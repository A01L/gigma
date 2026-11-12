// Layer actions shared by the context menu and keyboard shortcuts (Figma-compatible behaviour).
import type { BooleanOperation, Effect, GNode, Paint, Stroke } from '@shared/types'
import { flattenPath, isBooleanGroup, strokeOutline } from '../editor/boolean'
import { keyBetween, round2 } from '../editor/util'
import { editor as ed } from '../editor/editor'
import { copySelection, copyAsPng, handlePaste } from '../editor/clipboard'
import { alignNodes } from '../editor/commands'
import { isAutoLayout } from '../editor/autolayout'
import { t } from './i18n'

const sel = () => ed.selection.map((id) => ed.nodes.get(id)).filter(Boolean) as GNode[]

export const BOOLEAN_NAMES: Record<BooleanOperation, string> = { UNION: 'Union', SUBTRACT: 'Subtract', INTERSECT: 'Intersect', EXCLUDE: 'Exclude' }

/** the layer whose fills / strokes a boolean result inherits: the layer itself, or the bottom leaf of a plain group */
function paintSource(id: string | undefined): GNode | undefined {
  let n = id ? ed.nodes.get(id) : undefined
  while (n && n.type === 'GROUP' && !n.booleanOperation) {
    const first: string | undefined = ed.children(n.id, n.pageId)[0]
    n = first ? ed.nodes.get(first) : undefined
  }
  return n
}

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
  /** Union / Subtract / Intersect / Exclude: wrap the selection in a boolean group (or change the selected one) */
  booleanOp(op: BooleanOperation) {
    const n = sel()
    if (!n.length) return
    const name = BOOLEAN_NAMES[op]
    if (n.length === 1 && isBooleanGroup(n[0])) {
      const g = n[0]
      // keep a custom name, follow the operation otherwise
      const auto = Object.values(BOOLEAN_NAMES).includes(g.name)
      ed.act(() => ed.updateNode(g.id, { booleanOperation: op, ...(auto ? { name } : {}) }))
      return
    }
    ed.act(() => {
      const id = ed.group(ed.selection, name)
      if (!id) return
      // like Figma: the result takes the look of the bottom layer
      const src = paintSource(ed.children(id)[0])
      ed.updateNode(id, {
        booleanOperation: op,
        fills: src?.fills.length ? structuredClone(src.fills) : src?.strokes.length ? [] : [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85, a: 1 } }],
        strokes: structuredClone(src?.strokes ?? []),
        effects: structuredClone(src?.effects)
      })
    })
  },
  /** Ctrl+E: replace the selection with one vector path (its outline) */
  flatten() {
    const roots = ed.roots(ed.selection).sort((a, b) => (ed.paintOrderKey(a) < ed.paintOrderKey(b) ? -1 : 1))
    if (!roots.length) return
    const res = flattenPath(ed, roots)
    if (!res) {
      ed.showToast(t('Nothing to flatten'))
      return
    }
    const top = ed.nodes.get(roots[roots.length - 1])!
    const bottom = ed.nodes.get(roots[0])!
    const src = isBooleanGroup(bottom) ? bottom : paintSource(bottom.id)
    const parentId = roots.every((id) => ed.nodes.get(id)!.parentId === top.parentId) ? top.parentId : null
    const pw = parentId ? ed.world(parentId) : { x: 0, y: 0 }
    ed.act(() => {
      const v = ed.addNode({
        type: 'VECTOR',
        name: roots.length === 1 ? top.name : 'Vector',
        parentId,
        order: parentId === top.parentId ? top.order : undefined,
        x: round2(res.x - pw.x),
        y: round2(res.y - pw.y),
        width: round2(res.w),
        height: round2(res.h),
        path: res.d,
        pathBox: { w: res.w, h: res.h },
        fillRule: res.fillRule,
        fills: src?.fills.length ? structuredClone(src.fills) : src?.strokes.length ? [] : [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85, a: 1 } }],
        strokes: structuredClone(src?.strokes ?? []),
        effects: structuredClone(src?.effects),
        opacity: roots.length === 1 ? top.opacity : 1
      })
      for (const id of roots) ed.deleteNode(id)
      ed.selection = [v.id]
    })
    ed.emit('selection')
  },
  /** Ctrl+Alt+O: turn strokes into filled shapes */
  outlineStroke() {
    const targets = sel().filter((n) => n.strokes.some((s) => s.visible !== false && s.weight > 0))
    if (!targets.length) {
      ed.showToast(t('No stroke to outline'))
      return
    }
    const made: string[] = []
    ed.act(() => {
      for (const n of targets) {
        const res = strokeOutline(ed, n.id)
        if (!res) continue
        const stroke = n.strokes.find((s) => s.visible !== false && s.weight > 0)!
        const pw = n.parentId ? ed.world(n.parentId) : { x: 0, y: 0 }
        const sib = ed.children(n.parentId, n.pageId)
        const i = sib.indexOf(n.id)
        const hasFill = n.fills.some((f) => f.visible !== false) && n.type !== 'FRAME'
        const v = ed.addNode({
          type: 'VECTOR',
          name: hasFill || n.type === 'FRAME' ? n.name + ' stroke' : n.name,
          parentId: n.parentId,
          pageId: n.pageId,
          // right above the layer it came from
          order: keyBetween(n.order, i + 1 < sib.length ? ed.nodes.get(sib[i + 1])!.order : null),
          x: round2(res.x - pw.x),
          y: round2(res.y - pw.y),
          width: round2(res.w),
          height: round2(res.h),
          path: res.d,
          pathBox: { w: res.w, h: res.h },
          fillRule: res.fillRule,
          fills: [{ type: 'SOLID', color: { ...stroke.color } }],
          opacity: n.opacity
        })
        made.push(v.id)
        // the fill (or the frame with its content) stays as its own layer, as in Figma
        if (hasFill || n.type === 'FRAME' || n.type === 'GROUP') ed.updateNode(n.id, { strokes: [] })
        else ed.deleteNode(n.id)
      }
      if (made.length) ed.selection = made
    })
    ed.emit('selection')
    if (!made.length) ed.showToast(t('No stroke to outline'))
  },
  /** Ctrl+Alt+K: make a main component from the selection */
  createComponent() {
    const n = sel()
    if (!n.length) return
    if (n.some((x) => ed.instanceOf(x.id) || ed.mainComponentOf(x.id))) {
      ed.showToast(t('Already part of a component'))
      return
    }
    ed.act(() => {
      let id: string | null
      if (n.length === 1 && n[0].type === 'FRAME') id = n[0].id
      else {
        id = ed.group(ed.selection, n.length === 1 ? n[0].name : 'Component')
        if (id) ed.updateNode(id, { type: 'FRAME', clipsContent: false })
      }
      if (!id) return
      ed.updateNode(id, { isComponent: true })
      ed.selection = [id]
    })
    ed.emit('selection')
  },
  /** Ctrl+Alt+B: instance -> plain frame */
  detachInstance: () => ed.detachInstance(),
  goToMainComponent() {
    const inst = ed.instanceOf(ed.selection[0])
    const main = inst?.componentId ? ed.nodes.get(inst.componentId) : undefined
    if (!main) {
      ed.showToast(t('The main component was deleted'))
      return
    }
    if (main.pageId !== ed.currentPageId) ed.setCurrentPage(main.pageId)
    ed.setSelection([main.id])
    ed.zoomToRect(ed.world(main.id), 1)
  },
  /** Ctrl+Shift+R: paste over the selection (same place, same position in the layer list) */
  async pasteReplace() {
    const targets = ed.roots(ed.selection).filter((id) => ed.nodes.has(id))
    if (!targets.length) return void layerActions.paste()
    const info = targets.map((id) => {
      const n = ed.nodes.get(id)!
      const w = ed.world(id)
      return { id, parentId: n.parentId, order: n.order, cx: w.x + w.w / 2, cy: w.y + w.h / 2 }
    })
    ed.begin()
    try {
      const before = new Set(ed.nodes.keys())
      // nothing selected while pasting: the layers land on the page, not inside the layer being replaced
      ed.selection = []
      await layerActions.paste()
      const pasted = ed.roots(ed.selection).filter((id) => !before.has(id))
      if (!pasted.length) return
      const out: string[] = []
      info.forEach((tgt, k) => {
        // the first target takes the pasted layers, the others get copies
        const ids = k === 0 ? pasted : pasted.map((id) => ed.cloneSubtree(id, null, ed.currentPageId))
        const b = ed.selectionBounds(ids)!
        const dx = tgt.cx - (b.x + b.w / 2)
        const dy = tgt.cy - (b.y + b.h / 2)
        let order = tgt.order
        ed.deleteNode(tgt.id)
        const sib = ed.children(tgt.parentId)
        const next = sib.map((s) => ed.nodes.get(s)!.order).find((o) => o > tgt.order) ?? null
        for (const id of ids) {
          ed.moveBy(id, dx, dy)
          ed.reparent(id, tgt.parentId, order)
          order = keyBetween(order, next)
          out.push(id)
        }
      })
      ed.selection = out
    } finally {
      ed.commit()
      ed.emit('selection')
    }
  },
  /** move the selection to another page (same coordinates) */
  moveToPage(pageId: string) {
    const roots = ed.roots(ed.selection)
    if (!roots.length || pageId === ed.currentPageId) return
    ed.act(() => {
      for (const id of roots) {
        const w = ed.world(id)
        ed.updateNode(id, { parentId: null, pageId, x: w.x, y: w.y, order: ed.orderKeyAtTop(null, pageId) })
      }
      ed.selection = []
    })
    ed.emit('selection')
    ed.showToast(t('Moved to page') + ' “' + (ed.pages.get(pageId)?.name ?? '') + '”')
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
  if (mod && e.altKey && code === 'KeyO' && has) return done(layerActions.outlineStroke)
  if (mod && e.altKey && code === 'KeyK' && has) return done(layerActions.createComponent)
  if (mod && e.altKey && code === 'KeyB' && has) return done(layerActions.detachInstance)
  if (mod && e.shiftKey && !e.altKey && code === 'KeyR') return done(() => void layerActions.pasteReplace())
  // ] and [ alone: bring to front / send to back
  if (!mod && !e.altKey && !e.shiftKey && has && (code === 'BracketRight' || code === 'BracketLeft')) return done(code === 'BracketRight' ? layerActions.front : layerActions.back)
  if (mod && e.altKey && code === 'KeyC' && has) return done(copyProperties)
  if (mod && e.altKey && code === 'KeyV' && has) return done(pasteProperties)
  if (mod && code === 'KeyR' && !e.shiftKey && !e.altKey && has) return done(layerActions.rename)
  if (!mod && e.shiftKey && !e.altKey && code === 'KeyH' && has) return done(layerActions.flipH)
  if (!mod && e.shiftKey && !e.altKey && code === 'KeyV' && has) return done(layerActions.flipV)
  if (!mod && e.shiftKey && code === 'Digit2' && has) return done(layerActions.zoomToSelection)
  if (!mod && e.shiftKey && code === 'KeyA' && has) return done(e.altKey ? layerActions.removeAutoLayout : layerActions.addAutoLayout)
  // Alt+Shift+U / S / I / E: boolean operations; Ctrl+E: flatten
  if (!mod && e.altKey && e.shiftKey && has) {
    const ops: Record<string, BooleanOperation> = { KeyU: 'UNION', KeyS: 'SUBTRACT', KeyI: 'INTERSECT', KeyE: 'EXCLUDE' }
    if (ops[code]) return done(() => layerActions.booleanOp(ops[code]))
    if (code === 'KeyF') return done(layerActions.flatten)
  }
  if (mod && !e.shiftKey && !e.altKey && code === 'KeyE' && has) return done(layerActions.flatten)
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
