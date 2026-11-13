// Screenshot a page over CDP. Usage: node scripts/cdp-shot.mjs "#doc=" out.png
import { writeFileSync } from 'node:fs'
const [, , match = '#doc=', out = 'shot.png'] = process.argv
const pages = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT ?? 9333}/json`)).json()
const page = pages.find((p) => p.type === 'page' && p.url.includes(match))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const res = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), 20000)
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id === 1) (clearTimeout(t), resolve(m.result))
  })
  ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }))
})
writeFileSync(out, Buffer.from(res.data, 'base64'))
console.log('saved', out)
ws.close()
