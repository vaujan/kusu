/* eslint-disable @typescript-eslint/no-require-imports */
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const { PREVIEW_RUN_ID: runId, PREVIEW_TAG: tag } = process.env
if (!/^\d+$/.test(runId ?? '') || !/^v\d+\.\d+\.\d+-[\w.-]+$/.test(tag ?? '')) {
  throw new Error('Provide a numeric PREVIEW_RUN_ID and a prerelease PREVIEW_TAG.')
}
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
  gh('run', 'download', runId, '--pattern', 'kusu-*-unsigned-test', '--dir', directory)
  const files = []
  const checksums = []
  const names = new Set()
  let buildInfo
  for (const artifact of readdirSync(directory)) {
    if (!/^kusu-(windows-x64|linux-x64|macos-arm64|macos-x64)-unsigned-test$/.test(artifact)) {
      throw new Error(`Unexpected artifact: ${artifact}`)
    }
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
    const checksum = readFileSync(join(root, 'SHA256SUMS.txt'), 'utf8').trim()
    const match = checksum.match(
      /^([a-f0-9]{64}) {2}(kusu-\d+\.\d+\.\d+-(?:x64-setup\.exe|(?:x64|arm64)\.dmg|x86_64\.AppImage))$/
    )
    if (!match || names.has(match[2]))
      throw new Error(`Invalid installer checksum manifest: ${artifact}`)
    names.add(match[2])
    const file = join(root, match[2])
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== match[1]) {
      throw new Error(`Installer checksum mismatch: ${artifact}`)
    }
    const version = tag.match(/^v(\d+\.\d+\.\d+)-/)[1]
    if (!match[2].startsWith(`kusu-${version}-`))
      throw new Error('Installer version differs from release tag.')
    files.push(file)
    checksums.push(checksum)
  }
  if (files.length !== 4)
    throw new Error('All four platform installers are required before publication.')
  const manifest = join(directory, 'SHA256SUMS.txt')
  const provenance = join(directory, 'BUILD-INFO.txt')
  writeFileSync(manifest, `${checksums.sort().join('\n')}\n`)
  writeFileSync(provenance, buildInfo)
  gh('release', 'upload', tag, ...files, manifest, provenance, '--clobber')
  // Publish only after every upload succeeds. Stable releases are never created here.
  gh('release', 'edit', tag, '--draft=false', '--prerelease')
  console.log(`Published ${tag}: four verified installer files, checksums, and build provenance.`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}
