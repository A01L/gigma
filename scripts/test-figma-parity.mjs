// Figma parity, with a real mouse: the name of a rotated frame and renaming it on the canvas, the corner radius dots,
// polygons that keep their corners round, the gradient editor (popover and handles on the canvas), alpha masks and cropped pictures.
// Usage: node scripts/test-figma-parity.mjs [debugPort] [mcpPort] [screenshot.png]   (defaults 9333 / 7331)
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

const proj = await mcp('create_project', { name: 'Figma parity test' })
const frame = await mcp('create_frame', { name: 'Tilted', x: 0, y: 0, width: 400, height: 260, fill: '#FFFFFF' })
const board = await mcp('create_frame', { name: 'Board', x: 0, y: 420, width: 900, height: 420, fill: '#FFFFFF' })
const rect = await mcp('create_rectangle', { parentId: board.id, x: 600, y: 40, width: 240, height: 160, fill: '#D9D9D9' })
const tri = await mcp('create_shape', { kind: 'polygon', parentId: board.id, x: 340, y: 40, width: 200, height: 180 })
// on the left, away from the fill popover that opens beside the panel
const grad = await mcp('create_rectangle', { parentId: board.id, x: 40, y: 40, width: 240, height: 160, fill: '#FF6600' })
await mcp('update_node', { id: frame.id, rotation: 30 })
await mcp('update_node', { id: grad.id, fills: [{ type: 'GRADIENT_LINEAR', angle: 90, stops: [{ position: 0, color: '#FF6600' }, { position: 1, color: '#993D00' }] }] })
await mcp('zoom_to', { ids: [frame.id, board.id] })
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

const paint = () => send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 } })
const mouse = async (type, x, y, extra = {}) => {
  if (type === 'mousePressed') await paint()
  return send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra })
}
const move = (x, y, down = false, extra = {}) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: down ? 'left' : 'none', buttons: down ? 1 : 0, ...extra })
const click = async (x, y, extra = {}) => {
  await move(x, y)
  await mouse('mousePressed', x, y, extra)
  await mouse('mouseReleased', x, y, extra)
  await wait(120)
}
const drag = async (x1, y1, x2, y2, extra = {}) => {
  await move(x1, y1)
  await mouse('mousePressed', x1, y1, extra)
  for (let i = 1; i <= 6; i++) await move(x1 + ((x2 - x1) * i) / 6, y1 + ((y2 - y1) * i) / 6, true, extra)
  await mouse('mouseReleased', x2, y2, extra)
  await wait(150)
}
const key = async (k, code = k, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
}
const type = (text) => send('Input.insertText', { text })
// canvas-local screen point -> page coordinates
const pageXY = (sx, sy) => js(`(() => { const r = document.querySelector('.canvas-wrap canvas').getBoundingClientRect(); return [r.left + ${sx}, r.top + ${sy}] })()`)
const node = (nid, fields) => js(`(() => { const n = editor.nodes.get('${nid}'); return n ? ${fields} : null })()`)
const zoom = await js(`editor.camera.zoom`)

