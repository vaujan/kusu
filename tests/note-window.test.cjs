const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const test = require('node:test')

const controllerSource = readFileSync(require.resolve('../src/main/window/note-window.ts'), 'utf8')
const rendererSource = readFileSync(
  require.resolve('../src/renderer/src/features/items/note-window-app.tsx'),
  'utf8'
)
const menuSource = readFileSync(
  require.resolve('../src/renderer/src/features/items/item-action-menu.tsx'),
  'utf8'
)
const entrySource = readFileSync(require.resolve('../src/renderer/src/main.tsx'), 'utf8')
const mainWindowSource = readFileSync(
  require.resolve('../src/main/window/create-main-window.ts'),
  'utf8'
)
const windowControlsSource = readFileSync(
  require.resolve('../src/renderer/src/features/shell/window-controls.tsx'),
  'utf8'
)

test('uses renderer window controls for frameless Linux and Windows windows', () => {
  assert.match(mainWindowSource, /frame: isMac/)
  assert.match(controllerSource, /frame: isMac/)
  assert.match(
    windowControlsSource,
    /const hasCustomControls = platform !== 'darwin' && !nativeTitleBar/
  )
  assert.match(windowControlsSource, /if \(!hasCustomControls\) return null/)
  assert.match(windowControlsSource, /function LinuxCaptionIcon/)
  assert.match(windowControlsSource, /strokeWidth="1\.25"/)
  assert.match(windowControlsSource, /strokeLinecap="square"/)
  assert.match(windowControlsSource, /appearance === 'linux'/)
  assert.match(windowControlsSource, /h-10 w-10 text-foreground/)
  assert.doesNotMatch(windowControlsSource, /size-6 rounded-full bg-foreground/)
})

test('deduplicates note windows and rejects non-note items', () => {
  assert.match(controllerSource, /private readonly windows = new Map<string, BrowserWindow>\(\)/)
  assert.match(controllerSource, /const existing = this\.windows\.get\(itemId\)/)
  assert.match(controllerSource, /const pending = this\.opening\.get\(itemId\)/)
  assert.match(controllerSource, /existing\.show\(\)[\s\S]*existing\.focus\(\)/)
  assert.match(controllerSource, /if \(item\.type !== 'note'\) throw new Error/)
  assert.match(controllerSource, /this\.windows\.delete\(itemId\)/)
})

test('waits for note autosave before allowing a detached window to close', () => {
  assert.match(controllerSource, /noteWindowCloseRequested/)
  assert.match(controllerSource, /if \(approved && !window\.isDestroyed\(\)\)/)
  assert.match(rendererSource, /detailRef\.current\?\.flush\(\)/)
  assert.match(rendererSource, /resolveNoteWindowClose\(approved\)/)
  assert.match(rendererSource, /resolveNoteWindowClose\(false\)/)
})

test('routes note windows to the focused note surface and exposes a note-only action', () => {
  assert.match(entrySource, /surface === 'note-window'/)
  assert.match(entrySource, /<NoteWindowApp itemId=/)
  assert.match(rendererSource, /presentation="focus"/)
  assert.match(rendererSource, /expanded/)
  assert.match(rendererSource, /expandable=\{false\}/)
  assert.match(menuSource, /!bulk && item\.type === 'note'/)
  assert.match(menuSource, /Open in new window/)
  assert.match(menuSource, /Duplicate note/)
})

test('restores live selections and keeps read-mode metrics visible', () => {
  const detailSource = readFileSync(
    require.resolve('../src/renderer/src/features/items/item-detail-dialog.tsx'),
    'utf8'
  )

  assert.match(detailSource, /if \(mode === 'read'\) return[\s\S]{0,180}setSelection\(selection\)/)
  assert.match(detailSource, /\{!item\.missingContent \? \([\s\S]{0,180}note-status-bar/)
})

test('copies the current note draft as Markdown from note action menus', () => {
  assert.match(menuSource, /onClick=\{props\.detailOptions\.onCopyAsMarkdown\}/)
  assert.match(rendererSource, /onClick=\{options\.onCopyAsMarkdown\}/)

  const detailSource = readFileSync(
    require.resolve('../src/renderer/src/features/items/item-detail-dialog.tsx'),
    'utf8'
  )
  assert.match(detailSource, /copyTextToClipboard\(snapshot\.draft\)/)
  assert.match(detailSource, /if \(copied\) notifyCopiedAsMarkdown\(\)/)
})

test('opens attachment management as a dialog from the detached note menu', () => {
  assert.match(rendererSource, /onClick=\{options\.onManageAttachments\}/)
  assert.doesNotMatch(rendererSource, /options\.attachmentsMenu|DropdownMenuSubTrigger/)
})

test('exposes native file and image copying from detail context menus', () => {
  const detailSource = readFileSync(
    require.resolve('../src/renderer/src/features/items/item-detail-dialog.tsx'),
    'utf8'
  )
  assert.match(detailSource, /<NoteReadContextMenu itemId=\{item\.id\} onError=\{onError\}>/)
  assert.match(detailSource, /window\.kusu\.copyItemPath\(itemId\)/)
  assert.match(detailSource, /window\.kusu\.copyImage\(itemId\)/)
  assert.match(
    detailSource,
    /<ItemClipboardContextMenu[\s\S]{0,160}image=\{item\.type === 'image'\}/
  )
})
