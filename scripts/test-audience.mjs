// Bugs reported by users: text that vanished at a large zoom, handles on the sides, a marquee that pulled pictures out
// of their frames, undo of names and styles, an AI that took over the user's tab, and the archive of projects.
// Usage: node scripts/test-audience.mjs [debugPort] [mcpPort]   (defaults 9333 / 7331)
const port = process.argv[2] ?? '9333'
const mcpPort = process.argv[3] ?? '7331'
let mid = 0
async function mcp(name, args = {}) {
  const r = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++mid, method: 'tools/call', params: { name, arguments: args } }) })
  const j = await r.json()
  if (j.error || j.result?.isError) throw new Error(name + ': ' + JSON.stringify(j.error ?? j.result.content))
  // pictures come back as image content, everything else as JSON text
  const picture = j.result.content.find((c) => c.type === 'image')
  if (picture) return { picture: picture.data.length }
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
const stamp = Date.now().toString(36)
const NAME = 'User project ' + stamp
const RENAMED = 'Renamed ' + stamp
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
const tabOf = (path) => attach((u) => u.includes('#doc=' + encodeURIComponent(path)))

// ================================================================ 5. the AI works in a tab of its own, in the background
// the user has a project in front
const mine = await mcp('create_project', { name: NAME })
await mcp('show_tab', {})
const userFrame = await mcp('create_frame', { name: 'Mine', x: 0, y: 0, width: 300, height: 200, fill: '#FFFFFF' })
// the AI is told to make another project
const ai = await mcp('create_project', { name: 'AI project' })
let tabs = await mcp('list_tabs')
check('a project the AI creates opens in the background: the user stays where they were', [tabs.activeId === mine.tabId, tabs.aiTabId === ai.tabId, ai.shown], [true, true, false])
const made = await mcp('create_frame', { name: 'AI frame', x: 0, y: 0, width: 400, height: 300, fill: '#FF6600' })
const userTab = await tabOf(mine.path)
const aiTab = await tabOf(ai.path)
await wait(600)
check('its commands land in its own tab, not in the one the user looks at', [await aiTab.js(`[...editor.nodes.values()].map((n) => n.name)`), await userTab.js(`[...editor.nodes.values()].map((n) => n.name)`)], [['AI frame'], ['Mine']])
// the user opens yet another project while the AI is busy
const other = await mcp('create_project', { name: 'Another' })
await mcp('show_tab', { tabId: other.tabId })
await mcp('switch_tab', { tabId: ai.tabId })
tabs = await mcp('list_tabs')
check('switch_tab moves the AI, not the screen', [tabs.activeId === other.tabId, tabs.aiTabId === ai.tabId], [true, true])
await mcp('create_rectangle', { parentId: made.id, name: 'by AI', x: 10, y: 10, width: 50, height: 50, fill: '#000000' })
const otherTab = await tabOf(other.path)
check('the AI goes on in its own tab while the user is in another project', [await aiTab.js(`editor.nodes.size`), await otherTab.js(`editor.nodes.size`)], [2, 0])
// a hidden tab draws no frames: a screenshot must still come, and at once
const t0 = Date.now()
const shot = await mcp('get_screenshot', { maxSize: 400 })
check('a screenshot of the background tab comes at once', [shot.picture > 500, Date.now() - t0 < 5000], [true, true])
const png = await mcp('export_png', { ids: [made.id], scale: 1 })
check('and so does an export', png.picture > 500, true)
check('the tab bar marks the tab the AI works in', (await mcp('list_tabs')).tabs.find((t) => t.id === ai.tabId)?.ai, true)
// when the tab of the AI is closed, its next command takes the tab in front
const shell = await attach((u) => u.includes('#shell'))
await shell.js(`window.gigma.tabs.close('${ai.tabId}')`)
await wait(800)
const late = await mcp('create_frame', { name: 'After close', x: 500, y: 0, width: 100, height: 100 })
check('with its tab closed, the AI takes the tab in front', [(await mcp('list_tabs')).aiTabId === other.tabId, await otherTab.js(`[...editor.nodes.values()].map((n) => n.name)`)], [true, ['After close']])
aiTab.close()
otherTab.close()

