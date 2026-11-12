// Constraints, wrapping auto layout + live reflow, linked styles, variants, measuring / spacing guides.
// Usage: node scripts/test-batch3.mjs out.png   (dev app with --remoteDebuggingPort 9333)
import { writeFileSync } from 'node:fs'
const out = process.argv[2] ?? 'batch3.png'
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
const rect = (name, x, y, w, h, parentId, fill = '#94A3B8') => mcp('create_rectangle', { name, x, y, width: w, height: h, fill, parentId }).then(json)

await mcp('create_project', { name: 'Batch3 test' })

// ================= constraints =================
const card = json(await mcp('create_frame', { name: 'Card', x: 0, y: 0, width: 400, height: 300, fill: '#FFFFFF' }))
const tl = await rect('left-top', 20, 20, 60, 40, card.id)
const tr = await rect('right-top', 320, 20, 60, 40, card.id)
const st = await rect('stretch', 20, 100, 360, 40, card.id)
const ce = await rect('center', 170, 160, 60, 40, card.id)
const sc = await rect('scale', 100, 220, 200, 60, card.id)
const bo = await rect('bottom', 20, 240, 60, 40, card.id)
await mcp('update_node', { id: tr.id, constraints: { horizontal: 'MAX' } })
await mcp('update_node', { id: st.id, constraints: { horizontal: 'STRETCH' } })
await mcp('update_node', { id: ce.id, constraints: { horizontal: 'CENTER', vertical: 'CENTER' } })
await mcp('update_node', { id: sc.id, constraints: { horizontal: 'SCALE', vertical: 'SCALE' } })
await mcp('update_node', { id: bo.id, constraints: { vertical: 'MAX' } })
await mcp('update_node', { id: card.id, width: 600, height: 450 })
check('default (left, top) stays', box(await get(tl.id)), [20, 20, 60, 40])
check('right keeps the distance to the right edge', box(await get(tr.id)), [520, 20, 60, 40])
check('left and right stretches', box(await get(st.id)), [20, 100, 560, 40])
check('center stays centred on both axes', box(await get(ce.id)), [270, 235, 60, 40])
check('scale grows in proportion', box(await get(sc.id)), [150, 330, 300, 90])
check('bottom keeps the distance to the bottom edge', box(await get(bo.id)), [20, 390, 60, 40])

// ================= wrapping auto layout =================
const wrap = json(await mcp('create_frame', { name: 'Tags', x: 700, y: 0, width: 220, height: 10, fill: '#F1F5F9', layoutMode: 'HORIZONTAL', layoutWrap: 'WRAP', itemSpacing: 10, counterAxisSpacing: 6, padding: 10, counterAxisSizingMode: 'AUTO' }))
const tags = []
for (const [i, w] of [80, 90, 60, 100, 50].entries()) tags.push(await rect('t' + i, 0, 0, w, 30, wrap.id, '#6366F1'))
// inner width 200: [80 90] | [60 100] | [50]
check('wrap: items break into three lines', (await Promise.all(tags.map((t) => get(t.id)))).map((n) => [n.x, n.y]), [[10, 10], [100, 10], [10, 46], [80, 46], [10, 82]])
check('wrap: the frame hugs the lines', (await get(wrap.id)).height, 10 + 30 * 3 + 6 * 2 + 10)
await mcp('update_node', { id: wrap.id, width: 320 })
check('wrap: a wider frame takes more items per line', (await Promise.all(tags.map((t) => get(t.id)))).map((n) => n.y), [10, 10, 10, 46, 46])

