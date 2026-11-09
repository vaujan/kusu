const assert = require('node:assert/strict')
const test = require('node:test')
require('./helpers/install-ts-require.cjs')()
const { NativeSearch } = require('../src/main/native-search.ts')

// Independent oracle: the Electron search algorithm before the Rust integration.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function reference(items, query) {
  const terms = query.split(/\s+/)
  return items
    .map((item, index) => {
      const title = item.title.toLocaleLowerCase()
      const supporting = (
        item.type === 'note'
          ? item.body
          : item.type === 'image'
            ? (item.sourceFilename ?? item.contentFilename)
            : item.type === 'file'
              ? `${item.sourceFilename} ${item.contentFilename}`
              : `${item.domain} ${item.sourceUrl} ${item.description ?? ''}`
      ).toLocaleLowerCase()
      if (!terms.every((term) => `${title} ${supporting}`.includes(term))) return null
      const score =
        title === query
          ? 0
          : title.startsWith(query)
            ? 1
            : title.includes(query)
              ? 2
              : terms.every((term) => title.includes(term))
                ? 3
                : supporting.includes(query)
                  ? 4
                  : 5
      return { id: item.id, index, score }
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((match) => match.id)
}

test('Rust matches existing rankings, multi-term searches, Unicode and every item type', async () => {
  const search = new NativeSearch()
  const phrases = [
    'blue pricing',
    'blue x pricing',
    'BLUE PRICING plan',
    'prefix blue pricing',
    '无界 日本語',
    'İSTANBUL café Σίσυφος',
    'emoji 🌿',
    'no match'
  ]
  const items = []
  for (let index = 0; index < 512; index += 1) {
    items.push({
      id: `n${index}`,
      type: 'note',
      title: phrases[index % phrases.length],
      body: phrases[Math.floor(index / 8) % phrases.length]
    })
  }
  items.push(
    {
      id: 'image',
      type: 'image',
      title: 'reference',
      sourceFilename: null,
      contentFilename: 'BLUE.png'
    },
    {
      id: 'file',
      type: 'file',
      title: 'proposal',
      sourceFilename: 'pricing.pdf',
      contentFilename: 'blue.pdf'
    },
    {
      id: 'url',
      type: 'url',
      title: 'website',
      domain: 'blue.test',
      sourceUrl: 'https://blue.test/pricing',
      description: 'café'
    }
  )
  for (const query of [
    ...phrases,
    'blue',
    'pricing blue',
    'blue\tpricing',
    'blue\u00a0pricing',
    '🌿',
    '日本',
    'café',
    'absent',
    'i\u0307'
  ]) {
    const normalized = query.toLocaleLowerCase()
    assert.deepEqual(await search.query(items, normalized), reference(items, normalized), query)
  }
})

test('queued Rust queries keep their snapshot across edits, removals, reordering and clear', async () => {
  const search = new NativeSearch()
  const first = { id: 'first', type: 'note', title: 'blue', body: 'old content' }
  const second = { id: 'second', type: 'note', title: 'blue', body: 'old content' }
  const oldItems = [first, second]
  const before = search.query(oldItems, 'old')
  const edited = { ...first, body: 'new content' }
  const after = search.query([second, edited], 'blue')
  const removed = search.query([edited], 'old')
  search.clear()
  const reopened = search.query([second], 'old')
  assert.deepEqual(await before, ['first', 'second'])
  assert.deepEqual(await after, ['second', 'first'])
  assert.deepEqual(await removed, [])
  assert.deepEqual(await reopened, ['second'])
})
