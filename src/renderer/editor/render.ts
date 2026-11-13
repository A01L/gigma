// Canvas renderer.
// Performance strategy:
//  - only redraw when something changed (dirty flag + requestAnimationFrame)
//  - viewport culling through the R-tree spatial index (O(log n) per frame)
//  - level of detail: sub-pixel nodes are skipped, tiny text is drawn as bars
//  - cached Path2D for vectors and cached text layout
//  - images decoded once and kept as ImageBitmap; drawn with smoothing only when needed
// The renderer is isolated behind drawScene(), so a WebGL/Skia (CanvasKit) backend can be
// swapped in later without touching the editor.
import type { Effect, GNode, GradientPaint, Paint } from '@shared/types'
import { blendCss, rgbaToCss } from '@shared/types'
import { backend } from '../backend'
import type { Editor } from './editor'
import { cssFont, layoutText, DEFAULT_TEXT_STYLE, justifyWords, lineX, measureWord, textBaseline, verticalOffset } from './text'
import { rectsIntersect, unionRects, type Rect } from './util'
import { arrowHeadPoints } from './shapes'
import { parsePath, transformSegs } from './svgpath'
import { getCodeBitmap, codeBitmapAsync } from './code-render'
import { booleanAsVector, isBooleanGroup } from './boolean'
import { drawGuide, guideStore } from './guide-render'
import { handlesOf } from './gradient'

// ---------------- image cache ----------------
type ImgEntry = { bmp: ImageBitmap | null; missing: boolean; promise: Promise<ImageBitmap | null>; opaque?: boolean }
const images = new Map<string, ImgEntry>()
let onImageLoaded: () => void = () => {}
export function setImageLoadedCallback(fn: () => void): void {
  onImageLoaded = fn
}
export function loadImage(hash: string): Promise<ImageBitmap | null> {
  let e = images.get(hash)
  if (!e) {
    const promise = fetch(backend.blob.url(hash))
      .then((r) => {
        if (!r.ok) throw new Error('missing')
        return r.blob()
      })
      .then((b) => createImageBitmap(b))
      .then((bmp) => {
        e!.bmp = bmp
        onImageLoaded()
        return bmp
      })
      .catch(() => {
        e!.missing = true
        onImageLoaded()
        return null
      })
    e = { bmp: null, missing: false, promise }
    images.set(hash, e)
  }
  return e.promise
}
/**
 * Has the picture no transparency at all? Looked at once, on a small copy. A mask filled with such a picture
 * is just its outline, which is far cheaper to cut by than by the alpha of the picture.
 */
function imageOpaque(hash: string): boolean {
  const e = images.get(hash)
  if (!e) {
    loadImage(hash)
    return false
  }
  if (!e.bmp) return false
  if (e.opaque === undefined) {
    const c = document.createElement('canvas')
    c.width = Math.min(64, e.bmp.width)
    c.height = Math.min(64, e.bmp.height)
    const g = c.getContext('2d', { willReadFrequently: true })!
    g.drawImage(e.bmp, 0, 0, c.width, c.height)
    const d = g.getImageData(0, 0, c.width, c.height).data
    let opaque = true
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] < 250) {
        opaque = false
        break
      }
    }
    e.opaque = opaque
  }
  return e.opaque
}
/** Forget cached state so a newly stored blob for this hash is picked up. */
export function forgetImage(hash: string): void {
  images.delete(hash)
}
/** true if the image bytes are not in this project (e.g. pasted from Figma, not fetched yet) */
export async function isImageMissing(hash: string): Promise<boolean> {
  await loadImage(hash)
  return !!images.get(hash)?.missing
}

