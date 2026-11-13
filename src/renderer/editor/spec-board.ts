// The task board on Home shows the Spec tasks of every open project.
// Each project tab reports its own tasks to the app from here, and jumps to a task when the board asks.
import type { SpecTask } from '@shared/api'
import { backend } from '../backend'
import { editor as ed } from './editor'
import { unionRects } from './util'

/** spec id -> the AI client that last changed it over MCP (this session only, never saved) */
const clients = new Map<string, string>()

export function noteSpecClient(id: unknown, client: string): void {
  if (typeof id !== 'string' || !client) return
  clients.set(id, client)
  schedule()
}

function collect(): SpecTask[] {
  const out: (SpecTask & { key: string })[] = []
  for (const n of ed.nodes.values()) {
    // RULES cards are standing rules, not tasks: they have no status and never get "done"
    if (n.type !== 'SPEC' || !n.spec || n.spec.kind === 'RULES') continue
    const page = ed.pages.get(n.pageId)
    if (!page) continue
    const r = ed.world(n.id)
    out.push({
      id: n.id,
      title: n.spec.title.trim() || n.name,
      excerpt: n.spec.body.replace(/[#*`>_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160),
      status: n.spec.status,
      page: page.name,
      frames: (n.spec.targets ?? []).flatMap((id) => ed.nodes.get(id)?.name ?? []),
      ...(clients.has(n.id) && { client: clients.get(n.id) }),
      // reading order: page by page, then top to bottom
      key: page.order + '\u0000' + String(Math.round(r.y) + 1e9).padStart(12, '0') + String(Math.round(r.x) + 1e9).padStart(12, '0')
    })
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map(({ key: _key, ...t }) => t)
}

let timer: ReturnType<typeof setTimeout> | undefined
let last = ''

function send(): void {
  const tasks = collect()
  const now = JSON.stringify(tasks)
  if (now === last) return
  last = now
  backend.specs.report(tasks)
}

let queued = false
function schedule(): void {
  clearTimeout(timer)
  // a tab in the background has its timers slowed down, and there only an AI changes the document:
  // report right after the change, so the board follows the work live
  if (document.visibilityState === 'hidden') {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      send()
    })
    return
  }
  timer = setTimeout(send, 250)
}

/** show a spec: its page, the card selected, the card and the frames it is wired to in view */
function focusSpec(id: string): void {
  const n = ed.nodes.get(id)
  if (!n) return
  if (n.pageId !== ed.currentPageId) ed.setCurrentPage(n.pageId)
  ed.setSelection([id])
  const ids = [id, ...(n.spec?.targets ?? []).filter((t) => ed.nodes.get(t)?.pageId === n.pageId)]
  // the tab has just been shown: let the canvas take its size first
  setTimeout(() => ed.zoomToRect(unionRects(ids.map((i) => ed.world(i))), 1), 80)
}

let installed = false
/** call once the document is loaded */
export function initSpecBoard(): void {
  last = ''
  send()
  if (installed) return
  installed = true
  ed.subscribe('doc', schedule)
  ed.subscribe('pages', schedule)
  backend.specs.onFocus(focusSpec)
  // going to the background: do not leave the last change waiting on a slowed-down timer
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return
    clearTimeout(timer)
    send()
  })
}
