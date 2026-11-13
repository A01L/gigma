// A PDF dropped into Gigma: every page becomes a frame, and what is on the page becomes layers
// (text as text, lines and shapes as rectangles and vectors, pictures as images), in the order the PDF paints them.
//
// pdf.js reads the file. Its list of drawing operators is walked here with a small graphics state
// (the current matrix, colours, line width), and every painting operator turns into one layer.
import * as pdfjs from 'pdfjs-dist'
// the parser runs in this thread (pdf.js picks it up from globalThis): a document is small work,
// and it behaves the same in the dev server and in the packaged app, where a module worker from file:// may not start
import * as pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs'
import type { GNode, RGBA, TextStyle } from '@shared/types'
import { backend } from '../backend'
import { editor as ed } from './editor'
import { layoutText } from './text'
import { segsBounds, segsToD, type Mat, type Seg } from './svgpath'
import { round2 } from './util'
;(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = pdfWorker

const OPS = pdfjs.OPS
/** a page with more painted elements than this is cut short: the editor would crawl */
const MAX_LAYERS = 4000
const GAP = 60

const mul = (m: Mat, n: Mat): Mat => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]
const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
const scaleOf = (m: Mat): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))

/** "#rrggbb" (how pdf.js hands colours over) -> RGBA; anything else (a pattern, a shading) -> null */
function colorOf(c: unknown, alpha: number): RGBA | null {
  if (typeof c !== 'string') return null
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c)
  if (!m) return null
  return { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255, a: alpha }
}

type Layer =
  | { kind: 'path'; segs: Seg[]; fill: RGBA | null; stroke: RGBA | null; weight: number; evenodd: boolean }
  | { kind: 'image'; obj: unknown; x: number; y: number; w: number; h: number }
/** where a piece of text was shown and in what colour: text itself comes from getTextContent, which knows no colours */
type Shown = { x: number; y: number; color: RGBA | null; hidden: boolean }

interface State {
  ctm: Mat
  fill: unknown
  stroke: unknown
  fillAlpha: number
  strokeAlpha: number
  lineWidth: number
  /** text: matrix, the start of the line and the pen */
  tm: Mat
  lineX: number
  lineY: number
  leading: number
  mode: number
}

/** the path of a constructPath operator, in page coordinates */
function segsOf(data: ArrayLike<number> | null | undefined, m: Mat): Seg[] {
  const out: Seg[] = []
  if (!data) return out
  let cx = 0
  let cy = 0
  for (let i = 0; i < data.length; ) {
    const op = data[i++]
    if (op === 0 || op === 1) {
      cx = data[i++]
      cy = data[i++]
      out.push({ c: op === 0 ? 'M' : 'L', p: apply(m, cx, cy) })
    } else if (op === 2) {
      const p = [...apply(m, data[i], data[i + 1]), ...apply(m, data[i + 2], data[i + 3]), ...apply(m, data[i + 4], data[i + 5])]
      cx = data[i + 4]
      cy = data[i + 5]
      i += 6
      out.push({ c: 'C', p })
    } else if (op === 3) {
      // a quadratic curve, raised to a cubic one
      const [qx, qy, x, y] = [data[i], data[i + 1], data[i + 2], data[i + 3]]
      i += 4
      const c1 = apply(m, cx + ((qx - cx) * 2) / 3, cy + ((qy - cy) * 2) / 3)
      const c2 = apply(m, x + ((qx - x) * 2) / 3, y + ((qy - y) * 2) / 3)
      out.push({ c: 'C', p: [...c1, ...c2, ...apply(m, x, y)] })
      cx = x
      cy = y
    } else if (op === 4) out.push({ c: 'Z', p: [] })
    else break
  }
  return out
}

/** an axis-aligned rectangle drawn as a path -> its box (so a table cell becomes a Rectangle layer, not a vector) */
function rectOf(segs: Seg[]): { x: number; y: number; w: number; h: number } | null {
  const pts = segs.filter((s) => s.c === 'M' || s.c === 'L')
  if (segs.some((s) => s.c === 'C') || segs.filter((s) => s.c === 'M').length !== 1) return null
  let p = pts.map((s) => s.p)
  if (p.length === 5 && Math.abs(p[4][0] - p[0][0]) < 0.01 && Math.abs(p[4][1] - p[0][1]) < 0.01) p = p.slice(0, 4)
  if (p.length !== 4) return null
  const xs = [...new Set(p.map((q) => Math.round(q[0] * 100)))]
  const ys = [...new Set(p.map((q) => Math.round(q[1] * 100)))]
  if (xs.length !== 2 || ys.length !== 2) return null
  // corners must alternate: each side is horizontal or vertical
  for (let i = 0; i < 4; i++) {
    const a = p[i]
    const b = p[(i + 1) % 4]
    if (Math.abs(a[0] - b[0]) > 0.01 && Math.abs(a[1] - b[1]) > 0.01) return null
  }
  const x = Math.min(...p.map((q) => q[0]))
  const y = Math.min(...p.map((q) => q[1]))
  return { x, y, w: Math.max(...p.map((q) => q[0])) - x, h: Math.max(...p.map((q) => q[1])) - y }
}

