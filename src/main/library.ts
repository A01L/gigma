// Local project library: every project is a .gigma (SQLite) file in the app's data folder.
// Deleted projects go to the app's own Trash (library/.trash) and can be restored;
// "delete forever" hands the file to the OS recycle bin. Nothing is uploaded anywhere.
import { app, shell } from 'electron'
import { existsSync, mkdirSync, readdirSync, statSync, renameSync, utimesSync } from 'node:fs'
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

/** Projects stay in Trash for 30 days, like Figma. */
export async function purgeOldTrash(): Promise<void> {
  const limit = Date.now() - TRASH_DAYS * 86400_000
  for (const p of listTrash()) if ((p.trashedAt ?? Date.now()) < limit) await deleteForever(p.path).catch(() => {})
}