// ================================================================ 1. the name of a rotated frame
const lab = await js(`(() => { const l = canvasView.frameLabels.find((l) => l.id === '${frame.id}'); return l ? { ax: l.ax, ay: l.ay, rot: l.rot, w: l.r.w } : null })()`)
check('the label of a frame turned by 30° is turned with it', lab?.rot, 30)
// the corner the label is pinned to: the top left corner of the frame, turned around its centre
const wantCorner = await js(`(() => { const w = editor.world('${frame.id}'), c = editor.camera, t = -30 * Math.PI / 180, cx = w.x + w.w / 2, cy = w.y + w.h / 2, dx = w.x - cx, dy = w.y - cy; return [Math.round((cx + dx * Math.cos(t) - dy * Math.sin(t)) * c.zoom + c.x), Math.round((cy + dx * Math.sin(t) + dy * Math.cos(t)) * c.zoom + c.y)] })()`)
check('it is pinned to the turned top left corner', [Math.round(lab?.ax), Math.round(lab?.ay)], wantCorner)
// a point in the middle of the label: 12 px along the turned top edge, 10 px above it
const t30 = (-30 * Math.PI) / 180
const inLabel = (lx, ly) => [lab.ax + lx * Math.cos(t30) - ly * Math.sin(t30), lab.ay + lx * Math.sin(t30) + ly * Math.cos(t30)]
const [lx, ly] = await pageXY(...inLabel(12, -10))
await click(lx, ly)
check('a click on the turned label selects the frame', await js(`editor.selection`), [frame.id])
// where the label would be if it did not turn: nothing there any more
const [ox, oy] = await pageXY(...(await js(`(() => { const w = editor.world('${frame.id}'), c = editor.camera; return [w.x * c.zoom + c.x + 12, w.y * c.zoom + c.y - 10] })()`)))
await mcp('set_selection', { ids: [] })
await click(ox, oy)
check('nothing is left where an unturned label would be', await js(`editor.selection`), [])
// double click: rename in place
await move(lx, ly)
await mouse('mousePressed', lx, ly)
await mouse('mouseReleased', lx, ly)
await mouse('mousePressed', lx, ly, { clickCount: 2 })
await mouse('mouseReleased', lx, ly, { clickCount: 2 })
await wait(250)
check('a double click on the label opens a field with the name', await js(`(() => { const i = document.querySelector('input.label-editor'); return i ? [i.value, document.activeElement === i, /rotate\\(-30deg\\)/.test(i.style.transform)] : null })()`), ['Tilted', true, true])
await type('Hero screen')
await key('Enter', 'Enter', 13)
await wait(200)
check('Enter renames the frame', await node(frame.id, 'n.name'), 'Hero screen')
check('the field is gone', await js(`!!document.querySelector('input.label-editor')`), false)
await key('z', 'KeyZ', 90) // not an undo: just a key, the canvas has the keyboard again
check('the canvas has the keyboard back', await js(`document.activeElement?.tagName`), 'CANVAS')

// ================================================================ 2. corner radius on the canvas
await mcp('set_selection', { ids: [rect.id] })
await wait(200)
const dots = await js(`(() => { const n = editor.nodes.get('${rect.id}'); const b = canvasView.toScreen(editor.world(n.id)); return canvasView.radiusDots(n, b) })()`)
check('a rectangle shows a dot in each corner', dots?.length, 4)
let [dx, dy] = await pageXY(dots[0].x, dots[0].y)
// 30 layer pixels along the diagonal
await drag(dx, dy, dx + 30 * zoom, dy + 30 * zoom)
check('dragging a dot rounds every corner', await node(rect.id, '[n.cornerRadius, n.cornerRadii ?? null]'), [30, null])
// squeeze it: the radius is kept, the corners become half circles
await mcp('update_node', { id: rect.id, height: 40 })
check('a squeezed rectangle keeps its radius and draws half circles', await js(`(async () => { const n = editor.nodes.get('${rect.id}'); const { cornerRadiiOf } = await import('/editor/render.ts'); return [n.cornerRadius, cornerRadiiOf(n, { w: n.width, h: n.height })] })()`), [30, [20, 20, 20, 20]])
await mcp('update_node', { id: rect.id, height: 160 })
// Alt: one corner only
await mcp('set_selection', { ids: [rect.id] })
await wait(150)
const dots2 = await js(`(() => { const n = editor.nodes.get('${rect.id}'); return canvasView.radiusDots(n, canvasView.toScreen(editor.world(n.id))) })()`)
;[dx, dy] = await pageXY(dots2[1].x, dots2[1].y)
await drag(dx, dy, dx - 20 * zoom, dy + 20 * zoom, { modifiers: 1 })
check('Alt changes only the corner that is held', await node(rect.id, 'n.cornerRadii'), [30, 50, 30, 30])
// the limit: half of the shorter side
const dots3 = await js(`(() => { const n = editor.nodes.get('${rect.id}'); return canvasView.radiusDots(n, canvasView.toScreen(editor.world(n.id))) })()`)
;[dx, dy] = await pageXY(dots3[0].x, dots3[0].y)
await drag(dx, dy, dx + 300 * zoom, dy + 300 * zoom)
check('the radius stops at half of the shorter side', await node(rect.id, '[n.cornerRadius, n.cornerRadii ?? null]'), [80, null])
await mcp('set_selection', { ids: [] })
await js(`(async () => { for (let i = 0; i < 4; i++) editor.undo() })()`)

