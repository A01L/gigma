// Editor core: in-memory document, selection, camera, undo/redo, spatial index,
// and batched incremental persistence to the .gigma file.
import RBush from 'rbush'
import type { Constraint, DocMeta, DocSnapshot, GNode, Page, Paint, RGBA } from '@shared/types'
import { DEFAULT_PAGE_BG } from '@shared/types'
import { backend } from '../backend'
import { keyBetween, rectsIntersect, uid, unionRects, type Rect } from './util'
import { DEFAULT_TEXT_STYLE, fitText } from './text'
import { computeLayout, inFlow, isAutoLayout } from './autolayout'

export type Tool =
  | 'move'
  | 'hand'
  | 'scale'
  | 'frame'
  | 'section'
  | 'slice'
  | 'rect'
  | 'line'
  | 'arrow'
  | 'ellipse'
  | 'polygon'
  | 'star'
  | 'pen'
  | 'pencil'
  | 'text'
  | 'spec'
  | 'code'
  | 'annotation'
export type Topic = 'doc' | 'selection' | 'camera' | 'ui' | 'pages'

/** "Size=Large, State=Hover" -> { Size: 'Large', State: 'Hover' } (a name without "=" is one property) */
export function parseVariant(name: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of name.split(',')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
    else if (part.trim()) out['Property 1'] = part.trim()
  }
  return out
}
export const variantName = (props: Record<string, string>): string =>
  Object.entries(props)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')

/** properties an instance layer may differ in from the main component (Figma's overrides) */
const OVERRIDABLE = ['characters', 'fills', 'strokes', 'effects', 'opacity', 'visible', 'textStyle', 'blendMode'] as const
/** never copied from the main component */
const INSTANCE_OWN = new Set<string>(['id', 'parentId', 'pageId', 'isComponent', 'componentId', 'sourceId', 'overrides'])
/** the instance itself keeps its own place on the canvas */
const ROOT_OWN = new Set<string>(['x', 'y', 'order', 'name', 'rotation', 'flipX', 'flipY', 'locked', 'layoutGrow', 'layoutAlign', 'layoutPositioning', 'isMask'])

interface IndexItem {
  minX: number
  minY: number
  maxX: number
  maxY: number
  id: string
}

interface HistoryEntry {
  nodes: Map<string, { before: GNode | null; after: GNode | null }>
  pages: Map<string, { before: Page | null; after: Page | null }>
  selBefore: string[]
  selAfter: string[]
  pageBefore: string
  pageAfter: string
}

const clone = <T>(v: T): T => structuredClone(v)

export class Editor {
  meta!: DocMeta
  pages = new Map<string, Page>()
  nodes = new Map<string, GNode>()
  currentPageId = ''
  selection: string[] = []
  tool: Tool = 'move'
  camera = { x: 0, y: 0, zoom: 1 } // screen = world * zoom + (x, y)
  viewport = { w: 1, h: 1 }
  hoverId: string | null = null
  editingTextId: string | null = null
  leftOpen = true
  rightOpen = true
  toast: string | null = null
  toastAction: { label: string; run: () => void } | null = null

  private childrenOf = new Map<string, string[]>()
  private dirtyChildren = new Set<string>()
  private worldCache = new Map<string, Rect>()
  private tree = new RBush<IndexItem>()
  private treeItems = new Map<string, IndexItem>()
  private treeDirty = new Set<string>()
  private treeFull = true
  private listeners = new Map<Topic, Set<() => void>>()
  private versions: Record<Topic, number> = { doc: 0, selection: 0, camera: 0, ui: 0, pages: 0 }

  private tx: HistoryEntry | null = null
  private txDepth = 0
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []

  private pendingNodes = new Set<string>()
  private pendingPages = new Set<string>()
  private pendingMeta: Partial<DocMeta> | null = null
  private flushTimer: number | null = null

  // ---------------- lifecycle ----------------
  load(snap: DocSnapshot): void {
    this.meta = snap.meta
    this.pages = new Map(snap.pages.map((p) => [p.id, p]))
    this.nodes = new Map(snap.nodes.map((n) => [n.id, n]))
    this.childrenOf.clear()
    for (const n of this.nodes.values()) this.linkChild(n)
    this.dirtyChildren = new Set(this.childrenOf.keys())
    this.currentPageId = this.sortedPages()[0]?.id ?? ''
    this.selection = []
    this.undoStack = []
    this.redoStack = []
    this.invalidateAllGeometry()
    this.emit('doc', 'pages', 'selection', 'ui')
  }

  // ---------------- subscriptions ----------------
  subscribe(topic: Topic, fn: () => void): () => void {
    let s = this.listeners.get(topic)
    if (!s) this.listeners.set(topic, (s = new Set()))
    s.add(fn)
    return () => s!.delete(fn)
  }
  version(topic: Topic): number {
    return this.versions[topic]
  }
  emit(...topics: Topic[]): void {
    for (const t of topics) {
      this.versions[t]++
      this.listeners.get(t)?.forEach((f) => f())
    }
  }
  showToast(msg: string, action?: { label: string; run: () => void }): void {
    this.toast = msg
    this.toastAction = action ?? null
    this.emit('ui')
    setTimeout(
      () => {
        if (this.toast === msg) {
          this.toast = null
          this.toastAction = null
          this.emit('ui')
        }
      },
      action ? 12000 : 3500
    )
  }
  hideToast(): void {
    this.toast = null
    this.toastAction = null
    this.emit('ui')
  }

  // ---------------- tree helpers ----------------
  private parentKey(n: { parentId: string | null; pageId: string }): string {
    return n.parentId ?? 'page:' + n.pageId
  }
  private linkChild(n: GNode): void {
    const k = this.parentKey(n)
    let arr = this.childrenOf.get(k)
    if (!arr) this.childrenOf.set(k, (arr = []))
    arr.push(n.id)
    this.dirtyChildren.add(k)
  }
  private unlinkChild(n: GNode): void {
    const k = this.parentKey(n)
    const arr = this.childrenOf.get(k)
    if (!arr) return
    const i = arr.indexOf(n.id)
    if (i >= 0) arr.splice(i, 1)
  }
  /** children ids in z-order (bottom first) */
  children(parentId: string | null, pageId = this.currentPageId): string[] {
    const k = parentId ?? 'page:' + pageId
    const arr = this.childrenOf.get(k)
    if (!arr) return []
    if (this.dirtyChildren.has(k)) {
      arr.sort((a, b) => {
        const oa = this.nodes.get(a)!.order
        const ob = this.nodes.get(b)!.order
        return oa < ob ? -1 : oa > ob ? 1 : 0
      })
      this.dirtyChildren.delete(k)
    }
    return arr
  }
  sortedPages(): Page[] {
    return [...this.pages.values()].sort((a, b) => (a.order < b.order ? -1 : 1))
  }
  get page(): Page {
    return this.pages.get(this.currentPageId)!
  }
  ancestors(id: string): GNode[] {
    const out: GNode[] = []
    let n = this.nodes.get(id)
    while (n?.parentId) {
      n = this.nodes.get(n.parentId)
      if (n) out.push(n)
    }
    return out
  }
  isAncestor(ancestorId: string, id: string): boolean {
    return this.ancestors(id).some((a) => a.id === ancestorId)
  }
  descendants(id: string, out: string[] = []): string[] {
    for (const c of this.children(id)) {
      out.push(c)
      this.descendants(c, out)
    }
    return out
  }
  orderKeyAtTop(parentId: string | null, pageId = this.currentPageId): string {
    const ch = this.children(parentId, pageId)
    const last = ch.length ? this.nodes.get(ch[ch.length - 1])!.order : null
    return keyBetween(last, null)
  }

