// Local project library: every project is a .gigma (SQLite) file in the app's data folder.
// Deleted projects go to the app's own Trash (library/.trash) and can be restored;
// "delete forever" hands the file to the OS recycle bin. Nothing is uploaded anywhere.
import { app, shell } from 'electron'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, renameSync, utimesSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { join, basename, dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { GigmaFile } from './storage'

import type { ProjectInfo } from '../shared/api'
export type { ProjectInfo }

const TRASH_DAYS = 30

export function libraryDir(): string {
  const dir = join(app.getPath('userData'), 'library')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function trashDir(): string {
  const dir = join(libraryDir(), '.trash')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function readProjects(dir: string): ProjectInfo[] {
  const out: ProjectInfo[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.gigma')) continue
    const path = join(dir, f)
    try {
      const db = new DatabaseSync(path, { readOnly: true })
      const rows = db.prepare("SELECT key, value FROM meta WHERE key IN ('doc','thumb')").all() as { key: string; value: string }[]
      db.close()
      const doc = rows.find((r) => r.key === 'doc')
      const meta = doc ? JSON.parse(doc.value) : {}
      const st = statSync(path)
      // the write-ahead log and its index belong to the project too
      let size = st.size
      for (const ext of ['-wal', '-shm']) if (existsSync(path + ext)) size += statSync(path + ext).size
      out.push({
        size,
        path,
        name: meta.name ?? basename(f, '.gigma'),
        updatedAt: meta.updatedAt ?? st.mtimeMs,
        createdAt: meta.createdAt ?? st.birthtimeMs,
        thumb: rows.find((r) => r.key === 'thumb')?.value ?? null,
        trashedAt: dir === trashDir() ? st.mtimeMs : undefined
      })
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function listProjects(): ProjectInfo[] {
  return readProjects(libraryDir())
}

export function listTrash(): ProjectInfo[] {
  return readProjects(trashDir()).sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0))
}

export function createProject(name: string): string {
  const path = join(libraryDir(), randomUUID() + '.gigma')
  const f = new GigmaFile(path)
  f.apply({ meta: { name } })
  f.close()
  return path
}

export function importToLibrary(source: string): string {
  const path = join(libraryDir(), randomUUID() + '.gigma')
  // open through GigmaFile first to validate + checkpoint, then copy
  const f = new GigmaFile(source)
  f.saveCopy(path)
  f.close()
  return path
}

const inside = (dir: string, p: string) => resolve(dirname(p)) === resolve(dir)

function moveWithSidecars(from: string, toDir: string): string {
  const to = join(toDir, basename(from))
  for (const ext of ['', '-wal', '-shm']) if (existsSync(from + ext)) renameSync(from + ext, to + ext)
  return to
}

/** Move a project into Gigma's Trash (restorable). */
export function trashProject(path: string): void {
  if (!inside(libraryDir(), path)) throw new Error('not a library project')
  const to = moveWithSidecars(path, trashDir())
  const now = new Date()
  utimesSync(to, now, now) // mtime = time it was trashed
}

export function restoreProject(path: string): string {
  if (!inside(trashDir(), path)) throw new Error('not in trash')
  return moveWithSidecars(path, libraryDir())
}

/** Remove from Gigma's Trash; the file goes to the system recycle bin as a last safety net. */
export async function deleteForever(path: string): Promise<void> {
  if (!inside(trashDir(), path)) throw new Error('not in trash')
  for (const ext of ['', '-wal', '-shm']) if (existsSync(path + ext)) await shell.trashItem(path + ext)
}

export async function emptyTrash(): Promise<void> {
  for (const p of listTrash()) await deleteForever(p.path)
}

// ---------------------------------------------------------------- the archive ("cold storage")
// A project that is not needed for a while can be packed away: its file is compacted and compressed into
// library/.archive/<id>.gigma.gz, with a small card beside it (name, thumbnail, sizes) so the list can be shown
// without unpacking anything. An archived project is not on Home and cannot be opened until it is taken back.
export function archiveDir(): string {
  const dir = join(libraryDir(), '.archive')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
const cardOf = (gz: string) => gz.replace(/\.gigma\.gz$/, '.json')

export function listArchive(): ProjectInfo[] {
  const out: ProjectInfo[] = []
  for (const f of readdirSync(archiveDir())) {
    if (!f.endsWith('.gigma.gz')) continue
    const path = join(archiveDir(), f)
    try {
      const st = statSync(path)
      let card: Partial<ProjectInfo> = {}
      try {
        card = JSON.parse(readFileSync(cardOf(path), 'utf8'))
      } catch {
        /* a pack without its card is still listed, by its file name */
      }
      out.push({
        path,
        name: card.name ?? basename(f, '.gigma.gz'),
        updatedAt: card.updatedAt ?? st.mtimeMs,
        createdAt: card.createdAt ?? st.birthtimeMs,
        thumb: card.thumb ?? null,
        size: st.size,
        originalSize: card.originalSize,
        archivedAt: card.archivedAt ?? st.mtimeMs
      })
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
}

/** Pack a library project away. The project must not be open. */
export async function archiveProject(path: string): Promise<string> {
  if (!inside(libraryDir(), path)) throw new Error('not a library project')
  const info = readProjects(libraryDir()).find((p) => p.path === path)
  if (!info) throw new Error('unknown project')
  const id = basename(path, '.gigma')
  const tmp = join(archiveDir(), id + '.tmp')
  const gz = join(archiveDir(), id + '.gigma.gz')
  rmSync(tmp, { force: true })
  // a compact copy with everything in one file (the write-ahead log folded in), then compressed
  const f = new GigmaFile(path)
  try {
    f.saveCopy(tmp)
  } finally {
    f.close()
  }
  try {
    await pipeline(createReadStream(tmp), createGzip({ level: 9 }), createWriteStream(gz))
  } finally {
    rmSync(tmp, { force: true })
  }
  writeFileSync(cardOf(gz), JSON.stringify({ name: info.name, thumb: info.thumb, updatedAt: info.updatedAt, createdAt: info.createdAt, originalSize: info.size, archivedAt: Date.now() }))
  // only now, with the pack written, does the project leave the library
  for (const ext of ['', '-wal', '-shm']) rmSync(path + ext, { force: true })
  return gz
}

/** Unpack an archived project back into the library; returns its path there. */
export async function unarchiveProject(gz: string): Promise<string> {
  if (!inside(archiveDir(), gz) || !gz.endsWith('.gigma.gz')) throw new Error('not in the archive')
  let to = join(libraryDir(), basename(gz, '.gigma.gz') + '.gigma')
  if (existsSync(to)) to = join(libraryDir(), randomUUID() + '.gigma')
  const tmp = to + '.part'
  try {
    await pipeline(createReadStream(gz), createGunzip(), createWriteStream(tmp))
    // it must open as a project before the pack is thrown away
    new DatabaseSync(tmp, { readOnly: true }).close()
    renameSync(tmp, to)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
  rmSync(gz, { force: true })
  rmSync(cardOf(gz), { force: true })
  return to
}

/** Remove an archived project; the pack goes to the system recycle bin as a last safety net. */
export async function deleteArchived(gz: string): Promise<void> {
  if (!inside(archiveDir(), gz) || !gz.endsWith('.gigma.gz')) throw new Error('not in the archive')
  if (existsSync(gz)) await shell.trashItem(gz)
  rmSync(cardOf(gz), { force: true })
}

/** Projects stay in Trash for 30 days, like Figma. */
export async function purgeOldTrash(): Promise<void> {
  const limit = Date.now() - TRASH_DAYS * 86400_000
  for (const p of listTrash()) if ((p.trashedAt ?? Date.now()) < limit) await deleteForever(p.path).catch(() => {})
}
