// Boolean operations (Union / Subtract / Intersect / Exclude) and Flatten.
// A boolean group is a GROUP with `booleanOperation`: its children stay editable and the
// group is drawn as one shape computed from them, exactly like Figma's boolean groups.
// The geometry is exact (Bézier curves stay curves): paper.js does the path maths.
import paper from 'paper/dist/paper-core'
import type { BooleanOperation, CapKind, GNode } from '@shared/types'
import { capsOf, endCut, endShape, joinOf, miterLimitOf, profileOutline } from './stroke'
import type { Editor } from './editor'
import { cornerRadiiOf } from './render'
import { parsePath, segsToD, transformSegs } from './svgpath'

type PathItem = InstanceType<typeof paper.PathItem>
type PPath = InstanceType<typeof paper.Path>

let ready = false
function setup(): void {
  if (ready) return
  paper.setup(new paper.Size(1, 1))
  // items are only used for maths, never drawn by paper
  paper.settings.insertItems = false
  ready = true
}

const f = (v: number) => String(Math.round(v * 1000) / 1000)

/** outline of a single layer in its own coordinates (0,0 .. width,height); null when it has no area */
export function shapeD(n: GNode): string | null {
  const w = n.width
  const h = n.height
  if (w <= 0 || h <= 0) return null
  switch (n.type) {
    case 'ELLIPSE':
      return `M0 ${f(h / 2)}A${f(w / 2)} ${f(h / 2)} 0 1 1 ${f(w)} ${f(h / 2)}A${f(w / 2)} ${f(h / 2)} 0 1 1 0 ${f(h / 2)}Z`
    case 'VECTOR': {
      if (!n.path) return null
      const sx = w / (n.pathBox?.w || w)
      const sy = h / (n.pathBox?.h || h)
      return segsToD(transformSegs(parsePath(n.path), [sx, 0, 0, sy, 0, 0]))
    }
    case 'RECTANGLE':
    case 'IMAGE':
    case 'FRAME':
    case 'SECTION': {
      const rr = cornerRadiiOf(n, { w, h })
      if (!rr) return `M0 0H${f(w)}V${f(h)}H0Z`
      const [tl, tr, br, bl] = rr
      const arc = (r: number, x: number, y: number) => (r > 0 ? `A${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(y)}` : `L${f(x)} ${f(y)}`)
      return `M${f(tl)} 0H${f(w - tr)}${arc(tr, w, tr)}V${f(h - br)}${arc(br, w - br, h)}H${f(bl)}${arc(bl, 0, h - bl)}V${f(tl)}${arc(tl, tl, 0)}Z`
    }
    default:
      return null
  }
}

function combine(items: PathItem[], op: BooleanOperation): PathItem | null {
  if (!items.length) return null
  let acc = items[0]
  for (let i = 1; i < items.length; i++) {
    const b = items[i]
    acc = op === 'UNION' ? acc.unite(b) : op === 'SUBTRACT' ? acc.subtract(b) : op === 'INTERSECT' ? acc.intersect(b) : acc.exclude(b)
  }
  return acc
}

/** the layer (with its children) as a paper path in its parent's coordinate space */
function itemOf(ed: Editor, id: string): PathItem | null {
  const n = ed.nodes.get(id)
  if (!n || !n.visible) return null
  let item: PathItem | null = null
  if (n.type === 'GROUP') {
    const kids = ed.children(id, n.pageId).map((c) => itemOf(ed, c)).filter((x): x is PathItem => !!x)
    item = combine(kids, n.booleanOperation ?? 'UNION')
  } else {
    // a stroke-only vector (a line) has no area to combine
    if (n.type === 'VECTOR' && !n.fills.some((p) => p.visible !== false)) return null
    const d = shapeD(n)
    if (!d) return null
    item = paper.PathItem.create(d)
    if (n.type === 'VECTOR') {
      if (n.fillRule === 'evenodd') item.fillRule = 'evenodd'
      // filling closes open paths implicitly; do the same before combining
      for (const p of item instanceof paper.CompoundPath ? (item.children as PPath[]) : [item as PPath]) p.closed = true
    }
  }
  if (!item) return null
  item.transform(nodeMatrix(n))
  return item
}