// Placeholder for images whose bytes are not available: checkerboard + picture glyph.
let checker: CanvasPattern | null = null
function drawMissingImage(ctx: CanvasRenderingContext2D, r: Rect): void {
  if (!checker) {
    const c = document.createElement('canvas')
    c.width = c.height = 16
    const g = c.getContext('2d')!
    g.fillStyle = '#d6d6d6'
    g.fillRect(0, 0, 16, 16)
    g.fillStyle = '#c4c4c4'
    g.fillRect(0, 0, 8, 8)
    g.fillRect(8, 8, 8, 8)
    checker = ctx.createPattern(c, 'repeat')
  }
  ctx.save()
  const m = ctx.getTransform()
  const scale = Math.hypot(m.a, m.b) || 1
  // keep the checker size constant on screen
  checker!.setTransform(new DOMMatrix().scale(1 / scale))
  ctx.fillStyle = checker!
  ctx.fillRect(r.x, r.y, r.w, r.h)
  // picture glyph
  const s = Math.min(r.w, r.h) * 0.3
  if (s * scale > 10) {
    const cx = r.x + r.w / 2
    const cy = r.y + r.h / 2
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.lineWidth = Math.max(1 / scale, s * 0.06)
    ctx.beginPath()
    ctx.roundRect(cx - s / 2, cy - s * 0.38, s, s * 0.76, s * 0.1)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(cx - s * 0.4, cy + s * 0.3)
    ctx.lineTo(cx - s * 0.1, cy)
    ctx.lineTo(cx + s * 0.1, cy + s * 0.18)
    ctx.lineTo(cx + s * 0.22, cy + s * 0.06)
    ctx.lineTo(cx + s * 0.4, cy + s * 0.3)
    ctx.closePath()
    ctx.fill()
    ctx.beginPath()
    ctx.arc(cx + s * 0.2, cy - s * 0.15, s * 0.08, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}
export function imageSize(hash: string): Promise<{ w: number; h: number } | null> {
  return loadImage(hash).then((b) => (b ? { w: b.width, h: b.height } : null))
}

// ---------------- path cache ----------------
const paths = new Map<string, Path2D>()
function pathOf(d: string): Path2D {
  let p = paths.get(d)
  if (!p) {
    p = new Path2D(d)
    if (paths.size > 20000) paths.clear()
    paths.set(d, p)
  }
  return p
}

// ---------------- node drawing ----------------
/** Corner radii [tl, tr, br, bl] clamped to the box, or null when the corners are square. */
export function cornerRadiiOf(n: GNode, r: { w: number; h: number }): number[] | null {
  const max = Math.min(r.w, r.h) / 2
  const list = n.cornerRadii ?? (n.cornerRadius ? [n.cornerRadius, n.cornerRadius, n.cornerRadius, n.cornerRadius] : null)
  if (!list || !list.some((v) => v > 0)) return null
  return list.map((v) => Math.max(0, Math.min(v, max)))
}

/** true when the node is rotated or mirrored */
export const hasTransform = (n: GNode): boolean => !!(n.rotation || n.flipX || n.flipY)

/** Apply the node's rotation / flip around the center of its world rect. */
export function applyNodeTransform(ctx: CanvasRenderingContext2D, n: GNode, r: Rect): void {
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  ctx.translate(cx, cy)
  if (n.rotation) ctx.rotate((-n.rotation * Math.PI) / 180)
  if (n.flipX || n.flipY) ctx.scale(n.flipX ? -1 : 1, n.flipY ? -1 : 1)
  ctx.translate(-cx, -cy)
}
function shapePath(ctx: CanvasRenderingContext2D, n: GNode, r: Rect): void {
  ctx.beginPath()
  if (n.type === 'ELLIPSE') ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2)
  else if (cornerRadiiOf(n, r)) ctx.roundRect(r.x, r.y, r.w, r.h, cornerRadiiOf(n, r)!)
  else ctx.rect(r.x, r.y, r.w, r.h)
}

function drawImagePaint(ctx: CanvasRenderingContext2D, p: Extract<Paint, { type: 'IMAGE' }>, r: Rect): void {
  const e = images.get(p.imageHash)
  if (!e) {
    loadImage(p.imageHash)
    return
  }
  const bmp = e.bmp
  if (!bmp) {
    if (e.missing) drawMissingImage(ctx, r)
    return
  }
  if (p.scaleMode === 'STRETCH' && p.transform) {
    // Figma's crop: the matrix takes a point of the box to a point of the picture, so the picture is drawn through its inverse
    const [a, b, c, d, e, f] = p.transform
    const det = a * d - b * c
    if (Math.abs(det) > 1e-9) {
      ctx.save()
      ctx.translate(r.x, r.y)
      ctx.scale(r.w, r.h)
      ctx.transform(d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det)
      ctx.drawImage(bmp, 0, 0, 1, 1)
      ctx.restore()
      return
    }
  }
  let dw = r.w
  let dh = r.h
  if (p.scaleMode !== 'STRETCH') {
    const s = p.scaleMode === 'FIT' ? Math.min(r.w / bmp.width, r.h / bmp.height) : Math.max(r.w / bmp.width, r.h / bmp.height)
    dw = bmp.width * s
    dh = bmp.height * s
  }
  ctx.drawImage(bmp, r.x + (r.w - dw) / 2, r.y + (r.h - dh) / 2, dw, dh)
}

/** The node's outline as a Path2D in world coordinates (null for text / groups). */
function worldShape(n: GNode, r: Rect): Path2D | null {
  if (n.type === 'VECTOR') {
    if (!n.path) return null
    const p = new Path2D()
    const sx = r.w / (n.pathBox?.w || r.w || 1)
    const sy = r.h / (n.pathBox?.h || r.h || 1)
    p.addPath(pathOf(n.path), new DOMMatrix([sx, 0, 0, sy, r.x, r.y]))
    return p
  }
  if (n.type === 'TEXT' || n.type === 'GROUP') return null
  const p = new Path2D()
  if (n.type === 'ELLIPSE') p.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(0, r.w / 2), Math.max(0, r.h / 2), 0, 0, Math.PI * 2)
  else if (cornerRadiiOf(n, r)) p.roundRect(r.x, r.y, r.w, r.h, cornerRadiiOf(n, r)!)
  else p.rect(r.x, r.y, r.w, r.h)
  return p
}

/**
 * What is stroked on hover and for each layer of a multi-selection, as in Figma: the real outline of
 * the layer (ellipse, rounded corners, vector path, boolean result), and underlines for text lines.
 * World coordinates; null = no special outline, use the plain box.
 */
export function outlineShape(ed: Editor, id: string): Path2D | null {
  const src = ed.nodes.get(id)
  if (!src) return null
  const r = ed.world(id)
  const n = isBooleanGroup(src) ? booleanAsVector(ed, src) : src
  if (n.type === 'TEXT') {
    const l = layoutText(n)
    const oy = verticalOffset(n, l)
    const p = new Path2D()
    for (const ln of l.lines) {
      if (!ln.text) continue
      const y = r.y + oy + ln.y + l.lineHeight * 0.88
      const x = r.x + lineX(n, ln, r.w)
      p.moveTo(x, y)
      p.lineTo(x + ln.width, y)
    }
    return p
  }
  if (n.type === 'SPEC' || n.type === 'CODE' || n.type === 'SLICE' || n.type === 'ANNOTATION' || n.type === 'GUIDE') return null
  return worldShape(n, r)
}

/** current world->device scale (shadows and filters are specified in device pixels) */
const deviceScale = (ctx: CanvasRenderingContext2D) => {
  const m = ctx.getTransform()
  return Math.hypot(m.a, m.b) || 1
}

