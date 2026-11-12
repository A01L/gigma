// Layer actions shared by the context menu and keyboard shortcuts (Figma-compatible behaviour).
import type { Effect, GNode, Paint, Stroke } from '@shared/types'
import { editor as ed } from '../editor/editor'
import { copySelection, copyAsPng, handlePaste } from '../editor/clipboard'
import { alignNodes } from '../editor/commands'
import { isAutoLayout } from '../editor/autolayout'
import { t } from './i18n'

const sel = () => ed.selection.map((id) => ed.nodes.get(id)).filter(Boolean) as GNode[]

export const layerActions = {
  copy: () => void copySelection(false),
  cut: () => void copySelection(true),
  copyPng: () => void copyAsPng().then(() => ed.showToast(t('Copied as PNG'))),
  /** paste from the system clipboard (used by the context menu, where there is no paste event) */
  async paste() {
    try {
      const items = await navigator.clipboard.read()
      let text = ''
      let html = ''
      const files: File[] = []
      for (const it of items) {
        if (it.types.includes('text/html')) html = await (await it.getType('text/html')).text()
        if (it.types.includes('text/plain')) text = await (await it.getType('text/plain')).text()
        const img = it.types.find((x) => x.startsWith('image/'))
        if (img) files.push(new File([await it.getType(img)], 'Image', { type: img }))
      }
      const fake = { clipboardData: { getData: (k: string) => (k === 'text/html' ? html : k === 'text/plain' ? text : ''), files }, preventDefault() {} }
      await handlePaste(fake as unknown as ClipboardEvent)
    } catch (e) {
      ed.showToast(t('Could not read the clipboard') + ': ' + (e as Error).message)
    }
  },
  duplicate: () => void ed.duplicate(ed.selection, 10),
  delete: () => ed.deleteSelection(),
  group: () => void ed.group(),
  ungroup: () => ed.ungroup(),
  /** Ctrl+Alt+G: wrap the selection in a frame */
  frameSelection() {
    // one transaction, so a single undo removes the frame
    ed.act(() => {
      const id = ed.group(ed.selection, 'Frame')
      if (id) ed.updateNode(id, { type: 'FRAME', clipsContent: false })
    })
  },
  /** Shift+A: turn the selected frame into an auto layout frame, or wrap the selection in one */
  addAutoLayout() {
    const n = sel()
    if (!n.length) return
    if (n.length === 1 && isAutoLayout(n[0])) return
    ed.act(() => {
      let fid: string | null
      let pad = 0
      const own = n.length === 1 && n[0].type === 'FRAME'
      if (own) fid = n[0].id
      else {
        fid = ed.group(ed.selection, 'Frame')
        if (!fid) return
        ed.updateNode(fid, { type: 'FRAME', clipsContent: false })
        // a single layer becomes a "button": padding around it
        if (n.length === 1) pad = 10
      }
      const f = ed.nodes.get(fid!)!
      const kids = ed.children(f.id, f.pageId).map((id) => ed.nodes.get(id)!).filter((k) => k.visible)
      // direction: the axis the layers are spread along
      const span = (a: 'x' | 'y') => (kids.length ? Math.max(...kids.map((k) => k[a])) - Math.min(...kids.map((k) => k[a])) : 0)
      const horiz = kids.length > 1 ? span('x') >= span('y') : true
      const pos = (k: GNode) => (horiz ? k.x : k.y)
      const size = (k: GNode) => (horiz ? k.width : k.height)
      const sorted = [...kids].sort((a, b) => pos(a) - pos(b))
      // layout order follows the position on the canvas
      const keys = kids.map((k) => k.order)
      sorted.forEach((k, i) => k.order !== keys[i] && ed.updateNode(k.id, { order: keys[i] }))
      let gap = 10
      if (sorted.length > 1) {
        let sum = 0
        for (let i = 1; i < sorted.length; i++) sum += pos(sorted[i]) - pos(sorted[i - 1]) - size(sorted[i - 1])
        gap = Math.max(0, Math.round(sum / (sorted.length - 1)))
      }
      const patch: Partial<GNode> = { layoutMode: horiz ? 'HORIZONTAL' : 'VERTICAL', itemSpacing: gap, primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'AUTO', primaryAxisAlignItems: 'MIN', counterAxisAlignItems: 'MIN' }
      if (own && kids.length) {
        // keep the look: padding = distance from the frame edges to the content
        const r = Math.max(...kids.map((k) => k.x + k.width))
        const b = Math.max(...kids.map((k) => k.y + k.height))
        Object.assign(patch, {
          paddingLeft: Math.max(0, Math.round(Math.min(...kids.map((k) => k.x)))),
          paddingTop: Math.max(0, Math.round(Math.min(...kids.map((k) => k.y)))),
          paddingRight: Math.max(0, Math.round(f.width - r)),
          paddingBottom: Math.max(0, Math.round(f.height - b))
        })
      } else Object.assign(patch, { paddingLeft: pad, paddingRight: pad, paddingTop: pad, paddingBottom: pad, x: f.x - pad, y: f.y - pad })
      ed.updateNode(f.id, patch)
      ed.selection = [f.id]
    })
    ed.emit('selection')
  },
  /** Alt+Shift+A: back to a plain frame (children keep their places) */
  removeAutoLayout() {
    ed.act(() => sel().forEach((n) => isAutoLayout(n) && ed.updateNode(n.id, { layoutMode: undefined })))
  },
  front: () => ed.reorder(Infinity),
  back: () => ed.reorder(-Infinity),
  forward: () => ed.reorder(1),
  backward: () => ed.reorder(-1),
  toggleVisible() {
    const n = sel()
    const v = !n.every((x) => x.visible)
    ed.act(() => n.forEach((x) => ed.updateNode(x.id, { visible: v })))
  },
  toggleLock() {
    const n = sel()
    const v = !n.every((x) => x.locked)
    ed.act(() => n.forEach((x) => ed.updateNode(x.id, { locked: v })))
  },
  toggleMask() {
    const n = sel()
    const v = !n.every((x) => x.isMask)
    ed.act(() => n.forEach((x) => ed.updateNode(x.id, { isMask: v || undefined })))
  },
  flipH: () => ed.act(() => sel().forEach((x) => ed.updateNode(x.id, { flipX: !x.flipX || undefined }))),
  flipV: () => ed.act(() => sel().forEach((x) => ed.updateNode(x.id, { flipY: !x.flipY || undefined }))),
  setOpacity: (v: number) => ed.act(() => sel().forEach((x) => ed.updateNode(x.id, { opacity: v }))),
  align: (how: string) => alignNodes(ed.roots(ed.selection), how),
  zoomToSelection: () => ed.zoomToRect(ed.selectionBounds(), 8),
  /** Tab / Shift+Tab: next / previous sibling */
  cycleSibling(dir: 1 | -1) {
    const cur = ed.selection[0] ? ed.nodes.get(ed.selection[0]) : null
    const list = ed.children(cur?.parentId ?? null).filter((id) => ed.nodes.get(id)!.type !== 'ANNOTATION')
    if (!list.length) return
    const i = cur ? list.indexOf(cur.id) : -1
    // layers panel order is top-first, so "next" goes down the z-order
    ed.setSelection([list[(i - dir + list.length) % list.length]])
  },
  selectParent() {
    const cur = ed.selection[0] ? ed.nodes.get(ed.selection[0]) : null
    if (cur?.parentId) ed.setSelection([cur.parentId])
  },
  selectChildren() {
    const kids = ed.selection.flatMap((id) => ed.children(id))
    if (kids.length) ed.setSelection(kids)
  },
  rename() {
    window.dispatchEvent(new CustomEvent('gigma-rename', { detail: ed.selection[0] }))
  }
}

