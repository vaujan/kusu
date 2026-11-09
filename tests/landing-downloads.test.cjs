const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { runInNewContext } = require('node:vm')
const test = require('node:test')
const ts = require('typescript')
const script = ts.transpile(readFileSync('landing-page/src/downloads.ts', 'utf8'), {
  target: ts.ScriptTarget.ES2022
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function render(response, lang = 'en') {
  const elements = new Map()
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const createElement = () => ({
    children: [],
    textContent: '',
    attributes: new Map([['aria-busy', 'true']]),
    removeAttribute(name) {
      this.attributes.delete(name)
    },
    append(child) {
      this.children.push(child)
    },
    replaceChildren() {
      this.children = []
    },
    get childElementCount() {
      return this.children.length
    }
  })
  const document = {
    documentElement: { lang },
    createElement,
    querySelectorAll() {
      return ['windows', 'macos', 'linux'].map((platform) =>
        this.querySelector(`[data-download-platform="${platform}"]`)
      )
    },
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, createElement())
      return elements.get(selector)
    }
  }
  runInNewContext(script, {
    document,
    Intl,
    AbortSignal,
    fetch: async () => {
      if (response instanceof Error) throw response
      return response
    }
  })
  await new Promise(setImmediate)
  return elements
}

test('download page offers published preview installers and source from the same tag', async () => {
  const root = 'https://github.com/vaujan/kusu/releases/download/v0.0.3-preview.1/'
  const filenames = [
    'kuskus-0.0.3-x64-setup.exe',
    'kuskus-0.0.3-arm64.dmg',
    'kuskus-0.0.3-x64.dmg',
    'kuskus-0.0.3-x86_64.AppImage'
  ]
  const assets = filenames.map((name) => ({
    name,
    size: 104857600,
    browser_download_url: root + name
  }))
  assets.push({
    name: 'untrusted-setup.exe',
    size: 1,
    browser_download_url: 'https://example.org/file.exe'
  })
  const elements = await render({
    ok: true,
    json: async () => [{ tag_name: 'v0.0.3-preview.1', draft: false, prerelease: true, assets }]
  })
  assert.equal(elements.get('[data-download-platform="windows"]').children.length, 1)
  assert.equal(elements.get('[data-download-platform="macos"]').children.length, 2)
  assert.equal(elements.get('[data-download-platform="linux"]').children.length, 1)
  assert.match(elements.get('[data-download-status]').textContent, /Experimental preview/)
  assert.match(elements.get('[data-download-status]').textContent, /installed manually/)
  for (const platform of ['windows', 'macos', 'linux']) {
    assert.equal(
      elements.get(`[data-download-platform="${platform}"]`).attributes.has('aria-busy'),
      false
    )
  }
  const source = elements.get('[data-release-files]').children[0]
  assert.equal(source.href, 'https://github.com/vaujan/kusu/archive/refs/tags/v0.0.3-preview.1.zip')
})

test('download page identifies Windows previews with update metadata', async () => {
  const tag = 'v0.0.15-preview.1'
  const elements = await render({
    ok: true,
    json: async () => [
      {
        tag_name: tag,
        draft: false,
        prerelease: true,
        assets: [
          {
            name: 'preview.yml',
            size: 512,
            browser_download_url: `https://github.com/vaujan/kusu/releases/download/${tag}/preview.yml`
          }
        ]
      }
    ]
  })
  assert.match(
    elements.get('[data-download-status]').textContent,
    /Windows previews can update from Settings/
  )
})

test('download page distinguishes unpublished releases, missing platform assets, and network errors', async () => {
  let elements = await render({ ok: true, json: async () => [] }, 'id')
  assert.match(elements.get('[data-download-status]').textContent, /belum dipublikasikan/)
  for (const platform of ['windows', 'macos', 'linux']) {
    const container = elements.get(`[data-download-platform="${platform}"]`)
    assert.match(container.textContent, /belum dipublikasikan/)
    assert.equal(container.attributes.has('aria-busy'), false)
  }
  elements = await render({
    ok: true,
    json: async () => [{ tag_name: 'v1', assets: [], draft: false, prerelease: false }]
  })
  assert.match(elements.get('[data-download-platform="windows"]').textContent, /No files/)
  assert.doesNotMatch(elements.get('[data-download-status]').textContent, /Experimental preview/)
  for (const response of [new Error('offline'), { ok: false, status: 403 }]) {
    elements = await render(response)
    assert.match(elements.get('[data-download-status]').textContent, /could not be loaded/)
    for (const platform of ['windows', 'macos', 'linux']) {
      const container = elements.get(`[data-download-platform="${platform}"]`)
      assert.match(container.textContent, /could not be loaded/)
      assert.equal(container.attributes.has('aria-busy'), false)
    }
  }
})
