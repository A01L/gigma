// Text layout shared by the canvas renderer, SVG export and auto-sizing.
// Supports Figma's typography options: auto/px/% line height, % letter spacing, case,
// lists, paragraph spacing, justify, vertical alignment and truncation with "…".
import type { GNode, TextStyle } from '@shared/types'

const measureCtx = (() => {
  const c = document.createElement('canvas')
  return c.getContext('2d')!
})()

export const DEFAULT_TEXT_STYLE: TextStyle = { fontFamily: 'Inter', fontSize: 16, fontWeight: 400, align: 'LEFT' }

export function cssFont(s: TextStyle): string {
  // Offline: fall back to system fonts when the family is not installed.
  return `${s.italic ? 'italic ' : ''}${s.fontWeight} ${s.fontSize}px "${s.fontFamily}", "Segoe UI", -apple-system, system-ui, sans-serif`
}

export const lineHeightOf = (s: TextStyle): number =>
  s.lineHeightPercent !== undefined ? (s.fontSize * s.lineHeightPercent) / 100 : (s.lineHeight ?? Math.round(s.fontSize * 1.21))

export const letterSpacingOf = (s: TextStyle): number =>
  s.letterSpacingPercent !== undefined ? (s.fontSize * s.letterSpacingPercent) / 100 : (s.letterSpacing ?? 0)