/** local coordinates of a layer -> its parent's coordinates (position, rotation, flip) */
function nodeMatrix(n: GNode): InstanceType<typeof paper.Matrix> {
  const m = new paper.Matrix()
  m.translate(n.x + n.width / 2, n.y + n.height / 2)
  if (n.rotation) m.rotate(-n.rotation, 0, 0)
  if (n.flipX || n.flipY) m.scale(n.flipX ? -1 : 1, n.flipY ? -1 : 1)
  m.translate(-n.width / 2, -n.height / 2)
  return m
}

/** union of many pieces, pairwise (keeps every single union small) */
function unionAll(items: PathItem[]): PathItem | null {
  while (items.length > 1) {
    const next: PathItem[] = []
    for (let i = 0; i < items.length; i += 2) next.push(i + 1 < items.length ? items[i].unite(items[i + 1]) : items[i])
    items = next
  }
  return items[0] ?? null
}

/** Area covered by a stroke of `weight` centred on the outline of `item` (curves are followed in small steps). */
function centerStroke(item: PathItem, weight: number, join: 'miter' | 'bevel' | 'round', limit: number, caps: { start: CapKind; end: CapKind }): PathItem | null {
  const hw = weight / 2
  const round = join === 'round'
  const pieces: PathItem[] = []
  const poly = (pts: number[][]) => pieces.push(new paper.Path({ segments: pts, closed: true }))
  // what is added at the ends of open paths goes on top of the line, after the part an arrow head hides is cut away
  const tips: PathItem[] = []
  const cuts: PathItem[] = []
  for (const src of item instanceof paper.CompoundPath ? (item.children as PPath[]) : [item as PPath]) {
    const p = src.clone() as PPath
    p.flatten(0.2)
    const pts = p.segments.map((s) => s.point).filter((q, i, a) => i === 0 || q.getDistance(a[i - 1]) > 1e-4)
    const closed = p.closed
    if (closed && pts.length > 2 && pts[0].getDistance(pts[pts.length - 1]) < 1e-4) pts.pop()
    const n = pts.length
    if (n < 2) continue
    const dir = (i: number) => pts[(i + 1) % n].subtract(pts[i]).normalize()
    const segs = closed ? n : n - 1
    for (let i = 0; i < segs; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % n]
      const u = dir(i)
      const nx = -u.y * hw
      const ny = u.x * hw
      poly([[a.x + nx, a.y + ny], [b.x + nx, b.y + ny], [b.x - nx, b.y - ny], [a.x - nx, a.y - ny]])
    }
    // joins
    for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
      const v = pts[i]
      if (round) {
        pieces.push(new paper.Path.Circle(v, hw))
        continue
      }
      const u = dir((i - 1 + n) % n)
      const w = dir(i)
      const cross = u.x * w.y - u.y * w.x
      if (Math.abs(cross) < 1e-6) continue
      // the wedge on the outer side of the corner
      const s = cross > 0 ? -1 : 1
      const n1 = new paper.Point(-u.y * s, u.x * s)
      const n2 = new paper.Point(-w.y * s, w.x * s)
      const sum = n1.add(n2)
      const k = sum.length / 2 // cos of half the turning angle
      const p1 = v.add(n1.multiply(hw))
      const p2 = v.add(n2.multiply(hw))
      // a miter as long as the limit allows, a bevel past it
      if (join === 'miter' && k > 1e-6 && 1 / k <= limit) {
        const m = v.add(sum.normalize().multiply(hw / k))
        poly([[v.x, v.y], [p1.x, p1.y], [m.x, m.y], [p2.x, p2.y]])
      } else poly([[v.x, v.y], [p1.x, p1.y], [p2.x, p2.y]])
    }
    // caps of open paths
    if (!closed) {
      for (const [v, u, kind] of [[pts[0], dir(0).multiply(-1), caps.start], [pts[n - 1], dir(n - 2), caps.end]] as const) {
        // the same shapes the canvas draws at the ends: plain caps and arrows
        const end = { x: v.x, y: v.y, dx: u.x, dy: u.y }
        const shape = endShape(kind, end, weight)
        if (!shape) continue
        const cut = endCut(kind, end, weight)
        if (cut) cuts.push(new paper.Path({ segments: cut, closed: true }))
        for (const p of shape.polys) tips.push(new paper.Path({ segments: p, closed: true }))
        if (shape.circle) tips.push(new paper.Path.Circle(new paper.Point(shape.circle.x, shape.circle.y), shape.circle.r))
        if (shape.line) {
          const arrow = centerStroke(new paper.Path({ segments: shape.line, closed: false }), weight, 'miter', 10, { start: 'NONE', end: 'NONE' })
          if (arrow) tips.push(arrow)
        }
      }
    }
  }
  let line = unionAll(pieces)
  if (line) for (const c of cuts) line = line.subtract(c)
  return unionAll(line ? [line, ...tips] : tips)
}