  // ---------------- geometry ----------------
  world(id: string): Rect {
    const c = this.worldCache.get(id)
    if (c) return c
    const n = this.nodes.get(id)!
    let x = n.x
    let y = n.y
    if (n.parentId) {
      const p = this.world(n.parentId)
      x += p.x
      y += p.y
    }
    const r = { x, y, w: n.width, h: n.height }
    this.worldCache.set(id, r)
    return r
  }
  /** the node and its ancestors that are rotated or mirrored, outermost first */
  private transformChain(id: string): GNode[] {
    const out: GNode[] = []
    for (let n = this.nodes.get(id); n; n = n.parentId ? this.nodes.get(n.parentId) : undefined) if (n.rotation || n.flipX || n.flipY) out.unshift(n)
    return out
  }
  /** point on the canvas -> the same point in the node's own unrotated space (where world() lives) */
  toUnrotated(id: string, x: number, y: number): { x: number; y: number } {
    for (const a of this.transformChain(id)) {
      const r = this.world(a.id)
      const cx = r.x + r.w / 2
      const cy = r.y + r.h / 2
      const t = ((a.rotation ?? 0) * Math.PI) / 180
      const dx = x - cx
      const dy = y - cy
      x = cx + (dx * Math.cos(t) - dy * Math.sin(t)) * (a.flipX ? -1 : 1)
      y = cy + (dx * Math.sin(t) + dy * Math.cos(t)) * (a.flipY ? -1 : 1)
    }
    return { x, y }
  }
  /** axis-aligned box of the node as it is drawn (rotation of the node and its ancestors applied) */
  visualBounds(id: string): Rect {
    const r = this.world(id)
    const chain = this.transformChain(id)
    if (!chain.length) return r
    let pts = [
      [r.x, r.y],
      [r.x + r.w, r.y],
      [r.x + r.w, r.y + r.h],
      [r.x, r.y + r.h]
    ]
    for (const a of chain.reverse()) {
      const w = this.world(a.id)
      const cx = w.x + w.w / 2
      const cy = w.y + w.h / 2
      const t = (-(a.rotation ?? 0) * Math.PI) / 180
      pts = pts.map(([px, py]) => {
        const dx = (px - cx) * (a.flipX ? -1 : 1)
        const dy = (py - cy) * (a.flipY ? -1 : 1)
        return [cx + dx * Math.cos(t) - dy * Math.sin(t), cy + dx * Math.sin(t) + dy * Math.cos(t)]
      })
    }
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
  }
  /** is the canvas point inside the node as drawn */
  containsPoint(id: string, x: number, y: number, tol = 0): boolean {
    const p = this.toUnrotated(id, x, y)
    const r = this.world(id)
    return p.x >= r.x - tol && p.y >= r.y - tol && p.x <= r.x + r.w + tol && p.y <= r.y + r.h + tol
  }
  private invalidateGeometry(id: string): void {
    this.worldCache.delete(id)
    this.treeDirty.add(id)
    for (const c of this.childrenOf.get(id) ?? []) this.invalidateGeometry(c)
  }
  private invalidateAllGeometry(): void {
    this.worldCache.clear()
    this.treeFull = true
  }
  private syncIndex(): void {
    if (this.treeFull) {
      this.tree.clear()
      this.treeItems.clear()
      const items: IndexItem[] = []
      for (const n of this.nodes.values()) {
        if (n.pageId !== this.currentPageId) continue
        const r = this.visualBounds(n.id)
        const it = { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h, id: n.id }
        items.push(it)
        this.treeItems.set(n.id, it)
      }
      this.tree.load(items)
      this.treeFull = false
      this.treeDirty.clear()
      return
    }
    if (!this.treeDirty.size) return
    for (const id of this.treeDirty) {
      const old = this.treeItems.get(id)
      if (old) {
        this.tree.remove(old)
        this.treeItems.delete(id)
      }
      const n = this.nodes.get(id)
      if (!n || n.pageId !== this.currentPageId) continue
      const r = this.visualBounds(id)
      const it = { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h, id }
      this.tree.insert(it)
      this.treeItems.set(id, it)
    }
    this.treeDirty.clear()
  }
  /** ids whose world bounds intersect r (any depth) */
  query(r: Rect): string[] {
    this.syncIndex()
    return this.tree.search({ minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h }).map((i) => i.id)
  }
  selectionBounds(ids = this.selection): Rect | null {
    return unionRects(ids.filter((id) => this.nodes.has(id)).map((id) => this.world(id)))
  }

