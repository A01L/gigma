// Real-mouse test of Figma-like selection and re-parenting. Needs the dev app with --remoteDebuggingPort 9333.
// Usage: node scripts/test-canvas-select.mjs
let mid = 0
async function mcp(name, args = {}) {
  const r = await fetch('http://127.0.0.1:7331/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++mid, method: 'tools/call', params: { name, arguments: args } })
  })
  const j = await r.json()
  if (j.error || j.result?.isError) throw new Error(name + ': ' + JSON.stringify(j.error ?? j.result.content))
  return JSON.parse(j.result.content[0].text)
}
await mcp('create_project', { name: 'Select test' })
const A = await mcp('create_frame', { name: 'A', x: 0, y: 0, width: 300, height: 300 })
const B = await mcp('create_frame', { name: 'B', x: 400, y: 0, width: 300, height: 300 })
const a1 = await mcp('create_rectangle', { name: 'a1', x: 30, y: 30, width: 80, height: 80, fill: '#EF4444', parentId: A.id })
const a2 = await mcp('create_rectangle', { name: 'a2', x: 150, y: 30, width: 80, height: 80, fill: '#F59E0B', parentId: A.id })
const b1 = await mcp('create_rectangle', { name: 'b1', x: 30, y: 30, width: 80, height: 80, fill: '#3B82F6', parentId: B.id })
const loose = await mcp('create_rectangle', { name: 'loose', x: 0, y: 380, width: 80, height: 80, fill: '#10B981' })
await mcp('zoom_to', { ids: [A.id, B.id, loose.id] })
await mcp('set_selection', { ids: [] })

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
const send = (method, params = {}) => new Promise((res) => (pending.set(++id, res), ws.send(JSON.stringify({ id, method, params }))))
const js = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const names = () => js(`editor.selection.map(id => editor.nodes.get(id).name).sort().join(',')`)
const parentOf = (nid) => js(`(editor.nodes.get(editor.nodes.get('${nid}').parentId)||{name:'page'}).name`)
// world -> client coordinates
const pt = async (x, y) => js(`(() => { const r = document.querySelector('.canvas-wrap canvas').getBoundingClientRect(); const c = editor.camera; return [r.x + ${x} * c.zoom + c.x, r.y + ${y} * c.zoom + c.y] })()`)
// synthetic pointer events dispatched inside the page (works even when the window is in the background)
async function drag(from, to) {
  const [x1, y1] = await pt(...from)
  const [x2, y2] = await pt(...to)
  await js(`(() => {
    const c = document.querySelector('.canvas-wrap canvas')
    const ev = (t, x, y, b) => c.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, button: 0, buttons: b, pointerId: 1, bubbles: true }))
    ev('pointermove', ${x1}, ${y1}, 0)
    ev('pointerdown', ${x1}, ${y1}, 1)
    for (let i = 1; i <= 8; i++) ev('pointermove', ${x1} + (${x2} - ${x1}) * i / 8, ${y1} + (${y2} - ${y1}) * i / 8, 1)
    ev('pointerup', ${x2}, ${y2}, 0)
    return 1
  })()`)
  await sleep(120)
}
const click = (p) => drag(p, p)
const results = []
const check = (label, got, want) => {
  results.push(`${got === want ? 'PASS' : 'FAIL'}  ${label}: got "${got}", want "${want}"`)
}
await js(`editor.setTool('move'); 1`)

await drag([10, 250], [260, 20]) // starts on A's empty background
check('marquee started inside frame A selects its children', await names(), 'a1,a2')
await click([270, 270])
check('click on empty frame background clears selection (frame not grabbed)', await names(), '')
await drag([-40, -60], [450, 150]) // from canvas across A (partly) and B (partly)
check('marquee from canvas across two frames takes their children', await names(), 'a1,a2,b1')
await click([900, 500])
await drag([-40, -60], [340, 340]) // encloses A completely
check('marquee enclosing a frame selects the frame itself', await names(), 'A')
await click([900, 500])
await drag([200, 250], [460, 60]) // starts inside A, reaches into B
check('marquee from inside A continuing over B', await names(), 'a2,b1')
await click([900, 500])
await drag([70, 70], [600, 200]) // drag a1 from A into B
check('dragging a layer into another frame re-parents it', await parentOf(a1.id), 'B')
await drag([600, 200], [200, 420]) // out to the canvas
check('dragging it out of the frame puts it on the page', await parentOf(a1.id), 'page')
await click([900, 500])
await drag([40, 420], [200, 200]) // loose layer into A
check('dragging a canvas layer into a frame', await parentOf(loose.id), 'A')
await click([900, 500])
// frame label: just above the top-left corner
const zoom = await js(`editor.camera.zoom`)
await click([4 / zoom, -10 / zoom])
check('clicking the frame name selects the frame', await names(), 'A')
await js(`editor.undo(); 1`)
console.log(results.join('\n'))
ws.close()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
