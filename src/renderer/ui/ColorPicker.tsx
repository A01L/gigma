// Colour picker laid out like Figma's fill popover:
// Custom / Libraries tabs, fill types, the colour square, eyedropper + hue + opacity,
// a value row with a format switch (Hex, RGB, HSL, HSB, CSS) and the colours used on the page.
// It can be dragged by its header and closes with the cross, Escape or a click outside.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GradientPaint, GradientType, RGBA } from '@shared/types'
import { hexToRgba, rgbaToCss, rgbaToHex } from '@shared/types'
import { editor as ed } from '../editor/editor'
import { colorAt, flipped, rotated, sortedStops } from '../editor/gradient'
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
  /** shows the fill types (fills only): the paint becomes a solid colour or a gradient of that kind */
  onType?: (t: 'SOLID' | GradientType) => void
  /**
   * The fill is a gradient: the popover shows its kind, its bar of colour stops and their list, and the colour
   * controls below edit the selected stop. `set` is live, inside the transaction the popover was opened in.
   */
  gradient?: {
    paint: GradientPaint
    /** index of the selected stop in paint.stops */
    stop: number
    select: (i: number) => void
    set: (p: GradientPaint) => void
    /** size of the layer, for turning the gradient */
    w: number
    h: number
  }
}

const GRADIENT_LABELS: Record<GradientType, string> = { GRADIENT_LINEAR: 'Linear', GRADIENT_RADIAL: 'Radial', GRADIENT_ANGULAR: 'Angular', GRADIENT_DIAMOND: 'Diamond' }
export const gradientLabel = (type: GradientType): string => GRADIENT_LABELS[type]

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

/** the hex of a colour stop in the list: applied on Enter or when the field is left */
function StopHex({ color, onCommit }: { color: RGBA; onCommit: (c: RGBA) => void }) {
  const [text, setText] = useState<string | null>(null)
  const hex = rgbaToHex(color).slice(1).toUpperCase()
  return (
    <input
      className="cpick-input"
      value={text ?? hex}
      onFocus={(e) => {
        setText(hex)
        requestAnimationFrame(() => e.target.select())
      }}
      onChange={(e) => setText(e.target.value.toUpperCase())}
      onBlur={() => {
        const raw = (text ?? '').trim().replace('#', '')
        if (/^[0-9a-f]{3,8}$/i.test(raw) && raw.toUpperCase() !== hex) onCommit({ ...hexToRgba(raw), a: raw.length === 8 ? hexToRgba(raw).a : color.a })
        setText(null)
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
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
  gradient: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5 5h.01M8 5h.01M11 5h.01M6.5 6.5h.01M9.5 6.5h.01M5 8h.01M8 8h.01M11 8h.01M6.5 9.5h.01M9.5 9.5h.01M8 11h.01" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  flip: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 5.5h10M10.5 3L13 5.5 10.5 8M13 10.5H3M5.5 8L3 10.5 5.5 13" />
    </svg>
  ),
  rotate: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.8l4.2 4.2L8 10.2 3.8 6zM3.5 11.5a6 6 0 009 0M12.5 9.6v2h-2" />
    </svg>
  ),
  dropper: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinejoin="round" strokeLinecap="round">
      <path d="M9.2 4.2l2.6 2.6M10.5 3a1.84 1.84 0 012.6 2.6l-1.7 1.6-2.5-2.5zM9.8 5.6L4 11.4 3.3 13l1.6-.7 5.8-5.8" />
    </svg>
  )
}

