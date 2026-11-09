const assert = require('node:assert/strict')
const { existsSync, readFileSync } = require('node:fs')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')
require('./helpers/install-ts-require.cjs')()

const { LibraryService } = require('../src/main/library/library-service.ts')
const {
  addRecentSearchItem,
  resolveQuickOpenItems,
  resolveRecentSearchItems
} = require('../src/renderer/src/features/search/global-search-state.ts')

test('global search matches every query term and ranks title matches before body matches', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'kusu-global-search-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const service = new LibraryService(join(root, 'settings.json'))
  await service.createIn(root, 'Vault')

  const bodyMatch = await service.createNote({
    markdown: '# References\n\nA blue comparison of every pricing page.',
    attachmentIds: []
  })
  const titleMatch = await service.createNote({
    markdown: '# Blue pricing\n\nFinal direction.',
    attachmentIds: []
  })
  await service.createNote({
    markdown: '# Blue homepage\n\nNo commercial details.',
    attachmentIds: []
  })

  const result = await service.queryItems({ query: 'blue pricing' })

  assert.deepEqual(result.itemIds, [titleMatch.id, bodyMatch.id])
})

test('global search preserves Unicode substring matching, ranking and snapshot order', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'kusu-search-parity-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const service = new LibraryService(join(root, 'settings.json'))
  await service.createIn(root, 'Vault')

  const phrase = 'Élan rose'
  const body = await service.createNote({
    markdown: `# References\n\n${'padding '.repeat(400)}${phrase}`,
    attachmentIds: []
  })
  const prefix = await service.createNote({ markdown: `# ${phrase} draft`, attachmentIds: [] })
  const exact = await service.createNote({ markdown: `# ${phrase}`, attachmentIds: [] })
  const infix = await service.createNote({ markdown: `# Final ${phrase}`, attachmentIds: [] })
  const reordered = await service.createNote({ markdown: '# Rose and élan', attachmentIds: [] })
  const secondBody = await service.createNote({
    markdown: `# Appendix\n\n${phrase}`,
    attachmentIds: []
  })
  const snapshot = await service.queryItems({ query: '  ' })
  const tied = snapshot.itemIds.filter((id) => id === body.id || id === secondBody.id)
  assert.equal(tied.length, 2)

  const result = await service.queryItems({ query: '  ÉLAN ROSE  ' })
  assert.deepEqual(result.itemIds, [exact.id, prefix.id, infix.id, reordered.id, ...tied])
  assert.equal(result.revision, snapshot.revision)

  const substring = await service.queryItems({ query: 'lan\tros' })
  assert.deepEqual(new Set(substring.itemIds), new Set(result.itemIds))
})

test('global search follows the active vault when switching back and forth', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'kusu-search-vault-switch-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const service = new LibraryService(join(root, 'settings.json'))
  await service.createIn(root, 'First')
  const first = await service.createNote({ markdown: '# Shared phrase', attachmentIds: [] })
  const query = { query: 'shared phrase' }
  assert.deepEqual((await service.queryItems(query)).itemIds, [first.id])

  await service.createIn(root, 'Second')
  assert.deepEqual((await service.queryItems(query)).itemIds, [])
  const second = await service.createNote({ markdown: '# Shared phrase', attachmentIds: [] })
  assert.deepEqual((await service.queryItems(query)).itemIds, [second.id])

  await service.openAt(join(root, 'First'))
  assert.deepEqual((await service.queryItems(query)).itemIds, [first.id])
})

test('recent search items are unique, bounded, ordered, and omit internal attachments', () => {
  let recent = []
  for (let index = 0; index < 10; index += 1) {
    recent = addRecentSearchItem(recent, `item-${index}`)
  }
  recent = addRecentSearchItem(recent, 'item-5')

  assert.deepEqual(recent, [
    'item-5',
    'item-9',
    'item-8',
    'item-7',
    'item-6',
    'item-4',
    'item-3',
    'item-2'
  ])

  const items = [
    { id: 'item-9', referencedAttachment: false },
    { id: 'item-5', referencedAttachment: false },
    { id: 'item-8', referencedAttachment: true }
  ]
  assert.deepEqual(
    resolveRecentSearchItems(items, recent).map((item) => item.id),
    ['item-5', 'item-9']
  )
})

test('quick open matches titles and filenames without searching note contents', () => {
  const items = [
    {
      id: 'title',
      type: 'note',
      title: 'Pricing notes',
      body: 'Unrelated',
      relativePath: 'notes/Pricing notes.md',
      referencedAttachment: false
    },
    {
      id: 'filename',
      type: 'file',
      title: 'Proposal',
      sourceFilename: 'pricing-roadmap.pdf',
      contentFilename: 'file-1.pdf',
      relativePath: 'files/file-1.pdf',
      referencedAttachment: false
    },
    {
      id: 'body',
      type: 'note',
      title: 'Meeting notes',
      body: 'Pricing details',
      relativePath: 'notes/Meeting notes.md',
      referencedAttachment: false
    }
  ]

  assert.deepEqual(
    resolveQuickOpenItems(items, 'pricing').map((item) => item.id),
    ['title', 'filename']
  )
})

