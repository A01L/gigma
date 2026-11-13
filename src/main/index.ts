import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, clipboard, session, shell, WebContentsView, type WebContents } from 'electron'
import { join, extname } from 'node:path'
import { existsSync, readFileSync, statfsSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { GigmaFile } from './storage'
import {
  createProject,
  deleteForever,
  emptyTrash,
  importToLibrary,
  libraryDir,
  listProjects,
  listTrash,
  purgeOldTrash,
  restoreProject,
  trashProject
} from './library'
import { getSettings, setSettings } from './settings'
import { startMcpServer, type McpHandle } from './mcp'
import { handlePluginRequest, installPackage, isPluginFile, pluginSizes, registerPlugins } from './plugins'
import { renderPdf, type PdfPage } from './pdf'
import { deletedGuides, exportGuide, guideSizes, importGuide, importGuideFile, isGuideFile, listGuides, removeGuide, saveGuide } from './guides'
import type { GuideData } from '../shared/types'
import type { CommandName, CommandResponse } from '../shared/commands'
import type { DocChanges } from '../shared/types'
import type { AppSettings, McpStatus, SpecBoardItem, SpecTask, StorageStats, TabInfo, TabsState } from '../shared/api'

const MCP_PORT = Number(process.env.GIGMA_MCP_PORT || 7331)
export const TAB_BAR_H = 40
const isMac = process.platform === 'darwin'

protocol.registerSchemesAsPrivileged([
  // corsEnabled: renderers (served from http://localhost in dev, file:// in prod) fetch() image bytes
  { scheme: 'gigma-blob', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  // files of installed plugins, shown in sandboxed frames inside the editor
  { scheme: 'gigma-plugin', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])

let win: BrowserWindow | null = null
let mcp: McpHandle | null = null
let mcpError: string | undefined

// =====================================================================
// Tabs: Home lives in the window's own web contents (the "shell", which also
// draws the tab bar). Every open project is a separate WebContentsView with
// its own renderer process and its own open .gigma file — like Figma Desktop.
// A heavy file in one tab can't stall the others.
// =====================================================================
interface Tab {
  id: string
  path: string
  name: string
  view: WebContentsView
  file: GigmaFile | null
  ready: Promise<void>
  markReady: () => void
  /** Spec tasks the tab reported, for the board on Home */
  specs: SpecTask[]
}

const tabs: Tab[] = []
let activeId: string | null = null // null = Home

const tabOf = (wc: WebContents): Tab | undefined => tabs.find((t) => t.view.webContents.id === wc.id)
const activeTab = (): Tab | undefined => tabs.find((t) => t.id === activeId)

function fileOf(wc: WebContents): GigmaFile {
  const f = tabOf(wc)?.file
  if (!f) throw new Error('No project is open in this tab')
  return f
}

function rendererUrl(hash: string): { url?: string; file?: string; hash: string } {
  if (process.env.ELECTRON_RENDERER_URL) return { url: `${process.env.ELECTRON_RENDERER_URL}#${hash}`, hash }
  return { file: join(__dirname, '../renderer/index.html'), hash }
}

function loadInto(wc: WebContents, hash: string): void {
  const r = rendererUrl(hash)
  if (r.url) wc.loadURL(r.url)
  else wc.loadFile(r.file!, { hash: r.hash })
}

function tabsState(): TabsState {
  return { activeId, tabs: tabs.map((t): TabInfo => ({ id: t.id, name: t.name, path: t.path })) }
}

/** Spec tasks of every open tab, in tab order */
function specBoard(): SpecBoardItem[] {
  return tabs.flatMap((t) => t.specs.map((s): SpecBoardItem => ({ ...s, tabId: t.id, project: t.name })))
}
function broadcastSpecs(): void {
  if (win && !win.isDestroyed()) win.webContents.send('specs:update', specBoard())
}

function broadcastTabs(): void {
  win?.webContents.send('tabs:update', tabsState())
  broadcastSpecs()
  const t = activeTab()
  win?.setTitle(t ? `${t.name} - Gigma` : 'Gigma')
}

function layout(): void {
  if (!win) return
  const [w, h] = win.getContentSize()
  for (const t of tabs) {
    const visible = t.id === activeId
    t.view.setVisible(visible)
    if (visible) t.view.setBounds({ x: 0, y: TAB_BAR_H, width: w, height: Math.max(0, h - TAB_BAR_H) })
  }
}

function activate(id: string | null): void {
  activeId = id && tabs.some((t) => t.id === id) ? id : null
  layout()
  const t = activeTab()
  if (t) t.view.webContents.focus()
  else win?.webContents.focus()
  broadcastTabs()
  if (!t) win?.webContents.send('library:changed')
}

/** Open a library project in a tab (or focus it if already open). Resolves when the editor is ready. */
async function openTab(path: string): Promise<Tab> {
  const existing = tabs.find((t) => t.path === path)
  if (existing) {
    activate(existing.id)
    await existing.ready
    return existing
  }
  const id = randomUUID().slice(0, 8)
  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      additionalArguments: [`--gigma-tab=${id}`, `--gigma-version=${app.getVersion()}`]
    }
  })
  view.setBackgroundColor('#1e1e1e')
  let markReady!: () => void
  const ready = new Promise<void>((r) => (markReady = r))
  const tab: Tab = { id, path, name: 'Loading…', view, file: null, ready, markReady, specs: [] }
  tabs.push(tab)
  win!.contentView.addChildView(view)
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  view.webContents.on('render-process-gone', () => void closeTab(id, true))
  loadInto(view.webContents, 'doc=' + encodeURIComponent(path))
  activate(id)
  await Promise.race([ready, new Promise((_, rej) => setTimeout(() => rej(new Error('Editor did not open the project')), 20_000))])
  return tab
}

