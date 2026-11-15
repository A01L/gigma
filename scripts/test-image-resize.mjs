// Pictures keep their proportions when resized (no Shift needed), Ctrl on a handle crops the edge that is dragged,
// and layers pasted from another program land where the user is looking.
// Usage: node scripts/test-image-resize.mjs [debugPort] [mcpPort]   (defaults 9333 / 7331)
import { deflateSync } from 'node:zlib'
const port = process.argv[2] ?? '9333'
const mcpPort = process.argv[3] ?? '7331'
let mid = 0
async function mcp(name, args = {}) {
  const r = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++mid, method: 'tools/call', params: { name, arguments: args } }) })
  const j = await r.json()
  if (j.error || j.result?.isError) throw new Error(name + ': ' + JSON.stringify(j.error ?? j.result.content))
  return JSON.parse(j.result.content[0].text)
}
const results = []
process.on('uncaughtException', (e) => {
  console.log(results.join(String.fromCharCode(10)))
  console.log('CRASH', e.stack)
  process.exit(1)
})
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const check = (label, got, want) => results.push(`${same(got, want) ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${same(got, want) ? '' : '  want ' + JSON.stringify(want)}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// a 200 x 100 picture: left half red, right half blue
const W = 200, H = 100
const raw = Buffer.alloc((W * 3 + 1) * H)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = y * (W * 3 + 1) + 1 + x * 3; raw[o] = x < W / 2 ? 220 : 20; raw[o + 1] = 30; raw[o + 2] = x < W / 2 ? 20 : 220 }
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])

const proj = await mcp('create_project', { name: 'Image resize ' + Date.now().toString(36) })
await mcp('show_tab', {})
await wait(600)
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((p) => p.type === 'page' && p.url.includes('#doc=' + encodeURIComponent(proj.path)))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); pending.get(m.id)?.(m.result) })
const send = (method, params) => new Promise((res) => (pending.set(++id, res), ws.send(JSON.stringify({ id, method, params }))))
const js = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r.result?.value ?? r.exceptionDetails?.exception?.description ?? null)
const paint = () => send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 } })
const ev = (type, x, y, down, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !down ? 'none' : 'left', buttons: down ? 1 : 0, clickCount: 1, ...extra })
const at = (wx, wy) => js(`(() => { const r = document.querySelector('.canvas-wrap canvas').getBoundingClientRect(), c = editor.camera; return [r.left + ${wx} * c.zoom + c.x, r.top + ${wy} * c.zoom + c.y] })()`)
const drag = async (a, b, extra = {}) => {
  await ev('mouseMoved', a[0], a[1], false)
  await paint()
  await ev('mousePressed', a[0], a[1], true, extra)
  for (let i = 1; i <= 8; i++) await ev('mouseMoved', a[0] + ((b[0] - a[0]) * i) / 8, a[1] + ((b[1] - a[1]) * i) / 8, true, extra)
  await ev('mouseReleased', b[0], b[1], false, extra)
  await wait(250)
}
const CTRL = { modifiers: 2 }
const box = (i) => js(`(() => { const n = editor.nodes.get('${i}'); return [n.x, n.y, n.width, n.height].map((v) => Math.round(v)) })()`)
const fill = (i) => js(`(() => { const f = editor.nodes.get('${i}').fills.find((f) => f.type === 'IMAGE'); return [f.scaleMode, f.transform ? f.transform.map((v) => Math.round(v * 100) / 100) : null] })()`)

// ================================================================ pictures
const pic = await mcp('create_image', { name: 'pic', source: 'data:image/png;base64,' + png.toString('base64'), x: 0, y: 0, width: 400, height: 200 })
const anchor = await mcp('create_rectangle', { name: 'anchor', x: -300, y: -300, width: 10, height: 10, fill: '#333333' })
const far = await mcp('create_rectangle', { name: 'far', x: 900, y: 600, width: 10, height: 10, fill: '#333333' })
await mcp('zoom_to', { ids: [pic.id, anchor.id, far.id] })
await mcp('set_selection', { ids: [pic.id] })
await wait(500)
// the right side, no keys held
await drag(await at(400, 60), await at(300, 60))
check('a side of a picture dragged with no keys: the picture gets smaller as a whole, never squashed or cut', [await box(pic.id), await fill(pic.id)], [[0, 25, 300, 150], ['FILL', null]])
// a corner, no keys held
await drag(await at(300, 175), await at(400, 190))
check('a corner of a picture keeps its proportions without Shift', await box(pic.id), [0, 25, 400, 200])
// Ctrl on the right side: only that edge is cut
await drag(await at(400, 100), await at(300, 100), CTRL)
check('Ctrl on the right side: the box gets narrower, its height stays', await box(pic.id), [0, 25, 300, 200])
check('and the picture is cropped on that side only (three quarters of it are left, from the left edge)', await fill(pic.id), ['STRETCH', [0.75, 0, 0, 1, 0, 0]])
// Ctrl on the left side
await drag(await at(0, 100), await at(100, 100), CTRL)
check('Ctrl on the left side cuts the left edge: the picture does not move under the box', [await box(pic.id), await fill(pic.id)], [[100, 25, 200, 200], ['STRETCH', [0.5, 0, 0, 1, 0.25, 0]]])
// Ctrl outwards: the crop is given back, but never past the edge of the picture
await drag(await at(300, 100), await at(700, 100), CTRL)
check('Ctrl outwards gives the cut part back and stops at the edge of the picture', [await box(pic.id), await fill(pic.id)], [[100, 25, 300, 200], ['STRETCH', [0.75, 0, 0, 1, 0.25, 0]]])
// a cropped picture resized with no keys: the crop scales with it
await drag(await at(400, 100), await at(250, 100))
check('a cropped picture resized with no keys keeps its proportions and its crop', [await box(pic.id), await fill(pic.id)], [[100, 75, 150, 100], ['STRETCH', [0.75, 0, 0, 1, 0.25, 0]]])
// one undo per drag
await js(`editor.undo()`)
check('one undo takes back one drag', await box(pic.id), [100, 25, 300, 200])
await js(`editor.undo(); editor.undo(); editor.undo()`)
check('undo brings the crop back to none', [await box(pic.id), await fill(pic.id)], [[0, 25, 400, 200], ['FILL', null]])
// a plain shape is not a picture: a side changes one dimension only
const shape = await mcp('create_rectangle', { name: 'shape', x: 0, y: 300, width: 200, height: 100, fill: '#D9D9D9' })
await mcp('set_selection', { ids: [shape.id] })
await wait(300)
await drag(await at(200, 350), await at(300, 350))
check('a shape still changes one dimension when a side is dragged', await box(shape.id), [0, 300, 300, 100])
await drag(await at(300, 350), await at(350, 350), CTRL)
check('Ctrl means nothing for a shape', await box(shape.id), [0, 300, 350, 100])

// ================================================================ pasting from another program
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" fill="#22AA66"/></svg>`
const paste = (text) => js(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)}); if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return 1 })()`)
const pastedCentre = () => js(`(() => { const ids = editor.selection; if (!ids.length) return 'nothing selected'; const b = editor.selectionBounds(ids); const v = editor.visibleWorldRect(); return [Math.abs(b.x + b.w / 2 - (v.x + v.w / 2)) < 1, Math.abs(b.y + b.h / 2 - (v.y + v.h / 2)) < 1, editor.nodes.get(ids[0]).parentId] })()`)
// the view is moved far away from everything, to an empty place that does not hold the origin
await mcp('set_selection', { ids: [] })
await js(`editor.panBy(-6000, -4000)`)
await wait(200)
await paste(svg)
await wait(600)
check('layers from another program land in the middle of the view, on the free field', await pastedCentre(), [true, true, null])
// a frame is selected, then the view is moved away from it: the paste still lands in view, not inside that frame
const frame = await mcp('create_frame', { name: 'Frame', x: 0, y: 500, width: 600, height: 400, fill: '#FFFFFF' })
await mcp('set_selection', { ids: [frame.id] })
await wait(200)
await paste(svg)
await wait(600)
check('a selected frame that is out of sight does not swallow the paste', await pastedCentre(), [true, true, null])
// the frame is in view and selected: the layers go into it, at their own place inside it
await mcp('zoom_to', { ids: [frame.id] })
await mcp('set_selection', { ids: [frame.id] })
await wait(300)
await paste(svg)
await wait(600)
check('a selected frame in view takes the paste, at the same place inside it', await js(`(() => { const n = editor.nodes.get(editor.selection[0]); return [n.parentId === '${frame.id}', Math.round(n.x), Math.round(n.y)] })()`), [true, 0, 0])

console.log(results.join('\n'))
console.log(results.filter((r) => r.startsWith('FAIL')).length ? 'SOME FAILED' : 'ALL PASSED')
ws.close()
