// Point editing of vectors (double click), as in Figma: drag points and handles, add, delete, smooth, undo.
// Usage: node scripts/test-vector-edit.mjs [debugPort] [mcpPort] [screenshot.png]   (defaults 9333 / 7331)
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
const check = (label, got, want) => (process.env.TRACE && console.error(label), results).push(`${JSON.stringify(got) === JSON.stringify(want) ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(want) ? '' : '  want ' + JSON.stringify(want)}`)

await mcp('create_project', { name: 'Vector test' })
const made = await mcp('create_svg', { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><path d="M0 0L200 0L200 100L0 100Z" fill="#D9D9D9" stroke="#000"/></svg>', x: 100, y: 100 })
const rect = await mcp('create_rectangle', { name: 'rect', x: 400, y: 100, width: 120, height: 80, fill: '#2563EB' })
const ell = await mcp('create_ellipse', { name: 'ell', x: 600, y: 100, width: 100, height: 100, fill: '#F59E0B' })

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.filter((p) => p.type === 'page' && p.url.includes('#doc=')).pop()
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
const paint = () => send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 } })

await js(`(() => {
  const c = document.querySelector('.canvas-wrap canvas')
  window.__ev = (type, wx, wy, extra = {}) => { const r = c.getBoundingClientRect(); c.dispatchEvent(new (type === 'dblclick' ? MouseEvent : PointerEvent)(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: r.left + wx * editor.camera.zoom + editor.camera.x, clientY: r.top + wy * editor.camera.zoom + editor.camera.y, ...extra })) }
  window.__click = (wx, wy, extra) => { __ev('pointermove', wx, wy, { buttons: 0 }); __ev('pointerdown', wx, wy, extra); __ev('pointerup', wx, wy, extra) }
  window.__dbl = (wx, wy) => { __click(wx, wy); __click(wx, wy); __ev('dblclick', wx, wy) }
  window.__drag = (x1, y1, x2, y2, extra) => { __ev('pointermove', x1, y1, { buttons: 0 }); __ev('pointerdown', x1, y1, extra); __ev('pointermove', (x1 + x2) / 2, (y1 + y2) / 2, extra); __ev('pointermove', x2, y2, extra); __ev('pointerup', x2, y2, extra) }
  window.__key = (key, extra = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, code: extra.code ?? key, ...extra }))
  editor.zoomToRect({ x: 0, y: 0, w: 800, h: 320 }, 1)
  editor.setZoom(1)
  return 1
})()`)
// the path of the svg may sit inside a group: find the vector itself
const vid = await js(`(() => { const n = editor.nodes.get('${made.id ?? made[0]?.id}'); const v = n.type === 'VECTOR' ? n : editor.nodes.get(editor.descendants(n.id).find((d) => editor.nodes.get(d).type === 'VECTOR')); return v.id })()`)
const w = await js(`(() => { const r = editor.world('${vid}'); return [r.x, r.y, r.w, r.h] })()`)
const [X, Y, W, H] = w.map(Math.round)
const pts = () => js(`canvasView.vedit.state().subs.map((s) => s.pts.map((p) => [Math.round(p.x), Math.round(p.y)]))`)
const box = () => js(`(() => { const r = editor.world('${vid}'); return [r.x, r.y, r.w, r.h].map((v) => Math.round(v)) })()`)

