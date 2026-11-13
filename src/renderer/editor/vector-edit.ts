// Vector edit mode, as in Figma: double-click a vector to see its points, drag points and curve handles,
// add a point on a segment, delete points, turn a corner into a curve and back. The shape is hatched
// while it is being edited. Every gesture is one undo step.
//
// Points live in the unrotated world space of the layer (where editor.world() lives), so the layer's own
// box can be recomputed after each change. A rotated or mirrored layer keeps its box while it is edited
// (its pivot must not move under the pointer); the path simply reaches outside that box.
import type { GNode } from '@shared/types'
import { editor as ed } from './editor'
import { applyNodeTransform, hasTransform } from './render'
import { parsePath, segsBounds, segsToD, transformSegs, type Seg } from './svgpath'
import { round2 } from './util'

interface Pt {
  x: number
  y: number
}
/** an anchor with its two curve handles (absolute positions; absent = straight) */
interface Anchor extends Pt {
  in?: Pt
  out?: Pt
}
interface Sub {
  closed: boolean
  pts: Anchor[]
}
type Ref = { s: number; i: number }
type Hit = { kind: 'point'; ref: Ref } | { kind: 'handle'; ref: Ref; side: 'in' | 'out' } | { kind: 'segment'; s: number; i: number; t: number; at: Pt } | null

type Drag =
  | { kind: 'points'; start: Pt; orig: Map<string, Anchor>; moved: boolean }
  | { kind: 'handle'; ref: Ref; side: 'in' | 'out'; moved: boolean }
  | { kind: 'marquee'; start: Pt; now: Pt; base: Set<string> }

const BLUE = '#0d99ff'
const key = (r: Ref) => r.s + ':' + r.i
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const same = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6

/** shapes that become a vector when their points are edited */
function shapeAsPath(n: GNode): { path: string; pathBox: { w: number; h: number } } | null {
  const w = n.width
  const h = n.height
  if (n.type === 'RECTANGLE' || n.type === 'IMAGE') {
    const r = Math.min(n.cornerRadius ?? 0, w / 2, h / 2)
    if (n.type === 'IMAGE' || n.cornerRadii) return null
    if (!r) return { path: `M0 0L${w} 0L${w} ${h}L0 ${h}Z`, pathBox: { w, h } }
    const k = r * 0.5523
    return {
      path: `M${r} 0L${w - r} 0C${w - r + k} 0 ${w} ${r - k} ${w} ${r}L${w} ${h - r}C${w} ${h - r + k} ${w - r + k} ${h} ${w - r} ${h}L${r} ${h}C${r - k} ${h} 0 ${h - r + k} 0 ${h - r}L0 ${r}C0 ${r - k} ${r - k} 0 ${r} 0Z`,
      pathBox: { w, h }
    }
  }
  if (n.type === 'ELLIPSE') {
    const rx = w / 2
    const ry = h / 2
    const kx = rx * 0.5523
    const ky = ry * 0.5523
    return {
      path: `M${rx} 0C${rx + kx} 0 ${w} ${ry - ky} ${w} ${ry}C${w} ${ry + ky} ${rx + kx} ${h} ${rx} ${h}C${rx - kx} ${h} 0 ${ry + ky} 0 ${ry}C0 ${ry - ky} ${rx - kx} 0 ${rx} 0Z`,
      pathBox: { w, h }
    }
  }
  return null
}

export class VectorEdit {
  /** layer being edited, or null */
  id: string | null = null
  private subs: Sub[] = []
  private sel = new Set<string>()
  private drag: Drag | null = null
  /** the path this state was read from / written as: when the layer shows another one (undo), read it again */
  private synced = ''
  private hover: Hit = null

  constructor(private invalidate: () => void) {}

  get active(): boolean {
    return this.id !== null
  }
  /** can this layer be opened for point editing? */
  static editable(n: GNode | undefined): boolean {
    return !!n && ((n.type === 'VECTOR' && !!n.path) || !!shapeAsPath(n))
  }