/** Ask the tab to flush edits + thumbnail, then destroy it. */
async function closeTab(id: string, force = false): Promise<void> {
  const i = tabs.findIndex((t) => t.id === id)
  if (i < 0) return
  const t = tabs[i]
  if (!force && !t.view.webContents.isDestroyed()) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 4000)
      ipcMain.once(`tab:closed:${id}`, () => {
        clearTimeout(timer)
        resolve()
      })
      t.view.webContents.send('app:before-close', id)
    })
  }
  tabs.splice(tabs.indexOf(t), 1)
  try {
    t.file?.close()
  } catch {
    /* ignore */
  }
  win?.contentView.removeChildView(t.view)
  if (!t.view.webContents.isDestroyed()) t.view.webContents.close()
  if (activeId === id) activeId = tabs[Math.min(i, tabs.length - 1)]?.id ?? null
  layout()
  broadcastTabs()
  if (!activeId) win?.webContents.send('library:changed')
}

function cycleTab(dir: 1 | -1): void {
  const ids: (string | null)[] = [null, ...tabs.map((t) => t.id)]
  const i = ids.indexOf(activeId)
  activate(ids[(i + dir + ids.length) % ids.length])
}

// =====================================================================
// Command bus: main -> active tab's editor -> main
// =====================================================================
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

ipcMain.on('cmd:response', (_e, res: CommandResponse) => {
  const p = pending.get(res.id)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(res.id)
  if (res.ok) p.resolve(res.result)
  else p.reject(new Error(res.error ?? 'command failed'))
})

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif'
}

