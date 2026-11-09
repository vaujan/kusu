import { resolve } from 'path'
import { normalizePath } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    define: {
      'process.env.KUSU_PREVIEW_BUILD': JSON.stringify(process.env.KUSU_PREVIEW_BUILD ?? '')
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [
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
