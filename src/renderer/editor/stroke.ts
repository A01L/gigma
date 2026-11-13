// Stroke settings shared by the canvas, the SVG export and "Outline stroke": what the two ends of an open path
// look like, how corners are joined, dashes, and a stroke whose width changes along the path (width profile).
import type { CapKind, GNode } from '@shared/types'
import { parsePath, segsToD, transformSegs, type Seg } from './svgpath'

export const CAP_KINDS: CapKind[] = ['NONE', 'ROUND', 'SQUARE', 'LINE_ARROW', 'TRIANGLE_ARROW', 'REVERSED_TRIANGLE', 'CIRCLE_ARROW', 'DIAMOND_ARROW']
export const CAP_LABELS: Record<CapKind, string> = {
  NONE: 'None',
  ROUND: 'Round',
  SQUARE: 'Square',
  LINE_ARROW: 'Line arrow',
  TRIANGLE_ARROW: 'Triangle arrow',
  REVERSED_TRIANGLE: 'Reversed triangle',
  CIRCLE_ARROW: 'Circle arrow',
  DIAMOND_ARROW: 'Diamond arrow'
}
/** Figma's default miter angle: corners sharper than this are cut off (a miter limit of 4) */
export const DEFAULT_MITER_ANGLE = 28.96

/** the ends of an open path. Older documents have one cap for both ends and a flag for the arrow of the Arrow tool */
export function capsOf(n: GNode): { start: CapKind; end: CapKind } {
  return { start: n.strokeStartCap ?? n.strokeCap ?? 'NONE', end: n.strokeEndCap ?? (n.arrowEnd ? 'TRIANGLE_ARROW' : (n.strokeCap ?? 'NONE')) }
}
export const joinOf = (n: GNode): 'miter' | 'bevel' | 'round' => (n.strokeJoin ? (n.strokeJoin.toLowerCase() as 'miter' | 'bevel' | 'round') : n.strokeCap === 'ROUND' ? 'round' : 'miter')
/** miter limit (miter length / stroke weight) of the node's miter angle */
export function miterLimitOf(n: GNode): number {
  const a = Math.max(1, Math.min(180, n.strokeMiterAngle ?? DEFAULT_MITER_ANGLE))
  return 1 / Math.sin((a * Math.PI) / 360)
}
/** canvas / SVG name of a plain cap; arrows have none */
export const plainCap = (k: CapKind): 'butt' | 'round' | 'square' | null => (k === 'NONE' ? 'butt' : k === 'ROUND' ? 'round' : k === 'SQUARE' ? 'square' : null)
export const dashOf = (n: GNode): [number, number] | null => (n.dashPattern && n.dashPattern[0] > 0 ? [n.dashPattern[0], Math.max(0, n.dashPattern[1])] : null)
export const isOpenPath = (n: GNode): boolean => n.type === 'VECTOR' && !!n.path && !/z/i.test(n.path)

export interface PathEnd {
  x: number
  y: number
  /** unit vector pointing out of the path at this end */
  dx: number
  dy: number
}
/** where a path starts and ends, and which way it leaves there */
export function pathEnds(segs: Seg[]): { start: PathEnd; end: PathEnd } | null {
  const pts: [number, number][] = []
  for (const s of segs) {
    if (s.c === 'C') pts.push([s.p[0], s.p[1]], [s.p[2], s.p[3]], [s.p[4], s.p[5]])
    else if (s.p.length >= 2) pts.push([s.p[s.p.length - 2], s.p[s.p.length - 1]])
  }
  if (pts.length < 2) return null
  const dirFrom = (at: [number, number], rest: [number, number][]): PathEnd | null => {
    // the first point that is not on top of the end gives the direction (a handle may sit on its anchor)
    for (const q of rest) {
      const d = Math.hypot(at[0] - q[0], at[1] - q[1])
      if (d > 1e-6) return { x: at[0], y: at[1], dx: (at[0] - q[0]) / d, dy: (at[1] - q[1]) / d }
    }
    return null
  }
  const start = dirFrom(pts[0], pts.slice(1))
  const end = dirFrom(pts[pts.length - 1], pts.slice(0, -1).reverse())
  return start && end ? { start, end } : null
}