export interface OutlineResult {
  d: string
  x: number
  y: number
  w: number
  h: number
  fillRule: 'nonzero' | 'evenodd'
}

function finish(item: PathItem | null): OutlineResult | null {
  if (!item || item.isEmpty()) return null
  const b = item.bounds
  item.translate(new paper.Point(-b.x, -b.y))
  return { d: item.pathData, x: b.x, y: b.y, w: b.width, h: b.height, fillRule: item.fillRule === 'evenodd' ? 'evenodd' : 'nonzero' }
}

/**
 * "Outline stroke": the area painted by the first visible stroke of a layer as a filled path
 * in world coordinates. Rectangles and ellipses give exact shapes; other paths are traced.
 */
export function strokeOutline(ed: Editor, id: string): OutlineResult | null {
  setup()
  const n = ed.nodes.get(id)
  const s = n?.strokes.find((x) => x.visible !== false && x.weight > 0)
  if (!n || !s) return null
  const w = s.weight
  const simple = n.type === 'RECTANGLE' || n.type === 'ELLIPSE' || n.type === 'FRAME' || n.type === 'IMAGE' || n.type === 'SECTION'
  const bool = isBooleanGroup(n)
  const closed = n.type !== 'VECTOR' || /z/i.test(n.path ?? '')
  const align = closed ? (s.align ?? 'CENTER') : 'CENTER'
  let ring: PathItem | null = null
  if (simple) {
    // exact: the shape grown by one distance minus the shape shrunk by another
    const grown = (d: number): PathItem | null => {
      const v: GNode = { ...n, width: n.width + d * 2, height: n.height + d * 2 }
      const rr = cornerRadiiOf(n, { w: n.width, h: n.height })
      if (rr) {
        v.cornerRadii = rr.map((r) => (r > 0 ? Math.max(0, r + d) : 0)) as [number, number, number, number]
        v.cornerRadius = undefined
      }
      const dd = shapeD(v)
      if (!dd) return null
      const it = paper.PathItem.create(dd)
      it.translate(new paper.Point(-d, -d))
      return it
    }
    const [o, i] = align === 'INSIDE' ? [0, -w] : align === 'OUTSIDE' ? [w, 0] : [w / 2, -w / 2]
    const outer = grown(o)
    const inner = grown(i)
    ring = outer && inner ? outer.subtract(inner) : outer
  } else if (n.type === 'VECTOR' || bool) {
    let shape: PathItem | null = null
    if (bool) shape = combine(ed.children(id, n.pageId).map((c) => itemOf(ed, c)).filter((x): x is PathItem => !!x), n.booleanOperation!)
    else if (n.path) {
      const sx = n.width / (n.pathBox?.w || n.width || 1)
      const sy = n.height / (n.pathBox?.h || n.height || 1)
      shape = paper.PathItem.create(segsToD(transformSegs(parsePath(n.path), [sx, 0, 0, sy, 0, 0])))
    }
    if (!shape) return null
    const join = joinOf(n)
    const limit = miterLimitOf(n)
    const caps = capsOf(n)
    // a stroke with a width profile is already an area
    const profiled = !bool && n.strokeProfile && n.strokeProfile !== 'UNIFORM' ? profileOutline(shape.pathData, w, n.strokeProfile, !!n.strokeProfileFlip) : null
    if (profiled) ring = paper.PathItem.create(profiled)
    else if (align === 'CENTER') ring = centerStroke(shape, w, join, limit, caps)
    else {
      const wide = centerStroke(shape, w * 2, join, limit, caps)
      ring = wide ? (align === 'INSIDE' ? wide.intersect(shape) : wide.subtract(shape)) : null
    }
  }
  if (!ring) return null
  ring.transform(nodeMatrix(n))
  const pw = n.parentId ? ed.world(n.parentId) : { x: 0, y: 0 }
  ring.translate(new paper.Point(pw.x, pw.y))
  return finish(ring)
}

