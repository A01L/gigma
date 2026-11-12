// Adds missing RU translations to src/renderer/ui/i18n.ts (skips keys that already exist).
// Usage: node scripts/i18n-add.mjs path/to/entries.json   ({ "English": "Русский", ... })
import { readFileSync, writeFileSync } from 'node:fs'
const file = 'src/renderer/ui/i18n.ts'
const entries = JSON.parse(readFileSync(process.argv[2], 'utf8'))
let src = readFileSync(file, 'utf8')
const q = (s) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
const added = []
let block = ''
for (const [en, ru] of Object.entries(entries)) {
  if (src.includes(q(en) + ':') || src.includes(q(en) + ' :') || src.includes('"' + en + '":')) continue
  block += `  ${q(en)}: ${q(ru)},\n`
  added.push(en)
}
if (block) {
  // insert right before the first dictionary entry we know exists
  const anchor = "  'Clip content':"
  const i = src.indexOf(anchor)
  if (i < 0) throw new Error('anchor not found')
  src = src.slice(0, i) + block + src.slice(i)
  writeFileSync(file, src)
}
console.log('added', added.length, 'skipped', Object.keys(entries).length - added.length)
