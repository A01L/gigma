// Decoder for Figma's native clipboard format (Figma -> Gigma, plain Ctrl+C in Figma).
// Figma puts HTML on the clipboard with a base64 "fig-kiwi" archive:
//   "fig-kiwi" | u32 version | [u32 len | chunk]...   chunk0 = schema, chunk1 = message
// Chunks are raw-deflate (older) or zstd (newer). The schema is embedded, so we decode
// with kiwi-schema and map Figma nodeChanges to Gigma nodes.
import { compileSchema, decodeBinarySchema, ByteBuffer } from 'kiwi-schema'
import { decompress as zstd } from 'fzstd'
import type { BlendMode, Effect, GNode, Paint, Stroke, RGBA } from '@shared/types'
import { BLEND_MODES } from '@shared/types'
import { DEFAULT_TEXT_STYLE } from './text'
import { base64ToBytes, keyBetween, uid } from './util'
import { segsBounds, segsToD, transformSegs, type Seg } from './svgpath'

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw')
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function unpack(chunk: Uint8Array): Promise<Uint8Array> {
  if (chunk[0] === 0x28 && chunk[1] === 0xb5 && chunk[2] === 0x2f && chunk[3] === 0xfd) return zstd(chunk)
  return inflateRaw(chunk)
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type FigNode = any

const gkey = (g: { sessionID: number; localID: number } | undefined) => (g ? `${g.sessionID}:${g.localID}` : '')

function color(c: any, opacity = 1): RGBA {
  return { r: c?.r ?? 0, g: c?.g ?? 0, b: c?.b ?? 0, a: (c?.a ?? 1) * opacity }
}

const toHex = (b: Uint8Array | number[] | undefined) => (b ? [...b].map((x) => x.toString(16).padStart(2, '0')).join('') : '')

/** Figma file key of the copied data (from the figmeta block), used to fetch images later. */
let currentFileKey: string | undefined

function paints(list: any[] | undefined): Paint[] {
  const out: Paint[] = []
  for (const p of list ?? []) {
    if (p.visible === false) continue
    if (p.type === 'SOLID') out.push({ type: 'SOLID', color: color(p.color, p.opacity ?? 1) })
    else if (p.type?.startsWith('GRADIENT') && p.stops?.length) {
      // Figma's paint transform maps the node's unit square into gradient space; the gradient runs along +x there
      const m = p.transform ?? { m00: 1, m01: 0 }
      const angle = Math.round((Math.atan2(m.m00 ?? 1, -(m.m01 ?? 0)) * 180) / Math.PI)
      out.push({
        type: p.type === 'GRADIENT_RADIAL' || p.type === 'GRADIENT_DIAMOND' ? 'GRADIENT_RADIAL' : 'GRADIENT_LINEAR',
        angle: ((angle % 360) + 360) % 360,
        stops: p.stops.map((s: any) => ({ position: s.position ?? 0, color: color(s.color, p.opacity ?? 1) }))
      })
    }
    else if (p.type === 'IMAGE') {
      // Figma's clipboard carries only the image *reference* (SHA-1 hash), not the bytes.
      // We keep the hash: Figma's hash == SHA-1 of the image bytes == Gigma's blob hash, so once the
      // bytes are fetched (Figma API) or the user drops the same image, it resolves automatically.
      const hash = toHex(p.image?.hash)
      const mode = p.imageScaleMode === 'FIT' ? 'FIT' : p.imageScaleMode === 'STRETCH' ? 'STRETCH' : 'FILL'
      if (hash) out.push({ type: 'IMAGE', imageHash: hash, scaleMode: mode, figmaFileKey: currentFileKey })
    }
  }
  return out
}

function effectsOf(list: any[] | undefined): Effect[] {
  const out: Effect[] = []
  for (const e of list ?? []) {
    const visible = e.visible !== false
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW')
      out.push({
        type: e.type,
        color: color(e.color),
        offset: { x: e.offset?.x ?? 0, y: e.offset?.y ?? 0 },
        radius: e.radius ?? 0,
        spread: e.spread ?? 0,
        visible
      })
    else if (e.type === 'FOREGROUND_BLUR' || e.type === 'LAYER_BLUR') out.push({ type: 'LAYER_BLUR', radius: e.radius ?? 0, visible })
    else if (e.type === 'BACKGROUND_BLUR') out.push({ type: 'BACKGROUND_BLUR', radius: e.radius ?? 0, visible })
  }
  return out
}

const WEIGHTS: Record<string, number> = { thin: 100, extralight: 200, light: 300, regular: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 }

function geometryToSegs(blob: Uint8Array): Seg[] {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  const segs: Seg[] = []
  let i = 0
  const f = () => {
    const v = dv.getFloat32(i, true)
    i += 4
    return v
  }
  let cx = 0, cy = 0
  while (i < blob.length) {
    const cmd = dv.getUint8(i++)
    if (cmd === 0) segs.push({ c: 'Z', p: [] })
    else if (cmd === 1) segs.push({ c: 'M', p: [(cx = f()), (cy = f())] })
    else if (cmd === 2) segs.push({ c: 'L', p: [(cx = f()), (cy = f())] })
    else if (cmd === 3) {
      const qx = f(), qy = f(), ex = f(), ey = f()
      segs.push({ c: 'C', p: [cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey] })
      cx = ex
      cy = ey
    } else if (cmd === 4) {
      const p = [f(), f(), f(), f(), f(), f()]
      segs.push({ c: 'C', p })
      cx = p[4]
      cy = p[5]
    } else break
  }
  return segs
}

/**
 * Figma "vector network" blob (what the pen tool edits):
 *   u32 vertexCount, u32 segmentCount, u32 regionCount
 *   vertices: { u32 style, f32 x, f32 y }
 *   segments: { u32 style, u32 start, f32 t0x, f32 t0y, u32 end, f32 t1x, f32 t1y }  (tangents are relative)
 *   regions:  { u32 style|winding, u32 loopCount, loops: { u32 n, u32 segIndex[n] } }
 * Regions define fillable loops; without regions we stroke every segment as an open path.
 */
export function vectorNetworkToSegs(blob: Uint8Array): { segs: Seg[]; evenOdd: boolean; closed: boolean } | null {
  try {
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
    let o = 0
    const u32 = () => {
      const v = dv.getUint32(o, true)
      o += 4
      return v
    }
    const f32 = () => {
      const v = dv.getFloat32(o, true)
      o += 4
      return v
    }
    const vc = u32()
    const sc = u32()
    const rc = u32()
    if (vc > 1e6 || sc > 1e6 || rc > 1e5) return null
    const V: { x: number; y: number }[] = []
    for (let i = 0; i < vc; i++) {
      u32()
      V.push({ x: f32(), y: f32() })
    }
    const S: { a: number; t0x: number; t0y: number; b: number; t1x: number; t1y: number }[] = []
    for (let i = 0; i < sc; i++) {
      u32()
      const a = u32()
      const t0x = f32()
      const t0y = f32()
      const b = u32()
      const t1x = f32()
      const t1y = f32()
      S.push({ a, t0x, t0y, b, t1x, t1y })
    }
    const segTo = (s: (typeof S)[number], reverse: boolean): Seg => {
      const [p, q, tp, tq] = reverse
        ? [V[s.b], V[s.a], { x: s.t1x, y: s.t1y }, { x: s.t0x, y: s.t0y }]
        : [V[s.a], V[s.b], { x: s.t0x, y: s.t0y }, { x: s.t1x, y: s.t1y }]
      if (!tp.x && !tp.y && !tq.x && !tq.y) return { c: 'L', p: [q.x, q.y] }
      return { c: 'C', p: [p.x + tp.x, p.y + tp.y, q.x + tq.x, q.y + tq.y, q.x, q.y] }
    }
    const out: Seg[] = []
    let evenOdd = false
    if (rc > 0) {
      for (let r = 0; r < rc; r++) {
        const style = u32()
        if (!(style & 1)) evenOdd = true // low bit: 1 = nonzero, 0 = evenodd
        const loops = u32()
        for (let l = 0; l < loops; l++) {
          const n = u32()
          const idx: number[] = []
          for (let k = 0; k < n; k++) idx.push(u32())
          // walk the loop, orienting each segment so it continues from the previous end vertex
          let cur = -1
          idx.forEach((si, k) => {
            const s = S[si]
            if (!s) return
            let reverse = false
            if (k === 0) {
              const next = S[idx[1]]
              reverse = !!next && (s.a === next.a || s.a === next.b) && !(s.b === next.a || s.b === next.b)
              const start = reverse ? V[s.b] : V[s.a]
              out.push({ c: 'M', p: [start.x, start.y] })
              cur = reverse ? s.b : s.a
            } else reverse = s.b === cur && s.a !== cur
            out.push(segTo(s, reverse))
            cur = reverse ? s.a : s.b
          })
          out.push({ c: 'Z', p: [] })
        }
      }
      return { segs: out, evenOdd, closed: true }
    }
    // no regions: chain segments into open polylines
    let last = -1
    for (const s of S) {
      if (s.a !== last) out.push({ c: 'M', p: [V[s.a].x, V[s.a].y] })
      out.push(segTo(s, false))
      last = s.b
    }
    return { segs: out, evenOdd: false, closed: false }
  } catch {
    return null
  }
}

export async function decodeFigmaClipboard(html: string): Promise<GNode[] | null> {
  const m = /\(figma\)([A-Za-z0-9+/=\s]+)\(\/figma\)/.exec(html)
  if (!m) return null
  currentFileKey = undefined
  const meta = /\(figmeta\)([A-Za-z0-9+/=\s]+)\(\/figmeta\)/.exec(html)
  if (meta) {
    try {
      currentFileKey = JSON.parse(new TextDecoder().decode(base64ToBytes(meta[1].replace(/\s/g, '')))).fileKey
    } catch {
      /* ignore */
    }
  }
  const bytes = base64ToBytes(m[1].replace(/\s/g, ''))
  const header = new TextDecoder().decode(bytes.subarray(0, 8))
  if (header !== 'fig-kiwi') return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let off = 12
  const chunks: Uint8Array[] = []
  while (off + 4 <= bytes.length) {
    const len = dv.getUint32(off, true)
    off += 4
    chunks.push(bytes.subarray(off, off + len))
    off += len
  }
  if (chunks.length < 2) return null
  const schema = compileSchema(decodeBinarySchema(new ByteBuffer(await unpack(chunks[0])))) as any
  const msg = schema.decodeMessage(new ByteBuffer(await unpack(chunks[1])))
  const blobs: Uint8Array[] = (msg.blobs ?? []).map((b: any) => b.bytes)
  const changes: FigNode[] = msg.nodeChanges ?? []

  const byKey = new Map<string, FigNode>()
  for (const n of changes) byKey.set(gkey(n.guid), n)
  const SKIP = new Set(['DOCUMENT', 'CANVAS'])
  const idOf = new Map<string, string>()
  for (const n of changes) if (!SKIP.has(n.type)) idOf.set(gkey(n.guid), uid())

  // order siblings by Figma's fractional position
  const sorted = changes
    .filter((n) => !SKIP.has(n.type))
    .sort((a, b) => ((a.parentIndex?.position ?? '') < (b.parentIndex?.position ?? '') ? -1 : 1))

  const out: GNode[] = []
  const lastOrder = new Map<string, string | null>()
  for (const f of sorted) {
    const k = gkey(f.guid)
    const pk = gkey(f.parentIndex?.guid)
    const parentId = idOf.get(pk) ?? null
    const prev = lastOrder.get(parentId ?? '') ?? null
    const order = keyBetween(prev, null)
    lastOrder.set(parentId ?? '', order)
    const t = f.transform ?? { m02: 0, m12: 0 }
    const w = f.size?.x ?? 1
    const h = f.size?.y ?? 1
    let type: GNode['type']
    switch (f.type) {
      case 'SECTION':
        type = 'SECTION'
        break
      case 'FRAME':
      case 'INSTANCE':
      case 'SYMBOL':
      case 'COMPONENT':
      case 'COMPONENT_SET':
        type = f.resizeToFit ? 'GROUP' : 'FRAME'
        break
      case 'GROUP':
        type = 'GROUP'
        break
      case 'RECTANGLE':
      case 'ROUNDED_RECTANGLE':
        type = 'RECTANGLE'
        break
      case 'ELLIPSE':
        type = 'ELLIPSE'
        break
      case 'TEXT':
        type = 'TEXT'
        break
      default:
        type = 'VECTOR'
    }
    const strokes: Stroke[] = paints(f.strokePaints)
      .filter((p): p is Extract<Paint, { type: 'SOLID' }> => p.type === 'SOLID')
      .map((p) => ({ color: p.color, weight: f.strokeWeight ?? 1, align: f.strokeAlign ?? 'INSIDE' }))
    const n: GNode = {
      id: idOf.get(k)!,
      type,
      name: f.name ?? type,
      parentId,
      pageId: '',
      order,
      x: t.m02 ?? 0,
      y: t.m12 ?? 0,
      width: w,
      height: h,
      opacity: f.opacity ?? 1,
      visible: f.visible !== false,
      locked: !!f.locked,
      fills: paints(f.fillPaints),
      strokes,
      cornerRadius: f.cornerRadius || undefined,
      clipsContent: type === 'FRAME' ? !f.frameMaskDisabled : undefined
    }
    // independent corner radii
    const cr = [f.rectangleTopLeftCornerRadius, f.rectangleTopRightCornerRadius, f.rectangleBottomRightCornerRadius, f.rectangleBottomLeftCornerRadius]
    if (f.rectangleCornerRadiiIndependent && cr.some((v) => v)) {
      n.cornerRadii = cr.map((v) => v ?? 0) as [number, number, number, number]
      n.cornerRadius = undefined
    }
    // rotation: Figma stores a 2x3 matrix whose origin is the rotated top-left corner.
    // Gigma rotates around the center, so recover the unrotated box from the transformed center.
    const m00 = t.m00 ?? 1
    const m01 = t.m01 ?? 0
    const m10 = t.m10 ?? 0
    const m11 = t.m11 ?? 1
    if (Math.abs(m10) > 1e-6 || Math.abs(m01) > 1e-6 || m00 < 0 || m11 < 0) {
      const cx = (t.m02 ?? 0) + (m00 * w) / 2 + (m01 * h) / 2
      const cy = (t.m12 ?? 0) + (m10 * w) / 2 + (m11 * h) / 2
      n.x = cx - w / 2
      n.y = cy - h / 2
      const det = m00 * m11 - m01 * m10
      if (det < 0) n.flipY = true // mirrored: treat as vertical flip + rotation
      const ang = (Math.atan2(m10, m00) * 180) / Math.PI // clockwise on screen
      const rot = Math.round(-ang * 100) / 100
      if (rot) n.rotation = rot
    }
    if (type === 'TEXT') {
      const style = String(f.fontName?.style ?? 'Regular').toLowerCase().replace(/[\s-]/g, '')
      const lh = f.lineHeight
      n.characters = f.textData?.characters ?? ''
      n.textStyle = {
        ...DEFAULT_TEXT_STYLE,
        fontFamily: f.fontName?.family ?? 'Inter',
        fontSize: f.fontSize ?? 16,
        fontWeight: WEIGHTS[style.replace('italic', '')] ?? 400,
        italic: style.includes('italic') || undefined,
        align:
          f.textAlignHorizontal === 'CENTER' ? 'CENTER' : f.textAlignHorizontal === 'RIGHT' ? 'RIGHT' : f.textAlignHorizontal === 'JUSTIFIED' ? 'JUSTIFIED' : 'LEFT',
        verticalAlign: f.textAlignVertical === 'CENTER' ? 'CENTER' : f.textAlignVertical === 'BOTTOM' ? 'BOTTOM' : undefined,
        // Figma "Auto" line height arrives as 100% RAW/PERCENT; keep Auto in that case
        lineHeight: lh?.units === 'PIXELS' ? lh.value : undefined,
        lineHeightPercent: lh?.units === 'PERCENT' && lh.value !== 100 ? lh.value : lh?.units === 'RAW' && lh.value !== 1 ? lh.value * 100 : undefined,
        letterSpacing: f.letterSpacing?.units === 'PIXELS' ? f.letterSpacing.value : undefined,
        letterSpacingPercent: f.letterSpacing?.units === 'PERCENT' && f.letterSpacing.value ? f.letterSpacing.value : undefined,
        decoration: f.textDecoration === 'UNDERLINE' ? 'UNDERLINE' : f.textDecoration === 'STRIKETHROUGH' ? 'STRIKETHROUGH' : undefined,
        textCase: f.textCase === 'UPPER' ? 'UPPER' : f.textCase === 'LOWER' ? 'LOWER' : f.textCase === 'TITLE' ? 'TITLE' : undefined,
        paragraphSpacing: f.paragraphSpacing || undefined,
        truncate: f.textTruncation === 'ENDING' || undefined,
        verticalTrim: f.leadingTrim === 'CAP_HEIGHT' ? 'CAP_HEIGHT' : undefined,
        wrapStyle: f.textWrapStyle === 'BALANCE' || f.textWrapStyle === 'BALANCED' ? 'BALANCED' : undefined
      }
      n.textAutoResize = f.textAutoResize === 'WIDTH_AND_HEIGHT' ? 'WIDTH_AND_HEIGHT' : f.textAutoResize === 'HEIGHT' ? 'HEIGHT' : 'NONE'
    }
    if (f.mask || f.isMask) n.isMask = true
    // blend mode (PASS_THROUGH / NORMAL = default)
    if (typeof f.blendMode === 'string' && (BLEND_MODES as readonly string[]).includes(f.blendMode) && f.blendMode !== 'NORMAL') n.blendMode = f.blendMode as BlendMode
    // auto layout (Figma calls it "stack" internally)
    if (type === 'FRAME' && (f.stackMode === 'HORIZONTAL' || f.stackMode === 'VERTICAL')) {
      n.layoutMode = f.stackMode
      n.itemSpacing = f.stackSpacing ?? 0
      n.paddingLeft = f.stackHorizontalPadding ?? f.stackPadding ?? 0
      n.paddingTop = f.stackVerticalPadding ?? f.stackPadding ?? 0
      n.paddingRight = f.stackPaddingRight ?? n.paddingLeft
      n.paddingBottom = f.stackPaddingBottom ?? n.paddingTop
      const al = (v: unknown) => (v === 'CENTER' ? 'CENTER' : v === 'MAX' ? 'MAX' : 'MIN')
      n.primaryAxisAlignItems = String(f.stackPrimaryAlignItems ?? f.stackJustify ?? '').startsWith('SPACE') ? 'SPACE_BETWEEN' : al(f.stackPrimaryAlignItems ?? f.stackJustify)
      n.counterAxisAlignItems = al(f.stackCounterAlignItems ?? f.stackCounterAlign)
      const hug = (v: unknown) => (typeof v === 'string' && v.startsWith('RESIZE_TO_FIT') ? 'AUTO' : 'FIXED')
      // older files have no explicit sizing: hugging was the default
      n.primaryAxisSizingMode = f.stackPrimarySizing === undefined ? 'AUTO' : hug(f.stackPrimarySizing)
      n.counterAxisSizingMode = hug(f.stackCounterSizing)
    }
    if (n.layoutMode && f.stackWrap === 'WRAP') {
      n.layoutWrap = 'WRAP'
      n.counterAxisSpacing = f.stackCounterSpacing ?? 0
    }
    // constraints (MIN / MIN is the default and is not stored)
    const cons = (v: unknown) => (v === 'CENTER' || v === 'MAX' || v === 'STRETCH' || v === 'SCALE' ? v : 'MIN')
    const ch = cons(f.horizontalConstraint)
    const cv = cons(f.verticalConstraint)
    if (ch !== 'MIN' || cv !== 'MIN') n.constraints = { horizontal: ch, vertical: cv }
    if (f.stackChildPrimaryGrow) n.layoutGrow = 1
    if (f.stackChildAlignSelf === 'STRETCH') n.layoutAlign = 'STRETCH'
    if (f.stackPositioning === 'ABSOLUTE') n.layoutPositioning = 'ABSOLUTE'
    const fx = effectsOf(f.effects)
    if (fx.length) n.effects = fx
    if (type === 'VECTOR') {
      // 1) precomputed fill outline (node-local coordinates)
      const segs: Seg[] = []
      for (const g of f.fillGeometry ?? []) if (blobs[g.commandsBlob]) segs.push(...geometryToSegs(blobs[g.commandsBlob]))
      let fillRule: 'nonzero' | 'evenodd' = f.fillGeometry?.[0]?.windingRule === 'ODD' ? 'evenodd' : 'nonzero'
      // 2) pen-tool shapes often only carry the editable vector network
      if (!segs.length && f.vectorData?.vectorNetworkBlob !== undefined && blobs[f.vectorData.vectorNetworkBlob]) {
        const net = vectorNetworkToSegs(blobs[f.vectorData.vectorNetworkBlob])
        if (net) {
          const ns = f.vectorData.normalizedSize ?? { x: w, y: h }
          const sx = ns.x ? w / ns.x : 1
          const sy = ns.y ? h / ns.y : 1
          segs.push(...transformSegs(net.segs, [sx, 0, 0, sy, 0, 0]))
          if (net.evenOdd) fillRule = 'evenodd'
          if (!net.closed && !n.strokes.length && n.fills.length) {
            // open path with only a fill: Figma still fills it; keep as is
          }
        }
      }
      // 3) last resort: stroke outline geometry, drawn as a filled shape in the stroke colour
      if (!segs.length) {
        for (const g of f.strokeGeometry ?? []) if (blobs[g.commandsBlob]) segs.push(...geometryToSegs(blobs[g.commandsBlob]))
        if (segs.length) {
          n.fills = strokes.map((s) => ({ type: 'SOLID' as const, color: s.color }))
          n.strokes = []
        }
      }
      if (segs.length) {
        n.path = segsToD(segs)
        n.pathBox = { w: w || segsBounds(segs).w || 1, h: h || segsBounds(segs).h || 1 }
        n.fillRule = fillRule
      } else {
        n.type = 'RECTANGLE'
      }
    }
    out.push(n)
  }
  return out.length ? out : null
}
