// Visual test for the Figma-like inspector properties. Usage: node scripts/test-inspector.mjs out.png
import { writeFileSync } from 'node:fs'
const out = process.argv[2] ?? 'inspector.png'
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
await call('create_project', { name: 'Inspector test' })
const f = json(await call('create_frame', { name: 'Card', x: 0, y: 0, width: 720, height: 420, fill: '#F1F5F9' }))
const a = json(await call('create_rectangle', { name: 'Corners', x: 40, y: 60, width: 200, height: 140, fill: '#3B82F6', parentId: f.id }))
await call('update_node', { id: a.id, cornerRadii: [48, 0, 48, 0], strokes: [{ color: '#1E3A8A', weight: 4, align: 'INSIDE' }] })
const b = json(await call('create_rectangle', { name: 'Rotated', x: 300, y: 70, width: 180, height: 120, fill: '#F59E0B', cornerRadius: 16, parentId: f.id }))
await call('update_node', { id: b.id, rotation: 20, fills: [{ type: 'SOLID', color: '#F59E0B' }, { type: 'SOLID', color: '#EF444488' }] })
const c = json(await call('create_shape', { kind: 'arrow', x: 540, y: 80, width: 120, height: 80, stroke: '#0F172A', strokeWeight: 4, parentId: f.id }))
await call('update_node', { id: c.id, flipX: true })
const t = json(await call('create_text', { text: 'Rotated text', x: 60, y: 280, fontSize: 40, fontWeight: 800, color: '#0F172A', parentId: f.id }))
await call('update_node', { id: t.id, rotation: -8 })
await call('zoom_to', { ids: [f.id] })
await call('set_selection', { ids: [b.id] })
const png = await call('export_png', { id: f.id })
writeFileSync(out, Buffer.from(png[0].data, 'base64'))
console.log('ok', png[1].text, b.id)