async function runCommand(name: CommandName, args: Record<string, unknown>, client?: string): Promise<unknown> {
  if (!win || win.isDestroyed()) throw new Error('Gigma window is not open')
  // project-level commands handled in main
  if (name === 'list_projects')
    return listProjects().map(({ path, name, updatedAt }) => ({
      path,
      name,
      updatedAt: new Date(updatedAt).toISOString(),
      open: tabs.some((t) => t.path === path)
    }))
  if (name === 'list_tabs') return tabsState()
  if (name === 'create_project') {
    const path = createProject(String(args.name ?? 'Untitled'))
    const t = await openTab(path)
    return { path, tabId: t.id, name: args.name ?? 'Untitled', opened: true }
  }
  if (name === 'open_project') {
    const path = String(args.path)
    if (!listProjects().some((p) => p.path === path)) throw new Error('Unknown project path; use list_projects')
    const t = await openTab(path)
    return { path, tabId: t.id, opened: true }
  }
  if (name === 'switch_tab') {
    const id = (args.tabId as string | null) ?? null
    if (id && !tabs.some((t) => t.id === id)) throw new Error('Unknown tab id; use list_tabs')
    activate(id)
    return tabsState()
  }
  // document commands go to the active tab (or an explicit tabId)
  const tab = args.tabId ? tabs.find((t) => t.id === args.tabId) : activeTab()
  if (!tab?.file) throw new Error('No project tab is active in Gigma. Use list_projects + open_project, create_project, or switch_tab.')
  // Resolve image sources in main (renderers have no file system access).
  const toHash = (source: string): string => {
    const src = source.trim()
    let bytes: Uint8Array
    let mime = 'image/png'
    const m = /^data:([^;]+);base64,(.*)$/s.exec(src)
    if (m) {
      mime = m[1]
      bytes = Buffer.from(m[2], 'base64')
    } else if (/^([a-zA-Z]:[\\/]|\/|~)/.test(src) && src.length < 1024) {
      bytes = readFileSync(src)
      mime = MIME[extname(src).toLowerCase()] ?? 'image/png'
    } else {
      bytes = Buffer.from(src, 'base64')
    }
    return tab.file!.putBlob(bytes, mime)
  }
  if (name === 'create_image' && typeof args.source === 'string') args = { ...args, source: undefined, imageHash: toHash(args.source) }
  if (name === 'update_node' && Array.isArray(args.fills))
    args = {
      ...args,
      fills: (args.fills as Record<string, unknown>[]).map((f) =>
        f.type === 'IMAGE' && typeof f.source === 'string' ? { ...f, source: undefined, imageHash: toHash(f.source) } : f
      )
    }
  const id = randomUUID()
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Gigma editor did not respond in time'))
    }, 60_000)
    pending.set(id, { resolve, reject, timer })
    tab.view.webContents.send('cmd:request', { id, name, args, client })
  })
  // export_pdf: the editor describes the pages, the PDF itself is made and saved here
  if (name === 'export_pdf') {
    const r = result as { pages: PdfPage[]; name: string }
    const bytes = await renderPdf(r.pages)
    let path = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : ''
    if (path && !/\.pdf$/i.test(path)) path += '.pdf'
    if (!path) {
      // a free name in Downloads
      const base = join(app.getPath('downloads'), r.name.replace(/[\\/:*?"<>|]/g, '_') || 'Gigma')
      path = base + '.pdf'
      for (let i = 2; existsSync(path); i++) path = `${base} (${i}).pdf`
    }
    writeFileSync(path, bytes)
    return { path, pages: r.pages.map((p) => ({ width: p.width, height: p.height })), bytes: bytes.length }
  }
  return result
}

// =====================================================================
// IPC
// =====================================================================
ipcMain.handle('library:list', () => listProjects())
ipcMain.handle('library:create', (_e, name: string) => createProject(name || 'Untitled'))
ipcMain.handle('library:trash', async (_e, path: string) => {
  const open = tabs.find((t) => t.path === path)
  if (open) await closeTab(open.id)
  await trashProject(path)
})
ipcMain.handle('library:import', async () => {
  const r = await dialog.showOpenDialog(win!, { filters: [{ name: 'Gigma', extensions: ['gigma'] }], properties: ['openFile'] })
  if (r.canceled || !r.filePaths[0]) return null
  return importToLibrary(r.filePaths[0])
})

ipcMain.handle('trash:list', () => listTrash())
ipcMain.handle('trash:restore', (_e, path: string) => restoreProject(path))
ipcMain.handle('trash:delete', (_e, path: string) => deleteForever(path))
ipcMain.handle('trash:empty', () => emptyTrash())
ipcMain.handle('library:stats', (): StorageStats => {
  const sum = (list: { size?: number }[]) => list.reduce((s, p) => s + (p.size ?? 0), 0)
  let diskFree = 0
  let diskTotal = 0
  try {
    const d = statfsSync(libraryDir())
    diskFree = Number(d.bavail) * Number(d.bsize)
    diskTotal = Number(d.blocks) * Number(d.bsize)
  } catch {
    /* unknown disk: the page simply hides that line */
  }
  return { projects: sum(listProjects()), trash: sum(listTrash()), plugins: pluginSizes(), guides: guideSizes(), diskFree, diskTotal }
})
// ---------- guideline library ----------
ipcMain.handle('guides:list', () => ({ guides: listGuides(), deleted: deletedGuides() }))
ipcMain.handle('guides:save', (_e, data: GuideData) => {
  const g = saveGuide(data)
  broadcast('guides:changed')
  return g
})
ipcMain.handle('guides:remove', async (_e, id: string) => {
  await removeGuide(id)
  broadcast('guides:changed')
})
ipcMain.handle('guides:export', (_e, id: string) => exportGuide(win, id))
ipcMain.handle('guides:import', async () => {
  const g = await importGuide(win)
  if (g) broadcast('guides:changed')
  return g
})
ipcMain.handle('library:dir', () => libraryDir())
ipcMain.handle('library:reveal', () => shell.openPath(libraryDir()))

// ---------- settings (theme, language, favorites...) ----------
function effectiveDark(s: AppSettings): boolean {
  return s.theme === 'dark' || (s.theme === 'system' && nativeTheme.shouldUseDarkColors)
}
function effectiveLang(s: AppSettings): 'ru' | 'en' {
  if (s.language !== 'system') return s.language
  return app.getLocale().toLowerCase().startsWith('ru') ? 'ru' : 'en'
}
function applySettings(s: AppSettings): void {
  nativeTheme.themeSource = s.theme
  if (win && !isMac) {
    const dark = effectiveDark(s)
    win.setTitleBarOverlay({ color: dark ? '#2c2c2c' : '#ffffff', symbolColor: dark ? '#e6e6e6' : '#1e1e1e', height: TAB_BAR_H })
  }
  win?.setBackgroundColor(effectiveDark(s) ? '#1e1e1e' : '#f5f5f5')
  buildMenu()
  const all = [win?.webContents, ...tabs.map((t) => t.view.webContents)]
  for (const wc of all) if (wc && !wc.isDestroyed()) wc.send('settings:changed', s)
}
ipcMain.handle('settings:get', () => getSettings())
ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => {
  const s = setSettings(patch)
  applySettings(s)
  return s
})
nativeTheme.on('updated', () => {
  if (getSettings().theme === 'system') applySettings(getSettings())
})

ipcMain.handle('tabs:state', () => tabsState())
ipcMain.handle('tabs:open', async (_e, path: string) => void (await openTab(path)))
ipcMain.handle('tabs:new', async () => void (await openTab(createProject('Untitled'))))
ipcMain.handle('tabs:activate', (_e, id: string | null) => activate(id))
ipcMain.handle('tabs:close', (_e, id: string) => closeTab(id))
ipcMain.handle('tabs:home', () => activate(null))
ipcMain.handle('app:openSettings', () => {
  activate(null)
  win?.webContents.send('menu', 'settings')
})
ipcMain.handle('menu:popup', (_e, x: number, y: number) => Menu.getApplicationMenu()?.popup({ window: win!, x, y }))

ipcMain.handle('doc:open', (e, path: string) => {
  const t = tabOf(e.sender)
  if (!t) throw new Error('doc:open must come from a project tab')
  t.file?.close()
  t.file = new GigmaFile(path)
  const snap = t.file.load()
  t.name = snap.meta.name
  broadcastTabs()
  setTimeout(() => t.markReady(), 300) // let the editor mount before MCP commands arrive
  return snap
})
ipcMain.on('specs:report', (e, tasks: SpecTask[]) => {
  const t = tabOf(e.sender)
  if (!t || !Array.isArray(tasks)) return
  t.specs = tasks
  broadcastSpecs()
})
ipcMain.handle('specs:list', () => specBoard())
ipcMain.handle('specs:focus', (_e, tabId: string, id: string) => {
  const t = tabs.find((x) => x.id === tabId)
  if (!t) return
  activate(tabId)
  t.view.webContents.send('specs:focus', id)
})
ipcMain.handle('doc:close', (e) => {
  const t = tabOf(e.sender)
  if (t) void closeTab(t.id, true)
})
ipcMain.handle('doc:apply', (e, ch: DocChanges) => {
  const t = tabOf(e.sender)
  t?.file?.apply(ch)
  if (t && ch.meta?.name) {
    t.name = ch.meta.name
    broadcastTabs()
  }
})
ipcMain.handle('doc:thumb', (e, dataUrl: string) => tabOf(e.sender)?.file?.setThumb(dataUrl))
ipcMain.handle('doc:exportProject', async (e) => {
  const f = fileOf(e.sender)
  const r = await dialog.showSaveDialog(win!, {
    defaultPath: (f.getMeta()?.name ?? 'Untitled') + '.gigma',
    filters: [{ name: 'Gigma', extensions: ['gigma'] }]
  })
  if (r.canceled || !r.filePath) return false
  f.exportTo(r.filePath)
  return true
})
ipcMain.handle('doc:exportPages', async (e, pageIds: string[]) => {
  const f = fileOf(e.sender)
  const r = await dialog.showSaveDialog(win!, {
    defaultPath: (f.getMeta()?.name ?? 'Untitled') + ' - pages.gigma',
    filters: [{ name: 'Gigma', extensions: ['gigma'] }]
  })
  if (r.canceled || !r.filePath) return false
  f.exportTo(r.filePath, pageIds)
  return true
})
ipcMain.handle('doc:importPages', async (e) => {
  const f = fileOf(e.sender)
  const r = await dialog.showOpenDialog(win!, { filters: [{ name: 'Gigma', extensions: ['gigma'] }], properties: ['openFile'] })
  if (r.canceled || !r.filePaths[0]) return null
  return f.importPagesFrom(r.filePaths[0])
})
// CODE blocks: render HTML + CSS in a hidden, sandboxed, script-less, offline window and return a PNG.
// (Drawing SVG <foreignObject> on a canvas would taint it and break exports.)
let codeWin: BrowserWindow | null = null
let codeQueue: Promise<unknown> = Promise.resolve()
function codeWindow(): BrowserWindow {
  if (codeWin && !codeWin.isDestroyed()) return codeWin
  const ses = session.fromPartition('gigma-code-render')
  // nothing may leave the machine: only inline (data:) resources are allowed
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(data|about|blob):/.test(d.url) }))
  codeWin = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    webPreferences: { offscreen: true, javascript: false, session: ses, sandbox: true, contextIsolation: true, images: true }
  })
  codeWin.webContents.setFrameRate(1)
  return codeWin
}
ipcMain.handle('code:render', (_e, html: string, css: string, w: number, h: number, scale: number) => {
  // serialize renders through one hidden window
  const job = codeQueue.then(async () => {
    const cw = codeWindow()
    const W = Math.max(1, Math.min(4096, Math.round(w)))
    const H = Math.max(1, Math.min(4096, Math.round(h)))
    cw.setContentSize(W, H)
    cw.webContents.setZoomFactor(1)
    const doc =
      `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:transparent}*{box-sizing:border-box}</style>` +
      `<style>${css.replace(/<\/style/gi, '')}</style></head><body>${html}</body></html>`
    await cw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(doc))
    await new Promise((r) => setTimeout(r, 30))
    const img = await cw.webContents.capturePage({ x: 0, y: 0, width: W, height: H })
    const s = Math.max(0.25, Math.min(4, scale))
    const out = s === img.getSize().width / W ? img : img.resize({ width: Math.round(W * s), height: Math.round(H * s), quality: 'best' })
    return new Uint8Array(out.toPNG())
  })
  codeQueue = job.catch(() => null)
  return job
})