/** A rectangle big enough to contain the node plus any effect spill, with the shape cut out (evenodd). */
function inverseOf(shape: Path2D, r: Rect, pad: number): Path2D {
  const p = new Path2D()
  p.rect(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2)
  p.addPath(shape)
  return p
}

const addStops = (g: CanvasGradient, f: GradientPaint): CanvasGradient => {
  for (const s of f.stops) g.addColorStop(Math.max(0, Math.min(1, s.position)), rgbaToCss(s.color))
  return g
}

/** the handles of a gradient in the coordinates the box is drawn in */
function gradientPoints(f: GradientPaint, r: Rect): [number, number][] {
  return handlesOf(f, r.w, r.h).map((p) => [r.x + p.x * r.w, r.y + p.y * r.h] as [number, number])
}

/** A gradient as a plain canvas style: exact for a linear one, round for the others (text is filled with it). */
function canvasGradient(ctx: CanvasRenderingContext2D, f: GradientPaint, r: Rect): CanvasGradient {
  const [p0, p1] = gradientPoints(f, r)
  if (f.type === 'GRADIENT_LINEAR') return addStops(ctx.createLinearGradient(p0[0], p0[1], p1[0], p1[1]), f)
  if (f.type === 'GRADIENT_ANGULAR') return addStops(ctx.createConicGradient(Math.atan2(p1[1] - p0[1], p1[0] - p0[0]), p0[0], p0[1]), f)
  return addStops(ctx.createRadialGradient(p0[0], p0[1], 0, p0[0], p0[1], Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1), f)
}

/**
 * Fill a shape with a gradient. A linear one is a plain canvas gradient. Radial, angular and diamond ones are drawn
 * in the gradient's own space (start = origin, end = one unit along x, width handle = one unit along y), so they can
 * be stretched and turned the way the three handles say.
 */
function fillGradient(ctx: CanvasRenderingContext2D, f: GradientPaint, r: Rect, path: Path2D, rule: CanvasFillRule): void {
  const opacity = f.opacity ?? 1
  if (opacity <= 0) return
  ctx.save()
  if (opacity < 1) ctx.globalAlpha *= opacity
  const [p0, p1, p2] = gradientPoints(f, r)
  if (f.type === 'GRADIENT_LINEAR') {
    ctx.fillStyle = addStops(ctx.createLinearGradient(p0[0], p0[1], p1[0], p1[1]), f)
    ctx.fill(path, rule)
    ctx.restore()
    return
  }
  const a = p1[0] - p0[0]
  const b = p1[1] - p0[1]
  const c = p2[0] - p0[0]
  const d = p2[1] - p0[1]
  const det = a * d - b * c
  ctx.clip(path, rule)
  if (Math.abs(det) < 1e-9) {
    // the handles lie on one line: nothing to spread the colours over
    const last = [...f.stops].sort((x, y) => x.position - y.position).pop()
    if (last) {
      ctx.fillStyle = rgbaToCss(last.color)
      ctx.fillRect(r.x, r.y, r.w, r.h)
    }
    ctx.restore()
    return
  }
  ctx.transform(a, b, c, d, p0[0], p0[1])
  // the box in gradient space: what has to be covered
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const [wx, wy] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
    const u = (d * (wx - p0[0]) - c * (wy - p0[1])) / det
    const v = (-b * (wx - p0[0]) + a * (wy - p0[1])) / det
    x1 = Math.min(x1, u)
    y1 = Math.min(y1, v)
    x2 = Math.max(x2, u)
    y2 = Math.max(y2, v)
  }
  if (f.type === 'GRADIENT_DIAMOND') {
    // |x| + |y|: one linear gradient per quarter
    for (const [sx, sy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
      const qx1 = sx > 0 ? Math.max(0, x1) : x1
      const qx2 = sx > 0 ? x2 : Math.min(0, x2)
      const qy1 = sy > 0 ? Math.max(0, y1) : y1
      const qy2 = sy > 0 ? y2 : Math.min(0, y2)
      if (qx2 <= qx1 || qy2 <= qy1) continue
      ctx.fillStyle = addStops(ctx.createLinearGradient(0, 0, sx * 0.5, sy * 0.5), f)
      ctx.fillRect(qx1, qy1, qx2 - qx1, qy2 - qy1)
    }
  } else {
    ctx.fillStyle = f.type === 'GRADIENT_ANGULAR' ? addStops(ctx.createConicGradient(0, 0, 0), f) : addStops(ctx.createRadialGradient(0, 0, 0, 0, 0, 1), f)
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1)
  }
  ctx.restore()
}

function drawFills(ctx: CanvasRenderingContext2D, n: GNode, r: Rect, path: Path2D): void {
  for (const f of n.fills) {
    if (f.visible === false) continue
    if (f.type === 'SOLID') {
      ctx.fillStyle = rgbaToCss(f.color)
      ctx.fill(path, n.fillRule ?? 'nonzero')
    } else if ('stops' in f) {
      fillGradient(ctx, f, r, path, n.fillRule ?? 'nonzero')
    } else {
      ctx.save()
      ctx.clip(path, n.fillRule ?? 'nonzero')
      drawImagePaint(ctx, f, r)
      ctx.restore()
    }
  }
}

