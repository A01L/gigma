// Guideline library: a design system shared by every project, placed on the canvas as a dot or an open card.
// Usage: node scripts/test-guides.mjs [debugPort] [mcpPort] [screenshot.png]   (defaults 9333 / 7331)
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await mcp('create_project', { name: 'Guide test' })
// the library is shared by every project: guidelines made earlier may already be in it
const before = (await mcp('list_guidelines')).length
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
// a covered window draws no frames; taking a screenshot makes it draw one
const paint = () => send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 } })

const home = await mcp('create_frame', { name: 'Home', x: 700, y: 0, width: 360, height: 300, fill: '#FFFFFF' })
const cart = await mcp('create_frame', { name: 'Cart', x: 700, y: 380, width: 360, height: 300, fill: '#FFFFFF' })

// ---- MCP: create, read, link ----
const made = await mcp('create_guideline', {
  name: 'Acme brand',
  description: 'Calm, confident, a lot of air.',
  accent: '#7c3aed',
  colors: [
    { name: 'Violet', role: 'Buttons, links', hex: '#7c3aed' },
    { name: 'Ink', role: 'Text', hex: '#16121f' },
    { name: 'Mist', role: 'Backgrounds', hex: '#f4f1fb' }
  ],
  fonts: [
    { role: 'Heading', family: 'Georgia', weight: 700, size: 36 },
    { role: 'Body', family: 'Inter', weight: 400, size: 16 }
  ],
  rules: 'Radius 12 everywhere.\nNever more than one violet button on a screen.',
  x: 300,
  y: 150,
  frameIds: [home.id]
})
check('create_guideline returns ids', [typeof made.id, typeof made.nodeId, made.name], ['string', 'string', 'Acme brand'])
const node = await mcp('get_node', { id: made.nodeId })
check('a closed guideline is a 72 px dot', [node.type, node.width, node.height, node.guideline.colors.length], ['GUIDE', 72, 72, 3])
const listed = (await mcp('list_guidelines')).find((g) => g.id === made.id)
check('list_guidelines: where it sits', [listed.colors, listed.fonts, listed.onCanvas[0].linkedFrames.map((f) => f.name)], [3, 2, ['Home']])
const view = await mcp('get_guideline', { id: made.id })
check('get_guideline: values and rules', [view.colors[0].hex, view.colors[0].role, view.fonts[0].family, /Radius 12/.test(view.rules)], ['#7c3aed', 'Buttons, links', 'Georgia', true])
check('the frame lists its guideline', (await mcp('get_node', { id: home.id })).guidelines, [{ id: made.id, name: 'Acme brand' }])
const btn = await mcp('create_rectangle', { name: 'btn', x: 24, y: 220, width: 200, height: 52, fill: '#7c3aed', cornerRadius: 12, parentId: home.id })
check('working in the frame reminds of it', [btn.guidelines?.[0]?.name, /get_guideline/.test(btn.note)], ['Acme brand', true])
check('no reminder in a free frame', (await mcp('create_rectangle', { name: 'x', x: 0, y: 0, width: 10, height: 10, parentId: cart.id })).guidelines, undefined)

// ---- colours and fonts are styles of the document, and follow the guideline ----
const styles = await mcp('list_styles')
const styleNames = [...(styles.colorStyles ?? styles.colors ?? []), ...(styles.textStyles ?? styles.texts ?? [])].map((s) => s.name).sort()
check('colours and fonts became styles', styleNames, ['Acme brand / Body', 'Acme brand / Heading', 'Acme brand / Ink', 'Acme brand / Mist', 'Acme brand / Violet'])
await mcp('update_node', { id: btn.id, fillStyleId: view.colors[0].styleId })
await mcp('update_guideline', { id: made.id, colors: [{ name: 'Violet', role: 'Buttons, links', hex: '#0ea5e9' }, { name: 'Ink', role: 'Text', hex: '#16121f' }, { name: 'Mist', role: 'Backgrounds', hex: '#f4f1fb' }] })
check('a layer linked to a guideline colour is repainted', await js(`(() => { const c = editor.nodes.get('${btn.id}').fills[0].color; return [c.r, c.g, c.b].map((v) => Math.round(v * 255)) })()`), [14, 165, 233])

// ---- a guideline as a material of a spec ----
const spec = await mcp('create_spec', { title: 'Cart in the brand style', body: 'Rebuild the cart with the guideline.', x: 240, y: 420, frameIds: [cart.id], sourceIds: [made.nodeId] })
check('a spec takes a guideline as a material', [spec.sourceFrames[0].type, spec.sourceFrames[0].guidelineId], ['GUIDE', made.id])
check('but a guideline is not a place to work', await fails('link_spec', { specId: spec.id, frameIds: [made.nodeId] }), true)
await mcp('link_guideline', { nodeId: made.nodeId, frameIds: [cart.id] })
check('link_guideline', (await mcp('get_node', { id: made.nodeId })).linkedFrames.map((f) => f.name), ['Home', 'Cart'])

// ---- the library on disk and in the editor ----
await wait(700)
const lib = await js(`gigma.guides.list().then((r) => r.guides.filter((g) => g.id === '${made.id}').map((g) => [g.name, g.colors[0].hex]))`)
check('saved in the shared library', lib, [['Acme brand', '#0ea5e9']])
check('the document keeps a copy', await js(`Object.values(editor.meta.guides ?? {}).map((g) => g.name)`), ['Acme brand'])
check('storage statistics count it', await js(`gigma.library.stats().then((s) => [s.guides.length, s.guides.find((g) => g.id === '${made.id}').size > 200])`), [before + 1, true])

