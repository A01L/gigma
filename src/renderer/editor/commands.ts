// Executes command-bus requests (from MCP now, plugins later) as normal undoable edits.
import type { CommandName, CommandRequest, CommandResponse } from '@shared/commands'
import type { Effect, GNode, GradientPaint, GradientType, Paint, TextStyle } from '@shared/types'
import { hexToRgba, rgbaToHex } from '@shared/types'
import { backend } from '../backend'
import { editor as ed, parseVariant } from './editor'
import { DEFAULT_TEXT_STYLE } from './text'
import { exportPng, imageSize } from './render'
import { nodesToSvg, svgToNodes } from './svg'
import { framesInReadingOrder, pdfPages } from './pdf'
import { codeBitmapAsync } from './code-render'
import { aiCursor } from './ai-cursor'
import { noteSpecClient } from './spec-board'
import { guides, newGuide, newGuideId, placeGuide, saveGuide } from './guides'
import type { GuideData } from '@shared/types'

type Args = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

type SpecRef = { id: string; kind: 'TASK' | 'RULES'; title: string; status?: string; body: string }
/**
 * Spec cards wired to a layer or to one of the frames / sections it sits in. `open` leaves out finished tasks
 * (rules never finish). This is how the AI learns, while working inside a frame, what the user wants there.
 */
function specsFor(n: GNode, open = false, own = false): SpecRef[] {
  const chain = new Set<string>(own ? [n.id] : [n.id, ...ed.ancestors(n.id).map((a) => a.id)])
  const out: SpecRef[] = []
  for (const s of ed.nodes.values()) {
    if (s.type !== 'SPEC' || !s.spec?.targets?.some((t) => chain.has(t))) continue
    const rules = s.spec.kind === 'RULES'
    if (open && !rules && s.spec.status === 'DONE') continue
    out.push({ id: s.id, kind: rules ? 'RULES' : 'TASK', title: s.spec.title, ...(!rules && { status: s.spec.status }), body: s.spec.body })
  }
  return out
}
const brief = (s: SpecRef) => ({ id: s.id, kind: s.kind, title: s.title, ...(s.status && { status: s.status }) })
/** specs this frame is wired into as a material */
const materialFor = (n: GNode) => [...ed.nodes.values()].filter((s) => s.type === 'SPEC' && s.spec?.sources?.includes(n.id)).map((s) => ({ id: s.id, title: s.spec!.title }))
/** the frames a Spec card is wired to (deleted ones are skipped): `targets` = where to work, `sources` = materials */
const framesOf = (s: GNode, role: 'targets' | 'sources' = 'targets') =>
  (s.spec?.[role] ?? []).flatMap((id): Record<string, unknown>[] => {
    const f = ed.nodes.get(id)
    // a guideline wired in as a material is read with get_guideline, not looked at as a frame
    if (f?.type === 'GUIDE') return [{ id: f.id, type: f.type, name: f.name, pageId: f.pageId, guidelineId: f.guide?.id }]
    return f ? [{ id: f.id, type: f.type, name: f.name, pageId: f.pageId, width: Math.round(f.width), height: Math.round(f.height) }] : []
  })
/** guidelines (design systems) wired to a layer or to a frame / section it sits in */
function guidelinesFor(n: GNode, own = false): { id: string; name: string }[] {
  const chain = new Set<string>(own ? [n.id] : [n.id, ...ed.ancestors(n.id).map((a) => a.id)])
  const out = new Map<string, { id: string; name: string }>()
  for (const d of ed.nodes.values()) {
    if (d.type !== 'GUIDE' || !d.guide?.targets?.some((t) => chain.has(t))) continue
    const g = guides.get(d.guide.id)
    if (g) out.set(g.id, { id: g.id, name: g.name })
  }
  return [...out.values()]
}
/** a guideline as the AI reads it: every value, pictures by name only (they are large) */
const guidelineView = (g: GuideData) => ({
  id: g.id,
  name: g.name,
  description: g.description || undefined,
  accent: g.accent,
  colors: g.colors.map((c) => ({ name: c.name, role: c.role || undefined, hex: c.hex, styleId: `guide:${g.id}:${c.id}` })),
  fonts: g.fonts.map((f) => ({ role: f.role, family: f.family, weight: f.weight, size: f.size, lineHeightPercent: f.lineHeightPercent, styleId: `guide:${g.id}:${f.id}` })),
  // pictures by name: get_guideline_image returns one (with its transparency), place_guideline_image puts it on the canvas
  logos: g.logos.map((i) => ({ name: i.name, ...(i.bg && { shownOn: i.bg }) })),
  patterns: g.patterns.map((i) => ({ name: i.name, ...(i.bg && { shownOn: i.bg }) })),
  rules: g.rules,
  sections: g.sections.map((s) => ({ title: s.title, text: s.text, images: s.images.map((i) => i.name) }))
})
/** a picture of a guideline by its name (or its number in the list, from 1) */
function guidelineImage(g: GuideData, kind: string | undefined, name: string | undefined) {
  const list = kind === 'pattern' ? g.patterns : kind === 'logo' ? g.logos : [...g.logos, ...g.patterns, ...g.sections.flatMap((s) => s.images)]
  const im = name ? (list.find((i) => i.name === name) ?? list.find((i) => i.name.toLowerCase() === name.toLowerCase()) ?? list[parseInt(name) - 1]) : list[0]
  if (!im) throw new Error('No such picture in this guideline: ' + (list.map((i) => i.name).join(', ') || 'it has no pictures'))
  return im
}
/** the picture as PNG bytes with its transparency kept (whatever format it was added in) */
async function imageAsPng(dataUrl: string): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob())
  const c = document.createElement('canvas')
  c.width = bmp.width
  c.height = bmp.height
  c.getContext('2d')!.drawImage(bmp, 0, 0)
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('could not encode the picture'))), 'image/png'))
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: bmp.width, height: bmp.height }
}
function requireGuideline(id: string): GuideData {
  const g = guides.get(id)
  if (!g) throw new Error('Unknown guideline id; use list_guidelines')
  return g
}
const withIds = <T extends object>(list: T[] | undefined, old: (T & { id: string })[]): (T & { id: string })[] | undefined =>
  // keep the ids of entries that stay in place, so styles linked to them survive the edit
  list?.map((x, i) => ({ ...x, id: old[i]?.id ?? newGuideId() }))
