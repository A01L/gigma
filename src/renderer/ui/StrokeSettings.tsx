// Figma's "Stroke settings" popover: style (solid / dashed), width profile, the two end points of an open path,
// how corners are joined and the miter angle. It opens to the left of the inspector, next to the Stroke section.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CapKind, GNode } from '@shared/types'
import { editor as ed } from '../editor/editor'
import { CAP_KINDS, CAP_LABELS, DEFAULT_MITER_ANGLE, PROFILE_LABELS, capsOf, dashOf, isOpenPath, joinOf, type Profile } from '../editor/stroke'
import { Select } from './Select'
import { t } from './i18n'

const sameOf = <T,>(vals: T[]): T | null => (vals.every((v) => v === vals[0]) ? vals[0] : null)

/** a short line with the end it stands for; `start` mirrors it, so the end shows on the left */
export function CapIcon({ kind, start }: { kind: CapKind; start?: boolean }) {
  const x = 22
  const shape =
    kind === 'ROUND' ? (
      <circle cx={x} cy="7" r="3.5" fill="currentColor" stroke="none" />
    ) : kind === 'SQUARE' ? (
      <rect x={x - 3.5} y="3.5" width="7" height="7" fill="currentColor" stroke="none" />
    ) : kind === 'LINE_ARROW' ? (
      <path d={`M${x - 5} 2.5L${x} 7L${x - 5} 11.5`} />
    ) : kind === 'TRIANGLE_ARROW' ? (
      <path d={`M${x + 1} 7L${x - 6} 2.5V11.5Z`} fill="currentColor" stroke="none" />
    ) : kind === 'REVERSED_TRIANGLE' ? (
      <path d={`M${x - 6} 7L${x + 1} 2.5V11.5Z`} fill="currentColor" stroke="none" />
    ) : kind === 'CIRCLE_ARROW' ? (
      <circle cx={x - 2} cy="7" r="4" fill="currentColor" stroke="none" />
    ) : kind === 'DIAMOND_ARROW' ? (
      <path d={`M${x + 2} 7L${x - 2.5} 2.5L${x - 7} 7L${x - 2.5} 11.5Z`} fill="currentColor" stroke="none" />
    ) : null
  return (
    <svg className="cap-icon" width="28" height="14" viewBox="0 0 28 14" fill="none" stroke="currentColor" strokeWidth="1.4" style={start ? { transform: 'scaleX(-1)' } : undefined}>
      <path d={`M2 7H${kind === 'NONE' ? x : x - 2}`} />
      {/* the dotted box of Figma: where the path itself ends */}
      {kind === 'NONE' && <path d={`M${x} 3V11`} strokeDasharray="1.5 1.5" strokeWidth="1" />}
      {shape}
    </svg>
  )
}
export const capOptions = (start: boolean) =>
  CAP_KINDS.map((k) => ({
    value: k,
    text: CAP_LABELS[k],
    label: (
      <span className="cap-opt">
        <CapIcon kind={k} start={start} />
        {t(CAP_LABELS[k])}
      </span>
    )
  }))

/** set the two ends of a path; the older single cap and the arrow flag are folded into them */
export function setCaps(n: GNode, patch: { start?: CapKind; end?: CapKind }): void {
  const now = capsOf(n)
  ed.updateNode(n.id, {
    strokeStartCap: patch.start ?? now.start,
    strokeEndCap: patch.end ?? now.end,
    // corners keep the look the old round cap gave them
    strokeJoin: n.strokeJoin ?? (n.strokeCap === 'ROUND' ? 'ROUND' : undefined),
    strokeCap: undefined,
    arrowEnd: undefined
  })
}

const ProfileIcon = ({ p }: { p: Profile }) => (
  <svg width="64" height="12" viewBox="0 0 64 12" fill="currentColor">
    {p === 'UNIFORM' && <rect x="0" y="4.5" width="64" height="3" rx="1" />}
    {p === 'TAPER' && <path d="M0 2.5L64 6L0 9.5Z" />}
    {p === 'LENS' && <path d="M0 6C16 1 48 1 64 6C48 11 16 11 0 6Z" />}
    {p === 'WEDGE' && <path d="M0 2L64 5V7L0 10Z" />}
  </svg>
)

