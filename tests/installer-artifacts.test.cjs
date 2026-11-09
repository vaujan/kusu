const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { name, version } = require('../package.json')
const script = resolve('scripts/collect-installers.cjs')

test('installer collection includes only current artifacts and produces verifiable checksums', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kusu-installers-'))
  try {
    const dist = join(cwd, 'dist')
    mkdirSync(dist)
    const windowsInstaller = `${name}-${version}-x64-setup.exe`
    const installers = [
      windowsInstaller,
      `${name}-${version}-arm64.dmg`,
      `${name}-${version}-x86_64.AppImage`
    ]
    const blockmap = `${windowsInstaller}.blockmap`
    for (const filename of [
      ...installers,
      blockmap,
      `${name}-0.0.0-x64-setup.exe`,
      'builder-debug.yml'
    ]) {
      writeFileSync(join(dist, filename), filename)
    }
    const entry = {
      url: windowsInstaller,
      size: Buffer.byteLength(windowsInstaller),
      sha512: 'wrong'
    }
    const manifest = join(dist, 'preview.yml')
    writeFileSync(manifest, JSON.stringify({ version, files: [entry] }))
    const invalid = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' })
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stderr, /Preview update metadata does not match/)
    entry.sha512 = createHash('sha512').update(windowsInstaller).digest('base64')
    writeFileSync(manifest, JSON.stringify({ version, files: [entry] }))
    const result = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const output = join(cwd, 'release-artifacts')
    const artifacts = [...installers, blockmap, 'preview.yml']
    assert.deepEqual(
      readdirSync(output).sort(),
      [...artifacts, 'SHA256SUMS.txt', 'BUILD-INFO.txt'].sort()
    )
    for (const filename of artifacts) {
      const hash = createHash('sha256')
        .update(readFileSync(join(output, filename)))
        .digest('hex')
      assert.ok(
        readFileSync(join(output, 'SHA256SUMS.txt'), 'utf8').includes(`${hash}  ${filename}\n`)
      )
    }
    assert.match(readFileSync(join(output, 'BUILD-INFO.txt'), 'utf8'), /Unsigned test build/)
    assert.notEqual(spawnSync(process.execPath, [script], { cwd }).status, 0)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('installer collection fails when packaging produced no matching installers', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kusu-installers-empty-'))
  try {
    mkdirSync(join(cwd, 'dist'))
    writeFileSync(join(cwd, 'dist', `${name}-0.0.0-x64-setup.exe`), 'stale')
    const result = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /No installers match/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
