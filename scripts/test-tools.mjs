// Exercises the new toolbar features through MCP: shapes, section/slice, spec, code, annotations.
// Usage: node scripts/test-tools.mjs <outDir>
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.argv[2] ?? '.'
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

await call('create_project', { name: 'Tools test' })
const sec = json(await call('create_shape', { kind: 'section', name: 'Landing', x: -40, y: -80, width: 1400, height: 760 }))
const f = json(await call('create_frame', { name: 'Hero', x: 0, y: 0, width: 640, height: 420, fill: '#F8FAFC', parentId: sec.id }))
await call('create_shape', { kind: 'line', x: 40, y: 40, width: 200, height: 0.01, stroke: '#0F172A', strokeWeight: 3, parentId: f.id })
await call('create_shape', { kind: 'arrow', x: 40, y: 80, width: 200, height: 80, stroke: '#2563EB', strokeWeight: 3, parentId: f.id })
await call('create_shape', { kind: 'polygon', x: 300, y: 40, width: 120, height: 110, fill: '#F59E0B', parentId: f.id })
await call('create_shape', { kind: 'star', x: 460, y: 40, width: 130, height: 130, fill: '#EC4899', parentId: f.id })
await call('create_shape', { kind: 'polygon', sides: 6, x: 300, y: 200, width: 120, height: 120, fill: '#10B981', parentId: f.id })
await call('create_code', {
  name: 'Pricing card',
  x: 700,
  y: 0,
  width: 320,
  height: 260,
  parentId: sec.id,
  html: '<div class="c"><span class="tag">PRO</span><h3>$29<small>/mo</small></h3><ul><li>Unlimited projects</li><li>Local MCP</li><li>Offline</li></ul><button>Buy</button></div>',
  css: '.c{font-family:Inter,Segoe UI,sans-serif;background:linear-gradient(135deg,#4f46e5,#9333ea);color:#fff;border-radius:20px;padding:22px;height:100%}.tag{background:#fff3;padding:3px 8px;border-radius:99px;font-size:11px}h3{font-size:40px;margin:10px 0}small{font-size:14px;opacity:.7}ul{padding-left:18px;margin:0 0 14px;line-height:1.7}button{background:#fff;color:#4f46e5;border:0;border-radius:10px;padding:10px 20px;font-weight:700}'
})
await call('create_spec', { title: 'Make the hero bolder', body: '- Bigger headline\n- Brand gradient background\n- Add CTA button', x: 1060, y: 0, parentId: sec.id })
await call('create_shape', { kind: 'slice', name: 'Export area', x: 0, y: 0, width: 640, height: 420, parentId: sec.id })
await call('create_annotation', { text: 'Is this arrow pointing to the right place?', x: 200, y: 120 })
const specs = json(await call('list_specs', { status: 'TODO' }))
console.log('specs:', specs.map((s) => s.title).join(', '))
await call('update_spec', { id: specs[0].id, status: 'DONE', result: 'Test: marked done by MCP' })
const notes = json(await call('list_annotations', {}))
console.log('annotations:', JSON.stringify(notes.map((n) => ({ text: n.text, layer: n.layer?.name }))))
await call('set_selection', { ids: [] })
await call('zoom_to', { ids: [sec.id] })
await call('set_selection', { ids: [] })
const page = await call('export_png', { id: sec.id, maxSize: 1400 })
writeFileSync(join(dir, 'tools-section.png'), Buffer.from(page[0].data, 'base64'))
console.log('section png', page[1].text)
const shot = await call('get_screenshot', { maxSize: 1400 })
writeFileSync(join(dir, 'tools-screen.png'), Buffer.from(shot[0].data, 'base64'))
console.log('screen', shot[1].text)