function Num({ value, min, max, suffix, onCommit }: { value: number | null; min: number; max: number; suffix?: string; onCommit: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null)
  const shown = value === null ? t('Mixed') : String(Math.round(value * 100) / 100) + (suffix ?? '')
  return (
    <input
      className="tset-num"
      value={text ?? shown}
      onFocus={(e) => {
        setText(value === null ? '' : String(Math.round(value * 100) / 100))
        requestAnimationFrame(() => e.target.select())
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const v = parseFloat((text ?? '').replace(',', '.'))
        if (Number.isFinite(v) && v !== value) onCommit(Math.max(min, Math.min(max, v)))
        setText(null)
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

export function StrokeSettings({ nodes, anchor, onClose }: { nodes: GNode[]; anchor: HTMLElement; onClose: () => void }) {
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const pop = useRef<HTMLDivElement>(null)
  const each = (fn: (n: GNode) => void) => ed.act(() => nodes.forEach(fn))
  const set = (patch: Partial<GNode>) => each((n) => ed.updateNode(n.id, patch))

  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const panelLeft = (anchor.closest('.panel') as HTMLElement | null)?.getBoundingClientRect().left ?? r.left
      const H = pop.current?.offsetHeight ?? 360
      setPos({ left: Math.max(8, panelLeft - 280 - 8), top: Math.max(8, Math.min(window.innerHeight - H - 8, r.top - 60)) })
    }
    place()
    // the popover grows when the dash fields appear: it must stay inside the window
    const ro = new ResizeObserver(place)
    if (pop.current) ro.observe(pop.current)
    return () => ro.disconnect()
  }, [anchor])
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const tgt = e.target as HTMLElement
      if (pop.current?.contains(tgt) || anchor.contains(tgt) || tgt.closest?.('.gsel-pop')) return
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

  const dashes = nodes.map(dashOf)
  const dashed = dashes.every((d) => !!d)
  const weight = nodes[0].strokes.find((s) => s.visible !== false)?.weight ?? 1
  const vectors = nodes.every((n) => n.type === 'VECTOR' && !!n.path)
  const open = nodes.every(isOpenPath)
  const caps = nodes.map(capsOf)
  const join = sameOf(nodes.map(joinOf))

  return createPortal(
    <div ref={pop} className="tset stroke-set" style={{ left: pos.left, top: pos.top }} onKeyDown={(e) => e.stopPropagation()}>
      <div className="tset-head">
        <b>{t('Stroke settings')}</b>
        <button className="icon-btn" title={t('Close')} onClick={onClose}>
          <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.3">
            <path d="M2 2l6 6M8 2l-6 6" />
          </svg>
        </button>
      </div>

      <div className="tset-row">
        <span>{t('Style')}</span>
        <div className="field stroke-set-field">
          <Select
            value={dashed ? 'DASH' : 'SOLID'}
            // a new dashed line starts with dashes a few times its weight, as in Figma
            onChange={(v) => set({ dashPattern: v === 'DASH' ? [Math.max(4, weight * 4), Math.max(4, weight * 4)] : undefined, dashCap: v === 'DASH' ? nodes[0].dashCap : undefined })}
            options={[
              {
                value: 'SOLID',
                text: 'Solid',
                label: (
                  <span className="cap-opt">
                    <svg width="20" height="12" viewBox="0 0 20 12" stroke="currentColor" strokeWidth="1.4">
                      <path d="M1 6H19" />
                    </svg>
                    {t('Solid')}
                  </span>
                )
              },
              {
                value: 'DASH',
                text: 'Dashed',
                label: (
                  <span className="cap-opt">
                    <svg width="20" height="12" viewBox="0 0 20 12" stroke="currentColor" strokeWidth="1.4">
                      <path d="M1 6H19" strokeDasharray="4 3" />
                    </svg>
                    {t('Dashed')}
                  </span>
                )
              }
            ]}
          />
        </div>
      </div>
      {dashed && (
        <>
          <div className="tset-row">
            <span>{t('Dash')}</span>
            <Num value={sameOf(dashes.map((d) => d![0]))} min={0.1} max={10000} onCommit={(v) => each((n) => ed.updateNode(n.id, { dashPattern: [v, dashOf(n)?.[1] ?? v] }))} />
          </div>
          <div className="tset-row">
            <span>{t('Gap')}</span>
            <Num value={sameOf(dashes.map((d) => d![1]))} min={0} max={10000} onCommit={(v) => each((n) => ed.updateNode(n.id, { dashPattern: [dashOf(n)?.[0] ?? v, v] }))} />
          </div>
          <div className="tset-row">
            <span>{t('Dash cap')}</span>
            <div className="field stroke-set-field">
              <Select
                value={sameOf(nodes.map((n) => n.dashCap ?? 'NONE'))}
                onChange={(v) => set({ dashCap: v === 'NONE' ? undefined : v })}
                options={(['NONE', 'SQUARE', 'ROUND'] as const).map((k) => ({ value: k, label: t(CAP_LABELS[k]) }))}
              />
            </div>
          </div>
        </>
      )}
      {vectors && (
        <div className="tset-row">
          <span>{t('Width profile')}</span>
          <div className="stroke-set-pair">
            <div className="field stroke-set-field">
              <Select
                value={sameOf(nodes.map((n) => n.strokeProfile ?? 'UNIFORM'))}
                onChange={(v) => set({ strokeProfile: v === 'UNIFORM' ? undefined : v, strokeProfileFlip: v === 'UNIFORM' ? undefined : nodes[0].strokeProfileFlip })}
                options={(Object.keys(PROFILE_LABELS) as Profile[]).map((p) => ({ value: p, text: PROFILE_LABELS[p], label: <span className="cap-opt" title={t(PROFILE_LABELS[p])}><ProfileIcon p={p} /></span> }))}
              />
            </div>
            <button
              className={'icon-btn' + (nodes.every((n) => n.strokeProfileFlip) ? ' active-soft' : '')}
              title={t('Flip profile')}
              disabled={nodes.every((n) => !n.strokeProfile || n.strokeProfile === 'UNIFORM')}
              onClick={() => each((n) => ed.updateNode(n.id, { strokeProfileFlip: n.strokeProfileFlip ? undefined : true }))}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinejoin="round">
                <path d="M8 2v12" strokeDasharray="1.5 1.5" />
                <path d="M6 5L2.5 8L6 11ZM10 5l3.5 3L10 11Z" />
              </svg>
            </button>
          </div>
        </div>
      )}
      {open && (
        <>
          <div className="stroke-set-line" />
          <div className="tset-row">
            <span>{t('End points')}</span>
            <div className="stroke-set-pair">
              <div className="field cap-field" title={t('Start point')}>
                <Select value={sameOf(caps.map((c) => c.start))} minWidth={190} onChange={(v) => each((n) => setCaps(n, { start: v }))} options={capOptions(true)} />
              </div>
              <div className="field cap-field" title={t('End point')}>
                <Select value={sameOf(caps.map((c) => c.end))} minWidth={190} onChange={(v) => each((n) => setCaps(n, { end: v }))} options={capOptions(false)} />
              </div>
            </div>
          </div>
        </>
      )}
      <div className="stroke-set-line" />
      <div className="tset-row">
        <span>{t('Join')}</span>
        <div className="seg">
          {(
            [
              ['miter', 'Miter', 'M3 13V3H13'],
              ['bevel', 'Bevel', 'M3 13V7L7 3H13'],
              ['round', 'Round', 'M3 13V9A6 6 0 0 1 9 3H13']
            ] as const
          ).map(([v, label, d]) => (
            <button key={v} title={t(label)} className={join === v ? 'on' : ''} onClick={() => set({ strokeJoin: v === 'miter' ? 'MITER' : v === 'bevel' ? 'BEVEL' : 'ROUND' })}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                <path d={d} />
              </svg>
            </button>
          ))}
        </div>
      </div>
      {join === 'miter' && (
        <div className="tset-row">
          <span>{t('Miter angle')}</span>
          <Num value={sameOf(nodes.map((n) => n.strokeMiterAngle ?? DEFAULT_MITER_ANGLE))} min={1} max={180} suffix="°" onCommit={(v) => set({ strokeMiterAngle: Math.abs(v - DEFAULT_MITER_ANGLE) < 0.005 ? undefined : v })} />
        </div>
      )}
    </div>,
    document.body
  )
}
