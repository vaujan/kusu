/* eslint-disable @typescript-eslint/no-require-imports */
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const { PREVIEW_RUN_ID: runId, PREVIEW_TAG: tag } = process.env
const version = /^v(\d+\.\d+\.\d+)-preview\.[1-9]\d*$/.exec(tag ?? '')?.[1]
if (!/^\d+$/.test(runId ?? '') || !version) {
  throw new Error('Provide a numeric PREVIEW_RUN_ID and a vX.Y.Z-preview.N PREVIEW_TAG.')
}
const windowsInstaller = `kusu-${version}-x64-setup.exe`
const expectedFiles = new Map([
  [
    'kusu-windows-x64-unsigned-test',
    [windowsInstaller, `${windowsInstaller}.blockmap`, 'preview.yml']
  ],
  ['kusu-linux-x64-unsigned-test', [`kusu-${version}-x86_64.AppImage`]],
  ['kusu-macos-arm64-unsigned-test', [`kusu-${version}-arm64.dmg`]],
  ['kusu-macos-x64-unsigned-test', [`kusu-${version}-x64.dmg`]]
])
// All arguments are passed directly, never interpreted by a shell.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
const run = JSON.parse(gh('run', 'view', runId, '--json', 'conclusion,workflowName'))
if (run.conclusion !== 'success' || run.workflowName !== 'Build desktop installers') {
  throw new Error('Only a successful installer workflow can be published.')
}
const release = JSON.parse(
  gh('release', 'view', tag, '--json', 'isDraft,isPrerelease,targetCommitish')
)
if (!release.isDraft || !release.isPrerelease || !/^[a-f0-9]{40}$/.test(release.targetCommitish)) {
  throw new Error('Create a draft prerelease targeting the exact build source commit first.')
}
const directory = mkdtempSync(join(tmpdir(), 'kusu-preview-'))
try {
  gh('run', 'download', runId, '--dir', directory)
  const files = []
  const checksums = []
  let buildInfo
  for (const artifact of readdirSync(directory)) {
    const expected = expectedFiles.get(artifact)
    if (!expected) throw new Error(`Unexpected artifact: ${artifact}`)
    const root = join(directory, artifact)
    const info = readFileSync(join(root, 'BUILD-INFO.txt'), 'utf8')
    if (
      !info.includes(`Source commit: ${release.targetCommitish}\n`) ||
      !info.includes('Unsigned test build.')
    ) {
      throw new Error(`Build provenance does not match the draft release: ${artifact}`)
    }
    if (buildInfo && buildInfo !== info)
      throw new Error('Installer builds have different provenance.')
    buildInfo = info
    const entries = readFileSync(join(root, 'SHA256SUMS.txt'), 'utf8').trim().split(/\r?\n/)
    const missing = new Set(expected)
    for (const entry of entries) {
      const match = /^([a-f0-9]{64}) {2}(\S+)$/.exec(entry)
      if (!match || !missing.delete(match[2])) {
        throw new Error(`Invalid checksum manifest: ${artifact}`)
      }
      const file = join(root, match[2])
      if (createHash('sha256').update(readFileSync(file)).digest('hex') !== match[1]) {
        throw new Error(`Checksum mismatch: ${match[2]}`)
      }
      files.push(file)
      checksums.push(entry)
    }
    if (missing.size) throw new Error(`Missing release files: ${[...missing].join(', ')}`)
    expectedFiles.delete(artifact)
  }
  if (expectedFiles.size)
    throw new Error('All four platform installers are required before publication.')
  const manifest = join(directory, 'SHA256SUMS.txt')
  const provenance = join(directory, 'BUILD-INFO.txt')
  writeFileSync(manifest, `${checksums.sort().join('\n')}\n`)
  writeFileSync(provenance, buildInfo)
  gh('release', 'upload', tag, ...files, manifest, provenance, '--clobber')
  // Publish only after every upload succeeds. Stable releases are never created here.
  gh('release', 'edit', tag, '--draft=false', '--prerelease')
  console.log(`Published ${tag}: four verified installers, Windows update files, and provenance.`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}
