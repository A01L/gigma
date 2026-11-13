// Equal spacing while dragging, as in Figma: the gaps between the layers around form a pattern, the dragged layer snaps
// where its own gap repeats one of them, and every gap of that size is marked.
// Usage: node scripts/test-spacing.mjs [debugPort] [mcpPort] [screenshot.png]   (defaults 9333 / 7331)
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const check = (label, got, want) => results.push(`${same(got, want) ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${same(got, want) ? '' : '  want ' + JSON.stringify(want)}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const proj = await mcp('create_project', { name: 'Spacing test' })
// two columns of pictures on the page: the right one is complete (rows 132 apart), the left one waits for its third
const box = (x, y, w = 160, h = 100) => mcp('create_rectangle', { x, y, width: w, height: h, fill: '#E8743B' })
const l1 = await box(0, 0)
const l2 = await box(0, 232)
const r1 = await box(190, 10, 150, 90)
const r2 = await box(190, 232, 150, 90)
const r3 = await box(190, 454, 150, 90)
// the one that is dragged: dropped roughly where the third of the left column belongs
const drag1 = await box(0, 500)
// a row for the horizontal case: gaps of 40, and a loose one to the right
const h1 = await box(600, 0, 80, 80)
const h2 = await box(720, 0, 80, 80)
const h3 = await box(1000, 300, 80, 80)
await mcp('zoom_to', { ids: [l1.id, r3.id, h3.id, h1.id] })
await mcp('set_selection', { ids: [] })

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
const mouse = async (type, x, y) => {
  if (type === 'mousePressed') await paint()
  return send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })
}
const move = (x, y, down = false) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: down ? 'left' : 'none', buttons: down ? 1 : 0 })
const at = (wx, wy) => js(`(() => { const r = document.querySelector('.canvas-wrap canvas').getBoundingClientRect(), c = editor.camera; return [r.left + ${wx} * c.zoom + c.x, r.top + ${wy} * c.zoom + c.y] })()`)
const pos = (nid) => js(`(() => { const w = editor.world('${nid}'); return [Math.round(w.x * 100) / 100, Math.round(w.y * 100) / 100] })()`)
const gaps = () => js(`canvasView.gaps.map((g) => [g.axis, Math.round(g.from), Math.round(g.to)]).sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1])`)
/** press the middle of a layer and hold it at a world offset; the button stays down so the markers can be read */
const hold = async (nid, w, h, dx, dy) => {
  const [wx, wy] = await js(`(() => { const r = editor.world('${nid}'); return [r.x + r.w / 2, r.y + r.h / 2] })()`)
  const [x1, y1] = await at(wx, wy)
  const [x2, y2] = await at(wx + dx, wy + dy)
  await move(x1, y1)
  await mouse('mousePressed', x1, y1)
  for (let i = 1; i <= 5; i++) await move(x1 + ((x2 - x1) * i) / 5, y1 + ((y2 - y1) * i) / 5, true)
  await wait(120)
  return [x2, y2]
}

// ---- vertical: the left column gets the gap the right column has
let [ex, ey] = await hold(drag1.id, 160, 100, 0, -33) // 500 -> 467, three pixels off
check('the layer snaps where its gap repeats the pattern (132)', await pos(drag1.id), [0, 464])
const g = await gaps()
check('its own gap is marked', g.some((m) => m[0] === 'y' && m[1] === 332 && m[2] === 464), true)
check('and every gap of that size in the pattern: the other column too', g.filter((m) => m[0] === 'y' && m[2] - m[1] === 132).length, 4)
check('a gap of another size is not marked', g.some((m) => m[0] === 'y' && m[2] - m[1] !== 132), false)
if (shot) {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(shot, Buffer.from(s.data, 'base64'))
}
await mouse('mouseReleased', ex, ey)
await wait(150)
check('the markers go when the layer is dropped', await gaps(), [])
check('the layer stays where it snapped', await pos(drag1.id), [0, 464])

// ---- far from any repeat: no snap
;[ex, ey] = await hold(drag1.id, 160, 100, 0, 60)
check('away from the pattern the layer follows the pointer', [(await pos(drag1.id))[1], (await gaps()).filter((m) => m[0] === 'y').length], [524, 0])
await mouse('mouseReleased', ex, ey)
await wait(150)

// ---- horizontal: a third in a row continues the gap of the first two
await js(`editor.act(() => editor.updateNode('${h3.id}', { x: 853, y: 0 }))`)
await wait(100)
;[ex, ey] = await hold(h3.id, 80, 80, -10, 0) // 853 -> 843, the place is 840
check('a third layer in a row continues the gap of the first two (40)', await pos(h3.id), [840, 0])
check('both gaps of the row are marked', (await gaps()).filter((m) => m[0] === 'x'), [['x', 680, 720], ['x', 800, 840]])
await mouse('mouseReleased', ex, ey)
await wait(150)

// ---- between two neighbours: the middle
await js(`editor.act(() => { editor.updateNode('${h3.id}', { x: 1000, y: 0 }); editor.updateNode('${h2.id}', { x: 787, y: 0 }) })`)
await wait(100)
;[ex, ey] = await hold(h2.id, 80, 80, 10, 0) // 787 -> 797; the middle between 680 and 1000 is at 800
check('between two neighbours the layer snaps to the middle', await pos(h2.id), [800, 0])
check('the two equal gaps are marked', (await gaps()).filter((m) => m[0] === 'x'), [['x', 680, 800], ['x', 880, 1000]])
await mouse('mouseReleased', ex, ey)

console.log(results.join('\n'))
console.log(results.some((r) => r.startsWith('FAIL')) ? '\nFAILED' : '\nALL PASSED')
ws.close()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
