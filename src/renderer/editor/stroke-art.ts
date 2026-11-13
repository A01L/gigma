// Strokes that are more than a line of one width: a width profile, a dynamic (hand-shaken) line and brushes.
// Everything here is plain vector geometry made from the path of the layer, so the canvas, the SVG / PDF export and
// "Outline stroke" all get the same shape:
//   area  a closed outline that is filled with the colour of the stroke (profiles, brushes)
//   line  another centre line that is stroked as usual (dynamic strokes)
import type { BrushName, GNode } from '@shared/types'
import { parsePath, segsToD, type Seg } from './svgpath'

export type Profile = NonNullable<GNode['strokeProfile']>
export const PROFILE_LABELS: Record<Profile, string> = {
  UNIFORM: 'Uniform',
  TAPER: 'Taper',
  WEDGE: 'Wedge',
  LENS: 'Lens',
  BLADE: 'Blade',
  DROP: 'Drop',
  PINCH: 'Pinch'
}
/** share of the weight a profile gives at t (0 = start of the path, 1 = its end) */
export function profileAt(profile: Profile, t: number): number {
  switch (profile) {
    case 'TAPER':
      return 1 - t
    case 'WEDGE':
      return 0.25 + 0.75 * (1 - t)
    case 'LENS':
      return Math.sin(Math.PI * t)
    case 'BLADE':
      // swells fast, thins out slowly
      return t < 0.25 ? Math.sin((t / 0.25) * (Math.PI / 2)) : Math.cos(((t - 0.25) / 0.75) * (Math.PI / 2))
    case 'DROP':
      // a round head and a long tail
      return t < 0.12 ? Math.sqrt(1 - (1 - t / 0.12) ** 2) : (1 - (t - 0.12) / 0.88) ** 1.6
    case 'PINCH':
      return 0.2 + 0.8 * Math.abs(Math.cos(Math.PI * t))
    default:
      return 1
  }
}

export const BRUSHES: { name: BrushName; label: string; kind: 'STRETCH' | 'SCATTER' }[] = [
  { name: 'INK', label: 'Ink', kind: 'STRETCH' },
  { name: 'MARKER', label: 'Marker', kind: 'STRETCH' },
  { name: 'CALLIGRAPHY', label: 'Calligraphy', kind: 'STRETCH' },
  { name: 'CHARCOAL', label: 'Charcoal', kind: 'STRETCH' },
  { name: 'DRY', label: 'Dry brush', kind: 'STRETCH' },
  { name: 'DOTS', label: 'Dots', kind: 'SCATTER' },
  { name: 'SPLATTER', label: 'Splatter', kind: 'SCATTER' },
  { name: 'HATCH', label: 'Hatch', kind: 'SCATTER' }
]
export const brushKind = (name: BrushName): 'STRETCH' | 'SCATTER' => BRUSHES.find((b) => b.name === name)?.kind ?? 'STRETCH'
export const DEFAULT_DYNAMIC = { frequency: 50, wiggle: 30, smoothen: 50 }
export const DEFAULT_BRUSH: NonNullable<GNode['strokeBrush']> = { name: 'INK' }