function setGuideTargets(nodeId: string, frameIds: string[]): void {
  const n = requireNode(nodeId)
  if (n.type !== 'GUIDE' || !n.guide) throw new Error('nodeId is not a guideline on the canvas')
  for (const id of frameIds) {
    const t = requireNode(id).type
    if (t !== 'FRAME' && t !== 'SECTION') throw new Error(`"${id}" is not a frame or a section`)
  }
  ed.act(() => ed.updateNode(n.id, { guide: { ...n.guide!, targets: frameIds.length ? [...new Set(frameIds)] : undefined } }))
}
/** what a spec says about itself to the AI */
const specView = (s: GNode) => ({
  ...s.spec,
  kind: s.spec?.kind ?? 'TASK',
  ...(s.spec?.kind === 'RULES' && { status: undefined, result: undefined }),
  targets: undefined,
  sources: undefined,
  // where the work happens
  linkedFrames: framesOf(s),
  // materials wired into the spec: read them (get_node, export_png) and build from them, do not change them
  sourceFrames: framesOf(s, 'sources')
})
function setLinks(specId: string, frameIds: string[], role: 'targets' | 'sources' = 'targets'): void {
  const s = requireNode(specId)
  for (const id of frameIds) {
    const t = requireNode(id).type
    // a guideline dot can be wired into a spec as a material
    if (t === 'GUIDE' && role === 'sources') continue
    if (t !== 'FRAME' && t !== 'SECTION') throw new Error(`"${id}" is not a frame or a section: a spec can only be linked to those`)
  }
  const other = role === 'targets' ? 'sources' : 'targets'
  const spec = s.spec ?? { title: '', body: '', status: 'TODO' as const }
  // a frame is either a material or a place to work, not both
  const rest = (spec[other] ?? []).filter((id) => !frameIds.includes(id))
  ed.act(() => ed.updateNode(s.id, { spec: { ...spec, [role]: frameIds.length ? [...new Set(frameIds)] : undefined, [other]: rest.length ? rest : undefined } }))
}

function summarize(n: GNode, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: n.id,
    type: n.type,
    name: n.name,
    x: Math.round(n.x),
    y: Math.round(n.y),
    width: Math.round(n.width),
    height: Math.round(n.height)
  }
  if (n.type === 'TEXT') out.text = (n.characters ?? '').slice(0, 200)
  const solid = n.fills.find((f) => f.type === 'SOLID')
  if (solid && solid.type === 'SOLID') out.fill = '#' + [solid.color.r, solid.color.g, solid.color.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
  if (!n.visible) out.visible = false
  if (n.type === 'FRAME' || n.type === 'SECTION') {
    const specs = specsFor(n, false, true)
    if (specs.length) out.specs = specs.map(brief)
    const mat = materialFor(n)
    if (mat.length) out.materialForSpecs = mat
    const gl = guidelinesFor(n, true)
    if (gl.length) out.guidelines = gl
  }
  if (n.type === 'GUIDE') {
    const g = guides.get(n.guide?.id ?? '')
    out.guideline = g ? { id: g.id, name: g.name } : null
    const frames = (n.guide?.targets ?? []).flatMap((id) => (ed.nodes.has(id) ? [{ id, name: ed.nodes.get(id)!.name }] : []))
    if (frames.length) out.linkedFrames = frames
  }
  if (n.type === 'SPEC') {
    out.spec = { kind: n.spec?.kind ?? 'TASK', title: n.spec?.title, ...(n.spec?.kind !== 'RULES' && { status: n.spec?.status }) }
    const frames = framesOf(n)
    if (frames.length) out.linkedFrames = frames.map((f) => ({ id: f.id, name: f.name }))
    const src = framesOf(n, 'sources')
    if (src.length) out.sourceFrames = src.map((f) => ({ id: f.id, name: f.name, type: f.type }))
  }
  const kids = ed.children(n.id, n.pageId)
  if (kids.length) {
    if (depth > 1) out.children = kids.map((c) => summarize(ed.nodes.get(c)!, depth - 1))
    else out.childCount = kids.length
  }
  return out
}

function requireNode(id: string): GNode {
  const n = ed.nodes.get(id)
  if (!n) throw new Error(`Node ${id} not found`)
  return n
}

function checkParent(parentId?: string | null): string | null {
  if (!parentId) return null
  const p = requireNode(parentId)
  if (p.type !== 'FRAME' && p.type !== 'GROUP' && p.type !== 'SECTION') throw new Error(`Parent ${parentId} is a ${p.type}; only FRAME, GROUP or SECTION can have children`)
  if (p.pageId !== ed.currentPageId) ed.setCurrentPage(p.pageId)
  return parentId
}

function solid(hex?: string): Paint[] {
  return hex ? [{ type: 'SOLID', color: hexToRgba(hex) }] : []
}

/** auto layout props of create_frame / update_node */
function layoutPatch(a: Args): Partial<GNode> {
  const out: Partial<GNode> = {}
  if (a.layoutMode !== undefined) out.layoutMode = a.layoutMode === 'NONE' ? undefined : a.layoutMode
  for (const k of ['itemSpacing', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'primaryAxisSizingMode', 'counterAxisSizingMode', 'counterAxisSpacing'] as const)
    if (a[k] !== undefined) (out as Args)[k] = a[k]
  if (a.layoutWrap !== undefined) out.layoutWrap = a.layoutWrap === 'WRAP' ? 'WRAP' : undefined
  if (a.padding !== undefined) {
    const [t, r, b, l] = Array.isArray(a.padding) ? a.padding : [a.padding, a.padding, a.padding, a.padding]
    Object.assign(out, { paddingTop: t, paddingRight: r, paddingBottom: b, paddingLeft: l })
  }
  return out
}

function strokes(a: Args) {
  return a.stroke ? [{ color: hexToRgba(a.stroke), weight: a.strokeWeight ?? 1, align: 'INSIDE' as const }] : []
}

/** Figma-style typography args from MCP -> TextStyle fields (only provided ones). */
function typography(a: Args): Partial<TextStyle> {
  const out: Partial<TextStyle> = {}
  for (const k of ['italic', 'verticalAlign', 'decoration', 'textCase', 'lineHeightPercent', 'letterSpacingPercent', 'paragraphSpacing', 'listStyle', 'truncate', 'verticalTrim', 'wrapStyle'] as const)
    if (a[k] !== undefined) (out as Args)[k] = a[k]
  if (a.lineHeightPercent !== undefined) out.lineHeight = undefined
  if (a.letterSpacingPercent !== undefined) out.letterSpacing = undefined
  return out
}

