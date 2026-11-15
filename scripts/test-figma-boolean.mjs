// A boolean operation pasted from Figma stays a boolean group, vectors show their shape in the list of layers,
// and a text turned into outlines is a group of letters (a group per word when there are several).
// Usage: node scripts/test-figma-boolean.mjs [debugPort] [mcpPort]   (defaults 9333 / 7331)
import { deflateRawSync } from 'node:zlib'
import { compileSchema, parseSchema, encodeBinarySchema } from 'kiwi-schema'
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

// ---------------------------------------------------------------- a clipboard as Figma writes it (its schema travels with it)
const schemaText = `
package fig;
enum NodeType { DOCUMENT = 0; CANVAS = 1; FRAME = 2; BOOLEAN_OPERATION = 3; VECTOR = 4; }
enum BoolOp { UNION = 0; INTERSECT = 1; SUBTRACT = 2; XOR = 3; }
struct GUID { uint sessionID; uint localID; }
struct Vector { float x; float y; }
struct Color { float r; float g; float b; float a; }
struct Matrix { float m00; float m01; float m02; float m10; float m11; float m12; }
message ParentIndex { GUID guid = 1; string position = 2; }
message Paint { string type = 1; Color color = 2; float opacity = 3; bool visible = 4; }
message Path { string windingRule = 1; uint commandsBlob = 2; }
message Blob { byte[] bytes = 1; }
message NodeChange { GUID guid = 1; ParentIndex parentIndex = 2; NodeType type = 3; string name = 4; Vector size = 5; Matrix transform = 6; Paint[] fillPaints = 7; Path[] fillGeometry = 8; BoolOp booleanOperation = 9; }
message Message { NodeChange[] nodeChanges = 1; Blob[] blobs = 2; }
`
const parsed = parseSchema(schemaText)
const schema = compileSchema(parsed)
// a closed square as Figma's path commands: 1 = move, 2 = line, 0 = close
const square = (s) => {
  const b = Buffer.alloc(1 + 8 + 3 * 9 + 1)
  let o = 0
  const pt = (cmd, x, y) => { b.writeUInt8(cmd, o); b.writeFloatLE(x, o + 1); b.writeFloatLE(y, o + 5); o += 9 }
  pt(1, 0, 0); pt(2, s, 0); pt(2, s, s); pt(2, 0, s)
  b.writeUInt8(0, o)
  return new Uint8Array(b)
}
const g = (n) => ({ sessionID: 1, localID: n })
const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y })
const green = [{ type: 'SOLID', color: { r: 0, g: 0.8, b: 0.2, a: 1 }, opacity: 1, visible: true }]
const message = {
  blobs: [{ bytes: square(200) }, { bytes: square(80) }],
  nodeChanges: [
    { guid: g(0), type: 'DOCUMENT', name: 'Document' },
    { guid: g(1), parentIndex: { guid: g(0), position: '!' }, type: 'CANVAS', name: 'Page' },
    // the operation itself carries no outline of its own: that is the case that used to become a filled square
    { guid: g(2), parentIndex: { guid: g(1), position: '!' }, type: 'BOOLEAN_OPERATION', booleanOperation: 'SUBTRACT', name: 'Subtract', size: { x: 200, y: 200 }, transform: at(40, 40), fillPaints: green },
    { guid: g(3), parentIndex: { guid: g(2), position: '!' }, type: 'VECTOR', name: 'Vector', size: { x: 200, y: 200 }, transform: at(0, 0), fillPaints: green, fillGeometry: [{ windingRule: 'NONZERO', commandsBlob: 0 }] },
    // the operand that is cut out has no paint at all
    { guid: g(4), parentIndex: { guid: g(2), position: '"' }, type: 'VECTOR', name: 'Vector', size: { x: 80, y: 80 }, transform: at(60, 60), fillGeometry: [{ windingRule: 'NONZERO', commandsBlob: 1 }] }
  ]
}
const chunk = (bytes) => { const z = deflateRawSync(bytes); const len = Buffer.alloc(4); len.writeUInt32LE(z.length); return Buffer.concat([len, z]) }
const head = Buffer.alloc(12)
head.write('fig-kiwi')
head.writeUInt32LE(15, 8)
const archive = Buffer.concat([head, chunk(encodeBinarySchema(parsed)), chunk(schema.encodeMessage(message))])
const html = `<meta charset="utf-8"><span data-buffer="<!--(figma)${archive.toString('base64')}(/figma)-->"></span>`

const proj = await mcp('create_project', { name: 'Figma boolean ' + Date.now().toString(36) })
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
const pixel = (wx, wy) => js(`(() => { const c = document.querySelector('.canvas-wrap canvas'); const k = c.width / c.getBoundingClientRect().width; const cam = editor.camera; const d = c.getContext('2d').getImageData(Math.round((${wx} * cam.zoom + cam.x) * k), Math.round((${wy} * cam.zoom + cam.y) * k), 1, 1).data; return [d[0], d[1], d[2]] })()`)
const isGreen = (p) => p[1] > 150 && p[0] < 80