// ---------------------------------------------------------------- helpers
/** the same numbers for the same path every time: a brush must not flicker while the canvas is redrawn */
function seeded(text: string): () => number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  let s = h >>> 0 || 1
  return () => {
    // mulberry32
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** smooth noise in -1..1 over a line: random values at whole numbers, eased in between */
function noiseLine(rand: () => number): (x: number) => number {
  const vals: number[] = []
  const at = (i: number) => {
    while (vals.length <= i) vals.push(rand() * 2 - 1)
    return vals[i]
  }
  return (x: number) => {
    const i = Math.floor(Math.max(0, x))
    const f = Math.max(0, x) - i
    const k = (1 - Math.cos(f * Math.PI)) / 2
    return at(i) * (1 - k) + at(i + 1) * k
  }
}

interface Sample {
  x: number
  y: number
  /** unit normal (to the left of the direction of the path) */
  nx: number
  ny: number
  /** 0..1 along the piece */
  t: number
  /** distance from the start of the piece */
  s: number
}
interface Piece {
  pts: Sample[]
  length: number
  closed: boolean
}
let meter: SVGPathElement | null = null
/** points along every piece of a path (from one M to the next), about `step` pixels apart */
function samplePath(d: string, step: number, max = 600): Piece[] {
  meter ??= document.createElementNS('http://www.w3.org/2000/svg', 'path')
  const pieces: Seg[][] = []
  for (const s of parsePath(d)) {
    if (s.c === 'M' || !pieces.length) pieces.push([])
    pieces[pieces.length - 1].push(s)
  }
  const out: Piece[] = []
  for (const piece of pieces) {
    meter.setAttribute('d', segsToD(piece))
    const length = meter.getTotalLength()
    if (!(length > 0.01)) continue
    const count = Math.max(8, Math.min(max, Math.ceil(length / step)))
    const pts: Sample[] = []
    for (let i = 0; i <= count; i++) {
      const t = i / count
      const p = meter.getPointAtLength(length * t)
      // the direction of the path here, from the points just before and after
      const a = meter.getPointAtLength(Math.max(0, length * t - 0.5))
      const b = meter.getPointAtLength(Math.min(length, length * t + 0.5))
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
      pts.push({ x: p.x, y: p.y, nx: -(b.y - a.y) / len, ny: (b.x - a.x) / len, t, s: length * t })
    }
    out.push({ pts, length, closed: piece.some((s) => s.c === 'Z') })
  }
  return out
}
const f = (v: number) => String(Math.round(v * 100) / 100)
/** a closed band around a line of samples: `half(i)` is its half width at sample i, `shift(i)` moves it across */
function band(pts: Sample[], half: (i: number) => number, shift: (i: number) => number = () => 0): string {
  const left: string[] = []
  const right: string[] = []
  pts.forEach((p, i) => {
    const h = Math.max(0, half(i))
    const o = shift(i)
    left.push(`${f(p.x + p.nx * (o + h))} ${f(p.y + p.ny * (o + h))}`)
    right.push(`${f(p.x + p.nx * (o - h))} ${f(p.y + p.ny * (o - h))}`)
  })
  return 'M' + left.join('L') + 'L' + right.reverse().join('L') + 'Z'
}
const circle = (x: number, y: number, r: number) => `M${f(x - r)} ${f(y)}A${f(r)} ${f(r)} 0 1 0 ${f(x + r)} ${f(y)}A${f(r)} ${f(r)} 0 1 0 ${f(x - r)} ${f(y)}Z`

// ---------------------------------------------------------------- the three kinds
function profileArea(d: string, weight: number, profile: Profile, flip: boolean): string {
  let out = ''
  for (const piece of samplePath(d, 2, 400)) out += band(piece.pts, (i) => (weight / 2) * profileAt(profile, flip ? 1 - piece.pts[i].t : piece.pts[i].t))
  return out
}

/** a line that shakes around the path: how often (frequency), how far (wiggle), and how much of it is ironed out (smoothen) */
function dynamicLine(d: string, weight: number, o: NonNullable<GNode['strokeDynamic']>): string {
  const rand = seeded('dyn' + d)
  let out = ''
  for (const piece of samplePath(d, 1.5, 1200)) {
    const noise = noiseLine(rand)
    const fine = noiseLine(rand)
    // frequency 0 = one slow wave every 160 px, 100 = a shiver every 5 px
    const wave = 160 * Math.pow(5 / 160, Math.max(0, Math.min(100, o.frequency)) / 100)
    const reach = (Math.max(0, Math.min(100, o.wiggle)) / 100) * Math.max(weight * 3, 12)
    const n = piece.pts.length
    let pts = piece.pts.map((p) => {
      // an open line starts and ends where the path does
      const hold = piece.closed ? 1 : Math.min(1, p.s / wave, (piece.length - p.s) / wave)
      const off = (noise(p.s / wave) + fine((p.s / wave) * 2.7) * 0.35) * reach * hold
      return [p.x + p.nx * off, p.y + p.ny * off] as [number, number]
    })
    // smoothen: every point becomes the mean of its neighbours, a few times over
    const passes = Math.round((Math.max(0, Math.min(100, o.smoothen)) / 100) * 8)
    for (let k = 0; k < passes; k++) {
      pts = pts.map((p, i) => {
        if (!piece.closed && (i === 0 || i === n - 1)) return p
        const a = pts[(i - 1 + n) % n]
        const b = pts[(i + 1) % n]
        return [(a[0] + p[0] * 2 + b[0]) / 4, (a[1] + p[1] * 2 + b[1]) / 4] as [number, number]
      })
    }
    out += 'M' + pts.map((p) => `${f(p[0])} ${f(p[1])}`).join('L') + (piece.closed ? 'Z' : '')
  }
  return out
}

function brushArea(d: string, weight: number, o: NonNullable<GNode['strokeBrush']>): string {
  const rand = seeded(o.name + d)
  const hw = weight / 2
  const flip = !!o.flip
  let out = ''
  const kind = brushKind(o.name)
  if (kind === 'STRETCH') {
    for (const piece of samplePath(d, o.name === 'CHARCOAL' ? 1 : 1.5, 900)) {
      const T = (i: number) => (flip ? 1 - piece.pts[i].t : piece.pts[i].t)
      const slow = noiseLine(rand)
      const edgeA = noiseLine(rand)
      const edgeB = noiseLine(rand)
      const S = (i: number) => piece.pts[i].s
      if (o.name === 'INK') {
        // swells and thins like a loaded pen, ends in points
        out += band(piece.pts, (i) => hw * (0.3 + 0.7 * Math.pow(Math.sin(Math.PI * T(i)), 0.55)) * (1 + slow(S(i) / (weight * 4 + 20)) * 0.22) * Math.min(1, T(i) * 14, (1 - T(i)) * 14))
      } else if (o.name === 'MARKER') {
        // full width with a slightly uneven edge and a slanted nib
        out += band(piece.pts, (i) => hw * (1 + edgeA(S(i) / 3) * 0.06), (i) => edgeB(S(i) / 40) * hw * 0.08)
      } else if (o.name === 'CALLIGRAPHY') {
        // a flat nib held at 45°: thick across it, thin along it
        out += band(piece.pts, (i) => {
          const p = piece.pts[i]
          // the normal across the nib direction (1, -1)/√2
          return hw * (0.14 + 0.86 * Math.abs(p.nx * Math.SQRT1_2 - p.ny * Math.SQRT1_2))
        })
      } else if (o.name === 'CHARCOAL') {
        // a rough, crumbling edge, and crumbs beside it
        out += band(
          piece.pts,
          (i) => hw * (0.78 + edgeA(S(i) / 1.6) * 0.2 + slow(S(i) / 30) * 0.1),
          (i) => edgeB(S(i) / 2.2) * hw * 0.16
        )
        const crumbs = Math.min(500, Math.round(piece.length / 3))
        for (let k = 0; k < crumbs; k++) {
          const p = piece.pts[Math.floor(rand() * piece.pts.length)]
          const side = rand() < 0.5 ? -1 : 1
          const off = side * hw * (0.85 + rand() * 0.45)
          out += circle(p.x + p.nx * off + (rand() - 0.5) * 2, p.y + p.ny * off + (rand() - 0.5) * 2, Math.max(0.35, weight * 0.035 * (0.5 + rand())))
        }
      } else {
        // DRY: a handful of bristles, each with gaps where it ran out of paint
        const bristles = Math.max(4, Math.min(9, Math.round(weight / 2.5)))
        for (let b = 0; b < bristles; b++) {
          const across = ((b + 0.5) / bristles) * 2 - 1
          const own = noiseLine(rand)
          const wet = noiseLine(rand)
          const width = (hw / bristles) * (0.7 + rand() * 0.5)
          let run: Sample[] = []
          const flush = () => {
            if (run.length > 2) {
              const base = piece.pts.indexOf(run[0])
              out += band(run, () => width, (i) => across * hw * 0.9 + own((S(base + i) / 25)) * hw * 0.06)
            }
            run = []
          }
          piece.pts.forEach((p, i) => {
            // the paint thins towards the end of the stroke: more and longer gaps there
            if (wet(S(i) / 14 + b * 7) > -0.25 - 0.7 * (1 - T(i))) run.push(p)
            else flush()
          })
          flush()
        }
      }
    }
    return out
  }
  // scatter brushes: stamps along the path
  const gap = Math.max(weight * 0.25, (o.gap ?? 100) / 100 * weight * 1.2)
  const wiggle = ((o.wiggle ?? 20) / 100) * weight * 1.5
  const jitter = Math.max(0, Math.min(100, o.sizeJitter ?? 30)) / 100
  const turn = ((o.rotation ?? 0) * Math.PI) / 180
  for (const piece of samplePath(d, Math.max(0.5, gap / 4), 2400)) {
    let next = 0
    let stamps = 0
    for (const p of flip ? [...piece.pts].reverse() : piece.pts) {
      const s = flip ? piece.length - p.s : p.s
      if (s < next || stamps > 1500) continue
      next = s + gap * (0.75 + rand() * 0.5)
      stamps++
      const size = hw * (1 - jitter * rand())
      const off = (rand() * 2 - 1) * wiggle
      const x = p.x + p.nx * off
      const y = p.y + p.ny * off
      if (o.name === 'DOTS') out += circle(x, y, Math.max(0.4, size))
      else if (o.name === 'SPLATTER') {
        // a blob with a few drops thrown around it
        out += circle(x, y, Math.max(0.4, size * 0.8))
        const drops = 2 + Math.floor(rand() * 4)
        for (let k = 0; k < drops; k++) {
          const a = rand() * Math.PI * 2
          const far = size * (1.1 + rand() * 1.6)
          out += circle(x + Math.cos(a) * far, y + Math.sin(a) * far, Math.max(0.3, size * (0.12 + rand() * 0.25)))
        }
      } else {
        // HATCH: a short stroke across the path, turned by the rotation and a little by chance
        const a = Math.atan2(p.ny, p.nx) + turn + (rand() - 0.5) * 0.5 * jitter
        const lx = Math.cos(a) * size * 1.6
        const ly = Math.sin(a) * size * 1.6
        const tx = -Math.sin(a) * Math.max(0.4, weight * 0.06)
        const ty = Math.cos(a) * Math.max(0.4, weight * 0.06)
        out += `M${f(x - lx + tx)} ${f(y - ly + ty)}L${f(x + lx + tx)} ${f(y + ly + ty)}L${f(x + lx - tx)} ${f(y + ly - ty)}L${f(x - lx - tx)} ${f(y - ly - ty)}Z`
      }
    }
  }
  return out
}

const cache = new Map<string, { area?: string; line?: string } | null>()
/**
 * What replaces the plain stroke of a layer, or null when the stroke is a plain one. `d` is the outline of the layer at
 * its real size; the result is in the same coordinates.
 */
export function strokeArt(n: GNode, weight: number, d: string | null): { area?: string; line?: string } | null {
  if (!d || !(weight > 0)) return null
  const brush = n.strokeBrush
  const dyn = n.strokeDynamic
  const profile = n.strokeProfile && n.strokeProfile !== 'UNIFORM' ? n.strokeProfile : null
  if (!brush && !dyn && !profile) return null
  const key = JSON.stringify([brush ?? null, dyn ?? null, brush || dyn ? null : [profile, !!n.strokeProfileFlip], weight]) + d
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  let res: { area?: string; line?: string } | null
  if (brush) res = { area: brushArea(d, weight, brush) }
  else if (dyn) res = { line: dynamicLine(d, weight, dyn) }
  else res = { area: profileArea(d, weight, profile!, !!n.strokeProfileFlip) }
  if (!res.area && !res.line) res = null
  if (cache.size > 300) cache.clear()
  cache.set(key, res)
  return res
}
