// End-to-end smoke test: talks to a running Gigma through the stdio bridge exactly like
// Claude Desktop would, draws a social post and saves the exported PNG.
// Usage: node scripts/mcp-smoke.mjs [out.png]
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const out = process.argv[2] ?? 'gigma-smoke.png'
const bridge = spawn(process.execPath, ['bin/gigma-mcp.cjs'], { stdio: ['pipe', 'pipe', 'inherit'] })
const rl = createInterface({ input: bridge.stdout })
const waiting = new Map()
rl.on('line', (l) => {
  const m = JSON.parse(l)
  waiting.get(m.id)?.(m)
  waiting.delete(m.id)
})
let next = 1
const rpc = (method, params) =>
  new Promise((res) => {
    const id = next++
    waiting.set(id, res)
    bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
const call = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args })
  if (r.error) throw new Error(`${name}: ${r.error.message}`)
  if (r.result.isError) throw new Error(`${name}: ${r.result.content[0].text}`)
  return r.result.content
}
const json = (c) => JSON.parse(c[0].text)

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } })
console.log('server:', init.result?.serverInfo)
bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
const tools = await rpc('tools/list', {})
console.log('tools:', tools.result.tools.map((t) => t.name).join(', '))

await call('create_project', { name: 'MCP smoke test' })
const f = json(await call('create_frame', { name: 'Post', x: 0, y: 0, width: 1080, height: 1080, fill: '#1E1B4B' }))
await call('create_ellipse', { x: 640, y: -120, width: 600, height: 600, fill: '#7C3AED', opacity: 0.6, parentId: f.id })
await call('create_rectangle', { x: 80, y: 760, width: 420, height: 110, fill: '#FACC15', cornerRadius: 55, parentId: f.id })
await call('create_text', { text: 'Gigma', x: 80, y: 120, fontSize: 160, fontWeight: 800, color: '#FFFFFF', parentId: f.id })
await call('create_text', { text: 'Offline design tool with a built-in MCP server', x: 80, y: 330, width: 800, fontSize: 56, color: '#C7D2FE', parentId: f.id })
await call('create_text', { text: 'Try it', x: 200, y: 790, fontSize: 40, fontWeight: 700, color: '#1E1B4B', parentId: f.id })
await call('create_svg', {
  svg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21l2-7.5L2 9h7z" fill="#F472B6"/><circle cx="12" cy="12" r="3" fill="#fff"/></svg>',
  x: 820,
  y: 780,
  width: 200,
  parentId: f.id
})
await call('zoom_to', { ids: [f.id] })
const first = json(await call('list_tabs')).activeId

// second project in another tab, then switch back
await call('create_project', { name: 'MCP smoke test 2' })
const f2 = json(await call('create_frame', { name: 'Story', x: 0, y: 0, width: 1080, height: 1920, fill: '#0EA5E9' }))
await call('create_text', { text: 'Second tab', x: 80, y: 120, fontSize: 120, fontWeight: 800, color: '#FFFFFF', parentId: f2.id })
await call('zoom_to', { ids: [f2.id] })
const tabsNow = json(await call('list_tabs'))
console.log('tabs:', tabsNow.tabs.map((t) => t.name).join(' | '))
await call('switch_tab', { tabId: first })

const png = await call('export_png', { id: f.id, scale: 0.5 })
writeFileSync(out, Buffer.from(png[0].data, 'base64'))
console.log('saved', out, png[1].text)
bridge.stdin.end()
process.exit(0)