/** Strokes with Figma's alignment: INSIDE / CENTER / OUTSIDE. */
function drawStrokes(ctx: CanvasRenderingContext2D, n: GNode, r: Rect, path: Path2D): void {
  const closed = n.type !== 'VECTOR' || /z/i.test(n.path ?? '')
  for (const s of n.strokes) {
    if (s.visible === false || s.weight <= 0) continue
    ctx.save()
    ctx.strokeStyle = rgbaToCss(s.color)
    ctx.lineJoin = n.strokeCap === 'ROUND' ? 'round' : 'miter'
    ctx.lineCap = n.strokeCap === 'ROUND' ? 'round' : n.strokeCap === 'SQUARE' ? 'square' : 'butt'
    const align = closed ? (s.align ?? 'CENTER') : 'CENTER'
    if (align === 'CENTER') ctx.lineWidth = s.weight
    else {
      ctx.lineWidth = s.weight * 2
      if (align === 'INSIDE') ctx.clip(path, n.fillRule ?? 'nonzero')
      else ctx.clip(inverseOf(path, r, s.weight * 2 + 2), 'evenodd')
    }
    ctx.stroke(path)
    ctx.restore()
  }
}

/** Drop shadows: drawn only outside the shape (like Figma with "show behind transparent areas" off). */
function drawDropShadows(ctx: CanvasRenderingContext2D, n: GNode, r: Rect, path: Path2D, effects: Effect[]): void {
  const k = deviceScale(ctx)
  for (const e of effects) {
    if (e.type !== 'DROP_SHADOW') continue
    const pad = e.radius * 2 + Math.abs(e.offset.x) + Math.abs(e.offset.y) + Math.abs(e.spread) + 4
    ctx.save()
    ctx.clip(inverseOf(path, r, pad), 'evenodd')
    ctx.shadowColor = rgbaToCss(e.color)
    ctx.shadowBlur = e.radius * k
    ctx.shadowOffsetX = e.offset.x * k
    ctx.shadowOffsetY = e.offset.y * k
    ctx.fillStyle = '#000'
    ctx.fill(path, n.fillRule ?? 'nonzero')
    if (e.spread > 0) {
      ctx.lineWidth = e.spread * 2
      ctx.lineJoin = 'round'
      ctx.strokeStyle = '#000'
      ctx.stroke(path)
    }
    ctx.restore()
  }
}

/** Inner shadows: cast by everything outside the shape, clipped to the shape. */
function drawInnerShadows(ctx: CanvasRenderingContext2D, n: GNode, r: Rect, path: Path2D, effects: Effect[]): void {
  const k = deviceScale(ctx)
  for (const e of effects) {
    if (e.type !== 'INNER_SHADOW') continue
    const pad = e.radius * 2 + Math.abs(e.offset.x) + Math.abs(e.offset.y) + Math.abs(e.spread) + 4
    ctx.save()
    ctx.clip(path, n.fillRule ?? 'nonzero')
    ctx.shadowColor = rgbaToCss(e.color)
    ctx.shadowBlur = e.radius * k
    ctx.shadowOffsetX = e.offset.x * k
    ctx.shadowOffsetY = e.offset.y * k
    ctx.fillStyle = '#000'
    ctx.fill(inverseOf(path, r, pad), 'evenodd')
    if (e.spread > 0) {
      ctx.lineWidth = e.spread * 2
      ctx.strokeStyle = '#000'
      ctx.stroke(path)
    }
    ctx.restore()
  }
}

/** Background blur: blur whatever is already painted behind the shape. */
function drawBackgroundBlur(ctx: CanvasRenderingContext2D, n: GNode, path: Path2D, radius: number): void {
  const k = deviceScale(ctx)
  ctx.save()
  ctx.clip(path, n.fillRule ?? 'nonzero')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.filter = `blur(${Math.max(0, (radius * k) / 2)}px)`
  ctx.drawImage(ctx.canvas, 0, 0)
  ctx.restore()
}

export interface DrawOpts {
  view: Rect // world rect to draw
  zoom: number // world->device pixels (for LOD)
  visible?: Set<string> // pre-culled ids (spatial index)
}

function drawNode(ctx: CanvasRenderingContext2D, ed: Editor, id: string, o: DrawOpts): void {
  const n = ed.nodes.get(id)
  if (!n || !n.visible) return
  if (!hasTransform(n)) return drawNodeInner(ctx, ed, id, o)
  // rotated / mirrored: the whole subtree is drawn in the transformed space (no culling: bounds are not axis-aligned)
  ctx.save()
  applyNodeTransform(ctx, n, ed.world(id))
  drawNodeInner(ctx, ed, id, { ...o, view: { x: -1e9, y: -1e9, w: 2e9, h: 2e9 }, visible: undefined })
  ctx.restore()
}

