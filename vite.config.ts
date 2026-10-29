import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

// Keep PDF fonts, CMaps and codecs local in both development and packaged apps.
const pdfjsRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
const assetDirectories = ['cmaps', 'standard_fonts', 'wasm']

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), {
    name: 'local-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (request, response, next) => {
        const [directory, name, extra] = (request.url || '').split('?')[0].split('/').filter(Boolean)
        if (extra || !assetDirectories.includes(directory) || !name || name === '..' || name.includes('\\')) return next()
        try {
          response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
          response.end(readFileSync(join(pdfjsRoot, directory, name)))
        }
        catch { next() }
      })
    },
    generateBundle() {
      for (const directory of assetDirectories) {
        for (const name of readdirSync(join(pdfjsRoot, directory))) {
          this.emitFile({ type: 'asset', fileName: `pdfjs/${directory}/${name}`, source: readFileSync(join(pdfjsRoot, directory, name)) })
        }
      }
    },
  }],
  server: { port: 1420, strictPort: true, host: '127.0.0.1', watch: { ignored: ['**/src-tauri/target/**', '**/dist/**'] } },
  clearScreen: false,
})
