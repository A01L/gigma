// Point editing of vectors (double click), as in Figma: its own tools (move, pen, bend, bucket),
// points and handles, continuing and joining paths, snapping, rotated layers, undo.
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
const svg = (d, w, h, fill = 'none') => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><path d="${d}" fill="${fill}" stroke="#000"/></svg>`

await mcp('create_project', { name: 'Vector test' })
const made = await mcp('create_svg', { svg: svg('M0 0L200 0L200 100L0 100Z', 200, 100, '#D9D9D9'), x: 100, y: 100 })
const rect = await mcp('create_rectangle', { name: 'rect', x: 400, y: 100, width: 120, height: 80, fill: '#2563EB' })
const ell = await mcp('create_ellipse', { name: 'ell', x: 600, y: 100, width: 100, height: 100, fill: '#F59E0B' })
const open = await mcp('create_svg', { svg: svg('M0 0L100 0L100 80', 100, 80), x: 100, y: 400 })
const two = await mcp('create_svg', { svg: svg('M0 0L50 0M100 40L150 40', 150, 40), x: 300, y: 400 })
const round = await mcp('create_rectangle', { name: 'round', x: 550, y: 400, width: 120, height: 80, fill: '#10B981' })

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
  window.__ve = canvasView.vedit
  // the vector inside what create_svg made (it may be wrapped in a group)
  window.__vec = (id) => { const n = editor.nodes.get(id); return (n.type === 'VECTOR' ? n : editor.nodes.get(editor.descendants(n.id).find((d) => editor.nodes.get(d).type === 'VECTOR'))).id }
  // open a layer for point editing the way a double click does
  window.__open = (id) => { if (__ve.active) __ve.stop(); editor.setSelection([id]); return __ve.start(id) }
  editor.setZoom(1)
  editor.zoomToRect({ x: 0, y: 0, w: 800, h: 560 }, 1)
  return 1
})()`)
const vid = await js(`__vec('${made.id ?? made[0]?.id}')`)
const openId = await js(`__vec('${open.id ?? open[0]?.id}')`)
const twoId = await js(`__vec('${two.id ?? two[0]?.id}')`)
const [X, Y, W, H] = (await js(`(() => { const r = editor.world('${vid}'); return [r.x, r.y, r.w, r.h] })()`)).map(Math.round)
const pts = () => js(`__ve.state().subs.map((s) => s.pts.map((p) => [Math.round(p.x), Math.round(p.y)]))`)
const box = (nid = vid) => js(`(() => { const r = editor.world('${nid}'); return [r.x, r.y, r.w, r.h].map((v) => Math.round(v)) })()`)
const tool = (t) => js(`__ve.setTool('${t}'), 1`)

// ---- entering, the move tool ----
await js(`__dbl(${X + W / 2}, ${Y + H / 2}), 1`)
check('a double click opens the points', [await js(`__ve.active`), await pts()], [true, [[[X, Y], [X + W, Y], [X + W, Y + H], [X, Y + H]]]])
await paint()
check('the mode has its own toolbar', await js(`[document.querySelectorAll('.toolbar .icon-btn').length, document.querySelector('.toolbar .tool-done')?.textContent]`), [4, 'Готово'])
await js(`__drag(${X + W}, ${Y}, ${X + W + 60}, ${Y - 30}), 1`)
check('a point follows the drag', (await pts())[0][1], [X + W + 60, Y - 30])
check('the layer box grows with the shape', await box(), [X, Y - 30, W + 60, H + 30])
check('the path was rewritten', await js(`editor.nodes.get('${vid}').path`), 'M0 30L260 0L200 130L0 130Z')
await js(`__key('z', { code: 'KeyZ', ctrlKey: true }), 1`)
await paint()
check('Ctrl+Z puts the point back, still in the edit mode', [await js(`__ve.active`), (await pts())[0][1], await box()], [true, [X + W, Y], [X, Y, W, H]])
await js(`__drag(${X + W / 2}, ${Y + H}, ${X + W / 2}, ${Y + H + 40}), 1`)
check('move: a segment is dragged by its two ends', [(await pts())[0][2], (await pts())[0][3]], [[X + W, Y + H + 40], [X, Y + H + 40]])
await js(`__key('z', { code: 'KeyZ', ctrlKey: true }), 1`)
await paint()

