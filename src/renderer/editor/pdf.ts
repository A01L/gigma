// PDF export, the editor side: which layers become pages, in which order, and their SVG.
import type { Editor } from './editor'
import { nodesToSvg } from './svg'

export interface PdfPageData {
  svg: string
  width: number
  height: number
}

/** top-level frames of the current page in reading order: rows from the top, each row from the left (as Figma orders them) */
export function framesInReadingOrder(ed: Editor): string[] {
  const frames = ed.children(null).filter((id) => {
    const n = ed.nodes.get(id)!
    return n.type === 'FRAME' && n.visible
  })
  const rects = new Map(frames.map((id) => [id, ed.world(id)]))
  // frames whose vertical spans overlap belong to one row
  const byY = [...frames].sort((a, b) => rects.get(a)!.y - rects.get(b)!.y)
  const rows: string[][] = []
  let bottom = -Infinity
  for (const id of byY) {
    const r = rects.get(id)!
    if (!rows.length || r.y >= bottom) {
      rows.push([id])
      bottom = r.y + r.h
    } else {
      rows[rows.length - 1].push(id)
      bottom = Math.max(bottom, r.y + r.h)
    }
  }
  return rows.flatMap((row) => row.sort((a, b) => rects.get(a)!.x - rects.get(b)!.x))
}

/** One page per layer. */
export async function pdfPages(ed: Editor, ids: string[]): Promise<PdfPageData[]> {
  const pages: PdfPageData[] = []
  for (const id of ids) {
    if (!ed.nodes.has(id)) continue
    const w = ed.world(id)
    pages.push({ svg: await nodesToSvg(ed, [id], false), width: w.w, height: w.h })
  }
  return pages
}
