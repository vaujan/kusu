export const WINDOW_CHANNELS = {
  devAction: 'window:dev-action',
  minimize: 'window:minimize',
  toggleMaximize: 'window:toggle-maximize',
  close: 'window:close',
  isMaximized: 'window:is-maximized',
  maximizedChanged: 'window:maximized-changed',
  setZoomFactor: 'window:set-zoom-factor',
  setNativeThemeSource: 'window:set-native-theme-source',
  setTranslucentBackground: 'window:set-translucent-background',
  reducedTransparencyChanged: 'window:reduced-transparency-changed',
  zoomShortcut: 'window:zoom-shortcut',
  edit: 'window:edit',
  getSpellingLanguages: 'window:get-spelling-languages',
  setSpellingLanguages: 'window:set-spelling-languages',
  spellingLanguagesChanged: 'window:spelling-languages-changed',
  textContextMenu: 'window:text-context-menu',
  textContextMenuAction: 'window:text-context-menu-action',
  getGlobalCaptureShortcutStatus: 'window:get-global-capture-shortcut-status',
  setGlobalCaptureShortcut: 'window:set-global-capture-shortcut',
  globalCaptureRequested: 'window:global-capture-requested',
  openSettingsWindow: 'window:open-settings-window',
  openNoteWindow: 'window:open-note-window',
  noteWindowCloseRequested: 'window:note-window-close-requested',
  resolveNoteWindowClose: 'window:resolve-note-window-close'
} as const

export const APP_ZOOM_FACTORS = [0.8, 0.9, 1, 1.1, 1.2, 1.25] as const
export type AppZoomShortcut = 'in' | 'out' | 'reset'
export type EditCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'
export type NativeThemeSource = 'dark' | 'light' | 'system'
export const TRANSLUCENT_BACKGROUND_STORAGE_KEY = 'kusu-translucent-background:v1'

export function resolveTranslucentBackgroundPreference(storedValue: string | null): boolean {
  return storedValue !== 'false'
}

export function parseNativeThemeSource(value: unknown): NativeThemeSource {
  if (value === 'dark' || value === 'light' || value === 'system') return value
  throw new Error('Unsupported native theme source.')
}

export interface GlobalCaptureShortcutStatus {
  accelerator: string
  registered: boolean
}

export interface TranslucentBackgroundStatus {
  supported: boolean
  enabled: boolean
  reducedTransparency: boolean
}

export interface SpellingLanguagesStatus {
  available: string[]
  selected: string[]
  managedBySystem: boolean
}

export interface TextContextMenuDetails {
  x: number
  y: number
  misspelledWord: string
  suggestions: string[]
  editFlags: {
    canUndo: boolean
    canRedo: boolean
    canCut: boolean
    canCopy: boolean
    canPaste: boolean
    canSelectAll: boolean
  }
}

export type TextContextMenuAction =
  | { kind: 'replace'; text: string }
  | { kind: 'addToDictionary'; text: string }
  | { kind: 'edit'; command: EditCommand }

export type DesktopPlatform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd'

export interface ElectronWindowApi {
  devAction?: (action: 'reset-onboarding' | 'devtools') => Promise<boolean>
  platform: DesktopPlatform
  titleBar?: {
    getNative: () => boolean
    subscribe: (listener: () => void) => () => void
    setNative: (native: boolean) => Promise<void>
  }
  minimize: () => void
  toggleMaximize: () => void
  close: () => void
  isMaximized: () => Promise<boolean>
  onMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void
  setZoomFactor: (zoomFactor: number) => Promise<number>
  setNativeThemeSource: (source: NativeThemeSource) => void
  setTranslucentBackground: (enabled: boolean) => Promise<TranslucentBackgroundStatus>
  onReducedTransparencyChange: (callback: (reduced: boolean) => void) => () => void
  onZoomShortcut: (callback: (shortcut: AppZoomShortcut) => void) => () => void
  edit: (command: EditCommand) => void
  getSpellingLanguages: () => Promise<SpellingLanguagesStatus>
  setSpellingLanguages: (languages: string[]) => Promise<SpellingLanguagesStatus>
  onSpellingLanguagesChanged: (callback: (status: SpellingLanguagesStatus) => void) => () => void
  onTextContextMenu: (callback: (details: TextContextMenuDetails) => void) => () => void
  textContextMenuAction: (action: TextContextMenuAction) => void
  getGlobalCaptureShortcutStatus: () => Promise<GlobalCaptureShortcutStatus>
  setGlobalCaptureShortcut: (accelerator: string) => Promise<GlobalCaptureShortcutStatus>
  onGlobalCaptureRequested: (callback: () => void) => () => void
  openSettingsWindow: () => Promise<void>
  openNoteWindow: (itemId: string) => Promise<void>
  onNoteWindowCloseRequested: (callback: () => void) => () => void
  resolveNoteWindowClose: (approved: boolean) => void
}
