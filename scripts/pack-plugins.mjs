// Packs plugin folders into .gplug packages.
// Usage: node scripts/pack-plugins.mjs <folder> [output folder]
//   <folder> is either one plugin (it has manifest.json) or a folder of plugin folders.
//   Packages are written next to the plugin folders unless an output folder is given.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'

/** minimal zip writer (deflate), same layout as src/main/zip.ts */
function zip(entries) {
  const parts = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const comp = deflateRawSync(e.data)
    const crc = crc32(e.data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6)
    head.writeUInt16LE(8, 8)
    head.writeUInt32LE(0x00210000, 10)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(comp.length, 18)
    head.writeUInt32LE(e.data.length, 22)
    head.writeUInt16LE(name.length, 26)
    parts.push(head, name, comp)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(0x0800, 8)
    c.writeUInt16LE(8, 10)
    c.writeUInt32LE(0x00210000, 12)
    c.writeUInt32LE(crc, 16)
    c.writeUInt32LE(comp.length, 20)
    c.writeUInt32LE(e.data.length, 24)
    c.writeUInt16LE(name.length, 28)
    c.writeUInt32LE(offset, 42)
    central.push(c, name)
    offset += 30 + name.length + comp.length
  }
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, dir, end])
}

const src = process.argv[2]
if (!src || !existsSync(src)) {
  console.error('Usage: node scripts/pack-plugins.mjs <plugin folder | folder of plugins> [output folder]')
  process.exit(1)
}
const root = resolve(src)
const single = existsSync(join(root, 'manifest.json'))
const folders = single ? [root] : readdirSync(root).map((n) => join(root, n)).filter((d) => statSync(d).isDirectory() && existsSync(join(d, 'manifest.json')))
const out = resolve(process.argv[3] ?? (single ? dirname(root) : root))
mkdirSync(out, { recursive: true })
if (!folders.length) console.error('No plugin folders (with manifest.json) found in ' + root)
for (const dir of folders) {
  const entries = []
  const walk = (d, prefix) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith('.')) continue
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p, prefix + name + '/')
      else entries.push({ name: prefix + name, data: readFileSync(p) })
    }
  }
  walk(dir, '')
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  const file = join(out, manifest.id + '.gplug')
  writeFileSync(file, zip(entries))
  console.log(`${file}  (${entries.length} files, ${manifest.name} ${manifest.version})`)
}
