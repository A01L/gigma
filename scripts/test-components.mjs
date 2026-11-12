// Components / instances, outline stroke, grouping shortcuts (also on a Russian layout), context menu.
// Usage: node scripts/test-components.mjs out.png   (dev app with --remoteDebuggingPort 9333)
import { writeFileSync } from 'node:fs'
const out = process.argv[2] ?? 'components.png'
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

await mcp('create_project', { name: 'Components test' })
const bg = json(await mcp('create_frame', { name: 'BG', x: 0, y: 0, width: 760, height: 300, fill: '#F8FAFC' }))

// ---- a button component: auto layout frame with a label ----
const btn = json(await mcp('create_frame', { name: 'Button', x: 30, y: 30, width: 10, height: 10, fill: '#2563EB', cornerRadius: 10, parentId: bg.id, layoutMode: 'HORIZONTAL', padding: [10, 18, 10, 18], primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'AUTO' }))
const label = json(await mcp('create_text', { text: 'Button', x: 0, y: 0, fontSize: 15, fontWeight: 600, color: '#FFFFFF', parentId: btn.id }))
const comp = json(await mcp('create_component', { ids: [btn.id] }))
check('a single frame becomes the component itself', [comp.id === btn.id, (await get(btn.id)).isComponent], [true, true])
const i1 = json(await mcp('create_instance', { componentId: btn.id, x: 200, y: 30, parentId: bg.id }))
const i2 = json(await mcp('create_instance', { componentId: btn.id, x: 400, y: 30, parentId: bg.id }))
check('instance gets the layers of the component', [i1.layers.length, i1.layers[0].type, i1.width === (await get(btn.id)).width], [1, 'TEXT', true])
// override the text of the second instance
await mcp('update_node', { id: i2.layers[0].id, text: 'Buy now' })
// change the main component: colour, radius and text
await mcp('update_node', { id: btn.id, fill: '#16A34A', cornerRadius: 20 })
await mcp('update_node', { id: label.id, text: 'Continue' })
const n1 = await get(i1.id)
const n2 = await get(i2.id)
check('instances follow the fill and radius of the main component', [n1.fills[0].color.g > 0.6, n1.cornerRadius, n2.cornerRadius], [true, 20, 20])
check('instance without overrides follows the text', (await get(i1.layers[0].id)).characters, 'Continue')
check('overridden text is kept', (await get(i2.layers[0].id)).characters, 'Buy now')
check('instances hug their own text (auto layout re-run)', [n1.width === (await get(btn.id)).width, n2.width !== n1.width], [true, true])
check('instances keep their own position', [n1.x, n2.x], [200, 400])
// adding a layer to the main component adds it to every instance
const dot = json(await mcp('create_ellipse', { name: 'dot', x: 0, y: 0, width: 8, height: 8, fill: '#FDE047', parentId: btn.id }))
check('a new layer of the main component appears in instances', json(await mcp('find_nodes', { name: 'dot' })).length, 3)
await mcp('delete_nodes', { ids: [dot.id] })
check('a deleted layer disappears from instances', json(await mcp('find_nodes', { name: 'dot' })).length, 0)
// detach
await mcp('detach_instance', { ids: [i1.id] })
await mcp('update_node', { id: btn.id, fill: '#DC2626' })
check('detached instance no longer follows', [(await get(i1.id)).componentId ?? null, (await get(i1.id)).fills[0].color.g > 0.6, (await get(i2.id)).fills[0].color.r > 0.8], [null, true, true])

// ---- outline stroke ----
const ring = json(await mcp('create_ellipse', { name: 'ring', x: 40, y: 130, width: 120, height: 120, stroke: '#0EA5E9', strokeWeight: 16, parentId: bg.id }))
const outlined = json(await mcp('outline_stroke', { ids: [ring.id] }))
const ov = await get(outlined[0].id)
check('outline of a stroke-only ellipse: one vector, same box (inside stroke), stroke colour as fill', [ov.type, ov.width, ov.height, ov.strokes.length, ov.fills[0].color.b > 0.8], ['VECTOR', 120, 120, 0, true])
const card = json(await mcp('create_rectangle', { name: 'card', x: 220, y: 130, width: 140, height: 120, fill: '#FDE68A', stroke: '#B45309', strokeWeight: 10, cornerRadius: 24, parentId: bg.id }))
await mcp('update_node', { id: card.id, strokeAlign: 'OUTSIDE' })
const o2 = json(await mcp('outline_stroke', { ids: [card.id] }))
const cv = await get(o2[0].id)
check('filled shape keeps its fill layer; outside stroke grows the box by the weight', [cv.width, cv.height, cv.x, (await get(card.id)).strokes.length, (await get(card.id)).fills.length], [160, 140, 210, 0, 1])
const line = json(await mcp('create_shape', { kind: 'line', x: 420, y: 150, width: 200, height: 80, stroke: '#7C3AED', strokeWeight: 12, parentId: bg.id }))
const o3 = json(await mcp('outline_stroke', { ids: [line.id] }))
const lv = await get(o3[0].id)
check('outline of a line is a filled vector', [lv.type, lv.fills.length, lv.path.length > 10], ['VECTOR', 1, true])

const png = await mcp('export_png', { id: bg.id })
writeFileSync(out, Buffer.from(png[0].data, 'base64'))

// ---- in-page: shortcuts and menu ----
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

