// Clipboard interop.
//  Gigma -> Figma : we put SVG markup on the clipboard as text. Figma turns pasted SVG
//                   into editable layers (frames/groups/vectors/text).
//  Gigma -> Gigma : the same SVG carries <metadata> with exact Gigma nodes (lossless).
//  Figma -> Gigma : SVG text ("Copy as SVG" in Figma) is imported as layers; images pasted
//                   as files become image layers. Native Figma clipboard (fig-kiwi binary in
//                   text/html) is detected; its decoder lives in figma-clipboard.ts.
import { backend } from '../backend'
import { editor as ed } from './editor'
import { extractGigmaData, nodesToSvg, registerEmbeddedImages, svgToNodes } from './svg'
import { decodeFigmaClipboard } from './figma-clipboard'
import { replaceImageFill } from './figma-images'
import { imageSize, renderToCanvas } from './render'
import { rectsIntersect, unionRects } from './util'
import type { GNode } from '@shared/types'

export async function copySelection(cut = false): Promise<void> {
  if (!ed.selection.length) return
  const svg = await nodesToSvg(ed, ed.selection, true)
  await navigator.clipboard.writeText(svg)
  if (cut) ed.deleteSelection()
}

export async function copyAsPng(): Promise<void> {
  const c = await renderToCanvas(ed, ed.selection, 2)
  const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

function pasteTarget(): string | null {
  if (ed.selection.length === 1) {
    const n = ed.nodes.get(ed.selection[0])!
    if (n.type === 'FRAME') return n.id
    return n.parentId
  }
  return null
}

/**
 * Puts pasted layers on the page, always where the user is looking.
 * `foreign`: the layers come from another program (Figma, an SVG), so their coordinates mean nothing here
 * (in Figma they are counted from the parent of the copied layer): they go to the middle of the view,
 * or into the selected frame at the same place inside it when they fit there.
 */
function placeNodes(nodes: GNode[], foreign = false): string[] {
  const roots = nodes.filter((n) => !n.parentId || !nodes.some((m) => m.id === n.parentId))
  const b = unionRects(roots.map((n) => ({ x: n.x, y: n.y, w: n.width, h: n.height })))!
  const view = ed.visibleWorldRect()
  const middle = { x: view.x + view.w / 2, y: view.y + view.h / 2 }
  let target = pasteTarget()
  // a selected frame that was scrolled out of sight is not where the paste is wanted
  if (target && !rectsIntersect(ed.world(target), view)) target = null
  let at: { x: number; y: number } | undefined
  if (target) {
    const tw = ed.world(target)
    if (foreign) {
      const fits = b.x >= 0 && b.y >= 0 && b.x + b.w <= tw.w && b.y + b.h <= tw.h
      at = fits ? { x: tw.x + b.x + b.w / 2, y: tw.y + b.y + b.h / 2 } : { x: tw.x + tw.w / 2, y: tw.y + tw.h / 2 }
      // the frame is in view but that spot of it is not: the middle of what is seen of the frame
      if (!rectsIntersect({ x: at.x - b.w / 2, y: at.y - b.h / 2, w: b.w, h: b.h }, view)) {
        const x1 = Math.max(tw.x, view.x), x2 = Math.min(tw.x + tw.w, view.x + view.w)
        const y1 = Math.max(tw.y, view.y), y2 = Math.min(tw.y + tw.h, view.y + view.h)
        at = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }
      }
    } else if (!rectsIntersect(b, tw) || !rectsIntersect(b, view)) at = middle.x >= tw.x && middle.y >= tw.y && middle.x <= tw.x + tw.w && middle.y <= tw.y + tw.h ? middle : { x: tw.x + tw.w / 2, y: tw.y + tw.h / 2 }
  } else if (foreign || !rectsIntersect(b, view)) at = middle
  return ed.pasteNodes(nodes, target, at)
}

export async function insertImageBytes(bytes: Uint8Array, mime: string, name = 'Image', at?: { x: number; y: number }): Promise<string> {
  const hash = await backend.blob.put(bytes, mime)
  const size = (await imageSize(hash)) ?? { w: 200, h: 200 }
  const view = ed.visibleWorldRect()
  // fit large images into the viewport like Figma does
  const maxW = view.w * 0.8
  const s = size.w > maxW ? maxW / size.w : 1
  const w = size.w * s
  const h = size.h * s
  const c = at ?? { x: view.x + view.w / 2, y: view.y + view.h / 2 }
  const target = at ? ed.frameAt(at.x, at.y) : pasteTarget()
  const pw = target ? ed.world(target) : { x: 0, y: 0 }
  const n = ed.act(() =>
    ed.addNode({
      type: 'RECTANGLE',
      name,
      parentId: target,
      x: c.x - w / 2 - pw.x,
      y: c.y - h / 2 - pw.y,
      width: w,
      height: h,
      fills: [{ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL' }]
    })
  )
  ed.setSelection([n.id])
  return n.id
}

export async function handlePaste(e: ClipboardEvent): Promise<void> {
  const dt = e.clipboardData
  if (!dt) return
  const html = dt.getData('text/html')
  const text = dt.getData('text/plain')
  const files = Array.from(dt.files).filter((f) => f.type.startsWith('image/'))
  e.preventDefault()
  try {
    if (html && html.includes('(figma)')) {
      const nodes = await decodeFigmaClipboard(html)
      if (nodes?.length) {
        const ids = placeNodes(nodes, true)
        // Figma's clipboard has no image bytes: let the UI offer to fetch them
        window.dispatchEvent(new CustomEvent('gigma-figma-pasted', { detail: ids }))
        return
      }
      ed.showToast('Figma layers detected. Native Figma paste is not decoded yet: in Figma use Copy as → Copy as SVG')
      return
    }
    if (text) {
      const own = extractGigmaData(text)
      if (own) {
        await registerEmbeddedImages(text)
        placeNodes(own)
        return
      }
      if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) {
        placeNodes(await svgToNodes(text), true)
        return
      }
    }
    if (files.length) {
      // one image pasted while a layer with an image fill is selected -> replace that image
      const sel = ed.selection.length === 1 ? ed.nodes.get(ed.selection[0]) : undefined
      if (files.length === 1 && sel?.fills.some((f) => f.type === 'IMAGE')) {
        const hash = await backend.blob.put(new Uint8Array(await files[0].arrayBuffer()), files[0].type)
        replaceImageFill(sel.id, hash)
        return
      }
      for (const f of files) await insertImageBytes(new Uint8Array(await f.arrayBuffer()), f.type, f.name || 'Image')
      return
    }
    if (text.trim()) {
      const view = ed.visibleWorldRect()
      const target = pasteTarget()
      const pw = target ? ed.world(target) : { x: 0, y: 0 }
      const n = ed.act(() =>
        ed.addNode({
          type: 'TEXT',
          characters: text,
          parentId: target,
          x: view.x + view.w / 2 - pw.x,
          y: view.y + view.h / 2 - pw.y,
          fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }]
        })
      )
      ed.setSelection([n.id])
    }
  } catch (err) {
    ed.showToast('Paste failed: ' + (err as Error).message)
  }
}
