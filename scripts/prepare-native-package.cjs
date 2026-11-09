/* eslint-disable @typescript-eslint/no-require-imports */
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

module.exports = async (context) => {
  const platform = context.packager.platform.nodeName
  // electron-builder's Arch enum: x64=1, arm64=3. Reject unsupported targets.
  const arch = { 1: 'x64', 3: 'arm64' }[context.arch]
  if (platform !== process.platform || !arch) {
    throw new Error('Build the Rust addon and installer on the target OS (x64 or arm64).')
  }
  execFileSync(process.execPath, [join(__dirname, 'build-native.cjs'), `--arch=${arch}`], {
    stdio: 'inherit'
  })
}
