import { useEffect, useRef, useState } from 'react'
import { rgbaToCss } from '@shared/types'
import { editor as ed } from '../editor/editor'
import { CanvasController } from '../editor/canvas'
import { copySelection, handlePaste } from '../editor/clipboard'
import { cssFont, letterSpacingOf, lineHeightOf, DEFAULT_TEXT_STYLE } from '../editor/text'
import { useEditor } from './hooks'
import { Icons } from './icons'
import { LeftPanel } from './LeftPanel'
import { RightPanel } from './RightPanel'
import { handleKey, importFile, importPages, runAction, saveThumbnail } from './actions'
import { Toolbar } from './Toolbar'
import { ContextMenu } from './ContextMenu'
import { useT } from './i18n'
import { AnnotationEditor } from './AnnotationEditor'
import { ActionsPalette } from './ActionsPalette'
import { GuidesPalette } from './GuidesPalette'
import { PanelGrip } from './PanelGrip'
import { PluginHost } from './PluginHost'
import { backend } from '../backend'
import { imageFillOf, replaceImageFill } from '../editor/figma-images'
import { offerFigmaImages } from './actions'

export function EditorView({ onHome }: { onHome: () => void }) {
  useEditor('ui')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ctrlRef = useRef<CanvasController | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [annotationId, setAnnotationId] = useState<string | null>(null)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [guidesOpen, setGuidesOpen] = useState(false)
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    // the layers panel opens the same menu
    const h = (e: Event) => setCtx((e as CustomEvent<{ x: number; y: number }>).detail)
    window.addEventListener('gigma-context', h)
    return () => window.removeEventListener('gigma-context', h)
  }, [])

  useEffect(() => {
    const c = new CanvasController(canvasRef.current!)
    ctrlRef.current = c
    c.onEditText = (id) => {
      ed.editingTextId = id
      setEditingId(id)
      ed.emit('doc')
    }
    c.onEditAnnotation = (id) => setAnnotationId(id)
    requestAnimationFrame(() => ed.zoomToFit())
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+K: actions (physical key, any layout); Ctrl+Alt+K is "Create component"
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        setActionsOpen(true)
        return
      }
      // Ctrl+Shift+U: the guideline library
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyU') {
        e.preventDefault()
        setGuidesOpen(true)
        return
      }
      handleKey(e)
    }
    const onCopy = (e: ClipboardEvent) => {
      if (ed.editingTextId || isEditable(e.target)) return
      e.preventDefault()
      void copySelection(false)
    }
    const onCut = (e: ClipboardEvent) => {
      if (ed.editingTextId || isEditable(e.target)) return
      e.preventDefault()
      void copySelection(true)
    }
    const onPaste = (e: ClipboardEvent) => {
      if (ed.editingTextId || isEditable(e.target)) return
      void handlePaste(e)
    }
    const onMenu = (e: Event) => {
      const a = (e as CustomEvent<string>).detail
      if (a === 'import-pages') void importPages()
      else runAction(a)
    }
    const onFigmaPasted = (e: Event) => void offerFigmaImages((e as CustomEvent<string[]>).detail)
    window.addEventListener('gigma-figma-pasted', onFigmaPasted)
    window.addEventListener('keydown', onKey)
    document.addEventListener('copy', onCopy)
    document.addEventListener('cut', onCut)
    document.addEventListener('paste', onPaste)
    window.addEventListener('gigma-menu', onMenu)
    const thumbTimer = setInterval(() => void saveThumbnail(), 60_000)
    return () => {
      c.dispose()
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('cut', onCut)
      document.removeEventListener('paste', onPaste)
      window.removeEventListener('gigma-menu', onMenu)
      window.removeEventListener('gigma-figma-pasted', onFigmaPasted)
      clearInterval(thumbTimer)
    }
  }, [])

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    const r = canvasRef.current!.getBoundingClientRect()
    const at = ed.screenToWorld(e.clientX - r.left, e.clientY - r.top)
    const files = Array.from(e.dataTransfer.files)
    // dropping one image onto a layer that has an image fill replaces that image
    const hit = files.length === 1 && files[0].type.startsWith('image/') && files[0].type !== 'image/svg+xml' ? ed.hitTest(at.x, at.y, true) : null
    if (hit && imageFillOf(hit)) {
      const hash = await backend.blob.put(new Uint8Array(await files[0].arrayBuffer()), files[0].type)
      replaceImageFill(hit, hash)
      ed.setSelection([hit])
      return
    }
    for (const f of files) {
      if (f.name.endsWith('.gigma')) ed.showToast('Use File → Import Pages to add pages from a .gigma file')
      else await importFile(f, at)
    }
  }

  return (
    <div className="editor">
      {ed.leftOpen && <LeftPanel onHome={onHome} />}
      {ed.leftOpen && <PanelGrip side="left" />}
      <div className="canvas-wrap" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <canvas
          ref={canvasRef}
          tabIndex={0}
          onContextMenu={(e) => {
            e.preventDefault()
            const r = canvasRef.current!.getBoundingClientRect()
            const p = ed.screenToWorld(e.clientX - r.left, e.clientY - r.top)
            // right-click selects what is under the cursor unless it is already part of the selection
            const hit = ed.hitTest(p.x, p.y, e.ctrlKey || e.metaKey)
            if (hit && !ed.selection.includes(hit)) ed.setSelection([hit])
            if (!hit) ed.setSelection([])
            setCtx({ x: e.clientX, y: e.clientY })
          }}
        />
        {ctx && <ContextMenu x={ctx.x} y={ctx.y} onClose={() => setCtx(null)} />}
        {editingId && (
          <TextEditor
            id={editingId}
            onDone={() => {
              ed.editingTextId = null
              setEditingId(null)
              ed.emit('doc')
              canvasRef.current?.focus()
            }}
          />
        )}
        {!ed.leftOpen && (
          <button className="icon-btn float-btn" style={{ left: 10 }} title="Show left panel (Ctrl+\)" onClick={() => runAction('toggle-left')}>
            {Icons.sidebarL}
          </button>
        )}
        {!ed.rightOpen && (
          <button className="icon-btn float-btn" style={{ right: 10 }} title="Show right panel (Ctrl+Alt+\)" onClick={() => runAction('toggle-right')}>
            {Icons.sidebarR}
          </button>
        )}
        <Toolbar onActions={() => setActionsOpen(true)} onGuides={() => setGuidesOpen(true)} />
        <ZoomChip />
        {annotationId && <AnnotationEditor id={annotationId} onClose={() => setAnnotationId(null)} />}
        {actionsOpen && <ActionsPalette onClose={() => setActionsOpen(false)} />}
        {guidesOpen && <GuidesPalette onClose={() => setGuidesOpen(false)} />}
        <PluginHost />
        {ed.toast && (
          <div className="toast">
            <span>{ed.toast}</span>
            {ed.toastAction && (
              <button
                className="toast-action"
                onClick={() => {
                  const a = ed.toastAction!
                  ed.hideToast()
                  a.run()
                }}
              >
                {ed.toastAction.label}
              </button>
            )}
            {ed.toastAction && (
              <button className="toast-close" onClick={() => ed.hideToast()}>
                ×
              </button>
            )}
          </div>
        )}
      </div>
      {ed.rightOpen && <PanelGrip side="right" />}
      {ed.rightOpen && <RightPanel />}
    </div>
  )
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}


