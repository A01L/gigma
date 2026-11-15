import { useMemo, useRef, useState, useEffect } from 'react'
import { editor as ed } from '../editor/editor'
import { useEditor } from './hooks'
import { Icons, TypeIcon } from './icons'
import { exportCurrentPage, importPages, runAction } from './actions'
import { useT } from './i18n'
import { keyBetween } from '../editor/util'
import { isAutoLayout } from '../editor/autolayout'
import type { GNode } from '@shared/types'

const ROW_H = 28

export function LeftPanel({ onHome }: { onHome: () => void }) {
  useEditor('pages')
  const t = useT()
  const [renaming, setRenaming] = useState(false)
  /** what is typed into the search of the layers: the list shows the layers that match while it is not empty */
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  // Ctrl+F in the editor opens the search
  useEffect(() => {
    const h = () => setSearching(true)
    window.addEventListener('gigma-find-layer', h)
    return () => window.removeEventListener('gigma-find-layer', h)
  }, [])
  const closeSearch = () => (setSearching(false), setQuery(''))
  return (
    <div className="panel left">
      <div className="p-head">
        <button className="icon-btn" title={t('Home')} onClick={onHome}>
          {Icons.home}
        </button>
        {renaming ? (
          <InlineRename value={ed.meta.name} onDone={(v) => (setRenaming(false), v && ed.rename(v))} />
        ) : (
          <div className="title" onDoubleClick={() => setRenaming(true)} title="Double-click to rename">
            {ed.meta.name}
          </div>
        )}
        <button className="icon-btn" title="Hide panel (Ctrl+\)" onClick={() => runAction('toggle-left')}>
          {Icons.sidebarL}
        </button>
      </div>
      <Pages />
      <div className="section-title" style={{ marginTop: 6 }}>
        {searching ? (
          <LayerSearch value={query} onChange={setQuery} onClose={closeSearch} />
        ) : (
          <>
            {t('Layers')}
            <button className="icon-btn" title={t('Find a layer (Ctrl+F)')} onClick={() => setSearching(true)}>
              {Icons.search}
            </button>
          </>
        )}
      </div>
      <Layers query={searching ? query.trim().toLowerCase() : ''} />
    </div>
  )
}

function InlineRename({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      className="rename-input"
      defaultValue={value}
      onBlur={(e) => onDone(e.target.value.trim() || null)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') onDone(null)
      }}
      onClick={(e) => e.stopPropagation()}
    />
  )
}

function LayerSearch({ value, onChange, onClose }: { value: string; onChange: (v: string) => void; onClose: () => void }) {
  const t = useT()
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return (
    <div className="layer-search">
      {Icons.search}
      <input
        ref={ref}
        value={value}
        placeholder={t('Find a layer')}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') onClose()
        }}
        onClick={(e) => e.stopPropagation()}
      />
      <button className="icon-btn" title={t('Close')} onClick={onClose}>
        ×
      </button>
    </div>
  )
}

