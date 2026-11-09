/* eslint-disable @typescript-eslint/no-require-imports */
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { listPackage, extractFile } = require('@electron/asar')
const manifest = require('../package.json')
const platform = process.argv[2] ?? process.platform
if (!['win32', 'linux', 'darwin'].includes(platform))
  throw new Error('Inspect a win32, linux, or darwin package.')
const root =
  platform === 'darwin'
    ? join(
        'dist',
        process.arch === 'arm64' ? 'mac-arm64' : 'mac',
        'Kusu.app',
        'Contents',
        'Resources'
      )
    : join('dist', platform === 'win32' ? 'win-unpacked' : 'linux-unpacked')
const archive = join(root, platform === 'darwin' ? '' : 'resources', 'app.asar')
const files = listPackage(archive).map((name) => name.replaceAll('\\', '/').replace(/^\/+/, ''))
const allowedRoots = new Set([
  'out',
  'resources',
  'node_modules',
  'package.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.txt'
])
for (const file of files) {
  if (!allowedRoots.has(file.split('/')[0])) throw new Error(`Unexpected package entry: ${file}`)
  if (/(^|\/)\.env(?:\.|$)|\.(?:pfx|p12|pem|key)$/i.test(file)) {
    throw new Error(`Potential secret file in package: ${file}`)
  }
  if (/(^|\/)node_modules\/(react-grab|react-scan)(\/|$)/.test(file)) {
    throw new Error(`Development tooling found in package: ${file}`)
  }
}
for (const required of [
  'out/main/index.js',
  'out/preload/index.js',
  'out/renderer/index.html',
  'package.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.txt'
]) {
  if (!files.includes(required)) throw new Error(`Package is missing ${required}`)
}
const addon = `resources/native/${platform}-${process.arch}/kusu-search.node`
if (!files.includes(addon) || !existsSync(join(`${archive}.unpacked`, addon))) {
  throw new Error(`Package is missing its unpacked Rust search addon: ${addon}`)
}
const nativeNotices = 'resources/native/THIRD_PARTY_NOTICES.txt'
if (
  !files.includes(nativeNotices) ||
  !extractFile(archive, join(...nativeNotices.split('/'))).includes(Buffer.from('napi@'))
) {
  throw new Error('Package is missing Rust dependency attribution.')
}
const packagedManifest = JSON.parse(extractFile(archive, 'package.json').toString('utf8'))
if (packagedManifest.name !== manifest.name || packagedManifest.version !== manifest.version) {
  throw new Error(
    'Packaged name/version does not match the source release candidate. Rebuild the package.'
  )
}
if (!extractFile(archive, 'THIRD_PARTY_NOTICES.txt').includes(Buffer.from('Kenny Bergquist'))) {
  throw new Error('Package is missing the atomic editor attribution.')
}
for (const name of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) {
  if (!existsSync(join(root, name))) throw new Error(`Electron notice missing: ${name}`)
}
console.log(`Verified ${files.length} archive entries and Electron notices in ${root}.`)