function drawNodeInner(ctx: CanvasRenderingContext2D, ed: Editor, id: string, o: DrawOpts): void {
  let n = ed.nodes.get(id)
  if (!n || !n.visible) return
  // a boolean group is drawn as the single shape computed from its children
  if (isBooleanGroup(n)) n = booleanAsVector(ed, n)
  // never part of the artwork: slices are export regions, annotations are notes (drawn as overlay)
  if (n.type === 'SLICE' || n.type === 'ANNOTATION') return
  const r = ed.world(id)
  const clips = n.type === 'FRAME' && n.clipsContent !== false
  const isContainer = n.type === 'FRAME' || n.type === 'GROUP' || n.type === 'SECTION'
  if (n.type === 'GUIDE') {
    // the glow and the name reach outside the dot
    if (!rectsIntersect({ x: r.x - 90, y: r.y - 60, w: r.w + 180, h: r.h + 120 }, o.view)) return
    ctx.save()
    if (n.opacity < 1) ctx.globalAlpha *= n.opacity
    drawGuide(ctx, n, r, guideStore.get(n.guide?.id ?? ''), deviceScale(ctx))
    ctx.restore()
    return
  }
  if (n.type === 'SPEC' || n.type === 'CODE') {
    if (!rectsIntersect(r, o.view)) return
    ctx.save()
    if (n.opacity < 1) ctx.globalAlpha *= n.opacity
    if (n.type === 'SPEC') drawSpecCard(ctx, n, r)
    else drawCode(ctx, n, r)
    ctx.restore()
    return
  }
  const effects = (n.effects ?? []).filter((e) => e.visible !== false)
  // effects spill outside the bounds; grow the culling rect accordingly
  let spill = 0
  for (const e of effects) spill = Math.max(spill, e.radius * 2 + ('offset' in e ? Math.abs(e.offset.x) + Math.abs(e.offset.y) + Math.abs(e.spread) : 0))
  const cullR = spill ? { x: r.x - spill, y: r.y - spill, w: r.w + spill * 2, h: r.h + spill * 2 } : r
  // culling: a node (and, if it clips, its subtree) outside the view is skipped
  if (!rectsIntersect(cullR, o.view)) {
    if (!isContainer || clips || n.type === 'GROUP') return
  }
  if (r.w * o.zoom < 0.5 && r.h * o.zoom < 0.5 && !isContainer) return

  ctx.save()
  if (n.opacity < 1) ctx.globalAlpha *= n.opacity
  if (n.blendMode && n.blendMode !== 'NORMAL') ctx.globalCompositeOperation = blendCss(n.blendMode) as GlobalCompositeOperation
  const layerBlur = effects.find((e) => e.type === 'LAYER_BLUR')
  if (layerBlur && layerBlur.radius > 0) ctx.filter = `blur(${(layerBlur.radius * deviceScale(ctx)) / 2}px)`

  const shape = worldShape(n, r)
  if (shape) {
    const bg = effects.find((e) => e.type === 'BACKGROUND_BLUR')
    drawDropShadows(ctx, n, r, shape, effects)
    if (bg && bg.radius > 0 && !layerBlur) drawBackgroundBlur(ctx, n, shape, bg.radius)
    drawFills(ctx, n, r, shape)
    drawInnerShadows(ctx, n, r, shape, effects)
    if (!isContainer) drawStrokes(ctx, n, r, shape)
    if (n.arrowEnd && n.type === 'VECTOR' && n.path) drawArrowHead(ctx, n, r)
  } else if (n.type === 'TEXT') {
    const s = n.textStyle ?? DEFAULT_TEXT_STYLE
    // the top visible fill colours the text: a solid colour or a gradient
    const top = [...n.fills].reverse().find((f) => f.visible !== false && f.type !== 'IMAGE')
    const fill = top && top.type === 'SOLID' ? top : top && 'stops' in top ? { color: [...top.stops].sort((a, b) => a.position - b.position)[0]?.color ?? { r: 0, g: 0, b: 0, a: 1 } } : null
    const ink = (): string | CanvasGradient => (top && 'stops' in top ? canvasGradient(ctx, top, r) : rgbaToCss(fill!.color))
    if (fill) {
      if (s.fontSize * o.zoom < 3) {
        // LOD: greek tiny text
        ctx.fillStyle = rgbaToCss(fill.color, 0.25)
        const l = layoutText(n)
        const oy = verticalOffset(n, l)
        for (const ln of l.lines) ctx.fillRect(r.x + lineX(n, ln, r.w), r.y + oy + ln.y + l.lineHeight * 0.3, ln.width, l.lineHeight * 0.4)
      } else if (ed.editingTextId !== n.id) {
        const l = layoutText(n)
        const oy = verticalOffset(n, l)
        ctx.font = cssFont(s)
        ctx.letterSpacing = `${l.letterSpacing}px`
        const tb = textBaseline(l)
        ctx.textBaseline = tb.baseline
        ctx.textAlign = 'left'
        if ((n.textAutoResize ?? 'WIDTH_AND_HEIGHT') === 'NONE' && s.truncate) {
          ctx.beginPath()
          ctx.rect(r.x, r.y, r.w, r.h)
          ctx.clip()
        }
        // decorations are positioned from the visual middle of the line
        const midShift = tb.baseline === 'alphabetic' ? -(l.cap ?? 0) / 2 : 0
        const lines = (decorate: boolean) => {
          for (const ln of l.lines) {
            const top = r.y + oy + ln.y
            const mid = top + tb.dy
            if (ln.marker) ctx.fillText(ln.marker, r.x, mid)
            const x0 = r.x + lineX(n, ln, r.w)
            const j = justifyWords(n, ln, r.w)
            let width = ln.width
            if (j) {
              let x = r.x + ln.indent
              for (const w of j.words) {
                ctx.fillText(w, x, mid)
                x += measureWord(n, w) + j.gap
              }
              width = r.w - ln.indent
            } else ctx.fillText(ln.text, x0, mid)
            if (decorate && s.decoration && s.decoration !== 'NONE' && ln.text) {
              const th = Math.max(1, s.fontSize / 14)
              const dy = (s.decoration === 'UNDERLINE' ? mid + s.fontSize * 0.36 : mid + s.fontSize * 0.02) + midShift
              ctx.fillRect(j ? r.x + ln.indent : x0, dy, width, th)
            }
          }
        }
        // drop shadows on text: one pass per shadow, text itself drawn on top
        const k = deviceScale(ctx)
        for (const e of effects) {
          if (e.type !== 'DROP_SHADOW') continue
          ctx.save()
          ctx.shadowColor = rgbaToCss(e.color)
          ctx.shadowBlur = e.radius * k
          ctx.shadowOffsetX = e.offset.x * k
          ctx.shadowOffsetY = e.offset.y * k
          ctx.fillStyle = rgbaToCss(fill.color)
          lines(true)
          ctx.restore()
        }
        ctx.fillStyle = ink()
        if (top && 'stops' in top && (top.opacity ?? 1) < 1) ctx.globalAlpha *= top.opacity!
        lines(true)
      }
    }
  }

  if (isContainer) {
    ctx.save()
    if (clips && shape) ctx.clip(shape)
    drawChildren(ctx, ed, ed.children(id, n.pageId), o)
    ctx.restore()
    if (n.type === 'FRAME' && shape) drawStrokes(ctx, n, r, shape)
  }
  ctx.restore()
}

