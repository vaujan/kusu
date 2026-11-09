const assert = require('node:assert/strict')
const test = require('node:test')
require('./helpers/install-ts-require.cjs')()

const {
  createWindowMaterialController,
  readTranslucentBackgroundPreference
} = require('../src/renderer/src/lib/window-material-controller.ts')
const { TRANSLUCENT_BACKGROUND_STORAGE_KEY } = require('../src/shared/window-contract.ts')

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function createStorage(initialEntries = []) {
  const values = new Map(initialEntries)
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  }
}

test('defaults to opaque and keeps an explicitly saved translucency preference', () => {
  assert.equal(readTranslucentBackgroundPreference(createStorage()), false)
  const storage = createStorage([[TRANSLUCENT_BACKGROUND_STORAGE_KEY, 'true']])
  assert.equal(readTranslucentBackgroundPreference(storage), true)
})

test('falls back to opaque when renderer preference storage is unavailable', () => {
  const storage = {
    getItem: () => {
      throw new Error('unavailable')
    },
    setItem: () => {
      throw new Error('unavailable')
    },
    removeItem: () => {
      throw new Error('unavailable')
    }
  }
  assert.equal(readTranslucentBackgroundPreference(storage), false)
})

test('initializes the document and native Acrylic state once', async () => {
  const documentStates = []
  const nativeRequests = []
  let reducedTransparencySubscriptions = 0
  const controller = createWindowMaterialController({
    platform: 'win32',
    storage: createStorage([[TRANSLUCENT_BACKGROUND_STORAGE_KEY, 'true']]),
    applyDocumentState: (enabled) => documentStates.push(enabled),
    setNativeState: async (enabled) => {
      nativeRequests.push(enabled)
      return { supported: true, enabled, reducedTransparency: false }
    },
    onReducedTransparencyChange: () => {
      reducedTransparencySubscriptions += 1
      return () => undefined
    }
  })

  const firstRequest = controller.initialize()
  const secondRequest = controller.initialize()
  assert.equal(firstRequest, secondRequest)
  assert.deepEqual(await firstRequest, {
    supported: true,
    enabled: true,
    reducedTransparency: false
  })
  assert.deepEqual(nativeRequests, [true])
  assert.equal(reducedTransparencySubscriptions, 1)
  assert.deepEqual(documentStates, [true, true])
  assert.deepEqual(controller.getSnapshot(), {
    preferenceEnabled: true,
    status: { supported: true, enabled: true, reducedTransparency: false }
  })

  const subscribedSnapshots = []
  const unsubscribe = controller.subscribe((snapshot) => subscribedSnapshots.push(snapshot))
  assert.deepEqual(subscribedSnapshots, [controller.getSnapshot()])
  unsubscribe()
})

test('rolls preference, document, and snapshot back when native activation fails', async () => {
  const storage = createStorage([[TRANSLUCENT_BACKGROUND_STORAGE_KEY, 'false']])
  const documentStates = []
  let failNextRequest = false
  const controller = createWindowMaterialController({
    platform: 'win32',
    storage,
    applyDocumentState: (enabled) => documentStates.push(enabled),
    setNativeState: async (enabled) => {
      if (failNextRequest) throw new Error('native failure')
      return { supported: true, enabled, reducedTransparency: false }
    },
    onReducedTransparencyChange: () => () => undefined
  })

  await controller.initialize()
  failNextRequest = true
  controller.setEnabled(true)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(storage.values.get(TRANSLUCENT_BACKGROUND_STORAGE_KEY), 'false')
  assert.equal(documentStates.at(-1), false)
  assert.deepEqual(controller.getSnapshot(), {
    preferenceEnabled: false,
    status: { supported: true, enabled: false, reducedTransparency: false }
  })
})

