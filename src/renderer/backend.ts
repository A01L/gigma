// Access to the desktop backend (window.gigma from preload).
// When the UI runs in a plain browser (`npm run web`) we fall back to an
// in-memory backend so the editor can be developed and tested without Electron.
import type { AppSettings, GigmaApi, ProjectInfo } from '@shared/api'
import type { DocChanges, DocSnapshot, GNode, Page } from '@shared/types'
import { DEFAULT_PAGE_BG, FORMAT_VERSION } from '@shared/types'

declare global {
  interface Window {
    gigma?: GigmaApi
  }
}

function memoryBackend(): GigmaApi {
  const docs = new Map<string, DocSnapshot & { thumb: string | null }>()
  const blobs = new Map<string, string>() // hash -> object URL
  let open: string | null = null
  const mk = (name: string): string => {
    const id = crypto.randomUUID()
    const page: Page = { id: crypto.randomUUID(), name: 'Page 1', order: 'a0', background: { ...DEFAULT_PAGE_BG } }
    docs.set(id, {
      meta: { id, name, createdAt: Date.now(), updatedAt: Date.now(), formatVersion: FORMAT_VERSION },
      pages: [page],
      nodes: [],
      thumb: null
    })
    return id
  }
  return {
    platform: 'web',
    tabId: null,
    // plugins need the desktop app (packages live on disk, pages are served by the main process)
    plugins: {
      list: async () => [],
      install: async () => null,
      installFolder: async () => null,
      installPath: async () => Promise.reject(new Error('plugins need the desktop app')),
      remove: async () => {},
      onChanged: () => {},
      openFolder: async () => {},
      saveDocs: async () => false,
      saveTemplate: async () => false,
      docs: async () => '',
      command: async () => Promise.reject(new Error('plugins need the desktop app')),
      fetch: async () => Promise.reject(new Error('plugins need the desktop app')),
      capture: async () => Promise.reject(new Error('plugins need the desktop app')),
      storageGet: async () => null,
      storageSet: async () => {}
    },
    tabs: {
      state: async () => ({ activeId: null, tabs: [] }),
      open: async () => {},
      newProject: async () => {},
      activate: async () => {},
      close: async () => {},
      home: async () => {},
      openSettings: async () => {},
      onUpdate: () => {},
      popupMenu: async () => {}
    },
    onBeforeClose: () => {},
    ready: () => {},
    appVersion: 'web',
    settings: (() => {
      let s: AppSettings = { theme: 'dark', language: 'system', homeView: 'grid', homeSort: 'edited', favorites: [] }
      try {
        s = { ...s, ...JSON.parse(localStorage.getItem('gigma-settings') ?? '{}') }
      } catch {
        /* ignore */
      }
      const subs: ((s: AppSettings) => void)[] = []
      return {
        get: async () => s,
        set: async (patch: Partial<AppSettings>) => {
          s = { ...s, ...patch }
          try {
            localStorage.setItem('gigma-settings', JSON.stringify(s))
          } catch {
            /* ignore */
          }
          subs.forEach((f) => f(s))
          return s
        },
        onChanged: (f: (s: AppSettings) => void) => void subs.push(f)
      }
    })(),
    library: {
      onChanged: () => {},
      dir: async () => '(browser memory)',
      reveal: async () => {},
      listTrash: async () => [],
      restore: async (p: string) => p,
      deleteForever: async () => {},
      emptyTrash: async () => {},
      list: async () =>
        [...docs.entries()].map(([path, d]): ProjectInfo => ({ path, name: d.meta.name, updatedAt: d.meta.updatedAt, createdAt: d.meta.createdAt, thumb: d.thumb })),
      create: async (name) => mk(name),
      trash: async (path) => void docs.delete(path),
      importFile: async () => null
    },
    doc: {
      open: async (path) => {
        open = path
        const d = docs.get(path)!
        return structuredClone({ meta: d.meta, pages: d.pages, nodes: d.nodes })
      },
      close: async () => void (open = null),
      apply: async (ch: DocChanges) => {
        const d = open ? docs.get(open) : null
        if (!d) return
        const pages = new Map(d.pages.map((p) => [p.id, p]))
        const nodes = new Map(d.nodes.map((n) => [n.id, n]))
        for (const p of ch.upsertPages ?? []) pages.set(p.id, structuredClone(p))
        for (const id of ch.deletePages ?? []) pages.delete(id)
        for (const n of ch.upsertNodes ?? []) nodes.set(n.id, structuredClone(n))
        for (const id of ch.deleteNodes ?? []) nodes.delete(id)
        d.pages = [...pages.values()]
        d.nodes = [...nodes.values()].filter((n: GNode) => pages.has(n.pageId))
        d.meta = { ...d.meta, ...(ch.meta ?? {}), updatedAt: Date.now() }
      },
      setThumb: async (t) => {
        const d = open ? docs.get(open) : null
        if (d) d.thumb = t
      },
      exportProject: async () => false,
      exportPages: async () => false,
      importPages: async () => null
    },
    blob: {
      put: async (bytes, mime) => {
        const digest = await crypto.subtle.digest('SHA-1', bytes as BufferSource)
        const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
        if (!blobs.has(hash)) blobs.set(hash, URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })))
        return hash
      },
      url: (hash) => blobs.get(hash) ?? ''
    },
    code: { render: () => null },
    figma: {
      fetchImages: async () => ({ mapped: {}, failed: [], error: 'Only available in the desktop app' })
    },
    mcp: {
      status: async () => ({
        running: false,
        port: 0,
        url: '',
        error: 'MCP is only available in the desktop app',
        claudeDesktopConfig: ''
      }),
      copyConfig: async () => {}
    },
    onCommand: () => {},
    respondCommand: () => {},
    onMenu: () => {}
  }
}

export const backend: GigmaApi = window.gigma ?? memoryBackend()
export const isDesktop = !!window.gigma
