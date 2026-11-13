// Colour picker laid out like Figma's fill popover:
// Custom / Libraries tabs, fill types, the colour square, eyedropper + hue + opacity,
// a value row with a format switch (Hex, RGB, HSL, HSB, CSS) and the colours used on the page.
// It can be dragged by its header and closes with the cross, Escape or a click outside.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RGBA } from '@shared/types'
import { hexToRgba, rgbaToCss, rgbaToHex } from '@shared/types'
import { editor as ed } from '../editor/editor'
import { Select } from './Select'
import { t } from './i18n'

interface HSVA {
  h: number // 0..360
  s: number // 0..1
  v: number // 0..1
  a: number // 0..1
}

function rgbToHsv({ r, g, b, a }: RGBA): HSVA {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max ? d / max : 0, v: max, a }
}

function hsvToRgb({ h, s, v, a }: HSVA): RGBA {
  const f = (n: number) => {
    const k = (n + h / 60) % 6
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
  }
  return { r: f(5), g: f(3), b: f(1), a }
}
/** HSV -> HSL (h stays) */
const hsvToHsl = ({ s, v }: HSVA) => {
  const l = v * (1 - s / 2)
  return { s: l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l), l }
}
const hslToHsv = (s: number, l: number) => {
  const v = l + s * Math.min(l, 1 - l)
  return { s: v === 0 ? 0 : 2 * (1 - l / v), v }
}

type Format = 'HEX' | 'RGB' | 'HSL' | 'HSB' | 'CSS'
/** the format stays as chosen while the app runs, like in Figma */
let lastFormat: Format = 'HEX'
/** the popover stays where it was dragged to */
let lastPos: { left: number; top: number } | null = null

interface Props {
  color: RGBA
  anchor: HTMLElement
  onChange: (c: RGBA) => void // live (inside an open transaction)
  onClose: () => void
  /** shows the fill types (fills only) */
  onType?: (t: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL') => void
}

/** number box that applies on Enter / blur and steps with the arrow keys */
function Num({ value, max, onCommit, suffix }: { value: number; max: number; onCommit: (v: number) => void; suffix?: string }) {
  const [text, setText] = useState<string | null>(null)
  const commit = (raw: string) => {
    const v = parseFloat(raw)
    if (Number.isFinite(v)) onCommit(Math.max(0, Math.min(max, v)))
    setText(null)
  }
  return (
    <input
      className="cpick-input num"
      value={text ?? String(Math.round(value)) + (suffix ?? '')}
      onFocus={(e) => {
        setText(String(Math.round(value)))
        requestAnimationFrame(() => e.target.select())
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          const next = Math.max(0, Math.min(max, Math.round(value) + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)))
          onCommit(next)
          setText(String(next))
        }
      }}
    />
  )
}

const TypeIcon = {
  solid: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <rect x="5" y="5" width="6" height="6" rx="0.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  linear: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5 11h.01M5 8h.01M8 11h.01M8 8h.01M11 8h.01M8 5h.01M11 5h.01M11 11h.01M5 5h.01" strokeWidth="1.6" strokeLinecap="round" opacity="0.55" />
      <path d="M5 11h.01M8 11h.01M5 8h.01" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  radial: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <circle cx="8" cy="8" r="3" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  ),
  dropper: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinejoin="round" strokeLinecap="round">
      <path d="M9.2 4.2l2.6 2.6M10.5 3a1.84 1.84 0 012.6 2.6l-1.7 1.6-2.5-2.5zM9.8 5.6L4 11.4 3.3 13l1.6-.7 5.8-5.8" />
    </svg>
  )
}