  start(id: string): boolean {
    let n = ed.nodes.get(id)
    if (!n || !VectorEdit.editable(n)) return false
    if (n.type !== 'VECTOR') {
      // a rectangle or an ellipse becomes a vector the moment its points are edited
      const p = shapeAsPath(n)!
      ed.act(() => ed.updateNode(id, { type: 'VECTOR', path: p.path, pathBox: p.pathBox, cornerRadius: undefined }))
      n = ed.nodes.get(id)!
    }
    this.id = id
    this.sel.clear()
    this.read()
    ed.setSelection([id])
    this.invalidate()
    return true
  }
  stop(): void {
    if (!this.id) return
    this.id = null
    this.drag = null
    this.hover = null
    this.sel.clear()
    this.invalidate()
  }

  // ---------------------------------------------------------------- path <-> anchors
  private node(): GNode | null {
    const n = this.id ? ed.nodes.get(this.id) : null
    return n?.type === 'VECTOR' && n.path ? n : null
  }
  private read(): void {
    const n = this.node()
    if (!n) return
    const r = ed.world(n.id)
    const sx = r.w / (n.pathBox?.w || r.w || 1)
    const sy = r.h / (n.pathBox?.h || r.h || 1)
    const segs = transformSegs(parsePath(n.path!), [sx, 0, 0, sy, r.x, r.y])
    const subs: Sub[] = []
    let cur: Sub | null = null
    for (const s of segs) {
      if (s.c === 'M') {
        cur = { closed: false, pts: [{ x: s.p[0], y: s.p[1] }] }
        subs.push(cur)
      } else if (!cur) continue
      else if (s.c === 'L') cur.pts.push({ x: s.p[0], y: s.p[1] })
      else if (s.c === 'C') {
        const prev = cur.pts[cur.pts.length - 1]
        const c1 = { x: s.p[0], y: s.p[1] }
        const c2 = { x: s.p[2], y: s.p[3] }
        const end = { x: s.p[4], y: s.p[5] }
        if (!same(c1, prev)) prev.out = c1
        cur.pts.push({ ...end, ...(same(c2, end) ? {} : { in: c2 }) })
      } else if (s.c === 'Z') {
        cur.closed = true
        // "…back to the first point, Z": the last anchor is the first one again
        const first = cur.pts[0]
        const last = cur.pts[cur.pts.length - 1]
        if (cur.pts.length > 1 && same(first, last)) {
          if (last.in) first.in = last.in
          cur.pts.pop()
        }
        cur = null
      }
    }
    this.subs = subs.filter((s) => s.pts.length)
    this.synced = n.path!
    for (const k of [...this.sel]) {
      const [s, i] = k.split(':').map(Number)
      if (!this.subs[s]?.pts[i]) this.sel.delete(k)
    }
  }
  private segs(): Seg[] {
    const out: Seg[] = []
    for (const sub of this.subs) {
      const p = sub.pts
      if (!p.length) continue
      out.push({ c: 'M', p: [p[0].x, p[0].y] })
      const seg = (a: Anchor, b: Anchor): Seg => (a.out || b.in ? { c: 'C', p: [(a.out ?? a).x, (a.out ?? a).y, (b.in ?? b).x, (b.in ?? b).y, b.x, b.y] } : { c: 'L', p: [b.x, b.y] })
      for (let i = 1; i < p.length; i++) out.push(seg(p[i - 1], p[i]))
      if (sub.closed) {
        // Z already draws a straight closing edge; only a curved one has to be spelled out
        if (p.length > 1 && (p[p.length - 1].out || p[0].in)) out.push(seg(p[p.length - 1], p[0]))
        out.push({ c: 'Z', p: [] })
      }
    }
    return out
  }
  /** Write the anchors back to the layer (inside an open transaction). */
  private write(): void {
    const n = this.node()
    if (!n) return
    const world = this.segs()
    if (!world.length) return
    const r = ed.world(n.id)
    if (ed.ancestors(n.id).some(hasTransform) || hasTransform(n)) {
      // keep the box: the path is stored relative to it and may reach outside
      const w = r.w || 1
      const h = r.h || 1
      const path = segsToD(transformSegs(world, [1, 0, 0, 1, -r.x, -r.y]))
      ed.updateNode(n.id, { path, pathBox: { w, h } })
      this.synced = path
    } else {
      const b = segsBounds(world)
      const w = Math.max(b.w, 0.01)
      const h = Math.max(b.h, 0.01)
      const path = segsToD(transformSegs(world, [1, 0, 0, 1, -b.x, -b.y]))
      const pw = n.parentId ? ed.world(n.parentId) : { x: 0, y: 0 }
      ed.updateNode(n.id, { x: round2(b.x - pw.x), y: round2(b.y - pw.y), width: w, height: h, path, pathBox: { w, h } })
      this.synced = path
    }
    ed.emit('doc')
  }
  /** one undoable change */
  private change(fn: () => void): void {
    ed.act(() => {
      fn()
      this.write()
    })
    this.invalidate()
  }

