import type { LibraryItemDto } from './library-contract'

export function createLibrarySearch(): (
  items: readonly LibraryItemDto[],
  query: string
) => string[] {
  const searchDocuments = new WeakMap<
    LibraryItemDto,
    { title: string; supporting: string; searchable: string }
  >()

  return (items, input) => {
    const query = input.trim().toLocaleLowerCase()
    if (!query) return items.map((item) => item.id)
    const queryTerms = query.split(/\s+/)
    return items
      .map((item, index) => {
        let document = searchDocuments.get(item)
        if (!document) {
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
          document = { title, supporting, searchable: `${title} ${supporting}` }
          searchDocuments.set(item, document)
        }
        const { title, supporting, searchable } = document
        if (!queryTerms.every((term) => searchable.includes(term))) return null

        const score =
          title === query
            ? 0
            : title.startsWith(query)
              ? 1
              : title.includes(query)
                ? 2
                : queryTerms.every((term) => title.includes(term))
                  ? 3
                  : supporting.includes(query)
                    ? 4
                    : 5
        return { id: item.id, index, score }
      })
      .filter((match): match is { id: string; index: number; score: number } => match !== null)
      .sort((left, right) => left.score - right.score || left.index - right.index)
      .map((match) => match.id)
  }
}
