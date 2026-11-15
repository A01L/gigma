// Fetches the models the app ships with into models/ (not kept in git): run before packing an installer.
//   BiRefNet (full, MIT licence) as ONNX: background removal, 973 MB.
// A file that is already there with the right size and checksum is left alone.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MODELS = [
  {
    file: 'models/birefnet.onnx',
    url: 'https://huggingface.co/onnx-community/BiRefNet-ONNX/resolve/534d3c82d3bb8b2f0867db6dfbc3a525b8e42f67/onnx/model.onnx',
    size: 972666916,
    sha256: '58f621f00f5d756097615970a88a791584600dcf7c45b18a0a6267535a1ebd3c'
  }
]

const sha256 = (file) =>
  new Promise((res, rej) => {
    const h = createHash('sha256')
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej)
  })

mkdirSync('models', { recursive: true })
for (const m of MODELS) {
  if (existsSync(m.file) && statSync(m.file).size === m.size && (await sha256(m.file)) === m.sha256) {
    console.log('ok       ', m.file)
    continue
  }
  console.log('fetching ', m.file, '(' + Math.round(m.size / 1e6) + ' MB)')
  const r = await fetch(m.url)
  if (!r.ok || !r.body) throw new Error(m.url + ' answered ' + r.status)
  const part = m.file + '.part'
  await pipeline(Readable.fromWeb(r.body), createWriteStream(part))
  const sum = await sha256(part)
  if (statSync(part).size !== m.size || sum !== m.sha256) {
    rmSync(part, { force: true })
    throw new Error(m.file + ': the download does not match its checksum')
  }
  renameSync(part, m.file)
  console.log('fetched  ', m.file)
}
