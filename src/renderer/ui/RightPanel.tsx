import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BlendMode, Constraint, Effect, EffectType, GNode, GradientPaint, GradientType, Paint, RGBA, SpecData } from '@shared/types'
import { BLEND_MODES, defaultEffect, hexToRgba, rgbaToCss, rgbaToHex } from '@shared/types'
import { isAutoLayout } from '../editor/autolayout'
import { BOOLEAN_NAMES, layerActions } from './layerActions'
import { isBooleanGroup } from '../editor/boolean'
import { editor as ed, parseVariant, variantName } from '../editor/editor'
import { useEditor } from './hooks'
import { BoolIcons, Icons } from './icons'
import { exportFramesPdf, exportPdf, exportSelectionPng, exportSelectionSvg, restoreFigmaImages, runAction } from './actions'
import { replaceImageFill } from '../editor/figma-images'
import { isImageMissing } from '../editor/render'
import { round2 } from '../editor/util'
import { DEFAULT_TEXT_STYLE } from '../editor/text'
import { backend } from '../backend'
import { t, useT } from './i18n'
import { Select } from './Select'
import { ColorPicker, gradientLabel } from './ColorPicker'
import { handlesOf, previewCss } from '../editor/gradient'
import { maxShapeRadius } from '../editor/shapes'
import { TypeSettings } from './TypeSettings'
import { StrokeSettings, capOptions, setCaps } from './StrokeSettings'
import { capsOf, isOpenPath } from '../editor/stroke'
import { GuideInspector } from './GuideInspector'

type Mixed = number | 'mixed'

const same = <T,>(vals: T[]): T | 'mixed' => (vals.every((v) => v === vals[0]) ? vals[0] : 'mixed')
/** the id shared by the whole selection, or null */
const sameId = (ids: (string | null)[]): string | null => (ids.every((v) => v === ids[0]) ? ids[0] : null)

/**
 * Undo keys pressed inside a field of the inspector. With nothing typed in the field they belong to the
 * canvas (Figma does the same); with typed text they stay with the field. Returns true when handled.
 */
function undoFromField(e: React.KeyboardEvent<HTMLInputElement>, dirty: boolean): boolean {
  if (!(e.ctrlKey || e.metaKey) || dirty) return false
  const redo = (e.code === 'KeyZ' && e.shiftKey) || e.code === 'KeyY'
  if (e.code !== 'KeyZ' && !redo) return false
  e.preventDefault()
  ;(e.target as HTMLInputElement).blur()
  runAction(redo ? 'redo' : 'undo')
  return true
}

/** Number input with Figma-like label scrubbing. `apply` runs inside a transaction. */
function NumberField({ label, value, apply, min, step = 1, suffix }: { label: React.ReactNode; value: Mixed; apply: (v: number) => void; min?: number; step?: number; suffix?: string }) {
  const [text, setText] = useState('')
  const [focus, setFocus] = useState(false)
  const shown = value === 'mixed' ? t('Mixed') : String(round2(value)) + (suffix ?? '')
  const commit = (raw: string) => {
    let v: number
    try {
      // allow simple math like Figma: 100+20, 50*2
      v = Function(`"use strict";return (${raw.replace(/[^-+*/().\d\s]/g, '')})`)() as number
    } catch {
      return
    }
    if (!Number.isFinite(v)) return
    if (min !== undefined) v = Math.max(min, v)
    ed.act(() => apply(v))
  }
  const scrub = useRef<{ x: number; v: number } | null>(null)
  /** true once the user has typed in the focused field */
  const dirty = useRef(false)
  return (
    <label className="field">
      <span
        className="lbl"
        onPointerDown={(e) => {
          if (value === 'mixed') return
          ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
          scrub.current = { x: e.clientX, v: value }
          ed.begin()
        }}
        onPointerMove={(e) => {
          if (!scrub.current) return
          let v = scrub.current.v + Math.round((e.clientX - scrub.current.x) / 2) * step * (e.shiftKey ? 10 : 1)
          if (min !== undefined) v = Math.max(min, v)
          apply(v)
          ed.emit('doc')
        }}
        onPointerUp={() => {
          if (!scrub.current) return
          scrub.current = null
          ed.commit()
        }}
      >
        {label}
      </span>
      <input
        value={focus ? text : shown}
        onFocus={(e) => {
          setFocus(true)
          dirty.current = false
          setText(value === 'mixed' ? '' : String(round2(value)))
          requestAnimationFrame(() => e.target.select())
        }}
        onChange={(e) => {
          dirty.current = true
          setText(e.target.value)
        }}
        onBlur={(e) => {
          setFocus(false)
          // only what the user typed is applied: a field that was merely focused must never write back the
          // value it showed when it got the focus (the layer may have been moved on the canvas since then)
          if (!dirty.current) return
          dirty.current = false
          const raw = e.target.value
          if (raw.trim() && raw !== String(value)) commit(raw)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y in a field with nothing typed undo on the canvas, as in Figma
          if (undoFromField(e, dirty.current)) return
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            dirty.current = false
            setText(String(value))
            ;(e.target as HTMLInputElement).blur()
          }
          if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && value !== 'mixed') {
            e.preventDefault()
            const v = (focus ? parseFloat(text) || 0 : value) + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)
            setText(String(round2(v)))
            ed.act(() => apply(min !== undefined ? Math.max(min, v) : v))
          }
        }}
      />
    </label>
  )
}

/**
 * One row of colour: a solid colour, or (for fills) a gradient. A fill passes `setPaint`, and then the popover can
 * turn the colour into a gradient and back while it stays open; `target` names the layer whose gradient handles
 * are shown on the canvas meanwhile.
 */
