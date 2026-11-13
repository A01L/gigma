// Vector edit mode, as in Figma: double-click a vector to see its points. The mode has its own tools:
//   move   drag points, handles and segments; a marquee selects points
//   pen    add a point on the outline, continue an open path from its end, join two ends, start a new path
//   bend   click a point: corner <-> curve; drag a point: pull its handles; drag a segment: bend it
//   bucket click inside the shape: fill on / off
// The shape is hatched while it is being edited. Every gesture is one undo step.
//
// Points live in the unrotated world space of the layer (where editor.world() lives). After every change the
// layer's box is recomputed around the path; for a rotated or mirrored layer the points are shifted at the
// same time so that nothing moves on the screen while the pivot (the centre of the box) does.
import type { GNode } from '@shared/types'
import { editor as ed } from './editor'
import { applyNodeTransform, cornerRadiiOf, hasTransform } from './render'
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
export type VectorTool = 'move' | 'pen' | 'bend' | 'bucket'

type Drag =
  | { kind: 'points'; start: Pt; orig: Map<string, Anchor>; lead: string; moved: boolean }
  | { kind: 'handle'; ref: Ref; side: 'in' | 'out'; moved: boolean }
  /** bend / pen: pull a symmetric pair of handles out of a point; `fwd` follows the pointer */
  | { kind: 'pull'; ref: Ref; fwd: 'in' | 'out'; start: Pt; moved: boolean; click: 'toggle' | 'none' }
  /** bend: drag a segment so that the curve follows the pointer */
  | { kind: 'bendseg'; s: number; i: number; t: number; start: Pt; c1: Pt; c2: Pt }
  | { kind: 'marquee'; start: Pt; now: Pt; base: Set<string> }

const BLUE = '#0d99ff'
const key = (r: Ref) => r.s + ':' + r.i
const unkey = (k: string): Ref => ({ s: +k.split(':')[0], i: +k.split(':')[1] })
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const same = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6
const copy = (a: Anchor): Anchor => ({ x: a.x, y: a.y, in: a.in && { ...a.in }, out: a.out && { ...a.out } })