// ---------- copy / paste properties (Ctrl+Alt+C / Ctrl+Alt+V) ----------
let props: { fills: Paint[]; strokes: Stroke[]; effects?: Effect[]; opacity: number; cornerRadius?: number; cornerRadii?: GNode['cornerRadii']; textStyle?: GNode['textStyle'] } | null = null
export function copyProperties(): void {
  const n = sel()[0]
  if (!n) return
  props = structuredClone({ fills: n.fills, strokes: n.strokes, effects: n.effects, opacity: n.opacity, cornerRadius: n.cornerRadius, cornerRadii: n.cornerRadii, textStyle: n.textStyle })
  ed.showToast(t('Properties copied'))
}
export function pasteProperties(): void {
  if (!props) return
  const p = props
  ed.act(() =>
    sel().forEach((n) =>
      ed.updateNode(n.id, {
        fills: structuredClone(p.fills),
        strokes: structuredClone(p.strokes),
        effects: structuredClone(p.effects),
        opacity: p.opacity,
        cornerRadius: p.cornerRadius,
        cornerRadii: p.cornerRadii,
        ...(n.type === 'TEXT' && p.textStyle ? { textStyle: structuredClone(p.textStyle) } : {})
      })
    )
  )
}

/**
 * Figma shortcuts that are not tied to tools. Returns true when the key was handled.
 * (Ctrl = Cmd on macOS.)
 */
