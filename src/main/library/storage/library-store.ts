import { performance } from 'node:perf_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, type Stats } from 'node:fs'
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'

import type {
  ActiveItemLocation,
  CollectionDto,
  FileItemDto,
  ItemDeletionInspectionDto,
  ItemLocation,
  LibraryDto,
  LibraryItemDto,
  NoteAttachmentDto
} from '../../../shared/library-contract'
import type { UrlPreviewKind, UrlPreviewMediaType } from '../../../shared/library-contract'
import {
  encodeMarkdownImageTarget,
  markdownImageTargetKey,
  normalizeMarkdownImageTarget,
  rewriteMarkdownImageDestinations,
  stagedAttachmentAliases
} from '../../../shared/markdown-image-references'
import type { CaptureSubmissionRecord } from '../../capture/capture-submission-record'
import { IMAGE_EXTENSIONS, ITEM_ID_PATTERN, URL_PREVIEW_DIRECTORY } from '../constants'
import { createImageMetadata, detectImage, toImageDto } from '../items/image-item'
import { createNoteMetadata, toNoteDto } from '../items/note-item'
import { createUrlMetadata, toUrlDto } from '../items/url-item'
import {
  isPersistedItem,
  isPersistedLibrary,
  isCollectionIconKey,
  toCollectionDto,
  type PersistedCollection,
  type PersistedImageItem,
  type PersistedItem,
  type PersistedFileItem,
  type PersistedLibrary,
  type PersistedNoteAttachment,
  type PersistedNoteItem
} from '../schemas'
import { createInternetShortcut, parseInternetShortcut } from '../internet-shortcut'
import { markdownPathForAttachment, resolveAttachmentPlacement } from '../attachment-placement'
import {
  extractVaultReferenceTargets,
  resolveVaultReferencePath,
  rewriteVaultReferences
} from '../vault-frontmatter'
import { URL_PREVIEW_EXTENSIONS } from '../url-preview'
import { readJson, writeJsonAtomic } from './json-file'
import { replaceNoteContent } from './note-file'
import {
  recoverVaultTransactions,
  runVaultTransaction,
  type VaultTransaction
} from './vault-transaction'
import { kusuPath, resolveInsideVault, resolveInsideVaultAsync } from './vault-paths'
import * as captureStore from './capture-store'

const KUSU_DIRECTORY = '.kuskus'
const LIBRARY_FILENAME = 'library.json'
const RECORDS_DIRECTORY = 'records'
const COLLECTION_RECORDS_DIRECTORY = 'collections'
const TRASH_DIRECTORY = 'trash'
const INDEX_DIRECTORY = 'index'
const LIBRARY_INDEX_FILENAME = 'library-v1.json'
const DEFAULT_ARCHIVE_DIRECTORY = 'Archive'
const MARKDOWN_EXTENSION = '.md'
const INTERNET_SHORTCUT_EXTENSION = '.url'
const HIDDEN_DIRECTORY = /^\./
const ASSETS_DIRECTORY = /\.assets$/i
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

interface VaultItemRecord {
  schemaVersion: 2
  id: string
  relativePath: string
  fingerprint: string | null
  fileIdentity?: string | null
  fileSize?: number
  modifiedAtMs?: number
  recovery?: { lastSeenAt: string; missingSince: string | null }
  metadata: PersistedItem
}

type AttachmentItemRecord = VaultItemRecord & {
  metadata: PersistedImageItem | PersistedFileItem
}

interface VaultCollectionRecord extends PersistedCollection {
  schemaVersion: 2
  relativePath: string
  parentId: string | null
}

interface LibraryIndexCache {
  schemaVersion: 1
  libraryId: string
  writtenAt: string
  library: LibraryDto
}

function isAttachmentItemRecord(record: VaultItemRecord): record is AttachmentItemRecord {
  return record.metadata.type === 'image' || record.metadata.type === 'file'
}

function pathKey(path: string): string {
  return resolve(path).toLocaleLowerCase()
}

function attachmentMetadataFromDto(attachment: NoteAttachmentDto): PersistedNoteAttachment {
  return {
    id: attachment.id,
    filename: attachment.filename,
    relativePath: attachment.relativePath,
    sourceFilename: attachment.sourceFilename,
    mediaType: attachment.mediaType,
    width: attachment.width,
    height: attachment.height
  }
}

function attachmentsEqual(
  left: readonly PersistedNoteAttachment[],
  right: readonly PersistedNoteAttachment[]
): boolean {
  return (
    left.length === right.length &&
    left.every((attachment, index) => {
      const candidate = right[index]
      return (
        candidate !== undefined &&
        attachment.id === candidate.id &&
        attachment.filename === candidate.filename &&
        attachment.relativePath === candidate.relativePath &&
        attachment.sourceFilename === candidate.sourceFilename &&
        attachment.mediaType === candidate.mediaType &&
        attachment.width === candidate.width &&
        attachment.height === candidate.height
      )
    })
  )
}

export interface PersistedCaptureDraftFile {
  id: string
  filename: string
  mediaType: string
  size: number
}

export interface ResolvedLibraryItem {
  directory: string
  path: string
  relativePath: string
  location: ItemLocation
  metadata: PersistedItem
}

export interface ItemMoveRequest {
  item: ResolvedLibraryItem
  destination: ItemLocation
  metadata: PersistedItem
}

interface ScannedFile {
  path: string
  relativePath: string
  archive: boolean
}

interface ScannedFileWithStat extends ScannedFile {
  stats: Stats
}