function ColorField({
  color,
  apply,
  onRemove,
  visible,
  onToggleVisible,
  paint,
  setPaint,
  target
}: {
  color: RGBA | 'mixed'
  apply: (c: RGBA) => void
  onRemove?: () => void
  visible?: boolean
  onToggleVisible?: () => void
  /** the fill when it is a gradient */
  paint?: GradientPaint
  /** replaces the whole fill (live, inside the transaction of the popover) */
  setPaint?: (p: Paint) => void
  target?: { id: string; index: number; w: number; h: number }
}) {
  const [text, setText] = useState<string | null>(null)
  const [stopLocal, setStopLocal] = useState(0)
  const pe = ed.paintEdit
  const linked = !!target && !!pe && pe.id === target.id && pe.index === target.index
  const stop = paint ? Math.min(paint.stops.length - 1, Math.max(0, linked ? pe!.stop : stopLocal)) : 0
  const selectStop = (i: number) => {
    setStopLocal(i)
    if (target && ed.paintEdit) {
      ed.paintEdit = { ...ed.paintEdit, stop: i }
      ed.emit('ui', 'doc')
    }
  }
  /** the fill becomes a solid colour or a gradient of another kind; the popover stays open */
  const changeType = (tp: 'SOLID' | GradientType) => {
    if (!setPaint) return
    if (tp === 'SOLID') {
      if (paint) setPaint({ type: 'SOLID', color: paint.stops[stop]?.color ?? { r: 0.85, g: 0.85, b: 0.85, a: 1 }, visible: paint.visible })
    } else if (!paint) {
      // a colour becomes a gradient from that colour to the same colour fully transparent
      if (color !== 'mixed') setPaint({ type: tp, angle: 180, stops: [{ position: 0, color }, { position: 1, color: { ...color, a: 0 } }], visible: visible === false ? false : undefined })
    } else if (paint.type !== tp) {
      const w = target?.w || 1
      const h = target?.h || 1
      const next: GradientPaint = { ...paint, type: tp }
      if (paint.handles || paint.type === 'GRADIENT_LINEAR') {
        const [a, b] = handlesOf(paint, w, h)
        const across = (s: { x: number; y: number }, e: { x: number; y: number }, k: number) => ({ x: s.x - (((e.y - s.y) * h) / w) * k, y: s.y + (((e.x - s.x) * w) / h) * k })
        // a line runs from its start to its end; the others spread from their centre: the middle of that line
        if (paint.type === 'GRADIENT_LINEAR') {
          const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
          next.handles = [c, b, across(c, b, 1)]
        } else if (tp === 'GRADIENT_LINEAR') {
          const s = { x: a.x * 2 - b.x, y: a.y * 2 - b.y }
          next.handles = [s, b, across(s, b, 1)]
        }
      }
      setPaint(next)
    }
    ed.emit('doc')
  }
  const hex = color === 'mixed' ? 'Mixed' : rgbaToHex(color).slice(1).toUpperCase()
  const alpha = color === 'mixed' ? 1 : color.a
  const swatchRef = useRef<HTMLButtonElement>(null)
  const hexDirty = useRef(false)
  const [picking, setPicking] = useState(false)
  // while the popover of a gradient is open, the canvas shows the handles of that gradient
  const showHandles = picking && !!paint && !!target
  useEffect(() => {
    if (!showHandles || !target) return
    ed.paintEdit = { id: target.id, index: target.index, stop: stopLocal }
    ed.emit('ui', 'doc')
    return () => {
      ed.paintEdit = null
      ed.emit('ui', 'doc')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHandles, target?.id, target?.index])
  return (
    <div className={'row tight' + (visible === false ? ' dimmed' : '')}>
      <div className="field" style={{ flex: 1 }}>
        <button
          ref={swatchRef}
          type="button"
          className="swatch"
          onClick={() => {
            if (picking) return
            ed.begin() // the whole picking session is one undo step
            setPicking(true)
          }}
        >
          <div style={{ background: paint ? previewCss(paint) : color === 'mixed' ? '#888' : rgbaToCss(color) }} />
        </button>
        {picking && swatchRef.current && (
          <ColorPicker
            color={paint ? paint.stops[stop].color : color === 'mixed' ? { r: 0.5, g: 0.5, b: 0.5, a: 1 } : color}
            anchor={swatchRef.current}
            onType={setPaint && changeType}
            gradient={
              paint && setPaint
                ? {
                    paint,
                    stop,
                    select: selectStop,
                    set: (p) => {
                      setPaint(p)
                      ed.emit('doc')
                    },
                    w: target?.w || 1,
                    h: target?.h || 1
                  }
                : undefined
            }
            onChange={(c) => {
              if (paint && setPaint) setPaint({ ...paint, stops: paint.stops.map((s, i) => (i === stop ? { ...s, color: c } : s)) })
              else apply(c)
              ed.emit('doc')
            }}
            onClose={() => {
              setPicking(false)
              ed.commit()
            }}
          />
        )}
        {paint ? (
          <div className="paint-kind" onDoubleClick={() => swatchRef.current?.click()}>
            {t(gradientLabel(paint.type))}
          </div>
        ) : (
        <input
          value={text ?? hex}
          onFocus={(e) => {
            setText(hex === 'Mixed' ? '' : hex)
            requestAnimationFrame(() => e.target.select())
          }}
          onChange={(e) => {
            hexDirty.current = true
            setText(e.target.value)
          }}
          onBlur={(e) => {
            // apply only a colour the user typed: re-applying the shown hex would round the colour,
            // add an empty step to the history and detach a linked style
            const raw = e.target.value.trim()
            if (hexDirty.current && /^#?[0-9a-f]{3,8}$/i.test(raw) && raw.replace('#', '').toUpperCase() !== hex) ed.act(() => apply({ ...hexToRgba(raw), a: alpha }))
            hexDirty.current = false
            setText(null)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (undoFromField(e, hexDirty.current)) return
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
        )}
      </div>
      <div style={{ width: 58, flex: 'none' }}>
        {paint ? (
          <NumberField label="" value={Math.round((paint.opacity ?? 1) * 100)} min={0} suffix="%" apply={(v) => setPaint?.({ ...paint, opacity: v >= 100 ? undefined : Math.min(100, v) / 100 })} />
        ) : (
          <NumberField label="" value={Math.round(alpha * 100)} min={0} suffix="%" apply={(v) => color !== 'mixed' && apply({ ...color, a: Math.min(100, v) / 100 })} />
        )}
      </div>
      {onToggleVisible && (
        <button className="icon-btn" title={visible === false ? t('Show') : t('Hide')} onClick={onToggleVisible}>
          {visible === false ? Icons.eyeOff : Icons.eye}
        </button>
      )}
      {onRemove && (
        <button className="icon-btn" title={t('Remove')} onClick={onRemove}>
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor">
            <path d="M2 6h8" />
          </svg>
        </button>
      )}
    </div>
  )
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="section">
      <div className="section-title">
        {title}
        {action}
      </div>
      {children}
    </div>
  )
}

export function RightPanel() {
  useEditor('doc', 'selection', 'pages')
  useT()
  const nodes = ed.selection.map((id) => ed.nodes.get(id)).filter(Boolean) as GNode[]
  return (
    <div className="panel right">
      <div className="p-head">
        <div className="title">{nodes.length === 0 ? t('Design') : nodes.length === 1 ? t(nodes[0].isComponentSet ? 'Component set' : nodes[0].isComponent ? 'Component' : nodes[0].componentId ? 'Instance' : isBooleanGroup(nodes[0]) ? BOOLEAN_NAMES[nodes[0].booleanOperation!] : nodes[0].type.charAt(0) + nodes[0].type.slice(1).toLowerCase()) : `${nodes.length} ${t('layers')}`}</div>
        <button className="icon-btn" title="Hide panel (Ctrl+Alt+\)" onClick={() => runAction('toggle-right')}>
          {Icons.sidebarR}
        </button>
      </div>
      {nodes.length === 0 ? (
        <PageInspector />
      ) : nodes.length === 1 && nodes[0].type === 'GUIDE' ? (
        <GuideInspector node={nodes[0]} />
      ) : nodes.length === 1 && ['SPEC', 'CODE', 'ANNOTATION', 'SLICE'].includes(nodes[0].type) ? (
        <SpecialInspector node={nodes[0]} />
      ) : (
        <NodeInspector nodes={nodes} />
      )}
    </div>
  )
}

function PageInspector() {
  const p = ed.page
  return (
    <>
      <Section title={t('Page')}>
        <ColorField color={p.background} apply={(c) => ed.updatePage(p.id, { background: c })} />
      </Section>
      <Section title={t('Export')}>
        <div className="row">
          <button className="btn" style={{ flex: 1 }} title={t('Every frame of this page becomes a page of one PDF file')} onClick={() => void exportFramesPdf()}>
            {t('Export frames to PDF')}
          </button>
        </div>
      </Section>
    </>
  )
}

function align(kind: 'l' | 'ch' | 'r' | 't' | 'cv' | 'b') {
  const ids = ed.roots(ed.selection)
  let box
  if (ids.length === 1) {
    const n = ed.nodes.get(ids[0])!
    if (!n.parentId) return
    box = ed.world(n.parentId)
  } else box = ed.selectionBounds(ids)!
  ed.act(() => {
    for (const id of ids) {
      const w = ed.world(id)
      let dx = 0, dy = 0
      if (kind === 'l') dx = box.x - w.x
      if (kind === 'ch') dx = box.x + box.w / 2 - (w.x + w.w / 2)
      if (kind === 'r') dx = box.x + box.w - (w.x + w.w)
      if (kind === 't') dy = box.y - w.y
      if (kind === 'cv') dy = box.y + box.h / 2 - (w.y + w.h / 2)
      if (kind === 'b') dy = box.y + box.h - (w.y + w.h)
      ed.moveBy(id, round2(dx), round2(dy))
    }
  })
}

const SubLabel = ({ children }: { children: React.ReactNode }) => <div className="sub-label">{children}</div>

const EyeBtn = ({ on, onClick }: { on: boolean; onClick: () => void }) => (
  <button className="icon-btn" title={on ? t('Hide') : t('Show')} onClick={onClick}>
    {on ? Icons.eye : Icons.eyeOff}
  </button>
)
const MinusBtn = ({ onClick }: { onClick: () => void }) => (
  <button className="icon-btn" title={t('Remove')} onClick={onClick}>
    <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor">
      <path d="M2 6h8" />
    </svg>
  </button>
)

const colorKey = (c: RGBA) => rgbaToHex(c) + Math.round(c.a * 100)

/**
 * Styles of the document (Figma's four-dots button). A style applied from here stays linked:
 * the layer follows the style until its colour / typography is edited by hand.
 */
function StyleMenu<T extends { id: string; name: string }>(p: {
  styles: T[]
  /** id of the style the selection is linked to */
  linkedId?: string | null
  /** false when there is nothing to save a style from (e.g. no fill) */
  canSave: boolean
  preview: (s: T) => React.ReactNode
  detail: (s: T) => string
  onApply: (s: T) => void
  onSave: (name: string) => void
  /** overwrite the style with what the selection has now */
  onUpdate: (s: T) => void
  onRename: (s: T, name: string) => void
  onDelete: (s: T) => void
  onDetach: () => void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', down, true)
    return () => window.removeEventListener('mousedown', down, true)
  }, [open])
  const r = btn.current?.getBoundingClientRect()
  const panelLeft = (btn.current?.closest('.panel') as HTMLElement | null)?.getBoundingClientRect().left ?? 0
  const linked = p.styles.find((s) => s.id === p.linkedId)
  return (
    <>
      <button ref={btn} className={'icon-btn' + (open || linked ? ' active-soft' : '')} title={linked ? `${t('Style')}: ${linked.name}` : t('Styles')} onClick={() => setOpen(!open)}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
          <circle cx="4" cy="4" r="1.6" />
          <circle cx="10" cy="4" r="1.6" />
          <circle cx="4" cy="10" r="1.6" />
          <circle cx="10" cy="10" r="1.6" />
        </svg>
      </button>
      {open &&
        r &&
        createPortal(
          <div ref={pop} className="tset" style={{ left: Math.max(8, panelLeft - 288), top: Math.max(8, Math.min(window.innerHeight - 380, r.top - 20)) }} onKeyDown={(e) => e.stopPropagation()}>
            <div className="tset-head">
              <b>{t('Styles')}</b>
              {linked && (
                <button className="btn" style={{ height: 24, padding: '0 8px' }} title={t('The layer keeps its look and stops following the style')} onClick={() => p.onDetach()}>
                  {t('Detach style')}
                </button>
              )}
            </div>
            <div className="styles-list">
              {p.styles.length === 0 && <div className="muted" style={{ padding: '6px 2px' }}>{t('No saved styles yet')}</div>}
              {p.styles.map((s) => (
                <div key={s.id} className={'style-row' + (s.id === p.linkedId ? ' linked' : '')} onClick={() => (p.onApply(s), setOpen(false))}>
                  {p.preview(s)}
                  {renaming === s.id ? (
                    <input
                      className="tset-num"
                      style={{ flex: 1, width: 'auto', textAlign: 'left' }}
                      autoFocus
                      defaultValue={s.name}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => (e.target.value.trim() && p.onRename(s, e.target.value.trim()), setRenaming(null))}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && (e.target as HTMLInputElement).blur()}
                    />
                  ) : (
                    <span className="style-name" title={t('Double-click to rename')} onDoubleClick={(e) => (e.stopPropagation(), setRenaming(s.id))}>
                      {s.name}
                    </span>
                  )}
                  <span className="muted">{p.detail(s)}</span>
                  {p.canSave && (
                    <button className="icon-btn small" title={t('Update the style from the selection: every layer that uses it changes')} onClick={(e) => (e.stopPropagation(), p.onUpdate(s))}>
                      ↻
                    </button>
                  )}
                  <button className="icon-btn small" title={t('Delete')} onClick={(e) => (e.stopPropagation(), p.onDelete(s))}>
                    ×
                  </button>
                </div>
              ))}
            </div>
            {p.canSave && (
              <div className="style-save">
                <input className="tset-num" style={{ flex: 1, width: 'auto', textAlign: 'left' }} placeholder={t('Style name')} value={name} onChange={(e) => setName(e.target.value)} />
                <button
                  className="btn primary"
                  disabled={!name.trim()}
                  onClick={() => {
                    p.onSave(name.trim())
                    setName('')
                  }}
                >
                  {t('Save')}
                </button>
              </div>
            )}
          </div>,
          document.body
        )}
    </>
  )
}

/** Colour styles for the Fill and Stroke sections. `link` stores the style id on the selected layers. */
function ColorStylesButton({ current, linkedId, apply, link }: { current: RGBA | null; linkedId?: string | null; apply: (c: RGBA) => void; link: (id: string | undefined) => void }) {
  const styles = ed.meta.colorStyles ?? []
  return (
    <StyleMenu
      styles={styles}
      linkedId={linkedId}
      canSave={!!current}
      preview={(s) => (
        <span className="swatch" style={{ margin: 0 }}>
          <div style={{ background: rgbaToCss(s.color) }} />
        </span>
      )}
      detail={(s) => rgbaToHex(s.color).slice(1).toUpperCase()}
      onApply={(s) =>
        ed.act(() => {
          apply(s.color)
          link(s.id)
        })
      }
      onSave={(name) => {
        const id = crypto.randomUUID()
        ed.setColorStyles([...styles, { id, name, color: current! }])
        // the layer the style was made from is its first user
        ed.act(() => link(id))
      }}
      onUpdate={(s) => ed.updateColorStyle(s.id, { color: current! })}
      onRename={(s, name) => ed.updateColorStyle(s.id, { name })}
      onDelete={(s) => ed.deleteStyle('color', s.id)}
      onDetach={() => ed.act(() => link(undefined))}
    />
  )
}