/** shapes that become a vector when their points are edited */
function shapeAsPath(n: GNode): { path: string; pathBox: { w: number; h: number } } | null {
  const w = n.width
  const h = n.height
  if (n.type === 'RECTANGLE') {
    // [top-left, top-right, bottom-right, bottom-left], each within half of the shorter side
    const [tl, tr, br, bl] = cornerRadiiOf(n, { w, h }) ?? [0, 0, 0, 0]
    const K = 0.5523
    let d = `M${tl} 0L${w - tr} 0`
    if (tr) d += `C${w - tr + tr * K} 0 ${w} ${tr - tr * K} ${w} ${tr}`
    d += `L${w} ${h - br}`
    if (br) d += `C${w} ${h - br + br * K} ${w - br + br * K} ${h} ${w - br} ${h}`
    d += `L${bl} ${h}`
    if (bl) d += `C${bl - bl * K} ${h} 0 ${h - bl + bl * K} 0 ${h - bl}`
    d += `L0 ${tl}`
    if (tl) d += `C0 ${tl - tl * K} ${tl - tl * K} 0 ${tl} 0`
    return { path: d + 'Z', pathBox: { w, h } }
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

let probe: CanvasRenderingContext2D | null = null

export class VectorEdit {
  /** layer being edited, or null */
  id: string | null = null
  /** tool of the edit mode (its own toolbar) */
  tool: VectorTool = 'move'
  private subs: Sub[] = []
  private sel = new Set<string>()
  private drag: Drag | null = null
  /** the path this state was read from / written as: when the layer shows another one (undo), read it again */
  private synced = ''
  private hover: Hit = null
  /** pen: the open end new points are added to */
  private pen: { s: number; end: 'start' | 'end' } | null = null
  private pointer: Pt | null = null
  /** snapping lines shown while points are dragged */
  private guides: { axis: 'x' | 'y'; pos: number }[] = []

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
      ed.act(() => ed.updateNode(id, { type: 'VECTOR', path: p.path, pathBox: p.pathBox, cornerRadius: undefined, cornerRadii: undefined }))
      n = ed.nodes.get(id)!
    }
    this.id = id
    this.tool = 'move'
    this.pen = null
    this.sel.clear()
    this.read()
    ed.setSelection([id])
    this.invalidate()
    ed.emit('ui')
    return true
  }
  stop(): void {
    if (!this.id) return
    // a path started with the pen and left at one point is not a path
    if (this.node() && this.subs.some((s) => s.pts.length < 2)) {
      this.subs = this.subs.filter((s) => s.pts.length > 1)
      if (this.subs.length) ed.act(() => this.write())
    }
    this.id = null
    this.drag = null
    this.hover = null
    this.pen = null
    this.guides = []
    this.sel.clear()
    this.invalidate()
    ed.emit('ui')
  }
  setTool(t: VectorTool): void {
    this.tool = t
    this.pen = null
    this.hover = null
    this.invalidate()
    ed.emit('ui')
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
    this.pen = null
    for (const k of [...this.sel]) {
      const { s, i } = unkey(k)
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
  /** every stored position moves by d (the layer's pivot moved; see write) */
  private shiftAll(dx: number, dy: number): void {
    const mv = (q?: Pt) => {
      if (q) {
        q.x += dx
        q.y += dy
      }
    }
    for (const sub of this.subs)
      for (const a of sub.pts) {
        mv(a)
        mv(a.in)
        mv(a.out)
      }
    const d = this.drag
    if (d?.kind === 'points') {
      mv(d.start)
      for (const o of d.orig.values()) {
        mv(o)
        mv(o.in)
        mv(o.out)
      }
    } else if (d?.kind === 'pull') mv(d.start)
    else if (d?.kind === 'bendseg') {
      mv(d.start)
      mv(d.c1)
      mv(d.c2)
    }
    if (this.pointer) mv(this.pointer)
  }
  /** Write the anchors back to the layer (inside an open transaction). */
  private write(): void {
    const n = this.node()
    if (!n) return
    let world = this.segs()
    if (!world.length) return
    const r = ed.world(n.id)
    if (ed.ancestors(n.id).some((a) => a.type === 'GROUP' && hasTransform(a))) {
      // inside a rotated group the group's own box would follow and turn everything: keep the layer's box,
      // the path is stored relative to it and may reach outside
      const w = r.w || 1
      const h = r.h || 1
      const path = segsToD(transformSegs(world, [1, 0, 0, 1, -r.x, -r.y]))
      ed.updateNode(n.id, { path, pathBox: { w, h } })
      this.synced = path
      ed.emit('doc')
      return
    }
    let b = segsBounds(world)
    if (hasTransform(n)) {
      // The layer turns around the centre of its box. The box is about to change, so shift the points by
      // (R - I)(newCentre - oldCentre): then every point stays where it is on the screen.
      const t = (-(n.rotation ?? 0) * Math.PI) / 180
      const fx = n.flipX ? -1 : 1
      const fy = n.flipY ? -1 : 1
      const vx = b.x + b.w / 2 - (r.x + r.w / 2)
      const vy = b.y + b.h / 2 - (r.y + r.h / 2)
      const rx = Math.cos(t) * vx * fx - Math.sin(t) * vy * fy
      const ry = Math.sin(t) * vx * fx + Math.cos(t) * vy * fy
      const dx = rx - vx
      const dy = ry - vy
      if (Math.abs(dx) + Math.abs(dy) > 1e-9) {
        this.shiftAll(dx, dy)
        world = this.segs()
        b = segsBounds(world)
      }
    }
    const w = Math.max(b.w, 0.01)
    const h = Math.max(b.h, 0.01)
    const path = segsToD(transformSegs(world, [1, 0, 0, 1, -b.x, -b.y]))
    const pw = n.parentId ? ed.world(n.parentId) : { x: 0, y: 0 }
    ed.updateNode(n.id, { x: round2(b.x - pw.x), y: round2(b.y - pw.y), width: w, height: h, path, pathBox: { w, h } })
    this.synced = path
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
  /** an end of an open path (the pen continues from there) */
  private endOf(r: Ref): 'start' | 'end' | null {
    const sub = this.subs[r.s]
    if (!sub || sub.closed) return null
    if (r.i === sub.pts.length - 1) return 'end'
    return r.i === 0 ? 'start' : null
  }
  /** what is under a point (layer space); tol in the same units */
  private hit(p: Pt, tol: number): Hit {
    // handles of the selected points first: they sit on top
    for (const k of this.sel) {
      const { s, i } = unkey(k)
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
  private inside(p: Pt): boolean {
    probe ??= document.createElement('canvas').getContext('2d')!
    return probe.isPointInPath(new Path2D(segsToD(this.segs())), p.x, p.y, this.node()?.fillRule ?? 'nonzero')
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
  private static reversed(sub: Sub): Anchor[] {
    return [...sub.pts].reverse().map((a) => ({ x: a.x, y: a.y, ...(a.out && { in: a.out }), ...(a.in && { out: a.in }) }))
  }

  // ---------------------------------------------------------------- snapping
  /** x and y positions points snap to: the other points of the path and the edges / centres of the neighbours */
  private snapTargets(moving: Set<string>): { xs: number[]; ys: number[] } {
    const xs: number[] = []
    const ys: number[] = []
    const n = this.node()
    if (!n) return { xs, ys }
    for (const [s, sub] of this.subs.entries())
      for (const [i, a] of sub.pts.entries()) {
        if (moving.has(key({ s, i }))) continue
        xs.push(a.x)
        ys.push(a.y)
      }
    // layer edges only line up with the path when nothing in between is turned
    if (!hasTransform(n) && !ed.ancestors(n.id).some(hasTransform)) {
      const others = ed.children(n.parentId, n.pageId).filter((id) => id !== n.id)
      if (n.parentId) others.push(n.parentId)
      for (const id of others.slice(0, 200)) {
        const o = ed.nodes.get(id)
        if (!o || !o.visible || hasTransform(o)) continue
        const r = ed.world(id)
        xs.push(r.x, r.x + r.w / 2, r.x + r.w)
        ys.push(r.y, r.y + r.h / 2, r.y + r.h)
      }
    }
    return { xs, ys }
  }

  // ---------------------------------------------------------------- pointer
  private local(wx: number, wy: number): Pt {
    return this.id ? ed.toUnrotated(this.id, wx, wy) : { x: wx, y: wy }
  }
  private tol(): number {
    return 7 / ed.camera.zoom
  }
  private selectOnly(r: Ref): void {
    this.sel.clear()
    this.sel.add(key(r))
  }
  private startPoints(ref: Ref, p: Pt, moved: boolean): void {
    const orig = new Map<string, Anchor>()
    for (const q of this.sel) orig.set(q, copy(this.at(unkey(q))))
    this.drag = { kind: 'points', start: { ...p }, orig, lead: key(ref), moved }
  }

  /** returns true when the press belongs to the edit mode */
  down(wx: number, wy: number, e: PointerEvent): boolean {
    if (!this.node()) return false
    const p = this.local(wx, wy)
    this.pointer = p
    const h = this.hit(p, this.tol())
    // Ctrl with the move tool is the bend tool for one gesture, as in Figma
    const tool: VectorTool = this.tool === 'move' && (e.ctrlKey || e.metaKey) ? 'bend' : this.tool
    ed.begin()

    if (tool === 'bucket') {
      const n = this.node()!
      if (this.inside(p)) {
        ed.updateNode(n.id, { fills: n.fills.some((f) => f.visible !== false) ? [] : [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85, a: 1 } }] })
        ed.emit('doc')
      }
      this.drag = { kind: 'marquee', start: p, now: p, base: new Set(this.sel) }
      this.invalidate()
      return true
    }

    if (tool === 'pen') return this.penDown(p, h)

    if (h?.kind === 'handle') {
      this.drag = { kind: 'handle', ref: h.ref, side: h.side, moved: false }
      return true
    }
    if (tool === 'bend') {
      if (h?.kind === 'point') {
        this.selectOnly(h.ref)
        this.drag = { kind: 'pull', ref: h.ref, fwd: 'out', start: { ...p }, moved: false, click: 'toggle' }
      } else if (h?.kind === 'segment') {
        const [a, b] = this.segment(h.s, h.i)!
        this.drag = { kind: 'bendseg', s: h.s, i: h.i, t: h.t, start: { ...p }, c1: { ...(a.out ?? a) }, c2: { ...(b.in ?? b) } }
      } else this.drag = { kind: 'marquee', start: p, now: p, base: new Set() }
      this.invalidate()
      return true
    }

    // move
    if (h?.kind === 'point') {
      const k = key(h.ref)
      if (e.shiftKey) this.sel.has(k) ? this.sel.delete(k) : this.sel.add(k)
      else if (!this.sel.has(k)) this.selectOnly(h.ref)
      this.startPoints(h.ref, p, false)
    } else if (h?.kind === 'segment') {
      // a segment is dragged by its two ends
      const sub = this.subs[h.s]
      const j = (h.i + 1) % sub.pts.length
      if (!e.shiftKey) this.sel.clear()
      this.sel.add(key({ s: h.s, i: h.i }))
      this.sel.add(key({ s: h.s, i: j }))
      this.startPoints({ s: h.s, i: h.i }, p, false)
    } else {
      // empty space: a marquee over the points
      this.drag = { kind: 'marquee', start: p, now: p, base: e.shiftKey ? new Set(this.sel) : new Set() }
      if (!e.shiftKey) this.sel.clear()
    }
    this.invalidate()
    return true
  }

  /** the pen inside the edit mode */
  private penDown(p: Pt, h: Hit): boolean {
    const grab = (ref: Ref, fwd: 'in' | 'out') => {
      this.selectOnly(ref)
      this.drag = { kind: 'pull', ref, fwd, start: { ...p }, moved: false, click: 'none' }
    }
    if (h?.kind === 'segment' && !this.pen) {
      // a point on the outline
      const i = this.split(h.s, h.i, h.t)
      this.write()
      this.selectOnly({ s: h.s, i })
      this.startPoints({ s: h.s, i }, p, true)
    } else if (h?.kind === 'point' && this.pen) {
      const end = this.endOf(h.ref)
      const active = this.subs[this.pen.s]
      if (h.ref.s === this.pen.s) {
        // the other end of the same path closes it; any other point of it just ends the drawing
        if (end && end !== this.pen.end && active.pts.length > 2) {
          active.closed = true
          this.write()
        }
        this.pen = null
        this.selectOnly(h.ref)
      } else if (end) {
        // an end of another path: the two become one
        const mine = this.pen.end === 'end' ? active.pts : VectorEdit.reversed(active)
        const theirs = end === 'start' ? this.subs[h.ref.s].pts : VectorEdit.reversed(this.subs[h.ref.s])
        const joined: Sub = { closed: false, pts: [...mine, ...theirs] }
        const drop = new Set([this.pen.s, h.ref.s])
        this.subs = [...this.subs.filter((_, s) => !drop.has(s)), joined]
        this.pen = null
        this.sel.clear()
        this.write()
      } else {
        this.pen = null
        this.selectOnly(h.ref)
      }
      this.drag = { kind: 'marquee', start: p, now: p, base: new Set(this.sel) }
    } else if (h?.kind === 'point') {
      const end = this.endOf(h.ref)
      // an open end: the next clicks continue the path from it
      if (end) this.pen = { s: h.ref.s, end }
      this.selectOnly(h.ref)
      this.drag = { kind: 'marquee', start: p, now: p, base: new Set(this.sel) }
    } else {
      // empty space: the next point of the path being drawn, or the first point of a new one
      const a: Anchor = { x: round2(p.x), y: round2(p.y) }
      if (!this.pen) {
        this.subs.push({ closed: false, pts: [a] })
        this.pen = { s: this.subs.length - 1, end: 'end' }
        grab({ s: this.pen.s, i: 0 }, 'out')
      } else if (this.pen.end === 'end') {
        const sub = this.subs[this.pen.s]
        sub.pts.push(a)
        this.write()
        grab({ s: this.pen.s, i: sub.pts.length - 1 }, 'out')
      } else {
        this.subs[this.pen.s].pts.unshift(a)
        this.write()
        grab({ s: this.pen.s, i: 0 }, 'in')
      }
    }
    this.invalidate()
    return true
  }

  move(wx: number, wy: number, e: PointerEvent): boolean {
    if (!this.node()) return false
    let p = this.local(wx, wy)
    this.pointer = p
    const d = this.drag
    if (!d) {
      const h = this.hit(p, this.tol())
      if (JSON.stringify(h) !== JSON.stringify(this.hover) || this.pen) {
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
      // snap the point under the pointer: to other points and layers first, to whole pixels otherwise
      this.guides = []
      const lead = d.orig.get(d.lead)
      if (lead && !(e.ctrlKey || e.metaKey)) {
        const { xs, ys } = this.snapTargets(new Set(d.orig.keys()))
        const tol = 5 / ed.camera.zoom
        const near = (v: number, list: number[]) => list.reduce<number | null>((best, t) => (Math.abs(t - v) <= tol && (best === null || Math.abs(t - v) < Math.abs(best - v)) ? t : best), null)
        const sx = dx !== 0 || !e.shiftKey ? near(lead.x + dx, xs) : null
        const sy = dy !== 0 || !e.shiftKey ? near(lead.y + dy, ys) : null
        if (sx !== null) this.guides.push({ axis: 'x', pos: sx })
        if (sy !== null) this.guides.push({ axis: 'y', pos: sy })
        dx = (sx ?? Math.round(lead.x + dx)) - lead.x
        dy = (sy ?? Math.round(lead.y + dy)) - lead.y
      }
      for (const [k, o] of d.orig) {
        const a = this.at(unkey(k))
        a.x = o.x + dx
        a.y = o.y + dy
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
    } else if (d.kind === 'pull') {
      if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) * ed.camera.zoom < 3) return true
      d.moved = true
      const a = this.at(d.ref)
      const back = d.fwd === 'out' ? 'in' : 'out'
      a[d.fwd] = { x: p.x, y: p.y }
      a[back] = { x: 2 * a.x - p.x, y: 2 * a.y - p.y }
      this.write()
      // write() may have shifted everything (rotated layer): the pointer moved with it
      p = this.pointer ?? p
    } else if (d.kind === 'bendseg') {
      // moving both control points by v moves the curve at t by 3t(1-t)·v
      const k = 3 * d.t * (1 - d.t)
      const vx = (p.x - d.start.x) / k
      const vy = (p.y - d.start.y) / k
      const [a, b] = this.segment(d.s, d.i)!
      a.out = { x: d.c1.x + vx, y: d.c1.y + vy }
      b.in = { x: d.c2.x + vx, y: d.c2.y + vy }
      this.write()
    } else {
      d.now = p
      if (this.tool !== 'bucket' && this.tool !== 'pen') {
        const x1 = Math.min(d.start.x, p.x)
        const x2 = Math.max(d.start.x, p.x)
        const y1 = Math.min(d.start.y, p.y)
        const y2 = Math.max(d.start.y, p.y)
        this.sel = new Set(d.base)
        for (const [s, sub] of this.subs.entries()) for (const [i, a] of sub.pts.entries()) if (a.x >= x1 && a.x <= x2 && a.y >= y1 && a.y <= y2) this.sel.add(key({ s, i }))
      }
    }
    this.invalidate()
    return true
  }

  up(): boolean {
    const d = this.drag
    if (!d) return this.active
    this.drag = null
    this.guides = []
    // the bend tool: a click on a point (no drag) switches it between corner and curve
    if (d.kind === 'pull' && !d.moved && d.click === 'toggle') {
      this.toggleSmooth(d.ref)
      this.write()
    }
    // a gesture that changed nothing leaves no undo step behind
    ed.commit()
    this.invalidate()
    return true
  }

  /** double click: on a point = corner <-> curve; on empty space = leave the edit mode (or end the pen path) */
  dbl(wx: number, wy: number): boolean {
    if (!this.node()) return false
    if (this.pen) {
      this.pen = null
      this.invalidate()
      return true
    }
    const h = this.hit(this.local(wx, wy), this.tol())
    if (h?.kind === 'point' && this.tool === 'move') {
      this.change(() => this.toggleSmooth(h.ref))
      this.sel = new Set([key(h.ref)])
    } else if (!h && this.tool === 'move') this.stop()
    return true
  }

  /** keys of the edit mode; true = handled */
  key(e: KeyboardEvent): boolean {
    if (!this.node()) return false
    if (e.key === 'Enter' || e.key === 'Escape') {
      // first end the path being drawn, then the tool, then the mode
      if (this.pen) {
        this.pen = null
        this.invalidate()
      } else if (this.tool !== 'move' && e.key === 'Escape') this.setTool('move')
      else this.stop()
      return true
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const tools: Record<string, VectorTool> = { KeyV: 'move', KeyP: 'pen', KeyB: 'bucket' }
      if (tools[e.code]) {
        this.setTool(tools[e.code])
        return true
      }
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!this.sel.size) return true
      const gone = this.sel
      this.sel = new Set()
      this.pen = null
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
          const a = this.at(unkey(k))
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
    if (this.tool === 'pen') return 'crosshair'
    if (this.tool === 'bucket') return 'cell'
    if (this.tool === 'bend') return this.hover ? 'pointer' : null
    return this.hover ? 'move' : null
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
      ctx.globalAlpha = n.fills.some((f) => f.visible !== false) ? 0.75 : 0.3
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

    // snapping lines
    if (this.guides.length) {
      const v = ed.visibleWorldRect()
      ctx.strokeStyle = '#f24822'
      ctx.lineWidth = px
      ctx.beginPath()
      for (const g of this.guides) {
        if (g.axis === 'x') {
          ctx.moveTo(g.pos, v.y - v.h)
          ctx.lineTo(g.pos, v.y + v.h * 2)
        } else {
          ctx.moveTo(v.x - v.w, g.pos)
          ctx.lineTo(v.x + v.w * 2, g.pos)
        }
      }
      ctx.stroke()
    }
    // the pen: a line from the open end to the pointer shows the next segment
    if (this.pen && !this.drag && this.pointer && this.subs[this.pen.s]) {
      const sub = this.subs[this.pen.s]
      const a = this.pen.end === 'end' ? sub.pts[sub.pts.length - 1] : sub.pts[0]
      const h = this.pen.end === 'end' ? a.out : a.in
      ctx.strokeStyle = BLUE
      ctx.lineWidth = 1.5 * px
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      if (h) ctx.bezierCurveTo(h.x, h.y, this.pointer.x, this.pointer.y, this.pointer.x, this.pointer.y)
      else ctx.lineTo(this.pointer.x, this.pointer.y)
      ctx.stroke()
    }
    // where a click of the pen would add a point
    if (!this.drag && this.hover?.kind === 'segment' && this.tool === 'pen' && !this.pen) {
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
      const { s, i } = unkey(k)
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
        // the end the pen draws from is marked
        const live = this.pen?.s === s && i === (this.pen.end === 'end' ? sub.pts.length - 1 : 0)
        ctx.beginPath()
        ctx.arc(a.x, a.y, (on || hov || live ? 4.5 : 3.5) * px, 0, Math.PI * 2)
        ctx.fillStyle = on || live ? BLUE : '#fff'
        ctx.fill()
        ctx.lineWidth = 1.5 * px
        ctx.strokeStyle = on || live ? '#fff' : BLUE
        ctx.stroke()
      }
    // marquee
    if (this.drag?.kind === 'marquee' && this.tool !== 'bucket' && this.tool !== 'pen') {
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
  state(): { id: string | null; tool: VectorTool; subs: Sub[]; selected: string[]; pen: { s: number; end: 'start' | 'end' } | null; guides: { axis: 'x' | 'y'; pos: number }[] } {
    return { id: this.id, tool: this.tool, subs: this.subs, selected: [...this.sel], pen: this.pen, guides: this.guides }
  }
}

/** the edit mode of the canvas, for the toolbar */
export const vectorEdit: { current: VectorEdit | null } = { current: null }