/** walk the operators of a page: what is painted, in order, and where text was shown */
function walk(fn: number[], args: unknown[][], base: Mat): { layers: Layer[]; shown: Shown[]; cut: boolean } {
  const layers: Layer[] = []
  const shown: Shown[] = []
  const I: Mat = [1, 0, 0, 1, 0, 0]
  let s: State = { ctm: base, fill: '#000000', stroke: '#000000', fillAlpha: 1, strokeAlpha: 1, lineWidth: 1, tm: I, lineX: 0, lineY: 0, leading: 0, mode: 0 }
  const stack: State[] = []
  let cut = false
  const moveText = (x: number, y: number) => {
    s.lineX += x
    s.lineY += y
  }
  const show = () => {
    const [x, y] = apply(mul(s.ctm, s.tm), s.lineX, s.lineY)
    shown.push({ x, y, color: colorOf(s.fill, s.fillAlpha), hidden: s.mode === 3 || s.mode === 7 })
  }
  for (let i = 0; i < fn.length; i++) {
    const a = args[i] ?? []
    switch (fn[i]) {
      case OPS.save:
        stack.push({ ...s })
        break
      case OPS.restore:
        s = stack.pop() ?? s
        break
      case OPS.transform:
        s.ctm = mul(s.ctm, a as unknown as Mat)
        break
      case OPS.paintFormXObjectBegin:
        stack.push({ ...s })
        if (Array.isArray(a[0]) || ArrayBuffer.isView(a[0])) s.ctm = mul(s.ctm, Array.from(a[0] as ArrayLike<number>) as Mat)
        break
      case OPS.paintFormXObjectEnd:
        s = stack.pop() ?? s
        break
      case OPS.setLineWidth:
        s.lineWidth = a[0] as number
        break
      case OPS.setGState:
        for (const [key, value] of a[0] as [string, unknown][]) {
          if (key === 'LW') s.lineWidth = value as number
          else if (key === 'CA') s.strokeAlpha = value as number
          else if (key === 'ca') s.fillAlpha = value as number
        }
        break
      case OPS.setFillRGBColor:
        s.fill = a[0]
        break
      case OPS.setStrokeRGBColor:
        s.stroke = a[0]
        break
      case OPS.setFillTransparent:
        s.fill = null
        break
      case OPS.setStrokeTransparent:
        s.stroke = null
        break
      // patterns and shadings have no single colour: a neutral grey stands in for them
      case OPS.setFillColorN:
        s.fill = '#9a9a9a'
        break
      case OPS.setStrokeColorN:
        s.stroke = '#9a9a9a'
        break
      case OPS.constructPath: {
        const op = a[0] as number
        if (op === OPS.endPath) break // a path that only clips
        const data = (a[1] as unknown[] | null)?.[0] as ArrayLike<number> | null
        const segs = segsOf(data, s.ctm)
        if (!segs.length) break
        const closes = op === OPS.closeStroke || op === OPS.closeFillStroke || op === OPS.closeEOFillStroke
        if (closes && segs[segs.length - 1].c !== 'Z') segs.push({ c: 'Z', p: [] })
        const fills = op === OPS.fill || op === OPS.eoFill || op === OPS.fillStroke || op === OPS.eoFillStroke || op === OPS.closeFillStroke || op === OPS.closeEOFillStroke || op === OPS.rawFillPath
        const strokes = op === OPS.stroke || op === OPS.closeStroke || op === OPS.fillStroke || op === OPS.eoFillStroke || op === OPS.closeFillStroke || op === OPS.closeEOFillStroke
        const fill = fills ? colorOf(s.fill, s.fillAlpha) : null
        const stroke = strokes ? colorOf(s.stroke, s.strokeAlpha) : null
        if (!fill && !stroke) break
        if (layers.length >= MAX_LAYERS) {
          cut = true
          break
        }
        layers.push({ kind: 'path', segs, fill, stroke, weight: Math.max(0.25, s.lineWidth * scaleOf(s.ctm)), evenodd: op === OPS.eoFill || op === OPS.eoFillStroke || op === OPS.closeEOFillStroke })
        break
      }
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject: {
        // an image fills the unit square of the current space
        const c = [apply(s.ctm, 0, 0), apply(s.ctm, 1, 0), apply(s.ctm, 0, 1), apply(s.ctm, 1, 1)]
        const x = Math.min(...c.map((p) => p[0]))
        const y = Math.min(...c.map((p) => p[1]))
        if (layers.length < MAX_LAYERS) layers.push({ kind: 'image', obj: a[0], x, y, w: Math.max(...c.map((p) => p[0])) - x, h: Math.max(...c.map((p) => p[1])) - y })
        else cut = true
        break
      }
      case OPS.beginText:
        s.tm = I
        s.lineX = s.lineY = 0
        break
      case OPS.setTextMatrix:
        s.tm = Array.from(a[0] as ArrayLike<number>) as Mat
        s.lineX = s.lineY = 0
        break
      case OPS.setLeading:
        s.leading = -(a[0] as number)
        break
      case OPS.moveText:
        moveText(a[0] as number, a[1] as number)
        break
      case OPS.setLeadingMoveText:
        s.leading = a[1] as number
        moveText(a[0] as number, a[1] as number)
        break
      case OPS.nextLine:
        moveText(0, s.leading)
        break
      case OPS.setTextRenderingMode:
        s.mode = a[0] as number
        break
      case OPS.showText:
      case OPS.showSpacedText:
        show()
        break
      case OPS.nextLineShowText:
      case OPS.nextLineSetSpacingShowText:
        moveText(0, s.leading)
        show()
        break
    }
  }
  return { layers, shown, cut }
}

