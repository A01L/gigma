// The task board on Home: Spec tasks of the open projects, the widget in the sidebar, the jump to a task.
// Usage: node scripts/test-spec-board.mjs [debugPort] [mcpPort] [screenshot.png]   (defaults 9333 / 7331)
import { writeFileSync } from 'node:fs'
const port = process.argv[2] ?? '9333'
const mcpPort = process.argv[3] ?? '7331'
const shot = process.argv[4]
let mid = 0
const rpc = async (method, params, headers = {}) =>
  (await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++mid, method, params }) })).json()
async function mcp(name, args = {}, headers) {
  const j = await rpc('tools/call', { name, arguments: args }, headers)
  if (j.error || j.result?.isError) throw new Error(name + ': ' + JSON.stringify(j.error ?? j.result.content))
  return JSON.parse(j.result.content[0].text)
}
const results = []
const check = (label, got, want) => results.push(`${JSON.stringify(got) === JSON.stringify(want) ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(want) ? '' : '  want ' + JSON.stringify(want)}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function attach(match) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.filter((p) => p.type === 'page' && p.url.includes(match)).pop()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    pending.get(m.id)?.(m.result)
  })
  const send = (method, params) => new Promise((res) => (pending.set(++id, res), ws.send(JSON.stringify({ id, method, params }))))
  const js = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }).then((r) => r.result?.value ?? r.exceptionDetails?.exception?.description ?? null)
  return { send, js, close: () => ws.close() }
}

await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.0.0' } })
const shell = await attach('#shell')
const before = await shell.js(`window.gigma.specs.list().then((l) => l.length)`)

// ---- project A: three tasks and a page of its own for the last one ----
const a = await mcp('create_project', { name: 'Board A' })
const home = await mcp('create_frame', { name: 'Home', x: 600, y: 0, width: 360, height: 300, fill: '#FFFFFF' })
const s1 = await mcp('create_spec', { title: 'Hero block', body: 'A warm headline and **one** button', x: 0, y: 0, frameIds: [home.id] })
const s2 = await mcp('create_spec', { title: 'Footer', body: 'Links and a copyright line', x: 0, y: 300 })
const s3 = await mcp('create_spec', { title: 'Old banner', body: 'Remove it', x: 0, y: 600 })
await mcp('update_spec', { id: s1.id, status: 'IN_PROGRESS' })
await mcp('update_spec', { id: s3.id, status: 'DONE', result: 'Removed' }, { 'x-gigma-client': 'codex-mcp-client' })
const page2 = await mcp('create_page', { name: 'Checkout' })
await mcp('set_current_page', { pageId: page2.id })
const s4 = await mcp('create_spec', { title: 'Payment form', body: 'Card, name, pay button', x: 2000, y: 2000 })
// ---- project B: one task and a card of rules, which is not a task ----
const b = await mcp('create_project', { name: 'Board B' })
const s5 = await mcp('create_spec', { title: 'Pricing table', body: 'Three plans', x: 0, y: 0 })
await mcp('create_spec', { title: 'Brand rules', body: 'Only blue', kind: 'RULES', x: 0, y: 300 })
await mcp('switch_tab', { tabId: null })
await wait(700)

const mine = (l) => l.filter((s) => s.tabId === a.tabId || s.tabId === b.tabId)
const board = mine(await shell.js(`window.gigma.specs.list()`))
check('the board lists the tasks of both tabs, rules left out', board.map((s) => s.title), ['Hero block', 'Footer', 'Old banner', 'Payment form', 'Pricing table'])
check('each task carries its project, page and frames', board.map((s) => [s.project, s.page, s.frames.join()]).slice(0, 4), [
  ['Board A', 'Page 1', 'Home'],
  ['Board A', 'Page 1', ''],
  ['Board A', 'Page 1', ''],
  ['Board A', 'Checkout', '']
])
check('statuses', board.map((s) => s.status), ['IN_PROGRESS', 'TODO', 'DONE', 'TODO', 'TODO'])
check('the assistant that touched a task is named', [board[0].client, board[2].client], ['Claude', 'Codex'])
check('markdown marks are stripped from the excerpt', board[0].excerpt, 'A warm headline and one button')

// ---- the widget in the sidebar ----
const total = before + 5
const doneAll = (await shell.js(`window.gigma.specs.list()`)).filter((s) => s.status === 'DONE').length
const widget = () => shell.js(`(() => { const w = document.querySelector('.side-specs'); return w && [w.querySelector('b').textContent, w.querySelector('.side-specs-tag').textContent, w.querySelector('.side-specs-pct').textContent, w.querySelector('.side-specs-bar i').style.width] })()`)
const pct = Math.round((doneAll / total) * 100) + '%'
check('widget: count, tag, percent, bar', await widget(), [String(total), 'SPECS', pct, pct])
check('the widget sits above Recent', await shell.js(`document.querySelector('.side-specs').nextElementSibling.tagName`), 'NAV')

// ---- the page ----
await shell.js(`document.querySelector('.side-specs').click()`)
await wait(200)
const group = (cls) => shell.js(`[...document.querySelectorAll('.specs-group.${cls} .specs-row .specs-title')].map((e) => e.textContent)`)
const only = (l) => l.filter((t) => ['Hero block', 'Footer', 'Old banner', 'Payment form', 'Pricing table'].includes(t))
check('it is a page of Home, not a tab', await shell.js(`[!!document.querySelector('.home-main .specs-page'), document.querySelector('.side-specs').classList.contains('active')]`), [true, true])
check('group: in progress', only(await group('in_progress')), ['Hero block'])
check('group: queue', only(await group('todo')), ['Footer', 'Payment form', 'Pricing table'])
check('group: done', only(await group('done')), ['Old banner'])
check('groups come in the order: in progress, queue, done', await shell.js(`[...document.querySelectorAll('.specs-group')].map((g) => g.className.split(' ')[1])`), ['in_progress', 'todo', 'done'])
check('a row shows the frame, the assistant and the project', await shell.js(`[...[...document.querySelectorAll('.specs-row')].find((r) => r.querySelector('.specs-title').textContent === 'Hero block').querySelectorAll('.specs-chip, .specs-page-name')].map((c) => c.textContent)`), ['→ Home', 'Claude', 'Board A', 'Page 1'])
check('several projects: a project filter appears', await shell.js(`!!document.querySelector('.specs-tools .gsel')`), true)
// search
const type = (sel, v) => shell.js(`(() => { const i = document.querySelector('${sel}'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
await type('.specs-search input', 'pricing')
await wait(150)
check('search narrows the list', await shell.js(`[...document.querySelectorAll('.specs-row .specs-title')].map((e) => e.textContent)`), ['Pricing table'])
await type('.specs-search input', 'zzzz-nothing')
await wait(150)
check('search with no match', await shell.js(`[document.querySelectorAll('.specs-row').length, !!document.querySelector('.specs-page .empty')]`), [0, true])
await type('.specs-search input', '')
await wait(150)
// collapsing a group
await shell.js(`document.querySelector('.specs-group.todo .specs-group-head').click()`)
await wait(100)
check('a group folds', await shell.js(`document.querySelectorAll('.specs-group.todo .specs-row').length`), 0)
await shell.js(`document.querySelector('.specs-group.todo .specs-group-head').click()`)
await wait(100)
if (shot) {
  await wait(300)
  const r = await shell.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(shot, Buffer.from(r.data, 'base64'))
}

// ---- a click goes to the task in its tab ----
const clickRow = (title) => shell.js(`[...document.querySelectorAll('.specs-row')].find((r) => r.querySelector('.specs-title').textContent === ${JSON.stringify(title)}).click()`)
await clickRow('Payment form')
await wait(500)
check('the click switches to the tab of the task', (await mcp('list_tabs')).activeId, a.tabId)
const docA = await attach('#doc=' + encodeURIComponent(a.path))
check('its page is the current one, the card selected', [await docA.js(`editor.page.name`), await docA.js(`editor.selection`)], ['Checkout', [s4.id]])
check('the card is in view', await docA.js(`(() => { const w = editor.world('${s4.id}'), c = editor.camera, v = editor.viewport; const x = (w.x + w.w / 2) * c.zoom + c.x, y = (w.y + w.h / 2) * c.zoom + c.y; return x > 0 && x < v.w && y > 0 && y < v.h })()`), true)
// back on Home the board is still open
await mcp('switch_tab', { tabId: null })
await wait(500)
check('Home comes back to the board', await shell.js(`!!document.querySelector('.home-main .specs-page')`), true)
await clickRow('Hero block')
await wait(500)
check('a task with frames: page 1 again, the card selected', [await docA.js(`editor.page.name`), await docA.js(`editor.selection`)], ['Page 1', [s1.id]])
check('the card and its frame are both in view', await docA.js(`(() => { const c = editor.camera, v = editor.viewport; return ['${s1.id}', '${home.id}'].every((id) => { const w = editor.world(id); return w.x * c.zoom + c.x >= 0 && (w.x + w.w) * c.zoom + c.x <= v.w && w.y * c.zoom + c.y >= 0 && (w.y + w.h) * c.zoom + c.y <= v.h }) })()`), true)

// ---- it follows the work live ----
await mcp('update_spec', { id: s1.id, status: 'DONE', result: 'Built' })
await mcp('update_spec', { id: s2.id, status: 'IN_PROGRESS' }, { 'x-gigma-client': 'codex-mcp-client' })
await wait(600)
const live = mine(await shell.js(`window.gigma.specs.list()`))
check('status changes reach the board', live.filter((s) => s.tabId === a.tabId).map((s) => [s.title, s.status, s.client ?? null]), [
  ['Hero block', 'DONE', 'Claude'],
  ['Footer', 'IN_PROGRESS', 'Codex'],
  ['Old banner', 'DONE', 'Codex'],
  ['Payment form', 'TODO', null]
])
await mcp('switch_tab', { tabId: null })
await wait(400)
check('the page shows the new state', [only(await group('in_progress')), only(await group('done')).includes('Hero block')], [['Footer'], true])
await wait(500)

// ---- only open tabs count ----
await shell.js(`window.gigma.tabs.close('${a.tabId}')`)
await wait(900)
const left = mine(await shell.js(`window.gigma.specs.list()`))
check('closing a tab takes its tasks off the board', left.map((s) => s.title), ['Pricing table'])
check('the widget follows', (await widget())[0], String(before + 1))
await shell.js(`window.gigma.tabs.close('${b.tabId}')`)
await wait(900)
check('no tabs of ours: nothing of ours on the board', mine(await shell.js(`window.gigma.specs.list()`)).length, 0)
if (before === 0) check('empty board explains itself', await shell.js(`document.querySelector('.specs-page .empty')?.textContent.length > 10`), true)
void s5

console.log(results.join('\n'))
console.log(results.some((r) => r.startsWith('FAIL')) ? 'SOME FAILED' : `all ${results.length} passed`)
shell.close()
docA.close()