// ---- the pen adds a point on the outline ----
await tool('pen')
await js(`__click(${X + 80}, ${Y}), 1`)
check('pen: a click on the outline adds a point', [(await pts())[0].length, (await pts())[0][1], await js(`__ve.state().selected`)], [5, [X + 80, Y], ['0:1']])
await tool('move')
// ---- corner <-> curve ----
await js(`__ev('dblclick', ${X + 80}, ${Y}), 1`)
check('a double click on a point makes it a curve', await js(`(() => { const p = __ve.state().subs[0].pts[1]; return [!!p.in, !!p.out, Math.round(p.in.x), Math.round(p.out.x)] })()`), [true, true, X + 80 - 27, X + 80 + 40])
await js(`__drag(${X + 80}, ${Y}, ${X + 80}, ${Y - 40}), 1`)
check('the curve bulges beyond the old box', (await box())[1] < Y, true)
const hOut = await js(`(() => { const p = __ve.state().subs[0].pts[1]; return [p.out.x, p.out.y] })()`)
await js(`__drag(${hOut[0]}, ${hOut[1]}, ${hOut[0] + 30}, ${hOut[1] - 30}), 1`)
check('dragging a handle bends the curve, the other handle stays in line', await js(`(() => { const p = __ve.state().subs[0].pts[1]; const a = Math.atan2(p.out.y - p.y, p.out.x - p.x), b = Math.atan2(p.y - p.in.y, p.x - p.in.x); return [Math.round(p.out.x), Math.round(p.out.y), Math.abs(a - b) < 0.001] })()`), [Math.round(hOut[0] + 30), Math.round(hOut[1] - 30), true])
await js(`__drag(${hOut[0] + 30}, ${hOut[1] - 30}, ${hOut[0] + 30}, ${hOut[1] + 10}, { altKey: true }), 1`)
check('Alt breaks the pair', await js(`(() => { const p = __ve.state().subs[0].pts[1]; const a = Math.atan2(p.out.y - p.y, p.out.x - p.x), b = Math.atan2(p.y - p.in.y, p.x - p.in.x); return Math.abs(a - b) > 0.05 })()`), true)
if (shot) {
  await js(`new Promise((r) => setTimeout(r, 16500))`)
  writeFileSync(shot, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
}
await js(`__ev('dblclick', ${X + 80}, ${Y - 40}), 1`)
check('a double click on a curve point makes it a corner again', await js(`(() => { const p = __ve.state().subs[0].pts[1]; return [!!p.in, !!p.out] })()`), [false, false])
await js(`__key('ArrowRight', { shiftKey: true }), 1`)
check('Shift+arrow nudges the point by 10', (await pts())[0][1], [X + 90, Y - 40])
await js(`__key('Delete'), 1`)
check('Delete removes the point, not the layer', [(await pts())[0].length, await js(`editor.nodes.has('${vid}')`), await box()], [4, true, [X, Y, W, H]])
await js(`__drag(${X - 30}, ${Y - 30}, ${X + 30}, ${Y + H + 30}), 1`)
check('a marquee selects points', await js(`__ve.state().selected.sort()`), ['0:0', '0:3'])
await js(`__drag(${X}, ${Y}, ${X - 40}, ${Y}), 1`)
check('selected points move together', [(await pts())[0][0], (await pts())[0][3]], [[X - 40, Y], [X - 40, Y + H]])
await js(`__key('z', { code: 'KeyZ', ctrlKey: true }), 1`)
await paint()

// ---- the bend tool ----
await tool('bend')
await js(`__click(${X + W}, ${Y}), 1`)
check('bend: a click turns a corner into a curve', await js(`(() => { const p = __ve.state().subs[0].pts[1]; return [!!p.in, !!p.out] })()`), [true, true])
await js(`__click(${X + W}, ${Y}), 1`)
check('bend: and back', await js(`(() => { const p = __ve.state().subs[0].pts[1]; return [!!p.in, !!p.out] })()`), [false, false])
await js(`__drag(${X + W}, ${Y}, ${X + W + 30}, ${Y + 40}), 1`)
check('bend: dragging a point pulls a symmetric pair of handles', await js(`(() => { const p = __ve.state().subs[0].pts[1]; return [Math.round(p.out.x - p.x), Math.round(p.out.y - p.y), Math.round(p.in.x - p.x), Math.round(p.in.y - p.y)] })()`), [30, 40, -30, -40])
await js(`__key('z', { code: 'KeyZ', ctrlKey: true }), 1`)
await paint()
await js(`__drag(${X + W / 2}, ${Y + H}, ${X + W / 2}, ${Y + H + 30}), 1`)
// the middle of the bottom edge must now be where the pointer let go
check('bend: dragging a segment makes the curve pass through the pointer', await js(`(() => { const s = __ve.state().subs[0].pts, a = s[2], b = s[3], c1 = a.out, c2 = b.in; const y = 0.125 * a.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * b.y; return [!!c1, !!c2, Math.round(y)] })()`), [true, true, Y + H + 30])
await js(`__key('z', { code: 'KeyZ', ctrlKey: true }), 1`)
await paint()
await tool('move')
await js(`__click(${X}, ${Y + H}, { ctrlKey: true }), 1`)
check('Ctrl with the move tool bends for one gesture', await js(`(() => { const p = __ve.state().subs[0].pts[3]; return [!!p.in, !!p.out, __ve.state().tool] })()`), [true, true, 'move'])
await js(`__key('z', { code: 'KeyZ', ctrlKey: true }), 1`)
await paint()

// ---- the bucket ----
await tool('bucket')
await js(`__click(${X + W / 2}, ${Y + H / 2}), 1`)
check('bucket: a click inside removes the fill', await js(`editor.nodes.get('${vid}').fills.length`), 0)
await js(`__click(${X + W / 2}, ${Y + H / 2}), 1`)
check('bucket: and puts it back', await js(`editor.nodes.get('${vid}').fills.length`), 1)
await js(`__click(${X + W + 80}, ${Y + H + 60}), 1`)
check('bucket: a click outside changes nothing', await js(`editor.nodes.get('${vid}').fills.length`), 1)

// ---- snapping ----
await tool('move')
await js(`__drag(${X + W}, ${Y}, ${X + W + 2.4}, ${Y - 37.6}), 1`)
check('a dragged point lands on whole pixels and lines up with the point below it', [(await pts())[0][1], await js(`__ve.state().subs[0].pts[1].x`)], [[X + W, Y - 38], X + W])
await js(`__ev('pointermove', ${X + W}, ${Y - 38}, { buttons: 0 }), __ev('pointerdown', ${X + W}, ${Y - 38}), __ev('pointermove', ${X + W + 40}, ${Y - 20}), __ev('pointermove', ${X + W + 97}, ${Y - 3}), 1`)
check('while dragging near the corner of the next layer guides show', await js(`__ve.state().guides`), [{ axis: 'x', pos: 400 }, { axis: 'y', pos: Y }])
await js(`__ev('pointerup', ${X + W + 97}, ${Y - 3}), 1`)
check('and the point snaps to that corner', (await pts())[0][1], [400, Y])
await js(`__key('Escape'), 1`)
check('Escape leaves the mode, the layer stays selected', [await js(`__ve.active`), await js(`editor.selection`)], [false, [vid]])
check('the usual toolbar is back', await js(`!!document.querySelector('.toolbar .tool-done')`), false)

// ---- the pen continues an open path, closes it ----
await js(`__open('${openId}'), 1`)
await tool('pen')
check('an open path', [await js(`__ve.state().subs[0].closed`), (await pts())[0]], [false, [[100, 400], [200, 400], [200, 480]]])
await js(`__click(200, 480), 1`)
check('pen: a click on the end of an open path picks it up', await js(`__ve.state().pen`), { s: 0, end: 'end' })
await js(`__click(150, 520), 1`)
check('pen: the next click continues the path', (await pts())[0], [[100, 400], [200, 400], [200, 480], [150, 520]])
await js(`__drag(110, 500, 90, 470), 1`)
check('pen: a press and drag adds a curved point', await js(`(() => { const s = __ve.state().subs[0].pts; const p = s[s.length - 1]; return [s.length, Math.round(p.x), Math.round(p.y), Math.round(p.out.x), Math.round(p.out.y), Math.round(p.in.x), Math.round(p.in.y)] })()`), [5, 110, 500, 90, 470, 130, 530])
await js(`__click(100, 400), 1`)
check('pen: a click on the first point closes the path', [await js(`__ve.state().subs[0].closed`), await js(`__ve.state().pen`), (await pts())[0].length, /Z$/.test(await js(`editor.nodes.get('${openId}').path`))], [true, null, 5, true])
// a new path inside the same vector, then left unfinished
await js(`__click(260, 520), 1`)
check('pen: a click on empty space starts a new path', [(await pts()).length, (await pts())[1]], [2, [[260, 520]]])
await js(`__key('Escape'), __key('Escape'), __key('Escape'), 1`)
check('a path of one point is dropped on leaving', [await js(`__ve.active`), (await js(`editor.nodes.get('${openId}').path`)).split('M').length - 1], [false, 1])

// ---- the pen joins two paths ----
await js(`__open('${twoId}'), 1`)
await tool('pen')
check('two open paths', await pts(), [[[300, 400], [350, 400]], [[400, 440], [450, 440]]])
await js(`__click(350, 400), 1`)
await js(`__click(400, 440), 1`)
check('pen: end to end, the two paths become one', await pts(), [[[300, 400], [350, 400], [400, 440], [450, 440]]])
await js(`__key('Escape'), __key('Escape'), 1`)

// ---- plain shapes become vectors ----
await js(`__dbl(460, 140), 1`)
check('a rectangle opens as four points', [await js(`editor.nodes.get('${rect.id}').type`), (await pts())[0]], ['VECTOR', [[400, 100], [520, 100], [520, 180], [400, 180]]])
await js(`__key('Escape'), 1`)
await js(`__dbl(650, 150), 1`)
check('an ellipse opens as four curve points', [await js(`editor.nodes.get('${ell.id}').type`), (await pts())[0], await js(`__ve.state().subs[0].pts.every((p) => p.in && p.out)`)], ['VECTOR', [[650, 100], [700, 150], [650, 200], [600, 150]], true])
await js(`__key('Escape'), 1`)
await mcp('update_node', { id: round.id, cornerRadii: [20, 0, 30, 0] }).catch(() => js(`editor.act(() => editor.updateNode('${round.id}', { cornerRadii: [20, 0, 30, 0] })), 1`))
await js(`editor.act(() => editor.updateNode('${round.id}', { cornerRadii: [20, 0, 30, 0] })), 1`)
await js(`__open('${round.id}'), 1`)
check('a rectangle with different corner radii opens with its own corners', [await js(`editor.nodes.get('${round.id}').type`), (await pts())[0], await js(`__ve.state().subs[0].pts.map((p) => +!!p.in + +!!p.out)`)], ['VECTOR', [[570, 400], [670, 400], [670, 450], [640, 480], [550, 480], [550, 420]], [1, 0, 1, 1, 0, 1]])
await js(`__key('Escape'), 1`)

// ---- a rotated layer: the box follows the shape and nothing jumps ----
await js(`editor.act(() => editor.updateNode('${rect.id}', { rotation: 30 })), 1`)
await js(`__open('${rect.id}'), 1`)
// where the points are on the screen (world space, with the rotation applied)
const onScreen = () =>
  js(`(() => { const n = editor.nodes.get('${rect.id}'); const r = editor.world(n.id), cx = r.x + r.w / 2, cy = r.y + r.h / 2, t = (-n.rotation * Math.PI) / 180; return __ve.state().subs[0].pts.map((p) => { const dx = p.x - cx, dy = p.y - cy; return [Math.round((cx + dx * Math.cos(t) - dy * Math.sin(t)) * 10) / 10, Math.round((cy + dx * Math.sin(t) + dy * Math.cos(t)) * 10) / 10] }) })()`)
const s0 = await onScreen()
const b0 = await box(rect.id)
await js(`__drag(${s0[2][0]}, ${s0[2][1]}, ${s0[2][0] + 50}, ${s0[2][1] + 30}, { ctrlKey: false }), 1`)
const s1 = await onScreen()
const near = (a, b) => Math.abs(a[0] - b[0]) < 0.75 && Math.abs(a[1] - b[1]) < 0.75
check('rotated: the dragged point follows the pointer', [Math.abs(s1[2][0] - (s0[2][0] + 50)) < 1.5, Math.abs(s1[2][1] - (s0[2][1] + 30)) < 1.5], [true, true])
check('rotated: the other points stay where they were on the screen', [near(s1[0], s0[0]), near(s1[1], s0[1]), near(s1[3], s0[3])], [true, true, true])
const b1 = await box(rect.id)
check('rotated: the box was recomputed around the new shape', b1[2] !== b0[2] || b1[3] !== b0[3], true)
check('rotated: the path fits its box', await js(`(() => { const n = editor.nodes.get('${rect.id}'); return [Math.round(n.pathBox.w) === Math.round(n.width), Math.round(n.pathBox.h) === Math.round(n.height)] })()`), [true, true])
await js(`document.querySelector('.toolbar .tool-done').click(), 1`)
check('"Done" leaves the mode', await js(`__ve.active`), false)
console.log(results.join('\n'))
console.log(results.some((r) => r.startsWith('FAIL')) ? 'SOME FAILED' : `all ${results.length} passed`)
ws.close()