/** PostScript name of a PDF font ("ABCDEF+TimesNewRomanPS-BoldMT") -> a family this computer is likely to have, and the weight */
function fontOf(name: string, generic: string): { family: string; weight: number; italic: boolean } {
  const n = name.replace(/^[A-Z]{6}\+/, '')
  const low = n.toLowerCase()
  const weight = /black|heavy/.test(low) ? 900 : /extrabold|ultrabold/.test(low) ? 800 : /semibold|demibold|demi/.test(low) ? 600 : /bold/.test(low) ? 700 : /medium/.test(low) ? 500 : /light|thin/.test(low) ? 300 : 400
  const italic = /italic|oblique/.test(low)
  const known: [RegExp, string][] = [
    [/times/, 'Times New Roman'],
    [/georgia/, 'Georgia'],
    [/cambria/, 'Cambria'],
    [/garamond/, 'Garamond'],
    [/courier/, 'Courier New'],
    [/consol/, 'Consolas'],
    [/arial|helvetica|liberationsans|nimbussan/, 'Arial'],
    [/calibri|carlito/, 'Calibri'],
    [/verdana/, 'Verdana'],
    [/tahoma/, 'Tahoma'],
    [/segoe/, 'Segoe UI'],
    [/roboto/, 'Roboto'],
    [/opensans/, 'Open Sans'],
    [/montserrat/, 'Montserrat'],
    [/inter(?![a-z])|^inter/, 'Inter'],
    [/ptsans/, 'PT Sans'],
    [/ptserif/, 'PT Serif'],
    [/dejavusans|liberation/, 'Arial']
  ]
  const hit = known.find(([re]) => re.test(low.replace(/[\s_-]/g, '')))
  const family = hit ? hit[1] : generic === 'serif' ? 'Times New Roman' : generic === 'monospace' ? 'Courier New' : 'Arial'
  return { family, weight, italic }
}