/** Same behaviour as the inspector alignment buttons (+ distribute). */
export function alignNodes(ids: string[], how: string): void {
  if (!ids.length) return
  let box
  if (ids.length === 1) {
    const n = ed.nodes.get(ids[0])!
    if (!n.parentId) return
    box = ed.world(n.parentId)
  } else box = ed.selectionBounds(ids)!
  ed.act(() => {
    if (how === 'distribute-horizontal' || how === 'distribute-vertical') {
      const hz = how === 'distribute-horizontal'
      const items = ids.map((id) => ({ id, r: ed.world(id) })).sort((p, q) => (hz ? p.r.x - q.r.x : p.r.y - q.r.y))
      const total = items.reduce((s, it) => s + (hz ? it.r.w : it.r.h), 0)
      const gap = ((hz ? box.w : box.h) - total) / Math.max(1, items.length - 1)
      let pos = hz ? box.x : box.y
      for (const it of items) {
        ed.moveBy(it.id, hz ? pos - it.r.x : 0, hz ? 0 : pos - it.r.y)
        pos += (hz ? it.r.w : it.r.h) + gap
      }
      return
    }
    for (const id of ids) {
      const w = ed.world(id)
      let dx = 0,
        dy = 0
      if (how === 'left') dx = box.x - w.x
      if (how === 'center') dx = box.x + box.w / 2 - (w.x + w.w / 2)
      if (how === 'right') dx = box.x + box.w - (w.x + w.w)
      if (how === 'top') dy = box.y - w.y
      if (how === 'middle') dy = box.y + box.h / 2 - (w.y + w.h / 2)
      if (how === 'bottom') dy = box.y + box.h - (w.y + w.h)
      ed.moveBy(id, Math.round(dx * 100) / 100, Math.round(dy * 100) / 100)
    }
  })
}

function created(n: GNode) {
  const out: Record<string, unknown> = { id: n.id, type: n.type, name: n.name, x: n.x, y: n.y, width: n.width, height: n.height, parentId: n.parentId }
  // working inside a frame that has rules or an unfinished task: say so, they describe what is wanted here
  if (n.type !== 'SPEC') {
    const specs = specsFor(n, true)
    if (specs.length) {
      out.specs = specs.map(brief)
      const rules = specs.some((s) => s.kind === 'RULES')
      const tasks = specs.some((s) => s.kind === 'TASK')
      out.note =
        'The user wired specs to this frame. Read them with list_specs. ' +
        (rules ? 'RULES are standing rules: every change in this frame must follow them. ' : '') +
        (tasks ? 'A TASK says what to do here; when it is done call update_spec with status DONE.' : '')
    }
    // a guideline wired to this frame: the design system to follow here
    const gl = guidelinesFor(n)
    if (gl.length) {
      out.guidelines = gl
      out.note = (out.note ? out.note + ' ' : '') + 'A guideline (design system) is wired to this frame: read it with get_guideline and use its colours, fonts and rules.'
    }
  }
  return out
}

const mainOnly = () => {
  throw new Error('handled by the desktop app')
}

