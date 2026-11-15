// Brushes for the mask of a picture whose background was removed: "Erase" hides more of the picture, "Restore" brings
// it back. The picture itself is never touched: the brushes paint the mask, and every stroke is one step of history
// (Ctrl+Z takes it back while the brushes are open, too). With "Snap to edges" on, a stroke only spreads over pixels
// whose colour is close to the one under the cursor, so it stops at the outline of the object.
import { useEffect, useRef, useState } from 'react'
import { editor as ed } from '../editor/editor'
import { cutByMask, imageKey, imagePlacement, liveImages, loadImage } from '../editor/render'
import { imagePaintOf, maskSizeFor, putMask, setMask } from '../editor/matting'
import { backend } from '../backend'
import { t } from './i18n'

type Mode = 'erase' | 'restore'
/** the brush settings stay as they were set while the app runs */
const last = { mode: 'erase' as Mode, size: 40, soft: 50, snap: true }

interface Work {
  bmp: ImageBitmap
  /** the mask being painted: white, alpha = what is kept */
  mask: HTMLCanvasElement
  mctx: CanvasRenderingContext2D
  /** the picture at the size of the mask, for "Snap to edges" */
  pixels: Uint8ClampedArray
  /** the picture cut by the mask as it is right now: what the canvas shows */
  live: HTMLCanvasElement
  keys: Set<string>
  /** the mask hash this state was last saved as (undefined = no mask) */
  saved: string | undefined
}

