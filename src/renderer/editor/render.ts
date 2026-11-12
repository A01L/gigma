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

// ---------------- image cache ----------------
type ImgEntry = { bmp: ImageBitmap | null; missing: boolean; promise: Promise<ImageBitmap | null> }
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
  if (n.type === 'SPEC' || n.type === 'CODE' || n.type === 'SLICE' || n.type === 'ANNOTATION') return null
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

/** Start/end points of a linear gradient across a box (CSS angle convention). */
export function gradientLine(angle: number, r: Rect): { x1: number; y1: number; x2: number; y2: number } {
  const a = (angle * Math.PI) / 180
  const dx = Math.sin(a)
  const dy = -Math.cos(a)
  const L = Math.abs((r.w / 2) * dx) + Math.abs((r.h / 2) * dy)
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  return { x1: cx - dx * L, y1: cy - dy * L, x2: cx + dx * L, y2: cy + dy * L }
}

function canvasGradient(ctx: CanvasRenderingContext2D, f: GradientPaint, r: Rect): CanvasGradient {
  let g: CanvasGradient
  if (f.type === 'GRADIENT_RADIAL') g = ctx.createRadialGradient(r.x + r.w / 2, r.y + r.h / 2, 0, r.x + r.w / 2, r.y + r.h / 2, Math.max(r.w, r.h) / 2)
  else {
    const l = gradientLine(f.angle ?? 180, r)
    g = ctx.createLinearGradient(l.x1, l.y1, l.x2, l.y2)
  }
  for (const s of f.stops) g.addColorStop(Math.max(0, Math.min(1, s.position)), rgbaToCss(s.color))
  return g
}

function drawFills(ctx: CanvasRenderingContext2D, n: GNode, r: Rect, path: Path2D): void {
  for (const f of n.fills) {
    if (f.visible === false) continue
    if (f.type === 'SOLID') {
      ctx.fillStyle = rgbaToCss(f.color)
      ctx.fill(path, n.fillRule ?? 'nonzero')
    } else if ('stops' in f) {
      ctx.fillStyle = canvasGradient(ctx, f, r)
      ctx.fill(path, n.fillRule ?? 'nonzero')
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
    const fill = n.fills.find((f) => f.type === 'SOLID' && f.visible !== false)
    if (fill && fill.type === 'SOLID') {
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
        ctx.fillStyle = rgbaToCss(fill.color)
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

/** SPEC: a task card (yellow note) with status, title and description. */
function drawSpecCard(ctx: CanvasRenderingContext2D, n: GNode, r: Rect): void {
  const sp = n.spec ?? { title: 'Spec', body: '', status: 'TODO' as const }
  const k = deviceScale(ctx)
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.18)'
  ctx.shadowBlur = 16 * k
  ctx.shadowOffsetY = 4 * k
  ctx.fillStyle = '#FFF8DB'
  ctx.beginPath()
  ctx.roundRect(r.x, r.y, r.w, r.h, 12)
  ctx.fill()
  ctx.restore()
  ctx.strokeStyle = '#F2C94C'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.roundRect(r.x, r.y, r.w, r.h, 12)
  ctx.stroke()
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(r.x, r.y, r.w, r.h, 12)
  ctx.clip()
  // status chip
  const chip = { TODO: ['#F2994A', 'TODO'], IN_PROGRESS: ['#2F80ED', 'IN PROGRESS'], DONE: ['#27AE60', 'DONE'] }[sp.status]
  ctx.font = `700 10px Inter, "Segoe UI", sans-serif`
  ctx.textBaseline = 'middle'
  const label = 'SPEC · ' + chip[1]
  const cw = ctx.measureText(label).width + 14
  ctx.fillStyle = chip[0]
  ctx.beginPath()
  ctx.roundRect(r.x + 14, r.y + 12, cw, 18, 9)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.fillText(label, r.x + 21, r.y + 21)
  // title + body via the regular text layout
  const title: GNode = {
    ...n,
    type: 'TEXT',
    characters: sp.title || 'Untitled spec',
    width: r.w - 28,
    textAutoResize: 'HEIGHT',
    textStyle: { fontFamily: 'Inter', fontSize: 16, fontWeight: 700, align: 'LEFT' }
  }
  const tl = layoutText(title)
  ctx.fillStyle = '#1E1E1E'
  ctx.font = cssFont(title.textStyle!)
  ctx.letterSpacing = '0px'
  tl.lines.forEach((ln) => ctx.fillText(ln.text, r.x + 14, r.y + 40 + ln.y + tl.lineHeight / 2))
  const body: GNode = { ...title, characters: sp.body, textStyle: { fontFamily: 'Inter', fontSize: 13, fontWeight: 400, align: 'LEFT', lineHeightPercent: 145 } }
  const bl = layoutText(body)
  ctx.fillStyle = '#4A4A4A'
  ctx.font = cssFont(body.textStyle!)
  const top = r.y + 48 + tl.height
  bl.lines.forEach((ln) => ctx.fillText((ln.marker ? ln.marker + ' ' : '') + ln.text, r.x + 14, top + ln.y + bl.lineHeight / 2))
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
  for (const c of ids) {
    const n = ed.nodes.get(c)
    if (n?.isMask) {
      if (!n.visible) continue
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
