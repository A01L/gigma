// A code block stays on screen while a sharper picture of it is rendered, a picture larger than its frame stays in
// the frame while it is moved inside it, and the list of layers has a live search.
// Usage: node scripts/test-layers-search.mjs [debugPort] [mcpPort]   (defaults 9333 / 7331)
const port = process.argv[2] ?? '9333'
const mcpPort = process.argv[3] ?? '7331'
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

const proj = await mcp('create_project', { name: 'Layers search ' + Date.now().toString(36) })
await mcp('show_tab', {})
await wait(800)
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((p) => p.type === 'page' && p.url.includes('#doc=' + encodeURIComponent(proj.path)))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); pending.get(m.id)?.(m.result) })
const send = (method, params) => new Promise((res) => (pending.set(++id, res), ws.send(JSON.stringify({ id, method, params }))))
const js = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r.result?.value ?? r.exceptionDetails?.exception?.description ?? null)
const paint = () => send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 } })
const ev = (type, x, y, down, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !down ? 'none' : 'left', buttons: down ? 1 : 0, clickCount: 1, ...extra })
const at = (wx, wy) => js(`(() => { const r = document.querySelector('.canvas-wrap canvas').getBoundingClientRect(), c = editor.camera; return [r.left + ${wx} * c.zoom + c.x, r.top + ${wy} * c.zoom + c.y] })()`)
const drag = async (a, b, extra = {}) => {
  await ev('mouseMoved', a[0], a[1], false)
  await paint()
  await ev('mousePressed', a[0], a[1], true, extra)
  for (let i = 1; i <= 8; i++) await ev('mouseMoved', a[0] + ((b[0] - a[0]) * i) / 8, a[1] + ((b[1] - a[1]) * i) / 8, true, extra)
  await ev('mouseReleased', b[0], b[1], false, extra)
  await wait(250)
}
// the colour of the canvas at a point of the page
const pixel = (wx, wy) => js(`(() => { const c = document.querySelector('.canvas-wrap canvas'); const k = c.width / c.getBoundingClientRect().width; const cam = editor.camera; const d = c.getContext('2d').getImageData(Math.round((${wx} * cam.zoom + cam.x) * k), Math.round((${wy} * cam.zoom + cam.y) * k), 1, 1).data; return [d[0], d[1], d[2]] })()`)

// ================================================================ a code block while it is being rendered again
const code = await mcp('create_code', { name: 'block', x: 0, y: 0, width: 400, height: 300, html: '<div class="b"></div>', css: '.b { width: 400px; height: 300px; background: #e01010; }' })
await mcp('zoom_to', { ids: [code.id] })
await js(`(editor.camera.zoom = 0.4, editor.camera.x = 300, editor.camera.y = 200, editor.emit('camera'))`)
let first = null
for (let i = 0; i < 40 && !(first && first[0] > 200 && first[1] < 60); i++) { await wait(250); await paint(); first = await pixel(200, 150) }
check('a code block is drawn', first[0] > 200 && first[1] < 60, true)
// the zoom jumps by eight times: a sharper picture is needed, and until it is ready the old one is shown
await js(`(editor.camera.zoom = 3.2, editor.camera.x = 300 - 200 * 3.2 + 200 * 0.4, editor.camera.y = 200 - 150 * 3.2 + 150 * 0.4, editor.emit('camera'))`)
await paint()
const soon = await pixel(200, 150)
check('zoomed in at once, the block is still there (its last picture is shown while the sharp one is rendered)', soon[0] > 200 && soon[1] < 60, true)
// resized: again another picture, again no gap
await mcp('update_node', { id: code.id, width: 420 })
await paint()
const resized = await pixel(200, 150)
check('resized, the block is still there', resized[0] > 200 && resized[1] < 60, true)
await mcp('delete_nodes', { ids: [code.id] })

// ================================================================ a picture larger than its frame, moved inside the frame
const frame = await mcp('create_frame', { name: 'Card', x: 0, y: 0, width: 300, height: 400, fill: '#FFFFFF' })
const big = await mcp('create_rectangle', { name: 'Photo of a house', parentId: frame.id, x: -50, y: -40, width: 420, height: 520, fill: '#3355AA' })
await mcp('zoom_to', { ids: [frame.id] })
await mcp('set_selection', { ids: [big.id] })
await wait(400)
await drag(await at(150, 150), await at(150, 190))
check('a layer larger than its frame stays in the frame while it is moved inside it', await js(`(() => { const n = editor.nodes.get('${big.id}'); return [n.parentId === '${frame.id}', n.x, n.y] })()`), [true, -50, 0])
// the cursor leaves the frame: now it goes out
await drag(await at(150, 190), await at(700, 190))
check('it leaves the frame when the cursor does', await js(`editor.nodes.get('${big.id}').parentId`), null)

// ================================================================ the search of the layers
await mcp('create_text', { parentId: frame.id, x: 10, y: 10, text: 'Price from 380 000', fontSize: 20, color: '#111111' })
await mcp('create_rectangle', { name: 'Button', parentId: frame.id, x: 10, y: 300, width: 100, height: 40, fill: '#CCAA22' })
const farOne = await mcp('create_rectangle', { name: 'House far away', x: 9000, y: 9000, width: 100, height: 100, fill: '#22AA66' })
await mcp('set_selection', { ids: [] })
await wait(300)
const names = () => js(`[...document.querySelectorAll('.layers .list-row .name')].map((e) => e.textContent)`)
check('without a search the list is the tree', (await names()).slice(0, 3), ['House far away', 'Photo of a house', 'Card'])
await js(`document.querySelector('.panel.left .section-title .icon-btn[title*="Ctrl+F"]').click()`)
await wait(200)
const type = (text) => js(`(() => { const i = document.querySelector('.layer-search input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return document.activeElement === i })()`)
check('the search field opens with the cursor in it', await type('hou'), true)
await wait(200)
check('layers are found as the words are typed, whatever the case, at any depth', await names(), ['House far away', 'Photo of a house'])
check('the found part of a name is marked', await js(`[...document.querySelectorAll('.layers mark')].map((e) => e.textContent)`), ['Hou', 'hou'])
await type('380')
await wait(200)
check('a text layer is found by what it says', (await names()).length, 1)
await type('button')
await wait(200)
check('a layer inside a frame is found on its own, without its frame', await names(), ['Button'])
await type('zzzz')
await wait(200)
check('nothing found is said so', await js(`!!document.querySelector('.layers-empty')`), true)
await type('far')
await wait(200)
await js(`document.querySelector('.layers .list-row').click()`)
await wait(300)
check('a press on a found layer selects it and brings it into view', await js(`(() => { const w = editor.world('${farOne.id}'), v = editor.visibleWorldRect(); return [editor.selection[0] === '${farOne.id}', w.x >= v.x && w.y >= v.y && w.x + w.w <= v.x + v.w && w.y + w.h <= v.y + v.h] })()`), [true, true])
await js(`document.querySelector('.layer-search input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
await wait(200)
check('Escape closes the search and the tree is back', [await js(`!!document.querySelector('.layer-search')`), (await names()).includes('Card')], [false, true])
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 2 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 2 })
await wait(300)
check('Ctrl+F opens the search', await js(`!!document.querySelector('.layer-search input')`), true)

console.log(results.join('\n'))
console.log(results.filter((r) => r.startsWith('FAIL')).length ? 'SOME FAILED' : 'ALL PASSED')
ws.close()
process.exit(0)
