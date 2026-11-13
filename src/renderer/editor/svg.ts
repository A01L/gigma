// SVG import/export.
// SVG is the lingua franca with Figma: Figma pastes SVG markup as editable vector layers,
// and "Copy as SVG" in Figma gives us SVG we can import. Gigma additionally embeds its own
// lossless node data in <metadata> so Gigma -> Gigma copy/paste keeps everything.
import type { GNode, Paint, RGBA, Stroke } from '@shared/types'
import { handlesOf } from './gradient'
import { blendCss, rgbaToHex } from '@shared/types'
import { booleanAsVector, isBooleanGroup } from './boolean'
import { backend } from '../backend'
import type { Editor } from './editor'
import { layoutText, DEFAULT_TEXT_STYLE, justifyWords, lineX, textBaseline, verticalOffset } from './text'
import { base64ToBytes, bytesToBase64, uid, unionRects, keyBetween } from './util'
import { parsePath, segsBounds, segsToD, transformSegs, type Mat, type Seg } from './svgpath'
import { capsOf, dashOf, endShape, isOpenPath, joinOf, miterLimitOf, pathEnds, plainCap } from './stroke'
import { strokeArt } from './stroke-art'
import { clipsAsShape, cornerRadiiOf } from './render'
import { codeToPngDataUrl } from './code-render'

const META_TAG = 'gigma-data'

// =====================================================================
// import
// =====================================================================

function parseCssColor(v: string | null): RGBA | null {
  if (!v || v === 'none' || v === 'transparent') return null
  const m = /rgba?\(([^)]+)\)/.exec(v)
  if (!m) return null
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat)
  return { r: parts[0] / 255, g: parts[1] / 255, b: parts[2] / 255, a: parts[3] ?? 1 }
}

function gradientFallback(svg: SVGSVGElement, v: string): RGBA | null {
  const m = /url\(["']?#([^"')]+)["']?\)/.exec(v)
  if (!m) return null
  const grad = svg.querySelector('#' + CSS.escape(m[1]))
  const stop = grad?.querySelector('stop')
  if (!stop) return null
  return parseCssColor(getComputedStyle(stop).stopColor) ?? null
}

/** Figma "Copy as SVG" puts images into <pattern> fills: resolve pattern -> <use> -> <image href="data:..."> */
function patternImage(svg: SVGSVGElement, v: string): { mime: string; b64: string } | null {
  const m = /url\(["']?#([^"')]+)["']?\)/.exec(v)
  if (!m) return null
  const pat = svg.querySelector('#' + CSS.escape(m[1]))
  if (!pat || pat.tagName.toLowerCase() !== 'pattern') return null
  let img: Element | null = pat.querySelector('image')
  if (!img) {
    const use = pat.querySelector('use')
    const ref = use?.getAttribute('href') ?? use?.getAttribute('xlink:href')
    if (ref?.startsWith('#')) img = svg.querySelector('#' + CSS.escape(ref.slice(1)))
  }
  const href = img?.getAttribute('href') ?? img?.getAttribute('xlink:href') ?? ''
  const dm = /^data:([^;]+);base64,(.*)$/s.exec(href)
  return dm ? { mime: dm[1], b64: dm[2] } : null
}

