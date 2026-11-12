// Figma-like "Type settings" popover: Basics (preview, alignment, decoration, case) and
// Details (list style, paragraph spacing, truncation).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GNode, TextStyle } from '@shared/types'
import { rgbaToCss } from '@shared/types'
import { editor as ed } from '../editor/editor'
import { DEFAULT_TEXT_STYLE, applyCase, letterSpacingOf, lineHeightOf } from '../editor/text'
import { t } from './i18n'
import { Icons } from './icons'

type Patch = Partial<TextStyle>

const sameOf = <T,>(vals: T[]): T | 'mixed' => (vals.every((v) => v === vals[0]) ? vals[0] : 'mixed')

function Seg<T extends string>({ value, items, onPick }: { value: T | 'mixed'; items: { v: T; label: React.ReactNode; title: string }[]; onPick: (v: T) => void }) {
  return (
    <div className="seg">
      {items.map((it) => (
        <button key={it.v} title={it.title} className={value === it.v ? 'on' : ''} onClick={() => onPick(it.v)}>
          {it.label}
        </button>
      ))}
    </div>
  )
}

export function TypeSettings({ nodes, anchor, onClose }: { nodes: GNode[]; anchor: HTMLElement; onClose: () => void }) {
  const [tab, setTab] = useState<'basics' | 'details'>('basics')
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const pop = useRef<HTMLDivElement>(null)
  const st = nodes.map((n) => n.textStyle ?? DEFAULT_TEXT_STYLE)
  const s0 = st[0]
  const set = (patch: Patch) => ed.act(() => nodes.forEach((n) => ed.updateNode(n.id, { textStyle: { ...(n.textStyle ?? DEFAULT_TEXT_STYLE), ...patch } })))

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect()
    // like Figma: open to the left of the inspector panel, not over it
    const panelLeft = (anchor.closest('.panel') as HTMLElement | null)?.getBoundingClientRect().left ?? r.left
    const W = 280
    const H = 470
    setPos({ left: Math.max(8, panelLeft - W - 8), top: Math.max(8, Math.min(window.innerHeight - H - 8, r.top - 20)) })
  }, [anchor])
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const tgt = e.target as Node
      if (pop.current?.contains(tgt) || anchor.contains(tgt)) return
      // dropdown popups are portaled too: don't close when picking from them
      if ((tgt as HTMLElement).closest?.('.gsel-pop')) return
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

  const fill = nodes[0].fills.find((f) => f.type === 'SOLID')
  const sample = applyCase(nodes[0].characters?.split('\n')[0]?.slice(0, 40) || 'Rag 123', s0.textCase)

  return createPortal(
    <div ref={pop} className="tset" style={{ left: pos.left, top: pos.top }} onKeyDown={(e) => e.stopPropagation()}>
      <div className="tset-head">
        <div className="text-tabs">
          <button className={tab === 'basics' ? 'on' : ''} onClick={() => setTab('basics')}>
            {t('Basics')}
          </button>
          <button className={tab === 'details' ? 'on' : ''} onClick={() => setTab('details')}>
            {t('Details')}
          </button>
        </div>
        <button className="icon-btn" title={t('Close')} onClick={onClose}>
          <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.3">
            <path d="M2 2l6 6M8 2l-6 6" />
          </svg>
        </button>
      </div>

      {tab === 'basics' ? (
        <>
          <div
            className="tset-preview"
            style={(() => {
              // show the text in its real colour on a contrasting backdrop
              const c = fill && fill.type === 'SOLID' ? fill.color : null
              if (!c) return undefined
              const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
              return { background: lum < 0.5 ? '#f3f3f3' : '#1f1f1f', color: rgbaToCss({ ...c, a: 1 }) }
            })()}
          >
            <span
              style={{
                fontFamily: `"${s0.fontFamily}", system-ui`,
                fontWeight: s0.fontWeight,
                fontStyle: s0.italic ? 'italic' : undefined,
                fontSize: Math.min(28, Math.max(12, s0.fontSize)),
                letterSpacing: (letterSpacingOf(s0) / s0.fontSize) * Math.min(28, Math.max(12, s0.fontSize)) + 'px',
                lineHeight: lineHeightOf(s0) / s0.fontSize,
                textDecoration: s0.decoration === 'UNDERLINE' ? 'underline' : s0.decoration === 'STRIKETHROUGH' ? 'line-through' : undefined
              }}
            >
              {sample}
            </span>
          </div>
          <div className="tset-row">
            <span>{t('Alignment')}</span>
            <Seg
              value={sameOf(st.map((s) => s.align))}
              onPick={(v) => set({ align: v })}
              items={[
                { v: 'LEFT', label: Icons.tAlignL, title: t('Align left') },
                { v: 'CENTER', label: Icons.tAlignC, title: t('Align center') },
                { v: 'RIGHT', label: Icons.tAlignR, title: t('Align right') },
                { v: 'JUSTIFIED', label: Icons.tJustify, title: t('Justify') }
              ]}
            />
          </div>
          <div className="tset-row">
            <span>{t('Decoration')}</span>
            <Seg
              value={sameOf(st.map((s) => s.decoration ?? 'NONE'))}
              onPick={(v) => set({ decoration: v })}
              items={[
                { v: 'NONE', label: '—', title: t('None') },
                { v: 'UNDERLINE', label: <u>U</u>, title: t('Underline') },
                { v: 'STRIKETHROUGH', label: <s>S</s>, title: t('Strikethrough') }
              ]}
            />
          </div>
          <div className="tset-row">
            <span>{t('Case')}</span>
            <Seg
              value={sameOf(st.map((s) => s.textCase ?? 'ORIGINAL'))}
              onPick={(v) => set({ textCase: v })}
              items={[
                { v: 'ORIGINAL', label: '—', title: t('As typed') },
                { v: 'UPPER', label: 'AG', title: t('Upper case') },
                { v: 'LOWER', label: 'ag', title: t('Lower case') },
                { v: 'TITLE', label: 'Ag', title: t('Title case') }
              ]}
            />
          </div>
          <div className="tset-row">
            <span>{t('Italic')}</span>
            <Seg
              value={sameOf(st.map((s) => (s.italic ? 'I' : 'N')))}
              onPick={(v) => set({ italic: v === 'I' || undefined })}
              items={[
                { v: 'N', label: '—', title: t('None') },
                { v: 'I', label: <i style={{ fontFamily: 'serif' }}>I</i>, title: t('Italic') }
              ]}
            />
          </div>
        </>
      ) : (
        <>
          <div className="tset-row">
            <span>{t('Vertical trim')}</span>
            <Seg
              value={sameOf(st.map((s) => s.verticalTrim ?? 'STANDARD'))}
              onPick={(v) => set({ verticalTrim: v === 'STANDARD' ? undefined : v })}
              items={[
                {
                  v: 'STANDARD',
                  title: t('Standard'),
                  label: (
                    <svg width="18" height="16" viewBox="0 0 18 16" fill="none" stroke="currentColor">
                      <path d="M2 1.5h14M2 14.5h14" strokeOpacity="0.5" />
                      <text x="9" y="11.5" textAnchor="middle" fontSize="9" fill="currentColor" stroke="none" fontFamily="Inter, sans-serif" fontWeight="600">
                        Ag
                      </text>
                    </svg>
                  )
                },
                {
                  v: 'CAP_HEIGHT',
                  title: t('Cap height to baseline'),
                  label: (
                    <svg width="18" height="16" viewBox="0 0 18 16" fill="none" stroke="currentColor">
                      <path d="M2 4.5h14M2 11.5h14" strokeOpacity="0.5" />
                      <text x="9" y="11.5" textAnchor="middle" fontSize="9" fill="currentColor" stroke="none" fontFamily="Inter, sans-serif" fontWeight="600">
                        Ag
                      </text>
                    </svg>
                  )
                }
              ]}
            />
          </div>
          <div className="tset-row">
            <span>{t('Wrap style')}</span>
            <Seg
              value={sameOf(st.map((s) => s.wrapStyle ?? 'AUTO'))}
              onPick={(v) => set({ wrapStyle: v === 'AUTO' ? undefined : v })}
              items={[
                { v: 'AUTO', label: t('Auto'), title: t('Fill each line, then wrap') },
                { v: 'BALANCED', label: t('Balanced'), title: t('Even line lengths') }
              ]}
            />
          </div>
          <div className="tset-row">
            <span>{t('List style')}</span>
            <Seg
              value={sameOf(st.map((s) => s.listStyle ?? 'NONE'))}
              onPick={(v) => set({ listStyle: v })}
              items={[
                { v: 'NONE', label: '—', title: t('None') },
                { v: 'BULLET', label: Icons.listBullet, title: t('Bulleted list') },
                { v: 'NUMBER', label: Icons.listNumber, title: t('Numbered list') }
              ]}
            />
          </div>
          <div className="tset-row">
            <span>{t('Paragraph spacing')}</span>
            <input
              className="tset-num"
              type="number"
              min={0}
              value={sameOf(st.map((s) => s.paragraphSpacing ?? 0)) === 'mixed' ? '' : (s0.paragraphSpacing ?? 0)}
              onChange={(e) => set({ paragraphSpacing: Math.max(0, +e.target.value || 0) })}
            />
          </div>
          <div className="tset-row">
            <span>{t('Truncate text')}</span>
            <Seg
              value={sameOf(st.map((s) => (s.truncate ? 'Y' : 'N')))}
              onPick={(v) => {
                set({ truncate: v === 'Y' || undefined })
                // truncation needs a fixed box, like in Figma
                if (v === 'Y') ed.act(() => nodes.forEach((n) => ed.updateNode(n.id, { textAutoResize: 'NONE' })))
              }}
              items={[
                { v: 'N', label: '—', title: t('None') },
                { v: 'Y', label: 'A…', title: t('Truncate with ellipsis') }
              ]}
            />
          </div>
          <div className="tset-row">
            <span>{t('Vertical align')}</span>
            <Seg
              value={sameOf(st.map((s) => s.verticalAlign ?? 'TOP'))}
              onPick={(v) => set({ verticalAlign: v })}
              items={[
                { v: 'TOP', label: Icons.vAlignTop, title: t('Top') },
                { v: 'CENTER', label: Icons.vAlignMid, title: t('Middle') },
                { v: 'BOTTOM', label: Icons.vAlignBottom, title: t('Bottom') }
              ]}
            />
          </div>
        </>
      )}
    </div>,
    document.body
  )
}