const r = []
for (let i = 0; i < 6; i++) r.push(json(await mcp('create_rectangle', { name: 'r' + i, x: 20 + i * 60, y: 340 + (i % 2) * 30, width: 50, height: 50, fill: '#94A3B8' })).id)
const sel = (ids) => js(`editor.setSelection(${JSON.stringify(ids)}), 1`)
const parentOf = (nid) => js(`(() => { const p = editor.nodes.get(editor.nodes.get('${nid}').parentId); return p ? p.type + ':' + editor.children(p.id).length : null })()`)
// Ctrl+G with a Russian layout: the key is "п", the physical key is still KeyG
await sel(r)
await key({ key: 'п', code: 'KeyG', ctrlKey: true })
check('Ctrl+G groups six layers (Russian layout)', await parentOf(r[0]), 'GROUP:6')
await key({ key: 'П', code: 'KeyG', ctrlKey: true, shiftKey: true })
check('Ctrl+Shift+G ungroups (Russian layout)', [await parentOf(r[0]), await js(`editor.selection.length`)], [null, 6])
await key({ key: 'п', code: 'KeyG', ctrlKey: true, altKey: true })
check('Ctrl+Alt+G puts all six into one frame', await parentOf(r[0]), 'FRAME:6')
check('the frame is the selection and wraps the layers', await js(`(() => { const f = editor.nodes.get(editor.selection[0]); return [f.type, f.width, f.height] })()`), ['FRAME', 350, 80])
await key({ key: 'к', code: 'KeyR', bubbles: true })
check('tool shortcut works on a Russian layout (R = rectangle)', await js(`editor.tool`), 'rect')
await key({ key: 'м', code: 'KeyV' })
// Ctrl+Alt+K on the frame, Ctrl+D makes an instance, Ctrl+Alt+B detaches
await key({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true })
check('Ctrl+Alt+K makes a component', await js(`editor.nodes.get(editor.selection[0]).isComponent`), true)
const mainId = await js(`editor.selection[0]`)
await js(`editor.duplicate(editor.selection, 10), 1`)
check('duplicating a main component gives an instance with its layers', await js(`(() => { const n = editor.nodes.get(editor.selection[0]); return [n.componentId === '${mainId}', !!n.isComponent, editor.children(n.id).length] })()`), [true, false, 6])
await key({ key: 'b', code: 'KeyB', ctrlKey: true, altKey: true })
check('Ctrl+Alt+B detaches', await js(`(() => { const n = editor.nodes.get(editor.selection[0]); return [n.componentId ?? null, editor.children(n.id).every(c => !editor.nodes.get(c).sourceId)] })()`), [null, true])
// ] and [ change the order
await sel([r[0]])
await key({ key: ']', code: 'BracketRight' })
check('] brings to front', await js(`(() => { const p = editor.nodes.get('${r[0]}').parentId; const k = editor.children(p); return k[k.length - 1] === '${r[0]}' })()`), true)
// move to another page
const p2 = json(await mcp('create_page', { name: 'Second' }))
await mcp('set_current_page', { pageId: json(await mcp('list_pages'))[0].id })
await js(`(async () => { const { layerActions } = await import('/ui/layerActions.ts'); editor.setSelection(['${ring.id}'].filter(i => editor.nodes.has(i)).concat(['${o2[0].id}'])); layerActions.moveToPage('${p2.id ?? ''}'); return 1 })()`)
check('move to page', await js(`editor.nodes.get('${o2[0].id}').pageId === '${p2.id}'`), true)
await js(`editor.undo(), 1`)
// context menu: Figma's order, submenus
await sel([btn.id])
await js(`(() => { const c = document.querySelector('.canvas-wrap canvas'); const b = c.getBoundingClientRect(); const w = editor.world('${btn.id}'); c.dispatchEvent(new MouseEvent('contextmenu', { clientX: b.left + (w.x + 5) * editor.camera.zoom + editor.camera.x, clientY: b.top + (w.y + 5) * editor.camera.zoom + editor.camera.y, bubbles: true, cancelable: true })); return 1 })()`)
const labels = await js(`new Promise(r => requestAnimationFrame(() => r([...document.querySelectorAll('.ctx-menu .tm-label')].map(e => e.textContent))))`)
check('menu starts like Figma', (labels ?? []).slice(0, 4).length, 4)
check('menu has the items of the screenshot', await js(`(() => { const all = [...document.querySelectorAll('.ctx-menu .tool-menu-item')]; return ['Ctrl+Shift+R', 'Ctrl+Alt+G', 'Alt+Shift+F', 'Ctrl+Alt+O', 'Ctrl+Alt+M', 'Ctrl+Shift+H', 'Ctrl+Shift+L', 'Shift+H', 'Shift+V'].every(k => all.some(b => b.querySelector('.tm-key')?.textContent === k)) })()`), true)
check('submenu "Select layer" lists the layers under the cursor', await js(`(async () => { const item = [...document.querySelectorAll('.ctx-menu .tool-menu-item')].filter(b => b.querySelector('.tm-key')?.textContent === '›')[1]; item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); const panels = document.querySelectorAll('.ctx-menu'); return [panels.length, [...panels[1].querySelectorAll('.tm-label')].map(e => e.textContent)] })()`), [2, ['Button', 'BG']])
await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 1`)
console.log(results.join('\n'))
ws.close()
process.exit(results.some((x) => x.startsWith('FAIL')) ? 1 : 0)
