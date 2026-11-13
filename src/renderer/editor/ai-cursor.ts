// The cursor of an AI client working over MCP. It does not travel across the canvas: it jumps to the
// layer the AI has just created or changed, glows while the work goes on, shows who it is on hover,
// and pops when the calls stop.
import { editor as ed } from './editor'
import { ARROW_PATH } from './canvas'

/** no call for this long = the AI has finished (clients think for a while between calls) */
const IDLE_MS = 12_000
const POP_MS = 420
/** commands that only look at the document: they keep the cursor alive but do not move it */
const READS = /^(get_|list_|find_|export_|zoom_to|set_selection|set_current_page|switch_tab)/

interface Cursor {
  el: HTMLDivElement
  /** layer it points at; when that layer is gone the cursor stays where it was */
  nodeId: string | null
  at: { x: number; y: number }
  timer: number
}

const cursors = new Map<string, Cursor>()
let raf = 0

const wrap = () => document.querySelector<HTMLElement>('.canvas-wrap')

function make(client: string): Cursor | null {
  const host = wrap()
  if (!host) return null
  const el = document.createElement('div')
  el.className = 'ai-cursor'
  el.innerHTML =
    `<span class="ai-cursor-glow"></span><span class="ai-cursor-ring"></span>` +
    `<svg class="ai-cursor-arrow" width="24" height="24" viewBox="0 0 24 24"><path d="${ARROW_PATH}" fill="#0c8ce9" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>` +
    `<span class="ai-cursor-name"></span>`
  el.querySelector('.ai-cursor-name')!.textContent = client
  host.appendChild(el)
  return { el, nodeId: null, at: { x: 0, y: 0 }, timer: 0 }
}

/** where the tip goes: the bottom right corner of the layer, so the layer itself stays visible */
function place(c: Cursor): void {
  const host = wrap()
  if (!host) return
  if (c.nodeId && ed.nodes.has(c.nodeId)) {
    const w = ed.world(c.nodeId)
    c.at = { x: w.x + w.w, y: w.y + w.h }
  }
  const { zoom, x, y } = ed.camera
  // a little inside the corner; kept in view when the layer is larger than the window
  const sx = Math.max(8, Math.min(host.clientWidth - 28, c.at.x * zoom + x - 6))
  const sy = Math.max(8, Math.min(host.clientHeight - 28, c.at.y * zoom + y - 6))
  c.el.style.transform = `translate(${Math.round(sx - 4)}px, ${Math.round(sy - 3)}px)`
}

function loop(): void {
  raf = 0
  if (!cursors.size) return
  for (const c of cursors.values()) place(c)
  raf = requestAnimationFrame(loop)
}

function pop(client: string): void {
  const c = cursors.get(client)
  if (!c) return
  cursors.delete(client)
  c.el.classList.add('pop')
  setTimeout(() => c.el.remove(), POP_MS)
}

/** the first layer a command result or its arguments speak about */
function targetOf(args: Record<string, unknown>, result: unknown): string | null {
  const ids: unknown[] = []
  const take = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(take)
    else if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') ids.push((v as { id: string }).id)
  }
  take(result)
  ids.push(args.id, ...(Array.isArray(args.ids) ? args.ids : []), args.specId, args.parentId)
  for (const id of ids) if (typeof id === 'string' && ed.nodes.get(id)?.pageId === ed.currentPageId) return id
  return null
}

export const aiCursor = {
  /** called after every command an AI client ran */
  touch(client: string, command: string, args: Record<string, unknown>, result: unknown): void {
    let c = cursors.get(client)
    const target = READS.test(command) ? null : targetOf(args, result)
    if (!c) {
      // reading alone does not bring a cursor: there is nothing to point at yet
      if (!target) return
      c = make(client) ?? undefined
      if (!c) return
      cursors.set(client, c)
    }
    if (target) {
      c.nodeId = target
      // restart the landing animation: the cursor appears at the new place, it does not slide there
      c.el.classList.remove('land')
      void c.el.offsetWidth
      c.el.classList.add('land')
    }
    place(c)
    clearTimeout(c.timer)
    c.timer = window.setTimeout(() => pop(client), IDLE_MS)
    if (!raf) raf = requestAnimationFrame(loop)
  },
  /** for tests */
  state: () => [...cursors].map(([client, c]) => ({ client, nodeId: c.nodeId, transform: c.el.style.transform })),
  finish: (client: string) => pop(client)
}
;(window as unknown as { aiCursor: typeof aiCursor }).aiCursor = aiCursor
