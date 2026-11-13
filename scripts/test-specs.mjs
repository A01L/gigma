// Spec cards wired to frames: MCP view of the links and dragging the port on the canvas.
// Usage: node scripts/test-specs.mjs [debugPort] [mcpPort] [screenshot.png]   (defaults 9333 / 7331)
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
const fails = async (name, args) => mcp(name, args).then(() => false, () => true)
const results = []
const check = (label, got, want) => (process.env.TRACE && console.error(label), results).push(`${JSON.stringify(got) === JSON.stringify(want) ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(want) ? '' : '  want ' + JSON.stringify(want)}`)

await mcp('create_project', { name: 'Spec test' })
const home = await mcp('create_frame', { name: 'Home', x: 500, y: 0, width: 360, height: 300, fill: '#FFFFFF' })
const cart = await mcp('create_frame', { name: 'Cart', x: 500, y: 380, width: 360, height: 300, fill: '#FFFFFF' })
const other = await mcp('create_frame', { name: 'Other', x: 960, y: 0, width: 360, height: 300, fill: '#FFFFFF' })
const rect = await mcp('create_rectangle', { name: 'r', x: 20, y: 20, width: 80, height: 80, fill: '#2563EB', parentId: other.id })

// ---- MCP ----
const spec = await mcp('create_spec', { title: 'Add a buy button', body: 'Blue, 48 high, at the bottom', x: 0, y: 100, frameIds: [home.id] })
check('create_spec returns the linked frame', spec.linkedFrames.map((f) => f.name), ['Home'])
await mcp('link_spec', { specId: spec.id, frameIds: [cart.id] })
const listed = (await mcp('list_specs')).find((s) => s.id === spec.id)
check('list_specs: frames of the spec', listed.linkedFrames.map((f) => f.name), ['Home', 'Cart'])
check('list_specs hides the raw ids', 'targets' in listed, false)
const doc = JSON.stringify(await mcp('get_document'))
check('get_document: the frame lists its spec', doc.includes(`"specs":[{"id":"${spec.id}","kind":"TASK","title":"Add a buy button","status":"TODO"}]`), true)
const node = await mcp('get_node', { id: home.id })
check('get_node of a wired frame carries the task', node.specs?.[0]?.body, 'Blue, 48 high, at the bottom')
check('get_node of a free frame has no specs', (await mcp('get_node', { id: other.id })).specs, undefined)
const btn = await mcp('create_rectangle', { name: 'btn', x: 16, y: 236, width: 328, height: 48, fill: '#2563EB', parentId: home.id })
check('creating inside a wired frame reminds of the spec', [btn.specs?.[0]?.id, typeof btn.note], [spec.id, 'string'])
check('no reminder in a free frame', rect.specs, undefined)
check('get_node of a layer inside the frame', (await mcp('get_node', { id: btn.id })).specs?.length, 1)
check('get_node of the spec', (await mcp('get_node', { id: spec.id })).linkedFrames.length, 2)
check('a layer that is not a frame is refused', await fails('link_spec', { specId: spec.id, frameIds: [rect.id] }), true)
await mcp('link_spec', { specId: spec.id, frameIds: [cart.id], mode: 'remove' })
check('link_spec remove', (await mcp('list_specs')).find((s) => s.id === spec.id).linkedFrames.map((f) => f.name), ['Home'])
await mcp('update_spec', { id: spec.id, status: 'DONE', result: 'Button added' })
const after = await mcp('create_rectangle', { name: 'x', x: 0, y: 0, width: 10, height: 10, parentId: home.id })
check('a finished spec no longer nags', after.specs, undefined)
check('but the frame still shows it as done', (await mcp('get_node', { id: home.id })).specs?.[0]?.status, 'DONE')
await mcp('update_spec', { id: spec.id, status: 'TODO', frameIds: [home.id, cart.id] })
check('update_spec frameIds', (await mcp('get_node', { id: spec.id })).linkedFrames.length, 2)