export interface EndShape {
  /** filled polygons */
  polys: [number, number][][]
  /** filled circle */
  circle?: { x: number; y: number; r: number }
  /** an open line drawn with the weight of the stroke (the line arrow) */
  line?: [number, number][]
}
/** What an end of a stroke of that weight looks like. Null for a butt end, which adds nothing. */
export function endShape(kind: CapKind, e: PathEnd, weight: number): EndShape | null {
  if (kind === 'NONE') return null
  const hw = weight / 2
  const nx = -e.dy
  const ny = e.dx
  const at = (along: number, across: number): [number, number] => [e.x + e.dx * along + nx * across, e.y + e.dy * along + ny * across]
  if (kind === 'ROUND') return { polys: [], circle: { x: e.x, y: e.y, r: hw } }
  if (kind === 'SQUARE') return { polys: [[at(0, hw), at(hw, hw), at(hw, -hw), at(0, -hw)]] }
  // arrows grow with the stroke, and never get too small to be seen
  const len = Math.max(8, weight * 4.5)
  const half = Math.max(4, weight * 2.6)
  if (kind === 'TRIANGLE_ARROW') return { polys: [[at(0, 0), at(-len, half), at(-len, -half)]] }
  if (kind === 'REVERSED_TRIANGLE') return { polys: [[at(-len, 0), at(0, half), at(0, -half)]] }
  if (kind === 'DIAMOND_ARROW') return { polys: [[at(half, 0), at(0, half), at(-half, 0), at(0, -half)]] }
  if (kind === 'CIRCLE_ARROW') return { polys: [], circle: { x: e.x, y: e.y, r: half } }
  return { polys: [], line: [at(-len, half), at(0, 0), at(-len, -half)] }
}

/**
 * The part of the line an arrow head must hide. The line runs to the tip of a triangle arrow, where the triangle is
 * narrower than the line, so its square end would stick out on both sides: that last bit of the line is not drawn.
 */
export function endCut(kind: CapKind, e: PathEnd, weight: number): [number, number][] | null {
  if (kind !== 'TRIANGLE_ARROW') return null
  const len = Math.max(8, weight * 4.5)
  const half = Math.max(4, weight * 2.6)
  // from the tip back to where the triangle is as wide as the line
  const back = Math.min(len, (weight * len) / (2 * half) + 0.5)
  const nx = -e.dy
  const ny = e.dx
  const at = (along: number, across: number): [number, number] => [e.x + e.dx * along + nx * across, e.y + e.dy * along + ny * across]
  return [at(-back, weight), at(weight, weight), at(weight, -weight), at(-back, -weight)]
}

/** the path of a vector node at its real size, in its own coordinates (0,0 = its top left corner) */
export function sizedPath(n: GNode): Seg[] {
  const sx = n.width / (n.pathBox?.w || n.width || 1)
  const sy = n.height / (n.pathBox?.h || n.height || 1)
  return transformSegs(parsePath(n.path ?? ''), [sx, 0, 0, sy, 0, 0])
}

const endsCache = new Map<string, ReturnType<typeof pathEnds>>()
/** the two ends of a vector node's path at its real size, in its own coordinates */
export function nodeEnds(n: GNode): ReturnType<typeof pathEnds> {
  const key = `${n.width}|${n.height}|${n.pathBox?.w}|${n.pathBox?.h}|${n.path}`
  let e = endsCache.get(key)
  if (e === undefined) {
    e = pathEnds(sizedPath(n))
    if (endsCache.size > 2000) endsCache.clear()
    endsCache.set(key, e)
  }
  return e
}
