import type {
  ApiResult,
  CollectionDto,
  CreateNoteInput,
  MoveItemsInput,
  UpdateNoteInput,
  FileItemDto,
  ImageItemDto,
  ImagePreviewDto,
  KusuLibraryApi,
  LibraryDto,
  LibraryItemDto,
  LibraryOverviewDto,
  NoteItemDto,
  UrlItemDto,
  UrlPreviewKind
} from '../../../shared/library-contract'
import type { LibraryDestination } from '../features/shell/library-sidebar'
import { createLibrarySearch } from '../../../shared/library-search'
import type { CaptureApi } from '../../../shared/capture-contract'
import type { ElectronWindowApi } from '../../../shared/window-contract'
import { NOTE_FORMATTING_MARKDOWN, SAMPLE_NOTE } from '../features/items/note-story-fixtures'
import notebookImage from './assets/wireframe-notebook.webp?url'
import paletteImage from './assets/material-palette.webp?url'
import { studentCollections, studentItems } from './student-library-fixtures'
import { bookmarkAsset } from './bookmark-assets'

const date = '2026-09-24T00:00:00.000Z'
const inbox = { type: 'inbox' } as const
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data })
const unavailable = (): ApiResult<never> => ({
  ok: false,
  code: 'invalid-input',
  error: 'This action is unavailable in the demo preview.'
})
const unsubscribe = (): void => {}

function note(id: string, title: string, body: string): NoteItemDto {
  return { ...SAMPLE_NOTE, id, title, body, relativePath: `${title}.md`, location: inbox }
}

export const planningNote = note('planning', 'Project notes', SAMPLE_NOTE.body)
export const formattingNote = note('formatting', 'Writing patterns', NOTE_FORMATTING_MARKDOWN)
export const meetingNote = note(
  'meeting',
  'Research meeting',
  '# Research meeting\n\n## Decisions\n\n- Keep the library easy to scan.\n- Put supporting references beside each note.\n\n## Follow up\n\n- [ ] Review the image studies\n- [ ] Share the project brief'
)

export const image: ImageItemDto = {
  schemaVersion: 2,
  id: 'notebook-image',
  type: 'image',
  title: 'Notebook wireframe',
  createdAt: date,
  updatedAt: date,
  sourceFilename: 'wireframe-notebook.png',
  contentFilename: 'wireframe-notebook.png',
  mediaType: 'image/png',
  width: 1254,
  height: 1254,
  missingContent: false,
  location: inbox,
  relativePath: 'wireframe-notebook.png',
  referencedAttachment: false,
  attachmentOrigin: null
}

export const paletteImageItem: ImageItemDto = {
  ...image,
  id: 'palette-image',
  title: 'Material palette',
  sourceFilename: 'material-palette.png',
  contentFilename: 'material-palette.png',
  relativePath: 'material-palette.png',
  width: 2172,
  height: 724
}

export const link: UrlItemDto = {
  schemaVersion: 2,
  id: 'design-link',
  type: 'url',
  title: 'Design systems that scale',
  createdAt: date,
  updatedAt: date,
  sourceUrl: 'https://example.com/design-systems',
  domain: 'example.com',
  description: 'A reference for reusable interface patterns and documentation.',
  siteName: 'Design Journal',
  contentKind: 'webpage',
  metadataVersion: 1,
  hasFavicon: true,
  hasPreviewImage: true,
  metadataStatus: 'ready',
  metadataError: null,
  location: inbox,
  relativePath: 'Design systems that scale.url',
  referencedAttachment: false
}

export const file: FileItemDto = {
  schemaVersion: 2,
  id: 'project-brief',
  type: 'file',
  title: 'Project brief.pdf',
  createdAt: date,
  updatedAt: date,
  sourceFilename: 'Project brief.pdf',
  contentFilename: 'Project brief.pdf',
  mediaType: 'application/pdf',
  size: 184_320,
  missingContent: false,
  location: inbox,
  relativePath: 'Project brief.pdf',
  referencedAttachment: false
}

export function library(
  id: string,
  items: LibraryItemDto[],
  options: { name?: string; collections?: CollectionDto[] } = {}
): LibraryDto {
  return {
    schemaVersion: 2,
    id,
    name: options.name ?? 'Storybook Library',
    path: `/storybook/${id}`,
    createdAt: date,
    pinnedItemIds: items.length ? [items[0].id] : [],
    items,
    collections: options.collections ?? []
  }
}

function overview(value: LibraryDto, revision: number): LibraryOverviewDto {
  return {
    ...value,
    revision,
    rebuildState: 'ready',
    items: value.items.map((item) => {
      if (item.type !== 'note') return item
      const { body, ...summary } = item
      return { ...summary, previewMarkdown: body }
    })
  }
}

async function imagePreview(
  url: string,
  width: number,
  height: number
): Promise<ApiResult<ImagePreviewDto>> {
  const bytes = await fetch(url).then((response) => response.arrayBuffer())
  return ok({ bytes, mediaType: 'image/webp', width, height })
}

