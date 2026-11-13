// Ctrl+Z / Ctrl+Shift+Z through the real key handler, with the events a Russian layout produces.
// Usage: node scripts/test-undo.mjs [debugPort] [mcpPort]   (defaults 9333 / 7331)
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
const check = (label, got, want) => results.push(`${JSON.stringify(got) === JSON.stringify(want) ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(want) ? '' : '  want ' + JSON.stringify(want)}`)

await mcp('create_project', { name: 'Undo test' })
const f = await mcp('create_frame', { name: 'F', x: 0, y: 0, width: 600, height: 400 })
const a = await mcp('create_rectangle', { name: 'a', x: 50, y: 50, width: 100, height: 100, fill: '#2563EB', parentId: f.id })
const b = await mcp('create_ellipse', { name: 'b', x: 300, y: 50, width: 100, height: 100, fill: '#EC4899', parentId: f.id })

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
const js = (expression) =>
  new Promise((res) => (pending.set(++id, res), ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })))).then((r) => r.result?.value ?? r.exceptionDetails?.exception?.description ?? null)
// what the browser sends for Ctrl+Z on a Russian layout: key "я", physical key KeyZ
const key = (init) => js(`window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ bubbles: true, cancelable: true, ...init })})), 1`)
const undo = () => key({ key: 'я', code: 'KeyZ', ctrlKey: true })
const redo = () => key({ key: 'Я', code: 'KeyZ', ctrlKey: true, shiftKey: true })
await js(`(() => {
  const c = document.querySelector('.canvas-wrap canvas')
  window.__ev = (type, wx, wy, extra = {}) => { const r = c.getBoundingClientRect(); c.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: r.left + wx * editor.camera.zoom + editor.camera.x, clientY: r.top + wy * editor.camera.zoom + editor.camera.y, ...extra })) }
  editor.setZoom(1)
  return 1
})()`)
const pos = (nid) => js(`(() => { const n = editor.nodes.get('${nid}'); return n ? [n.x, n.y] : null })()`)

// 1. drag with the mouse, Ctrl+Z puts the layer back, Ctrl+Shift+Z moves it again
await js(`editor.setSelection(['${a.id}']), 1`)
await js(`(() => { __ev('pointermove', 100, 100, { buttons: 0 }); __ev('pointerdown', 100, 100); __ev('pointermove', 140, 130); __ev('pointermove', 223, 187); __ev('pointerup', 223, 187); return 1 })()`)
const moved = await pos(a.id)
check('the drag moved the layer', moved[0] !== 50 && moved[1] !== 50, true)
await undo()
check('Ctrl+Z after a drag puts it back', await pos(a.id), [50, 50])
await redo()
check('Ctrl+Shift+Z repeats the drag', await pos(a.id), moved)
await undo()

// 2. nudge with the arrow keys
await key({ key: 'ArrowRight', code: 'ArrowRight', shiftKey: true })
check('Shift+arrow nudges by 10', await pos(a.id), [60, 50])
await undo()
check('Ctrl+Z after a nudge', await pos(a.id), [50, 50])

// 3. delete, Ctrl+Z brings the layer back with its place in the frame and the selection
await js(`editor.setSelection(['${b.id}']), 1`)
await key({ key: 'Delete', code: 'Delete' })
check('Delete removes the layer', await pos(b.id), null)
await undo()
check('Ctrl+Z after Delete restores it', [await pos(b.id), await js(`editor.nodes.get('${b.id}')?.parentId === '${f.id}'`), await js(`editor.selection[0] === '${b.id}'`)], [[300, 50], true, true])

// 4. several steps back and forward, one step per action
await js(`editor.setSelection(['${a.id}']), 1`)
for (let i = 0; i < 3; i++) await key({ key: 'ArrowDown', code: 'ArrowDown', shiftKey: true })
check('three nudges', await pos(a.id), [50, 80])
await undo()
await undo()
check('two undos = two steps back', await pos(a.id), [50, 60])
await redo()
check('redo = one step forward', await pos(a.id), [50, 70])
// Ctrl+Y also redoes (Windows habit)
await key({ key: 'н', code: 'KeyY', ctrlKey: true })
check('Ctrl+Y redoes too', await pos(a.id), [50, 80])

// Latin layout
await key({ key: 'z', code: 'KeyZ', ctrlKey: true })
check('Ctrl+Z on a Latin layout', await pos(a.id), [50, 70])

// 5. fields of the inspector
const tick = () => js(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))`)
const field = `[...document.querySelectorAll('.panel.right .field')].find((f) => f.querySelector('.lbl')?.textContent === 'X').querySelector('input')`
const keyIn = (init) => js(`${field}.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ bubbles: true, cancelable: true, ...init })})), 1`)
const type = (text) => js(`(() => { const i = ${field}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`)
// a focused field with nothing typed: Ctrl+Z still undoes on the canvas (and the field lets go of the focus)
await js(`${field}.focus(), 1`)
await tick()
await keyIn({ key: 'я', code: 'KeyZ', ctrlKey: true })
await tick()
check('Ctrl+Z in an untouched field undoes on the canvas', [await pos(a.id), await js(`document.activeElement.tagName`)], [[50, 60], 'BODY'])
// typed text: Ctrl+Z belongs to the field, the canvas stays
await js(`${field}.focus(), 1`)
await tick()
await type('77')
await tick()
await keyIn({ key: 'я', code: 'KeyZ', ctrlKey: true })
check('Ctrl+Z while typing does not undo the canvas', await pos(a.id), [50, 60])
await keyIn({ key: 'Enter', code: 'Enter' })
await tick()
check('Enter applies the typed value', await pos(a.id), [77, 60])
await undo()
check('and Ctrl+Z takes it back in one step', await pos(a.id), [50, 60])
// a focused field must not write its old value back when the layer was moved meanwhile
await js(`${field}.focus(), 1`)
await tick()
const steps = await js(`editor.undoStack.length`)
await js(`editor.act(() => editor.updateNode('${a.id}', { x: 200 })), 1`)
await js(`document.activeElement.blur(), 1`)
await tick()
check('blur of an untouched field changes nothing and adds no undo step', [await pos(a.id), (await js(`editor.undoStack.length`)) - steps], [[200, 60], 1])
// pressing on the canvas takes the keyboard back from a field
await js(`${field}.focus(), 1`)
await tick()
await js(`(() => { __ev('pointerdown', 550, 380); __ev('pointerup', 550, 380); return 1 })()`)
check('a press on the canvas takes the focus from the field', await js(`document.activeElement.tagName`), 'CANVAS')
await js(`editor.setSelection(['${a.id}']), 1`)
await undo()
check('so Ctrl+Z works right after it', await pos(a.id), [50, 60])
console.log(results.join('\n'))
ws.close()
process.exit(results.some((x) => x.startsWith('FAIL')) ? 1 : 0)
