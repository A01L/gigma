// Canvas controller: render loop + pointer interactions (select, move, resize, create,
// marquee, pan/zoom, snapping) for the main editor canvas. Plain TS, no React, so input
// handling never waits for UI re-renders.
import type { GNode } from '@shared/types'
import { rgbaToCss } from '@shared/types'
import { editor as ed } from './editor'
import { drawScene, setImageLoadedCallback } from './render'
import { rectsIntersect, round2, unionRects, type Rect } from './util'
import { polygonPath, smoothPath, starPath } from './shapes'
import { parsePath, segsBounds, segsToD, transformSegs, type Seg } from './svgpath'
import { DEFAULT_CODE, setCodeReadyCallback } from './code-render'

const BLUE = '#0d99ff'
const HANDLE = 7

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
const CURSORS: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' }

type Drag =
  | { kind: 'pan'; sx: number; sy: number }
  | { kind: 'move'; sx: number; sy: number; ids: string[]; orig: Map<string, Rect>; box: Rect; moved: boolean; dup: boolean }
  | { kind: 'resize'; handle: Handle; box: Rect; ids: string[]; orig: Map<string, Rect>; snap?: Map<string, GNode> }
  | { kind: 'marquee'; sx: number; sy: number; x: number; y: number; base: string[]; scope: string | null }
  | { kind: 'create'; type: GNode['type']; wx: number; wy: number; id: string | null; parent: string | null; tool: string }
  | { kind: 'pencil'; pts: [number, number][]; parent: string | null }
  | { kind: 'pen-handle'; index: number }

interface PenPoint {
  x: number
  y: number
  /** outgoing handle (incoming is mirrored) */
  hx?: number
  hy?: number
}

interface Guide {
  axis: 'x' | 'y'
  pos: number
  from: number
  to: number
}

