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

const clean = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Untitled'
const fileName = () => clean(ed.selection.length === 1 ? ed.nodes.get(ed.selection[0])!.name : ed.meta.name)

/** hand exported files to the app: it asks where to save (a file name for one, a folder for a batch) and tells the result */
async function saveFiles(files: { name: string; bytes: Uint8Array }[]): Promise<void> {
  const r = await backend.files.save(files)
  if (!r) return ed.hideToast()
  if (!r.paths.length) return ed.hideToast()
  const msg = r.paths.length === 1 ? t('Saved: {name}', { name: files[0].name }) : t('Files saved: {n}', { n: String(r.paths.length) })
  ed.showToast(msg, { label: t('Show in folder'), run: () => void backend.files.reveal(r.paths[0]) })
}

/**
 * The selected layers as export files. As in Figma, every selected layer becomes a file of its own, named after the
 * layer (layers with the same name get a number), in the order they read on the page.
 */
async function exportEach(ext: string, suffix: string, make: (id: string) => Promise<Uint8Array>): Promise<void> {
  const ids = ed.roots(ed.selection)
  if (!ids.length) return ed.showToast(t('Select layers to export'))
  // rows first, then left to right: the order the files should have in a folder
  const row = (id: string) => ed.world(id)
  ids.sort((a, b) => {
    const p = row(a)
    const q = row(b)
    return Math.abs(p.y - q.y) > Math.min(p.h, q.h) / 2 ? p.y - q.y : p.x - q.x
  })
  const used = new Map<string, number>()
  const files: { name: string; bytes: Uint8Array }[] = []
  for (const [i, id] of ids.entries()) {
    if (ids.length > 1) ed.showToast(t('Exporting {i} of {n}…', { i: String(i + 1), n: String(ids.length) }))
    const base = clean(ed.nodes.get(id)!.name)
    const seen = used.get(base.toLowerCase()) ?? 0
    used.set(base.toLowerCase(), seen + 1)
    files.push({ name: `${base}${seen ? ' ' + (seen + 1) : ''}${suffix}.${ext}`, bytes: await make(id) })
    // let the progress be painted between two heavy renders
    if (ids.length > 1) await new Promise((r) => setTimeout(r, 0))
  }
  await saveFiles(files)
}

export async function exportSelectionPng(scale = 2): Promise<void> {
  await exportEach('png', scale !== 1 ? `@${scale}x` : '', async (id) => {
    const c = await renderToCanvas(ed, [id], scale)
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'))
    if (!blob) throw new Error('could not encode the image')
    return new Uint8Array(await blob.arrayBuffer())
  }).catch((e) => ed.showToast(t('Export failed') + ': ' + String((e as Error).message ?? e)))
}

export async function exportSelectionSvg(): Promise<void> {
  await exportEach('svg', '', async (id) => new TextEncoder().encode(await nodesToSvg(ed, [id], false))).catch((e) => ed.showToast(t('Export failed') + ': ' + String((e as Error).message ?? e)))
}

/** PDF of the given layers, one page each (default: the selection in layer order) */
export async function exportPdf(ids?: string[], name?: string): Promise<void> {
  const list = ids ?? ed.roots(ed.selection).sort((a, b) => (ed.paintOrderKey(a) < ed.paintOrderKey(b) ? -1 : 1))
  if (!list.length) return ed.showToast(t('Select layers to export'))
  try {
    ed.showToast(t('Preparing PDF…'))
    const bytes = await backend.pdf.render(await pdfPages(ed, list))
    await saveFiles([{ name: `${name ?? fileName()}.pdf`, bytes }])
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

/** pick PDF files: every page of each becomes a frame */
export function importPdfFiles(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.pdf,application/pdf'
  input.multiple = true
  input.onchange = async () => {
    for (const f of Array.from(input.files ?? [])) await importFile(f)
  }
  input.click()
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
    } else if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
      // a PDF: every page becomes a frame with its text, shapes and pictures as layers (the reader is loaded only when needed)
      ed.showToast(t('Reading {name}…', { name: f.name }))
      const { importPdf } = await import('../editor/pdf-import')
      const n = await importPdf(new Uint8Array(await f.arrayBuffer()), f.name.replace(/\.pdf$/i, ''), at)
      ed.showToast(n ? t('{name}: pages imported as frames ({n})', { name: f.name, n: String(n) }) : t('{name} has no pages', { name: f.name }))
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
    case 'import-pdf':
      return importPdfFiles()
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