// sections, rules and materials
const section = await mcp('create_shape', { kind: 'section', name: 'Shop', x: 440, y: 800, width: 900, height: 420 }).catch(() => null)
const kit = await mcp('create_frame', { name: 'UI kit', x: -500, y: 0, width: 360, height: 300, fill: '#FFFFFF' })
const rules = await mcp('create_spec', { title: 'Brand rules', body: 'Only blue and white. Radius 12.', kind: 'RULES', x: 0, y: 420, frameIds: [home.id, other.id], sourceIds: [kit.id] })
check('create_spec with rules and materials', [rules.kind, rules.linkedFrames.length, rules.sourceFrames.map((f) => f.name)], ['RULES', 2, ['UI kit']])
const inRules = await mcp('create_rectangle', { name: 'y', x: 0, y: 0, width: 10, height: 10, parentId: other.id })
check('rules remind in their frames', [inRules.specs?.[0]?.kind, /RULES are standing rules/.test(inRules.note)], ['RULES', true])
const lr = (await mcp('list_specs')).find((s) => s.id === rules.id)
check('list_specs: rules have no status, sources are named', [lr.kind, 'status' in lr, lr.sourceFrames[0].name, 'sources' in lr], ['RULES', false, 'UI kit', false])
check('list_specs filter by kind', (await mcp('list_specs', { kind: 'RULES' })).map((s) => s.id), [rules.id])
check('status filter skips rules', (await mcp('list_specs', { status: 'TODO' })).some((s) => s.id === rules.id), false)
check('a source frame knows what it feeds', (await mcp('get_node', { id: kit.id })).materialForSpecs?.[0]?.id, rules.id)
check('a source is not a place to work', (await mcp('create_rectangle', { name: 'k', x: 0, y: 0, width: 10, height: 10, parentId: kit.id })).specs, undefined)
await mcp('link_spec', { specId: rules.id, frameIds: [other.id], role: 'source' })
const moved = await mcp('get_node', { id: rules.id })
check('a frame is a source or a target, not both', [moved.linkedFrames.map((f) => f.name), moved.sourceFrames.map((f) => f.name)], [['Home'], ['UI kit', 'Other']])
await mcp('link_spec', { specId: rules.id, frameIds: [other.id], role: 'source', mode: 'remove' })
await mcp('update_spec', { id: rules.id, kind: 'TASK' })
check('update_spec turns rules into a task', (await mcp('get_node', { id: rules.id })).kind, 'TASK')
await mcp('update_spec', { id: rules.id, kind: 'RULES' })
if (section) {
  const inside = await mcp('create_frame', { name: 'Product', x: 40, y: 60, width: 300, height: 300, fill: '#FFFFFF', parentId: section.id })
  await mcp('link_spec', { specId: rules.id, frameIds: [section.id] })
  check('a section can be linked', (await mcp('get_node', { id: rules.id })).linkedFrames.map((f) => f.type).includes('SECTION'), true)
  check('frames inside the section inherit its specs', (await mcp('get_node', { id: inside.id })).specs?.some((s) => s.id === rules.id), true)
} else results.push('FAIL  could not create a section')

