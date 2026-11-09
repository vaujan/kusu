/* eslint-disable @typescript-eslint/no-require-imports */
const { spawnSync } = require('node:child_process')
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} = require('node:fs')
const { homedir } = require('node:os')
const { dirname, join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const arch =
  process.argv.find((argument) => argument.startsWith('--arch='))?.slice(7) ?? process.arch
const target = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin'
}[`${process.platform}-${arch}`]
if (!target) throw new Error(`Unsupported native target: ${process.platform}-${arch}`)
const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo')
const installedCargo = join(cargoHome, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')
const cargo = existsSync(installedCargo) ? installedCargo : 'cargo'
const result = spawnSync(
  cargo,
  [
    'build',
    '--release',
    '--locked',
    '--target',
    target,
    '--target-dir',
    'native/search/target',
    '--manifest-path',
    'native/search/Cargo.toml'
  ],
  {
    cwd: root,
    stdio: 'inherit'
  }
)
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
const library = {
  win32: 'kusu_search.dll',
  darwin: 'libkusu_search.dylib',
  linux: 'libkusu_search.so'
}[process.platform]
if (!library) throw new Error(`Unsupported native platform: ${process.platform}`)
const destination = join(root, 'resources', 'native', `${process.platform}-${arch}`)
mkdirSync(destination, { recursive: true })
copyFileSync(
  join(root, 'native/search/target', target, 'release', library),
  join(destination, 'kusu-search.node')
)
const metadata = spawnSync(
  cargo,
  ['metadata', '--locked', '--format-version=1', '--manifest-path', 'native/search/Cargo.toml'],
  {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  }
)
if (metadata.error) throw metadata.error
if (metadata.status !== 0) throw new Error(metadata.stderr)
const notices = []
for (const pkg of JSON.parse(metadata.stdout).packages) {
  if (pkg.name === 'kusu-search') continue
  // These published crates omit the repository-level MIT license. The vendored
  // copy was checked against each locked crate's .cargo_vcs_info.json commit.
  if (
    [
      'napi@3.16.1',
      'napi-build@2.6.0',
      'napi-derive@3.7.0',
      'napi-derive-backend@7.0.0',
      'napi-sys@3.4.1'
    ].includes(`${pkg.name}@${pkg.version}`)
  ) {
    notices.push(
      `${pkg.name}@${pkg.version} (${pkg.license})\n${readFileSync(join(root, 'third-party/napi-rs.LICENSE.txt'), 'utf8')}`
    )
    continue
  }
  const directory = dirname(pkg.manifest_path)
  const files = readdirSync(directory).filter((name) =>
    /^(license|copying|notice)([.\-_]|$)/i.test(name)
  )
  if (pkg.license_file && !files.includes(pkg.license_file)) files.push(pkg.license_file)
  if (!files.length) throw new Error(`Missing Rust license text for ${pkg.name}`)
  notices.push(
    `${pkg.name}@${pkg.version} (${pkg.license})\n${files.map((name) => readFileSync(join(directory, name), 'utf8')).join('\n')}`
  )
}
writeFileSync(join(root, 'resources/native/THIRD_PARTY_NOTICES.txt'), notices.join('\n\n'))
console.log(`Built Rust search for ${process.platform}-${arch}`)