/** containers that do not clip may have children outside their own bounds */
function clipsOrGroup(ed: Editor, id: string): boolean {
  const n = ed.nodes.get(id)!
  return !(n.type === 'FRAME' && n.clipsContent === false)
}

function drawArrowHead(ctx: CanvasRenderingContext2D, n: GNode, r: Rect): void {
  const st = n.strokes.find((s) => s.visible !== false && s.weight > 0)
  if (!st) return
  const sx = r.w / (n.pathBox?.w || r.w || 1)
  const sy = r.h / (n.pathBox?.h || r.h || 1)
  const head = arrowHeadPoints(transformSegs(parsePath(n.path!), [sx, 0, 0, sy, r.x, r.y]), st.weight)
  if (!head) return
  ctx.fillStyle = rgbaToCss(st.color)
  ctx.beginPath()
  ctx.moveTo(head[0][0], head[0][1])
  ctx.lineTo(head[1][0], head[1][1])
  ctx.lineTo(head[2][0], head[2][1])
  ctx.closePath()
  ctx.fill()
}

/** height of the dark title bar of a Spec card */
export const SPEC_HEAD = 34

/**
 * SPEC card, drawn like Figma's spec block: a dark shell with the document icon and the name in the
 * title bar, and a white sheet with the title and the text of the task below.
 */
function drawSpecCard(ctx: CanvasRenderingContext2D, n: GNode, r: Rect): void {
  const sp = n.spec ?? { title: '', body: '', status: 'TODO' as const }
  const k = deviceScale(ctx)
  const pad = 6
  // shell
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.35)'
  ctx.shadowBlur = 18 * k
  ctx.shadowOffsetY = 6 * k
  ctx.fillStyle = '#2c2c2c'
  ctx.beginPath()
  ctx.roundRect(r.x, r.y, r.w, r.h, 10)
  ctx.fill()
  ctx.restore()
  ctx.strokeStyle = '#3d3d3d'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 10)
  ctx.stroke()
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(r.x, r.y, r.w, r.h, 10)
  ctx.clip()

  // title bar: document icon, name, status
  const cy = r.y + SPEC_HEAD / 2
  const BLUE = '#7cb7ff'
  ctx.strokeStyle = BLUE
  ctx.lineWidth = 1.3
  ctx.lineJoin = 'round'
  const ix = r.x + 13
  ctx.beginPath()
  ctx.roundRect(ix, cy - 7, 11, 14, 2)
  ctx.moveTo(ix + 3, cy - 3)
  ctx.lineTo(ix + 8, cy - 3)
  ctx.moveTo(ix + 3, cy)
  ctx.lineTo(ix + 8, cy)
  ctx.moveTo(ix + 3, cy + 3)
  ctx.lineTo(ix + 6.5, cy + 3)
  ctx.stroke()
  const chip = sp.kind === 'RULES' ? ['#8b6fe8', 'RULES'] : { TODO: ['#f2994a', 'TODO'], IN_PROGRESS: ['#2f80ed', 'IN PROGRESS'], DONE: ['#27ae60', 'DONE'] }[sp.status]
  ctx.textBaseline = 'middle'
  ctx.letterSpacing = '0px'
  ctx.font = '700 9.5px Inter, "Segoe UI", sans-serif'
  const cw = ctx.measureText(chip[1]).width + 14
  ctx.fillStyle = chip[0]
  ctx.beginPath()
  ctx.roundRect(r.x + r.w - cw - 10, cy - 9, cw, 18, 9)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.fillText(chip[1], r.x + r.w - cw - 3, cy + 0.5)
  ctx.font = '600 13px Inter, "Segoe UI", sans-serif'
  ctx.fillStyle = BLUE
  let name = n.name || 'Spec'
  const maxName = r.w - 44 - cw - 16
  while (name.length > 1 && ctx.measureText(name).width > maxName) name = name.slice(0, -2) + '…'
  if (maxName > 20) ctx.fillText(name, ix + 19, cy + 0.5)

  // the sheet
  const sx = r.x + pad
  const sy = r.y + SPEC_HEAD
  const sw = Math.max(1, r.w - pad * 2)
  const sh = Math.max(1, r.h - SPEC_HEAD - pad)
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.roundRect(sx, sy, sw, sh, 5)
  ctx.fill()
  ctx.beginPath()
  ctx.roundRect(sx, sy, sw, sh, 5)
  ctx.clip()
  const inner = Math.max(20, sw - 36)
  const title: GNode = {
    ...n,
    type: 'TEXT',
    characters: sp.title || 'Untitled',
    width: inner,
    textAutoResize: 'HEIGHT',
    textStyle: { fontFamily: 'Inter', fontSize: 20, fontWeight: 700, align: 'LEFT' }
  }
  const tl = layoutText(title)
  // empty fields show grey placeholders, as an empty document does
  ctx.fillStyle = sp.title ? '#1e1e1e' : '#b3b3b3'
  ctx.font = cssFont(title.textStyle!)
  tl.lines.forEach((ln) => ctx.fillText(ln.text, sx + 18, sy + 20 + ln.y + tl.lineHeight / 2))
  const body: GNode = { ...title, characters: sp.body || (sp.kind === 'RULES' ? 'Rules the AI follows in the linked frames…' : 'Describe the task for the AI…'), textStyle: { fontFamily: 'Inter', fontSize: 13, fontWeight: 400, align: 'LEFT', lineHeightPercent: 150 } }
  const bl = layoutText(body)
  ctx.fillStyle = sp.body ? '#444444' : '#b3b3b3'
  ctx.font = cssFont(body.textStyle!)
  let top = sy + 30 + tl.height
  bl.lines.forEach((ln) => ctx.fillText((ln.marker ? ln.marker + ' ' : '') + ln.text, sx + 18, top + ln.y + bl.lineHeight / 2))
  if (sp.result && sp.kind !== 'RULES') {
    // what was done, written by the AI (or a person) when the task was closed
    top += bl.height + 16
    ctx.strokeStyle = '#e6e6e6'
    ctx.beginPath()
    ctx.moveTo(sx + 18, top - 8)
    ctx.lineTo(sx + sw - 18, top - 8)
    ctx.stroke()
    const res: GNode = { ...body, characters: '✓ ' + sp.result }
    const rl = layoutText(res)
    ctx.fillStyle = '#27ae60'
    rl.lines.forEach((ln) => ctx.fillText(ln.text, sx + 18, top + ln.y + rl.lineHeight / 2))
  }
  ctx.restore()
}

