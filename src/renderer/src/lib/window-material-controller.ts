import {
  resolveTranslucentBackgroundPreference,
  TRANSLUCENT_BACKGROUND_STORAGE_KEY,
  type DesktopPlatform,
  type TranslucentBackgroundStatus
} from '../../../shared/window-contract'

const UNSUPPORTED_STATUS: TranslucentBackgroundStatus = {
  supported: false,
  enabled: false,
  reducedTransparency: false
}

export interface WindowMaterialStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export interface WindowMaterialEnvironment {
  platform: DesktopPlatform
  storage: WindowMaterialStorage
  applyDocumentState: (enabled: boolean) => void
  setNativeState: (enabled: boolean) => Promise<TranslucentBackgroundStatus>
  onReducedTransparencyChange: (callback: () => void) => () => void
}

export interface WindowMaterialSnapshot {
  preferenceEnabled: boolean
  status: TranslucentBackgroundStatus | null
}

type WindowMaterialListener = (snapshot: WindowMaterialSnapshot) => void

export interface WindowMaterialController {
  getSnapshot: () => WindowMaterialSnapshot
  initialize: () => Promise<TranslucentBackgroundStatus>
  setEnabled: (enabled: boolean) => void
  syncStoredPreference: () => void
  subscribe: (listener: WindowMaterialListener) => () => void
}

export function readTranslucentBackgroundPreference(storage: WindowMaterialStorage): boolean {
  try {
    return resolveTranslucentBackgroundPreference(
      storage.getItem(TRANSLUCENT_BACKGROUND_STORAGE_KEY)
    )
  } catch {
    return false
  }
}

function writeTranslucentBackgroundPreference(
  storage: WindowMaterialStorage,
  enabled: boolean
): void {
  try {
    storage.setItem(TRANSLUCENT_BACKGROUND_STORAGE_KEY, String(enabled))
  } catch {
    // The native state can still be changed for this session when storage is unavailable.
  }
}

export function createWindowMaterialController(
  environment: WindowMaterialEnvironment
): WindowMaterialController {
  const listeners = new Set<WindowMaterialListener>()
  const supportsMaterial = environment.platform === 'win32' || environment.platform === 'linux'
  let operationId = 0
  let initializationRequest: Promise<TranslucentBackgroundStatus> | null = null
  let reducedTransparencyUnsubscribe: (() => void) | null = null
  let snapshot: WindowMaterialSnapshot = {
    preferenceEnabled: readTranslucentBackgroundPreference(environment.storage),
    status: null
  }

  const publish = (nextSnapshot: WindowMaterialSnapshot): void => {
    snapshot = nextSnapshot
    for (const listener of listeners) listener(snapshot)
  }

  const requestNativeState = (enabled: boolean): Promise<TranslucentBackgroundStatus> =>
    supportsMaterial ? environment.setNativeState(enabled) : Promise.resolve(UNSUPPORTED_STATUS)

  const applyStatus = (status: TranslucentBackgroundStatus): void => {
    environment.applyDocumentState(status.enabled)
    publish({ ...snapshot, status })
  }

  const refreshNativeState = (): void => {
    const requestId = ++operationId
    void requestNativeState(snapshot.preferenceEnabled)
      .then((status) => {
        if (requestId === operationId) applyStatus(status)
      })
      .catch(() => {
        if (requestId === operationId) applyStatus(UNSUPPORTED_STATUS)
      })
  }

  const initialize = (): Promise<TranslucentBackgroundStatus> => {
    if (initializationRequest) return initializationRequest

    reducedTransparencyUnsubscribe ??= environment.onReducedTransparencyChange(refreshNativeState)

    const requestId = operationId
    environment.applyDocumentState(supportsMaterial && snapshot.preferenceEnabled)
    initializationRequest = requestNativeState(snapshot.preferenceEnabled)
      .then((status) => {
        if (requestId === operationId) applyStatus(status)
        return status
      })
      .catch(() => {
        if (requestId === operationId) applyStatus(UNSUPPORTED_STATUS)
        return UNSUPPORTED_STATUS
      })
    return initializationRequest
  }

  const setEnabled = (enabled: boolean): void => {
    const previousSnapshot = snapshot
    const previousDocumentState =
      previousSnapshot.status?.enabled ?? (supportsMaterial && previousSnapshot.preferenceEnabled)
    const requestId = ++operationId

    writeTranslucentBackgroundPreference(environment.storage, enabled)
    environment.applyDocumentState(supportsMaterial && enabled)
    publish({ ...snapshot, preferenceEnabled: enabled })

    void requestNativeState(enabled)
      .then((status) => {
        if (requestId !== operationId) return
        if (enabled && status.supported && !status.enabled && !status.reducedTransparency) {
          writeTranslucentBackgroundPreference(
            environment.storage,
            previousSnapshot.preferenceEnabled
          )
          environment.applyDocumentState(previousDocumentState)
          publish(previousSnapshot)
          return
        }
        applyStatus(status)
      })
      .catch(() => {
        if (requestId !== operationId) return
        writeTranslucentBackgroundPreference(
          environment.storage,
          previousSnapshot.preferenceEnabled
        )
        environment.applyDocumentState(previousDocumentState)
        publish(previousSnapshot)
      })
  }

  const syncStoredPreference = (): void => {
    const enabled = readTranslucentBackgroundPreference(environment.storage)
    if (enabled !== snapshot.preferenceEnabled) setEnabled(enabled)
  }

  return {
    getSnapshot: () => snapshot,
    initialize,
    setEnabled,
    syncStoredPreference,
    subscribe: (listener) => {
      listeners.add(listener)
      listener(snapshot)
      return () => listeners.delete(listener)
    }
  }
}

let browserController: WindowMaterialController | null = null

export function getWindowMaterialController(): WindowMaterialController {
  if (!browserController) {
    browserController = createWindowMaterialController({
      platform: window.electron.window.platform,
      storage: localStorage,
      applyDocumentState: (enabled) => {
        document.documentElement.dataset.windowMaterial = enabled
          ? window.electron.window.platform === 'linux'
            ? 'transparent'
            : 'acrylic'
          : 'opaque'
      },
      setNativeState: (enabled) => window.electron.window.setTranslucentBackground(enabled),
      onReducedTransparencyChange: (callback) =>
        window.electron.window.onReducedTransparencyChange(callback)
    })
    window.addEventListener('storage', (event) => {
      if (event.key === TRANSLUCENT_BACKGROUND_STORAGE_KEY) {
        browserController?.syncStoredPreference()
      }
    })
  }
  return browserController
}