  // ---------------- camera ----------------
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.camera.x) / this.camera.zoom, y: (sy - this.camera.y) / this.camera.zoom }
  }
  visibleWorldRect(): Rect {
    const a = this.screenToWorld(0, 0)
    return { x: a.x, y: a.y, w: this.viewport.w / this.camera.zoom, h: this.viewport.h / this.camera.zoom }
  }
  setZoom(zoom: number, sx = this.viewport.w / 2, sy = this.viewport.h / 2): void {
    zoom = Math.min(256, Math.max(0.01, zoom))
    const w = this.screenToWorld(sx, sy)
    this.camera.zoom = zoom
    this.camera.x = sx - w.x * zoom
    this.camera.y = sy - w.y * zoom
    this.emit('camera')
  }
  panBy(dx: number, dy: number): void {
    this.camera.x += dx
    this.camera.y += dy
    this.emit('camera')
  }
  zoomToRect(r: Rect | null, maxZoom = 1): void {
    if (!r) {
      this.camera = { x: this.viewport.w / 2, y: this.viewport.h / 2, zoom: 1 }
      this.emit('camera')
      return
    }
    const pad = 80
    const zoom = Math.min(maxZoom, (this.viewport.w - pad * 2) / Math.max(r.w, 1), (this.viewport.h - pad * 2) / Math.max(r.h, 1))
    this.camera.zoom = Math.max(0.01, zoom)
    this.camera.x = this.viewport.w / 2 - (r.x + r.w / 2) * this.camera.zoom
    this.camera.y = this.viewport.h / 2 - (r.y + r.h / 2) * this.camera.zoom
    this.emit('camera')
  }
  zoomToFit(): void {
    const top = this.children(null)
    this.zoomToRect(unionRects(top.map((id) => this.world(id))), 1)
  }

  // ---------------- transactions / undo ----------------
  begin(): void {
    if (this.txDepth++ === 0) {
      this.tx = {
        nodes: new Map(),
        pages: new Map(),
        selBefore: [...this.selection],
        selAfter: [],
        pageBefore: this.currentPageId,
        pageAfter: ''
      }
    }
  }
  commit(): void {
    if (--this.txDepth > 0) return
    const tx = this.tx!
    this.tx = null
    // keep groups fitted to their children
    const groups = new Set<string>()
    for (const [id, e] of tx.nodes) {
      const parents = [this.nodes.get(id)?.parentId, e.before?.parentId]
      for (let pid of parents) {
        while (pid) {
          const a = this.nodes.get(pid)
          if (!a) break
          if (a.type === 'GROUP') groups.add(a.id)
          pid = a.parentId
        }
      }
    }
    if (groups.size) {
      this.txDepth++
      this.tx = tx
      for (const g of [...groups].sort((a, b) => this.ancestors(b).length - this.ancestors(a).length)) this.fitGroup(g)
      this.tx = null
      this.txDepth--
    }
    // keep auto layout frames arranged and instances in step with their main components
    this.txDepth++
    this.tx = tx
    try {
      this.detachEditedStyles(tx)
      this.runAutoLayout(tx)
      if (this.runComponentSync(tx)) this.runAutoLayout(tx, false)
    } finally {
      this.tx = null
      this.txDepth--
      this.skipOverrides.clear()
    }
    for (const [id, e] of tx.nodes) e.after = this.nodes.has(id) ? clone(this.nodes.get(id)!) : null
    for (const [id, e] of tx.pages) e.after = this.pages.has(id) ? clone(this.pages.get(id)!) : null
    for (const [id, e] of tx.nodes) if (JSON.stringify(e.before) === JSON.stringify(e.after)) tx.nodes.delete(id)
    tx.selAfter = [...this.selection]
    tx.pageAfter = this.currentPageId
    if (tx.nodes.size || tx.pages.size) {
      this.undoStack.push(tx)
      if (this.undoStack.length > 300) this.undoStack.shift()
      this.redoStack = []
      for (const id of tx.nodes.keys()) this.pendingNodes.add(id)
      for (const id of tx.pages.keys()) this.pendingPages.add(id)
      this.scheduleFlush()
    }
    this.emit('doc')
  }
  /** set by the canvas while a drag is committed: layers dropped into an auto layout frame land where they were dropped */
  dropByPosition = false
  /** layers being dragged on the canvas right now (null = no drag) */
  dragIds: Set<string> | null = null

  /**
   * Arrange auto layout frames right now, inside the open transaction: the canvas calls this on every
   * step of a drag so the layout follows the pointer instead of jumping when the mouse is released.
   */
  layoutNow(): void {
    if (!this.tx || this.txDepth !== 1) return
    const was = this.dropByPosition
    this.dropByPosition = true
    try {
      this.runAutoLayout(this.tx)
    } finally {
      this.dropByPosition = was
    }
  }

  // ---------------- components ----------------
  /** nearest main component that contains the node (or is the node) */
  mainComponentOf(id: string | null | undefined): GNode | null {
    for (let n = id ? this.nodes.get(id) : undefined; n; n = n.parentId ? this.nodes.get(n.parentId) : undefined) if (n.isComponent) return n
    return null
  }
  /** the instance that contains the node (or is the node) */
  instanceOf(id: string | null | undefined): GNode | null {
    for (let n = id ? this.nodes.get(id) : undefined; n; n = n.parentId ? this.nodes.get(n.parentId) : undefined) if (n.componentId) return n
    return null
  }
  /** Add an instance of a main component (its layers are filled in when the transaction commits). */
  createInstance(mainId: string, parentId: string | null, x: number, y: number, order?: string): GNode {
    const main = this.nodes.get(mainId)!
    const { isComponent: _c, overrides: _o, sourceId: _s, ...rest } = clone(main)
    return this.addNode({ ...rest, id: uid(), parentId, pageId: this.currentPageId, order: order ?? this.orderKeyAtTop(parentId), x, y, componentId: mainId })
  }
  /** Turn instances into plain frames. */
  detachInstance(ids = this.selection): void {
    this.act(() => {
      for (const id of ids) {
        const inst = this.instanceOf(id)
        if (!inst) continue
        for (const d of [inst.id, ...this.descendants(inst.id)]) this.updateNode(d, { componentId: undefined, sourceId: undefined, overrides: undefined })
      }
    })
  }

  // ---------------- variants ----------------
  /** the component set (frame of variants) a main component sits in */
  componentSetOf(id: string | null | undefined): GNode | null {
    const n = id ? this.nodes.get(id) : undefined
    const p = n?.parentId ? this.nodes.get(n.parentId) : undefined
    return n?.isComponent && p?.isComponentSet ? p : null
  }
  /** the variants of a component set with their properties, in layer order */
  variantsOf(setId: string): { id: string; props: Record<string, string> }[] {
    const set = this.nodes.get(setId)
    if (!set) return []
    return this.children(setId, set.pageId)
      .filter((id) => this.nodes.get(id)!.isComponent)
      .map((id) => ({ id, props: parseVariant(this.nodes.get(id)!.name) }))
  }
  /**
   * Add a variant to a main component. The first variant turns the component into a component set
   * (a frame that holds the variants); variants are named "Property=Value, …" as in Figma.
   */
  addVariant(mainId: string): string | null {
    const main = this.nodes.get(mainId)
    if (!main?.isComponent) return null
    let created: string | null = null
    this.act(() => {
      let set = this.componentSetOf(mainId)
      if (!set) {
        const pad = 16
        set = this.addNode({
          type: 'FRAME',
          name: main.name,
          parentId: main.parentId,
          pageId: main.pageId,
          order: main.order,
          x: main.x - pad,
          y: main.y - pad,
          width: main.width + pad * 2,
          height: main.height + pad * 2,
          isComponentSet: true,
          clipsContent: false,
          cornerRadius: 5,
          // the set grows by itself as variants are added
          layoutMode: 'VERTICAL',
          itemSpacing: pad,
          paddingLeft: pad,
          paddingRight: pad,
          paddingTop: pad,
          paddingBottom: pad,
          primaryAxisSizingMode: 'AUTO',
          counterAxisSizingMode: 'AUTO'
        })
        this.updateNode(mainId, { parentId: set.id, x: pad, y: pad, order: keyBetween(null, null), name: 'Property 1=Default', layoutGrow: undefined, layoutAlign: undefined, layoutPositioning: undefined })
      }
      const variants = this.variantsOf(set.id)
      const props = { ...parseVariant(this.nodes.get(mainId)!.name) }
      const keys = Object.keys(props)
      const key = keys[keys.length - 1] ?? 'Property 1'
      // a value that no variant uses yet
      let n = variants.length + 1
      while (variants.some((v) => v.props[key] === 'Variant ' + n)) n++
      props[key] = 'Variant ' + n
      const kids = this.children(set.id, set.pageId)
      const copy = this.cloneSubtree(mainId, set.id, set.pageId, keyBetween(this.nodes.get(kids[kids.length - 1])!.order, null))
      this.updateNode(copy, { name: variantName(props) })
      created = copy
      this.selection = [copy]
    })
    this.emit('selection')
    return created
  }
  /** Point an instance at another main component (another variant); overrides are kept by layer name. */
  swapInstance(instId: string, mainId: string): void {
    const inst = this.nodes.get(instId)
    const main = this.nodes.get(mainId)
    if (!inst?.componentId || !main?.isComponent || inst.componentId === mainId) return
    const path = (id: string): string => {
      const names: string[] = []
      for (let n = this.nodes.get(id); n && n.id !== instId; n = n.parentId ? this.nodes.get(n.parentId) : undefined) names.unshift(n.name)
      return names.join('/')
    }
    this.act(() => {
      const kept = new Map<string, Partial<GNode>>()
      for (const d of this.descendants(instId)) {
        const n = this.nodes.get(d)!
        if (!n.overrides?.length) continue
        const patch: Record<string, unknown> = { overrides: [...n.overrides] }
        for (const k of n.overrides) patch[k] = clone(n[k as keyof GNode])
        kept.set(path(d), patch as Partial<GNode>)
      }
      for (const c of [...this.children(instId, inst.pageId)]) this.deleteNode(c)
      this.updateNode(instId, { componentId: mainId })
      this.noConstraints = true
      try {
        this.syncInstance(instId)
      } finally {
        this.noConstraints = false
      }
      if (kept.size)
        for (const d of this.descendants(instId)) {
          const patch = kept.get(path(d))
          if (patch) this.updateNode(d, patch)
        }
    })
  }
  /** layers whose changes in the current transaction must not be recorded as overrides */
  private skipOverrides = new Set<string>()

  /** Drop every override of an instance: it looks like its main component again. */
  resetInstance(instId: string): void {
    const inst = this.nodes.get(instId)
    if (!inst?.componentId) return
    this.act(() => {
      for (const d of [instId, ...this.descendants(instId)]) {
        // the values that come back from the main component are not new overrides
        this.skipOverrides.add(d)
        if (this.nodes.get(d)!.overrides) this.updateNode(d, { overrides: undefined })
      }
      this.noConstraints = true
      try {
        this.syncInstance(instId)
      } finally {
        this.noConstraints = false
      }
    })
  }

  /** Record overrides made on instances and push changes of main components to their instances. */
  private runComponentSync(tx: HistoryEntry): boolean {
    let dirty = new Set<string>()
    const fresh = new Set<string>()
    const mark = (id: string | null | undefined, into: Set<string>) => {
      for (let n = id ? this.nodes.get(id) : undefined; n; n = n.parentId ? this.nodes.get(n.parentId) : undefined) if (n.isComponent) into.add(n.id)
    }
    for (const [id, e] of [...tx.nodes]) {
      const n = this.nodes.get(id)
      const b = e.before
      mark(id, dirty)
      mark(b?.parentId, dirty)
      if (!n) continue
      // a new or re-linked instance needs its layers
      if (n.componentId && (!b || b.componentId !== n.componentId)) fresh.add(id)
      // edits made on an instance become overrides
      if (b && !this.skipOverrides.has(id) && (n.sourceId || n.componentId) && n.sourceId === b.sourceId && n.componentId === b.componentId) {
        const changed = OVERRIDABLE.filter((k) => !n.overrides?.includes(k) && JSON.stringify(n[k]) !== JSON.stringify(b[k]))
        if (changed.length) this.updateNode(id, { overrides: [...(n.overrides ?? []), ...changed] })
      }
    }
    if (!dirty.size && !fresh.size) return false
    let any = false
    // sizes copied from the main component are not a resize: constraints stay out of it
    this.noConstraints = true
    try {
      any = this.syncAll(fresh, dirty, mark)
    } finally {
      this.noConstraints = false
    }
    return any
  }

  private syncAll(fresh: Set<string>, dirty: Set<string>, mark: (id: string | null | undefined, into: Set<string>) => void): boolean {
    let any = false
    for (const id of fresh) any = this.syncInstance(id) || any
    for (let round = 0; round < 6 && dirty.size; round++) {
      const next = new Set<string>()
      for (const n of [...this.nodes.values()]) {
        if (!n.componentId || !dirty.has(n.componentId) || !this.nodes.has(n.id)) continue
        if (this.syncInstance(n.id)) {
          any = true
          // an instance that lives inside another main component changes that component too
          mark(n.parentId, next)
        }
      }
      dirty = next
    }
    return any
  }

  /** Make the layers of an instance mirror its main component, keeping overrides. Returns true when something changed. */
  private syncInstance(instId: string): boolean {
    const inst = this.nodes.get(instId)
    const main = inst?.componentId ? this.nodes.get(inst.componentId) : undefined
    if (!inst || !main || !main.isComponent || this.isAncestor(main.id, instId)) return false
    let changed = false
    const copyProps = (t: GNode, src: GNode, root: boolean) => {
      const patch: Record<string, unknown> = {}
      for (const k of new Set([...Object.keys(src), ...Object.keys(t)]) as Set<keyof GNode>) {
        if (INSTANCE_OWN.has(k) || t.overrides?.includes(k)) continue
        if (root && ROOT_OWN.has(k)) continue
        if (JSON.stringify(src[k]) !== JSON.stringify(t[k])) patch[k] = src[k] === undefined ? undefined : clone(src[k])
      }
      // a nested instance is mirrored as plain layers: its own main keeps the original in step
      if (!root && t.componentId) patch.componentId = undefined
      if (Object.keys(patch).length) {
        this.updateNode(t.id, patch as Partial<GNode>)
        changed = true
      }
    }
    copyProps(inst, main, true)
    const mirror = new Map<string, GNode>()
    for (const d of this.descendants(instId)) {
      const n = this.nodes.get(d)!
      if (n.sourceId) mirror.set(n.sourceId, n)
    }
    const seen = new Set<string>()
    const walk = (srcParent: string, dstParent: string) => {
      for (const c of this.children(srcParent, main.pageId)) {
        const src = this.nodes.get(c)!
        let t = mirror.get(c)
        if (!t) {
          const { isComponent: _c, componentId: _i, overrides: _o, ...rest } = clone(src)
          t = this.addNode({ ...rest, id: uid(), parentId: dstParent, pageId: inst.pageId, sourceId: c })
          changed = true
        } else {
          if (t.parentId !== dstParent || t.order !== src.order || t.pageId !== inst.pageId) {
            this.updateNode(t.id, { parentId: dstParent, order: src.order, pageId: inst.pageId })
            changed = true
          }
          copyProps(t, src, false)
        }
        seen.add(t.id)
        walk(c, t.id)
      }
    }
    walk(main.id, instId)
    for (const n of mirror.values())
      if (!seen.has(n.id) && this.nodes.has(n.id)) {
        this.deleteNode(n.id)
        changed = true
      }
    return changed
  }

  private runAutoLayout(tx: HistoryEntry, intent = true): void {
    const frames = new Set<string>()
    const moved = new Map<string, Set<string>>()
    const addChain = (pid: string | null | undefined) => {
      while (pid) {
        const a = this.nodes.get(pid)
        if (!a) break
        if (isAutoLayout(a)) frames.add(a.id)
        pid = a.parentId
      }
    }
    for (const [id, e] of [...tx.nodes]) {
      const n = this.nodes.get(id)
      const b = e.before
      addChain(id)
      addChain(b?.parentId)
      // the checks below read the user's intent; they are skipped when re-running after a component sync
      if (!n || !b || !intent) continue
      const dw = Math.abs(n.width - b.width) > 0.01
      const dh = Math.abs(n.height - b.height) > 0.01
      const p = n.parentId ? this.nodes.get(n.parentId) : undefined
      if (isAutoLayout(p) && inFlow(n)) {
        const horiz = p.layoutMode === 'HORIZONTAL'
        if (n.parentId === b.parentId) {
          // resized by hand: the layer stops filling the frame on that axis
          const patch: Partial<GNode> = {}
          if ((horiz ? dw : dh) && n.layoutGrow && b.layoutGrow === n.layoutGrow) patch.layoutGrow = 0
          if ((horiz ? dh : dw) && n.layoutAlign === 'STRETCH' && b.layoutAlign === 'STRETCH') patch.layoutAlign = 'INHERIT'
          if (Object.keys(patch).length) this.updateNode(id, patch)
          // during a drag only the dragged layers count as moved: their neighbours were shifted by the layout itself
          const isMoved = this.dragIds ? this.dragIds.has(id) : !dw && !dh && (n.x !== b.x || n.y !== b.y) && inFlow(b)
          if (isMoved) (moved.get(p.id) ?? moved.set(p.id, new Set()).get(p.id)!).add(id)
        } else if (this.dragIds ? this.dragIds.has(id) : this.dropByPosition) (moved.get(p.id) ?? moved.set(p.id, new Set()).get(p.id)!).add(id)
      }
      // frame resized by hand: it stops hugging on that axis
      if (isAutoLayout(n) && isAutoLayout(b) && n.layoutMode === b.layoutMode) {
        const horiz = n.layoutMode === 'HORIZONTAL'
        const patch: Partial<GNode> = {}
        if ((horiz ? dw : dh) && n.primaryAxisSizingMode === 'AUTO' && b.primaryAxisSizingMode === 'AUTO') patch.primaryAxisSizingMode = 'FIXED'
        if ((horiz ? dh : dw) && n.counterAxisSizingMode === 'AUTO' && b.counterAxisSizingMode === 'AUTO') patch.counterAxisSizingMode = 'FIXED'
        if (Object.keys(patch).length) this.updateNode(id, patch)
      }
    }
    if (!frames.size) return
    const order = [...frames].filter((id) => this.nodes.has(id)).sort((a, b) => this.ancestors(b).length - this.ancestors(a).length)
    // bottom-up for hugging, repeated because filling children are sized top-down
    for (let pass = 0; pass < 3; pass++) {
      let changed = false
      for (const id of order) changed = this.layoutFrame(id, pass === 0 ? moved.get(id) : undefined) || changed
      if (!changed) break
    }
  }

  /** arrange one auto layout frame; returns true when something changed */
  private layoutFrame(fid: string, moved?: Set<string>): boolean {
    const f = this.nodes.get(fid)
    if (!isAutoLayout(f)) return false
    const horiz = f.layoutMode === 'HORIZONTAL'
    let changed = false
    if (moved?.size) {
      // dragged layers take the slot they were dropped on
      const flow = this.children(fid, f.pageId).map((id) => this.nodes.get(id)!).filter(inFlow)
      const center = (k: GNode) => (horiz ? k.x + k.width / 2 : k.y + k.height / 2)
      let sorted: GNode[]
      if (f.layoutWrap === 'WRAP') {
        // several lines: a dragged layer goes next to the item it was dropped closest to
        sorted = flow.filter((k) => !moved.has(k.id))
        const cross = (k: GNode) => (horiz ? k.y + k.height / 2 : k.x + k.width / 2)
        const lineOf = (k: GNode) => Math.round(horiz ? k.y : k.x)
        for (const m of flow.filter((k) => moved.has(k.id))) {
          if (!sorted.length) {
            sorted.push(m)
            continue
          }
          // first the line the layer is over, then its place among the items of that line
          let line = lineOf(sorted[0])
          let bestD = Infinity
          for (const k of sorted) {
            const d = Math.abs(cross(k) - cross(m))
            if (d < bestD) {
              bestD = d
              line = lineOf(k)
            }
          }
          const inLine = sorted.map((k, i) => ({ k, i })).filter((x) => lineOf(x.k) === line)
          const next = inLine.find((x) => center(x.k) > center(m))
          sorted.splice(next ? next.i : inLine[inLine.length - 1].i + 1, 0, m)
        }
      } else sorted = [...flow].sort((a, b) => center(a) - center(b))
      if (sorted.some((k, i) => k.id !== flow[i].id)) {
        const keys = flow.map((k) => k.order)
        sorted.forEach((k, i) => k.order !== keys[i] && this.updateNode(k.id, { order: keys[i] }))
        changed = true
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      const kids = this.children(fid, f.pageId).map((id) => this.nodes.get(id)!)
      const r = computeLayout(f, kids)
      let textResized = false
      for (const [id, b] of r.children) {
        const k = this.nodes.get(id)!
        const patch: Partial<GNode> = {}
        if (Math.abs(k.x - b.x) > 0.01) patch.x = b.x
        if (Math.abs(k.y - b.y) > 0.01) patch.y = b.y
        if (Math.abs(k.width - b.width) > 0.01) patch.width = b.width
        if (Math.abs(k.height - b.height) > 0.01) patch.height = b.height
        if (!Object.keys(patch).length) continue
        if (k.type === 'TEXT' && ('width' in patch || 'height' in patch)) {
          // text sized by the layout can no longer size itself on that axis
          const mode = k.textAutoResize ?? 'WIDTH_AND_HEIGHT'
          if ('height' in patch && (horiz ? k.layoutAlign === 'STRETCH' : (k.layoutGrow ?? 0) > 0)) patch.textAutoResize = 'NONE'
          else if ('width' in patch && mode === 'WIDTH_AND_HEIGHT') patch.textAutoResize = 'HEIGHT'
          else if ('height' in patch && !('width' in patch)) delete patch.height
          textResized = true
        }
        if (!Object.keys(patch).length) continue
        this.updateNode(id, patch)
        changed = true
      }
      if (Math.abs(f.width - r.frame.width) > 0.01 || Math.abs(f.height - r.frame.height) > 0.01) {
        this.updateNode(fid, { width: r.frame.width, height: r.frame.height })
        changed = true
      }
      if (!textResized) break
    }
    return changed
  }

  /** run fn inside a transaction */
  act<T>(fn: () => T): T {
    this.begin()
    try {
      return fn()
    } finally {
      this.commit()
    }
  }
  private touch(id: string): void {
    if (!this.tx) throw new Error('mutation outside transaction')
    if (!this.tx.nodes.has(id)) {
      const n = this.nodes.get(id)
      this.tx.nodes.set(id, { before: n ? clone(n) : null, after: null })
    }
  }
  private touchPage(id: string): void {
    if (!this.tx) throw new Error('mutation outside transaction')
    if (!this.tx.pages.has(id)) {
      const p = this.pages.get(id)
      this.tx.pages.set(id, { before: p ? clone(p) : null, after: null })
    }
  }
  undo(): void {
    const e = this.undoStack.pop()
    if (!e) return
    this.applyHistory(e, 'before')
    this.redoStack.push(e)
  }
  redo(): void {
    const e = this.redoStack.pop()
    if (!e) return
    this.applyHistory(e, 'after')
    this.undoStack.push(e)
  }
  private applyHistory(e: HistoryEntry, side: 'before' | 'after'): void {
    for (const [id, v] of e.pages) {
      const p = v[side]
      if (p) this.pages.set(id, clone(p))
      else this.pages.delete(id)
      this.pendingPages.add(id)
    }
    for (const [id, v] of e.nodes) {
      const old = this.nodes.get(id)
      if (old) this.unlinkChild(old)
      const n = v[side]
      if (n) {
        this.nodes.set(id, clone(n))
        this.linkChild(this.nodes.get(id)!)
      } else this.nodes.delete(id)
      this.pendingNodes.add(id)
    }
    this.invalidateAllGeometry()
    const page = side === 'before' ? e.pageBefore : e.pageAfter
    if (this.pages.has(page)) this.currentPageId = page
    else if (!this.pages.has(this.currentPageId)) this.currentPageId = this.sortedPages()[0].id
    this.selection = (side === 'before' ? e.selBefore : e.selAfter).filter((id) => this.nodes.has(id))
    this.scheduleFlush()
    this.emit('doc', 'pages', 'selection')
  }

  // ---------------- persistence ----------------
  private scheduleFlush(): void {
    if (this.flushTimer !== null) return
    this.flushTimer = window.setTimeout(() => this.flush(), 250)
  }
  async flush(): Promise<void> {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (!this.pendingNodes.size && !this.pendingPages.size && !this.pendingMeta) return
    const upsertNodes: GNode[] = []
    const deleteNodes: string[] = []
    for (const id of this.pendingNodes) {
      const n = this.nodes.get(id)
      if (n) upsertNodes.push(n)
      else deleteNodes.push(id)
    }
    const upsertPages: Page[] = []
    const deletePages: string[] = []
    for (const id of this.pendingPages) {
      const p = this.pages.get(id)
      if (p) upsertPages.push(p)
      else deletePages.push(id)
    }
    const meta = this.pendingMeta ?? undefined
    this.pendingNodes.clear()
    this.pendingPages.clear()
    this.pendingMeta = null
    try {
      await backend.doc.apply({ upsertNodes, deleteNodes, upsertPages, deletePages, meta })
    } catch (err) {
      this.showToast('Save failed: ' + (err as Error).message)
    }
  }
  rename(name: string): void {
    this.meta = { ...this.meta, name }
    this.pendingMeta = { ...(this.pendingMeta ?? {}), name }
    this.scheduleFlush()
    this.emit('pages')
  }
  /** Saved color styles live in the document file. */
  setColorStyles(colorStyles: NonNullable<DocMeta['colorStyles']>): void {
    this.meta = { ...this.meta, colorStyles }
    this.pendingMeta = { ...(this.pendingMeta ?? {}), colorStyles }
    this.scheduleFlush()
    this.emit('doc')
  }

  setTextStyles(textStyles: NonNullable<DocMeta['textStyles']>): void {
    this.meta = { ...this.meta, textStyles }
    this.pendingMeta = { ...(this.pendingMeta ?? {}), textStyles }
    this.scheduleFlush()
    this.emit('doc')
  }

  // ---------------- linked styles ----------------
  /** true while a style is being pushed to its layers (that is not a manual edit, so the link stays) */
  private applyingStyle = false

  /** Change a colour style; every layer linked to it is repainted. */
  updateColorStyle(id: string, patch: { name?: string; color?: RGBA }): void {
    const styles = (this.meta.colorStyles ?? []).map((s) => (s.id === id ? { ...s, ...patch } : s))
    const style = styles.find((s) => s.id === id)
    if (!style) return
    this.setColorStyles(styles)
    if (!patch.color) return
    this.applyingStyle = true
    try {
      this.act(() => {
        for (const n of [...this.nodes.values()]) {
          if (n.fillStyleId === id) {
            // the style drives the top solid fill; other fills (images, gradients) stay
            const top = [...n.fills].reverse().find((f) => f.type === 'SOLID')
            this.updateNode(n.id, { fills: top ? n.fills.map((f) => (f === top ? { ...f, color: { ...style.color } } : f)) : [...n.fills, { type: 'SOLID', color: { ...style.color } }] })
          }
          if (n.strokeStyleId === id && n.strokes.length) this.updateNode(n.id, { strokes: n.strokes.map((s, i) => (i === 0 ? { ...s, color: { ...style.color } } : s)) })
        }
      })
    } finally {
      this.applyingStyle = false
    }
  }

  /** Change a text style; every text layer linked to it follows. */
  updateTextStyle(id: string, patch: { name?: string; style?: NonNullable<GNode['textStyle']> }): void {
    const styles = (this.meta.textStyles ?? []).map((s) => (s.id === id ? { ...s, ...patch } : s))
    const style = styles.find((s) => s.id === id)
    if (!style) return
    this.setTextStyles(styles)
    if (!patch.style) return
    this.applyingStyle = true
    try {
      this.act(() => {
        for (const n of [...this.nodes.values()]) if (n.textStyleId === id && n.type === 'TEXT') this.updateNode(n.id, { textStyle: clone(style.style) })
      })
    } finally {
      this.applyingStyle = false
    }
  }

  /** Delete a style: its layers keep their look and lose the link. */
  deleteStyle(kind: 'color' | 'text', id: string): void {
    this.applyingStyle = true
    try {
      this.act(() => {
        for (const n of [...this.nodes.values()]) {
          if (kind === 'color' && (n.fillStyleId === id || n.strokeStyleId === id)) this.updateNode(n.id, { fillStyleId: n.fillStyleId === id ? undefined : n.fillStyleId, strokeStyleId: n.strokeStyleId === id ? undefined : n.strokeStyleId })
          if (kind === 'text' && n.textStyleId === id) this.updateNode(n.id, { textStyleId: undefined })
        }
      })
    } finally {
      this.applyingStyle = false
    }
    if (kind === 'color') this.setColorStyles((this.meta.colorStyles ?? []).filter((s) => s.id !== id))
    else this.setTextStyles((this.meta.textStyles ?? []).filter((s) => s.id !== id))
  }

  /** A layer edited by hand no longer follows its style (Figma detaches the style the same way). */
  private detachEditedStyles(tx: HistoryEntry): void {
    if (this.applyingStyle) return
    for (const [id, e] of [...tx.nodes]) {
      const n = this.nodes.get(id)
      const b = e.before
      if (!n || !b) continue
      const patch: Partial<GNode> = {}
      const topColor = (x: GNode) => JSON.stringify([...x.fills].reverse().find((f) => f.type === 'SOLID') ?? null)
      if (n.fillStyleId && n.fillStyleId === b.fillStyleId && topColor(n) !== topColor(b)) patch.fillStyleId = undefined
      if (n.strokeStyleId && n.strokeStyleId === b.strokeStyleId && JSON.stringify(n.strokes[0]?.color) !== JSON.stringify(b.strokes[0]?.color)) patch.strokeStyleId = undefined
      if (n.textStyleId && n.textStyleId === b.textStyleId && JSON.stringify(n.textStyle) !== JSON.stringify(b.textStyle)) patch.textStyleId = undefined
      if (Object.keys(patch).length) this.updateNode(id, patch)
    }
  }

  // ---------------- mutations (call inside act/begin) ----------------
  addNode(partial: Partial<GNode> & { type: GNode['type'] }): GNode {
    const pageId = partial.pageId ?? this.currentPageId
    const parentId = partial.parentId ?? null
    const n: GNode = {
      id: uid(),
      name: partial.name ?? defaultName(partial.type),
      parentId,
      pageId,
      order: partial.order ?? this.orderKeyAtTop(parentId, pageId),
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      opacity: 1,
      visible: true,
      locked: false,
      fills: [],
      strokes: [],
      ...partial
    } as GNode
    if (n.type === 'TEXT') {
      n.textStyle = { ...DEFAULT_TEXT_STYLE, ...(n.textStyle ?? {}) }
      n.characters ??= ''
      const s = fitText(n)
      n.width = s.width
      n.height = s.height
    }
    this.touch(n.id)
    this.nodes.set(n.id, n)
    this.linkChild(n)
    this.invalidateGeometry(n.id)
    return n
  }

  updateNode(id: string, patch: Partial<GNode>): void {
    const n = this.nodes.get(id)
    if (!n) return
    this.touch(id)
    const reparent = ('parentId' in patch && patch.parentId !== n.parentId) || ('pageId' in patch && patch.pageId !== n.pageId)
    const reorder = 'order' in patch && patch.order !== n.order
    if (reparent || reorder) this.unlinkChild(n)
    const oldW = n.width
    const oldH = n.height
    Object.assign(n, patch)
    // a resized frame carries its children along according to their constraints
    if (n.type === 'FRAME' && !this.noConstraints && ('width' in patch || 'height' in patch) && (n.width !== oldW || n.height !== oldH)) this.applyConstraints(n, oldW, oldH)
    if (n.type === 'TEXT' && ('characters' in patch || 'textStyle' in patch || 'width' in patch || 'textAutoResize' in patch)) {
      const s = fitText(n)
      n.width = s.width
      n.height = s.height
    }
    if (reparent || reorder) this.linkChild(n)
    if (reparent && 'pageId' in patch) for (const d of this.descendants(id)) this.updateNode(d, { pageId: n.pageId })
    if (reparent || 'x' in patch || 'y' in patch || 'width' in patch || 'height' in patch || 'rotation' in patch || 'flipX' in patch || 'flipY' in patch || n.type === 'TEXT')
      this.invalidateGeometry(id)
  }

  /** set while sizes are written by the app itself (auto layout, component sync), not by a resize */
  private noConstraints = false

  /** Figma constraints: move / resize the children of a frame that went from oldW × oldH to its current size. */
  private applyConstraints(f: GNode, oldW: number, oldH: number): void {
    if (oldW <= 0 || oldH <= 0) return
    const auto = isAutoLayout(f)
    const axis = (c: Constraint, pos: number, size: number, was: number, now: number): [number, number] => {
      const d = now - was
      if (c === 'MAX') return [pos + d, size]
      if (c === 'CENTER') return [pos + d / 2, size]
      if (c === 'STRETCH') return [pos, Math.max(1, size + d)]
      if (c === 'SCALE') return [(pos * now) / was, Math.max(1, (size * now) / was)]
      return [pos, size]
    }
    for (const id of [...this.children(f.id, f.pageId)]) {
      const k = this.nodes.get(id)!
      // children arranged by auto layout have no constraints; absolute ones do
      if (auto && inFlow(k)) continue
      const c = k.constraints
      if (!c || (c.horizontal === 'MIN' && c.vertical === 'MIN')) continue
      const [x, w] = axis(c.horizontal, k.x, k.width, oldW, f.width)
      const [y, h] = axis(c.vertical, k.y, k.height, oldH, f.height)
      if (w !== k.width || h !== k.height) {
        // setWorldRect scales the content of groups and converts auto-width text to fixed width
        const pw = this.world(f.id)
        this.setWorldRect(id, { x: pw.x + x, y: pw.y + y, w, h })
      } else if (x !== k.x || y !== k.y) this.updateNode(id, { x, y })
    }
  }

  deleteNode(id: string): void {
    const n = this.nodes.get(id)
    if (!n) return
    for (const c of [...this.children(id, n.pageId)]) this.deleteNode(c)
    this.touch(id)
    this.unlinkChild(n)
    this.nodes.delete(id)
    const it = this.treeItems.get(id)
    if (it) {
      this.tree.remove(it)
      this.treeItems.delete(id)
    }
    this.worldCache.delete(id)
  }

  /** Move node to a new parent keeping its world position. */
  reparent(id: string, parentId: string | null, order?: string): void {
    const n = this.nodes.get(id)!
    const w = this.world(id)
    const pw = parentId ? this.world(parentId) : { x: 0, y: 0 }
    this.updateNode(id, { parentId, x: w.x - pw.x, y: w.y - pw.y, order: order ?? this.orderKeyAtTop(parentId, n.pageId) })
  }

  /** Move a node by a world-space delta. */
  moveBy(id: string, dx: number, dy: number): void {
    const n = this.nodes.get(id)!
    this.updateNode(id, { x: n.x + dx, y: n.y + dy })
  }

  /** Set world rect (handles group scaling of children). */
  setWorldRect(id: string, r: Rect): void {
    const n = this.nodes.get(id)!
    const old = this.world(id)
    const pw = n.parentId ? this.world(n.parentId) : { x: 0, y: 0 }
    const w = Math.max(r.w, 0.01)
    const h = Math.max(r.h, 0.01)
    if (n.type === 'GROUP' && old.w > 0 && old.h > 0) {
      const sx = w / old.w
      const sy = h / old.h
      for (const c of this.children(id, n.pageId)) {
        const cw = this.world(c)
        this.setWorldRect(c, { x: r.x + (cw.x - old.x) * sx, y: r.y + (cw.y - old.y) * sy, w: cw.w * sx, h: cw.h * sy })
      }
    }
    const patch: Partial<GNode> = { x: r.x - pw.x, y: r.y - pw.y, width: w, height: h }
    if (n.type === 'TEXT' && (n.textAutoResize ?? 'WIDTH_AND_HEIGHT') === 'WIDTH_AND_HEIGHT' && Math.abs(w - old.w) > 0.5) patch.textAutoResize = 'HEIGHT'
    this.updateNode(id, patch)
  }

  fitGroup(id: string): void {
    const g = this.nodes.get(id)
    if (!g || g.type !== 'GROUP') return
    const kids = this.children(id, g.pageId)
    if (!kids.length) {
      this.deleteNode(id)
      return
    }
    const ub = unionRects(kids.map((c) => {
      const k = this.nodes.get(c)!
      return { x: k.x, y: k.y, w: k.width, h: k.height }
    }))!
    if (Math.abs(ub.x) < 1e-6 && Math.abs(ub.y) < 1e-6 && ub.w === g.width && ub.h === g.height) return
    for (const c of kids) {
      const k = this.nodes.get(c)!
      this.updateNode(c, { x: k.x - ub.x, y: k.y - ub.y })
    }
    this.updateNode(id, { x: g.x + ub.x, y: g.y + ub.y, width: ub.w, height: ub.h })
  }

  // ---------------- higher-level operations ----------------
  setSelection(ids: string[]): void {
    this.selection = ids.filter((id) => this.nodes.has(id))
    this.emit('selection')
  }
  setTool(t: Tool): void {
    this.tool = t
    this.emit('ui')
  }
  setCurrentPage(id: string): void {
    if (!this.pages.has(id) || id === this.currentPageId) return
    this.currentPageId = id
    this.selection = []
    this.invalidateAllGeometry()
    this.zoomToFit()
    this.emit('pages', 'doc', 'selection')
  }
  addPage(name?: string): Page {
    return this.act(() => {
      const pages = this.sortedPages()
      const p: Page = {
        id: uid(),
        name: name ?? `Page ${pages.length + 1}`,
        order: keyBetween(pages.length ? pages[pages.length - 1].order : null, null),
        background: { ...DEFAULT_PAGE_BG }
      }
      this.touchPage(p.id)
      this.pages.set(p.id, p)
      this.currentPageId = p.id
      this.selection = []
      this.invalidateAllGeometry()
      this.emit('pages')
      return p
    })
  }
  updatePage(id: string, patch: Partial<Page>): void {
    this.act(() => {
      this.touchPage(id)
      Object.assign(this.pages.get(id)!, patch)
    })
    this.emit('pages')
  }
  deletePage(id: string): void {
    if (this.pages.size <= 1) return
    this.act(() => {
      for (const n of [...this.nodes.values()]) if (n.pageId === id && !n.parentId) this.deleteNode(n.id)
      this.touchPage(id)
      this.pages.delete(id)
      if (this.currentPageId === id) this.currentPageId = this.sortedPages()[0].id
      this.selection = []
      this.invalidateAllGeometry()
    })
    this.emit('pages', 'selection')
  }
  /** Add pages + nodes (e.g. imported from another .gigma) */
  importPages(pages: Page[], nodes: GNode[]): void {
    this.act(() => {
      let last = this.sortedPages().at(-1)?.order ?? null
      for (const p of pages.sort((a, b) => (a.order < b.order ? -1 : 1))) {
        last = keyBetween(last, null)
        this.touchPage(p.id)
        this.pages.set(p.id, { ...p, order: last })
      }
      for (const n of nodes) {
        this.touch(n.id)
        this.nodes.set(n.id, n)
        this.linkChild(n)
      }
      this.invalidateAllGeometry()
      if (pages[0]) this.currentPageId = pages[0].id
    })
    this.emit('pages', 'doc')
    this.zoomToFit()
  }

  deleteSelection(): void {
    if (!this.selection.length) return
    this.act(() => {
      for (const id of this.selection) this.deleteNode(id)
      this.selection = []
    })
    this.emit('selection')
  }

  /** Top-most selectable roots among ids (drops ids whose ancestor is also present). */
  roots(ids: string[]): string[] {
    const set = new Set(ids)
    return ids.filter((id) => !this.ancestors(id).some((a) => set.has(a.id)))
  }

  group(ids = this.selection, name = 'Group'): string | null {
    const roots = this.roots(ids).filter((id) => this.nodes.has(id))
    if (!roots.length) return null
    const first = this.nodes.get(roots[0])!
    const parentId = first.parentId
    const sameParent = roots.every((id) => this.nodes.get(id)!.parentId === parentId)
    const target = sameParent ? parentId : null
    const b = this.selectionBounds(roots)!
    const pw = target ? this.world(target) : { x: 0, y: 0 }
    const sorted = [...roots].sort((a, c) => (this.paintOrderKey(a) < this.paintOrderKey(c) ? -1 : 1))
    let gid = ''
    this.act(() => {
      const topId = sorted[sorted.length - 1]
      const sib = this.children(target, first.pageId)
      const ti = sib.indexOf(topId)
      const order = sameParent
        ? keyBetween(this.nodes.get(topId)!.order, ti + 1 < sib.length ? this.nodes.get(sib[ti + 1])!.order : null)
        : undefined
      const g = this.addNode({ type: 'GROUP', name, parentId: target, x: b.x - pw.x, y: b.y - pw.y, width: b.w, height: b.h, order })
      gid = g.id
      let prev: string | null = null
      for (const id of sorted) {
        prev = keyBetween(prev, null)
        this.reparent(id, g.id, prev)
      }
      this.selection = [g.id]
    })
    this.emit('selection')
    return gid
  }

  ungroup(): void {
    const groups = this.selection.map((id) => this.nodes.get(id)!).filter((n) => n && (n.type === 'GROUP' || n.type === 'FRAME' || n.type === 'SECTION'))
    if (!groups.length) return
    const newSel: string[] = []
    this.act(() => {
      for (const g of groups) {
        const kids = [...this.children(g.id, g.pageId)]
        const siblings = this.children(g.parentId, g.pageId)
        const idx = siblings.indexOf(g.id)
        let lo = g.order
        const hi = idx + 1 < siblings.length ? this.nodes.get(siblings[idx + 1])!.order : null
        for (const k of kids) {
          lo = keyBetween(lo, hi)
          this.reparent(k, g.parentId, lo)
          newSel.push(k)
        }
        this.deleteNode(g.id)
      }
      this.selection = newSel
    })
    this.emit('selection')
  }

  /** z-order: bring forward (+1) / send backward (-1) / front (+Inf) / back (-Inf) */
  reorder(dir: number): void {
    this.act(() => {
      for (const id of this.selection) {
        const n = this.nodes.get(id)!
        const sib = this.children(n.parentId, n.pageId)
        const i = sib.indexOf(id)
        const order = (k: number) => (k >= 0 && k < sib.length ? this.nodes.get(sib[k])!.order : null)
        let key: string | null = null
        if (dir === Infinity && i < sib.length - 1) key = keyBetween(order(sib.length - 1), null)
        else if (dir === -Infinity && i > 0) key = keyBetween(null, order(0))
        else if (dir === 1 && i < sib.length - 1) key = keyBetween(order(i + 1), order(i + 2))
        else if (dir === -1 && i > 0) key = keyBetween(order(i - 2), order(i - 1))
        if (key) this.updateNode(id, { order: key })
      }
    })
  }

  /** Global paint-order key for sorting arbitrary nodes on a page. */
  paintOrderKey(id: string): string {
    const chain = [this.nodes.get(id)!, ...this.ancestors(id)].reverse()
    return chain.map((n) => n.order.padEnd(24, '0')).join('/')
  }

  duplicate(ids = this.selection, offset = 0): string[] {
    const out: string[] = []
    this.act(() => {
      for (const id of this.roots(ids)) {
        const n = this.nodes.get(id)!
        // inside a component set a copy is a new variant
        if (this.componentSetOf(id)) {
          const v = this.addVariant(id)
          if (v) out.push(v)
          continue
        }
        // a copy of a main component is an instance of it, as in Figma
        const copy = n.isComponent ? this.createInstance(id, n.parentId, n.x, n.y).id : this.cloneSubtree(id, n.parentId, n.pageId)
        if (offset) this.moveBy(copy, offset, offset)
        out.push(copy)
      }
      this.selection = out
    })
    this.emit('selection')
    return out
  }

  cloneSubtree(id: string, parentId: string | null, pageId: string, order?: string): string {
    const src = this.nodes.get(id)!
    const n = this.addNode({ ...clone(src), id: uid(), parentId, pageId, order: order ?? this.orderKeyAtTop(parentId, pageId) })
    let prev: string | null = null
    for (const c of this.children(id, src.pageId)) {
      prev = keyBetween(prev, null)
      this.cloneSubtree(c, n.id, pageId, prev)
    }
    return n.id
  }

  /** Serializable subtree for clipboard / export (world coords for roots). */
  serialize(ids: string[]): GNode[] {
    const out: GNode[] = []
    for (const id of this.roots(ids)) {
      const w = this.world(id)
      out.push({ ...clone(this.nodes.get(id)!), x: w.x, y: w.y, parentId: null })
      for (const d of this.descendants(id)) out.push(clone(this.nodes.get(d)!))
    }
    return out
  }

  /** Paste serialized nodes; returns new root ids. */
  pasteNodes(nodes: GNode[], parentId: string | null, at?: { x: number; y: number }): string[] {
    const idMap = new Map<string, string>()
    for (const n of nodes) idMap.set(n.id, uid())
    const roots = nodes.filter((n) => !n.parentId || !idMap.has(n.parentId))
    const rb = unionRects(roots.map((n) => ({ x: n.x, y: n.y, w: n.width, h: n.height })))!
    const pw = parentId ? this.world(parentId) : { x: 0, y: 0 }
    const dx = at ? at.x - (rb.x + rb.w / 2) : 0
    const dy = at ? at.y - (rb.y + rb.h / 2) : 0
    const out: string[] = []
    // pasting a main component that lives in this document gives an instance of it
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const asInstance = new Set<string>()
    for (const n of nodes) {
      if (!n.isComponent || !this.nodes.get(n.id)?.isComponent) continue
      asInstance.add(n.id)
    }
    const inInstance = (n: GNode): boolean => {
      for (let p = n.parentId ? byId.get(n.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) if (asInstance.has(p.id)) return true
      return false
    }
    this.act(() => {
      for (const n of nodes) {
        const isRoot = !n.parentId || !idMap.has(n.parentId)
        const copy: GNode = {
          ...clone(n),
          id: idMap.get(n.id)!,
          pageId: this.currentPageId,
          parentId: isRoot ? parentId : idMap.get(n.parentId!)!,
          order: isRoot ? this.orderKeyAtTop(parentId) : n.order
        }
        if (asInstance.has(n.id)) {
          copy.isComponent = undefined
          copy.componentId = n.id
        } else if (inInstance(n)) {
          copy.sourceId = n.id
          copy.isComponent = undefined
          copy.componentId = undefined
        }
        if (isRoot) {
          copy.x = n.x + dx - pw.x
          copy.y = n.y + dy - pw.y
          out.push(copy.id)
        }
        this.touch(copy.id)
        this.nodes.set(copy.id, copy)
        this.linkChild(copy)
        this.invalidateGeometry(copy.id)
      }
      this.selection = out
    })
    this.emit('selection')
    return out
  }

  /** Topmost frame at world point (for dropping / creating inside frames). */
  frameAt(x: number, y: number, exclude: Set<string> = new Set()): string | null {
    const cands = this.query({ x, y, w: 0.001, h: 0.001 })
      .map((id) => this.nodes.get(id)!)
      .filter((n) => (n.type === 'FRAME' || n.type === 'SECTION') && n.visible && !exclude.has(n.id) && ![...exclude].some((e) => this.isAncestor(e, n.id)))
      .filter((n) => this.isVisibleThroughClips(n.id, x, y))
    if (!cands.length) return null
    cands.sort((a, b) => (this.paintOrderKey(a.id) < this.paintOrderKey(b.id) ? 1 : -1))
    return cands[0].id
  }

  isVisibleThroughClips(id: string, x: number, y: number): boolean {
    for (const a of this.ancestors(id)) {
      if (!a.visible) return false
      if (a.type === 'FRAME' && a.clipsContent !== false) {
        if (!this.containsPoint(a.id, x, y)) return false
      }
    }
    return true
  }

  /**
   * Hit test like Figma: returns the node to select at a world point.
   * Groups are selected as a whole; frames let you click straight to their children.
   * With deep=true (Ctrl/Cmd+click) returns the deepest leaf.
   */
  hitTest(x: number, y: number, deep = false): string | null {
    const tol = 2 / this.camera.zoom
    const cands = this.query({ x: x - tol, y: y - tol, w: tol * 2, h: tol * 2 })
      .map((id) => this.nodes.get(id)!)
      // slices are transparent export areas: select them from the layers panel, clicks go through
      .filter((n) => n.type !== 'ANNOTATION' && n.type !== 'SLICE' && n.visible && !n.locked && this.containsPoint(n.id, x, y, tol) && this.isVisibleThroughClips(n.id, x, y) && !this.ancestors(n.id).some((a) => a.locked))
    if (!cands.length) return null
    cands.sort((a, b) => (this.paintOrderKey(a.id) < this.paintOrderKey(b.id) ? 1 : -1))
    // prefer non-container leaves on top; containers (frames, sections) only when nothing inside was hit
    const leaf = cands.find((n) => n.type !== 'FRAME' && n.type !== 'GROUP' && n.type !== 'SECTION') ?? cands[0]
    if (deep) return leaf.id
    // climb out of groups (select the outermost group below a frame/page)
    let pick = leaf
    for (const a of this.ancestors(leaf.id)) {
      if (a.type === 'GROUP') pick = a
      else break
    }
    // if the user already has something inside this group selected, allow selecting siblings
    if (pick.id !== leaf.id && this.selection.some((s) => this.isAncestor(pick.id, s))) {
      const sel = this.nodes.get(this.selection[0])!
      const level = this.ancestors(leaf.id).find((a) => a.id === sel.parentId)
      if (level) {
        let n: GNode = leaf
        while (n.parentId !== level.id) n = this.nodes.get(n.parentId!)!
        return n.id
      }
    }
    return pick.id
  }

  visibleIds(r: Rect): Set<string> {
    return new Set(this.query(r))
  }

  intersectsRect(id: string, r: Rect): boolean {
    return rectsIntersect(this.world(id), r)
  }

  // ---------------- convenience setters used by UI & commands ----------------
  setFill(id: string, color: RGBA | null): void {
    const n = this.nodes.get(id)!
    const others = n.fills.filter((f) => f.type !== 'SOLID')
    const fills: Paint[] = color ? [...others, { type: 'SOLID', color }] : others
    this.updateNode(id, { fills })
  }
}

export function defaultName(t: GNode['type']): string {
  const names: Record<GNode['type'], string> = {
    FRAME: 'Frame',
    GROUP: 'Group',
    RECTANGLE: 'Rectangle',
    ELLIPSE: 'Ellipse',
    TEXT: 'Text',
    VECTOR: 'Vector',
    IMAGE: 'Image',
    SECTION: 'Section',
    SLICE: 'Slice',
    SPEC: 'Spec',
    CODE: 'Code',
    ANNOTATION: 'Annotation'
  }
  return names[t]
}

export const editor = new Editor()
;(window as unknown as { editor: Editor }).editor = editor
