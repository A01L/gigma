// ---------- ids ----------
export const uid = (): string => crypto.randomUUID()

// ---------- fractional indexing (z-order keys) ----------
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'
const BASE = DIGITS.length

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`bad key range ${a} ${b}`)
  let n = 0
  while (b !== null && (a[n] ?? '0') === b[n]) n++
  if (n > 0) return b!.slice(0, n) + midpoint(a.slice(n), b!.slice(n))
  const da = a ? DIGITS.indexOf(a[0]) : 0
  const db = b !== null ? DIGITS.indexOf(b[0]) : BASE
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]
  if (b !== null && b.length > 1) return b.slice(0, 1)
  return DIGITS[da] + midpoint(a.slice(1), null)
}

/** Key strictly between a and b (null = open end). Keys sort lexicographically. */
export function keyBetween(a: string | null, b: string | null): string {
  return midpoint(a ?? '', b)
}

// ---------- geometry ----------
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const rectsIntersect = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

export const rectContains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h

export function unionRects(rs: Rect[]): Rect | null {
  if (!rs.length) return null
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const r of rs) {
    x1 = Math.min(x1, r.x)
    y1 = Math.min(y1, r.y)
    x2 = Math.max(x2, r.x + r.w)
    y2 = Math.max(y2, r.y + r.h)
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

export const round2 = (v: number): number => Math.round(v * 100) / 100

export function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH))
  return btoa(s)
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
