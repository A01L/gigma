// The fill popover (laid out like Figma's): formats, page colours, styles, dragging, closing.
// Usage: node scripts/test-colorpicker.mjs [debugPort] [mcpPort] [screenshot.png]   (defaults 9333 / 7331)
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
const check = (label, got, want) => (process.env.TRACE && console.error(label), results).push(`${JSON.stringify(got) === JSON.stringify(want) ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(want) ? '' : '  want ' + JSON.stringify(want)}`)

await mcp('create_project', { name: 'Picker test' })
const f = await mcp('create_frame', { name: 'F', x: 0, y: 0, width: 600, height: 400, fill: '#FFFFFF' })
const a = await mcp('create_rectangle', { name: 'a', x: 40, y: 40, width: 200, height: 120, fill: '#D9D9D9', parentId: f.id })
await mcp('create_rectangle', { name: 'b', x: 300, y: 40, width: 100, height: 100, fill: '#2563EB', parentId: f.id })
await mcp('create_rectangle', { name: 'c', x: 300, y: 200, width: 100, height: 100, fill: '#2563EB', parentId: f.id })
await mcp('create_ellipse', { name: 'd', x: 40, y: 220, width: 100, height: 100, fill: '#F59E0B', parentId: f.id })
await mcp('create_style', { kind: 'color', name: 'Brand / Rose', color: '#E11D48' }).catch(() => mcp('create_style', { type: 'color', name: 'Brand / Rose', color: '#E11D48' }))

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
const tick = () => js(`new Promise((r) => setTimeout(r, 250))`)
const fill = () => js(`(() => { const c = editor.nodes.get('${a.id}').fills[0].color; return [c.r, c.g, c.b].map((v) => Math.round(v * 255)).concat(Math.round(c.a * 100)) })()`)
// type into a field of the popover the way a person does: focus, replace the text, Enter
const type = (sel, text) =>
  js(`(() => { const el = document.querySelectorAll('${sel}')[0]; el.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); return 1 })()`)
const pickFormat = async (label) => {
  await js(`document.querySelector('.cpick-format .gsel').click(), 1`)
  await tick()
  const state = await js(`[!!document.querySelector('.gsel-pop'), [...document.querySelectorAll('.gsel-opt')].map((o) => o.textContent.trim())]`)
  if (process.env.TRACE) console.error('menu', label, JSON.stringify(state))
  await js(`[...document.querySelectorAll('.gsel-opt')].find((o) => o.textContent.trim() === '${label}').click(), 1`)
  await tick()
}

await js(`editor.setSelection(['${a.id}']), 1`)
await tick()
await js(`document.querySelector('.panel.right button.swatch').click(), 1`)
await tick()
check('the popover opens with both tabs', await js(`[...document.querySelectorAll('.cpick-head > button:not(.cpick-ico)')].map((b) => b.textContent)`), ['Свой', 'Библиотеки'])
check('fill types are offered', await js(`document.querySelectorAll('.cpick-types button').length`), 3)
check('colours of the page, most used first', await js(`[...document.querySelectorAll('.cpick-swatches button')].map((b) => b.title)`), ['#2563EB', '#FFFFFF', '#D9D9D9', '#F59E0B'])
check('it sits to the left of the panel', await js(`document.querySelector('.cpick').getBoundingClientRect().right <= document.querySelector('.panel.right').getBoundingClientRect().left`), true)

await type('.cpick-values .cpick-input', '10B981')
check('hex', await fill(), [16, 185, 129, 100])
await pickFormat('RGB')
check('RGB shows three numbers and opacity', await js(`[...document.querySelectorAll('.cpick-values .cpick-input')].map((i) => i.value)`), ['16', '185', '129', '100%'])
await type('.cpick-values .cpick-input', '255')
check('RGB: red set to 255', await fill(), [255, 185, 129, 100])
await pickFormat('HSB')
check('HSB values', await js(`[...document.querySelectorAll('.cpick-values .cpick-input')].map((i) => i.value)`), ['27', '49', '100', '100%'])
await pickFormat('HSL')
check('HSL values', await js(`[...document.querySelectorAll('.cpick-values .cpick-input')].map((i) => i.value)`), ['27', '100', '75', '100%'])
await pickFormat('CSS')
await type('.cpick-values .cpick-input', 'rgba(0, 0, 255, 0.5)')
check('CSS: any colour the browser understands', await fill(), [0, 0, 255, 50])
await type('.cpick-values .cpick-input', 'tomato')
check('CSS: colour names', await fill(), [255, 99, 71, 100])
await pickFormat('Hex')
// a swatch of the page
await js(`[...document.querySelectorAll('.cpick-swatches button')].find((b) => b.title === '#F59E0B').click(), 1`)
check('a page colour applies with a click', await fill(), [245, 158, 11, 100])
// dragging by the header
const before = await js(`(() => { const r = document.querySelector('.cpick').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)] })()`)
await js(`(() => { const h = document.querySelector('.cpick-head'); const r = h.getBoundingClientRect(); const o = (x, y) => ({ bubbles: true, clientX: x, clientY: y, pointerId: 1 }); h.dispatchEvent(new PointerEvent('pointerdown', o(r.left + 150, r.top + 10))); window.dispatchEvent(new PointerEvent('pointermove', o(r.left + 90, r.top + 70))); window.dispatchEvent(new PointerEvent('pointerup', o(r.left + 90, r.top + 70))); return 1 })()`)
await tick()
check('the header drags the popover', await js(`(() => { const r = document.querySelector('.cpick').getBoundingClientRect(); return [Math.round(r.left) - ${0}, Math.round(r.top)] })()`), [before[0] - 60, before[1] + 60])
if (shot) {
  await tick()
  writeFileSync(shot, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
}
// libraries
await js(`[...document.querySelectorAll('.cpick-head > button')][1].click(), 1`)
await tick()
check('Libraries lists the colour styles', await js(`[...document.querySelectorAll('.cpick-lib span')].map((s) => s.textContent)`), ['Brand / Rose'])
await js(`document.querySelector('.cpick-lib').click(), 1`)
check('a style applies with a click', await fill(), [225, 29, 72, 100])
if (shot) {
  await tick()
  writeFileSync(shot.replace(/\.png$/, '-libraries.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
}
// the plus saves the current colour as a style
await js(`document.querySelectorAll('.cpick-head .cpick-ico')[0].click(), 1`)
await tick()
check('the plus saves the colour as a style', await js(`editor.meta.colorStyles.map((s) => s.name)`), ['Brand / Rose', '#E11D48'])
// the cross closes; the whole session is one undo step
await js(`document.querySelectorAll('.cpick-head .cpick-ico')[1].click(), 1`)
await tick()
check('the cross closes it', await js(`!!document.querySelector('.cpick')`), false)
await js(`window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'z', code: 'KeyZ', ctrlKey: true })), 1`)
check('one Ctrl+Z undoes the whole picking session', await fill(), [217, 217, 217, 100])
console.log(results.join('\n'))
console.log(results.some((r) => r.startsWith('FAIL')) ? 'SOME FAILED' : `all ${results.length} passed`)
ws.close()
