// Text -> outlines, the pen leaving for another tool, and a stroke turned into a shape.
// Usage: node scripts/test-outline.mjs [debugPort] [mcpPort] [screenshot.png]   (defaults 9333 / 7331)
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const check = (label, got, want) => results.push(`${same(got, want) ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${same(got, want) ? '' : '  want ' + JSON.stringify(want)}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const proj = await mcp('create_project', { name: 'Outline test' })
const frame = await mcp('create_frame', { name: 'Sheet', x: 0, y: 0, width: 900, height: 700, fill: '#FFFFFF' })
const mk = (args) => mcp('create_text', { parentId: frame.id, fill: '#111111', ...args })
const t1 = await mk({ x: 40, y: 40, text: 'Hamburgefonts 123', fontFamily: 'Arial', fontSize: 48, fontWeight: 700 })
const t2 = await mk({ x: 40, y: 140, text: 'Привет, Gigma! Обводка', fontFamily: 'Segoe UI', fontSize: 36 })
const t3 = await mk({ x: 40, y: 220, width: 300, text: 'Two lines of text that wrap inside a box and sit in its centre', fontFamily: 'Georgia', fontSize: 22 })
const t4 = await mk({ x: 480, y: 220, text: 'Turned text', fontFamily: 'Arial', fontSize: 40 })
await mcp('update_node', { id: t3.id, textAlign: 'CENTER' }).catch(() => {})
await mcp('update_node', { id: t4.id, rotation: 25 })
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
await wait(2300)
const paint = () => send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 } })
const mouse = async (type, x, y) => {
  if (type === 'mousePressed') await paint()
  return send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })
}
const move = (x, y, down = false) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: down ? 'left' : 'none', buttons: down ? 1 : 0 })
const click = async (x, y) => {
  await move(x, y)
  await mouse('mousePressed', x, y)
  await mouse('mouseReleased', x, y)
  await wait(120)
}
const key = async (k, code = k, vk, modifiers = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
}
const at = (wx, wy) => js(`(() => { const r = document.querySelector('.canvas-wrap canvas').getBoundingClientRect(), c = editor.camera; return [r.left + ${wx} * c.zoom + c.x, r.top + ${wy} * c.zoom + c.y] })()`)

// ================================================================ 1. text -> outlines
// the frame is drawn before and after; the two pictures must be the same but for the edges of the glyphs
const snap = `(async () => { const { renderToCanvas } = await import('/editor/render.ts'); const c = await renderToCanvas(editor, ['${frame.id}'], 2); return c.getContext('2d').getImageData(0, 0, c.width, c.height) })()`
await js(`(async () => { window.__before = await ${snap} })()`)
const kinds = () => js(`[${[t1, t2, t3, t4].map((t) => `'${t.id}'`).join(',')}].map((i) => editor.nodes.get(i)?.type)`)
await mcp('set_selection', { ids: [t1.id] })
// Ctrl+Alt+O, the shortcut of Figma
await js(`document.querySelector('.canvas-wrap canvas').focus()`)
await key('o', 'KeyO', 79, 3)
await wait(1500)
check('Ctrl+Alt+O turns a text into a vector', (await kinds())[0], 'VECTOR')
check('the layer keeps its name, place in the list and colour', await js(`(() => { const n = editor.nodes.get('${t1.id}'); return [n.name, n.parentId === '${frame.id}', n.fills[0].color.r < 0.1, n.characters ?? null, !!n.path && n.path.length > 500] })()`), ['Hamburgefonts 123', true, true, null, true])
await mcp('outline_stroke', { ids: [t2.id, t3.id, t4.id] })
await wait(300)
check('the MCP tool outlines texts too', await kinds(), ['VECTOR', 'VECTOR', 'VECTOR', 'VECTOR'])
check('a turned text keeps its angle', await js(`editor.nodes.get('${t4.id}').rotation`), 25)
const diff = await js(`(async () => {
  const a = window.__before, b = await ${snap}
  // how much ink there is and where its middle lies, per text (the sheet is cut into the bands the four texts stand in)
  const bands = [[0, 0, 1800, 240], [0, 240, 1800, 420], [0, 420, 900, 1000], [900, 300, 1800, 1000]]
  const stat = (img, [x1, y1, x2, y2]) => { let n = 0, sx = 0, sy = 0; for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) { const v = 255 - img.data[(y * img.width + x) * 4]; n += v; sx += v * x; sy += v * y } return [n / 255, sx / n, sy / n] }
  return bands.map((r) => { const p = stat(a, r), q = stat(b, r); return { ink: Math.round(p[0]), ratio: Math.round((q[0] / p[0]) * 1000) / 1000, dx: Math.round((q[1] - p[1]) * 100) / 100, dy: Math.round((q[2] - p[2]) * 100) / 100 } })
})()`)
// the picture is at 2x: the outlines must carry the same amount of ink (within 4%) with its middle within one pixel of the text's
for (const [i, d] of diff.entries()) console.log('   text', i + 1, JSON.stringify(d))
check('the outlines carry the same ink as the texts did, in the same place', diff.map((d) => d.ink > 2000 && Math.abs(d.ratio - 1) < 0.04 && Math.abs(d.dx) <= 1 && Math.abs(d.dy) <= 1), [true, true, true, true])
check('one undo brings a text back', await js(`(() => { editor.undo(); const n = editor.nodes.get('${t4.id}'); const r = [n.type, n.characters]; editor.redo(); return r })()`), ['TEXT', 'Turned text'])

// ================================================================ 2. the pen: another tool keeps the path
await mcp('set_selection', { ids: [] })
await js(`editor.setTool('pen')`)
const pts = [[520, 420], [600, 380], [700, 460], [640, 560]]
for (const [x, y] of pts.slice(0, 3)) {
  const [sx, sy] = await at(x, y)
  await click(sx, sy)
}
// the pointer moves on: the rubber band follows it
const [hx, hy] = await at(pts[3][0], pts[3][1])
await move(hx, hy)
check('while drawing, the path follows the pointer', await js(`[!!canvasView.pen, canvasView.pen?.pts.length]`), [true, 3])
// V: the move tool
await key('v', 'KeyV', 86)
await wait(200)
check('picking another tool ends the drawing', await js(`[editor.tool, !!canvasView.pen]`), ['move', false])
const path = await js(`(() => { const n = editor.nodes.get(editor.selection[0]); return n ? { type: n.type, pts: (n.path.match(/[ML]/g) || []).length, w: Math.round(n.width), h: Math.round(n.height), stroke: n.strokes[0]?.weight, fills: n.fills.length } : null })()`)
check('what was drawn became a vector with its three points', path, { type: 'VECTOR', pts: 3, w: 180, h: 80, stroke: 1, fills: 0 })
await move(hx + 40, hy + 30)
check('nothing follows the pointer any more', await js(`!!canvasView.pen`), false)
// the same when the tool is picked in the toolbar, and a tool other than Move stays chosen
await js(`editor.setTool('pen')`)
for (const [x, y] of [[100, 420], [200, 520]]) {
  const [sx, sy] = await at(x, y)
  await click(sx, sy)
}
await js(`editor.setTool('rect')`)
await wait(150)
check('leaving for the rectangle tool keeps the path and the rectangle tool', await js(`[editor.tool, !!canvasView.pen, editor.nodes.get(editor.selection[0])?.type]`), ['rect', false, 'VECTOR'])
await js(`editor.setTool('move')`)
// one point is not a path
await js(`editor.setTool('pen')`)
const before = await js(`editor.nodes.size`)
const [ox, oy] = await at(300, 600)
await click(ox, oy)
await key('v', 'KeyV', 86)
check('a single point leaves nothing behind', await js(`[editor.nodes.size, !!canvasView.pen]`), [before, false])

// ================================================================ 3. the stroke of that path becomes a shape
const pathId = await js(`[...editor.nodes.values()].find((n) => n.type === 'VECTOR' && Math.round(n.width) === 180 && Math.round(n.height) === 80).id`)
await mcp('update_node', { id: pathId, strokes: [{ color: '#0D99FF', weight: 24, align: 'CENTER' }] })
for (const cap of ['NONE', 'ROUND', 'SQUARE']) {
  const made = await js(`(async () => {
    const src = editor.nodes.get('${pathId}')
    let copy
    const { id: _i, order: _o, ...rest } = structuredClone(src)
    editor.act(() => { copy = editor.addNode({ ...rest, strokeCap: '${cap}' }) })
    editor.setSelection([copy.id])
    const { layerActions } = await import('/ui/layerActions.ts')
    await layerActions.outlineStroke()
    const n = editor.nodes.get(editor.selection[0])
    const w = editor.world(n.id)
    const res = { type: n.type, closed: /z/i.test(n.path), strokes: n.strokes.length, fill: Math.round(n.fills[0].color.b * 255), w: Math.round(w.w), h: Math.round(w.h), gone: !editor.nodes.has(copy.id) }
    editor.act(() => editor.deleteNode(n.id))
    return res
  })()`)
  // the path is 180 x 80; butt caps add nothing along the path, round and square caps add half the weight at each end,
  // and the miter of the corner in the middle reaches out past the path
  if (typeof made === 'string') console.log(made)
  check(`outline stroke, ${cap} caps: a filled closed shape in the colour of the stroke`, [made.type, made.closed, made.strokes, made.fill, made.gone], ['VECTOR', true, 0, 255, true])
  console.log('   ', cap, 'size', made.w, 'x', made.h)
}
if (shot) {
  await mcp('zoom_to', { ids: [frame.id] })
  await wait(300)
  const s = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(shot, Buffer.from(s.data, 'base64'))
}
console.log(results.join('\n'))
console.log(results.some((r) => r.startsWith('FAIL')) ? '\nFAILED' : '\nALL PASSED')
ws.close()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
