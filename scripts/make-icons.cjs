// Generates app icons from build/icon.svg using Electron's own Chromium renderer.
// Run: npx electron scripts/make-icons.cjs
// App icon:  build/icon.svg      -> build/icon.{png,ico,icns}, build/icons/<size>.png, src/renderer/assets/logo.svg
// File icon: build/file-icon.svg -> build/file-icon.{png,ico,icns} (used for .gigma documents)
// Guideline and plugin files: build/guide-icon.svg, build/plug-icon.svg -> the same set, and src/renderer/assets/
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')

async function render(win, svg, size, pad = 0) {
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image()
    img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))}
    await img.decode()
    const c = document.createElement('canvas')
    c.width = c.height = ${size}
    const ctx = c.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    const p = ${size} * ${pad}
    ctx.drawImage(img, p, p, ${size} - 2 * p, ${size} - 2 * p)
    return c.toDataURL('image/png')
  })()`)
  return Buffer.from(dataUrl.split(',')[1], 'base64')
}

function ico(pngs) {
  // ICO container with embedded PNG images (supported since Windows Vista)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const dir = Buffer.alloc(16 * pngs.length)
  let offset = 6 + dir.length
  pngs.forEach(([size, buf], i) => {
    const o = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, o)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1)
    dir.writeUInt8(0, o + 2)
    dir.writeUInt8(0, o + 3)
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(buf.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += buf.length
  })
  return Buffer.concat([header, dir, ...pngs.map((p) => p[1])])
}

function icns(entries) {
  const chunks = entries.map(([type, buf]) => {
    const h = Buffer.alloc(8)
    h.write(type, 0, 'ascii')
    h.writeUInt32BE(buf.length + 8, 4)
    return Buffer.concat([h, buf])
  })
  const body = Buffer.concat(chunks)
  const h = Buffer.alloc(8)
  h.write('icns', 0, 'ascii')
  h.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([h, body])
}

/** build/<name>.svg -> build/<name>.png/.ico/.icns (+ build/<pngDir>/<size>.png) */
async function generate(win, name, pngDir) {
  const svg = fs.readFileSync(path.join(root, `build/${name}.svg`), 'utf8')
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
  const full = {}
  for (const s of sizes) {
    full[s] = await render(win, svg, s)
    if (pngDir) {
      fs.mkdirSync(path.join(root, 'build', pngDir), { recursive: true })
      fs.writeFileSync(path.join(root, 'build', pngDir, `${s}x${s}.png`), full[s])
    }
  }
  fs.writeFileSync(path.join(root, `build/${name}.png`), full[1024])
  fs.writeFileSync(path.join(root, `build/${name}.ico`), ico([16, 24, 32, 48, 64, 128, 256].map((s) => [s, full[s]])))

  // macOS: Apple icon grid leaves ~10% transparent margin around the rounded square
  const mac = {}
  for (const s of [16, 32, 64, 128, 256, 512, 1024]) mac[s] = await render(win, svg, s, 0.1)
  fs.writeFileSync(
    path.join(root, `build/${name}.icns`),
    icns([
      ['icp4', mac[16]],
      ['icp5', mac[32]],
      ['icp6', mac[64]],
      ['ic07', mac[128]],
      ['ic08', mac[256]],
      ['ic09', mac[512]],
      ['ic10', mac[1024]],
      ['ic11', mac[32]],
      ['ic12', mac[64]],
      ['ic13', mac[256]],
      ['ic14', mac[512]]
    ])
  )
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<html><body></body></html>')
  await generate(win, 'icon', 'icons') // app icon
  await generate(win, 'file-icon') // icon for .gigma documents
  for (const name of ['guide-icon', 'plug-icon']) {
    await generate(win, name) // icons of .gguide and .gplug files
    fs.copyFileSync(path.join(root, `build/${name}.svg`), path.join(root, `src/renderer/assets/${name}.svg`))
  }
  fs.copyFileSync(path.join(root, 'build/icon.svg'), path.join(root, 'src/renderer/assets/logo.svg'))
  console.log('icons written to build/')
  app.quit()
})
