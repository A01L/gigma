// Visual test for Vertical trim and Wrap style. Usage: node scripts/test-trim-wrap.mjs out.png
import { writeFileSync } from 'node:fs'
const out = process.argv[2] ?? 'trim.png'
let id = 0
async function call(name, args = {}) {
  const r = await fetch('http://127.0.0.1:7331/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })
  })
  const j = await r.json()
  if (j.error || j.result?.isError) throw new Error(name + ': ' + JSON.stringify(j.error ?? j.result.content))
  return j.result.content
}
const json = (c) => JSON.parse(c[0].text)
await call('create_project', { name: 'Trim test' })
const f = json(await call('create_frame', { name: 'Trim', x: 0, y: 0, width: 900, height: 520, fill: '#FFFFFF' }))
// trim: the box (shown by a tinted rectangle of the same size) hugs the capitals
for (const [i, trim] of ['STANDARD', 'CAP_HEIGHT'].entries()) {
  const t = json(await call('create_text', { text: 'Hxg Vertical', x: 40 + i * 420, y: 60, fontSize: 64, fontWeight: 800, color: '#111827', verticalTrim: trim, parentId: f.id }))
  await call('create_rectangle', { x: t.x, y: t.y, width: t.width, height: t.height, fill: '#3B82F633', parentId: f.id })
  await call('reorder_nodes', { ids: [t.id], to: 'front' })
}
const heading = 'Design locally, ship to Figma whenever you are ready'
await call('create_text', { text: 'Auto: ' + heading, x: 40, y: 220, width: 380, fontSize: 30, fontWeight: 700, color: '#111827', parentId: f.id })
await call('create_text', { text: 'Balanced: ' + heading, x: 480, y: 220, width: 380, fontSize: 30, fontWeight: 700, color: '#111827', wrapStyle: 'BALANCED', parentId: f.id })
const png = await call('export_png', { id: f.id })
writeFileSync(out, Buffer.from(png[0].data, 'base64'))
console.log('ok', png[1].text)
