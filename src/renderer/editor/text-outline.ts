// Text -> outlines (Figma's "Outline stroke" / "Flatten" on a text layer): every glyph becomes part of one vector path.
// The glyph shapes come from the font files installed on this computer (Local Font Access), read with opentype.js.
// The lines, their places and the spacing are the ones the canvas draws the text with, so the outline lands on the text.
import opentype from 'opentype.js'
import type { GNode, TextStyle } from '@shared/types'
import { cssFont, DEFAULT_TEXT_STYLE, justifyWords, layoutText, lineX, measureWord, textBaseline, verticalOffset } from './text'
import { parsePath, segsBounds, segsToD, transformSegs, type Seg } from './svgpath'

interface FontData {
  family: string
  fullName: string
  postscriptName: string
  style: string
  blob(): Promise<Blob>
}
interface Glyph {
  index: number
  advanceWidth?: number
  getPath(x: number, y: number, size: number): { toPathData(decimals?: number): string }
}
interface Font {
  unitsPerEm: number
  charToGlyph(ch: string): Glyph
  getKerningValue(a: Glyph, b: Glyph): number
}

// The browser lists the installed fonts only for a page that is on screen. The list is therefore asked for as soon as
// the page is visible and kept, so a text can still be outlined later while the window is covered (an AI working over MCP).
let listed: FontData[] | null = null
let asking: Promise<FontData[]> | null = null
function localFonts(): Promise<FontData[]> {
  if (listed) return Promise.resolve(listed)
  const q = (window as unknown as { queryLocalFonts?: () => Promise<FontData[]> }).queryLocalFonts
  if (!q) return Promise.resolve([])
  asking ??= q()
    .then((list) => (listed = list))
    .catch(() => [])
    .finally(() => (asking = null))
  return asking
}
void localFonts()
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void localFonts())

const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/extra\s*light|ultra\s*light/i, 200],
  [/semi\s*light/i, 350],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi\s*bold|demi\s*bold|demi/i, 600],
  [/extra\s*bold|ultra\s*bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700]
]
const weightOf = (style: string): number => WEIGHTS.find(([re]) => re.test(style))?.[1] ?? 400
const italicOf = (style: string): boolean => /italic|oblique/i.test(style)

/**
 * A font file may be a collection (.ttc): several fonts that share their tables. opentype.js reads a single font,
 * so the table directory of the wanted one is copied to the start of the file (the offsets in it are absolute).
 */
function singleFont(buf: ArrayBuffer, postscriptName: string): ArrayBuffer {
  const dv = new DataView(buf)
  if (buf.byteLength < 16 || dv.getUint32(0) !== 0x74746366 /* 'ttcf' */) return buf
  const count = dv.getUint32(8)
  const pick = (offset: number): ArrayBuffer => {
    const tables = dv.getUint16(offset + 4)
    const out = buf.slice(0)
    new Uint8Array(out).set(new Uint8Array(buf, offset, 12 + tables * 16), 0)
    return out
  }
  let first: ArrayBuffer | null = null
  for (let i = 0; i < count; i++) {
    const one = pick(dv.getUint32(12 + i * 4))
    first ??= one
    try {
      const f = opentype.parse(one) as unknown as { names: { postScriptName?: Record<string, string> } }
      if (Object.values(f.names.postScriptName ?? {}).includes(postscriptName)) return one
    } catch {
      /* try the next one */
    }
  }
  return first ?? buf
}

const parsed = new Map<string, Promise<Font | null>>()
function load(fd: FontData): Promise<Font | null> {
  let p = parsed.get(fd.postscriptName)
  if (!p) {
    p = fd
      .blob()
      .then((b) => b.arrayBuffer())
      .then((buf) => opentype.parse(singleFont(buf, fd.postscriptName)) as unknown as Font)
      .catch(() => null)
    parsed.set(fd.postscriptName, p)
  }
  return p
}

/** the installed face of a family that is closest to the wanted weight and slant */
async function face(family: string, s: TextStyle): Promise<Font | null> {
  const all = (await localFonts()).filter((f) => f.family.toLowerCase() === family.toLowerCase())
  if (!all.length) return null
  const score = (f: FontData) => Math.abs(weightOf(f.style) - s.fontWeight) + (italicOf(f.style) === !!s.italic ? 0 : 1000)
  for (const f of [...all].sort((a, b) => score(a) - score(b))) {
    const font = await load(f)
    if (font) return font
  }
  return null
}

/** what the canvas falls back to when the family is not installed or lacks a glyph (see cssFont) */
const FALLBACKS = ['Segoe UI', 'Arial', 'Helvetica Neue', 'Helvetica', 'DejaVu Sans', 'Segoe UI Symbol', 'Segoe UI Emoji']

