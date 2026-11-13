// The cursor of an AI client on the canvas: appears on the layer it touched, signed with the client's name, pops at the end.
// Usage: node scripts/test-ai-cursor.mjs [debugPort] [mcpPort] [screenshot.png]   (defaults 9333 / 7331)
import { writeFileSync } from 'node:fs'
const port = process.argv[2] ?? '9333'
const mcpPort = process.argv[3] ?? '7331'
const shot = process.argv[4]
let mid = 0
const rpc = async (method, params, headers = {}) =>
  (await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++mid, method, params }) })).json()
async function mcp(name, args = {}, headers) {
  const j = await rpc('tools/call', { name, arguments: args }, headers)
  if (j.error || j.result?.isError) throw new Error(name + ': ' + JSON.stringify(j.error ?? j.result.content))
  return JSON.parse(j.result.content[0].text)
}
const results = []
const check = (label, got, want) => results.push(`${JSON.stringify(got) === JSON.stringify(want) ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(want) ? '' : '  want ' + JSON.stringify(want)}`)

// the client says who it is once, like every MCP client does
await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.0.0' } })
await mcp('create_project', { name: 'Cursor test' })

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
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const cursors = () => js(`[...document.querySelectorAll('.ai-cursor:not(.pop)')].map((c) => c.querySelector('.ai-cursor-name').textContent)`)
// screen position of the tip, relative to the canvas
const tip = () => js(`(() => { const c = document.querySelector('.ai-cursor:not(.pop)'); if (!c) return null; const m = new DOMMatrix(getComputedStyle(c).transform); return [m.e + 4, m.f + 3] })()`)
const corner = (nid) => js(`(() => { const w = editor.world('${nid}'), c = editor.camera; return [Math.round((w.x + w.w) * c.zoom + c.x - 6), Math.round((w.y + w.h) * c.zoom + c.y - 6)] })()`)

await js(`editor.zoomToRect({ x: -100, y: -100, w: 1000, h: 700 }, 1), 1`)
await mcp('get_document')
check('reading does not bring a cursor', await cursors(), [])
const frame = await mcp('create_frame', { name: 'Card', x: 0, y: 0, width: 400, height: 300, fill: '#FFFFFF' })
check('a cursor appears, signed with the client', await cursors(), ['Claude'])
check('at the corner of the new frame', await tip(), await corner(frame.id))
const title = await mcp('create_text', { text: 'Hello', x: 32, y: 32, fontSize: 32, parentId: frame.id })
check('it jumps to the next layer', await tip(), await corner(title.id))
check('still one cursor', (await cursors()).length, 1)
await mcp('get_node', { id: frame.id })
check('reading leaves it where it was', await tip(), await corner(title.id))
const btn = await mcp('create_rectangle', { name: 'btn', x: 32, y: 220, width: 160, height: 48, fill: '#0C8CE9', cornerRadius: 12, parentId: frame.id })
await mcp('update_node', { id: btn.id, x: 200 })
check('update_node points at the changed layer', await tip(), await corner(btn.id))
await js(`editor.setZoom(editor.camera.zoom * 1.5), new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))`)
check('it follows the layer when the view changes', await tip(), await corner(btn.id))
check('the name is hidden until hover', await js(`getComputedStyle(document.querySelector('.ai-cursor-name')).opacity`), '0')
check('it glows', await js(`getComputedStyle(document.querySelector('.ai-cursor-glow')).animationName.includes('ai-cursor-glow')`), true)
// a second client, named by the stdio bridge header
await mcp('create_ellipse', { x: 500, y: 40, width: 120, height: 120, fill: '#EC4899' }, { 'x-gigma-client': 'codex-mcp-client' })
check('another client gets its own cursor', (await cursors()).sort(), ['Claude', 'Codex'])
check('the user cursor is the Figma arrow', await js(`(() => { const c = document.querySelector('.canvas-wrap canvas'); c.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: c.getBoundingClientRect().left + 30, clientY: c.getBoundingClientRect().top + 30 })); return c.style.cursor.startsWith('url("data:image/svg+xml') })()`), true)
if (shot) {
  await js(`document.querySelectorAll('.ai-cursor').forEach((c) => c.classList.add('named')), new Promise((r) => setTimeout(r, 400))`)
  const res = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(shot, Buffer.from(res.data, 'base64'))
  await js(`document.querySelectorAll('.ai-cursor').forEach((c) => c.classList.remove('named')), 1`)
}
// the end of the work: the cursor pops and is removed
await js(`aiCursor.finish('Codex'), 1`)
check('popping', await js(`document.querySelectorAll('.ai-cursor.pop').length`), 1)
await wait(700)
check('gone after the pop', await js(`[...document.querySelectorAll('.ai-cursor')].map((c) => c.querySelector('.ai-cursor-name').textContent)`), ['Claude'])
console.log(results.join('\n'))
console.log(results.some((r) => r.startsWith('FAIL')) ? 'SOME FAILED' : `all ${results.length} passed`)
ws.close()