/** Zoom percentage with Figma's zoom menu. */
function ZoomChip() {
  useEditor('camera')
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', down, true)
    return () => window.removeEventListener('mousedown', down, true)
  }, [open])
  const items: ([string, string, () => void] | null)[] = [
    ['Zoom in', 'Ctrl++', () => ed.setZoom(ed.camera.zoom * 2)],
    ['Zoom out', 'Ctrl+-', () => ed.setZoom(ed.camera.zoom / 2)],
    ['Zoom to fit', 'Shift+1', () => ed.zoomToFit()],
    ['Zoom to selection', 'Shift+2', () => ed.zoomToRect(ed.selectionBounds(), 8)],
    null,
    ['Zoom to 50%', '', () => ed.setZoom(0.5)],
    ['Zoom to 100%', 'Ctrl+0', () => ed.setZoom(1)],
    ['Zoom to 200%', '', () => ed.setZoom(2)]
  ]
  return (
    <div ref={ref}>
      <button className="zoom-chip" onClick={() => setOpen(!open)}>
        {Math.round(ed.camera.zoom * 100)}%
      </button>
      {open && (
        <div className="tool-menu zoom-menu" style={{ position: 'absolute', right: 10, bottom: 56 }}>
          {items.map((it, i) =>
            it ? (
              <button key={i} className="tool-menu-item" onClick={() => (setOpen(false), it[2]())}>
                <span className="tm-label">{t(it[0])}</span>
                <span className="tm-key">{it[1]}</span>
              </button>
            ) : (
              <div key={i} className="ctx-sep" />
            )
          )}
        </div>
      )}
    </div>
  )
}

function TextEditor({ id, onDone }: { id: string; onDone: () => void }) {
  useEditor('camera', 'doc')
  const ref = useRef<HTMLTextAreaElement>(null)
  const n = ed.nodes.get(id)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
    ed.begin() // whole editing session = one undo step
  }, [])
  if (!n) return null
  const w = ed.world(id)
  const s = n.textStyle ?? DEFAULT_TEXT_STYLE
  const fill = n.fills.find((f) => f.type === 'SOLID')
  const z = ed.camera.zoom
  const auto = (n.textAutoResize ?? 'WIDTH_AND_HEIGHT') === 'WIDTH_AND_HEIGHT'
  const finish = () => {
    const v = ref.current?.value ?? ''
    if (!v.trim()) {
      ed.deleteNode(id)
      ed.selection = ed.selection.filter((s) => s !== id)
    }
    ed.commit()
    ed.emit('selection')
    onDone()
  }
  return (
    <textarea
      ref={ref}
      className="text-editor"
      defaultValue={n.characters}
      spellCheck={false}
      style={{
        left: w.x * z + ed.camera.x,
        top: w.y * z + ed.camera.y,
        width: (auto ? Math.max(w.w, 4) + s.fontSize : w.w) ,
        height: Math.max(w.h, lineHeightOf(s)),
        transform: `scale(${z})`,
        font: cssFont(s),
        lineHeight: lineHeightOf(s) + 'px',
        letterSpacing: letterSpacingOf(s) + 'px',
        textAlign: (s.align === 'JUSTIFIED' ? 'justify' : s.align.toLowerCase()) as 'left',
        textDecoration: s.decoration === 'UNDERLINE' ? 'underline' : s.decoration === 'STRIKETHROUGH' ? 'line-through' : undefined,
        textTransform: s.textCase === 'UPPER' ? 'uppercase' : s.textCase === 'LOWER' ? 'lowercase' : s.textCase === 'TITLE' ? 'capitalize' : undefined,
        color: fill && fill.type === 'SOLID' ? rgbaToCss(fill.color) : '#000',
        whiteSpace: auto ? 'pre' : 'pre-wrap'
      }}
      onChange={(e) => {
        ed.updateNode(id, { characters: e.target.value, name: e.target.value.split('\n')[0].slice(0, 40) || 'Text' })
        ed.emit('doc')
      }}
      onBlur={finish}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
          e.preventDefault()
          ref.current?.blur()
        }
      }}
    />
  )
}
