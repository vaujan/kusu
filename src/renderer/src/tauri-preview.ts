import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type {
  ApiResult,
  ImageItemDto,
  ImagePreviewDto,
  LibraryDto,
  LibraryState,
  NoteAttachmentDto
} from '../../shared/library-contract'
import {
  installPreview,
  library,
  formattingNote,
  planningNote,
  type PreviewTextUpdate
} from './demo/app-preview-fixtures'

const TITLE_BAR_KEY = 'kusu-tauri-native-title-bar'

type OpenedPreview = { sessionId: number | null; library: LibraryDto }
type PreviewTextChanged = { sessionId: number; paths: string[] }

async function initializeTauriWindow(): Promise<void> {
  const appWindow = getCurrentWindow()
  const windowApi = window.electron.window
  const titleBarListeners = new Set<() => void>()
  let nativeTitleBar = false

  windowApi.titleBar = {
    getNative: () => nativeTitleBar,
    subscribe: (listener) => {
      titleBarListeners.add(listener)
      return () => titleBarListeners.delete(listener)
    },
    setNative: async (native) => {
      await appWindow.setDecorations(native)
      nativeTitleBar = native
      titleBarListeners.forEach((listener) => listener())
      localStorage.setItem(TITLE_BAR_KEY, String(native))
    }
  }
  windowApi.openSettingsWindow = async () => {
    window.dispatchEvent(new Event('kusu:open-settings'))
  }
  windowApi.minimize = () => void appWindow.minimize().catch(console.error)
  windowApi.toggleMaximize = () => void appWindow.toggleMaximize().catch(console.error)
  windowApi.close = () => void appWindow.close().catch(console.error)
  windowApi.isMaximized = () => appWindow.isMaximized()
  windowApi.onMaximizedChange = (listener) => {
    let active = true
    const subscription = appWindow.onResized(async () => {
      const maximized = await appWindow.isMaximized()
      if (active) listener(maximized)
    })
    void subscription.catch(console.error)
    return () => {
      active = false
      void subscription.then((unlisten) => unlisten()).catch(console.error)
    }
  }

  if (localStorage.getItem(TITLE_BAR_KEY) === 'true') {
    await windowApi.titleBar.setNative(true).catch(console.error)
  }
}

function initializeLocalPreviews(snapshot: LibraryDto): void {
  const images = new Map<string, ImageItemDto>()
  const attachments = new Map<string, NoteAttachmentDto[]>()
  for (const item of snapshot.items) {
    if (item.type === 'image') images.set(item.id, item)
    if (item.type === 'note' && item.attachments.length) attachments.set(item.id, item.attachments)
  }
  const readMedia = (itemId: string, thumbnail: boolean): Promise<ArrayBuffer> =>
    invoke('read_preview_media', { itemId, thumbnail })
  const readImage = async (
    image: ImageItemDto | NoteAttachmentDto | undefined,
    thumbnail: boolean,
    load: () => Promise<ArrayBuffer>
  ): Promise<ApiResult<ImagePreviewDto>> => {
    if (!image) return { ok: false, code: 'invalid-input', error: 'The image is unavailable.' }
    try {
      const bytes = await load()
      const header = new DataView(bytes)
      return {
        ok: true,
        data: {
          bytes,
          mediaType: thumbnail ? 'image/png' : image.mediaType,
          width: thumbnail ? header.getUint32(16) : image.width,
          height: thumbnail ? header.getUint32(20) : image.height
        }
      }
    } catch (error) {
      return { ok: false, code: 'invalid-input', error: String(error) }
    }
  }
  window.kusu.getImageThumbnail = (itemId) =>
    readImage(images.get(itemId), true, () => readMedia(itemId, true))
  window.kusu.getImagePreview = (itemId) =>
    readImage(images.get(itemId), false, () => readMedia(itemId, false))
  window.kusu.getNoteAttachmentPreview = (itemId, attachmentId) =>
    readImage(
      attachments.get(itemId)?.find((attachment) => attachment.id === attachmentId),
      false,
      () => invoke('read_preview_media', { itemId, attachmentId, thumbnail: false })
    )
  window.kusu.getPdfPreview = async (itemId) => {
    try {
      return { ok: true, data: await readMedia(itemId, false) }
    } catch (error) {
      return { ok: false, code: 'invalid-input', error: String(error) }
    }
  }
  const showItem = async (itemId: string, reveal: boolean): Promise<ApiResult<null>> => {
    try {
      await invoke('show_preview_item', { itemId, reveal })
      return { ok: true, data: null }
    } catch (error) {
      return { ok: false, code: 'not-found', error: String(error) }
    }
  }
  window.kusu.showItemInExplorer = (itemId) => showItem(itemId, true)
  window.kusu.openItemInDefaultApp = (itemId) => showItem(itemId, false)
}

