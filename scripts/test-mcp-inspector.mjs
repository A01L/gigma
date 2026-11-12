// Exercises the inspector-level MCP tools and saves the two kinds of snapshots.
// Usage: node scripts/test-mcp-inspector.mjs <outDir>
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
const log = (...a) => console.log(...a)

const tools = await fetch('http://127.0.0.1:7331/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' })
}).then((r) => r.json())
log('tools:', tools.result.tools.length)

await call('create_project', { name: 'MCP inspector test' })
await call('update_page', { name: 'Main', background: '#1F2937' })
const f = json(await call('create_frame', { name: 'Grid', x: 0, y: 0, width: 800, height: 400, fill: '#F8FAFC', cornerRadius: 24 }))
await call('update_node', { id: f.id, clipsContent: true, effects: [{ type: 'DROP_SHADOW', color: '#00000066', y: 20, radius: 40 }] })
const a = json(await call('create_rectangle', { x: 40, y: 60, width: 160, height: 160, parentId: f.id }))
await call('update_node', {
  id: a.id,
  cornerRadius: 20,
  fills: [
    { type: 'IMAGE', source: process.cwd().replace(/\\/g, '/') + '/build/icons/256x256.png', scaleMode: 'FILL' },
    { type: 'SOLID', color: '#7C3AED55' }
  ],
  strokes: [{ color: '#7C3AED', weight: 4, align: 'OUTSIDE' }]
})
const copies = json(await call('duplicate_nodes', { ids: [a.id], offsetX: 200 }))
const copies2 = json(await call('duplicate_nodes', { ids: [a.id], offsetX: 500 }))
await call('align_nodes', { ids: [a.id, copies[0].id, copies2[0].id], align: 'distribute-horizontal' })
await call('update_node', { id: copies[0].id, y: 120 })
await call('align_nodes', { ids: [a.id, copies[0].id, copies2[0].id], align: 'bottom' })
const label = json(await call('create_text', { text: 'MCP controls the inspector', x: 40, y: 300, fontSize: 32, fontWeight: 700, color: '#0F172A', parentId: f.id }))
await call('align_nodes', { ids: [label.id], align: 'center' })
await call('reorder_nodes', { ids: [a.id], to: 'front' })
const g = json(await call('group_nodes', { ids: [copies[0].id, copies2[0].id], name: 'Pair' }))
await call('ungroup_nodes', { ids: [g.id] })
const node = json(await call('get_node', { id: a.id }))
log('node fills:', node.fills.map((p) => p.type).join('+'), 'stroke align:', node.strokes[0].align)
await call('set_selection', { ids: [label.id] })
await call('zoom_to', { ids: [f.id] })
await call('set_selection', { ids: [label.id] })
const page = await call('export_png', { maxSize: 800 })
writeFileSync(join(dir, 'mcp-page.png'), Buffer.from(page[0].data, 'base64'))
log('page png', page[1].text)
const shot = await call('get_screenshot', { maxSize: 1000 })
writeFileSync(join(dir, 'mcp-screenshot.png'), Buffer.from(shot[0].data, 'base64'))
log('screenshot', shot[1].text)
