import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  applyTheme,
  applyControlStyle,
  DEFAULT_TYPOGRAPHY,
  resolveBaseFontSize,
  resolveAppliedTheme,
  resolveColorMode,
  resolveColorTheme,
  resolveControlStyle,
  resolveFontPreference
} from './hooks/theme'
import { initializeTranslucentBackground } from './hooks/use-translucent-background'
import { SettingsProvider } from './settings/settings-context'
import {
  resolveTranslucentBackgroundPreference,
  TRANSLUCENT_BACKGROUND_STORAGE_KEY
} from '../../shared/window-contract'

import { resolveBackgroundOpacity } from './settings/settings-schema'

document.documentElement.style.setProperty(
  '--window-background-opacity',
  `${resolveBackgroundOpacity(localStorage.getItem('kusu-background-opacity'))}%`
)

document.documentElement.dataset.platform = window.electron.window.platform

performance.mark('kusu:renderer-entry')
window.electron.window.onTextContextMenu((details) => {
  void import('./features/shell/text-context-menu').then(({ openTextContextMenu }) => {
    openTextContextMenu(details)
  })
})

const initialColorMode = resolveColorMode(localStorage.getItem('kusu-color-mode'))
applyControlStyle(resolveControlStyle(localStorage.getItem('kusu-control-style')))
window.electron.window.setNativeThemeSource(initialColorMode)
applyTheme(
  resolveAppliedTheme(initialColorMode),
  resolveColorTheme(localStorage.getItem('kusu-color-theme')),
  {
    uiFont: resolveFontPreference(localStorage.getItem('kusu-ui-font'), DEFAULT_TYPOGRAPHY.uiFont),
    uiFontFallback: DEFAULT_TYPOGRAPHY.uiFontFallback,
    contentFont: resolveFontPreference(
      localStorage.getItem('kusu-content-font'),
      DEFAULT_TYPOGRAPHY.contentFont
    ),
    contentFontFallback: DEFAULT_TYPOGRAPHY.contentFontFallback,
    codeFont: resolveFontPreference(
      localStorage.getItem('kusu-code-font'),
      DEFAULT_TYPOGRAPHY.codeFont
    ),
    codeFontFallback: DEFAULT_TYPOGRAPHY.codeFontFallback,
    sourceFontSize: resolveBaseFontSize(
      localStorage.getItem('kusu-markdown-source-font-size'),
      DEFAULT_TYPOGRAPHY.sourceFontSize
    ),
    contentFontSize: resolveBaseFontSize(
      localStorage.getItem('kusu-markdown-content-font-size'),
      DEFAULT_TYPOGRAPHY.contentFontSize
    )
  }
)
const searchParams = new URLSearchParams(window.location.search)
const surface = searchParams.get('surface')
const isQuickCapture = surface === 'quick-capture'
const isNoteWindow = surface === 'note-window'
const isSettingsWindow = surface === 'settings-window'
if (isQuickCapture) {
  document.documentElement.dataset.surface = 'quick-capture'
  const applyQuickCaptureMaterial = (): void => {
    const requested = resolveTranslucentBackgroundPreference(
      localStorage.getItem(TRANSLUCENT_BACKGROUND_STORAGE_KEY)
    )
    void window.electron.window.setTranslucentBackground(requested).then(
      (status) => {
        document.documentElement.dataset.quickCaptureMaterial = status.enabled
          ? 'acrylic'
          : 'opaque'
      },
      () => {
        document.documentElement.dataset.quickCaptureMaterial = 'opaque'
      }
    )
  }
  document.documentElement.dataset.quickCaptureCorners =
    searchParams.get('corners') === 'native' ? 'native' : 'css'
  applyQuickCaptureMaterial()
  window.electron.window.onReducedTransparencyChange(applyQuickCaptureMaterial)
  window.addEventListener('storage', (event) => {
    if (event.key === TRANSLUCENT_BACKGROUND_STORAGE_KEY) applyQuickCaptureMaterial()
  })
} else void initializeTranslucentBackground()

const root = createRoot(document.getElementById('root')!)
if (isQuickCapture) {
  void import('./features/capture/quick-capture-app').then(({ QuickCaptureApp }) => {
    performance.mark('kusu:surface-module-loaded')
    root.render(
      <StrictMode>
        <SettingsProvider>
          <QuickCaptureApp />
        </SettingsProvider>
      </StrictMode>
    )
  })
} else if (isNoteWindow) {
  void import('./features/items/note-window-app').then(({ NoteWindowApp }) => {
    performance.mark('kusu:surface-module-loaded')
    root.render(
      <StrictMode>
        <SettingsProvider>
          <NoteWindowApp itemId={searchParams.get('itemId') ?? ''} />
        </SettingsProvider>
      </StrictMode>
    )
  })
} else if (isSettingsWindow) {
  void import('./features/settings/settings-window-app').then(({ SettingsWindowApp }) => {
    performance.mark('kusu:surface-module-loaded')
    root.render(
      <StrictMode>
        <SettingsProvider>
          <SettingsWindowApp />
        </SettingsProvider>
      </StrictMode>
    )
  })
} else {
  void Promise.all([
    import('./App'),
    window.electron.window.titleBar ? import('./features/settings/tauri-settings') : null
  ]).then(([{ default: App }, settings]) => {
    performance.mark('kusu:surface-module-loaded')
    root.render(
      <StrictMode>
        <SettingsProvider>
          <App />
          {settings ? <settings.TauriSettings /> : null}
        </SettingsProvider>
      </StrictMode>
    )
  })
}