test('keeps the latest preference when native responses arrive out of order', async () => {
  const pendingRequests = []
  const controller = createWindowMaterialController({
    platform: 'win32',
    storage: createStorage(),
    applyDocumentState: () => undefined,
    setNativeState: (enabled) =>
      new Promise((resolve) => pendingRequests.push({ enabled, resolve })),
    onReducedTransparencyChange: () => () => undefined
  })

  controller.setEnabled(false)
  controller.setEnabled(true)
  pendingRequests[1].resolve({
    supported: true,
    enabled: true,
    reducedTransparency: false
  })
  await new Promise((resolve) => setImmediate(resolve))
  pendingRequests[0].resolve({
    supported: true,
    enabled: false,
    reducedTransparency: false
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(controller.getSnapshot(), {
    preferenceEnabled: true,
    status: { supported: true, enabled: true, reducedTransparency: false }
  })
})

test('does not invoke native material APIs on macOS', async () => {
  let nativeRequestCount = 0
  const controller = createWindowMaterialController({
    platform: 'darwin',
    storage: createStorage(),
    applyDocumentState: () => undefined,
    setNativeState: async () => {
      nativeRequestCount += 1
      return { supported: true, enabled: true, reducedTransparency: false }
    },
    onReducedTransparencyChange: () => () => undefined
  })

  assert.deepEqual(await controller.initialize(), {
    supported: false,
    enabled: false,
    reducedTransparency: false
  })
  assert.equal(nativeRequestCount, 0)
})

test('preserves the preference while reduced transparency disables the material', async () => {
  const storage = createStorage([[TRANSLUCENT_BACKGROUND_STORAGE_KEY, 'true']])
  const documentStates = []
  let reducedTransparency = false
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  let notifyReducedTransparency = () => undefined
  const controller = createWindowMaterialController({
    platform: 'win32',
    storage,
    applyDocumentState: (enabled) => documentStates.push(enabled),
    setNativeState: async (enabled) => ({
      supported: true,
      enabled: enabled && !reducedTransparency,
      reducedTransparency
    }),
    onReducedTransparencyChange: (callback) => {
      notifyReducedTransparency = callback
      return () => undefined
    }
  })

  await controller.initialize()
  reducedTransparency = true
  notifyReducedTransparency()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(storage.values.get(TRANSLUCENT_BACKGROUND_STORAGE_KEY), 'true')
  assert.equal(controller.getSnapshot().preferenceEnabled, true)
  assert.deepEqual(controller.getSnapshot().status, {
    supported: true,
    enabled: false,
    reducedTransparency: true
  })
  assert.equal(documentStates.at(-1), false)
})

test('applies a preference changed by another window', async () => {
  const storage = createStorage([[TRANSLUCENT_BACKGROUND_STORAGE_KEY, 'true']])
  const nativeRequests = []
  const controller = createWindowMaterialController({
    platform: 'win32',
    storage,
    applyDocumentState: () => undefined,
    setNativeState: async (enabled) => {
      nativeRequests.push(enabled)
      return { supported: true, enabled, reducedTransparency: false }
    },
    onReducedTransparencyChange: () => () => undefined
  })

  await controller.initialize()
  storage.setItem(TRANSLUCENT_BACKGROUND_STORAGE_KEY, 'false')
  controller.syncStoredPreference()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(controller.getSnapshot().preferenceEnabled, false)
  assert.deepEqual(nativeRequests, [true, false])
})

test('Linux initializes and toggles background transparency', async () => {
  const documentStates = []
  const controller = createWindowMaterialController({
    platform: 'linux',
    storage: createStorage(),
    applyDocumentState: (enabled) => documentStates.push(enabled),
    setNativeState: async (enabled) => ({ supported: true, enabled, reducedTransparency: false }),
    onReducedTransparencyChange: () => () => undefined
  })
  assert.equal((await controller.initialize()).enabled, false)
  controller.setEnabled(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(controller.getSnapshot().status.enabled, true)
  controller.setEnabled(false)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(controller.getSnapshot().status.enabled, false)
  assert.equal(documentStates.at(-1), false)
})
