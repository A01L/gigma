// How a guideline looks on the canvas: a glowing dot when closed, a card with its colours, fonts,
// logos and rules when open. One routine both measures and draws the card, so the two never disagree.
import type { GNode, GuideData, GuideImage } from '@shared/types'
import type { Rect } from './util'

/** every guideline of the library, by id (filled and kept current by guides.ts) */
export const guideStore = new Map<string, GuideData>()

export const GUIDE_DOT = 72
export const GUIDE_CARD_W = 440
const GREY = '#8c8c8c'

/** accent of a guideline as a CSS colour (grey when none is set) */
export function guideAccent(g: GuideData | undefined): string {
  return g?.accent && /^#[0-9a-f]{3,8}$/i.test(g.accent) ? g.accent : GREY
}

// ---------------- pictures (data: URLs decoded once) ----------------
const pics = new Map<string, HTMLImageElement>()
let repaint: () => void = () => {}
export function setGuideRepaint(fn: () => void): void {
  repaint = fn
}
function pic(src: string): HTMLImageElement | null {
  let im = pics.get(src)
  if (!im) {
    im = new Image()
    im.onload = () => repaint()
    im.src = src
    pics.set(src, im)
    if (pics.size > 400) pics.delete(pics.keys().next().value!)
  }
  return im.complete && im.naturalWidth > 0 ? im : null
}

let measureCtx: CanvasRenderingContext2D | null = null
const FONT = 'Inter, "Segoe UI", sans-serif'

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/)) {
      const next = line ? line + ' ' + word : word
      if (line && ctx.measureText(next).width > width) {
        out.push(line)
        line = word
      } else line = next
    }
    out.push(line)
  }
  return out
}

/**
 * Lay the card out at (x, y) with the given width; draws when `paint` is true.
 * Returns the height the card needs.
 */
function card(ctx: CanvasRenderingContext2D, g: GuideData, x: number, y: number, w: number, paint: boolean): number {
  const pad = 22
  const inner = w - pad * 2
  let cy = y + pad
  const text = (s: string, font: string, color: string, lh: number, maxLines = 400) => {
    ctx.font = font
    const lines = wrap(ctx, s, inner).slice(0, maxLines)
    if (paint) {
      ctx.fillStyle = color
      lines.forEach((ln, i) => ctx.fillText(ln, x + pad, cy + i * lh + lh / 2))
    }
    cy += lines.length * lh
  }
  const heading = (s: string) => {
    cy += 18
    if (paint) {
      ctx.strokeStyle = '#3d3d3d'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x + pad, cy - 9.5)
      ctx.lineTo(x + w - pad, cy - 9.5)
      ctx.stroke()
    }
    ctx.letterSpacing = '0.8px'
    text(s.toUpperCase(), `600 10px ${FONT}`, '#9a9a9a', 16)
    ctx.letterSpacing = '0px'
    cy += 8
  }
  const gallery = (list: GuideImage[], h: number) => {
    let px = x + pad
    let rowH = 0
    for (const im of list) {
      const el = pic(im.dataUrl)
      const iw = el ? Math.min(inner, Math.max(24, (el.naturalWidth / el.naturalHeight) * h)) : h
      if (px + iw > x + pad + inner + 0.5 && px > x + pad) {
        px = x + pad
        cy += rowH + 10
        rowH = 0
      }
      if (paint) {
        ctx.fillStyle = '#ffffff'
        ctx.beginPath()
        ctx.roundRect(px, cy, iw, h, 8)
        ctx.fill()
        if (el) {
          ctx.save()
          ctx.beginPath()
          ctx.roundRect(px, cy, iw, h, 8)
          ctx.clip()
          // fit inside with a little air
          const k = Math.min((iw - 8) / el.naturalWidth, (h - 8) / el.naturalHeight)
          ctx.drawImage(el, px + (iw - el.naturalWidth * k) / 2, cy + (h - el.naturalHeight * k) / 2, el.naturalWidth * k, el.naturalHeight * k)
          ctx.restore()
        }
        if (im.name) {
          ctx.font = `400 10px ${FONT}`
          ctx.fillStyle = '#9a9a9a'
          let nm = im.name
          while (nm.length > 1 && ctx.measureText(nm).width > iw) nm = nm.slice(0, -2) + '…'
          ctx.fillText(nm, px, cy + h + 10)
        }
      }
      rowH = Math.max(rowH, h + (im.name ? 18 : 0))
      px += iw + 10
    }
    cy += rowH
  }

  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  // header: accent dot, name
  const accent = guideAccent(g)
  if (paint) {
    ctx.save()
    ctx.shadowColor = accent
    ctx.shadowBlur = 12
    ctx.fillStyle = accent
    ctx.beginPath()
    ctx.arc(x + pad + 7, cy + 13, 7, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    ctx.font = `600 9.5px ${FONT}`
    ctx.fillStyle = '#9a9a9a'
    ctx.letterSpacing = '0.8px'
    ctx.textAlign = 'right'
    ctx.fillText('GUIDELINE', x + w - pad, cy + 13)
    ctx.textAlign = 'left'
    ctx.letterSpacing = '0px'
  }
  ctx.font = `700 20px ${FONT}`
  if (paint) {
    ctx.fillStyle = '#ffffff'
    let nm = g.name || 'Guideline'
    while (nm.length > 1 && ctx.measureText(nm).width > inner - 110) nm = nm.slice(0, -2) + '…'
    ctx.fillText(nm, x + pad + 24, cy + 13)
  }
  cy += 30
  if (g.description) {
    cy += 4
    text(g.description, `400 12.5px ${FONT}`, '#c4c4c4', 19)
  }

  if (g.colors.length) {
    heading('Colors')
    const tile = 72
    const gap = (inner - tile * 5) / 4
    g.colors.forEach((c, i) => {
      const col = i % 5
      if (i && col === 0) cy += 92
      if (!paint) return
      const tx = x + pad + col * (tile + gap)
      ctx.fillStyle = /^#[0-9a-f]{3,8}$/i.test(c.hex) ? c.hex : '#000'
      ctx.beginPath()
      ctx.roundRect(tx, cy, tile, 46, 8)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.14)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.roundRect(tx + 0.5, cy + 0.5, tile - 1, 45, 8)
      ctx.stroke()
      const fit = (s: string) => {
        while (s.length > 1 && ctx.measureText(s).width > tile) s = s.slice(0, -2) + '…'
        return s
      }
      ctx.font = `600 11px ${FONT}`
      ctx.fillStyle = '#ffffff'
      ctx.fillText(fit(c.name || 'Color'), tx, cy + 58)
      ctx.font = `400 10px ${FONT}`
      ctx.fillStyle = '#9a9a9a'
      ctx.fillText(fit(c.hex.toUpperCase()), tx, cy + 71)
      if (c.role) ctx.fillText(fit(c.role), tx, cy + 83)
    })
    cy += 92
  }

  if (g.fonts.length) {
    heading('Typography')
    for (const f of g.fonts) {
      const size = Math.max(14, Math.min(30, f.size))
      const rowH = Math.max(40, size + 14)
      if (paint) {
        ctx.font = `${f.weight} ${size}px "${f.family}", ${FONT}`
        ctx.fillStyle = '#ffffff'
        ctx.fillText('Aa', x + pad, cy + rowH / 2)
        ctx.font = `600 12px ${FONT}`
        ctx.fillText(f.role || 'Text', x + pad + 62, cy + rowH / 2 - 8)
        ctx.font = `400 11px ${FONT}`
        ctx.fillStyle = '#9a9a9a'
        ctx.fillText(`${f.family} · ${f.weight} · ${f.size}px`, x + pad + 62, cy + rowH / 2 + 8)
      }
      cy += rowH
    }
  }
  if (g.logos.length) {
    heading('Logo')
    gallery(g.logos, 64)
  }
  if (g.patterns.length) {
    heading('Patterns and images')
    gallery(g.patterns, 80)
  }
  if (g.rules.trim()) {
    heading('Rules')
    text(g.rules, `400 12.5px ${FONT}`, '#dcdcdc', 19)
  }
  for (const s of g.sections) {
    heading(s.title || 'Section')
    if (s.text.trim()) text(s.text, `400 12.5px ${FONT}`, '#dcdcdc', 19)
    if (s.images.length) {
      if (s.text.trim()) cy += 10
      gallery(s.images, 80)
    }
  }
  return cy + pad - y
}