export interface TextOutline {
  /** path in the coordinates of the result (0,0 .. w,h) */
  d: string
  /** where the result sits inside the box of the text */
  x: number
  y: number
  w: number
  h: number
  /** true when a glyph had to come from another font than the one of the text */
  substituted: boolean
}

let probe: CanvasRenderingContext2D | null = null

/** The outline of a text layer, or null when no font with its glyphs can be read on this computer. */
export async function outlineText(n: GNode): Promise<TextOutline | null> {
  if (n.type !== 'TEXT') return null
  const s = n.textStyle ?? DEFAULT_TEXT_STYLE
  const fonts: Font[] = []
  const own = await face(s.fontFamily, s)
  if (own) fonts.push(own)
  for (const fam of FALLBACKS) {
    if (fam.toLowerCase() === s.fontFamily.toLowerCase()) continue
    const f = await face(fam, s)
    if (f) fonts.push(f)
  }
  if (!fonts.length) return null
  let substituted = !own

  const l = layoutText(n)
  const oy = verticalOffset(n, l)
  const tb = textBaseline(l)
  const size = s.fontSize
  // the canvas places a line by the middle of the em box; glyph outlines are placed by the baseline.
  // The distance between the two is read from the canvas itself, so both agree for any font.
  probe ??= document.createElement('canvas').getContext('2d')!
  probe.font = cssFont(s)
  probe.textBaseline = 'alphabetic'
  const up = probe.measureText('H').actualBoundingBoxAscent
  probe.textBaseline = 'middle'
  const baseShift = tb.baseline === 'middle' ? up - probe.measureText('H').actualBoundingBoxAscent : 0

  const segs: Seg[] = []
  probe.letterSpacing = `${l.letterSpacing}px`
  /**
   * Draw a run of text from x0 on the baseline y; returns where it ends. Every glyph stands where the canvas puts it:
   * the width of the text before it, as the canvas measures it (kerning and letter spacing included). The font's own
   * advances are used only for very long runs, where measuring every prefix would take too long.
   */
  const run = (text: string, x0: number, y: number): number => {
    let prev: { font: Font; glyph: Glyph } | null = null
    const exact = text.length <= 600
    let x = x0
    let done = ''
    for (const ch of text) {
      if (exact) x = x0 + (done ? probe!.measureText(done).width : 0)
      done += ch
      let font = fonts[0]
      let glyph = font.charToGlyph(ch)
      if (glyph.index === 0 && ch.trim()) {
        for (const f of fonts.slice(1)) {
          const g = f.charToGlyph(ch)
          if (g.index !== 0) {
            font = f
            glyph = g
            substituted = true
            break
          }
        }
      }
      const k = size / font.unitsPerEm
      if (!exact && prev && prev.font === font) x += font.getKerningValue(prev.glyph, glyph) * k
      if (ch.trim()) {
        const d = glyph.getPath(x, y, size).toPathData(3)
        if (d) segs.push(...parsePath(d))
      }
      x += (glyph.advanceWidth ?? 0) * k + l.letterSpacing
      prev = { font, glyph }
    }
    return exact ? x0 + probe!.measureText(text).width : x
  }
  const rect = (x: number, y: number, w: number, h: number) => {
    if (w > 0 && h > 0) segs.push({ c: 'M', p: [x, y] }, { c: 'L', p: [x, y + h] }, { c: 'L', p: [x + w, y + h] }, { c: 'L', p: [x + w, y] }, { c: 'Z', p: [] })
  }
  const midShift = tb.baseline === 'alphabetic' ? -(l.cap ?? 0) / 2 : 0
  for (const ln of l.lines) {
    const mid = oy + ln.y + tb.dy
    const base = mid + baseShift
    if (ln.marker) run(ln.marker, 0, base)
    const x0 = lineX(n, ln, n.width)
    const j = justifyWords(n, ln, n.width)
    let from = x0
    let to: number
    if (j) {
      let x = ln.indent
      from = x
      for (const w of j.words) {
        run(w, x, base)
        x += measureWord(n, w) + j.gap
      }
      to = n.width
    } else to = Math.max(run(ln.text, x0, base) - l.letterSpacing, x0 + ln.width)
    if (s.decoration && s.decoration !== 'NONE' && ln.text) {
      const th = Math.max(1, size / 14)
      rect(from, (s.decoration === 'UNDERLINE' ? mid + size * 0.36 : mid + size * 0.02) + midShift, to - from, th)
    }
  }
  if (!segs.length) return null
  const b = segsBounds(segs)
  if (!(b.w > 0) || !(b.h > 0)) return null
  return { d: segsToD(transformSegs(segs, [1, 0, 0, 1, -b.x, -b.y])), x: b.x, y: b.y, w: b.w, h: b.h, substituted }
}