// enter
await js(`__dbl(${X + W / 2}, ${Y + H / 2}), 1`)
check('a double click opens the points', [await js(`canvasView.vedit.active`), await pts()], [true, [[[X, Y], [X + W, Y], [X + W, Y + H], [X, Y + H]]]])
await paint()
// drag a corner
await js(`__drag(${X + W}, ${Y}, ${X + W + 60}, ${Y - 30}), 1`)
check('a point follows the drag', (await pts())[0][1], [X + W + 60, Y - 30])
check('the layer box grows with the shape', await box(), [X, Y - 30, W + 60, H + 30])
check('the path was rewritten', await js(`editor.nodes.get('${vid}').path`), 'M0 30L260 0L200 130L0 130Z')
await js(`__key('z', { code: 'KeyZ', ctrlKey: true }), 1`)
await paint()
check('Ctrl+Z puts the point back, still in the edit mode', [await js(`canvasView.vedit.active`), (await pts())[0][1], await box()], [true, [X + W, Y], [X, Y, W, H]])
// add a point on the top edge
await js(`__click(${X + 80}, ${Y}), 1`)
check('a click on the outline adds a point', [(await pts())[0].length, (await pts())[0][1], await js(`canvasView.vedit.state().selected`)], [5, [X + 80, Y], ['0:1']])
// turn it into a curve
await js(`__ev('dblclick', ${X + 80}, ${Y}), 1`)
const smooth = await js(`(() => { const p = canvasView.vedit.state().subs[0].pts[1]; return [!!p.in, !!p.out, Math.round(p.in.x), Math.round(p.out.x)] })()`)
check('a double click on a point makes it a curve', smooth, [true, true, X + 80 - 27, X + 80 + 40])
// pull it up, then bend with the handle
await js(`__drag(${X + 80}, ${Y}, ${X + 80}, ${Y - 40}), 1`)
check('the curve bulges beyond the old box', (await box())[1] < Y, true)
const hOut = await js(`(() => { const p = canvasView.vedit.state().subs[0].pts[1]; return [p.out.x, p.out.y] })()`)
await js(`__drag(${hOut[0]}, ${hOut[1]}, ${hOut[0] + 30}, ${hOut[1] - 30}), 1`)
const pair = await js(`(() => { const p = canvasView.vedit.state().subs[0].pts[1]; const a = Math.atan2(p.out.y - p.y, p.out.x - p.x), b = Math.atan2(p.y - p.in.y, p.x - p.in.x); return [Math.round(p.out.x), Math.round(p.out.y), Math.abs(a - b) < 0.001] })()`)
check('dragging a handle bends the curve, the other handle stays in line', pair, [Math.round(hOut[0] + 30), Math.round(hOut[1] - 30), true])
await js(`__drag(${hOut[0] + 30}, ${hOut[1] - 30}, ${hOut[0] + 30}, ${hOut[1] + 10}, { altKey: true }), 1`)
check('Alt breaks the pair', await js(`(() => { const p = canvasView.vedit.state().subs[0].pts[1]; const a = Math.atan2(p.out.y - p.y, p.out.x - p.x), b = Math.atan2(p.y - p.in.y, p.x - p.in.x); return Math.abs(a - b) > 0.05 })()`), true)
if (shot) {
  await js(`new Promise((r) => setTimeout(r, 16500))`)
  writeFileSync(shot, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
}
// back to a corner, nudge, delete
await js(`__ev('dblclick', ${X + 80}, ${Y - 40}), 1`)
check('a double click on a curve point makes it a corner again', await js(`(() => { const p = canvasView.vedit.state().subs[0].pts[1]; return [!!p.in, !!p.out] })()`), [false, false])
await js(`__key('ArrowRight', { shiftKey: true }), 1`)
check('Shift+arrow nudges the point by 10', (await pts())[0][1], [X + 90, Y - 40])
await js(`__key('Delete'), 1`)
check('Delete removes the point, not the layer', [(await pts())[0].length, await js(`editor.nodes.has('${vid}')`), await box()], [4, true, [X, Y, W, H]])
// marquee over the two left points, move them together
await js(`__drag(${X - 30}, ${Y - 30}, ${X + 30}, ${Y + H + 30}), 1`)
check('a marquee selects points', await js(`canvasView.vedit.state().selected.sort()`), ['0:0', '0:3'])
await js(`__drag(${X}, ${Y}, ${X - 40}, ${Y}), 1`)
check('selected points move together', [(await pts())[0][0], (await pts())[0][3]], [[X - 40, Y], [X - 40, Y + H]])
// leave
await js(`__key('Escape'), 1`)
check('Escape leaves the mode, the layer stays selected', [await js(`canvasView.vedit.active`), await js(`editor.selection`)], [false, [vid]])
await js(`__dbl(${X + W / 2}, ${Y + H / 2}), 1`)
await js(`__dbl(${X + W / 2}, ${Y + H + 150}), 1`)
check('a double click on empty space leaves it too', await js(`canvasView.vedit.active`), false)

// plain shapes become vectors
await js(`__dbl(460, 140), 1`)
check('a rectangle opens as four points', [await js(`editor.nodes.get('${rect.id}').type`), (await pts())[0]], ['VECTOR', [[400, 100], [520, 100], [520, 180], [400, 180]]])
await js(`__key('Escape'), 1`)
await js(`__dbl(650, 150), 1`)
check('an ellipse opens as four curve points', [await js(`editor.nodes.get('${ell.id}').type`), (await pts())[0], await js(`canvasView.vedit.state().subs[0].pts.every((p) => p.in && p.out)`)], ['VECTOR', [[650, 100], [700, 150], [650, 200], [600, 150]], true])
await js(`__key('Escape'), 1`)

// a rotated layer keeps its box while its points move
await mcp('update_node', { id: rect.id, rotation: 30 })
const before = await js(`(() => { const n = editor.nodes.get('${rect.id}'); return [n.x, n.y, n.width, n.height] })()`)
await js(`__dbl(460, 140), 1`)
const p0 = await js(`(() => { const p = canvasView.vedit.state().subs[0].pts[2]; const n = editor.nodes.get('${rect.id}'); const r = editor.world(n.id), cx = r.x + r.w / 2, cy = r.y + r.h / 2, t = (-30 * Math.PI) / 180; const dx = p.x - cx, dy = p.y - cy; return [cx + dx * Math.cos(t) - dy * Math.sin(t), cy + dx * Math.sin(t) + dy * Math.cos(t)] })()`)
await js(`__drag(${p0[0]}, ${p0[1]}, ${p0[0] + 40}, ${p0[1] + 40}), 1`)
check('rotated: the point is found where it is drawn, the box stays', [await js(`canvasView.vedit.active`), await js(`(() => { const n = editor.nodes.get('${rect.id}'); return [n.x, n.y, n.width, n.height] })()`), await js(`editor.nodes.get('${rect.id}').path !== 'M0 0L120 0L120 80L0 80Z'`)], [true, before, true])
await js(`__key('Escape'), 1`)
console.log(results.join('\n'))
console.log(results.some((r) => r.startsWith('FAIL')) ? 'SOME FAILED' : `all ${results.length} passed`)
ws.close()
