import { writeFile } from 'node:fs/promises'
import type { BrowserWindow, NativeImage } from 'electron'
import { writePerformanceEvent } from './performance-log'

function bitmapBrightness(image: NativeImage): number {
  const bitmap = image.toBitmap()
  let sum = 0
  let samples = 0
  // A stride coprime with four samples across all byte positions in the bitmap.
  for (let index = 0; index < bitmap.length; index += 1021) {
    sum += bitmap[index]
    samples += 1
  }
  return sum / samples
}

// Explicit benchmark-only visual checks. Changing the fixture profile never changes the user's profile.
export async function capturePerformanceScreenshots(window: BrowserWindow): Promise<void> {
  const output = process.env.KUSU_PERFORMANCE_OUTPUT
  if (!output || process.env.KUSU_PERFORMANCE_SCREENSHOTS !== '1') return
  const previous: string | null = await window.webContents.executeJavaScript(
    "localStorage.getItem('kusu-color-mode')"
  )
  const previousThrottling = window.webContents.getBackgroundThrottling()
  const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 200))
  const setMode = async (mode: string | null): Promise<void> => {
    await window.webContents.executeJavaScript(`(() => {
      const value = ${JSON.stringify(mode)};
      if (value === null) localStorage.removeItem('kusu-color-mode'); else localStorage.setItem('kusu-color-mode', value);
      window.dispatchEvent(new StorageEvent('storage', { key: 'kusu-color-mode', newValue: value, storageArea: localStorage }));
    })()`)
    await pause()
  }
  window.webContents.setBackgroundThrottling(false)
  try {
    for (const mode of ['light', 'dark']) {
      await setMode(mode)
      const dark: boolean = await window.webContents.executeJavaScript(
        "document.documentElement.classList.contains('dark')"
      )
      if (dark !== (mode === 'dark')) throw new Error('The fixture theme did not update.')
      const material: string | null = await window.webContents.executeJavaScript(
        'document.documentElement.dataset.windowMaterial ?? null'
      )
      if (material !== 'opaque')
        throw new Error(`Expected the default opaque surface, got ${material}.`)
      let screenshot: NativeImage | undefined
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await window.webContents.executeJavaScript(`
          new Promise(resolve => {
            const deadline = setTimeout(resolve, 300);
            requestAnimationFrame(() => requestAnimationFrame(() => {
              clearTimeout(deadline);
              resolve();
            }));
          })
        `)
        const frame = await window.capturePage()
        if (frame.isEmpty()) continue
        const brightness = bitmapBrightness(frame)
        if (mode === 'light' ? brightness > 155 : brightness < 135) {
          screenshot = frame
          break
        }
      }
      if (!screenshot) throw new Error(`The captured workspace did not paint in ${mode} mode.`)
      const path = `${output}.${process.env.KUSU_PERFORMANCE_RUN ?? '1'}.${mode}.png`
      await writeFile(path, screenshot.toPNG())
      writePerformanceEvent('screenshot', { mode, material, path })
    }
    const protocol = window.webContents.debugger
    protocol.attach('1.3')
    try {
      await protocol.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
      })
      const reduced: boolean = await window.webContents.executeJavaScript(
        "matchMedia('(prefers-reduced-motion: reduce)').matches"
      )
      if (!reduced) throw new Error('Reduced motion emulation did not apply.')
      await window.webContents.executeJavaScript(`(() => {
        const root = [...document.querySelectorAll('[data-virtual-list]')].find(el => el.getBoundingClientRect().height > 0);
        const scroller = root.closest('[data-slot="scroll-area-viewport"]');
        scroller.scrollTop += 600;
      })()`)
      await pause()
      writePerformanceEvent('reduced-motion', { verified: true })
    } finally {
      await protocol.sendCommand('Emulation.setEmulatedMedia', { features: [] })
      protocol.detach()
    }
  } finally {
    try {
      await setMode(previous)
    } finally {
      window.webContents.setBackgroundThrottling(previousThrottling)
    }
  }
}
