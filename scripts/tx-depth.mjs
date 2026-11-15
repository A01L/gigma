// Prints, for every open project tab, whether an edit was left unfinished (which would stop undo from recording).
// Usage: node scripts/tx-depth.mjs [debugPort]
const port = process.argv[2] ?? '9333'
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
for (const page of targets.filter((p) => p.type === 'page' && p.url.includes('#doc='))) {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  const res = await new Promise((r) => {
    ws.addEventListener('message', (ev) => r(JSON.parse(ev.data).result?.result?.value))
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `JSON.stringify({ name: editor.meta.name, depth: editor.txDepth, undo: editor.undoStack.length })`, returnByValue: true } }))
  })
  console.log(res)
  ws.close()
}
process.exit(0)