/** the pixels of a PDF image (an ImageBitmap, or raw bytes in one of three layouts) -> PNG bytes */
async function pngOf(img: { bitmap?: ImageBitmap; data?: Uint8Array | Uint8ClampedArray; width: number; height: number; kind?: number }): Promise<Uint8Array | null> {
  if (!img?.width || !img?.height) return null
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d')!
  if (img.bitmap) ctx.drawImage(img.bitmap, 0, 0)
  else if (img.data) {
    const out = ctx.createImageData(img.width, img.height)
    const d = img.data
    const n = img.width * img.height
    if (img.kind === 3) out.data.set(d.subarray(0, n * 4))
    else if (img.kind === 2)
      for (let i = 0; i < n; i++) {
        out.data[i * 4] = d[i * 3]
        out.data[i * 4 + 1] = d[i * 3 + 1]
        out.data[i * 4 + 2] = d[i * 3 + 2]
        out.data[i * 4 + 3] = 255
      }
    else {
      // one bit a pixel, rows padded to whole bytes
      const row = (img.width + 7) >> 3
      for (let y = 0; y < img.height; y++)
        for (let x = 0; x < img.width; x++) {
          const v = (d[y * row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0
          const o = (y * img.width + x) * 4
          out.data[o] = out.data[o + 1] = out.data[o + 2] = v
          out.data[o + 3] = 255
        }
    }
    ctx.putImageData(out, 0, 0)
  } else return null
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'))
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null
}

type Made = Partial<GNode> & { type: GNode['type'] }

/** One page -> the layers of its frame, in page coordinates (top-left of the page is 0, 0). */
async function pageLayers(page: pdfjs.PDFPageProxy): Promise<{ w: number; h: number; nodes: Made[]; cut: boolean }> {
  const vp = page.getViewport({ scale: 1 })
  const base = vp.transform as Mat
  const [list, text] = await Promise.all([page.getOperatorList(), page.getTextContent()])
  const { layers, shown, cut } = walk(list.fnArray, list.argsArray as unknown[][], base)
  const nodes: Made[] = []
  const white = (c: RGBA | null) => !!c && c.r > 0.985 && c.g > 0.985 && c.b > 0.985
  for (const l of layers) {
    if (l.kind === 'image') {
      // pdf.js answers when the picture is decoded; one it cannot decode would never answer, so the wait is limited
      const data =
        typeof l.obj === 'string'
          ? await new Promise<unknown>((res) => {
              const give = (v: unknown) => res(v)
              setTimeout(() => res(null), 4000)
              if ((l.obj as string).startsWith('g_')) page.commonObjs.get(l.obj as string, give)
              else page.objs.get(l.obj as string, give)
            })
          : l.obj
      const png = await pngOf(data as Parameters<typeof pngOf>[0]).catch(() => null)
      if (!png || l.w < 0.5 || l.h < 0.5) continue
      const hash = await backend.blob.put(png, 'image/png')
      nodes.push({ type: 'RECTANGLE', name: 'Image', x: round2(l.x), y: round2(l.y), width: round2(l.w), height: round2(l.h), fills: [{ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL' }] })
      continue
    }
    const paint: Partial<GNode> = {
      fills: l.fill ? [{ type: 'SOLID', color: l.fill }] : [],
      strokes: l.stroke ? [{ color: l.stroke, weight: round2(l.weight), align: 'CENTER' }] : []
    }
    const r = rectOf(l.segs)
    if (r) {
      // the white sheet under everything is the frame itself
      if (!l.stroke && white(l.fill) && r.w >= vp.width * 0.98 && r.h >= vp.height * 0.98) continue
      // a rectangle with no area is a line: it stays a vector, below
      if (r.w >= 0.05 && r.h >= 0.05) {
        nodes.push({ type: 'RECTANGLE', name: 'Rectangle', x: round2(r.x), y: round2(r.y), width: round2(r.w), height: round2(r.h), ...paint })
        continue
      }
    }
    const b = segsBounds(l.segs)
    if (!isFinite(b.x) || !isFinite(b.y)) continue
    const w = Math.max(b.w, 0.01)
    const h = Math.max(b.h, 0.01)
    const local = l.segs.map((s) => ({ c: s.c, p: s.p.map((v, i) => v - (i % 2 ? b.y : b.x)) }))
    const open = !l.segs.some((s) => s.c === 'Z')
    nodes.push({ type: 'VECTOR', name: open && !l.fill ? 'Line' : 'Vector', x: round2(b.x), y: round2(b.y), width: round2(w), height: round2(h), path: segsToD(local), pathBox: { w, h }, ...(l.evenodd && { fillRule: 'evenodd' as const }), ...(open && !l.fill && { strokeCap: 'NONE' as const }), ...paint })
  }

  // text goes on top: one layer for every run pdf.js found
  for (const it of text.items) {
    if (!('str' in it) || !it.str.trim()) continue
    const m = mul(base, it.transform as Mat)
    const size = Math.hypot(m[2], m[3])
    if (size < 1) continue
    const x = m[4]
    const baseline = m[5]
    // its colour: the nearest place where text was shown on that line, at or before this run
    let best: Shown | null = null
    let bestD = Infinity
    for (const sh of shown) {
      const dy = Math.abs(sh.y - baseline)
      if (dy > size * 0.6) continue
      const dx = x - sh.x
      const d = dy * 4 + (dx >= -1 ? dx : -dx * 3 + 40)
      if (d < bestD) {
        bestD = d
        best = sh
      }
    }
    if (best?.hidden) continue // the invisible text of a scan: the picture already shows it
    const style = text.styles[it.fontName]
    let ps = ''
    try {
      ps = (page.commonObjs.has(it.fontName) ? (page.commonObjs.get(it.fontName) as { name?: string })?.name : '') ?? ''
    } catch {
      /* the font object is not there: the generic family will do */
    }
    const f = fontOf(ps, style?.fontFamily ?? 'sans-serif')
    const lineHeight = round2(size * 1.2)
    const textStyle: TextStyle = { fontFamily: f.family, fontSize: round2(size), fontWeight: f.weight, align: 'LEFT', lineHeight, ...(f.italic && { italic: true }) }
    const str = it.str.replace(/\s+$/, '')
    // another font is a little wider or narrower: the letters are spaced so that the run keeps its width
    const want = it.width * scaleOf(base)
    const measure = () => layoutText({ type: 'TEXT', characters: str, textStyle, textAutoResize: 'WIDTH_AND_HEIGHT' } as GNode).width
    let width = measure()
    if (want > 0 && str.length > 1) {
      const ls = (want - width) / (str.length - 1)
      if (Math.abs(ls) > 0.01 && Math.abs(ls) <= size * 0.12) {
        textStyle.letterSpacing = round2(ls)
        width = measure()
      }
    }
    // the run starts at (x, baseline); the middle of its line box sits about a third of the size above the baseline
    const up = size * 0.34
    const turn = Math.atan2(m[1], m[0]) // on screen, clockwise
    let left = x
    let top = baseline - up - lineHeight / 2
    if (Math.abs(turn) > 0.009) {
      // a layer turns around its centre: place the centre so that the start of the run lands where the PDF has it
      const dx = -width / 2
      const cxr = x - (Math.cos(turn) * dx - Math.sin(turn) * up)
      const cyr = baseline - (Math.sin(turn) * dx + Math.cos(turn) * up)
      left = cxr - width / 2
      top = cyr - lineHeight / 2
    }
    nodes.push({
      type: 'TEXT',
      name: str.slice(0, 40),
      x: round2(left),
      y: round2(top),
      characters: str,
      textStyle,
      textAutoResize: 'WIDTH_AND_HEIGHT',
      fills: [{ type: 'SOLID', color: best?.color ?? { r: 0, g: 0, b: 0, a: 1 } }],
      // layers count degrees counter-clockwise
      ...(Math.abs(turn) > 0.009 && { rotation: round2((-turn * 180) / Math.PI) })
    })
  }
  return { w: vp.width, h: vp.height, nodes, cut }
}

/**
 * Import a PDF: a frame for every page, laid out in rows from `at` (or from the middle of the view).
 * The whole import is one undo step. Returns the number of pages.
 */
export async function importPdf(bytes: Uint8Array, name: string, at?: { x: number; y: number }): Promise<number> {
  // fontExtraProperties: without it pdf.js does not hand over the names of the fonts, and bold text would come out regular
  const task = pdfjs.getDocument({ data: bytes, useSystemFonts: true, fontExtraProperties: true })
  const doc = await task.promise
  try {
    const pages: Awaited<ReturnType<typeof pageLayers>>[] = []
    for (let i = 1; i <= doc.numPages; i++) pages.push(await pageLayers(await doc.getPage(i)))
    if (!pages.length) return 0
    const view = ed.visibleWorldRect()
    const start = at ?? { x: view.x + view.w / 2 - pages[0].w / 2, y: view.y + view.h / 2 - pages[0].h / 2 }
    // rows of up to six pages, like sheets laid out on a table
    const perRow = pages.length <= 6 ? pages.length : Math.ceil(Math.sqrt(pages.length * 1.6))
    const frames: string[] = []
    ed.act(() => {
      let x = start.x
      let y = start.y
      let rowH = 0
      pages.forEach((p, i) => {
        if (i && i % perRow === 0) {
          x = start.x
          y += rowH + GAP
          rowH = 0
        }
        const frame = ed.addNode({ type: 'FRAME', name: pages.length > 1 ? `${name} · ${i + 1}` : name, x: round2(x), y: round2(y), width: round2(p.w), height: round2(p.h), fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }], clipsContent: true })
        for (const n of p.nodes) ed.addNode({ ...n, parentId: frame.id })
        frames.push(frame.id)
        x += p.w + GAP
        rowH = Math.max(rowH, p.h)
      })
    })
    ed.setSelection(frames)
    ed.zoomToRect(ed.selectionBounds(), 1)
    if (pages.some((p) => p.cut)) ed.showToast('Some pages are very detailed: only their first ' + MAX_LAYERS + ' elements were imported')
    return pages.length
  } finally {
    void task.destroy()
  }
}