/** Text styles for the Typography section. */
function TextStylesButton({ nodes }: { nodes: GNode[] }) {
  const styles = ed.meta.textStyles ?? []
  const current = nodes[0].textStyle ?? DEFAULT_TEXT_STYLE
  const linkedId = same(nodes.map((n) => n.textStyleId ?? null))
  return (
    <StyleMenu
      styles={styles}
      linkedId={linkedId === 'mixed' ? null : linkedId}
      canSave
      preview={(s) => <span style={{ width: 22, flex: 'none', fontFamily: `"${s.style.fontFamily}", system-ui`, fontWeight: s.style.fontWeight, fontStyle: s.style.italic ? 'italic' : undefined, fontSize: 13 }}>Ag</span>}
      detail={(s) => `${s.style.fontSize}`}
      onApply={(s) => ed.act(() => nodes.forEach((n) => ed.updateNode(n.id, { textStyle: structuredClone(s.style), textStyleId: s.id })))}
      onSave={(name) => {
        const id = crypto.randomUUID()
        ed.setTextStyles([...styles, { id, name, style: structuredClone(current) }])
        ed.act(() => nodes.forEach((n) => ed.updateNode(n.id, { textStyleId: id })))
      }}
      onUpdate={(s) => ed.updateTextStyle(s.id, { style: structuredClone(current) })}
      onRename={(s, name) => ed.updateTextStyle(s.id, { name })}
      onDelete={(s) => ed.deleteStyle('text', s.id)}
      onDetach={() => ed.act(() => nodes.forEach((n) => ed.updateNode(n.id, { textStyleId: undefined })))}
    />
  )
}

/** Every distinct colour used inside the selection; editing one recolours all its uses (like Figma). */
function SelectionColors({ nodes }: { nodes: GNode[] }) {
  const [all, setAll] = useState(false)
  const set: GNode[] = []
  for (const n of nodes) {
    set.push(n)
    for (const d of ed.descendants(n.id)) {
      if (set.length > 3000) break
      set.push(ed.nodes.get(d)!)
    }
  }
  const colors = new Map<string, RGBA>()
  for (const n of set) {
    for (const f of n.fills) if (f.type === 'SOLID' && f.visible !== false) colors.set(colorKey(f.color), f.color)
    for (const s of n.strokes) if (s.visible !== false) colors.set(colorKey(s.color), s.color)
  }
  if (colors.size < 2 && set.length === nodes.length) return null
  if (!colors.size) return null
  const list = [...colors.entries()]
  const replace = (key: string, c: RGBA) => {
    for (const n of set) {
      const hitF = n.fills.some((f) => f.type === 'SOLID' && colorKey(f.color) === key)
      const hitS = n.strokes.some((s) => colorKey(s.color) === key)
      if (!hitF && !hitS) continue
      ed.updateNode(n.id, {
        fills: hitF ? n.fills.map((f) => (f.type === 'SOLID' && colorKey(f.color) === key ? { ...f, color: c } : f)) : n.fills,
        strokes: hitS ? n.strokes.map((s) => (colorKey(s.color) === key ? { ...s, color: c } : s)) : n.strokes
      })
    }
  }
  const shown = all ? list : list.slice(0, 5)
  return (
    <Section title={t('Selection colors')}>
      {shown.map(([key, c], i) => (
        <ColorField key={i} color={c} apply={(nc) => replace(key, nc)} />
      ))}
      {list.length > shown.length && (
        <div className="row">
          <button className="btn" style={{ flex: 1 }} onClick={() => setAll(true)}>
            {t('See all {n} colors', { n: String(list.length) })}
          </button>
        </div>
      )}
    </Section>
  )
}

const BLEND_LABELS: Record<BlendMode, string> = {
  NORMAL: 'Normal',
  DARKEN: 'Darken',
  MULTIPLY: 'Multiply',
  COLOR_BURN: 'Color burn',
  LIGHTEN: 'Lighten',
  SCREEN: 'Screen',
  COLOR_DODGE: 'Color dodge',
  OVERLAY: 'Overlay',
  SOFT_LIGHT: 'Soft light',
  HARD_LIGHT: 'Hard light',
  DIFFERENCE: 'Difference',
  EXCLUSION: 'Exclusion',
  HUE: 'Hue',
  SATURATION: 'Saturation',
  COLOR: 'Color',
  LUMINOSITY: 'Luminosity'
}

type Sizing = 'FIXED' | 'HUG' | 'FILL'
const parentOf = (n: GNode) => (n.parentId ? ed.nodes.get(n.parentId) : undefined)
/** how a layer is sized on an axis, in Figma's terms */
function sizingOf(n: GNode, axis: 'w' | 'h'): Sizing {
  const p = parentOf(n)
  if (isAutoLayout(p) && n.layoutPositioning !== 'ABSOLUTE') {
    const primary = (p.layoutMode === 'HORIZONTAL') === (axis === 'w')
    if (primary ? (n.layoutGrow ?? 0) > 0 : n.layoutAlign === 'STRETCH') return 'FILL'
  }
  if (isAutoLayout(n)) {
    const primary = (n.layoutMode === 'HORIZONTAL') === (axis === 'w')
    if ((primary ? n.primaryAxisSizingMode : n.counterAxisSizingMode) === 'AUTO') return 'HUG'
  }
  return 'FIXED'
}
function setSizing(n: GNode, axis: 'w' | 'h', v: Sizing): void {
  const patch: Partial<GNode> = {}
  const p = parentOf(n)
  if (isAutoLayout(p)) {
    if ((p.layoutMode === 'HORIZONTAL') === (axis === 'w')) patch.layoutGrow = v === 'FILL' ? 1 : undefined
    else patch.layoutAlign = v === 'FILL' ? 'STRETCH' : undefined
  }
  if (isAutoLayout(n)) {
    if ((n.layoutMode === 'HORIZONTAL') === (axis === 'w')) patch.primaryAxisSizingMode = v === 'HUG' ? 'AUTO' : 'FIXED'
    else patch.counterAxisSizingMode = v === 'HUG' ? 'AUTO' : 'FIXED'
  }
  ed.updateNode(n.id, patch)
}

/** Figma's "Resizing": Fixed / Hug contents / Fill container for width and height */
function ResizingRow({ nodes }: { nodes: GNode[] }) {
  const canHug = nodes.every((n) => isAutoLayout(n))
  const canFill = nodes.every((n) => isAutoLayout(parentOf(n)) && n.layoutPositioning !== 'ABSOLUTE')
  if (!canHug && !canFill) return null
  const options = [
    { value: 'FIXED', label: t('Fixed') },
    ...(canHug ? [{ value: 'HUG', label: t('Hug') }] : []),
    ...(canFill ? [{ value: 'FILL', label: t('Fill container') }] : [])
  ]
  return (
    <>
      <SubLabel>{t('Resizing')}</SubLabel>
      <div className="grid2">
        {(['w', 'h'] as const).map((axis) => (
          <div className="field" key={axis} title={axis === 'w' ? t('Width') : t('Height')}>
            <span className="lbl">{axis.toUpperCase()}</span>
            <Select value={same(nodes.map((n) => sizingOf(n, axis))) as string} onChange={(v) => ed.act(() => nodes.forEach((n) => setSizing(n, axis, v as Sizing)))} options={options} />
          </div>
        ))}
      </div>
    </>
  )
}

/** text input that commits on Enter / blur */
function CommitInput({ value, onCommit, placeholder }: { value: string; onCommit: (v: string) => void; placeholder?: string }) {
  const [text, setText] = useState<string | null>(null)
  return (
    <input
      value={text ?? value}
      placeholder={placeholder}
      spellCheck={false}
      onFocus={() => setText(value)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== null && text !== value) onCommit(text)
        setText(null)
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') (setText(null), (e.target as HTMLInputElement).blur())
      }}
    />
  )
}

/** Components: variants of a main component, and the variant / text of an instance (Figma's component properties). */
function ComponentSection({ node }: { node: GNode }) {
  const inst = node.componentId ? node : null
  const main = inst ? ed.nodes.get(inst.componentId!) : node.isComponent ? node : null
  const set = node.isComponentSet ? node : main ? ed.componentSetOf(main.id) : null
  const variants = set ? ed.variantsOf(set.id) : []
  // every property with the values the variants use, in order of appearance
  const props = new Map<string, string[]>()
  for (const v of variants) for (const [k, val] of Object.entries(v.props)) props.set(k, [...new Set([...(props.get(k) ?? []), val])])
  const current = main ? parseVariant(main.name) : {}

  if (inst) {
    const texts = ed.descendants(inst.id).map((id) => ed.nodes.get(id)!).filter((n) => n.type === 'TEXT').slice(0, 12)
    const hasOverrides = [inst.id, ...ed.descendants(inst.id)].some((id) => ed.nodes.get(id)!.overrides?.length)
    const pick = (key: string, value: string) => {
      const want = { ...current, [key]: value }
      // the variant that matches every property, or the closest one with the chosen value
      const score = (p: Record<string, string>) => Object.keys(want).filter((k) => p[k] === want[k]).length
      const best = variants.filter((v) => v.props[key] === value).sort((a, b) => score(b.props) - score(a.props))[0]
      if (best) ed.swapInstance(inst.id, best.id)
    }
    return (
      <Section title={main ? (set ? set.name : main.name) : t('Instance')}>
        {!main && <div className="row muted">{t('The main component was deleted')}</div>}
        {set &&
          [...props].map(([key, values]) => (
            <div className="row" key={key}>
              <div className="field" style={{ flex: 1 }}>
                <span className="lbl" style={{ width: 'auto', maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 6 }} title={key}>
                  {key}
                </span>
                <Select value={current[key] ?? null} onChange={(v) => pick(key, v)} options={values.map((v) => ({ value: v, label: v }))} />
              </div>
            </div>
          ))}
        {texts.map((n) => (
          <div className="row" key={n.id} title={t('Text of the layer') + ' “' + n.name + '”'}>
            <div className="field" style={{ flex: 1 }}>
              <span className="lbl">T</span>
              <CommitInput value={n.characters ?? ''} onCommit={(v) => ed.act(() => ed.updateNode(n.id, { characters: v }))} />
            </div>
          </div>
        ))}
        <div className="row btn-stack">
          <button className="btn" disabled={!main} onClick={layerActions.goToMainComponent}>
            {t('Go to main component')}
          </button>
          <button className="btn" title="Ctrl+Alt+B" onClick={layerActions.detachInstance}>
            {t('Detach')}
          </button>
        </div>
        {hasOverrides && (
          <div className="row">
            <button className="btn" style={{ flex: 1 }} onClick={() => ed.resetInstance(inst.id)}>
              {t('Reset all changes')}
            </button>
          </div>
        )}
      </Section>
    )
  }

  const rename = (key: string, value: string) => {
    if (!main || !value.trim()) return
    ed.act(() => ed.updateNode(main.id, { name: variantName({ ...current, [key]: value.trim() }) }))
  }
  // renaming a property renames it in every variant of the set
  const renameKey = (key: string, next: string) => {
    if (!set || !next.trim() || props.has(next.trim())) return
    ed.act(() => {
      for (const v of variants) {
        const p: Record<string, string> = {}
        for (const [k, val] of Object.entries(v.props)) p[k === key ? next.trim() : k] = val
        ed.updateNode(v.id, { name: variantName(p) })
      }
    })
  }
  const addProperty = () => {
    if (!set) return
    let i = props.size + 1
    while (props.has('Property ' + i)) i++
    ed.act(() => variants.forEach((v) => ed.updateNode(v.id, { name: variantName({ ...v.props, ['Property ' + i]: 'Default' }) })))
  }
  return (
    <Section
      title={set ? t('Variants') : t('Component')}
      action={
        set ? (
          <button className="icon-btn" title={t('Add property')} onClick={addProperty}>
            {Icons.plus}
          </button>
        ) : undefined
      }
    >
      {set && main && (
        <>
          <SubLabel>{t('Properties of this variant')}</SubLabel>
          {[...props.keys()].map((key) => (
            <div className="grid2" key={key}>
              <div className="field" title={t('Property name')}>
                <CommitInput value={key} onCommit={(v) => renameKey(key, v)} />
              </div>
              <div className="field" title={t('Value')}>
                <CommitInput value={current[key] ?? ''} placeholder="—" onCommit={(v) => rename(key, v)} />
              </div>
            </div>
          ))}
        </>
      )}
      {set && !main && (
        <>
          {[...props].map(([key, values]) => (
            <div className="row" key={key} style={{ alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontWeight: 600 }}>{key}</span>
              <span className="muted" style={{ flex: 1, minWidth: 0 }}>
                {values.join(', ')}
              </span>
            </div>
          ))}
          <div className="row muted">{t('Select a variant to edit its properties.')}</div>
        </>
      )}
      <div className="row">
        <button className="btn" style={{ flex: 1 }} onClick={() => ed.addVariant(main ? main.id : (variants[variants.length - 1]?.id ?? ''))}>
          + {t('Add variant')}
        </button>
      </div>
    </Section>
  )
}

