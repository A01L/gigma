// Gradients via MCP + shortcuts / context menu / layer drop logic via in-page events.
// Usage: node scripts/test-batch1.mjs out.png   (dev app with --remoteDebuggingPort 9333)
import { writeFileSync } from 'node:fs'
const out = process.argv[2] ?? 'batch1.png'
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
await mcp('create_project', { name: 'Batch1 test' })
const f = json(await mcp('create_frame', { name: 'F', x: 0, y: 0, width: 640, height: 300, fill: '#0F172A' }))
const a = json(await mcp('create_rectangle', { name: 'a', x: 30, y: 40, width: 260, height: 200, cornerRadius: 24, parentId: f.id }))
await mcp('update_node', { id: a.id, fills: [{ type: 'GRADIENT_LINEAR', angle: 135, stops: [{ position: 0, color: '#F97316' }, { position: 0.5, color: '#EC4899' }, { position: 1, color: '#6366F1' }] }] })
const b = json(await mcp('create_ellipse', { name: 'b', x: 350, y: 40, width: 200, height: 200, parentId: f.id }))
await mcp('update_node', { id: b.id, fills: [{ type: 'GRADIENT_RADIAL', stops: [{ position: 0, color: '#FDE68A' }, { position: 1, color: '#F59E0B00' }] }] })
const svg = json(await mcp('export_svg', { id: a.id }))
const png = await mcp('export_png', { id: f.id })
writeFileSync(out, Buffer.from(png[0].data, 'base64'))

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
const results = []
const check = (label, got, want) => results.push(`${JSON.stringify(got) === JSON.stringify(want) ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}`)
const key = (init) => js(`window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ bubbles: true, ...init })})), 1`)
const N = (name) => `[...editor.nodes.values()].find(n => n.name === '${name}')`

if (!/fill="url\(#g/.test(svg)) console.log('SVG:', svg.slice(0, 600))
check('svg export contains a linearGradient',/<linearGradient/.test(svg) && /fill="url\(#g/.test(svg), true)
await js(`editor.setSelection([${N('a')}.id]), 1`)
await key({ key: '5', code: 'Digit5' })
check('digit 5 sets opacity to 50%', await js(`${N('a')}.opacity`), 0.5)
await key({ key: 'H', code: 'KeyH', ctrlKey: true, shiftKey: true })
check('Ctrl+Shift+H hides the layer', await js(`${N('a')}.visible`), false)
await key({ key: 'H', code: 'KeyH', ctrlKey: true, shiftKey: true })
await key({ key: 'L', code: 'KeyL', ctrlKey: true, shiftKey: true })
check('Ctrl+Shift+L locks the layer', await js(`${N('a')}.locked`), true)
await key({ key: 'L', code: 'KeyL', ctrlKey: true, shiftKey: true })
await key({ key: 'H', code: 'KeyH', shiftKey: true })
check('Shift+H flips horizontally', await js(`${N('a')}.flipX`), true)
await key({ key: 'Tab', code: 'Tab' })
check('Tab selects the next sibling', await js(`editor.nodes.get(editor.selection[0]).name`), 'b')
await key({ key: 'Enter', code: 'Enter', shiftKey: true })
check('Shift+Enter selects the parent', await js(`editor.nodes.get(editor.selection[0]).name`), 'F')
await js(`editor.setSelection([${N('a')}.id]), 1`)
await key({ key: 'c', code: 'KeyC', ctrlKey: true, altKey: true })
await js(`editor.setSelection([${N('b')}.id]), 1`)
await key({ key: 'v', code: 'KeyV', ctrlKey: true, altKey: true })
check('Ctrl+Alt+C / V copies properties (fill type)', await js(`${N('b')}.fills[0].type`), 'GRADIENT_LINEAR')
await js(`editor.setSelection([${N('a')}.id, ${N('b')}.id]), 1`)
await key({ key: 'g', code: 'KeyG', ctrlKey: true, altKey: true })
check('Ctrl+Alt+G wraps the selection in a frame', await js(`(() => { const p = editor.nodes.get(${N('a')}.parentId); return p.type + ':' + p.name })()`), 'FRAME:Frame')
// context menu opens on right click and lists Figma's items
await js(`(() => { const c = document.querySelector('.canvas-wrap canvas'); const r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu', { clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, bubbles: true, cancelable: true })); return 1 })()`)
await new Promise((r) => setTimeout(r, 300))
check('context menu opens with items', await js(`document.querySelectorAll('.ctx-menu .tool-menu-item').length > 5`), true)
await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 1`)
console.log(results.join('\n'))
ws.close()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