function shapeSegs(el: Element): Seg[] | null {
  const n = (a: string) => parseFloat(el.getAttribute(a) ?? '0') || 0
  switch (el.tagName.toLowerCase()) {
    case 'path':
      return parsePath(el.getAttribute('d') ?? '')
    case 'rect': {
      const x = n('x'), y = n('y'), w = n('width'), h = n('height')
      let rx = n('rx'), ry = n('ry')
      if (!el.hasAttribute('ry')) ry = rx
      if (!el.hasAttribute('rx')) rx = ry
      rx = Math.min(rx, w / 2)
      ry = Math.min(ry, h / 2)
      if (!rx && !ry) return parsePath(`M${x} ${y}H${x + w}V${y + h}H${x}Z`)
      return parsePath(
        `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}` +
          `H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
      )
    }
    case 'circle':
    case 'ellipse': {
      const cx = n('cx'), cy = n('cy')
      const rx = el.tagName === 'circle' ? n('r') : n('rx')
      const ry = el.tagName === 'circle' ? n('r') : n('ry')
      return parsePath(`M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`)
    }
    case 'line':
      return parsePath(`M${n('x1')} ${n('y1')}L${n('x2')} ${n('y2')}`)
    case 'polyline':
    case 'polygon': {
      const pts = (el.getAttribute('points') ?? '').trim()
      if (!pts) return null
      return parsePath('M' + pts + (el.tagName === 'polygon' ? 'Z' : ''))
    }
  }
  return null
}

const SKIP = new Set(['defs', 'clippath', 'mask', 'symbol', 'pattern', 'marker', 'lineargradient', 'radialgradient', 'style', 'title', 'desc', 'metadata', 'filter', 'script', 'foreignobject'])

/** Extract Gigma's own embedded nodes from SVG markup (lossless round trip). */
export function extractGigmaData(svgText: string): GNode[] | null {
  const m = new RegExp(`<${META_TAG}[^>]*>([^<]+)</${META_TAG}>`).exec(svgText)
  if (!m) return null
  try {
    return JSON.parse(new TextDecoder().decode(base64ToBytes(m[1].trim()))) as GNode[]
  } catch {
    return null
  }
}

/** Re-register images embedded in the SVG (data-hash) so pasted IMAGE fills resolve in this project. */
export async function registerEmbeddedImages(svgText: string): Promise<void> {
  const re = /data-hash="([0-9a-f]+)"[^>]*?href="data:([^;]+);base64,([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(svgText))) await backend.blob.put(base64ToBytes(m[3]), m[2])
}

/**
 * Convert SVG markup to Gigma nodes (world coordinates, parent links), ready for editor.pasteNodes().
 */
export async function svgToNodes(svgText: string, opts: { name?: string; width?: number } = {}): Promise<GNode[]> {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const src = doc.querySelector('svg')
  if (!src || doc.querySelector('parsererror')) throw new Error('Invalid SVG')
  const svg = document.importNode(src, true) as SVGSVGElement
  // give it a definite size
  const vb = svg.viewBox?.baseVal
  if (!svg.getAttribute('width') && vb?.width) svg.setAttribute('width', String(vb.width))
  if (!svg.getAttribute('height') && vb?.height) svg.setAttribute('height', String(vb.height))
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-100000px;top:0;opacity:0;pointer-events:none'
  host.appendChild(svg)
  document.body.appendChild(host)
  try {
    const box = svg.getBoundingClientRect()
    let scale = 1
    if (opts.width && box.width) scale = opts.width / box.width
    const toLocal = (el: SVGGraphicsElement): Mat => {
      const m = el.getScreenCTM()
      if (!m) return [scale, 0, 0, scale, 0, 0]
      return [m.a * scale, m.b * scale, m.c * scale, m.d * scale, (m.e - box.left) * scale, (m.f - box.top) * scale]
    }
    const out: GNode[] = []
    const groupId = uid()
    let order: string | null = null
    const nextOrder = () => (order = keyBetween(order, null))
    const base = (type: GNode['type'], name: string): GNode => ({
      id: uid(),
      type,
      name,
      parentId: groupId,
      pageId: '',
      order: nextOrder(),
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      opacity: 1,
      visible: true,
      locked: false,
      fills: [],
      strokes: []
    })
    const inheritedOpacity = (el: Element) => {
      let o = 1
      for (let e: Element | null = el; e && e !== svg.parentElement; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity || '1')
      return o
    }

    const walk = async (el: Element) => {
      const tag = el.tagName.toLowerCase()
      if (SKIP.has(tag)) return
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') return
      if (tag === 'g' || tag === 'svg' || tag === 'a') {
        for (const c of Array.from(el.children)) await walk(c)
        return
      }
      const g = el as SVGGraphicsElement
      const m = toLocal(g)
      const s = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1
      const opacity = inheritedOpacity(el)

      if (tag === 'text') {
        const bb = g.getBBox()
        const pts = transformSegs([{ c: 'M', p: [bb.x, bb.y] }, { c: 'L', p: [bb.x + bb.width, bb.y + bb.height] }], m)
        const r = segsBounds(pts)
        const n = base('TEXT', (el.textContent ?? 'Text').trim().slice(0, 40) || 'Text')
        const color = parseCssColor(cs.fill) ?? { r: 0, g: 0, b: 0, a: 1 }
        n.characters = (el.textContent ?? '').trim()
        n.textStyle = {
          ...DEFAULT_TEXT_STYLE,
          fontFamily: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim() || 'Inter',
          fontSize: Math.max(1, parseFloat(cs.fontSize) * s),
          fontWeight: parseInt(cs.fontWeight) || 400
        }
        n.textAutoResize = 'WIDTH_AND_HEIGHT'
        n.fills = [{ type: 'SOLID', color: { ...color, a: color.a * parseFloat(cs.fillOpacity || '1') } }]
        n.opacity = opacity
        Object.assign(n, { x: r.x, y: r.y, width: r.w, height: r.h })
        const l = layoutText(n)
        n.width = l.width
        n.height = l.height
        out.push(n)
        return
      }

      if (tag === 'image') {
        const href = el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? ''
        const dm = /^data:([^;]+);base64,(.*)$/s.exec(href)
        if (!dm) return // offline app: remote images are not fetched
        const hash = await backend.blob.put(base64ToBytes(dm[2]), dm[1])
        const bb = g.getBBox()
        const r = segsBounds(transformSegs([{ c: 'M', p: [bb.x, bb.y] }, { c: 'L', p: [bb.x + bb.width, bb.y + bb.height] }], m))
        const n = base('RECTANGLE', 'Image')
        const par = el.getAttribute('preserveAspectRatio') ?? ''
        n.fills = [{ type: 'IMAGE', imageHash: hash, scaleMode: par === 'none' ? 'STRETCH' : par.includes('slice') ? 'FILL' : 'FIT' }]
        n.opacity = opacity
        Object.assign(n, { x: r.x, y: r.y, width: r.w, height: r.h })
        out.push(n)
        return
      }

      const segs = shapeSegs(el)
      if (!segs || !segs.length) return
      const fill = cs.fill.startsWith('url(') ? gradientFallback(svg, cs.fill) : parseCssColor(cs.fill)
      const stroke = cs.stroke.startsWith('url(') ? gradientFallback(svg, cs.stroke) : parseCssColor(cs.stroke)
      const sw = parseFloat(cs.strokeWidth) || 0
      const fills: Paint[] = fill && !['line', 'polyline'].includes(tag) ? [{ type: 'SOLID', color: { ...fill, a: fill.a * parseFloat(cs.fillOpacity || '1') } }] : []
      const pimg = cs.fill.startsWith('url(') ? patternImage(svg, cs.fill) : null
      if (pimg) fills.splice(0, fills.length, { type: 'IMAGE', imageHash: await backend.blob.put(base64ToBytes(pimg.b64), pimg.mime), scaleMode: 'FILL' })
      const strokes: Stroke[] = stroke && sw > 0 ? [{ color: { ...stroke, a: stroke.a * parseFloat(cs.strokeOpacity || '1') }, weight: sw * s, align: 'CENTER' }] : []
      if (!fills.length && !strokes.length) return

      const world = transformSegs(segs, m)
      const r = segsBounds(world)
      const local = transformSegs(world, [1, 0, 0, 1, -r.x, -r.y])
      const axisAligned = Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9
      let n: GNode
      if (axisAligned && (tag === 'rect' || tag === 'circle' || tag === 'ellipse') && !(tag === 'rect' && el.getAttribute('ry') && el.getAttribute('ry') !== el.getAttribute('rx'))) {
        n = base(tag === 'rect' ? 'RECTANGLE' : 'ELLIPSE', tag === 'rect' ? 'Rectangle' : 'Ellipse')
        if (tag === 'rect') {
          const rx = parseFloat(el.getAttribute('rx') ?? el.getAttribute('ry') ?? '0') || 0
          if (rx) n.cornerRadius = rx * Math.abs(m[0])
        }
      } else {
        n = base('VECTOR', el.getAttribute('id') || 'Vector')
        n.path = segsToD(local)
        n.pathBox = { w: Math.max(r.w, 0.01), h: Math.max(r.h, 0.01) }
        n.fillRule = cs.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'
      }
      n.fills = fills
      n.strokes = strokes
      n.opacity = opacity
      Object.assign(n, { x: r.x, y: r.y, width: Math.max(r.w, 0.01), height: Math.max(r.h, 0.01) })
      out.push(n)
    }

    await walk(svg)
    if (!out.length) throw new Error('SVG contains no drawable elements')
    if (out.length === 1) {
      out[0].parentId = null
      if (opts.name) out[0].name = opts.name
      return out
    }
    const b = unionRects(out.map((n) => ({ x: n.x, y: n.y, w: n.width, h: n.height })))!
    for (const n of out) {
      n.x -= b.x
      n.y -= b.y
    }
    const group: GNode = {
      id: groupId,
      type: 'GROUP',
      name: opts.name ?? svg.getAttribute('id') ?? 'SVG',
      parentId: null,
      pageId: '',
      order: 'a0',
      x: b.x,
      y: b.y,
      width: b.w,
      height: b.h,
      opacity: 1,
      visible: true,
      locked: false,
      fills: [],
      strokes: []
    }
    return [group, ...out]
  } finally {
    host.remove()
  }
}

// =====================================================================
// export
// =====================================================================

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const f = (v: number) => String(Math.round(v * 1000) / 1000)

/** fills array -> "url(#gradient)" registered by nodeSvgInner for nodes whose top fill is a gradient */
const gradientRefs = new WeakMap<Paint[], string>()

function gradientDef(p: Extract<Paint, { stops: unknown }>, id: string, w: number, h: number): string {
  const stops = [...p.stops]
    .sort((a, b) => a.position - b.position)
    .map((st) => `<stop offset="${f(st.position)}" stop-color="${rgbaToHex(st.color)}"${st.color.a < 1 ? ` stop-opacity="${f(st.color.a)}"` : ''}/>`)
    .join('')
  const op = (p.opacity ?? 1) < 1 ? ` opacity="${f(p.opacity!)}"` : ''
  const [h0, h1, h2] = handlesOf(p, w, h)
  // SVG has no angular or diamond gradient: they go out as a radial one of the same place and size
  if (p.type !== 'GRADIENT_LINEAR')
    return `<radialGradient id="${id}" cx="0" cy="0" r="1" gradientTransform="matrix(${f(h1.x - h0.x)} ${f(h1.y - h0.y)} ${f(h2.x - h0.x)} ${f(h2.y - h0.y)} ${f(h0.x)} ${f(h0.y)})"${op}>${stops}</radialGradient>`
  return `<linearGradient id="${id}" x1="${f(h0.x)}" y1="${f(h0.y)}" x2="${f(h1.x)}" y2="${f(h1.y)}"${op}>${stops}</linearGradient>`
}

function paintAttrs(n: GNode): string {
  const solid = n.fills.find((p) => p.type === 'SOLID' && p.visible !== false)
  let s = ''
  const grad = gradientRefs.get(n.fills)
  if (grad && n.fills.length) s += ` fill="${grad}"`
  else if (solid && solid.type === 'SOLID') {
    s += ` fill="${rgbaToHex(solid.color)}"`
    if (solid.color.a < 1) s += ` fill-opacity="${f(solid.color.a)}"`
  } else s += ' fill="none"'
  const st = n.strokes.find((x) => x.visible !== false && x.weight > 0)
  if (st) {
    s += ` stroke="${rgbaToHex(st.color)}" stroke-width="${f(st.weight)}"`
    if (st.color.a < 1) s += ` stroke-opacity="${f(st.color.a)}"`
    const join = joinOf(n)
    if (join !== 'miter') s += ` stroke-linejoin="${join}"`
    else s += ` stroke-miterlimit="${f(miterLimitOf(n))}"`
    const dash = dashOf(n)
    if (dash) s += ` stroke-dasharray="${f(dash[0])} ${f(dash[1])}"`
    // one cap for both ends is all SVG has; ends that differ and arrows are separate shapes (see the VECTOR case)
    const caps = isOpenPath(n) ? capsOf(n) : null
    const cap = dash ? plainCap(n.dashCap ?? 'NONE') : caps && caps.start === caps.end ? plainCap(caps.start) : null
    if (cap && cap !== 'butt') s += ` stroke-linecap="${cap}"`
  }
  if (n.opacity < 1) s += ` opacity="${f(n.opacity)}"`
  if (n.blendMode && n.blendMode !== 'NORMAL') s += ` style="mix-blend-mode:${blendCss(n.blendMode)}"`
  return s
}

async function imageHref(hash: string): Promise<{ mime: string; b64: string } | null> {
  try {
    const blob = await (await fetch(backend.blob.url(hash))).blob()
    return { mime: blob.type || 'image/png', b64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) }
  } catch {
    return null
  }
}

/** SVG filter for drop shadows / inner shadows / layer blur (background blur has no SVG equivalent). */
function effectFilter(n: GNode, defs: string[]): string | null {
  const fx = (n.effects ?? []).filter((e) => e.visible !== false && e.type !== 'BACKGROUND_BLUR')
  if (!fx.length) return null
  const id = 'fx' + defs.length
  const parts: string[] = []
  const merge: string[] = []
  fx.forEach((e, i) => {
    if (e.type === 'DROP_SHADOW') {
      parts.push(
        `<feDropShadow dx="${f(e.offset.x)}" dy="${f(e.offset.y)}" stdDeviation="${f(e.radius / 2)}" flood-color="${rgbaToHex(e.color)}" flood-opacity="${f(e.color.a)}" result="s${i}"/>`
      )
      merge.push(`s${i}`)
    } else if (e.type === 'INNER_SHADOW') {
      parts.push(
        `<feOffset in="SourceAlpha" dx="${f(e.offset.x)}" dy="${f(e.offset.y)}"/><feGaussianBlur stdDeviation="${f(e.radius / 2)}"/>` +
          `<feComposite operator="arithmetic" in2="SourceAlpha" k2="-1" k3="1"/>` +
          `<feColorMatrix values="0 0 0 0 ${f(e.color.r)} 0 0 0 0 ${f(e.color.g)} 0 0 0 0 ${f(e.color.b)} 0 0 0 ${f(e.color.a)} 0" result="i${i}"/>`
      )
      merge.push(`i${i}`)
    }
  })
  const blur = fx.find((e) => e.type === 'LAYER_BLUR')
  let body = parts.join('')
  if (merge.length) {
    // shadows under the graphic, inner shadows over it
    const drops = merge.filter((m) => m.startsWith('s'))
    const inners = merge.filter((m) => m.startsWith('i'))
    body += `<feMerge result="m">${drops.map((m) => `<feMergeNode in="${m}"/>`).join('')}<feMergeNode in="SourceGraphic"/>${inners
      .map((m) => `<feMergeNode in="${m}"/>`)
      .join('')}</feMerge>`
  }
  if (blur) body += `<feGaussianBlur in="${merge.length ? 'm' : 'SourceGraphic'}" stdDeviation="${f(blur.radius / 2)}"/>`
  defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${body}</filter>`)
  return id
}

async function nodeSvg(ed: Editor, id: string, ox: number, oy: number, defs: string[]): Promise<string> {
  const inner = await nodeSvgInner(ed, id, ox, oy, defs)
  const n = ed.nodes.get(id)
  if (!inner || !n) return inner
  const fid = effectFilter(n, defs)
  let out = fid ? `<g filter="url(#${fid})">${inner}</g>` : inner
  if (n.rotation || n.flipX || n.flipY) {
    const w = ed.world(id)
    const cx = f(w.x - ox + w.w / 2)
    const cy = f(w.y - oy + w.h / 2)
    const parts = [`translate(${cx} ${cy})`]
    if (n.rotation) parts.push(`rotate(${f(-n.rotation)})`)
    if (n.flipX || n.flipY) parts.push(`scale(${n.flipX ? -1 : 1} ${n.flipY ? -1 : 1})`)
    parts.push(`translate(-${cx} -${cy})`.replace(/--/g, ''))
    out = `<g transform="${parts.join(' ')}">${out}</g>`
  }
  return out
}

async function nodeSvgInner(ed: Editor, id: string, ox: number, oy: number, defs: string[]): Promise<string> {
  const src = ed.nodes.get(id)!
  if (!src.visible) return ''
  // a boolean group is exported as the single path it draws
  const n = isBooleanGroup(src) ? booleanAsVector(ed, src) : src
  const w = ed.world(id)
  const x = w.x - ox
  const y = w.y - oy
  const name = ` data-name="${esc(n.name)}"`
  const rect = (attrs: string) => {
    if (n.type === 'ELLIPSE') return `<ellipse cx="${f(x + w.w / 2)}" cy="${f(y + w.h / 2)}" rx="${f(w.w / 2)}" ry="${f(w.h / 2)}"${attrs}/>`
    const rr = cornerRadiiOf(n, w)
    if (rr && new Set(rr).size > 1) {
      // independent corners: explicit path (tl, tr, br, bl)
      const [tl, tr, br, bl] = rr
      const X = x + w.w
      const Y = y + w.h
      const d =
        `M${f(x + tl)} ${f(y)}H${f(X - tr)}A${f(tr)} ${f(tr)} 0 0 1 ${f(X)} ${f(y + tr)}V${f(Y - br)}A${f(br)} ${f(br)} 0 0 1 ${f(X - br)} ${f(Y)}` +
        `H${f(x + bl)}A${f(bl)} ${f(bl)} 0 0 1 ${f(x)} ${f(Y - bl)}V${f(y + tl)}A${f(tl)} ${f(tl)} 0 0 1 ${f(x + tl)} ${f(y)}Z`
      return `<path d="${d}"${attrs}/>`
    }
    return `<rect x="${f(x)}" y="${f(y)}" width="${f(w.w)}" height="${f(w.h)}"${rr ? ` rx="${f(rr[0])}"` : ''}${attrs}/>`
  }

  // topmost visible gradient fill becomes an SVG gradient
  const topFill = [...n.fills].reverse().find((p) => p.visible !== false)
  gradientRefs.delete(n.fills)
  if (topFill && 'stops' in topFill) {
    const gid = 'g' + defs.length
    defs.push(gradientDef(topFill, gid, n.width, n.height))
    gradientRefs.set(n.fills, `url(#${gid})`)
  }

  let imgs = ''
  for (const p of n.fills) {
    if (p.type !== 'IMAGE' || p.visible === false) continue
    const h = await imageHref(p.imageHash)
    if (!h) continue
    const clip = 'c' + defs.length
    defs.push(`<clipPath id="${clip}">${rect('')}</clipPath>`)
    const par = p.scaleMode === 'STRETCH' ? 'none' : p.scaleMode === 'FIT' ? 'xMidYMid meet' : 'xMidYMid slice'
    if (p.scaleMode === 'STRETCH' && p.transform) {
      // a cropped picture: the whole picture is placed through the inverse of the crop matrix and cut by the box
      const [a, b, c, d, e, g] = p.transform
      const det = a * d - b * c
      if (Math.abs(det) > 1e-9) {
        const m = [d / det, -b / det, -c / det, a / det, (c * g - d * e) / det, (b * e - a * g) / det]
        imgs += `<g clip-path="url(#${clip})"><image data-hash="${p.imageHash}" width="1" height="1" preserveAspectRatio="none" transform="translate(${f(x)} ${f(y)}) scale(${f(w.w)} ${f(w.h)}) matrix(${m.map((v) => String(Math.round(v * 1e6) / 1e6)).join(' ')})" href="data:${h.mime};base64,${h.b64}"/></g>`
        continue
      }
    }
    imgs += `<image data-hash="${p.imageHash}" x="${f(x)}" y="${f(y)}" width="${f(w.w)}" height="${f(w.h)}" preserveAspectRatio="${par}" clip-path="url(#${clip})" href="data:${h.mime};base64,${h.b64}"/>`
  }

  switch (n.type) {
    case 'RECTANGLE':
    case 'ELLIPSE':
    case 'IMAGE': {
      const hasSolid = n.fills.some((p) => p.type === 'SOLID' || 'stops' in p)
      const shape = hasSolid || n.strokes.length ? rect(paintAttrs(n) + name) : ''
      return imgs ? `<g${name}${n.opacity < 1 ? ` opacity="${f(n.opacity)}"` : ''}>${imgs}${shape}</g>` : shape
    }
    case 'VECTOR': {
      if (!n.path) return ''
      const sx = w.w / (n.pathBox?.w || w.w || 1)
      const sy = w.h / (n.pathBox?.h || w.h || 1)
      const segs = transformSegs(parsePath(n.path), [sx, 0, 0, sy, x, y])
      const d = segsToD(segs)
      const st = n.strokes.find((s) => s.visible !== false && s.weight > 0)
      const ink = st ? ` fill="${rgbaToHex(st.color)}"${st.color.a < 1 ? ` fill-opacity="${f(st.color.a)}"` : ''}` : ''
      // a width profile or a brush is an area: the path keeps its fill only, the stroke goes out as that area.
      // A dynamic stroke is another line: the fill stays on the path, the stroke is drawn along the shaken line.
      const art = st ? strokeArt(n, st.weight, d) : null
      const body = art && n.fills.some((p) => p.visible !== false) ? `<path d="${d}"${n.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : ''}${paintAttrs({ ...n, strokes: [] })}${name}/>` : ''
      if (art?.area) return body + `<path d="${art.area}"${ink}${n.opacity < 1 ? ` opacity="${f(n.opacity)}"` : ''}${body ? '' : name}/>`
      let out = art?.line ? body + `<path d="${art.line}"${paintAttrs({ ...n, fills: [] })}${body ? '' : name}/>` : `<path d="${d}"${n.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : ''}${paintAttrs(n)}${name}/>`
      const caps = st && isOpenPath(n) ? capsOf(n) : null
      const ends = caps ? pathEnds(segs) : null
      if (st && caps && ends) {
        const dash = dashOf(n)
        const both = caps.start === caps.end ? plainCap(caps.start) : null
        for (const [kind, e] of [[caps.start, ends.start], [caps.end, ends.end]] as const) {
          if (dash ? plainCap(kind) : both) continue
          const shape = endShape(kind, e, st.weight)
          if (!shape) continue
          for (const poly of shape.polys) out += `<path d="M${poly.map((p) => f(p[0]) + ' ' + f(p[1])).join('L')}Z"${ink}/>`
          if (shape.circle) out += `<circle cx="${f(shape.circle.x)}" cy="${f(shape.circle.y)}" r="${f(shape.circle.r)}"${ink}/>`
          if (shape.line) out += `<path d="M${shape.line.map((p) => f(p[0]) + ' ' + f(p[1])).join('L')}" fill="none" stroke="${rgbaToHex(st.color)}" stroke-width="${f(st.weight)}"${st.color.a < 1 ? ` stroke-opacity="${f(st.color.a)}"` : ''}/>`
        }
      }
      return out
    }
    case 'SLICE':
    case 'ANNOTATION':
    case 'GUIDE':
      return ''
    case 'CODE': {
      // rasterized so Figma (which ignores <foreignObject>) gets the exact look
      const png = await codeToPngDataUrl(n, w.w, w.h)
      return png ? `<image x="${f(x)}" y="${f(y)}" width="${f(w.w)}" height="${f(w.h)}" href="${png}"${name}/>` : ''
    }
    case 'SPEC': {
      const sp = n.spec ?? { title: '', body: '', status: 'TODO' }
      const body = sp.body
        .split('\n')
        .slice(0, 30)
        .map((l, i) => `<tspan x="${f(x + 16)}" y="${f(y + 64 + i * 18)}">${esc(l) || ' '}</tspan>`)
        .join('')
      return (
        `<g${name}><rect x="${f(x)}" y="${f(y)}" width="${f(w.w)}" height="${f(w.h)}" rx="12" fill="#FFF8DB" stroke="#F2C94C"/>` +
        `<text x="${f(x + 16)}" y="${f(y + 34)}" font-family="Inter" font-size="16" font-weight="700" fill="#1E1E1E">${esc(sp.title)}</text>` +
        `<text font-family="Inter" font-size="13" fill="#3C3C3C">${body}</text></g>`
      )
    }
    case 'SECTION': {
      let inner = ''
      for (const c of ed.children(id, n.pageId)) inner += await nodeSvg(ed, c, ox, oy, defs)
      const bg = n.fills.some((p) => p.type === 'SOLID') ? rect(paintAttrs({ ...n, strokes: [], opacity: 1 })) : ''
      return `<g${name}>${bg}${inner}</g>`
    }
    case 'TEXT': {
      const s = n.textStyle ?? DEFAULT_TEXT_STYLE
      const l = layoutText(n)
      const oy = verticalOffset(n, l)
      const tb = textBaseline(l)
      const spans = l.lines
        .map((ln) => {
          const cy = f(y + oy + ln.y + tb.dy)
          const marker = ln.marker ? `<tspan x="${f(x)}" y="${cy}">${esc(ln.marker)}</tspan>` : ''
          const j = justifyWords(n, ln, w.w)
          // justified lines: stretch with textLength so Figma/browsers keep the full width
          const fit = j ? ` textLength="${f(w.w - ln.indent)}" lengthAdjust="spacing"` : ''
          return `${marker}<tspan x="${f(x + lineX(n, ln, w.w))}" y="${cy}"${fit}>${esc(ln.text) || ' '}</tspan>`
        })
        .join('')
      const deco = s.decoration === 'UNDERLINE' ? ' text-decoration="underline"' : s.decoration === 'STRIKETHROUGH' ? ' text-decoration="line-through"' : ''
      return `<text font-family="${esc(s.fontFamily)}" font-size="${f(s.fontSize)}" font-weight="${s.fontWeight}"${s.italic ? ' font-style="italic"' : ''} dominant-baseline="${tb.baseline === 'alphabetic' ? 'alphabetic' : 'central'}"${
        l.letterSpacing ? ` letter-spacing="${f(l.letterSpacing)}"` : ''
      }${deco}${paintAttrs(n)}${name} xml:space="preserve">${spans}</text>`
    }
    case 'FRAME':
    case 'GROUP': {
      // masks: a mask child becomes a <clipPath> applied to every sibling above it
      let inner = ''
      let opened = 0
      for (const c of ed.children(id, n.pageId)) {
        const cn = ed.nodes.get(c)!
        if (cn.isMask) {
          if (!cn.visible) continue
          if (!clipsAsShape(cn)) {
            // a picture, a text or a group masks with its alpha: that is an SVG mask, not a clip path
            const mid = 'a' + defs.length
            defs.push('')
            const body = await nodeSvg(ed, c, ox, oy, defs)
            defs.push(`<mask id="${mid}" style="mask-type:alpha" mask-type="alpha">${body}</mask>`)
            inner += `<g mask="url(#${mid})">`
            opened++
            continue
          }
          const clip = 'm' + defs.length
          const shape = (await nodeSvg(ed, c, ox, oy, [])).replace(/ (fill|stroke|opacity|fill-opacity|stroke-width)="[^"]*"/g, '')
          defs.push(`<clipPath id="${clip}">${shape}</clipPath>`)
          inner += `<g clip-path="url(#${clip})">`
          opened++
          continue
        }
        inner += await nodeSvg(ed, c, ox, oy, defs)
      }
      inner += '</g>'.repeat(opened)
      if (n.type === 'GROUP') return `<g${name}${n.opacity < 1 ? ` opacity="${f(n.opacity)}"` : ''}>${inner}</g>`
      let clipAttr = ''
      if (n.clipsContent !== false) {
        const clip = 'c' + defs.length
        defs.push(`<clipPath id="${clip}">${rect('')}</clipPath>`)
        clipAttr = ` clip-path="url(#${clip})"`
      }
      const bg = n.fills.some((p) => p.type === 'SOLID') ? rect(paintAttrs({ ...n, strokes: [], opacity: 1 })) : ''
      const border = n.strokes.length ? rect(paintAttrs({ ...n, fills: [], opacity: 1 })) : ''
      return `<g${name}${n.opacity < 1 ? ` opacity="${f(n.opacity)}"` : ''}>${bg}${imgs}<g${clipAttr}>${inner}</g>${border}</g>`
    }
  }
}

/** Export nodes to standalone SVG. embedData=true adds Gigma's lossless node data. */
export async function nodesToSvg(ed: Editor, ids: string[], embedData = true): Promise<string> {
  const roots = ed.roots(ids).sort((a, b) => (ed.paintOrderKey(a) < ed.paintOrderKey(b) ? -1 : 1))
  const b = unionRects(roots.map((id) => ed.world(id)))
  if (!b) return ''
  const defs: string[] = []
  let body = ''
  for (const id of roots) body += await nodeSvg(ed, id, b.x, b.y, defs)
  let meta = ''
  if (embedData) {
    const json = JSON.stringify(ed.serialize(roots))
    meta = `<metadata><${META_TAG} xmlns="https://gigma.app/ns">${bytesToBase64(new TextEncoder().encode(json))}</${META_TAG}></metadata>`
  }
  return (
    `<svg width="${f(b.w)}" height="${f(b.h)}" viewBox="0 0 ${f(b.w)} ${f(b.h)}" fill="none" xmlns="http://www.w3.org/2000/svg">` +
    meta +
    (defs.length ? `<defs>${defs.join('')}</defs>` : '') +
    body +
    '</svg>'
  )
}
