// Draws a typography showcase through MCP and saves the exported PNG.
// Usage: node scripts/test-typography.mjs out.png
import { writeFileSync } from 'node:fs'
const out = process.argv[2] ?? 'typography.png'
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

await call('create_project', { name: 'Typography test' })
const f = json(await call('create_frame', { name: 'Type', x: 0, y: 0, width: 960, height: 620, fill: '#FFFFFF' }))
const T = (args) => call('create_text', { parentId: f.id, color: '#111827', ...args })
await T({ text: 'uppercase title, -2% tracking', x: 40, y: 32, fontSize: 40, fontWeight: 800, textCase: 'UPPER', letterSpacingPercent: -2 })
await T({ text: 'Italic underlined', x: 40, y: 100, fontSize: 28, italic: true, decoration: 'UNDERLINE', color: '#2563EB' })
await T({ text: 'Strikethrough €99', x: 400, y: 100, fontSize: 28, decoration: 'STRIKETHROUGH', color: '#DC2626' })
await T({
  text: 'Justified paragraph: Gigma lays out text like Figma, so long copy wraps and both edges stay perfectly aligned except the last line.',
  x: 40,
  y: 160,
  width: 400,
  fontSize: 18,
  align: 'JUSTIFIED',
  lineHeightPercent: 150
})
await T({ text: 'Bulleted list\nWorks offline\nBuilt-in MCP', x: 500, y: 160, width: 400, fontSize: 18, listStyle: 'BULLET', paragraphSpacing: 6 })
await T({ text: 'Numbered\nSecond step\nThird step', x: 500, y: 290, width: 400, fontSize: 18, listStyle: 'NUMBER' })
const tr = json(
  await T({
    text: 'This fixed-size box is too small for all of this text, so it is truncated with an ellipsis at the end of the last visible line.',
    x: 40,
    y: 420,
    width: 380,
    fontSize: 20
  })
)
await call('update_node', { id: tr.id, height: 56, truncate: true })
const mid = json(await T({ text: 'Vertically centered', x: 500, y: 420, width: 380, fontSize: 22, align: 'CENTER' }))
await call('update_node', { id: mid.id, height: 140 })
await call('update_node', { id: mid.id, verticalAlign: 'CENTER' })
await call('create_rectangle', { parentId: f.id, x: 500, y: 420, width: 380, height: 140, stroke: '#94A3B8', strokeWeight: 1 })
const png = await call('export_png', { id: f.id, scale: 1 })
writeFileSync(out, Buffer.from(png[0].data, 'base64'))
console.log('ok', png[1].text)
