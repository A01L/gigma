// Plugins: .plug.gigma packages (zip archives with manifest.json + an HTML page).
//
// A plugin is a web page shown in a sandboxed <iframe> inside the editor. It has no access to
// Node, to the file system or to the application: everything goes through the `gigma` object
// injected into the page, which talks to the editor with postMessage. Document commands are the
// same ones the built-in MCP server exposes (same names, same arguments).
import { app, BrowserWindow, dialog, ipcMain, net, session, shell, type WebContents } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path'
import type { PageCapture, PluginInfo, PluginManifest } from '../shared/api'
import type { CommandName } from '../shared/commands'
import { unzip, zip, type ZipEntry } from './zip'
import { commandReference, prepareCommand } from './mcp'
import guide from '../../docs/PLUGINS.md?raw'
import { BRIDGE_JS, TEMPLATE_HTML, UI_CSS } from './plugin-runtime'

export const PLUGIN_EXT = '.plug.gigma'
const ID_RE = /^[a-z0-9][a-z0-9-]{1,48}$/

const pluginsDir = () => {
  const d = join(app.getPath('userData'), 'plugins')
  mkdirSync(d, { recursive: true })
  return d
}
const devFile = () => join(pluginsDir(), 'dev-folders.json')
const dataFile = (id: string) => join(pluginsDir(), '.data', id + '.json')

/** plugins used straight from a folder (developer mode): id -> folder */
function devFolders(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(devFile(), 'utf8'))
  } catch {
    return {}
  }
}

function checkManifest(raw: unknown): PluginManifest {
  const m = raw as PluginManifest
  if (!m || typeof m !== 'object') throw new Error('manifest.json is not an object')
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) throw new Error('manifest.json: "id" must be 2-49 characters: lowercase latin letters, digits, dashes')
  if (typeof m.name !== 'string' || !m.name.trim()) throw new Error('manifest.json: "name" is required')
  if (typeof m.version !== 'string') throw new Error('manifest.json: "version" is required, e.g. "1.0.0"')
  if (m.main !== undefined && (typeof m.main !== 'string' || !/\.html?$/i.test(m.main))) throw new Error('manifest.json: "main" must be an .html file')
  if (m.permissions !== undefined && (!Array.isArray(m.permissions) || m.permissions.some((p) => typeof p !== 'string'))) throw new Error('manifest.json: "permissions" must be a list of strings')
  return m
}

function folderOf(id: string): string | null {
  const dev = devFolders()[id]
  if (dev && existsSync(join(dev, 'manifest.json'))) return dev
  const dir = join(pluginsDir(), id)
  return existsSync(join(dir, 'manifest.json')) ? dir : null
}

function infoOf(dir: string, devPath?: string): PluginInfo {
  const m = checkManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')))
  return { ...m, url: `gigma-plugin://${m.id}/${m.main ?? 'index.html'}`, iconUrl: m.icon ? `gigma-plugin://${m.id}/${m.icon}` : null, devPath }
}

