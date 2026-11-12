// Themed dropdown that replaces native <select> (whose OS popup can't be styled).
// Popup is rendered in a portal with fixed positioning so panels with overflow never clip it.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { t } from './i18n'

export interface SelectOption<T extends string | number> {
  value: T
  label: ReactNode
  /** text used for type-to-search (defaults to label when it is a string) */
  text?: string
  style?: React.CSSProperties
}

interface Props<T extends string | number> {
  value: T | null
  options: SelectOption<T>[]
  onChange: (v: T) => void
  placeholder?: ReactNode
  /** visual variant: 'field' fits inspector fields, 'pill' fits rounded toolbars */
  variant?: 'field' | 'pill'
  prefix?: ReactNode
  searchable?: boolean
  className?: string
  title?: string
  minWidth?: number
}

const Check = (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 6.2l2.3 2.3 4.7-5" />
  </svg>
)
const Chevron = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 4l2.5 2.5L7.5 4" />
  </svg>
)

export function Select<T extends string | number>({ value, options, onChange, placeholder, variant = 'field', prefix, searchable, className, title, minWidth }: Props<T>) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [query, setQuery] = useState('')
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxH: number; up: boolean } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)

  const current = options.find((o) => o.value === value)
  const textOf = (o: SelectOption<T>) => o.text ?? (typeof o.label === 'string' ? o.label : String(o.value))
  const shown = query ? options.filter((o) => textOf(o).toLowerCase().includes(query.toLowerCase())) : options

  useLayoutEffect(() => {
    if (!open || !btn.current) return
    const r = btn.current.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - 8
    const above = r.top - 8
    const want = Math.min(320, options.length * 30 + (searchable ? 44 : 0) + 10)
    const up = below < Math.min(want, 200) && above > below
    const width = Math.max(r.width, minWidth ?? 0)
    // keep the popup inside the window horizontally
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
    setPos({ left, top: up ? r.top - 4 : r.bottom + 4, width, maxH: Math.min(320, up ? above : below), up })
  }, [open, options.length, searchable, minWidth])

  useEffect(() => {
    if (!open) return
    setActive(Math.max(0, options.findIndex((o) => o.value === value)))
    setQuery('')
    const close = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false)
    }
    const onResize = () => setOpen(false)
    window.addEventListener('mousedown', close, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('blur', onResize)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('blur', onResize)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const pick = (o: SelectOption<T>) => {
    onChange(o.value)
    setOpen(false)
    btn.current?.focus()
  }

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(shown.length - 1, a + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(0, a - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (shown[active]) pick(shown[active])
    } else if (!searchable && e.key.length === 1) {
      const i = options.findIndex((o) => textOf(o).toLowerCase().startsWith(e.key.toLowerCase()))
      if (i >= 0) setActive(i)
    }
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        title={title}
        className={`gsel gsel-${variant}${open ? ' open' : ''}${className ? ' ' + className : ''}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKey}
      >
        {prefix && <span className="gsel-prefix">{prefix}</span>}
        <span className="gsel-value" style={current?.style}>
          {current ? current.label : <span className="gsel-ph">{placeholder ?? '—'}</span>}
        </span>
        <span className="gsel-chev">{Chevron}</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={list}
            className={'gsel-pop' + (pos.up ? ' up' : '')}
            style={{ left: pos.left, top: pos.up ? undefined : pos.top, bottom: pos.up ? window.innerHeight - pos.top : undefined, minWidth: pos.width, maxHeight: pos.maxH }}
            onKeyDown={onKey}
          >
            {searchable && (
              <input
                className="gsel-search"
                autoFocus
                placeholder={t('Search')}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setActive(0)
                }}
              />
            )}
            <div className="gsel-list" role="listbox">
              {shown.map((o, i) => (
                <div
                  key={String(o.value)}
                  data-i={i}
                  role="option"
                  aria-selected={o.value === value}
                  className={'gsel-opt' + (i === active ? ' active' : '') + (o.value === value ? ' selected' : '')}
                  style={o.style}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o)}
                >
                  <span className="gsel-check">{o.value === value ? Check : null}</span>
                  <span className="gsel-label">{o.label}</span>
                </div>
              ))}
              {shown.length === 0 && <div className="gsel-empty">—</div>}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