/** everything that changes the result: geometry of the whole subtree */
function signature(ed: Editor, id: string): string {
  const n = ed.nodes.get(id)!
  let s = [n.type, n.x, n.y, n.width, n.height, n.rotation ?? 0, n.flipX ? 1 : 0, n.flipY ? 1 : 0, n.visible ? 1 : 0, n.cornerRadius ?? 0, n.cornerRadii?.join(',') ?? '', n.booleanOperation ?? '', n.fillRule ?? '', n.type === 'VECTOR' ? n.fills.length : 0, n.path ?? '', n.pathBox?.w ?? 0, n.pathBox?.h ?? 0].join('|')
  if (n.type === 'GROUP') for (const c of ed.children(id, n.pageId)) s += '[' + signature(ed, c) + ']'
  return s
}

interface Result {
  sig: string
  d: string
  fillRule: 'nonzero' | 'evenodd'
}
const cache = new Map<string, Result>()

/** Path of a boolean group in the group's own coordinates (0,0 = its top-left corner). */
export function booleanResult(ed: Editor, id: string): Result | null {
  const n = ed.nodes.get(id)
  if (!n || n.type !== 'GROUP' || !n.booleanOperation) return null
  const sig = signature(ed, id)
  const hit = cache.get(id)
  if (hit && hit.sig === sig) return hit
  setup()
  let res: Result = { sig, d: '', fillRule: 'nonzero' }
  try {
    const kids = ed.children(id, n.pageId).map((c) => itemOf(ed, c)).filter((x): x is PathItem => !!x)
    const item = combine(kids, n.booleanOperation)
    if (item && !item.isEmpty()) res = { sig, d: item.pathData, fillRule: item.fillRule === 'evenodd' ? 'evenodd' : 'nonzero' }
  } catch (e) {
    console.warn('boolean operation failed', e)
  }
  if (cache.size > 2000) cache.clear()
  cache.set(id, res)
  return res
}

/** A boolean group seen as the single vector it draws (used by the renderer and the SVG export). */
export function booleanAsVector(ed: Editor, n: GNode): GNode {
  const r = booleanResult(ed, n.id)
  return { ...n, type: 'VECTOR', path: r?.d ?? '', pathBox: { w: n.width, h: n.height }, fillRule: r?.fillRule }
}

export const isBooleanGroup = (n: GNode | undefined): boolean => !!n && n.type === 'GROUP' && !!n.booleanOperation

/**
 * Outline of any selection as one path in world coordinates (union of the layers), for Flatten.
 * Returns the path with its bounding box, or null when nothing has an area.
 */
export function flattenPath(ed: Editor, ids: string[]): { d: string; x: number; y: number; w: number; h: number; fillRule: 'nonzero' | 'evenodd' } | null {
  setup()
  const items: PathItem[] = []
  for (const id of ids) {
    const n = ed.nodes.get(id)
    if (!n) continue
    const it = itemOf(ed, id)
    if (!it) continue
    // itemOf works in the parent's space: move it to the page
    const pw = n.parentId ? ed.world(n.parentId) : { x: 0, y: 0 }
    it.translate(new paper.Point(pw.x, pw.y))
    items.push(it)
  }
  const item = combine(items, 'UNION')
  if (!item || item.isEmpty()) return null
  const b = item.bounds
  item.translate(new paper.Point(-b.x, -b.y))
  return { d: item.pathData, x: b.x, y: b.y, w: b.width, h: b.height, fillRule: item.fillRule === 'evenodd' ? 'evenodd' : 'nonzero' }
}