export function listPlugins(): PluginInfo[] {
  const out = new Map<string, PluginInfo>()
  for (const name of readdirSync(pluginsDir())) {
    const dir = join(pluginsDir(), name)
    try {
      if (statSync(dir).isDirectory() && !name.startsWith('.') && existsSync(join(dir, 'manifest.json'))) {
        const info = infoOf(dir)
        if (info.id === name) out.set(info.id, info)
      }
    } catch {
      /* a broken plugin folder is simply not listed */
    }
  }
  for (const [id, dir] of Object.entries(devFolders())) {
    try {
      const info = infoOf(dir, dir)
      if (info.id === id) out.set(id, info)
    } catch {
      /* folder moved or manifest broken */
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Install a .plug.gigma package (replaces an installed plugin with the same id). */
export function installPackage(file: string): PluginInfo {
  const entries = unzip(readFileSync(file))
  // the files may sit in a single top-level folder (zipping a folder does that)
  let root = ''
  if (!entries.some((e) => e.name === 'manifest.json')) {
    const hit = entries.find((e) => /^[^/]+\/manifest\.json$/.test(e.name))
    if (!hit) throw new Error('manifest.json was not found in the package')
    root = hit.name.slice(0, hit.name.indexOf('/') + 1)
  }
  const files = entries.filter((e) => e.name.startsWith(root)).map((e) => ({ name: e.name.slice(root.length), data: e.data }))
  const manifest = checkManifest(JSON.parse(files.find((e) => e.name === 'manifest.json')!.data.toString('utf8')))
  const main = manifest.main ?? 'index.html'
  if (!files.some((e) => e.name === main)) throw new Error(`"${main}" was not found in the package`)
  const dir = join(pluginsDir(), manifest.id)
  rmSync(dir, { recursive: true, force: true })
  for (const f of files) {
    const target = join(dir, f.name)
    if (!resolve(target).startsWith(resolve(dir) + sep)) throw new Error('unsafe path in the package')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, f.data)
  }
  // an installed package wins over a developer folder with the same id
  const dev = devFolders()
  if (dev[manifest.id]) {
    delete dev[manifest.id]
    writeFileSync(devFile(), JSON.stringify(dev, null, 2))
  }
  return infoOf(dir)
}

export function installFolder(dir: string): PluginInfo {
  if (!existsSync(join(dir, 'manifest.json'))) throw new Error('manifest.json was not found in this folder')
  const info = infoOf(dir, dir)
  if (!existsSync(join(dir, info.main ?? 'index.html'))) throw new Error(`"${info.main ?? 'index.html'}" was not found in this folder`)
  const dev = devFolders()
  dev[info.id] = dir
  writeFileSync(devFile(), JSON.stringify(dev, null, 2))
  return info
}

export function removePlugin(id: string): void {
  if (!ID_RE.test(id)) return
  const dev = devFolders()
  if (dev[id]) {
    // a developer folder is only unlinked, never deleted
    delete dev[id]
    writeFileSync(devFile(), JSON.stringify(dev, null, 2))
  }
  rmSync(join(pluginsDir(), id), { recursive: true, force: true })
  rmSync(dataFile(id), { force: true })
}

/** disk space of every installed plugin (developer folders are not ours, they are not counted) */
export function pluginSizes(): { id: string; name: string; size: number }[] {
  const sizeOf = (d: string): number => readdirSync(d).reduce((s, n) => s + (statSync(join(d, n)).isDirectory() ? sizeOf(join(d, n)) : statSync(join(d, n)).size), 0)
  return listPlugins()
    .filter((p) => !p.devPath)
    .map((p) => ({ id: p.id, name: p.name, size: sizeOf(join(pluginsDir(), p.id)) }))
}

/** Pack a plugin folder into a .plug.gigma archive. */
export function packFolder(dir: string): Buffer {
  const entries: ZipEntry[] = []
  const walk = (d: string, prefix: string) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith('.')) continue
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p, prefix + name + '/')
      else entries.push({ name: prefix + name, data: readFileSync(p) })
    }
  }
  walk(dir, '')
  return zip(entries)
}

// ---------------------------------------------------------------- serving plugin files
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8'
}

/**
 * Plugin pages may only load their own files and inline code: no network at all from the page
 * itself. The internet is reachable only through gigma.fetch / gigma.capturePage, which need the
 * "network" permission.
 */
const CSP = "default-src 'none'; script-src gigma-plugin: 'unsafe-inline' 'unsafe-eval' blob:; style-src gigma-plugin: 'unsafe-inline'; img-src gigma-plugin: data: blob:; font-src gigma-plugin: data:; media-src gigma-plugin: data: blob:; connect-src gigma-plugin: data: blob:; worker-src blob:; form-action 'none'; base-uri 'none'"

/** gigma-plugin://<id>/<file> */
export function handlePluginRequest(req: Request): Response {
  const headers: Record<string, string> = { 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' }
  const u = new URL(req.url)
  const path = decodeURIComponent(u.pathname).replace(/^\/+/, '')
  if (path === '@gigma/ui.css') return new Response(UI_CSS, { headers: { ...headers, 'content-type': MIME['.css'] } })
  if (path === '@gigma/api.js') return new Response(BRIDGE_JS, { headers: { ...headers, 'content-type': MIME['.js'] } })
  const dir = folderOf(u.hostname)
  if (!dir) return new Response('plugin not found', { status: 404, headers })
  const file = normalize(join(dir, path || 'index.html'))
  if (!resolve(file).startsWith(resolve(dir) + sep) || !existsSync(file) || !statSync(file).isFile()) return new Response('not found', { status: 404, headers })
  const ext = extname(file).toLowerCase()
  let body: Buffer | string = readFileSync(file)
  if (ext === '.html' || ext === '.htm') {
    // the API is there before any script of the plugin runs
    const tag = `<script>${BRIDGE_JS}</script>`
    const html = body.toString('utf8')
    const at = /<head[^>]*>/i.exec(html)
    body = at ? html.slice(0, at.index + at[0].length) + tag + html.slice(at.index + at[0].length) : tag + html
  }
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), { headers: { ...headers, 'content-type': MIME[ext] ?? 'application/octet-stream' } })
}

