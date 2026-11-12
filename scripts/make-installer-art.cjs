// Draws the artwork of the Windows installer and the README banner from build/icon.svg.
// Run: npx electron scripts/make-installer-art.cjs
//   build/installer-sidebar.bmp  164 x 314  (welcome and finish pages)
//   build/installer-header.bmp   150 x 57   (the other pages)
//   docs/banner.png              1600 x 520 (README)
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const icon = fs.readFileSync(path.join(root, 'build/icon.svg'), 'utf8')

/** 24-bit BMP (what NSIS wants) from RGBA pixels */
function bmp(rgba, w, h) {
  const row = Math.ceil((w * 3) / 4) * 4
  const out = Buffer.alloc(54 + row * h)
  out.write('BM', 0, 'ascii')
  out.writeUInt32LE(out.length, 2)
  out.writeUInt32LE(54, 10)
  out.writeUInt32LE(40, 14)
  out.writeInt32LE(w, 18)
  out.writeInt32LE(h, 22)
  out.writeUInt16LE(1, 26)
  out.writeUInt16LE(24, 28)
  out.writeUInt32LE(row * h, 34)
  out.writeInt32LE(2835, 38)
  out.writeInt32LE(2835, 42)
  for (let y = 0; y < h; y++) {
    // rows are stored bottom-up, pixels as B G R
    let o = 54 + (h - 1 - y) * row
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      out[o++] = rgba[i + 2]
      out[o++] = rgba[i + 1]
      out[o++] = rgba[i]
    }
  }
  return out
}