/** height an open guideline card needs at this width */
export function guideCardHeight(g: GuideData, w = GUIDE_CARD_W): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')!
  return Math.ceil(card(measureCtx, g, 0, 0, w, false))
}

export function drawGuide(ctx: CanvasRenderingContext2D, n: GNode, r: Rect, g: GuideData | undefined, k: number): void {
  const accent = guideAccent(g)
  if (n.guide?.open && g) {
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.4)'
    ctx.shadowBlur = 20 * k
    ctx.shadowOffsetY = 6 * k
    ctx.fillStyle = '#242424'
    ctx.beginPath()
    ctx.roundRect(r.x, r.y, r.w, r.h, 14)
    ctx.fill()
    ctx.restore()
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(r.x, r.y, r.w, r.h, 14)
    ctx.clip()
    // a thin line of the accent along the top
    ctx.fillStyle = accent
    ctx.fillRect(r.x, r.y, r.w, 3)
    card(ctx, g, r.x, r.y, r.w, true)
    ctx.restore()
    ctx.strokeStyle = '#3d3d3d'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 14)
    ctx.stroke()
    return
  }
  // closed: a dot that glows with the accent
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const rad = Math.min(r.w, r.h) / 2
  // neon: the light stays close to the edge, a thin halo instead of a cloud
  ctx.save()
  ctx.shadowColor = accent
  ctx.shadowBlur = 7 * k
  ctx.fillStyle = accent
  ctx.beginPath()
  ctx.arc(cx, cy, rad * 0.78, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
  // a soft highlight makes it a sphere, not a flat disc
  const shine = ctx.createRadialGradient(cx - rad * 0.25, cy - rad * 0.3, 0, cx, cy, rad * 0.78)
  shine.addColorStop(0, 'rgba(255,255,255,0.45)')
  shine.addColorStop(0.6, 'rgba(255,255,255,0)')
  ctx.fillStyle = shine
  ctx.beginPath()
  ctx.arc(cx, cy, rad * 0.78, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(cx, cy, rad * 0.78 - 0.75, 0, Math.PI * 2)
  ctx.stroke()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // the name under the dot
  ctx.font = `600 12px ${FONT}`
  ctx.fillStyle = g ? '#e6e6e6' : '#9a9a9a'
  let nm = g?.name ?? n.name
  while (nm.length > 1 && ctx.measureText(nm).width > r.w + 80) nm = nm.slice(0, -2) + '…'
  ctx.fillText(nm, cx, r.y + r.h + 12)
  ctx.textAlign = 'left'
}
