// Right-click menu for the canvas and the layers panel (same items and shortcuts as Figma).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { editor as ed } from '../editor/editor'
import { useT } from './i18n'
import { layerActions as A, copyProperties, pasteProperties } from './layerActions'
import { exportSelectionPng, exportSelectionSvg } from './actions'

type Item = { label: string; key?: string; run: () => void; disabled?: boolean } | 'sep'

export function ContextMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const nodes = ed.selection.map((id) => ed.nodes.get(id)!).filter(Boolean)
  const has = nodes.length > 0
  const container = nodes.some((n) => n.type === 'GROUP' || n.type === 'FRAME' || n.type === 'SECTION')

  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect()
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) })
  }, [x, y])
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose()
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

  const items: Item[] = has
    ? [
        { label: 'Copy', key: 'Ctrl+C', run: A.copy },
        { label: 'Cut', key: 'Ctrl+X', run: A.cut },
        { label: 'Paste here', key: 'Ctrl+V', run: () => void A.paste() },
        { label: 'Duplicate', key: 'Ctrl+D', run: A.duplicate },
        { label: 'Delete', key: 'Del', run: A.delete },
        'sep',
        { label: 'Copy properties', key: 'Ctrl+Alt+C', run: copyProperties },
        { label: 'Paste properties', key: 'Ctrl+Alt+V', run: pasteProperties },
        { label: 'Copy as PNG', key: 'Ctrl+Shift+C', run: A.copyPng },
        'sep',
        { label: 'Bring to front', key: 'Ctrl+Alt+]', run: A.front },
        { label: 'Bring forward', key: 'Ctrl+]', run: A.forward },
        { label: 'Send backward', key: 'Ctrl+[', run: A.backward },
        { label: 'Send to back', key: 'Ctrl+Alt+[', run: A.back },
        'sep',
        { label: 'Group selection', key: 'Ctrl+G', run: A.group },
        { label: 'Frame selection', key: 'Ctrl+Alt+G', run: A.frameSelection },
        { label: 'Ungroup', key: 'Ctrl+Shift+G', run: A.ungroup, disabled: !container },
        { label: 'Rename', key: 'Ctrl+R', run: A.rename, disabled: nodes.length !== 1 },
        'sep',
        { label: nodes.every((n) => n.isMask) ? 'Remove mask' : 'Use as mask', key: 'Ctrl+Alt+M', run: A.toggleMask },
        { label: nodes.every((n) => n.visible) ? 'Hide' : 'Show', key: 'Ctrl+Shift+H', run: A.toggleVisible },
        { label: nodes.every((n) => n.locked) ? 'Unlock' : 'Lock', key: 'Ctrl+Shift+L', run: A.toggleLock },
        'sep',
        { label: 'Flip horizontal', key: 'Shift+H', run: A.flipH },
        { label: 'Flip vertical', key: 'Shift+V', run: A.flipV },
        'sep',
        { label: 'Export selection as PNG', run: () => void exportSelectionPng() },
        { label: 'Export selection as SVG', run: () => void exportSelectionSvg() }
      ]
    : [
        { label: 'Paste here', key: 'Ctrl+V', run: () => void A.paste() },
        'sep',
        { label: 'Select all', key: 'Ctrl+A', run: () => ed.setSelection([...ed.children(null)]) },
        { label: 'Zoom to fit', key: 'Shift+1', run: () => ed.zoomToFit() },
        { label: 'Zoom to 100%', key: 'Shift+0', run: () => ed.setZoom(1) },
        'sep',
        { label: 'Undo', key: 'Ctrl+Z', run: () => ed.undo() },
        { label: 'Redo', key: 'Ctrl+Shift+Z', run: () => ed.redo() }
      ]

  return createPortal(
    <div ref={ref} className="tool-menu ctx-menu" style={{ left: pos.left, top: pos.top, bottom: 'auto' }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            key={i}
            className={'tool-menu-item' + (it.disabled ? ' disabled' : '')}
            onClick={() => {
              onClose()
              it.run()
            }}
          >
            <span className="tm-label">{t(it.label)}</span>
            <span className="tm-key">{it.key}</span>
          </button>
        )
      )}
    </div>,
    document.body
  )
}
