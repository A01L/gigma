// Runs one plugin at a time (like Figma): a floating window with the plugin page in a sandboxed
// frame. The page cannot touch the app; it sends requests with postMessage and this host answers.
import { useEffect, useRef, useState } from 'react'
import type { GNode } from '@shared/types'
import type { PluginInfo } from '@shared/api'
import { editor as ed } from '../editor/editor'
import { backend } from '../backend'
import { base64ToBytes } from '../editor/util'
import { usePlugins } from './plugins'
import { t } from './i18n'

/** a layer as plugins see it: every property plus its position on the page */
function describe(n: GNode) {
  const w = ed.world(n.id)
  return { ...structuredClone(n), absX: w.x, absY: w.y }
}
const selectionData = () => ed.selection.map((id) => ed.nodes.get(id)).filter((n): n is GNode => !!n).map(describe)
const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')

export function PluginHost() {
  const plugins = usePlugins()
  const [id, setId] = useState<string | null>(null)
  // a new key reloads the frame when the same plugin is started again
  const [run, setRun] = useState(0)
  const [size, setSize] = useState({ w: 300, h: 400 })
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const undoOpen = useRef(false)
  const plugin: PluginInfo | undefined = plugins.find((p) => p.id === id)

  const closeUndo = () => {
    if (!undoOpen.current) return
    undoOpen.current = false
    ed.commit()
  }
  const close = () => {
    closeUndo()
    setId(null)
  }

  useEffect(() => {
    const start = (e: Event) => {
      closeUndo()
      setId((e as CustomEvent<string>).detail)
      setRun((n) => n + 1)
      setPos(null)
    }
    window.addEventListener('gigma-run-plugin', start)
    return () => window.removeEventListener('gigma-run-plugin', start)
  }, [])

  useEffect(() => {
    if (!plugin) return
    const ui = plugin.ui === false ? null : (plugin.ui ?? {})
    setSize({ w: Math.max(160, Math.min(900, ui?.width ?? 300)), h: Math.max(80, Math.min(800, ui?.height ?? 400)) })
    const post = (msg: unknown) => frame.current?.contentWindow?.postMessage(msg, '*')
    const event = (name: string, data: unknown) => post({ gigma: 'event', name, data })

    const handle = async (method: string, p: Record<string, unknown>): Promise<unknown> => {
      switch (method) {
        case 'hello':
          return { plugin: { id: plugin.id, name: plugin.name, version: plugin.version, permissions: plugin.permissions ?? [] }, theme: theme(), locale: document.documentElement.lang || 'en', selection: selectionData(), page: { id: ed.currentPageId, name: ed.page.name } }
        case 'command':
          return backend.plugins.command(plugin.id, String(p.name), p.args)
        case 'selection':
          return selectionData()
        case 'viewport': {
          const v = ed.visibleWorldRect()
          return { x: v.x, y: v.y, width: v.w, height: v.h, centerX: v.x + v.w / 2, centerY: v.y + v.h / 2, zoom: ed.camera.zoom }
        }
        case 'notify':
          ed.showToast(String(p.text).slice(0, 300))
          return null
        case 'close':
          close()
          return null
        case 'resize':
          setSize({ w: Math.max(160, Math.min(900, Number(p.width) || 300)), h: Math.max(80, Math.min(800, Number(p.height) || 400)) })
          return null
        case 'createImage': {
          const m = /^data:([^;,]+)[^,]*;base64,(.*)$/s.exec(String(p.source))
          if (!m) throw new Error('createImage needs a data: URL, a Blob or bytes')
          return backend.blob.put(base64ToBytes(m[2]), m[1])
        }
        case 'fetch':
          return backend.plugins.fetch(plugin.id, String(p.url), p.as as 'text')
        case 'capturePage': {
          const shot = await backend.plugins.capture(plugin.id, { url: String(p.url), width: Number(p.width) || 1440, mobile: !!p.mobile, maxHeight: Number(p.maxHeight) || undefined })
          // the picture goes straight into the project; the plugin gets its hash
          const imageHash = await backend.blob.put(shot.bytes, shot.mime)
          return { imageHash, width: shot.width, height: shot.height, title: shot.title }
        }
        case 'storageGet':
          return backend.plugins.storageGet(plugin.id, String(p.key))
        case 'storageSet':
          return backend.plugins.storageSet(plugin.id, String(p.key), p.value)
        case 'beginUndo':
          if (!undoOpen.current) {
            undoOpen.current = true
            ed.begin()
          }
          return null
        case 'endUndo':
          closeUndo()
          return null
        case 'undo':
          closeUndo()
          ed.undo()
          return null
        case 'redo':
          closeUndo()
          ed.redo()
          return null
        default:
          throw new Error('unknown method: ' + method)
      }
    }

    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const m = e.data as { gigma?: string; id?: number; method?: string; params?: Record<string, unknown> }
      if (!m || m.gigma !== 'call' || typeof m.method !== 'string') return
      handle(m.method, m.params ?? {}).then(
        (result) => post({ gigma: 'reply', id: m.id, result }),
        // "Error invoking remote method 'x': Error: message" -> "message"
        (err) => post({ gigma: 'reply', id: m.id, error: String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '') })
      )
    }
    window.addEventListener('message', onMessage)
    const offSel = ed.subscribe('selection', () => event('selectionchange', selectionData()))
    const offPage = ed.subscribe('pages', () => event('pagechange', { id: ed.currentPageId, name: ed.page.name }))
    const themeWatch = new MutationObserver(() => event('themechange', theme()))
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      window.removeEventListener('message', onMessage)
      offSel()
      offPage()
      themeWatch.disconnect()
      closeUndo()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin?.id, run])

  if (!plugin) return null
  const hidden = plugin.ui === false
  const startDrag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
    const host = (e.currentTarget.parentElement!.parentElement as HTMLElement).getBoundingClientRect()
    const dx = e.clientX - box.left
    const dy = e.clientY - box.top
    // the frame would swallow pointer events while dragging over it
    if (frame.current) frame.current.style.pointerEvents = 'none'
    const move = (ev: PointerEvent) =>
      setPos({ x: Math.max(0, Math.min(host.width - 80, ev.clientX - host.left - dx)), y: Math.max(0, Math.min(host.height - 32, ev.clientY - host.top - dy)) })
    const up = () => {
      if (frame.current) frame.current.style.pointerEvents = ''
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div className={'plugin-win' + (hidden ? ' hidden' : '')} style={pos ? { left: pos.x, top: pos.y, right: 'auto' } : undefined} onMouseDown={(e) => e.stopPropagation()}>
      <div className="plugin-head" onPointerDown={startDrag}>
        {plugin.iconUrl ? <img src={plugin.iconUrl} alt="" /> : <span className="plugin-dot" />}
        <span className="plugin-title">{plugin.name}</span>
        <button className="icon-btn" title={t('Close')} onClick={close}>
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" fill="none">
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </svg>
        </button>
      </div>
      <iframe
        key={plugin.id + ':' + run}
        ref={frame}
        className="plugin-frame"
        title={plugin.name}
        src={plugin.url}
        // scripts only: no same-origin, so the page cannot reach the app, cookies or storage
        sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
        style={{ width: size.w, height: size.h }}
      />
    </div>
  )
}