test('global search uses inline overview and rail inputs without a dialog', () => {
  const toolbar = readFileSync(
    require.resolve('../src/renderer/src/features/shell/app-toolbar.tsx'),
    'utf8'
  )
  const railHeader = readFileSync(
    require.resolve('../src/renderer/src/features/items/focus-list-header.tsx'),
    'utf8'
  )
  const search = readFileSync(
    require.resolve('../src/renderer/src/features/search/use-library-search.ts'),
    'utf8'
  )

  assert.match(toolbar, /<LibrarySearchInput/)
  assert.match(railHeader, /aria-controls="focus-library-search"/)
  assert.match(railHeader, /searchOpen \? \(/)
  assert.match(railHeader, /<LibrarySearchInput/)
  assert.match(search, /window\.kusu\.queryItems/)
  assert.match(search, /if \(cancelled\) return/)
  assert.equal(
    existsSync(join(__dirname, '../src/renderer/src/features/search/global-search-dialog.tsx')),
    false
  )
})

test('quick open creates notes while full-text search remains separate', () => {
  const searchInput = readFileSync(
    require.resolve('../src/renderer/src/features/search/library-search-input.tsx'),
    'utf8'
  )
  const quickOpen = readFileSync(
    require.resolve('../src/renderer/src/features/search/quick-open-dialog.tsx'),
    'utf8'
  )
  const toolbar = readFileSync(
    require.resolve('../src/renderer/src/features/shell/app-toolbar.tsx'),
    'utf8'
  )
  const workspace = readFileSync(
    require.resolve('../src/renderer/src/features/library/workspace.tsx'),
    'utf8'
  )

  assert.match(searchInput, /aria-label="Search"/)
  assert.match(toolbar, /scopeLabel=\{destinationLabel\}/)
  assert.match(searchInput, /title=\{scopeLabel\}/)
  assert.match(searchInput, /aria-keyshortcuts="Control\+Shift\+F Meta\+Shift\+F"/)
  assert.doesNotMatch(searchInput, /onCreateNote|Create note/)
  assert.match(quickOpen, /title="Quick Open"/)
  assert.match(quickOpen, /event\.key\.toLocaleLowerCase\(\) !== 'o'/)
  assert.match(quickOpen, /aria-keyshortcuts="Control\+O Meta\+O"/)
  assert.match(quickOpen, /resolveQuickOpenItems/)
  assert.doesNotMatch(quickOpen, /GlobalSearchPreview/)
  assert.match(toolbar, /<LibrarySearchInput/)
  assert.doesNotMatch(toolbar, /Find or create…/)
  assert.match(quickOpen, /onCreateNote\(normalizedQuery\)/)
  assert.match(quickOpen, /Create note “\{normalizedQuery\}”/)
  assert.match(workspace, /createNote\(\{ markdown: `# \$\{title\}`, attachmentIds: \[\] \}\)/)
  assert.match(workspace, /onCreateNote=\{createNoteFromSearch\}/)
})

test('dialog surfaces open without animation and dim without backdrop blur', () => {
  const dialog = readFileSync(
    require.resolve('../src/renderer/src/components/ui/dialog.tsx'),
    'utf8'
  )
  const alertDialog = readFileSync(
    require.resolve('../src/renderer/src/components/ui/alert-dialog.tsx'),
    'utf8'
  )

  assert.doesNotMatch(dialog, /backdrop-blur|data-open:animate-in|zoom-in/)
  assert.doesNotMatch(alertDialog, /backdrop-blur/)
})

test('cached search documents follow note edits, renames and removals', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'kusu-search-update-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const service = new LibraryService(join(root, 'settings.json'))
  await service.createIn(root, 'Vault')
  const note = await service.createNote({
    markdown: '# Before\n\nOriginal needle.',
    attachmentIds: []
  })
  assert.deepEqual((await service.queryItems({ query: 'original needle' })).itemIds, [note.id])
  await service.updateNote({
    itemId: note.id,
    markdown: '# After\n\nReplacement haystack.',
    expectedMarkdown: note.body
  })
  assert.deepEqual((await service.queryItems({ query: 'original needle' })).itemIds, [])
  assert.deepEqual((await service.queryItems({ query: 'replacement haystack' })).itemIds, [note.id])
  await service.renameItem({ itemId: note.id, title: 'Renamed title' })
  assert.deepEqual((await service.queryItems({ query: 'renamed title' })).itemIds, [note.id])
  await service.trashItems({ itemIds: [note.id] })
  await service.permanentlyDeleteItems({ itemIds: [note.id] })
  assert.deepEqual((await service.queryItems({ query: 'renamed title' })).itemIds, [])
})
