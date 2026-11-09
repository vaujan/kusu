const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const test = require('node:test')
require('./helpers/install-ts-require.cjs')()

const {
  applyTranslucentBackground,
  isTranslucentBackgroundSupported,
  parseTranslucentBackgroundRequest,
  parseWindowsBuild,
  resolveTranslucentBackgroundStatus
} = require('../src/main/window/window-material.ts')
const {
  parseNativeThemeSource,
  resolveTranslucentBackgroundPreference
} = require('../src/shared/window-contract.ts')

test('derives Acrylic colors from active theme tokens with neutral sidebar interactions', () => {
  const css = readFileSync(
    require.resolve('../src/renderer/src/assets/window-material.css'),
    'utf8'
  )

  assert.doesNotMatch(css, /oklch\(/)
  assert.match(css, /var\(--background\)/)
  assert.match(css, /var\(--popover\)/)
  assert.match(
    css,
    /--sidebar-selection: color-mix\(in oklch, var\(--sidebar-foreground\) 14%, transparent\)/
  )
  assert.match(
    css,
    /--sidebar-accent: color-mix\(in oklch, var\(--sidebar-foreground\) 8%, transparent\)/
  )
  assert.match(css, /--sidebar-selection-foreground: var\(--sidebar-foreground\)/)
  assert.match(css, /--sidebar-accent-foreground: var\(--sidebar-foreground\)/)
  assert.doesNotMatch(css, /--sidebar-selection: var\(--sidebar-primary\)/)
  assert.doesNotMatch(css, /material-sidebar-(?:accent|selection)/)
  assert.match(
    css,
    /\[data-slot='sidebar'\]\[data-variant='floating'\][\s\S]*?background-color: color-mix\(in oklch, var\(--sidebar\) 72%, transparent\)[\s\S]*?backdrop-filter: blur\(32px\) saturate\(1\.25\)/
  )
  assert.match(css, /prefers-reduced-transparency[\s\S]*?backdrop-filter: none/)
  assert.match(css, /:root\.dark\[data-window-material='acrylic'\]/)
  assert.equal(
    (
      css.match(/--window-canvas: color-mix\(in oklch, var\(--background\) 78%, transparent\)/g) ??
      []
    ).length,
    2
  )
  assert.match(
    css,
    /\.window-canvas,\s*\.window-toolbar \{\s*background-color: var\(--window-canvas\)/
  )
  assert.doesNotMatch(css, /--window-toolbar/)
  assert.match(
    css,
    /--window-rail: color-mix\(in srgb, var\(--window-sidebar\) 72%, var\(--window-canvas\)\)/
  )
  assert.match(css, /\.focus-rail-surface \{\s*background-color: var\(--window-rail\)/)
  assert.match(css, /html\[data-window-material='acrylic'\] body/)
  assert.match(css, /html\[data-window-material='acrylic'\] #root/)
  assert.match(css, /\.settings-window \[data-slot='sidebar-inner'\][\s\S]*?var\(--sidebar\) 90%/)
  assert.match(
    css,
    /\.settings-window \[data-slot='sidebar-inset'\][\s\S]*?var\(--background\) 88%/
  )
})

test('defaults to opaque and enables translucency only by explicit preference', () => {
  assert.equal(resolveTranslucentBackgroundPreference(null), false)
  assert.equal(resolveTranslucentBackgroundPreference('true'), true)
  assert.equal(resolveTranslucentBackgroundPreference('false'), false)
  assert.equal(resolveTranslucentBackgroundPreference('invalid'), false)
})

test('accepts only supported native theme sources', () => {
  assert.equal(parseNativeThemeSource('dark'), 'dark')
  assert.equal(parseNativeThemeSource('light'), 'light')
  assert.equal(parseNativeThemeSource('system'), 'system')
  assert.throws(() => parseNativeThemeSource('sepia'), /Unsupported native theme source/)
  assert.throws(() => parseNativeThemeSource(null), /Unsupported native theme source/)
})

test('parses Windows build numbers and rejects malformed versions', () => {
  assert.equal(parseWindowsBuild('10.0.22621'), 22621)
  assert.equal(parseWindowsBuild('10.0.26200.1'), 26200)
  assert.equal(parseWindowsBuild('10.0'), null)
  assert.equal(parseWindowsBuild('10.0.invalid'), null)
})

test('supports Acrylic only on Windows 11 22H2 and newer', () => {
  assert.equal(isTranslucentBackgroundSupported('win32', '10.0.22621'), true)
  assert.equal(isTranslucentBackgroundSupported('win32', '10.0.22000'), false)
  assert.equal(isTranslucentBackgroundSupported('darwin', '23.0.0'), false)
})

test('resolves requested, reduced, and effective translucency independently', () => {
  assert.deepEqual(resolveTranslucentBackgroundStatus('win32', '10.0.22621', true, false), {
    supported: true,
    enabled: true,
    reducedTransparency: false
  })
  assert.deepEqual(resolveTranslucentBackgroundStatus('win32', '10.0.22621', true, true), {
    supported: true,
    enabled: false,
    reducedTransparency: true
  })
  assert.deepEqual(resolveTranslucentBackgroundStatus('win32', '10.0.22621', false, false), {
    supported: true,
    enabled: false,
    reducedTransparency: false
  })
  assert.deepEqual(resolveTranslucentBackgroundStatus('win32', '10.0.22000', true, true), {
    supported: false,
    enabled: false,
    reducedTransparency: false
  })
})

test('applies Acrylic or restores the safe opaque background', () => {
  const calls = []
  const target = {
    setBackgroundColor: (color) => calls.push(['color', color]),
    setBackgroundMaterial: (material) => calls.push(['material', material])
  }

  applyTranslucentBackground(target, 'win32', '10.0.22621', true, false)
  assert.deepEqual(calls, [
    ['color', '#00000000'],
    ['material', 'acrylic']
  ])

  calls.length = 0
  applyTranslucentBackground(target, 'win32', '10.0.22621', false, false)
  assert.deepEqual(calls, [
    ['material', 'none'],
    ['color', '#181c1d']
  ])

  calls.length = 0
  applyTranslucentBackground(target, 'win32', '10.0.22621', true, true)
  assert.deepEqual(calls, [
    ['material', 'none'],
    ['color', '#181c1d']
  ])
})

test('rejects invalid IPC preference values', () => {
  assert.equal(parseTranslucentBackgroundRequest(true), true)
  assert.throws(() => parseTranslucentBackgroundRequest('true'), /must be a boolean/)
  assert.throws(() => parseTranslucentBackgroundRequest(null), /must be a boolean/)
})

test('Linux uses an alpha background without Windows material APIs', () => {
  const calls = []
  const window = {
    setBackgroundColor: (color) => calls.push(color),
    setBackgroundMaterial: () => {
      throw new Error('Windows-only API')
    }
  }
  assert.deepEqual(applyTranslucentBackground(window, 'linux', '6.18', true, false), {
    supported: true,
    enabled: true,
    reducedTransparency: false
  })
  assert.equal(calls.pop(), '#00000000')
  assert.equal(applyTranslucentBackground(window, 'linux', '6.18', true, true).enabled, false)
  assert.equal(calls.pop(), '#181c1d')
  assert.equal(applyTranslucentBackground(window, 'linux', '6.18', false, false).enabled, false)
  assert.equal(calls.pop(), '#181c1d')
})