/** Figma constraints: what a layer does when its parent frame is resized */
function ConstraintsSection({ nodes }: { nodes: GNode[] }) {
  // only layers placed freely in a frame have constraints (auto layout arranges its own children)
  const ok = nodes.every((n) => {
    const p = parentOf(n)
    return p?.type === 'FRAME' && (!isAutoLayout(p) || n.layoutPositioning === 'ABSOLUTE')
  })
  if (!ok) return null
  const get = (n: GNode) => n.constraints ?? { horizontal: 'MIN' as Constraint, vertical: 'MIN' as Constraint }
  const set = (axis: 'horizontal' | 'vertical', v: Constraint) => ed.act(() => nodes.forEach((n) => ed.updateNode(n.id, { constraints: { ...get(n), [axis]: v } })))
  const h = same(nodes.map((n) => get(n).horizontal))
  const v = same(nodes.map((n) => get(n).vertical))
  const opts = (names: [string, string, string, string, string]) => (['MIN', 'MAX', 'STRETCH', 'CENTER', 'SCALE'] as const).map((value, i) => ({ value, label: t(names[i]) }))
  // small diagram: the frame, the layer and the sides it is pinned to
  const pin = (on: boolean) => (on ? 'var(--accent)' : 'var(--text-3)')
  const hv = h === 'mixed' ? '' : h
  const vv = v === 'mixed' ? '' : v
  return (
    <Section title={t('Constraints')}>
      <div className="row" style={{ alignItems: 'center', gap: 10 }}>
        <svg width="56" height="56" viewBox="0 0 56 56" fill="none" style={{ flex: 'none' }}>
          <rect x="1.5" y="1.5" width="53" height="53" rx="5" stroke="var(--border)" strokeWidth="1" fill="var(--panel-2)" />
          <rect x="20" y="20" width="16" height="16" rx="2" stroke="var(--text-2)" />
          <path d="M6 28h10" stroke={pin(hv === 'MIN' || hv === 'STRETCH' || hv === 'SCALE')} strokeWidth="2" strokeLinecap="round" />
          <path d="M40 28h10" stroke={pin(hv === 'MAX' || hv === 'STRETCH' || hv === 'SCALE')} strokeWidth="2" strokeLinecap="round" />
          <path d="M28 6v10" stroke={pin(vv === 'MIN' || vv === 'STRETCH' || vv === 'SCALE')} strokeWidth="2" strokeLinecap="round" />
          <path d="M28 40v10" stroke={pin(vv === 'MAX' || vv === 'STRETCH' || vv === 'SCALE')} strokeWidth="2" strokeLinecap="round" />
          {hv === 'CENTER' && <path d="M24 28h8" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />}
          {vv === 'CENTER' && <path d="M28 24v8" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />}
        </svg>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="field" title={t('Horizontal')}>
            <span className="lbl">↔</span>
            <Select value={h === 'mixed' ? null : h} placeholder={t('Mixed')} onChange={(x) => set('horizontal', x as Constraint)} options={opts(['Left', 'Right', 'Left and right', 'Center', 'Scale'])} />
          </div>
          <div className="field" title={t('Vertical')}>
            <span className="lbl">↕</span>
            <Select value={v === 'mixed' ? null : v} placeholder={t('Mixed')} onChange={(x) => set('vertical', x as Constraint)} options={opts(['Top', 'Bottom', 'Top and bottom', 'Center', 'Scale'])} />
          </div>
        </div>
      </div>
    </Section>
  )
}

