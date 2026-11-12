// Boolean operations + flatten through MCP, checked by pixels of the exported PNG.
// Usage: node scripts/test-boolean.mjs out.png   (dev app with --remoteDebuggingPort 9333)
import { writeFileSync } from 'node:fs'
const out = process.argv[2] ?? 'boolean.png'
let mid = 0
async function mcp(name, args = {}) {
  const r = await fetch('http://127.0.0.1:7331/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++mid, method: 'tools/call', params: { name, arguments: args } })
  })
  const j = await r.json()
  if (j.error || j.result?.isError) throw new Error(name + ': ' + JSON.stringify(j.error ?? j.result.content))
  return j.result.content
}
const json = (c) => JSON.parse(c[0].text)
const results = []
const check = (label, got, want) => results.push(`${JSON.stringify(got) === JSON.stringify(want) ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(want) ? '' : '  want ' + JSON.stringify(want)}`)

await mcp('create_project', { name: 'Boolean test' })
const bg = json(await mcp('create_frame', { name: 'BG', x: 0, y: 0, width: 880, height: 240, fill: '#0F172A' }))
// four pairs: a 120x120 square with a circle overlapping its right half
const ops = ['UNION', 'SUBTRACT', 'INTERSECT', 'EXCLUDE']
const groups = {}
for (const [i, op] of ops.entries()) {
  const x = 30 + i * 215
  const sq = json(await mcp('create_rectangle', { name: 'sq', x, y: 60, width: 120, height: 120, fill: '#38BDF8', cornerRadius: 16, parentId: bg.id }))
  const ci = json(await mcp('create_ellipse', { name: 'ci', x: x + 70, y: 40, width: 100, height: 100, fill: '#F43F5E', parentId: bg.id }))
  groups[op] = json(await mcp('boolean_operation', { ids: [sq.id, ci.id], operation: op }))
}
check('boolean group is created with the name of the operation', [groups.UNION.type, groups.UNION.name, groups.SUBTRACT.name], ['GROUP', 'Union', 'Subtract'])
const g = json(await mcp('get_node', { id: groups.SUBTRACT.id }))
check('group keeps the operation and takes the fill of the bottom layer', [g.booleanOperation, g.fills[0].color.b > 0.9], ['SUBTRACT', true])
const svg = json(await mcp('export_svg', { id: groups.SUBTRACT.id }))
check('svg export is a single path (no ellipse, no rect)', [/<path /.test(svg), /<ellipse|<rect/.test(svg)], [true, false])

const png = await mcp('export_png', { id: bg.id, scale: 1 })
writeFileSync(out, Buffer.from(png[0].data, 'base64'))

// ---- pixels: sample the exported image inside the page ----
const pages = await (await fetch('http://127.0.0.1:9333/json')).json()
const page = pages.filter((p) => p.type === 'page' && p.url.includes('#doc=')).pop()
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  pending.get(m.id)?.(m.result)
})
const js = (expression) =>
  new Promise((res) => (pending.set(++id, res), ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })))).then((r) => r.result?.value ?? r.exceptionDetails?.exception?.description)
const b64 = png[0].data
const sample = (pts) =>
  js(`(async () => { const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,${b64}')).blob()); const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d'); x.drawImage(bmp, 0, 0); return JSON.stringify(${JSON.stringify(pts)}.map(([px, py]) => { const d = x.getImageData(px, py, 1, 1).data; return d[2] > 200 && d[0] < 120 ? 'fill' : 'bg' })) })()`).then(JSON.parse)
// per pair (x0 = left of the square): A = square only, B = overlap, C = circle only
const pts = (i) => {
  const x = 30 + i * 215
  return [
    [x + 30, 150],
    [x + 100, 100],
    [x + 150, 55]
  ]
}
check('UNION     keeps square, overlap, circle', await sample(pts(0)), ['fill', 'fill', 'fill'])
check('SUBTRACT  keeps only the square without the overlap', await sample(pts(1)), ['fill', 'bg', 'bg'])
check('INTERSECT keeps only the overlap', await sample(pts(2)), ['bg', 'fill', 'bg'])
check('EXCLUDE   keeps everything but the overlap', await sample(pts(3)), ['fill', 'bg', 'fill'])

// ---- editing a child updates the result; changing the operation; flatten ----
const N = (name, n = 0) => `[...editor.nodes.values()].filter(n => n.name === '${name}')[${n}]`
const resultD = () => js(`(async () => (await import('/editor/boolean.ts')).booleanResult(editor, '${groups.UNION.id}').d)()`)
const d1 = await resultD()
await js(`editor.act(() => editor.updateNode(${N('ci')}.id, { x: ${N('ci')}.x + 20 })), 1`)
const d2 = await resultD()
check('moving a child recomputes the result', typeof d1 === 'string' && d1.length > 20 && d1 !== d2, true)
await mcp('boolean_operation', { ids: [groups.UNION.id], operation: 'INTERSECT' })
const g2 = json(await mcp('get_node', { id: groups.UNION.id }))
check('changing the operation of an existing group', [g2.booleanOperation, g2.name], ['INTERSECT', 'Intersect'])
const flat = json(await mcp('flatten_nodes', { ids: [groups.EXCLUDE.id] }))
const fn = json(await mcp('get_node', { id: flat.id }))
check('flatten gives one vector with a path', [fn.type, typeof fn.path === 'string' && fn.path.length > 20, fn.fills.length], ['VECTOR', true, 1])
check('flattened group and its children are gone', await js(`editor.nodes.has('${groups.EXCLUDE.id}')`), false)
// keyboard: Alt+Shift+U on two fresh shapes, then Ctrl+E
const r1 = json(await mcp('create_rectangle', { name: 'k1', x: 20, y: 300, width: 80, height: 80, fill: '#22C55E' }))
const r2 = json(await mcp('create_rectangle', { name: 'k2', x: 60, y: 340, width: 80, height: 80, fill: '#EAB308' }))
await js(`editor.setSelection(['${r1.id}', '${r2.id}']), 1`)
await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'U', code: 'KeyU', altKey: true, shiftKey: true, bubbles: true })), 1`)
check('Alt+Shift+U makes a union group', await js(`(() => { const p = editor.nodes.get(editor.nodes.get('${r1.id}').parentId); return [p?.booleanOperation, editor.selection[0] === p?.id] })()`), ['UNION', true])
await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', ctrlKey: true, bubbles: true })), 1`)
check('Ctrl+E flattens it: 120x120 vector', await js(`(() => { const n = editor.nodes.get(editor.selection[0]); return [n.type, n.width, n.height] })()`), ['VECTOR', 120, 120])
await js(`editor.undo(), editor.undo(), 1`)
check('two undos bring both rectangles back', await js(`[editor.nodes.has('${r1.id}'), editor.nodes.get('${r1.id}')?.parentId]`), [true, null])
// outline used for hover / multi-selection follows the real shape
check('outline of an ellipse is not a box', await js(`(async () => { const { outlineShape } = await import('/editor/render.ts'); const p = outlineShape(editor, ${N('ci', 1)}.id); const c = new OffscreenCanvas(4, 4).getContext('2d'); const w = editor.world(${N('ci', 1)}.id); return [c.isPointInPath(p, w.x + w.w / 2, w.y + w.h / 2), c.isPointInPath(p, w.x + 2, w.y + 2)] })()`), [true, false])
console.log(results.join('\n'))
ws.close()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
