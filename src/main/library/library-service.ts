import { isPdfFile } from '../../shared/file-type'
import { STARTER_TUTORIAL } from '../../shared/starter-tutorial'
import { randomUUID } from 'node:crypto'
import { realpathSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import type {
  ActiveItemLocation,
  CollectionIconKey,
  CreateNoteInput,
  CreateCollectionInput,
  ImageImportInput,
  RenameCaptureDraftImageInput,
  FileImportInput,
  FileItemDto,
  ImageItemDto,
  ImagePreviewDto,
  CollectionDto,
  ItemMutationInput,
  InspectItemDeletionInput,
  ItemDeletionInspectionDto,
  PermanentlyDeleteItemsInput,
  TrashItemsInput,
  LibraryDto,
  LibraryItemSummaryDto,
  LibraryOverviewDto,
  LibraryOverviewState,
  LibraryItemDto,
  LibraryState,
  MoveItemsInput,
  MoveCollectionInput,
  NoteImageImportInput,
  NoteAttachmentDto,
  NoteItemDto,
  QueryItemsInput,
  QueryItemsResult,
  CaptureDraftImageDto,
  CaptureDraftFileDto,
  UpdateNoteInput,
  RenameItemInput,
  SetItemsPinnedInput,
  UrlItemDto,
  UrlPreviewDto,
  UrlPreviewKind
} from '../../shared/library-contract'
import { encodeMarkdownImageTarget } from '../../shared/markdown-image-references'
import type { CaptureSubmissionRecord } from '../capture/capture-submission-record'
import { ITEM_ID_PATTERN, NOTE_FILENAME, RESERVED_WINDOWS_NAMES } from './constants'
import {
  createImageMetadata,
  detectImage,
  safeSourceFilename,
  toImageDto,
  validateImageInput
} from './items/image-item'
import {
  createNoteMetadata,
  deriveNoteTitle,
  noteAttachmentFilename,
  updateNoteMetadata
} from './items/note-item'
import { createUrlMetadata, extractUrlMetadata, toUrlDto, validateWebUrl } from './items/url-item'
import {
  isCollectionIconKey,
  toCollectionDto,
  type PersistedCollection,
  type PersistedItem,
  type PersistedLibrary,
  type PersistedSettings,
  type PersistedUrlItem
} from './schemas'
import { readJson, writeJsonAtomic } from './storage/json-file'
import { LibraryStore } from './storage/library-store'
import {
  defaultUrlNetworkDependencies,
  fetchPublicResource,
  readBoundedBytes,
  readHtmlHead,
  type UrlNetworkDependencies
} from './url-network'
import { toUrlPreviewDto, URL_PREVIEW_LIMITS, validateUrlPreview } from './url-preview'
import { CARD_THUMBNAIL_EDGE, createImageThumbnail } from './image-thumbnail'
import { NativeSearch } from '../native-search'

export class NoteUpdateConflictError extends Error {
  constructor(readonly current: NoteItemDto) {
    super('This note changed on disk while you were editing it.')
    this.name = 'NoteUpdateConflictError'
  }
}

export class LibraryService {
  private currentLibraryPath: string | null = null
  private pendingLibraryPath: string | null = null
  private unavailableLibrary: { path: string; message: string } | null = null
  private readonly store = new LibraryStore((libraryPath, relativePath) => {
    if (this.currentLibraryPath === libraryPath) this.markAppOwnedWrite(relativePath)
  })

  getPerformanceVaultScanCount(): number {
    return this.store.getPerformanceVaultScanCount()
  }

  private readonly urlNetwork: UrlNetworkDependencies
  private readonly enrichmentRequests = new Map<string, Promise<UrlItemDto>>()
  private readonly previewRequests = new Map<string, Promise<UrlPreviewDto>>()
  private readonly thumbnailRequests = new Map<string, Promise<ImagePreviewDto>>()
  private librarySnapshot: LibraryDto | null = null
  private reconciliation: Promise<LibraryDto> | null = null
  private startupReconciliationPending = false
  private vaultDirty = true
  private readonly vaultChangedPaths = new Set<string>()
  private libraryRevision = 0
  private readonly search = new NativeSearch()
  private vaultWatcher: FSWatcher | null = null
  private vaultChangeTimer: NodeJS.Timeout | null = null
  private ignoredAppMoveTimer: NodeJS.Timeout | null = null
  private readonly ignoredAppMovePaths = new Set<string>()
  private readonly recentAppWrites = new Map<string, number>()
  private readonly vaultChangeListeners = new Set<() => void>()

  private markAppOwnedWrite(relativePath: string): void {
    if (!relativePath) return
    let path = relativePath.replace(/\\/g, '/').toLocaleLowerCase()
    const now = Date.now()
    while (path && path !== '.') {
      this.recentAppWrites.set(path, now)
      path = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    }
  }

  private isAppOwnedWrite(relativePath: string): boolean {
    const key = relativePath.replace(/\\/g, '/').toLocaleLowerCase()
    const writtenAt = this.recentAppWrites.get(key)
    if (writtenAt === undefined) return false
    if (Date.now() - writtenAt > 5_000) {
      this.recentAppWrites.delete(key)
      return false
    }
    return true
  }

  constructor(
    private readonly settingsPath: string,
    dependencies: Partial<UrlNetworkDependencies> = {}
  ) {
    this.urlNetwork = { ...defaultUrlNetworkDependencies, ...dependencies }
  }

  isReadyForCapture(): boolean {
    return this.currentLibraryPath !== null
  }

  async getCaptureContext(): Promise<{ libraryId: string; libraryPath: string }> {
    const libraryPath = this.requireCurrentLibrary()
    const library = await this.store.readPersistedLibrary(libraryPath)
    return { libraryId: library.id, libraryPath }
  }

  async prepareCaptureSubmission(record: CaptureSubmissionRecord): Promise<void> {
    const { libraryId, libraryPath } = await this.getCaptureContext()
    if (record.libraryId !== libraryId) throw new Error('The capture library is no longer active.')
    if (
      record.destination.type === 'collection' &&
      !(await this.store.collectionExists(libraryPath, record.destination.collectionId))
    ) {
      throw new Error('The capture destination folder no longer exists.')
    }
    await this.store.prepareCaptureSubmission(libraryPath, record)
  }

  async listCaptureSubmissions(): Promise<CaptureSubmissionRecord[]> {
    return this.store.listCaptureSubmissions(this.requireCurrentLibrary())
  }

  async updateCaptureSubmission(record: CaptureSubmissionRecord): Promise<void> {
    await this.store.writeCaptureSubmission(this.requireCurrentLibrary(), record)
  }

  async discardCaptureSubmission(submissionId: string): Promise<void> {
    await this.store.discardCaptureSubmission(this.requireCurrentLibrary(), submissionId)
  }

  async discardActiveCaptureDraft(): Promise<void> {
    await this.store.discardCaptureDraft(this.requireCurrentLibrary())
    await this.store.discardCaptureDraftFile(this.requireCurrentLibrary())
  }

  async restoreCaptureSubmissionDraft(submissionId: string): Promise<void> {
    await this.store.restoreCaptureSubmissionDraft(this.requireCurrentLibrary(), submissionId)
  }

  async commitCaptureSubmission(record: CaptureSubmissionRecord): Promise<LibraryItemDto> {
    const libraryPath = this.requireCurrentLibrary()
    await this.currentLibraryDto(libraryPath)
    let existing: PersistedItem | null = null
    try {
      existing = await this.store.readPersistedItem(libraryPath, record.id)
    } catch {
      // No authoritative item exists yet.
    }
    if (existing) {
      const item = await this.refreshChangedItem(libraryPath, existing.id)
      if (item) return item
      throw new Error('The saved capture could not be reopened.')
    }

    if (record.kind === 'url') {
      validateWebUrl(record.markdown)
      const metadata = createUrlMetadata(record.id, record.markdown, record.submittedAt)
      await this.store.finalizeInboxItem(libraryPath, metadata, [], record.destination)
      const saved = await this.refreshChangedItem(libraryPath, record.id)
      if (!saved || saved.type !== 'url') throw new Error('The saved link could not be reopened.')
      return saved
    }

    if (record.kind === 'file') {
      if (!record.fileId) throw new Error('The submitted file is missing.')
      const { file, bytes } = await this.store.readCaptureSubmissionFile(
        libraryPath,
        record.id,
        record.fileId
      )
      const imported = await this.store.importVaultFile(
        libraryPath,
        {
          id: record.id,
          filename: file.filename,
          mediaType: file.mediaType,
          bytes,
          timestamp: record.submittedAt
        },
        record.destination
      )
      const saved = await this.refreshChangedItem(libraryPath, imported.id)
      if (saved.type !== 'file') throw new Error('The imported file could not be reopened.')
      return saved
    }

    const staged = await Promise.all(
      record.attachmentIds.map((attachmentId) =>
        this.store.readCaptureSubmissionAttachment(libraryPath, record.id, attachmentId)
      )
    )
    if (record.kind === 'image') {
      if (staged.length !== 1) throw new Error('The submitted image is no longer valid.')
      const detected = detectImage(staged[0].bytes)
      if (!detected) throw new Error('The submitted image content is invalid.')
      const metadata = createImageMetadata(
        record.id,
        staged[0].attachment.sourceFilename,
        detected,
        record.submittedAt
      )
      await this.store.finalizeInboxItem(
        libraryPath,
        metadata,
        [{ filename: metadata.contentFilename, data: staged[0].bytes }],
        record.destination
      )
      const saved = (await this.buildLibraryDto(libraryPath)).items.find(
        (candidate) => candidate.id === record.id
      )
      if (!saved || saved.type !== 'image')
        throw new Error('The saved image could not be reopened.')
      return saved
    }

    if (!record.markdown.trim()) throw new Error('Write something before saving the note.')
    const attachments = staged.map(({ attachment }) => attachment)
    const metadata = createNoteMetadata(record.id, record.markdown, record.submittedAt, attachments)
    await this.store.finalizeInboxItem(
      libraryPath,
      metadata,
      [
        { filename: NOTE_FILENAME, data: record.markdown },
        ...staged.map(({ attachment, bytes }) => ({
          filename: attachment.filename,
          data: bytes
        }))
      ],
      record.destination
    )
    const persisted = await this.store.readPersistedItem(libraryPath, record.id)
    if (persisted.type !== 'note') throw new Error('The saved note could not be reopened.')
    const item = await this.refreshChangedItem(libraryPath, record.id)
    if (item.type !== 'note') throw new Error('The saved note could not be reopened.')
    return item
  }

  async resetOnboarding(): Promise<void> {
    await this.reconciliation
    await writeJsonAtomic(this.settingsPath, {
      schemaVersion: 1,
      lastLibraryPath: null
    } satisfies PersistedSettings)
    this.vaultWatcher?.close()
    this.vaultWatcher = null
    if (this.vaultChangeTimer) clearTimeout(this.vaultChangeTimer)
    this.vaultChangeTimer = null
    if (this.ignoredAppMoveTimer) clearTimeout(this.ignoredAppMoveTimer)
    this.ignoredAppMoveTimer = null
    this.ignoredAppMovePaths.clear()
    this.currentLibraryPath = null
    this.pendingLibraryPath = null
    this.unavailableLibrary = null
    this.librarySnapshot = null
    this.search.clear()
    this.startupReconciliationPending = false
  }

  async initialize(): Promise<void> {
    try {
      const settings = await readJson<PersistedSettings>(this.settingsPath)
      if (settings.schemaVersion !== 1 || !settings.lastLibraryPath) return

      if (await this.store.isUninitializedVault(settings.lastLibraryPath)) {
        this.pendingLibraryPath = settings.lastLibraryPath
        return
      }
      await this.store.readPersistedLibrary(settings.lastLibraryPath)
      this.currentLibraryPath = settings.lastLibraryPath
      this.librarySnapshot = await this.store.readCachedLibraryDto(settings.lastLibraryPath)
      this.startupReconciliationPending = this.librarySnapshot !== null
    } catch (error) {
      if (await this.store.pathExists(this.settingsPath)) {
        const lastPath = await this.readLastLibraryPathSafely()
        if (lastPath) {
          this.unavailableLibrary = {
            path: lastPath,
            message: this.toMessage(error, 'The previous library could not be opened.')
          }
        }
      }
    }
  }

  async getState(preferCached = false): Promise<LibraryState> {
    if (this.currentLibraryPath) {
      try {
        if (preferCached && this.librarySnapshot) {
          if (this.startupReconciliationPending) {
            this.startupReconciliationPending = false
            void this.reconcileCurrentLibrary(true).catch(() => {
              // Keep the last valid rebuildable snapshot usable; a later focus retry can reconcile.
            })
          }
          return { status: 'ready', library: this.librarySnapshot }
        }
        return {
          status: 'ready',
          library: await this.buildLibraryDto(this.currentLibraryPath)
        }
      } catch (error) {
        const path = this.currentLibraryPath
        this.currentLibraryPath = null
        this.unavailableLibrary = {
          path,
          message: this.toMessage(error, 'The current library is unavailable.')
        }
      }
    }

    if (this.pendingLibraryPath) return this.pendingState(this.pendingLibraryPath)

    if (this.unavailableLibrary) return { status: 'unavailable', ...this.unavailableLibrary }
    return { status: 'none' }
  }

  async reconcileState(): Promise<LibraryState> {
    if (!this.currentLibraryPath) return this.getState()
    if (this.librarySnapshot && !this.vaultDirty && this.vaultWatcher) {
      return { status: 'ready', library: this.librarySnapshot }
    }
    try {
      const changedPaths = [...this.vaultChangedPaths]
      this.vaultChangedPaths.clear()
      return {
        status: 'ready',
        library: await this.reconcileCurrentLibrary(false, changedPaths)
      }
    } catch (error) {
      return {
        status: 'unavailable',
        path: this.currentLibraryPath,
        message: this.toMessage(error, 'The current library could not be reconciled.')
      }
    }
  }

  async getOverviewState(): Promise<LibraryOverviewState> {
    return this.toOverviewState(await this.getState(true))
  }

  async reconcileOverviewState(): Promise<LibraryOverviewState> {
    return this.toOverviewState(await this.reconcileState())
  }

  async getItemDetail(itemId: string): Promise<LibraryItemDto> {
    this.validateItemId(itemId, 'item')
    const library = this.reconciliation
      ? await this.reconciliation
      : (this.librarySnapshot ?? (await this.buildLibraryDto(this.requireCurrentLibrary())))
    const item = library.items.find((candidate) => candidate.id === itemId)
    if (!item) throw new Error('The item no longer exists in this library.')
    return item
  }

  async queryItems(input: QueryItemsInput): Promise<QueryItemsResult> {
    if (!input || typeof input !== 'object' || typeof input.query !== 'string') {
      throw new Error('The library query is invalid.')
    }
    const query = input.query.trim().toLocaleLowerCase()
    const library =
      this.librarySnapshot ?? (await this.buildLibraryDto(this.requireCurrentLibrary()))
    if (!query) {
      this.search.clear()
      return { revision: this.libraryRevision, itemIds: library.items.map((item) => item.id) }
    }
    const revision = this.libraryRevision
    const itemIds = await this.search.query(library.items, query)
    return { revision, itemIds }
  }

  private toOverviewState(state: LibraryState): LibraryOverviewState {
    if (state.status !== 'ready') return state
    const items: LibraryItemSummaryDto[] = state.library.items.map((item) =>
      item.type === 'note'
        ? {
            schemaVersion: item.schemaVersion,
            id: item.id,
            type: item.type,
            title: item.title,
            titleSource: item.titleSource,
            previewMarkdown: item.body.slice(0, 2_400),
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            missingContent: item.missingContent,
            attachments: item.attachments,
            location: item.location,
            relativePath: item.relativePath,
            referencedAttachment: false
          }
        : item
    )
    const overview: LibraryOverviewDto = {
      ...state.library,
      items,
      revision: this.libraryRevision,
      rebuildState: this.reconciliation ? 'reconciling' : 'ready'
    }
    return { status: 'ready', library: overview }
  }

  async createIn(parentPath: string, requestedName: string): Promise<LibraryState> {
    const name = this.validateLibraryName(requestedName)
    const libraryPath = join(parentPath, name)
    const library: PersistedLibrary = {
      schemaVersion: 2,
      id: randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      pinnedItemIds: []
    }

    await this.store.prepareNewLibrary(libraryPath, library)
    await this.setCurrentLibrary(libraryPath)
    return this.getState()
  }

  async createWithTutorialIn(parentPath: string, requestedName: string): Promise<LibraryState> {
    await this.createIn(parentPath, requestedName)
    const folder = await this.createCollection({ name: 'Getting started', icon: 'book' })
    const note = await this.createNote({ markdown: STARTER_TUTORIAL, attachmentIds: [] })
    await this.moveItems({
      itemIds: [note.id],
      destination: { type: 'collection', collectionId: folder.id }
    })
    return this.getState()
  }

  async openAt(libraryPath: string): Promise<LibraryState> {
    if (await this.store.isUninitializedVault(libraryPath)) {
      this.pendingLibraryPath = libraryPath
      this.currentLibraryPath = null
      await writeJsonAtomic(this.settingsPath, {
        schemaVersion: 1,
        lastLibraryPath: libraryPath
      } satisfies PersistedSettings)
      return this.pendingState(libraryPath)
    }
    await this.store.readPersistedLibrary(libraryPath)
    await this.store.ensureLibraryDirectories(libraryPath)
    await this.setCurrentLibrary(libraryPath)
    return this.getState()
  }

  async initializePendingVault(): Promise<LibraryState> {
    const path = this.requirePendingLibrary()
    if (!(await this.store.isUninitializedVault(path))) {
      throw new Error('The selected folder no longer needs initialization.')
    }
    await this.store.initializeExistingVault(path)
    await this.setCurrentLibrary(path)
    return this.getState()
  }

  private async pendingState(path: string): Promise<LibraryState> {
    if (await this.store.isUninitializedVault(path)) {
      const preview = await this.store.inspectUninitializedVault(path)
      return { status: 'needs-initialization', path, name: basename(path), ...preview }
    }
    throw new Error('The selected folder is no longer available.')
  }

  async createNote(input: CreateNoteInput): Promise<NoteItemDto> {
    const libraryPath = this.requireCurrentLibrary()
    const { markdown, attachmentIds } = input
    if (!markdown.trim()) throw new Error('Write something before saving the note.')
    if (!Array.isArray(attachmentIds) || attachmentIds.some((id) => !ITEM_ID_PATTERN.test(id))) {
      throw new Error('The note attachment list is invalid.')
    }
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      throw new Error('The note attachment list contains duplicates.')
    }
    await this.store.readPersistedLibrary(libraryPath)

    const id = randomUUID()
    const timestamp = new Date().toISOString()
    const staged = await Promise.all(
      attachmentIds.map((attachmentId) =>
        this.store.readCaptureDraftAttachment(libraryPath, attachmentId)
      )
    )
    const attachments = staged.map(({ attachment }) => attachment)
    const metadata = createNoteMetadata(id, markdown, timestamp, attachments)
    await this.store.finalizeInboxItem(libraryPath, metadata, [
      { filename: NOTE_FILENAME, data: markdown },
      ...staged.map(({ attachment, bytes }) => ({
        filename: attachment.filename,
        data: bytes
      }))
    ])
    for (const attachmentId of attachmentIds) {
      await this.store.removeCaptureDraftAttachment(libraryPath, attachmentId)
    }
    const persisted = await this.store.readPersistedItem(libraryPath, id)
    if (persisted.type !== 'note') throw new Error('The saved note could not be reopened.')
    const item = await this.refreshChangedItem(libraryPath, id)
    if (item.type !== 'note') throw new Error('The saved note could not be reopened.')
    return item
  }

  async duplicateNote(itemId: string): Promise<LibraryDto> {
    this.validateItemId(itemId, 'item')
    const libraryPath = this.requireCurrentLibrary()
    const source = await this.store.resolveItem(libraryPath, itemId)
    if (source.metadata.type !== 'note') throw new Error('Only notes can be duplicated.')
    if (source.location.type === 'trash')
      throw new Error('Restore this note before duplicating it.')

    const markdown = (await this.store.readItemContent(libraryPath, source.metadata)).toString(
      'utf8'
    )
    const id = randomUUID()
    const timestamp = new Date().toISOString()
    const metadata = {
      ...createNoteMetadata(id, markdown, timestamp),
      title: source.metadata.title,
      titleSource: 'custom' as const
    }
    await this.store.finalizeInboxItem(
      libraryPath,
      metadata,
      [{ filename: NOTE_FILENAME, data: markdown }],
      source.location
    )
    return this.refreshLibraryDto(libraryPath, [id])
  }

  async updateNote(input: UpdateNoteInput): Promise<NoteItemDto> {
    const libraryPath = this.requireCurrentLibrary()
    const { itemId, markdown, expectedMarkdown } = input
    this.validateItemId(itemId, 'item')
    if (typeof markdown !== 'string' || !markdown.trim()) {
      throw new Error('Write something before saving the note.')
    }
    if (typeof expectedMarkdown !== 'string')
      throw new Error('The expected note content is invalid.')

    const metadata = await this.store.readPersistedItem(libraryPath, itemId)
    if (metadata.type !== 'note') throw new Error('The saved item is not a note.')
    let currentMarkdown: string
    try {
      currentMarkdown = (await this.store.readItemContent(libraryPath, metadata)).toString('utf8')
    } catch {
      throw new Error('The note file is missing from the library.')
    }
    if (currentMarkdown !== expectedMarkdown) {
      const conflict = await this.refreshChangedItem(libraryPath, itemId)
      if (conflict.type !== 'note') throw new Error('The saved note could not be reopened.')
      throw new NoteUpdateConflictError(conflict)
    }

    const updated = updateNoteMetadata(metadata, markdown, new Date().toISOString())
    await this.store.updateNote(libraryPath, updated, markdown)
    const item = await this.refreshChangedItem(libraryPath, itemId)
    if (item.type !== 'note') throw new Error('The saved note could not be reopened.')
    return item
  }

  private async refreshChangedItem(libraryPath: string, itemId: string): Promise<LibraryItemDto> {
    const next = this.librarySnapshot
      ? await this.store.updateLibraryDto(libraryPath, this.librarySnapshot, [itemId])
      : null
    if (next) {
      this.librarySnapshot = next
      this.libraryRevision++
    }
    const item = next?.items.find((entry) => entry.id === itemId)
    if (!item) throw new Error('The saved item could not be reopened.')
    return item
  }

  async importNoteImage(input: NoteImageImportInput): Promise<NoteAttachmentDto> {
    const libraryPath = this.requireCurrentLibrary()
    this.validateItemId(input.itemId, 'item')
    const bytes = validateImageInput(input)
    const detected = detectImage(bytes)
    if (!detected) throw new Error('Kusu supports PNG, JPEG, GIF, WebP, and BMP images.')
    if (input.origin !== undefined && input.origin !== 'clipboard' && input.origin !== 'file') {
      throw new Error('The image source is invalid.')
    }
    const note = await this.getItemDetail(input.itemId)
    if (note.type !== 'note') throw new Error('The saved item is not a note.')
    const timestamp = new Date()
    const clipboardName = input.origin === 'clipboard' ? this.clipboardImageStem(timestamp) : null
    const filename = noteAttachmentFilename(
      input.origin === 'clipboard' ? null : input.sourceFilename,
      detected,
      new Set(note.attachments.map((attachment) => attachment.filename.toLocaleLowerCase())),
      clipboardName ?? 'pasted-image'
    )
    return this.store.importNoteImage(libraryPath, input.itemId, {
      id: randomUUID(),
      filename,
      sourceFilename:
        input.origin === 'clipboard' ? filename : safeSourceFilename(input.sourceFilename),
      bytes,
      ...detected,
      timestamp: timestamp.toISOString()
    })
  }

  async listCaptureDraftImages(): Promise<CaptureDraftImageDto[]> {
    const libraryPath = this.requireCurrentLibrary()
    const attachments = await this.store.readCaptureDraftAttachments(libraryPath)
    return Promise.all(
      attachments.map(async (attachment) => ({
        ...attachment,
        missingContent: !(await this.store.pathExists(
          join(libraryPath, '.kuskus', 'temp', 'note-draft', attachment.filename)
        ))
      }))
    )
  }

  async stageCaptureDraftImage(input: ImageImportInput): Promise<CaptureDraftImageDto> {
    const libraryPath = this.requireCurrentLibrary()
    const bytes = validateImageInput(input)
    const detected = detectImage(bytes)
    if (!detected) throw new Error('Kusu supports PNG, JPEG, GIF, WebP, and BMP images.')
    if (input.origin !== undefined && input.origin !== 'clipboard' && input.origin !== 'file') {
      throw new Error('The image source is invalid.')
    }
    const existing = await this.store.readCaptureDraftAttachments(libraryPath)
    const clipboardName = input.origin === 'clipboard' ? this.clipboardImageStem(new Date()) : null
    const filename = noteAttachmentFilename(
      input.origin === 'clipboard' ? null : input.sourceFilename,
      detected,
      new Set(existing.map((attachment) => attachment.filename.toLocaleLowerCase())),
      clipboardName ?? 'pasted-image'
    )
    const attachment = {
      id: randomUUID(),
      filename,
      relativePath: `./${encodeMarkdownImageTarget(filename)}`,
      sourceFilename:
        input.origin === 'clipboard' ? filename : safeSourceFilename(input.sourceFilename),
      mediaType: detected.mediaType,
      width: detected.width,
      height: detected.height
    }
    await this.store.stageCaptureDraftAttachment(libraryPath, attachment, bytes)
    return { ...attachment, missingContent: false }
  }

  async renameCaptureDraftImage(
    input: RenameCaptureDraftImageInput
  ): Promise<CaptureDraftImageDto> {
    if (!input || typeof input !== 'object') throw new Error('The image rename request is invalid.')
    this.validateItemId(input.attachmentId, 'attachment')
    const requested = this.validateItemTitle(input.name)
    const libraryPath = this.requireCurrentLibrary()
    const attachments = await this.store.readCaptureDraftAttachments(libraryPath)
    const current = attachments.find((entry) => entry.id === input.attachmentId)
    if (!current) throw new Error('The staged image no longer exists.')
    const extension = extname(current.filename)
    const filename = noteAttachmentFilename(
      `${requested}${extension}`,
      { mediaType: current.mediaType, width: current.width, height: current.height },
      new Set(
        attachments
          .filter((entry) => entry.id !== current.id)
          .map((entry) => entry.filename.toLocaleLowerCase())
      )
    )
    const renamed = await this.store.renameCaptureDraftAttachment(libraryPath, current.id, filename)
    return { ...renamed, missingContent: false }
  }

  private clipboardImageStem(date: Date): string {
    const part = (value: number): string => value.toString().padStart(2, '0')
    return `image-${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`
  }

  async removeCaptureDraftImage(attachmentId: string): Promise<void> {
    this.validateItemId(attachmentId, 'attachment')
    await this.store.removeCaptureDraftAttachment(this.requireCurrentLibrary(), attachmentId)
  }

  async discardCaptureDraft(): Promise<void> {
    const libraryPath = this.requireCurrentLibrary()
    await Promise.all([
      this.store.discardCaptureDraft(libraryPath),
      this.store.discardCaptureDraftFile(libraryPath)
    ])
  }

  async getCaptureDraftImagePreview(attachmentId: string): Promise<ImagePreviewDto> {
    this.validateItemId(attachmentId, 'attachment')
    const { attachment, bytes } = await this.store.readCaptureDraftAttachment(
      this.requireCurrentLibrary(),
      attachmentId
    )
    return this.toValidatedImagePreview(attachment.mediaType, bytes)
  }

  async commitCaptureDraftImage(attachmentId: string): Promise<ImageItemDto> {
    this.validateItemId(attachmentId, 'attachment')
    const libraryPath = this.requireCurrentLibrary()
    await this.store.readPersistedLibrary(libraryPath)
    const attachments = await this.store.readCaptureDraftAttachments(libraryPath)
    if (attachments.length !== 1 || attachments[0].id !== attachmentId) {
      throw new Error('The standalone image draft is no longer valid.')
    }
    const { attachment, bytes } = await this.store.readCaptureDraftAttachment(
      libraryPath,
      attachmentId
    )
    const detected = detectImage(bytes)
    if (!detected) throw new Error('The staged image content is invalid.')

    const timestamp = new Date().toISOString()
    const metadata = createImageMetadata(
      randomUUID(),
      attachment.sourceFilename,
      detected,
      timestamp
    )
    await this.store.finalizeInboxItem(libraryPath, metadata, [
      { filename: metadata.contentFilename, data: bytes }
    ])
    await this.store.discardCaptureDraft(libraryPath)
    const persisted = await this.store.readPersistedItem(libraryPath, metadata.id)
    if (persisted.type !== 'image') throw new Error('The saved image could not be reopened.')
    return toImageDto(persisted)
  }

  async getCaptureDraftFile(): Promise<CaptureDraftFileDto | null> {
    const libraryPath = this.requireCurrentLibrary()
    const file = await this.store.readCaptureDraftFile(libraryPath)
    if (!file) return null
    return {
      ...file,
      missingContent: !(await this.store.pathExists(
        join(libraryPath, '.kuskus', 'temp', 'file-draft', file.filename)
      ))
    }
  }

  async stageCaptureDraftFile(input: FileImportInput): Promise<CaptureDraftFileDto> {
    const { bytes, filename, mediaType } = this.validateFileImport(input)
    const file = { id: randomUUID(), filename, mediaType, size: bytes.byteLength }
    await this.store.stageCaptureDraftFile(this.requireCurrentLibrary(), file, bytes)
    return { ...file, missingContent: false }
  }

  async removeCaptureDraftFile(): Promise<void> {
    await this.store.discardCaptureDraftFile(this.requireCurrentLibrary())
  }

  async commitCaptureDraftFile(fileId: string): Promise<FileItemDto> {
    this.validateItemId(fileId, 'item')
    const libraryPath = this.requireCurrentLibrary()
    const { file, bytes } = await this.store.readCaptureDraftFileBytes(libraryPath, fileId)
    const item = await this.store.importVaultFile(libraryPath, {
      id: randomUUID(),
      filename: file.filename,
      mediaType: file.mediaType,
      bytes,
      timestamp: new Date().toISOString()
    })
    await this.store.discardCaptureDraftFile(libraryPath)
    return item
  }

  async getNoteAttachmentPreview(itemId: string, attachmentId: string): Promise<ImagePreviewDto> {
    this.validateItemId(itemId, 'item')
    this.validateItemId(attachmentId, 'attachment')
    const { attachment, bytes } = await this.store.readNoteAttachment(
      this.requireCurrentLibrary(),
      itemId,
      attachmentId
    )
    return this.toValidatedImagePreview(attachment.mediaType, bytes)
  }

  async importImage(input: ImageImportInput): Promise<ImageItemDto> {
    const libraryPath = this.requireCurrentLibrary()
    const bytes = validateImageInput(input)
    await this.store.readPersistedLibrary(libraryPath)

    const detected = detectImage(bytes)
    if (!detected) throw new Error('Kusu supports PNG, JPEG, GIF, WebP, and BMP images.')

    const metadata = createImageMetadata(
      randomUUID(),
      input.sourceFilename,
      detected,
      new Date().toISOString()
    )
    await this.store.finalizeInboxItem(libraryPath, metadata, [
      { filename: metadata.contentFilename, data: bytes }
    ])
    const persisted = await this.store.readPersistedItem(libraryPath, metadata.id)
    if (persisted.type !== 'image') throw new Error('The saved image could not be reopened.')
    return toImageDto(persisted)
  }

  async importFile(input: FileImportInput): Promise<FileItemDto> {
    const { bytes, filename, mediaType } = this.validateFileImport(input)
    const libraryPath = this.requireCurrentLibrary()
    await this.currentLibraryDto(libraryPath)
    const imported = await this.store.importVaultFile(libraryPath, {
      id: randomUUID(),
      filename,
      mediaType,
      bytes,
      timestamp: new Date().toISOString()
    })
    const saved = await this.refreshChangedItem(libraryPath, imported.id)
    if (saved.type !== 'file') throw new Error('The imported file could not be reopened.')
    return saved
  }

  private validateFileImport(input: FileImportInput): {
    bytes: Uint8Array
    filename: string
    mediaType: string
  } {
    if (
      !input ||
      typeof input !== 'object' ||
      !(input.bytes instanceof ArrayBuffer) ||
      typeof input.sourceFilename !== 'string' ||
      typeof input.mediaType !== 'string'
    ) {
      throw new Error('The file import is invalid.')
    }
    const bytes = new Uint8Array(input.bytes)
    if (bytes.byteLength === 0) throw new Error('The selected file is empty.')
    if (bytes.byteLength > 100 * 1024 * 1024) {
      throw new Error('Files larger than 100 MB cannot be imported yet.')
    }
    const filename = safeSourceFilename(input.sourceFilename)
    if (!filename) throw new Error('The selected file needs a valid filename.')
    return { bytes, filename, mediaType: input.mediaType }
  }

  async createUrl(sourceUrl: string): Promise<UrlItemDto> {
    const libraryPath = this.requireCurrentLibrary()
    validateWebUrl(sourceUrl)
    await this.store.readPersistedLibrary(libraryPath)
    const timestamp = new Date().toISOString()
    const metadata = createUrlMetadata(randomUUID(), sourceUrl, timestamp)
    await this.store.finalizeInboxItem(libraryPath, metadata, [])
    const persisted = await this.store.readPersistedItem(libraryPath, metadata.id)
    if (persisted.type !== 'url') throw new Error('The saved link could not be reopened.')
    return toUrlDto(persisted)
  }

  async enrichUrl(itemId: string): Promise<UrlItemDto> {
    this.validateItemId(itemId, 'item')
    const libraryPath = this.requireCurrentLibrary()
    const key = `${libraryPath}:${itemId}`
    const existing = this.enrichmentRequests.get(key)
    if (existing) return existing
    const request = this.performUrlEnrichment(itemId)
      .then((item) => {
        if (this.currentLibraryPath === libraryPath && this.librarySnapshot) {
          this.librarySnapshot = {
            ...this.librarySnapshot,
            items: this.librarySnapshot.items.map((current) =>
              current.id === item.id ? item : current
            )
          }
          this.libraryRevision++
        }
        return item
      })
      .finally(() => this.enrichmentRequests.delete(key))
    this.enrichmentRequests.set(key, request)
    return request
  }

  private async performUrlEnrichment(itemId: string): Promise<UrlItemDto> {
    const libraryPath = this.requireCurrentLibrary()
    await this.currentLibraryDto(libraryPath)
    const item = await this.store.readPersistedItem(libraryPath, itemId)
    if (item.type !== 'url') throw new Error('The saved link metadata is invalid.')
    if (item.metadataStatus === 'ready' && (item.metadataVersion ?? 1) >= 2)
      return toUrlDto(item, (await this.store.resolveItem(libraryPath, itemId)).location)
    try {
      const pageUrl = validateWebUrl(item.sourceUrl)
      const response = await fetchPublicResource(
        pageUrl,
        'text/html,application/xhtml+xml',
        this.urlNetwork
      )
      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        throw new Error('The link did not return a webpage.')
      }
      const html = await readHtmlHead(response)
      const finalUrl = response.url ? new URL(response.url) : pageUrl
      const extracted = extractUrlMetadata(html, finalUrl)
      const current = await this.store.readPersistedItem(libraryPath, itemId)
      if (current.type !== 'url' || current.sourceUrl !== item.sourceUrl)
        throw new Error('The link changed during metadata loading.')
      const updated: PersistedUrlItem = {
        ...current,
        ...extracted,
        title: current.titleSource === 'custom' ? current.title : extracted.title,
        metadataStatus: 'ready',
        metadataError: null,
        updatedAt: new Date().toISOString()
      }
      await this.store.updateItem(libraryPath, updated)
      return toUrlDto(updated, (await this.store.resolveItem(libraryPath, itemId)).location)
    } catch (error) {
      const current = await this.store.readPersistedItem(libraryPath, itemId)
      if (current.type !== 'url' || current.sourceUrl !== item.sourceUrl)
        throw new Error('The link changed during metadata loading.')
      const updated: PersistedUrlItem = {
        ...current,
        metadataVersion: 2,
        metadataStatus: 'unavailable',
        metadataError: this.toMessage(error, 'Metadata is unavailable.'),
        updatedAt: new Date().toISOString()
      }
      await this.store.updateItem(libraryPath, updated)
      return toUrlDto(updated, (await this.store.resolveItem(libraryPath, itemId)).location)
    }
  }

  async getUrlPreview(itemId: string, kind: UrlPreviewKind): Promise<UrlPreviewDto> {
    this.validateItemId(itemId, 'item')
    if (!['preview', 'favicon'].includes(kind)) throw new Error('The preview kind is invalid.')
    const requestKey = `${itemId}:${kind}`
    const existing = this.previewRequests.get(requestKey)
    if (existing) return existing
    const request = this.loadUrlPreview(itemId, kind).finally(() => {
      this.previewRequests.delete(requestKey)
    })
    this.previewRequests.set(requestKey, request)
    return request
  }

  private async loadUrlPreview(itemId: string, kind: UrlPreviewKind): Promise<UrlPreviewDto> {
    const libraryPath = this.requireCurrentLibrary()
    const item = await this.store.readPersistedItem(libraryPath, itemId)
    if (item.type !== 'url') throw new Error('The saved item is not a link.')
    const cached = await this.store.readUrlPreviewCache(libraryPath, itemId, kind)
    if (cached) {
      try {
        validateUrlPreview(cached.bytes, cached.mediaType, kind)
        return toUrlPreviewDto(cached.bytes, cached.mediaType)
      } catch {
        await this.store.removeUrlPreviewCache(libraryPath, itemId, kind)
      }
    }
    const assetUrl = kind === 'preview' ? item.previewImageUrl : item.faviconUrl
    if (!assetUrl) throw new Error('No link preview is available.')
    const response = await fetchPublicResource(
      validateWebUrl(assetUrl),
      'image/webp,image/png,image/jpeg,image/gif,image/bmp,image/x-icon,image/vnd.microsoft.icon',
      this.urlNetwork
    )
    const bytes = await readBoundedBytes(response, URL_PREVIEW_LIMITS[kind].bytes)
    const validated = validateUrlPreview(bytes, response.headers.get('content-type') ?? '', kind)
    await this.store.writeUrlPreviewCache(libraryPath, itemId, kind, validated.extension, bytes)
    return toUrlPreviewDto(bytes, validated.mediaType)
  }

  async createCollection(input: CreateCollectionInput): Promise<CollectionDto> {
    const libraryPath = this.requireCurrentLibrary()
    const name = this.validateCollectionName(input.name)
    const icon = input.icon === undefined ? undefined : this.validateCollectionIcon(input.icon)
    const parentId = input.parentId ?? null
    if (parentId !== null) {
      this.validateCollectionId(parentId)
      const parentExists = (await this.store.readPersistedCollections(libraryPath)).some(
        (entry) => entry.id === parentId
      )
      if (!parentExists) throw new Error('The parent folder no longer exists.')
    }
    const collection: PersistedCollection = {
      schemaVersion: 2,
      id: randomUUID(),
      name,
      ...(icon ? { icon } : {}),
      createdAt: new Date().toISOString(),
      parentId
    }
    await this.store.createCollection(libraryPath, collection)
    const created = (await this.store.readPersistedCollections(libraryPath)).find(
      (entry) => entry.id === collection.id
    )
    if (!created) throw new Error('The new folder could not be reopened.')
    return toCollectionDto(created)
  }

  async renameCollection(collectionId: string, requestedName: string): Promise<CollectionDto> {
    const libraryPath = this.requireCurrentLibrary()
    const collection = (await this.store.readPersistedCollections(libraryPath)).find(
      (entry) => entry.id === collectionId
    )
    if (!collection) throw new Error('This folder no longer exists.')
    const renamed = { ...collection, name: this.validateCollectionName(requestedName) }
    await this.store.updateCollection(libraryPath, renamed)
    return toCollectionDto(renamed)
  }

  async moveCollection(input: MoveCollectionInput): Promise<LibraryDto> {
    if (!input || typeof input !== 'object') throw new Error('The folder move request is invalid.')
    this.validateCollectionId(input.collectionId)
    if (input.parentId !== null) this.validateCollectionId(input.parentId)
    const libraryPath = this.requireCurrentLibrary()
    const collections = await this.store.readPersistedCollections(libraryPath)
    const current = collections.find((entry) => entry.id === input.collectionId)
    if (!current) throw new Error('This folder no longer exists.')
    if (current.parentId === input.parentId) return this.currentLibraryDto(libraryPath)
    if (input.parentId !== null) {
      const parent = collections.find((entry) => entry.id === input.parentId)
      if (!parent) throw new Error('The destination folder no longer exists.')
      const descendants = new Set<string>()
      const queue = [current.id]
      for (let index = 0; index < queue.length; index += 1) {
        for (const candidate of collections) {
          if (candidate.parentId !== queue[index] || descendants.has(candidate.id)) continue
          descendants.add(candidate.id)
          queue.push(candidate.id)
        }
      }
      if (input.parentId === current.id || descendants.has(input.parentId)) {
        throw new Error('A folder cannot be moved inside itself or one of its subfolders.')
      }
    }
    await this.store.moveCollection(libraryPath, current.id, input.parentId)
    return this.refreshLibraryDto(
      libraryPath,
      (this.librarySnapshot?.items ?? []).map((item) => item.id)
    )
  }

  async setCollectionIcon(
    collectionId: string,
    requestedIcon: CollectionIconKey
  ): Promise<CollectionDto> {
    this.validateCollectionId(collectionId)
    const libraryPath = this.requireCurrentLibrary()
    const collection = (await this.store.readPersistedCollections(libraryPath)).find(
      (entry) => entry.id === collectionId
    )
    if (!collection) throw new Error('This folder no longer exists.')
    const updated = { ...collection, icon: this.validateCollectionIcon(requestedIcon) }
    await this.store.updateCollection(libraryPath, updated)
    return toCollectionDto(updated)
  }

  async deleteCollection(collectionId: string): Promise<LibraryDto> {
    this.validateCollectionId(collectionId)
    const libraryPath = this.requireCurrentLibrary()
    const library = await this.currentLibraryDto(libraryPath)
    const collectionIds = new Set([collectionId])
    for (const id of collectionIds) {
      for (const collection of library.collections) {
        if (collection.parentId === id) collectionIds.add(collection.id)
      }
    }
    const items = library.items.filter(
      (item) => item.location.type === 'collection' && collectionIds.has(item.location.collectionId)
    )
    const resolved = await Promise.all(
      items.map((item) => this.store.resolveItem(libraryPath, item.id))
    )
    for (const id of collectionIds) {
      const retainedEntries = library.collections
        .filter((collection) => collection.parentId === id)
        .map((collection) => basename(collection.relativePath))
      for (const item of resolved) {
        if (item.location.type !== 'collection' || item.location.collectionId !== id) continue
        retainedEntries.push(basename(item.path))
        if (item.metadata.type === 'note') {
          retainedEntries.push(`${basename(item.path, extname(item.path))}.assets`)
        }
      }
      await this.store.assertCollectionRemovable(libraryPath, id, retainedEntries)
    }
    if (resolved.length > 0) {
      await this.store.moveItems(
        libraryPath,
        resolved.map((item) => ({
          item,
          destination: { type: 'inbox' },
          metadata: this.clearLifecycleMetadata(item.metadata)
        }))
      )
    }
    await this.store.deleteCollection(libraryPath, collectionId)
    return this.refreshLibraryDto(
      libraryPath,
      this.affectedItemIds(
        library,
        items.map((item) => item.id)
      )
    )
  }

  async renameItem(input: RenameItemInput): Promise<LibraryDto> {
    if (!input || typeof input !== 'object') throw new Error('The item rename request is invalid.')
    this.validateItemId(input.itemId, 'item')
    const libraryPath = this.requireCurrentLibrary()
    const item = await this.store.resolveItem(libraryPath, input.itemId)
    if (item.location.type === 'trash') throw new Error('Restore this item before renaming it.')
    let title: string
    let titleSource: 'derived' | 'custom'
    if ('titleSource' in input) {
      if (input.titleSource !== 'derived' || item.metadata.type !== 'note') {
        throw new Error('Only notes can derive their title from their contents.')
      }
      title = deriveNoteTitle(
        (await this.store.readItemContent(libraryPath, item.metadata)).toString('utf8')
      )
      titleSource = 'derived'
    } else {
      title = this.validateItemTitle(input.title)
      titleSource = 'custom'
    }
    await this.store.updateItem(libraryPath, {
      ...item.metadata,
      title,
      titleSource,
      updatedAt: new Date().toISOString()
    })
    return this.refreshLibraryDto(
      libraryPath,
      this.affectedItemIds(await this.currentLibraryDto(libraryPath), [item.metadata.id])
    )
  }

  async moveItems(input: MoveItemsInput): Promise<LibraryDto> {
    const requestedItemIds = this.validateItemMutationInput(input)
    const destination = this.validateDestination(input.destination)
    const libraryPath = this.requireCurrentLibrary()
    if (
      destination.type === 'collection' &&
      !(await this.store.collectionExists(libraryPath, destination.collectionId))
    ) {
      throw new Error('The destination folder no longer exists.')
    }
    const library = await this.currentLibraryDto(libraryPath)
    const itemIds = this.withExclusiveSiblingAttachments(library, requestedItemIds)
    const items = await Promise.all(
      itemIds.map((itemId) => this.store.resolveItem(libraryPath, itemId))
    )
    if (items.some((item) => item.location.type === 'trash')) {
      throw new Error('Restore items from Trash before moving them.')
    }
    const requests = items
      .filter((item) => !this.sameActiveLocation(item.location, destination))
      .map((item) => ({
        item,
        destination,
        metadata: this.clearLifecycleMetadata(item.metadata)
      }))
    await this.store.moveItems(libraryPath, requests)
    return this.refreshLibraryDto(libraryPath, this.affectedItemIds(library, itemIds))
  }

  async archiveItems(input: ItemMutationInput): Promise<LibraryDto> {
    const requestedItemIds = this.validateItemMutationInput(input)
    const libraryPath = this.requireCurrentLibrary()
    const library = await this.currentLibraryDto(libraryPath)
    const itemIds = this.withExclusiveSiblingAttachments(library, requestedItemIds)
    const items = await Promise.all(
      itemIds.map((itemId) => this.store.resolveItem(libraryPath, itemId))
    )
    if (items.some((item) => item.location.type === 'archive' || item.location.type === 'trash')) {
      throw new Error('Only active items can be archived.')
    }
    await this.store.moveItems(
      libraryPath,
      items.map((item) => ({
        item,
        destination: {
          type: 'archive',
          originalCollectionId:
            item.location.type === 'collection' ? item.location.collectionId : null
        },
        metadata: {
          ...this.clearLifecycleMetadata(item.metadata),
          originalCollectionId:
            item.location.type === 'collection' ? item.location.collectionId : null
        }
      }))
    )
    return this.refreshLibraryDto(libraryPath, this.affectedItemIds(library, itemIds))
  }

  async unarchiveItems(input: ItemMutationInput): Promise<LibraryDto> {
    const requestedItemIds = this.validateItemMutationInput(input)
    const libraryPath = this.requireCurrentLibrary()
    const library = await this.currentLibraryDto(libraryPath)
    const itemIds = this.withExclusiveSiblingAttachments(library, requestedItemIds)
    const items = await Promise.all(
      itemIds.map((itemId) => this.store.resolveItem(libraryPath, itemId))
    )
    if (items.some((item) => item.location.type !== 'archive')) {
      throw new Error('Only archived items can be unarchived.')
    }
    const requests = await Promise.all(
      items.map(async (item) => {
        const collectionId = item.metadata.originalCollectionId
        const destination: ActiveItemLocation =
          collectionId && (await this.store.collectionExists(libraryPath, collectionId))
            ? { type: 'collection', collectionId }
            : { type: 'inbox' }
        return { item, destination, metadata: this.clearLifecycleMetadata(item.metadata) }
      })
    )
    await this.store.moveItems(libraryPath, requests)
    return this.refreshLibraryDto(libraryPath, this.affectedItemIds(library, itemIds))
  }

  async setItemsPinned(input: SetItemsPinnedInput): Promise<LibraryDto> {
    if (!input || typeof input !== 'object') throw new Error('The pin request is invalid.')
    const itemIds = this.validateItemMutationInput(input)
    if (typeof input.pinned !== 'boolean') throw new Error('The pin request is invalid.')
    const libraryPath = this.requireCurrentLibrary()
    const library = await this.currentLibraryDto(libraryPath)
    const requested = new Set(itemIds)
    const existing = new Set(library.pinnedItemIds)
    const nextPinned = input.pinned
      ? [
          ...existing,
          ...library.items
            .filter((item) => requested.has(item.id))
            .map((item) => item.id)
            .filter((itemId) => !existing.has(itemId))
        ]
      : library.pinnedItemIds.filter((itemId) => !requested.has(itemId))
    await this.store.setItemsPinned(libraryPath, nextPinned)
    const nextLibrary = await this.store.updateLibraryDto(
      libraryPath,
      { ...library, pinnedItemIds: nextPinned },
      []
    )
    if (this.currentLibraryPath === libraryPath) {
      this.librarySnapshot = nextLibrary
      this.vaultDirty = false
      this.libraryRevision += 1
    }
    return nextLibrary
  }

  private withExclusiveSiblingAttachments(
    library: LibraryDto,
    requestedItemIds: readonly string[]
  ): string[] {
    const requested = new Set(requestedItemIds)
    const movingNotes = library.items.filter(
      (item): item is NoteItemDto => requested.has(item.id) && item.type === 'note'
    )
    if (movingNotes.length === 0) return [...requestedItemIds]
    const movingNoteIds = new Set(movingNotes.map((note) => note.id))
    const references = new Map<string, Set<string>>()
    for (const item of library.items) {
      if (item.type !== 'note') continue
      for (const attachment of item.attachments) {
        const noteIds = references.get(attachment.id) ?? new Set<string>()
        noteIds.add(item.id)
        references.set(attachment.id, noteIds)
      }
    }
    const imageById = new Map(
      library.items
        .filter((item): item is ImageItemDto => item.type === 'image')
        .map((image) => [image.id, image])
    )
    const added = new Set<string>()
    for (const note of movingNotes) {
      for (const attachment of note.attachments) {
        if (requested.has(attachment.id) || added.has(attachment.id)) continue
        const image = imageById.get(attachment.id)
        if (
          !image ||
          image.location.type === 'trash' ||
          image.attachmentOrigin !== 'note-capture'
        ) {
          continue
        }
        if (
          dirname(image.relativePath).toLocaleLowerCase() !==
          dirname(note.relativePath).toLocaleLowerCase()
        ) {
          continue
        }
        const inbound = references.get(image.id) ?? new Set<string>()
        if ([...inbound].some((noteId) => !movingNoteIds.has(noteId))) continue
        added.add(image.id)
      }
    }
    return [...requestedItemIds, ...added]
  }

  async inspectItemDeletion(input: InspectItemDeletionInput): Promise<ItemDeletionInspectionDto> {
    const itemIds = this.validateItemMutationInput(input)
    if (input.mode !== 'trash' && input.mode !== 'permanent') {
      throw new Error('The deletion inspection mode is invalid.')
    }
    return this.store.inspectItemDeletion(this.requireCurrentLibrary(), itemIds, input.mode)
  }

  async trashItems(input: TrashItemsInput): Promise<LibraryDto> {
    const itemIds = this.validateItemMutationInput(input)
    this.validateDeletionReview(input.referenceRevision, input.confirmedReferencedItemIds)
    const libraryPath = this.requireCurrentLibrary()
    const inspection = await this.store.inspectItemDeletion(libraryPath, itemIds, 'trash')
    if (input.referenceRevision && input.referenceRevision !== inspection.revision) {
      throw new Error('References changed while this action was open. Review the deletion again.')
    }
    if (inspection.referencedItems.length > 0) {
      const confirmed = new Set(input.confirmedReferencedItemIds ?? [])
      if (
        !input.referenceRevision ||
        inspection.referencedItems.some((item) => !confirmed.has(item.itemId))
      ) {
        throw new Error('Review the notes that reference this image before moving it to Trash.')
      }
    }
    const items = await Promise.all(
      itemIds.map((itemId) => this.store.resolveItem(libraryPath, itemId))
    )
    if (items.some((item) => item.location.type === 'trash')) {
      throw new Error('These items are already in Trash.')
    }
    await this.store.moveItems(
      libraryPath,
      items.map((item) => {
        const from =
          item.location.type === 'archive'
            ? 'archive'
            : item.location.type === 'collection'
              ? 'collection'
              : 'inbox'
        const originalCollectionId =
          item.location.type === 'archive'
            ? item.metadata.originalCollectionId
            : item.location.type === 'collection'
              ? item.location.collectionId
              : null
        const metadata: PersistedItem = {
          ...item.metadata,
          originalCollectionId,
          trashedFrom: from,
          trashedFromRelativePath: item.relativePath
        }
        return {
          item,
          destination: { type: 'trash', trashedFrom: from, originalCollectionId },
          metadata
        }
      })
    )
    return this.refreshLibraryDto(
      libraryPath,
      this.affectedItemIds(await this.currentLibraryDto(libraryPath), itemIds)
    )
  }

  async restoreItems(input: ItemMutationInput): Promise<LibraryDto> {
    const itemIds = this.validateItemMutationInput(input)
    const libraryPath = this.requireCurrentLibrary()
    const items = await Promise.all(
      itemIds.map((itemId) => this.store.resolveItem(libraryPath, itemId))
    )
    if (items.some((item) => item.location.type !== 'trash')) {
      throw new Error('Only trashed items can be restored.')
    }
    const requests = await Promise.all(
      items.map(async (item) => {
        const trashedFrom = item.metadata.trashedFrom ?? 'inbox'
        if (trashedFrom === 'archive') {
          return {
            item,
            destination: {
              type: 'archive' as const,
              originalCollectionId: item.metadata.originalCollectionId
            },
            metadata: this.withoutTrashedFrom(item.metadata)
          }
        }
        const collectionId = item.metadata.originalCollectionId
        const destination: ActiveItemLocation =
          trashedFrom === 'collection' &&
          collectionId &&
          (await this.store.collectionExists(libraryPath, collectionId))
            ? { type: 'collection', collectionId }
            : { type: 'inbox' }
        return { item, destination, metadata: this.clearLifecycleMetadata(item.metadata) }
      })
    )
    await this.store.moveItems(libraryPath, requests)
    return this.refreshLibraryDto(
      libraryPath,
      this.affectedItemIds(await this.currentLibraryDto(libraryPath), itemIds)
    )
  }

  async permanentlyDeleteItems(input: PermanentlyDeleteItemsInput): Promise<LibraryDto> {
    const itemIds = this.validateItemMutationInput(input)
    this.validateDeletionReview(input.referenceRevision, input.confirmedReferencedItemIds)
    this.validateDeletionReview(input.referenceRevision, input.cleanupImageIds)
    const libraryPath = this.requireCurrentLibrary()
    const inspection = await this.store.inspectItemDeletion(libraryPath, itemIds, 'permanent')
    if (input.referenceRevision && input.referenceRevision !== inspection.revision) {
      throw new Error('References changed while this action was open. Review the deletion again.')
    }
    if (inspection.referencedItems.length > 0) {
      const confirmed = new Set(input.confirmedReferencedItemIds ?? [])
      if (
        !input.referenceRevision ||
        inspection.referencedItems.some((item) => !confirmed.has(item.itemId))
      ) {
        throw new Error('Review the notes that reference this image before deleting it forever.')
      }
    }
    const eligibleCleanup = new Set(inspection.cleanupCandidates.map((item) => item.itemId))
    const cleanupImageIds = input.cleanupImageIds ?? []
    if (cleanupImageIds.some((id) => !eligibleCleanup.has(id))) {
      throw new Error('An attachment selected for cleanup is still referenced or unavailable.')
    }
    await this.store.permanentlyDeleteItems(libraryPath, itemIds)
    await Promise.all(
      itemIds.map((itemId) =>
        this.store.removeUrlPreviewCache(libraryPath, itemId).catch(() => undefined)
      )
    )
    if (cleanupImageIds.length > 0) await this.trashItems({ itemIds: cleanupImageIds })
    return this.refreshLibraryDto(libraryPath, [], itemIds)
  }

  async getItemContentPath(itemId: string): Promise<string> {
    return this.store.getItemContentPath(this.requireCurrentLibrary(), itemId)
  }

  async getItemRevealPath(itemId: string): Promise<string> {
    return this.store.getItemRevealPath(this.requireCurrentLibrary(), itemId)
  }

  async getImageThumbnail(itemId: string): Promise<ImagePreviewDto> {
    const libraryPath = this.requireCurrentLibrary()
    const metadata = await this.store.readPersistedItem(libraryPath, itemId)
    if (metadata.type !== 'image') throw new Error('The saved image metadata is invalid.')
    const sourceKey = `${metadata.relativePath}:${metadata.updatedAt}:${metadata.width}x${metadata.height}`
    const requestKey = `${libraryPath}:${itemId}:${sourceKey}`
    const active = this.thumbnailRequests.get(requestKey)
    if (active) return active

    const request = (async () => {
      const cached = await this.store.readImageThumbnailCache(libraryPath, itemId, sourceKey)
      if (cached) {
        try {
          const preview = this.toValidatedImagePreview('image/png', cached)
          if (preview.width <= CARD_THUMBNAIL_EDGE && preview.height <= CARD_THUMBNAIL_EDGE) {
            return preview
          }
        } catch {
          // Rebuild invalid rebuildable cache bytes from the authoritative image.
        }
      }

      const bytes = await this.store.readItemContent(libraryPath, metadata)
      const detected = detectImage(bytes)
      if (!detected || detected.mediaType !== metadata.mediaType) {
        throw new Error('The saved image content is invalid.')
      }
      const thumbnail = await createImageThumbnail(bytes, detected.width, detected.height)
      await this.store.writeImageThumbnailCache(
        libraryPath,
        itemId,
        sourceKey,
        new Uint8Array(thumbnail.bytes)
      )
      return thumbnail
    })().finally(() => this.thumbnailRequests.delete(requestKey))
    this.thumbnailRequests.set(requestKey, request)
    return request
  }

  async getPdfPreview(itemId: string): Promise<ArrayBuffer> {
    const libraryPath = this.requireCurrentLibrary()
    const metadata = await this.store.readPersistedItem(libraryPath, itemId)
    if (metadata.type !== 'file' || !isPdfFile(metadata)) {
      throw new Error('The saved item is not a PDF.')
    }
    const bytes = await this.store.readItemContent(libraryPath, metadata)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }

  async getImagePreview(itemId: string): Promise<ImagePreviewDto> {
    const libraryPath = this.requireCurrentLibrary()
    const metadata = await this.store.readPersistedItem(libraryPath, itemId)
    if (metadata.type !== 'image') throw new Error('The saved image metadata is invalid.')
    return this.toValidatedImagePreview(
      metadata.mediaType,
      await this.store.readItemContent(libraryPath, metadata)
    )
  }

  private toValidatedImagePreview(
    mediaType: ImagePreviewDto['mediaType'],
    bytes: Uint8Array
  ): ImagePreviewDto {
    const detected = detectImage(bytes)
    if (!detected || detected.mediaType !== mediaType) {
      throw new Error('The saved image content is invalid.')
    }
    return {
      bytes: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer,
      mediaType,
      width: detected.width,
      height: detected.height
    }
  }

  private async setCurrentLibrary(libraryPath: string): Promise<void> {
    this.currentLibraryPath = libraryPath
    this.pendingLibraryPath = null
    this.unavailableLibrary = null
    this.librarySnapshot = null
    this.search.clear()
    this.startupReconciliationPending = false
    this.vaultDirty = true
    if (this.ignoredAppMoveTimer) clearTimeout(this.ignoredAppMoveTimer)
    this.ignoredAppMoveTimer = null
    this.ignoredAppMovePaths.clear()
    await writeJsonAtomic(this.settingsPath, {
      schemaVersion: 1,
      lastLibraryPath: libraryPath
    } satisfies PersistedSettings)
    if (this.vaultChangeListeners.size > 0) this.startVaultWatcher(libraryPath)
  }

  onVaultChanged(listener: () => void): () => void {
    this.vaultChangeListeners.add(listener)
    if (this.currentLibraryPath && !this.vaultWatcher) {
      this.startVaultWatcher(this.currentLibraryPath)
    }
    return () => {
      this.vaultChangeListeners.delete(listener)
      if (this.vaultChangeListeners.size === 0) {
        this.vaultWatcher?.close()
        this.vaultWatcher = null
      }
    }
  }

  private startVaultWatcher(libraryPath: string): void {
    this.vaultWatcher?.close()
    this.vaultWatcher = null
    try {
      // libuv can abort on Windows short paths; watch the canonical native path.
      this.vaultWatcher = watch(
        realpathSync.native(libraryPath),
        { recursive: true },
        (_event, filename) => {
          const relativePath = typeof filename === 'string' ? filename.replace(/\\/g, '/') : ''
          if (
            !relativePath ||
            relativePath === '.kuskus' ||
            relativePath === '.obsidian' ||
            relativePath.startsWith('.kuskus/') ||
            relativePath.startsWith('.obsidian/')
          ) {
            return
          }
          if (this.ignoredAppMovePaths.has(relativePath.toLocaleLowerCase())) return
          if (this.isAppOwnedWrite(relativePath)) return
          if (process.env.KUSU_PERFORMANCE_OUTPUT) performance.mark('kusu:watcher:' + relativePath)
          this.vaultDirty = true
          this.vaultChangedPaths.add(relativePath)
          if (this.vaultChangeTimer) clearTimeout(this.vaultChangeTimer)
          this.vaultChangeTimer = setTimeout(() => {
            this.vaultChangeTimer = null
            const changedPaths = [...this.vaultChangedPaths]
            this.vaultChangedPaths.clear()
            void this.reconcileCurrentLibrary(true, changedPaths).catch(() => {
              // The renderer retains the last valid snapshot and focus reconciliation can retry.
            })
          }, 300)
        }
      )
      this.vaultWatcher.unref()
    } catch {
      // Startup/focus rescans remain available when recursive watching is unsupported.
    }
  }

  private async currentLibraryDto(libraryPath: string): Promise<LibraryDto> {
    if (this.reconciliation) return this.reconciliation
    if (!this.librarySnapshot || this.vaultDirty) return this.buildLibraryDto(libraryPath)
    return this.librarySnapshot
  }

  private affectedItemIds(library: LibraryDto, itemIds: readonly string[]): string[] {
    const affected = new Set(itemIds)
    const referenced = new Set(
      library.items.flatMap((item) =>
        affected.has(item.id) && (item.type === 'image' || item.type === 'file') ? [item.id] : []
      )
    )
    if (referenced.size > 0) {
      for (const item of library.items) {
        if (
          item.type === 'note' &&
          item.attachments.some((attachment) => referenced.has(attachment.id))
        ) {
          affected.add(item.id)
        }
      }
    }
    return [...affected]
  }

  private async refreshLibraryDto(
    libraryPath: string,
    changedItemIds: readonly string[],
    removedItemIds: readonly string[] = []
  ): Promise<LibraryDto> {
    const current = this.librarySnapshot ?? (await this.currentLibraryDto(libraryPath))
    const library = await this.store.updateLibraryDto(
      libraryPath,
      current,
      changedItemIds,
      removedItemIds
    )
    const nextById = new Map(library.items.map((item) => [item.id, item]))
    for (const item of current.items) {
      if (
        (changedItemIds.includes(item.id) || removedItemIds.includes(item.id)) &&
        nextById.get(item.id)?.relativePath !== item.relativePath
      ) {
        this.ignoredAppMovePaths.add(item.relativePath.toLocaleLowerCase())
      }
    }
    if (this.ignoredAppMovePaths.size > 0) {
      for (const path of this.vaultChangedPaths) {
        if (this.ignoredAppMovePaths.has(path.toLocaleLowerCase())) {
          this.vaultChangedPaths.delete(path)
        }
      }
      if (this.ignoredAppMoveTimer) clearTimeout(this.ignoredAppMoveTimer)
      this.ignoredAppMoveTimer = setTimeout(() => {
        this.ignoredAppMoveTimer = null
        this.ignoredAppMovePaths.clear()
      }, 1_000)
      this.ignoredAppMoveTimer.unref()
    }
    if (this.currentLibraryPath === libraryPath) {
      this.librarySnapshot = library
      this.vaultDirty = false
      this.libraryRevision += 1
    }
    return library
  }

  private async buildLibraryDto(libraryPath: string): Promise<LibraryDto> {
    const library = await this.store.buildLibraryDto(libraryPath)
    if (this.currentLibraryPath === libraryPath) {
      this.librarySnapshot = library
      this.vaultDirty = false
      this.libraryRevision += 1
    }
    return library
  }

  private async reconcileCurrentLibrary(
    notify: boolean,
    changedPaths: readonly string[] = []
  ): Promise<LibraryDto> {
    const libraryPath = this.requireCurrentLibrary()
    const previous = this.librarySnapshot
    const active = this.reconciliation
    if (active) {
      const library = await active
      if (notify && !isDeepStrictEqual(previous, library))
        for (const listener of this.vaultChangeListeners) listener()
      return library
    }
    const reconciliation = (async () => {
      const incremental = this.librarySnapshot
        ? await this.store.reconcileKnownFiles(libraryPath, this.librarySnapshot, changedPaths)
        : null
      if (!incremental) return this.buildLibraryDto(libraryPath)
      this.librarySnapshot = incremental
      this.vaultDirty = false
      this.libraryRevision += 1
      return incremental
    })()
    this.reconciliation = reconciliation
    try {
      const library = await reconciliation
      if (notify && !isDeepStrictEqual(previous, library))
        for (const listener of this.vaultChangeListeners) listener()
      return library
    } finally {
      if (this.reconciliation === reconciliation) this.reconciliation = null
    }
  }

  private requireCurrentLibrary(): string {
    if (!this.currentLibraryPath) throw new Error('Open or create a library first.')
    return this.currentLibraryPath
  }

  private requirePendingLibrary(): string {
    if (!this.pendingLibraryPath) throw new Error('Choose a vault that needs initialization first.')
    return this.pendingLibraryPath
  }

  private validateLibraryName(requestedName: string): string {
    const name = requestedName.trim()
    if (!name) throw new Error('Enter a name for the library.')
    if (name === '.' || name === '..') throw new Error('Choose a different library name.')
    const containsControlCharacter = [...name].some((character) => character.charCodeAt(0) <= 31)
    if (/[<>:"/\\|?*]/.test(name) || containsControlCharacter || /[. ]$/.test(name)) {
      throw new Error('The library name contains characters Windows cannot use in a folder name.')
    }
    if (RESERVED_WINDOWS_NAMES.test(name)) {
      throw new Error('That name is reserved by Windows. Choose a different library name.')
    }
    return name
  }

  private validateCollectionName(requestedName: string): string {
    const name = requestedName.trim()
    if (!name) throw new Error('Enter a name for the folder.')
    if (name.length > 80) throw new Error('Folder names must be 80 characters or fewer.')
    if ([...name].some((character) => character.charCodeAt(0) <= 31)) {
      throw new Error('Enter a valid folder name.')
    }
    return name
  }

  private validateCollectionIcon(icon: unknown): CollectionIconKey {
    if (!isCollectionIconKey(icon)) throw new Error('Choose a supported folder icon.')
    return icon
  }

  private validateItemTitle(requestedTitle: unknown): string {
    if (typeof requestedTitle !== 'string') throw new Error('Enter a valid item title.')
    const title = requestedTitle.trim()
    if (!title) throw new Error('Enter a title for this item.')
    if (title.length > 200) throw new Error('Item titles must be 200 characters or fewer.')
    if ([...title].some((character) => character.charCodeAt(0) <= 31)) {
      throw new Error('Enter a valid item title.')
    }
    return title
  }

  private validateItemMutationInput(input: unknown): string[] {
    if (!input || typeof input !== 'object') throw new Error('The item request is invalid.')
    const itemIds = (input as Record<string, unknown>).itemIds
    if (
      !Array.isArray(itemIds) ||
      itemIds.length === 0 ||
      itemIds.length > 1000 ||
      itemIds.some((itemId) => typeof itemId !== 'string' || !ITEM_ID_PATTERN.test(itemId))
    ) {
      throw new Error('Choose one or more valid items.')
    }
    if (new Set(itemIds).size !== itemIds.length) {
      throw new Error('The item list contains duplicates.')
    }
    return itemIds as string[]
  }

  private validateDeletionReview(revision: unknown, itemIds: unknown): void {
    if (
      revision !== undefined &&
      (typeof revision !== 'string' || !/^[0-9a-f]{64}$/i.test(revision))
    ) {
      throw new Error('The deletion review is invalid.')
    }
    if (
      itemIds !== undefined &&
      (!Array.isArray(itemIds) ||
        itemIds.length > 1000 ||
        itemIds.some((itemId) => typeof itemId !== 'string' || !ITEM_ID_PATTERN.test(itemId)) ||
        new Set(itemIds).size !== itemIds.length)
    ) {
      throw new Error('The deletion review contains invalid items.')
    }
  }

  private validateDestination(value: unknown): ActiveItemLocation {
    if (!value || typeof value !== 'object') throw new Error('Choose a valid destination.')
    const destination = value as Record<string, unknown>
    if (destination.type === 'inbox') return { type: 'inbox' }
    if (
      destination.type === 'collection' &&
      typeof destination.collectionId === 'string' &&
      ITEM_ID_PATTERN.test(destination.collectionId)
    ) {
      return { type: 'collection', collectionId: destination.collectionId }
    }
    throw new Error('Choose a valid destination.')
  }

  private sameActiveLocation(
    current: Awaited<ReturnType<LibraryStore['resolveItem']>>['location'],
    destination: ActiveItemLocation
  ): boolean {
    return (
      current.type === destination.type &&
      (current.type !== 'collection' ||
        (destination.type === 'collection' && current.collectionId === destination.collectionId))
    )
  }

  private clearLifecycleMetadata(metadata: PersistedItem): PersistedItem {
    const next = { ...metadata, originalCollectionId: null }
    delete next.trashedFrom
    delete next.trashedFromRelativePath
    return next
  }

  private withoutTrashedFrom(metadata: PersistedItem): PersistedItem {
    const next = { ...metadata }
    delete next.trashedFrom
    delete next.trashedFromRelativePath
    return next
  }

  private validateCollectionId(collectionId: string): void {
    if (!/^[0-9a-f-]{36}$/i.test(collectionId)) {
      throw new Error('The folder identifier is invalid.')
    }
  }

  private validateItemId(id: string, label: 'item' | 'attachment'): void {
    if (!ITEM_ID_PATTERN.test(id)) throw new Error(`The ${label} identifier is invalid.`)
  }

  private async readLastLibraryPathSafely(): Promise<string | null> {
    try {
      const settings = await readJson<PersistedSettings>(this.settingsPath)
      return typeof settings.lastLibraryPath === 'string' ? settings.lastLibraryPath : null
    } catch {
      return null
    }
  }

  private toMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback
  }
}
