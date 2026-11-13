// Side panels (layers, inspector) are widened by dragging their edge: the usual width is the minimum, twice that the maximum.
// Usage: node scripts/test-panels.mjs [debugPort] [mcpPort] [screenshot.png]   (defaults 9333 / 7331)
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
const check = (label, got, want) => results.push(`${JSON.stringify(got) === JSON.stringify(want) ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(want) ? '' : '  want ' + JSON.stringify(want)}`)

await mcp('create_project', { name: 'Panels test' })
const f = await mcp('create_frame', { name: 'A frame with a rather long name to see the layers panel', x: 0, y: 0, width: 400, height: 300, fill: '#FFFFFF' })
const r = await mcp('create_rectangle', { name: 'rect', x: 40, y: 40, width: 200, height: 120, fill: '#2563EB', parentId: f.id })
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.filter((p) => p.type === 'page' && p.url.includes('#doc=')).pop()
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res) => ws.addEventListener('open', res, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  pending.get(m.id)?.(m.result)
})
const send = (method, params) => new Promise((res) => (pending.set(++id, res), ws.send(JSON.stringify({ id, method, params }))))
const js = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((x) => x.result?.value ?? x.exceptionDetails?.exception?.description ?? null)
const tick = () => js(`new Promise((res) => setTimeout(res, 200))`)

await js(`(() => {
  localStorage.removeItem('gigma-left-panel-w'); localStorage.removeItem('gigma-right-panel-w')
  window.__w = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().width)
  // drag the grip of a side by dx screen pixels
  window.__grip = (side, dx) => { const g = document.querySelector('.panel-grip.' + side + ' .panel-grip-hit'); const b = g.getBoundingClientRect(); const o = (x) => ({ bubbles: true, cancelable: true, pointerId: 1, clientX: x, clientY: b.top + 200 }); g.dispatchEvent(new PointerEvent('pointerdown', o(b.left + 4))); window.dispatchEvent(new PointerEvent('pointermove', o(b.left + 4 + dx / 2))); window.dispatchEvent(new PointerEvent('pointermove', o(b.left + 4 + dx))); window.dispatchEvent(new PointerEvent('pointerup', o(b.left + 4 + dx))) }
  editor.setSelection(['${r.id}'])
  return 1
})()`)
await tick()
check('both panels start at the usual width', await js(`[__w('.panel.left'), __w('.panel.right')]`), [240, 240])
const canvas0 = await js(`__w('.canvas-wrap')`)
await js(`__grip('left', 100), 1`)
await tick()
check('the edge of the layers panel drags it wider', await js(`__w('.panel.left')`), 340)
check('the canvas gives up that room', await js(`__w('.canvas-wrap')`), canvas0 - 100)
check('and is redrawn at its new size', await js(`Math.round(document.querySelector('.canvas-wrap canvas').getBoundingClientRect().width)`), canvas0 - 100)
await js(`__grip('left', 400), 1`)
await tick()
check('not wider than twice the usual width', await js(`__w('.panel.left')`), 480)
await js(`__grip('left', -900), 1`)
await tick()
check('not narrower than the usual width', await js(`__w('.panel.left')`), 240)
await js(`__grip('right', -130), 1`)
await tick()
check('the inspector widens to the left', await js(`__w('.panel.right')`), 370)
await js(`__grip('right', -500), 1`)
await tick()
check('the inspector stops at twice its width too', await js(`__w('.panel.right')`), 480)
check('the width is remembered', await js(`[localStorage.getItem('gigma-left-panel-w'), localStorage.getItem('gigma-right-panel-w')]`), ['240', '480'])
await js(`__grip('left', 160), 1`)
await tick()
if (shot) writeFileSync(shot, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
check('nothing in the wide inspector sticks out', await js(`(() => { const p = document.querySelector('.panel.right').getBoundingClientRect(); return [...document.querySelectorAll('.panel.right *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > p.right + 1 || b.left < p.left - 1) }).length })()`), 0)
await js(`document.querySelector('.panel-grip.right .panel-grip-hit').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), 1`)
await tick()
check('a double click on the edge puts the usual width back', await js(`__w('.panel.right')`), 240)
await js(`document.querySelector('.panel-grip.left .panel-grip-hit').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), 1`)
console.log(results.join('\n'))
console.log(results.some((x) => x.startsWith('FAIL')) ? 'SOME FAILED' : `all ${results.length} passed`)
ws.close()
