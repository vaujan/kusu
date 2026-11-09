/* eslint-disable @typescript-eslint/no-require-imports */
const { createHash } = require('node:crypto')
const { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { parse } = require('yaml')
const { name, version } = require('../package.json')

const input = 'dist'
const output = 'release-artifacts'
const filenames = readdirSync(input)
  .filter((filename) =>
    ['x64', 'arm64'].some((arch) =>
      [
        `${name}-${version}-${arch}-setup.exe`,
        `${name}-${version}-${arch}.dmg`,
        `${name}-${version}-${arch === 'x64' ? 'x86_64' : arch}.AppImage`
      ].includes(filename)
    )
  )
  .sort()
if (!filenames.length) throw new Error('No installers match the current package name and version.')
const windowsInstaller = `${name}-${version}-x64-setup.exe`
if (filenames.includes(windowsInstaller)) {
  const metadata = parse(readFileSync(join(input, 'preview.yml'), 'utf8'))
  const entry = metadata?.files?.[0]
  const installer = readFileSync(join(input, windowsInstaller))
  if (
    !entry ||
    metadata.version !== version ||
    metadata.files.length !== 1 ||
    entry.url !== windowsInstaller ||
    entry.size !== installer.length ||
    entry.sha512 !== createHash('sha512').update(installer).digest('base64')
  ) {
    throw new Error('Preview update metadata does not match the Windows installer.')
  }
  filenames.push('preview.yml', `${windowsInstaller}.blockmap`)
}
const checksums = filenames.map((filename) => {
  const source = join(input, filename)
  const checksum = createHash('sha256').update(readFileSync(source)).digest('hex')
  return `${checksum}  ${filename}`
})
mkdirSync(output) // Refuse to mix a new build with stale artifacts.
for (const filename of filenames) {
  copyFileSync(join(input, filename), join(output, filename))
}
writeFileSync(join(output, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`)
writeFileSync(
  join(output, 'BUILD-INFO.txt'),
  [
    `Kusu ${version}`,
    `Source commit: ${process.env.GITHUB_SHA || 'local build'}`,
    'Unsigned test build. macOS builds use ad-hoc signing and are not notarized.',
    'Installation and runtime behavior must be tested on the matching OS and architecture.',
    'These CI artifacts are not approved public releases.',
    ''
  ].join('\n')
)
console.log(`Collected ${filenames.length} release files and SHA-256 checksums in ${output}.`)