// ---------------------------------------------------------------- network (permission "network")
function needNetwork(id: string): PluginInfo {
  const p = listPlugins().find((x) => x.id === id)
  if (!p) throw new Error('unknown plugin')
  if (!p.permissions?.includes('network')) throw new Error('this plugin has no "network" permission (add it to "permissions" in manifest.json)')
  return p
}
function httpUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : 'https://' + raw)
  } catch {
    throw new Error('invalid address: ' + raw)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http and https addresses are allowed')
  return u
}

async function pluginFetch(url: string, as: 'text' | 'json' | 'dataURL'): Promise<unknown> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 30_000)
  try {
    const res = await net.fetch(httpUrl(url).href, { signal: ctl.signal, credentials: 'omit' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > 32 * 1024 * 1024) throw new Error('the response is larger than 32 MB')
    if (as === 'dataURL') return `data:${(res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]};base64,${buf.toString('base64')}`
    const text = buf.toString('utf8')
    return as === 'json' ? JSON.parse(text) : text
  } finally {
    clearTimeout(timer)
  }
}

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

/** Load a web page in a hidden, isolated window and take a picture of the whole page. */
async function capturePage(opts: { url: string; width: number; mobile?: boolean; maxHeight?: number }): Promise<PageCapture> {
  const url = httpUrl(String(opts.url))
  const width = Math.round(Math.max(240, Math.min(2560, Number(opts.width) || 1440)))
  const maxHeight = Math.round(Math.max(400, Math.min(16000, Number(opts.maxHeight) || 12000)))
  const mobile = !!opts.mobile
  // nothing is shared with the app or between captures: no cookies, no cache on disk, no permissions
  const ses = session.fromPartition('gigma-plugin-capture')
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.removeAllListeners('will-download')
  ses.on('will-download', (e) => e.preventDefault())
  const w = new BrowserWindow({
    show: false,
    width,
    height: 900,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false }
  })
  const wc = w.webContents
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.setAudioMuted(true)
  const dbg = wc.debugger
  const step = (s: string) => process.env.GIGMA_DEBUG_CAPTURE && console.log('[capture]', s)
  try {
    if (mobile) wc.setUserAgent(MOBILE_UA)
    // the debugger answers only once the window has a live page
    await wc.loadURL('about:blank')
    dbg.attach('1.3')
    step('attached')
    const scale = mobile ? 2 : 1
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: scale, mobile })
    if (mobile) await dbg.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true })
    step('emulating')
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => done(), 25_000) // a slow page is captured as far as it got
      wc.once('did-finish-load', () => (clearTimeout(timer), done()))
      wc.once('did-fail-load', (_e, code, desc, _u, isMain) => {
        if (!isMain) return
        clearTimeout(timer)
        fail(new Error(`could not load the page: ${desc} (${code})`))
      })
      wc.loadURL(url.href).catch(() => {})
    })
    step('loaded')
    // scroll through the page once so lazy images load, then go back to the top
    await wc
      .executeJavaScript(
        `(async () => { const h = Math.min(document.documentElement.scrollHeight, ${maxHeight}); for (let y = 0; y < h; y += 700) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 90)) } window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 500)) })()`,
        true
      )
      .catch(() => {})
    step('scrolled')
    const metrics = (await dbg.sendCommand('Page.getLayoutMetrics')) as { cssContentSize?: { width: number; height: number } }
    step('metrics ' + JSON.stringify(metrics.cssContentSize))
    const full = Math.ceil(metrics.cssContentSize?.height ?? 900)
    let height = Math.max(200, Math.min(full, maxHeight))
    // keep the bitmap within what a canvas can draw
    const outScale = height * scale > 16000 ? 1 : scale
    if (height * outScale > 16000) height = 16000
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: Math.min(height, 4000), deviceScaleFactor: outScale, mobile })
    const shot = (await dbg.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 90, captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } })) as { data: string }
    return { bytes: Buffer.from(shot.data, 'base64'), mime: 'image/jpeg', width, height, title: wc.getTitle() || url.hostname }
  } finally {
    try {
      dbg.detach()
    } catch {
      /* already detached */
    }
    w.destroy()
  }
}

// ---------------------------------------------------------------- documentation
export function pluginDocs(): string {
  return guide.replace('<!-- COMMANDS -->', commandReference())
}

const TEMPLATE_MANIFEST = JSON.stringify({ id: 'my-plugin', name: 'My plugin', version: '1.0.0', description: 'What the plugin does', author: 'Your name', main: 'index.html', ui: { width: 300, height: 360 }, permissions: [] }, null, 2)