export function ColorPicker({ color, anchor, onChange, onClose, onType }: Props) {
  const [hsv, setHsv] = useState<HSVA>(() => rgbToHsv(color))
  const [hex, setHex] = useState(rgbaToHex(color).slice(1).toUpperCase())
  const [pos, setPos] = useState(lastPos ?? { left: 0, top: 0 })
  const [tab, setTab] = useState<'custom' | 'libraries'>('custom')
  const [format, setFormatState] = useState<Format>(lastFormat)
  const [source, setSource] = useState<'page' | 'document'>('page')
  const [css, setCss] = useState<string | null>(null)
  const pop = useRef<HTMLDivElement>(null)
  /** the system eyedropper is open: clicks on the screen belong to it */
  const dropping = useRef(false)
  const setFormat = (f: Format) => {
    lastFormat = f
    setFormatState(f)
  }

  useLayoutEffect(() => {
    if (lastPos) return
    const r = anchor.getBoundingClientRect()
    const W = 264
    const H = pop.current?.offsetHeight ?? 520
    // like Figma: to the left of the panel, level with the row
    const panel = anchor.closest('.panel')?.getBoundingClientRect()
    let left = (panel?.left ?? r.left) - W - 8
    if (left < 8) left = Math.min(window.innerWidth - W - 8, r.right + 12)
    setPos({ left, top: Math.max(8, Math.min(window.innerHeight - H - 8, r.top - 60)) })
  }, [anchor])

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (dropping.current) return
      const el = e.target as HTMLElement
      // menus of the popover (format, source) live in their own layer
      if (pop.current?.contains(el) || anchor.contains(el) || el.closest('.gsel-menu, .gsel-pop, [data-cpick-menu]')) return
      onClose()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [anchor, onClose])

  const apply = (next: HSVA) => {
    setHsv(next)
    const rgb = hsvToRgb(next)
    setHex(rgbaToHex(rgb).slice(1).toUpperCase())
    onChange(rgb)
  }
  const applyRgb = (c: RGBA) => apply(rgbToHsv(c))

  // inset: the knob of a slider stays inside its rounded ends, so the track is shorter than the element
  const drag = (el: HTMLElement, e: React.PointerEvent, fn: (x: number, y: number) => void, inset = 0) => {
    el.setPointerCapture(e.pointerId)
    const r = el.getBoundingClientRect()
    const run = (ev: { clientX: number; clientY: number }) =>
      fn(Math.min(1, Math.max(0, (ev.clientX - r.left - inset) / (r.width - inset * 2))), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)))
    run(e)
    const move = (ev: PointerEvent) => run(ev)
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
  /** drag the whole popover by its header */
  const movePopover = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    const start = { x: e.clientX, y: e.clientY, ...pos }
    const move = (ev: PointerEvent) => {
      const next = {
        left: Math.max(4, Math.min(window.innerWidth - 60, start.left + ev.clientX - start.x)),
        top: Math.max(4, Math.min(window.innerHeight - 40, start.top + ev.clientY - start.y))
      }
      lastPos = next
      setPos(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const pickFromScreen = async () => {
    const Dropper = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper
    if (!Dropper) return
    dropping.current = true
    try {
      const r = await new Dropper().open()
      applyRgb({ ...hexToRgba(r.sRGBHex), a: hsv.a })
    } catch {
      /* cancelled with Escape */
    } finally {
      // the click that picked the colour must not count as a click outside
      setTimeout(() => (dropping.current = false), 150)
    }
  }

  const hueColor = `hsl(${hsv.h}, 100%, 50%)`
  const solid = hsvToRgb({ ...hsv, a: 1 })
  const rgb255 = [solid.r, solid.g, solid.b].map((v) => Math.round(v * 255))
  const hsl = hsvToHsl(hsv)
  const cssText = hsv.a < 1 ? `rgba(${rgb255.join(', ')}, ${+hsv.a.toFixed(2)})` : `#${hex}`

  // colours of the solid fills and strokes on this page, most used first
  const pageColors = useMemo(() => {
    const count = new Map<string, { color: RGBA; n: number }>()
    const add = (c: RGBA) => {
      const k = rgbaToHex(c) + Math.round(c.a * 100)
      const e = count.get(k)
      if (e) e.n++
      else count.set(k, { color: c, n: 1 })
    }
    for (const n of ed.nodes.values()) {
      if (n.pageId !== ed.currentPageId || n.type === 'SPEC' || n.type === 'GUIDE' || n.type === 'ANNOTATION') continue
      for (const f of n.fills) if (f.type === 'SOLID' && f.visible !== false) add(f.color)
      for (const s of n.strokes) if (s.visible !== false) add(s.color)
    }
    return [...count.values()].sort((a, b) => b.n - a.n).slice(0, 48)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const styles = ed.meta.colorStyles ?? []

  const saveAsStyle = () => {
    const c = hsvToRgb(hsv)
    ed.setColorStyles([...styles, { id: crypto.randomUUID(), name: '#' + hex, color: c }])
    setTab('libraries')
  }
  const swatches = (list: { color: RGBA; title: string; key: string }[]) => (
    <div className="cpick-swatches">
      {list.map((s) => (
        <button key={s.key} title={s.title} onClick={() => applyRgb(s.color)}>
          <i style={{ background: rgbaToCss(s.color) }} />
        </button>
      ))}
    </div>
  )

  return createPortal(
    <div ref={pop} className="cpick" style={{ left: pos.left, top: pos.top }} onKeyDown={(e) => e.stopPropagation()}>
      <div className="cpick-head" onPointerDown={movePopover}>
        <button className={tab === 'custom' ? 'on' : ''} onClick={() => setTab('custom')}>
          {t('Custom')}
        </button>
        <button className={tab === 'libraries' ? 'on' : ''} onClick={() => setTab('libraries')}>
          {t('Libraries')}
        </button>
        <span className="cpick-grow" />
        <button className="cpick-ico" title={t('Save as a style')} onClick={saveAsStyle}>
          <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor">
            <path d="M7 1.5v11M1.5 7h11" />
          </svg>
        </button>
        <button className="cpick-ico" title={t('Close')} onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor">
            <path d="M2.5 2.5l9 9M11.5 2.5l-9 9" />
          </svg>
        </button>
      </div>

      {tab === 'custom' ? (
        <>
          {onType && (
            <div className="cpick-types">
              <button className="on" title={t('Solid')}>
                {TypeIcon.solid}
              </button>
              <button title={t('Linear')} onClick={() => onType('GRADIENT_LINEAR')}>
                {TypeIcon.linear}
              </button>
              <button title={t('Radial')} onClick={() => onType('GRADIENT_RADIAL')}>
                {TypeIcon.radial}
              </button>
            </div>
          )}
          <div className="cpick-body">
            <div
              className="cpick-sv"
              style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})` }}
              onPointerDown={(e) => drag(e.currentTarget, e, (x, y) => apply({ ...hsv, s: x, v: 1 - y }))}
            >
              <div className="cpick-dot" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: rgbaToCss(solid) }} />
            </div>
            <div className="cpick-sliders">
              <button className="cpick-ico" title={t('Pick a colour from the screen')} onClick={() => void pickFromScreen()}>
                {TypeIcon.dropper}
              </button>
              <div className="cpick-stack">
                <div className="cpick-slider hue" onPointerDown={(e) => drag(e.currentTarget, e, (x) => apply({ ...hsv, h: x * 360 }), 8)}>
                  <div className="cpick-knob" style={{ left: `calc(8px + (100% - 16px) * ${hsv.h / 360})`, background: hueColor }} />
                </div>
                <div className="cpick-slider alpha" onPointerDown={(e) => drag(e.currentTarget, e, (x) => apply({ ...hsv, a: Math.round(x * 100) / 100 }), 8)}>
                  <div className="cpick-alpha-fill" style={{ background: `linear-gradient(to right, transparent, ${rgbaToCss(solid)})` }} />
                  <div className="cpick-knob" style={{ left: `calc(8px + (100% - 16px) * ${hsv.a})`, background: rgbaToCss({ ...solid, a: hsv.a }) }} />
                </div>
              </div>
            </div>
            <div className="cpick-row">
              <div className="cpick-format" data-cpick-menu>
                <Select
                  value={format}
                  onChange={(v) => setFormat(v as Format)}
                  options={[
                    { value: 'HEX', label: 'Hex' },
                    { value: 'RGB', label: 'RGB' },
                    { value: 'HSL', label: 'HSL' },
                    { value: 'HSB', label: 'HSB' },
                    { value: 'CSS', label: 'CSS' }
                  ]}
                />
              </div>
              <div className="cpick-values">
                {format === 'HEX' && (
                  <input
                    className="cpick-input"
                    value={hex}
                    onFocus={(e) => requestAnimationFrame(() => e.target.select())}
                    onChange={(e) => setHex(e.target.value.toUpperCase())}
                    onBlur={() => {
                      const raw = hex.trim().replace('#', '')
                      if (/^[0-9a-f]{3,8}$/i.test(raw)) applyRgb({ ...hexToRgba(raw), a: raw.length === 8 ? hexToRgba(raw).a : hsv.a })
                      else setHex(rgbaToHex(hsvToRgb(hsv)).slice(1).toUpperCase())
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                  />
                )}
                {format === 'RGB' && rgb255.map((v, i) => <Num key={i} value={v} max={255} onCommit={(n) => applyRgb({ r: (i === 0 ? n : rgb255[0]) / 255, g: (i === 1 ? n : rgb255[1]) / 255, b: (i === 2 ? n : rgb255[2]) / 255, a: hsv.a })} />)}
                {format === 'HSL' && (
                  <>
                    <Num value={hsv.h} max={360} onCommit={(n) => apply({ ...hsv, h: n })} />
                    <Num value={hsl.s * 100} max={100} onCommit={(n) => apply({ ...hsv, ...hslToHsv(n / 100, hsl.l) })} />
                    <Num value={hsl.l * 100} max={100} onCommit={(n) => apply({ ...hsv, ...hslToHsv(hsl.s, n / 100) })} />
                  </>
                )}
                {format === 'HSB' && (
                  <>
                    <Num value={hsv.h} max={360} onCommit={(n) => apply({ ...hsv, h: n })} />
                    <Num value={hsv.s * 100} max={100} onCommit={(n) => apply({ ...hsv, s: n / 100 })} />
                    <Num value={hsv.v * 100} max={100} onCommit={(n) => apply({ ...hsv, v: n / 100 })} />
                  </>
                )}
                {format === 'CSS' && (
                  <input
                    className="cpick-input"
                    value={css ?? cssText}
                    onFocus={(e) => {
                      setCss(cssText)
                      requestAnimationFrame(() => e.target.select())
                    }}
                    onChange={(e) => setCss(e.target.value)}
                    onBlur={() => {
                      // let the browser read any CSS colour: names, rgb(), hsl(), hex
                      const probe = document.createElement('span')
                      probe.style.color = (css ?? '').trim()
                      if (probe.style.color) {
                        document.body.appendChild(probe)
                        const m = getComputedStyle(probe).color.match(/[\d.]+/g)
                        probe.remove()
                        if (m) applyRgb({ r: +m[0] / 255, g: +m[1] / 255, b: +m[2] / 255, a: m[3] !== undefined ? +m[3] : 1 })
                      }
                      setCss(null)
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                  />
                )}
                {format !== 'CSS' && <Num value={hsv.a * 100} max={100} suffix="%" onCommit={(n) => apply({ ...hsv, a: n / 100 })} />}
              </div>
            </div>
          </div>
          <div className="cpick-page">
            <div className="cpick-source" data-cpick-menu>
              <Select
                value={source}
                onChange={(v) => setSource(v as 'page' | 'document')}
                options={[
                  { value: 'page', label: t('On this page') },
                  { value: 'document', label: t('Document styles') }
                ]}
              />
            </div>
            {source === 'page'
              ? pageColors.length
                ? swatches(pageColors.map((c, i) => ({ color: c.color, key: String(i), title: rgbaToHex(c.color).toUpperCase() + (c.color.a < 1 ? ` ${Math.round(c.color.a * 100)}%` : '') })))
                : <div className="cpick-empty">{t('No colours on this page yet')}</div>
              : styles.length
                ? swatches(styles.map((s) => ({ color: s.color, key: s.id, title: s.name })))
                : <div className="cpick-empty">{t('No colour styles yet. The plus above saves the current colour as a style.')}</div>}
          </div>
        </>
      ) : (
        <div className="cpick-libs">
          {!styles.length && <div className="cpick-empty">{t('No colour styles yet. The plus above saves the current colour as a style.')}</div>}
          {styles.map((s) => (
            <button key={s.id} className="cpick-lib" onClick={() => applyRgb(s.color)}>
              <i style={{ background: rgbaToCss(s.color) }} />
              <span>{s.name}</span>
              <em>{rgbaToHex(s.color).slice(1).toUpperCase()}</em>
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body
  )
}
