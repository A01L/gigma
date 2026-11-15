// Background removal for picture fills. The picture itself is never changed: the result is a mask (a PNG whose alpha
// says what is kept) stored next to it in the project and named by the fill (maskHash). Removing the mask brings the
// background back, and every change of it is one step of history.
import type { GNode, Paint } from '@shared/types'
import { backend } from '../backend'
import { editor as ed } from './editor'
import { loadImage } from './render'

export type ImagePaint = Extract<Paint, { type: 'IMAGE' }>
/** the side of the square the model looks at (see main/matting.ts) */
const MODEL_SIZE = 1024
/** masks are kept at the size of the picture, but never larger than this on a side */
export const MASK_MAX = 2048

/** the picture fill a layer is seen by: its top visible image fill */
export function imagePaintOf(n: GNode | undefined): { paint: ImagePaint; index: number } | null {
  if (!n) return null
  for (let i = n.fills.length - 1; i >= 0; i--) {
    const f = n.fills[i]
    if (f.type === 'IMAGE' && f.visible !== false) return { paint: f, index: i }
  }
  return null
}

export function maskSizeFor(w: number, h: number): { w: number; h: number } {
  const k = Math.min(1, MASK_MAX / Math.max(w, h, 1))
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) }
}

/** store a mask canvas (white, alpha = what is kept) in the project; returns its hash */
export async function putMask(c: HTMLCanvasElement | OffscreenCanvas): Promise<string> {
  const blob = 'convertToBlob' in c ? await c.convertToBlob({ type: 'image/png' }) : await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('could not encode the mask'))), 'image/png'))
  return backend.blob.put(new Uint8Array(await blob.arrayBuffer()), 'image/png')
}

/** set (or drop) the mask of the picture fill of a layer, as one step of history */
export function setMask(nodeId: string, index: number, maskHash: string | undefined): void {
  const n = ed.nodes.get(nodeId)
  if (!n) return
  ed.act(() => ed.updateNode(nodeId, { fills: n.fills.map((f, i) => (i === index && f.type === 'IMAGE' ? { ...f, maskHash } : f)) }))
}

/**
 * Remove the background of the picture of a layer. Resolves with what the model ran on and how long it took.
 * Works offline: the model is part of the app.
 */
export async function removeBackground(nodeId: string): Promise<{ device: string; ms: number }> {
  const n = ed.nodes.get(nodeId)
  const found = imagePaintOf(n)
  if (!n || !found) throw new Error('The layer has no picture')
  const bmp = await loadImage(found.paint.imageHash)
  if (!bmp) throw new Error('The picture of this layer is not in the project')
  // the model takes a 1024 × 1024 picture: the whole picture is squeezed into it, and its answer stretched back
  const sq = new OffscreenCanvas(MODEL_SIZE, MODEL_SIZE)
  const g = sq.getContext('2d', { willReadFrequently: true })!
  g.imageSmoothingQuality = 'high'
  g.drawImage(bmp, 0, 0, MODEL_SIZE, MODEL_SIZE)
  const rgba = new Uint8Array(g.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data.buffer)
  const res = await backend.matting.run(rgba)
  // the answer as a picture: white, with the mask in its alpha
  const small = new OffscreenCanvas(MODEL_SIZE, MODEL_SIZE)
  const sg = small.getContext('2d')!
  const img = sg.createImageData(MODEL_SIZE, MODEL_SIZE)
  for (let i = 0; i < MODEL_SIZE * MODEL_SIZE; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255
    img.data[i * 4 + 3] = res.mask[i]
  }
  sg.putImageData(img, 0, 0)
  const size = maskSizeFor(bmp.width, bmp.height)
  const full = new OffscreenCanvas(size.w, size.h)
  const fg = full.getContext('2d')!
  fg.imageSmoothingQuality = 'high'
  fg.drawImage(small, 0, 0, size.w, size.h)
  const hash = await putMask(full)
  // the layer may have changed while the model was working: the mask goes to the same picture, wherever it is now
  const now = imagePaintOf(ed.nodes.get(nodeId))
  if (!now || now.paint.imageHash !== found.paint.imageHash) throw new Error('The picture was changed while its background was being removed')
  setMask(nodeId, now.index, hash)
  return { device: res.device, ms: res.ms }
}

/** bring the background back: the mask is dropped, the picture was never touched */
export function restoreBackground(nodeId: string): void {
  const found = imagePaintOf(ed.nodes.get(nodeId))
  if (found?.paint.maskHash) setMask(nodeId, found.index, undefined)
}
