import { backend, isDesktop } from '../backend'
import { editor as ed } from '../editor/editor'
import { renderToCanvas } from '../editor/render'
import { nodesToSvg, svgToNodes } from '../editor/svg'
import { framesInReadingOrder, pdfPages } from '../editor/pdf'
import { copyAsPng, insertImageBytes } from '../editor/clipboard'
import { isTyping } from '../editor/canvas'
import { unionRects } from '../editor/util'
import { fetchFigmaImages, missingFigmaImages } from '../editor/figma-images'
import { t } from './i18n'
import { handleLayerShortcut } from './layerActions'

/** Download originals of images pasted from Figma; explains what to do when no token is set. */
export async function restoreFigmaImages(): Promise<void> {
  ed.showToast(t('Loading images from Figma…'))
  const r = await fetchFigmaImages()
  if (r.error === 'NO_TOKEN') {
    ed.showToast(t('Add your Figma token in Settings to load images.'), { label: t('Open settings'), run: () => void backend.tabs.openSettings() })
    return
  }
  if (r.error === 'FORBIDDEN') {
    ed.showToast(t('Figma rejected the token or you have no access to this file.'), { label: t('Open settings'), run: () => void backend.tabs.openSettings() })
    return
  }
  if (r.error && !r.restored) {
    ed.showToast(t('Could not load images: {e}', { e: r.error }))
    return
  }
  ed.showToast(t('Images loaded: {n}', { n: String(r.restored) }) + (r.failed ? ' · ' + t('not found: {n}', { n: String(r.failed) }) : ''))
  void saveThumbnail()
}

/** After pasting from Figma: offer to load the images that Figma did not put on the clipboard. */
export async function offerFigmaImages(nodeIds: string[]): Promise<void> {
  const all = [...nodeIds, ...nodeIds.flatMap((id) => ed.descendants(id))]
  const missing = await missingFigmaImages(all)
  let n = 0
  for (const s of missing.values()) n += s.size
  if (!n) return
  ed.showToast(t('Figma did not copy {n} images.', { n: String(n) }), { label: t('Load from Figma'), run: () => void restoreFigmaImages() })
}

