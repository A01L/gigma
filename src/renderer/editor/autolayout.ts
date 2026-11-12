// Auto layout, same model as Figma: a frame stacks its children in a row or a column
// with a gap and padding, can hug its contents, and children can fill the frame.
import type { GNode } from '@shared/types'

export const isAutoLayout = (n: GNode | undefined): n is GNode => !!n && n.type === 'FRAME' && (n.layoutMode === 'HORIZONTAL' || n.layoutMode === 'VERTICAL')

/** children that take part in the flow */
export const inFlow = (n: GNode) => n.visible && n.layoutPositioning !== 'ABSOLUTE' && !n.isMask

export interface LayoutResult {
  frame: { width: number; height: number }
  children: Map<string, { x: number; y: number; width: number; height: number }>
}

/** kids must be in layout order (first item first) */
export function computeLayout(f: GNode, kids: GNode[]): LayoutResult {
  const horiz = f.layoutMode === 'HORIZONTAL'
  const flow = kids.filter(inFlow)
  const pl = f.paddingLeft ?? 0
  const pr = f.paddingRight ?? 0
  const pt = f.paddingTop ?? 0
  const pb = f.paddingBottom ?? 0
  const pStart = horiz ? pl : pt
  const pEnd = horiz ? pr : pb
  const cStart = horiz ? pt : pl
  const cEnd = horiz ? pb : pr
  const hugP = f.primaryAxisSizingMode === 'AUTO'
  const hugC = f.counterAxisSizingMode === 'AUTO'
  const between = f.primaryAxisAlignItems === 'SPACE_BETWEEN' && !hugP
  let gap = f.itemSpacing ?? 0

  const pOf = (k: GNode) => (horiz ? k.width : k.height)
  const cOf = (k: GNode) => (horiz ? k.height : k.width)
  // a child can only fill an axis the frame does not hug
  const grows = (k: GNode) => !hugP && (k.layoutGrow ?? 0) > 0
  const stretches = (k: GNode) => k.layoutAlign === 'STRETCH'

  // ---- wrapping layout: lines of items, like text ----
  if (f.layoutWrap === 'WRAP' && !hugP) {
    const frameP = horiz ? f.width : f.height
    const inner = frameP - pStart - pEnd
    const lineGap = f.counterAxisSpacing ?? 0
    const lines: GNode[][] = []
    let used = 0
    for (const k of flow) {
      const size = grows(k) ? 1 : pOf(k)
      const line = lines[lines.length - 1]
      if (!line || used + gap + size > inner + 0.01) {
        lines.push([k])
        used = size
      } else {
        line.push(k)
        used += gap + size
      }
    }
    const children = new Map<string, { x: number; y: number; width: number; height: number }>()
    const cAlign = f.counterAxisAlignItems ?? 'MIN'
    const align = f.primaryAxisAlignItems ?? 'MIN'
    let cCursor = cStart
    for (const line of lines) {
      const growers = line.filter(grows)
      const fixed = line.reduce((s, k) => s + (grows(k) ? 0 : pOf(k)), 0)
      const gapsN = line.length - 1
      const share = growers.length ? Math.max(1, (inner - fixed - gapsN * gap) / growers.length) : 0
      const sizes = line.map((k) => (grows(k) ? share : pOf(k)))
      const total = sizes.reduce((s, v) => s + v, 0)
      const g = align === 'SPACE_BETWEEN' && !growers.length && gapsN > 0 ? (inner - total) / gapsN : gap
      const free = inner - total - gapsN * g
      let cursor = pStart + (growers.length || align === 'SPACE_BETWEEN' ? 0 : align === 'CENTER' ? free / 2 : align === 'MAX' ? free : 0)
      const natural = line.filter((k) => !stretches(k))
      const lineC = (natural.length ? natural : line).reduce((m, k) => Math.max(m, cOf(k)), 0)
      line.forEach((k, i) => {
        const c = stretches(k) ? Math.max(1, lineC) : cOf(k)
        const cPos = cCursor + (cAlign === 'CENTER' ? (lineC - c) / 2 : cAlign === 'MAX' ? lineC - c : 0)
        children.set(k.id, horiz ? { x: cursor, y: cPos, width: sizes[i], height: c } : { x: cPos, y: cursor, width: c, height: sizes[i] })
        cursor += sizes[i] + g
      })
      cCursor += lineC + lineGap
    }
    const contentC = cCursor - (lines.length ? lineGap : 0) + cEnd
    const frameC = hugC ? contentC : horiz ? f.height : f.width
    return { frame: horiz ? { width: Math.max(frameP, 1), height: Math.max(frameC, 1) } : { width: Math.max(frameC, 1), height: Math.max(frameP, 1) }, children }
  }

  // ---- primary axis ----
  let frameP = horiz ? f.width : f.height
  const sizeP = new Map<string, number>()
  const fixedSum = flow.reduce((s, k) => s + (grows(k) ? 0 : pOf(k)), 0)
  const gaps = Math.max(0, flow.length - 1)
  if (hugP) frameP = pStart + pEnd + fixedSum + gaps * gap
  const inner = frameP - pStart - pEnd
  const growers = flow.filter(grows)
  const share = growers.length ? Math.max(1, (inner - fixedSum - gaps * (between ? 0 : gap)) / growers.length) : 0
  for (const k of flow) sizeP.set(k.id, grows(k) ? share : pOf(k))
  const used = flow.reduce((s, k) => s + sizeP.get(k.id)!, 0)
  if (between) gap = flow.length > 1 ? (inner - used) / (flow.length - 1) : 0
  const free = inner - used - gaps * gap
  const align = f.primaryAxisAlignItems ?? 'MIN'
  let cursor = pStart + (between || growers.length ? 0 : align === 'CENTER' ? free / 2 : align === 'MAX' ? free : 0)

  // ---- counter axis ----
  let frameC = horiz ? f.height : f.width
  if (hugC) {
    const natural = flow.filter((k) => !stretches(k))
    const src = natural.length ? natural : flow
    frameC = cStart + cEnd + src.reduce((m, k) => Math.max(m, cOf(k)), 0)
  }
  const innerC = frameC - cStart - cEnd
  const cAlign = f.counterAxisAlignItems ?? 'MIN'

  const children = new Map<string, { x: number; y: number; width: number; height: number }>()
  for (const k of flow) {
    const p = sizeP.get(k.id)!
    const c = stretches(k) ? Math.max(1, innerC) : cOf(k)
    const cPos = cStart + (cAlign === 'CENTER' ? (innerC - c) / 2 : cAlign === 'MAX' ? innerC - c : 0)
    children.set(k.id, horiz ? { x: cursor, y: cPos, width: p, height: c } : { x: cPos, y: cursor, width: c, height: p })
    cursor += p + gap
  }
  return { frame: horiz ? { width: Math.max(frameP, 1), height: Math.max(frameC, 1) } : { width: Math.max(frameC, 1), height: Math.max(frameP, 1) }, children }
}