async function openPreviewVault(): Promise<ApiResult<LibraryState>> {
  try {
    const preview = await invoke<OpenedPreview | null>('open_preview_vault')
    if (!preview) return { ok: false, code: 'cancelled', error: 'Opening a vault was cancelled.' }
    const electron = window.electron
    const applyText = installPreview(preview.library, { type: 'all' }, 'win32')
    window.electron = electron
    initializeLibraryActions()
    initializeLocalPreviews(preview.library)
    if (preview.sessionId !== null) initializeTextRefresh(preview.sessionId, applyText)
    return window.kusu.getState()
  } catch (error) {
    return { ok: false, code: 'invalid-input', error: String(error) }
  }
}

export async function initializeTauriPreview(): Promise<void> {
  let preview: OpenedPreview | null = null
  let unavailable: LibraryState | null = null
  try {
    preview = await invoke<OpenedPreview | null>('load_preview_snapshot')
  } catch (error) {
    unavailable = { status: 'unavailable', path: '', message: String(error) }
  }
  const applyText = installPreview(
    preview?.library ??
      library('tauri-preview', [planningNote, formattingNote], { name: 'Tauri Preview' }),
    { type: 'all' },
    'win32'
  )
  await initializeTauriWindow()
  initializeLibraryActions()
  if (preview) {
    initializeLocalPreviews(preview.library)
    if (preview.sessionId !== null) initializeTextRefresh(preview.sessionId, applyText)
  }
  if (unavailable) {
    const state = unavailable
    window.kusu.getOverview = async () => ({ ok: true, data: state })
  }
}

function initializeTextRefresh(
  sessionId: number,
  applyText: (updates: readonly PreviewTextUpdate[]) => boolean
): void {
  const api = window.kusu
  let inFlight: Promise<boolean> | null = null
  let pending: Set<string> | null | undefined
  const drain = async (): Promise<boolean> => {
    let changed = false
    try {
      while (pending !== undefined && window.kusu === api) {
        const paths = pending === null ? null : [...pending]
        pending = undefined
        const updates = await invoke<PreviewTextUpdate[]>('refresh_preview_text', {
          sessionId,
          paths
        })
        if (window.kusu !== api) return false
        changed = applyText(updates) || changed
      }
      return changed
    } finally {
      inFlight = null
    }
  }
  const refresh = (paths?: readonly string[]): Promise<boolean> => {
    if (!paths) {
      pending = null
    } else if (pending !== null) {
      pending ??= new Set()
      for (const path of paths) pending.add(path)
    }
    inFlight ??= drain()
    return inFlight
  }

  const readOverview = api.getOverview
  const readState = api.getState
  api.reconcileOverview = async () => {
    try {
      await refresh()
      return readOverview()
    } catch (error) {
      return { ok: false, code: 'io-error', error: String(error) }
    }
  }
  api.reconcile = async () => {
    try {
      await refresh()
      return readState()
    } catch (error) {
      return { ok: false, code: 'io-error', error: String(error) }
    }
  }
  api.onVaultChanged = (callback) => {
    let active = true
    const sync = (paths?: readonly string[]): void => {
      if (!active) return
      void refresh(paths)
        .then((changed) => {
          if (changed && active && window.kusu === api) callback()
        })
        .catch(console.error)
    }
    const subscription = listen<PreviewTextChanged>('kusu:preview-text-changed', ({ payload }) => {
      if (payload.sessionId === sessionId) sync(payload.paths)
    })
    void subscription.then(
      () => sync(),
      () => sync()
    )
    return () => {
      active = false
      void subscription.then((unlisten) => unlisten()).catch(console.error)
    }
  }
}

function initializeLibraryActions(): void {
  window.kusu.open = openPreviewVault
  window.kusu.openExternalUrl = async (url) => {
    try {
      await invoke('open_preview_link', { url })
      return { ok: true, data: null }
    } catch (error) {
      return { ok: false, code: 'invalid-input', error: String(error) }
    }
  }
}
