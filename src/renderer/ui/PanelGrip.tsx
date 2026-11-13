// The edge of a side panel (layers / inspector) that can be dragged to make the panel wider, as in Figma.
// The usual width is the minimum, twice that is the maximum. A double click puts it back.
// The width is remembered on this computer.
import { useEffect, useState } from 'react'

const BASE = 240
const MAX = BASE * 2
const KEY = { left: 'gigma-left-panel-w', right: 'gigma-right-panel-w' }

function stored(side: 'left' | 'right'): number {
  try {
    const v = parseFloat(localStorage.getItem(KEY[side]) ?? '')
    return Number.isFinite(v) ? Math.max(BASE, Math.min(MAX, v)) : BASE
  } catch {
    return BASE
  }
}
/** apply the width to the panel (a CSS variable on the page root, read by .panel.left / .panel.right) */
function apply(side: 'left' | 'right', w: number): void {
  document.documentElement.style.setProperty(`--${side}-panel-w`, w + 'px')
}

export function PanelGrip({ side }: { side: 'left' | 'right' }) {
  const [w, setW] = useState(() => stored(side))
  const [dragging, setDragging] = useState(false)
  useEffect(() => apply(side, w), [side, w])

  const save = (v: number) => {
    setW(v)
    try {
      localStorage.setItem(KEY[side], String(v))
    } catch {
      /* the width simply is not remembered */
    }
  }
  const down = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = w
    setDragging(true)
    const move = (ev: PointerEvent) => {
      const d = (ev.clientX - startX) * (side === 'left' ? 1 : -1)
      const next = Math.round(Math.max(BASE, Math.min(MAX, startW + d)))
      setW(next)
      apply(side, next)
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragging(false)
      const d = (ev.clientX - startX) * (side === 'left' ? 1 : -1)
      save(Math.round(Math.max(BASE, Math.min(MAX, startW + d))))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div className={`panel-grip ${side}` + (dragging ? ' dragging' : '')}>
      <div className="panel-grip-hit" onPointerDown={down} onDoubleClick={() => save(BASE)} />
    </div>
  )
}