ipcMain.handle('pdf:render', (_e, pages: PdfPage[]) => renderPdf(pages))

// Fetch originals of images referenced by layers pasted from Figma.
// Figma's clipboard has only image hashes; the Figma REST API maps hash -> download URL.
// This is the only network access in Gigma and runs only when the user asks for it.
ipcMain.handle('figma:fetchImages', async (e, fileKey: string, hashes: string[]) => {
  const f = fileOf(e.sender)
  const token = getSettings().figmaToken?.trim()
  const result: { mapped: Record<string, string>; failed: string[]; error?: string } = { mapped: {}, failed: [] }
  if (!token) return { ...result, failed: hashes, error: 'NO_TOKEN' }
  if (!/^[A-Za-z0-9]+$/.test(fileKey)) return { ...result, failed: hashes, error: 'BAD_FILE_KEY' }
  try {
    const r = await fetch(`https://api.figma.com/v1/files/${fileKey}/images`, { headers: { 'X-Figma-Token': token } })
    if (r.status === 403) return { ...result, failed: hashes, error: 'FORBIDDEN' }
    if (!r.ok) return { ...result, failed: hashes, error: `HTTP_${r.status}` }
    const body = (await r.json()) as { meta?: { images?: Record<string, string> } }
    const urls = body.meta?.images ?? {}
    for (const h of hashes) {
      const url = urls[h]
      if (!url) {
        result.failed.push(h)
        continue
      }
      try {
        const img = await fetch(url)
        if (!img.ok) throw new Error(String(img.status))
        const mime = img.headers.get('content-type') ?? 'image/png'
        result.mapped[h] = f.putBlob(new Uint8Array(await img.arrayBuffer()), mime)
      } catch {
        result.failed.push(h)
      }
    }
  } catch (err) {
    return { ...result, failed: hashes, error: 'NETWORK: ' + (err as Error).message }
  }
  return result
})
ipcMain.handle('blob:put',(e, bytes: Uint8Array, mime: string) => fileOf(e.sender).putBlob(bytes, mime))

