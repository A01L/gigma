/// <reference types="vite/client" />

// the parser of pdf.js, run in the page itself (see editor/pdf-import.ts)
declare module 'pdfjs-dist/build/pdf.worker.mjs'

// font files are read with it to turn text into outlines (see editor/text-outline.ts)
declare module 'opentype.js' {
  const opentype: { parse(buffer: ArrayBuffer): unknown }
  export default opentype
}
