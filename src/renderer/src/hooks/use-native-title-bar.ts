import { useSyncExternalStore } from 'react'

const subscribe = (): (() => void) => () => {}
const getIntegrated = (): boolean => false

export function useNativeTitleBar(): boolean {
  const titleBar = window.electron.window.titleBar
  return useSyncExternalStore(
    titleBar?.subscribe ?? subscribe,
    titleBar?.getNative ?? getIntegrated
  )
}
