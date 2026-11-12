// Executes command-bus requests (from MCP now, plugins later) as normal undoable edits.
import type { CommandName, CommandRequest, CommandResponse } from '@shared/commands'
import type { Effect, GNode, Paint, TextStyle } from '@shared/types'
import { hexToRgba } from '@shared/types'
import { backend } from '../backend'
import { editor as ed } from './editor'
import { exportPng, imageSize } from './render'
import { nodesToSvg, svgToNodes } from './svg'
import { polygonPath, starPath } from './shapes'
import { codeBitmapAsync } from './code-render'

type Args = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

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
  for (const k of ['itemSpacing', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'primaryAxisSizingMode', 'counterAxisSizingMode'] as const)
    if (a[k] !== undefined) (out as Args)[k] = a[k]
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
  return { id: n.id, type: n.type, name: n.name, x: n.x, y: n.y, width: n.width, height: n.height, parentId: n.parentId }
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
  get_node: (a) => requireNode(a.id),
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
          if (f.type === 'GRADIENT_LINEAR' || f.type === 'GRADIENT_RADIAL') {
            if (!Array.isArray(f.stops) || f.stops.length < 2) throw new Error('gradient fill needs at least 2 stops')
            return { type: f.type, angle: f.angle ?? 180, stops: f.stops.map((s: Args) => ({ position: s.position, color: hexToRgba(s.color) })), visible: f.visible }
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
            return ed.addNode({ type: 'VECTOR', ...base, name: a.name ?? 'Polygon', path: polygonPath(a.sides ?? 3, 100, 100), pathBox: { w: 100, h: 100 }, fills, strokes: strokes(a) })
          case 'star':
            return ed.addNode({ type: 'VECTOR', ...base, name: a.name ?? 'Star', path: starPath(a.sides ?? 5, a.innerRatio ?? 0.382, 100, 100), pathBox: { w: 100, h: 100 }, fills, strokes: strokes(a) })
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
      .filter((n) => n.type === 'SPEC' && (a.allPages !== false || n.pageId === ed.currentPageId) && (!a.status || n.spec?.status === a.status))
      .map((n) => ({
        id: n.id,
        pageId: n.pageId,
        page: ed.pages.get(n.pageId)?.name,
        parentId: n.parentId,
        ...n.spec,
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
          ...(a.body !== undefined && { body: a.body })
        }
      })
    )
    return { id: n.id, ...ed.nodes.get(n.id)!.spec }
  },
  create_spec: (a) =>
    created(
      ed.act(() =>
        ed.addNode({
          type: 'SPEC',
          name: a.title.slice(0, 40) || 'Spec',
          parentId: checkParent(a.parentId),
          x: a.x,
          y: a.y,
          width: a.width ?? 320,
          height: a.height ?? 220,
          spec: { title: a.title, body: a.body ?? '', status: 'TODO' }
        })
      )
    ),
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
    return { id: req.id, ok: true, result }
  } catch (e) {
    return { id: req.id, ok: false, error: (e as Error).message }
  }
}

export function installCommandBus(): void {
  backend.onCommand(async (req) => backend.respondCommand(await executeCommand(req)))
}
