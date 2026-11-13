// Stroke settings, the tabs Dynamic and Brush, all width profiles, and a dashed stroke turned into separate dashes.
// Usage: node scripts/test-stroke-art.mjs [debugPort] [mcpPort] [screenshot.png]   (defaults 9333 / 7331)
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
process.on('uncaughtException', (e) => {
  console.log(results.join(String.fromCharCode(10)))
  console.log('CRASH', e.stack)
  process.exit(1)
})
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const check = (label, got, want) => results.push(`${same(got, want) ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${same(got, want) ? '' : '  want ' + JSON.stringify(want)}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const proj = await mcp('create_project', { name: 'Stroke art test' })
const frame = await mcp('create_frame', { name: 'Sheet', x: 0, y: 0, width: 1100, height: 900, fill: '#FFFFFF' })
const line = await mcp('create_shape', { kind: 'line', parentId: frame.id, x: 60, y: 60, width: 300, height: 0.01 })
await mcp('update_node', { id: line.id, strokes: [{ color: '#000000', weight: 16, align: 'CENTER' }] })
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
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 } })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  await wait(220)
}
const center = (sel, index = 0) => js(`(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${index}]; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
const node = (fields) => js(`(() => { const n = editor.nodes.get('${line.id}'); return ${fields} })()`)
/** the line drawn alone at 1x with 80 px of room around it: how far the ink reaches above / below the path, and how many gaps it has along it */
const look = () =>
  js(`(async () => {
    const { renderToCanvas } = await import('/editor/render.ts')
    const n = editor.nodes.get('${line.id}')
    let pad
    editor.act(() => { pad = editor.addNode({ type: 'RECTANGLE', parentId: n.parentId, x: n.x - 80, y: n.y - 80, width: n.width + 160, height: 160, fills: [] }) })
    const c = await renderToCanvas(editor, [pad.id, n.id], 1)
    editor.act(() => editor.deleteNode(pad.id))
    const g = c.getContext('2d').getImageData(0, 0, c.width, c.height)
    const on = (x, y) => g.data[(y * g.width + x) * 4 + 3] > 128
    let top = 1e9, bottom = -1e9, ink = 0
    const cols = []
    for (let x = 0; x < g.width; x++) { let any = false; for (let y = 0; y < g.height; y++) if (on(x, y)) { any = true; ink++; top = Math.min(top, y - 80); bottom = Math.max(bottom, y - 80) } cols.push(any) }
    // empty columns between the first and the last inked one, counted as runs
    const first = cols.indexOf(true), last = cols.lastIndexOf(true)
    let gaps = 0
    for (let x = first + 1; x < last; x++) if (!cols[x] && cols[x - 1]) gaps++
    // thickness of the ink in a column, at a quarter, the middle and three quarters of the path
    const thick = [0.1, 0.5, 0.9].map((t) => { const x = 80 + Math.round(n.width * t); let k = 0; for (let y = 0; y < g.height; y++) if (on(x, y)) k++; return k })
    return { top, bottom, ink, gaps, thick, from: first - 80, to: last - 80 }
  })()`)

// ================================================================ the popover and its tabs
const gear = await center('.panel.right .stroke-grid > .icon-btn')
await click(gear[0], gear[1])
check('Stroke settings has the three tabs', await js(`[...document.querySelectorAll('.stroke-set-tabs button')].map((b) => [b.textContent.length > 0, b.classList.contains('on')])`), [[true, true], [true, false], [true, false]])
const plain = await look()
check('a plain stroke: 16 thick, straight, no gaps', [plain.thick, plain.top, plain.bottom, plain.gaps], [[16, 16, 16], -8, 7, 0])

// ---- width profiles
const profiles = await js(`(async () => (await import('/editor/stroke-art.ts')).PROFILE_LABELS)()`)
check('seven width profiles', Object.keys(profiles), ['UNIFORM', 'TAPER', 'WEDGE', 'LENS', 'BLADE', 'DROP', 'PINCH'])
const shapes = {}
for (const p of Object.keys(profiles).slice(1)) {
  await js(`editor.act(() => editor.updateNode('${line.id}', { strokeProfile: '${p}' }))`)
  shapes[p] = (await look()).thick
}
console.log('   profiles (thickness at 10%, 50%, 90%)', JSON.stringify(shapes))
check('each profile has its own shape', [
  shapes.TAPER[0] > shapes.TAPER[1] && shapes.TAPER[1] > shapes.TAPER[2],
  shapes.WEDGE[0] > shapes.WEDGE[2] && shapes.WEDGE[2] >= 4,
  shapes.LENS[1] > shapes.LENS[0] && shapes.LENS[1] > shapes.LENS[2],
  shapes.BLADE[0] > shapes.BLADE[2] && shapes.BLADE[1] > shapes.BLADE[2],
  shapes.DROP[0] > shapes.DROP[1] && shapes.DROP[1] > shapes.DROP[2],
  shapes.PINCH[0] > shapes.PINCH[1] && shapes.PINCH[2] > shapes.PINCH[1]
], [true, true, true, true, true, true])
await js(`editor.act(() => editor.updateNode('${line.id}', { strokeProfile: undefined }))`)

// ---- Dynamic
const tab = (i) => center('.stroke-set-tabs button', i)
let at = await tab(1)
await click(at[0], at[1])
check('the Dynamic tab makes the stroke dynamic', await node('n.strokeDynamic'), { frequency: 50, wiggle: 30, smoothen: 50 })
check('it shows Frequency, Wiggle and Smoothen', await js(`document.querySelectorAll('.stroke-set input[type=range]').length`), 3)
const calm = await look()
check('the line now leaves the path, its weight kept', [calm.top < -9 || calm.bottom > 9, calm.thick.every((t) => t >= 15 && t <= 22), calm.gaps], [true, true, 0])
// the square end of a tilted line reaches a few pixels past the end of the path
check('it still starts and ends where the path does', [Math.abs(calm.from) <= 6, Math.abs(calm.to - 300) <= 6], [true, true])
// the slider: typing a value in its number field
await js(`(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; const f = document.querySelectorAll('.stroke-set .stroke-set-slider .tset-num')[1]; f.focus(); set.call(f, '100'); f.dispatchEvent(new Event('input', { bubbles: true })); f.blur() })()`)
await wait(200)
check('Wiggle 100 from its field', await node('n.strokeDynamic.wiggle'), 100)
const wild = await look()
check('more wiggle throws the line further', wild.bottom - wild.top > calm.bottom - calm.top + 10, true)
await js(`editor.act(() => editor.updateNode('${line.id}', { strokeDynamic: { frequency: 50, wiggle: 100, smoothen: 0 } }))`)
const rough = await look()
await js(`editor.act(() => editor.updateNode('${line.id}', { strokeDynamic: { frequency: 50, wiggle: 100, smoothen: 100 } }))`)
const smooth = await look()
check('Smoothen irons it out', smooth.bottom - smooth.top < rough.bottom - rough.top, true)
check('the same line is drawn the same way every time', same(await look(), smooth), true)

// ---- Brush
at = await tab(2)
await click(at[0], at[1])
check('the Brush tab makes it a brush stroke, the dynamic one is gone', await node('[n.strokeBrush, n.strokeDynamic ?? null]'), [{ name: 'INK' }, null])
const brushes = {}
for (const b of ['INK', 'MARKER', 'CALLIGRAPHY', 'CHARCOAL', 'DRY', 'DOTS', 'SPLATTER', 'HATCH']) {
  await js(`editor.act(() => editor.updateNode('${line.id}', { strokeBrush: { name: '${b}' } }))`)
  brushes[b] = await look()
}
console.log('   brushes', JSON.stringify(Object.fromEntries(Object.entries(brushes).map(([k, v]) => [k, [v.ink, v.gaps, v.thick]]))))
check('every brush leaves ink', Object.values(brushes).every((v) => v.ink > 300), true)
check('the brushes differ from one another', new Set(Object.values(brushes).map((v) => v.ink)).size, 8)
check('ink swells in the middle and ends in points', brushes.INK.thick[1] > brushes.INK.thick[0] && brushes.INK.thick[1] > brushes.INK.thick[2], true)
check('a marker is about as thick as the stroke', brushes.MARKER.thick.every((t) => t >= 13 && t <= 19), true)
check('a flat nib is thin along a horizontal line', brushes.CALLIGRAPHY.thick.every((t) => t >= 8 && t <= 13), true)
check('dots are stamps with gaps between them', brushes.DOTS.gaps > 5, true)
check('the scatter settings appear for a scatter brush', await js(`document.querySelectorAll('.stroke-set input[type=range]').length`), 4)
await js(`editor.act(() => editor.updateNode('${line.id}', { strokeBrush: { name: 'DOTS', gap: 300 } }))`)
check('a larger gap leaves fewer dots', (await look()).gaps < brushes.DOTS.gaps, true)
// back to Basic
at = await tab(0)
await click(at[0], at[1])
check('Basic makes it a plain stroke again', [await node('[n.strokeBrush ?? null, n.strokeDynamic ?? null]'), same(await look(), plain)], [[null, null], true])

// ================================================================ SVG: brushes and dynamic lines are plain vector paths
const svg = async (patch) => js(`(async () => { editor.act(() => editor.updateNode('${line.id}', ${patch})); const { nodesToSvg } = await import('/editor/svg.ts'); return nodesToSvg(editor, ['${line.id}'], false) })()`)
const sBrush = await svg(`{ strokeBrush: { name: 'DOTS' } }`)
check('a brush goes out as a filled path, with no stroke', [(sBrush.match(/A/g) || []).length > 20, / fill="#000000"/.test(sBrush), /stroke-width/.test(sBrush)], [true, true, false])
const sDyn = await svg(`{ strokeBrush: undefined, strokeDynamic: { frequency: 60, wiggle: 60, smoothen: 30 } }`)
check('a dynamic stroke goes out as a stroked line of many points', [(sDyn.match(/L/g) || []).length > 50, /stroke-width="16"/.test(sDyn)], [true, true])
await js(`editor.act(() => editor.updateNode('${line.id}', { strokeDynamic: undefined }))`)

// ================================================================ Outline stroke
const outline = (patch) =>
  js(`(async () => {
    const src = editor.nodes.get('${line.id}')
    const { id: _i, order: _o, ...rest } = structuredClone(src)
    let copy
    editor.act(() => { copy = editor.addNode({ ...rest, ...${patch} }) })
    editor.setSelection([copy.id])
    const { layerActions } = await import('/ui/layerActions.ts')
    await layerActions.outlineStroke()
    const n = editor.nodes.get(editor.selection[0]); const w = editor.world(n.id)
    const res = { type: n.type, parts: (n.path.match(/[Mm]/g) || []).length, w: Math.round(w.w), h: Math.round(w.h), strokes: n.strokes.length }
    editor.act(() => editor.deleteNode(n.id))
    return res
  })()`)
// 300 long, dashes of 40 with gaps of 20: dashes start at 0, 60, ... 240 -> five dashes
check('a dashed stroke becomes its dashes, each a shape of its own', await outline(`{ dashPattern: [40, 20] }`), { type: 'VECTOR', parts: 5, w: 280, h: 16, strokes: 0 })
check('round dash caps grow every dash by half the weight at each end', await outline(`{ dashPattern: [40, 20], dashCap: 'ROUND' }`), { type: 'VECTOR', parts: 5, w: 296, h: 16, strokes: 0 })
const oBrush = await outline(`{ strokeBrush: { name: 'DOTS' } }`)
check('a brush stroke becomes its stamps', [oBrush.type, oBrush.parts > 10, oBrush.strokes], ['VECTOR', true, 0])
const oDyn = await outline(`{ strokeDynamic: { frequency: 50, wiggle: 80, smoothen: 40 } }`)
check('a dynamic stroke becomes the shape of its shaken line', [oDyn.type, oDyn.h > 24, oDyn.strokes], ['VECTOR', true, 0])
// a dashed rectangle
const rect = await js(`(async () => {
  let r
  editor.act(() => { r = editor.addNode({ type: 'RECTANGLE', parentId: '${frame.id}', x: 500, y: 40, width: 200, height: 100, fills: [], strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 10, align: 'CENTER' }], dashPattern: [30, 30] }) })
  editor.setSelection([r.id])
  const { layerActions } = await import('/ui/layerActions.ts')
  await layerActions.outlineStroke()
  const n = editor.nodes.get(editor.selection[0])
  return [n.type, (n.path.match(/[Mm]/g) || []).length]
})()`)
// the outline is 600 long: ten dashes of 30 with gaps of 30
check('a dashed rectangle gives its dashes too', rect, ['VECTOR', 10])

// ================================================================ a sheet of everything, for the eye
if (shot) {
  await js(`(() => {
    const wave = 'M0 40C60 -20 120 100 180 40S300 -20 360 40'
    const mk = (y, x, patch) => editor.addNode({ type: 'VECTOR', parentId: '${frame.id}', x, y, width: 360, height: 80, path: wave, pathBox: { w: 360, h: 80 }, fills: [], strokes: [{ color: { r: 0.07, g: 0.07, b: 0.1, a: 1 }, weight: 14, align: 'CENTER' }], ...patch })
    editor.act(() => {
      const rows = [
        [{ strokeProfile: 'TAPER' }, { strokeProfile: 'WEDGE' }], [{ strokeProfile: 'LENS' }, { strokeProfile: 'BLADE' }], [{ strokeProfile: 'DROP' }, { strokeProfile: 'PINCH' }],
        [{ strokeDynamic: { frequency: 40, wiggle: 50, smoothen: 60 } }, { strokeDynamic: { frequency: 85, wiggle: 40, smoothen: 10 } }],
        [{ strokeBrush: { name: 'INK' } }, { strokeBrush: { name: 'MARKER' } }], [{ strokeBrush: { name: 'CALLIGRAPHY' } }, { strokeBrush: { name: 'CHARCOAL' } }],
        [{ strokeBrush: { name: 'DRY' } }, { strokeBrush: { name: 'DOTS' } }], [{ strokeBrush: { name: 'SPLATTER' } }, { strokeBrush: { name: 'HATCH', rotation: 30 } }]
      ]
      rows.forEach((r, i) => r.forEach((p, k) => mk(170 + i * 88, 60 + k * 420, p)))
    })
    editor.setSelection([])
  })()`)
  await mcp('zoom_to', { ids: [frame.id] })
  await wait(500)
  const s = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(shot, Buffer.from(s.data, 'base64'))
}
console.log(results.join('\n'))
console.log(results.some((r) => r.startsWith('FAIL')) ? '\nFAILED' : '\nALL PASSED')
ws.close()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