interface DtoBuildContext {
  itemRecords: VaultItemRecord[]
  attachmentRecords: AttachmentItemRecord[]
  attachmentRecordIds: Set<string>
  availablePaths: () => Promise<string[]>
  imageDetection: Map<string, Promise<ReturnType<typeof detectImage>>>
  noteSources: ReadonlyMap<string, string>
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  operation: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await operation(values[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function recordsEqual(left: VaultItemRecord, right: VaultItemRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function slash(path: string): string {
  return path.split(sep).join('/')
}

function titleFromPath(path: string): string {
  return basename(path, extname(path))
}

function safeStem(value: string, fallback = 'Untitled'): string {
  const stem = value
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 160)
  return !stem || WINDOWS_RESERVED.test(stem) ? fallback : stem
}

function mimeForExtension(extension: string): string {
  const normalized = extension.toLowerCase()
  if (normalized === '.png') return 'image/png'
  if (normalized === '.jpg' || normalized === '.jpeg') return 'image/jpeg'
  if (normalized === '.gif') return 'image/gif'
  if (normalized === '.webp') return 'image/webp'
  if (normalized === '.bmp') return 'image/bmp'
  return 'application/octet-stream'
}

function isImageExtension(extension: string): boolean {
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(extension.toLowerCase())
}

function metadataTimestamp(date: Date): string {
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

export class LibraryStore {
  constructor(
    private readonly onAppOwnedWrite?: (libraryPath: string, relativePath: string) => void
  ) {}

  private markAppOwnedPath(libraryPath: string, path: string): void {
    this.onAppOwnedWrite?.(libraryPath, slash(relative(libraryPath, path)))
  }

  private readonly scanPromises = new Map<
    string,
    Promise<{
      records: VaultItemRecord[]
      collections: VaultCollectionRecord[]
      noteSources: ReadonlyMap<string, string>
    }>
  >()
  private readonly scanSnapshots = new Map<
    string,
    { records: VaultItemRecord[]; collections: VaultCollectionRecord[] }
  >()
  private performanceVaultScans = 0

  getPerformanceVaultScanCount(): number {
    return this.performanceVaultScans
  }

  async pathExists(path: string): Promise<boolean> {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }

  async readCachedLibraryDto(libraryPath: string): Promise<LibraryDto | null> {
    try {
      const library = await this.readPersistedLibrary(libraryPath)
      const cached = await readJson<unknown>(
        kusuPath(libraryPath, INDEX_DIRECTORY, LIBRARY_INDEX_FILENAME)
      )
      if (!cached || typeof cached !== 'object') return null
      const value = cached as Partial<LibraryIndexCache>
      const dto = value.library
      if (
        value.schemaVersion !== 1 ||
        value.libraryId !== library.id ||
        !dto ||
        dto.id !== library.id ||
        dto.path !== libraryPath ||
        !Array.isArray(dto.items) ||
        !Array.isArray(dto.collections)
      ) {
        return null
      }
      return dto
    } catch {
      return null
    }
  }

  private async writeCachedLibraryDto(libraryPath: string, library: LibraryDto): Promise<void> {
    await writeJsonAtomic(kusuPath(libraryPath, INDEX_DIRECTORY, LIBRARY_INDEX_FILENAME), {
      schemaVersion: 1,
      libraryId: library.id,
      writtenAt: new Date().toISOString(),
      library
    } satisfies LibraryIndexCache)
  }

  private async uniquePath(directory: string, filename: string): Promise<string> {
    const extension = extname(filename)
    const stem = basename(filename, extension)
    let candidate = join(directory, filename)
    let suffix = 2
    while (await this.pathExists(candidate)) {
      candidate = join(directory, `${stem} (${suffix})${extension}`)
      suffix += 1
    }
    return candidate
  }

  private async rewriteInboundReferences(
    libraryPath: string,
    replacements: ReadonlyMap<string, string>,
    transaction: VaultTransaction
  ): Promise<void> {
    if (replacements.size === 0) return
    const records = await this.currentItemRecords(libraryPath)
    const updates = (
      await mapWithConcurrency(records, 32, async (record) => {
        if (record.metadata.type !== 'note') return null
        const path = await resolveInsideVaultAsync(libraryPath, record.relativePath)
        const fileStats = await stat(path).catch(() => null)
        if (!fileStats) return null
        const source = await readFile(path, 'utf8')
        const next = rewriteVaultReferences(source, path, path, libraryPath, replacements)
        return next === source ? null : { path, source, next }
      })
    ).filter((update): update is { path: string; source: string; next: string } => update !== null)
    for (const update of updates) {
      this.markAppOwnedPath(libraryPath, update.path)
      await transaction.writeText(update.path, update.next)
    }
  }

  async prepareNewLibrary(libraryPath: string, library: PersistedLibrary): Promise<void> {
    if (await this.pathExists(libraryPath)) {
      const targetStat = await stat(libraryPath)
      if (!targetStat.isDirectory()) {
        throw new Error(`A file named "${library.name}" already exists in the selected location.`)
      }
      if ((await readdir(libraryPath)).length > 0) {
        throw new Error(
          `The folder "${library.name}" already exists and is not empty. Choose another name or open it as an existing vault.`
        )
      }
    } else {
      await mkdir(libraryPath, { recursive: false })
    }
    await this.ensureLibraryDirectories(libraryPath)
    await mkdir(resolveInsideVault(libraryPath, DEFAULT_ARCHIVE_DIRECTORY), { recursive: true })
    await writeJsonAtomic(kusuPath(libraryPath, LIBRARY_FILENAME), {
      ...library,
      schemaVersion: 2
    })
  }

  async initializeExistingVault(libraryPath: string): Promise<PersistedLibrary> {
    const targetStat = await stat(libraryPath)
    if (!targetStat.isDirectory()) throw new Error('The selected vault path is not a folder.')
    const entries = await readdir(libraryPath)
    const archiveName = entries.includes(DEFAULT_ARCHIVE_DIRECTORY)
      ? DEFAULT_ARCHIVE_DIRECTORY
      : DEFAULT_ARCHIVE_DIRECTORY
    await this.ensureLibraryDirectories(libraryPath)
    const createdAt = new Date().toISOString()
    const library: PersistedLibrary = {
      schemaVersion: 2,
      id: randomUUID(),
      name: basename(libraryPath),
      createdAt,
      pinnedItemIds: []
    }
    await writeJsonAtomic(kusuPath(libraryPath, LIBRARY_FILENAME), {
      ...library,
      archiveDirectory: archiveName
    })
    await this.scanVault(libraryPath)
    return library
  }

  async readPersistedLibrary(libraryPath: string): Promise<PersistedLibrary> {
    await recoverVaultTransactions(libraryPath)
    const targetStat = await stat(libraryPath)
    if (!targetStat.isDirectory()) throw new Error('The library path is not a folder.')
    const v2Path = kusuPath(libraryPath, LIBRARY_FILENAME)
    if (await this.pathExists(v2Path)) {
      const library = await readJson<unknown>(v2Path)
      if (!isPersistedLibrary(library) || library.schemaVersion !== 2) {
        throw new Error('This vault uses an unsupported Kusu storage version.')
      }
      return {
        ...library,
        pinnedItemIds: Array.isArray(library.pinnedItemIds) ? library.pinnedItemIds : []
      }
    }
    throw new Error('This folder is not an initialized Kusu vault.')
  }

  async setItemsPinned(libraryPath: string, pinnedItemIds: readonly string[]): Promise<void> {
    const library = await this.readPersistedLibrary(libraryPath)
    await writeJsonAtomic(kusuPath(libraryPath, LIBRARY_FILENAME), {
      ...library,
      schemaVersion: 2,
      pinnedItemIds
    })
  }

  async isUninitializedVault(libraryPath: string): Promise<boolean> {
    if (await this.pathExists(kusuPath(libraryPath, LIBRARY_FILENAME))) return false
    const rootMetadata = await readJson<unknown>(join(libraryPath, LIBRARY_FILENAME)).catch(
      () => null
    )
    if (isPersistedLibrary(rootMetadata)) {
      throw new Error(
        'Root library.json metadata is unsupported. Open a vault-native Kusu library.'
      )
    }
    try {
      return (await stat(libraryPath)).isDirectory()
    } catch {
      return false
    }
  }

  async inspectUninitializedVault(libraryPath: string): Promise<{
    markdownFiles: number
    imageFiles: number
    otherFiles: number
    folders: number
    archiveFolderExists: boolean
  }> {
    const files = await this.listVisibleFiles(libraryPath)
    const markdownFiles = files.filter(
      (file) => extname(file.path).toLowerCase() === MARKDOWN_EXTENSION
    ).length
    const imageFiles = files.filter((file) => isImageExtension(extname(file.path))).length
    const folders = new Set<string>()
    for (const file of files) {
      let directory = slash(dirname(file.relativePath))
      while (directory !== '.' && directory !== DEFAULT_ARCHIVE_DIRECTORY) {
        folders.add(directory)
        const parent = slash(dirname(directory))
        if (parent === directory) break
        directory = parent
      }
    }
    return {
      markdownFiles,
      imageFiles,
      otherFiles: files.length - markdownFiles - imageFiles,
      folders: folders.size,
      archiveFolderExists: await this.pathExists(join(libraryPath, DEFAULT_ARCHIVE_DIRECTORY))
    }
  }

  async ensureLibraryDirectories(libraryPath: string): Promise<void> {
    await Promise.all([
      mkdir(kusuPath(libraryPath, RECORDS_DIRECTORY), { recursive: true }),
      mkdir(kusuPath(libraryPath, COLLECTION_RECORDS_DIRECTORY), { recursive: true }),
      mkdir(kusuPath(libraryPath, TRASH_DIRECTORY), { recursive: true }),
      mkdir(kusuPath(libraryPath, 'temp'), { recursive: true }),
      mkdir(kusuPath(libraryPath, URL_PREVIEW_DIRECTORY), { recursive: true })
    ])
  }

  private itemRecordPath(libraryPath: string, id: string): string {
    return kusuPath(libraryPath, RECORDS_DIRECTORY, `${id}.json`)
  }

  private collectionRecordPath(libraryPath: string, id: string): string {
    return kusuPath(libraryPath, COLLECTION_RECORDS_DIRECTORY, `${id}.json`)
  }

  private async readItemRecord(path: string, id: string): Promise<VaultItemRecord | null> {
    if (!ITEM_ID_PATTERN.test(id)) return null
    try {
      const value = await readJson<unknown>(path)
      if (!value || typeof value !== 'object') return null
      const record = value as VaultItemRecord
      if (
        record.schemaVersion === 2 &&
        record.id === id &&
        typeof record.relativePath === 'string' &&
        isPersistedItem(record.metadata, id)
      )
        return record
    } catch {
      // Invalid records remain on disk for explicit repair.
    }
    return null
  }

  private async readItemRecords(libraryPath: string): Promise<VaultItemRecord[]> {
    const directory = kusuPath(libraryPath, RECORDS_DIRECTORY)
    await mkdir(directory, { recursive: true })
    const entries = (await readdir(directory, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.json')
    )
    const values = await mapWithConcurrency(entries, 32, (entry) =>
      this.readItemRecord(join(directory, entry.name), entry.name.slice(0, -5))
    )
    return values.filter((record): record is VaultItemRecord => record !== null)
  }

  private async readCollectionRecords(libraryPath: string): Promise<VaultCollectionRecord[]> {
    const directory = kusuPath(libraryPath, COLLECTION_RECORDS_DIRECTORY)
    await mkdir(directory, { recursive: true })
    const entries = (await readdir(directory, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.json')
    )
    const values = await mapWithConcurrency(entries, 32, async (entry) => {
      try {
        const value = await readJson<unknown>(join(directory, entry.name))
        if (!value || typeof value !== 'object') return null
        const record = value as VaultCollectionRecord
        if (
          record.schemaVersion === 2 &&
          ITEM_ID_PATTERN.test(record.id) &&
          typeof record.name === 'string' &&
          typeof record.relativePath === 'string'
        ) {
          return {
            ...record,
            icon: isCollectionIconKey(record.icon) ? record.icon : undefined
          } as VaultCollectionRecord
        }
      } catch {
        // Invalid records remain available for manual recovery.
      }
      return null
    })
    return values.filter((record): record is VaultCollectionRecord => record !== null)
  }

  private async currentItemRecords(libraryPath: string): Promise<VaultItemRecord[]> {
    return (
      this.scanSnapshots.get(resolve(libraryPath))?.records ?? this.readItemRecords(libraryPath)
    )
  }

  private async currentCollectionRecords(libraryPath: string): Promise<VaultCollectionRecord[]> {
    return (
      this.scanSnapshots.get(resolve(libraryPath))?.collections ??
      this.readCollectionRecords(libraryPath)
    )
  }

  private async writeItemRecord(
    libraryPath: string,
    record: VaultItemRecord,
    transaction?: VaultTransaction
  ): Promise<void> {
    const path = this.itemRecordPath(libraryPath, record.id)
    if (transaction) await transaction.writeJson(path, record)
    else await writeJsonAtomic(path, record)
    const snapshot = this.scanSnapshots.get(resolve(libraryPath))
    if (!snapshot) return
    const index = snapshot.records.findIndex((entry) => entry.id === record.id)
    if (index === -1) snapshot.records.push(record)
    else snapshot.records[index] = record
  }

  private async writeCollectionRecord(
    libraryPath: string,
    record: VaultCollectionRecord,
    transaction?: VaultTransaction
  ): Promise<void> {
    const path = this.collectionRecordPath(libraryPath, record.id)
    if (transaction) await transaction.writeJson(path, record)
    else await writeJsonAtomic(path, record)
    const snapshot = this.scanSnapshots.get(resolve(libraryPath))
    if (!snapshot) return
    const index = snapshot.collections.findIndex((entry) => entry.id === record.id)
    if (index === -1) snapshot.collections.push(record)
    else snapshot.collections[index] = record
  }

  private async listVisibleFiles(libraryPath: string): Promise<ScannedFile[]> {
    const walk = async (directory: string, archive: boolean): Promise<ScannedFile[]> => {
      const entries = await readdir(directory, { withFileTypes: true })
      const files = await mapWithConcurrency(entries, 32, async (entry): Promise<ScannedFile[]> => {
        if (entry.isSymbolicLink()) return []
        const path = join(directory, entry.name)
        const relativePath = slash(relative(libraryPath, path))
        if (entry.isDirectory()) {
          return HIDDEN_DIRECTORY.test(entry.name)
            ? []
            : walk(path, archive || relativePath === DEFAULT_ARCHIVE_DIRECTORY)
        }
        if (!entry.isFile()) return []
        if (HIDDEN_DIRECTORY.test(entry.name) || entry.name.endsWith('.kuskus-initialize-backup'))
          return []
        return [{ path, relativePath, archive }]
      })
      return files.flat()
    }
    return walk(libraryPath, false)
  }

  private async fingerprint(path: string): Promise<string> {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex')
  }

  private fileIdentityFromStats(value: Stats): string | null {
    if (value.ino === 0) return null
    return `${value.dev.toString()}:${value.ino.toString()}`
  }

  private async fileIdentity(path: string): Promise<string | null> {
    return this.fileIdentityFromStats(await stat(path))
  }

  private async metadataForFile(
    file: ScannedFileWithStat,
    id: string,
    existing: VaultItemRecord | undefined,
    textSource?: string
  ): Promise<PersistedItem> {
    const fileStat = file.stats
    const createdAt = metadataTimestamp(fileStat.birthtime)
    const updatedAt = metadataTimestamp(fileStat.mtime)
    const title = titleFromPath(file.relativePath)
    if (extname(file.path).toLowerCase() === INTERNET_SHORTCUT_EXTENSION) {
      const sourceUrl = parseInternetShortcut(textSource ?? (await readFile(file.path, 'utf8')))
      const metadata =
        existing?.metadata.type === 'url'
          ? existing.metadata
          : createUrlMetadata(id, sourceUrl, createdAt)
      return {
        ...metadata,
        schemaVersion: 2,
        title,
        sourceUrl,
        domain: new URL(sourceUrl).hostname,
        updatedAt,
        relativePath: file.relativePath,
        referencedAttachment: false
      }
    }
    if (extname(file.path).toLowerCase() === MARKDOWN_EXTENSION) {
      const source = textSource ?? (await readFile(file.path, 'utf8'))
      const metadata =
        existing?.metadata.type === 'note'
          ? existing.metadata
          : createNoteMetadata(id, source, createdAt)
      return {
        ...metadata,
        schemaVersion: 2,
        title,
        updatedAt,
        relativePath: file.relativePath,
        referencedAttachment: false
      }
    }

    const bytes = await readFile(file.path)
    const detected = detectImage(bytes)
    if (!detected) {
      const metadata: PersistedFileItem =
        existing?.metadata.type === 'file'
          ? existing.metadata
          : {
              schemaVersion: 2,
              id,
              type: 'file',
              title,
              createdAt,
              updatedAt,
              sourceUrl: null,
              sourceFilename: basename(file.path),
              contentFilename: basename(file.path),
              mediaType: mimeForExtension(extname(file.path)),
              size: fileStat.size,
              note: '',
              originalCollectionId: null
            }
      return {
        ...metadata,
        title,
        updatedAt,
        sourceFilename: basename(file.path),
        contentFilename: basename(file.path),
        size: fileStat.size,
        relativePath: file.relativePath
      }
    }
    const metadata =
      existing?.metadata.type === 'image'
        ? existing.metadata
        : createImageMetadata(id, basename(file.path), detected, createdAt)
    return {
      ...metadata,
      schemaVersion: 2,
      title,
      updatedAt,
      sourceFilename: basename(file.path),
      contentFilename: basename(file.path),
      mediaType: detected.mediaType,
      width: detected.width,
      height: detected.height,
      relativePath: file.relativePath
    } satisfies PersistedImageItem
  }

  private async scanCollections(
    libraryPath: string,
    files: ScannedFile[]
  ): Promise<VaultCollectionRecord[]> {
    const existing = await this.readCollectionRecords(libraryPath)
    const byPath = new Map(existing.map((record) => [record.relativePath.toLowerCase(), record]))
    const folderPaths = new Set<string>()
    const existingPaths = await mapWithConcurrency(existing, 32, async (record) =>
      record.relativePath !== DEFAULT_ARCHIVE_DIRECTORY &&
      !HIDDEN_DIRECTORY.test(record.relativePath) &&
      (await this.pathExists(resolveInsideVault(libraryPath, record.relativePath)))
        ? record.relativePath
        : null
    )
    for (const relativePath of existingPaths) if (relativePath) folderPaths.add(relativePath)
    for (const file of files) {
      if (file.archive) continue
      let current = slash(dirname(file.relativePath))
      while (current && current !== '.' && current !== DEFAULT_ARCHIVE_DIRECTORY) {
        if (!ASSETS_DIRECTORY.test(current)) folderPaths.add(current)
        current = slash(dirname(current))
      }
    }
    const sortedPaths = [...folderPaths].sort((a, b) => a.split('/').length - b.split('/').length)
    const result: VaultCollectionRecord[] = []
    for (const relativePath of sortedPaths) {
      const current = byPath.get(relativePath.toLowerCase())
      const parentPath = slash(dirname(relativePath))
      const parent = result.find((record) => record.relativePath === parentPath)
      const record: VaultCollectionRecord = {
        schemaVersion: 2,
        id: current?.id ?? randomUUID(),
        name: basename(relativePath),
        icon: current?.icon,
        createdAt: current?.createdAt ?? new Date().toISOString(),
        relativePath,
        parentId: parent?.id ?? null
      }
      if (!current || JSON.stringify(current) !== JSON.stringify(record)) {
        await this.writeCollectionRecord(libraryPath, record)
      }
      result.push(record)
    }
    return result
  }

  private locationForPath(
    relativePath: string,
    collections: VaultCollectionRecord[],
    metadata: PersistedItem
  ): ItemLocation {
    if (relativePath.startsWith(`${KUSU_DIRECTORY}/${TRASH_DIRECTORY}/`)) {
      return {
        type: 'trash',
        trashedFrom: metadata.trashedFrom ?? 'inbox',
        originalCollectionId: metadata.originalCollectionId
      }
    }
    if (
      relativePath === DEFAULT_ARCHIVE_DIRECTORY ||
      relativePath.startsWith(`${DEFAULT_ARCHIVE_DIRECTORY}/`)
    ) {
      return { type: 'archive', originalCollectionId: metadata.originalCollectionId }
    }
    const parentPath = slash(dirname(relativePath))
    if (parentPath === '.') return { type: 'inbox' }
    const collection = collections.find((entry) => entry.relativePath === parentPath)
    return collection ? { type: 'collection', collectionId: collection.id } : { type: 'inbox' }
  }

  private async performScanVault(libraryPath: string): Promise<{
    records: VaultItemRecord[]
    collections: VaultCollectionRecord[]
    noteSources: ReadonlyMap<string, string>
  }> {
    let phaseStart = performance.now()
    const phase = (name: string): void => {
      const end = performance.now()
      if (process.env.KUSU_PERFORMANCE_OUTPUT)
        performance.measure('kusu:storage:' + name, { start: phaseStart, end })
      phaseStart = end
    }
    await recoverVaultTransactions(libraryPath)
    await this.ensureLibraryDirectories(libraryPath)
    phase('prepare')
    const files = await this.listVisibleFiles(libraryPath)
    phase('list-files')
    const collections = await this.scanCollections(libraryPath, files)
    phase('collections')
    const existing = await this.readItemRecords(libraryPath)
    phase('read-records')
    const byPath = new Map(existing.map((record) => [record.relativePath.toLowerCase(), record]))
    const byFingerprint = new Map<string, VaultItemRecord[]>()
    const byFileIdentity = new Map<string, VaultItemRecord[]>()
    for (const record of existing) {
      if (record.fingerprint) {
        const entries = byFingerprint.get(record.fingerprint) ?? []
        entries.push(record)
        byFingerprint.set(record.fingerprint, entries)
      }
      if (record.fileIdentity) {
        const entries = byFileIdentity.get(record.fileIdentity) ?? []
        entries.push(record)
        byFileIdentity.set(record.fileIdentity, entries)
      }
    }

    const seenIds = new Set<string>()
    const records: VaultItemRecord[] = []
    const filesWithStats = await mapWithConcurrency(files, 32, async (file) => ({
      ...file,
      stats: await stat(file.path)
    }))
    phase('file-stats')
    const scanEntries = await mapWithConcurrency(filesWithStats, 8, async (file) => {
      const current = byPath.get(file.relativePath.toLowerCase())
      const fileIdentity = this.fileIdentityFromStats(file.stats)
      const sameStats =
        current !== undefined &&
        current.fileSize === file.stats.size &&
        current.modifiedAtMs === file.stats.mtimeMs &&
        current.fileIdentity === fileIdentity
      const extension = extname(file.path).toLowerCase()
      const textBytes =
        extension === MARKDOWN_EXTENSION ||
        (!sameStats && extension === INTERNET_SHORTCUT_EXTENSION)
          ? await readFile(file.path)
          : null
      const fingerprint = textBytes
        ? createHash('sha256').update(textBytes).digest('hex')
        : sameStats
          ? current.fingerprint
          : await this.fingerprint(file.path)
      return {
        file,
        fileIdentity,
        fingerprint,
        textSource: textBytes?.toString('utf8'),
        unchanged: sameStats && current.fingerprint === fingerprint
      }
    })
    phase('fingerprints')
    const fingerprintCounts = new Map<string, number>()
    for (const entry of scanEntries) {
      if (entry.fingerprint) {
        fingerprintCounts.set(
          entry.fingerprint,
          (fingerprintCounts.get(entry.fingerprint) ?? 0) + 1
        )
      }
    }
    const plannedRecords: Array<{
      file: ScannedFileWithStat
      fileIdentity: string | null
      fingerprint: string | null
      unchanged: boolean
      current: VaultItemRecord | undefined
      id: string
      textSource: string | undefined
    }> = []
    // Existing paths own their IDs even when a new file shares or reuses a file identity.
    const presentPaths = new Set(scanEntries.map(({ file }) => file.relativePath.toLowerCase()))
    for (const { file, fileIdentity, fingerprint, textSource, unchanged } of scanEntries) {
      let current = byPath.get(file.relativePath.toLowerCase())
      if (!current && fileIdentity) {
        const matches = (byFileIdentity.get(fileIdentity) ?? []).filter(
          (record) =>
            !seenIds.has(record.id) && !presentPaths.has(record.relativePath.toLowerCase())
        )
        if (matches.length === 1) current = matches[0]
      }
      if (!current && fingerprint && fingerprintCounts.get(fingerprint) === 1) {
        const matches = (byFingerprint.get(fingerprint) ?? []).filter(
          (record) =>
            !seenIds.has(record.id) && !presentPaths.has(record.relativePath.toLowerCase())
        )
        if (matches.length === 1) current = matches[0]
      }
      let id = current?.id ?? randomUUID()
      if (seenIds.has(id)) id = randomUUID()
      plannedRecords.push({ file, fileIdentity, fingerprint, unchanged, current, id, textSource })
      seenIds.add(id)
    }
    const builtRecords = await mapWithConcurrency(plannedRecords, 32, async (planned) => {
      const { file, fileIdentity, fingerprint, unchanged, current, id, textSource } = planned
      const metadata =
        unchanged && current
          ? current.metadata
          : await this.metadataForFile(file, id, current, textSource)
      const record: VaultItemRecord = {
        schemaVersion: 2,
        id,
        relativePath: file.relativePath,
        fingerprint,
        fileIdentity,
        fileSize: file.stats.size,
        modifiedAtMs: file.stats.mtimeMs,
        recovery:
          unchanged && current?.recovery
            ? { ...current.recovery, missingSince: null }
            : { lastSeenAt: new Date().toISOString(), missingSince: null },
        metadata
      }
      return {
        record,
        changed: !current || !recordsEqual(current, record),
        isNew: current === undefined,
        textSource
      }
    })
    phase('metadata')
    records.push(...builtRecords.map(({ record }) => record))
    await mapWithConcurrency(
      builtRecords.filter(({ changed }) => changed),
      128,
      async ({ record, isNew }) => {
        if (isNew) {
          // ponytail: new scan records are rebuildable, so avoid 5,000 atomic rename transactions.
          await writeFile(
            await resolveInsideVaultAsync(
              libraryPath,
              join(KUSU_DIRECTORY, RECORDS_DIRECTORY, `${record.id}.json`)
            ),
            `${JSON.stringify(record, null, 2)}\n`,
            'utf8'
          )
        } else {
          await this.writeItemRecord(libraryPath, record)
        }
      }
    )

    phase('write-records')
    const references = new Set<string>()
    let availablePaths: Promise<string[]> | undefined
    const noteSources = new Map(
      builtRecords.flatMap(({ record, textSource }) =>
        record.metadata.type === 'note' && textSource !== undefined
          ? ([[record.id, textSource]] as const)
          : []
      )
    )
    const noteRecords = records.filter((record) => record.metadata.type === 'note')
    const noteReferences = await mapWithConcurrency(noteRecords, 32, async (record) => {
      const source =
        noteSources.get(record.id) ??
        (await readFile(await resolveInsideVaultAsync(libraryPath, record.relativePath), 'utf8'))
      noteSources.set(record.id, source)
      const references = extractVaultReferenceTargets(source)
      if (references.length === 0) return []
      const notePath = await resolveInsideVaultAsync(libraryPath, record.relativePath)
      const paths = await (availablePaths ??= mapWithConcurrency(records, 32, (entry) =>
        resolveInsideVaultAsync(libraryPath, entry.relativePath)
      ))
      return references.map((reference) => {
        const target = resolveVaultReferencePath(reference, notePath, libraryPath, paths)
        return slash(relative(libraryPath, target)).toLowerCase()
      })
    })
    for (const targets of noteReferences) {
      for (const target of targets) references.add(target)
    }
    const referenceUpdates: VaultItemRecord[] = []
    for (const record of records) {
      if (record.metadata.type !== 'image' && record.metadata.type !== 'file') continue
      const referencedAttachment = references.has(record.relativePath.toLowerCase())
      if ((record.metadata.referencedAttachment ?? false) !== referencedAttachment) {
        record.metadata = { ...record.metadata, referencedAttachment }
        referenceUpdates.push(record)
      }
    }
    await mapWithConcurrency(referenceUpdates, 16, async (record) =>
      this.writeItemRecord(libraryPath, record)
    )
    phase('references')
    const missingRecords: VaultItemRecord[] = []
    for (const record of existing) {
      if (seenIds.has(record.id)) continue
      const missing = {
        ...record,
        recovery: {
          lastSeenAt: record.recovery?.lastSeenAt ?? record.metadata.updatedAt,
          missingSince: record.recovery?.missingSince ?? new Date().toISOString()
        }
      }
      if (!recordsEqual(record, missing)) missingRecords.push(missing)
      records.push(missing)
    }
    await mapWithConcurrency(missingRecords, 16, async (record) =>
      this.writeItemRecord(libraryPath, record)
    )
    phase('missing-records')
    return { records, collections, noteSources }
  }

  private async scanVault(libraryPath: string): ReturnType<LibraryStore['performScanVault']> {
    const key = resolve(libraryPath)
    const active = this.scanPromises.get(key)
    if (active) return active
    if (process.env.KUSU_PERFORMANCE_OUTPUT) this.performanceVaultScans += 1
    const scan = this.performScanVault(libraryPath)
      .then((snapshot) => {
        const { records, collections } = snapshot
        this.scanSnapshots.set(key, { records, collections })
        return snapshot
      })
      .finally(() => {
        this.scanPromises.delete(key)
      })
    this.scanPromises.set(key, scan)
    return scan
  }

  async buildLibraryDto(libraryPath: string): Promise<LibraryDto> {
    const library = await this.readPersistedLibrary(libraryPath)
    const { records, collections, noteSources } = await this.scanVault(libraryPath)
    return this.buildDto(libraryPath, library, records, collections, noteSources)
  }

  async updateLibraryDto(
    libraryPath: string,
    library: LibraryDto,
    changedItemIds: readonly string[],
    removedItemIds: readonly string[] = []
  ): Promise<LibraryDto> {
    const snapshot = this.scanSnapshots.get(resolve(libraryPath))
    if (!snapshot) return this.buildLibraryDtoFromRecords(libraryPath)
    const existingIds = new Set(library.items.map((item) => item.id))
    const changed = new Set(changedItemIds)
    for (const record of snapshot.records) {
      if (!existingIds.has(record.id) && !removedItemIds.includes(record.id)) {
        changed.add(record.id)
      }
    }
    const removed = new Set(removedItemIds)
    const context = this.dtoBuildContextFromRecords(libraryPath, snapshot.records)
    const changedItems = await mapWithConcurrency(
      snapshot.records.filter((record) => changed.has(record.id) && !removed.has(record.id)),
      16,
      (record) => this.recordToDto(libraryPath, record, snapshot.collections, context)
    )
    const changedById = new Map(changedItems.map((item) => [item.id, item]))
    const next: LibraryDto = {
      ...library,
      items: [
        ...library.items
          .filter((item) => !removed.has(item.id))
          .map((item) => changedById.get(item.id) ?? item),
        ...changedItems.filter((item) => !existingIds.has(item.id))
      ].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      collections: snapshot.collections.map(toCollectionDto)
    }
    await this.writeCachedLibraryDto(libraryPath, next)
    return next
  }

  async buildLibraryDtoFromRecords(libraryPath: string): Promise<LibraryDto> {
    const [library, records, collections] = await Promise.all([
      this.readPersistedLibrary(libraryPath),
      this.readItemRecords(libraryPath),
      this.readCollectionRecords(libraryPath)
    ])
    this.scanSnapshots.set(resolve(libraryPath), { records, collections })
    return this.buildDto(libraryPath, library, records, collections, new Map())
  }

  private async buildDto(
    libraryPath: string,
    library: PersistedLibrary,
    records: VaultItemRecord[],
    collections: VaultCollectionRecord[],
    noteSources: ReadonlyMap<string, string>
  ): Promise<LibraryDto> {
    const context = this.dtoBuildContextFromRecords(libraryPath, records, noteSources)
    const items = await mapWithConcurrency(records, 32, (record) =>
      this.recordToDto(libraryPath, record, collections, context)
    )
    const dto: LibraryDto = {
      ...library,
      schemaVersion: 2,
      path: libraryPath,
      items: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      collections: collections.map(toCollectionDto)
    }
    await this.writeCachedLibraryDto(libraryPath, dto)
    return dto
  }

  async reconcileKnownFiles(
    libraryPath: string,
    library: LibraryDto,
    relativePaths: readonly string[]
  ): Promise<LibraryDto | null> {
    const key = resolve(libraryPath)
    const snapshot = this.scanSnapshots.get(key)
    if (!snapshot || relativePaths.length === 0) return null
    const records = [...snapshot.records]
    const recordByPath = new Map(
      records.map((record) => [record.relativePath.toLocaleLowerCase(), record])
    )
    const itemById = new Map(library.items.map((item) => [item.id, item]))
    const changedRecords: VaultItemRecord[] = []

    for (const relativePath of new Set(relativePaths)) {
      const normalizedPath = slash(relativePath)
      const current = recordByPath.get(normalizedPath.toLocaleLowerCase())
      const item = current ? itemById.get(current.id) : null
      if (!current || !item || current.recovery?.missingSince) return null
      const path = resolveInsideVault(libraryPath, normalizedPath)
      let fileStats: Stats
      try {
        fileStats = await stat(path)
      } catch {
        return null
      }
      if (!fileStats.isFile()) return null
      if (
        current.fileSize === fileStats.size &&
        current.modifiedAtMs === fileStats.mtimeMs &&
        current.fileIdentity === this.fileIdentityFromStats(fileStats)
      ) {
        continue
      }
      if (item.type === 'note') {
        const nextBody = await readFile(path, 'utf8')
        const previousReferences = extractVaultReferenceTargets(item.body).sort()
        const nextReferences = extractVaultReferenceTargets(nextBody).sort()
        if (JSON.stringify(previousReferences) !== JSON.stringify(nextReferences)) return null
      }
      const file: ScannedFileWithStat = {
        path,
        relativePath: normalizedPath,
        archive:
          normalizedPath === DEFAULT_ARCHIVE_DIRECTORY ||
          normalizedPath.startsWith(`${DEFAULT_ARCHIVE_DIRECTORY}/`),
        stats: fileStats
      }
      const nextRecord: VaultItemRecord = {
        schemaVersion: 2,
        id: current.id,
        relativePath: normalizedPath,
        fingerprint: await this.fingerprint(path),
        fileIdentity: this.fileIdentityFromStats(fileStats),
        fileSize: fileStats.size,
        modifiedAtMs: fileStats.mtimeMs,
        recovery: { lastSeenAt: new Date().toISOString(), missingSince: null },
        metadata: await this.metadataForFile(file, current.id, current)
      }
      await this.writeItemRecord(libraryPath, nextRecord)
      const index = records.findIndex((record) => record.id === current.id)
      records[index] = nextRecord
      recordByPath.set(normalizedPath.toLocaleLowerCase(), nextRecord)
      changedRecords.push(nextRecord)
    }

    if (changedRecords.length === 0) return library
    const context = this.dtoBuildContextFromRecords(libraryPath, records)
    const changedItems = await Promise.all(
      changedRecords.map((record) =>
        this.recordToDto(libraryPath, record, snapshot.collections, context)
      )
    )
    const changedById = new Map(changedItems.map((item) => [item.id, item]))
    const nextLibrary: LibraryDto = {
      ...library,
      items: library.items
        .map((item) => changedById.get(item.id) ?? item)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    }
    this.scanSnapshots.set(key, { records, collections: snapshot.collections })
    await this.writeCachedLibraryDto(libraryPath, nextLibrary)
    return nextLibrary
  }

  private async createDtoBuildContext(libraryPath: string): Promise<DtoBuildContext> {
    const itemRecords = await this.readItemRecords(libraryPath)
    return this.dtoBuildContextFromRecords(libraryPath, itemRecords, new Map())
  }

  private dtoBuildContextFromRecords(
    libraryPath: string,
    itemRecords: VaultItemRecord[],
    noteSources: ReadonlyMap<string, string> = new Map()
  ): DtoBuildContext {
    let availablePaths: Promise<string[]> | undefined
    const attachmentRecords = itemRecords.filter(isAttachmentItemRecord)
    return {
      itemRecords,
      attachmentRecords,
      attachmentRecordIds: new Set(attachmentRecords.map((item) => item.id)),
      availablePaths: () =>
        (availablePaths ??= mapWithConcurrency(itemRecords, 32, async (item) => [
          await resolveInsideVaultAsync(libraryPath, item.relativePath),
          ...(item.metadata.trashedFromRelativePath
            ? [await resolveInsideVaultAsync(libraryPath, item.metadata.trashedFromRelativePath)]
            : [])
        ]).then((paths) => paths.flat())),
      imageDetection: new Map(),
      noteSources
    }
  }

  private async recordToDto(
    libraryPath: string,
    record: VaultItemRecord,
    collections: VaultCollectionRecord[],
    context?: DtoBuildContext
  ): Promise<LibraryItemDto> {
    const metadata = { ...record.metadata, relativePath: record.relativePath }
    const location = this.locationForPath(record.relativePath, collections, metadata)
    const path = await resolveInsideVaultAsync(libraryPath, record.relativePath)
    if (metadata.type === 'url') return toUrlDto(metadata, location)
    if (metadata.type === 'image') {
      return { ...toImageDto(metadata, location), missingContent: !(await this.pathExists(path)) }
    }
    if (metadata.type === 'file') {
      return {
        schemaVersion: 2,
        id: metadata.id,
        type: 'file',
        title: metadata.title,
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
        sourceFilename: metadata.sourceFilename,
        contentFilename: metadata.contentFilename,
        mediaType: metadata.mediaType,
        size: metadata.size,
        missingContent: !(await this.pathExists(path)),
        location,
        relativePath: record.relativePath,
        referencedAttachment: metadata.referencedAttachment ?? false
      } satisfies FileItemDto
    }
    let body = context?.noteSources.get(record.id) ?? ''
    let missingContent = false
    if (!context?.noteSources.has(record.id)) {
      try {
        body = await readFile(path, 'utf8')
      } catch {
        missingContent = true
      }
    }
    const attachments = await this.noteAttachments(libraryPath, record, body, context)
    return { ...toNoteDto(metadata, body, attachments, location), missingContent }
  }

  private async noteAttachments(
    libraryPath: string,
    record: VaultItemRecord,
    source: string,
    context?: DtoBuildContext
  ): Promise<NoteAttachmentDto[]> {
    if (record.metadata.type !== 'note') return []
    const references = extractVaultReferenceTargets(source)
    if (references.length === 0) return []
    const buildContext = context ?? (await this.createDtoBuildContext(libraryPath))

    const notePath = await resolveInsideVaultAsync(libraryPath, record.relativePath)
    const availablePaths = await buildContext.availablePaths()
    const attachments: NoteAttachmentDto[] = []
    const seenTargets = new Set<string>()
    for (const reference of references) {
      const target = resolveVaultReferencePath(reference, notePath, libraryPath, availablePaths)
      const targetKey = pathKey(target)
      if (seenTargets.has(targetKey)) continue
      seenTargets.add(targetKey)
      const relativePath = slash(relative(dirname(notePath), target))
      if (!target.startsWith(`${resolve(libraryPath)}${sep}`) || !isImageExtension(extname(target)))
        continue
      await resolveInsideVaultAsync(libraryPath, relative(libraryPath, target))
      const targetExists = await this.pathExists(target)
      const binaryRecord = this.attachmentRecordForTarget(
        libraryPath,
        notePath,
        record.metadata,
        target,
        buildContext.attachmentRecords,
        targetExists
      )
      let width = binaryRecord?.metadata.type === 'image' ? binaryRecord.metadata.width : 1
      let height = binaryRecord?.metadata.type === 'image' ? binaryRecord.metadata.height : 1
      let mediaType =
        binaryRecord?.metadata.type === 'image'
          ? binaryRecord.metadata.mediaType
          : (mimeForExtension(extname(target)) as NoteAttachmentDto['mediaType'])
      let missingContent = !targetExists
      if (targetExists && !binaryRecord) {
        const key = pathKey(target)
        let detection = buildContext.imageDetection.get(key)
        if (!detection) {
          detection = readFile(target).then((bytes) => detectImage(bytes))
          buildContext.imageDetection.set(key, detection)
        }
        const detected = await detection
        if (detected) {
          width = detected.width
          height = detected.height
          mediaType = detected.mediaType
          missingContent = false
        }
      }
      attachments.push({
        id: binaryRecord?.id ?? randomUUID(),
        filename: basename(target),
        relativePath: relativePath.startsWith('.') ? relativePath : `./${relativePath}`,
        sourceFilename: basename(target),
        mediaType,
        width,
        height,
        missingContent
      })
    }
    await this.reconcileNoteAttachmentMetadata(
      libraryPath,
      notePath,
      record,
      record.metadata,
      attachments.filter((attachment) => buildContext.attachmentRecordIds.has(attachment.id))
    )
    return attachments
  }

  private attachmentRecordForTarget(
    libraryPath: string,
    notePath: string,
    noteMetadata: PersistedNoteItem,
    target: string,
    attachmentRecords: readonly AttachmentItemRecord[],
    targetExists: boolean
  ): AttachmentItemRecord | undefined {
    const targetRelativePath = slash(relative(libraryPath, target)).toLowerCase()
    const exactActiveRecord = attachmentRecords.find(
      (entry) =>
        targetExists &&
        !entry.relativePath.startsWith(`${KUSU_DIRECTORY}/`) &&
        entry.relativePath.toLowerCase() === targetRelativePath
    )
    if (exactActiveRecord) return exactActiveRecord

    for (const attachment of noteMetadata.attachments ?? []) {
      const storedTarget = resolve(
        dirname(notePath),
        normalizeMarkdownImageTarget(attachment.relativePath)
      )
      if (pathKey(storedTarget) !== pathKey(target)) continue
      const persistedRecord = attachmentRecords.find(
        (entry) =>
          entry.id === attachment.id &&
          (entry.relativePath.toLowerCase() === targetRelativePath ||
            entry.metadata.trashedFromRelativePath?.toLowerCase() === targetRelativePath)
      )
      if (persistedRecord) return persistedRecord
    }

    const historicalRecords = attachmentRecords.filter(
      (entry) => entry.metadata.trashedFromRelativePath?.toLowerCase() === targetRelativePath
    )
    return historicalRecords.length === 1 ? historicalRecords[0] : undefined
  }

  private async reconcileNoteAttachmentMetadata(
    libraryPath: string,
    notePath: string,
    record: VaultItemRecord,
    noteMetadata: PersistedNoteItem,
    attachments: readonly NoteAttachmentDto[]
  ): Promise<void> {
    if (!(await this.pathExists(notePath))) return
    const persistedAttachments = attachments.map(attachmentMetadataFromDto)
    if (attachmentsEqual(noteMetadata.attachments ?? [], persistedAttachments)) return
    await this.writeItemRecord(libraryPath, {
      ...record,
      metadata: { ...noteMetadata, attachments: persistedAttachments }
    })
  }

  async createCollection(libraryPath: string, collection: PersistedCollection): Promise<void> {
    const parentId = collection.parentId ?? null
    let directory = libraryPath
    if (parentId !== null) {
      const parent = (await this.readPersistedCollections(libraryPath)).find(
        (record) => record.id === parentId
      )
      if (!parent) throw new Error('The parent folder no longer exists.')
      directory = resolveInsideVault(libraryPath, parent.relativePath ?? parent.name)
      const parentStat = await stat(directory)
      if (!parentStat.isDirectory()) throw new Error('The parent folder is unavailable.')
    }
    const path = await this.uniquePath(directory, safeStem(collection.name, 'New collection'))
    await mkdir(path, { recursive: false })
    try {
      await this.writeCollectionRecord(libraryPath, {
        ...collection,
        schemaVersion: 2,
        name: basename(path),
        relativePath: slash(relative(libraryPath, path)),
        parentId
      })
    } catch (error) {
      await rm(path, { recursive: true, force: true })
      throw error
    }
  }

  async readCollections(libraryPath: string): Promise<CollectionDto[]> {
    return (await this.scanVault(libraryPath)).collections.map(toCollectionDto)
  }

  async readPersistedCollections(libraryPath: string): Promise<PersistedCollection[]> {
    return (await this.scanVault(libraryPath)).collections
  }

  async updateCollection(libraryPath: string, collection: PersistedCollection): Promise<void> {
    try {
      await runVaultTransaction(libraryPath, (transaction) =>
        this.updateCollectionInTransaction(libraryPath, collection, transaction)
      )
    } catch (error) {
      this.scanSnapshots.delete(resolve(libraryPath))
      throw error
    }
  }

  private async updateCollectionInTransaction(
    libraryPath: string,
    collection: PersistedCollection,
    transaction: VaultTransaction
  ): Promise<void> {
    const records = await this.readCollectionRecords(libraryPath)
    const current = records.find((entry) => entry.id === collection.id)
    if (!current) throw new Error('This folder no longer exists.')
    let relativePath = current.relativePath
    if (collection.name !== current.name) {
      const source = resolveInsideVault(libraryPath, current.relativePath)
      const destination = await this.uniquePath(
        dirname(source),
        safeStem(collection.name, current.name)
      )
      await transaction.rename(source, destination)
      relativePath = slash(relative(libraryPath, destination))
      const items = (await this.readItemRecords(libraryPath))
        .filter((item) => item.relativePath.startsWith(`${current.relativePath}/`))
        .map((item) => {
          item.relativePath = `${relativePath}${item.relativePath.slice(current.relativePath.length)}`
          item.metadata = { ...item.metadata, relativePath: item.relativePath }
          return item
        })
      const children = records
        .filter((child) => child.relativePath.startsWith(`${current.relativePath}/`))
        .map((child) => {
          child.relativePath = `${relativePath}${child.relativePath.slice(current.relativePath.length)}`
          child.name = basename(child.relativePath)
          return child
        })
      for (const item of items) await this.writeItemRecord(libraryPath, item, transaction)
      for (const child of children)
        await this.writeCollectionRecord(libraryPath, child, transaction)
    }
    await this.writeCollectionRecord(
      libraryPath,
      {
        ...current,
        ...collection,
        schemaVersion: 2,
        name: basename(relativePath),
        relativePath
      },
      transaction
    )
  }

  async moveCollection(
    libraryPath: string,
    collectionId: string,
    parentId: string | null
  ): Promise<void> {
    try {
      await runVaultTransaction(libraryPath, (transaction) =>
        this.moveCollectionInTransaction(libraryPath, collectionId, parentId, transaction)
      )
    } catch (error) {
      this.scanSnapshots.delete(resolve(libraryPath))
      throw error
    }
  }

  private async moveCollectionInTransaction(
    libraryPath: string,
    collectionId: string,
    parentId: string | null,
    transaction: VaultTransaction
  ): Promise<void> {
    const collectionRecords = await this.readCollectionRecords(libraryPath)
    const current = collectionRecords.find((entry) => entry.id === collectionId)
    if (!current) throw new Error('This folder no longer exists.')
    let destinationDirectory = libraryPath
    if (parentId !== null) {
      const parent = collectionRecords.find((entry) => entry.id === parentId)
      if (!parent) throw new Error('The destination folder no longer exists.')
      if (parent.id === current.id || parent.relativePath.startsWith(`${current.relativePath}/`)) {
        throw new Error('A folder cannot be moved inside itself or one of its subfolders.')
      }
      destinationDirectory = resolveInsideVault(libraryPath, parent.relativePath)
    }

    const source = resolveInsideVault(libraryPath, current.relativePath)
    const destination = await this.uniquePath(destinationDirectory, basename(source))
    const nextRoot = slash(relative(libraryPath, destination))
    const itemRecords = await this.readItemRecords(libraryPath)
    const affectedItems = itemRecords.filter((item) =>
      item.relativePath.startsWith(`${current.relativePath}/`)
    )
    const affectedCollections = collectionRecords.filter(
      (collection) =>
        collection.id === current.id ||
        collection.relativePath.startsWith(`${current.relativePath}/`)
    )

    await transaction.rename(source, destination)
    for (const item of affectedItems) {
      const relativePath = `${nextRoot}${item.relativePath.slice(current.relativePath.length)}`
      await this.writeItemRecord(
        libraryPath,
        {
          ...item,
          relativePath,
          metadata: { ...item.metadata, relativePath }
        },
        transaction
      )
    }
    for (const collection of affectedCollections) {
      const relativePath = `${nextRoot}${collection.relativePath.slice(current.relativePath.length)}`
      await this.writeCollectionRecord(
        libraryPath,
        {
          ...collection,
          name: basename(relativePath),
          relativePath,
          parentId: collection.id === current.id ? parentId : collection.parentId
        },
        transaction
      )
    }
  }

  async assertCollectionRemovable(
    libraryPath: string,
    collectionId: string,
    retainedEntries: string[]
  ): Promise<void> {
    const current = (await this.readCollectionRecords(libraryPath)).find(
      (entry) => entry.id === collectionId
    )
    if (!current) throw new Error('This folder no longer exists.')
    const path = resolveInsideVault(libraryPath, current.relativePath)
    const retained = new Set(retainedEntries.map((entry) => entry.toLowerCase()))
    const remaining = (await readdir(path, { withFileTypes: true })).filter(
      (entry) => !retained.has(entry.name.toLowerCase())
    )
    if (remaining.some((entry) => entry.isDirectory())) {
      throw new Error('Move or remove its subfolders before deleting this folder.')
    }
    if (remaining.length > 0) {
      throw new Error(
        'This folder contains files Kusu does not manage. Move them in Explorer, then try again.'
      )
    }
  }

  async deleteCollection(libraryPath: string, collectionId: string): Promise<void> {
    const collections = await this.readCollectionRecords(libraryPath)
    const current = collections.find((entry) => entry.id === collectionId)
    if (!current) return
    const path = resolveInsideVault(libraryPath, current.relativePath)
    await rm(path, { recursive: true })
    const removedIds = new Set(
      collections
        .filter(
          (entry) =>
            entry.id === collectionId || entry.relativePath.startsWith(`${current.relativePath}/`)
        )
        .map((entry) => entry.id)
    )
    await Promise.all(
      [...removedIds].map((id) => rm(this.collectionRecordPath(libraryPath, id), { force: true }))
    )
    const snapshot = this.scanSnapshots.get(resolve(libraryPath))
    if (snapshot) {
      snapshot.collections = snapshot.collections.filter((entry) => !removedIds.has(entry.id))
    }
  }

  async prepareCaptureSubmission(
    libraryPath: string,
    record: CaptureSubmissionRecord
  ): Promise<void> {
    return captureStore.prepareCaptureSubmission(libraryPath, record)
  }

  async listCaptureSubmissions(libraryPath: string): Promise<CaptureSubmissionRecord[]> {
    return captureStore.listCaptureSubmissions(libraryPath)
  }

  async readCaptureSubmission(
    libraryPath: string,
    submissionId: string
  ): Promise<CaptureSubmissionRecord> {
    return captureStore.readCaptureSubmission(libraryPath, submissionId)
  }

  async writeCaptureSubmission(
    libraryPath: string,
    record: CaptureSubmissionRecord
  ): Promise<void> {
    return captureStore.writeCaptureSubmission(libraryPath, record)
  }

  async discardCaptureSubmission(libraryPath: string, submissionId: string): Promise<void> {
    return captureStore.discardCaptureSubmission(libraryPath, submissionId)
  }

  async restoreCaptureSubmissionDraft(libraryPath: string, submissionId: string): Promise<void> {
    return captureStore.restoreCaptureSubmissionDraft(libraryPath, submissionId)
  }

  async readCaptureSubmissionAttachment(
    libraryPath: string,
    submissionId: string,
    attachmentId: string
  ): Promise<{ attachment: PersistedNoteAttachment; bytes: Buffer }> {
    return captureStore.readCaptureSubmissionAttachment(libraryPath, submissionId, attachmentId)
  }

  async readCaptureSubmissionFile(
    libraryPath: string,
    submissionId: string,
    fileId: string
  ): Promise<{ file: PersistedCaptureDraftFile; bytes: Buffer }> {
    return captureStore.readCaptureSubmissionFile(libraryPath, submissionId, fileId)
  }

  async readCaptureDraftFile(libraryPath: string): Promise<PersistedCaptureDraftFile | null> {
    return captureStore.readCaptureDraftFile(libraryPath)
  }

  async stageCaptureDraftFile(
    libraryPath: string,
    file: PersistedCaptureDraftFile,
    bytes: Uint8Array
  ): Promise<void> {
    return captureStore.stageCaptureDraftFile(libraryPath, file, bytes)
  }

  async readCaptureDraftFileBytes(
    libraryPath: string,
    fileId: string
  ): Promise<{ file: PersistedCaptureDraftFile; bytes: Buffer }> {
    return captureStore.readCaptureDraftFileBytes(libraryPath, fileId)
  }

  async discardCaptureDraftFile(libraryPath: string): Promise<void> {
    return captureStore.discardCaptureDraftFile(libraryPath)
  }

  async readCaptureDraftAttachments(libraryPath: string): Promise<PersistedNoteAttachment[]> {
    return captureStore.readCaptureDraftAttachments(libraryPath)
  }

  async stageCaptureDraftAttachment(
    libraryPath: string,
    attachment: PersistedNoteAttachment,
    bytes: Uint8Array
  ): Promise<void> {
    return captureStore.stageCaptureDraftAttachment(libraryPath, attachment, bytes)
  }

  async renameCaptureDraftAttachment(
    libraryPath: string,
    attachmentId: string,
    filename: string
  ): Promise<PersistedNoteAttachment> {
    return captureStore.renameCaptureDraftAttachment(libraryPath, attachmentId, filename)
  }

  async removeCaptureDraftAttachment(libraryPath: string, attachmentId: string): Promise<void> {
    return captureStore.removeCaptureDraftAttachment(libraryPath, attachmentId)
  }

  async discardCaptureDraft(libraryPath: string): Promise<void> {
    return captureStore.discardCaptureDraft(libraryPath)
  }

  async readCaptureDraftAttachment(
    libraryPath: string,
    attachmentId: string
  ): Promise<{ attachment: PersistedNoteAttachment; bytes: Buffer }> {
    return captureStore.readCaptureDraftAttachment(libraryPath, attachmentId)
  }

  async finalizeInboxItem(
    libraryPath: string,
    metadata: PersistedItem,
    files: Array<{ filename: string; data: string | Uint8Array }>,
    location: ItemLocation = { type: 'inbox' }
  ): Promise<void> {
    await this.readPersistedLibrary(libraryPath)
    let filename: string
    let content: string | Uint8Array
    if (metadata.type === 'url') {
      filename = `${safeStem(metadata.title, metadata.domain)}${INTERNET_SHORTCUT_EXTENSION}`
      content = createInternetShortcut(metadata.sourceUrl)
    } else if (metadata.type === 'note') {
      filename = `${safeStem(metadata.title)}.md`
      const note = files.find((entry) => entry.filename.toLowerCase().endsWith('.md'))
      if (!note || typeof note.data !== 'string') throw new Error('The note content is missing.')
      content = note.data
    } else if (metadata.type === 'image') {
      const extension = `.${IMAGE_EXTENSIONS[metadata.mediaType]}`
      const original = metadata.sourceFilename
      filename =
        original && extname(original)
          ? safeStem(basename(original, extname(original))) + extension
          : `${safeStem(metadata.title, 'Pasted image')}${extension}`
      const image = files.find((entry) => !entry.filename.includes('/'))
      if (!image) throw new Error('The image content is missing.')
      content = image.data
    } else {
      throw new Error(
        'General files are indexed from the vault but are not captured through this operation.'
      )
    }
    const recoveryMarker = kusuPath(libraryPath, 'temp', `${metadata.id}.capture-recovery.json`)
    let destination: string
    let recoveredAttachmentPaths: Array<{ id: string; relativePath: string }> = []
    try {
      const marker = await readJson<unknown>(recoveryMarker)
      const relativePath =
        marker && typeof marker === 'object'
          ? (marker as Record<string, unknown>).relativePath
          : null
      if (typeof relativePath !== 'string') throw new Error('Invalid capture recovery marker.')
      destination = resolveInsideVault(libraryPath, relativePath)
      const attachmentPaths = (marker as Record<string, unknown>).attachmentPaths
      if (Array.isArray(attachmentPaths)) {
        recoveredAttachmentPaths = attachmentPaths.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return []
          const candidate = entry as Record<string, unknown>
          return typeof candidate.id === 'string' && typeof candidate.relativePath === 'string'
            ? [{ id: candidate.id, relativePath: candidate.relativePath }]
            : []
        })
      }
    } catch {
      const directory = await this.destinationDirectory(libraryPath, location, metadata.id)
      await mkdir(directory, { recursive: true })
      destination = await this.uniquePath(directory, filename)
      if (metadata.type === 'note') {
        recoveredAttachmentPaths = await mapWithConcurrency(
          metadata.attachments ?? [],
          1,
          async (attachment) => {
            const placement = resolveAttachmentPlacement({
              libraryPath,
              notePath: destination,
              filename: attachment.filename
            })
            const attachmentPath = await this.uniquePath(placement.directory, attachment.filename)
            return {
              id: attachment.id,
              relativePath: slash(relative(libraryPath, attachmentPath))
            }
          }
        )
      }
      await writeJsonAtomic(recoveryMarker, {
        schemaVersion: 2,
        relativePath: slash(relative(libraryPath, destination)),
        attachmentPaths: recoveredAttachmentPaths
      })
    }
    if (
      metadata.type === 'note' &&
      (metadata.attachments ?? []).some(
        (attachment) => !recoveredAttachmentPaths.some((entry) => entry.id === attachment.id)
      )
    ) {
      recoveredAttachmentPaths = await mapWithConcurrency(
        metadata.attachments ?? [],
        1,
        async (attachment) => {
          const placement = resolveAttachmentPlacement({
            libraryPath,
            notePath: destination,
            filename: attachment.filename
          })
          const attachmentPath = await this.uniquePath(placement.directory, attachment.filename)
          return {
            id: attachment.id,
            relativePath: slash(relative(libraryPath, attachmentPath))
          }
        }
      )
      await writeJsonAtomic(recoveryMarker, {
        schemaVersion: 2,
        relativePath: slash(relative(libraryPath, destination)),
        attachmentPaths: recoveredAttachmentPaths
      })
    }
    const temporary = kusuPath(libraryPath, 'temp', `${metadata.id}.capture`)
    const stagedContent = join(temporary, basename(destination))
    const destinationAlreadyFinalized = await this.pathExists(destination)
    if (!destinationAlreadyFinalized) {
      await mkdir(temporary, { recursive: true })
      await writeFile(stagedContent, content)
    }
    let attachments: PersistedNoteAttachment[] | undefined
    if (metadata.type === 'note' && metadata.attachments?.length) {
      attachments = []
      for (const attachment of metadata.attachments) {
        const file = files.find((entry) => basename(entry.filename) === attachment.filename)
        if (!file) throw new Error(`The attachment ${attachment.filename} is missing.`)
        const reserved = recoveredAttachmentPaths.find((entry) => entry.id === attachment.id)
        if (!reserved) throw new Error(`The attachment ${attachment.filename} has no destination.`)
        const attachmentPath = resolveInsideVault(libraryPath, reserved.relativePath)
        const relativePath = markdownPathForAttachment(destination, attachmentPath)
        attachments.push({ ...attachment, filename: basename(attachmentPath), relativePath })
        if (!(await this.pathExists(attachmentPath))) {
          const stagedAttachment = join(temporary, `${attachment.id}${extname(attachmentPath)}`)
          await writeFile(stagedAttachment, file.data)
          await rename(stagedAttachment, attachmentPath)
        }
        const bytes = Buffer.from(file.data)
        const detected = detectImage(bytes)
        if (!detected) throw new Error(`The attachment ${attachment.filename} is invalid.`)
        const imageMetadata = {
          ...createImageMetadata(
            attachment.id,
            attachment.sourceFilename ?? basename(attachmentPath),
            detected,
            metadata.createdAt
          ),
          relativePath: reserved.relativePath,
          referencedAttachment: true,
          attachmentOrigin: 'note-capture'
        } satisfies PersistedImageItem
        await this.writeItemRecord(libraryPath, {
          schemaVersion: 2,
          id: attachment.id,
          relativePath: reserved.relativePath,
          fingerprint: await this.fingerprint(attachmentPath),
          fileIdentity: await this.fileIdentity(attachmentPath),
          recovery: { lastSeenAt: new Date().toISOString(), missingSince: null },
          metadata: imageMetadata
        })
      }
      if (!destinationAlreadyFinalized) {
        let markdown = await readFile(stagedContent, 'utf8')
        const replacements = new Map<string, string>()
        for (let index = 0; index < metadata.attachments.length; index += 1) {
          for (const alias of stagedAttachmentAliases(metadata.attachments[index])) {
            replacements.set(alias, encodeMarkdownImageTarget(attachments[index].relativePath))
          }
        }
        markdown = rewriteMarkdownImageDestinations(
          markdown,
          (reference) => replacements.get(markdownImageTargetKey(reference.destination)) ?? null
        )
        await writeFile(stagedContent, markdown, 'utf8')
      }
    }
    if (!destinationAlreadyFinalized) {
      this.markAppOwnedPath(libraryPath, destination)
      await rename(stagedContent, destination)
    }
    await rm(temporary, { recursive: true, force: true })
    const relativePath = slash(relative(libraryPath, destination))
    const nextMetadata = {
      ...metadata,
      schemaVersion: 2,
      title: titleFromPath(relativePath),
      contentFilename: metadata.type === 'url' ? null : basename(destination),
      relativePath,
      ...(metadata.type === 'note' && attachments ? { attachments } : {})
    } as PersistedItem
    await this.writeItemRecord(libraryPath, {
      schemaVersion: 2,
      id: metadata.id,
      relativePath,
      fingerprint: await this.fingerprint(destination),
      fileIdentity: await this.fileIdentity(destination),
      recovery: { lastSeenAt: new Date().toISOString(), missingSince: null },
      metadata: nextMetadata
    })
    await rm(recoveryMarker, { force: true })
  }

  async importVaultFile(
    libraryPath: string,
    input: {
      id: string
      filename: string
      mediaType: string
      bytes: Uint8Array
      timestamp: string
    },
    location: ActiveItemLocation = { type: 'inbox' }
  ): Promise<FileItemDto> {
    await this.readPersistedLibrary(libraryPath)
    const extension = extname(input.filename)
    const safeFilename = `${safeStem(basename(input.filename, extension), 'Imported file')}${extension}`
    const recoveryMarker = kusuPath(libraryPath, 'temp', `${input.id}.file-import-recovery.json`)
    let destination: string
    try {
      const marker = await readJson<unknown>(recoveryMarker)
      const markedRelativePath =
        marker && typeof marker === 'object'
          ? (marker as Record<string, unknown>).relativePath
          : null
      if (typeof markedRelativePath !== 'string') {
        throw new Error('Invalid file recovery marker.')
      }
      destination = resolveInsideVault(libraryPath, markedRelativePath)
    } catch {
      const directory = await this.destinationDirectory(libraryPath, location, input.id)
      await mkdir(directory, { recursive: true })
      destination = await this.uniquePath(directory, safeFilename)
      await writeJsonAtomic(recoveryMarker, {
        schemaVersion: 1,
        relativePath: slash(relative(libraryPath, destination))
      })
    }
    const temporary = kusuPath(libraryPath, 'temp', `${input.id}.file-import`)
    if (!(await this.pathExists(destination))) {
      await writeFile(temporary, input.bytes)
      this.markAppOwnedPath(libraryPath, destination)
      await rename(temporary, destination)
    }
    const relativePath = slash(relative(libraryPath, destination))
    const metadata: PersistedFileItem = {
      schemaVersion: 2,
      id: input.id,
      type: 'file',
      title: titleFromPath(relativePath),
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
      sourceUrl: null,
      sourceFilename: input.filename,
      contentFilename: basename(destination),
      mediaType: input.mediaType || mimeForExtension(extension),
      size: input.bytes.byteLength,
      note: '',
      originalCollectionId: null,
      relativePath,
      referencedAttachment: false
    }
    await this.writeItemRecord(libraryPath, {
      schemaVersion: 2,
      id: input.id,
      relativePath,
      fingerprint: await this.fingerprint(destination),
      fileIdentity: await this.fileIdentity(destination),
      recovery: { lastSeenAt: new Date().toISOString(), missingSince: null },
      metadata
    })
    await rm(recoveryMarker, { force: true })
    const record = (await this.currentItemRecords(libraryPath)).find(
      (item) => item.id === metadata.id
    )
    const saved = record
      ? await this.recordToDto(
          libraryPath,
          record,
          await this.currentCollectionRecords(libraryPath)
        )
      : null
    if (!saved || saved.type !== 'file') throw new Error('The imported file could not be reopened.')
    return saved
  }

  async resolveItem(libraryPath: string, itemId: string): Promise<ResolvedLibraryItem> {
    if (!ITEM_ID_PATTERN.test(itemId)) throw new Error('The item identifier is invalid.')
    const snapshot = this.scanSnapshots.get(resolve(libraryPath))
    const record = snapshot
      ? snapshot.records.find((entry) => entry.id === itemId)
      : await this.readItemRecord(this.itemRecordPath(libraryPath, itemId), itemId)
    if (!record) throw new Error('The saved item no longer exists.')
    const collections = await this.currentCollectionRecords(libraryPath)
    const path = resolveInsideVault(libraryPath, record.relativePath)
    return {
      directory: dirname(path),
      path,
      relativePath: record.relativePath,
      location: this.locationForPath(record.relativePath, collections, record.metadata),
      metadata: { ...record.metadata, relativePath: record.relativePath }
    }
  }

  async readPersistedItem(libraryPath: string, itemId: string): Promise<PersistedItem> {
    return (await this.resolveItem(libraryPath, itemId)).metadata
  }

  async updateItem(libraryPath: string, item: PersistedItem): Promise<void> {
    try {
      await runVaultTransaction(libraryPath, (transaction) =>
        this.updateItemInTransaction(libraryPath, item, transaction)
      )
    } catch (error) {
      this.scanSnapshots.delete(resolve(libraryPath))
      throw error
    }
  }

  private async updateItemInTransaction(
    libraryPath: string,
    item: PersistedItem,
    transaction: VaultTransaction
  ): Promise<void> {
    const resolved = await this.resolveItem(libraryPath, item.id)
    let path = resolved.path
    if (item.title !== resolved.metadata.title && resolved.location.type !== 'trash') {
      const extension = extname(path) || (item.type === 'url' ? MARKDOWN_EXTENSION : '')
      const destination = await this.uniquePath(
        dirname(path),
        `${safeStem(item.title)}${extension}`
      )
      this.markAppOwnedPath(libraryPath, path)
      this.markAppOwnedPath(libraryPath, destination)
      await transaction.rename(path, destination)
      if (resolved.metadata.type === 'note') {
        const oldAssets = join(dirname(path), `${basename(path, MARKDOWN_EXTENSION)}.assets`)
        const newAssets = join(
          dirname(destination),
          `${basename(destination, MARKDOWN_EXTENSION)}.assets`
        )
        const movedLegacyAssets =
          (await this.pathExists(oldAssets)) && !(await this.pathExists(newAssets))
        if (movedLegacyAssets) {
          await transaction.rename(oldAssets, newAssets)
        }
        const source = await readFile(destination, 'utf8')
        const replacements = new Map<string, string>()
        const references = extractVaultReferenceTargets(source)
        const availablePaths =
          references.length > 0
            ? await this.dtoBuildContextFromRecords(
                libraryPath,
                await this.currentItemRecords(libraryPath)
              ).availablePaths()
            : []
        for (const reference of references) {
          const previousTarget = resolveVaultReferencePath(reference, path, libraryPath, [
            ...availablePaths,
            oldAssets
          ])
          const nextTarget =
            movedLegacyAssets && previousTarget.startsWith(`${oldAssets}${sep}`)
              ? join(newAssets, relative(oldAssets, previousTarget))
              : previousTarget
          replacements.set(previousTarget, nextTarget)
        }
        const rewritten = rewriteVaultReferences(
          source,
          path,
          destination,
          libraryPath,
          replacements
        )
        if (rewritten !== source) await transaction.writeText(destination, rewritten)
      } else if (resolved.metadata.type === 'image' || resolved.metadata.type === 'file') {
        await this.rewriteInboundReferences(
          libraryPath,
          new Map([[path, destination]]),
          transaction
        )
      }
      path = destination
    }
    const relativePath = slash(relative(libraryPath, path))
    const existing = (await this.currentItemRecords(libraryPath)).find(
      (entry) => entry.id === item.id
    )
    await this.writeItemRecord(
      libraryPath,
      {
        schemaVersion: 2,
        id: item.id,
        relativePath,
        fingerprint: (await this.pathExists(path))
          ? await this.fingerprint(path)
          : (existing?.fingerprint ?? null),
        fileIdentity: (await this.pathExists(path))
          ? await this.fileIdentity(path)
          : (existing?.fileIdentity ?? null),
        recovery: { lastSeenAt: new Date().toISOString(), missingSince: null },
        metadata: {
          ...item,
          schemaVersion: 2,
          title: titleFromPath(relativePath),
          contentFilename: item.type === 'url' ? null : basename(path),
          relativePath
        } as PersistedItem
      },
      transaction
    )
  }

  async importNoteImage(
    libraryPath: string,
    itemId: string,
    input: {
      id: string
      filename: string
      sourceFilename: string | null
      bytes: Uint8Array
      mediaType: NoteAttachmentDto['mediaType']
      width: number
      height: number
      timestamp: string
    }
  ): Promise<NoteAttachmentDto> {
    const note = await this.resolveItem(libraryPath, itemId)
    if (note.metadata.type !== 'note') throw new Error('The saved item is not a note.')
    const destination = await this.uniquePath(note.directory, input.filename)
    await writeFile(destination, input.bytes, { flag: 'wx' })
    const relativePath = slash(relative(libraryPath, destination))
    const metadata = {
      ...createImageMetadata(
        input.id,
        input.sourceFilename ?? basename(destination),
        { mediaType: input.mediaType, width: input.width, height: input.height },
        input.timestamp
      ),
      title: titleFromPath(relativePath),
      contentFilename: basename(destination),
      relativePath,
      referencedAttachment: true,
      attachmentOrigin: 'note-capture'
    } satisfies PersistedImageItem
    try {
      await this.writeItemRecord(libraryPath, {
        schemaVersion: 2,
        id: input.id,
        relativePath,
        fingerprint: await this.fingerprint(destination),
        fileIdentity: await this.fileIdentity(destination),
        recovery: { lastSeenAt: input.timestamp, missingSince: null },
        metadata
      })
    } catch (error) {
      await rm(destination, { force: true })
      throw error
    }
    return {
      id: input.id,
      filename: basename(destination),
      relativePath: markdownPathForAttachment(note.path, destination),
      sourceFilename: input.sourceFilename,
      mediaType: input.mediaType,
      width: input.width,
      height: input.height,
      missingContent: false
    }
  }

  async updateNote(
    libraryPath: string,
    metadata: PersistedNoteItem,
    markdown: string
  ): Promise<void> {
    const resolved = await this.resolveItem(libraryPath, metadata.id)
    if (resolved.metadata.type !== 'note') throw new Error('The saved item is not a note.')
    this.markAppOwnedPath(libraryPath, resolved.path)
    await replaceNoteContent(resolved.path, kusuPath(libraryPath, 'temp'), markdown)
    await this.updateItem(libraryPath, { ...metadata, relativePath: resolved.relativePath })
  }

  async readNoteAttachment(
    libraryPath: string,
    itemId: string,
    attachmentId: string
  ): Promise<{ attachment: PersistedNoteAttachment; bytes: Buffer }> {
    const item = await this.resolveItem(libraryPath, itemId)
    if (item.metadata.type !== 'note') throw new Error('The saved item is not a note.')
    const source = await readFile(item.path, 'utf8')
    const attachments = await this.noteAttachments(
      libraryPath,
      {
        schemaVersion: 2,
        id: itemId,
        relativePath: item.relativePath,
        fingerprint: null,
        metadata: item.metadata
      },
      source
    )
    const attachment = attachments.find((entry) => entry.id === attachmentId)
    if (!attachment) throw new Error('The note attachment no longer exists.')
    const path = resolve(dirname(item.path), attachment.relativePath)
    return { attachment, bytes: await readFile(path) }
  }

  async getItemContentPath(libraryPath: string, itemId: string): Promise<string> {
    const item = await this.resolveItem(libraryPath, itemId)
    if (item.metadata.type === 'url') return item.path
    return item.path
  }

  async getItemRevealPath(libraryPath: string, itemId: string): Promise<string> {
    const item = await this.resolveItem(libraryPath, itemId)
    return (await this.pathExists(item.path)) ? item.path : this.itemRecordPath(libraryPath, itemId)
  }

  async readItemContent(libraryPath: string, metadata: PersistedItem): Promise<Buffer> {
    const item = await this.resolveItem(libraryPath, metadata.id)
    return readFile(item.path)
  }

  private urlPreviewDirectory(libraryPath: string, itemId: string): string {
    return kusuPath(libraryPath, URL_PREVIEW_DIRECTORY, itemId)
  }

  async readImageThumbnailCache(
    libraryPath: string,
    itemId: string,
    sourceKey: string
  ): Promise<Buffer | null> {
    try {
      const directory = this.urlPreviewDirectory(libraryPath, itemId)
      const metadata = await readJson<{ sourceKey: string }>(join(directory, 'image-card.json'))
      if (metadata.sourceKey !== sourceKey) return null
      return await readFile(join(directory, 'image-card.png'))
    } catch {
      return null
    }
  }

  async writeImageThumbnailCache(
    libraryPath: string,
    itemId: string,
    sourceKey: string,
    bytes: Uint8Array
  ): Promise<void> {
    const directory = this.urlPreviewDirectory(libraryPath, itemId)
    await mkdir(directory, { recursive: true })
    const temporary = join(directory, `image-card.${randomUUID()}.pending`)
    const destination = join(directory, 'image-card.png')
    await writeFile(temporary, bytes)
    await rm(destination, { force: true })
    await rename(temporary, destination)
    await writeJsonAtomic(join(directory, 'image-card.json'), { sourceKey })
  }

  async readUrlPreviewCache(
    libraryPath: string,
    itemId: string,
    kind: UrlPreviewKind
  ): Promise<{ bytes: Buffer; mediaType: UrlPreviewMediaType } | null> {
    const directory = this.urlPreviewDirectory(libraryPath, itemId)
    for (const [mediaType, extension] of Object.entries(URL_PREVIEW_EXTENSIONS) as Array<
      [UrlPreviewMediaType, string]
    >) {
      const path = join(directory, `${kind}.${extension}`)
      if (await this.pathExists(path)) return { bytes: await readFile(path), mediaType }
    }
    return null
  }

  async writeUrlPreviewCache(
    libraryPath: string,
    itemId: string,
    kind: UrlPreviewKind,
    extension: string,
    bytes: Uint8Array
  ): Promise<void> {
    const directory = this.urlPreviewDirectory(libraryPath, itemId)
    await mkdir(directory, { recursive: true })
    await this.removeUrlPreviewCache(libraryPath, itemId, kind)
    const temporary = join(directory, `${kind}.${randomUUID()}.pending`)
    await writeFile(temporary, bytes)
    await rename(temporary, join(directory, `${kind}.${extension}`))
  }

  async removeUrlPreviewCache(
    libraryPath: string,
    itemId: string,
    kind?: UrlPreviewKind
  ): Promise<void> {
    const directory = this.urlPreviewDirectory(libraryPath, itemId)
    if (!kind) return rm(directory, { recursive: true, force: true })
    for (const extension of Object.keys(URL_PREVIEW_EXTENSIONS)) {
      await rm(join(directory, `${kind}.${extension}`), { force: true })
    }
  }

  async collectionExists(libraryPath: string, collectionId: string): Promise<boolean> {
    return (await this.readCollectionRecords(libraryPath)).some(
      (entry) => entry.id === collectionId
    )
  }

  private async destinationDirectory(
    libraryPath: string,
    location: ItemLocation,
    itemId: string
  ): Promise<string> {
    if (location.type === 'inbox') return libraryPath
    if (location.type === 'archive')
      return resolveInsideVault(libraryPath, DEFAULT_ARCHIVE_DIRECTORY)
    if (location.type === 'trash') return kusuPath(libraryPath, TRASH_DIRECTORY, itemId)
    const collection = (await this.currentCollectionRecords(libraryPath)).find(
      (entry) => entry.id === location.collectionId
    )
    if (!collection) throw new Error('The destination folder no longer exists.')
    return resolveInsideVault(libraryPath, collection.relativePath)
  }

  async moveItems(libraryPath: string, requests: ItemMoveRequest[]): Promise<void> {
    try {
      await runVaultTransaction(libraryPath, (transaction) =>
        this.moveItemsInTransaction(libraryPath, requests, transaction)
      )
    } catch (error) {
      this.scanSnapshots.delete(resolve(libraryPath))
      throw error
    }
  }

  private async moveItemsInTransaction(
    libraryPath: string,
    requests: ItemMoveRequest[],
    transaction: VaultTransaction
  ): Promise<void> {
    if (requests.length === 0) return
    const stagingDirectory = kusuPath(libraryPath, 'temp', `${randomUUID()}.item-move`)
    await mkdir(stagingDirectory, { recursive: true })
    const staged: Array<{
      request: ItemMoveRequest
      file: string
      assets: string | null
      original: string
      originalAssets: string | null
      missingSource: boolean
    }> = []
    for (const request of requests) {
      const missingSource = !(await this.pathExists(request.item.path))
      if (missingSource && request.destination.type !== 'trash') {
        throw new Error(
          "The item's file is missing from the library, so it cannot be moved or archived. Move it to Trash to remove it."
        )
      }
      const stagedFile = join(
        stagingDirectory,
        `${request.item.metadata.id}${extname(request.item.path)}`
      )
      let stagedAssets: string | null = null
      let originalAssets: string | null = null
      if (!missingSource) {
        this.markAppOwnedPath(libraryPath, request.item.path)
        await transaction.rename(request.item.path, stagedFile)
        if (request.item.metadata.type === 'note') {
          originalAssets = join(
            dirname(request.item.path),
            `${basename(request.item.path, MARKDOWN_EXTENSION)}.assets`
          )
          if (await this.pathExists(originalAssets)) {
            stagedAssets = join(stagingDirectory, `${request.item.metadata.id}.assets`)
            await transaction.rename(originalAssets, stagedAssets)
          }
        }
      }
      staged.push({
        request,
        file: stagedFile,
        assets: stagedAssets,
        original: request.item.path,
        originalAssets,
        missingSource
      })
    }
    const referenceReplacements = new Map<string, string>()
    for (const entry of staged) {
      const directory = await this.destinationDirectory(
        libraryPath,
        entry.request.destination,
        entry.request.item.metadata.id
      )
      this.markAppOwnedPath(libraryPath, directory)
      await mkdir(directory, { recursive: true })
      const destination = await this.uniquePath(directory, basename(entry.original))
      this.markAppOwnedPath(libraryPath, destination)
      if (!entry.missingSource) await transaction.rename(entry.file, destination)
      let legacyAssetDestination: string | null = null
      if (entry.assets) {
        const assetDestination = join(
          directory,
          `${basename(destination, MARKDOWN_EXTENSION)}.assets`
        )
        await transaction.rename(entry.assets, assetDestination)
        legacyAssetDestination = assetDestination
      }
      let nextRequestMetadata = entry.request.metadata
      if (!entry.missingSource && entry.request.item.metadata.type === 'note') {
        const source = await readFile(destination, 'utf8')
        const replacements = new Map<string, string>()
        const references = extractVaultReferenceTargets(source)
        const availablePaths =
          references.length > 0
            ? await this.dtoBuildContextFromRecords(
                libraryPath,
                await this.currentItemRecords(libraryPath)
              ).availablePaths()
            : []
        for (const reference of references) {
          const previousTarget = resolveVaultReferencePath(reference, entry.original, libraryPath, [
            ...availablePaths,
            entry.originalAssets ?? entry.original
          ])
          const nextTarget =
            entry.originalAssets &&
            legacyAssetDestination &&
            previousTarget.startsWith(`${entry.originalAssets}${sep}`)
              ? join(legacyAssetDestination, relative(entry.originalAssets, previousTarget))
              : previousTarget
          replacements.set(previousTarget, nextTarget)
        }
        const rewritten = rewriteVaultReferences(
          source,
          entry.original,
          destination,
          libraryPath,
          replacements
        )
        if (rewritten !== source) await transaction.writeText(destination, rewritten)
        if (nextRequestMetadata.type === 'note' && nextRequestMetadata.attachments) {
          nextRequestMetadata = {
            ...nextRequestMetadata,
            attachments: nextRequestMetadata.attachments.map((attachment) => {
              const previousTarget = resolve(dirname(entry.original), attachment.relativePath)
              const nextTarget = replacements.get(previousTarget) ?? previousTarget
              return {
                ...attachment,
                relativePath: markdownPathForAttachment(destination, nextTarget)
              }
            })
          }
        }
      } else if (
        !entry.missingSource &&
        entry.request.destination.type !== 'trash' &&
        (entry.request.item.metadata.type === 'image' ||
          entry.request.item.metadata.type === 'file')
      ) {
        const previousPath = entry.request.item.metadata.trashedFromRelativePath
          ? resolveInsideVault(libraryPath, entry.request.item.metadata.trashedFromRelativePath)
          : entry.original
        referenceReplacements.set(previousPath, destination)
      }
      const relativePath = slash(relative(libraryPath, destination))
      const record = (await this.currentItemRecords(libraryPath)).find(
        (item) => item.id === entry.request.item.metadata.id
      )
      await this.writeItemRecord(
        libraryPath,
        {
          schemaVersion: 2,
          id: entry.request.item.metadata.id,
          relativePath,
          fingerprint: record?.fingerprint ?? null,
          ...(entry.missingSource && record?.recovery ? { recovery: record.recovery } : {}),
          metadata: {
            ...nextRequestMetadata,
            schemaVersion: 2,
            relativePath,
            contentFilename: nextRequestMetadata.type === 'url' ? null : basename(destination)
          } as PersistedItem
        },
        transaction
      )
    }
    await this.rewriteInboundReferences(libraryPath, referenceReplacements, transaction)
    await rm(stagingDirectory, { recursive: true, force: true })
  }

  async permanentlyDeleteItems(libraryPath: string, itemIds: string[]): Promise<void> {
    for (const itemId of itemIds) {
      const item = await this.resolveItem(libraryPath, itemId)
      if (item.location.type !== 'trash')
        throw new Error('Only items in Trash can be deleted forever.')
      const trashRoot = kusuPath(libraryPath, TRASH_DIRECTORY, itemId)
      await rm(trashRoot, { recursive: true, force: true })
      await rm(this.itemRecordPath(libraryPath, itemId), { force: true })
      const snapshot = this.scanSnapshots.get(resolve(libraryPath))
      if (snapshot) snapshot.records = snapshot.records.filter((record) => record.id !== itemId)
    }
  }

  async inspectItemDeletion(
    libraryPath: string,
    itemIds: string[],
    mode: 'trash' | 'permanent'
  ): Promise<ItemDeletionInspectionDto> {
    const library = await this.buildLibraryDtoFromRecords(libraryPath)
    const selected = new Set(itemIds)
    const selectedItems = library.items.filter((item) => selected.has(item.id))
    const notes = library.items.filter((item) => item.type === 'note')
    const references = new Map<string, Array<{ id: string; title: string }>>()
    for (const note of notes) {
      for (const attachment of note.attachments) {
        const entries = references.get(attachment.id) ?? []
        if (!entries.some((entry) => entry.id === note.id))
          entries.push({ id: note.id, title: note.title })
        references.set(attachment.id, entries)
      }
    }
    const referencedItems = selectedItems.flatMap((item) => {
      if (item.type !== 'image' && item.type !== 'file') return []
      const noteReferences = references.get(item.id) ?? []
      return noteReferences.length > 0
        ? [
            {
              itemId: item.id,
              title: item.title,
              noteTitles: noteReferences.slice(0, 5).map((entry) => entry.title),
              referenceCount: noteReferences.length
            }
          ]
        : []
    })
    const cleanupIds = new Set<string>()
    if (mode === 'permanent') {
      for (const note of selectedItems) {
        if (note.type !== 'note') continue
        for (const attachment of note.attachments) {
          const remaining = (references.get(attachment.id) ?? []).some(
            (entry) => !selected.has(entry.id)
          )
          if (!remaining) cleanupIds.add(attachment.id)
        }
      }
    }
    const cleanupCandidates = library.items.flatMap((item) =>
      cleanupIds.has(item.id) && item.type === 'image' && item.location.type !== 'trash'
        ? [{ itemId: item.id, title: item.title }]
        : []
    )
    const revisionPayload = JSON.stringify({
      mode,
      selected: [...selected].sort(),
      referencedItems,
      cleanupCandidates,
      notes: notes
        .map((note) => ({ id: note.id, updatedAt: note.updatedAt }))
        .sort((a, b) => a.id.localeCompare(b.id))
    })
    return {
      revision: createHash('sha256').update(revisionPayload).digest('hex'),
      referencedItems,
      cleanupCandidates
    }
  }
}
