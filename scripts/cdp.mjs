// Tiny Chrome DevTools Protocol helper for UI checks of the dev app.
// Start the app with: npx electron-vite dev --remoteDebuggingPort 9333
// Usage: node scripts/cdp.mjs <page-match> "<js expression>"
//   page-match: substring of the page URL, e.g. "#shell" or "#doc="
import { readFileSync } from 'node:fs'
const [, , match = '#shell', rawExpr = 'document.title'] = process.argv
// "@path/to/file.js" evaluates the file's contents
const expr = rawExpr.startsWith('@') ? readFileSync(rawExpr.slice(1), 'utf8') : rawExpr
const port = process.env.CDP_PORT ?? 9333
const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = pages.find((p) => p.type === 'page' && p.url.includes(match))
if (!page) {
  console.error('no page matching', match, pages.map((p) => p.url))
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const call = (id, method, params) =>
  new Promise((resolve) => {
    const on = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id === id) {
        ws.removeEventListener('message', on)
        resolve(m.result)
      }
    }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify({ id, method, params }))
  })
// CDP_WIDTH / CDP_HEIGHT: emulate a smaller viewport while evaluating (layout tests)
if (process.env.CDP_WIDTH) {
  await call(10, 'Emulation.setDeviceMetricsOverride', {
    width: +process.env.CDP_WIDTH,
    height: +(process.env.CDP_HEIGHT ?? 700),
    deviceScaleFactor: 1,
    mobile: false
  })
  await new Promise((r) => setTimeout(r, 400))
}
const res = await call(1, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })
if (process.env.CDP_WIDTH) await call(11, 'Emulation.clearDeviceMetricsOverride', {})
console.log(JSON.stringify(res.exceptionDetails ? res.exceptionDetails : res.result.value, null, 1))
ws.close()