  // ---------------------------------------------------------------- geometry
  private at(r: Ref): Anchor {
    return this.subs[r.s].pts[r.i]
  }
  /** the segment that starts at anchor i of sub s (null past the open end) */
  private segment(s: number, i: number): [Anchor, Anchor] | null {
    const sub = this.subs[s]
    const j = i + 1
    if (j < sub.pts.length) return [sub.pts[i], sub.pts[j]]
    return sub.closed && sub.pts.length > 1 ? [sub.pts[i], sub.pts[0]] : null
  }
  private static point(a: Anchor, b: Anchor, t: number): Pt {
    if (!a.out && !b.in) return lerp(a, b, t)
    const c1 = a.out ?? a
    const c2 = b.in ?? b
    const u = 1 - t
    return {
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y
    }
  }
  /** what is under a point (layer space); tol in the same units */
  private hit(p: Pt, tol: number): Hit {
    // handles of the selected points first: they sit on top
    for (const k of this.sel) {
      const [s, i] = k.split(':').map(Number)
      const a = this.subs[s]?.pts[i]
      if (!a) continue
      for (const side of ['in', 'out'] as const) {
        const h = a[side]
        if (h && Math.hypot(h.x - p.x, h.y - p.y) <= tol) return { kind: 'handle', ref: { s, i }, side }
      }
    }
    for (const [s, sub] of this.subs.entries()) for (const [i, a] of sub.pts.entries()) if (Math.hypot(a.x - p.x, a.y - p.y) <= tol) return { kind: 'point', ref: { s, i } }
    let best: Hit = null
    let bestD = tol
    for (const [s, sub] of this.subs.entries())
      for (let i = 0; i < sub.pts.length; i++) {
        const seg = this.segment(s, i)
        if (!seg) continue
        for (let k = 1; k < 40; k++) {
          const t = k / 40
          const q = VectorEdit.point(seg[0], seg[1], t)
          const d = Math.hypot(q.x - p.x, q.y - p.y)
          if (d < bestD) {
            bestD = d
            best = { kind: 'segment', s, i, t, at: q }
          }
        }
      }
    return best
  }
  /** Split a segment at t with a new anchor; returns its index. */
  private split(s: number, i: number, t: number): number {
    const sub = this.subs[s]
    const seg = this.segment(s, i)!
    const [a, b] = seg
    let mid: Anchor
    if (!a.out && !b.in) mid = lerp(a, b, t)
    else {
      // de Casteljau: both halves keep the shape of the curve
      const c1 = a.out ?? a
      const c2 = b.in ?? b
      const p01 = lerp(a, c1, t)
      const p12 = lerp(c1, c2, t)
      const p23 = lerp(c2, b, t)
      const p012 = lerp(p01, p12, t)
      const p123 = lerp(p12, p23, t)
      mid = { ...lerp(p012, p123, t), in: p012, out: p123 }
      a.out = p01
      b.in = p23
    }
    sub.pts.splice(i + 1, 0, mid)
    return i + 1
  }
  /** corner <-> smooth */
  private toggleSmooth(r: Ref): void {
    const sub = this.subs[r.s]
    const a = sub.pts[r.i]
    if (a.in || a.out) {
      delete a.in
      delete a.out
      return
    }
    const n = sub.pts.length
    const prev = sub.pts[r.i - 1] ?? (sub.closed ? sub.pts[n - 1] : undefined)
    const next = sub.pts[r.i + 1] ?? (sub.closed ? sub.pts[0] : undefined)
    if (!prev && !next) return
    // handles along the line through the neighbours, a third of the way to each
    const from = prev ?? a
    const to = next ?? a
    const len = Math.hypot(to.x - from.x, to.y - from.y) || 1
    const ux = (to.x - from.x) / len
    const uy = (to.y - from.y) / len
    if (prev) {
      const d = Math.hypot(a.x - prev.x, a.y - prev.y) / 3
      a.in = { x: a.x - ux * d, y: a.y - uy * d }
    }
    if (next) {
      const d = Math.hypot(next.x - a.x, next.y - a.y) / 3
      a.out = { x: a.x + ux * d, y: a.y + uy * d }
    }
  }