// ================================================================ the rest runs in the user's project, in front
await mcp('switch_tab', { tabId: mine.tabId })
await mcp('show_tab', { tabId: mine.tabId })
await wait(500)
const { send, js } = userTab
const paint = () => send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 } })
const ev = (type, x, y, down, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !down ? 'none' : 'left', buttons: down ? 1 : 0, clickCount: 1, ...extra })
const at = (wx, wy) => js(`(() => { const r = document.querySelector('.canvas-wrap canvas').getBoundingClientRect(), c = editor.camera; return [r.left + ${wx} * c.zoom + c.x, r.top + ${wy} * c.zoom + c.y] })()`)
const drag = async (a, b, extra = {}) => {
  await ev('mouseMoved', a[0], a[1], false)
  await paint()
  await ev('mousePressed', a[0], a[1], true, extra)
  for (let i = 1; i <= 8; i++) await ev('mouseMoved', a[0] + ((b[0] - a[0]) * i) / 8, a[1] + ((b[1] - a[1]) * i) / 8, true, extra)
  await ev('mouseReleased', b[0], b[1], false, extra)
  await wait(250)
}

// ================================================================ 2. zoomed far into a layer, it must still be drawn
// A text in a box of fixed size runs out of the box; a thick stroke lies outside the box of its line. Zoomed into
// such a part, the view no longer touches the box of the layer: the layer used to vanish there.
const text = await mcp('create_text', { parentId: userFrame.id, x: 20, y: 20, width: 60, text: '████ ████ ████ ████ ████', fontSize: 16, fontFamily: 'Arial', color: '#000000' })
await mcp('update_node', { id: text.id, textAutoResize: 'NONE', height: 20 })
const stroke = await mcp('create_shape', { kind: 'line', parentId: userFrame.id, x: 150, y: 100, width: 100, height: 0.01 })
await mcp('update_node', { id: stroke.id, strokes: [{ color: '#000000', weight: 30, align: 'CENTER' }] })
/** how much of the screen is ink when the view is centred on a world point at that zoom */
const dark = async (wx, wy, z) =>
  js(`(async () => {
    editor.setZoom(${z})
    const v = editor.viewport
    editor.camera = { zoom: editor.camera.zoom, x: v.w / 2 - ${wx} * editor.camera.zoom, y: v.h / 2 - ${wy} * editor.camera.zoom }
    editor.emit('camera')
    await new Promise((r) => setTimeout(r, 350))
    const c = document.querySelector('.canvas-wrap canvas')
    const g = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 0; i < g.length; i += 4) if (g[i] < 60 && g[i + 1] < 60 && g[i + 2] < 60) n++
    return Math.round((n / (c.width * c.height)) * 100) / 100
  })()`)
const box0 = await js(`editor.world('${text.id}')`)
// the third line of the text lies well below its 20 px box
const below = { x: box0.x + 20, y: box0.y + 48 }
const seen = []
for (const z of [32, 128, 256]) seen.push(await dark(below.x, below.y, z))
console.log('   ink on screen when zoomed into the text below its box, by zoom', JSON.stringify(seen))
check('text that runs out of its box is drawn at 3200%, 12800% and 25600%', seen.map((v) => v > 0.9), [true, true, true])
// the stroke is 30 thick around a line whose box has no height: 12 px above the line is still stroke
const s0 = await js(`editor.world('${stroke.id}')`)
const thick = []
for (const z of [64, 256]) thick.push(await dark(s0.x + 50, s0.y - 12, z))
console.log('   ink on screen when zoomed into the edge of a thick stroke, by zoom', JSON.stringify(thick))
check('a thick stroke is drawn when zoomed into its edge', [thick[0] > 0.5, thick[1] > 0.9], [true, true])
await mcp('delete_nodes', { ids: [stroke.id] })
await mcp('zoom_to', { ids: [userFrame.id] })

