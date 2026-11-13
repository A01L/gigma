// The editor of a guideline (right panel, shown while its dot or card is selected).
// Everything typed here goes to the shared library, so it changes in every project that uses the guideline.
import { useEffect, useRef, useState } from 'react'
import type { GNode, GuideData, GuideImage } from '@shared/types'
import { editor as ed } from '../editor/editor'
import { guides, newGuideId, removeGuide, saveGuide, setGuideOpen } from '../editor/guides'
import { guideAccent } from '../editor/guide-render'
import { backend } from '../backend'
import { Icons } from './icons'
import { useT } from './i18n'
import { Select } from './Select'
import './guide.css'

const FONTS = ['Inter', 'Roboto', 'Arial', 'Helvetica', 'Segoe UI', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Montserrat', 'Open Sans']
/** pictures are kept inside the guideline file: keep each one reasonable */
const MAX_IMAGE = 3 * 1024 * 1024

/** fonts installed on this computer (asked once), on top of the usual ones */
let localFonts: string[] | null = null
function useFonts(): string[] {
  const [fonts, setFonts] = useState(localFonts ?? FONTS)
  useEffect(() => {
    if (localFonts) return
    const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts
    q?.()
      .then((list) => {
        localFonts = [...new Set([...FONTS, ...list.map((f) => f.family)])].sort()
        setFonts(localFonts)
      })
      .catch(() => {})
  }, [])
  return fonts
}
const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900]
/** backdrops offered for a picture: none, white, black */
const BACKDROPS: [string | undefined, string][] = [
  [undefined, 'Transparent'],
  ['#ffffff', 'White'],
  ['#111111', 'Dark']
]

/** text field that saves when you leave it or press Enter */
function In({ value, onCommit, placeholder, list, area, rows = 3 }: { value: string; onCommit: (v: string) => void; placeholder?: string; list?: string; area?: boolean; rows?: number }) {
  const [text, setText] = useState<string | null>(null)
  const props = {
    value: text ?? value,
    placeholder,
    spellCheck: false,
    onFocus: () => setText(value),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setText(e.target.value),
    onBlur: () => {
      if (text !== null && text !== value) onCommit(text)
      setText(null)
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      e.stopPropagation()
      if (e.key === 'Enter' && !area) (e.target as HTMLElement).blur()
      if (e.key === 'Escape') (setText(null), (e.target as HTMLElement).blur())
    }
  }
  return area ? <textarea className="g-in" rows={rows} {...props} /> : <input className="g-in" list={list} {...props} />
}

