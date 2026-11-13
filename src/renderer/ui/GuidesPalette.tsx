// The guidelines menu (toolbar button, Ctrl+Shift+U): the library of design systems shared by every project.
// Pick one and click on the canvas to place its dot; "Create" places a new, open guideline.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { editor as ed } from '../editor/editor'
import { guides, guidesVersion, loadGuides, removeGuide, subscribeGuides } from '../editor/guides'
import { guideAccent, guideBallCss } from '../editor/guide-render'
import { backend } from '../backend'
import { Icons } from './icons'
import { useT } from './i18n'
import guideIcon from '../assets/guide-icon.svg'
import './guide.css'

export function GuidesPalette({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const v = useSyncExternalStore(subscribeGuides, guidesVersion)
  useEffect(() => input.current?.focus(), [])

  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return [...guides.values()].filter((g) => !s || g.name.toLowerCase().includes(s)).sort((a, b) => a.name.localeCompare(b.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, v])

  /** the next click on the canvas places it */
  const place = (id: string) => {
    onClose()
    ed.pendingGuide = id
    ed.setTool('guide')
    ed.showToast(id === 'new' ? t('Click on the canvas to place the new guideline') : t('Click on the canvas to place the guideline'))
  }
  const importFile = async () => {
    const g = await backend.guides.importFile()
    if (g) {
      await loadGuides()
      ed.showToast(t('“{name}” is in the library', { name: g.name }))
    }
  }
  // rows: guidelines first, then the two commands
  const rows: { key: string; run: () => void }[] = [...list.map((g) => ({ key: g.id, run: () => place(g.id) })), { key: 'new', run: () => place('new') }, { key: 'import', run: () => void importFile() }]

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
            placeholder={t('Search guidelines')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') onClose()
              if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(rows.length - 1, a + 1)))
              if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(0, a - 1)))
              if (e.key === 'Enter') rows[active]?.run()
            }}
          />
        </label>
        <div className="palette-list">
          {guides.size === 0 ? (
            <div className="palette-empty">
              <img src={guideIcon} alt="" width={56} height={56} draggable={false} />
              <span className="muted">{t('No guidelines yet. A guideline keeps the colours, fonts, logo and rules of a brand in one place, for every project.')}</span>
            </div>
          ) : (
            <div className="palette-section palette-head">
              <img src={guideIcon} alt="" width={18} height={18} draggable={false} />
              {t('Guidelines')}
            </div>
          )}
          {list.map((g, i) => (
            <button key={g.id} className={'palette-item' + (i === active ? ' active' : '')} onMouseEnter={() => setActive(i)} onClick={() => place(g.id)}>
              <span className="pi-icon">
                <i className="guide-dot" style={{ background: guideBallCss(guideAccent(g)) }} />
              </span>
              <span className="pi-label">{g.name}</span>
              <span className="pi-hint">
                {t('{c} colours, {f} fonts', { c: String(g.colors.length), f: String(g.fonts.length) })}
              </span>
              <span className="pi-tools">
                <span
                  onClick={(e) => {
                    e.stopPropagation()
                    void backend.guides.exportFile(g.id)
                  }}
                >
                  {t('Export')}
                </span>
                <span
                  onClick={(e) => {
                    e.stopPropagation()
                    if (confirm(t('Delete “{name}” from the library? It will disappear from every project.', { name: g.name }))) void removeGuide(g.id)
                  }}
                >
                  {t('Delete')}
                </span>
              </span>
            </button>
          ))}
          {guides.size > 0 && !list.length && <div className="palette-section">{t('Nothing found')}</div>}
          <div className="palette-section">{t('Library')}</div>
          <button className={'palette-item' + (active === list.length ? ' active' : '')} onMouseEnter={() => setActive(list.length)} onClick={() => place('new')}>
            <span className="pi-icon">{Icons.plus}</span>
            <span className="pi-label">{t('Create a guideline')}</span>
            <span className="pi-hint" />
          </button>
          <button className={'palette-item' + (active === list.length + 1 ? ' active' : '')} onMouseEnter={() => setActive(list.length + 1)} onClick={() => void importFile()}>
            <span className="pi-icon">{Icons.plus}</span>
            <span className="pi-label">{t('Import .gguide…')}</span>
            <span className="pi-hint" />
          </button>
        </div>
      </div>
    </div>
  )
}
