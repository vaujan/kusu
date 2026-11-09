import { join } from 'node:path'
import type { LibraryItemDto } from '../shared/library-contract'

const SEARCH_CACHE_IDLE_MS = 15_000

interface SearchDocument {
  id: string
  title: string
  supporting: string
}

interface NativeIndex {
  clear(): void
  synchronize(updates: SearchDocument[], ids: string[]): void
  query(query: string, terms: string[]): Promise<string[]>
}

// Both src/main (tests) and out/main (Electron) are two levels below the app root.
// resources is unpacked by electron-builder so Node can load the native library.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SearchIndex } = require(
  join(
    __dirname,
    '../../resources/native',
    `${process.platform}-${process.arch}`,
    'kusu-search.node'
  )
) as { SearchIndex: new () => NativeIndex }

export class NativeSearch {
  private index: NativeIndex | null = null
  private indexedItems = new Map<string, WeakRef<LibraryItemDto>>()
  private indexedSnapshot: WeakRef<LibraryItemDto[]> | null = null
  private idleTimer: NodeJS.Timeout | undefined

  clear(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    this.index?.clear()
    this.index = null
    this.indexedItems.clear()
    this.indexedSnapshot = null
  }

  query(items: LibraryItemDto[], query: string): Promise<string[]> {
    if (this.idleTimer) this.idleTimer.refresh()
    else this.idleTimer = setTimeout(() => this.clear(), SEARCH_CACHE_IDLE_MS).unref()
    const terms = query.split(/\s+/)
    if (this.index && this.indexedSnapshot?.deref() === items) {
      return this.index.query(query, terms)
    }
    const updates: SearchDocument[] = []
    const next = new Map<string, WeakRef<LibraryItemDto>>()
    for (const item of items) {
      const previous = this.indexedItems.get(item.id)
      if (previous?.deref() === item) {
        next.set(item.id, previous)
        continue
      }
      next.set(item.id, new WeakRef(item))
      updates.push({
        id: item.id,
        title: item.title.toLocaleLowerCase(),
        supporting: (item.type === 'note'
          ? item.body
          : item.type === 'image'
            ? (item.sourceFilename ?? item.contentFilename)
            : item.type === 'file'
              ? `${item.sourceFilename} ${item.contentFilename}`
              : `${item.domain} ${item.sourceUrl} ${item.description ?? ''}`
        ).toLocaleLowerCase()
      })
    }
    this.index ??= new SearchIndex()
    this.index.synchronize(
      updates,
      items.map((item) => item.id)
    )
    this.indexedItems = next
    this.indexedSnapshot = new WeakRef(items)
    return this.index.query(query, terms)
  }
}
