// Right-click menu for the canvas and the layers panel: same items, order and shortcuts as Figma
// (without the things Gigma does not have: code, motion, plugins, widgets).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { editor as ed } from '../editor/editor'
import { isBooleanGroup } from '../editor/boolean'
import { useT } from './i18n'
import { layerActions as A, copyProperties, pasteProperties } from './layerActions'
import { exportSelectionPng, exportSelectionSvg } from './actions'
import { TypeIcon } from './icons'
import { runPlugin, usePlugins } from './plugins'
import { backend } from '../backend'

type Item = { label: string; key?: string; run?: () => void; disabled?: boolean; children?: Item[]; icon?: React.ReactNode; raw?: boolean } | 'sep'

/** layers under a point of the canvas, top first */
function layersAt(x: number, y: number): string[] {
  const canvas = document.querySelector<HTMLCanvasElement>('.canvas-wrap canvas')
  if (!canvas) return []
  const r = canvas.getBoundingClientRect()
  if (x < r.left || y < r.top || x > r.right || y > r.bottom) return []
  const p = ed.screenToWorld(x - r.left, y - r.top)
  return ed
    .query({ x: p.x, y: p.y, w: 0.001, h: 0.001 })
    .filter((id) => {
      const n = ed.nodes.get(id)!
      return n.visible && n.type !== 'ANNOTATION' && ed.containsPoint(id, p.x, p.y) && ed.isVisibleThroughClips(id, p.x, p.y)
    })
    .sort((a, b) => (ed.paintOrderKey(a) < ed.paintOrderKey(b) ? 1 : -1))
    .slice(0, 14)
}

function Panel({ items, x, y, onClose, anchor }: { items: Item[]; x: number; y: number; onClose: () => void; anchor?: DOMRect }) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [open, setOpen] = useState<{ i: number; rect: DOMRect } | null>(null)
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect()
    // a submenu that does not fit on the right opens on the left of its parent
    let left = x
    if (left + r.width > window.innerWidth - 8) left = anchor ? anchor.left - r.width + 4 : window.innerWidth - r.width - 8
    setPos({ left: Math.max(8, left), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) })
  }, [x, y, anchor])
  return (
    <>
      <div ref={ref} className="tool-menu ctx-menu" style={{ left: pos.left, top: pos.top, bottom: 'auto' }} onContextMenu={(e) => e.preventDefault()}>
        {items.map((it, i) =>
          it === 'sep' ? (
            <div key={i} className="ctx-sep" />
          ) : (
            <button
              key={i}
              className={'tool-menu-item' + (it.disabled ? ' disabled' : '') + (open?.i === i ? ' active' : '')}
              onMouseEnter={(e) => setOpen(it.children && !it.disabled ? { i, rect: e.currentTarget.getBoundingClientRect() } : null)}
              onClick={(e) => {
                if (it.children) return setOpen({ i, rect: e.currentTarget.getBoundingClientRect() })
                onClose()
                it.run?.()
              }}
            >
              {it.icon && <span className="ctx-icon">{it.icon}</span>}
              <span className="tm-label">{it.raw ? it.label : t(it.label)}</span>
              <span className="tm-key">{it.children ? '›' : it.key}</span>
            </button>
          )
        )}
      </div>
      {open && (items[open.i] as Exclude<Item, 'sep'>).children && (
        <Panel items={(items[open.i] as Exclude<Item, 'sep'>).children!} x={open.rect.right - 4} y={open.rect.top - 6} anchor={open.rect} onClose={onClose} />
      )}
    </>
  )
}