  // ---------------------------------------------------------------- pointer
  private local(wx: number, wy: number): Pt {
    return this.id ? ed.toUnrotated(this.id, wx, wy) : { x: wx, y: wy }
  }
  private tol(): number {
    return 7 / ed.camera.zoom
  }

  /** returns true when the press belongs to the edit mode */
  down(wx: number, wy: number, e: PointerEvent): boolean {
    if (!this.node()) return false
    const p = this.local(wx, wy)
    const h = this.hit(p, this.tol())
    if (h?.kind === 'handle') {
      ed.begin()
      this.drag = { kind: 'handle', ref: h.ref, side: h.side, moved: false }
      return true
    }
    let ref: Ref | null = h?.kind === 'point' ? h.ref : null
    ed.begin()
    if (h?.kind === 'segment') {
      // a press on the outline adds a point there, ready to be dragged
      ref = { s: h.s, i: this.split(h.s, h.i, h.t) }
      // indices after the new point shifted
      this.sel.clear()
      this.write()
    }
    if (ref) {
      const k = key(ref)
      if (e.shiftKey) this.sel.has(k) ? this.sel.delete(k) : this.sel.add(k)
      else if (!this.sel.has(k)) {
        this.sel.clear()
        this.sel.add(k)
      }
      const orig = new Map<string, Anchor>()
      for (const q of this.sel) {
        const [s, i] = q.split(':').map(Number)
        const a = this.subs[s].pts[i]
        orig.set(q, { x: a.x, y: a.y, in: a.in && { ...a.in }, out: a.out && { ...a.out } })
      }
      this.drag = { kind: 'points', start: p, orig, moved: h?.kind === 'segment' }
    } else {
      // empty space: a marquee over the points
      this.drag = { kind: 'marquee', start: p, now: p, base: e.shiftKey ? new Set(this.sel) : new Set() }
      if (!e.shiftKey) this.sel.clear()
    }
    this.invalidate()
    return true
  }