export class CanvasController {
  private ctx: CanvasRenderingContext2D
  private dpr = window.devicePixelRatio || 1
  private raf = 0
  private drag: Drag | null = null
  private spaceDown = false
  private guides: Guide[] = []
  private frameLabels: { id: string; r: Rect }[] = []
  private annotationPins: { id: string; r: Rect }[] = []
  /** frame/section highlighted as the drop target while dragging */
  private dropTarget: string | null = null
  private disposers: (() => void)[] = []
  /** Pen tool: points of the path being drawn (world coordinates) */
  private pen: { pts: PenPoint[]; parent: string | null; hover: { x: number; y: number } | null } | null = null
  onEditText: (id: string) => void = () => {}
  onEditAnnotation: (id: string) => void = () => {}

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!
    const ro = new ResizeObserver(() => this.resize())
    ro.observe(canvas)
    this.disposers.push(() => ro.disconnect())
    for (const t of ['doc', 'selection', 'camera', 'ui', 'pages'] as const) this.disposers.push(ed.subscribe(t, () => this.invalidate()))
    setImageLoadedCallback(() => this.invalidate())
    setCodeReadyCallback(() => this.invalidate())

    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, ev: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(ev, fn as EventListener, opts)
      this.disposers.push(() => el.removeEventListener(ev, fn as EventListener, opts))
    }
    on(canvas, 'pointerdown', (e) => this.down(e))
    on(canvas, 'pointermove', (e) => this.move(e))
    on(canvas, 'pointerup', (e) => this.up(e))
    on(canvas, 'dblclick', (e) => this.dbl(e))
    on(canvas, 'wheel', (e) => this.wheel(e), { passive: false })
    on(window, 'keydown', (e) => {
      // finish the pen path with Enter / Escape (Escape on the first point cancels)
      if (this.pen && (e.key === 'Enter' || e.key === 'Escape') && !isTyping()) {
        e.preventDefault()
        e.stopImmediatePropagation()
        this.finishPen(false)
        return
      }
      if (e.code === 'Space' && !isTyping()) {
        this.spaceDown = true
        canvas.style.cursor = 'grab'
      }
    })
    on(window, 'keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false
        this.updateCursor()
      }
    })
    this.resize()
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    this.disposers.forEach((d) => d())
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect()
    this.dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr))
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr))
    ed.viewport = { w: r.width, h: r.height }
    this.invalidate()
  }

  invalidate(): void {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.draw()
    })
  }

  // ------------------------------------------------------------------ drawing
  private draw(): void {
    const { ctx, dpr } = this
    const page = ed.pages.get(ed.currentPageId)
    if (!page) return
    const { zoom, x: cx, y: cy } = ed.camera
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = rgbaToCss(page.background)
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)

    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * cx, dpr * cy)
    ctx.imageSmoothingQuality = zoom < 1 ? 'medium' : 'high'
    const view = ed.visibleWorldRect()
    const visible = new Set(ed.query(view))
    drawScene(ctx, ed, { view, zoom: zoom * dpr, visible })

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.drawOverlay(view)
  }

  private toScreen(r: Rect): Rect {
    const { zoom, x, y } = ed.camera
    return { x: r.x * zoom + x, y: r.y * zoom + y, w: r.w * zoom, h: r.h * zoom }
  }

  private drawOverlay(view: Rect): void {
    const ctx = this.ctx
    // frame labels for top-level frames
    this.frameLabels = []
    ctx.font = '11px Inter, "Segoe UI", system-ui, sans-serif'
    ctx.textBaseline = 'bottom'
    // top-level frames + frames directly inside sections get a name label; sections get a pill inside
    const labelled: string[] = []
    for (const id of ed.children(null)) {
      const n = ed.nodes.get(id)!
      labelled.push(id)
      if (n.type === 'SECTION') for (const c of ed.children(id)) labelled.push(c)
    }
    for (const id of labelled) {
      const n = ed.nodes.get(id)!
      if ((n.type !== 'FRAME' && n.type !== 'SECTION') || !n.visible) continue
      const w = ed.world(id)
      if (!rectsIntersect(w, view)) continue
      const s = this.toScreen(w)
      const sel = ed.selection.includes(id)
      let label = n.name
      if (n.type === 'SECTION') {
        ctx.font = '600 12px Inter, "Segoe UI", system-ui, sans-serif'
        const maxW = Math.max(s.w - 24, 20)
        while (label.length > 1 && ctx.measureText(label).width > maxW) label = label.slice(0, -2) + '…'
        const lw = ctx.measureText(label).width + 16
        ctx.fillStyle = sel ? BLUE : 'rgba(255,255,255,0.9)'
        ctx.beginPath()
        ctx.roundRect(s.x + 8, s.y + 8, lw, 22, 6)
        ctx.fill()
        ctx.fillStyle = sel ? '#fff' : '#1e1e1e'
        ctx.textBaseline = 'middle'
        ctx.fillText(label, s.x + 16, s.y + 19)
        ctx.textBaseline = 'bottom'
        ctx.font = '11px Inter, "Segoe UI", system-ui, sans-serif'
        this.frameLabels.push({ id, r: { x: s.x + 8, y: s.y + 8, w: lw, h: 22 } })
        continue
      }
      ctx.fillStyle = sel ? BLUE : '#8a8a8a'
      const maxW = Math.max(s.w, 20)
      while (label.length > 1 && ctx.measureText(label).width > maxW) label = label.slice(0, -2) + '…'
      ctx.fillText(label, s.x, s.y - 4)
      this.frameLabels.push({ id, r: { x: s.x, y: s.y - 18, w: Math.min(ctx.measureText(label).width, maxW), h: 16 } })
    }

    // slices: dashed export areas
    ctx.save()
    ctx.setLineDash([4, 3])
    ctx.lineWidth = 1
    for (const id of ed.query(view)) {
      const n = ed.nodes.get(id)
      if (n?.type !== 'SLICE' || !n.visible) continue
      const s = this.toScreen(ed.world(id))
      ctx.strokeStyle = ed.selection.includes(id) ? BLUE : 'rgba(255,255,255,0.55)'
      ctx.strokeRect(Math.round(s.x) + 0.5, Math.round(s.y) + 0.5, Math.round(s.w), Math.round(s.h))
    }
    ctx.restore()

    // annotations: pins in screen space (always readable at any zoom)
    this.annotationPins = []
    for (const n of ed.nodes.values()) {
      if (n.type !== 'ANNOTATION' || n.pageId !== ed.currentPageId || !n.visible || n.resolved) continue
      const w = ed.world(n.id)
      const s = this.toScreen(w)
      if (s.x < -40 || s.y < -40 || s.x > ed.viewport.w + 40 || s.y > ed.viewport.h + 40) continue
      const sel = ed.selection.includes(n.id)
      // speech bubble with a pointed bottom-left corner at the anchor
      ctx.save()
      ctx.translate(s.x, s.y)
      ctx.fillStyle = sel ? '#0a7fd8' : BLUE
      ctx.shadowColor = 'rgba(0,0,0,0.3)'
      ctx.shadowBlur = 6
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(0, -14)
      ctx.arc(14, -14, 14, Math.PI, Math.PI * 1.5 + Math.PI / 2, false)
      ctx.arc(14, -14, 14, 0, Math.PI / 2, false)
      ctx.closePath()
      ctx.fill()
      ctx.shadowColor = 'transparent'
      ctx.fillStyle = '#fff'
      ctx.font = '700 11px Inter, "Segoe UI", sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(this.annotationPins.length + 1), 14, -14)
      ctx.restore()
      this.annotationPins.push({ id: n.id, r: { x: s.x, y: s.y - 28, w: 28, h: 28 } })
    }

    // pen tool: path in progress + rubber band to the cursor
    if (this.pen && this.pen.pts.length) {
      const segs = this.penSegs(false)
      const h = this.pen.hover
      const last = this.pen.pts[this.pen.pts.length - 1]
      if (h && !this.drag) segs.push(last.hx || last.hy ? { c: 'C', p: [last.x + (last.hx ?? 0), last.y + (last.hy ?? 0), h.x, h.y, h.x, h.y] } : { c: 'L', p: [h.x, h.y] })
      const { zoom, x: cx, y: cy } = ed.camera
      ctx.save()
      ctx.strokeStyle = BLUE
      ctx.lineWidth = 1.5
      ctx.stroke(new Path2D(segsToD(transformSegs(segs, [zoom, 0, 0, zoom, cx, cy]))))
      for (const [i, pt] of this.pen.pts.entries()) {
        const s = this.toScreen({ x: pt.x, y: pt.y, w: 0, h: 0 })
        if (pt.hx || pt.hy) {
          const a = this.toScreen({ x: pt.x + (pt.hx ?? 0), y: pt.y + (pt.hy ?? 0), w: 0, h: 0 })
          const b = this.toScreen({ x: pt.x - (pt.hx ?? 0), y: pt.y - (pt.hy ?? 0), w: 0, h: 0 })
          ctx.beginPath()
          ctx.moveTo(b.x, b.y)
          ctx.lineTo(a.x, a.y)
          ctx.stroke()
          for (const q of [a, b]) {
            ctx.beginPath()
            ctx.arc(q.x, q.y, 3, 0, Math.PI * 2)
            ctx.fillStyle = BLUE
            ctx.fill()
          }
        }
        ctx.fillStyle = i === 0 ? BLUE : '#fff'
        ctx.fillRect(s.x - 4, s.y - 4, 8, 8)
        ctx.strokeRect(s.x - 4 + 0.5, s.y - 4 + 0.5, 7, 7)
      }
      ctx.restore()
    }

    // pencil stroke in progress
    if (this.drag?.kind === 'pencil' && this.drag.pts.length > 1) {
      ctx.save()
      ctx.strokeStyle = '#000'
      ctx.lineWidth = Math.max(1, 2 * ed.camera.zoom)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      for (const [i, [x, y]] of this.drag.pts.entries()) {
        const s = this.toScreen({ x, y, w: 0, h: 0 })
        if (i) ctx.lineTo(s.x, s.y)
        else ctx.moveTo(s.x, s.y)
      }
      ctx.stroke()
      ctx.restore()
    }

    // hover
    if (ed.hoverId && !ed.selection.includes(ed.hoverId) && ed.nodes.has(ed.hoverId) && !this.drag) {
      const s = this.toScreen(ed.world(ed.hoverId))
      ctx.strokeStyle = BLUE
      ctx.lineWidth = 1.5
      ctx.strokeRect(s.x, s.y, s.w, s.h)
    }

    // drop target while dragging layers between frames
    if (this.drag?.kind === 'move' && this.drag.moved && this.dropTarget && ed.nodes.has(this.dropTarget)) {
      const s = this.toScreen(ed.world(this.dropTarget))
      ctx.strokeStyle = BLUE
      ctx.lineWidth = 2
      ctx.strokeRect(s.x, s.y, s.w, s.h)
    }

    // selection
    const sel = ed.selection.filter((id) => ed.nodes.has(id) && ed.nodes.get(id)!.pageId === ed.currentPageId)
    if (sel.length && ed.editingTextId === null) {
      ctx.strokeStyle = BLUE
      ctx.lineWidth = 1
      if (sel.length > 1)
        for (const id of sel) {
          const s = this.toScreen(ed.world(id))
          ctx.strokeRect(Math.round(s.x) + 0.5, Math.round(s.y) + 0.5, Math.round(s.w), Math.round(s.h))
        }
      const b = this.toScreen(ed.selectionBounds(sel)!)
      ctx.lineWidth = 1.5
      // a single rotated layer shows its outline rotated with it
      const single = sel.length === 1 ? ed.nodes.get(sel[0])! : null
      const rotated = !!single?.rotation
      ctx.save()
      if (rotated) {
        ctx.translate(b.x + b.w / 2, b.y + b.h / 2)
        ctx.rotate((-single!.rotation! * Math.PI) / 180)
        ctx.translate(-(b.x + b.w / 2), -(b.y + b.h / 2))
      }
      ctx.strokeRect(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5, Math.round(b.w), Math.round(b.h))
      if (!(this.drag?.kind === 'move' && this.drag.moved)) {
        for (const [, hx, hy] of this.handles(b)) {
          ctx.fillStyle = '#fff'
          ctx.fillRect(hx - HANDLE / 2, hy - HANDLE / 2, HANDLE, HANDLE)
          ctx.strokeRect(hx - HANDLE / 2 + 0.5, hy - HANDLE / 2 + 0.5, HANDLE - 1, HANDLE - 1)
        }
      }
      ctx.restore()
      // size pill
      const wb = ed.selectionBounds(sel)!
      const text = `${round2(wb.w)} × ${round2(wb.h)}`
      ctx.font = '11px Inter, "Segoe UI", system-ui, sans-serif'
      const tw = ctx.measureText(text).width + 10
      const px = b.x + b.w / 2 - tw / 2
      const py = b.y + b.h + 8
      ctx.fillStyle = BLUE
      ctx.beginPath()
      ctx.roundRect(px, py, tw, 17, 3)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'center'
      ctx.fillText(text, px + tw / 2, py + 9)
      ctx.textAlign = 'left'
    }

    // snapping guides
    if (this.guides.length) {
      ctx.strokeStyle = '#f24822'
      ctx.lineWidth = 1
      for (const g of this.guides) {
        ctx.beginPath()
        if (g.axis === 'x') {
          const a = this.toScreen({ x: g.pos, y: g.from, w: 0, h: g.to - g.from })
          ctx.moveTo(Math.round(a.x) + 0.5, a.y)
          ctx.lineTo(Math.round(a.x) + 0.5, a.y + a.h)
        } else {
          const a = this.toScreen({ x: g.from, y: g.pos, w: g.to - g.from, h: 0 })
          ctx.moveTo(a.x, Math.round(a.y) + 0.5)
          ctx.lineTo(a.x + a.w, Math.round(a.y) + 0.5)
        }
        ctx.stroke()
      }
    }

    // marquee
    if (this.drag?.kind === 'marquee') {
      const d = this.drag
      const x = Math.min(d.sx, d.x), y = Math.min(d.sy, d.y)
      ctx.fillStyle = 'rgba(13,153,255,0.08)'
      ctx.strokeStyle = BLUE
      ctx.lineWidth = 1
      ctx.fillRect(x, y, Math.abs(d.x - d.sx), Math.abs(d.y - d.sy))
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(d.x - d.sx), Math.abs(d.y - d.sy))
    }
  }

  private handles(b: Rect): [Handle, number, number][] {
    const { x, y, w, h } = b
    const list: [Handle, number, number][] = [
      ['nw', x, y],
      ['ne', x + w, y],
      ['se', x + w, y + h],
      ['sw', x, y + h]
    ]
    if (w > 30) list.push(['n', x + w / 2, y], ['s', x + w / 2, y + h])
    if (h > 30) list.push(['e', x + w, y + h / 2], ['w', x, y + h / 2])
    return list
  }

  private handleAt(sx: number, sy: number): Handle | null {
    if (!ed.selection.length) return null
    const b = this.toScreen(ed.selectionBounds()!)
    for (const [h, hx, hy] of this.handles(b)) if (Math.abs(sx - hx) <= 6 && Math.abs(sy - hy) <= 6) return h
    // edges
    const tol = 4
    const inY = sy > b.y && sy < b.y + b.h
    const inX = sx > b.x && sx < b.x + b.w
    if (inY && Math.abs(sx - b.x) < tol) return 'w'
    if (inY && Math.abs(sx - (b.x + b.w)) < tol) return 'e'
    if (inX && Math.abs(sy - b.y) < tol) return 'n'
    if (inX && Math.abs(sy - (b.y + b.h)) < tol) return 's'
    return null
  }

  // ------------------------------------------------------------------ input
  private local(e: PointerEvent | MouseEvent | WheelEvent) {
    const r = this.canvas.getBoundingClientRect()
    const sx = e.clientX - r.left
    const sy = e.clientY - r.top
    return { sx, sy, ...ed.screenToWorld(sx, sy) }
  }

  private updateCursor(e?: PointerEvent): void {
    let c = 'default'
    if (this.spaceDown || ed.tool === 'hand') c = this.drag?.kind === 'pan' ? 'grabbing' : 'grab'
    else if (ed.tool !== 'move' && ed.tool !== 'scale') c = ed.tool === 'text' ? 'text' : ed.tool === 'annotation' ? 'cell' : 'crosshair'
    else if (e) {
      const p = this.local(e)
      const h = this.handleAt(p.sx, p.sy)
      if (h) c = CURSORS[h]
    }
    this.canvas.style.cursor = c
  }

  private down(e: PointerEvent): void {
    if (ed.editingTextId) return
    try {
      this.canvas.setPointerCapture(e.pointerId)
    } catch {
      /* synthetic events (tests) have no capturable pointer */
    }
    const p = this.local(e)
    if (e.button === 1 || this.spaceDown || ed.tool === 'hand') {
      this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY }
      this.updateCursor()
      return
    }
    if (e.button !== 0) return

    if (ed.tool === 'text') {
      const parent = ed.frameAt(p.x, p.y)
      const pw = parent ? ed.world(parent) : { x: 0, y: 0 }
      const n = ed.act(() =>
        ed.addNode({ type: 'TEXT', parentId: parent, x: p.x - pw.x, y: p.y - pw.y, characters: '', fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }] })
      )
      ed.setSelection([n.id])
      ed.setTool('move')
      this.onEditText(n.id)
      return
    }
    if (ed.tool === 'annotation') {
      // click on an existing pin opens it, otherwise drop a new note
      const pin = this.annotationPins.find((a) => p.sx >= a.r.x && p.sx <= a.r.x + a.r.w && p.sy >= a.r.y && p.sy <= a.r.y + a.r.h)
      if (pin) return this.onEditAnnotation(pin.id)
      const n = ed.act(() => ed.addNode({ type: 'ANNOTATION', name: 'Annotation', x: p.x, y: p.y, width: 1, height: 1, characters: '' }))
      this.onEditAnnotation(n.id)
      return
    }
    if (ed.tool === 'pen') {
      this.penDown(p.x, p.y)
      return
    }
    if (ed.tool === 'pencil') {
      this.drag = { kind: 'pencil', pts: [[p.x, p.y]], parent: ed.frameAt(p.x, p.y) }
      return
    }
    const CREATE: Partial<Record<string, GNode['type']>> = {
      frame: 'FRAME',
      section: 'SECTION',
      slice: 'SLICE',
      rect: 'RECTANGLE',
      ellipse: 'ELLIPSE',
      line: 'VECTOR',
      arrow: 'VECTOR',
      polygon: 'VECTOR',
      star: 'VECTOR',
      spec: 'SPEC',
      code: 'CODE'
    }
    const type = CREATE[ed.tool]
    if (type) {
      // sections and slices live on the page (or in sections); others go into the frame under the cursor
      const parent = ed.tool === 'section' ? null : ed.frameAt(p.x, p.y)
      this.drag = { kind: 'create', type, wx: p.x, wy: p.y, id: null, parent, tool: ed.tool }
      ed.begin()
      return
    }

    // move tool
    const handle = this.handleAt(p.sx, p.sy)
    if (handle) {
      const ids = ed.roots(ed.selection)
      // Scale tool (K): remember the whole subtree so every property scales proportionally
      const all = ed.tool === 'scale' ? [...ids, ...ids.flatMap((id) => ed.descendants(id))] : ids
      this.drag = {
        kind: 'resize',
        handle,
        box: ed.selectionBounds(ids)!,
        ids,
        orig: new Map(all.map((id) => [id, { ...ed.world(id) }])),
        snap: ed.tool === 'scale' ? new Map(all.map((id) => [id, structuredClone(ed.nodes.get(id)!)])) : undefined
      }
      ed.begin()
      return
    }
    // annotation pins open on click with any tool
    const pin = this.annotationPins.find((a) => p.sx >= a.r.x && p.sx <= a.r.x + a.r.w && p.sy >= a.r.y && p.sy <= a.r.y + a.r.h)
    if (pin) {
      ed.setSelection([pin.id])
      this.onEditAnnotation(pin.id)
      return
    }
    const label = this.frameLabels.find((l) => p.sx >= l.r.x && p.sx <= l.r.x + l.r.w && p.sy >= l.r.y && p.sy <= l.r.y + l.r.h)
    let hit = label ? label.id : ed.hitTest(p.x, p.y, e.ctrlKey || e.metaKey)
    // clicking inside the current selection bounds keeps it (drag selection as a whole)
    const sb = ed.selectionBounds()
    if (!e.shiftKey && sb && ed.selection.length > 1 && p.x >= sb.x && p.y >= sb.y && p.x <= sb.x + sb.w && p.y <= sb.y + sb.h) hit = hit && ed.selection.includes(hit) ? hit : ed.selection[0]
    // Like Figma: pressing on the empty background of a top-level frame (or a section) that has
    // children does not grab the frame — it starts a selection marquee scoped to that frame.
    // The frame itself is picked by its name label, or dragged once it is already selected.
    let scope: string | null = null
    if (hit && !label && this.isBackground(hit) && !ed.selection.includes(hit) && !(e.ctrlKey || e.metaKey)) {
      scope = hit
      hit = null
    }
    if (!hit) {
      this.drag = { kind: 'marquee', sx: p.sx, sy: p.sy, x: p.sx, y: p.sy, base: e.shiftKey ? [...ed.selection] : [], scope }
      if (!e.shiftKey) ed.setSelection([])
      return
    }
    if (e.shiftKey) {
      ed.setSelection(ed.selection.includes(hit) ? ed.selection.filter((s) => s !== hit) : [...ed.selection, hit])
      if (!ed.selection.includes(hit)) return
    } else if (!ed.selection.includes(hit)) ed.setSelection([hit])
    const ids = ed.roots(ed.selection).filter((id) => !ed.nodes.get(id)!.locked)
    this.drag = {
      kind: 'move',
      sx: p.x,
      sy: p.y,
      ids,
      orig: new Map(ids.map((id) => [id, { ...ed.world(id) }])),
      box: ed.selectionBounds(ids)!,
      moved: false,
      dup: e.altKey
    }
  }

  // ------------------------------------------------------------------ Figma-like selection rules
  /** A top-level frame (directly on the page or in a section) or a section that has children:
   *  its background is "canvas", not a grab area. */
  private isBackground(id: string): boolean {
    const n = ed.nodes.get(id)
    if (!n || !ed.children(id).some((c) => ed.nodes.get(c)?.type !== 'ANNOTATION')) return false
    if (n.type === 'SECTION') return true
    if (n.type !== 'FRAME') return false
    const parent = n.parentId ? ed.nodes.get(n.parentId) : null
    return !parent || parent.type === 'SECTION'
  }

  /** What a click at this point selects/hovers (null = empty canvas or a frame background). */
  private pickAt(x: number, y: number, deep: boolean): string | null {
    const hit = ed.hitTest(x, y, deep)
    if (hit && !deep && this.isBackground(hit) && !ed.selection.includes(hit)) return null
    return hit
  }

  /**
   * Layers a marquee selects.
   *  - started on the canvas: top-level layers it touches; a top-level frame/section is taken whole only
   *    when fully enclosed, otherwise the marquee reaches into it and takes the children it touches
   *    (works across several frames at once);
   *  - started inside a frame (scope): the children of that frame it touches, plus the canvas rule for
   *    everything outside that frame.
   */
  private marqueeHits(r: Rect, scope: string | null): string[] {
    const ok = (id: string) => {
      const n = ed.nodes.get(id)!
      return n.visible && !n.locked && n.type !== 'ANNOTATION' && n.type !== 'SLICE'
    }
    const encloses = (w: Rect) => r.x <= w.x && r.y <= w.y && r.x + r.w >= w.x + w.w && r.y + r.h >= w.y + w.h
    const out: string[] = []
    const collect = (parentId: string | null, insideScope: boolean) => {
      for (const id of ed.children(parentId)) {
        if (!ok(id)) continue
        const w = ed.world(id)
        if (!rectsIntersect(r, w)) continue
        // reach into top-level containers unless the marquee swallows them whole;
        // the frame the marquee started in is never selected itself
        if (this.isBackground(id) && (id === scope || !encloses(w))) {
          collect(id, insideScope || id === scope)
          continue
        }
        if (id === scope) continue
        out.push(id)
      }
    }
    collect(null, false)
    return out
  }

  /** Frame/section the dragged layers would land in at this point (null = the page). */
  private dropTargetAt(x: number, y: number, ids: string[]): string | null {
    const target = ed.frameAt(x, y, new Set(ids))
    if (!target) return null
    // a layer bigger than the frame under the cursor is being moved past it, not into it
    const tw = ed.world(target)
    const b = ed.selectionBounds(ids)
    if (b && (b.w > tw.w || b.h > tw.h)) {
      // fall back to the first ancestor that is big enough
      for (const a of ed.ancestors(target)) {
        const aw = ed.world(a.id)
        if ((a.type === 'FRAME' || a.type === 'SECTION') && b.w <= aw.w && b.h <= aw.h) return a.id
      }
      return null
    }
    return target
  }

  /** Move dragged layers into the container under the cursor, keeping their place on screen. */
  private reparentDragged(ids: string[], target: string | null): void {
    for (const id of ids) {
      const n = ed.nodes.get(id)!
      const parent = n.parentId ? ed.nodes.get(n.parentId) : null
      if (parent?.type === 'GROUP') continue // layers inside groups stay in their group
      if (n.type === 'SECTION' && target && ed.nodes.get(target)?.type !== 'SECTION') continue // sections only nest in sections
      if (n.parentId !== target) ed.reparent(id, target)
    }
  }

  private move(e: PointerEvent): void {
    const p = this.local(e)
    const d = this.drag
    if (!d) {
      if (this.pen) {
        this.pen.hover = { x: p.x, y: p.y }
        this.invalidate()
      }
      if ((ed.tool === 'move' || ed.tool === 'scale') && !this.spaceDown && !ed.editingTextId) {
        const h = this.pickAt(p.x, p.y, e.ctrlKey || e.metaKey)
        if (h !== ed.hoverId) {
          ed.hoverId = h
          this.invalidate()
        }
      }
      this.updateCursor(e)
      return
    }
    switch (d.kind) {
      case 'pan':
        ed.panBy(e.clientX - d.sx, e.clientY - d.sy)
        d.sx = e.clientX
        d.sy = e.clientY
        break
      case 'marquee': {
        d.x = p.sx
        d.y = p.sy
        const a = ed.screenToWorld(Math.min(d.sx, d.x), Math.min(d.sy, d.y))
        const r = { x: a.x, y: a.y, w: Math.abs(d.x - d.sx) / ed.camera.zoom, h: Math.abs(d.y - d.sy) / ed.camera.zoom }
        ed.setSelection([...new Set([...d.base, ...this.marqueeHits(r, d.scope)])])
        this.invalidate()
        break
      }
      case 'move': {
        let dx = p.x - d.sx
        let dy = p.y - d.sy
        if (!d.moved) {
          if (Math.hypot(dx * ed.camera.zoom, dy * ed.camera.zoom) < 3) return
          d.moved = true
          ed.begin()
          if (d.dup) {
            const copies = ed.duplicate(d.ids)
            d.ids = copies
            d.orig = new Map(copies.map((id) => [id, { ...ed.world(id) }]))
          }
        }
        if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0)
        const snapped = this.snap({ ...d.box, x: d.box.x + dx, y: d.box.y + dy }, d.ids)
        dx += snapped.dx
        dy += snapped.dy
        for (const id of d.ids) {
          const o = d.orig.get(id)!
          const n = ed.nodes.get(id)!
          const pw = n.parentId ? ed.world(n.parentId) : { x: 0, y: 0 }
          ed.updateNode(id, { x: round2(o.x + dx - pw.x), y: round2(o.y + dy - pw.y) })
        }
        // live re-parenting like Figma: the layer joins the frame under the cursor while you drag,
        // so it is never hidden by the clipping of the frame it just left
        // holding Ctrl/Cmd keeps the layer in its current frame (as in Figma)
        if (e.ctrlKey || e.metaKey) this.dropTarget = null
        else {
          this.dropTarget = this.dropTargetAt(p.x, p.y, d.ids)
          this.reparentDragged(d.ids, this.dropTarget)
        }
        ed.emit('doc')
        break
      }
      case 'resize': {
        const b = d.box
        let x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h
        if (d.handle.includes('w')) x1 = p.x
        if (d.handle.includes('e')) x2 = p.x
        if (d.handle.includes('n')) y1 = p.y
        if (d.handle.includes('s')) y2 = p.y
        if (e.shiftKey && d.handle.length === 2 && b.w && b.h) {
          const ratio = b.w / b.h
          const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1)
          if (w / h > ratio) {
            const nh = w / ratio
            if (d.handle.includes('n')) y1 = y2 - nh * Math.sign(y2 - y1 || 1)
            else y2 = y1 + nh * Math.sign(y2 - y1 || 1)
          } else {
            const nw = h * ratio
            if (d.handle.includes('w')) x1 = x2 - nw * Math.sign(x2 - x1 || 1)
            else x2 = x1 + nw * Math.sign(x2 - x1 || 1)
          }
        }
        const nb = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.max(1, Math.abs(x2 - x1)), h: Math.max(1, Math.abs(y2 - y1)) }
        let sx = nb.w / (b.w || 1), sy = nb.h / (b.h || 1)
        if (d.snap) {
          // Scale tool: uniform scale of geometry AND properties (text size, strokes, radius, effects)
          const k = d.handle === 'n' || d.handle === 's' ? sy : sx
          sx = sy = Math.max(0.01, k)
          nb.w = b.w * k
          nb.h = b.h * k
          if (d.handle.includes('w')) nb.x = b.x + b.w - nb.w
          if (d.handle.includes('n')) nb.y = b.y + b.h - nb.h
          for (const [id, src] of d.snap) {
            const o = d.orig.get(id)!
            const patch: Partial<GNode> = {
              strokes: src.strokes.map((s) => ({ ...s, weight: round2(s.weight * k) })),
              cornerRadius: src.cornerRadius !== undefined ? round2(src.cornerRadius * k) : undefined,
              cornerRadii: src.cornerRadii ? (src.cornerRadii.map((v) => round2(v * k)) as [number, number, number, number]) : undefined,
              effects: src.effects?.map((e) => ('offset' in e ? { ...e, radius: e.radius * k, spread: e.spread * k, offset: { x: e.offset.x * k, y: e.offset.y * k } } : { ...e, radius: e.radius * k }))
            }
            if (src.textStyle)
              patch.textStyle = {
                ...src.textStyle,
                fontSize: round2(src.textStyle.fontSize * k),
                lineHeight: src.textStyle.lineHeight !== undefined ? round2(src.textStyle.lineHeight * k) : undefined,
                letterSpacing: src.textStyle.letterSpacing !== undefined ? src.textStyle.letterSpacing * k : undefined,
                paragraphSpacing: src.textStyle.paragraphSpacing !== undefined ? src.textStyle.paragraphSpacing * k : undefined
              }
            ed.updateNode(id, patch)
            // descendants: scale positions inside the selection box (parents first, Map keeps insertion order)
            const n = ed.nodes.get(id)!
            if (n.type !== 'GROUP')
              ed.setWorldRect(id, { x: round2(nb.x + (o.x - b.x) * k), y: round2(nb.y + (o.y - b.y) * k), w: round2(Math.max(0.01, o.w * k)), h: round2(Math.max(0.01, o.h * k)) })
          }
          ed.emit('doc')
          break
        }
        for (const id of d.ids) {
          const o = d.orig.get(id)!
          ed.setWorldRect(id, {
            x: round2(nb.x + (o.x - b.x) * sx),
            y: round2(nb.y + (o.y - b.y) * sy),
            w: round2(Math.max(1, o.w * sx)),
            h: round2(Math.max(1, o.h * sy))
          })
        }
        ed.emit('doc')
        break
      }
      case 'create': {
        let w = p.x - d.wx
        let h = p.y - d.wy
        const isLine = d.tool === 'line' || d.tool === 'arrow'
        if (e.shiftKey) {
          if (isLine) {
            // snap lines to 45° steps
            const ang = Math.round(Math.atan2(h, w) / (Math.PI / 4)) * (Math.PI / 4)
            const len = Math.hypot(w, h)
            w = Math.cos(ang) * len
            h = Math.sin(ang) * len
          } else {
            const m = Math.max(Math.abs(w), Math.abs(h))
            w = Math.sign(w || 1) * m
            h = Math.sign(h || 1) * m
          }
        }
        const r = { x: round2(Math.min(d.wx, d.wx + w)), y: round2(Math.min(d.wy, d.wy + h)), w: round2(Math.max(1, Math.abs(w))), h: round2(Math.max(1, Math.abs(h))) }
        if (!d.id) {
          if (Math.hypot(w, h) * ed.camera.zoom < 3) return
          const n = this.createShape(d, r, w, h)
          d.id = n.id
          ed.selection = [n.id]
          ed.emit('selection')
        } else if (isLine) {
          ed.updateNode(d.id, this.linePatch(d, w, h))
        } else ed.setWorldRect(d.id, r)
        ed.emit('doc')
        break
      }
      case 'pencil': {
        const last = d.pts[d.pts.length - 1]
        if (Math.hypot(p.x - last[0], p.y - last[1]) * ed.camera.zoom > 1.5) d.pts.push([p.x, p.y])
        this.invalidate()
        break
      }
      case 'pen-handle': {
        const pt = this.pen?.pts[d.index]
        if (pt) {
          pt.hx = p.x - pt.x
          pt.hy = p.y - pt.y
          this.invalidate()
        }
        break
      }
    }
  }

  // ------------------------------------------------------------------ shape tools
  /** Geometry for a line from the drag start (wx, wy) by (w, h), in the node's local box. */
  private linePatch(d: Extract<Drag, { kind: 'create' }>, w: number, h: number): Partial<GNode> {
    const bx = Math.min(d.wx, d.wx + w)
    const by = Math.min(d.wy, d.wy + h)
    const bw = Math.max(Math.abs(w), 0.01)
    const bh = Math.max(Math.abs(h), 0.01)
    const x0 = d.wx - bx
    const y0 = d.wy - by
    const pw = d.parent ? ed.world(d.parent) : { x: 0, y: 0 }
    return {
      x: round2(bx - pw.x),
      y: round2(by - pw.y),
      width: bw,
      height: bh,
      path: `M${round2(x0)} ${round2(y0)}L${round2(x0 + w)} ${round2(y0 + h)}`,
      pathBox: { w: bw, h: bh }
    }
  }

  private createShape(d: Extract<Drag, { kind: 'create' }>, r: Rect, w: number, h: number): GNode {
    const pw = d.parent ? ed.world(d.parent) : { x: 0, y: 0 }
    const box = { parentId: d.parent, x: r.x - pw.x, y: r.y - pw.y, width: r.w, height: r.h }
    const grey = { r: 0.85, g: 0.85, b: 0.85, a: 1 }
    const black = { r: 0, g: 0, b: 0, a: 1 }
    switch (d.tool) {
      case 'line':
      case 'arrow':
        return ed.addNode({
          type: 'VECTOR',
          name: d.tool === 'arrow' ? 'Arrow' : 'Line',
          ...this.linePatch(d, w, h),
          parentId: d.parent,
          fills: [],
          strokes: [{ color: black, weight: 2, align: 'CENTER' }],
          arrowEnd: d.tool === 'arrow' || undefined
        })
      case 'polygon':
        return ed.addNode({ type: 'VECTOR', name: 'Polygon', ...box, path: polygonPath(3, 100, 100), pathBox: { w: 100, h: 100 }, fills: [{ type: 'SOLID', color: grey }] })
      case 'star':
        return ed.addNode({ type: 'VECTOR', name: 'Star', ...box, path: starPath(5, 0.382, 100, 100), pathBox: { w: 100, h: 100 }, fills: [{ type: 'SOLID', color: grey }] })
      case 'section':
        return ed.addNode({ type: 'SECTION', name: 'Section', ...box, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 0.08 } }], strokes: [{ color: { r: 1, g: 1, b: 1, a: 0.25 }, weight: 1, align: 'INSIDE' }], cornerRadius: 4 })
      case 'slice':
        return ed.addNode({ type: 'SLICE', name: 'Slice', ...box })
      case 'spec':
        return ed.addNode({ type: 'SPEC', name: 'Spec', ...box, spec: { title: 'New task', body: 'Describe what should be designed…', status: 'TODO' } })
      case 'code':
        return ed.addNode({ type: 'CODE', name: 'Code', ...box, code: { ...DEFAULT_CODE } })
      default:
        return ed.addNode({
          type: d.type,
          ...box,
          fills: [{ type: 'SOLID', color: d.type === 'FRAME' ? { r: 1, g: 1, b: 1, a: 1 } : grey }],
          clipsContent: d.type === 'FRAME' ? true : undefined
        })
    }
  }

  /** Default size when a creation tool is clicked without dragging (like Figma). */
  private defaultSize(tool: string): { w: number; h: number } {
    if (tool === 'spec') return { w: 320, h: 220 }
    if (tool === 'code') return { w: 360, h: 220 }
    if (tool === 'section') return { w: 800, h: 600 }
    if (tool === 'line' || tool === 'arrow') return { w: 100, h: 0 }
    return { w: 100, h: 100 }
  }

  // ------------------------------------------------------------------ pen tool
  private penDown(x: number, y: number): void {
    if (!this.pen) this.pen = { pts: [], parent: ed.frameAt(x, y), hover: null }
    const pts = this.pen.pts
    // clicking the first point closes the path
    if (pts.length > 2 && Math.hypot(pts[0].x - x, pts[0].y - y) * ed.camera.zoom < 8) {
      this.finishPen(true)
      return
    }
    pts.push({ x, y })
    this.drag = { kind: 'pen-handle', index: pts.length - 1 }
    this.invalidate()
  }

  private penSegs(close: boolean): Seg[] {
    const pts = this.pen!.pts
    const segs: Seg[] = [{ c: 'M', p: [pts[0].x, pts[0].y] }]
    const seg = (a: PenPoint, b: PenPoint): Seg =>
      a.hx || a.hy || b.hx || b.hy
        ? { c: 'C', p: [a.x + (a.hx ?? 0), a.y + (a.hy ?? 0), b.x - (b.hx ?? 0), b.y - (b.hy ?? 0), b.x, b.y] }
        : { c: 'L', p: [b.x, b.y] }
    for (let i = 1; i < pts.length; i++) segs.push(seg(pts[i - 1], pts[i]))
    if (close) {
      segs.push(seg(pts[pts.length - 1], pts[0]))
      segs.push({ c: 'Z', p: [] })
    }
    return segs
  }

  private finishPen(close: boolean): void {
    const pen = this.pen
    this.pen = null
    this.drag = null
    if (!pen || pen.pts.length < 2) {
      this.invalidate()
      return
    }
    this.pen = pen
    const world = this.penSegs(close)
    this.pen = null
    this.addPathNode(world, pen.parent, close ? 'Vector' : 'Path', close)
    ed.setTool('move')
  }

  private addPathNode(world: Seg[], parent: string | null, name: string, closed: boolean, strokeWeight = 1): void {
    const b = segsBounds(world)
    const w = Math.max(b.w, 0.01)
    const h = Math.max(b.h, 0.01)
    const local = transformSegs(world, [1, 0, 0, 1, -b.x, -b.y])
    const pw = parent ? ed.world(parent) : { x: 0, y: 0 }
    const n = ed.act(() =>
      ed.addNode({
        type: 'VECTOR',
        name,
        parentId: parent,
        x: round2(b.x - pw.x),
        y: round2(b.y - pw.y),
        width: w,
        height: h,
        path: segsToD(local),
        pathBox: { w, h },
        fills: closed ? [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85, a: 1 } }] : [],
        strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: strokeWeight, align: 'CENTER' }],
        strokeCap: closed ? undefined : 'ROUND'
      })
    )
    ed.setSelection([n.id])
  }

  private up(e: PointerEvent): void {
    const d = this.drag
    this.drag = null
    this.guides = []
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)
    if (!d) return
    if (d.kind === 'move' && d.moved) {
      // drop into / out of frames like Figma (already re-parented live while dragging)
      const p = this.local(e)
      if (!(e.ctrlKey || e.metaKey)) this.reparentDragged(d.ids, this.dropTargetAt(p.x, p.y, d.ids))
      this.dropTarget = null
      ed.commit()
    } else if (d.kind === 'move' && !d.moved && !e.shiftKey && ed.selection.length > 1) {
      // click without drag on a multi-selection selects just the clicked node
      const p = this.local(e)
      const hit = this.pickAt(p.x, p.y, e.ctrlKey || e.metaKey)
      if (hit) ed.setSelection([hit])
    } else if (d.kind === 'resize') ed.commit()
    else if (d.kind === 'create') {
      if (!d.id) {
        // click without drag: default size like Figma (100x100, bigger for cards/sections)
        const s = this.defaultSize(d.tool)
        const isLine = d.tool === 'line' || d.tool === 'arrow'
        const r = isLine ? { x: d.wx, y: d.wy, w: s.w, h: 0.01 } : { x: d.wx - s.w / 2, y: d.wy - s.h / 2, w: s.w, h: s.h }
        const n = this.createShape({ ...d, wx: isLine ? d.wx : r.x, wy: isLine ? d.wy : r.y }, r, s.w, 0)
        ed.selection = [n.id]
      }
      ed.commit()
      ed.emit('selection')
      ed.setTool('move')
    } else if (d.kind === 'pencil') {
      if (d.pts.length > 1) {
        const dpath = smoothPath(d.pts, 1.2 / ed.camera.zoom)
        this.addPathNode(parsePath(dpath), d.parent, 'Pencil', false, 2)
      }
    }
    this.updateCursor(e)
    this.invalidate()
  }

  private dbl(e: MouseEvent): void {
    const p = this.local(e)
    const deep = ed.hitTest(p.x, p.y, true)
    if (!deep) return
    const n = ed.nodes.get(deep)!
    const sel = ed.selection[0] ? ed.nodes.get(ed.selection[0]) : null
    if (n.type === 'TEXT' && (sel?.id === n.id || ed.isAncestor(sel?.id ?? '', n.id) || !sel)) {
      ed.setSelection([n.id])
      this.onEditText(n.id)
      return
    }
    // dive one level into groups
    if (sel && (sel.type === 'GROUP' || sel.type === 'FRAME') && ed.isAncestor(sel.id, deep)) {
      let c = n
      while (c.parentId !== sel.id) c = ed.nodes.get(c.parentId!)!
      ed.setSelection([c.id])
    }
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault()
    const p = this.local(e)
    if (e.ctrlKey || e.metaKey) {
      // pinch-zoom on trackpads arrives as ctrl+wheel
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025) * (Math.abs(e.deltaY) > 50 ? 1 : 2))
      ed.setZoom(ed.camera.zoom * factor, p.sx, p.sy)
    } else if (e.shiftKey && !e.deltaX) ed.panBy(-e.deltaY, 0)
    else ed.panBy(-e.deltaX, -e.deltaY)
  }

  // ------------------------------------------------------------------ snapping
  private snap(box: Rect, moving: string[]): { dx: number; dy: number } {
    this.guides = []
    const tol = 5 / ed.camera.zoom
    const skip = new Set(moving)
    for (const id of moving) for (const d of ed.descendants(id)) skip.add(d)
    const view = ed.visibleWorldRect()
    const parentIds = new Set(moving.map((id) => ed.nodes.get(id)!.parentId))
    const cands = ed
      .query(view)
      .filter((id) => !skip.has(id))
      .filter((id) => {
        const n = ed.nodes.get(id)!
        // snap to siblings and to the parent frame
        return parentIds.has(n.parentId) || parentIds.has(id) || n.parentId === null
      })
      .slice(0, 400)
      .map((id) => ed.world(id))
    const xs = [box.x, box.x + box.w / 2, box.x + box.w]
    const ys = [box.y, box.y + box.h / 2, box.y + box.h]
    let bestX: { d: number; pos: number; r: Rect } | null = null
    let bestY: { d: number; pos: number; r: Rect } | null = null
    for (const r of cands) {
      for (const tx of [r.x, r.x + r.w / 2, r.x + r.w])
        for (const sx of xs) {
          const dd = tx - sx
          if (Math.abs(dd) < tol && (!bestX || Math.abs(dd) < Math.abs(bestX.d))) bestX = { d: dd, pos: tx, r }
        }
      for (const ty of [r.y, r.y + r.h / 2, r.y + r.h])
        for (const sy of ys) {
          const dd = ty - sy
          if (Math.abs(dd) < tol && (!bestY || Math.abs(dd) < Math.abs(bestY.d))) bestY = { d: dd, pos: ty, r }
        }
    }
    const dx = bestX?.d ?? 0
    const dy = bestY?.d ?? 0
    const nb = { ...box, x: box.x + dx, y: box.y + dy }
    if (bestX) {
      const u = unionRects([nb, bestX.r])!
      this.guides.push({ axis: 'x', pos: bestX.pos, from: u.y, to: u.y + u.h })
    }
    if (bestY) {
      const u = unionRects([nb, bestY.r])!
      this.guides.push({ axis: 'y', pos: bestY.pos, from: u.x, to: u.x + u.w })
    }
    return { dx, dy }
  }
}

export function isTyping(): boolean {
  const a = document.activeElement as HTMLElement | null
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)
}
