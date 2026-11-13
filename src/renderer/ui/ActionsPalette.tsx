// Ctrl+K "Actions": search tools, commands and layers (offline equivalent of Figma's actions menu;
// plugins will register here later).
import { useEffect, useMemo, useRef, useState } from 'react'
import { editor as ed } from '../editor/editor'
import { Icons } from './icons'
import { useT } from './i18n'
import { TOOL_GROUPS } from './Toolbar'
import { runAction, exportFramesPdf, exportPdf, exportSelectionPng, exportSelectionSvg, importPdfFiles, placeImage } from './actions'
import { runPlugin, usePlugins } from './plugins'
import { backend } from '../backend'

interface Action {
  id: string
  label: string
  hint?: string
  section: string
  icon?: keyof typeof Icons
  /** plugin icon */
  img?: string
  run: () => void
}

export function ActionsPalette({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<'all' | 'layers'>('all')
  const [active, setActive] = useState(0)
  const plugins = usePlugins()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])

  const actions = useMemo<Action[]>(() => {
    const out: Action[] = []
    for (const g of TOOL_GROUPS)
      for (const it of g.items) {
        if (it.disabled) continue
        out.push({ id: 'tool:' + it.label, label: t(it.label), hint: it.key, section: t('Tools'), icon: it.icon, run: () => (it.run ? it.run() : ed.setTool(it.tool!)) })
      }
    out.push({ id: 'tool:annotation', label: t('Annotation'), hint: 'C', section: t('Tools'), icon: 'annotation', run: () => ed.setTool('annotation') })
    const cmd = (id: string, label: string, hint: string, run: () => void) => out.push({ id: 'cmd:' + id, label: t(label), hint, section: t('Commands'), run })
    cmd('undo', 'Undo', 'Ctrl+Z', () => ed.undo())
    cmd('redo', 'Redo', 'Ctrl+Shift+Z', () => ed.redo())
    cmd('select-all', 'Select all', 'Ctrl+A', () => runAction('select-all'))
    cmd('duplicate', 'Duplicate', 'Ctrl+D', () => runAction('duplicate'))
    cmd('group', 'Group selection', 'Ctrl+G', () => ed.group())
    cmd('ungroup', 'Ungroup', 'Ctrl+Shift+G', () => ed.ungroup())
    cmd('delete', 'Delete', 'Del', () => ed.deleteSelection())
    cmd('front', 'Bring to front', 'Ctrl+Alt+]', () => ed.reorder(Infinity))
    cmd('back', 'Send to back', 'Ctrl+Alt+[', () => ed.reorder(-Infinity))
    cmd('zoom-fit', 'Zoom to fit', 'Shift+1', () => ed.zoomToFit())
    cmd('zoom-100', 'Zoom to 100%', 'Shift+0', () => ed.setZoom(1))
    cmd('toggle-left', 'Toggle left panel', 'Ctrl+\\', () => runAction('toggle-left'))
    cmd('toggle-right', 'Toggle right panel', 'Ctrl+Alt+\\', () => runAction('toggle-right'))
    cmd('png', 'Export selection as PNG', '', () => void exportSelectionPng())
    cmd('svg', 'Export selection as SVG', '', () => void exportSelectionSvg())
    cmd('pdf', 'Export selection as PDF', '', () => void exportPdf())
    cmd('frames-pdf', 'Export frames to PDF', '', () => void exportFramesPdf())
    cmd('place-image', 'Place image', 'Ctrl+Shift+K', placeImage)
    cmd('import-pdf', 'Import PDF…', '', importPdfFiles)
    cmd('add-page', 'Add page', '', () => ed.addPage())
    for (const p of plugins) out.push({ id: 'plugin:' + p.id, label: p.name, hint: p.description ?? '', section: t('Plugins'), img: p.iconUrl ?? undefined, run: () => runPlugin(p.id) })
    out.push({ id: 'plugin-manage', label: t('Manage plugins…'), hint: '', section: t('Plugins'), run: () => void backend.tabs.openSettings() })
    return out
  }, [t, plugins])

  const layers = useMemo<Action[]>(
    () =>
      [...ed.nodes.values()]
        .filter((n) => n.pageId === ed.currentPageId && n.type !== 'ANNOTATION')
        .slice(0, 5000)
        .map((n) => ({
          id: 'layer:' + n.id,
          label: n.name,
          hint: t(n.type.charAt(0) + n.type.slice(1).toLowerCase()),
          section: t('Layers'),
          run: () => {
            ed.setSelection([n.id])
            ed.zoomToRect(ed.selectionBounds(), 2)
          }
        })),
    [t]
  )

  const shown = useMemo(() => {
    const base = tab === 'layers' ? layers : [...actions, ...(q ? layers : [])]
    const s = q.trim().toLowerCase()
    return (s ? base.filter((a) => a.label.toLowerCase().includes(s)) : base).slice(0, 200)
  }, [q, tab, actions, layers])

  const run = (a: Action | undefined) => {
    if (!a) return
    onClose()
    a.run()
  }

  let lastSection = ''
  return (
    <div className="palette-bg" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <label className="palette-search">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" strokeLinecap="round" />
          </svg>
          <input
            ref={input}
            placeholder={t('Search')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') onClose()
              if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(shown.length - 1, a + 1)))
              if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(0, a - 1)))
              if (e.key === 'Enter') run(shown[active])
            }}
          />
        </label>
        <div className="text-tabs" style={{ padding: '6px 8px' }}>
          <button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>
            {t('All')}
          </button>
          <button className={tab === 'layers' ? 'on' : ''} onClick={() => setTab('layers')}>
            {t('Layers')}
          </button>
        </div>
        <div className="palette-list">
          {shown.map((a, i) => {
            const header = a.section !== lastSection ? (lastSection = a.section) : null
            return (
              <div key={a.id}>
                {header && <div className="palette-section">{header}</div>}
                <button className={'palette-item' + (i === active ? ' active' : '')} onMouseEnter={() => setActive(i)} onClick={() => run(a)}>
                  <span className="pi-icon">{a.img ? <img src={a.img} alt="" width={16} height={16} /> : a.icon ? Icons[a.icon] : null}</span>
                  <span className="pi-label">{a.label}</span>
                  <span className="pi-hint">{a.hint}</span>
                </button>
              </div>
            )
          })}
          {!shown.length && <div className="palette-section">{t('Nothing found')}</div>}
        </div>
      </div>
    </div>
  )
}
