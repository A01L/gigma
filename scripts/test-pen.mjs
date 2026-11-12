// Drives the pen, pencil, line and annotation tools with real mouse events over CDP.
// Usage: node scripts/test-pen.mjs   (app started with --remoteDebuggingPort 9333, a project tab open)
const pages = await (await fetch('http://127.0.0.1:9333/json')).json()
const page = pages.find((p) => p.type === 'page' && p.url.includes('#doc='))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  pending.get(m.id)?.(m.result)
})
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mouse = (type, x, y, buttons = 1) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 })
const click = async (x, y) => {
  await mouse('mouseMoved', x, y, 0)
  await mouse('mousePressed', x, y)
  await mouse('mouseReleased', x, y, 0)
  await sleep(60)
}
const key = async (k, code) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : k === 'Enter' ? 13 : 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code })
  await sleep(50)
}

const rect = await evalJs(`(() => { const r = document.querySelector('.canvas-wrap canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
const cx = rect.x + rect.w / 2
const cy = rect.y + rect.h / 2
const before = await evalJs('editor.nodes.size')
await evalJs(`editor.addPage('Pen test'); 1`)

// Pen: triangle, closed by clicking the first point; one curved segment by dragging
await key('p', 'KeyP')
await click(cx - 150, cy - 50)
await mouse('mouseMoved', cx - 50, cy - 120, 0)
await mouse('mousePressed', cx - 50, cy - 120)
await mouse('mouseMoved', cx, cy - 160)
await mouse('mouseReleased', cx, cy - 160, 0)
await click(cx + 20, cy + 40)
await click(cx - 150, cy - 50) // close
// Pencil: a wavy stroke
await key('P', 'KeyP') // Shift+P handled below
await evalJs(`editor.setTool('pencil'); 1`)
await mouse('mouseMoved', cx - 150, cy + 120, 0)
await mouse('mousePressed', cx - 150, cy + 120)
for (let i = 0; i <= 30; i++) await mouse('mouseMoved', cx - 150 + i * 10, cy + 120 + Math.sin(i / 3) * 30)
await mouse('mouseReleased', cx + 150, cy + 120, 0)
// Line tool
await key('l', 'KeyL')
await mouse('mouseMoved', cx + 100, cy - 100, 0)
await mouse('mousePressed', cx + 100, cy - 100)
await mouse('mouseMoved', cx + 200, cy - 20)
await mouse('mouseReleased', cx + 200, cy - 20, 0)
await sleep(200)
const result = await evalJs(`[...editor.nodes.values()].filter(n => n.pageId === editor.currentPageId).map(n => ({ type: n.type, name: n.name, path: (n.path||'').slice(0,60), closed: /z/i.test(n.path||'') }))`)
console.log(JSON.stringify(result, null, 1))
console.log('nodes before/after', before, await evalJs('editor.nodes.size'))
ws.close()