// ================================================================ 3. handles and Shift on a side
await mcp('delete_nodes', { ids: [text.id] })
const box = await mcp('create_rectangle', { name: 'box', x: 400, y: 0, width: 200, height: 100, fill: '#D9D9D9' })
await mcp('zoom_to', { ids: [userFrame.id, box.id] })
await mcp('set_selection', { ids: [box.id] })
await wait(300)
check('a selection has handles in its corners only', await js(`canvasView.handles(canvasView.toScreen(editor.world('${box.id}'))).map((h) => h[0])`), ['nw', 'ne', 'se', 'sw'])
// the right side is grabbed anywhere along it
await drag(await at(600, 30), await at(700, 30))
check('a side is still dragged by any point of it', await js(`[editor.nodes.get('${box.id}').width, editor.nodes.get('${box.id}').height]`), [300, 100])
await drag(await at(400, 70), await at(300, 70), { modifiers: 8 })
check('with Shift a side scales the whole layer: the height follows, around the middle', await js(`(() => { const n = editor.nodes.get('${box.id}'); return [Math.round(n.width), Math.round(n.height * 100) / 100, Math.round(n.y * 100) / 100, Math.round(n.x)] })()`), [400, 133.33, -16.67, 300])
await drag(await at(500, 116.67), await at(500, 150), { modifiers: 8 })
check('the same for the bottom side: the width follows', await js(`(() => { const n = editor.nodes.get('${box.id}'); return [Math.round(n.width), Math.round(n.height)] })()`), [500, 167])
await mcp('delete_nodes', { ids: [box.id, userFrame.id] })

// ================================================================ 4. a marquee over frames with pictures larger than the frames
const frames = []
for (let i = 0; i < 6; i++) {
  const f = await mcp('create_frame', { name: 'F' + i, x: (i % 3) * 260, y: Math.floor(i / 3) * 340, width: 216, height: 270, fill: '#1B1B20' })
  await mcp('create_rectangle', { parentId: f.id, name: 'photo', x: -60, y: -40, width: 340, height: 360, fill: '#CC6633' })
  await mcp('create_text', { parentId: f.id, x: 12, y: 12, text: 'Title ' + i, fontSize: 20, color: '#FFFFFF' })
  frames.push(f)
}
await mcp('zoom_to', { ids: frames.map((f) => f.id) })
await mcp('set_selection', { ids: [] })
await wait(300)
const snap = () => js(`JSON.stringify([...editor.nodes.values()].map((n) => [n.name, n.parentId ? editor.nodes.get(n.parentId).name : null, Math.round(n.x), Math.round(n.y), n.order]).sort())`)
const names = () => js(`editor.selection.map((i) => editor.nodes.get(i).name).sort()`)
const before = await snap()
// the marquee swallows the first two frames and only touches the others
await drag(await at(-40, -30), await at(600, 500))
check('a marquee that swallows some frames and touches the others takes the frames, never their contents', await names(), ['F0', 'F1', 'F2', 'F3', 'F4', 'F5'])
await drag(await at(100, 200), await at(600, 320))
check('dragged, every picture stays in its frame', await js(`[...editor.nodes.values()].filter((n) => n.name === 'photo').map((n) => [editor.nodes.get(n.parentId).name, n.x, n.y]).sort()`), [0, 1, 2, 3, 4, 5].map((i) => ['F' + i, -60, -40]))
check('and all six frames moved together', await js(`[...editor.nodes.values()].filter((n) => /^F\\d/.test(n.name)).map((n) => [n.name, n.x, n.y]).sort()`), [0, 1, 2, 3, 4, 5].map((i) => ['F' + i, (i % 3) * 260 + 500, Math.floor(i / 3) * 340 + 120]))
await js(`editor.undo()`)
await wait(200)
check('one undo puts everything back exactly', (await snap()) === before, true)
// a marquee that only touches frames (swallows none) still reaches into them, as in Figma
await mcp('set_selection', { ids: [] })
await drag(await at(-30, 100), await at(120, 200))
check('a marquee inside one frame takes what it touches there', await names(), ['photo'])
// the part of a picture that hangs out of its frame is hidden: a marquee over that empty place catches nothing
await mcp('set_selection', { ids: [] })
await drag(await at(222, 60), await at(250, 120))
check('the hidden part of a picture cannot be caught by a marquee', await names(), [])

