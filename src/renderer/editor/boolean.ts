// Boolean operations (Union / Subtract / Intersect / Exclude) and Flatten.
// A boolean group is a GROUP with `booleanOperation`: its children stay editable and the
// group is drawn as one shape computed from them, exactly like Figma's boolean groups.
// The geometry is exact (Bézier curves stay curves): paper.js does the path maths.
import paper from 'paper/dist/paper-core'
import type { BooleanOperation, GNode } from '@shared/types'
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
  const m = new paper.Matrix()
  m.translate(n.x + n.width / 2, n.y + n.height / 2)
  if (n.rotation) m.rotate(-n.rotation, 0, 0)
  if (n.flipX || n.flipY) m.scale(n.flipX ? -1 : 1, n.flipY ? -1 : 1)
  m.translate(-n.width / 2, -n.height / 2)
  item.transform(m)
  return item
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