// ---- canvas: open / fold, place with a click ----
await js(`(() => {
  const c = document.querySelector('.canvas-wrap canvas')
  window.__ev = (type, wx, wy, dx = 0, extra = {}) => { const r = c.getBoundingClientRect(); c.dispatchEvent(new (type === 'dblclick' ? MouseEvent : PointerEvent)(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: r.left + wx * editor.camera.zoom + editor.camera.x + dx, clientY: r.top + wy * editor.camera.zoom + editor.camera.y, ...extra })) }
  editor.zoomToRect({ x: -520, y: -60, w: 1640, h: 860 }, 1)
  return 1
})()`)
await paint()
await js(`__ev('dblclick', 336, 186), 1`)
const open = await js(`(() => { const n = editor.nodes.get('${made.nodeId}'); return [!!n.guide.open, n.width, n.height > 300] })()`)
check('a double click opens the card', open, [true, 440, true])
// the right port of the open card wires it to a frame
await js(`editor.setSelection(['${made.nodeId}']), 1`)
await paint()
await mcp('link_guideline', { nodeId: made.nodeId, frameIds: [cart.id], mode: 'remove' })
await js(`(() => { const n = editor.nodes.get('${made.nodeId}'); const px = n.x + n.width, py = n.y + 60; __ev('pointermove', px, py, 14, { buttons: 0 }); __ev('pointerdown', px, py, 14); __ev('pointermove', px + 60, py + 40); __ev('pointermove', 800, 500); __ev('pointerup', 800, 500); return 1 })()`)
check('dragging its port to a frame links it', await js(`editor.nodes.get('${made.nodeId}').guide.targets.length`), 2)
// a new guideline from the menu: the next click places it, open
await js(`(() => { editor.pendingGuide = 'new'; editor.setTool('guide'); __ev('pointermove', -480, 0, 0, { buttons: 0 }); __ev('pointerdown', -480, 0); __ev('pointerup', -480, 0); return 1 })()`)
const fresh = await js(`(() => { const n = editor.nodes.get(editor.selection[0]); return [n.type, !!n.guide.open, editor.tool, n.x, n.y] })()`)
check('a click places a new guideline, open for editing', fresh, ['GUIDE', true, 'move', -480, 0])
const freshId = await js(`editor.nodes.get(editor.selection[0]).guide.id`)
const freshNode = await js(`editor.selection[0]`)
await wait(700)
check('it is in the library at once', (await mcp('list_guidelines')).length, before + 2)
if (shot) {
  await js(`(() => { editor.setSelection(['${spec.id}']); return new Promise((r) => setTimeout(r, 500)) })()`)
  const res = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(shot, Buffer.from(res.data, 'base64'))
  await js(`editor.setSelection(['${made.nodeId}']), new Promise((r) => setTimeout(r, 400))`)
  const res2 = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(shot.replace(/\.png$/, '-editor.png'), Buffer.from(res2.data, 'base64'))
}
// an open card cannot be squeezed: it has a minimum width and its height follows its contents
const size = () => js(`(() => { const n = editor.nodes.get('${made.nodeId}'); return [n.x, n.y, n.width, Math.round(n.height)] })()`)
const wide = await size()
await js(`editor.act(() => editor.setWorldRect('${made.nodeId}', { ...editor.world('${made.nodeId}'), w: 150 })), 1`)
const narrow = await size()
check('squeezed from the right: stops at the minimum width, grows taller', [narrow[0], narrow[2], narrow[3] >= wide[3]], [wide[0], 320, true])
await js(`editor.act(() => { const r = editor.world('${made.nodeId}'); editor.setWorldRect('${made.nodeId}', { ...r, x: r.x + 250, w: r.w - 250 }) }), 1`)
check('squeezed from the left: the right edge stays', await size(), narrow)
await js(`editor.act(() => editor.setWorldRect('${made.nodeId}', { ...editor.world('${made.nodeId}'), h: 40 })), 1`)
check('the height cannot be set by hand', await size(), narrow)
await js(`editor.act(() => editor.setWorldRect('${made.nodeId}', { ...editor.world('${made.nodeId}'), w: 440 })), 1`)
check('widened back', await size(), wide)
// fold back into a dot
await js(`editor.setSelection(['${made.nodeId}']), new Promise((r) => setTimeout(r, 300))`)
await js(`document.querySelector('.guide-ins .btn.primary')?.click(), 1`)
check('"Save and fold" turns it back into a dot', await js(`(() => { const n = editor.nodes.get('${made.nodeId}'); return [!!n.guide.open, n.width, n.height] })()`), [false, 72, 72])
// deleting from the library removes it from the project
await js(`gigma.guides.remove('${freshId}'), 1`)
await wait(900)
check('deleted from the library = gone from the project', await js(`editor.nodes.has('${freshNode}')`), false)
check('the other guideline stays', await js(`editor.nodes.has('${made.nodeId}')`), true)
await js(`gigma.guides.remove('${made.id}'), 1`)
await wait(900)
check('its styles leave with it', await js(`(editor.meta.colorStyles ?? []).length + (editor.meta.textStyles ?? []).length`), 0)
check('the layer keeps its colour', await js(`Math.round(editor.nodes.get('${btn.id}').fills[0].color.b * 255)`), 233)
console.log(results.join('\n'))
console.log(results.some((r) => r.startsWith('FAIL')) ? 'SOME FAILED' : `all ${results.length} passed`)
ws.close()
