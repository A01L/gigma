// Themed color picker popover (replaces the OS color dialog of <input type="color">).
// Saturation/brightness square + hue slider + alpha slider + hex input, Figma-style.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RGBA } from '@shared/types'
import { hexToRgba, rgbaToCss, rgbaToHex } from '@shared/types'
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

interface Props {
  color: RGBA
  anchor: HTMLElement
  onChange: (c: RGBA) => void // live (inside an open transaction)
  onClose: () => void
  /** shows Solid / Linear / Radial tabs (fills only) */
  onType?: (t: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL') => void
}

export function ColorPicker({ color, anchor, onChange, onClose, onType }: Props) {
  const [hsv, setHsv] = useState<HSVA>(() => rgbToHsv(color))
  const [hex, setHex] = useState(rgbaToHex(color).slice(1).toUpperCase())
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const pop = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect()
    const W = 240
    const H = 300
    let left = r.left - W - 12
    if (left < 8) left = Math.min(window.innerWidth - W - 8, r.right + 12)
    const top = Math.max(8, Math.min(window.innerHeight - H - 8, r.top - 40))
    setPos({ left, top })
  }, [anchor])

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!pop.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose()
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

  const drag = (el: HTMLElement, e: React.PointerEvent, fn: (x: number, y: number) => void) => {
    el.setPointerCapture(e.pointerId)
    const r = el.getBoundingClientRect()
    const run = (ev: { clientX: number; clientY: number }) =>
      fn(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)))
    run(e)
    const move = (ev: PointerEvent) => run(ev)
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const hueColor = `hsl(${hsv.h}, 100%, 50%)`
  const solid = hsvToRgb({ ...hsv, a: 1 })

  return createPortal(
    <div ref={pop} className="cpick" style={{ left: pos.left, top: pos.top }} onKeyDown={(e) => e.stopPropagation()}>
      {onType && (
        <div className="text-tabs cpick-tabs">
          <button className="on">{t('Solid')}</button>
          <button onClick={() => onType('GRADIENT_LINEAR')}>{t('Linear')}</button>
          <button onClick={() => onType('GRADIENT_RADIAL')}>{t('Radial')}</button>
        </div>
      )}
      <div
        className="cpick-sv"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})` }}
        onPointerDown={(e) => drag(e.currentTarget, e, (x, y) => apply({ ...hsv, s: x, v: 1 - y }))}
      >
        <div className="cpick-dot" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: rgbaToCss(solid) }} />
      </div>
      <div className="cpick-slider hue" onPointerDown={(e) => drag(e.currentTarget, e, (x) => apply({ ...hsv, h: x * 360 }))}>
        <div className="cpick-knob" style={{ left: `${(hsv.h / 360) * 100}%`, background: hueColor }} />
      </div>
      <div className="cpick-slider alpha" onPointerDown={(e) => drag(e.currentTarget, e, (x) => apply({ ...hsv, a: Math.round(x * 100) / 100 }))}>
        <div className="cpick-alpha-fill" style={{ background: `linear-gradient(to right, transparent, ${rgbaToCss(solid)})` }} />
        <div className="cpick-knob" style={{ left: `${hsv.a * 100}%`, background: rgbaToCss({ ...solid, a: hsv.a }) }} />
      </div>
      <div className="cpick-row">
        <span className="cpick-label">HEX</span>
        <input
          className="cpick-input"
          value={hex}
          onChange={(e) => setHex(e.target.value.toUpperCase())}
          onBlur={() => {
            if (/^#?[0-9a-f]{3,8}$/i.test(hex.trim())) apply(rgbToHsv({ ...hexToRgba(hex.trim()), a: hex.trim().replace('#', '').length === 8 ? hexToRgba(hex.trim()).a : hsv.a }))
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <input
          className="cpick-input pct"
          value={Math.round(hsv.a * 100) + '%'}
          onChange={(e) => {
            const v = parseInt(e.target.value)
            if (!isNaN(v)) apply({ ...hsv, a: Math.min(100, Math.max(0, v)) / 100 })
          }}
        />
      </div>
    </div>,
    document.body
  )
}
