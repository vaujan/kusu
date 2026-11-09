import { useEffect, useState } from 'react'

import type { NoteAttachmentDto } from '../../../../shared/library-contract'
import { acquirePreview } from '@/features/items/preview-cache'

export function useNoteAttachmentPreviews(
  itemId: string,
  attachments: NoteAttachmentDto[],
  enabled = true
): Record<string, string> {
  const [state, setState] = useState<{ itemId: string; previews: Record<string, string> }>({
    itemId: '',
    previews: {}
  })

  useEffect(() => {
    if (!enabled) return
    const available = attachments.filter((attachment) => !attachment.missingContent)
    if (available.length === 0) return

    let active = true
    const releases: Array<() => void> = []
    void Promise.allSettled(
      available.map(async (attachment) => {
        const lease = await acquirePreview(`attachment:${itemId}:${attachment.id}`, async () => {
          const result = await window.kusu.getNoteAttachmentPreview(itemId, attachment.id)
          if (!result.ok) throw new Error(result.error)
          return result.data
        })
        if (!active) {
          lease.release()
          return null
        }
        releases.push(lease.release)
        return [attachment.id, lease.url] as const
      })
    ).then((entries) => {
      if (!active) return
      setState({
        itemId,
        previews: Object.fromEntries(
          entries.flatMap((entry) =>
            entry.status === 'fulfilled' && entry.value ? [entry.value] : []
          )
        )
      })
    })

    return () => {
      active = false
      releases.forEach((release) => release())
    }
  }, [attachments, enabled, itemId])

  return enabled &&
    attachments.some((attachment) => !attachment.missingContent) &&
    state.itemId === itemId
    ? state.previews
    : {}
}
