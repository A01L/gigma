// Draws an effects showcase through MCP (like an AI client would) and saves the exported PNG.
// Usage: node scripts/test-effects.mjs out.png
import { writeFileSync } from 'node:fs'
const out = process.argv[2] ?? 'effects.png'
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

await call('create_project', { name: 'Effects test' })
const f = json(await call('create_frame', { name: 'Effects', x: 0, y: 0, width: 900, height: 520, fill: '#EEF1F6' }))
// photo-like backdrop to show background blur
await call('create_image', { source: process.cwd().replace(/\\/g, '/') + '/build/icons/512x512.png', x: 560, y: 120, width: 300, height: 300, parentId: f.id })
const card = json(await call('create_rectangle', { name: 'Card / drop shadow', x: 40, y: 60, width: 220, height: 160, fill: '#FFFFFF', cornerRadius: 16, parentId: f.id }))
await call('update_node', { id: card.id, effects: [{ type: 'DROP_SHADOW', color: '#0F172A33', x: 0, y: 12, radius: 24, spread: -4 }] })
const inner = json(await call('create_rectangle', { name: 'Inner shadow', x: 300, y: 60, width: 220, height: 160, fill: '#DDE3EE', cornerRadius: 16, parentId: f.id }))
await call('update_node', { id: inner.id, effects: [{ type: 'INNER_SHADOW', color: '#00000055', x: 4, y: 6, radius: 12 }] })
const blur = json(await call('create_ellipse', { name: 'Layer blur', x: 60, y: 290, width: 180, height: 180, fill: '#7C3AED', parentId: f.id }))
await call('update_node', { id: blur.id, effects: [{ type: 'LAYER_BLUR', radius: 30 }] })
const glass = json(
  await call('create_svg', {
    svg: '<svg viewBox="0 0 200 260" xmlns="http://www.w3.org/2000/svg"><path d="M30 0L200 20L170 260L0 230Z" fill="#FFA11E" fill-opacity="0.7" stroke="#FFAF40" stroke-width="2"/></svg>',
    x: 600,
    y: 150,
    width: 200,
    parentId: f.id
  })
)[0]
await call('update_node', { id: glass.id, strokeAlign: 'CENTER', effects: [{ type: 'BACKGROUND_BLUR', radius: 16 }] })
const txt = json(await call('create_text', { text: 'Shadow text', x: 300, y: 330, fontSize: 48, fontWeight: 800, color: '#111827', parentId: f.id }))
await call('update_node', { id: txt.id, effects: [{ type: 'DROP_SHADOW', color: '#F59E0B', x: 3, y: 3, radius: 0 }] })
await call('zoom_to', { ids: [f.id] })
const png = await call('export_png', { id: f.id, scale: 1 })
writeFileSync(out, Buffer.from(png[0].data, 'base64'))
console.log('ok', png[1].text)