/** CODE: rendered HTML/CSS bitmap (placeholder while rendering). */
function drawCode(ctx: CanvasRenderingContext2D, n: GNode, r: Rect): void {
  const bmp = getCodeBitmap(n, r.w, r.h, deviceScale(ctx))
  if (bmp) {
    ctx.drawImage(bmp, r.x, r.y, r.w, r.h)
    return
  }
  ctx.fillStyle = 'rgba(13,153,255,0.06)'
  ctx.fillRect(r.x, r.y, r.w, r.h)
  ctx.strokeStyle = 'rgba(13,153,255,0.5)'
  ctx.setLineDash([6, 4])
  ctx.lineWidth = 1 / deviceScale(ctx)
  ctx.strokeRect(r.x, r.y, r.w, r.h)
  ctx.setLineDash([])
}

/**
 * Can this mask be a plain clip? Yes when it is a shape filled with solid colour: its outline is all that matters.
 * A picture, a gradient with transparency, a text, a group or a frame masks with its alpha instead (as in Figma),
 * and that needs the layers to be composed off screen.
 */
export function clipsAsShape(n: GNode): boolean {
  if (isBooleanGroup(n)) return true
  if (n.type === 'GROUP' || n.type === 'FRAME' || n.type === 'SECTION' || n.type === 'TEXT' || n.type === 'CODE' || n.type === 'SPEC' || n.type === 'GUIDE') return false
  if (n.opacity < 0.999 || (n.effects ?? []).some((e) => e.visible !== false && e.type === 'LAYER_BLUR')) return false
  const fills = n.fills.filter((f) => f.visible !== false)
  // an outline only (no fill) masks with its stroke
  if (!fills.length) return !n.strokes.some((s) => s.visible !== false && s.weight > 0)
  return fills.some((f) =>
    f.type === 'SOLID'
      ? f.color.a >= 0.999
      : 'stops' in f
        ? (f.opacity ?? 1) >= 0.999 && f.stops.every((s) => s.color.a >= 0.999)
        : // a picture that covers the whole box and has no transparency
          f.scaleMode !== 'FIT' && !f.transform && imageOpaque(f.imageHash)
  )
}

// canvases the masked layers are composed on, reused from frame to frame
const scratch: HTMLCanvasElement[] = []
function takeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = scratch.pop() ?? document.createElement('canvas')
  // setting the size also clears it
  c.width = w
  c.height = h
  return c
}

/**
 * Alpha mask: the siblings above the mask are drawn off screen, then everything outside the picture the mask
 * itself gives is erased. Only the part of the screen the mask covers is composed.
 */
function drawMasked(ctx: CanvasRenderingContext2D, ed: Editor, mask: GNode, rest: string[], o: DrawOpts): void {
  const r = ed.world(mask.id)
  const m = ctx.getTransform()
  // effects of the mask reach outside its box
  let pad = 2
  for (const e of mask.effects ?? []) if (e.visible !== false) pad = Math.max(pad, e.radius * 2 + ('offset' in e ? Math.abs(e.offset.x) + Math.abs(e.offset.y) + Math.abs(e.spread) : 0))
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  // a rotated mask covers the box of its turned corners
  const c0 = { x: r.x + r.w / 2, y: r.y + r.h / 2 }
  const t = (-(mask.rotation ?? 0) * Math.PI) / 180
  for (const [px, py] of [[r.x - pad, r.y - pad], [r.x + r.w + pad, r.y - pad], [r.x - pad, r.y + r.h + pad], [r.x + r.w + pad, r.y + r.h + pad]]) {
    const dx = px - c0.x
    const dy = py - c0.y
    const p = m.transformPoint({ x: c0.x + dx * Math.cos(t) - dy * Math.sin(t), y: c0.y + dx * Math.sin(t) + dy * Math.cos(t) })
    x1 = Math.min(x1, p.x)
    y1 = Math.min(y1, p.y)
    x2 = Math.max(x2, p.x)
    y2 = Math.max(y2, p.y)
  }
  x1 = Math.max(0, Math.floor(x1))
  y1 = Math.max(0, Math.floor(y1))
  x2 = Math.min(ctx.canvas.width, Math.ceil(x2))
  y2 = Math.min(ctx.canvas.height, Math.ceil(y2))
  const w = x2 - x1
  const h = y2 - y1
  // the mask is off screen: nothing of the masked layers can be seen
  if (w <= 0 || h <= 0) return
  const local = new DOMMatrix().translate(-x1, -y1).multiply(m)
  // the layers are cut by the box of the mask anyway, so nothing outside it has to be drawn
  const inside: DrawOpts = { ...o, visible: undefined, view: { x: -1e9, y: -1e9, w: 2e9, h: 2e9 } }
  const a = takeCanvas(w, h)
  const ac = a.getContext('2d')!
  ac.setTransform(local)
  ac.imageSmoothingQuality = ctx.imageSmoothingQuality
  drawChildren(ac, ed, rest, inside)
  const b = takeCanvas(w, h)
  const bc = b.getContext('2d')!
  bc.setTransform(local)
  bc.imageSmoothingQuality = ctx.imageSmoothingQuality
  drawNode(bc, ed, mask.id, inside)
  ac.setTransform(1, 0, 0, 1, 0, 0)
  ac.globalCompositeOperation = 'destination-in'
  ac.drawImage(b, 0, 0)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(a, x1, y1)
  ctx.restore()
  scratch.push(a, b)
}

