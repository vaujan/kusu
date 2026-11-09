/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports */
// Windows release smoke: node scripts/smoke-tauri-record-recovery.cjs <exe>
// Creates its own vault and WebView2 profile; never opens the user's selected vault.
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { randomUUID, createHash } = require('node:crypto')
const { mkdtemp, mkdir, writeFile, readFile, stat, rename, access } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { setTimeout: pause } = require('node:timers/promises')
const { createServer } = require('node:net')

async function main() {
  assert.equal(process.platform, 'win32', 'Run this smoke against the Windows WebView2 release.')
  assert.ok(process.argv[2], 'Supply the release executable path.')
  const profile = await mkdtemp(join(tmpdir(), 'kusu-record-recovery-'))
  const vault = join(profile, 'Vault')
  const records = join(vault, '.kuskus', 'records')
  const index = join(vault, '.kuskus', 'index', 'library-v1.json')
  const folderId = randomUUID()
  const noteId = randomUUID()
  const linkId = randomUUID()
  const fileId = randomUUID()
  const createdAt = new Date().toISOString()
  const notePath = join(vault, 'Café', 'Résumé.md')
  const body = '---\naliases: [Résumé]\n---\n# Recovery fixture\r\nExact recovery needle ☕\n'
  await mkdir(records, { recursive: true })
  await mkdir(join(vault, '.kuskus', 'collections'))
  await mkdir(join(vault, 'Café'))
  await writeFile(
    join(vault, '.kuskus', 'library.json'),
    JSON.stringify({
      schemaVersion: 2,
      id: randomUUID(),
      name: 'Record recovery smoke',
      createdAt,
      pinnedItemIds: [noteId]
    })
  )
  await writeFile(
    join(vault, '.kuskus', 'collections', folderId + '.json'),
    JSON.stringify({
      schemaVersion: 2,
      id: folderId,
      name: 'Café',
      icon: 'book',
      relativePath: 'Café',
      parentId: null,
      createdAt
    })
  )
  await writeFile(notePath, body)
  const info = await stat(notePath)
  const noteRecord = {
    schemaVersion: 2,
    id: noteId,
    relativePath: 'Café/Résumé.md',
    fingerprint: createHash('sha256').update(body).digest('hex'),
    fileIdentity: `${info.dev}:${info.ino}`,
    metadata: {
      schemaVersion: 2,
      id: noteId,
      type: 'note',
      title: 'Résumé',
      createdAt,
      updatedAt: createdAt,
      titleSource: 'derived',
      originalCollectionId: null,
      attachments: []
    }
  }
  const savedRecord = JSON.stringify(noteRecord)
  await writeFile(join(records, noteId + '.json'), savedRecord)
  await writeFile(
    join(vault, 'Link.url'),
    '[InternetShortcut]\nURL=https://example.test/recovered\n'
  )
  await writeFile(
    join(records, linkId + '.json'),
    JSON.stringify({
      schemaVersion: 2,
      id: linkId,
      relativePath: 'Link.url',
      metadata: {
        schemaVersion: 2,
        id: linkId,
        type: 'url',
        title: 'Link',
        createdAt,
        updatedAt: createdAt,
        sourceUrl: 'https://old.example/',
        originalCollectionId: null,
        description: 'Stale description'
      }
    })
  )
  const pdf = '%PDF-1.4\n% Read-only media fixture\n'
  await writeFile(join(vault, 'Document.pdf'), pdf)
  await writeFile(
    join(records, fileId + '.json'),
    JSON.stringify({
      schemaVersion: 2,
      id: fileId,
      relativePath: 'Document.pdf',
      metadata: {
        schemaVersion: 2,
        id: fileId,
        type: 'file',
        title: 'Document',
        createdAt,
        updatedAt: createdAt,
        mediaType: 'application/pdf',
        sourceFilename: 'Document.pdf',
        contentFilename: 'Document.pdf',
        size: Buffer.byteLength(pdf),
        originalCollectionId: null
      }
    })
  )

  const server = createServer()
  await new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', done)
  })
  const port = server.address().port
  await new Promise((done) => server.close(done))
  const child = spawn(resolve(process.argv[2]), [], {
    windowsHide: true,
    env: {
      ...process.env,
      KUSU_TAURI_SNAPSHOT: index,
      WEBVIEW2_USER_DATA_FOLDER: join(profile, 'WebView'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`
    }
  })
  let socket
  try {
    let target
    for (let attempt = 0; attempt < 100 && !target; attempt++) {
      try {
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
        target = targets.find((entry) => entry.url === 'http://tauri.localhost/')
      } catch {
        /* The owned app may still be starting. */
      }
      if (!target) await pause(200)
    }
    assert.ok(target, 'The release app did not open its webview.')
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((done, fail) => {
      socket.addEventListener('open', done, { once: true })
      socket.addEventListener('error', fail, { once: true })
    })
    let requestId = 0
    const call = (method, params = {}) =>
      new Promise((done, fail) => {
        const id = ++requestId
        const timeout = setTimeout(() => {
          socket.removeEventListener('message', receive)
          fail(Error(`Timed out: ${method}`))
        }, 15000)
        const receive = ({ data }) => {
          const packet = JSON.parse(data)
          if (packet.id !== id) return
          clearTimeout(timeout)
          socket.removeEventListener('message', receive)
          if (packet.error || packet.result.exceptionDetails) fail(Error(JSON.stringify(packet)))
          else done(packet.result)
        }
        socket.addEventListener('message', receive)
        socket.send(JSON.stringify({ id, method, params }))
      })
    const evaluate = async (expression) =>
      (
        await call('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true
        })
      ).result.value
    const detailExpression = `window.kusu?.getItemDetail(${JSON.stringify(noteId)}).then(r=>r.data)`
    const waitNote = async (expectedBody) => {
      for (let attempt = 0; attempt < 80; attempt++) {
        const note = await evaluate(detailExpression).catch(() => null)
        if (note?.body === expectedBody) return note
        await pause(200)
      }
      throw Error('Recovered note did not reach detail.')
    }
    const reload = async () => {
      // Wait for the old document to go away before observing its replacement.
      const marker = await evaluate('performance.timeOrigin')
      await call('Page.reload', { ignoreCache: true })
      for (let attempt = 0; attempt < 80; attempt++) {
        const next = await evaluate('performance.timeOrigin').catch(() => marker)
        if (next !== marker) return
        await pause(100)
      }
      throw Error('The webview did not reload.')
    }
    for (const cache of [
      null,
      'broken json',
      JSON.stringify({
        schemaVersion: 1,
        library: { schemaVersion: 2, id: 'foreign', items: [], collections: [] }
      })
    ]) {
      if (cache !== null) {
        await mkdir(join(vault, '.kuskus', 'index'), { recursive: true })
        await writeFile(index, cache)
        await reload()
      }
      const note = await waitNote(body)
      assert.equal(note.id, noteId)
      assert.equal(note.location.collectionId, folderId)
      const query = await evaluate('window.kusu.queryItems({query:"recovery needle"})')
      assert.ok(query.data.itemIds.includes(noteId))
      const library = await evaluate('window.kusu.getState().then(r=>r.data.library)')
      assert.equal(library.items.length, 3)
      assert.equal(library.collections[0].icon, 'book')
      const link = library.items.find((item) => item.id === linkId)
      assert.equal(link.sourceUrl, 'https://example.test/recovered')
      assert.equal(link.description, null)
      const bytes = await evaluate(
        `window.kusu.getPdfPreview(${JSON.stringify(fileId)}).then(r=>r.ok ? Array.from(new Uint8Array(r.data)) : r)`
      )
      assert.deepEqual(bytes, Array.from(Buffer.from(pdf)))
      assert.equal(await readFile(notePath, 'utf8'), body)
      assert.equal(await readFile(join(records, noteId + '.json'), 'utf8'), savedRecord)
      if (cache === null) await assert.rejects(access(index))
      else assert.equal(await readFile(index, 'utf8'), cache)
    }
    const renamed = join(vault, 'Café', 'Renamed.md')
    await rename(notePath, renamed)
    const edited = body + 'External edit after recovery\n'
    await writeFile(renamed, edited)
    assert.equal((await waitNote(edited)).relativePath, 'Café/Renamed.md')
    await reload()
    assert.equal((await waitNote(edited)).id, noteId)
    assert.equal(await readFile(join(records, noteId + '.json'), 'utf8'), savedRecord)
    console.log(
      JSON.stringify({
        passed: true,
        checks: [
          'absent cache',
          'corrupt cache',
          'foreign cache',
          'exact note content',
          'folder identity',
          'search',
          'bookmark parsing',
          'PDF bytes',
          'rename with edit',
          'reopen identity',
          'no vault writes'
        ],
        fixture: vault
      })
    )
  } finally {
    socket?.close()
    child.kill()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