export async function saveThumbnail(): Promise<void> {
  const top = ed.children(null)
  if (!top.length) return
  try {
    const b = unionRects(top.map((id) => ed.world(id)))!
    const scale = Math.min(1, 480 / Math.max(b.w, b.h, 1))
    const bg = ed.page.background
    const c = await renderToCanvas(ed, top, scale, `rgb(${Math.round(bg.r * 255)},${Math.round(bg.g * 255)},${Math.round(bg.b * 255)})`)
    await backend.doc.setThumb(c.toDataURL('image/jpeg', 0.8))
  } catch {
    /* thumbnails are best effort */
  }
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

const fileName = () => (ed.selection.length === 1 ? ed.nodes.get(ed.selection[0])!.name : ed.meta.name).replace(/[\\/:*?"<>|]/g, '_')

export async function exportSelectionPng(scale = 2): Promise<void> {
  if (!ed.selection.length) return ed.showToast('Select layers to export')
  const c = await renderToCanvas(ed, ed.selection, scale)
  c.toBlob((b) => b && download(b, `${fileName()}${scale !== 1 ? `@${scale}x` : ''}.png`), 'image/png')
}

export async function exportSelectionSvg(): Promise<void> {
  if (!ed.selection.length) return ed.showToast('Select layers to export')
  const svg = await nodesToSvg(ed, ed.selection, false)
  download(new Blob([svg], { type: 'image/svg+xml' }), `${fileName()}.svg`)
}

/** PDF of the given layers, one page each (default: the selection in layer order) */
export async function exportPdf(ids?: string[], name?: string): Promise<void> {
  const list = ids ?? ed.roots(ed.selection).sort((a, b) => (ed.paintOrderKey(a) < ed.paintOrderKey(b) ? -1 : 1))
  if (!list.length) return ed.showToast(t('Select layers to export'))
  try {
    ed.showToast(t('Preparing PDF…'))
    const bytes = await backend.pdf.render(await pdfPages(ed, list))
    download(new Blob([bytes as BlobPart], { type: 'application/pdf' }), `${name ?? fileName()}.pdf`)
    ed.hideToast()
  } catch (e) {
    ed.showToast(t('PDF export failed') + ': ' + String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''))
  }
}

/** Figma's "Export frames to PDF": every top-level frame of the page, one page each */
export async function exportFramesPdf(): Promise<void> {
  const frames = framesInReadingOrder(ed)
  if (!frames.length) return ed.showToast(t('There are no frames on this page'))
  await exportPdf(frames, `${ed.meta.name} – ${ed.page.name}`.replace(/[\\/:*?"<>|]/g, '_'))
}

export function placeImage(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*,.svg'
  input.multiple = true
  input.onchange = async () => {
    for (const f of Array.from(input.files ?? [])) await importFile(f)
  }
  input.click()
}

export async function importFile(f: File, at?: { x: number; y: number }): Promise<void> {
  try {
    if (f.type === 'image/svg+xml' || f.name.toLowerCase().endsWith('.svg')) {
      const nodes = await svgToNodes(await f.text(), { name: f.name.replace(/\.svg$/i, '') })
      const view = ed.visibleWorldRect()
      ed.pasteNodes(nodes, null, at ?? { x: view.x + view.w / 2, y: view.y + view.h / 2 })
    } else if (f.type.startsWith('image/')) {
      await insertImageBytes(new Uint8Array(await f.arrayBuffer()), f.type, f.name.replace(/\.[^.]+$/, ''), at)
    }
  } catch (e) {
    ed.showToast(`Could not import ${f.name}: ${(e as Error).message}`)
  }
}

export async function exportProject(): Promise<void> {
  await ed.flush()
  if (await backend.doc.exportProject()) ed.showToast('Project exported')
}
export async function exportCurrentPage(ids = [ed.currentPageId]): Promise<void> {
  await ed.flush()
  if (await backend.doc.exportPages(ids)) ed.showToast('Page exported')
}
export async function importPages(): Promise<void> {
  await ed.flush()
  const r = await backend.doc.importPages()
  if (r) {
    ed.importPages(r.pages, r.nodes)
    ed.showToast(`Imported ${r.pages.length} page(s)`)
  }
}

/** Menu actions (desktop menu or keyboard in web mode). */
export function runAction(action: string): void {
  switch (action) {
    case 'undo':
      return ed.undo()
    case 'redo':
      return ed.redo()
    case 'duplicate':
      return void ed.duplicate(ed.selection, 10)
    case 'select-all': {
      const sel = ed.selection[0] ? ed.nodes.get(ed.selection[0]) : null
      return ed.setSelection([...ed.children(sel?.parentId ?? null)])
    }
    case 'toggle-left':
      ed.leftOpen = !ed.leftOpen
      return ed.emit('ui')
    case 'toggle-right':
      ed.rightOpen = !ed.rightOpen
      return ed.emit('ui')
    case 'zoom-fit':
      return ed.zoomToFit()
    case 'zoom-100':
      return ed.setZoom(1)
    case 'place-image':
      return placeImage()
    case 'export-project':
      return void exportProject()
    case 'export-page':
      return void exportCurrentPage()
    case 'import-pages':
      return void importPages()
    case 'export-png':
      return void exportSelectionPng()
    case 'export-svg':
      return void exportSelectionSvg()
    case 'export-pdf':
      return void exportPdf()
    case 'export-frames-pdf':
      return void exportFramesPdf()
  }
}

/** Keyboard shortcuts (Figma-compatible). */
export function handleKey(e: KeyboardEvent): void {
  if (isTyping() || ed.editingTextId) return
  if (handleLayerShortcut(e)) return
  const mod = e.ctrlKey || e.metaKey
  // shortcuts follow the physical key, so they work on any keyboard layout (Russian included)
  const PHYSICAL: Record<string, string> = { BracketLeft: '[', BracketRight: ']', Backslash: '\\', Equal: '=', Minus: '-', NumpadAdd: '+', NumpadSubtract: '-' }
  const k = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : /^Digit\d$/.test(e.code) && mod ? e.code.slice(5) : (PHYSICAL[e.code] ?? e.key.toLowerCase())
  // handled here in every build: the native menu only shows these shortcuts (its accelerators are matched
  // by the typed character and would not fire on a non-Latin layout)
  const act = (a: string) => {
    e.preventDefault()
    runAction(a)
  }
  if (mod && k === 'z' && !e.shiftKey) return act('undo')
  if (mod && ((k === 'z' && e.shiftKey) || k === 'y')) return act('redo')
  if (mod && k === 'd') return act('duplicate')
  if (mod && k === 'a') return act('select-all')
  if (mod && k === '\\') return act(e.altKey ? 'toggle-right' : 'toggle-left')
  if (mod && e.shiftKey && k === 'k') return act('place-image')
  if (e.shiftKey && e.code === 'Digit1') return act('zoom-fit')
  if (e.shiftKey && e.code === 'Digit0') return act('zoom-100')

  if (mod && k === 'g') {
    e.preventDefault()
    return e.shiftKey ? ed.ungroup() : void ed.group()
  }
  if (mod && e.shiftKey && k === 'c') {
    e.preventDefault()
    return void copyAsPng().then(() => ed.showToast('Copied as PNG'))
  }
  if (mod && k === ']') return e.preventDefault(), ed.reorder(e.altKey ? Infinity : 1)
  if (mod && k === '[') return e.preventDefault(), ed.reorder(e.altKey ? -Infinity : -1)
  if (mod && (k === '=' || k === '+')) return e.preventDefault(), ed.setZoom(ed.camera.zoom * 2)
  if (mod && k === '-') return e.preventDefault(), ed.setZoom(ed.camera.zoom / 2)
  if (mod && k === '0') return e.preventDefault(), ed.setZoom(1)
  if (mod) return

  if (k === 'delete' || k === 'backspace') return e.preventDefault(), ed.deleteSelection()
  if (k === 'escape') {
    const sel = ed.selection[0] ? ed.nodes.get(ed.selection[0]) : null
    if (ed.tool !== 'move') return ed.setTool('move')
    return ed.setSelection(sel?.parentId ? [sel.parentId] : [])
  }
  if (k === 'enter' && ed.selection.length === 1) {
    const kids = ed.children(ed.selection[0])
    if (kids.length) ed.setSelection([...kids])
    return
  }
  if (k.startsWith('arrow') && ed.selection.length) {
    e.preventDefault()
    const step = e.shiftKey ? 10 : 1
    const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0
    const dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0
    ed.act(() => ed.roots(ed.selection).forEach((id) => ed.moveBy(id, dx, dy)))
    return
  }
  // Figma shortcuts
  const tools: Record<string, typeof ed.tool> = {
    v: 'move',
    h: 'hand',
    k: 'scale',
    f: 'frame',
    a: 'frame',
    s: 'slice',
    r: 'rect',
    l: 'line',
    o: 'ellipse',
    p: 'pen',
    t: 'text',
    d: 'spec',
    b: 'code',
    c: 'annotation'
  }
  const shiftTools: Record<string, typeof ed.tool> = { s: 'section', l: 'arrow', p: 'pencil' }
  if (e.altKey) return
  if (e.shiftKey && shiftTools[k]) return ed.setTool(shiftTools[k])
  if (!e.shiftKey && tools[k]) return ed.setTool(tools[k])
}