// ---- a polygon
check('a polygon remembers what it is', await node(tri.id, '[n.shape, n.pathBox]'), [{ kind: 'POLYGON', count: 3 }, { w: 200, h: 180 }])
await mcp('set_selection', { ids: [tri.id] })
await wait(200)
const pd = await js(`(() => { const n = editor.nodes.get('${tri.id}'); return canvasView.radiusDots(n, canvasView.toScreen(editor.world(n.id))) })()`)
check('a polygon shows one dot under its top', pd?.length, 1)
;[dx, dy] = await pageXY(pd[0].x, pd[0].y)
await drag(dx, dy, dx, dy + 24 * zoom)
const triR = await node(tri.id, 'n.cornerRadius')
check('dragging it rounds the corners of the polygon', triR, 24)
check('the path has curves now', await node(tri.id, '(n.path.match(/C/g) || []).length'), 3)
// squeeze the polygon: the path is built anew at the new size, corners are arcs of a circle, not squashed ones
await mcp('update_node', { id: tri.id, height: 60 })
const squeezed = await js(`(async () => {
  const n = editor.nodes.get('${tri.id}')
  const { parsePath } = await import('/editor/svgpath.ts')
  // every corner is one cubic between two points on the edges: for a circular arc both ends are equally far from the corner
  const { shapePoints } = await import('/editor/shapes.ts')
  const pts = shapePoints(n.shape, n.width, n.height)
  const segs = parsePath(n.path)
  let prev = null, ok = true, i = 0
  for (const s of segs) {
    if (s.c === 'C') { const b = pts[i++]; const d1 = Math.hypot(prev[0] - b[0], prev[1] - b[1]); const d2 = Math.hypot(s.p[4] - b[0], s.p[5] - b[1]); if (Math.abs(d1 - d2) > 0.01) ok = false }
    if (s.p.length) prev = [s.p[s.p.length - 2], s.p[s.p.length - 1]]
  }
  return [n.pathBox, ok, i]
})()`)
check('a squeezed polygon is drawn anew with round corners', squeezed, [{ w: 200, h: 60 }, true, 3])
await mcp('update_node', { id: tri.id, height: 180 })
// the number of sides in the panel
const countField = await js(`(() => { const lab = [...document.querySelectorAll('.panel.right .sublabel, .panel.right div')].find((d) => d.children.length === 0 && /^(Count|Количество)$/.test(d.textContent.trim())); const inp = lab?.parentElement?.querySelector('input'); if (!inp) return null; const r = inp.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
check('the panel has a Count field for a polygon', !!countField, true)
if (countField) {
  await click(countField[0], countField[1])
  await key('a', 'KeyA', 65)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await type('6')
  await key('Enter', 'Enter', 13)
  await wait(200)
  check('typing 6 makes a hexagon', await node(tri.id, '[n.shape.count, (n.path.match(/C/g) || []).length]'), [6, 6])
}
// editing its points turns it into a plain path
await js(`canvasView.vedit.start('${tri.id}')`)
check('editing the points makes it a plain path', await node(tri.id, '[n.shape ?? null, n.cornerRadius ?? null, n.path.length > 20]'), [null, null, true])
await js(`canvasView.vedit.stop()`)

// ================================================================ 3. gradient
await mcp('set_selection', { ids: [grad.id] })
await wait(250)
const sw = await js(`(() => { const s = [...document.querySelectorAll('.panel.right button.swatch')].find((b) => /gradient/.test(b.firstElementChild.style.background)); if (!s) return null; const r = s.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
check('the fill row shows the gradient', !!sw, true)
check('and names its kind', /^(Linear|Линейный)$/.test(await js(`document.querySelector('.panel.right .paint-kind')?.textContent`)), true)
await click(sw[0], sw[1])
await wait(250)
check('the popover opens with the bar of stops', await js(`[!!document.querySelector('.cpick.grad'), document.querySelectorAll('.cpick-thumb').length, document.querySelectorAll('.cpick-stop').length]`), [true, 2, 2])
check('the canvas shows the handles of this gradient', await js(`editor.paintEdit && [editor.paintEdit.id === '${grad.id}', editor.paintEdit.index, editor.paintEdit.stop]`), [true, 0, 0])
// a press on the bar adds a stop in the colour the gradient has there
const bar = await js(`(() => { const r = document.querySelector('.cpick-bar').getBoundingClientRect(); return [r.left, r.top, r.width, r.height] })()`)
await click(bar[0] + 10 + (bar[2] - 20) * 0.5, bar[1] + bar[3] - 8)
check('a press on the bar adds a stop in the middle', await node(grad.id, `n.fills[0].stops.map((s) => [s.position, Math.round(s.color.r * 255), Math.round(s.color.g * 255)])`), [[0, 255, 102], [1, 153, 61], [0.5, 204, 82]])
check('the new stop is selected', await js(`[editor.paintEdit.stop, document.querySelectorAll('.cpick-stop').length, [...document.querySelectorAll('.cpick-stop')].findIndex((r) => r.classList.contains('on'))]`), [2, 3, 1])
// drag the thumb of the new stop
await drag(bar[0] + 10 + (bar[2] - 20) * 0.5, bar[1] + 10, bar[0] + 10 + (bar[2] - 20) * 0.25, bar[1] + 10)
check('its thumb drags it along the bar', await node(grad.id, 'n.fills[0].stops[2].position'), 0.25)
// the handles on the canvas
const gp = await js(`(() => { const g = canvasView.gradEdit(); const p = canvasView.gradPoints(g); return { p0: p.p0, p1: p.p1, stops: p.stops } })()`)
check('the line runs from the left edge to the right one (90°)', [Math.round(gp.p1.x - gp.p0.x) > 0, Math.round(gp.p1.y - gp.p0.y)], [true, 0])
let [ex, ey] = await pageXY(gp.p1.x, gp.p1.y)
const gb = await js(`canvasView.toScreen(editor.world('${grad.id}'))`)
const [bx, by] = await pageXY(gb.x + gb.w, gb.y + gb.h)
await drag(ex, ey, bx, by)
check('the popover is still open after a drag on the canvas', await js(`!!document.querySelector('.cpick.grad')`), true)
check('dragging the end handle moves the end of the gradient', await node(grad.id, 'n.fills[0].handles && [n.fills[0].handles[0], n.fills[0].handles[1]]'), [{ x: 0, y: 0.5 }, { x: 1, y: 1 }])
// drag a stop along the line on the canvas
const gp2 = await js(`(() => { const g = canvasView.gradEdit(); const p = canvasView.gradPoints(g); return { p0: p.p0, p1: p.p1, stops: p.stops } })()`)
const chip = gp2.stops[2]
const [c1x, c1y] = await pageXY(chip.x, chip.y)
const [c2x, c2y] = await pageXY(chip.x + (gp2.p1.x - gp2.p0.x) * 0.5, chip.y + (gp2.p1.y - gp2.p0.y) * 0.5)
await drag(c1x, c1y, c2x, c2y)
check('a stop is dragged along the line on the canvas', await node(grad.id, 'n.fills[0].stops[2].position'), 0.75)
// a press on the line adds a stop
const [nx, ny] = await pageXY(gp2.p0.x + (gp2.p1.x - gp2.p0.x) * 0.4, gp2.p0.y + (gp2.p1.y - gp2.p0.y) * 0.4)
await click(nx, ny)
check('a press on the line adds a stop there', await node(grad.id, '[n.fills[0].stops.length, n.fills[0].stops[3].position]'), [4, 0.4])
// Delete removes the selected stop, not the layer
await key('Delete', 'Delete', 46)
await wait(150)
check('Delete removes the selected stop and keeps the layer', await node(grad.id, 'n.fills[0].stops.length'), 3)
// flip and rotate
const before = await node(grad.id, 'n.fills[0].stops.map((s) => s.position)')
await js(`document.querySelectorAll('.cpick-grad-top .cpick-ico')[0].click()`)
await wait(100)
check('flip reverses the stops', await node(grad.id, 'n.fills[0].stops.map((s) => s.position).sort()'), before.map((p) => Math.round((1 - p) * 100) / 100).sort())
// another kind, and back to a colour: the popover stays
await js(`(async () => { const { handlesOf } = await import('/editor/gradient.ts'); window.__h = handlesOf })()`)
const setKind = (kind) => js(`(() => { const n = editor.nodes.get('${grad.id}'); return 1 })()`)
await setKind()
// the menu of kinds, through the keyboard-free path: open it and pick Radial
const sel = await js(`(() => { const r = document.querySelector('.cpick-grad-type .gsel').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
await click(sel[0], sel[1])
await wait(200)
const radialItem = await js(`(() => { const it = [...document.querySelectorAll('.gsel-menu *, .gsel-pop *')].find((e) => e.children.length === 0 && /^(Radial|Радиальный)$/.test(e.textContent.trim())); if (!it) return null; const r = it.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
check('the menu of kinds lists Radial', !!radialItem, true)
if (radialItem) {
  await click(radialItem[0], radialItem[1])
  await wait(200)
  check('the gradient becomes radial and the popover stays open', [await node(grad.id, 'n.fills[0].type'), await js(`!!document.querySelector('.cpick.grad')`), /^(Radial|Радиальный)$/.test(await js(`document.querySelector('.panel.right .paint-kind')?.textContent`))], ['GRADIENT_RADIAL', true, true])
  check('a radial one spreads from the middle of the old line', await node(grad.id, 'n.fills[0].handles[0]'), { x: 0.5, y: 0.75 })
  check('a radial gradient has a width handle on the canvas', await js(`(() => { const g = canvasView.gradEdit(); const p = canvasView.gradPoints(g); return [p.linear, Math.round(Math.hypot(p.p2.x - p.p0.x, p.p2.y - p.p0.y)) === Math.round(Math.hypot(p.p1.x - p.p0.x, p.p1.y - p.p0.y))] })()`), [false, true])
}
await js(`document.querySelector('.cpick-types button').click()`)
await wait(200)
check('Solid turns it into a colour, the popover still open', [await node(grad.id, 'n.fills[0].type'), await js(`[!!document.querySelector('.cpick'), !!document.querySelector('.cpick.grad')]`), await js(`editor.paintEdit`)], ['SOLID', [true, false], null])
await js(`document.querySelectorAll('.cpick-types button')[1].click()`)
await wait(200)
check('Gradient turns the colour into a gradient again', [await node(grad.id, 'n.fills[0].type'), await js(`!!document.querySelector('.cpick.grad')`)], ['GRADIENT_LINEAR', true])
await key('Escape', 'Escape', 27)
await wait(200)
check('Escape closes the popover and the handles go', [await js(`!!document.querySelector('.cpick')`), await js(`editor.paintEdit`)], [false, null])
check('the layer is still there', await node(grad.id, 'n.type'), 'RECTANGLE')

// ================================================================ 4. alpha mask and cropped picture (drawn, then read back)
const pix = await js(`(async () => {
  const { backend } = await import('/backend.ts')
  const { renderToCanvas } = await import('/editor/render.ts')
  const png = async (draw, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d')); const b = await new Promise((r) => c.toBlob(r, 'image/png')); return backend.blob.put(new Uint8Array(await b.arrayBuffer()), 'image/png') }
  // a black disc on a transparent ground: the mask
  const disc = await png((g) => { g.fillStyle = '#000'; g.beginPath(); g.arc(50, 50, 40, 0, Math.PI * 2); g.fill() }, 100, 100)
  // left half red, right half blue: the picture to crop
  const halves = await png((g) => { g.fillStyle = '#ff0000'; g.fillRect(0, 0, 50, 100); g.fillStyle = '#0000ff'; g.fillRect(50, 0, 50, 100) }, 100, 100)
  let ids
  editor.act(() => {
    const g = editor.addNode({ type: 'GROUP', name: 'Mask group', x: 0, y: 1000, width: 100, height: 100 })
    editor.addNode({ type: 'RECTANGLE', name: 'logo', parentId: g.id, x: 0, y: 0, width: 100, height: 100, isMask: true, fills: [{ type: 'IMAGE', imageHash: disc, scaleMode: 'FILL' }] })
    editor.addNode({ type: 'RECTANGLE', name: 'white', parentId: g.id, x: 0, y: 0, width: 100, height: 100, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }] })
    // the box shows the right half of the picture: u = 0.5 * x + 0.5
    const crop = editor.addNode({ type: 'RECTANGLE', name: 'crop', x: 200, y: 1000, width: 100, height: 100, fills: [{ type: 'IMAGE', imageHash: halves, scaleMode: 'STRETCH', transform: [0.5, 0, 0, 1, 0.5, 0] }] })
    // the box shows the left third and a strip beyond the picture: u = x - 0.5
    const off = editor.addNode({ type: 'RECTANGLE', name: 'off', x: 400, y: 1000, width: 100, height: 100, fills: [{ type: 'IMAGE', imageHash: halves, scaleMode: 'STRETCH', transform: [1, 0, 0, 1, -0.5, 0] }] })
    ids = [g.id, crop.id, off.id]
  })
  const read = async (id, pts) => { const c = await renderToCanvas(editor, [id], 1); const g = c.getContext('2d'); return pts.map(([x, y]) => [...g.getImageData(x, y, 1, 1).data]) }
  return { mask: await read(ids[0], [[50, 50], [5, 5], [95, 50]]), crop: await read(ids[1], [[10, 50], [90, 50]]), off: await read(ids[2], [[10, 50], [75, 50]]), ids }
})()`)
check('a picture used as a mask cuts by its alpha: white inside the disc, nothing outside', pix?.mask, [[255, 255, 255, 255], [0, 0, 0, 0], [0, 0, 0, 0]])
check('a cropped picture shows the part its matrix names', pix?.crop, [[0, 0, 255, 255], [0, 0, 255, 255]])
check('and nothing where the crop reaches past the picture', pix?.off, [[0, 0, 0, 0], [255, 0, 0, 255]])
// the same through the SVG export
const svg = await js(`(async () => { const { nodesToSvg } = await import('/editor/svg.ts'); const s = await nodesToSvg(editor, ['${pix?.ids?.[0]}'], false); return [/<mask id="a\\d+"[^>]*mask-type/.test(s), /mask="url\\(#a\\d+\\)"/.test(s)] })()`)
check('the SVG export writes an alpha mask', svg, [true, true])

// ================================================================ 5. kinds of gradient are drawn where their handles say
const gpix = await js(`(async () => {
  const { renderToCanvas } = await import('/editor/render.ts')
  const red = { r: 1, g: 0, b: 0, a: 1 }, blue = { r: 0, g: 0, b: 1, a: 1 }
  const stops = [{ position: 0, color: red }, { position: 1, color: blue }]
  const mk = (type, handles, x) => editor.addNode({ type: 'RECTANGLE', x, y: 1300, width: 100, height: 100, fills: [{ type, stops, handles }] }).id
  let ids
  editor.act(() => { ids = [
    mk('GRADIENT_LINEAR', [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }], 0),
    mk('GRADIENT_RADIAL', [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }], 200),
    mk('GRADIENT_DIAMOND', [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }], 400),
    mk('GRADIENT_ANGULAR', [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }], 600)
  ] })
  const read = async (id, pts) => { const c = await renderToCanvas(editor, [id], 1); const g = c.getContext('2d'); return pts.map(([x, y]) => { const d = g.getImageData(x, y, 1, 1).data; return d[0] > d[2] ? 'red' : 'blue' }) }
  return [
    await read(ids[0], [[5, 50], [95, 50]]),
    // on the diagonal a circle is still young where a diamond is already old
    await read(ids[1], [[50, 50], [50, 3], [66, 66]]),
    await read(ids[2], [[50, 50], [50, 3], [66, 66]]),
    // angular: starts at the end handle and goes round clockwise, so just below the handle it is young, just above it old
    await read(ids[3], [[90, 60], [90, 40]])
  ]
})()`)
check('linear, radial, diamond and angular gradients are drawn by their handles', gpix, [['red', 'blue'], ['red', 'blue', 'red'], ['red', 'blue', 'blue'], ['red', 'blue']])

if (shot) {
  await mcp('zoom_to', { ids: [frame.id, board.id] })
  await mcp('set_selection', { ids: [rect.id] })
  await wait(300)
  const s = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(shot, Buffer.from(s.data, 'base64'))
}
console.log(results.join('\n'))
console.log(results.some((r) => r.startsWith('FAIL')) ? '\nFAILED' : '\nALL PASSED')
ws.close()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
