// The guideline library as the editor sees it. Guidelines live in the app library (see main/guides.ts)
// and are shared by every project: this module keeps them in memory, saves edits, and keeps the open
// document in step with them (dots of deleted guidelines go away, colours and fonts of the guidelines
// used here become styles of the document and follow every change).
import type { GNode, GuideData, RGBA } from '@shared/types'
import { hexToRgba } from '@shared/types'
import { backend } from '../backend'
import { editor as ed } from './editor'
import { DEFAULT_TEXT_STYLE } from './text'
import { GUIDE_CARD_W, GUIDE_DOT, guideCardHeight, guideStore, setGuideRepaint } from './guide-render'

export const guides = guideStore
const deleted = new Set<string>()
const subs = new Set<() => void>()
/** guidelines being edited here whose save has not come back yet: the library copy must not overwrite them */
const saving = new Map<string, number>()
let version = 0

export const guidesVersion = () => version
export function subscribeGuides(fn: () => void): () => void {
  subs.add(fn)
  return () => void subs.delete(fn)
}
function changed(): void {
  version++
  subs.forEach((f) => f())
  ed.emit('doc')
}

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12)

/** a new guideline with the usual parts already in place */
export function newGuide(name = 'Guideline'): GuideData {
  return {
    id: crypto.randomUUID(),
    name,
    description: '',
    accent: '#0c8ce9',
    colors: [
      { id: uid(), name: 'Primary', role: 'Buttons, links', hex: '#0c8ce9' },
      { id: uid(), name: 'Text', role: 'Main text', hex: '#1e1e1e' },
      { id: uid(), name: 'Background', role: 'Page', hex: '#ffffff' }
    ],
    fonts: [
      { id: uid(), role: 'Heading', family: 'Inter', weight: 700, size: 32 },
      { id: uid(), role: 'Body', family: 'Inter', weight: 400, size: 16 }
    ],
    logos: [],
    patterns: [],
    rules: '',
    sections: [],
    updatedAt: Date.now(),
    formatVersion: 1
  }
}
export const newGuideId = uid

/** Save an edit: visible at once here, written to the library a moment later, then shown in every open project. */
export function saveGuide(g: GuideData): void {
  guides.set(g.id, g)
  deleted.delete(g.id)
  clearTimeout(saving.get(g.id))
  saving.set(
    g.id,
    window.setTimeout(() => {
      saving.delete(g.id)
      void backend.guides.save(guides.get(g.id) ?? g)
    }, 350)
  )
  reconcile()
  changed()
}

export async function removeGuide(id: string): Promise<void> {
  clearTimeout(saving.get(id))
  saving.delete(id)
  guides.delete(id)
  deleted.add(id)
  await backend.guides.remove(id)
  reconcile()
  changed()
}

export async function loadGuides(): Promise<void> {
  const r = await backend.guides.list()
  const mine = [...saving.keys()].map((id) => guides.get(id)).filter((g): g is GuideData => !!g)
  guides.clear()
  for (const g of r.guides) guides.set(g.id, g)
  for (const g of mine) guides.set(g.id, g)
  deleted.clear()
  for (const id of r.deleted) deleted.add(id)
  reconcile()
  changed()
}

const sameColor = (a: RGBA, b: RGBA) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) + Math.abs(a.a - b.a) < 0.002