// drawing code runs in the page; `S` is the supersampling factor
const PAGE = String.raw`
const GRAD = ['#ff7a59', '#ff4fa3', '#9b5cff', '#3fa9ff']
async function loadIcon(svg) {
  const img = new Image()
  img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))
  await img.decode()
  return img
}
function glow(ctx, x, y, r, color, alpha) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, color)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.globalAlpha = alpha
  ctx.fillStyle = g
  ctx.fillRect(x - r, y - r, r * 2, r * 2)
  ctx.globalAlpha = 1
}
function gradientText(ctx, text, x, y, w) {
  const g = ctx.createLinearGradient(x, 0, x + w, 0)
  GRAD.forEach((c, i) => g.addColorStop(i / (GRAD.length - 1), c))
  ctx.fillStyle = g
  ctx.fillText(text, x, y)
}
/** "Gigma" in white followed by an italic gradient "26", centred on cx */
function wordmark(ctx, cx, y, size) {
  ctx.textBaseline = 'alphabetic'
  ctx.font = '700 ' + size + 'px "Segoe UI", Inter, system-ui, sans-serif'
  const w1 = ctx.measureText('Gigma ').width
  ctx.font = 'italic 800 ' + size + 'px "Segoe UI", Inter, system-ui, sans-serif'
  const w2 = ctx.measureText('26').width
  const x = cx - (w1 + w2) / 2
  ctx.font = '700 ' + size + 'px "Segoe UI", Inter, system-ui, sans-serif'
  ctx.fillStyle = '#ffffff'
  ctx.fillText('Gigma ', x, y)
  ctx.font = 'italic 800 ' + size + 'px "Segoe UI", Inter, system-ui, sans-serif'
  gradientText(ctx, '26', x + w1, y, w2)
  return { x, width: w1 + w2 }
}
async function draw(kind, svg, w, h, S) {
  const img = await loadIcon(svg)
  const c = document.createElement('canvas')
  c.width = w * S
  c.height = h * S
  const ctx = c.getContext('2d')
  ctx.scale(S, S)
  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = '#17171b'
  ctx.fillRect(0, 0, w, h)
  if (kind === 'sidebar') {
    glow(ctx, 20, 40, 170, '#9b5cff', 0.55)
    glow(ctx, 160, 250, 190, '#ff4fa3', 0.4)
    glow(ctx, 30, 320, 150, '#3fa9ff', 0.35)
    ctx.drawImage(img, w / 2 - 38, 62, 76, 76)
    wordmark(ctx, w / 2, 176, 25)
    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(255,255,255,0.72)'
    ctx.font = '500 10.5px "Segoe UI", system-ui, sans-serif'
    ctx.fillText('Offline design tool', w / 2, 197)
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '400 9.5px "Segoe UI", system-ui, sans-serif'
    ctx.fillText('Free · Open source · MCP', w / 2, h - 18)
    ctx.textAlign = 'left'
  } else if (kind === 'header') {
    glow(ctx, 150, 0, 110, '#9b5cff', 0.6)
    glow(ctx, 40, 70, 90, '#ff4fa3', 0.3)
    ctx.drawImage(img, w - 49, 9, 39, 39)
  } else {
    // README banner
    glow(ctx, 180, 60, 620, '#9b5cff', 0.5)
    glow(ctx, 1350, 470, 640, '#ff4fa3', 0.38)
    glow(ctx, 1500, 40, 420, '#3fa9ff', 0.3)
    glow(ctx, 120, 560, 380, '#ff7a59', 0.22)
    ctx.drawImage(img, w / 2 - 70, 70, 140, 140)
    wordmark(ctx, w / 2, 318, 96)
    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(255,255,255,0.86)'
    ctx.font = '500 30px "Segoe UI", system-ui, sans-serif'
    ctx.fillText('Офлайн-редактор дизайна в духе Figma со встроенным MCP', w / 2, 382)
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.font = '400 22px "Segoe UI", system-ui, sans-serif'
    ctx.fillText('Windows · macOS  ·  бесплатно и с открытым кодом  ·  файлы остаются на вашем компьютере', w / 2, 432)
    ctx.textAlign = 'left'
  }
  // downscale to the final size
  const o = document.createElement('canvas')
  o.width = w
  o.height = h
  const octx = o.getContext('2d')
  octx.imageSmoothingQuality = 'high'
  octx.drawImage(c, 0, 0, w, h)
  if (kind === 'banner') return { png: o.toDataURL('image/png') }
  return { rgba: Array.from(octx.getImageData(0, 0, w, h).data) }
}
`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('about:blank')
  await win.webContents.executeJavaScript(PAGE + '; window.__draw = draw; 1')
  const run = (kind, w, h, S) => win.webContents.executeJavaScript(`__draw(${JSON.stringify(kind)}, ${JSON.stringify(icon)}, ${w}, ${h}, ${S})`)
  const side = await run('sidebar', 164, 314, 4)
  fs.writeFileSync(path.join(root, 'build/installer-sidebar.bmp'), bmp(side.rgba, 164, 314))
  const head = await run('header', 150, 57, 4)
  fs.writeFileSync(path.join(root, 'build/installer-header.bmp'), bmp(head.rgba, 150, 57))
  const banner = await run('banner', 1600, 520, 1)
  fs.writeFileSync(path.join(root, 'docs/banner.png'), Buffer.from(banner.png.split(',')[1], 'base64'))
  // previews to look at (BMP is awkward to open): not used by the build
  const preview = await win.webContents.executeJavaScript(`(async () => { const r = await __draw('sidebar', ${JSON.stringify(icon)}, 164, 314, 4); const c = document.createElement('canvas'); c.width = 164; c.height = 314; const x = c.getContext('2d'); x.putImageData(new ImageData(new Uint8ClampedArray(r.rgba), 164, 314), 0, 0); return c.toDataURL('image/png') })()`)
  if (process.argv.includes('--preview')) fs.writeFileSync(path.join(root, 'build/installer-sidebar-preview.png'), Buffer.from(preview.split(',')[1], 'base64'))
  console.log('written: build/installer-sidebar.bmp, build/installer-header.bmp, docs/banner.png')
  app.quit()
})
