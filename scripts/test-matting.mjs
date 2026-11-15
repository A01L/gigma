// Background removal (the model runs in the app), the mask brushes, a guideline that travels with its frames, and the
// update check. The app must run with GIGMA_EXPORT_DIR set to an existing folder (it stands in for the save dialog),
// and models/birefnet.onnx must be there (npm run models).
// Usage: node scripts/test-matting.mjs [debugPort] [mcpPort] <exportDir> [screenshot.png]   (defaults 9333 / 7331)
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const port = process.argv[2] ?? '9333'
const mcpPort = process.argv[3] ?? '7331'
const dir = process.argv[4]
const shot = process.argv[5]
if (!dir) throw new Error('pass the folder GIGMA_EXPORT_DIR points to')
let mid = 0
async function mcp(name, args = {}) {
  const r = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++mid, method: 'tools/call', params: { name, arguments: args } }) })
  const j = await r.json()
  if (j.error || j.result?.isError) throw new Error(name + ': ' + JSON.stringify(j.error ?? j.result.content))
  return JSON.parse(j.result.content[0].text)
}
const results = []
process.on('uncaughtException', (e) => {
  console.log(results.join(String.fromCharCode(10)))
  console.log('CRASH', e.stack)
  process.exit(1)
})
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const check = (label, got, want) => results.push(`${same(got, want) ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${same(got, want) ? '' : '  want ' + JSON.stringify(want)}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function attach(match) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.filter((p) => p.type === 'page' && match(p.url)).pop()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    pending.get(m.id)?.(m.result)
  })
  const send = (method, params) => new Promise((res) => (pending.set(++id, res), ws.send(JSON.stringify({ id, method, params }))))
  const js = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r.result?.value ?? r.exceptionDetails?.exception?.description ?? null)
  return { send, js, close: () => ws.close() }
}
for (const f of readdirSync(dir)) rmSync(join(dir, f))

const proj = await mcp('create_project', { name: 'Matting test' })
await mcp('show_tab', {})
const { send, js } = await attach((u) => u.includes('#doc=' + encodeURIComponent(proj.path)))
await wait(1500)

// ---- a picture to cut: a red ball with a highlight on a green wall, 600 × 400
const png = await js(`(() => { const c = document.createElement('canvas'); c.width = 600; c.height = 400; const g = c.getContext('2d'); const bg = g.createLinearGradient(0, 0, 600, 400); bg.addColorStop(0, '#2f7d4a'); bg.addColorStop(1, '#1d5a33'); g.fillStyle = bg; g.fillRect(0, 0, 600, 400); const ball = g.createRadialGradient(270, 170, 10, 300, 200, 130); ball.addColorStop(0, '#ff9a8a'); ball.addColorStop(0.4, '#e53a2a'); ball.addColorStop(1, '#8f1408'); g.fillStyle = ball; g.beginPath(); g.arc(300, 200, 130, 0, Math.PI * 2); g.fill(); return c.toDataURL('image/png') })()`)
const frame = await mcp('create_frame', { name: 'Card', x: 0, y: 0, width: 700, height: 500, fill: '#FFFFFF' })
const pic = await mcp('create_image', { parentId: frame.id, name: 'ball', source: png, x: 50, y: 50, width: 600, height: 400 })
await mcp('zoom_to', { ids: [frame.id] })
/** the picture layer drawn alone at 1x: [r, g, b, a] at some points */
const probe = (pts) =>
  js(`(async () => { const { renderToCanvas } = await import('/editor/render.ts'); const c = await renderToCanvas(editor, ['${pic.id}'], 1); const g = c.getContext('2d'); return ${JSON.stringify(pts)}.map(([x, y]) => [...g.getImageData(x, y, 1, 1).data]) })()`)
const alpha = async (pts) => (await probe(pts)).map((p) => (p[3] > 200 ? 'kept' : p[3] < 40 ? 'gone' : 'half'))
const fill = () => js(`(() => { const f = editor.nodes.get('${pic.id}').fills.find((f) => f.type === 'IMAGE'); return { image: f.imageHash, mask: f.maskHash ?? null } })()`)
const POINTS = [[300, 200], [20, 20], [580, 380], [300, 20]]

check('the app has its model', await js(`window.gigma.matting.available()`), true)
const before = await fill()
check('before: the whole picture is there', await alpha(POINTS), ['kept', 'kept', 'kept', 'kept'])

// ================================================================ remove the background (as the AI would, over MCP)
const t0 = Date.now()
const res = await mcp('remove_background', { ids: [pic.id] })
console.log('   ran on', res[0].device, 'in', res[0].seconds, 's (with loading the model:', Math.round((Date.now() - t0) / 100) / 10, 's)')
check('remove_background answers with what it ran on', [res[0].backgroundRemoved, /GPU|CPU/.test(res[0].device)], [true, true])
const cut = await fill()
check('the picture is the same file, a mask was added', [cut.image === before.image, typeof cut.mask === 'string' && cut.mask.length === 40], [true, true])
await wait(600)
check('the ball stays, the wall is gone', await alpha(POINTS), ['kept', 'gone', 'gone', 'gone'])
// a second picture goes faster: the model is already loaded
const t1 = Date.now()
await mcp('remove_background', { ids: [pic.id] })
console.log('   second run:', Math.round((Date.now() - t1) / 100) / 10, 's')
// the same picture gives the same mask: nothing changed, so it added no step to the history
check('removing it twice changes nothing', (await fill()).mask === cut.mask, true)
// ---- undo, redo, restore
await js(`editor.undo()`)
await wait(400)
check('Ctrl+Z brings the background back', [(await fill()).mask, await alpha(POINTS)], [null, ['kept', 'kept', 'kept', 'kept']])
await js(`editor.redo()`)
await wait(400)
check('redo removes it again', [(await fill()).mask === cut.mask, (await alpha(POINTS))[1]], [true, 'gone'])
await mcp('remove_background', { ids: [pic.id], restore: true })
await wait(300)
check('restore: true puts the background back', (await fill()).mask, null)
await js(`editor.undo()`)
await wait(400)

// ================================================================ the same from the context menu entry (the action behind it)
await mcp('set_selection', { ids: [pic.id] })
await js(`(async () => { const { layerActions } = await import('/ui/layerActions.ts'); layerActions.restoreBackground(); await layerActions.removeBackground() })()`)
await wait(500)
check('the menu action removes the background too', (await alpha(POINTS))[1], 'gone')
check('and tells what it ran on', /GPU|CPU/.test(await js(`document.querySelector('.toast span')?.textContent ?? ''`)), true)

// ================================================================ the SVG export carries the transparency
const svg = await js(`(async () => { const { nodesToSvg } = await import('/editor/svg.ts'); return nodesToSvg(editor, ['${pic.id}'], false) })()`)
const b64 = /href="data:image\/png;base64,([^"]+)"/.exec(svg)?.[1]
const exported = b64 ? await js(`(async () => { const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,${b64}')).blob()); const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); return [g.getImageData(300, 200, 1, 1).data[3], g.getImageData(20, 20, 1, 1).data[3]] })()`) : null
check('the SVG export holds the picture without its background', [exported?.[0] > 200, exported?.[1] < 40], [true, true])

// ================================================================ the mask brushes
const paint = () => send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 } })
const ev = (type, x, y, down) => send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !down ? 'none' : 'left', buttons: down ? 1 : 0, clickCount: 1 })
const at = (wx, wy) => js(`(() => { const r = document.querySelector('.canvas-wrap canvas').getBoundingClientRect(), c = editor.camera; return [r.left + ${wx} * c.zoom + c.x, r.top + ${wy} * c.zoom + c.y] })()`)
const strokeLine = async (a, b) => {
  await ev('mouseMoved', a[0], a[1], false)
  await paint()
  await ev('mousePressed', a[0], a[1], true)
  for (let i = 1; i <= 10; i++) await ev('mouseMoved', a[0] + ((b[0] - a[0]) * i) / 10, a[1] + ((b[1] - a[1]) * i) / 10, true)
  await ev('mouseReleased', b[0], b[1], false)
  await wait(700)
}
await js(`(async () => { const { layerActions } = await import('/ui/layerActions.ts'); layerActions.editMask() })()`)
await wait(900)
check('"Edit mask" opens the brushes', await js(`[!!document.querySelector('.mask-stage'), document.querySelectorAll('.mask-bar .seg button').length, [...document.querySelectorAll('.mask-bar .seg button')].findIndex((b) => b.classList.contains('on'))]`), [true, 2, 0])
const setBar = (expr) => js(`(() => { ${expr} })()`)
// snapping off, a hard brush of 60: erase a stroke through the middle of the ball
await setBar(`const c = document.querySelector('.mask-bar input[type=checkbox]'); if (c.checked) c.click()`)
const setRange = (index, v) => js(`(() => { const el = document.querySelectorAll('.mask-bar input[type=range]')[${index}]; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '${v}'); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) })()`)
await setRange(0, 60)
await setRange(1, 0)
await wait(200)
const maskBefore = (await fill()).mask
// the picture layer is at 50,50 in the frame: its middle is world 350,250
await strokeLine(await at(300, 250), await at(400, 250))
const erased = await fill()
check('a stroke of the eraser makes a new mask', erased.mask !== maskBefore && typeof erased.mask === 'string', true)
check('it hid the middle of the ball, and nothing else', await alpha([[300, 200], [300, 110], [300, 290], [20, 20]]), ['gone', 'kept', 'kept', 'gone'])
await js(`editor.undo()`)
await wait(900)
check('Ctrl+Z takes the stroke back, the brushes stay open', [(await fill()).mask === maskBefore, (await alpha([[300, 200]]))[0], await js(`!!document.querySelector('.mask-stage')`)], [true, 'kept', true])
// Restore: bring a piece of the wall back, above the ball
await js(`document.querySelectorAll('.mask-bar .seg button')[1].click()`)
await strokeLine(await at(150, 100), await at(250, 100))
check('the restore brush brings the wall back where it went', await alpha([[150, 50], [400, 50]]), ['kept', 'gone'])
// Snap to edges: an eraser started on the ball and dragged far into the wall hides the ball part only
await js(`editor.undo()`)
await wait(900)
await js(`document.querySelectorAll('.mask-bar .seg button')[1].click()`)
await setBar(`const c = document.querySelector('.mask-bar input[type=checkbox]'); if (!c.checked) c.click()`)
await setRange(0, 80)
// restore with snapping, started on the wall and dragged across the edge of the ball: the wall comes back, the stroke
// must not... (the ball is already kept; what matters is the next check with the eraser)
await js(`document.querySelectorAll('.mask-bar .seg button')[0].click()`)
// first bring a strip of wall back without snapping, so the eraser has wall to (not) touch
await setBar(`const c = document.querySelector('.mask-bar input[type=checkbox]'); if (c.checked) c.click()`)
await js(`document.querySelectorAll('.mask-bar .seg button')[1].click()`)
await strokeLine(await at(120, 250), await at(210, 250))
check('a strip of wall left of the ball is back', (await alpha([[100, 200]]))[0], 'kept')
await js(`document.querySelectorAll('.mask-bar .seg button')[0].click()`)
await setBar(`const c = document.querySelector('.mask-bar input[type=checkbox]'); if (!c.checked) c.click()`)
// the eraser starts on the ball (world 260,250 = picture 210,200) and runs left over the wall strip
await strokeLine(await at(260, 250), await at(150, 250))
check('with "Snap to edges" the eraser takes the ball and leaves the wall beside it', await alpha([[205, 200], [100, 200]]), ['gone', 'kept'])
if (shot) {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(shot, Buffer.from(s.data, 'base64'))
}
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await wait(300)
check('Escape closes the brushes; the picture file itself was never changed', [await js(`!!document.querySelector('.mask-stage')`), (await fill()).image === before.image], [false, true])

