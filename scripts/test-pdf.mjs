// PDF export through MCP: page count, page sizes (1 px = 1 pt), vector text, order of frames.
// Usage: node scripts/test-pdf.mjs out.pdf   (dev app with --remoteDebuggingPort 9333)
import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
const out = resolve(process.argv[2] ?? 'gigma-test.pdf')
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

/** page boxes and decoded content streams of a PDF (enough to check sizes and whether text is real text) */
function inspect(file) {
  const buf = readFileSync(file)
  const text = buf.toString('latin1')
  const boxes = [...text.matchAll(/\/MediaBox\s*\[\s*([\d.\s-]+)\]/g)].map((m) => m[1].trim().split(/\s+/).map(Number)).map((b) => [Math.round(b[2] - b[0]), Math.round(b[3] - b[1])])
  let streams = ''
  for (const m of text.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length
    const end = text.indexOf('endstream', start)
    try {
      streams += inflateSync(buf.subarray(start, end)).toString('latin1') + '\n'
    } catch {
      /* not a deflated stream */
    }
  }
  return { header: text.slice(0, 5), size: buf.length, boxes, streams, fonts: /\/Type\s*\/Font\b/.test(text), textOps: (streams.match(/\bT[jJ]\b/g) ?? []).length, pathOps: (streams.match(/\b(re|c|l)\n/g) ?? []).length, images: (text.match(/\/Subtype\s*\/Image/g) ?? []).length }
}

await mcp('create_project', { name: 'PDF test' })
// three frames: two in the first row (created right one first), one below; plus a loose shape
const b = json(await mcp('create_frame', { name: 'B', x: 700, y: 20, width: 400, height: 300, fill: '#0F172A' }))
const a = json(await mcp('create_frame', { name: 'A', x: 0, y: 0, width: 595, height: 842, fill: '#FFFFFF' }))
const c = json(await mcp('create_frame', { name: 'C', x: 0, y: 1000, width: 1080, height: 1080, fill: '#FEF3C7' }))
await mcp('create_text', { text: 'Invoice 2026', x: 40, y: 40, fontSize: 36, fontWeight: 700, parentId: a.id })
await mcp('create_text', { text: 'Привет, PDF', x: 40, y: 100, fontSize: 20, parentId: a.id })
const r = json(await mcp('create_rectangle', { x: 40, y: 160, width: 515, height: 200, fill: '#2563EB', cornerRadius: 24, parentId: a.id }))
await mcp('update_node', { id: r.id, fills: [{ type: 'GRADIENT_LINEAR', angle: 90, stops: [{ position: 0, color: '#2563EB' }, { position: 1, color: '#EC4899' }] }], effects: [{ type: 'DROP_SHADOW', color: '#00000040', x: 0, y: 8, radius: 24 }] })
await mcp('create_ellipse', { x: 100, y: 60, width: 200, height: 200, fill: '#22D3EE', parentId: b.id })
await mcp('create_text', { text: 'Slide two', x: 30, y: 250, fontSize: 24, color: '#FFFFFF', parentId: b.id })
await mcp('create_shape', { kind: 'star', x: 340, y: 340, width: 400, height: 400, fill: '#F59E0B', parentId: c.id })
await mcp('create_rectangle', { name: 'loose', x: 1500, y: 0, width: 100, height: 100, fill: '#000000' })

// all frames of the page
const all = json(await mcp('export_pdf', { path: out }))
const pdf = inspect(all.path)
check('a real PDF was written where asked', [all.path === out, pdf.header, pdf.size > 2000], [true, '%PDF-', true])
check('one page per top-level frame, ordered by rows from the top left (A, B, C); the loose shape is not a page', all.pages.map((p) => [p.width, p.height]), [[595, 842], [400, 300], [1080, 1080]])
check('every page has the size of its frame: 1 px = 1 pt', pdf.boxes, [[595, 842], [400, 300], [1080, 1080]])
check('text is real text with embedded fonts, shapes are vector paths', [pdf.fonts, pdf.textOps >= 3, pdf.pathOps > 3], [true, true, true])

// the star of page 3 sits inside the clip of its own frame: an orange fill (.9608 .6196 .0431) must be drawn.
// (ids of clip paths repeat from page to page; a mix-up would clip it with the frame of page 1)
check('content of later pages is clipped by its own frame, not by the first page', /\.96\d* \.6\d* \.04\d* rg/.test(pdf.streams), true)

// chosen layers, in the order given; default location = Downloads
const two = json(await mcp('export_pdf', { ids: [c.id, r.id], name: 'gigma pdf selftest' }))
const pdf2 = inspect(two.path)
check('export of chosen layers keeps their order and sizes', pdf2.boxes, [[1080, 1080], [515, 200]])
check('without a path the file goes to Downloads under the given name', /Downloads[\\/]gigma pdf selftest( \(\d+\))?\.pdf$/.test(two.path), true)
rmSync(two.path, { force: true })

// the button of the inspector uses the same pages: ask the editor for the bytes directly
const pages = await (await fetch('http://127.0.0.1:9333/json')).json()
const page = pages.filter((p) => p.type === 'page' && p.url.includes('#doc=')).pop()
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res) => ws.addEventListener('open', res, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  pending.get(m.id)?.(m.result)
})
const js = (expression) =>
  new Promise((res) => (pending.set(++id, res), ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })))).then((x) => x.result?.value ?? x.exceptionDetails?.exception?.description ?? null)
check('the inspector path (window.gigma.pdf) returns PDF bytes', await js(`(async () => { const { pdfPages } = await import('/editor/pdf.ts'); const bytes = await gigma.pdf.render(await pdfPages(editor, ['${b.id}'])); return [String.fromCharCode(...bytes.slice(0, 5)), bytes.length > 1000] })()`), ['%PDF-', true])
check('frames are found in reading order', await js(`(async () => { const { framesInReadingOrder } = await import('/editor/pdf.ts'); return framesInReadingOrder(editor).map((i) => editor.nodes.get(i).name).join('') })()`), 'ABC')
console.log(results.join('\n'))
console.log('PDF kept for a look: ' + out)
ws.close()
process.exit(results.some((x) => x.startsWith('FAIL')) ? 1 : 0)