export function ColorPicker({ color, anchor, onChange, onClose, onType, gradient }: Props) {
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
  // another stop was selected (or the fill changed its kind): the controls show that colour
  const shown = gradient ? gradient.stop + ':' + gradient.paint.stops.length : 'solid'
  const first = useRef(shown)
  useEffect(() => {
    if (first.current === shown) return
    first.current = shown
    setHsv(rgbToHsv(color))
    setHex(rgbaToHex(color).slice(1).toUpperCase())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown])

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
      // a press on a handle of the gradient on the canvas belongs to the gradient
      if ((window as unknown as { canvasView?: { gradBusy(): boolean } }).canvasView?.gradBusy()) return
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

  // ---- gradient: the bar of stops
  const g = gradient
  const setStops = (stops: GradientPaint['stops']) => g?.set({ ...g.paint, stops })
  const addStop = (t: number) => {
    if (!g) return
    const stops = [...g.paint.stops, { position: Math.round(t * 100) / 100, color: colorAt(g.paint.stops, t) }]
    g.set({ ...g.paint, stops })
    g.select(stops.length - 1)
  }
  const removeStop = (i: number) => {
    if (!g || g.paint.stops.length <= 2) return
    setStops(g.paint.stops.filter((_, k) => k !== i))
    g.select(Math.max(0, i - 1))
  }
  /** drag a stop along the bar; a press on the empty bar adds one first */
  const dragStop = (bar: HTMLElement, e: React.PointerEvent, index: number | null) => {
    if (!g) return
    e.stopPropagation()
    const r = bar.getBoundingClientRect()
    const at = (x: number) => Math.round(Math.min(1, Math.max(0, (x - r.left - 10) / (r.width - 20))) * 100) / 100
    let stops = g.paint.stops
    let i = index
    if (i === null) {
      const t = at(e.clientX)
      stops = [...stops, { position: t, color: colorAt(stops, t) }]
      i = stops.length - 1
      g.set({ ...g.paint, stops })
    }
    g.select(i)
    const move = (ev: PointerEvent) => {
      stops = stops.map((s, k) => (k === i ? { ...s, position: at(ev.clientX) } : s))
      g.set({ ...g.paint, stops })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  // the list shows the stops from the first to the last, whatever order they were added in
  const stopRows = g ? g.paint.stops.map((s, i) => ({ s, i })).sort((a, b) => a.s.position - b.s.position || a.i - b.i) : []

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
    <div
      ref={pop}
      className={'cpick' + (g ? ' grad' : '')}
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={(e) => {
        e.stopPropagation()
        // Delete removes the selected stop of a gradient (not while a value is being typed)
        const el = e.target as HTMLElement
        if (g && (e.key === 'Delete' || e.key === 'Backspace') && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
          e.preventDefault()
          removeStop(g.stop)
        }
      }}
    >
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
              <button className={g ? '' : 'on'} title={t('Solid')} onClick={() => g && onType('SOLID')}>
                {TypeIcon.solid}
              </button>
              <button className={g ? 'on' : ''} title={t('Gradient')} onClick={() => !g && onType('GRADIENT_LINEAR')}>
                {TypeIcon.gradient}
              </button>
            </div>
          )}
          {g && (
            <div className="cpick-grad">
              <div className="cpick-grad-top">
                <div className="cpick-grad-type" data-cpick-menu>
                  <Select
                    value={g.paint.type}
                    onChange={(v) => onType?.(v as GradientType)}
                    options={(Object.keys(GRADIENT_LABELS) as GradientType[]).map((k) => ({ value: k, label: t(GRADIENT_LABELS[k]) }))}
                  />
                </div>
                <span className="cpick-grow" />
                <button className="cpick-ico" title={t('Flip gradient')} onClick={() => g.set(flipped(g.paint))}>
                  {TypeIcon.flip}
                </button>
                <button className="cpick-ico" title={t('Rotate gradient 90°')} onClick={() => g.set(rotated(g.paint, g.w, g.h))}>
                  {TypeIcon.rotate}
                </button>
              </div>
              <div className="cpick-bar" onPointerDown={(e) => dragStop(e.currentTarget, e, null)}>
                <div className="cpick-bar-track">
                  {/* the colours run between the places of the first and the last thumb */}
                  <div style={{ background: `linear-gradient(90deg, ${sortedStops(g.paint.stops).map((s) => `${rgbaToCss(s.color)} calc(10px + (100% - 20px) * ${Math.min(1, Math.max(0, s.position))})`).join(', ')})` }} />
                </div>
                {g.paint.stops.map((s, i) => (
                  <button
                    key={i}
                    className={'cpick-thumb' + (i === g.stop ? ' on' : '')}
                    style={{ left: `calc(10px + (100% - 20px) * ${Math.min(1, Math.max(0, s.position))})`, zIndex: i === g.stop ? 2 : 1 }}
                    onPointerDown={(e) => dragStop(e.currentTarget.parentElement!, e, i)}
                  >
                    <i style={{ background: rgbaToCss(s.color) }} />
                  </button>
                ))}
              </div>
              <div className="cpick-stops-head">
                <span>{t('Stops')}</span>
                <button
                  className="cpick-ico"
                  title={t('Add stop')}
                  onClick={() => {
                    // between the selected stop and the next one (or the one before the last)
                    const k = stopRows.findIndex((r) => r.i === g.stop)
                    const a = stopRows[k] ?? stopRows[0]
                    const b = stopRows[k + 1] ?? stopRows[k - 1] ?? a
                    addStop((a.s.position + b.s.position) / 2)
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor">
                    <path d="M7 2.5v9M2.5 7h9" />
                  </svg>
                </button>
              </div>
              <div className="cpick-stops">
                {stopRows.map(({ s, i }) => (
                  <div key={i} className={'cpick-stop' + (i === g.stop ? ' on' : '')} onPointerDown={() => g.select(i)}>
                    <Num value={s.position * 100} max={100} suffix="%" onCommit={(v) => setStops(g.paint.stops.map((x, k) => (k === i ? { ...x, position: v / 100 } : x)))} />
                    <div className="cpick-stop-color">
                      <i>
                        <b style={{ background: rgbaToCss(s.color) }} />
                      </i>
                      <StopHex color={s.color} onCommit={(c) => setStops(g.paint.stops.map((x, k) => (k === i ? { ...x, color: c } : x)))} />
                    </div>
                    <Num value={s.color.a * 100} max={100} suffix="%" onCommit={(v) => setStops(g.paint.stops.map((x, k) => (k === i ? { ...x, color: { ...x.color, a: v / 100 } } : x)))} />
                    <button className="cpick-ico" title={t('Remove')} disabled={g.paint.stops.length <= 2} onClick={() => removeStop(i)}>
                      <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor">
                        <path d="M3 7h8" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
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