/** Clip the context to a mask layer's shape (Figma "Use as mask"). */
function clipToMask(ctx: CanvasRenderingContext2D, ed: Editor, n: GNode): void {
  const r = ed.world(n.id)
  if (isBooleanGroup(n)) n = booleanAsVector(ed, n)
  if (n.type === 'VECTOR' && n.path) {
    const m = ctx.getTransform()
    ctx.translate(r.x, r.y)
    ctx.scale(r.w / (n.pathBox?.w || r.w || 1), r.h / (n.pathBox?.h || r.h || 1))
    ctx.clip(pathOf(n.path), n.fillRule ?? 'nonzero')
    ctx.setTransform(m)
    return
  }
  if (n.type === 'GROUP' || n.type === 'TEXT') {
    ctx.beginPath()
    ctx.rect(r.x, r.y, r.w, r.h)
    ctx.clip()
    return
  }
  shapePath(ctx, n, r)
  ctx.clip()
}

/** Draw siblings bottom-to-top; a mask layer clips every sibling above it and is itself not painted. */
function drawChildren(ctx: CanvasRenderingContext2D, ed: Editor, ids: string[], o: DrawOpts): void {
  let masks = 0
  for (const [i, c] of ids.entries()) {
    const n = ed.nodes.get(c)
    if (n?.isMask) {
      if (!n.visible) continue
      if (!clipsAsShape(n)) {
        // an alpha mask takes over everything above it (further masks included: they are handled inside)
        drawMasked(ctx, ed, n, ids.slice(i + 1), o)
        break
      }
      ctx.save()
      masks++
      clipToMask(ctx, ed, n)
      continue
    }
    if (!o.visible || o.visible.has(c) || !clipsOrGroup(ed, c)) drawNode(ctx, ed, c, o)
  }
  while (masks--) ctx.restore()
}

export function drawScene(ctx: CanvasRenderingContext2D, ed: Editor, o: DrawOpts, rootIds?: string[]): void {
  drawChildren(ctx, ed, rootIds ?? ed.children(null), o)
}

// ---------------- export ----------------
export async function renderToCanvas(ed: Editor, ids: string[], scale = 1, background?: string): Promise<HTMLCanvasElement> {
  let roots = ed.roots(ids).sort((a, b) => (ed.paintOrderKey(a) < ed.paintOrderKey(b) ? -1 : 1))
  const b = unionRects(roots.map((id) => ed.world(id)))!
  // a slice exports everything visible inside its area
  const sliceOnly = roots.length === 1 && ed.nodes.get(roots[0])?.type === 'SLICE'
  if (sliceOnly) roots = [...ed.children(null, ed.nodes.get(roots[0])!.pageId)]
  const hashes = new Set<string>()
  const codes: Promise<unknown>[] = []
  for (const id of roots)
    for (const x of [id, ...ed.descendants(id)]) {
      const nd = ed.nodes.get(x)!
      for (const f of nd.fills) if (f.type === 'IMAGE') hashes.add(f.imageHash)
      if (nd.type === 'CODE') {
        const w = ed.world(x)
        codes.push(codeBitmapAsync(nd, w.w, w.h, scale))
      }
    }
  await Promise.all([...[...hashes].map(loadImage), ...codes])
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(b.w * scale))
  c.height = Math.max(1, Math.round(b.h * scale))
  const ctx = c.getContext('2d')!
  if (background) {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, c.width, c.height)
  }
  ctx.setTransform(scale, 0, 0, scale, -b.x * scale, -b.y * scale)
  const saved = ed.editingTextId
  ed.editingTextId = null
  if (sliceOnly) {
    ctx.beginPath()
    ctx.rect(b.x, b.y, b.w, b.h)
    ctx.clip()
    drawChildren(ctx, ed, roots, { view: b, zoom: scale })
  } else
    for (const id of roots) {
      // draw each root with its own ancestors' clipping ignored (exports the node itself)
      drawNode(ctx, ed, id, { view: b, zoom: scale })
    }
  ed.editingTextId = saved
  return c
}

export async function exportPng(ed: Editor, ids: string[], scale = 1): Promise<{ base64: string; width: number; height: number }> {
  const c = await renderToCanvas(ed, ids, scale)
  const url = c.toDataURL('image/png')
  return { base64: url.slice(url.indexOf(',') + 1), width: c.width, height: c.height }
}
