// Ctrl+Z from the keyboard after the things users do: drawing, moving, resizing a picture, cropping, pasting, searching layers.
// Usage: node scripts/test-undo-key.mjs [debugPort] [mcpPort]   (defaults 9333 / 7331)
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

const W = 200, H = 100
const raw = Buffer.alloc((W * 3 + 1) * H, 120)
for (let y = 0; y < H; y++) raw[y * (W * 3 + 1)] = 0
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])

const proj = await mcp('create_project', { name: 'Undo key ' + Date.now().toString(36) })
await mcp('show_tab', {})
await wait(800)
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
// Ctrl+Z as the keyboard sends it
const undoKey = async () => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 })
  await wait(250)
}
const box = (i) => js(`(() => { const n = editor.nodes.get('${i}'); return n ? [n.x, n.y, n.width, n.height].map((v) => Math.round(v)) : null })()`)
const focus = () => js(`(() => { const a = document.activeElement; return a ? a.tagName + (a.className ? '.' + String(a.className).split(' ')[0] : '') : null })()`)

const rect = await mcp('create_rectangle', { name: 'box', x: 0, y: 300, width: 200, height: 100, fill: '#D9D9D9' })
const pic = await mcp('create_image', { name: 'pic', source: 'data:image/png;base64,' + png.toString('base64'), x: 0, y: 0, width: 400, height: 200 })
const far = await mcp('create_rectangle', { name: 'far', x: 900, y: 600, width: 10, height: 10, fill: '#333333' })
await mcp('zoom_to', { ids: [pic.id, rect.id, far.id] })
await wait(600)

// 1. a shape is moved, Ctrl+Z
await mcp('set_selection', { ids: [rect.id] })
await wait(300)
await drag(await at(100, 350), await at(160, 380))
check('a shape was moved', await box(rect.id), [60, 330, 200, 100])
await undoKey()
check('Ctrl+Z after a move', await box(rect.id), [0, 300, 200, 100])

// 2. a picture is resized, Ctrl+Z
await mcp('set_selection', { ids: [pic.id] })
await wait(300)
await drag(await at(400, 60), await at(300, 60))
await undoKey()
check('Ctrl+Z after a picture was resized', await box(pic.id), [0, 0, 400, 200])

// 3. a picture is cropped with Ctrl, Ctrl+Z
await drag(await at(400, 100), await at(300, 100), { modifiers: 2 })
check('a picture was cropped', await box(pic.id), [0, 0, 300, 200])
await undoKey()
check('Ctrl+Z after a crop', await box(pic.id), [0, 0, 400, 200])

// 4. the search of layers was used, then Ctrl+Z
await drag(await at(200, 100), await at(230, 120))
await js(`document.querySelector('.panel.left .section-title .icon-btn[title*="Ctrl+F"]').click()`)
await wait(200)
await js(`document.querySelector('.layer-search input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
await wait(200)
await undoKey()
check('Ctrl+Z after the search of layers was opened and closed', await box(pic.id), [0, 0, 400, 200])

// 5. the search is left open (typed into), the user clicks on the canvas and presses Ctrl+Z
await drag(await at(200, 100), await at(230, 120))
await js(`document.querySelector('.panel.left .section-title .icon-btn[title*="Ctrl+F"]').click()`)
await wait(200)
const p = await at(600, 500)
await ev('mouseMoved', p[0], p[1], false)
await ev('mousePressed', p[0], p[1], true)
await ev('mouseReleased', p[0], p[1], false)
await wait(200)
await undoKey()
check('Ctrl+Z with the search left open, after a click on the canvas', await box(pic.id), [0, 0, 400, 200])

// 6. a paste, Ctrl+Z
const before = await js(`editor.nodes.size`)
await js(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50" fill="#22AA66"/></svg>'); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return 1 })()`)
await wait(500)
const pasted = await js(`editor.nodes.size`)
await undoKey()
check('Ctrl+Z after a paste', [pasted > before, await js(`editor.nodes.size`)], [true, before])

// 7. the colour popover is open (it holds one edit open), another layer is selected from the list and moved
await mcp('set_selection', { ids: [rect.id] })
await wait(400)
await js(`document.querySelector('.panel.right button.swatch').click()`)
await wait(300)
check('a colour popover holds an edit open', await js(`editor.txDepth`), 1)
await js(`editor.setSelection(['${far.id}'])`)
await wait(400)
check('selecting another layer with the popover open closes the popover and its edit', [await js(`editor.txDepth`), await js(`!!document.querySelector('.color-picker, .cp, .colorpicker')`)], [0, false])
await mcp('set_selection', { ids: [rect.id] })
await wait(300)
await drag(await at(100, 350), await at(160, 380))
await undoKey()
check('and Ctrl+Z works after it', await box(rect.id), [0, 300, 200, 100])

// 8. the popover is open and Ctrl+Z is pressed: the edit is closed and the last step is taken back
await drag(await at(100, 350), await at(160, 380))
await js(`document.querySelector('.panel.right button.swatch').click()`)
await wait(300)
await js(`document.querySelector('.canvas-wrap canvas').focus()`)
await undoKey()
check('Ctrl+Z with a colour popover open', [await box(rect.id), await js(`editor.txDepth`)], [[0, 300, 200, 100], 0])

// 9. an edit that was left open by anything at all does not stop undo
await drag(await at(100, 350), await at(160, 380))
await js(`editor.begin()`)
await undoKey()
check('an edit left open is closed by Ctrl+Z, which then takes the last step back', [await box(rect.id), await js(`editor.txDepth`)], [[0, 300, 200, 100], 0])
await js(`editor.commit(); editor.commit()`)
check('a commit with nothing open does no harm', await js(`editor.txDepth`), 0)
await drag(await at(100, 350), await at(160, 380))
await undoKey()
check('and undo keeps recording afterwards', await box(rect.id), [0, 300, 200, 100])

console.log(results.join('\n'))
console.log(results.filter((r) => r.startsWith('FAIL')).length ? 'SOME FAILED' : 'ALL PASSED')
ws.close()
process.exit(0)