function mcpStatus(): McpStatus {
  const bridge = join(app.getAppPath(), 'bin', 'gigma-mcp.cjs')
  const config = {
    mcpServers: {
      gigma: { command: process.execPath, args: [bridge], env: { ELECTRON_RUN_AS_NODE: '1', GIGMA_MCP_PORT: String(MCP_PORT) } }
    }
  }
  return {
    running: !!mcp,
    port: MCP_PORT,
    url: `http://127.0.0.1:${MCP_PORT}/mcp`,
    error: mcpError,
    claudeDesktopConfig: JSON.stringify(config, null, 2)
  }
}
ipcMain.handle('mcp:status', () => mcpStatus())
ipcMain.handle('mcp:copyConfig', () => clipboard.writeText(mcpStatus().claudeDesktopConfig))

// =====================================================================
// Menu (actions go to the active tab, app-level ones are handled here)
// =====================================================================
function toTab(action: string) {
  return () => {
    const t = activeTab()
    if (t) t.view.webContents.send('menu', action)
  }
}
function toShell(action: string) {
  return () => {
    activate(null)
    win?.webContents.send('menu', action)
  }
}

async function newProjectTab(): Promise<void> {
  await openTab(createProject('Untitled'))
}

async function importToLibraryAndOpen(): Promise<void> {
  const r = await dialog.showOpenDialog(win!, { filters: [{ name: 'Gigma', extensions: ['gigma'] }], properties: ['openFile'] })
  if (r.canceled || !r.filePaths[0]) return
  await openTab(importToLibrary(r.filePaths[0]))
}

