// CODE nodes: live HTML + CSS rendered as design, fully offline.
// The markup is serialized to XHTML and drawn through an SVG <foreignObject> image, so
// scripts never run and nothing is fetched from the network.
import type { GNode } from '@shared/types'
import { backend } from '../backend'

type Entry = { bmp: ImageBitmap | null; promise: Promise<ImageBitmap | null>; failed?: boolean }
const cache = new Map<string, Entry>()
let onReady: () => void = () => {}
export function setCodeReadyCallback(fn: () => void): void {
  onReady = fn
}

export const DEFAULT_CODE = {
  html: '<div class="card">\n  <h2>Hello from code</h2>\n  <p>Edit HTML and CSS in the inspector.</p>\n  <button>Action</button>\n</div>',
  css:
    '.card { font-family: Inter, "Segoe UI", sans-serif; padding: 24px; border-radius: 16px; background: #fff; color: #111;\n  box-shadow: 0 8px 24px rgba(0,0,0,.12); }\n' +
    'h2 { margin: 0 0 8px; font-size: 22px; }\np { margin: 0 0 16px; color: #555; }\n' +
    'button { border: 0; border-radius: 10px; padding: 10px 18px; background: #0d99ff; color: #fff; font-weight: 600; }'
}

/** Convert loose HTML into well-formed XHTML (required inside SVG). Strips scripts and event handlers. */
function toXhtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  doc.querySelectorAll('script, iframe, object, embed, link[rel="import"]').forEach((e) => e.remove())
  doc.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) if (a.name.startsWith('on')) el.removeAttribute(a.name)
  })
  const ser = new XMLSerializer()
  return [...doc.body.childNodes].map((nd) => ser.serializeToString(nd)).join('')
}

function buildSvg(html: string, css: string, w: number, h: number): string {
  const safeCss = css.replace(/<\/style/gi, '')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<foreignObject x="0" y="0" width="${w}" height="${h}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;overflow:hidden;margin:0;box-sizing:border-box">` +
    `<style>*{box-sizing:border-box}${safeCss.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</style>${toXhtml(html)}</div>` +
    `</foreignObject></svg>`
  )
}

async function render(n: GNode, w: number, h: number, scale: number): Promise<ImageBitmap | null> {
  // Desktop: real Chromium rendering in a sandboxed, script-less, offline window (keeps the canvas exportable)
  const viaMain = backend.code.render(n.code?.html ?? '', n.code?.css ?? '', w, h, scale)
  if (viaMain) {
    const bytes = await viaMain
    return createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }))
  }
  // Web mode fallback: SVG foreignObject (may taint the canvas, fine for previews)
  const svg = buildSvg(n.code?.html ?? '', n.code?.css ?? '', w, h)
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await img.decode()
  return createImageBitmap(img, { resizeWidth: Math.max(1, Math.round(w * scale)), resizeHeight: Math.max(1, Math.round(h * scale)), resizeQuality: 'high' })
}

/** Resolution buckets: re-render only when zoom changes a lot. */
const bucket = (s: number) => Math.min(4, Math.pow(2, Math.ceil(Math.log2(Math.max(0.25, s)))))

/** Cached bitmap for drawing; null while rendering (callback fires when ready). */
export function getCodeBitmap(n: GNode, w: number, h: number, deviceScale: number): ImageBitmap | null {
  const s = bucket(deviceScale)
  const key = JSON.stringify([n.code?.html, n.code?.css, Math.round(w), Math.round(h), s])
  let e = cache.get(key)
  if (!e) {
    const entry: Entry = { bmp: null, promise: Promise.resolve(null) }
    entry.promise = render(n, Math.round(w), Math.round(h), s)
      .then((b) => {
        entry.bmp = b
        onReady()
        return b
      })
      .catch(() => {
        entry.failed = true
        return null
      })
    cache.set(key, entry)
    e = entry
    if (cache.size > 200) cache.delete(cache.keys().next().value!)
  }
  return e.bmp
}

export async function codeBitmapAsync(n: GNode, w: number, h: number, scale: number): Promise<ImageBitmap | null> {
  getCodeBitmap(n, w, h, scale)
  const s = bucket(scale)
  return cache.get(JSON.stringify([n.code?.html, n.code?.css, Math.round(w), Math.round(h), s]))!.promise
}

export async function codeToPngDataUrl(n: GNode, w: number, h: number): Promise<string | null> {
  const bmp = await codeBitmapAsync(n, w, h, 2)
  if (!bmp) return null
  const c = document.createElement('canvas')
  c.width = bmp.width
  c.height = bmp.height
  c.getContext('2d')!.drawImage(bmp, 0, 0)
  return c.toDataURL('image/png')
}
