// Gradient geometry shared by the renderer, the handles on the canvas, the fill popover and the SVG export.
// A gradient is placed by three handles in the units of the layer's box (as in Figma): start, end, width.
import type { GradientPaint, GradientStop, RGBA, UnitPoint } from '@shared/types'
import { rgbaToCss } from '@shared/types'

export type Handles = [UnitPoint, UnitPoint, UnitPoint]

/** the handles of a gradient: the stored ones, or the ones its angle (linear) or the box (others) give */
export function handlesOf(p: GradientPaint, w: number, h: number): Handles {
  if (p.handles) return p.handles
  w = w || 1
  h = h || 1
  if (p.type === 'GRADIENT_LINEAR') {
    // CSS angle: the line runs through the centre and reaches the corners
    const a = ((p.angle ?? 180) * Math.PI) / 180
    const dx = Math.sin(a)
    const dy = -Math.cos(a)
    const L = Math.abs((w / 2) * dx) + Math.abs((h / 2) * dy)
    const s = { x: 0.5 - (dx * L) / w, y: 0.5 - (dy * L) / h }
    const e = { x: 0.5 + (dx * L) / w, y: 0.5 + (dy * L) / h }
    return [s, e, across(s, e, w, h)]
  }
  // a circle around the centre that reaches the far sides
  const r = Math.max(w, h) / 2
  return [{ x: 0.5, y: 0.5 }, { x: 0.5 + r / w, y: 0.5 }, { x: 0.5, y: 0.5 + r / h }]
}

/** the width handle that keeps the gradient "round": across the line, as long as the line (in pixels) */
export function across(s: UnitPoint, e: UnitPoint, w: number, h: number): UnitPoint {
  const vx = (e.x - s.x) * w
  const vy = (e.y - s.y) * h
  return { x: s.x + -vy / (w || 1), y: s.y + vx / (h || 1) }
}

/** CSS angle of a line between two handles (for programs that only read `angle`) */
export function angleOf(hd: Handles, w: number, h: number): number {
  const vx = (hd[1].x - hd[0].x) * w
  const vy = (hd[1].y - hd[0].y) * h
  const a = (Math.atan2(vx, -vy) * 180) / Math.PI
  return Math.round((((a % 360) + 360) % 360) * 100) / 100
}

export const sortedStops = (stops: GradientStop[]): GradientStop[] => [...stops].sort((a, b) => a.position - b.position)

/** the colour of a gradient at t (0..1): what a new stop placed there gets */
export function colorAt(stops: GradientStop[], t: number): RGBA {
  const s = sortedStops(stops)
  if (!s.length) return { r: 0.85, g: 0.85, b: 0.85, a: 1 }
  if (t <= s[0].position) return { ...s[0].color }
  for (let i = 1; i < s.length; i++) {
    if (t > s[i].position) continue
    const a = s[i - 1]
    const b = s[i]
    const k = b.position === a.position ? 0 : (t - a.position) / (b.position - a.position)
    return { r: a.color.r + (b.color.r - a.color.r) * k, g: a.color.g + (b.color.g - a.color.g) * k, b: a.color.b + (b.color.b - a.color.b) * k, a: a.color.a + (b.color.a - a.color.a) * k }
  }
  return { ...s[s.length - 1].color }
}

const stopsCss = (p: GradientPaint, unit = '%', k = 100) =>
  sortedStops(p.stops)
    .map((s) => `${rgbaToCss(s.color)} ${Math.round(s.position * k * 100) / 100}${unit}`)
    .join(', ')

/** the stops as a flat bar, left to right (the bar of the popover, the row of the panel) */
export const barCss = (p: GradientPaint): string => `linear-gradient(90deg, ${stopsCss(p)})`

/** a small preview of the gradient for a swatch */
export function previewCss(p: GradientPaint): string {
  if (p.type === 'GRADIENT_RADIAL' || p.type === 'GRADIENT_DIAMOND') return `radial-gradient(circle, ${stopsCss(p)})`
  if (p.type === 'GRADIENT_ANGULAR') return `conic-gradient(from 90deg, ${stopsCss(p, 'deg', 360)})`
  const hd = handlesOf(p, 1, 1)
  return `linear-gradient(${angleOf(hd, 1, 1)}deg, ${stopsCss(p)})`
}

/** turn the gradient a quarter clockwise around the middle of the box (the "rotate" button of Figma) */
export function rotated(p: GradientPaint, w: number, h: number): GradientPaint {
  const hd = handlesOf(p, w, h)
  const turn = (q: UnitPoint): UnitPoint => {
    // work in pixels, so a quarter turn is a quarter turn in a box that is not square
    const x = (q.x - 0.5) * w
    const y = (q.y - 0.5) * h
    return { x: 0.5 + -y / (w || 1), y: 0.5 + x / (h || 1) }
  }
  const next = hd.map(turn) as Handles
  return { ...p, handles: next, angle: angleOf(next, w, h) }
}

/** reverse the order of the colours (the "flip" button of Figma) */
export const flipped = (p: GradientPaint): GradientPaint => ({ ...p, stops: sortedStops(p.stops.map((s) => ({ ...s, position: 1 - s.position }))) })