// ---- canvas ----
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
// a covered window draws no frames; taking a screenshot makes it draw one
const frame = () => send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 } })
const js = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r.result?.value ?? r.exceptionDetails?.exception?.description ?? null)
await js(`(() => {
  const c = document.querySelector('.canvas-wrap canvas')
  window.__ev = (type, wx, wy, dx = 0, extra = {}) => { const r = c.getBoundingClientRect(); c.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: r.left + wx * editor.camera.zoom + editor.camera.x + dx, clientY: r.top + wy * editor.camera.zoom + editor.camera.y, ...extra })) }
  editor.zoomToRect({ x: -560, y: -40, w: 1940, h: 1300 }, 1)
  editor.setSelection(['${spec.id}'])
  return 1
})()`)
const linked = () => js(`editor.nodes.get('${spec.id}').spec.targets ?? []`)
// the right port sits 14 screen px outside the right edge, 60 px below the top of the card
const drag = (wx, wy) => js(`(() => { __ev('pointermove', 320, 160, 14, { buttons: 0 }); __ev('pointerdown', 320, 160, 14); __ev('pointermove', 400, 200); __ev('pointermove', ${wx}, ${wy}); __ev('pointerup', ${wx}, ${wy}); return 1 })()`)
await drag(1100, 150)
check('dragging the port onto a frame links it', await linked(), [home.id, cart.id, other.id])
check('the card did not move', await js(`[editor.nodes.get('${spec.id}').x, editor.nodes.get('${spec.id}').y]`), [0, 100])
await js(`window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'z', code: 'KeyZ', ctrlKey: true })), 1`)
check('Ctrl+Z removes the link', await linked(), [home.id, cart.id])
await drag(1100, 150)
await drag(1100, 150)
check('dragging onto a linked frame unlinks it', await linked(), [home.id, cart.id])
await drag(420, 720)
check('dropping on empty canvas changes nothing', await linked(), [home.id, cart.id])
// the left port takes materials
const dragL = (wx, wy) => js(`(() => { __ev('pointermove', 0, 160, -14, { buttons: 0 }); __ev('pointerdown', 0, 160, -14); __ev('pointermove', -60, 200); __ev('pointermove', ${wx}, ${wy}); __ev('pointerup', ${wx}, ${wy}); return 1 })()`)
await dragL(-300, 150)
check('the left port wires a frame in as a material', await js(`editor.nodes.get('${spec.id}').spec.sources ?? []`), [kit.id])
check('and leaves the targets alone', await linked(), [home.id, cart.id])
await mcp('delete_nodes', { ids: [cart.id] })
check('a deleted frame drops out of the list', (await mcp('list_specs')).find((s) => s.id === spec.id).linkedFrames.map((f) => f.name), ['Home'])
await js(`window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'z', code: 'KeyZ', ctrlKey: true })), 1`)
await drag(1100, 150)
await js(`editor.setSelection(['${spec.id}']), new Promise((r) => (requestAnimationFrame(() => requestAnimationFrame(() => r(1))), setTimeout(() => r(0), 400)))`)
// wires: dim by default, lit under the pointer
await js(`(() => { editor.setSelection([]); __ev('pointermove', -200, -30, 0, { buttons: 0 }); return new Promise((r) => (requestAnimationFrame(() => requestAnimationFrame(() => r(1))), setTimeout(() => r(0), 400))) })()`)
await frame()
const wire = await js(`(() => { const w = canvasView.wires.find((w) => w.spec === '${spec.id}' && w.other === '${home.id}'); const p = w.pts[14]; const c = document.querySelector('.canvas-wrap canvas').getBoundingClientRect(); document.querySelector('.canvas-wrap canvas').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: c.left + p.x, clientY: c.top + p.y })); return canvasView.hoverWire })()`)
check('the pointer on a wire lights it', wire, { spec: spec.id, other: home.id })
check('only that wire', await js(`[canvasView.wireLit('${spec.id}', '${home.id}'), canvasView.wireLit('${rules.id}', '${home.id}')]`), [true, false])
check('hovering a frame lights its wires', await js(`(() => { __ev('pointermove', 520, 20, 0, { buttons: 0 }); return [canvasView.hoverFrame === '${home.id}', canvasView.wireLit('${spec.id}', '${home.id}'), canvasView.wireLit('${rules.id}', '${home.id}'), canvasView.wireLit('${rules.id}', '${kit.id}')] })()`), [true, true, true, false])
await js(`new Promise((r) => (requestAnimationFrame(() => requestAnimationFrame(() => r(1))), setTimeout(() => r(0), 400)))`)
if (shot) {
  const res = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(shot, Buffer.from(res.data, 'base64'))
}
console.log(results.join('\n'))
console.log(results.some((r) => r.startsWith('FAIL')) ? 'SOME FAILED' : `all ${results.length} passed`)
ws.close()