// ================================================================ a guideline travels with the frames wired to it
const made = await js(`(async () => {
  const { newGuide, saveGuide, placeGuide, flushGuides } = await import('/editor/guides.ts')
  const g = newGuide('Brand ' + Date.now().toString(36))
  saveGuide(g)
  const n = placeGuide(g.id, { x: -300, y: 100 }, false)
  editor.act(() => editor.updateNode(n.id, { guide: { ...editor.nodes.get(n.id).guide, targets: ['${frame.id}'] } }))
  await flushGuides()
  const { exportGuideFile } = await import('/editor/guides.ts')
  const ok = await exportGuideFile(g.id)
  return { ok, id: g.id, name: g.name, dot: n.id }
})()`)
const file = readdirSync(dir).find((f) => f.endsWith('.gguide'))
const saved = file ? JSON.parse(readFileSync(join(dir, file), 'utf8')) : null
check('the exported .gguide holds the frame wired to the guideline, its layers and its picture', [made.ok, saved?.frames?.nodes.map((n) => n.name), Object.keys(saved?.frames?.images ?? {}).length >= 1, saved?.frames?.nodes[0].parentId], [true, ['Card', 'ball'], true, null])
// another project: import the file, place the guideline, the frame comes with it
const other = await mcp('create_project', { name: 'Matting test 2' })
await mcp('show_tab', {})
const tab2 = await attach((u) => u.includes('#doc=' + encodeURIComponent(other.path)))
await wait(1500)
// as if it came from another computer: a guideline with another id
const copy = { ...saved, id: saved.id.replace(/^.{8}/, 'feedc0de'), name: saved.name + ' imported' }
writeFileSync(join(dir, 'imported.gguide'), JSON.stringify(copy))
const imported = await tab2.js(`window.gigma.guides.importPath(${JSON.stringify(join(dir, 'imported.gguide'))}).then((g) => g.name)`)
check('the file is imported into the library', imported, copy.name)
await tab2.js(`(async () => { const { loadGuides, placeGuide } = await import('/editor/guides.ts'); await loadGuides(); placeGuide('${copy.id}', { x: 0, y: 0 }, false) })()`)
await wait(1500)
const landed = await tab2.js(`(() => { const dot = [...editor.nodes.values()].find((n) => n.type === 'GUIDE'); const frame = [...editor.nodes.values()].find((n) => n.name === 'Card'); const ball = [...editor.nodes.values()].find((n) => n.name === 'ball'); return { nodes: [...editor.nodes.values()].map((n) => n.name).sort(), wired: !!frame && (dot.guide.targets ?? []).includes(frame.id), child: ball?.parentId === frame?.id, mask: !!ball?.fills.find((f) => f.type === 'IMAGE')?.maskHash, where: frame && [Math.round(frame.x - dot.x), Math.round(frame.y - dot.y)] } })()`)
check('placed in another project, the guideline brings its frame, wired to it, where it stood', [landed.nodes.filter((n) => n === 'Card' || n === 'ball'), landed.wired, landed.child, landed.where], [['Card', 'ball'], true, true, [336, -64]])
const pictureThere = await tab2.js(`(async () => { const { isImageMissing } = await import('/editor/render.ts'); const ball = [...editor.nodes.values()].find((n) => n.name === 'ball'); const f = ball.fills.find((f) => f.type === 'IMAGE'); return [await isImageMissing(f.imageHash), !!f.maskHash] })()`)
check('its picture came along, with the mask of the removed background', pictureThere, [false, true])
tab2.close()

// ================================================================ updates
const shell = await attach((u) => u.includes('#shell'))
const upd = await shell.js(`window.gigma.updates.check()`)
console.log('   update check from a build run from the sources:', JSON.stringify(upd))
check('the update check answers (this build is newer than the published release, or GitHub is unreachable)', ['none', 'link', 'error'].includes(upd?.status), true)
check('Settings can switch the check off', await shell.js(`window.gigma.settings.set({ autoUpdate: false }).then((s) => s.autoUpdate)`), false)
await shell.js(`window.gigma.settings.set({ autoUpdate: true })`)
shell.close()

console.log(results.join('\n'))
console.log(results.some((r) => r.startsWith('FAIL')) ? '\nFAILED' : '\nALL PASSED')
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
