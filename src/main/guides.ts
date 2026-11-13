// Guideline library: design systems shared by every project on this computer.
// A guideline is one JSON file (<id>.gguide) in <library>/guides: colours, fonts, logos, rules.
// Projects only refer to it by id (and keep a copy for when the file travels to another computer),
// so an edit shows up everywhere at once. Nothing is uploaded anywhere.
import { dialog, shell, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { libraryDir } from './library'
import type { GuideData } from '../shared/types'

// Windows picks a file icon by the last extension only, so guidelines have one of their own.
// Files saved before that were called *.guide.gigma: they are still read and imported.
const EXT = '.gguide'
const OLD_EXT = '.guide.gigma'

export function guidesDir(): string {
  const dir = join(libraryDir(), 'guides')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  // the library itself moves to the new name once
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(OLD_EXT)) continue
    const to = join(dir, f.slice(0, -OLD_EXT.length) + EXT)
    try {
      if (!existsSync(to)) renameSync(join(dir, f), to)
    } catch {
      /* stays readable under the old name next time */
    }
  }
  return dir
}
const fileOf = (id: string) => join(guidesDir(), id + EXT)
const tombstones = () => join(guidesDir(), 'deleted.json')

/** ids of guidelines the user deleted: projects drop them instead of bringing them back from their copy */
export function deletedGuides(): string[] {
  try {
    const list = JSON.parse(readFileSync(tombstones(), 'utf8'))
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}
function setDeleted(id: string, deleted: boolean): void {
  const cur = new Set(deletedGuides())
  if (deleted) cur.add(id)
  else if (!cur.delete(id)) return
  writeFileSync(tombstones(), JSON.stringify([...cur]))
}

/** a guideline as read from a file: only well-formed data gets in */
function parse(text: string): GuideData {
  const g = JSON.parse(text) as Partial<GuideData>
  if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !/^[\w-]{1,64}$/.test(g.id)) throw new Error('not a Gigma guideline file')
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
  return {
    id: g.id,
    name: String(g.name ?? 'Guideline').slice(0, 120),
    description: typeof g.description === 'string' ? g.description : undefined,
    accent: typeof g.accent === 'string' ? g.accent : undefined,
    colors: list(g.colors),
    fonts: list(g.fonts),
    logos: list(g.logos),
    patterns: list(g.patterns),
    rules: typeof g.rules === 'string' ? g.rules : '',
    sections: list(g.sections),
    updatedAt: Number(g.updatedAt) || Date.now(),
    formatVersion: 1
  }
}

export function listGuides(): GuideData[] {
  const out: GuideData[] = []
  for (const f of readdirSync(guidesDir())) {
    if (!f.endsWith(EXT)) continue
    try {
      out.push(parse(readFileSync(join(guidesDir(), f), 'utf8')))
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function saveGuide(data: GuideData): GuideData {
  const g = parse(JSON.stringify({ ...data, updatedAt: Date.now() }))
  writeFileSync(fileOf(g.id), JSON.stringify(g))
  setDeleted(g.id, false)
  return g
}

/** Delete from the library, and so from every project. The file goes to the system recycle bin as a safety net. */
export async function removeGuide(id: string): Promise<void> {
  if (!/^[\w-]{1,64}$/.test(id)) throw new Error('bad guideline id')
  if (existsSync(fileOf(id))) await shell.trashItem(fileOf(id))
  setDeleted(id, true)
}

export function guideSizes(): { id: string; name: string; size: number }[] {
  return listGuides().map((g) => ({ id: g.id, name: g.name, size: statSync(fileOf(g.id)).size }))
}

export async function exportGuide(win: BrowserWindow | null, id: string): Promise<boolean> {
  if (!existsSync(fileOf(id))) throw new Error('unknown guideline')
  const g = parse(readFileSync(fileOf(id), 'utf8'))
  const opts = { defaultPath: g.name.replace(/[\\/:*?"<>|]/g, '_') + EXT, filters: [{ name: 'Gigma guideline', extensions: ['gguide', 'gigma'] }] }
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (r.canceled || !r.filePath) return false
  writeFileSync(r.filePath, JSON.stringify(g))
  return true
}

export const isGuideFile = (path: string) => path.toLowerCase().endsWith(EXT) || path.toLowerCase().endsWith(OLD_EXT)

export function importGuideFile(path: string): GuideData {
  return saveGuide(parse(readFileSync(path, 'utf8')))
}

export async function importGuide(win: BrowserWindow | null): Promise<GuideData | null> {
  const opts = { properties: ['openFile' as const], filters: [{ name: 'Gigma guideline', extensions: ['gguide', 'gigma'] }] }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (r.canceled || !r.filePaths[0]) return null
  return importGuideFile(r.filePaths[0])
}
