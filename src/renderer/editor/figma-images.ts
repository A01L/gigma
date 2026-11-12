// Restoring images of layers pasted from Figma (whose clipboard holds only image hashes).
import type { Paint } from '@shared/types'
import { backend } from '../backend'
import { editor as ed } from './editor'
import { forgetImage, isImageMissing } from './render'

type ImagePaint = Extract<Paint, { type: 'IMAGE' }>

/** Missing images in the whole document, grouped by Figma file key. */
export async function missingFigmaImages(nodeIds?: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  const nodes = nodeIds ? nodeIds.map((id) => ed.nodes.get(id)).filter(Boolean) : [...ed.nodes.values()]
  const checked = new Map<string, boolean>()
  for (const n of nodes) {
    for (const f of n!.fills) {
      if (f.type !== 'IMAGE' || !f.figmaFileKey) continue
      let miss = checked.get(f.imageHash)
      if (miss === undefined) checked.set(f.imageHash, (miss = await isImageMissing(f.imageHash)))
      if (!miss) continue
      let s = out.get(f.figmaFileKey)
      if (!s) out.set(f.figmaFileKey, (s = new Set()))
      s.add(f.imageHash)
    }
  }
  return out
}

export async function countMissingImages(): Promise<number> {
  let n = 0
  for (const s of (await missingFigmaImages()).values()) n += s.size
  return n
}

export interface FetchSummary {
  restored: number
  failed: number
  error?: string // NO_TOKEN | FORBIDDEN | NETWORK… | HTTP_…
}

/** Download originals from Figma for every missing image in the document. */
export async function fetchFigmaImages(): Promise<FetchSummary> {
  const missing = await missingFigmaImages()
  let restored = 0
  let failed = 0
  let error: string | undefined
  const remap = new Map<string, string>()
  for (const [fileKey, hashes] of missing) {
    const r = await backend.figma.fetchImages(fileKey, [...hashes])
    if (r.error) error = r.error
    for (const [from, to] of Object.entries(r.mapped)) {
      remap.set(from, to)
      forgetImage(from)
      forgetImage(to)
      restored++
    }
    failed += r.failed.length
  }
  // the blob hash normally equals Figma's hash; re-point fills if it does not
  const changed = [...remap].filter(([a, b]) => a !== b)
  if (changed.length) {
    ed.act(() => {
      for (const n of ed.nodes.values()) {
        if (!n.fills.some((f) => f.type === 'IMAGE' && remap.has(f.imageHash) && remap.get(f.imageHash) !== f.imageHash)) continue
        ed.updateNode(n.id, {
          fills: n.fills.map((f) => (f.type === 'IMAGE' && remap.has(f.imageHash) ? { ...f, imageHash: remap.get(f.imageHash)! } : f))
        })
      }
    })
  }
  ed.emit('doc')
  return { restored, failed, error }
}

/** Put a new image into the node's image fill (or add one). */
export function replaceImageFill(nodeId: string, hash: string): void {
  const n = ed.nodes.get(nodeId)
  if (!n) return
  forgetImage(hash)
  const has = n.fills.some((f) => f.type === 'IMAGE')
  const fills: Paint[] = has
    ? n.fills.map((f) => (f.type === 'IMAGE' ? ({ ...f, imageHash: hash, figmaFileKey: undefined } as ImagePaint) : f))
    : [...n.fills.filter((f) => f.type !== 'SOLID'), { type: 'IMAGE', imageHash: hash, scaleMode: 'FILL' }]
  ed.act(() => ed.updateNode(nodeId, { fills }))
}

export function imageFillOf(nodeId: string): ImagePaint | undefined {
  return ed.nodes.get(nodeId)?.fills.find((f): f is ImagePaint => f.type === 'IMAGE')
}
