// Minimal ZIP reader / writer (store + deflate) on top of node:zlib. Enough for .plug.gigma
// plugin packages; no dependency, no native code.
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

export interface ZipEntry {
  name: string
  data: Buffer
}

const MAX_TOTAL = 64 * 1024 * 1024
const MAX_FILES = 2000

/** Read every file of a zip archive. Throws on anything that is not a plain, sane zip. */
export function unzip(buf: Buffer): ZipEntry[] {
  // end of central directory: last 22+ bytes
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  if (eocd < 0) throw new Error('not a zip archive')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  if (count > MAX_FILES) throw new Error('too many files in the archive')
  const out: ZipEntry[] = []
  let total = 0
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip directory')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nlen = buf.readUInt16LE(p + 28)
    const elen = buf.readUInt16LE(p + 30)
    const clen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8').replace(/\\/g, '/')
    p += 46 + nlen + elen + clen
    if (flags & 1) throw new Error('encrypted archives are not supported')
    if (name.endsWith('/')) continue // directory
    // no absolute paths, no escaping the plugin folder
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').includes('..')) throw new Error('unsafe path in the archive: ' + name)
    total += usize
    if (total > MAX_TOTAL) throw new Error('the archive is too large')
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('corrupt zip entry')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + csize)
    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: MAX_TOTAL })
    else throw new Error('unsupported compression in the archive')
    out.push({ name, data })
  }
  return out
}

/** Build a zip archive (deflate). */
export function zip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8')
    const comp = deflateRawSync(e.data)
    const crc = crc32(e.data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6) // UTF-8 names
    head.writeUInt16LE(8, 8)
    head.writeUInt32LE(0x00210000, 10) // 1980-01-01, fixed so archives are reproducible
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