export function handleLayerShortcut(e: KeyboardEvent): boolean {
  const mod = e.ctrlKey || e.metaKey
  const k = e.key.toLowerCase()
  const code = e.code
  const has = ed.selection.length > 0
  const done = (fn: () => void) => {
    e.preventDefault()
    fn()
    return true
  }
  if (mod && e.shiftKey && code === 'KeyH' && has) return done(layerActions.toggleVisible)
  if (mod && e.shiftKey && code === 'KeyL' && has) return done(layerActions.toggleLock)
  if (mod && e.altKey && code === 'KeyG' && has) return done(layerActions.frameSelection)
  if (mod && e.altKey && code === 'KeyM' && has) return done(layerActions.toggleMask)
  if (mod && e.altKey && code === 'KeyC' && has) return done(copyProperties)
  if (mod && e.altKey && code === 'KeyV' && has) return done(pasteProperties)
  if (mod && code === 'KeyR' && !e.shiftKey && !e.altKey && has) return done(layerActions.rename)
  if (!mod && e.shiftKey && !e.altKey && code === 'KeyH' && has) return done(layerActions.flipH)
  if (!mod && e.shiftKey && !e.altKey && code === 'KeyV' && has) return done(layerActions.flipV)
  if (!mod && e.shiftKey && code === 'Digit2' && has) return done(layerActions.zoomToSelection)
  if (!mod && e.shiftKey && code === 'KeyA' && has) return done(e.altKey ? layerActions.removeAutoLayout : layerActions.addAutoLayout)
  // Alt + A/D/W/S/H/V: align
  if (e.altKey && !mod && has) {
    const map: Record<string, string> = { KeyA: 'left', KeyD: 'right', KeyW: 'top', KeyS: 'bottom', KeyH: 'center', KeyV: 'middle' }
    if (map[code]) return done(() => layerActions.align(map[code]))
  }
  if (!mod && !e.altKey && k === 'tab') return done(() => layerActions.cycleSibling(e.shiftKey ? -1 : 1))
  if (!mod && e.shiftKey && k === 'enter' && has) return done(layerActions.selectParent)
  // digits set opacity: 1 = 10% … 9 = 90%, 0 = 100%
  if (!mod && !e.shiftKey && !e.altKey && has && /^Digit\d$/.test(code)) {
    const d = +code.slice(5)
    return done(() => layerActions.setOpacity(d === 0 ? 1 : d / 10))
  }
  return false
}
