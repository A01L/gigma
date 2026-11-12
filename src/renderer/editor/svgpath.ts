// SVG path utilities: parse any path, normalize to absolute M/L/C/Z
// (arcs and quadratics become cubics), apply affine matrices, compute bounds.

export type Seg = { c: 'M' | 'L' | 'C' | 'Z'; p: number[] }
export type Mat = [number, number, number, number, number, number] // a b c d e f

const PARAMS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }

function tokenize(d: string): (string | number)[] {
  const out: (string | number)[] = []
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(d))) out.push(m[1] ?? parseFloat(m[2]))
  return out
}

function arcToCubics(x1: number, y1: number, rx: number, ry: number, phi: number, fa: number, fs: number, x2: number, y2: number): number[][] {
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]]
  const sin = Math.sin((phi * Math.PI) / 180)
  const cos = Math.cos((phi * Math.PI) / 180)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cos * dx + sin * dy
  const y1p = -sin * dx + cos * dy
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lam > 1) {
    rx *= Math.sqrt(lam)
    ry *= Math.sqrt(lam)
  }
  const sign = fa === fs ? -1 : 1
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const co = sign * Math.sqrt(Math.max(0, num / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)))
  const cxp = (co * rx * y1p) / ry
  const cyp = (-co * ry * x1p) / rx
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    return a
  }
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!fs && dt > 0) dt -= Math.PI * 2
  if (fs && dt < 0) dt += Math.PI * 2
  const segs = Math.ceil(Math.abs(dt) / (Math.PI / 2))
  const out: number[][] = []
  const delta = dt / segs
  const k = (4 / 3) * Math.tan(delta / 4)
  let t = t1
  for (let i = 0; i < segs; i++) {
    const c1 = Math.cos(t), s1 = Math.sin(t)
    const c2 = Math.cos(t + delta), s2 = Math.sin(t + delta)
    const pts = [
      [c1 - k * s1, s1 + k * c1],
      [c2 + k * s2, s2 - k * c2],
      [c2, s2]
    ].map(([px, py]) => {
      const X = px * rx
      const Y = py * ry
      return [cos * X - sin * Y + cx, sin * X + cos * Y + cy]
    })
    out.push([...pts[0], ...pts[1], ...pts[2]])
    t += delta
  }
  return out
}

export function parsePath(d: string): Seg[] {
  const tk = tokenize(d)
  const out: Seg[] = []
  let i = 0
  let cmd = ''
  let x = 0, y = 0, sx = 0, sy = 0
  let lcx = 0, lcy = 0 // last control point (for S/T)
  let lastCmd = ''
  while (i < tk.length) {
    if (typeof tk[i] === 'string') cmd = tk[i++] as string
    else if (!cmd) break
    const up = cmd.toUpperCase()
    const rel = cmd !== up
    const n = PARAMS[up]
    if (up === 'Z') {
      out.push({ c: 'Z', p: [] })
      x = sx
      y = sy
      lastCmd = 'Z'
      continue
    }
    if (i + n > tk.length) break
    const a = tk.slice(i, i + n) as number[]
    i += n
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    switch (up) {
      case 'M':
        x = a[0] + ox
        y = a[1] + oy
        sx = x
        sy = y
        out.push({ c: 'M', p: [x, y] })
        cmd = rel ? 'l' : 'L'
        break
      case 'L':
        x = a[0] + ox
        y = a[1] + oy
        out.push({ c: 'L', p: [x, y] })
        break
      case 'H':
        x = a[0] + ox
        out.push({ c: 'L', p: [x, y] })
        break
      case 'V':
        y = a[0] + oy
        out.push({ c: 'L', p: [x, y] })
        break
      case 'C': {
        const p = [a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy, a[4] + ox, a[5] + oy]
        out.push({ c: 'C', p })
        lcx = p[2]
        lcy = p[3]
        x = p[4]
        y = p[5]
        break
      }
      case 'S': {
        const r = lastCmd === 'C' || lastCmd === 'S'
        const c1x = r ? 2 * x - lcx : x
        const c1y = r ? 2 * y - lcy : y
        const p = [c1x, c1y, a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy]
        out.push({ c: 'C', p })
        lcx = p[2]
        lcy = p[3]
        x = p[4]
        y = p[5]
        break
      }
      case 'Q':
      case 'T': {
        let qx: number, qy: number, ex: number, ey: number
        if (up === 'Q') {
          qx = a[0] + ox
          qy = a[1] + oy
          ex = a[2] + ox
          ey = a[3] + oy
        } else {
          const r = lastCmd === 'Q' || lastCmd === 'T'
          qx = r ? 2 * x - lcx : x
          qy = r ? 2 * y - lcy : y
          ex = a[0] + ox
          ey = a[1] + oy
        }
        out.push({ c: 'C', p: [x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey] })
        lcx = qx
        lcy = qy
        x = ex
        y = ey
        break
      }
      case 'A': {
        const ex = a[5] + ox
        const ey = a[6] + oy
        for (const c of arcToCubics(x, y, a[0], a[1], a[2], a[3], a[4], ex, ey)) out.push({ c: 'C', p: c })
        x = ex
        y = ey
        break
      }
    }
    lastCmd = up
  }
  return out
}

export function transformSegs(segs: Seg[], m: Mat): Seg[] {
  const [a, b, c, d, e, f] = m
  return segs.map((s) => {
    const p = s.p.slice()
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i], y = p[i + 1]
      p[i] = a * x + c * y + e
      p[i + 1] = b * x + d * y + f
    }
    return { c: s.c, p }
  })
}

export function segsBounds(segs: Seg[]): { x: number; y: number; w: number; h: number } {
  // tight-ish bounds: endpoints + sampled cubic curves
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  const add = (x: number, y: number) => {
    if (x < x1) x1 = x
    if (x > x2) x2 = x
    if (y < y1) y1 = y
    if (y > y2) y2 = y
  }
  let cx = 0, cy = 0
  for (const s of segs) {
    if (s.c === 'C') {
      const [ax, ay, bx, by, ex, ey] = s.p
      for (let i = 1; i <= 16; i++) {
        const t = i / 16, u = 1 - t
        add(
          u * u * u * cx + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * ex,
          u * u * u * cy + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * ey
        )
      }
      cx = ex
      cy = ey
    } else if (s.p.length) {
      cx = s.p[0]
      cy = s.p[1]
      add(cx, cy)
    }
  }
  if (x1 === Infinity) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

const fmt = (v: number) => String(Math.round(v * 1000) / 1000)

export function segsToD(segs: Seg[]): string {
  return segs.map((s) => s.c + s.p.map(fmt).join(' ')).join('')
}

export const matMul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5]
]