function buildMenu(): void {
  const ru = effectiveLang(getSettings()) === 'ru'
  const L = (en: string, r: string) => (ru ? r : en)
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: L('File', 'Файл'),
      submenu: [
        { label: L('Home', 'Главная'), click: () => activate(null) },
        { label: L('New Project', 'Новый проект'), accelerator: 'CmdOrCtrl+N', click: () => void newProjectTab() },
        { label: L('Close Tab', 'Закрыть вкладку'), accelerator: 'CmdOrCtrl+W', click: () => activeId && void closeTab(activeId) },
        { label: L('Settings...', 'Настройки...'), accelerator: 'CmdOrCtrl+,', click: toShell('settings') },
        { type: 'separator' },
        { label: L('Import .gigma to Library...', 'Импорт .gigma в библиотеку...'), click: () => void importToLibraryAndOpen() },
        { label: L('Import Pages from .gigma...', 'Импорт страниц из .gigma...'), click: toTab('import-pages') },
        { type: 'separator' },
        { label: L('Export Project as .gigma...', 'Экспорт проекта в .gigma...'), accelerator: 'CmdOrCtrl+Shift+E', click: toTab('export-project') },
        { label: L('Export Current Page as .gigma...', 'Экспорт текущей страницы в .gigma...'), click: toTab('export-page') },
        { label: L('Export Selection as PNG...', 'Экспорт выделения в PNG...'), click: toTab('export-png') },
        { label: L('Export Selection as SVG...', 'Экспорт выделения в SVG...'), click: toTab('export-svg') },
        { label: L('Export Selection as PDF...', 'Экспорт выделения в PDF...'), click: toTab('export-pdf') },
        { label: L('Export Frames to PDF...', 'Экспорт фреймов в PDF...'), click: toTab('export-frames-pdf') },
        { type: 'separator' },
        { label: L('Place Image...', 'Вставить изображение...'), accelerator: 'CmdOrCtrl+Shift+K', registerAccelerator: false, click: toTab('place-image') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: L('Exit', 'Выход') }
      ]
    },
    // Items with registerAccelerator: false only SHOW their shortcut. The editor handles those keys itself,
    // by physical key, so they work on any keyboard layout (a menu accelerator "Ctrl+Z" does not fire on a
    // Russian layout, where that key types "я") and never steal keys from text fields.
    {
      label: L('Edit', 'Правка'),
      submenu: [
        { label: L('Undo', 'Отменить'), accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: toTab('undo') },
        { label: L('Redo', 'Повторить'), accelerator: 'CmdOrCtrl+Shift+Z', registerAccelerator: false, click: toTab('redo') },
        { type: 'separator' },
        { role: 'cut', label: L('Cut', 'Вырезать') },
        { role: 'copy', label: L('Copy', 'Копировать') },
        { role: 'paste', label: L('Paste', 'Вставить') },
        { label: L('Duplicate', 'Дублировать'), accelerator: 'CmdOrCtrl+D', registerAccelerator: false, click: toTab('duplicate') },
        { label: L('Select All', 'Выделить всё'), accelerator: 'CmdOrCtrl+A', registerAccelerator: false, click: toTab('select-all') }
      ]
    },
    {
      label: L('View', 'Вид'),
      submenu: [
        { label: L('Toggle Left Panel', 'Левая панель'), accelerator: 'CmdOrCtrl+\\', registerAccelerator: false, click: toTab('toggle-left') },
        { label: L('Toggle Right Panel', 'Правая панель'), accelerator: 'CmdOrCtrl+Alt+\\', registerAccelerator: false, click: toTab('toggle-right') },
        { type: 'separator' },
        { label: L('Zoom to Fit', 'Показать всё'), accelerator: 'Shift+1', registerAccelerator: false, click: toTab('zoom-fit') },
        { label: L('Zoom to 100%', 'Масштаб 100%'), accelerator: 'Shift+0', registerAccelerator: false, click: toTab('zoom-100') },
        { type: 'separator' },
        { label: L('Next Tab', 'Следующая вкладка'), accelerator: 'Ctrl+Tab', click: () => cycleTab(1) },
        { label: L('Previous Tab', 'Предыдущая вкладка'), accelerator: 'Ctrl+Shift+Tab', click: () => cycleTab(-1) },
        { type: 'separator' },
        {
          label: L('Toggle Developer Tools', 'Инструменты разработчика'),
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: () => (activeTab()?.view.webContents ?? win?.webContents)?.toggleDevTools()
        },
        { role: 'togglefullscreen', label: L('Full Screen', 'Полный экран') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// =====================================================================
// Window
// =====================================================================
function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1e1e',
    title: 'Gigma',
    show: false,
    icon: join(app.getAppPath(), 'build', 'icon.png'),
    // Figma-like: the tab bar is the title bar
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { color: '#2c2c2c', symbolColor: '#e6e6e6', height: TAB_BAR_H } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      additionalArguments: [`--gigma-version=${app.getVersion()}`]
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  loadInto(win.webContents, 'shell')
  applySettings(getSettings())
  win.on('resize', layout)
  let closing = false
  win.on('close', (e) => {
    if (closing || !tabs.length) return
    e.preventDefault()
    closing = true
    Promise.all(tabs.map((t) => closeTab(t.id))).finally(() => win?.close())
  })
  win.on('closed', () => {
    win = null
  })
}

/** tell the shell and every project tab that something changed */
function broadcast(channel: string): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel)
  for (const t of tabs) if (!t.view.webContents.isDestroyed()) t.view.webContents.send(channel)
}