/** Bring the open document in step with the library. Safe to call often. */
export function reconcile(): void {
  if (!ed.meta) return
  const nodes = [...ed.nodes.values()].filter((n): n is GNode & { guide: NonNullable<GNode['guide']> } => n.type === 'GUIDE' && !!n.guide)
  // 1. a guideline deleted from the library disappears from every project
  const gone = nodes.filter((n) => deleted.has(n.guide.id))
  if (gone.length) ed.act(() => gone.forEach((n) => ed.deleteNode(n.id)))
  const live = nodes.filter((n) => !deleted.has(n.guide.id))
  // 2. a project from another computer brings its guidelines along
  const copies = ed.meta.guides ?? {}
  for (const n of live) {
    const copy = copies[n.guide.id]
    if (!guides.has(n.guide.id) && copy) {
      guides.set(copy.id, copy)
      void backend.guides.save(copy)
    }
  }
  const used = new Map<string, GuideData>()
  for (const n of live) {
    const g = guides.get(n.guide.id)
    if (g) used.set(g.id, g)
  }
  // 3. the copy kept inside the document
  const next: Record<string, GuideData> = {}
  let dirty = Object.keys(copies).length !== used.size
  for (const g of used.values()) {
    next[g.id] = g
    if (copies[g.id]?.updatedAt !== g.updatedAt || copies[g.id] !== g) dirty = dirty || JSON.stringify(copies[g.id]) !== JSON.stringify(g)
  }
  if (dirty) ed.setGuideCopies(next)
  // 4. the dot is named after its guideline; an open card is as tall as its contents
  for (const n of live) {
    const g = guides.get(n.guide.id)
    if (!g) continue
    // like a document: the width is fixed, the height is whatever the contents need
    const w = n.guide.open ? GUIDE_CARD_W : GUIDE_DOT
    const h = n.guide.open ? guideCardHeight(g, w) : GUIDE_DOT
    if (n.name !== g.name || Math.abs(n.height - h) > 0.5 || Math.abs(n.width - w) > 0.5) ed.patchQuietly(n.id, { name: g.name, width: w, height: h })
  }
  // 5. colours and fonts of the guidelines used here are styles of the document
  const prefix = (gid: string) => `guide:${gid}:`
  const wantColors = new Map<string, { name: string; color: RGBA }>()
  const wantFonts = new Map<string, { name: string; style: NonNullable<GNode['textStyle']> }>()
  for (const g of used.values()) {
    for (const c of g.colors) if (/^#[0-9a-f]{3,8}$/i.test(c.hex)) wantColors.set(prefix(g.id) + c.id, { name: `${g.name} / ${c.name || 'Color'}`, color: hexToRgba(c.hex) })
    for (const f of g.fonts)
      wantFonts.set(prefix(g.id) + f.id, {
        name: `${g.name} / ${f.role || 'Text'}`,
        style: { ...DEFAULT_TEXT_STYLE, fontFamily: f.family, fontWeight: f.weight, fontSize: f.size, ...(f.lineHeightPercent ? { lineHeightPercent: f.lineHeightPercent } : {}) }
      })
  }
  const colors = ed.meta.colorStyles ?? []
  for (const s of colors) if (s.id.startsWith('guide:') && !wantColors.has(s.id)) ed.deleteStyle('color', s.id)
  const missingC = [...wantColors].filter(([id]) => !colors.some((s) => s.id === id))
  if (missingC.length) ed.setColorStyles([...(ed.meta.colorStyles ?? []), ...missingC.map(([id, v]) => ({ id, ...v }))])
  for (const s of ed.meta.colorStyles ?? []) {
    const w = wantColors.get(s.id)
    if (w && (s.name !== w.name || !sameColor(s.color, w.color))) ed.updateColorStyle(s.id, { name: w.name, ...(sameColor(s.color, w.color) ? {} : { color: w.color }) })
  }
  const texts = ed.meta.textStyles ?? []
  for (const s of texts) if (s.id.startsWith('guide:') && !wantFonts.has(s.id)) ed.deleteStyle('text', s.id)
  const missingT = [...wantFonts].filter(([id]) => !texts.some((s) => s.id === id))
  if (missingT.length) ed.setTextStyles([...(ed.meta.textStyles ?? []), ...missingT.map(([id, v]) => ({ id, ...v }))])
  for (const s of ed.meta.textStyles ?? []) {
    const w = wantFonts.get(s.id)
    if (!w) continue
    const same = s.style.fontFamily === w.style.fontFamily && s.style.fontWeight === w.style.fontWeight && s.style.fontSize === w.style.fontSize && s.style.lineHeightPercent === w.style.lineHeightPercent
    if (s.name !== w.name || !same) ed.updateTextStyle(s.id, { name: w.name, ...(same ? {} : { style: { ...s.style, ...w.style } }) })
  }
}

/** Put a guideline on the canvas: a closed dot, or an open card for one that was just created. */
export function placeGuide(id: string, at: { x: number; y: number }, open = false): GNode {
  const g = guides.get(id)
  const w = open ? GUIDE_CARD_W : GUIDE_DOT
  const h = open && g ? guideCardHeight(g, w) : GUIDE_DOT
  const n = ed.act(() =>
    ed.addNode({ type: 'GUIDE', name: g?.name ?? 'Guideline', parentId: null, x: Math.round(at.x - (open ? 0 : w / 2)), y: Math.round(at.y - (open ? 0 : h / 2)), width: w, height: h, fills: [], guide: { id, open: open || undefined } })
  )
  reconcile()
  return n
}

/** Open the card for editing, or fold it back into a dot (it stays where its top left corner / centre was). */
export function setGuideOpen(nodeId: string, open: boolean): void {
  const n = ed.nodes.get(nodeId)
  if (!n?.guide || !!n.guide.open === open) return
  const g = guides.get(n.guide.id)
  const w = open ? GUIDE_CARD_W : GUIDE_DOT
  const h = open && g ? guideCardHeight(g, w) : GUIDE_DOT
  ed.act(() => ed.updateNode(n.id, { guide: { ...n.guide!, open: open || undefined }, width: w, height: h }))
}

export function initGuides(): void {
  setGuideRepaint(() => ed.emit('doc'))
  backend.guides.onChanged(() => void loadGuides())
  void loadGuides()
}