function AutoLayoutSection({ nodes }: { nodes: GNode[] }) {
  const [sides, setSides] = useState(false)
  const frames = nodes.filter((n) => isAutoLayout(n))
  const all = frames.length === nodes.length
  const each = (patch: Partial<GNode>) => frames.forEach((f) => ed.updateNode(f.id, patch))
  const action = all ? (
    <button className="icon-btn" title={t('Remove auto layout') + ' (Alt+Shift+A)'} onClick={layerActions.removeAutoLayout}>
      <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor">
        <path d="M2 6h8" />
      </svg>
    </button>
  ) : (
    <button className="icon-btn" title={t('Add auto layout') + ' (Shift+A)'} onClick={layerActions.addAutoLayout}>
      {Icons.plus}
    </button>
  )
  if (!all) return <Section title={t('Auto layout')} action={action} />
  const f = frames[0]
  const mode = same(frames.map((x) => x.layoutMode))
  const horiz = f.layoutMode === 'HORIZONTAL'
  const between = frames.every((x) => x.primaryAxisAlignItems === 'SPACE_BETWEEN')
  const pv = (k: 'paddingLeft' | 'paddingRight' | 'paddingTop' | 'paddingBottom') => same(frames.map((x) => x[k] ?? 0))
  const pair = (a: Mixed, b: Mixed): Mixed => (a === b ? a : 'mixed')
  const showSides = sides || pair(pv('paddingLeft'), pv('paddingRight')) === 'mixed' || pair(pv('paddingTop'), pv('paddingBottom')) === 'mixed'
  // 3 x 3 alignment grid: column / row index -> MIN / CENTER / MAX on the matching axis
  const A = ['MIN', 'CENTER', 'MAX'] as const
  const cell = (col: number, row: number): Partial<GNode> => {
    const p = A[horiz ? col : row]
    const c = A[horiz ? row : col]
    return between ? { counterAxisAlignItems: c } : { primaryAxisAlignItems: p, counterAxisAlignItems: c }
  }
  const isOn = (col: number, row: number) => {
    const want = cell(col, row)
    return frames.every((x) => (x.counterAxisAlignItems ?? 'MIN') === want.counterAxisAlignItems && (between || (x.primaryAxisAlignItems ?? 'MIN') === want.primaryAxisAlignItems))
  }
  const padIcon = (d: string) => (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">
      <path d={d} />
    </svg>
  )
  return (
    <Section title={t('Auto layout')} action={action}>
      <div className="row split">
        <div className="seg">
          <button className={mode === 'VERTICAL' ? 'on' : ''} title={t('Vertical layout')} onClick={() => ed.act(() => each({ layoutMode: 'VERTICAL' }))}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor">
              <path d="M7 2v10M4 9l3 3 3-3" />
            </svg>
          </button>
          <button className={mode === 'HORIZONTAL' ? 'on' : ''} title={t('Horizontal layout')} onClick={() => ed.act(() => each({ layoutMode: 'HORIZONTAL' }))}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor">
              <path d="M2 7h10M9 4l3 3-3 3" />
            </svg>
          </button>
        </div>
        <div style={{ width: 96, flex: 'none' }} title={t('Gap between items')}>
          {between ? (
            <div className="field">
              <span className="lbl">{padIcon(horiz ? 'M2 2v8M10 2v8M5 6h2' : 'M2 2h8M2 10h8M6 5v2')}</span>
              <input readOnly value={t('Auto')} />
            </div>
          ) : (
            <NumberField label={padIcon(horiz ? 'M2 2v8M10 2v8M5 6h2' : 'M2 2h8M2 10h8M6 5v2')} value={same(frames.map((x) => x.itemSpacing ?? 0))} apply={(v) => each({ itemSpacing: v })} />
          )}
        </div>
      </div>
      <div className="row split" style={{ alignItems: 'flex-start' }}>
        <div className="al-grid" title={t('Alignment')}>
          {[0, 1, 2].map((row) =>
            [0, 1, 2].map((col) => (
              <button key={row + '-' + col} className={isOn(col, row) ? 'on' : ''} onClick={() => ed.act(() => each(cell(col, row)))}>
                <i />
              </button>
            ))
          )}
        </div>
        <div style={{ width: 96, flex: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label className="checkbox" style={{ padding: 0 }} title={t('Spread the items across the frame')}>
            <input type="checkbox" checked={between} onChange={(e) => ed.act(() => each({ primaryAxisAlignItems: e.target.checked ? 'SPACE_BETWEEN' : 'MIN' }))} />
            {t('Space between')}
          </label>
          <label className="checkbox" style={{ padding: 0 }} title={t('Items that do not fit continue on the next line. The frame needs a fixed size along the layout direction.')}>
            <input
              type="checkbox"
              checked={frames.every((x) => x.layoutWrap === 'WRAP')}
              // wrapping needs a fixed size to wrap at
              onChange={(e) => ed.act(() => each(e.target.checked ? { layoutWrap: 'WRAP', primaryAxisSizingMode: 'FIXED' } : { layoutWrap: undefined }))}
            />
            {t('Wrap')}
          </label>
          {frames.every((x) => x.layoutWrap === 'WRAP') && (
            <div title={t('Gap between lines')}>
              <NumberField label={padIcon(horiz ? 'M2 2h8M2 10h8M6 5v2' : 'M2 2v8M10 2v8M5 6h2')} value={same(frames.map((x) => x.counterAxisSpacing ?? 0))} apply={(v) => each({ counterAxisSpacing: v })} />
            </div>
          )}
        </div>
      </div>
      <SubLabel>{t('Padding')}</SubLabel>
      <div className="row tight">
        <div style={{ flex: 1, minWidth: 0 }} title={t('Horizontal padding')}>
          <NumberField label={padIcon('M2 2v8M10 2v8M4.5 4.5h3v3h-3z')} min={0} value={pair(pv('paddingLeft'), pv('paddingRight'))} apply={(v) => each({ paddingLeft: v, paddingRight: v })} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }} title={t('Vertical padding')}>
          <NumberField label={padIcon('M2 2h8M2 10h8M4.5 4.5h3v3h-3z')} min={0} value={pair(pv('paddingTop'), pv('paddingBottom'))} apply={(v) => each({ paddingTop: v, paddingBottom: v })} />
        </div>
        <button className={'icon-btn' + (showSides ? ' active-soft' : '')} title={t('Individual padding')} onClick={() => setSides(!showSides)}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor">
            <path d="M2 4.5v5M12 4.5v5M4.5 2h5M4.5 12h5" />
          </svg>
        </button>
      </div>
      {showSides && (
        <div className="grid2">
          {(
            [
              ['paddingLeft', 'Left', 'M2 2v8'],
              ['paddingTop', 'Top', 'M2 2h8'],
              ['paddingRight', 'Right', 'M10 2v8'],
              ['paddingBottom', 'Bottom', 'M2 10h8']
            ] as const
          ).map(([k, label, d]) => (
            <div key={k} title={t(label)}>
              <NumberField label={padIcon(d + 'M4.5 4.5h3v3h-3z')} min={0} value={pv(k)} apply={(v) => each({ [k]: v })} />
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

function NodeInspector({ nodes }: { nodes: GNode[] }) {
  const each = (fn: (n: GNode) => void) => nodes.forEach(fn)
  const worlds = nodes.map((n) => ed.world(n.id))
  const allText = nodes.every((n) => n.type === 'TEXT')
  /** polygons and stars: one radius for every corner, and the fields Figma has for them (count, ratio) */
  const shapes = nodes.every((n) => n.type === 'VECTOR' && !!n.shape)
  const hasRadius = shapes || nodes.every((n) => n.type === 'RECTANGLE' || n.type === 'FRAME' || n.type === 'IMAGE' || n.type === 'SECTION')
  const frames = nodes.filter((n) => n.type === 'FRAME')
  const [scale, setScale] = useState(2)
  const [cornersOpen, setCornersOpen] = useState(false)
  const [strokeSetOpen, setStrokeSetOpen] = useState(false)
  const strokeSetBtn = useRef<HTMLButtonElement>(null)
  const showCorners = hasRadius && !shapes && (cornersOpen || nodes.some((n) => n.cornerRadii))
  const locked = nodes.every((n) => n.constrainProportions)
  const visible = nodes.every((n) => n.visible)

  // dimensions honour "constrain proportions"
  const setDim = (axis: 'w' | 'h', v: number) =>
    each((n) => {
      const w = ed.world(n.id)
      const next = { ...w, [axis]: v }
      if (n.constrainProportions && w.w > 0 && w.h > 0) {
        if (axis === 'w') next.h = round2((w.h * v) / w.w)
        else next.w = round2((w.w * v) / w.h)
      }
      ed.setWorldRect(n.id, next)
    })

  // fills: the first selected layer is the source of truth, edits apply to the whole selection
  const fills = nodes[0].fills
  const fillsMixed = nodes.some((n) => JSON.stringify(n.fills) !== JSON.stringify(fills))
  const setFills = (next: Paint[]) => each((n) => ed.updateNode(n.id, { fills: next }))
  const topSolid = [...fills].reverse().find((f) => f.type === 'SOLID') as Extract<Paint, { type: 'SOLID' }> | undefined
  const strokes = nodes[0].strokes
  const strokesMixed = nodes.some((n) => JSON.stringify(n.strokes) !== JSON.stringify(strokes))
  const setStrokes = (next: GNode['strokes']) => each((n) => ed.updateNode(n.id, { strokes: next }))
  const radii = (n: GNode): [number, number, number, number] => n.cornerRadii ?? [n.cornerRadius ?? 0, n.cornerRadius ?? 0, n.cornerRadius ?? 0, n.cornerRadius ?? 0]
  const setCorner = (i: number, v: number) =>
    each((n) => {
      const r = [...radii(n)] as [number, number, number, number]
      r[i] = v
      ed.updateNode(n.id, { cornerRadii: r, cornerRadius: undefined })
    })
  const cornerIcon = (rot: number) => (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" style={{ transform: `rotate(${rot}deg)` }}>
      <path d="M1 9V5a4 4 0 014-4h4" />
    </svg>
  )

  const boolGroup = nodes.length === 1 && isBooleanGroup(nodes[0]) ? nodes[0] : null

  return (
    <>
      {(nodes.length > 1 || boolGroup) && (
        <div className="section bool-bar">
          <div className="seg">
            {(['UNION', 'SUBTRACT', 'INTERSECT', 'EXCLUDE'] as const).map((op) => (
              <button key={op} className={boolGroup?.booleanOperation === op ? 'on' : ''} title={`${t(BOOLEAN_NAMES[op])} (Alt+Shift+${op === 'UNION' ? 'U' : op[0]})`} onClick={() => layerActions.booleanOp(op)}>
                {BoolIcons[op]}
              </button>
            ))}
          </div>
          <button className="icon-btn" title={t('Flatten') + ' (Ctrl+E)'} onClick={layerActions.flatten}>
            {BoolIcons.FLATTEN}
          </button>
        </div>
      )}
      {nodes.length === 1 && (nodes[0].componentId || nodes[0].isComponent || nodes[0].isComponentSet) && <ComponentSection node={nodes[0]} />}
      <Section title={t('Position')}>
        <SubLabel>{t('Alignment')}</SubLabel>
        <div className="row split">
          <div className="seg">
            <button title={t('Align left')} onClick={() => align('l')}>{Icons.alignL}</button>
            <button title={t('Align horizontal centers')} onClick={() => align('ch')}>{Icons.alignCH}</button>
            <button title={t('Align right')} onClick={() => align('r')}>{Icons.alignR}</button>
          </div>
          <div className="seg">
            <button title={t('Align top')} onClick={() => align('t')}>{Icons.alignT}</button>
            <button title={t('Align vertical centers')} onClick={() => align('cv')}>{Icons.alignCV}</button>
            <button title={t('Align bottom')} onClick={() => align('b')}>{Icons.alignB}</button>
          </div>
        </div>
        <SubLabel>{t('Position')}</SubLabel>
        <div className="grid2">
          <NumberField label="X" value={same(nodes.map((n) => n.x))} apply={(v) => each((n) => ed.updateNode(n.id, { x: v }))} />
          <NumberField label="Y" value={same(nodes.map((n) => n.y))} apply={(v) => each((n) => ed.updateNode(n.id, { y: v }))} />
        </div>
        <SubLabel>{t('Rotation')}</SubLabel>
        <div className="grid2">
          <NumberField
            label={
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">
                <path d="M2 2v8h8M2 6a4 4 0 014 4" />
              </svg>
            }
            suffix="°"
            value={same(nodes.map((n) => n.rotation ?? 0))}
            apply={(v) => each((n) => ed.updateNode(n.id, { rotation: ((((v + 180) % 360) + 360) % 360) - 180 || undefined }))}
          />
          <div className="seg" style={{ justifySelf: 'start' }}>
            <button title={t('Rotate 90° right')} onClick={() => ed.act(() => each((n) => ed.updateNode(n.id, { rotation: ((((((n.rotation ?? 0) - 90 + 180) % 360) + 360) % 360) - 180) || undefined })))}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor">
                <path d="M3 8a4 4 0 104-4h3M8.5 2L10.5 4l-2 2" />
              </svg>
            </button>
            <button title={t('Flip horizontal')} className={nodes.every((n) => n.flipX) ? 'on' : ''} onClick={() => ed.act(() => each((n) => ed.updateNode(n.id, { flipX: !n.flipX || undefined })))}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor">
                <path d="M7 1.5v11M5 4L1.5 7 5 10zM9 4l3.5 3L9 10z" />
              </svg>
            </button>
            <button title={t('Flip vertical')} className={nodes.every((n) => n.flipY) ? 'on' : ''} onClick={() => ed.act(() => each((n) => ed.updateNode(n.id, { flipY: !n.flipY || undefined })))}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor">
                <path d="M1.5 7h11M4 5l3-3.5L10 5zM4 9l3 3.5L10 9z" />
              </svg>
            </button>
          </div>
        </div>
      </Section>

      <ConstraintsSection nodes={nodes} />

      <Section title={t('Layout')}>
        <SubLabel>{t('Dimensions')}</SubLabel>
        <div className="row tight">
          <div style={{ flex: 1, minWidth: 0 }}>
            <NumberField label="W" min={1} value={same(worlds.map((w) => w.w))} apply={(v) => setDim('w', v)} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <NumberField label="H" min={1} value={same(worlds.map((w) => w.h))} apply={(v) => setDim('h', v)} />
          </div>
          <button className={'icon-btn' + (locked ? ' active-soft' : '')} title={t('Constrain proportions')} onClick={() => ed.act(() => each((n) => ed.updateNode(n.id, { constrainProportions: !locked || undefined })))}>
            {locked ? Icons.lock : Icons.unlock}
          </button>
        </div>
        <ResizingRow nodes={nodes} />
        {frames.length > 0 && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={frames.every((f) => f.clipsContent !== false)}
              onChange={(e) => ed.act(() => frames.forEach((f) => ed.updateNode(f.id, { clipsContent: e.target.checked })))}
            />
            {t('Clip content')}
          </label>
        )}
        {nodes.every((n) => isAutoLayout(n.parentId ? ed.nodes.get(n.parentId) : undefined)) && (
          <label className="checkbox" title={t('The layer keeps its own position inside the auto layout frame')}>
            <input
              type="checkbox"
              checked={nodes.every((n) => n.layoutPositioning === 'ABSOLUTE')}
              onChange={(e) => ed.act(() => each((n) => ed.updateNode(n.id, { layoutPositioning: e.target.checked ? 'ABSOLUTE' : undefined })))}
            />
            {t('Ignore auto layout')}
          </label>
        )}
      </Section>

      <AutoLayoutSection nodes={nodes} />

      <Section title={t('Appearance')} action={<EyeBtn on={visible} onClick={() => ed.act(() => each((n) => ed.updateNode(n.id, { visible: !visible })))} />}>
        <div className="row tight" style={{ alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <SubLabel>{t('Opacity')}</SubLabel>
            <NumberField
              label={
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">
                  <rect x="1.5" y="1.5" width="9" height="9" rx="2" />
                  <path d="M4 4h.01M6 6h.01M8 8h.01M8 4h.01M4 8h.01" strokeLinecap="round" />
                </svg>
              }
              min={0}
              suffix="%"
              value={same(nodes.map((n) => Math.round(n.opacity * 100)))}
              apply={(v) => each((n) => ed.updateNode(n.id, { opacity: Math.min(100, v) / 100 }))}
            />
          </div>
          {hasRadius && (
            <div style={{ flex: 1, minWidth: 0 }}>
              <SubLabel>{t('Corner radius')}</SubLabel>
              <NumberField
                label={
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">
                    <path d="M1.5 4.5v-1a2 2 0 012-2h1M7.5 1.5h1a2 2 0 012 2v1M10.5 7.5v1a2 2 0 01-2 2h-1M4.5 10.5h-1a2 2 0 01-2-2v-1" />
                  </svg>
                }
                min={0}
                value={same(nodes.map((n) => (n.cornerRadii ? (new Set(n.cornerRadii).size === 1 ? n.cornerRadii[0] : -1) : (n.cornerRadius ?? 0)))) === -1 ? 'mixed' : same(nodes.map((n) => (n.cornerRadii ? n.cornerRadii[0] : (n.cornerRadius ?? 0))))}
                apply={(v) => each((n) => ed.updateNode(n.id, { cornerRadius: n.shape ? Math.min(v, Math.round(maxShapeRadius(n.shape, n.width, n.height) * 100) / 100) : v, cornerRadii: undefined }))}
              />
            </div>
          )}
          {hasRadius && !shapes && (
            <button className={'icon-btn' + (showCorners ? ' active-soft' : '')} title={t('Individual corners')} onClick={() => setCornersOpen(!showCorners)}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor">
                <path d="M1.5 5V3.5a2 2 0 012-2H5M9 1.5h1.5a2 2 0 012 2V5M12.5 9v1.5a2 2 0 01-2 2H9M5 12.5H3.5a2 2 0 01-2-2V9" />
              </svg>
            </button>
          )}
        </div>
        {shapes && (
          <div className="grid2">
            <div title={t(nodes[0].shape!.kind === 'STAR' ? 'Points' : 'Sides')}>
              <SubLabel>{t('Count')}</SubLabel>
              <NumberField
                label={
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">
                    <path d="M6 1.5l4.5 3.3-1.7 5.2H3.2L1.5 4.8z" />
                  </svg>
                }
                min={3}
                value={same(nodes.map((n) => n.shape!.count))}
                apply={(v) => each((n) => ed.updateNode(n.id, { shape: { ...n.shape!, count: Math.max(3, Math.min(60, Math.round(v))) } }))}
              />
            </div>
            {nodes.every((n) => n.shape!.kind === 'STAR') && (
              <div title={t('How deep the star is cut')}>
                <SubLabel>{t('Ratio')}</SubLabel>
                <NumberField
                  label={
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">
                      <path d="M6 1l1.4 3.2 3.4.3-2.6 2.3.8 3.4L6 8.4l-3 1.8.8-3.4L1.2 4.5l3.4-.3z" />
                    </svg>
                  }
                  min={1}
                  suffix="%"
                  value={same(nodes.map((n) => Math.round((n.shape!.ratio ?? 0.382) * 1000) / 10))}
                  apply={(v) => each((n) => ed.updateNode(n.id, { shape: { ...n.shape!, ratio: Math.max(0.01, Math.min(1, v / 100)) } }))}
                />
              </div>
            )}
          </div>
        )}
        {showCorners && (
          <div className="grid2">
            {(
              [
                [0, 0, 'Top left'],
                [1, 90, 'Top right'],
                [3, 270, 'Bottom left'],
                [2, 180, 'Bottom right']
              ] as const
            ).map(([i, rot, label]) => (
              <div key={i} title={t(label)}>
                <NumberField label={cornerIcon(rot)} min={0} value={same(nodes.map((n) => radii(n)[i]))} apply={(v) => setCorner(i, v)} />
              </div>
            ))}
          </div>
        )}
        <SubLabel>{t('Blend mode')}</SubLabel>
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <Select
              value={same(nodes.map((n) => n.blendMode ?? 'NORMAL')) as string}
              onChange={(v) => ed.act(() => each((n) => ed.updateNode(n.id, { blendMode: v === 'NORMAL' ? undefined : (v as BlendMode) })))}
              options={BLEND_MODES.map((m) => ({ value: m, label: t(BLEND_LABELS[m]) }))}
            />
          </div>
        </div>
        <label className="checkbox" title={t('The shape of this layer clips the layers above it')}>
          <input type="checkbox" checked={nodes.every((n) => !!n.isMask)} onChange={(e) => ed.act(() => each((n) => ed.updateNode(n.id, { isMask: e.target.checked || undefined })))} />
          {t('Use as mask')}
        </label>
      </Section>

      {allText && <TextSection nodes={nodes} />}

      <Section
        title={t('Fill')}
        action={
          <span style={{ display: 'flex' }}>
            <ColorStylesButton
              current={topSolid?.color ?? null}
              linkedId={sameId(nodes.map((n) => n.fillStyleId ?? null))}
              apply={(c) => setFills(topSolid ? fills.map((f) => (f === topSolid ? { ...f, color: c } : f)) : [...fills, { type: 'SOLID', color: c }])}
              link={(id) => each((n) => ed.updateNode(n.id, { fillStyleId: id }))}
            />
            <button className="icon-btn" title={t('Add fill')} onClick={() => ed.act(() => setFills([...(fillsMixed ? [] : fills), { type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85, a: 1 } }]))}>
              {Icons.plus}
            </button>
          </span>
        }
      >
        {fillsMixed ? (
          <div className="row muted hint">{t('Click + to replace mixed content')}</div>
        ) : (
          fills
            .map((f, i) => ({ f, i }))
            .reverse()
            .map(({ f, i }) =>
              f.type === 'SOLID' || 'stops' in f ? (
                <ColorField
                  key={i}
                  color={f.type === 'SOLID' ? f.color : (f.stops[0]?.color ?? { r: 0.85, g: 0.85, b: 0.85, a: 1 })}
                  paint={'stops' in f ? f : undefined}
                  setPaint={(p) => setFills(fills.map((x, k) => (k === i ? p : x)))}
                  target={nodes.length === 1 ? { id: nodes[0].id, index: i, w: nodes[0].width, h: nodes[0].height } : undefined}
                  visible={f.visible !== false}
                  onToggleVisible={() => ed.act(() => setFills(fills.map((x, k) => (k === i ? { ...x, visible: x.visible === false ? undefined : false } : x))))}
                  apply={(c) => setFills(fills.map((x, k) => (k === i && x.type === 'SOLID' ? { ...x, color: c } : x)))}
                  onRemove={() => ed.act(() => setFills(fills.filter((_, k) => k !== i)))}
                />
              ) : (
                <div key={i}>
                  <div className="row tight">
                    <div className="field" style={{ flex: 1 }}>
                      <span className="swatch">
                        <div style={{ background: `center/cover url(${backend.blob.url(f.imageHash)})` }} />
                      </span>
                      <Select
                        value={f.scaleMode === 'STRETCH' && f.transform ? 'CROP' : f.scaleMode}
                        // a cropped picture (it comes like that from Figma) keeps its crop until another mode is chosen
                        onChange={(v) => ed.act(() => setFills(fills.map((x, k) => (k === i && x.type === 'IMAGE' && v !== 'CROP' ? { ...x, scaleMode: v as 'FILL' | 'FIT' | 'STRETCH', transform: undefined } : x))))}
                        options={[
                          { value: 'FILL', label: t('Fill mode') },
                          { value: 'FIT', label: t('Fit') },
                          { value: 'STRETCH', label: t('Stretch') },
                          ...(f.transform ? [{ value: 'CROP', label: t('Crop') }] : [])
                        ]}
                      />
                    </div>
                    <EyeBtn on={f.visible !== false} onClick={() => ed.act(() => setFills(fills.map((x, k) => (k === i ? { ...x, visible: x.visible === false ? undefined : false } : x))))} />
                    <MinusBtn onClick={() => ed.act(() => setFills(fills.filter((_, k) => k !== i)))} />
                  </div>
                  {nodes.length === 1 && <ImageFillActions nodeId={nodes[0].id} hash={f.imageHash} fromFigma={!!f.figmaFileKey} />}
                </div>
              )
            )
        )}
      </Section>

      <Section
        title={t('Stroke')}
        action={
          <span style={{ display: 'flex' }}>
            <ColorStylesButton
              current={strokes[0]?.color ?? null}
              linkedId={sameId(nodes.map((n) => n.strokeStyleId ?? null))}
              apply={(c) => setStrokes(strokes.length ? strokes.map((s, k) => (k === 0 ? { ...s, color: c } : s)) : [{ color: c, weight: 1, align: 'INSIDE' }])}
              link={(id) => each((n) => ed.updateNode(n.id, { strokeStyleId: id }))}
            />
            <button className="icon-btn" title={t('Add stroke')} onClick={() => ed.act(() => setStrokes([...(strokesMixed ? [] : strokes), { color: { r: 0, g: 0, b: 0, a: 1 }, weight: 1, align: 'INSIDE' }]))}>
              {Icons.plus}
            </button>
          </span>
        }
      >
        {strokesMixed ? (
          <div className="row muted hint">{t('Click + to replace mixed content')}</div>
        ) : (
          strokes.length > 0 && (
            <>
              {strokes
                .map((s, i) => ({ s, i }))
                .reverse()
                .map(({ s, i }) => (
                  <ColorField
                    key={i}
                    color={s.color}
                    visible={s.visible !== false}
                    onToggleVisible={() => ed.act(() => setStrokes(strokes.map((x, k) => (k === i ? { ...x, visible: x.visible === false ? undefined : false } : x))))}
                    apply={(c) => setStrokes(strokes.map((x, k) => (k === i ? { ...x, color: c } : x)))}
                    onRemove={() => ed.act(() => setStrokes(strokes.filter((_, k) => k !== i)))}
                  />
                ))}
              <div className="stroke-grid">
                <div>
                  <SubLabel>{t('Position')}</SubLabel>
                  <div className="field">
                    <Select
                      value={strokes[0].align ?? 'CENTER'}
                      onChange={(v) => ed.act(() => setStrokes(strokes.map((s) => ({ ...s, align: v }))))}
                      options={[
                        { value: 'INSIDE', label: t('Inside') },
                        { value: 'CENTER', label: t('Center') },
                        { value: 'OUTSIDE', label: t('Outside') }
                      ]}
                    />
                  </div>
                </div>
                <div>
                  <SubLabel>{t('Weight')}</SubLabel>
                  <NumberField
                    label={
                      <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor">
                        <path d="M1 3h10M1 6.5h10" strokeWidth="1" />
                        <path d="M1 10h10" strokeWidth="2" />
                      </svg>
                    }
                    min={0}
                    value={strokes[0].weight}
                    apply={(v) => setStrokes(strokes.map((s) => ({ ...s, weight: v })))}
                  />
                </div>
                <button ref={strokeSetBtn} className={'icon-btn' + (strokeSetOpen ? ' active-soft' : '')} title={t('Stroke settings')} onClick={() => setStrokeSetOpen(!strokeSetOpen)}>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round">
                    <path d="M5 2.5v2M5 8.5v5M11 2.5v5M11 11.5v2" />
                    <circle cx="5" cy="6.5" r="2" />
                    <circle cx="11" cy="9.5" r="2" />
                  </svg>
                </button>
              </div>
              {nodes.every(isOpenPath) && (
                <div className="grid2">
                  <div>
                    <SubLabel>{t('Start point')}</SubLabel>
                    <div className="field cap-field">
                      <Select
                        value={same(nodes.map((n) => capsOf(n).start)) === 'mixed' ? null : capsOf(nodes[0]).start}
                        minWidth={190}
                        onChange={(v) => ed.act(() => each((n) => setCaps(n, { start: v })))}
                        options={capOptions(true)}
                      />
                    </div>
                  </div>
                  <div>
                    <SubLabel>{t('End point')}</SubLabel>
                    <div className="field cap-field">
                      <Select
                        value={same(nodes.map((n) => capsOf(n).end)) === 'mixed' ? null : capsOf(nodes[0]).end}
                        minWidth={190}
                        onChange={(v) => ed.act(() => each((n) => setCaps(n, { end: v })))}
                        options={capOptions(false)}
                      />
                    </div>
                  </div>
                </div>
              )}
              {strokeSetOpen && strokeSetBtn.current && <StrokeSettings nodes={nodes} anchor={strokeSetBtn.current} onClose={() => setStrokeSetOpen(false)} />}
            </>
          )
        )}
      </Section>

      <EffectsSection nodes={nodes} />

      <SelectionColors nodes={nodes} />

      <Section title={t('Export')}>
        <div className="row tight">
          <div className="field" style={{ width: 64 }}>
            <Select value={scale} onChange={setScale} options={[0.5, 1, 2, 3, 4].map((s) => ({ value: s, label: `${s}x` }))} />
          </div>
          <button className="btn" style={{ flex: 1, padding: '0 4px' }} onClick={() => exportSelectionPng(scale)}>
            PNG
          </button>
          <button className="btn" style={{ flex: 1, padding: '0 4px' }} onClick={() => exportSelectionSvg()}>
            SVG
          </button>
          <button className="btn" style={{ flex: 1, padding: '0 4px' }} title={t('One page per selected layer, vector, with selectable text')} onClick={() => void exportPdf()}>
            PDF
          </button>
        </div>
        <div className="row muted hint">{t('Ctrl+C copies as SVG — paste straight into Figma.')}</div>
      </Section>
    </>
  )
}

/** Text area that edits a field and commits as one undo step when focus leaves. */
function AreaField({ value, onCommit, className, rows = 6, placeholder }: { value: string; onCommit: (v: string) => void; className?: string; rows?: number; placeholder?: string }) {
  const [text, setText] = useState<string | null>(null)
  return (
    <textarea
      className={'code-area' + (className ? ' ' + className : '')}
      rows={rows}
      spellCheck={false}
      placeholder={placeholder}
      value={text ?? value}
      onFocus={() => setText(value)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== null && text !== value) ed.act(() => onCommit(text))
        setText(null)
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        // Tab inserts two spaces in code
        if (e.key === 'Tab') {
          e.preventDefault()
          const ta = e.currentTarget
          const s = ta.selectionStart
          const v = ta.value.slice(0, s) + '  ' + ta.value.slice(ta.selectionEnd)
          setText(v)
          requestAnimationFrame(() => ta.setSelectionRange(s + 2, s + 2))
        }
      }}
    />
  )
}

/** Inspector for Spec / Code / Annotation / Slice nodes. */
function SpecialInspector({ node: n }: { node: GNode }) {
  const w = ed.world(n.id)
  const layout = (
    <Section title={t('Layout')}>
      <div className="grid2">
        <NumberField label="X" value={n.x} apply={(v) => ed.updateNode(n.id, { x: v })} />
        <NumberField label="Y" value={n.y} apply={(v) => ed.updateNode(n.id, { y: v })} />
        {n.type !== 'ANNOTATION' && <NumberField label="W" min={1} value={w.w} apply={(v) => ed.setWorldRect(n.id, { ...ed.world(n.id), w: v })} />}
        {n.type !== 'ANNOTATION' && <NumberField label="H" min={1} value={w.h} apply={(v) => ed.setWorldRect(n.id, { ...ed.world(n.id), h: v })} />}
      </div>
    </Section>
  )
  if (n.type === 'SPEC') {
    const sp = n.spec ?? { title: '', body: '', status: 'TODO' as const }
    const set = (patch: Partial<SpecData>) => ed.updateNode(n.id, { spec: { ...sp, ...patch } })
    const rules = sp.kind === 'RULES'
    const links = (role: 'targets' | 'sources') =>
      (sp[role] ?? [])
        .filter((id) => ed.nodes.has(id))
        .map((id) => (
          <div className="row tight" key={id}>
            <button className="field" style={{ flex: 1, textAlign: 'left', cursor: 'pointer' }} title={t('Show on the canvas')} onClick={() => ed.zoomToRect(ed.world(id), 1)}>
              <span className="lbl">{ed.nodes.get(id)!.type === 'GUIDE' ? Icons.guide : ed.nodes.get(id)!.type === 'SECTION' ? Icons.section : Icons.frame}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ed.nodes.get(id)!.name}</span>
            </button>
            <MinusBtn onClick={() => ed.act(() => set({ [role]: (sp[role] ?? []).filter((x) => x !== id) }))} />
          </div>
        ))
    return (
      <>
        {layout}
        <Section title={rules ? t('Rules') : t('Task')}>
          <div className="row">
            <div className="seg">
              {(
                [
                  ['TASK', t('Task')],
                  ['RULES', t('Rules')]
                ] as const
              ).map(([v, label]) => (
                <button key={v} className={(sp.kind ?? 'TASK') === v ? 'on' : ''} onClick={() => ed.act(() => set({ kind: v === 'RULES' ? 'RULES' : undefined }))}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="row muted hint">
            {rules
              ? t('Rules are not a task to finish: the AI follows them every time it works in the linked frames.')
              : t('Spec cards are tasks for AI: MCP clients find them with list_specs and mark them done.')}
          </div>
          {!rules && (
            <>
              <div className="field-label">{t('Status')}</div>
              <div className="row">
                <div className="seg">
                  {(
                    [
                      ['TODO', t('To do')],
                      ['IN_PROGRESS', t('In progress')],
                      ['DONE', t('Done')]
                    ] as const
                  ).map(([v, label]) => (
                    <button key={v} className={sp.status === v ? 'on' : ''} onClick={() => ed.act(() => set({ status: v }))}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
          <div className="field-label">{t('Title')}</div>
          <AreaField className="prose" rows={2} value={sp.title} onCommit={(v) => set({ title: v, ...(v ? {} : {}) })} />
          <div className="field-label">{t('Description')}</div>
          <AreaField className="prose" rows={8} value={sp.body} onCommit={(v) => set({ body: v })} />
          {sp.result && !rules && (
            <>
              <div className="field-label">{t('Result')}</div>
              <AreaField className="prose" rows={4} value={sp.result} onCommit={(v) => set({ result: v })} />
            </>
          )}
        </Section>
        <Section title={t('Linked frames')}>
          {links('targets').length === 0 && <div className="row muted hint">{t('Drag the blue port on the right edge of the card to a frame or a section. The AI will see that this spec is about it.')}</div>}
          {links('targets')}
        </Section>
        <Section title={t('Materials')}>
          {links('sources').length === 0 && <div className="row muted hint">{t('Drag the violet port on the left edge to frames with components, references or an old design. The AI will build from them in the linked frames.')}</div>}
          {links('sources')}
        </Section>
      </>
    )
  }
  if (n.type === 'CODE') {
    const code = n.code ?? { html: '', css: '' }
    return (
      <>
        {layout}
        <Section title={t('Code')}>
          <div className="row muted hint">{t('HTML + CSS rendered as design. Scripts never run; only local content is shown.')}</div>
          <div className="field-label">HTML</div>
          <AreaField rows={10} value={code.html} onCommit={(v) => ed.updateNode(n.id, { code: { ...code, html: v } })} />
          <div className="field-label">CSS</div>
          <AreaField rows={10} value={code.css} onCommit={(v) => ed.updateNode(n.id, { code: { ...code, css: v } })} />
        </Section>
        <Section title={t('Export')}>
          <div className="row">
            <button className="btn" style={{ flex: 1 }} onClick={() => exportSelectionPng(2)}>
              PNG
            </button>
            <button className="btn" style={{ flex: 1 }} onClick={() => exportSelectionSvg()}>
              SVG
            </button>
          </div>
        </Section>
      </>
    )
  }
  if (n.type === 'SLICE')
    return (
      <>
        {layout}
        <Section title={t('Export')}>
          <div className="row muted hint">{t('Slices export everything inside their area.')}</div>
          <div className="row">
            <button className="btn" style={{ flex: 1 }} onClick={() => exportSelectionPng(1)}>
              PNG 1x
            </button>
            <button className="btn" style={{ flex: 1 }} onClick={() => exportSelectionPng(2)}>
              PNG 2x
            </button>
          </div>
        </Section>
      </>
    )
  // ANNOTATION
  return (
    <>
      {layout}
      <Section title={t('Note')}>
        <AreaField className="prose" rows={6} value={n.characters ?? ''} onCommit={(v) => ed.updateNode(n.id, { characters: v, name: v.split('\n')[0].slice(0, 40) || 'Annotation' })} />
        <label className="checkbox">
          <input type="checkbox" checked={!!n.resolved} onChange={(e) => ed.act(() => ed.updateNode(n.id, { resolved: e.target.checked || undefined }))} />
          {t('Resolved')}
        </label>
      </Section>
    </>
  )
}

const BlurIcon = (
  <span title="Blur">
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeDasharray="1.5 1.5">
      <circle cx="6" cy="6" r="4.5" />
    </svg>
  </span>
)
const SpreadIcon = (
  <span title="Spread">
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">
      <rect x="3.5" y="3.5" width="5" height="5" />
      <rect x="1" y="1" width="10" height="10" strokeOpacity="0.5" />
    </svg>
  </span>
)

const EFFECT_LABEL: Record<EffectType, string> = {
  DROP_SHADOW: 'Drop shadow',
  INNER_SHADOW: 'Inner shadow',
  LAYER_BLUR: 'Layer blur',
  BACKGROUND_BLUR: 'Background blur'
}

/** Figma-style effects list. Edits apply to the first selected layer's effects (copied to all selected). */
function EffectsSection({ nodes }: { nodes: GNode[] }) {
  const effects = nodes[0].effects ?? []
  const [open, setOpen] = useState<number | null>(null)
  const setAll = (fx: Effect[]) => nodes.forEach((n) => ed.updateNode(n.id, { effects: fx.length ? fx : undefined }))
  const update = (i: number, patch: Partial<Effect>) => setAll(effects.map((e, k) => (k === i ? ({ ...e, ...patch } as Effect) : e)))
  return (
    <Section
      title={t('Effects')}
      action={
        <button
          className="icon-btn"
          title={t('Add effect')}
          onClick={() => {
            ed.act(() => setAll([...effects, defaultEffect('DROP_SHADOW')]))
            setOpen(effects.length)
          }}
        >
          {Icons.plus}
        </button>
      }
    >
      {effects.map((e, i) => (
        <div key={i} className="effect">
          <div className="row">
            <button className={'icon-btn effect-toggle' + (open === i ? ' on' : '')} title={t('Effect settings')} onClick={() => setOpen(open === i ? null : i)}>
              <EffectGlyph type={e.type} />
            </button>
            <div className="field" style={{ flex: 1 }}>
              <Select
                value={e.type}
                onChange={(v) =>
                  ed.act(() => {
                    const d = defaultEffect(v)
                    // keep radius when switching, keep shadow params between the two shadow kinds
                    const next = 'offset' in d && 'offset' in e ? { ...e, type: v } : { ...d, radius: e.radius, visible: e.visible }
                    setAll(effects.map((x, k) => (k === i ? (next as Effect) : x)))
                  })
                }
                options={(Object.keys(EFFECT_LABEL) as EffectType[]).map((k) => ({ value: k, label: t(EFFECT_LABEL[k]) }))}
              />
            </div>
            <button className="icon-btn" title={e.visible === false ? t('Show') : t('Hide')} onClick={() => ed.act(() => update(i, { visible: e.visible === false }))}>
              {e.visible === false ? Icons.eyeOff : Icons.eye}
            </button>
            <button className="icon-btn" title={t('Remove')} onClick={() => ed.act(() => setAll(effects.filter((_, k) => k !== i)))}>
              <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor">
                <path d="M2 6h8" />
              </svg>
            </button>
          </div>
          {open === i && (
            <div className="effect-body">
              {'offset' in e ? (
                <>
                  <div className="grid2">
                    <NumberField label="X" value={e.offset.x} apply={(v) => update(i, { offset: { ...e.offset, x: v } } as Partial<Effect>)} />
                    <NumberField label="Y" value={e.offset.y} apply={(v) => update(i, { offset: { ...e.offset, y: v } } as Partial<Effect>)} />
                    <NumberField label={BlurIcon} min={0} value={e.radius} apply={(v) => update(i, { radius: v })} />
                    <NumberField label={SpreadIcon} value={e.spread} apply={(v) => update(i, { spread: v } as Partial<Effect>)} />
                  </div>
                  <ColorField color={e.color} apply={(c) => update(i, { color: c } as Partial<Effect>)} />
                </>
              ) : (
                <div className="grid2">
                  <NumberField label={BlurIcon} min={0} value={e.radius} apply={(v) => update(i, { radius: v })} />
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </Section>
  )
}

function EffectGlyph({ type }: { type: EffectType }) {
  if (type === 'DROP_SHADOW')
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor">
        <rect x="2" y="2" width="8" height="8" rx="1.5" />
        <path d="M12 5v6a1 1 0 01-1 1H5" strokeOpacity="0.5" />
      </svg>
    )
  if (type === 'INNER_SHADOW')
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor">
        <rect x="2" y="2" width="10" height="10" rx="1.5" />
        <path d="M4 10V5a1 1 0 011-1h5" strokeOpacity="0.5" />
      </svg>
    )
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeDasharray={type === 'LAYER_BLUR' ? '1.5 1.5' : undefined}>
      <circle cx="7" cy="7" r="5" />
      {type === 'BACKGROUND_BLUR' && <path d="M3 9h8M4 5h6" strokeOpacity="0.5" />}
    </svg>
  )
}

/** Replace / restore buttons for an image fill (shows a hint when the image bytes are missing). */
function ImageFillActions({ nodeId, hash, fromFigma }: { nodeId: string; hash: string; fromFigma: boolean }) {
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let alive = true
    isImageMissing(hash).then((m) => alive && setMissing(m))
    return () => {
      alive = false
    }
  }, [hash, ed.version('doc')]) // eslint-disable-line react-hooks/exhaustive-deps
  const replace = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/avif'
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return
      replaceImageFill(nodeId, await backend.blob.put(new Uint8Array(await f.arrayBuffer()), f.type))
    }
    input.click()
  }
  return (
    <>
      {missing && <div className="row muted hint">{fromFigma ? t('Image was not copied by Figma.') : t('Image file is missing.')}</div>}
      <div className="btn-stack">
        {missing && fromFigma && (
          <button className="btn primary" onClick={() => void restoreFigmaImages()}>
            {t('Load from Figma')}
          </button>
        )}
        <button className="btn" onClick={replace}>
          {t('Replace image…')}
        </button>
      </div>
    </>
  )
}

/** Text input with a unit (Auto / px / %), commits on Enter or blur. */
function UnitField({ label, title, value, onCommit }: { label: React.ReactNode; title: string; value: string | 'mixed'; onCommit: (raw: string) => void }) {
  const [text, setText] = useState<string | null>(null)
  const shown = value === 'mixed' ? t('Mixed') : value
  return (
    <label className="field" title={title}>
      <span className="lbl">{label}</span>
      <input
        value={text ?? shown}
        onFocus={(e) => {
          setText(value === 'mixed' ? '' : value)
          requestAnimationFrame(() => e.target.select())
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text !== null && text !== shown) ed.act(() => onCommit(text))
          setText(null)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setText(null)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
    </label>
  )
}

const FONTS = ['Inter', 'Roboto', 'Arial', 'Helvetica', 'Segoe UI', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Montserrat', 'Open Sans']

function TextSection({ nodes }: { nodes: GNode[] }) {
  const st = nodes.map((n) => n.textStyle ?? DEFAULT_TEXT_STYLE)
  const setStyle = (patch: Partial<typeof DEFAULT_TEXT_STYLE>) => nodes.forEach((n) => ed.updateNode(n.id, { textStyle: { ...(n.textStyle ?? DEFAULT_TEXT_STYLE), ...patch } }))
  const family = same(st.map((s) => s.fontFamily))
  const [fonts, setFonts] = useState(FONTS)
  useEffect(() => {
    // Local font access (offline): list installed families when the platform allows it.
    const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts
    q?.()
      .then((list) => setFonts([...new Set([...FONTS, ...list.map((f) => f.family)])].sort()))
      .catch(() => {})
  }, [])
  const tsBtn = useRef<HTMLButtonElement>(null)
  const [tsOpen, setTsOpen] = useState(false)
  const weightVal = (() => {
    const w = same(st.map((s) => s.fontWeight * 10 + (s.italic ? 1 : 0)))
    return w === 'mixed' ? null : w
  })()
  return (
    <Section
      title={t('Typography')}
      action={
        <>
          <TextStylesButton nodes={nodes} />
          <button ref={tsBtn} className={'icon-btn' + (tsOpen ? ' active-soft' : '')} title={t('Type settings')} onClick={() => setTsOpen(!tsOpen)}>
            {Icons.typeSettings}
          </button>
        </>
      }
    >
      {tsOpen && tsBtn.current && <TypeSettings nodes={nodes} anchor={tsBtn.current} onClose={() => setTsOpen(false)} />}
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <Select
            searchable
            minWidth={220}
            value={family === 'mixed' ? null : family}
            placeholder={t('Mixed')}
            onChange={(v) => ed.act(() => setStyle({ fontFamily: v }))}
            options={(fonts.includes(family as string) || family === 'mixed' ? fonts : [family as string, ...fonts]).map((f) => ({
              value: f,
              label: f,
              style: { fontFamily: `"${f}", system-ui` }
            }))}
          />
        </div>
      </div>
      <div className="grid2">
        <div className="field">
          <Select
            minWidth={170}
            value={weightVal}
            placeholder={t('Mixed')}
            onChange={(v) => ed.act(() => setStyle({ fontWeight: Math.floor(v / 10), italic: v % 10 === 1 || undefined }))}
            options={[100, 200, 300, 400, 500, 600, 700, 800, 900].flatMap((w) => {
              const name = { 100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semi Bold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black' }[w]!
              return [
                { value: w * 10, label: name, style: { fontWeight: w } },
                { value: w * 10 + 1, label: (w === 400 ? '' : name + ' ') + 'Italic', style: { fontWeight: w, fontStyle: 'italic' } }
              ]
            })}
          />
        </div>
        <NumberField label="Aa" min={1} value={same(st.map((s) => s.fontSize))} apply={(v) => setStyle({ fontSize: v })} />
        <UnitField
          label={Icons.lineHeight}
          title={t('Line height')}
          value={same(st.map((s) => (s.lineHeightPercent !== undefined ? `${round2(s.lineHeightPercent)}%` : s.lineHeight !== undefined ? String(round2(s.lineHeight)) : t('Auto'))))}
          onCommit={(raw) => {
            const v = raw.trim().toLowerCase()
            if (!v || v === 'auto' || v === t('Auto').toLowerCase()) return setStyle({ lineHeight: undefined, lineHeightPercent: undefined })
            const num = parseFloat(v)
            if (!Number.isFinite(num) || num < 0) return
            if (v.endsWith('%')) setStyle({ lineHeightPercent: num, lineHeight: undefined })
            else setStyle({ lineHeight: num, lineHeightPercent: undefined })
          }}
        />
        <UnitField
          label={Icons.letterSpacing}
          title={t('Letter spacing')}
          value={same(st.map((s) => (s.letterSpacingPercent !== undefined || !s.letterSpacing ? `${round2(s.letterSpacingPercent ?? 0)}%` : `${round2(s.letterSpacing)}px`)))}
          onCommit={(raw) => {
            const v = raw.trim().toLowerCase()
            const num = parseFloat(v)
            if (!Number.isFinite(num)) return
            if (v.endsWith('px')) setStyle({ letterSpacing: num, letterSpacingPercent: undefined })
            else setStyle({ letterSpacingPercent: num, letterSpacing: undefined })
          }}
        />
      </div>
      <div className="row split">
        <div className="seg">
          {(['LEFT', 'CENTER', 'RIGHT'] as const).map((a) => (
            <button
              key={a}
              title={t(a === 'LEFT' ? 'Align left' : a === 'CENTER' ? 'Align center' : 'Align right')}
              className={same(st.map((s) => s.align)) === a ? 'on' : ''}
              onClick={() => ed.act(() => setStyle({ align: a }))}
            >
              {a === 'LEFT' ? Icons.tAlignL : a === 'CENTER' ? Icons.tAlignC : Icons.tAlignR}
            </button>
          ))}
        </div>
        <div className="seg">
          {(
            [
              ['TOP', t('Top'), Icons.vAlignTop],
              ['CENTER', t('Middle'), Icons.vAlignMid],
              ['BOTTOM', t('Bottom'), Icons.vAlignBottom]
            ] as const
          ).map(([v, label, icon]) => (
            <button key={v} title={label} className={same(st.map((s) => s.verticalAlign ?? 'TOP')) === v ? 'on' : ''} onClick={() => ed.act(() => setStyle({ verticalAlign: v }))}>
              {icon}
            </button>
          ))}
        </div>
      </div>
      <div className="row split">
        <span className="muted">{t('Resizing')}</span>
        {/* icons + tooltips like Figma, so the control always fits the panel */}
        <div className="seg">
          {(
            [
              ['WIDTH_AND_HEIGHT', t('Auto width'), Icons.autoW],
              ['HEIGHT', t('Auto height'), Icons.autoH],
              ['NONE', t('Fixed size'), Icons.fixedSize]
            ] as const
          ).map(([m, label, icon]) => (
            <button
              key={m}
              title={label}
              className={same(nodes.map((n) => n.textAutoResize ?? 'WIDTH_AND_HEIGHT')) === m ? 'on' : ''}
              onClick={() => ed.act(() => nodes.forEach((n) => ed.updateNode(n.id, { textAutoResize: m })))}
            >
              {icon}
            </button>
          ))}
        </div>
      </div>
    </Section>
  )
}