// ================================================================ 1. Subtract from Figma
await js(`(() => { const dt = new DataTransfer(); dt.setData('text/html', ${JSON.stringify(html)}); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return 1 })()`)
await wait(800)
const op = await js(`(() => { const n = [...editor.nodes.values()].find((n) => n.name === 'Subtract'); if (!n) return null; editor.setSelection([]); return { id: n.id, type: n.type, op: n.booleanOperation, kids: editor.children(n.id).map((c) => editor.nodes.get(c).type), w: Math.round(n.width) } })()`)
check('a Subtract from Figma is a boolean group with its two shapes inside', [op?.type, op?.op, op?.kids, op?.w], ['GROUP', 'SUBTRACT', ['VECTOR', 'VECTOR'], 200])
await mcp('zoom_to', { ids: [op.id] })
await wait(500)
await paint()
const o = await js(`editor.world('${op.id}')`)
const ring = await pixel(o.x + 20, o.y + 20)
const hole = await pixel(o.x + 100, o.y + 100)
check('it is drawn as the shape with the hole cut out, not as a filled square', [isGreen(ring), isGreen(hole)], [true, false])

// ================================================================ 2. the list of layers shows the shape of a vector
await js(`editor.setSelection([editor.children('${op.id}')[0]])`)
await wait(400)
const rows = await js(`[...document.querySelectorAll('.layers .list-row')].map((r) => [r.querySelector('.name').textContent, !!r.querySelector('svg.vector-thumb path[d]')])`)
check('vectors show their own shape as the icon, other layers their usual one', rows, [['Subtract', false], ['Vector', true], ['Vector', true]])
const pen = await mcp('create_svg', { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><path d="M0 40 L30 0 L60 40" fill="none" stroke="#000" stroke-width="2"/></svg>', x: 400, y: 0 })
await wait(300)
check('a vector with no fill is shown as a line', await js(`(() => { const p = [...document.querySelectorAll('.layers svg.vector-thumb path')].find((p) => p.getAttribute('fill') === 'none'); return !!p })()`), true)

// ================================================================ 3. a text turned into outlines: letters, grouped by word
const one = await mcp('create_text', { x: 0, y: 400, text: 'Okna', fontSize: 40, fontFamily: 'Arial', color: '#111111' })
const two = await mcp('create_text', { x: 0, y: 500, text: 'Okna Office', fontSize: 40, fontFamily: 'Arial', color: '#CC2200' })
const boxBefore = await js(`(() => { const w = editor.world('${two.id}'); return [w.x, w.y] })()`)
await mcp('outline_stroke', { ids: [one.id, two.id] })
await wait(500)
const tree = (i) => js(`(() => { const d = (id) => { const n = editor.nodes.get(id); const k = editor.children(id); return k.length ? [n.type, n.name, k.map(d)] : [n.type, n.name] }; return d('${i}') })()`)
const t1 = await tree(one.id)
check('one word becomes a group of vectors, a vector per letter', [t1[0], t1[2].map((k) => k[0] + ' ' + k[1])], ['GROUP', ['VECTOR O', 'VECTOR k', 'VECTOR n', 'VECTOR a']])
const t2 = await tree(two.id)
check('several words: a group per word, the letters inside', [t2[0], t2[2].map((k) => [k[0], k[1], k[2].map((l) => l[1]).join('')])], ['GROUP', [['GROUP', 'Okna', 'Okna'], ['GROUP', 'Office', 'Office']]])
check('the letters keep the colour of the text', await js(`(() => { const v = editor.descendants('${two.id}').map((x) => editor.nodes.get(x)).filter((n) => n.type === 'VECTOR'); return [v.length, v.every((n) => n.fills[0].color.r > 0.7 && n.fills[0].color.g < 0.2)] })()`), [10, true])
check('and stand where the text stood', await js(`(() => { const w = editor.world('${two.id}'); const ls = editor.descendants('${two.id}').filter((x) => editor.nodes.get(x).type === 'VECTOR').map((x) => editor.world(x)); const x1 = Math.min(...ls.map((l) => l.x)), y1 = Math.min(...ls.map((l) => l.y)); return [Math.abs(x1 - w.x) < 0.6, Math.abs(y1 - w.y) < 0.6, w.x >= ${boxBefore[0]} - 1 && w.x < ${boxBefore[0]} + 12, w.y >= ${boxBefore[1]} && w.y < ${boxBefore[1]} + 30] })()`), [true, true, true, true])
await js(`editor.undo()`)
check('one undo brings both texts back', await js(`[editor.nodes.get('${one.id}').type, editor.nodes.get('${two.id}').type, editor.descendants('${two.id}').length]`), ['TEXT', 'TEXT', 0])

console.log(results.join('\n'))
console.log(results.filter((r) => r.startsWith('FAIL')).length ? 'SOME FAILED' : 'ALL PASSED')
ws.close()
process.exit(0)
