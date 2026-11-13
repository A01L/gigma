// Batch export: several selected frames become a file each in the chosen folder; one layer is a single file.
// The app must run with GIGMA_EXPORT_DIR set to an existing empty folder (it stands in for the folder dialog).
// Usage: node scripts/test-export-batch.mjs [debugPort] [mcpPort] <exportDir>   (defaults 9333 / 7331)
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const port = process.argv[2] ?? '9333'
const mcpPort = process.argv[3] ?? '7331'
const dir = process.argv[4]
if (!dir) throw new Error('pass the folder GIGMA_EXPORT_DIR points to')
let mid = 0
async function mcp(name, args = {}) {
  const r = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++mid, method: 'tools/call', params: { name, arguments: args } }) })
  const j = await r.json()
  if (j.error || j.result?.isError) throw new Error(name + ': ' + JSON.stringify(j.error ?? j.result.content))
  return JSON.parse(j.result.content[0].text)
}
const results = []
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const check = (label, got, want) => results.push(`${same(got, want) ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${same(got, want) ? '' : '  want ' + JSON.stringify(want)}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const clear = () => readdirSync(dir).forEach((f) => rmSync(join(dir, f)))
const list = () => readdirSync(dir).sort()
/** width and height of a PNG file, from its header */
const pngSize = (f) => {
  const b = readFileSync(join(dir, f))
  return [b.readUInt32BE(16), b.readUInt32BE(20)]
}
clear()

const proj = await mcp('create_project', { name: 'Export test' })
// two rows of frames; two of them share a name, one has a character a file name cannot have
const mk = (name, x, y, w, h) => mcp('create_frame', { name, x, y, width: w, height: h, fill: '#3355FF' })
const a = await mk('01 · Алый закат', 0, 0, 108, 135)
const b = await mk('Post', 150, 4, 108, 135)
const c = await mk('Post', 0, 200, 108, 135)
const d = await mk('04: Изумруд?', 150, 200, 200, 100)
await mcp('create_rectangle', { parentId: a.id, x: 10, y: 10, width: 40, height: 40, fill: '#FF0000' })
await mcp('zoom_to', { ids: [a.id, d.id] })

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.filter((p) => p.type === 'page' && p.url.includes('#doc=' + encodeURIComponent(proj.path))).pop()
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  pending.get(m.id)?.(m.result)
})
const send = (method, params) => new Promise((res) => (pending.set(++id, res), ws.send(JSON.stringify({ id, method, params }))))
const js = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r.result?.value ?? r.exceptionDetails?.exception?.description ?? null)
await wait(2000)
const press = async (label) => {
  const at = await js(`(() => { const b = [...document.querySelectorAll('.panel.right .btn')].find((b) => b.textContent.trim() === '${label}'); if (!b) return null; b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0], y: at[1], button: 'none', buttons: 0 })
  await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 } })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at[0], y: at[1], button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at[0], y: at[1], button: 'left', buttons: 0, clickCount: 1 })
  await wait(1500)
}

// ---- four frames, PNG at 2x (the default of the panel)
await mcp('set_selection', { ids: [d.id, c.id, b.id, a.id] })
await wait(300)
await press('PNG')
check('four selected frames give four PNG files, named after the frames', list(), ['01 · Алый закат@2x.png', '04_ Изумруд_@2x.png', 'Post 2@2x.png', 'Post@2x.png'])
check('each file is its own frame at 2x', [pngSize('01 · Алый закат@2x.png'), pngSize('04_ Изумруд_@2x.png'), pngSize('Post@2x.png')], [[216, 270], [400, 200], [216, 270]])
check('the app says how many were saved and offers to show them', await js(`[/4/.test(document.querySelector('.toast span')?.textContent ?? ''), !!document.querySelector('.toast .toast-action')]`), [true, true])
// the red square is only in the first frame: the files are not one picture cut in parts, and not the same picture four times
const red = (f) => js(`(async () => { const bytes = new Uint8Array(${JSON.stringify([...readFileSync(join(dir, f))])}); const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' })); const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); return [...g.getImageData(60, 60, 1, 1).data].slice(0, 3) })()`)
check('the first frame has its red square, the other does not', [await red('01 · Алый закат@2x.png'), await red('Post@2x.png')], [[255, 0, 0], [51, 85, 255]])

// ---- SVG
clear()
await press('SVG')
check('the same selection gives four SVG files', list(), ['01 · Алый закат.svg', '04_ Изумруд_.svg', 'Post 2.svg', 'Post.svg'])
check('each is an SVG of one frame', [/^<svg[^>]*width="108"/.test(readFileSync(join(dir, 'Post.svg'), 'utf8')), /^<svg[^>]*width="200"/.test(readFileSync(join(dir, '04_ Изумруд_.svg'), 'utf8'))], [true, true])

// ---- one layer
clear()
await mcp('set_selection', { ids: [d.id] })
await wait(300)
await press('PNG')
check('one selected frame gives one file', list(), ['04_ Изумруд_@2x.png'])

// ---- a frame and a layer inside it: the frame alone (the layer is already in it)
clear()
const inner = await js(`editor.children('${a.id}')[0]`)
await mcp('set_selection', { ids: [a.id, inner] })
await wait(300)
await press('PNG')
check('a layer selected together with its frame is not exported twice', list(), ['01 · Алый закат@2x.png'])
clear()

console.log(results.join('\n'))
console.log(results.some((r) => r.startsWith('FAIL')) ? '\nFAILED' : '\nALL PASSED')
ws.close()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