export function MaskEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const [mode, setModeState] = useState<Mode>(last.mode)
  const [size, setSizeState] = useState(last.size)
  const [soft, setSoftState] = useState(last.soft)
  const [snap, setSnapState] = useState(last.snap)
  const [ready, setReady] = useState(false)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const work = useRef<Work | null>(null)
  const opts = useRef({ mode, size, soft, snap })
  opts.current = { mode, size, soft, snap }
  const setMode = (v: Mode) => ((last.mode = v), setModeState(v))
  const setSize = (v: number) => ((last.size = v), setSizeState(v))
  const setSoft = (v: number) => ((last.soft = v), setSoftState(v))
  const setSnap = (v: boolean) => ((last.snap = v), setSnapState(v))
  const redraw = () => (window as unknown as { canvasView?: { invalidate(): void } }).canvasView?.invalidate()

  /** fill the working mask from a stored one (or make it whole) and show the result */
  const loadMask = async (w: Work, hash: string | undefined) => {
    w.mctx.globalCompositeOperation = 'copy'
    if (hash) {
      const blob = await (await fetch(backend.blob.url(hash))).blob()
      w.mctx.drawImage(await createImageBitmap(blob), 0, 0, w.mask.width, w.mask.height)
    } else {
      w.mctx.fillStyle = '#fff'
      w.mctx.fillRect(0, 0, w.mask.width, w.mask.height)
    }
    w.mctx.globalCompositeOperation = 'source-over'
    w.saved = hash
    cutByMask(w.bmp, w.mask, w.live)
    redraw()
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      const found = imagePaintOf(ed.nodes.get(id))
      const bmp = found ? await loadImage(found.paint.imageHash) : null
      if (!alive) return
      if (!found || !bmp) return onClose()
      const ms = maskSizeFor(bmp.width, bmp.height)
      const mask = document.createElement('canvas')
      mask.width = ms.w
      mask.height = ms.h
      const mctx = mask.getContext('2d', { willReadFrequently: true })!
      const small = new OffscreenCanvas(ms.w, ms.h)
      const sg = small.getContext('2d', { willReadFrequently: true })!
      sg.drawImage(bmp, 0, 0, ms.w, ms.h)
      const live = document.createElement('canvas')
      const w: Work = { bmp, mask, mctx, pixels: sg.getImageData(0, 0, ms.w, ms.h).data, live, keys: new Set(), saved: undefined }
      await loadMask(w, found.paint.maskHash)
      if (!alive) return
      const key = imageKey(found.paint)
      liveImages.set(key, live)
      w.keys.add(key)
      work.current = w
      setReady(true)
      redraw()
    })()
    // undo and redo while the brushes are open: the mask follows the document
    const off = ed.subscribe('doc', () => {
      const w = work.current
      const now = imagePaintOf(ed.nodes.get(id))
      if (!now) return onClose()
      if (!w || now.paint.maskHash === w.saved) return
      const key = imageKey(now.paint)
      liveImages.set(key, w.live)
      w.keys.add(key)
      void loadMask(w, now.paint.maskHash)
    })
    return () => {
      alive = false
      off()
      for (const k of work.current?.keys ?? []) liveImages.delete(k)
      work.current = null
      redraw()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault()
        e.stopImmediatePropagation()
        onClose()
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.code === 'KeyE') setMode('erase')
        else if (e.code === 'KeyR') setMode('restore')
        else if (e.key === '[') setSize(Math.max(2, Math.round(opts.current.size * 0.8)))
        else if (e.key === ']') setSize(Math.min(600, Math.round(opts.current.size * 1.25) + 1))
        else return
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** a point on the screen (inside the canvas area) -> a pixel of the mask, and how many mask pixels one layer pixel is */
  const toMask = (clientX: number, clientY: number): { x: number; y: number; scale: number } | null => {
    const w = work.current
    const n = ed.nodes.get(id)
    const found = imagePaintOf(n)
    const canvas = document.querySelector<HTMLCanvasElement>('.canvas-wrap canvas')
    if (!w || !n || !found || !canvas) return null
    const cr = canvas.getBoundingClientRect()
    const p = ed.screenToWorld(clientX - cr.left, clientY - cr.top)
    const r = ed.world(id)
    // into the layer's own space: its turn and its flips taken back
    let dx = p.x - (r.x + r.w / 2)
    let dy = p.y - (r.y + r.h / 2)
    if (n.rotation) {
      const a = (n.rotation * Math.PI) / 180
      ;[dx, dy] = [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)]
    }
    if (n.flipX) dx = -dx
    if (n.flipY) dy = -dy
    const at = imagePlacement(found.paint, r, w.bmp.width, w.bmp.height)
    const scale = w.mask.width / at.w
    return { x: (r.x + r.w / 2 + dx - at.x) * scale, y: (r.y + r.h / 2 + dy - at.y) * (w.mask.height / at.h), scale }
  }

  /** one touch of the brush on the mask, at a mask pixel */
  const dab = (cx: number, cy: number, radius: number, ref: [number, number, number] | null) => {
    const w = work.current
    if (!w) return
    const { mode, soft, snap } = opts.current
    const x0 = Math.max(0, Math.floor(cx - radius))
    const y0 = Math.max(0, Math.floor(cy - radius))
    const x1 = Math.min(w.mask.width, Math.ceil(cx + radius))
    const y1 = Math.min(w.mask.height, Math.ceil(cy + radius))
    if (x1 <= x0 || y1 <= y0) return
    const img = w.mctx.getImageData(x0, y0, x1 - x0, y1 - y0)
    const d = img.data
    // the brush is full inside its hard core and fades to nothing at its rim
    const core = radius * (1 - soft / 100)
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
        if (dist >= radius) continue
        let k = dist <= core ? 1 : 1 - (dist - core) / Math.max(0.001, radius - core)
        if (snap && ref) {
          // only pixels that look like the one the stroke started on: the stroke stops at the outline of the object
          const i = (y * w.mask.width + x) * 4
          const far = Math.hypot(w.pixels[i] - ref[0], w.pixels[i + 1] - ref[1], w.pixels[i + 2] - ref[2])
          k *= far <= 36 ? 1 : far >= 84 ? 0 : 1 - (far - 36) / 48
        }
        if (k <= 0) continue
        const o = ((y - y0) * (x1 - x0) + (x - x0)) * 4
        d[o] = d[o + 1] = d[o + 2] = 255
        d[o + 3] = mode === 'erase' ? Math.round(d[o + 3] * (1 - k)) : Math.round(d[o + 3] + (255 - d[o + 3]) * k)
      }
    }
    w.mctx.putImageData(img, x0, y0)
  }

  const stroke = useRef<{ x: number; y: number; ref: [number, number, number] | null; dirty: boolean; raf: number } | null>(null)
  const show = () => {
    const w = work.current
    const s = stroke.current
    if (!w || !s || s.raf) return
    s.raf = requestAnimationFrame(() => {
      s.raf = 0
      cutByMask(w.bmp, w.mask, w.live)
      redraw()
    })
  }
  const down = (e: React.PointerEvent) => {
    const w = work.current
    if (!w || e.button !== 0) return
    const p = toMask(e.clientX, e.clientY)
    if (!p) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const ix = Math.min(w.mask.width - 1, Math.max(0, Math.round(p.x)))
    const iy = Math.min(w.mask.height - 1, Math.max(0, Math.round(p.y)))
    const i = (iy * w.mask.width + ix) * 4
    stroke.current = { x: p.x, y: p.y, ref: [w.pixels[i], w.pixels[i + 1], w.pixels[i + 2]], dirty: true, raf: 0 }
    dab(p.x, p.y, (opts.current.size / 2) * p.scale, stroke.current.ref)
    show()
  }
  const move = (e: React.PointerEvent) => {
    const canvas = document.querySelector<HTMLCanvasElement>('.canvas-wrap canvas')
    const cr = canvas?.getBoundingClientRect()
    if (cr) setCursor({ x: e.clientX - cr.left, y: e.clientY - cr.top })
    const s = stroke.current
    if (!s) return
    const p = toMask(e.clientX, e.clientY)
    if (!p) return
    // touches close enough to one another to read as one line
    const radius = (opts.current.size / 2) * p.scale
    const step = Math.max(1, radius * 0.3)
    const len = Math.hypot(p.x - s.x, p.y - s.y)
    for (let d = step; d <= len; d += step) dab(s.x + ((p.x - s.x) * d) / len, s.y + ((p.y - s.y) * d) / len, radius, s.ref)
    if (len >= step) {
      s.x = p.x
      s.y = p.y
      show()
    }
  }
  const up = async () => {
    const s = stroke.current
    const w = work.current
    stroke.current = null
    if (!s || !w) return
    cancelAnimationFrame(s.raf)
    cutByMask(w.bmp, w.mask, w.live)
    // the stroke becomes a mask of its own in the project, and one step of history
    const hash = await putMask(w.mask)
    const found = imagePaintOf(ed.nodes.get(id))
    if (!found || work.current !== w) return
    w.saved = hash
    const key = imageKey({ ...found.paint, maskHash: hash })
    liveImages.set(key, w.live)
    w.keys.add(key)
    setMask(id, found.index, hash)
    redraw()
  }
  /** the wheel still pans and zooms the canvas under the brushes */
  const wheel = (e: React.WheelEvent) => {
    const canvas = document.querySelector<HTMLCanvasElement>('.canvas-wrap canvas')
    const n = e.nativeEvent
    canvas?.dispatchEvent(new WheelEvent('wheel', { deltaX: n.deltaX, deltaY: n.deltaY, deltaMode: n.deltaMode, clientX: n.clientX, clientY: n.clientY, ctrlKey: n.ctrlKey, shiftKey: n.shiftKey, metaKey: n.metaKey, bubbles: true, cancelable: true }))
  }
  const whole = async (keep: boolean) => {
    const w = work.current
    const found = imagePaintOf(ed.nodes.get(id))
    if (!w || !found) return
    w.mctx.globalCompositeOperation = 'copy'
    w.mctx.fillStyle = keep ? '#fff' : 'rgba(255,255,255,0)'
    w.mctx.fillRect(0, 0, w.mask.width, w.mask.height)
    w.mctx.globalCompositeOperation = 'source-over'
    cutByMask(w.bmp, w.mask, w.live)
    const hash = keep ? undefined : await putMask(w.mask)
    w.saved = hash
    const key = imageKey({ ...found.paint, maskHash: hash })
    liveImages.set(key, w.live)
    w.keys.add(key)
    setMask(id, found.index, hash)
    redraw()
  }

  const d = size * ed.camera.zoom
  return (
    <>
      <div className="mask-stage" onPointerDown={down} onPointerMove={move} onPointerUp={() => void up()} onPointerLeave={() => setCursor(null)} onWheel={wheel} onContextMenu={(e) => e.preventDefault()}>
        {cursor && ready && <div className={'mask-brush ' + mode} style={{ left: cursor.x - d / 2, top: cursor.y - d / 2, width: d, height: d }} />}
      </div>
      <div className="mask-bar" onPointerDown={(e) => e.stopPropagation()}>
        <div className="seg">
          <button className={mode === 'erase' ? 'on' : ''} title={t('Hide parts of the picture') + ' (E)'} onClick={() => setMode('erase')}>
            {t('Erase')}
          </button>
          <button className={mode === 'restore' ? 'on' : ''} title={t('Bring parts of the picture back') + ' (R)'} onClick={() => setMode('restore')}>
            {t('Restore')}
          </button>
        </div>
        <label title={t('Brush size') + ' ([ ])'}>
          <span>{t('Size')}</span>
          <input type="range" min={2} max={300} value={Math.min(300, size)} onChange={(e) => setSize(+e.target.value)} />
          <b>{size}</b>
        </label>
        <label title={t('How soft the edge of the brush is')}>
          <span>{t('Softness')}</span>
          <input type="range" min={0} max={100} value={soft} onChange={(e) => setSoft(+e.target.value)} />
          <b>{soft}%</b>
        </label>
        <label className="checkbox" title={t('A stroke spreads only over colours close to the one under the cursor, so it stops at the outline of the object')}>
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
          {t('Snap to edges')}
        </label>
        <button className="btn" title={t('The whole picture is shown again')} onClick={() => void whole(true)}>
          {t('Show all')}
        </button>
        <button className="btn primary" onClick={onClose}>
          {t('Done')}
        </button>
      </div>
    </>
  )
}
