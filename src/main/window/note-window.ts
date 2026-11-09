import { MACOS_WINDOW_CHROME } from './macos-chrome'
import { secureWindow } from '../security'
import { BrowserWindow, type WebContents } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'

import icon from '../../../resources/icon.png?asset'
import { WINDOW_CHANNELS } from '../../shared/window-contract'
import type { LibraryService } from '../library/library-service'
import { OPAQUE_WINDOW_BACKGROUND } from './window-material'
import { installMaximizedStateUpdates } from './maximized-state'
import { installDevToolsShortcut } from './devtools-shortcut'
import { installTextContextMenu } from './text-context-menu'

export class NoteWindowController {
  private readonly windows = new Map<string, BrowserWindow>()
  private readonly opening = new Map<string, Promise<void>>()
  private readonly closeRequests = new Map<BrowserWindow, Promise<boolean>>()
  private readonly closeResolvers = new Map<BrowserWindow, (approved: boolean) => void>()
  private readonly approvedCloses = new WeakSet<BrowserWindow>()

  constructor(private readonly libraryService: LibraryService) {}

  open(itemId: string): Promise<void> {
    const existing = this.windows.get(itemId)
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return Promise.resolve()
    }

    const pending = this.opening.get(itemId)
    if (pending) return pending
    const request = this.openNew(itemId).finally(() => this.opening.delete(itemId))
    this.opening.set(itemId, request)
    return request
  }

  private async openNew(itemId: string): Promise<void> {
    const item = await this.libraryService.getItemDetail(itemId)
    if (item.type !== 'note') throw new Error('Only notes can open in a new window.')
    const window = this.createWindow(itemId, item.title)
    this.windows.set(itemId, window)
  }

  resolveClose(sender: WebContents, approved: boolean): void {
    const window = BrowserWindow.fromWebContents(sender)
    if (!window) return
    this.closeResolvers.get(window)?.(approved)
  }

  async closeAll(): Promise<boolean> {
    await Promise.allSettled(this.opening.values())
    const results = await Promise.all(
      [...this.windows.values()].map((window) => this.requestClose(window))
    )
    return results.every(Boolean)
  }

  private requestClose(window: BrowserWindow): Promise<boolean> {
    if (window.isDestroyed()) return Promise.resolve(true)
    const pending = this.closeRequests.get(window)
    if (pending) return pending
    if (window.webContents.isLoadingMainFrame()) {
      this.approvedCloses.add(window)
      window.close()
      return Promise.resolve(true)
    }

    const request = new Promise<boolean>((resolve) => {
      this.closeResolvers.set(window, (approved) => {
        this.closeResolvers.delete(window)
        this.closeRequests.delete(window)
        if (approved && !window.isDestroyed()) {
          this.approvedCloses.add(window)
          window.close()
        }
        resolve(approved)
      })
      window.webContents.send(WINDOW_CHANNELS.noteWindowCloseRequested)
    })
    this.closeRequests.set(window, request)
    return request
  }

  private createWindow(itemId: string, title: string): BrowserWindow {
    const isMac = process.platform === 'darwin'
    const window = new BrowserWindow({
      title,
      width: 960,
      height: 760,
      minWidth: 560,
      minHeight: 420,
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
    window.on('close', (event) => {
      if (this.approvedCloses.delete(window)) return
      event.preventDefault()
      void this.requestClose(window)
    })
    window.on('closed', () => {
      if (this.windows.get(itemId) === window) this.windows.delete(itemId)
      this.closeResolvers.get(window)?.(true)
      this.closeResolvers.delete(window)
      this.closeRequests.delete(window)
    })
    window.webContents.on('render-process-gone', () => {
      if (!window.isDestroyed()) {
        this.approvedCloses.add(window)
        window.close()
      }
    })

    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    const url = rendererUrl ? URL.parse(rendererUrl) : null
    if (is.dev && url) {
      url.searchParams.set('surface', 'note-window')
      url.searchParams.set('itemId', itemId)
      void window.loadURL(url.toString())
    } else {
      void window.loadFile(join(__dirname, '../renderer/index.html'), {
        query: { surface: 'note-window', itemId }
      })
    }

    return window
  }
}