// ================= linked styles =================
const brand = json(await mcp('create_style', { kind: 'color', name: 'Brand', color: '#2563EB' }))
const heading = json(await mcp('create_style', { kind: 'text', name: 'Heading', fontSize: 32, fontWeight: 700 }))
const s1 = await rect('s1', 0, 520, 80, 80, undefined)
const s2 = await rect('s2', 100, 520, 80, 80, undefined)
const s3 = await rect('s3', 200, 520, 80, 80, undefined)
const tx1 = json(await mcp('create_text', { text: 'Title', x: 320, y: 520 }))
for (const s of [s1, s2, s3]) await mcp('update_node', { id: s.id, fillStyleId: brand.id })
await mcp('update_node', { id: tx1.id, textStyleId: heading.id })
check('linking applies the style', [(await get(s1.id)).fills[0].color.b > 0.9, (await get(tx1.id)).textStyle.fontSize], [true, 32])
// editing a layer by hand detaches it
await mcp('update_node', { id: s3.id, fill: '#000000' })
check('a hand-edited layer loses the link', (await get(s3.id)).fillStyleId ?? null, null)
await mcp('update_style', { id: brand.id, color: '#DC2626' })
await mcp('update_style', { id: heading.id, fontSize: 48 })
check('changing the style repaints linked layers only', [(await get(s1.id)).fills[0].color.r > 0.8, (await get(s2.id)).fills[0].color.r > 0.8, (await get(s3.id)).fills[0].color.r], [true, true, 0])
check('text style change reaches the text layer and keeps the link', [(await get(tx1.id)).textStyle.fontSize, (await get(tx1.id)).textStyleId === heading.id, (await get(s1.id)).fillStyleId === brand.id], [48, true, true])
check('list_styles', json(await mcp('list_styles')).colors.map((c) => c.name + c.color), ['Brand#dc2626'])
await mcp('delete_style', { id: brand.id })
check('deleting a style keeps the look and removes the link', [(await get(s1.id)).fillStyleId ?? null, (await get(s1.id)).fills[0].color.r > 0.8], [null, true])

// ================= variants =================
const btn = json(await mcp('create_frame', { name: 'Button', x: 0, y: 700, width: 10, height: 10, fill: '#2563EB', cornerRadius: 8, layoutMode: 'HORIZONTAL', padding: [10, 16, 10, 16], primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'AUTO' }))
const lbl = json(await mcp('create_text', { text: 'Button', x: 0, y: 0, fontSize: 14, fontWeight: 600, color: '#FFFFFF', parentId: btn.id }))
await mcp('create_component', { ids: [btn.id] })
const inst = json(await mcp('create_instance', { componentId: btn.id, x: 400, y: 700 }))
await mcp('update_node', { id: inst.layers[0].id, text: 'Send' })
const hover = json(await mcp('add_variant', { componentId: btn.id, name: 'State=Hover' }))
await mcp('update_node', { id: btn.id, name: 'State=Default' })
await mcp('update_node', { id: hover.id, fill: '#1D4ED8' })
const setNode = await get(hover.componentSetId)
check('the first variant creates a component set around both', [setNode.isComponentSet, setNode.name, (await get(btn.id)).parentId === setNode.id, hover.variants.length], [true, 'Button', true, 2])
check('the instance stays where it was and keeps its text', [(await get(inst.id)).x, (await get(inst.layers[0].id)).characters], [400, 'Send'])
const sw = json(await mcp('set_variant', { instanceId: inst.id, properties: { State: 'Hover' } }))
const instN = await get(inst.id)
const instLabel = json(await mcp('find_nodes', { name: 'Send' }))[0] ?? json(await mcp('find_nodes', { type: 'TEXT' })).find((n) => n.parentId === inst.id)
check('set_variant switches the instance to the other variant', [instN.componentId === hover.id, instN.fills[0].color.b < 0.9, sw.properties.State], [true, true, 'Hover'])
check('the text override survives the switch', instLabel ? (await get(instLabel.id)).characters : null, 'Send')
await mcp('update_node', { id: hover.id, cornerRadius: 20 })
check('the instance follows its new variant', (await get(inst.id)).cornerRadius, 20)
void lbl

const png = await mcp('export_png', { id: card.id })
writeFileSync(out, Buffer.from(png[0].data, 'base64'))

