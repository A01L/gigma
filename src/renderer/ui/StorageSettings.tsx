// Settings → Storage, modelled on Windows "System → Storage": what Gigma keeps on disk, by category,
// with a list of the items of each category and how much space every one takes.
import { useEffect, useState } from 'react'
import type { ProjectInfo, StorageStats } from '@shared/api'
import { backend } from '../backend'
import { Icons } from './icons'
import { useT } from './i18n'

/** 1536 -> "1,5 КБ" / "1.5 KB" */
export function formatBytes(bytes: number, lang: string): string {
  const ru = lang.startsWith('ru')
  const units = ru ? ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'] : ['B', 'KB', 'MB', 'GB', 'TB']
  let v = Math.max(0, bytes)
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const text = i === 0 ? String(Math.round(v)) : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)
  return (ru ? text.replace('.', ',') : text) + ' ' + units[i]
}

type Kind = 'projects' | 'trash' | 'plugins'

export function StorageSection() {
  const t = useT()
  const lang = document.documentElement.lang || 'en'
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [trash, setTrash] = useState<ProjectInfo[]>([])
  const [dir, setDir] = useState('')
  const [open, setOpen] = useState<Kind | null>(null)
  const load = () => {
    backend.library.stats().then(setStats)
    backend.library.list().then(setProjects)
    backend.library.listTrash().then(setTrash)
  }
  useEffect(() => {
    load()
    backend.library.dir().then(setDir)
    backend.library.onChanged(load)
  }, [])
  if (!stats) return null
  const fmt = (n: number) => formatBytes(n, lang)
  const pluginsSize = stats.plugins.reduce((s, p) => s + p.size, 0)
  const total = stats.projects + stats.trash + pluginsSize
  const share = (n: number, of = total) => (of > 0 ? Math.max(n > 0 ? 1.5 : 0, (n / of) * 100) : 0)

  const rows: { kind: Kind; icon: React.ReactNode; title: string; hint: string; size: number }[] = [
    { kind: 'projects', icon: Icons.frame, title: t('Projects'), hint: t('{n} in the library', { n: String(projects.length) }), size: stats.projects },
    { kind: 'trash', icon: Icons.trash, title: t('Trash'), hint: t('{n} deleted, kept for 30 days', { n: String(trash.length) }), size: stats.trash },
    { kind: 'plugins', icon: Icons.actions ?? Icons.plus, title: t('Plugins'), hint: t('{n} installed', { n: String(stats.plugins.length) }), size: pluginsSize }
  ]
  const items = (kind: Kind): { key: string; name: string; size: number; thumb?: string | null; path?: string }[] =>
    (kind === 'projects' ? projects : kind === 'trash' ? trash : stats.plugins.map((p) => ({ path: p.id, name: p.name, size: p.size, thumb: null })))
      .map((p) => ({ key: p.path, name: p.name, size: p.size ?? 0, thumb: p.thumb, path: p.path }))
      .sort((a, b) => b.size - a.size)

  return (
    <section>
      <h2>{t('Storage')}</h2>
      <div className="stor-total">
        <b>{t('Gigma uses {size}', { size: fmt(total) })}</b>
        {stats.diskTotal > 0 && <span className="muted">{t('Free on the disk: {size}', { size: fmt(stats.diskFree) })}</span>}
      </div>
      {/* one bar for everything: projects, trash, plugins */}
      <div className="stor-bar big">
        <i style={{ width: share(stats.projects) + '%' }} />
        <i className="trash" style={{ width: share(stats.trash) + '%' }} />
        <i className="plugins" style={{ width: share(pluginsSize) + '%' }} />
      </div>

      <div className="stor-list">
        {rows.map((r) => {
          const list = open === r.kind ? items(r.kind) : []
          const max = list[0]?.size || 1
          return (
            <div key={r.kind} className={'stor-cat' + (open === r.kind ? ' open' : '')}>
              <button className="stor-row" onClick={() => setOpen(open === r.kind ? null : r.kind)}>
                <span className="stor-icon">{r.icon}</span>
                <span className="stor-main">
                  <span className="stor-line">
                    <b>{r.title}</b>
                    <span className="muted">
                      {t('Used {size} of {total}', { size: fmt(r.size), total: fmt(total) })}
                    </span>
                  </span>
                  <span className={'stor-bar ' + r.kind}>
                    <i style={{ width: share(r.size) + '%' }} />
                  </span>
                  <span className="muted stor-hint">{r.hint}</span>
                </span>
                <span className="stor-chev">{open === r.kind ? Icons.chevD : Icons.chevR}</span>
              </button>
              {open === r.kind && (
                <div className="stor-items">
                  {!list.length && <div className="muted stor-empty">{t('Nothing here')}</div>}
                  {r.kind === 'trash' && list.length > 0 && (
                    <div className="stor-actions">
                      <span className="muted">{t('Deleted projects keep taking space until they are removed for good.')}</span>
                      <button
                        className="pill"
                        onClick={async () => {
                          if (!confirm(t('Delete all {n} projects in Trash forever?', { n: String(list.length) }))) return
                          await backend.library.emptyTrash()
                          load()
                        }}
                      >
                        {t('Empty trash')} · {fmt(stats.trash)}
                      </button>
                    </div>
                  )}
                  {list.map((it) => (
                    <div key={it.key} className="stor-item">
                      <span className="stor-thumb">{it.thumb ? <img src={it.thumb} alt="" draggable={false} /> : null}</span>
                      <span className="stor-main">
                        <span className="stor-line">
                          <span className="stor-name">{it.name}</span>
                          <span className="muted">{fmt(it.size)}</span>
                        </span>
                        <span className={'stor-bar thin ' + r.kind}>
                          <i style={{ width: share(it.size, max) + '%' }} />
                        </span>
                      </span>
                      {r.kind === 'projects' && (
                        <button className="pill small" onClick={() => backend.tabs.open(it.path!)}>
                          {t('Open')}
                        </button>
                      )}
                      {r.kind === 'trash' && (
                        <>
                          <button className="pill small" onClick={() => backend.library.restore(it.path!).then(load)}>
                            {t('Restore')}
                          </button>
                          <button className="pill small danger" onClick={() => confirm(t('Delete “{name}” forever?', { name: it.name })) && backend.library.deleteForever(it.path!).then(load)}>
                            {t('Delete')}
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="set-row" style={{ marginTop: 10 }}>
        <span>{t('Projects folder')}</span>
        <code className="path">{dir}</code>
        <button className="pill" onClick={() => backend.library.reveal()}>
          {t('Open folder')}
        </button>
      </div>
    </section>
  )
}
