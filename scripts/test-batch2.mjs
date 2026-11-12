// Auto layout, blend modes and rotated hit-testing, driven through MCP + in-page checks.
// Usage: node scripts/test-batch2.mjs out.png   (dev app with --remoteDebuggingPort 9333)
import { writeFileSync } from 'node:fs'
const out = process.argv[2] ?? 'batch2.png'
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
const get = async (id) => json(await mcp('get_node', { id }))
const box = (n) => [n.x, n.y, n.width, n.height]

await mcp('create_project', { name: 'Batch2 test' })
const bg = json(await mcp('create_frame', { name: 'BG', x: 0, y: 0, width: 700, height: 420, fill: '#F1F5F9' }))

// ---- horizontal, hug both, padding + gap ----
const row = json(await mcp('create_frame', { name: 'Row', x: 20, y: 20, width: 10, height: 10, fill: '#FFFFFF', cornerRadius: 12, parentId: bg.id, layoutMode: 'HORIZONTAL', itemSpacing: 8, padding: [10, 16, 10, 16], primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'AUTO', counterAxisAlignItems: 'CENTER' }))
const a = json(await mcp('create_rectangle', { name: 'a', x: 500, y: 300, width: 40, height: 40, fill: '#6366F1', cornerRadius: 8, parentId: row.id }))
const b = json(await mcp('create_rectangle', { name: 'b', x: 0, y: 0, width: 60, height: 20, fill: '#EC4899', cornerRadius: 8, parentId: row.id }))
const c = json(await mcp('create_rectangle', { name: 'c', x: 0, y: 0, width: 30, height: 30, fill: '#F59E0B', cornerRadius: 8, parentId: row.id }))
check('row hugs: 16+40+8+60+8+30+16 x 10+40+10', box(await get(row.id)).slice(2), [178, 60])
check('a placed at padding', box(await get(a.id)), [16, 10, 40, 40])
check('b after a + gap, centered vertically', box(await get(b.id)), [64, 20, 60, 20])
check('c last', box(await get(c.id)), [132, 15, 30, 30])

// ---- changing a child re-flows the frame ----
await mcp('update_node', { id: a.id, width: 100 })
check('row grows with its child', (await get(row.id)).width, 238)
check('b shifted', (await get(b.id)).x, 124)

// ---- fixed width + fill child + space between ----
await mcp('update_node', { id: row.id, primaryAxisSizingMode: 'FIXED', width: 400 })
await mcp('update_node', { id: b.id, layoutGrow: 1 })
check('fill child takes the free space: 400-32-100-30-16', (await get(b.id)).width, 222)
await mcp('update_node', { id: b.id, layoutGrow: 0, width: 60 })
await mcp('update_node', { id: row.id, primaryAxisAlignItems: 'SPACE_BETWEEN' })
check('space between: last child at the right padding', (await get(c.id)).x, 400 - 16 - 30)
check('space between: middle child centered in the gap', (await get(b.id)).x, 16 + 100 + (400 - 32 - 190) / 2)
await mcp('update_node', { id: row.id, primaryAxisAlignItems: 'MAX' })
check('align end', (await get(a.id)).x, 400 - 16 - 30 - 8 - 60 - 8 - 100)

// ---- vertical with stretch + text ----
const col = json(await mcp('create_frame', { name: 'Col', x: 20, y: 120, width: 240, height: 10, fill: '#FFFFFF', cornerRadius: 12, parentId: bg.id, layoutMode: 'VERTICAL', itemSpacing: 12, padding: 16, primaryAxisSizingMode: 'AUTO' }))
const title = json(await mcp('create_text', { text: 'Auto layout', x: 0, y: 0, fontSize: 20, fontWeight: 700, parentId: col.id }))
const body = json(await mcp('create_text', { text: 'This paragraph fills the width of the card and wraps onto several lines by itself.', x: 0, y: 0, fontSize: 13, color: '#475569', parentId: col.id }))
await mcp('update_node', { id: body.id, layoutAlign: 'STRETCH' })
const btn = json(await mcp('create_rectangle', { name: 'btn', x: 0, y: 0, width: 50, height: 36, fill: '#0D99FF', cornerRadius: 8, parentId: col.id }))
await mcp('update_node', { id: btn.id, layoutAlign: 'STRETCH' })
const bodyN = await get(body.id)
const colN = await get(col.id)
const btnN = await get(btn.id)
check('stretched text takes the inner width', bodyN.width, 208)
check('stretched text wrapped (taller than one line)', bodyN.height > 30, true)
check('stretched button', [btnN.x, btnN.width], [16, 208])
check('column hugs its height', colN.height, btnN.y + 36 + 16)
check('text keeps its natural height (not stretched vertically)', (await get(title.id)).y, 16)