// ---------- double-clicked .gigma files: import into the library and open ----------
/** files Gigma opens: projects, guidelines (.gguide) and plugin packages (.gplug) */
const isGigmaFile = (a: string) => /\.(gigma|gguide|gplug)$/i.test(a)
const pendingFiles: string[] = process.argv.slice(1).filter(isGigmaFile)
let shellReady = false

async function openExternalFile(file: string): Promise<void> {
  if (!shellReady || !win) {
    pendingFiles.push(file)
    return
  }
  // a double-clicked .gplug is a plugin package: ask, then install
  if (isPluginFile(file)) {
    try {
      const ru = effectiveLang(getSettings()) === 'ru'
      const r = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ru ? ['Установить', 'Отмена'] : ['Install', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: ru ? 'Установить плагин Gigma?' : 'Install this Gigma plugin?',
        detail: file
      })
      if (r.response !== 0) return
      const info = installPackage(file)
      broadcast('plugins:changed')
      await dialog.showMessageBox(win, { type: 'info', message: (ru ? 'Плагин установлен: ' : 'Plugin installed: ') + info.name })
    } catch (e) {
      dialog.showErrorBox('Gigma', `Could not install ${file}:\n${(e as Error).message}`)
    }
    return
  }
  // a double-clicked .gguide goes into the guideline library
  if (isGuideFile(file)) {
    try {
      const g = importGuideFile(file)
      broadcast('guides:changed')
      const ru = effectiveLang(getSettings()) === 'ru'
      await dialog.showMessageBox(win, { type: 'info', message: (ru ? 'Гайдлайн добавлен в библиотеку: ' : 'Guideline added to the library: ') + g.name })
    } catch (e) {
      dialog.showErrorBox('Gigma', `Could not import ${file}:
${(e as Error).message}`)
    }
    return
  }
  try {
    await openTab(importToLibrary(file))
    if (win.isMinimized()) win.restore()
    win.focus()
  } catch (e) {
    dialog.showErrorBox('Gigma', `Could not open ${file}:\n${(e as Error).message}`)
  }
}

