const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createHash } = require('node:crypto')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')
const test = require('node:test')
const script = fs.readFileSync('scripts/publish-preview.cjs', 'utf8')

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function publish(options = {}) {
  const calls = []
  const source = 'a'.repeat(40)
  let error
  let uploadedChecksums
  try {
    runInNewContext(script, {
      process: { env: { PREVIEW_RUN_ID: '123', PREVIEW_TAG: 'v0.0.3-preview.1' } },
      console: {
        log() {
          return undefined
        }
      },
      require(name) {
        if (name !== 'node:child_process') return require(name)
        return {
          execFileSync(command, args) {
            calls.push([...args])
            if (args[0] === 'run' && args[1] === 'view')
              return JSON.stringify({
                conclusion: options.failed ? 'failure' : 'success',
                workflowName: 'Build desktop installers'
              })
            if (args[0] === 'release' && args[1] === 'view')
              return JSON.stringify({
                isDraft: !options.published,
                isPrerelease: true,
                targetCommitish: source
              })
            if (args[0] === 'run' && args[1] === 'download') {
              const root = args.at(-1)
              const platforms = [
                ['windows-x64', 'x64-setup.exe'],
                ['linux-x64', 'x86_64.AppImage'],
                ['macos-arm64', 'arm64.dmg'],
                ['macos-x64', 'x64.dmg']
              ]
              for (const [index, [platform, suffix]] of platforms.entries()) {
                if (options.missing && index === 3) continue
                const directory = join(root, `kusu-${platform}-unsigned-test`)
                fs.mkdirSync(directory)
                const filename = `kusu-0.0.3-${suffix}`
                const names = [filename]
                if (index === 0 && !options.missingUpdateFiles) {
                  names.push('preview.yml', `${filename}.blockmap`)
                }
                const checksums = names.map((name) => {
                  fs.writeFileSync(join(directory, name), name)
                  const checksum = createHash('sha256')
                    .update(options.corrupt && index === 0 ? 'corrupt' : name)
                    .digest('hex')
                  return `${checksum}  ${name}`
                })
                fs.writeFileSync(join(directory, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`)
                fs.writeFileSync(
                  join(directory, 'BUILD-INFO.txt'),
                  `Source commit: ${options.wrongSource && index === 0 ? 'b'.repeat(40) : source}\nUnsigned test build.\n`
                )
              }
            }
            if (args[0] === 'release' && args[1] === 'upload') {
              if (options.uploadFails) throw new Error('Upload failed')
              uploadedChecksums = fs.readFileSync(
                args.find((arg) => arg.endsWith('SHA256SUMS.txt')),
                'utf8'
              )
            }
            return ''
          }
        }
      }
    })
  } catch (caught) {
    error = caught
  }
  return { calls, error, uploadedChecksums }
}

test('preview publication uploads all verified installers and update files before publishing', () => {
  const result = publish()
  assert.equal(result.error, undefined)
  assert.equal(result.uploadedChecksums.trim().split('\n').length, 6)
  assert.match(result.uploadedChecksums, / {2}preview\.yml\n/)
  assert.match(result.uploadedChecksums, / {2}kusu-0\.0\.3-x64-setup\.exe\.blockmap\n/)
  assert.equal(result.calls.at(-2)[1], 'upload')
  assert.deepEqual(result.calls.at(-1), [
    'release',
    'edit',
    'v0.0.3-preview.1',
    '--draft=false',
    '--prerelease'
  ])
})

test('preview publication rejects failed builds, published releases, missing files, and invalid provenance or hashes', () => {
  for (const options of [
    { failed: true },
    { published: true },
    { missing: true },
    { missingUpdateFiles: true },
    { wrongSource: true },
    { corrupt: true },
    { uploadFails: true }
  ]) {
    const result = publish(options)
    assert.ok(result.error, JSON.stringify(options))
    assert.equal(
      result.calls.some((args) => args[0] === 'release' && args[1] === 'edit'),
      false
    )
  }
})
