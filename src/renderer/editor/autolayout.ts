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
