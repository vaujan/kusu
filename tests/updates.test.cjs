const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { EventEmitter } = require('node:events')
const { runInNewContext } = require('node:vm')
const test = require('node:test')
const ts = require('typescript')

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function setup({
  packaged = true,
  platform = 'win32',
  save = true,
  notes = true,
  preview = false
} = {}) {
  const handlers = new Map()
  const listeners = new Map()
  const updater = new EventEmitter()
  const calls = []
  updater.checkForUpdates = async () => {
    calls.push('check')
    updater.emit('update-available', { version: '1.0.0' })
  }
  updater.downloadUpdate = async () => {
    calls.push('download')
    updater.emit('download-progress', { percent: 50 })
    updater.emit('update-downloaded', { version: '1.0.0' })
  }
  updater.quitAndInstall = () => calls.push('install')
  const sender = {
    isDestroyed: () => false,
    send: () => {
      calls.push('save')
      listeners.get('updates:prepared')({ sender }, save)
    }
  }
  const module = { exports: {} }
  const source = ts.transpileModule(readFileSync('src/main/updates.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const timers = []
  runInNewContext(source, {
    module,
    exports: module.exports,
    process: { platform, env: { KUSU_PREVIEW_BUILD: preview ? '1' : '' } },
    setTimeout: (callback) => {
      timers.push(callback)
      return { unref: () => undefined }
    },
    setInterval: () => ({ unref: () => undefined }),
    clearTimeout: () => undefined,
    clearInterval: () => undefined,
    require: (id) => {
      if (id === 'electron')
        return {
          app: { isPackaged: packaged, once: () => undefined },
          BrowserWindow: { getAllWindows: () => [] },
          Notification: { isSupported: () => false }
        }
      if (id === 'electron-updater') return { autoUpdater: updater }
      if (id === './security')
        return {
          trustedIpcMain: {
            handle: (channel, handler) => handlers.set(channel, handler),
            on: (channel, handler) => listeners.set(channel, handler)
          }
        }
      if (id === '../shared/update-contract')
        return {
          UPDATE_CHANNELS: {
            status: 'updates:status',
            changed: 'updates:changed',
            check: 'updates:check',
            download: 'updates:download',
            install: 'updates:install',
            prepare: 'updates:prepare',
            prepared: 'updates:prepared'
          }
        }
      throw new Error(id)
    }
  })
  module.exports.registerUpdates(
    () => sender,
    async () => {
      calls.push('notes')
      return notes
    },
    () => {}
  )
  return {
    updater,
    calls,
    timers,
    handlers,
    listeners,
    sender,
    status: () => handlers.get('updates:status')(),
    check: () => handlers.get('updates:check')(),
    download: () => handlers.get('updates:download')(),
    install: () => handlers.get('updates:install')()
  }
}

test('updates check automatically but download and install only on request', async () => {
  const s = setup()
  assert.equal(s.updater.autoDownload, false)
  assert.equal(s.updater.autoInstallOnAppQuit, false)
  assert.equal(s.updater.allowPrerelease, false)
  await s.install()
  await s.download()
  assert.deepEqual(s.calls, [])
  await s.timers[0]()
  assert.equal(s.status().phase, 'available')
  assert.deepEqual(s.calls, ['check'])
  await s.check()
  await s.download()
  assert.equal(s.status().phase, 'ready')
  await s.install()
  assert.deepEqual(s.calls, ['check', 'download', 'save', 'notes', 'save', 'install'])
})

test('edits made while separate notes close must save before restart', async () => {
  const s = setup()
  await s.check()
  await s.download()
  let saves = 0
  s.sender.send = () => {
    saves += 1
    s.listeners.get('updates:prepared')({ sender: s.sender }, saves === 1)
  }
  await s.install()
  assert.equal(saves, 2)
  assert.equal(s.calls.includes('install'), false)
  assert.equal(s.status().phase, 'ready')
})

test('only packaged Windows previews subscribe to the preview channel', async () => {
  const s = setup({ preview: true })
  assert.equal(s.updater.allowPrerelease, true)
  assert.equal(s.updater.channel, 'preview')
  assert.equal(s.updater.allowDowngrade, false)
  assert.equal(s.updater.autoDownload, false)
  assert.equal(s.updater.autoInstallOnAppQuit, false)
  s.updater.checkForUpdates = async () => {
    throw Object.assign(new Error('missing release'), { code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' })
  }
  await s.check()
  assert.match(s.status().message, /Could not find a preview release/)
})

test('development and unsupported platforms never check or install', async () => {
  for (const options of [{ packaged: false }, { platform: 'darwin' }, { platform: 'linux' }]) {
    const s = setup({ ...options, preview: true })
    assert.equal(s.updater.allowPrerelease, false)
    await s.check()
    await s.download()
    await s.install()
    assert.equal(s.status().phase, 'unavailable')
    assert.deepEqual(s.calls, [])
    assert.equal(s.timers.length, 0)
  }
})

test('a failed main-editor or note-window save blocks installation and allows retry', async () => {
  for (const options of [{ save: false }, { notes: false }]) {
    const s = setup(options)
    await s.check()
    await s.download()
    await s.install()
    assert.equal(s.calls.includes('install'), false)
    assert.equal(s.status().phase, 'ready')
    assert.match(s.status().message, /Save or close/)
  }
})

test('network errors can be retried without leaving the updater busy', async () => {
  const s = setup()
  s.updater.checkForUpdates = async () => {
    throw new Error('offline')
  }
  await s.check()
  assert.equal(s.status().phase, 'error')
  assert.equal(s.status().message, 'Could not update Kusu. Please try again later.')
  s.updater.checkForUpdates = async () => s.updater.emit('update-not-available')
  await s.check()
  assert.equal(s.status().phase, 'current')
})

test('release feed failures point to GitHub Releases for events and rejected checks', async () => {
  for (const code of [
    'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
    'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
    'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
  ]) {
    const s = setup()
    const error = Object.assign(new Error('release unavailable'), { code })
    s.updater.checkForUpdates = async () => {
      s.updater.emit('error', error)
      throw error
    }
    await s.check()
    assert.equal(s.status().phase, 'error')
    assert.match(s.status().message, /GitHub Releases/)
    assert.doesNotMatch(s.status().message, /connection/)
    s.updater.checkForUpdates = async () => s.updater.emit('update-not-available')
    await s.check()
    assert.equal(s.status().phase, 'current')
  }
})

test('a missing save response blocks restart and unrelated windows cannot approve it', async () => {
  const s = setup()
  await s.check()
  await s.download()
  s.sender.send = () => {}
  const pending = s.install()
  s.listeners.get('updates:prepared')({ sender: {} }, true)
  assert.equal(s.status().phase, 'installing')
  s.timers[1]()
  await pending
  assert.equal(s.status().phase, 'ready')
  assert.equal(s.calls.includes('install'), false)
})

test('duplicate downloads and premature install requests are ignored', async () => {
  const s = setup()
  await s.check()
  let finish
  s.updater.downloadUpdate = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const pending = s.download()
  await s.download()
  await s.install()
  assert.equal(s.status().phase, 'downloading')
  assert.equal(s.calls.includes('install'), false)
  s.updater.emit('error', new Error('bad signature'))
  finish()
  await pending
  assert.equal(s.status().phase, 'error')
})

test('wrapped missing stable releases point to GitHub Releases', async () => {
  const s = setup()
  s.updater.checkForUpdates = async () => {
    throw Object.assign(
      new Error('Cannot parse releases feed: Error: Unable to find latest version on GitHub'),
      {
        code: 'ERR_UPDATER_INVALID_RELEASE_FEED'
      }
    )
  }
  await s.check()
  assert.equal(s.status().phase, 'error')
  assert.match(s.status().message, /stable release/)
  assert.match(s.status().message, /GitHub Releases/)
})

test('invalid feeds do not claim the app is current', async () => {
  const s = setup()
  s.updater.checkForUpdates = async () => {
    throw Object.assign(new Error('invalid XML'), { code: 'ERR_UPDATER_INVALID_RELEASE_FEED' })
  }
  await s.check()
  assert.equal(s.status().phase, 'error')
  assert.match(s.status().message, /Could not read the update feed/)
})
