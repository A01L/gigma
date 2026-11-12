// PDF export. Every page is the SVG of one layer (the same SVG the SVG export produces), printed
// by Chromium: shapes stay vector, text stays text (selectable, fonts embedded), images are embedded.
// Like Figma, one pixel of the design is one point of the PDF page.
import { app, BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PdfPage {
  svg: string
  /** size of the layer in design pixels = size of the page in points */
  width: number
  height: number
  /** CSS colour painted behind the layer (e.g. the canvas colour); none = white paper */
  background?: string
}

let queue: Promise<unknown> = Promise.resolve()

async function render(pages: PdfPage[]): Promise<Uint8Array> {
  if (!pages.length) throw new Error('nothing to export')
  if (pages.length > 500) throw new Error('too many pages (the limit is 500)')
  // PDF pages cannot be larger than 200 inches
  const clamp = (v: number) => Math.max(1, Math.min(14400, Math.round(v * 100) / 100))
  let css = 'html,body{margin:0;padding:0}.p{display:block;overflow:hidden;break-after:page;break-inside:avoid}.p:last-child{break-after:auto}.p>svg{display:block;width:100%;height:100%}'
  let body = ''
  pages.forEach((p, i) => {
    const w = clamp(p.width)
    const h = clamp(p.height)
    // a named page per layer: every page of the PDF has the size of its layer
    css += `@page p${i}{size:${w}pt ${h}pt;margin:0}.p${i}{page:p${i};width:${w}pt;height:${h}pt;${p.background ? `background:${p.background.replace(/[;{}<>]/g, '')}` : ''}}`
    // all pages share one document, so ids (clip paths, gradients, filters) must be unique per page:
    // otherwise url(#c0) of page 3 would point at the clip path of page 1
    const svg = p.svg
      .replace(/<\?xml[^>]*\?>/, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '') // scripts are disabled in the print window anyway
      .replace(/\bid="([^"]+)"/g, `id="p${i}-$1"`)
      .replace(/url\(#([^)]+)\)/g, `url(#p${i}-$1)`)
      .replace(/\b(xlink:href|href)="#([^"]+)"/g, `$1="#p${i}-$2"`)
    body += `<div class="p p${i}">${svg}</div>`
  })
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`
  const file = join(app.getPath('temp'), `gigma-pdf-${randomUUID()}.html`)
  writeFileSync(file, html)
  const ses = session.fromPartition('gigma-pdf')
  // nothing is fetched from the network: the page only has inline content
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(data|about|blob|file):/.test(d.url) }))
  const w = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { session: ses, javascript: false, sandbox: true, contextIsolation: true } })
  try {
    await w.loadFile(file)
    const first = pages[0]
    const pdf = await w.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      // used only if the CSS page size is ignored: the size of the first page, in inches
      pageSize: { width: clamp(first.width) / 72, height: clamp(first.height) / 72 }
    })
    return new Uint8Array(pdf)
  } finally {
    w.destroy()
    rmSync(file, { force: true })
  }
}

/** Render pages to PDF bytes (one hidden window at a time). */
export function renderPdf(pages: PdfPage[]): Promise<Uint8Array> {
  const job = queue.then(() => render(pages))
  queue = job.catch(() => null)
  return job
}