// ================= in-page: live reflow, guides, measuring =================
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
  new Promise((res) => (pending.set(++id, res), ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })))).then((r) => r.result?.value ?? r.exceptionDetails?.exception?.description ?? null)

// pointer helpers inside the page
await js(`(() => {
  const c = document.querySelector('.canvas-wrap canvas')
  window.__pt = (wx, wy) => { const b = c.getBoundingClientRect(); return { clientX: b.left + wx * editor.camera.zoom + editor.camera.x, clientY: b.top + wy * editor.camera.zoom + editor.camera.y } }
  window.__ev = (type, wx, wy, extra = {}) => c.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, ...window.__pt(wx, wy), ...extra }))
  return 1
})()`)
// live reflow: drag the first tag to the right, past the second one, and look BEFORE releasing
await mcp('update_node', { id: wrap.id, width: 220 })
await js(`editor.setZoom(1), editor.setSelection(['${tags[0].id}']), 1`)
const w0 = await js(`(() => { const w = editor.world('${tags[0].id}'); return [w.x + 20, w.y + 15] })()`)
const during = await js(`(() => {
  __ev('pointermove', ${w0[0]}, ${w0[1]}, { buttons: 0 })
  __ev('pointerdown', ${w0[0]}, ${w0[1]})
  __ev('pointermove', ${w0[0]} + 60, ${w0[1]})
  __ev('pointermove', ${w0[0]} + 150, ${w0[1]})
  const order = editor.children('${wrap.id}').map((i) => editor.nodes.get(i).name).join(',')
  const second = editor.nodes.get('${tags[1].id}').x
  __ev('pointerup', ${w0[0]} + 150, ${w0[1]})
  return [order, second]
})()`)
check('live reflow: while dragging, the neighbour already took the first slot', during, ['t1,t0,t2,t3,t4', 10])
check('after the drop the dragged tag sits in the second slot', await js(`[editor.nodes.get('${tags[0].id}').x, editor.nodes.get('${tags[0].id}').y]`), [110, 10])
await js(`editor.undo(), 1`)
check('one undo restores the order', await js(`editor.children('${wrap.id}').map((i) => editor.nodes.get(i).name).join(',')`), 't0,t1,t2,t3,t4')

// equal spacing: three boxes in a row, drag the middle one near the centre -> it snaps to equal gaps
const a = await rect('ga', 0, 1000, 60, 60, undefined)
const b = await rect('gb', 107, 1000, 60, 60, undefined)
const c = await rect('gc', 260, 1000, 60, 60, undefined)
await js(`editor.setSelection(['${b.id}']), 1`)
await js(`(() => { __ev('pointermove', 137, 1030, { buttons: 0 }); __ev('pointerdown', 137, 1030); __ev('pointermove', 145, 1030); __ev('pointermove', 158, 1031); __ev('pointerup', 158, 1031); return 1 })()`)
check('equal spacing snap: the middle box lands exactly between its neighbours', (await get(b.id)).x, 130)
void a, c

// Alt measuring draws without errors and only while Alt is held
const measured = await js(`(async () => {
  editor.setSelection(['${tl.id}'])
  const errs = []
  const onErr = (e) => errs.push(e.message)
  window.addEventListener('error', onErr)
  const w = editor.world('${tr.id}')
  __ev('pointermove', w.x + 10, w.y + 10, { buttons: 0 })
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', code: 'AltLeft', altKey: true, bubbles: true }))
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', code: 'AltLeft', bubbles: true }))
  await new Promise((r) => requestAnimationFrame(r))
  window.removeEventListener('error', onErr)
  return [editor.hoverId === '${tr.id}', errs.length]
})()`)
check('Alt measuring: hovered layer is the target, no errors', measured, [true, 0])
console.log(results.join('\n'))
ws.close()
process.exit(results.some((x) => x.startsWith('FAIL')) ? 1 : 0)