const hex6 = (h: string) => (/^#[0-9a-f]{6}$/i.test(h) ? h : /^#[0-9a-f]{3}$/i.test(h) ? '#' + [...h.slice(1)].map((c) => c + c).join('') : '#888888')
const cleanHex = (v: string, old: string) => {
  const s = v.trim().replace(/^#?/, '#')
  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s) ? s.toLowerCase() : old
}

function Swatch({ hex, onChange }: { hex: string; onChange: (h: string) => void }) {
  return (
    <label className="g-swatch" style={{ background: hex }}>
      <input type="color" value={hex6(hex)} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

function Gallery({ images, onChange }: { images: GuideImage[]; onChange: (list: GuideImage[]) => void }) {
  const t = useT()
  const file = useRef<HTMLInputElement>(null)
  const add = async (files: FileList | null) => {
    const out = [...images]
    for (const f of Array.from(files ?? [])) {
      if (!f.type.startsWith('image/')) continue
      if (f.size > MAX_IMAGE) {
        ed.showToast(t('“{name}” is larger than 3 MB and was skipped', { name: f.name }))
        continue
      }
      const dataUrl = await new Promise<string>((res) => {
        const r = new FileReader()
        r.onload = () => res(String(r.result))
        r.readAsDataURL(f)
      })
      out.push({ id: newGuideId(), name: f.name.replace(/\.[^.]+$/, ''), dataUrl })
    }
    onChange(out)
  }
  return (
    <div className="g-gallery">
      {images.map((im) => (
        <div key={im.id} className="g-thumb" title={im.name}>
          <img className={im.bg ? '' : 'clear'} style={im.bg ? { background: im.bg } : undefined} src={im.dataUrl} alt="" draggable={false} />
          <div className="g-bgs" title={t('Backdrop in the card. The file itself stays transparent.')}>
            {BACKDROPS.map(([bg, label]) => (
              <i key={label} className={(im.bg ?? '') === (bg ?? '') ? 'on' : ''} title={t(label)} style={bg ? { background: bg } : undefined} onClick={() => onChange(images.map((x) => (x.id === im.id ? { ...x, bg } : x)))} />
            ))}
            <label title={t('Other colour')} style={{ background: im.bg && !BACKDROPS.some(([b]) => b === im.bg) ? im.bg : undefined }} className={im.bg && !BACKDROPS.some(([b]) => b === im.bg) ? 'on' : 'pick'}>
              <input type="color" value={hex6(im.bg ?? '#888888')} onChange={(e) => onChange(images.map((x) => (x.id === im.id ? { ...x, bg: e.target.value } : x)))} />
            </label>
          </div>
          <button title={t('Remove')} onClick={() => onChange(images.filter((x) => x.id !== im.id))}>
            ×
          </button>
          <In value={im.name} placeholder={t('Name')} onCommit={(v) => onChange(images.map((x) => (x.id === im.id ? { ...x, name: v } : x)))} />
        </div>
      ))}
      <button className="g-add-img" onClick={() => file.current?.click()} title={t('Add image')}>
        {Icons.plus}
      </button>
      <input
        ref={file}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void add(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}

function Block({ title, onAdd, children }: { title: string; onAdd?: () => void; children?: React.ReactNode }) {
  return (
    <div className="section g-block">
      <div className="g-head">
        <span>{title}</span>
        {onAdd && (
          <button className="icon-btn" onClick={onAdd}>
            {Icons.plus}
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

export function GuideInspector({ node }: { node: GNode }) {
  const t = useT()
  const fonts = useFonts()
  const g = guides.get(node.guide?.id ?? '')
  if (!g) return <div className="section g-block muted">{t('This guideline is not in the library.')}</div>
  const set = (patch: Partial<GuideData>) => saveGuide({ ...g, ...patch, updatedAt: Date.now() })
  const targets = (node.guide?.targets ?? []).filter((id) => ed.nodes.has(id))
  return (
    <div className="guide-ins">
      <Block title={t('Guideline')}>
        <div className="muted g-hint">{t('A guideline is shared: an edit here changes it in every project that uses it.')}</div>
        <In value={g.name} placeholder={t('Name')} onCommit={(v) => set({ name: v || 'Guideline' })} />
        <In area rows={2} value={g.description ?? ''} placeholder={t('What this design system is for')} onCommit={(v) => set({ description: v })} />
        <div className="g-row">
          <Swatch hex={guideAccent(g)} onChange={(h) => set({ accent: h })} />
          <span className="g-grow">{t('Accent colour')}</span>
          <In value={g.accent ?? ''} placeholder="#" onCommit={(v) => set({ accent: v.trim() ? cleanHex(v, g.accent ?? '') : undefined })} />
        </div>
        <div className="g-row">
          {node.guide?.open ? (
            <button className="btn g-grow primary" onClick={() => setGuideOpen(node.id, false)}>
              {t('Save and fold')}
            </button>
          ) : (
            <button className="btn g-grow" onClick={() => setGuideOpen(node.id, true)}>
              {t('Open the card')}
            </button>
          )}
        </div>
        <div className="g-row">
          <button className="btn g-grow" onClick={() => void backend.guides.exportFile(g.id)}>
            {t('Export…')}
          </button>
        </div>
      </Block>

      <Block title={t('Colors')} onAdd={() => set({ colors: [...g.colors, { id: newGuideId(), name: '', role: '', hex: '#cccccc' }] })}>
        {g.colors.map((c) => {
          const upd = (p: Partial<typeof c>) => set({ colors: g.colors.map((x) => (x.id === c.id ? { ...x, ...p } : x)) })
          return (
            <div key={c.id} className="g-item">
              <div className="g-row">
                <Swatch hex={c.hex} onChange={(h) => upd({ hex: h })} />
                <In value={c.name} placeholder={t('Name')} onCommit={(v) => upd({ name: v })} />
                <In value={c.hex} placeholder="#" onCommit={(v) => upd({ hex: cleanHex(v, c.hex) })} />
                <button className="icon-btn" title={t('Remove')} onClick={() => set({ colors: g.colors.filter((x) => x.id !== c.id) })}>
                  ×
                </button>
              </div>
              <In value={c.role ?? ''} placeholder={t('What it is for: buttons, background…')} onCommit={(v) => upd({ role: v })} />
            </div>
          )
        })}
      </Block>

      <Block title={t('Typography')} onAdd={() => set({ fonts: [...g.fonts, { id: newGuideId(), role: '', family: 'Inter', weight: 400, size: 16 }] })}>
        {g.fonts.map((f) => {
          const upd = (p: Partial<typeof f>) => set({ fonts: g.fonts.map((x) => (x.id === f.id ? { ...x, ...p } : x)) })
          const num = (v: string, old: number, min: number, max: number) => (Number.isFinite(parseFloat(v)) ? Math.max(min, Math.min(max, parseFloat(v))) : old)
          return (
            <div key={f.id} className="g-item">
              <div className="g-row">
                <In value={f.role} placeholder={t('Role: heading, body…')} onCommit={(v) => upd({ role: v })} />
                <button className="icon-btn" title={t('Remove')} onClick={() => set({ fonts: g.fonts.filter((x) => x.id !== f.id) })}>
                  ×
                </button>
              </div>
              <div className="g-row g-font">
                <div className="g-sel g-grow">
                  <Select
                    searchable
                    value={f.family}
                    onChange={(v) => upd({ family: v })}
                    options={[...new Set([f.family, ...fonts])].map((name) => ({ value: name, label: name, style: { fontFamily: `"${name}", Inter, sans-serif` } }))}
                  />
                </div>
                <div className="g-sel g-weight">
                  <Select value={f.weight} onChange={(v) => upd({ weight: v })} options={WEIGHTS.map((w) => ({ value: w, label: String(w) }))} />
                </div>
                <In value={String(f.size)} placeholder="16" onCommit={(v) => upd({ size: num(v, f.size, 1, 999) })} />
              </div>
            </div>
          )
        })}
      </Block>

      <Block title={t('Logo')}>
        <Gallery images={g.logos} onChange={(logos) => set({ logos })} />
      </Block>
      <Block title={t('Patterns and images')}>
        <Gallery images={g.patterns} onChange={(patterns) => set({ patterns })} />
      </Block>
      <Block title={t('Rules')}>
        <In area rows={6} value={g.rules} placeholder={t('Tone, spacing, what to do and what to avoid. The AI reads this.')} onCommit={(v) => set({ rules: v })} />
      </Block>

      {g.sections.map((s) => {
        const upd = (p: Partial<typeof s>) => set({ sections: g.sections.map((x) => (x.id === s.id ? { ...x, ...p } : x)) })
        return (
          <div key={s.id} className="section g-block">
            <div className="g-row">
              <In value={s.title} placeholder={t('Section title')} onCommit={(v) => upd({ title: v })} />
              <button className="icon-btn" title={t('Remove')} onClick={() => set({ sections: g.sections.filter((x) => x.id !== s.id) })}>
                ×
              </button>
            </div>
            <In area rows={4} value={s.text} placeholder={t('Text')} onCommit={(v) => upd({ text: v })} />
            <Gallery images={s.images} onChange={(images) => upd({ images })} />
          </div>
        )
      })}
      <div className="section g-block">
        <button className="btn" style={{ width: '100%' }} onClick={() => set({ sections: [...g.sections, { id: newGuideId(), title: '', text: '', images: [] }] })}>
          {t('Add a section')}
        </button>
      </div>

      <Block title={t('Linked frames')}>
        {!targets.length && <div className="muted g-hint">{t('Drag the port on the right of the dot to a frame or a section, or to the left port of a Spec card. The AI will follow this guideline there.')}</div>}
        {targets.map((id) => (
          <div className="g-row" key={id}>
            <button className="g-link g-grow" title={t('Show on the canvas')} onClick={() => ed.zoomToRect(ed.world(id), 1)}>
              {ed.nodes.get(id)!.type === 'SECTION' ? Icons.section : Icons.frame}
              <span>{ed.nodes.get(id)!.name}</span>
            </button>
            <button className="icon-btn" title={t('Remove')} onClick={() => ed.act(() => ed.updateNode(node.id, { guide: { ...node.guide!, targets: targets.filter((x) => x !== id) } }))}>
              ×
            </button>
          </div>
        ))}
      </Block>
      <div className="section g-block">
        <button
          className="btn danger"
          style={{ width: '100%' }}
          onClick={() => {
            if (confirm(t('Delete “{name}” from the library? It will disappear from every project.', { name: g.name }))) void removeGuide(g.id)
          }}
        >
          {t('Delete from the library')}
        </button>
      </div>
    </div>
  )
}