export function applyCase(text: string, c: TextStyle['textCase']): string {
  if (c === 'UPPER') return text.toUpperCase()
  if (c === 'LOWER') return text.toLowerCase()
  if (c === 'TITLE') return text.replace(/(^|[\s\-(«"'])(\p{L})/gu, (_, a, b) => a + b.toUpperCase())
  return text
}

export interface TextLine {
  text: string
  /** top of the line box, relative to the text block */
  y: number
  /** x offset caused by a list marker */
  indent: number
  width: number
  /** last line of its paragraph (never justified) */
  last: boolean
  /** list marker drawn before the first line of a list paragraph */
  marker?: string
}

export interface TextLayout {
  lines: TextLine[]
  width: number
  height: number
  lineHeight: number
  letterSpacing: number
  /** set when vertical trim is CAP_HEIGHT: glyphs are placed by their baseline */
  cap?: number
}

/** How to place a line's glyphs: canvas textBaseline + y offset from the line top. */
export function textBaseline(l: TextLayout): { baseline: 'middle' | 'alphabetic'; dy: number } {
  return l.cap !== undefined ? { baseline: 'alphabetic', dy: l.lineHeight / 2 + l.cap / 2 } : { baseline: 'middle', dy: l.lineHeight / 2 }
}

const cache = new Map<string, TextLayout>()

export function layoutText(n: GNode): TextLayout {
  const s = n.textStyle ?? DEFAULT_TEXT_STYLE
  const mode = n.textAutoResize ?? 'WIDTH_AND_HEIGHT'
  const auto = mode === 'WIDTH_AND_HEIGHT'
  const ls = letterSpacingOf(s)
  const key = JSON.stringify([s, auto ? -1 : n.width, mode === 'NONE' ? n.height : -1, n.characters ?? ''])
  const hit = cache.get(key)
  if (hit) return hit
  measureCtx.font = cssFont(s)
  measureCtx.letterSpacing = `${ls}px`
  const measure = (t: string) => measureCtx.measureText(t).width
  const lh = lineHeightOf(s)
  const ps = s.paragraphSpacing ?? 0
  const text = applyCase(n.characters ?? '', s.textCase)
  const lines: TextLine[] = []
  let y = 0
  let maxW = 0
  let num = 0
  const paras = text.split('\n')
  paras.forEach((para, pi) => {
    let marker: string | undefined
    let indent = 0
    if (s.listStyle && s.listStyle !== 'NONE' && para.trim()) {
      num++
      marker = s.listStyle === 'BULLET' ? '•' : `${num}.`
      indent = Math.max(measure(marker + '  '), s.fontSize * 1.2)
    } else if (!para.trim()) num = 0
    const avail = auto ? Infinity : Math.max(1, n.width - indent)
    const wrap = (limit: number): string[] => {
      const out: string[] = []
      const words = para.split(/(\s+)/)
      let line = ''
      for (const w of words) {
        const test = line + w
        if (line && measure(test.trimEnd()) > limit) {
          out.push(line.trimEnd())
          line = w.trimStart()
          // hard-break words longer than the box
          while (line && measure(line) > limit && line.length > 1) {
            let k = line.length - 1
            while (k > 1 && measure(line.slice(0, k)) > limit) k--
            out.push(line.slice(0, k))
            line = line.slice(k)
          }
        } else line = test
      }
      out.push(line)
      return out
    }
    let paraLines: string[]
    if (auto) paraLines = [para]
    else {
      paraLines = wrap(avail)
      // Balanced wrap: narrowest width that still gives the same number of lines -> even line lengths
      if (s.wrapStyle === 'BALANCED' && paraLines.length > 1) {
        const count = paraLines.length
        let lo = 1
        let hi = avail
        for (let it = 0; it < 18 && hi - lo > 0.5; it++) {
          const mid = (lo + hi) / 2
          if (wrap(mid).length > count) lo = mid
          else hi = mid
        }
        paraLines = wrap(hi)
      }
    }
    paraLines.forEach((t, li) => {
      const w = measure(t)
      maxW = Math.max(maxW, w + indent)
      lines.push({ text: t, y, indent, width: w, last: li === paraLines.length - 1, marker: li === 0 ? marker : undefined })
      y += lh
    })
    if (pi < paras.length - 1) y += ps
  })
  let height = Math.max(lh, y)
  // Vertical trim "cap height to baseline": cut the half-leading above the first cap and below the last baseline.
  // Lines are then drawn on the alphabetic baseline at lineTop + lh/2 + cap/2 (see textBaseline()).
  let cap: number | undefined
  if (s.verticalTrim === 'CAP_HEIGHT' && lines.length) {
    cap = measureCtx.measureText('H').actualBoundingBoxAscent || s.fontSize * 0.7
    const trim = Math.max(0, (lh - cap) / 2)
    for (const l of lines) l.y -= trim
    height = Math.max(cap, height - trim * 2)
  }
  const layout: TextLayout = { lines, width: Math.ceil(auto ? maxW : n.width), height, lineHeight: lh, letterSpacing: ls, cap }

  // truncation: fixed-size boxes cut overflow and end with an ellipsis
  if (mode === 'NONE' && s.truncate && height > n.height + 0.5) {
    const fit = layout.lines.filter((l) => l.y + lh <= n.height + 0.5)
    if (fit.length) {
      const lastL = { ...fit[fit.length - 1], last: true }
      let t = lastL.text
      const avail = n.width - lastL.indent
      while (t && measure(t + '…') > avail) t = t.slice(0, -1)
      lastL.text = t.trimEnd() + '…'
      lastL.width = measure(lastL.text)
      fit[fit.length - 1] = lastL
    }
    layout.lines = fit
  }
  if (cache.size > 5000) cache.clear()
  cache.set(key, layout)
  return layout
}

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ' +
  'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. ' +
  'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. ' +
  'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.'
/** the placeholder of a new text */
export const LOREM_SHORT = 'Lorem ipsum'

/** Lorem ipsum that fills a text box of the node's size and style without spilling out of it (never less than two words). */
export function loremFor(n: GNode): string {
  const words = LOREM.split(' ')
  const take = (count: number) => Array.from({ length: count }, (_, i) => words[i % words.length]).join(' ')
  const fits = (count: number) => layoutText({ ...n, characters: take(count), textAutoResize: 'HEIGHT' }).height <= n.height + 0.5
  let lo = 2
  let hi = 1600
  if (!fits(lo)) return take(lo)
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(mid)) lo = mid
    else hi = mid - 1
  }
  return take(lo)
}

/** Returns the size a text node should have after its content/style changed. */
export function fitText(n: GNode): { width: number; height: number } {
  const mode = n.textAutoResize ?? 'WIDTH_AND_HEIGHT'
  if (mode === 'NONE') return { width: n.width, height: n.height }
  const l = layoutText(n)
  return { width: Math.max(1, l.width), height: l.height }
}

/** Vertical offset of the text block inside a fixed-height box. */
export function verticalOffset(n: GNode, l: TextLayout): number {
  if ((n.textAutoResize ?? 'WIDTH_AND_HEIGHT') !== 'NONE') return 0
  const free = n.height - l.height
  const v = n.textStyle?.verticalAlign ?? 'TOP'
  return v === 'CENTER' ? free / 2 : v === 'BOTTOM' ? free : 0
}

/** x of a line's start for the given alignment (relative to the box). */
export function lineX(n: GNode, l: TextLine, boxW: number): number {
  const a = n.textStyle?.align ?? 'LEFT'
  const free = boxW - l.indent - l.width
  if (a === 'CENTER') return l.indent + free / 2
  if (a === 'RIGHT') return l.indent + free
  return l.indent
}

/** Words + gap for justified lines (null = draw normally). */
export function justifyWords(n: GNode, l: TextLine, boxW: number): { words: string[]; gap: number } | null {
  if ((n.textStyle?.align ?? 'LEFT') !== 'JUSTIFIED' || l.last) return null
  const words = l.text.split(/\s+/).filter(Boolean)
  if (words.length < 2) return null
  measureCtx.font = cssFont(n.textStyle ?? DEFAULT_TEXT_STYLE)
  measureCtx.letterSpacing = `${letterSpacingOf(n.textStyle ?? DEFAULT_TEXT_STYLE)}px`
  const total = words.reduce((a, w) => a + measureCtx.measureText(w).width, 0)
  return { words, gap: (boxW - l.indent - total) / (words.length - 1) }
}

export function measureWord(n: GNode, w: string): number {
  measureCtx.font = cssFont(n.textStyle ?? DEFAULT_TEXT_STYLE)
  measureCtx.letterSpacing = `${letterSpacingOf(n.textStyle ?? DEFAULT_TEXT_STYLE)}px`
  return measureCtx.measureText(w).width
}
