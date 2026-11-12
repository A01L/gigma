// Bottom toolbar grouped like Figma: each group shows its last used tool, the chevron opens the group menu.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { editor as ed, type Tool } from '../editor/editor'
import { useEditor } from './hooks'
import { Icons } from './icons'
import { useT } from './i18n'
import { placeImage } from './actions'

export interface ToolItem {
  tool?: Tool
  /** non-tool actions (e.g. place image) */
  run?: () => void
  icon: keyof typeof Icons
  label: string
  key: string
  disabled?: boolean
}

export const TOOL_GROUPS: { id: string; items: ToolItem[] }[] = [
  {
    id: 'move',
    items: [
      { tool: 'move', icon: 'move', label: 'Move', key: 'V' },
      { tool: 'hand', icon: 'hand', label: 'Hand tool', key: 'H' },
      { tool: 'scale', icon: 'scale', label: 'Scale', key: 'K' }
    ]
  },
  {
    id: 'frame',
    items: [
      { tool: 'frame', icon: 'frame', label: 'Frame', key: 'F' },
      { tool: 'section', icon: 'section', label: 'Section', key: 'Shift+S' },
      { tool: 'slice', icon: 'slice', label: 'Slice', key: 'S' }
    ]
  },
  {
    id: 'shape',
    items: [
      { tool: 'rect', icon: 'rect', label: 'Rectangle', key: 'R' },
      { tool: 'line', icon: 'line', label: 'Line', key: 'L' },
      { tool: 'arrow', icon: 'arrow', label: 'Arrow', key: 'Shift+L' },
      { tool: 'ellipse', icon: 'ellipse', label: 'Ellipse', key: 'O' },
      { tool: 'polygon', icon: 'polygon', label: 'Polygon', key: '' },
      { tool: 'star', icon: 'star', label: 'Star', key: '' },
      { run: placeImage, icon: 'image', label: 'Image…', key: 'Ctrl+Shift+K' }
    ]
  },
  {
    id: 'pen',
    items: [
      { tool: 'pen', icon: 'pen', label: 'Pen', key: 'P' },
      { tool: 'pencil', icon: 'pencil', label: 'Pencil', key: 'Shift+P' }
    ]
  },
  {
    id: 'text',
    items: [
      { tool: 'text', icon: 'text', label: 'Text', key: 'T' },
      { icon: 'textPath', label: 'Text on path (soon)', key: '', disabled: true }
    ]
  },
  {
    id: 'dev',
    items: [
      { tool: 'spec', icon: 'spec', label: 'Spec', key: 'D' },
      { tool: 'code', icon: 'code', label: 'Code', key: 'B' }
    ]
  }
]

/** last used tool per group (persists while the app runs) */
const lastInGroup: Record<string, number> = {}

function GroupButton({ group }: { group: (typeof TOOL_GROUPS)[number] }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const activeIdx = group.items.findIndex((i) => i.tool && i.tool === ed.tool)
  if (activeIdx >= 0) lastInGroup[group.id] = activeIdx
  const current = group.items[lastInGroup[group.id] ?? 0]
  const active = activeIdx >= 0

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close, true)
    return () => window.removeEventListener('mousedown', close, true)
  }, [open])

  const pick = (it: ToolItem, idx: number) => {
    if (it.disabled) return
    setOpen(false)
    if (it.run) return it.run()
    lastInGroup[group.id] = idx
    ed.setTool(it.tool!)
  }
  const r = btn.current?.getBoundingClientRect()
  return (
    <div className="tool-group" ref={btn}>
      <button className={'icon-btn tip' + (active ? ' active' : '')} data-tip={`${t(current.label)}${current.key ? '  ' + current.key : ''}`} onClick={() => pick(current, lastInGroup[group.id] ?? 0)}>
        {Icons[current.icon]}
      </button>
      {group.items.length > 1 && (
        <button className={'tool-chevron' + (open ? ' open' : '')} onClick={() => setOpen(!open)} aria-label="More tools">
          {Icons.chevDown}
        </button>
      )}
      {open &&
        r &&
        createPortal(
          <div ref={menu} className="tool-menu" style={{ left: r.left, bottom: window.innerHeight - r.top + 10 }}>
            {group.items.map((it, i) => (
              <button key={it.label} className={'tool-menu-item' + (it.disabled ? ' disabled' : '')} onClick={() => pick(it, i)}>
                <span className="tm-check">{it.tool && it.tool === ed.tool ? '✓' : ''}</span>
                <span className="tm-icon">{Icons[it.icon]}</span>
                <span className="tm-label">{t(it.label)}</span>
                <span className="tm-key">{it.key}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  )
}

export function Toolbar({ onActions }: { onActions: () => void }) {
  useEditor('ui')
  const t = useT()
  return (
    <div className="toolbar">
      {TOOL_GROUPS.map((g) => (
        <GroupButton key={g.id} group={g} />
      ))}
      <button className={'icon-btn tip' + (ed.tool === 'annotation' ? ' active' : '')} data-tip={t('Annotation') + '  C'} onClick={() => ed.setTool('annotation')}>
        {Icons.annotation}
      </button>
      <button className="icon-btn tip" data-tip={t('Actions') + '  Ctrl+K'} onClick={onActions}>
        {Icons.actions}
      </button>
    </div>
  )
}
