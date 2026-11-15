// Writes dist/latest.yml for the installer that was just built: the file electron-updater reads from a GitHub release
// to learn that a new version exists. (electron-builder writes it only when it publishes; here nothing is published by
// the build, the release is made by hand.) Upload it to the release together with the installer and its .blockmap.
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const name = `Gigma-Setup-${version}.exe`
const file = `dist/${name}`
const sha512 = await new Promise((res, rej) => {
  const h = createHash('sha512')
  createReadStream(file)
    .on('data', (d) => h.update(d))
    .on('end', () => res(h.digest('base64')))
    .on('error', rej)
})
const size = statSync(file).size
writeFileSync('dist/latest.yml', `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${size}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`)
console.log('dist/latest.yml for', name, Math.round(size / 1e6) + ' MB')