// ================================================================ undo of what used to have no history
await js(`editor.rename('${RENAMED}')`)
await js(`editor.setColorStyles([{ id: 's1', name: 'Brand', color: { r: 1, g: 0, b: 0, a: 1 } }])`)
await js(`editor.updateColorStyle('s1', { name: 'Brand red' })`)
check('a rename and styles are steps of history', await js(`[editor.meta.name, editor.meta.colorStyles.map((s) => s.name)]`), [RENAMED, ['Brand red']])
await js(`editor.undo()`)
check('undo: the style has its old name', await js(`editor.meta.colorStyles.map((s) => s.name)`), ['Brand'])
await js(`editor.undo()`)
check('undo: the style is gone', await js(`(editor.meta.colorStyles ?? []).length`), 0)
await js(`editor.undo()`)
check('undo: the project has its old name', await js(`editor.meta.name`), NAME)
await js(`editor.redo(); editor.redo(); editor.redo()`)
check('redo brings all three back', await js(`[editor.meta.name, editor.meta.colorStyles.map((s) => s.name)]`), [RENAMED, ['Brand red']])
await js(`editor.flush()`)
await wait(400)

// ================================================================ 6. the archive
const lib = () => shell.js(`window.gigma.library.list().then((l) => l.map((p) => p.name).sort())`)
const arch = () => shell.js(`window.gigma.library.listArchive().then((l) => l.filter((p) => p.name.endsWith('${stamp}')).map((p) => [p.name, p.size > 0, p.originalSize > 0, !!p.thumb || p.thumb === null]))`)
const nodesBefore = await js(`editor.nodes.size`)
check('nothing is in the archive at first', await arch(), [])
await shell.js(`window.gigma.library.archive(${JSON.stringify(mine.path)})`)
await wait(800)
check('an archived project leaves the library and its tab closes', [(await lib()).includes(RENAMED), (await mcp('list_tabs')).tabs.some((t) => t.id === mine.tabId)], [false, false])
check('it is listed in the archive with its name and sizes', await arch(), [[RENAMED, true, true, true]])
check('the storage statistics count it', await shell.js(`window.gigma.library.stats().then((s) => s.archive > 0)`), true)
const packed = await shell.js(`window.gigma.library.listArchive().then((l) => l.find((p) => p.name.endsWith('${stamp}')).path)`)
const back = await shell.js(`window.gigma.library.unarchive(${JSON.stringify(packed)})`)
await wait(500)
check('restored, it is in the library again and the archive is empty', [(await lib()).includes(RENAMED), await arch()], [true, []])
const again = await mcp('open_project', { path: back })
await mcp('show_tab', { tabId: again.tabId })
await wait(1500)
const reopened = await tabOf(back)
check('and it opens with everything it had', [await reopened.js(`editor.nodes.size`), await reopened.js(`editor.meta.name`), await reopened.js(`editor.meta.colorStyles.map((s) => s.name)`)], [nodesBefore, RENAMED, ['Brand red']])
reopened.close()

console.log(results.join('\n'))
console.log(results.some((r) => r.startsWith('FAIL')) ? '\nFAILED' : '\nALL PASSED')
userTab.close()
shell.close()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
