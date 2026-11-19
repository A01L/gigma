// Closing Gigma: the process exits (nothing left in the background), and everything is in the file on the next launch,
// including what an AI did while the user had an edit open, and the undo history. A killed process keeps every
// change an AI was already told about.
// Usage: npm run build && node scripts/test-persist.mjs [debugPort] [mcpPort]   (defaults 9344 / 7344)
// Runs its own Gigma with a throwaway profile, so the real library is never touched.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const port = process.argv[2] ?? '9344'
const mcpPort = process.argv[3] ?? '7344'
const electron = createRequire(import.meta.url)('electron')
const profile = mkdtempSync(join(tmpdir(), 'gigma-persist-'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (label, got, want) => results.push(`${JSON.stringify(got) === JSON.stringify(want) ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(want) ? '' : '  want ' + JSON.stringify(want)}`)

let mid = 0
async function mcp(name, args = {}) {
  const r = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++mid, method: 'tools/call', params: { name, arguments: args } }) })
  const j = await r.json()
  if (j.error || j.result?.isError) throw new Error(name + ': ' + JSON.stringify(j.error ?? j.result.content))
  return JSON.parse(j.result.content[0].text)
}

function launch() {
  const p = spawn(electron, ['.', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { env: { ...process.env, GIGMA_MCP_PORT: mcpPort }, stdio: 'ignore' })
  p.exited = new Promise((r) => p.once('exit', () => r(Date.now())))
  return p
}
async function ready() {
  for (let i = 0; i < 100; i++) {
    try {
      await mcp('list_tabs')
      return
    } catch {
      await wait(200)
    }
  }
  throw new Error('Gigma did not start')
}
async function page(match) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const t = targets.filter((p) => p.type === 'page' && match(p.url)).pop()
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    pending.get(m.id)?.(m.result)
  })
  const send = (method, params) => new Promise((res) => (pending.set(++id, res), ws.send(JSON.stringify({ id, method, params }))))
  return { ws, js: (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value ?? null) }
}
// what the X button of the window does (window.close() from the page skips the app's close handler)
const closeWindow = (app) => spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${app.pid}).CloseMainWindow() | Out-Null`])
const portFree = async () => {
  try {
    await fetch(`http://127.0.0.1:${mcpPort}/health`)
    return false
  } catch {
    return true
  }
}
const names = async () => (await mcp('find_nodes', {})).map?.((n) => n.name).sort() ?? []

try {
  // ---- 1. an AI draws while the user has an edit open, then the window is closed ----
  let app = launch()
  await ready()
  const proj = await mcp('create_project', { name: 'Persist test' })
  const f = await mcp('create_frame', { name: 'Frame', x: 0, y: 0, width: 400, height: 300 })
  // a code block is drawn in a hidden helper window, which used to keep the app alive after its window was closed
  await mcp('create_code', { name: 'Code', x: 0, y: 320, width: 200, height: 100, html: '<b>hi</b>' })
  const tab = await page((u) => u.includes('#doc='))
  // a colour popover left open: the edit never closes
  await tab.js('editor.begin(), true')
  await mcp('create_rectangle', { name: 'AI rect', x: 20, y: 20, width: 100, height: 80, fill: '#2563EB', parentId: f.id })
  tab.ws.close()
  const t0 = Date.now()
  closeWindow(app)
  const exitedAt = await Promise.race([app.exited, wait(20_000).then(() => 0)])
  check('process exits after the window is closed', exitedAt > 0, true)
  if (!exitedAt) app.kill()
  console.log(`  exited in ${exitedAt ? exitedAt - t0 : '-'} ms`)
  check('MCP port is free after exit', await portFree(), true)

  // ---- 2. next launch: the layers and the undo history are there ----
  app = launch()
  await ready()
  await mcp('open_project', { path: proj.path })
  check('layers after reopening', await names(), ['AI rect', 'Code', 'Frame'])
  const tab2 = await page((u) => u.includes('#doc='))
  check('undo steps after reopening', await tab2.js('editor.undoStack.length'), 3)
  await tab2.js('editor.undo(), true')
  check('Ctrl+Z removes the last AI layer', await tab2.js('[...editor.nodes.values()].map((n) => n.name)'), ['Frame', 'Code'])
  await tab2.js('editor.redo(), editor.flush().then(() => true)')
  tab2.ws.close()

  // ---- 3. the process is killed right after an AI command ----
  await mcp('create_ellipse', { name: 'AI ellipse', x: 200, y: 20, width: 80, height: 80, fill: '#EC4899', parentId: f.id })
  app.kill('SIGKILL')
  await app.exited
  await wait(500)
  app = launch()
  await ready()
  await mcp('open_project', { path: proj.path })
  check('layers after a killed process', await names(), ['AI ellipse', 'AI rect', 'Code', 'Frame'])
  closeWindow(app)
  check('process exits again', (await Promise.race([app.exited, wait(20_000).then(() => 0)])) > 0, true)
} catch (e) {
  results.push('FAIL  ' + e.message)
} finally {
  console.log(results.join('\n'))
  await wait(500)
  try {
    if (!process.env.KEEP) rmSync(profile, { recursive: true, force: true })
    else console.log(profile)
  } catch {
    /* a file still held by a dying process */
  }
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
}