export function ContextMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const nodes = ed.selection.map((id) => ed.nodes.get(id)!).filter(Boolean)
  const has = nodes.length > 0
  const one = nodes.length === 1 ? nodes[0] : null
  const container = nodes.some((n) => n.type === 'GROUP' || n.type === 'FRAME' || n.type === 'SECTION')
  const instance = one ? ed.instanceOf(one.id) : null
  const inComponent = nodes.some((n) => ed.mainComponentOf(n.id) || ed.instanceOf(n.id))

  useEffect(() => {
    const down = (e: MouseEvent) => !(e.target as HTMLElement).closest?.('.ctx-menu') && onClose()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const under = layersAt(x, y)
  const selectLayer: Item = {
    label: 'Select layer',
    disabled: !under.length,
    children: under.map((id) => {
      const n = ed.nodes.get(id)!
      return { label: n.name, raw: true, icon: <TypeIcon type={n.isComponent ? 'COMPONENT' : n.componentId ? 'INSTANCE' : isBooleanGroup(n) ? n.booleanOperation! : n.type} />, run: () => ed.setSelection([id]) }
    })
  }
  const plugins = usePlugins()
  const pluginsItem: Item = {
    label: 'Plugins',
    children: [
      ...plugins.map((p): Item => ({ label: p.name, raw: true, icon: p.iconUrl ? <img src={p.iconUrl} alt="" width={14} height={14} /> : undefined, run: () => runPlugin(p.id) })),
      ...(plugins.length ? (['sep'] as Item[]) : []),
      { label: 'Manage plugins…', run: () => void backend.tabs.openSettings() }
    ]
  }
  const pages = ed.sortedPages().filter((p) => p.id !== ed.currentPageId)
  const moveToPage: Item = { label: 'Move to page', disabled: !pages.length, children: pages.map((p) => ({ label: p.name, raw: true, run: () => A.moveToPage(p.id) })) }
  const copyPasteAs: Item = {
    label: 'Copy/Paste as',
    children: [
      { label: 'Copy as SVG', run: A.copy },
      { label: 'Copy as PNG', key: 'Ctrl+Shift+C', run: A.copyPng },
      'sep',
      { label: 'Copy properties', key: 'Ctrl+Alt+C', run: copyProperties },
      { label: 'Paste properties', key: 'Ctrl+Alt+V', run: pasteProperties },
      'sep',
      { label: 'Export selection as PNG', run: () => void exportSelectionPng() },
      { label: 'Export selection as SVG', run: () => void exportSelectionSvg() }
    ]
  }

  const items: Item[] = has
    ? [
        { label: 'Copy', key: 'Ctrl+C', run: A.copy },
        { label: 'Paste here', run: () => void A.paste() },
        { label: 'Paste to replace', key: 'Ctrl+Shift+R', run: () => void A.pasteReplace() },
        copyPasteAs,
        'sep',
        selectLayer,
        moveToPage,
        { label: 'Bring to front', key: ']', run: A.front },
        { label: 'Send to back', key: '[', run: A.back },
        'sep',
        { label: 'Group selection', key: 'Ctrl+G', run: A.group },
        { label: 'Frame selection', key: 'Ctrl+Alt+G', run: A.frameSelection },
        ...(container ? [{ label: 'Ungroup', key: 'Ctrl+Shift+G', run: A.ungroup } as Item] : []),
        { label: 'Flatten', key: 'Alt+Shift+F', run: A.flatten },
        { label: 'Outline stroke', key: 'Ctrl+Alt+O', run: A.outlineStroke, disabled: !nodes.some((n) => n.strokes.some((s) => s.visible !== false && s.weight > 0)) },
        { label: nodes.every((n) => n.isMask) ? 'Remove mask' : 'Use as mask', key: 'Ctrl+Alt+M', run: A.toggleMask },
        {
          label: 'Boolean groups',
          children: [
            { label: 'Union', key: 'Alt+Shift+U', run: () => A.booleanOp('UNION') },
            { label: 'Subtract', key: 'Alt+Shift+S', run: () => A.booleanOp('SUBTRACT') },
            { label: 'Intersect', key: 'Alt+Shift+I', run: () => A.booleanOp('INTERSECT') },
            { label: 'Exclude', key: 'Alt+Shift+E', run: () => A.booleanOp('EXCLUDE') }
          ]
        },
        'sep',
        one?.layoutMode ? { label: 'Remove auto layout', key: 'Alt+Shift+A', run: A.removeAutoLayout } : { label: 'Add auto layout', key: 'Shift+A', run: A.addAutoLayout },
        ...(instance
          ? ([
              { label: 'Go to main component', run: A.goToMainComponent },
              { label: 'Detach instance', key: 'Ctrl+Alt+B', run: A.detachInstance }
            ] as Item[])
          : one?.isComponent
            ? [{ label: 'Add variant', run: () => void ed.addVariant(one.id) } as Item]
            : [{ label: 'Create component', key: 'Ctrl+Alt+K', run: A.createComponent, disabled: inComponent } as Item]),
        pluginsItem,
        'sep',
        { label: 'Show/Hide', key: 'Ctrl+Shift+H', run: A.toggleVisible },
        { label: 'Lock/Unlock', key: 'Ctrl+Shift+L', run: A.toggleLock },
        'sep',
        { label: 'Flip horizontal', key: 'Shift+H', run: A.flipH },
        { label: 'Flip vertical', key: 'Shift+V', run: A.flipV }
      ]
    : [
        { label: 'Paste here', key: 'Ctrl+V', run: () => void A.paste() },
        'sep',
        selectLayer,
        { label: 'Select all', key: 'Ctrl+A', run: () => ed.setSelection([...ed.children(null)]) },
        pluginsItem,
        'sep',
        { label: 'Zoom to fit', key: 'Shift+1', run: () => ed.zoomToFit() },
        { label: 'Zoom to 100%', key: 'Shift+0', run: () => ed.setZoom(1) },
        'sep',
        { label: 'Undo', key: 'Ctrl+Z', run: () => ed.undo() },
        { label: 'Redo', key: 'Ctrl+Shift+Z', run: () => ed.redo() }
      ]

  return createPortal(<Panel items={items} x={x} y={y} onClose={onClose} />, document.body)
}
