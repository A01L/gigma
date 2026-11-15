// Background removal, offline: the BiRefNet model (full, MIT licence) run by onnxruntime on this computer.
// The model file ships inside the installer (resources/models/birefnet.onnx); nothing is sent anywhere.
// It runs on the graphics card when there is one that can (WebGPU, then DirectML on Windows / CoreML on macOS),
// and on the processor otherwise. The first run loads the model, which takes a few seconds; it then stays in memory
// for a couple of minutes so the next pictures are quick, and is let go after that.
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type * as Ort from 'onnxruntime-node'

/** the side of the square picture the model looks at */
export const MATTING_SIZE = 1024
const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]
const IDLE_MS = 150_000

export function mattingModelPath(): string | null {
  const places = [join(process.resourcesPath ?? '', 'models', 'birefnet.onnx'), join(app.getAppPath(), 'models', 'birefnet.onnx'), join(process.cwd(), 'models', 'birefnet.onnx')]
  return places.find((p) => existsSync(p)) ?? null
}

let session: Ort.InferenceSession | null = null
let device = ''
/** index in providers() of the one the session runs on */
let using = -1
let loading: Promise<Ort.InferenceSession> | null = null
let idle: NodeJS.Timeout | null = null
/** one picture at a time: two runs side by side would need twice the memory */
let queue: Promise<unknown> = Promise.resolve()

/**
 * Graphics first, the processor last. WebGPU cannot run the Split nodes of the decoder of this model (they need more
 * buffers in one shader than a card allows), so those are left to the processor and everything else runs on the card:
 * about two and a half times quicker than the processor alone. DirectML runs out of memory on this model and is not tried.
 */
function providers(): { label: string; ep: Ort.InferenceSession.SessionOptions['executionProviders'] }[] {
  const splits = ['/decoder/Split', ...Array.from({ length: 200 }, (_, i) => '/decoder/Split_' + (i + 1))]
  return [
    { label: 'GPU (WebGPU)', ep: [{ name: 'webgpu', forceCpuNodeNames: splits } as unknown as Ort.InferenceSession.ExecutionProviderConfig] },
    { label: 'CPU', ep: ['cpu'] }
  ]
}

/** start the model on the first provider from `from` on that loads */
async function load(from = 0): Promise<Ort.InferenceSession> {
  if (session && using >= from) return session
  loading ??= (async () => {
    const path = mattingModelPath()
    if (!path) throw new Error('The background removal model is missing from this build (models/birefnet.onnx)')
    const ort = (await import('onnxruntime-node')) as typeof Ort
    await unload()
    let last: unknown
    const forced = process.env.GIGMA_MATTING_DEVICE
    const list = providers()
    for (let i = from; i < list.length; i++) {
      if (forced && !list[i].label.toLowerCase().includes(forced.toLowerCase())) continue
      try {
        // without the memory arena the processor side keeps about a gigabyte instead of more than ten
        session = await ort.InferenceSession.create(path, { executionProviders: list[i].ep, graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false })
        device = list[i].label
        using = i
        return session
      } catch (e) {
        last = e
      }
    }
    throw new Error('Could not start the background removal model: ' + String((last as Error)?.message ?? last).split(/\r?\n/)[0])
  })().finally(() => (loading = null))
  return loading
}

async function infer(ort: typeof Ort, s: Ort.InferenceSession, chw: Float32Array): Promise<Float32Array> {
  const input = new ort.Tensor('float32', chw, [1, 3, MATTING_SIZE, MATTING_SIZE])
  const out = await s.run({ [s.inputNames[0]]: input })
  // the model gives several maps (coarse to fine); the last output is the final one
  const t = out[s.outputNames[s.outputNames.length - 1]]
  return t.data as Float32Array
}

/**
 * rgba: MATTING_SIZE × MATTING_SIZE pixels of the picture (stretched to the square). Returns the mask of the subject,
 * one byte per pixel (255 = keep), and what it ran on.
 */
export function removeBackground(rgba: Uint8Array): Promise<{ mask: Uint8Array; device: string; ms: number }> {
  const run = async () => {
    const n = MATTING_SIZE * MATTING_SIZE
    if (rgba.length !== n * 4) throw new Error('bad picture size for background removal')
    const t0 = Date.now()
    let s = await load()
    const ort = (await import('onnxruntime-node')) as typeof Ort
    const chw = new Float32Array(3 * n)
    for (let i = 0; i < n; i++) {
      chw[i] = (rgba[i * 4] / 255 - MEAN[0]) / STD[0]
      chw[n + i] = (rgba[i * 4 + 1] / 255 - MEAN[1]) / STD[1]
      chw[2 * n + i] = (rgba[i * 4 + 2] / 255 - MEAN[2]) / STD[2]
    }
    let logits: Float32Array
    try {
      logits = await infer(ort, s, chw)
    } catch (e) {
      // the card could load the model but not run it (an old driver, not enough memory): the processor takes over
      if (using >= providers().length - 1) throw e
      s = await load(using + 1)
      logits = await infer(ort, s, chw)
    }
    const mask = new Uint8Array(n)
    for (let i = 0; i < n; i++) mask[i] = Math.round(255 / (1 + Math.exp(-logits[i])))
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => void unload(), IDLE_MS)
    return { mask, device, ms: Date.now() - t0 }
  }
  const next = queue.then(run, run)
  queue = next.catch(() => {})
  return next
}

async function unload(): Promise<void> {
  const s = session
  session = null
  using = -1
  try {
    await s?.release()
  } catch {
    /* already gone */
  }
}