// ---------------------------------------------------------------- IPC
export function registerPlugins(host: {
  /** run a document command in the tab that owns this web contents */
  runInTab: (wc: WebContents, name: CommandName, args: Record<string, unknown>) => Promise<unknown>
  window: () => BrowserWindow | null
  broadcast: (channel: string) => void
}): void {
  const changed = () => host.broadcast('plugins:changed')
  const known = (id: string) => {
    if (!listPlugins().some((p) => p.id === id)) throw new Error('unknown plugin')
  }
  ipcMain.handle('plugins:list', () => listPlugins())
  ipcMain.handle('plugins:install', async () => {
    const r = await dialog.showOpenDialog(host.window()!, { title: 'Install plugin', filters: [{ name: 'Gigma plugin', extensions: ['gigma', 'zip'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths[0]) return null
    const info = installPackage(r.filePaths[0])
    changed()
    return info
  })
  // a package dropped onto the settings page
  ipcMain.handle('plugins:installPath', (_e, file: string) => {
    if (typeof file !== 'string' || !/\.(gigma|zip)$/i.test(file)) throw new Error('not a .plug.gigma file')
    const info = installPackage(file)
    changed()
    return info
  })
  ipcMain.handle('plugins:installFolder', async () => {
    const r = await dialog.showOpenDialog(host.window()!, { title: 'Plugin folder (with manifest.json)', properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    const info = installFolder(r.filePaths[0])
    changed()
    return info
  })
  ipcMain.handle('plugins:remove', (_e, id: string) => {
    removePlugin(id)
    changed()
  })
  ipcMain.handle('plugins:openFolder', () => shell.openPath(pluginsDir()))
  ipcMain.handle('plugins:docs', () => pluginDocs())
  ipcMain.handle('plugins:saveDocs', async () => {
    const r = await dialog.showSaveDialog(host.window()!, { defaultPath: 'Gigma-plugins.md', filters: [{ name: 'Markdown', extensions: ['md'] }] })
    if (r.canceled || !r.filePath) return false
    writeFileSync(r.filePath, pluginDocs())
    shell.showItemInFolder(r.filePath)
    return true
  })
  ipcMain.handle('plugins:saveTemplate', async () => {
    const r = await dialog.showSaveDialog(host.window()!, { defaultPath: 'gigma-plugin-template.zip', filters: [{ name: 'ZIP', extensions: ['zip'] }] })
    if (r.canceled || !r.filePath) return false
    writeFileSync(
      r.filePath,
      zip([
        { name: 'my-plugin/manifest.json', data: Buffer.from(TEMPLATE_MANIFEST) },
        { name: 'my-plugin/index.html', data: Buffer.from(TEMPLATE_HTML) },
        { name: 'PLUGINS.md', data: Buffer.from(pluginDocs()) }
      ])
    )
    shell.showItemInFolder(r.filePath)
    return true
  })
  ipcMain.handle('plugins:command', (e, id: string, name: string, args: unknown) => {
    known(id)
    const cmd = prepareCommand(name, args)
    // plugins cannot choose where files are written: exports always go to Downloads
    if (cmd.name === 'export_pdf') delete cmd.args.path
    return host.runInTab(e.sender, cmd.name, cmd.args)
  })
  ipcMain.handle('plugins:fetch', (_e, id: string, url: string, as: 'text' | 'json' | 'dataURL') => {
    needNetwork(id)
    return pluginFetch(String(url), as === 'json' || as === 'dataURL' ? as : 'text')
  })
  ipcMain.handle('plugins:capture', (_e, id: string, opts: { url: string; width: number; mobile?: boolean; maxHeight?: number }) => {
    needNetwork(id)
    return capturePage(opts ?? { url: '', width: 1440 })
  })
  const readData = (id: string): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(dataFile(id), 'utf8'))
    } catch {
      return {}
    }
  }
  ipcMain.handle('plugins:storageGet', (_e, id: string, key: string) => {
    known(id)
    return readData(id)[String(key)] ?? null
  })
  ipcMain.handle('plugins:storageSet', (_e, id: string, key: string, value: unknown) => {
    known(id)
    const data = readData(id)
    if (value === undefined || value === null) delete data[String(key)]
    else data[String(key)] = value
    const text = JSON.stringify(data)
    if (text.length > 5 * 1024 * 1024) throw new Error('plugin storage is limited to 5 MB')
    mkdirSync(dirname(dataFile(id)), { recursive: true })
    writeFileSync(dataFile(id), text)
  })
}

export const isPluginFile = (f: string) => basename(f).toLowerCase().endsWith(PLUGIN_EXT)