app.on('open-file', (e, file) => {
  e.preventDefault()
  void openExternalFile(file)
})

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', (_e, argv) => {
  for (const a of argv.slice(1)) if (isGigmaFile(a)) void openExternalFile(a)
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

ipcMain.on('renderer:ready', (e) => {
  if (e.sender !== win?.webContents) return
  shellReady = true
  for (const f of pendingFiles.splice(0)) void openExternalFile(f)
})

app.whenReady().then(async () => {
  // gigma-blob://t<tabId>/<sha1> -> image bytes from that tab's .gigma file
  protocol.handle('gigma-blob', (req) => {
    const u = new URL(req.url)
    const tab = tabs.find((t) => 't' + t.id === u.hostname)
    const b = tab?.file?.getBlob(u.pathname.replace(/^\//, ''))
    const cors = { 'access-control-allow-origin': '*' }
    if (!b) return new Response('not found', { status: 404, headers: cors })
    return new Response(Buffer.from(b.bytes), { headers: { ...cors, 'content-type': b.mime, 'cache-control': 'max-age=31536000, immutable' } })
  })
  protocol.handle('gigma-plugin', (req) => {
    try {
      return handlePluginRequest(req)
    } catch (e) {
      return new Response(String((e as Error).message), { status: 500 })
    }
  })
  registerPlugins({
    window: () => win,
    broadcast,
    runInTab: (wc, name, args) => {
      const tab = tabOf(wc)
      if (!tab) throw new Error('plugins run inside an open project')
      return runCommand(name, { ...args, tabId: tab.id })
    }
  })
  buildMenu()
  createWindow()
  void purgeOldTrash()
  try {
    // dev builds only: window screenshot endpoint for automated UI checks
    const shot = app.isPackaged
      ? undefined
      : async (part: string) => {
          // part=shell -> tab bar + Home; part=tab -> active project tab content
          const t = activeTab()
          const wc = part === 'shell' || !t ? win!.webContents : t.view.webContents
          return (await wc.capturePage()).toPNG()
        }
    mcp = await startMcpServer(runCommand, MCP_PORT, shot)
  } catch (e) {
    mcpError = `Port ${MCP_PORT} unavailable: ${(e as Error).message}`
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})
app.on('before-quit', () => {
  mcp?.close()
  for (const t of tabs) t.file?.close()
})
