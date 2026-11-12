// Geometry for the shape tools: polygon, star, line/arrow, and pencil smoothing.
import type { Seg } from './svgpath'
import { segsToD } from './svgpath'

/** Regular polygon inscribed in a w×h box (first vertex at top, like Figma). */
export function polygonPath(sides: number, w: number, h: number): string {
  const pts: string[] = []
  for (let i = 0; i < sides; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / sides
    pts.push(`${(w / 2 + (Math.cos(a) * w) / 2).toFixed(3)} ${(h / 2 + (Math.sin(a) * h) / 2).toFixed(3)}`)
  }
  return 'M' + pts.join('L') + 'Z'
}

/** Star with `points` tips; ratio = inner radius / outer radius (Figma default 0.382). */
export function starPath(points: number, ratio: number, w: number, h: number): string {
  const pts: string[] = []
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / points
    const r = i % 2 ? ratio : 1
    pts.push(`${(w / 2 + (Math.cos(a) * r * w) / 2).toFixed(3)} ${(h / 2 + (Math.sin(a) * r * h) / 2).toFixed(3)}`)
  }
  return 'M' + pts.join('L') + 'Z'
}

/** Triangle at the end of a path pointing along the last segment's direction. */
export function arrowHeadPoints(segs: Seg[], weight: number): [number, number][] | null {
  // find last two distinct points
  const pts: [number, number][] = []
  for (const s of segs) {
    if (s.c === 'C') pts.push([s.p[2], s.p[3]], [s.p[4], s.p[5]])
    else if (s.p.length) pts.push([s.p[0], s.p[1]])
  }
  if (pts.length < 2) return null
  const end = pts[pts.length - 1]
  let k = pts.length - 2
  while (k >= 0 && Math.hypot(pts[k][0] - end[0], pts[k][1] - end[1]) < 1e-6) k--
  if (k < 0) return null
  const prev = pts[k]
  const ang = Math.atan2(end[1] - prev[1], end[0] - prev[0])
  const len = Math.max(8, weight * 4.5)
  const half = Math.max(4, weight * 2.6)
  const bx = end[0] - Math.cos(ang) * len
  const by = end[1] - Math.sin(ang) * len
  return [
    [end[0], end[1]],
    [bx + Math.cos(ang + Math.PI / 2) * half, by + Math.sin(ang + Math.PI / 2) * half],
    [bx - Math.cos(ang + Math.PI / 2) * half, by - Math.sin(ang + Math.PI / 2) * half]
  ]
}

/** Ramer–Douglas–Peucker simplification. */
function simplify(points: [number, number][], tol: number): [number, number][] {
  if (points.length < 3) return points
  const [a, b] = [points[0], points[points.length - 1]]
  let maxD = 0
  let idx = 0
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  for (let i = 1; i < points.length - 1; i++) {
    const d = Math.abs(dy * points[i][0] - dx * points[i][1] + b[0] * a[1] - b[1] * a[0]) / len
    if (d > maxD) {
      maxD = d
      idx = i
    }
  }
  if (maxD <= tol) return [a, b]
  return [...simplify(points.slice(0, idx + 1), tol).slice(0, -1), ...simplify(points.slice(idx), tol)]
}

/** Freehand pencil stroke -> smooth path (Catmull-Rom converted to cubics). */
export function smoothPath(raw: [number, number][], tol = 1.5): string {
  const p = simplify(raw, tol)
  if (p.length < 2) return p.length ? `M${p[0][0]} ${p[0][1]}` : ''
  const segs: Seg[] = [{ c: 'M', p: [p[0][0], p[0][1]] }]
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i]
    const p1 = p[i]
    const p2 = p[i + 1]
    const p3 = p[i + 2] ?? p2
    segs.push({
      c: 'C',
      p: [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]]
    })
  }
  return segsToD(segs)
}
