// Popover for an annotation pin: write / edit the note, resolve or delete it.
import { useEffect, useRef, useState } from 'react'
import { editor as ed } from '../editor/editor'
import { useEditor } from './hooks'
import { useT } from './i18n'

export function AnnotationEditor({ id, onClose }: { id: string; onClose: () => void }) {
  useEditor('camera', 'doc')
  const t = useT()
  const n = ed.nodes.get(id)
  const [text, setText] = useState(n?.characters ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  if (!n) return null
  const w = ed.world(id)
  const sx = w.x * ed.camera.zoom + ed.camera.x
  const sy = w.y * ed.camera.zoom + ed.camera.y
  const save = () => {
    const v = text.trim()
    if (!v && !n.characters) ed.act(() => ed.deleteNode(id)) // empty new note: discard
    else if (v !== n.characters) ed.act(() => ed.updateNode(id, { characters: v, name: v.split('\n')[0].slice(0, 40) || 'Annotation' }))
    onClose()
  }
  return (
    <div className="anno" style={{ left: sx + 36, top: Math.max(8, sy - 40) }} onMouseDown={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        className="anno-input"
        placeholder={t('Add an annotation')}
        value={text}
        rows={Math.min(8, Math.max(1, text.split('\n').length))}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            save()
          }
          if (e.key === 'Escape') onClose()
        }}
      />
      <div className="anno-actions">
        {n.characters && (
          <>
            <button
              className="anno-btn"
              title={t('Resolve')}
              onClick={() => {
                ed.act(() => ed.updateNode(id, { resolved: true }))
                onClose()
              }}
            >
              ✓ {t('Resolve')}
            </button>
            <button
              className="anno-btn danger"
              onClick={() => {
                ed.act(() => ed.deleteNode(id))
                onClose()
              }}
            >
              {t('Delete')}
            </button>
          </>
        )}
        <button className="anno-send" title={t('Save')} onClick={save} disabled={!text.trim()}>
          ↑
        </button>
      </div>
    </div>
  )
}