const handlers: Record<CommandName, (a: Args) => unknown | Promise<unknown>> = {
  list_projects: mainOnly,
  create_project: mainOnly,
  open_project: mainOnly,
  list_tabs: mainOnly,
  switch_tab: mainOnly,
  get_document: (a) => {
    const pageId = a.pageId ?? ed.currentPageId
    return {
      name: ed.meta.name,
      currentPageId: ed.currentPageId,
      pages: ed.sortedPages().map((p) => ({ id: p.id, name: p.name })),
      nodes: ed.children(null, pageId).map((id) => summarize(ed.nodes.get(id)!, a.depth ?? 4))
    }
  },
  list_pages: () => ed.sortedPages().map((p) => ({ id: p.id, name: p.name, current: p.id === ed.currentPageId })),
  create_page: (a) => {
    const p = ed.addPage(a.name)
    return { id: p.id, name: p.name }
  },
  set_current_page: (a) => {
    if (!ed.pages.has(a.pageId)) throw new Error('page not found')
    ed.setCurrentPage(a.pageId)
    return { ok: true }
  },
  get_selection: () => ed.selection.map((id) => summarize(ed.nodes.get(id)!, 2)),
  set_selection: (a) => {
    ed.setSelection(a.ids)
    return { selected: ed.selection }
  },
  get_node: (a) => {
    const n = requireNode(a.id)
    if (n.type === 'SPEC') return { ...n, spec: undefined, ...specView(n) }
    if (n.type === 'GUIDE') {
      const g = guides.get(n.guide?.id ?? '')
      return { ...n, guideline: g ? guidelineView(g) : null, linkedFrames: (n.guide?.targets ?? []).flatMap((id) => (ed.nodes.has(id) ? [{ id, name: ed.nodes.get(id)!.name }] : [])) }
    }
    const specs = specsFor(n)
    const mat = materialFor(n)
    const gl = guidelinesFor(n)
    return specs.length || mat.length || gl.length ? { ...n, ...(specs.length && { specs }), ...(mat.length && { materialForSpecs: mat }), ...(gl.length && { guidelines: gl }) } : n
  },
  list_guidelines: () =>
    [...guides.values()].map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description || undefined,
      accent: g.accent,
      colors: g.colors.length,
      fonts: g.fonts.length,
      // where it sits in this document and which frames it is wired to
      onCanvas: [...ed.nodes.values()]
        .filter((n) => n.type === 'GUIDE' && n.guide?.id === g.id)
        .map((n) => ({ nodeId: n.id, pageId: n.pageId, linkedFrames: (n.guide?.targets ?? []).flatMap((id) => (ed.nodes.has(id) ? [{ id, name: ed.nodes.get(id)!.name }] : [])) }))
    })),
  get_guideline: (a) => guidelineView(requireGuideline(a.id)),
  create_guideline: (a) => {
    const g: GuideData = {
      ...newGuide(a.name || 'Guideline'),
      description: a.description ?? '',
      accent: a.accent ?? a.colors?.[0]?.hex ?? '#0c8ce9',
      ...(a.colors && { colors: withIds(a.colors, []) }),
      ...(a.fonts && { fonts: withIds(a.fonts, []) }),
      rules: a.rules ?? '',
      sections: withIds((a.sections ?? []).map((s: Args) => ({ title: s.title ?? '', text: s.text ?? '', images: [] })), []) ?? []
    }
    saveGuide(g)
    const n = placeGuide(g.id, { x: a.x ?? 0, y: a.y ?? 0 }, false)
    if (Array.isArray(a.frameIds) && a.frameIds.length) setGuideTargets(n.id, a.frameIds)
    return { id: g.id, nodeId: n.id, name: g.name, note: 'Saved to the shared library: the guideline is available in every project.' }
  },
  update_guideline: (a) => {
    const g = requireGuideline(a.id)
    const next: GuideData = {
      ...g,
      ...(a.name !== undefined && { name: a.name }),
      ...(a.description !== undefined && { description: a.description }),
      ...(a.accent !== undefined && { accent: a.accent }),
      ...(a.colors && { colors: withIds(a.colors, g.colors) }),
      ...(a.fonts && { fonts: withIds(a.fonts, g.fonts) }),
      ...(a.rules !== undefined && { rules: a.rules }),
      ...(a.sections && { sections: (a.sections as Args[]).map((s, i) => ({ id: g.sections[i]?.id ?? newGuideId(), title: s.title ?? '', text: s.text ?? '', images: g.sections[i]?.images ?? [] })) }),
      updatedAt: Date.now()
    }
    saveGuide(next)
    return { ...guidelineView(next), note: 'The guideline is shared: this edit applies in every project that uses it.' }
  },
  place_guideline: (a) => {
    const g = requireGuideline(a.id)
    const n = placeGuide(g.id, { x: a.x ?? 0, y: a.y ?? 0 }, !!a.open)
    if (Array.isArray(a.frameIds) && a.frameIds.length) setGuideTargets(n.id, a.frameIds)
    return { ...created(ed.nodes.get(n.id)!), guideline: { id: g.id, name: g.name } }
  },
  get_guideline_image: async (a) => {
    const png = await imageAsPng(guidelineImage(requireGuideline(a.id), a.kind, a.name).dataUrl)
    let bin = ''
    for (let i = 0; i < png.bytes.length; i += 0x8000) bin += String.fromCharCode(...png.bytes.subarray(i, i + 0x8000))
    return { pngBase64: btoa(bin), width: png.width, height: png.height }
  },
  place_guideline_image: async (a) => {
    const im = guidelineImage(requireGuideline(a.id), a.kind, a.name)
    const png = await imageAsPng(im.dataUrl)
    const hash = await backend.blob.put(png.bytes, 'image/png')
    const w = a.width ?? (a.height ? (png.width / png.height) * a.height : png.width)
    const h = a.height ?? (png.height / png.width) * w
    return created(
      ed.act(() =>
        ed.addNode({ type: 'RECTANGLE', name: im.name || 'Logo', x: a.x ?? 0, y: a.y ?? 0, width: w, height: h, fills: [{ type: 'IMAGE', imageHash: hash, scaleMode: 'FIT' }], parentId: checkParent(a.parentId) })
      )
    )
  },
  link_guideline: (a) => {
    const n = requireNode(a.nodeId)
    const cur = (n.guide?.targets ?? []).filter((id) => ed.nodes.has(id))
    const ids: string[] = a.frameIds
    setGuideTargets(n.id, a.mode === 'set' ? ids : a.mode === 'remove' ? cur.filter((id) => !ids.includes(id)) : [...cur, ...ids])
    return { nodeId: n.id, linkedFrames: (ed.nodes.get(n.id)!.guide?.targets ?? []).map((id) => ({ id, name: ed.nodes.get(id)?.name })) }
  },
  link_spec: (a) => {
    const s = requireNode(a.specId)
    if (s.type !== 'SPEC') throw new Error('specId is not a Spec card')
    const role = a.role === 'source' ? 'sources' : 'targets'
    const cur = (s.spec?.[role] ?? []).filter((id) => ed.nodes.has(id))
    const ids: string[] = a.frameIds
    setLinks(s.id, a.mode === 'set' ? ids : a.mode === 'remove' ? cur.filter((id) => !ids.includes(id)) : [...cur, ...ids], role)
    const now = ed.nodes.get(s.id)!
    return { id: s.id, title: s.spec?.title, linkedFrames: framesOf(now), sourceFrames: framesOf(now, 'sources') }
  },
  find_nodes: (a) => {
    const q = (a.name ?? '').toLowerCase()
    const res: unknown[] = []
    for (const n of ed.nodes.values()) {
      if (n.pageId !== ed.currentPageId) continue
      if (a.type && n.type !== a.type) continue
      if (q && !n.name.toLowerCase().includes(q)) continue
      res.push({ id: n.id, type: n.type, name: n.name, parentId: n.parentId })
      if (res.length >= 500) break
    }
    return res
  },
  create_frame: (a) =>
    created(
      ed.act(() =>
        ed.addNode({
          type: 'FRAME',
          name: a.name,
          x: a.x,
          y: a.y,
          width: a.width,
          height: a.height,
          fills: solid(a.fill ?? '#FFFFFF'),
          cornerRadius: a.cornerRadius,
          clipsContent: true,
          parentId: checkParent(a.parentId),
          ...layoutPatch(a)
        })
      )
    ),
  create_rectangle: (a) =>
    created(
      ed.act(() =>
        ed.addNode({
          type: 'RECTANGLE',
          name: a.name ?? 'Rectangle',
          x: a.x,
          y: a.y,
          width: a.width,
          height: a.height,
          fills: solid(a.fill ?? (a.stroke ? undefined : '#D9D9D9')),
          strokes: strokes(a),
          cornerRadius: a.cornerRadius,
          opacity: a.opacity ?? 1,
          parentId: checkParent(a.parentId)
        })
      )
    ),
  create_ellipse: (a) =>
    created(
      ed.act(() =>
        ed.addNode({
          type: 'ELLIPSE',
          name: a.name ?? 'Ellipse',
          x: a.x,
          y: a.y,
          width: a.width,
          height: a.height,
          fills: solid(a.fill ?? (a.stroke ? undefined : '#D9D9D9')),
          strokes: strokes(a),
          opacity: a.opacity ?? 1,
          parentId: checkParent(a.parentId)
        })
      )
    ),
  create_text: (a) =>
    created(
      ed.act(() =>
        ed.addNode({
          type: 'TEXT',
          name: a.name ?? String(a.text).slice(0, 40),
          characters: a.text,
          x: a.x,
          y: a.y,
          width: a.width ?? 100,
          textAutoResize: a.width ? 'HEIGHT' : 'WIDTH_AND_HEIGHT',
          textStyle: {
            fontFamily: a.fontFamily ?? 'Inter',
            fontSize: a.fontSize ?? 16,
            fontWeight: a.fontWeight ?? 400,
            align: a.align ?? 'LEFT',
            lineHeight: a.lineHeight,
            ...typography(a)
          },
          fills: solid(a.color ?? '#000000'),
          parentId: checkParent(a.parentId)
        })
      )
    ),
  create_svg: async (a) => {
    const parentId = checkParent(a.parentId)
    const nodes = await svgToNodes(a.svg, { name: a.name, width: a.width })
    const root = nodes.find((n) => !n.parentId)!
    const dx = a.x - root.x
    const dy = a.y - root.y
    for (const n of nodes)
      if (!n.parentId) {
        n.x += dx
        n.y += dy
      }
    // pasteNodes expects world coordinates for roots
    const pw = parentId ? ed.world(parentId) : { x: 0, y: 0 }
    for (const n of nodes)
      if (!n.parentId) {
        n.x += pw.x
        n.y += pw.y
      }
    const ids = ed.pasteNodes(nodes, parentId)
    return ids.map((id) => created(ed.nodes.get(id)!))
  },
  create_image: async (a) => {
    const parentId = checkParent(a.parentId)
    const hash: string = a.imageHash
    if (!hash) throw new Error('create_image needs source or imageHash')
    const size = await imageSize(hash)
    let w = a.width ?? size?.w ?? 200
    let h = a.height ?? size?.h ?? 200
    if (size && a.width && !a.height) h = (size.h / size.w) * a.width
    if (size && a.height && !a.width) w = (size.w / size.h) * a.height
    return created(
      ed.act(() =>
        ed.addNode({
          type: 'RECTANGLE',
          name: a.name ?? 'Image',
          x: a.x,
          y: a.y,
          width: w,
          height: h,
          fills: [{ type: 'IMAGE', imageHash: hash, scaleMode: a.scaleMode ?? 'FILL' }],
          parentId
        })
      )
    )
  },
  update_node: (a) => {
    const n = requireNode(a.id)
    ed.act(() => {
      const patch: Partial<GNode> = {}
      for (const k of ['name', 'x', 'y', 'width', 'height', 'cornerRadius', 'opacity', 'visible', 'locked'] as const)
        if (a[k] !== undefined) (patch as Args)[k] = a[k]
      if (a.text !== undefined) patch.characters = a.text
      if (a.width !== undefined && n.type === 'TEXT') patch.textAutoResize = 'HEIGHT'
      // an explicit height makes a text box fixed-size (needed for truncation / vertical align)
      if (a.height !== undefined && n.type === 'TEXT') patch.textAutoResize = 'NONE'
      if (a.fontSize || a.fontWeight || a.fontFamily || a.align)
        patch.textStyle = {
          ...n.textStyle!,
          ...(a.fontSize && { fontSize: a.fontSize }),
          ...(a.fontWeight && { fontWeight: a.fontWeight }),
          ...(a.fontFamily && { fontFamily: a.fontFamily }),
          ...(a.align && { align: a.align })
        }
      if (n.type === 'TEXT' && Object.keys(typography(a)).length) patch.textStyle = { ...(patch.textStyle ?? n.textStyle!), ...typography(a) }
      if (a.fill !== undefined) patch.fills = [...n.fills.filter((f) => f.type !== 'SOLID'), ...solid(a.fill)]
      if (a.stroke !== undefined || a.strokeWeight !== undefined)
        patch.strokes = [{ color: a.stroke ? hexToRgba(a.stroke) : n.strokes[0]?.color ?? hexToRgba('#000000'), weight: a.strokeWeight ?? n.strokes[0]?.weight ?? 1, align: 'INSIDE' }]
      if (a.strokeAlign && (patch.strokes ?? n.strokes).length)
        patch.strokes = (patch.strokes ?? n.strokes).map((s) => ({ ...s, align: a.strokeAlign }))
      if (a.isMask !== undefined) patch.isMask = a.isMask || undefined
      if (Array.isArray(a.fills))
        patch.fills = a.fills.map((f: Args): Paint => {
          if (f.type === 'IMAGE') {
            if (!f.imageHash) throw new Error('IMAGE fill needs source or imageHash')
            return { type: 'IMAGE', imageHash: f.imageHash, scaleMode: f.scaleMode ?? 'FILL', visible: f.visible }
          }
          if (typeof f.type === 'string' && f.type.startsWith('GRADIENT_')) {
            if (!Array.isArray(f.stops) || f.stops.length < 2) throw new Error('gradient fill needs at least 2 stops')
            return {
              type: f.type as GradientType,
              angle: f.angle ?? 180,
              // start, end and width handle in the units of the box; without them the angle places a linear gradient
              handles: Array.isArray(f.handles) && f.handles.length === 3 ? (f.handles.map((p: Args) => ({ x: +p.x, y: +p.y })) as GradientPaint['handles']) : undefined,
              opacity: typeof f.opacity === 'number' && f.opacity < 1 ? Math.max(0, f.opacity) : undefined,
              stops: f.stops.map((s: Args) => ({ position: s.position, color: hexToRgba(s.color) })),
              visible: f.visible
            }
          }
          return { type: 'SOLID', color: hexToRgba(f.color ?? '#D9D9D9'), visible: f.visible }
        })
      if (Array.isArray(a.strokes))
        patch.strokes = a.strokes.map((s: Args) => ({ color: hexToRgba(s.color), weight: s.weight ?? 1, align: s.align ?? 'INSIDE', visible: s.visible }))
      if (a.clipsContent !== undefined) patch.clipsContent = a.clipsContent
      if (n.type === 'CODE' && (a.html !== undefined || a.css !== undefined))
        patch.code = { html: a.html ?? n.code?.html ?? '', css: a.css ?? n.code?.css ?? '' }
      if (a.arrowEnd !== undefined) patch.arrowEnd = a.arrowEnd || undefined
      if (Array.isArray(a.cornerRadii)) {
        patch.cornerRadii = a.cornerRadii as [number, number, number, number]
        patch.cornerRadius = undefined
      } else if (a.cornerRadius !== undefined) patch.cornerRadii = undefined
      if (a.rotation !== undefined) patch.rotation = a.rotation || undefined
      if (a.flipX !== undefined) patch.flipX = a.flipX || undefined
      if (a.flipY !== undefined) patch.flipY = a.flipY || undefined
      if (a.constrainProportions !== undefined) patch.constrainProportions = a.constrainProportions || undefined
      if (a.textAutoResize !== undefined && n.type === 'TEXT') patch.textAutoResize = a.textAutoResize
      if (n.type === 'TEXT' && (a.lineHeight !== undefined || a.letterSpacing !== undefined))
        patch.textStyle = {
          ...(patch.textStyle ?? n.textStyle!),
          ...(a.lineHeight !== undefined && { lineHeight: a.lineHeight, lineHeightPercent: undefined }),
          ...(a.letterSpacing !== undefined && { letterSpacing: a.letterSpacing, letterSpacingPercent: undefined })
        }
      if (Array.isArray(a.effects))
        patch.effects = a.effects.length
          ? a.effects.map((e: Args): Effect =>
              e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW'
                ? {
                    type: e.type,
                    color: e.color ? hexToRgba(e.color) : { r: 0, g: 0, b: 0, a: 0.25 },
                    offset: { x: e.x ?? 0, y: e.y ?? 4 },
                    radius: e.radius ?? 4,
                    spread: e.spread ?? 0,
                    visible: e.visible ?? true
                  }
                : { type: e.type, radius: e.radius ?? 4, visible: e.visible ?? true }
            )
          : undefined
      Object.assign(patch, layoutPatch(a))
      if (a.layoutGrow !== undefined) patch.layoutGrow = a.layoutGrow || undefined
      if (a.layoutAlign !== undefined) patch.layoutAlign = a.layoutAlign === 'STRETCH' ? 'STRETCH' : undefined
      if (a.layoutPositioning !== undefined) patch.layoutPositioning = a.layoutPositioning === 'ABSOLUTE' ? 'ABSOLUTE' : undefined
      if (a.blendMode !== undefined) patch.blendMode = a.blendMode === 'NORMAL' ? undefined : a.blendMode
      if (a.constraints) patch.constraints = { horizontal: a.constraints.horizontal ?? n.constraints?.horizontal ?? 'MIN', vertical: a.constraints.vertical ?? n.constraints?.vertical ?? 'MIN' }
      // linking a style also gives the layer the look of that style
      if (a.fillStyleId !== undefined) {
        const s = a.fillStyleId ? (ed.meta.colorStyles ?? []).find((x) => x.id === a.fillStyleId) : null
        if (a.fillStyleId && !s) throw new Error('unknown colour style (see list_styles)')
        patch.fillStyleId = s?.id
        if (s) patch.fills = [...(patch.fills ?? n.fills).filter((f) => f.type !== 'SOLID'), { type: 'SOLID', color: { ...s.color } }]
      }
      if (a.strokeStyleId !== undefined) {
        const s = a.strokeStyleId ? (ed.meta.colorStyles ?? []).find((x) => x.id === a.strokeStyleId) : null
        if (a.strokeStyleId && !s) throw new Error('unknown colour style (see list_styles)')
        patch.strokeStyleId = s?.id
        const cur = patch.strokes ?? n.strokes
        if (s) patch.strokes = cur.length ? cur.map((x, i) => (i === 0 ? { ...x, color: { ...s.color } } : x)) : [{ color: { ...s.color }, weight: 1, align: 'INSIDE' }]
      }
      if (a.textStyleId !== undefined && n.type === 'TEXT') {
        const s = a.textStyleId ? (ed.meta.textStyles ?? []).find((x) => x.id === a.textStyleId) : null
        if (a.textStyleId && !s) throw new Error('unknown text style (see list_styles)')
        patch.textStyleId = s?.id
        if (s) patch.textStyle = structuredClone(s.style)
      }
      ed.updateNode(n.id, patch)
      if (a.parentId !== undefined) ed.reparent(n.id, a.parentId ? checkParent(a.parentId) : null)
    })
    return created(requireNode(a.id))
  },
  delete_nodes: (a) => {
    ed.act(() => {
      for (const id of a.ids) ed.deleteNode(id)
      ed.selection = ed.selection.filter((s) => ed.nodes.has(s))
    })
    ed.emit('selection')
    return { deleted: a.ids.length }
  },
  group_nodes: (a) => {
    a.ids.forEach(requireNode)
    const id = ed.group(a.ids, a.name ?? 'Group')
    return id ? created(ed.nodes.get(id)!) : null
  },
  create_shape: (a) => {
    const parentId = a.kind === 'section' ? (a.parentId ? checkParent(a.parentId) : null) : checkParent(a.parentId)
    const base = { name: a.name, parentId, x: a.x, y: a.y, width: a.width, height: a.height }
    const fills = solid(a.fill ?? (a.kind === 'line' || a.kind === 'arrow' || a.kind === 'slice' ? undefined : a.kind === 'section' ? '#FFFFFF14' : '#D9D9D9'))
    return created(
      ed.act(() => {
        switch (a.kind) {
          case 'line':
          case 'arrow':
            return ed.addNode({
              type: 'VECTOR',
              ...base,
              name: a.name ?? (a.kind === 'arrow' ? 'Arrow' : 'Line'),
              path: `M0 0L${a.width} ${a.height}`,
              pathBox: { w: a.width, h: a.height },
              fills: [],
              strokes: [{ color: hexToRgba(a.stroke ?? '#000000'), weight: a.strokeWeight ?? 2, align: 'CENTER' }],
              arrowEnd: a.kind === 'arrow' || undefined
            })
          case 'polygon':
            return ed.addNode({ type: 'VECTOR', ...base, name: a.name ?? 'Polygon', shape: { kind: 'POLYGON', count: a.sides ?? 3 }, fills, strokes: strokes(a) })
          case 'star':
            return ed.addNode({ type: 'VECTOR', ...base, name: a.name ?? 'Star', shape: { kind: 'STAR', count: a.sides ?? 5, ratio: a.innerRatio ?? 0.382 }, fills, strokes: strokes(a) })
          case 'section':
            return ed.addNode({ type: 'SECTION', ...base, name: a.name ?? 'Section', fills, strokes: [{ color: { r: 1, g: 1, b: 1, a: 0.25 }, weight: 1, align: 'INSIDE' }], cornerRadius: 4 })
          default:
            return ed.addNode({ type: 'SLICE', ...base, name: a.name ?? 'Slice' })
        }
      })
    )
  },
  list_specs: (a) =>
    [...ed.nodes.values()]
      .filter((n) => n.type === 'SPEC' && (a.allPages !== false || n.pageId === ed.currentPageId) && (!a.status || (n.spec?.kind !== 'RULES' && n.spec?.status === a.status)) && (!a.kind || (n.spec?.kind ?? 'TASK') === a.kind))
      .map((n) => ({
        id: n.id,
        pageId: n.pageId,
        page: ed.pages.get(n.pageId)?.name,
        parentId: n.parentId,
        ...specView(n),
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height
      })),
  update_spec: (a) => {
    const n = requireNode(a.id)
    if (n.type !== 'SPEC') throw new Error('not a Spec node')
    ed.act(() =>
      ed.updateNode(n.id, {
        spec: {
          ...(n.spec ?? { title: '', body: '', status: 'TODO' }),
          ...(a.status && { status: a.status }),
          ...(a.result !== undefined && { result: a.result }),
          ...(a.title !== undefined && { title: a.title }),
          ...(a.body !== undefined && { body: a.body }),
          ...(a.kind && { kind: a.kind === 'RULES' ? ('RULES' as const) : undefined })
        }
      })
    )
    if (Array.isArray(a.frameIds)) setLinks(n.id, a.frameIds)
    if (Array.isArray(a.sourceIds)) setLinks(n.id, a.sourceIds, 'sources')
    return { id: n.id, ...specView(ed.nodes.get(n.id)!) }
  },
  create_spec: (a) => {
    const n = ed.act(() =>
      ed.addNode({
        type: 'SPEC',
        name: a.title.slice(0, 40) || 'Spec',
        parentId: checkParent(a.parentId),
        x: a.x,
        y: a.y,
        width: a.width ?? 320,
        height: a.height ?? 220,
        spec: { title: a.title, body: a.body ?? '', status: 'TODO', ...(a.kind === 'RULES' && { kind: 'RULES' as const }) }
      })
    )
    if (Array.isArray(a.frameIds) && a.frameIds.length) setLinks(n.id, a.frameIds)
    if (Array.isArray(a.sourceIds) && a.sourceIds.length) setLinks(n.id, a.sourceIds, 'sources')
    const now = ed.nodes.get(n.id)!
    return { ...created(now), kind: now.spec?.kind ?? 'TASK', linkedFrames: framesOf(now), sourceFrames: framesOf(now, 'sources') }
  },
  create_code: async (a) => {
    const n = ed.act(() =>
      ed.addNode({
        type: 'CODE',
        name: a.name ?? 'Code',
        parentId: checkParent(a.parentId),
        x: a.x,
        y: a.y,
        width: a.width ?? 400,
        height: a.height ?? 300,
        code: { html: a.html, css: a.css ?? '' }
      })
    )
    // wait for the first render so export_png right after shows the result
    const w = ed.world(n.id)
    await codeBitmapAsync(n, w.w, w.h, 1).catch(() => null)
    ed.emit('doc')
    return created(n)
  },
  list_annotations: (a) =>
    [...ed.nodes.values()]
      .filter((n) => n.type === 'ANNOTATION' && (a.includeResolved || !n.resolved) && (a.allPages !== false || n.pageId === ed.currentPageId))
      .map((n) => {
        const w = ed.world(n.id)
        // the layer under the pin, so the AI knows what the note is about
        const prevPage = ed.currentPageId
        let under: string | null = null
        if (n.pageId === prevPage) under = ed.hitTest(w.x + 1, w.y + 1, true)
        const u = under ? ed.nodes.get(under) : undefined
        return { id: n.id, text: n.characters ?? '', resolved: !!n.resolved, pageId: n.pageId, x: w.x, y: w.y, layer: u ? { id: u.id, name: u.name, type: u.type } : null }
      }),
  create_annotation: (a) => {
    const n = ed.act(() => ed.addNode({ type: 'ANNOTATION', name: String(a.text).slice(0, 40) || 'Annotation', x: a.x, y: a.y, width: 1, height: 1, characters: a.text }))
    return { id: n.id }
  },
  resolve_annotation: (a) => {
    const n = requireNode(a.id)
    ed.act(() => ed.updateNode(n.id, { resolved: true }))
    return { ok: true }
  },
  boolean_operation: async (a) => {
    a.ids.forEach(requireNode)
    const { layerActions } = await import('../ui/layerActions')
    ed.setSelection(a.ids)
    layerActions.booleanOp(a.operation)
    const n = ed.nodes.get(ed.selection[0])!
    if (a.name) ed.act(() => ed.updateNode(n.id, { name: a.name }))
    return created(n)
  },
  flatten_nodes: async (a) => {
    a.ids.forEach(requireNode)
    const { layerActions } = await import('../ui/layerActions')
    ed.setSelection(a.ids)
    layerActions.flatten()
    const n = ed.nodes.get(ed.selection[0])!
    if (n.type !== 'VECTOR') throw new Error('nothing to flatten: the layers have no area')
    return created(n)
  },
  add_variant: (a) => {
    const main = requireNode(a.componentId)
    if (!main.isComponent) throw new Error('componentId is not a main component (use create_component first)')
    const id = ed.addVariant(main.id)
    if (!id) throw new Error('could not add a variant')
    if (a.name) ed.act(() => ed.updateNode(id, { name: a.name }))
    const set = ed.componentSetOf(id)!
    return { ...created(ed.nodes.get(id)!), componentSetId: set.id, variants: ed.variantsOf(set.id).map((v) => ({ id: v.id, properties: v.props })) }
  },
  set_variant: (a) => {
    const inst = requireNode(a.instanceId)
    const main = inst.componentId ? ed.nodes.get(inst.componentId) : undefined
    const set = main ? ed.componentSetOf(main.id) : null
    if (!main || !set) throw new Error('instanceId is not an instance of a component with variants')
    const want: Record<string, string> = { ...parseVariant(main.name), ...(a.properties as Record<string, string>) }
    const variants = ed.variantsOf(set.id)
    const hit = variants.find((v) => Object.keys(want).every((k) => v.props[k] === want[k]))
    if (!hit) throw new Error('no such variant; available: ' + variants.map((v) => ed.nodes.get(v.id)!.name).join(' | '))
    ed.swapInstance(inst.id, hit.id)
    return { ...created(ed.nodes.get(inst.id)!), properties: hit.props }
  },
  list_styles: () => ({
    colors: (ed.meta.colorStyles ?? []).map((s) => ({ id: s.id, name: s.name, color: rgbaToHex(s.color, true) })),
    texts: (ed.meta.textStyles ?? []).map((s) => ({ id: s.id, name: s.name, ...s.style }))
  }),
  create_style: (a) => {
    const id = crypto.randomUUID()
    if (a.kind === 'color') {
      if (!a.color) throw new Error('a colour style needs "color"')
      ed.setColorStyles([...(ed.meta.colorStyles ?? []), { id, name: a.name, color: hexToRgba(a.color) }])
    } else
      ed.setTextStyles([
        ...(ed.meta.textStyles ?? []),
        { id, name: a.name, style: { ...DEFAULT_TEXT_STYLE, ...(a.fontFamily && { fontFamily: a.fontFamily }), ...(a.fontSize && { fontSize: a.fontSize }), ...(a.fontWeight && { fontWeight: a.fontWeight }), ...(a.lineHeight !== undefined && { lineHeight: a.lineHeight }), ...(a.letterSpacing !== undefined && { letterSpacing: a.letterSpacing }), ...typography(a) } }
      ])
    return { id, kind: a.kind, name: a.name }
  },
  update_style: (a) => {
    const c = (ed.meta.colorStyles ?? []).find((s) => s.id === a.id)
    const tx = (ed.meta.textStyles ?? []).find((s) => s.id === a.id)
    if (c) ed.updateColorStyle(c.id, { ...(a.name && { name: a.name }), ...(a.color && { color: hexToRgba(a.color) }) })
    else if (tx) {
      const style = { ...tx.style, ...(a.fontFamily && { fontFamily: a.fontFamily }), ...(a.fontSize && { fontSize: a.fontSize }), ...(a.fontWeight && { fontWeight: a.fontWeight }), ...(a.lineHeight !== undefined && { lineHeight: a.lineHeight, lineHeightPercent: undefined }), ...(a.letterSpacing !== undefined && { letterSpacing: a.letterSpacing, letterSpacingPercent: undefined }), ...typography(a) }
      ed.updateTextStyle(tx.id, { ...(a.name && { name: a.name }), style })
    } else throw new Error('unknown style (see list_styles)')
    return { id: a.id, users: [...ed.nodes.values()].filter((n) => n.fillStyleId === a.id || n.strokeStyleId === a.id || n.textStyleId === a.id).length }
  },
  delete_style: (a) => {
    const kind = (ed.meta.colorStyles ?? []).some((s) => s.id === a.id) ? 'color' : (ed.meta.textStyles ?? []).some((s) => s.id === a.id) ? 'text' : null
    if (!kind) throw new Error('unknown style (see list_styles)')
    ed.deleteStyle(kind, a.id)
    return { deleted: a.id }
  },
  create_component: async (a) => {
    a.ids.forEach(requireNode)
    const { layerActions } = await import('../ui/layerActions')
    ed.setSelection(a.ids)
    layerActions.createComponent()
    const n = ed.nodes.get(ed.selection[0])!
    if (!n.isComponent) throw new Error('could not create a component: the layers are already part of a component or an instance')
    if (a.name) ed.act(() => ed.updateNode(n.id, { name: a.name }))
    return created(n)
  },
  create_instance: (a) => {
    const main = requireNode(a.componentId)
    if (!main.isComponent) throw new Error('componentId is not a main component (use create_component first)')
    const parentId = checkParent(a.parentId)
    const n = ed.act(() => ed.createInstance(main.id, parentId, a.x, a.y))
    return { ...created(ed.nodes.get(n.id)!), layers: ed.descendants(n.id).map((id) => ({ id, name: ed.nodes.get(id)!.name, type: ed.nodes.get(id)!.type })) }
  },
  detach_instance: (a) => {
    a.ids.forEach(requireNode)
    ed.detachInstance(a.ids)
    return { detached: a.ids.length }
  },
  outline_stroke: async (a) => {
    a.ids.forEach(requireNode)
    const { layerActions } = await import('../ui/layerActions')
    ed.setSelection(a.ids)
    layerActions.outlineStroke()
    return ed.selection.map((id) => created(ed.nodes.get(id)!))
  },
  ungroup_nodes: (a) => {
    a.ids.forEach(requireNode)
    ed.setSelection(a.ids)
    ed.ungroup()
    return { selection: ed.selection }
  },
  duplicate_nodes: (a) => {
    a.ids.forEach(requireNode)
    const ids = ed.duplicate(a.ids)
    if (a.offsetX || a.offsetY) ed.act(() => ids.forEach((id) => ed.moveBy(id, a.offsetX ?? 0, a.offsetY ?? 0)))
    return ids.map((id) => created(ed.nodes.get(id)!))
  },
  reorder_nodes: (a) => {
    a.ids.forEach(requireNode)
    const prev = ed.selection
    ed.selection = a.ids
    ed.reorder({ front: Infinity, back: -Infinity, forward: 1, backward: -1 }[a.to as 'front'])
    ed.selection = prev
    ed.emit('doc')
    return { ok: true }
  },
  align_nodes: (a) => {
    const ids = ed.roots(a.ids.map((id: string) => requireNode(id).id))
    alignNodes(ids, a.align)
    return ids.map((id) => created(ed.nodes.get(id)!))
  },
  update_page: (a) => {
    const id = a.pageId ?? ed.currentPageId
    if (!ed.pages.has(id)) throw new Error('page not found')
    const patch: Record<string, unknown> = {}
    if (a.name) patch.name = a.name
    if (a.background) patch.background = hexToRgba(a.background)
    ed.updatePage(id, patch)
    return { id, ...ed.pages.get(id) }
  },
  delete_page: (a) => {
    if (!ed.pages.has(a.pageId)) throw new Error('page not found')
    if (ed.pages.size <= 1) throw new Error('cannot delete the last page')
    ed.deletePage(a.pageId)
    return { ok: true, currentPageId: ed.currentPageId }
  },
  export_png: async (a) => {
    let ids: string[] = a.id ? [requireNode(a.id).id] : ed.selection
    if (!ids.length) ids = [...ed.children(null)] // whole page
    if (!ids.length) throw new Error('The page is empty')
    const b = ed.selectionBounds(ed.roots(ids))!
    const maxSize = a.maxSize ?? 1600
    const scale = Math.min(a.scale ?? 1, maxSize / Math.max(b.w, b.h, 1))
    const r = await exportPng(ed, ids, scale)
    return { pngBase64: r.base64, width: r.width, height: r.height }
  },
  get_screenshot: async (a) => {
    // exactly what the user sees: the live canvas including selection and frame labels
    const src = document.querySelector<HTMLCanvasElement>('.canvas-wrap canvas')
    if (!src) throw new Error('canvas not ready')
    await new Promise((r) => requestAnimationFrame(r))
    const maxSize = a.maxSize ?? 1400
    const s = Math.min(1, maxSize / Math.max(src.width, src.height))
    const c = document.createElement('canvas')
    c.width = Math.round(src.width * s)
    c.height = Math.round(src.height * s)
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(src, 0, 0, c.width, c.height)
    const url = c.toDataURL('image/png')
    return { pngBase64: url.slice(url.indexOf(',') + 1), width: c.width, height: c.height }
  },
  export_svg: async (a) => nodesToSvg(ed, [requireNode(a.id).id], false),
  // describes the pages; the main process turns them into the PDF file and returns its path
  export_pdf: async (a) => {
    const ids: string[] = Array.isArray(a.ids) && a.ids.length ? a.ids.map((id: string) => requireNode(id).id) : framesInReadingOrder(ed)
    if (!ids.length) throw new Error('nothing to export: the page has no frames (pass ids)')
    return { pages: await pdfPages(ed, ids), name: a.name ?? (ids.length === 1 ? ed.nodes.get(ids[0])!.name : `${ed.meta.name} – ${ed.page.name}`) }
  },
  zoom_to: (a) => {
    ed.setSelection(a.ids)
    ed.zoomToRect(ed.selectionBounds(), 4)
    return { ok: true }
  }
}

export async function executeCommand(req: CommandRequest): Promise<CommandResponse> {
  try {
    const h = handlers[req.name]
    if (!h) throw new Error('Unknown command ' + req.name)
    const result = await h(req.args ?? {})
    if (req.client) aiCursor.touch(req.client, req.name, req.args ?? {}, result)
    // the task board on Home shows which assistant works on a spec (creating a card is not working on it)
    if (req.client && req.name === 'update_spec') noteSpecClient(req.args?.id, req.client)
    return { id: req.id, ok: true, result }
  } catch (e) {
    return { id: req.id, ok: false, error: (e as Error).message }
  }
}

export function installCommandBus(): void {
  backend.onCommand(async (req) => backend.respondCommand(await executeCommand(req)))
}
