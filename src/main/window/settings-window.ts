import { MACOS_WINDOW_CHROME } from './macos-chrome'
import { secureWindow } from '../security'
import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'

import icon from '../../../resources/icon.png?asset'
import { OPAQUE_WINDOW_BACKGROUND } from './window-material'
import { installMaximizedStateUpdates } from './maximized-state'
import { installDevToolsShortcut } from './devtools-shortcut'
import { installTextContextMenu } from './text-context-menu'

export class SettingsWindowController {
  private window: BrowserWindow | null = null

  open(): void {
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) this.window.restore()
      this.window.show()
      this.window.focus()
      return
    }

    this.window = this.createWindow()
  }

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
  }

  private createWindow(): BrowserWindow {
    const isMac = process.platform === 'darwin'
    const window = new BrowserWindow({
      title: 'Settings — Kusu',
      width: 840,
      height: 640,
      minWidth: 680,
      minHeight: 520,
      show: false,
      transparent: process.platform === 'linux',
      backgroundColor: OPAQUE_WINDOW_BACKGROUND,
      autoHideMenuBar: true,
      frame: isMac,
      ...(isMac ? MACOS_WINDOW_CHROME : {}),
      ...(isMac ? {} : { icon }),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    secureWindow(window)
    installTextContextMenu(window)
    installDevToolsShortcut(window)
    installMaximizedStateUpdates(window)
    window.on('ready-to-show', () => window.show())
    window.on('closed', () => {
      if (this.window === window) this.window = null
    })

    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    const url = rendererUrl ? URL.parse(rendererUrl) : null
    if (is.dev && url) {
      url.searchParams.set('surface', 'settings-window')
      void window.loadURL(url.toString())
    } else {
      void window.loadFile(join(__dirname, '../renderer/index.html'), {
        query: { surface: 'settings-window' }
      })
    }

    return window
  }
}