// ---- absolute child, removal, layout off ----
const badge = json(await mcp('create_ellipse', { name: 'badge', x: 215, y: -8, width: 20, height: 20, fill: '#EF4444', parentId: col.id }))
await mcp('update_node', { id: badge.id, layoutPositioning: 'ABSOLUTE', x: 228, y: -8 })
check('absolute child keeps its place', box(await get(badge.id)), [228, -8, 20, 20])
check('absolute child does not change the frame', (await get(col.id)).height, colN.height)

// ---- blend mode + rotation ----
const blend = json(await mcp('create_ellipse', { name: 'blend', x: 300, y: 130, width: 160, height: 160, fill: '#22D3EE', parentId: bg.id }))
const blend2 = json(await mcp('create_ellipse', { name: 'blend2', x: 380, y: 170, width: 160, height: 160, fill: '#F43F5E', parentId: bg.id }))
await mcp('update_node', { id: blend2.id, blendMode: 'MULTIPLY' })
check('blend mode stored', (await get(blend2.id)).blendMode, 'MULTIPLY')
const rot = json(await mcp('create_rectangle', { name: 'rot', x: 540, y: 60, width: 140, height: 30, fill: '#10B981', cornerRadius: 6, parentId: bg.id }))
await mcp('update_node', { id: rot.id, rotation: 90 })
const svg = json(await mcp('export_svg', { id: blend2.id }))
check('svg carries mix-blend-mode', /mix-blend-mode:multiply/.test(svg), true)

const png = await mcp('export_png', { id: bg.id })
writeFileSync(out, Buffer.from(png[0].data, 'base64'))

// ---- in-page checks ----
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
const key = (init) => js(`window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ bubbles: true, ...init })})), 1`)
const N = (name) => `[...editor.nodes.values()].find(n => n.name === '${name}')`

// rotated 140x30 bar at 90deg occupies a 30x140 column around its center (610, 75)
check('hit inside the rotated shape (outside its unrotated box)', await js(`editor.hitTest(610, 130, true) === ${N('rot')}.id`), true)
check('no hit in the unrotated box corner', await js(`editor.hitTest(545, 75, true) === ${N('rot')}.id`), false)
// undo restores the layout in one step
await js(`editor.act(() => editor.updateNode(${N('Row')}.id, { itemSpacing: 30 })), 1`)
const moved = await js(`${N('b')}.x`)
await js(`editor.undo(), 1`)
check('undo of a layout change restores children', [moved !== (await js(`${N('b')}.x`)), await js(`${N('Row')}.itemSpacing`)], [true, 8])
// dragging a child inside the row reorders it: move "c" before "a"
await js(`(() => { editor.dropByPosition = true; editor.act(() => editor.updateNode(${N('c')}.id, { x: -50 })); editor.dropByPosition = false; return 1 })()`)
check('moved child takes the first slot', await js(`editor.children(${N('Row')}.id).map(i => editor.nodes.get(i).name).join(',')`), 'c,a,b')
await js(`editor.undo(), 1`)
// resizing a hugging frame by hand makes it fixed
await js(`editor.act(() => editor.updateNode(${N('Col')}.id, { height: 400 })), 1`)
check('hand-resized frame stops hugging', [await js(`${N('Col')}.primaryAxisSizingMode`), await js(`${N('Col')}.height`)], ['FIXED', 400])
await js(`editor.undo(), 1`)
// Shift+A wraps the selection, Alt+Shift+A removes the layout
await js(`editor.setSelection([${N('blend')}.id, ${N('blend2')}.id]), 1`)
await key({ key: 'A', code: 'KeyA', shiftKey: true })
check('Shift+A wraps the selection in an auto layout frame', await js(`(() => { const p = editor.nodes.get(${N('blend')}.parentId); return [p.type, p.layoutMode, p.itemSpacing, editor.selection[0] === p.id] })()`), ['FRAME', 'HORIZONTAL', 0, true])
check('wrapped children keep their order by position', await js(`${N('blend')}.x < ${N('blend2')}.x`), true)
await js(`editor.undo(), 1`)
check('one undo removes the wrapper', await js(`${N('blend')}.parentId === ${N('BG')}.id`), true)
console.log(results.join('\n'))
ws.close()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
