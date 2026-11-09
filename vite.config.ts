// shadcn's framework detector expects a conventional Vite config file.
// Electron builds use electron.vite.config.ts. Tauri uses this standalone renderer build.
import { resolve } from 'path'
import { randomUUID } from 'node:crypto'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, normalizePath } from 'vite'

export default defineConfig(({ mode, command }) => {
  const devNonce = mode === 'tauri' && command === 'serve' ? randomUUID() : undefined
  return {
    root: 'src/renderer',
    server: mode === 'tauri' ? { host: '127.0.0.1', port: 1420, strictPort: true } : undefined,
    html: { cspNonce: devNonce },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [
      {
        name: 'tauri-ipc-csp',
        apply: () => mode === 'tauri',
        transformIndexHtml(html) {
          const devSocket = devNonce ? ' ws://127.0.0.1:1420' : ''
          const withIpc = html.replace(
            "default-src 'self';",
            `default-src 'self'; connect-src 'self' ipc: http://ipc.localhost${devSocket};`
          )
          return devNonce
            ? withIpc.replace('script-src ', `script-src 'nonce-${devNonce}' `)
            : withIpc
        }
      },
      react(),
      tailwindcss(),
      viteStaticCopy({
        targets: ['cmaps', 'standard_fonts', 'wasm', 'iccs'].map((directory) => ({
          src: normalizePath(resolve('node_modules/pdfjs-dist', directory)),
          dest: 'pdfjs'
        }))
      })
    ]
  }
})