/** the shape of a vector as its icon in the list (as Figma shows it): filled when the layer has a fill, a line otherwise */
function VectorThumb({ n }: { n: GNode }) {
  const w = n.pathBox?.w || n.width || 1
  const h = n.pathBox?.h || n.height || 1
  const filled = n.fills.some((f) => f.visible !== false)
  const pad = Math.max(w, h) * 0.06
  return (
    <svg width="14" height="14" viewBox={[-pad, -pad, w + pad * 2, h + pad * 2].join(' ')} preserveAspectRatio="xMidYMid meet" className="vector-thumb">
      <path d={n.path} fillRule={n.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={filled ? 0 : 1.2} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** a name with the found part marked */
function Marked({ text, query }: { text: string; query: string }) {
  const i = query ? text.toLowerCase().indexOf(query) : -1
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  )
}

function Pages() {
  useEditor('pages')
  const t = useT()
  const [renaming, setRenaming] = useState<string | null>(null)
  const pages = ed.sortedPages()
  return (
    <div className="section pages">
      <div className="section-title">
        {t('Pages')}
        <span style={{ display: 'flex' }}>
          <button className="icon-btn" title={t('Import pages from .gigma')} onClick={() => void importPages()}>
            {Icons.export}
          </button>
          <button className="icon-btn" title={t('Add page')} onClick={() => ed.addPage()}>
            {Icons.plus}
          </button>
        </span>
      </div>
      {pages.map((p) => (
        <div
          key={p.id}
          className={'list-row' + (p.id === ed.currentPageId ? ' selected' : '')}
          style={{ paddingLeft: 12 }}
          onClick={() => ed.setCurrentPage(p.id)}
          onDoubleClick={() => setRenaming(p.id)}
        >
          {renaming === p.id ? (
            <InlineRename value={p.name} onDone={(v) => (setRenaming(null), v && ed.updatePage(p.id, { name: v }))} />
          ) : (
            <span className="name">{p.name}</span>
          )}
          <span className="row-actions">
            <button title={t('Export page as .gigma')} onClick={(e) => (e.stopPropagation(), void exportCurrentPage([p.id]))}>
              {Icons.export}
            </button>
            {pages.length > 1 && (
              <button
                title={t('Delete page')}
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm(`Delete page "${p.name}"? You can undo with Ctrl+Z.`)) ed.deletePage(p.id)
                }}
              >
                {Icons.trash}
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

interface Row {
  id: string
  depth: number
  hasKids: boolean
}

function Layers({ query }: { query: string }) {
  const t = useT()
  const v = useEditor('doc', 'selection', 'pages')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<string | null>(null)
  const [scroll, setScroll] = useState(0)
  const [height, setHeight] = useState(400)
  const boxRef = useRef<HTMLDivElement>(null)

  // auto-expand ancestors of selection
  useEffect(() => {
    let changed = false
    const next = new Set(expanded)
    for (const id of ed.selection)
      for (const a of ed.ancestors(id))
        if (!next.has(a.id)) {
          next.add(a.id)
          changed = true
        }
    if (changed) setExpanded(next)
  }, [ed.version('selection')]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = boxRef.current!
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Flatten tree (top of z-order first, like Figma).
  const rows = useMemo(() => {
    const out: Row[] = []
    if (query) {
      // a search: every layer of the page whose name (or text) has the words, as a flat list in the order of the tree
      const find = (parent: string | null) => {
        const flow = isAutoLayout(parent ? ed.nodes.get(parent) : undefined)
        const kids = flow ? [...ed.children(parent)].reverse() : ed.children(parent)
        for (let i = kids.length - 1; i >= 0; i--) {
          const n = ed.nodes.get(kids[i])
          if (!n || n.type === 'ANNOTATION') continue
          if (n.name.toLowerCase().includes(query) || (n.type === 'TEXT' && (n.characters ?? '').toLowerCase().includes(query))) out.push({ id: n.id, depth: 0, hasKids: false })
          find(n.id)
        }
      }
      find(null)
      return out
    }
    const walk = (parent: string | null, depth: number) => {
      // auto layout frames list their items in layout order (first item on top), as Figma does
      const flow = isAutoLayout(parent ? ed.nodes.get(parent) : undefined)
      const kids = flow ? [...ed.children(parent)].reverse() : ed.children(parent)
      for (let i = kids.length - 1; i >= 0; i--) {
        const id = kids[i]
        // annotations are notes, not layers (like Figma comments)
        if (ed.nodes.get(id)?.type === 'ANNOTATION') continue
        const has = ed.children(id).length > 0
        out.push({ id, depth, hasKids: has })
        if (has && expanded.has(id)) walk(id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [v, expanded, query])

  const selSet = new Set(ed.selection)
  const first = Math.max(0, Math.floor(scroll / ROW_H) - 5)
  const last = Math.min(rows.length, Math.ceil((scroll + height) / ROW_H) + 5)

  const toggle = (id: string) => {
    const n = new Set(expanded)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    setExpanded(n)
  }

  // Ctrl+R / context menu "Rename"
  useEffect(() => {
    const h = (e: Event) => setRenaming((e as CustomEvent<string>).detail ?? null)
    window.addEventListener('gigma-rename', h)
    return () => window.removeEventListener('gigma-rename', h)
  }, [])

  // ---- drag & drop: reorder layers and move them in / out of frames and groups ----
  const dragId = useRef<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; zone: 'above' | 'below' | 'inside' } | null>(null)
  const zoneOf = (e: React.DragEvent, id: string): 'above' | 'below' | 'inside' => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const f = (e.clientY - r.top) / r.height
    const t = ed.nodes.get(id)!
    const container = t.type === 'FRAME' || t.type === 'GROUP' || t.type === 'SECTION'
    if (container && f > 0.25 && f < 0.75) return 'inside'
    return f < 0.5 ? 'above' : 'below'
  }
  const drop = (targetId: string, shown: 'above' | 'below' | 'inside') => {
    // inside an auto layout frame the list runs the other way (first item on top)
    const tp = ed.nodes.get(targetId)?.parentId
    const flip = isAutoLayout(tp ? ed.nodes.get(tp) : undefined)
    const zone = flip && shown !== 'inside' ? (shown === 'above' ? 'below' : 'above') : shown
    const src = dragId.current
    dragId.current = null
    setDropAt(null)
    const target = ed.nodes.get(targetId)
    if (!src || !target) return
    const moving = ed
      .roots(ed.selection.includes(src) ? ed.selection : [src])
      .filter((id) => id !== targetId && !ed.isAncestor(id, targetId))
      .sort((a, b) => (ed.paintOrderKey(a) < ed.paintOrderKey(b) ? -1 : 1))
    if (!moving.length) return
    ed.act(() => {
      if (zone === 'inside') {
        for (const id of moving) ed.reparent(id, targetId)
        return
      }
      const parent = target.parentId
      const sib = ed.children(parent).filter((id) => !moving.includes(id))
      const i = sib.indexOf(targetId)
      // the list shows the top of the z-order first, so "above" means a higher order key
      let lo = zone === 'above' ? target.order : i > 0 ? ed.nodes.get(sib[i - 1])!.order : null
      const hi = zone === 'above' ? (i + 1 < sib.length ? ed.nodes.get(sib[i + 1])!.order : null) : target.order
      for (const id of moving) {
        lo = keyBetween(lo, hi)
        ed.reparent(id, parent, lo)
      }
    })
    if (zone === 'inside') setExpanded(new Set([...expanded, targetId]))
  }

  return (
    <div className="layers" ref={boxRef} onScroll={(e) => setScroll((e.target as HTMLDivElement).scrollTop)} onClick={() => ed.setSelection([])}>
      {query && !rows.length && <div className="layers-empty">{t('Nothing found')}</div>}
      <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
        {rows.slice(first, last).map((r, i) => {
          const n = ed.nodes.get(r.id)
          if (!n) return null
          const selected = selSet.has(r.id)
          const inSel = !selected && ed.ancestors(r.id).some((a) => selSet.has(a.id))
          return (
            <div
              key={r.id}
              className={'list-row' + (selected ? ' selected' : inSel ? ' child-of-selected' : '') + (dropAt?.id === r.id ? ' drop-' + dropAt.zone : '')}
              style={{ position: 'absolute', top: (first + i) * ROW_H, left: 0, right: 0, paddingLeft: 4 + r.depth * 16 }}
              draggable={renaming !== r.id && !query}
              onDragStart={(e) => {
                dragId.current = r.id
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', n.name)
              }}
              onDragOver={(e) => {
                if (!dragId.current || dragId.current === r.id) return
                e.preventDefault()
                e.stopPropagation()
                const zone = zoneOf(e, r.id)
                if (dropAt?.id !== r.id || dropAt.zone !== zone) setDropAt({ id: r.id, zone })
              }}
              onDragLeave={() => dropAt?.id === r.id && setDropAt(null)}
              onDrop={(e) => {
                e.preventDefault()
                e.stopPropagation()
                drop(r.id, zoneOf(e, r.id))
              }}
              onDragEnd={() => {
                dragId.current = null
                setDropAt(null)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (!selected) ed.setSelection([r.id])
                window.dispatchEvent(new CustomEvent('gigma-context', { detail: { x: e.clientX, y: e.clientY } }))
              }}
              onMouseEnter={() => {
                ed.hoverId = r.id
                ed.emit('camera')
              }}
              onMouseLeave={() => {
                ed.hoverId = null
                ed.emit('camera')
              }}
              onClick={(e) => {
                e.stopPropagation()
                if (e.shiftKey || e.ctrlKey || e.metaKey) ed.setSelection(selected ? ed.selection.filter((s) => s !== r.id) : [...ed.selection, r.id])
                else {
                  ed.setSelection([r.id])
                  // a layer found by the search is brought into view when it is out of sight
                  if (query) {
                    const w = ed.world(r.id), view = ed.visibleWorldRect()
                    const seen = w.x < view.x + view.w && w.x + w.w > view.x && w.y < view.y + view.h && w.y + w.h > view.y
                    if (!seen) ed.zoomToRect({ x: w.x - 40, y: w.y - 40, w: w.w + 80, h: w.h + 80 }, Math.max(ed.camera.zoom, 0.1))
                  }
                }
              }}
              onDoubleClick={(e) => (e.stopPropagation(), setRenaming(r.id))}
            >
              <span className="chev" onClick={(e) => (e.stopPropagation(), r.hasKids && toggle(r.id))}>
                {r.hasKids ? (expanded.has(r.id) ? Icons.chevD : Icons.chevR) : null}
              </span>
              <span className="type-icon">
                {n.type === 'VECTOR' && !n.isMask && n.path && n.path.length < 60000 ? <VectorThumb n={n} /> : <TypeIcon type={n.isMask ? 'MASK' : n.isComponent || n.isComponentSet ? 'COMPONENT' : n.componentId ? 'INSTANCE' : n.type === 'GROUP' && n.booleanOperation ? n.booleanOperation : n.fills.some((f) => f.type === 'IMAGE') ? 'IMAGE' : n.type} />}
              </span>
              {renaming === r.id ? (
                <InlineRename value={n.name} onDone={(v) => (setRenaming(null), v && ed.act(() => ed.updateNode(r.id, { name: v })))} />
              ) : (
                <span className={'name' + (n.visible ? '' : ' dim')}>
                  <Marked text={n.name} query={query} />
                </span>
              )}
              <span className={'row-actions' + (!n.visible || n.locked ? ' pinned' : '')}>
                <button title={n.locked ? 'Unlock' : 'Lock'} onClick={(e) => (e.stopPropagation(), ed.act(() => ed.updateNode(r.id, { locked: !n.locked })))}>
                  {n.locked ? Icons.lock : Icons.unlock}
                </button>
                <button title={n.visible ? 'Hide' : 'Show'} onClick={(e) => (e.stopPropagation(), ed.act(() => ed.updateNode(r.id, { visible: !n.visible })))}>
                  {n.visible ? Icons.eye : Icons.eyeOff}
                </button>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
