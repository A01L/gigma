// PDF import: pages become frames, what is on them becomes layers.
// The PDF is made by Gigma itself (export_pdf), then dropped back in the way a file is.
// Usage: node scripts/test-pdf-import.mjs [debugPort] [mcpPort] [screenshot.png]   (defaults 9333 / 7331)
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol

// ---- a document of two pages, drawn in Gigma
const proj = await mcp('create_project', { name: 'PDF source' })
const p1 = await mcp('create_frame', { name: 'Invoice', x: 0, y: 0, width: 400, height: 300, fill: '#FFFFFF' })
await mcp('create_text', { parentId: p1.id, text: 'Invoice 0010', x: 30, y: 24, fontSize: 28, fontWeight: 700, fontFamily: 'Arial', color: '#C2410C' })
await mcp('create_text', { parentId: p1.id, text: 'Design of a landing page', x: 30, y: 80, fontSize: 14, fontFamily: 'Arial', color: '#1C1917' })
await mcp('create_rectangle', { parentId: p1.id, name: 'Bar', x: 30, y: 130, width: 340, height: 6, fill: '#2563EB' })
await mcp('create_ellipse', { parentId: p1.id, name: 'Seal', x: 280, y: 180, width: 80, height: 80, fill: '#FDE68A' })
await mcp('create_shape', { parentId: p1.id, kind: 'line', x: 30, y: 250, width: 200, height: 0 }).catch(() => null)
const p2 = await mcp('create_frame', { name: 'Act', x: 460, y: 0, width: 300, height: 420, fill: '#FFFFFF' })
await mcp('create_text', { parentId: p2.id, text: 'Second page', x: 24, y: 24, fontSize: 20, fontFamily: 'Arial', color: '#000000' })
const dir = mkdtempSync(join(tmpdir(), 'gigma-pdf-'))
const file = join(dir, 'source.pdf')
const made = await mcp('export_pdf', { ids: [p1.id, p2.id], path: file })
check('the source PDF has two pages', made.pages.length, 2)

// ---- drop it into a new project
const dest = await mcp('create_project', { name: 'PDF import test' })
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.filter((p) => p.type === 'page' && p.url.includes('#doc=' + encodeURIComponent(dest.path))).pop()
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  pending.get(m.id)?.(m.result)
})
const send = (method, params) => new Promise((res) => (pending.set(++id, res), ws.send(JSON.stringify({ id, method, params }))))
const js = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r.result?.value ?? r.exceptionDetails?.exception?.description ?? r.exceptionDetails?.text ?? null)
await wait(1200)
const b64 = readFileSync(file).toString('base64')
// a real drop of a file on the canvas (works the same in the dev server and in the built app);
// `at` is the place in the document, `raw` replaces the bytes of the file
const drop = (name, at, raw) =>
  js(`(async () => {
    const bytes = ${raw ? `new Uint8Array(${JSON.stringify(raw)})` : `Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0))`}
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: 'application/pdf' }))
    const wrap = document.querySelector('.canvas-wrap')
    const r = wrap.querySelector('canvas').getBoundingClientRect()
    const k = editor.camera
    const at = ${JSON.stringify(at ?? null)}
    const had = editor.toast
    wrap.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: at ? r.left + at.x * k.zoom + k.x : r.left + r.width / 2, clientY: at ? r.top + at.y * k.zoom + k.y : r.top + r.height / 2 }))
    // the import is done when its last message is up
    for (let i = 0; i < 200; i++) {
      await new Promise((res) => setTimeout(res, 50))
      if (editor.toast && editor.toast !== had && !/^(Reading|Читаю)/.test(editor.toast)) break
    }
    return editor.toast
  })()`)