export type PreviewTextUpdate = { updatedAtMs: number | null; relativePath: string } & (
  | Pick<NoteItemDto, 'id' | 'type' | 'body' | 'missingContent'>
  | (Pick<UrlItemDto, 'id' | 'type' | 'sourceUrl' | 'domain' | 'contentKind'> & {
      error: string | null
    })
)

export function installPreview(
  value: LibraryDto,
  destination: LibraryDestination = inbox,
  platform: ElectronWindowApi['platform'] = 'linux'
): (updates: readonly PreviewTextUpdate[]) => boolean {
  // Demo edits belong to this preview only, never to the shared fixtures or disk.
  value = structuredClone(value)
  const searchLibrary = createLibrarySearch()
  const editedNotes = new Set<string>()
  let revision = 1
  value.items = value.items.map((item) =>
    item.type === 'url'
      ? {
          ...item,
          hasPreviewImage: Boolean(bookmarkAsset(item.sourceUrl, 'preview')),
          hasFavicon: Boolean(bookmarkAsset(item.sourceUrl, 'favicon'))
        }
      : item
  )
  document.documentElement.dataset.platform = platform
  performance.mark('kusu:renderer-entry')
  localStorage.setItem('kusu-sidebar-hidden', 'false')
  localStorage.setItem('kusu-library-view', 'visual')
  localStorage.setItem(
    `kusu-session:v1:${value.path}`,
    JSON.stringify({ destination, typeFilters: [] })
  )

  const readApi = {
    createNote: async ({ markdown }: CreateNoteInput) => {
      const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || 'Untitled note'
      const timestamp = new Date().toISOString()
      const item: NoteItemDto = {
        ...SAMPLE_NOTE,
        id: crypto.randomUUID(),
        title,
        body: markdown,
        createdAt: timestamp,
        updatedAt: timestamp,
        location: inbox,
        relativePath: `${title}.md`
      }
      value.items = [...value.items, item]
      revision += 1
      return ok(item)
    },
    updateNote: async ({ itemId, markdown }: UpdateNoteInput) => {
      const item = value.items.find((entry) => entry.id === itemId)
      if (item?.type !== 'note') return unavailable()
      const updated: NoteItemDto = { ...item, body: markdown, updatedAt: new Date().toISOString() }
      editedNotes.add(itemId)
      value.items = value.items.map((entry) => (entry.id === itemId ? updated : entry))
      revision += 1
      return ok(updated)
    },
    moveItems: async ({ itemIds, destination: nextLocation }: MoveItemsInput) => {
      value.items = value.items.map((item) =>
        itemIds.includes(item.id) ? { ...item, location: nextLocation } : item
      )
      revision += 1
      return ok(value)
    },
    getState: async () => ok({ status: 'ready' as const, library: value }),
    getOverview: async () => ok({ status: 'ready' as const, library: overview(value, revision) }),
    reconcileOverview: async () =>
      ok({ status: 'ready' as const, library: overview(value, revision) }),
    reconcile: async () => ok({ status: 'ready' as const, library: value }),
    getItemDetail: async (itemId: string) => {
      const item = value.items.find((entry) => entry.id === itemId)
      return item ? ok(item) : unavailable()
    },
    queryItems: async ({ query }: { query: string }) =>
      ok({
        revision,
        itemIds: searchLibrary(value.items, query)
      }),
    getImageThumbnail: async (itemId: string) => imagePreviewFor(itemId),
    getImagePreview: async (itemId: string) => imagePreviewFor(itemId),
    getUrlPreview: async (itemId: string, kind: UrlPreviewKind) => {
      const item = value.items.find((entry) => entry.id === itemId)
      const asset = item?.type === 'url' ? bookmarkAsset(item.sourceUrl, kind) : null
      if (!asset) return unavailable()
      const response = await fetch(asset.url)
      if (!response.ok) return unavailable()
      return ok({ bytes: await response.arrayBuffer(), mediaType: asset.mediaType })
    },
    onVaultChanged: () => unsubscribe
  }
  window.kusu = new Proxy(readApi, {
    get(target, property, receiver) {
      return Reflect.get(target, property, receiver) ?? (async () => unavailable())
    }
  }) as unknown as KusuLibraryApi

  const windowApi: ElectronWindowApi = {
    platform,
    minimize: () => {},
    toggleMaximize: () => {},
    close: () => {},
    isMaximized: async () => false,
    onMaximizedChange: () => unsubscribe,
    setZoomFactor: async (factor) => {
      document.documentElement.style.zoom = String(factor)
      document.documentElement.style.setProperty('--preview-zoom', String(factor))
      return factor
    },
    setNativeThemeSource: () => {},
    setTranslucentBackground: async () => ({
      supported: false,
      enabled: false,
      reducedTransparency: false
    }),
    onReducedTransparencyChange: () => unsubscribe,
    onZoomShortcut: () => unsubscribe,
    edit: () => {},
    getSpellingLanguages: async () => ({
      available: ['en-US', 'id'],
      selected: ['en-US', 'id'],
      managedBySystem: false
    }),
    setSpellingLanguages: async (languages) => ({
      available: ['en-US', 'id'],
      selected: languages,
      managedBySystem: false
    }),
    onSpellingLanguagesChanged: () => unsubscribe,
    onTextContextMenu: () => unsubscribe,
    textContextMenuAction: () => {},
    getGlobalCaptureShortcutStatus: async () => ({
      accelerator: 'Super+Shift+K',
      registered: true
    }),
    setGlobalCaptureShortcut: async (accelerator) => ({ accelerator, registered: true }),
    onGlobalCaptureRequested: () => unsubscribe,
    openSettingsWindow: async () => {},
    openNoteWindow: async () => {},
    onNoteWindowCloseRequested: () => unsubscribe,
    resolveNoteWindowClose: () => {}
  }
  window.electron = {
    window: windowApi,
    updates: {
      getStatus: async () => ({
        phase: 'unavailable',
        message: 'Updates are disabled in previews.'
      }),
      check: async () => {},
      download: async () => {},
      install: async () => {},
      onStatus: () => () => {},
      onPrepare: () => () => {}
    }
  }

  const captureApi = {
    getQueue: async () => ok({ pendingCount: 0, failures: [] }),
    onSessionChanged: () => unsubscribe,
    onQueueChanged: () => unsubscribe,
    onRecoveryRequested: () => unsubscribe,
    onMainItemRequested: () => unsubscribe,
    onQuickCaptureActivated: () => unsubscribe
  }
  window.capture = new Proxy(captureApi, {
    get(target, property, receiver) {
      return Reflect.get(target, property, receiver) ?? (async () => unavailable())
    }
  }) as unknown as CaptureApi

  return (updates) => {
    if (!updates.length) return false
    const byId = new Map(updates.map((update) => [update.id, update]))
    let changed = false
    const items = value.items.map((item) => {
      const update = byId.get(item.id)
      if (!update || item.type !== update.type) return item
      const updatedAt =
        update.updatedAtMs === null ? item.updatedAt : new Date(update.updatedAtMs).toISOString()
      const renamed = update.relativePath !== item.relativePath
      const parts = update.relativePath.split('/')
      const filename = parts.pop() ?? ''
      const parent = parts.join('/')
      const oldParent = item.relativePath.split('/').slice(0, -1).join('/')
      let destination = item.location
      if (renamed && parent !== oldParent && item.location.type !== 'trash') {
        if (!parent) {
          destination = inbox
        } else if (parts[0] === 'Archive') {
          destination = {
            type: 'archive',
            originalCollectionId:
              item.location.type === 'collection' ? item.location.collectionId : null
          }
        } else {
          const collection = value.collections.find(
            (entry) => entry.relativePath.toLowerCase() === parent.toLowerCase()
          )
          if (collection) destination = { type: 'collection', collectionId: collection.id }
        }
      }
      const location = renamed
        ? {
            relativePath: update.relativePath,
            title: filename.replace(/\.[^.]+$/, ''),
            location: destination
          }
        : {}
      if (item.type === 'note' && update.type === 'note') {
        if (editedNotes.has(item.id)) {
          if (renamed) changed = true
          return renamed ? { ...item, ...location } : item
        }
        changed = true
        return {
          ...item,
          ...location,
          body: update.body,
          missingContent: update.missingContent,
          updatedAt,
          bodyTruncated: false
        }
      }
      if (item.type === 'url' && update.type === 'url') {
        changed = true
        if (renamed && update.sourceUrl === item.sourceUrl && update.error === null) {
          return { ...item, ...location, updatedAt }
        }
        return {
          ...item,
          ...location,
          sourceUrl: update.sourceUrl,
          domain: update.domain,
          siteName: update.domain,
          contentKind: update.contentKind,
          updatedAt,
          description: null,
          hasFavicon: false,
          hasPreviewImage: false,
          metadataStatus: 'unavailable' as const,
          metadataError: update.error
        }
      }
      return item
    })
    if (changed) {
      value.items = items
      revision += 1
    }
    return changed
  }
}

function imagePreviewFor(itemId: string): Promise<ApiResult<ImagePreviewDto>> {
  if (itemId === 'palette-image') {
    return imagePreview(paletteImage, 2172, 724)
  }
  return imagePreview(notebookImage, 1254, 1254)
}

export const heroCollection = studentCollections[0]
export const heroLocation = { type: 'collection', collectionId: heroCollection.id } as const
export const heroItems = studentItems

export function installHeroPreview(): void {
  installPreview(
    library('landing-hero', heroItems, { name: 'My Library', collections: studentCollections }),
    { type: 'all' }
  )
}
