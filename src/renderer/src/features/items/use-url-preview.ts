import { useEffect, useState } from 'react'

import type { UrlPreviewKind } from '../../../../shared/library-contract'
import { acquirePreview } from '@/features/items/preview-cache'

interface UrlPreviewState {
  key: string
  preview: string | null
  loading: boolean
  error: string
}

export function useUrlPreview(
  itemId: string,
  kind: UrlPreviewKind,
  available: boolean
): { preview: string | null; loading: boolean; error: string } {
  const key = `${itemId}:${kind}`
  const [state, setState] = useState<UrlPreviewState>({
    key,
    preview: null,
    loading: available,
    error: ''
  })

  useEffect(() => {
    if (!available) return
    let active = true
    let release: (() => void) | null = null
    void acquirePreview(`url:${key}`, async () => {
      const result = await window.kusu.getUrlPreview(itemId, kind)
      if (!result.ok) throw new Error(result.error)
      return result.data
    }).then(
      (lease) => {
        if (!active) return lease.release()
        release = lease.release
        setState({ key, preview: lease.url, loading: false, error: '' })
      },
      (error: unknown) => {
        if (active)
          setState({
            key,
            preview: null,
            loading: false,
            error: error instanceof Error ? error.message : 'Preview unavailable'
          })
      }
    )
    return () => {
      active = false
      release?.()
    }
  }, [available, itemId, key, kind])

  return available && state.key === key
    ? { preview: state.preview, loading: state.loading, error: state.error }
    : { preview: null, loading: available, error: '' }
}