const before = await js(`editor.nodes.size`)
const toast = await drop('source.pdf', { x: 1000, y: 500 })
check('the import says how many pages came in', /source\.pdf.*2/.test(String(toast)), true)
const frames = JSON.parse(await js(`JSON.stringify([...editor.nodes.values()].filter((n) => n.type === 'FRAME').sort((a, b) => a.x - b.x).map((f) => ({ id: f.id, name: f.name, x: f.x, y: f.y, w: f.width, h: f.height, clip: f.clipsContent })))`))
check('every page is a frame, named after the file', frames.map((f) => f.name), ['source · 1', 'source · 2'])
check('frames have the size of the pages', frames.map((f) => [near(f.w, 400), near(f.h, 300)]).concat([]).flat().slice(0, 2).concat([near(frames[1].w, 300), near(frames[1].h, 420)]), [true, true, true, true])
check('the first frame starts where the file was dropped', [near(frames[0].x, 1000, 2), near(frames[0].y, 500, 2)], [true, true])
check('pages stand in a row with a gap', frames[1].x > frames[0].x + frames[0].w && near(frames[1].y, frames[0].y), true)
const kids = (fid) => js(`JSON.stringify([...editor.nodes.values()].filter((n) => n.parentId === '${fid}').map((n) => ({ t: n.type, name: n.name, x: n.x, y: n.y, w: n.width, h: n.height, chars: n.characters, fam: n.textStyle?.fontFamily, wt: n.textStyle?.fontWeight, size: n.textStyle?.fontSize, fill: n.fills?.[0]?.color ? [n.fills[0].color.r, n.fills[0].color.g, n.fills[0].color.b].map((v) => Math.round(v * 255)) : null, stroke: n.strokes?.length ?? 0 })))`).then(JSON.parse)
const k1 = await kids(frames[0].id)
const title = k1.find((k) => k.t === 'TEXT' && k.chars === 'Invoice 0010')
check('text stays text', [!!title, k1.some((k) => k.t === 'TEXT' && k.chars === 'Design of a landing page')], [true, true])
check('with its font, weight, size and colour', [title?.fam, title?.wt, near(title?.size ?? 0, 28, 0.6), title?.fill], ['Arial', 700, true, [194, 65, 12]])
check('and it sits where it was', [near(title?.x ?? -99, 30, 2.5), near(title?.y ?? -99, 24, 5)], [true, true])
const bar = k1.find((k) => k.t === 'RECTANGLE' && k.fill && k.fill[2] > 200 && k.fill[0] < 80)
check('a rectangle comes back as a rectangle, same place and colour', [!!bar, near(bar?.x ?? -9, 30), near(bar?.y ?? -9, 130), near(bar?.w ?? 0, 340), near(bar?.h ?? 0, 6), bar?.fill], [true, true, true, true, true, [37, 99, 235]])
const seal = k1.find((k) => k.t === 'VECTOR' && k.fill && k.fill[0] > 240 && k.fill[2] < 160)
check('a circle comes back as a vector of the same box', [!!seal, near(seal?.x ?? -9, 280), near(seal?.y ?? -9, 180), near(seal?.w ?? 0, 80), near(seal?.h ?? 0, 80)], [true, true, true, true, true])
check('nothing sticks out of the page', k1.every((k) => k.x > -2 && k.y > -8 && k.x + k.w < 402 + 2 && k.y + k.h < 300 + 8), true)
check('no white sheet under the page: the frame is the sheet', k1.some((k) => k.t === 'RECTANGLE' && k.fill?.every((v) => v > 250) && k.w > 390), false)
const k2 = await kids(frames[1].id)
check('the second page has its own text', k2.filter((k) => k.t === 'TEXT').map((k) => k.chars), ['Second page'])
check('the frames are selected after the import', (await js(`editor.selection`)).sort(), frames.map((f) => f.id).sort())
if (shot) {
  await js(`editor.zoomToFit(), editor.setSelection([]), 1`)
  await wait(400)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(shot, Buffer.from(r.data, 'base64'))
}
// ---- one undo step
await js(`editor.undo(), 1`)
check('the whole import is one undo step', await js(`editor.nodes.size`), before)
await js(`editor.redo(), 1`)
check('and one redo', (await js(`[...editor.nodes.values()].filter((n) => n.type === 'FRAME').length`)), 2)
// ---- a second file, without a place: it goes to the middle of the view
await drop('again.pdf')
check('a second PDF adds its own frames', await js(`[...editor.nodes.values()].filter((n) => n.type === 'FRAME').map((n) => n.name).sort()`), ['again · 1', 'again · 2', 'source · 1', 'source · 2'])
// ---- a file that is not a PDF inside
const bad = await drop('broken.pdf', null, [1, 2, 3, 4])
check('a broken file says so and adds nothing', [/Could not import broken\.pdf/.test(String(bad)), await js(`[...editor.nodes.values()].filter((n) => n.type === 'FRAME').length`)], [true, 4])
// ---- the palette knows the command
await js(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', ctrlKey: true, bubbles: true })), 1`)
await wait(400)
await js(`(() => { const i = document.querySelector('.palette-search input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'pdf'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
await wait(300)
check('Ctrl+K finds the import', (await js(`[...document.querySelectorAll('.palette-item .pi-label')].map((e) => e.textContent)`)).some((l) => /Import PDF|Импорт PDF/.test(l)), true)
await js(`document.querySelector('.palette-bg')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), 1`)
void proj

console.log(results.join('\n'))
console.log(results.some((r) => r.startsWith('FAIL')) ? 'SOME FAILED' : `all ${results.length} passed`)
ws.close()
