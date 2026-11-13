// Canvas controller: render loop + pointer interactions (select, move, resize, create,
// marquee, pan/zoom, snapping) for the main editor canvas. Plain TS, no React, so input
// handling never waits for UI re-renders.
import type { GNode } from '@shared/types'
import { rgbaToCss } from '@shared/types'
import { editor as ed } from './editor'
import { guides, placeGuide, newGuide, saveGuide, setGuideOpen } from './guides'
import { guideAccent } from './guide-render'
import { VectorEdit, vectorEdit } from './vector-edit'
import { applyNodeTransform, drawScene, hasTransform, outlineShape, setImageLoadedCallback } from './render'
import { rectsIntersect, round2, unionRects, type Rect } from './util'
import { polygonPath, smoothPath, starPath } from './shapes'
import { parsePath, segsBounds, segsToD, transformSegs, type Seg } from './svgpath'
import { DEFAULT_CODE, setCodeReadyCallback } from './code-render'

const BLUE = '#0d99ff'
/** components and instances */
const PURPLE = '#9747ff'
/** measuring lines and snapping guides */
const RED = '#f24822'
/** equal spacing markers */
const PINK = '#ff24bd'
/** wires between Spec cards and frames */
const WIRE = '#7cb7ff'
/** wires that bring materials into a Spec card (frames with components, references) */
const WIRE_IN = '#b99bff'
/** selection colour of a layer: purple inside components and instances */
const accentOf = (id: string) => (ed.mainComponentOf(id) || ed.instanceOf(id) || ed.nodes.get(id)?.isComponentSet ? PURPLE : BLUE)
/** cursor shown just outside the corners of the selection: drag to rotate */
const ROTATE_CURSOR =
  `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="#fff" stroke-width="4"><path d="M6 15a7 7 0 0 1 9-9"/><path d="M12 4l3.5 2-2 3.5M4 12l2 3.5 3.5-2"/></g><g stroke="#000" stroke-width="1.6"><path d="M6 15a7 7 0 0 1 9-9"/><path d="M12 4l3.5 2-2 3.5M4 12l2 3.5 3.5-2"/></g></svg>')}") 12 12, crosshair`

/** the arrow of Figma: black with a white outline, a little slimmer than the system one */
export const ARROW_PATH = 'M4.5 3.5 20 10.2 12.6 12.7 10.2 20Z'
const ARROW_CURSOR =
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="${ARROW_PATH}" fill="#000" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`)}") 4 3, default`

/** Spec cards and guidelines are wired to frames: what a node links to, or null for other layers */
function linksOf(n: GNode | undefined): { targets: string[]; sources: string[] } | null {
  if (n?.type === 'SPEC' && n.spec) return { targets: n.spec.targets ?? [], sources: n.spec.sources ?? [] }
  if (n?.type === 'GUIDE' && n.guide) return { targets: n.guide.targets ?? [], sources: [] }
  return null
}
/** ports a linking node has: a guideline only gives (right), a spec also takes materials (left) */
const portSides = (n: GNode): readonly ('l' | 'r')[] => (n.type === 'GUIDE' ? ['r'] : ['l', 'r'])

/** rotate a point around c by deg (Figma direction: positive = counter-clockwise on screen) */
function turn(x: number, y: number, c: { x: number; y: number }, deg: number): { x: number; y: number } {
  const t = (-deg * Math.PI) / 180
  const dx = x - c.x
  const dy = y - c.y
  return { x: c.x + dx * Math.cos(t) - dy * Math.sin(t), y: c.y + dx * Math.sin(t) + dy * Math.cos(t) }
}
const HANDLE = 7

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
const CURSORS: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' }

