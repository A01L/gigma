// A .gigma file is a single SQLite database (node:sqlite, built into Electron's Node).
// - every node is a row (JSON payload) -> saving touches only changed nodes, never the whole doc
// - images live in the same file as content-addressed blobs (sha1), deduplicated
// - WAL journal -> crash-safe autosave, readers never block the writer
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { DocChanges, DocMeta, DocSnapshot, GNode, Page } from '../shared/types'
import { DEFAULT_PAGE_BG, FORMAT_VERSION } from '../shared/types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta  (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, page_id TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS nodes_page ON nodes(page_id);
CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL, created_at INTEGER NOT NULL);
`

export function imageHashes(nodes: GNode[]): Set<string> {
  const s = new Set<string>()
  for (const n of nodes) for (const f of n.fills) if (f.type === 'IMAGE') s.add(f.imageHash)
  return s
}

export class GigmaFile {
  readonly db: DatabaseSync
  private st: Record<string, StatementSync>

  constructor(readonly path: string) {
    const isNew = !existsSync(path)
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=OFF;')
    this.db.exec(SCHEMA)
    this.st = {
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
      upsertPage: this.db.prepare('INSERT INTO pages(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'),
      deletePage: this.db.prepare('DELETE FROM pages WHERE id = ?'),
      deletePageNodes: this.db.prepare('DELETE FROM nodes WHERE page_id = ?'),
      upsertNode: this.db.prepare(
        'INSERT INTO nodes(id,page_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET page_id=excluded.page_id, data=excluded.data'
      ),
      deleteNode: this.db.prepare('DELETE FROM nodes WHERE id = ?'),
      putBlob: this.db.prepare('INSERT OR IGNORE INTO blobs(hash,mime,bytes,created_at) VALUES(?,?,?,?)'),
      getBlob: this.db.prepare('SELECT mime, bytes FROM blobs WHERE hash = ?')
    }
    if (isNew || !this.getMeta()) this.initialize()
  }

  private initialize(): void {
    const now = Date.now()
    const meta: DocMeta = { id: randomUUID(), name: 'Untitled', createdAt: now, updatedAt: now, formatVersion: FORMAT_VERSION }
    const page: Page = { id: randomUUID(), name: 'Page 1', order: 'a0', background: { ...DEFAULT_PAGE_BG } }
    this.tx(() => {
      this.st.setMeta.run('doc', JSON.stringify(meta))
      this.st.upsertPage.run(page.id, JSON.stringify(page))
    })
  }

  setThumb(dataUrl: string): void {
    this.st.setMeta.run('thumb', dataUrl)
  }

  getMeta(): DocMeta | null {
    const row = this.st.getMeta.get('doc') as { value: string } | undefined
    return row ? (JSON.parse(row.value) as DocMeta) : null
  }

  load(): DocSnapshot {
    const meta = this.getMeta()!
    const pages = (this.db.prepare('SELECT data FROM pages').all() as { data: string }[]).map((r) => JSON.parse(r.data) as Page)
    const nodes = (this.db.prepare('SELECT data FROM nodes').all() as { data: string }[]).map((r) => JSON.parse(r.data) as GNode)
    return { meta, pages, nodes }
  }

  apply(ch: DocChanges): void {
    this.tx(() => {
      for (const p of ch.upsertPages ?? []) this.st.upsertPage.run(p.id, JSON.stringify(p))
      for (const id of ch.deletePages ?? []) {
        this.st.deletePage.run(id)
        this.st.deletePageNodes.run(id)
      }
      for (const n of ch.upsertNodes ?? []) this.st.upsertNode.run(n.id, n.pageId, JSON.stringify(n))
      for (const id of ch.deleteNodes ?? []) this.st.deleteNode.run(id)
      const meta = { ...this.getMeta()!, ...(ch.meta ?? {}), updatedAt: Date.now() }
      this.st.setMeta.run('doc', JSON.stringify(meta))
    })
  }

  putBlob(bytes: Uint8Array, mime: string): string {
    const hash = createHash('sha1').update(bytes).digest('hex')
    this.st.putBlob.run(hash, mime, bytes, Date.now())
    return hash
  }

  getBlob(hash: string): { mime: string; bytes: Uint8Array } | null {
    const row = this.st.getBlob.get(hash) as { mime: string; bytes: Uint8Array } | undefined
    return row ?? null
  }

  /** Atomic consistent copy (used by "Save As"). */
  saveCopy(target: string): void {
    this.db.prepare('VACUUM INTO ?').run(target)
  }

  /**
   * Export the whole project or only some pages into a standalone .gigma file
   * (same SQLite format, images included). This is the exchange/archive format.
   */
  exportTo(target: string, pageIds?: string[]): void {
    if (!pageIds) {
      this.saveCopy(target)
      return
    }
    const snap = this.load()
    const pages = snap.pages.filter((p) => pageIds.includes(p.id))
    const nodes = snap.nodes.filter((n) => pageIds.includes(n.pageId))
    const out = new GigmaFile(target)
    try {
      const outSnap = out.load()
      out.apply({
        deletePages: outSnap.pages.map((p) => p.id),
        upsertPages: pages,
        upsertNodes: nodes,
        meta: { name: snap.meta.name + (pages.length === 1 ? ' - ' + pages[0].name : '') }
      })
      for (const hash of imageHashes(nodes)) {
        const b = this.getBlob(hash)
        if (b) out.putBlob(b.bytes, b.mime)
      }
    } finally {
      out.close()
    }
  }

  /**
   * Import pages (with images) from another .gigma file into this project.
   * All ids are re-generated so the same file can be imported repeatedly.
   */
  importPagesFrom(source: string): { pages: Page[]; nodes: GNode[] } {
    const src = new GigmaFile(source)
    try {
      const snap = src.load()
      const idMap = new Map<string, string>()
      const map = (id: string) => {
        let v = idMap.get(id)
        if (!v) idMap.set(id, (v = randomUUID()))
        return v
      }
      const pages = snap.pages.map((p) => ({ ...p, id: map(p.id) }))
      const nodes = snap.nodes.map((n) => ({
        ...n,
        id: map(n.id),
        pageId: map(n.pageId),
        parentId: n.parentId ? map(n.parentId) : null
      }))
      for (const hash of imageHashes(snap.nodes)) {
        const b = src.getBlob(hash)
        if (b) this.putBlob(b.bytes, b.mime)
      }
      return { pages, nodes }
    } finally {
      src.close()
    }
  }

  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      /* ignore */
    }
    this.db.close()
  }

  private tx(fn: () => void): void {
    this.db.exec('BEGIN')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
}
