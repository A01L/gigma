// The text tool, with a real mouse: a click places text, a drag makes a text box, both come filled with Lorem ipsum.
// Usage: node scripts/test-text-tool.mjs [debugPort] [mcpPort] [screenshot.png]   (defaults 9333 / 7331)
import { writeFileSync } from 'node:fs'
const port = process.argv[2] ?? '9333'
const mcpPort = process.argv[3] ?? '7331'
const shot = process.argv[4]
let mid = 0
async function mcp(name, args = {}) {
  const r = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++mid, method: 'tools/call', params: { name, arguments: args } }) })
  const j = await r.json()
  if (j.error || j.result?.isError) throw new Error(name + ': ' + JSON.stringify(j.error ?? j.result.content))
  return JSON.parse(j.result.content[0].text)
}
const results = []
const check = (label, got, want) => results.push(`${JSON.stringify(got) === JSON.stringify(want) ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(want) ? '' : '  want ' + JSON.stringify(want)}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const proj = await mcp('create_project', { name: 'Text tool test' })
const frame = await mcp('create_frame', { name: 'Card', x: 0, y: 0, width: 600, height: 500, fill: '#FFFFFF' })
await mcp('zoom_to', { ids: [frame.id] })
await mcp('set_selection', { ids: [] })

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
await wait(2300) // the AI cursor leaves, the canvas settles

// a real mouse: these go through the browser's own input pipeline (focus changes and all), unlike synthetic events
// a covered window draws no frames, and without a frame a press is not routed to the page: a tiny screenshot makes it draw one
const paint = () => send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 } })
const mouse = async (type, x, y, extra = {}) => {
  if (type === 'mousePressed') await paint()
  return send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra })
}
const move = (x, y, down = false) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: down ? 'left' : 'none', buttons: down ? 1 : 0 })
const key = async (k, code = k, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
}
// screen position (page coordinates) of a world point
const at = (wx, wy) => js(`(() => { const r = document.querySelector('.canvas-wrap canvas').getBoundingClientRect(), c = editor.camera; return [r.left + ${wx} * c.zoom + c.x, r.top + ${wy} * c.zoom + c.y] })()`)
const texts = () => js(`[...editor.nodes.values()].filter((n) => n.type === 'TEXT').map((n) => ({ id: n.id, chars: n.characters, mode: n.textAutoResize ?? 'WIDTH_AND_HEIGHT', x: Math.round(editor.world(n.id).x), y: Math.round(editor.world(n.id).y), w: Math.round(n.width), h: Math.round(n.height), parent: n.parentId }))`)
// the Text button of the toolbar, pressed with the mouse like a person does
const pickText = async () => {
  const [x, y] = await js(`(() => { const b = [...document.querySelectorAll('.tool-group > .icon-btn')].find((b) => /  T$/.test(b.dataset.tip)); const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
  await move(x, y)
  await mouse('mousePressed', x, y)
  await mouse('mouseReleased', x, y)
  await wait(150)
}

// ---- a click ----
await pickText()
check('the text tool is on', await js(`editor.tool`), 'text')
const [cx, cy] = await at(60, 60)
await move(cx, cy)
await mouse('mousePressed', cx, cy)
await mouse('mouseReleased', cx, cy)
await wait(400)
let t = await texts()
check('a click places a text', t.length, 1)
check('it is filled with Lorem ipsum', t[0]?.chars, 'Lorem ipsum')
check('at the click, inside the frame under it', [t[0]?.x, t[0]?.y > 40 && t[0]?.y < 62, t[0]?.parent], [60, true, frame.id])
check('it grows with its text', t[0]?.mode, 'WIDTH_AND_HEIGHT')
check('it is being edited, all of it selected', await js(`(() => { const a = document.querySelector('textarea.text-editor'); return [editor.editingTextId === '${t[0]?.id}', document.activeElement === a, a?.selectionStart, a?.selectionEnd] })()`), [true, true, 0, 11])
check('the tool goes back to Move', await js(`editor.tool`), 'move')
// typing replaces the placeholder
await send('Input.insertText', { text: 'Hello' })
await wait(150)
check('typing replaces the placeholder', (await texts())[0].chars, 'Hello')
await key('Escape', 'Escape', 27)
await wait(250)
check('Escape ends the editing and keeps the text', [await js(`editor.editingTextId`), (await texts()).map((x) => x.chars)], [null, ['Hello']])

// ---- a click, then leaving without typing: the placeholder stays ----
await pickText()
const [c2x, c2y] = await at(60, 140)
await move(c2x, c2y)
await mouse('mousePressed', c2x, c2y)
await mouse('mouseReleased', c2x, c2y)
await wait(400)
await key('Escape', 'Escape', 27)
await wait(250)
t = await texts()
check('left as it is, the Lorem ipsum stays', t.map((x) => x.chars).sort(), ['Hello', 'Lorem ipsum'])

// ---- a drag makes a box of that size, filled ----
await pickText()
const [ax, ay] = await at(60, 220)
const [bx, by] = await at(360, 380)
await move(ax, ay)
await mouse('mousePressed', ax, ay)
await move((ax + bx) / 2, (ay + by) / 2, true)
check('nothing is created until the mouse is released', (await texts()).length, 2)
await move(bx, by, true)
if (shot) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(shot.replace(/\.png$/, '-drag.png'), Buffer.from(r.data, 'base64'))
}
await mouse('mouseReleased', bx, by)
await wait(450)
t = await texts()
const box = t.find((x) => x.chars.length > 20)
check('a drag makes a text box of that size', [box?.x, box?.y, box?.w, box?.h, box?.mode], [60, 220, 300, 160, 'NONE'])
check('the box is filled with Lorem ipsum', [box?.chars.startsWith('Lorem ipsum dolor sit amet'), box?.chars.length > 120], [true, true])
check('the text fits the box and fills most of it', await js(`(() => { const l = canvasView.textLayoutOf('${box?.id}'); return [l.height <= 160, l.height >= 160 - l.lineHeight * 1.01] })()`), [true, true])
check('the box is being edited too', await js(`editor.editingTextId`), box?.id)
if (shot) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(shot, Buffer.from(r.data, 'base64'))
}
await key('Escape', 'Escape', 27)
await wait(250)
// a drag upwards and to the left works the same
await pickText()
const [dx, dy] = await at(560, 480)
const [ex, ey] = await at(420, 420)
await move(dx, dy)
await mouse('mousePressed', dx, dy)
await move(ex, ey, true)
await mouse('mouseReleased', ex, ey)
await wait(450)
await key('Escape', 'Escape', 27)
await wait(250)
t = await texts()
const small = t.find((x) => x.x === 420 && x.y === 420)
check('dragging up and left gives the same box', [small?.w, small?.h, small?.mode, small?.chars.startsWith('Lorem')], [140, 60, 'NONE', true])
// ---- one undo step each ----
await js(`editor.undo(), 1`)
check('one undo removes the last text', (await texts()).length, 3)
// ---- double click on an existing text still edits it ----
const hello = (await texts()).find((x) => x.chars === 'Hello')
const [hx, hy] = await at(hello.x + 8, hello.y + 8)
await move(hx, hy)
await mouse('mousePressed', hx, hy)
await mouse('mouseReleased', hx, hy)
await mouse('mousePressed', hx, hy, { clickCount: 2 })
await mouse('mouseReleased', hx, hy, { clickCount: 2 })
await wait(400)
check('a double click edits an existing text', await js(`editor.editingTextId`), hello.id)
await send('Input.insertText', { text: 'Hello again' })
await key('Escape', 'Escape', 27)
await wait(250)
check('and its new text is kept', (await texts()).find((x) => x.id === hello.id).chars, 'Hello again')

console.log(results.join('\n'))
console.log(results.some((r) => r.startsWith('FAIL')) ? 'SOME FAILED' : `all ${results.length} passed`)
ws.close()