  move(wx: number, wy: number, e: PointerEvent): boolean {
    if (!this.node()) return false
    const p = this.local(wx, wy)
    const d = this.drag
    if (!d) {
      const h = this.hit(p, this.tol())
      if (JSON.stringify(h) !== JSON.stringify(this.hover)) {
        this.hover = h
        this.invalidate()
      }
      return true
    }
    if (d.kind === 'points') {
      let dx = p.x - d.start.x
      let dy = p.y - d.start.y
      // Shift keeps the move horizontal or vertical
      if (e.shiftKey && d.moved) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0)
      if (!d.moved && Math.hypot(dx, dy) * ed.camera.zoom < 2) return true
      d.moved = true
      for (const [k, o] of d.orig) {
        const [s, i] = k.split(':').map(Number)
        const a = this.subs[s].pts[i]
        a.x = round2(o.x + dx)
        a.y = round2(o.y + dy)
        if (o.in) a.in = { x: o.in.x + dx, y: o.in.y + dy }
        if (o.out) a.out = { x: o.out.x + dx, y: o.out.y + dy }
      }
      this.write()
    } else if (d.kind === 'handle') {
      d.moved = true
      const a = this.at(d.ref)
      a[d.side] = { x: p.x, y: p.y }
      // the opposite handle stays in line (Alt breaks the pair, as in Figma)
      const other = d.side === 'in' ? 'out' : 'in'
      const o = a[other]
      if (o && !e.altKey) {
        const len = Math.hypot(o.x - a.x, o.y - a.y)
        const hl = Math.hypot(p.x - a.x, p.y - a.y) || 1
        a[other] = { x: a.x - ((p.x - a.x) / hl) * len, y: a.y - ((p.y - a.y) / hl) * len }
      }
      this.write()
    } else {
      d.now = p
      const x1 = Math.min(d.start.x, p.x)
      const x2 = Math.max(d.start.x, p.x)
      const y1 = Math.min(d.start.y, p.y)
      const y2 = Math.max(d.start.y, p.y)
      this.sel = new Set(d.base)
      for (const [s, sub] of this.subs.entries()) for (const [i, a] of sub.pts.entries()) if (a.x >= x1 && a.x <= x2 && a.y >= y1 && a.y <= y2) this.sel.add(key({ s, i }))
    }
    this.invalidate()
    return true
  }

  up(): boolean {
    const d = this.drag
    if (!d) return this.active
    this.drag = null
    // a gesture that changed nothing leaves no undo step behind
    ed.commit()
    this.invalidate()
    return true
  }

  /** double click: on a point = corner <-> curve; on empty space = leave the edit mode */
  dbl(wx: number, wy: number): boolean {
    if (!this.node()) return false
    const h = this.hit(this.local(wx, wy), this.tol())
    if (h?.kind === 'point') {
      this.change(() => this.toggleSmooth(h.ref))
      this.sel = new Set([key(h.ref)])
    } else if (!h) this.stop()
    return true
  }

  /** keys of the edit mode; true = handled */
  key(e: KeyboardEvent): boolean {
    if (!this.node()) return false
    if (e.key === 'Enter' || e.key === 'Escape') {
      this.stop()
      return true
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!this.sel.size) return true
      const gone = this.sel
      this.sel = new Set()
      let empty = false
      ed.act(() => {
        this.subs = this.subs
          .map((sub, s) => {
            const pts = sub.pts.filter((_, i) => !gone.has(key({ s, i })))
            // two points cannot enclose anything
            return { closed: sub.closed && pts.length > 2, pts }
          })
          .filter((sub) => sub.pts.length > 1)
        empty = !this.subs.length
        if (empty) ed.deleteNode(this.id!)
        else this.write()
      })
      if (empty) {
        ed.setSelection([])
        this.stop()
      }
      this.invalidate()
      return true
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const dir = arrows[e.key]
    if (dir && this.sel.size) {
      const step = e.shiftKey ? 10 : 1
      this.change(() => {
        for (const k of this.sel) {
          const [s, i] = k.split(':').map(Number)
          const a = this.subs[s].pts[i]
          for (const q of [a, a.in, a.out]) {
            if (!q) continue
            q.x += dir[0] * step
            q.y += dir[1] * step
          }
        }
      })
      return true
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyA') {
      this.sel = new Set(this.subs.flatMap((sub, s) => sub.pts.map((_, i) => key({ s, i }))))
      this.invalidate()
      return true
    }
    return false
  }

  /** the pointer shape over the edited layer */
  cursor(): string | null {
    if (!this.active) return null
    return this.hover?.kind === 'segment' ? 'copy' : this.hover ? 'move' : null
  }

  // ---------------------------------------------------------------- drawing
  /** Called with the canvas in screen space (CSS pixels). */
  draw(ctx: CanvasRenderingContext2D): void {
    const n = this.node()
    if (!n || ed.selection.length !== 1 || ed.selection[0] !== n.id) {
      // the layer is gone or something else got selected: the mode ends
      if (this.id) this.stop()
      return
    }
    // undo / redo changed the layer under us
    if (!this.drag && n.path !== this.synced) this.read()
    const { zoom, x, y } = ed.camera
    const px = 1 / zoom
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(zoom, zoom)
    for (const a of [...ed.ancestors(n.id).reverse(), n]) if (hasTransform(a)) applyNodeTransform(ctx, a, ed.world(a.id))
    const shape = new Path2D(segsToD(this.segs()))

    // zebra over the fillable area
    if (this.subs.some((s) => s.closed)) {
      ctx.save()
      ctx.clip(shape, n.fillRule ?? 'nonzero')
      const b = segsBounds(this.segs())
      const gap = 9 * px
      ctx.strokeStyle = BLUE
      ctx.globalAlpha = 0.75
      ctx.lineWidth = px
      ctx.beginPath()
      for (let d = -b.h; d < b.w + gap; d += gap) {
        ctx.moveTo(b.x + d, b.y + b.h)
        ctx.lineTo(b.x + d + b.h, b.y)
      }
      ctx.stroke()
      ctx.restore()
    }
    // the outline itself
    ctx.lineWidth = 3 * px
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.stroke(shape)
    ctx.lineWidth = px
    ctx.strokeStyle = '#6b6b6b'
    ctx.stroke(shape)

    // where a click would add a point
    if (!this.drag && this.hover?.kind === 'segment') {
      const q = this.hover.at
      ctx.beginPath()
      ctx.arc(q.x, q.y, 3.5 * px, 0, Math.PI * 2)
      ctx.fillStyle = BLUE
      ctx.fill()
      ctx.lineWidth = 1.5 * px
      ctx.strokeStyle = '#fff'
      ctx.stroke()
    }
    // handles of the selected points
    ctx.lineWidth = px
    for (const k of this.sel) {
      const [s, i] = k.split(':').map(Number)
      const a = this.subs[s]?.pts[i]
      if (!a) continue
      for (const h of [a.in, a.out]) {
        if (!h) continue
        ctx.strokeStyle = BLUE
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(h.x, h.y)
        ctx.stroke()
        // a small diamond, like Figma's handle ends
        const r = 3.5 * px
        ctx.beginPath()
        ctx.moveTo(h.x, h.y - r)
        ctx.lineTo(h.x + r, h.y)
        ctx.lineTo(h.x, h.y + r)
        ctx.lineTo(h.x - r, h.y)
        ctx.closePath()
        ctx.fillStyle = '#fff'
        ctx.fill()
        ctx.stroke()
      }
    }
    // anchors
    for (const [s, sub] of this.subs.entries())
      for (const [i, a] of sub.pts.entries()) {
        const on = this.sel.has(key({ s, i }))
        const hov = this.hover?.kind === 'point' && this.hover.ref.s === s && this.hover.ref.i === i
        ctx.beginPath()
        ctx.arc(a.x, a.y, (on || hov ? 4.5 : 3.5) * px, 0, Math.PI * 2)
        ctx.fillStyle = on ? BLUE : '#fff'
        ctx.fill()
        ctx.lineWidth = 1.5 * px
        ctx.strokeStyle = on ? '#fff' : BLUE
        ctx.stroke()
      }
    // marquee
    if (this.drag?.kind === 'marquee') {
      const d = this.drag
      ctx.fillStyle = 'rgba(13,153,255,0.12)'
      ctx.strokeStyle = BLUE
      ctx.lineWidth = px
      const rx = Math.min(d.start.x, d.now.x)
      const ry = Math.min(d.start.y, d.now.y)
      ctx.fillRect(rx, ry, Math.abs(d.now.x - d.start.x), Math.abs(d.now.y - d.start.y))
      ctx.strokeRect(rx, ry, Math.abs(d.now.x - d.start.x), Math.abs(d.now.y - d.start.y))
    }
    ctx.restore()
  }

  /** for the UI test scripts */
  state(): { id: string | null; subs: Sub[]; selected: string[] } {
    return { id: this.id, subs: this.subs, selected: [...this.sel] }
  }
}
