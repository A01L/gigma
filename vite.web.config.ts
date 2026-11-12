// Runs only the UI in a normal browser (in-memory document, no MCP/SQLite).
// Handy for fast UI iteration: `npm run web`.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/renderer',
  resolve: { alias: { '@shared': resolve('src/shared') } },
  plugins: [react()],
  server: { port: 5199 }
})