type Drag =
  | { kind: 'pan'; sx: number; sy: number }
  | { kind: 'move'; sx: number; sy: number; ids: string[]; orig: Map<string, Rect>; box: Rect; moved: boolean; dup: boolean }
  | { kind: 'resize'; handle: Handle; box: Rect; ids: string[]; orig: Map<string, Rect>; snap?: Map<string, GNode>; rot: number }
  | { kind: 'rotate'; cx: number; cy: number; a0: number; orig: Map<string, { cx: number; cy: number; rot: number }> }
  /** dragging a wire out of a Spec card towards a frame (world coordinates of the loose end) */
  | { kind: 'link'; spec: string; side: 'l' | 'r'; x: number; y: number; target: string | null }
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
  private altDown = false
  /** equal-spacing markers shown while dragging: a gap between two layers that matches another gap */
  private gaps: { axis: 'x' | 'y'; from: number; to: number; at: number }[] = []
  private guides: Guide[] = []
  private frameLabels: { id: string; r: Rect }[] = []
  private annotationPins: { id: string; r: Rect }[] = []
  /** frame/section highlighted as the drop target while dragging */
  private dropTarget: string | null = null
  private disposers: (() => void)[] = []
  /** Pen tool: points of the path being drawn (world coordinates) */
  /** point editing of a vector (double click), as in Figma */
  private vedit = new VectorEdit(() => this.invalidate())
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
    vectorEdit.current = this.vedit
    // for the UI test scripts, like window.editor
    ;(window as unknown as { canvasView: unknown }).canvasView = this
    on(canvas, 'pointerdown', (e) => this.down(e))
    on(canvas, 'pointermove', (e) => this.move(e))
    on(canvas, 'pointerup', (e) => this.up(e))
    on(canvas, 'dblclick', (e) => this.dbl(e))
    on(canvas, 'wheel', (e) => this.wheel(e), { passive: false })
    on(window, 'keydown', (e) => {
      // editing the points of a vector: Enter / Escape leave, Delete removes points, arrows nudge them
      if (this.vedit.active && !isTyping() && this.vedit.key(e)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        return
      }
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
      // Alt: measure distances from the selection to what is under the cursor
      if (e.key === 'Alt' && !this.altDown) {
        this.altDown = true
        // a lone Alt would otherwise move the focus to the window menu
        if (ed.selection.length) e.preventDefault()
        this.invalidate()
      }
    })
    on(window, 'keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false
        this.updateCursor()
      }
      if (e.key === 'Alt') {
        this.altDown = false
        if (ed.selection.length) e.preventDefault()
        this.invalidate()
      }
    })
    on(window, 'blur', () => {
      this.altDown = false
      this.invalidate()
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
    // wires run behind the layers they connect
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.drawSpecWires()
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * cx, dpr * cy)
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
      // components and instances are purple, with Figma's marks in front of the name
      const comp = n.isComponent || n.componentId || n.isComponentSet
      if (comp) label = (n.componentId ? '◇ ' : '❖ ') + label
      ctx.fillStyle = comp ? PURPLE : sel ? BLUE : '#8a8a8a'
      const maxW = Math.max(s.w, 20)
      while (label.length > 1 && ctx.measureText(label).width > maxW) label = label.slice(0, -2) + '…'
      ctx.fillText(label, s.x, s.y - 4)
      this.frameLabels.push({ id, r: { x: s.x, y: s.y - 18, w: Math.min(ctx.measureText(label).width, maxW), h: 16 } })
    }

    // component sets: Figma's dashed purple border around the variants
    ctx.save()
    ctx.setLineDash([5, 4])
    ctx.lineWidth = 1
    ctx.strokeStyle = PURPLE
    for (const id of ed.query(view)) {
      const n = ed.nodes.get(id)
      if (!n?.isComponentSet || !n.visible) continue
      const s = this.toScreen(ed.world(id))
      ctx.beginPath()
      ctx.roundRect(Math.round(s.x) + 0.5, Math.round(s.y) + 0.5, Math.round(s.w), Math.round(s.h), 5)
      ctx.stroke()
    }
    ctx.restore()

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
      ctx.strokeStyle = accentOf(ed.hoverId)
      ctx.lineWidth = 1.5
      this.outline(ed.hoverId)
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
    if (sel.length && ed.editingTextId === null && !this.vedit.active) {
      const accent = sel.every((id) => accentOf(id) === PURPLE) ? PURPLE : BLUE
      ctx.strokeStyle = accent
      ctx.lineWidth = 1
      if (sel.length > 1)
        for (const id of sel) this.outline(id)
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
      if (!(this.drag?.kind === 'move' && this.drag.moved) && !this.selfSized()) {
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
      ctx.fillStyle = accent
      ctx.beginPath()
      ctx.roundRect(px, py, tw, 17, 3)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'center'
      ctx.fillText(text, px + tw / 2, py + 9)
      ctx.textAlign = 'left'
    }

    // points, handles and the hatch of the vector being edited
    this.vedit.draw(ctx)

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

    this.drawSpecPorts()

    // equal spacing while dragging
    for (const g of this.gaps) {
      const a = g.axis === 'x' ? this.toScreen({ x: g.from, y: g.at, w: g.to - g.from, h: 0 }) : this.toScreen({ x: g.at, y: g.from, w: 0, h: g.to - g.from })
      this.measureLine(a.x, a.y, a.x + a.w, a.y + a.h, round2(g.to - g.from), PINK)
    }

    // Alt: distances from the selection to the hovered layer (or to the parent frame)
    if (this.altDown && !this.drag && sel.length && ed.editingTextId === null) this.drawMeasure(sel)

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

  // ---------------------------------------------------------------- spec wires
  /** the two ports of a Spec card (left and right edge), in world coordinates */
  private specPorts(id: string): { l: { x: number; y: number }; r: { x: number; y: number } } {
    const w = ed.world(id)
    const y = w.y + Math.min(w.h / 2, 60)
    return { l: { x: w.x, y }, r: { x: w.x + w.w, y } }
  }
  /** the port of the selected Spec card under a screen point */
  private specPortAt(sx: number, sy: number): { spec: string; side: 'l' | 'r' } | null {
    if (ed.selection.length !== 1 || ed.tool !== 'move') return null
    const n = ed.nodes.get(ed.selection[0])
    if (!n || !linksOf(n)) return null
    const ports = this.specPorts(n.id)
    for (const side of portSides(n)) {
      const p = this.toScreen({ x: ports[side].x, y: ports[side].y, w: 0, h: 0 })
      if (Math.hypot(sx - (p.x + (side === 'l' ? -14 : 14)), sy - p.y) <= 10) return { spec: n.id, side }
    }
    return null
  }
  /** a wire from a port to a point: leaves the card sideways and arrives sideways. Returns points along it (for hit testing). */
  private wire(x1: number, y1: number, x2: number, y2: number, side: 'l' | 'r', endSide: 'l' | 'r' | 't' | 'b' | null): { x: number; y: number }[] {
    const ctx = this.ctx
    const k = Math.max(30, Math.min(160, Math.abs(x2 - x1) / 2 + Math.abs(y2 - y1) / 6))
    const c1x = x1 + (side === 'l' ? -k : k)
    const c2x = endSide === 'l' ? x2 - k : endSide === 'r' ? x2 + k : x2
    const c2y = endSide === 't' ? y2 - k : endSide === 'b' ? y2 + k : y2
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.bezierCurveTo(c1x, y1, c2x, c2y, x2, y2)
    ctx.stroke()
    const pts: { x: number; y: number }[] = []
    for (let i = 0; i <= 28; i++) {
      const t = i / 28
      const u = 1 - t
      pts.push({ x: u * u * u * x1 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x2, y: u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * c2y + t * t * t * y2 })
    }
    return pts
  }
  /** where a wire from (px, py) lands on a frame: the middle of the side that faces the card */
  private wireEnd(target: Rect, px: number, py: number): { x: number; y: number; side: 'l' | 'r' | 't' | 'b' } {
    // a card well above or below the frame is met by the top or bottom edge: the wire does not sneak in from the side
    const dx = px < target.x ? target.x - px : px > target.x + target.w ? px - target.x - target.w : 0
    const dy = py < target.y ? target.y - py : py > target.y + target.h ? py - target.y - target.h : 0
    if (dx > 0 && dy >= dx * 0.35) return py < target.y ? { x: target.x + target.w / 2, y: target.y, side: 't' } : { x: target.x + target.w / 2, y: target.y + target.h, side: 'b' }
    if (px < target.x) return { x: target.x, y: target.y + Math.min(target.h / 2, 60), side: 'l' }
    if (px > target.x + target.w) return { x: target.x + target.w, y: target.y + Math.min(target.h / 2, 60), side: 'r' }
    return py < target.y + target.h / 2 ? { x: target.x + target.w / 2, y: target.y, side: 't' } : { x: target.x + target.w / 2, y: target.y + target.h, side: 'b' }
  }
  /** the wires drawn in the last frame, in screen space */
  private wires: { spec: string; other: string; pts: { x: number; y: number }[] }[] = []
  private hoverWire: { spec: string; other: string } | null = null
  private hoverFrame: string | null = null
  private wireAt(sx: number, sy: number): { spec: string; other: string } | null {
    for (const w of this.wires) for (const p of w.pts) if (Math.hypot(p.x - sx, p.y - sy) <= 7) return { spec: w.spec, other: w.other }
    return null
  }
  /** a wire lights up when the pointer is on it, on its card or on its frame, and while either end is selected */
  private wireLit(spec: string, other: string): boolean {
    const h = ed.hoverId
    const d = this.drag
    const hf = this.hoverFrame
    return (
      hf === other ||
      (!!hf && ed.isAncestor(other, hf)) ||
      ed.selection.includes(spec) ||
      ed.selection.includes(other) ||
      h === spec ||
      h === other ||
      (!!h && ed.isAncestor(other, h)) ||
      (this.hoverWire?.spec === spec && this.hoverWire.other === other) ||
      (d?.kind === 'link' && d.spec === spec)
    )
  }
  /**
   * Wires of every Spec card on the page. Drawn before the layers, so they pass behind the frames and cards:
   * materials come in at the left port, the frames to work in go out of the right one.
   */
  private drawSpecWires(): void {
    const ctx = this.ctx
    const S = (p: { x: number; y: number }) => this.toScreen({ x: p.x, y: p.y, w: 0, h: 0 })
    this.wires = []
    ctx.save()
    ctx.lineCap = 'round'
    for (const n of ed.nodes.values()) {
      const links = linksOf(n)
      if (!links || n.pageId !== ed.currentPageId || !n.visible) continue
      // a guideline is a standing rule too; its wires carry its accent colour
      const rules = n.type === 'GUIDE' || n.spec?.kind === 'RULES'
      const done = !rules && n.spec?.status === 'DONE'
      const own = n.type === 'GUIDE' ? guideAccent(guides.get(n.guide!.id)) : null
      const ports = this.specPorts(n.id)
      for (const [side, ids] of [['r', links.targets], ['l', links.sources]] as const) {
        for (const tid of ids) {
          const t = ed.nodes.get(tid)
          if (!t || t.pageId !== n.pageId || !t.visible) continue
          const tw = ed.world(tid)
          const a = S(ports[side])
          const endW = this.wireEnd(tw, ports[side].x, ports[side].y)
          const b = S(endW)
          const lit = this.wireLit(n.id, tid)
          const color = own ?? (side === 'l' ? WIRE_IN : done ? '#27ae60' : WIRE)
          ctx.globalAlpha = lit ? 1 : 0.28
          ctx.lineWidth = lit ? 2 : 1.5
          ctx.strokeStyle = color
          ctx.shadowColor = lit ? color : 'transparent'
          ctx.shadowBlur = lit ? 10 * this.dpr : 0
          // an open task is dashed; materials, rules and finished work are solid
          ctx.setLineDash(side === 'r' && !done && !rules ? [6, 5] : [])
          this.wires.push({ spec: n.id, other: tid, pts: this.wire(a.x, a.y, b.x, b.y, side, endW.side) })
          ctx.setLineDash([])
          ctx.fillStyle = color
          for (const p of [a, b]) {
            ctx.beginPath()
            ctx.arc(p.x, p.y, 4, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      }
    }
    ctx.restore()
  }
  /** on top of the layers: outlines of what a selected card is wired to, its ports and the wire being dragged */
  private drawSpecPorts(): void {
    const ctx = this.ctx
    const S = (p: { x: number; y: number }) => this.toScreen({ x: p.x, y: p.y, w: 0, h: 0 })
    ctx.save()
    ctx.lineWidth = 1.5
    ctx.lineCap = 'round'
    const sel = ed.selection.length === 1 ? ed.nodes.get(ed.selection[0]) : undefined
    const selLinks = linksOf(sel)
    if (sel && selLinks) {
      for (const [color, ids] of [[WIRE, selLinks.targets], [WIRE_IN, selLinks.sources]] as const) {
        ctx.strokeStyle = color
        for (const id of ids) {
          if (!ed.nodes.has(id) || ed.nodes.get(id)!.pageId !== sel.pageId) continue
          const f = this.toScreen(ed.world(id))
          ctx.strokeRect(Math.round(f.x) + 0.5, Math.round(f.y) + 0.5, Math.round(f.w), Math.round(f.h))
        }
      }
    }
    // ports of the selected card: drag one to a frame (left = materials in, right = where to work)
    if (sel && selLinks && ed.tool === 'move' && !(this.drag?.kind === 'move' && this.drag.moved)) {
      const ports = this.specPorts(sel.id)
      for (const side of portSides(sel)) {
        const color = side === 'l' ? WIRE_IN : WIRE
        const p = S(ports[side])
        const cx = p.x + (side === 'l' ? -14 : 14)
        ctx.strokeStyle = color
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.lineTo(cx, p.y)
        ctx.stroke()
        ctx.fillStyle = '#fff'
        ctx.beginPath()
        ctx.arc(cx, p.y, 6, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(cx, p.y, 2.5, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    const d = this.drag
    if (d?.kind === 'link') {
      const color = d.side === 'l' ? WIRE_IN : WIRE
      const a = S(this.specPorts(d.spec)[d.side])
      let end = S({ x: d.x, y: d.y })
      let endSide: 'l' | 'r' | 't' | 'b' | null = null
      ctx.strokeStyle = color
      if (d.target && ed.nodes.has(d.target)) {
        const tw = ed.world(d.target)
        const e = this.wireEnd(tw, this.specPorts(d.spec)[d.side].x, this.specPorts(d.spec)[d.side].y)
        end = S(e)
        endSide = e.side
        const f = this.toScreen(tw)
        ctx.lineWidth = 2
        ctx.strokeRect(Math.round(f.x) + 0.5, Math.round(f.y) + 0.5, Math.round(f.w), Math.round(f.h))
        ctx.lineWidth = 1.5
      }
      this.wire(a.x, a.y, end.x, end.y, d.side, endSide)
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(end.x, end.y, 4, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  /** a measuring line in screen space with end ticks and the value in a pill */
  private measureLine(x1: number, y1: number, x2: number, y2: number, value: number, color: string): void {
    const ctx = this.ctx
    const horiz = Math.abs(x2 - x1) >= Math.abs(y2 - y1)
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5)
    ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5)
    for (const [x, y] of [[x1, y1], [x2, y2]]) {
      ctx.moveTo(Math.round(x) + 0.5 - (horiz ? 0 : 3), Math.round(y) + 0.5 - (horiz ? 3 : 0))
      ctx.lineTo(Math.round(x) + 0.5 + (horiz ? 0 : 3), Math.round(y) + 0.5 + (horiz ? 3 : 0))
    }
    ctx.stroke()
    const text = String(value)
    ctx.font = '11px Inter, "Segoe UI", system-ui, sans-serif'
    const tw = ctx.measureText(text).width + 8
    const cx = (x1 + x2) / 2
    const cy = (y1 + y2) / 2
    // the pill sits beside the line so it never hides it
    const px = horiz ? cx - tw / 2 : cx + 5
    const py = horiz ? cy - 20 : cy - 8
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.roundRect(px, py, tw, 16, 3)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    ctx.fillText(text, px + tw / 2, py + 8.5)
    ctx.restore()
  }

  /** Figma's Alt measuring: red lines from the selection to the hovered layer, or to its parent frame */
  private drawMeasure(sel: string[]): void {
    const ctx = this.ctx
    const A = ed.selectionBounds(sel)!
    let target = ed.hoverId && ed.nodes.has(ed.hoverId) && !sel.includes(ed.hoverId) && !sel.some((s) => ed.isAncestor(s, ed.hoverId!)) ? ed.hoverId : null
    if (!target) target = ed.nodes.get(sel[0])?.parentId ?? null
    if (!target) return
    const B = ed.world(target)
    const a = this.toScreen(A)
    const b = this.toScreen(B)
    // outline of what is being measured against
    ctx.save()
    ctx.strokeStyle = RED
    ctx.lineWidth = 1
    ctx.strokeRect(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5, Math.round(b.w), Math.round(b.h))
    ctx.setLineDash([3, 3])
    const dash = (x1: number, y1: number, x2: number, y2: number) => {
      ctx.beginPath()
      ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5)
      ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5)
      ctx.stroke()
    }
    const overlap = (a1: number, a2: number, b1: number, b2: number) => (Math.min(a2, b2) > Math.max(a1, b1) ? (Math.max(a1, b1) + Math.min(a2, b2)) / 2 : null)
    const segs: [number, number, number, number, number][] = []
    // horizontal distances are drawn at a height both boxes share, or at the middle of the selection
    const oy = overlap(a.y, a.y + a.h, b.y, b.y + b.h)
    const y = oy ?? a.y + a.h / 2
    const ox = overlap(a.x, a.x + a.w, b.x, b.x + b.w)
    const x = ox ?? a.x + a.w / 2
    const H = (s1: number, s2: number, w1: number, w2: number) => Math.abs(w2 - w1) > 0.005 && segs.push([s1, y, s2, y, round2(Math.abs(w2 - w1))])
    const V = (s1: number, s2: number, w1: number, w2: number) => Math.abs(w2 - w1) > 0.005 && segs.push([x, s1, x, s2, round2(Math.abs(w2 - w1))])
    if (A.x + A.w <= B.x) H(a.x + a.w, b.x, A.x + A.w, B.x)
    else if (B.x + B.w <= A.x) H(b.x + b.w, a.x, B.x + B.w, A.x)
    else {
      H(Math.min(a.x, b.x), Math.max(a.x, b.x), A.x, B.x)
      H(Math.min(a.x + a.w, b.x + b.w), Math.max(a.x + a.w, b.x + b.w), A.x + A.w, B.x + B.w)
    }
    if (A.y + A.h <= B.y) V(a.y + a.h, b.y, A.y + A.h, B.y)
    else if (B.y + B.h <= A.y) V(b.y + b.h, a.y, B.y + B.h, A.y)
    else {
      V(Math.min(a.y, b.y), Math.max(a.y, b.y), A.y, B.y)
      V(Math.min(a.y + a.h, b.y + b.h), Math.max(a.y + a.h, b.y + b.h), A.y + A.h, B.y + B.h)
    }
    // dashed helpers when the line runs outside the other box
    if (oy === null && (A.x + A.w <= B.x || B.x + B.w <= A.x)) {
      const ex = A.x + A.w <= B.x ? b.x : b.x + b.w
      dash(ex, y, ex, y < b.y ? b.y : b.y + b.h)
    }
    if (ox === null && (A.y + A.h <= B.y || B.y + B.h <= A.y)) {
      const ey = A.y + A.h <= B.y ? b.y : b.y + b.h
      dash(x, ey, x < b.x ? b.x : b.x + b.w, ey)
    }
    ctx.restore()
    for (const s of segs) this.measureLine(s[0], s[1], s[2], s[3], s[4], RED)
  }

  /** stroke the box of a layer, rotated with it */
  private outline(id: string): void {
    const ctx = this.ctx
    const n = ed.nodes.get(id)
    if (!n) return
    const r = ed.world(id)
    const { zoom, x, y } = ed.camera
    const lw = ctx.lineWidth
    ctx.save()
    // draw in world space so the outline follows the real shape, with every rotation applied
    ctx.translate(x, y)
    ctx.scale(zoom, zoom)
    for (const a of [...ed.ancestors(id).reverse(), n]) if (hasTransform(a)) applyNodeTransform(ctx, a, ed.world(a.id))
    ctx.lineWidth = lw / zoom
    const shape = outlineShape(ed, id)
    if (shape) ctx.stroke(shape)
    else ctx.strokeRect(r.x, r.y, r.w, r.h)
    ctx.restore()
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

  /** rotation of the selection box: a single rotated layer shows its box rotated with it */
  private boxRotation(): number {
    return ed.selection.length === 1 ? (ed.nodes.get(ed.selection[0])?.rotation ?? 0) : 0
  }
  /** screen point -> the unrotated space of the selection box */
  private intoBox(sx: number, sy: number, b: Rect): { x: number; y: number } {
    const rot = this.boxRotation()
    return rot ? turn(sx, sy, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, -rot) : { x: sx, y: sy }
  }
  /** just outside a corner of the selection box: the rotate zone, as in Figma */
  private rotateZoneAt(sx0: number, sy0: number): boolean {
    if (!ed.selection.length || ed.tool !== 'move' || this.selfSized()) return false
    const b = this.toScreen(ed.selectionBounds()!)
    const { x, y } = this.intoBox(sx0, sy0, b)
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return false
    for (const [cx, cy] of [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]]) {
      const dx = x - cx
      const dy = y - cy
      // outside the box on both axes relative to this corner
      const outX = cx === b.x ? dx < 0 : dx > 0
      const outY = cy === b.y ? dy < 0 : dy > 0
      if (outX && outY && Math.hypot(dx, dy) > 6 && Math.hypot(dx, dy) < 22) return true
    }
    return false
  }

  /** a guideline is like a document: its size comes from its contents, so it has no resize handles and does not rotate */
  private selfSized(): boolean {
    return ed.selection.length > 0 && ed.selection.every((id) => ed.nodes.get(id)?.type === 'GUIDE')
  }
  private handleAt(sx0: number, sy0: number): Handle | null {
    if (!ed.selection.length || this.selfSized()) return null
    const b = this.toScreen(ed.selectionBounds()!)
    const { x: sx, y: sy } = this.intoBox(sx0, sy0, b)
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
    let c = ARROW_CURSOR
    if (this.vedit.active && !this.spaceDown && ed.tool === 'move') {
      this.canvas.style.cursor = this.vedit.cursor() ?? ARROW_CURSOR
      return
    }
    if (this.spaceDown || ed.tool === 'hand') c = this.drag?.kind === 'pan' ? 'grabbing' : 'grab'
    else if (ed.tool !== 'move' && ed.tool !== 'scale') c = ed.tool === 'text' ? 'text' : ed.tool === 'annotation' ? 'cell' : 'crosshair'
    else if (e) {
      const p = this.local(e)
      const h = this.handleAt(p.sx, p.sy)
      if (this.drag?.kind === 'link' || this.specPortAt(p.sx, p.sy)) c = 'crosshair'
      else if (h) c = CURSORS[h]
      else if (this.drag?.kind === 'rotate' || this.rotateZoneAt(p.sx, p.sy)) c = ROTATE_CURSOR
    }
    this.canvas.style.cursor = c
  }

  private down(e: PointerEvent): void {
    if (ed.editingTextId) return
    // working on the canvas takes the keyboard away from the fields of the panels (their value is committed
    // on blur), so Ctrl+Z, Delete and the tool keys act on the canvas again
    const active = document.activeElement as HTMLElement | null
    if (active && active !== this.canvas && isTyping()) active.blur()
    this.canvas.focus({ preventScroll: true })
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
    if (this.vedit.active && ed.tool === 'move' && e.button === 0 && this.vedit.down(p.x, p.y, e)) return
    // another tool ends the point editing
    if (this.vedit.active && ed.tool !== 'move') this.vedit.stop()
    if (ed.tool === 'guide') {
      let id = ed.pendingGuide
      const fresh = id === 'new' || !id || !guides.has(id)
      if (fresh) {
        const g = newGuide()
        saveGuide(g)
        id = g.id
      }
      const n = placeGuide(id!, { x: p.x, y: p.y }, fresh)
      ed.pendingGuide = null
      ed.setTool('move')
      ed.setSelection([n.id])
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

    // a port of the selected Spec card: pull a wire to a frame
    const port = this.specPortAt(p.sx, p.sy)
    if (port) {
      this.drag = { kind: 'link', spec: port.spec, side: port.side, x: p.x, y: p.y, target: null }
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
        snap: ed.tool === 'scale' ? new Map(all.map((id) => [id, structuredClone(ed.nodes.get(id)!)])) : undefined,
        rot: this.boxRotation()
      }
      ed.begin()
      return
    }
    if (this.rotateZoneAt(p.sx, p.sy)) {
      const box = ed.selectionBounds()!
      const cx = box.x + box.w / 2
      const cy = box.y + box.h / 2
      this.drag = {
        kind: 'rotate',
        cx,
        cy,
        a0: Math.atan2(p.y - cy, p.x - cx),
        orig: new Map(
          ed.roots(ed.selection).map((id) => {
            const w = ed.world(id)
            return [id, { cx: w.x + w.w / 2, cy: w.y + w.h / 2, rot: ed.nodes.get(id)!.rotation ?? 0 }]
          })
        )
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
    if (!d && this.vedit.active && ed.tool === 'move' && !this.spaceDown && this.vedit.move(p.x, p.y, e)) {
      this.updateCursor(e)
      return
    }
    if (!d) {
      if (this.pen) {
        this.pen.hover = { x: p.x, y: p.y }
        this.invalidate()
      }
      if ((ed.tool === 'move' || ed.tool === 'scale') && !this.spaceDown && !ed.editingTextId) {
        const h = this.pickAt(p.x, p.y, e.ctrlKey || e.metaKey)
        // wires lie behind the layers: one is hovered only where nothing else is
        const hw = h ? null : this.wireAt(p.sx, p.sy)
        // the frame or section under the pointer, also over its empty area: its wires light up
        const hf = this.wires.length ? ed.frameAt(p.x, p.y) : null
        if (h !== ed.hoverId || hf !== this.hoverFrame || hw?.spec !== this.hoverWire?.spec || hw?.other !== this.hoverWire?.other) {
          ed.hoverId = h
          this.hoverFrame = hf
          this.hoverWire = hw
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
        // auto layout follows the drag: the layer slides between its neighbours as it moves
        ed.dragIds = new Set(d.ids)
        ed.layoutNow()
        ed.emit('doc')
        break
      }
      case 'link': {
        d.x = p.x
        d.y = p.y
        // the frame under the cursor (the outermost one: specs are about whole screens), or the section when over its empty area
        let hit = ed.frameAt(p.x, p.y)
        while (hit && ed.nodes.get(hit)!.parentId && ed.nodes.get(ed.nodes.get(hit)!.parentId!)?.type === 'FRAME') hit = ed.nodes.get(hit)!.parentId
        d.target = hit && !ed.isAncestor(hit, d.spec) ? hit : null
        // the left port of a spec also takes a guideline: its dot is a material like any frame
        const dot = d.side === 'l' ? ed.hitTest(p.x, p.y, true) : null
        if (dot && dot !== d.spec && ed.nodes.get(dot)?.type === 'GUIDE' && ed.nodes.get(d.spec)?.type === 'SPEC') d.target = dot
        this.invalidate()
        break
      }
      case 'rotate': {
        // degrees turned since the drag started (screen clockwise = negative in Figma's convention)
        let delta = (-(Math.atan2(p.y - d.cy, p.x - d.cx) - d.a0) * 180) / Math.PI
        if (e.shiftKey) {
          // snap the result to 15° steps
          const first = d.orig.values().next().value!
          delta = Math.round((first.rot + delta) / 15) * 15 - first.rot
        }
        for (const [id, o] of d.orig) {
          const n = ed.nodes.get(id)
          if (!n) continue
          const c = turn(o.cx, o.cy, { x: d.cx, y: d.cy }, delta)
          const pw = n.parentId ? ed.world(n.parentId) : { x: 0, y: 0 }
          const rot = ((((o.rot + delta + 180) % 360) + 360) % 360) - 180
          ed.updateNode(id, { x: round2(c.x - n.width / 2 - pw.x), y: round2(c.y - n.height / 2 - pw.y), rotation: Math.round(rot * 100) / 100 || undefined })
        }
        ed.emit('doc')
        break
      }
      case 'resize': {
        const b = d.box
        // a rotated layer is resized in its own (unrotated) space
        const c0 = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
        if (d.rot) Object.assign(p, turn(p.x, p.y, c0, -d.rot))
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
        if (d.rot) {
          // keep the opposite corner where it is on screen: the new center is the rotated image of the box center
          const c = turn(nb.x + nb.w / 2, nb.y + nb.h / 2, c0, d.rot)
          nb.x = c.x - nb.w / 2
          nb.y = c.y - nb.h / 2
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
        ed.layoutNow()
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
        return ed.addNode({ type: 'SPEC', name: 'Spec', ...box, spec: { title: '', body: '', status: 'TODO' } })
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
    if (!this.drag && this.vedit.active) {
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)
      this.vedit.up()
      return
    }
    const d = this.drag
    this.drag = null
    this.guides = []
    this.gaps = []
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)
    if (!d) return
    if (d.kind === 'move' && d.moved) {
      // drop into / out of frames like Figma (already re-parented live while dragging)
      const p = this.local(e)
      if (!(e.ctrlKey || e.metaKey)) this.reparentDragged(d.ids, this.dropTargetAt(p.x, p.y, d.ids))
      this.dropTarget = null
      // inside an auto layout frame the layer takes the slot it was dropped on
      ed.dropByPosition = true
      ed.dragIds = new Set(d.ids)
      ed.commit()
      ed.dropByPosition = false
      ed.dragIds = null
    } else if (d.kind === 'move' && !d.moved && !e.shiftKey && ed.selection.length > 1) {
      // click without drag on a multi-selection selects just the clicked node
      const p = this.local(e)
      const hit = this.pickAt(p.x, p.y, e.ctrlKey || e.metaKey)
      if (hit) ed.setSelection([hit])
    } else if (d.kind === 'link') {
      // dropping the wire on a frame links it; dropping it on an already linked frame removes the link.
      // The left port takes materials, the right one points at the frames to work in.
      const spec = ed.nodes.get(d.spec)
      if (spec?.guide && d.target) {
        const cur = (spec.guide.targets ?? []).filter((t) => ed.nodes.has(t))
        const next = cur.includes(d.target) ? cur.filter((t) => t !== d.target) : [...cur, d.target]
        ed.act(() => ed.updateNode(spec.id, { guide: { ...spec.guide!, targets: next.length ? next : undefined } }))
      } else if (spec?.spec && d.target) {
        const mine = d.side === 'l' ? 'sources' : 'targets'
        const other = d.side === 'l' ? 'targets' : 'sources'
        const cur = (spec.spec[mine] ?? []).filter((t) => ed.nodes.has(t))
        const next = cur.includes(d.target) ? cur.filter((t) => t !== d.target) : [...cur, d.target]
        const rest = (spec.spec[other] ?? []).filter((t) => t !== d.target)
        ed.act(() => ed.updateNode(spec.id, { spec: { ...spec.spec!, [mine]: next.length ? next : undefined, [other]: rest.length ? rest : undefined } }))
      }
      this.invalidate()
    } else if (d.kind === 'resize' || d.kind === 'rotate') ed.commit()
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
    // inside the point editing a double click turns a corner into a curve, or leaves the mode
    if (this.vedit.active) {
      this.vedit.dbl(p.x, p.y)
      return
    }
    const deep = ed.hitTest(p.x, p.y, true)
    if (!deep) return
    const n = ed.nodes.get(deep)!
    // a vector (or a plain shape) that is selected, or can be selected with one click, opens for point editing
    if (ed.tool === 'move' && VectorEdit.editable(n) && !n.locked && (ed.selection[0] === n.id || ed.hitTest(p.x, p.y, false) === n.id)) {
      if (this.vedit.start(n.id)) return
    }
    // a guideline dot opens into its card
    if (n.type === 'GUIDE') {
      setGuideOpen(n.id, true)
      ed.setSelection([n.id])
      return
    }
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
    this.gaps = []
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
    // equal spacing: between two neighbours, or continuing the gap of the two layers next to it
    const parent = ed.nodes.get(moving[0])?.parentId ?? null
    const sibs = ed
      .children(parent)
      .filter((id) => !skip.has(id) && ed.nodes.get(id)!.visible)
      .slice(0, 300)
      .map((id) => ed.world(id))
    const spacing = (axis: 'x' | 'y'): { d: number; marks: { from: number; to: number; at: number }[] } | null => {
      const P = axis === 'x' ? 'x' : 'y'
      const S = axis === 'x' ? 'w' : 'h'
      const CP = axis === 'x' ? 'y' : 'x'
      const CS = axis === 'x' ? 'h' : 'w'
      // only layers that share the row (or the column) with the dragged box
      const row = sibs.filter((r) => r[CP] < box[CP] + box[CS] && r[CP] + r[CS] > box[CP])
      const before = row.filter((r) => r[P] + r[S] <= box[P] + tol).sort((a, b) => b[P] + b[S] - (a[P] + a[S]))
      const after = row.filter((r) => r[P] >= box[P] + box[S] - tol).sort((a, b) => a[P] - b[P])
      const at = (a: Rect) => Math.max(a[CP], box[CP]) + (Math.min(a[CP] + a[CS], box[CP] + box[CS]) - Math.max(a[CP], box[CP])) / 2
      const L = before[0]
      const R = after[0]
      const tries: { pos: number; marks: { from: number; to: number; at: number }[] }[] = []
      if (L && R) {
        const g = (R[P] - (L[P] + L[S]) - box[S]) / 2
        if (g > 0) tries.push({ pos: L[P] + L[S] + g, marks: [{ from: L[P] + L[S], to: L[P] + L[S] + g, at: at(L) }, { from: R[P] - g, to: R[P], at: at(R) }] })
      }
      if (L && before[1]) {
        const g = L[P] - (before[1][P] + before[1][S])
        if (g > 0) tries.push({ pos: L[P] + L[S] + g, marks: [{ from: before[1][P] + before[1][S], to: L[P], at: at(L) }, { from: L[P] + L[S], to: L[P] + L[S] + g, at: at(L) }] })
      }
      if (R && after[1]) {
        const g = after[1][P] - (R[P] + R[S])
        if (g > 0) tries.push({ pos: R[P] - g - box[S], marks: [{ from: R[P] + R[S], to: after[1][P], at: at(R) }, { from: R[P] - g, to: R[P], at: at(R) }] })
      }
      let best: { d: number; marks: { from: number; to: number; at: number }[] } | null = null
      for (const t of tries) {
        const d = t.pos - box[P]
        if (Math.abs(d) < tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, marks: t.marks }
      }
      return best
    }
    const gx = spacing('x')
    const gy = spacing('y')
    // an edge / centre match wins; spacing is used on an axis that has none
    const dx = bestX?.d ?? gx?.d ?? 0
    const dy = bestY?.d ?? gy?.d ?? 0
    if (!bestX && gx) for (const m of gx.marks) this.gaps.push({ axis: 'x', ...m })
    if (!bestY && gy) for (const m of gy.marks) this.gaps.push({ axis: 'y', ...m })
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
