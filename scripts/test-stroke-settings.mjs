// Stroke settings as in Figma: the settings popover, start / end points, dashes, joins and the miter angle, width profile;
// what the canvas draws for them, the SVG export and Outline stroke.
// Usage: node scripts/test-stroke-settings.mjs [debugPort] [mcpPort] [screenshot.png]   (defaults 9333 / 7331)
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
// a step that cannot go on still shows what passed before it
process.on('uncaughtException', (e) => {
  console.log(results.join(String.fromCharCode(10)))
  console.log('CRASH', e.stack)
  process.exit(1)
})
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const check = (label, got, want) => results.push(`${same(got, want) ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${same(got, want) ? '' : '  want ' + JSON.stringify(want)}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const proj = await mcp('create_project', { name: 'Stroke settings test' })
const frame = await mcp('create_frame', { name: 'Sheet', x: 0, y: 0, width: 800, height: 600, fill: '#FFFFFF' })
// a horizontal line 200 long with a thick stroke: its ends are easy to probe
const line = await mcp('create_shape', { kind: 'line', parentId: frame.id, x: 100, y: 100, width: 200, height: 0.01 })
await mcp('update_node', { id: line.id, strokes: [{ color: '#000000', weight: 20, align: 'CENTER' }] })
await mcp('zoom_to', { ids: [frame.id] })
await mcp('set_selection', { ids: [line.id] })

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
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await paint()
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  await wait(200)
}
const center = (sel, index = 0) => js(`(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${index}]; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
const node = (fields) => js(`(() => { const n = editor.nodes.get('${line.id}'); return ${fields} })()`)
/** open a select (by the element that holds it) and pick the option with that text */
const pick = async (holder, index, label) => {
  const at = await center(holder + ' .gsel', index)
  await click(at[0], at[1])
  const opt = await js(`(() => { const o = [...document.querySelectorAll('.gsel-opt')].find((o) => new RegExp(${JSON.stringify(label)}).test(o.textContent.trim())); if (!o) return null; const r = o.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
  if (!opt) return false
  await click(opt[0], opt[1])
  return true
}
// the line drawn alone, at 1x; x and y are in its own box, grown by 60 on each side so the ends fit
const ink = (pts) =>
  js(`(async () => {
    const { renderToCanvas } = await import('/editor/render.ts')
    const n = editor.nodes.get('${line.id}')
    let pad
    editor.act(() => { pad = editor.addNode({ type: 'RECTANGLE', parentId: n.parentId, x: n.x - 60, y: n.y - 60, width: n.width + 120, height: 120, fills: [] }) })
    const c = await renderToCanvas(editor, [pad.id, n.id], 1)
    editor.act(() => editor.deleteNode(pad.id))
    const g = c.getContext('2d')
    return ${JSON.stringify(pts)}.map(([x, y]) => g.getImageData(x + 60, y + 60, 1, 1).data[3] > 128 ? 1 : 0)
  })()`)

// ================================================================ the panel
check('an open path shows Start point and End point in the panel', await js(`document.querySelectorAll('.panel.right .cap-field').length`), 2)
check('both ends start as None', await node('[n.strokeStartCap ?? null, n.strokeEndCap ?? null]'), [null, null])
// a butt end: nothing past the end of the path
check('a plain end stops at the end of the path', await ink([[100, 0], [-5, 0], [205, 0]]), [1, 0, 0])
check('picking Round for the start', await pick('.panel.right .cap-field', 0, '^(Round|Круглый)$'), true)
check('the start is round, the end still plain', await node('[n.strokeStartCap, n.strokeEndCap]'), ['ROUND', 'NONE'])
check('the canvas draws a round start only', await ink([[-6, 0], [-8, 8], [205, 0]]), [1, 0, 0])
check('picking Triangle arrow for the end', await pick('.panel.right .cap-field', 1, '^(Triangle arrow|Стрелка треугольником)$'), true)
check('the end is an arrow', await node('n.strokeEndCap'), 'TRIANGLE_ARROW')
// the arrow is 90 long and 52 to each side for a weight of 20: wider than the line near its base
check('the canvas draws the arrow head', await ink([[130, 30], [195, 0], [195, 30], [205, 0]]), [1, 1, 0, 0])

// ================================================================ the popover
const gear = await center('.panel.right .stroke-grid > .icon-btn')
await click(gear[0], gear[1])
check('the settings button opens Stroke settings', await js(`!!document.querySelector('.stroke-set')`), true)
check('it shows the two end points', await js(`document.querySelectorAll('.stroke-set .cap-field').length`), 2)
check('Circle arrow for the start, from the popover', await pick('.stroke-set .cap-field', 0, '^(Circle arrow|Круг)$'), true)
check('the start is a circle', await node('n.strokeStartCap'), 'CIRCLE_ARROW')
check('the canvas draws the circle (radius 52)', await ink([[-40, 0], [0, 45], [-60, 0]]), [1, 1, 0])

// dashes
check('Style: Dashed', await pick('.stroke-set .stroke-set-field', 0, '^(Dashed|Пунктир)$'), true)
check('a dashed line gets a dash and a gap of four weights', await node('n.dashPattern'), [80, 80])
check('Dash and Gap fields appear', await js(`document.querySelectorAll('.stroke-set .tset-num').length`), 3)
await js(`(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; const type = (el, v) => { el.focus(); set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.blur() }; const f = document.querySelectorAll('.stroke-set .tset-num'); type(f[0], '30'); type(f[1], '20') })()`)
await wait(200)
check('typing 30 and 20 sets the dashes', await node('n.dashPattern'), [30, 20])
// dashes of 30 with gaps of 20, from the start of the path (probed between the circle at the start and the arrow at the end)
check('the canvas draws dashes and gaps', await ink([[65, 0], [90, 0]]), [1, 0])
check('Style: Solid again', await pick('.stroke-set .stroke-set-field', 0, '^(Solid|Сплошн)'), true)
check('the line is solid', await node('n.dashPattern ?? null'), null)

// joins and the miter angle
check('Join starts as Miter with the angle of Figma', await js(`[[...document.querySelectorAll('.stroke-set .seg button')].findIndex((b) => b.classList.contains('on')), document.querySelector('.stroke-set .tset-row:last-child .tset-num').value]`), [0, '28.96°'])
const bevel = await center('.stroke-set .seg button', 1)
await click(bevel[0], bevel[1])
check('Bevel', await node('n.strokeJoin'), 'BEVEL')
check('the miter angle goes away with it', await js(`!!document.querySelector('.stroke-set .tset-row:last-child .tset-num')`), false)
const roundJ = await center('.stroke-set .seg button', 2)
await click(roundJ[0], roundJ[1])
check('Round', await node('n.strokeJoin'), 'ROUND')
const miter = await center('.stroke-set .seg button', 0)
await click(miter[0], miter[1])
check('Miter', await node('n.strokeJoin'), 'MITER')

// width profile
check('Width profile: Taper', await pick('.stroke-set .stroke-set-pair .stroke-set-field', 0, ''), true)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await js(`editor.act(() => editor.updateNode('${line.id}', { strokeProfile: 'TAPER' }))`)
await wait(150)
// full weight at the start, nothing at the end
check('a tapered stroke is wide at the start and thin at the end', await ink([[10, 8], [100, 3], [100, 8], [190, 3]]), [1, 1, 0, 0])
await js(`editor.act(() => editor.updateNode('${line.id}', { strokeProfileFlip: true }))`)
check('flipped, it is the other way round', await ink([[10, 3], [190, 8]]), [0, 1])
await js(`editor.act(() => editor.updateNode('${line.id}', { strokeProfile: undefined, strokeProfileFlip: undefined }))`)

// ================================================================ the miter angle changes what is drawn
const corner = await js(`(async () => {
  const { renderToCanvas } = await import('/editor/render.ts')
  let v
  // a sharp corner of about 20 degrees, pointing right; its tip is at x = 100
  editor.act(() => { v = editor.addNode({ type: 'VECTOR', parentId: '${frame.id}', x: 400, y: 300, width: 100, height: 36, path: 'M0 0L100 18L0 36', pathBox: { w: 100, h: 36 }, fills: [], strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 10, align: 'CENTER' }] }) })
  const probe = async () => { const c = await renderToCanvas(editor, [v.id], 1); const b = editor.world(v.id); const g = c.getContext('2d'); let far = 0; for (let x = c.width - 1; x >= 0; x--) if (g.getImageData(x, Math.round(c.height / 2), 1, 1).data[3] > 128) { far = x; break } return far }
  // the export is as large as the node, so the miter cannot be seen past its box: put the corner inside a bigger frame
  let f
  editor.act(() => { f = editor.addNode({ type: 'FRAME', parentId: '${frame.id}', x: 380, y: 280, width: 220, height: 80, fills: [], clipsContent: true }); editor.reparent(v.id, f.id) })
  const far = async () => { const c = await renderToCanvas(editor, [f.id], 1); const g = c.getContext('2d'); for (let x = c.width - 1; x >= 0; x--) if (g.getImageData(x, 38, 1, 1).data[3] > 128) return x; return 0 }
  const cut = await far()
  editor.act(() => editor.updateNode(v.id, { strokeMiterAngle: 10 }))
  const sharp = await far()
  editor.act(() => editor.updateNode(v.id, { strokeJoin: 'ROUND' }))
  const round = await far()
  return { cut, sharp, round, id: v.id }
})()`)
// the tip of the path is at x = 120 in the frame; a bevel ends about there, a round join 5 further, a miter much further
check('a corner sharper than the miter angle is bevelled; a smaller angle lets the miter out; round sits between', [corner.cut <= 123, corner.sharp > corner.cut + 15, corner.round > corner.cut && corner.round < corner.sharp], [true, true, true])
console.log('   corner reaches', JSON.stringify(corner))

// ================================================================ SVG and Outline stroke
await js(`editor.act(() => editor.updateNode('${line.id}', { dashPattern: [30, 20], dashCap: 'ROUND', strokeJoin: 'BEVEL' }))`)
const svg = await js(`(async () => { const { nodesToSvg } = await import('/editor/svg.ts'); return nodesToSvg(editor, ['${line.id}'], false) })()`)
check('the SVG carries dashes, their caps, the join, and the two end shapes', [/stroke-dasharray="30 20"/.test(svg), /stroke-linecap="round"/.test(svg), /stroke-linejoin="bevel"/.test(svg), /<circle /.test(svg), (svg.match(/<path /g) || []).length >= 2], [true, true, true, true, true])
await js(`editor.act(() => editor.updateNode('${line.id}', { dashPattern: undefined, dashCap: undefined }))`)
const outlined = await js(`(async () => {
  editor.setSelection(['${line.id}'])
  const { layerActions } = await import('/ui/layerActions.ts')
  await layerActions.outlineStroke()
  const n = editor.nodes.get(editor.selection[0]); const w = editor.world(n.id)
  return { type: n.type, w: Math.round(w.w), h: Math.round(w.h), strokes: n.strokes.length }
})()`)
// the line is 200 long; the circle adds 52 at the start; the arrow ends at the end of the path; both are 104 tall
check('Outline stroke keeps the end shapes: the circle and the arrow are part of the outline', outlined, { type: 'VECTOR', w: 252, h: 104, strokes: 0 })

if (shot) {
  await js(`editor.undo()`)
  await mcp('set_selection', { ids: [line.id] })
  await wait(300)
  const g = await center('.panel.right .stroke-grid > .icon-btn')
  if (!(await js(`!!document.querySelector('.stroke-set')`))) await click(g[0], g[1])
  await wait(300)
  const s = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(shot, Buffer.from(s.data, 'base64'))
}
console.log(results.join('\n'))
console.log(results.some((r) => r.startsWith('FAIL')) ? '\nFAILED' : '\nALL PASSED')
ws.close()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
