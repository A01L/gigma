import { useEffect, useMemo, useState } from 'react'
import type { McpStatus, ProjectInfo } from '@shared/api'
import { backend } from '../backend'
import { Icons } from './icons'
import logoUrl from '../assets/logo.svg'
import { greetingFor, setSettings, useSettings, useT } from './i18n'
import { Select } from './Select'

interface Props {
  onOpen: (p: string) => void
  onNew: () => void
  /** open directly on a section (e.g. Settings from the app menu) */
  initialSection?: Section
  onImport?: () => void
  openPaths?: Set<string>
}

export type Section = 'recent' | 'favorites' | 'trash' | 'settings'

const I = {
  clock: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" strokeLinecap="round" />
    </svg>
  ),
  star: (filled = false) => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />
    </svg>
  ),
  gear: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7L3.4 3.4" strokeLinecap="round" />
    </svg>
  ),
  grid: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="2" y="2" width="5" height="5" rx="1.2" />
      <rect x="9" y="2" width="5" height="5" rx="1.2" />
      <rect x="2" y="9" width="5" height="5" rx="1.2" />
      <rect x="9" y="9" width="5" height="5" rx="1.2" />
    </svg>
  ),
  list: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    </svg>
  ),
  search: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" strokeLinecap="round" />
    </svg>
  )
}

function relTime(ts: number, lang: string): string {
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
  const s = (ts - Date.now()) / 1000
  const abs = Math.abs(s)
  if (abs < 60) return rtf.format(Math.round(s), 'second')
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour')
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day')
  return new Date(ts).toLocaleDateString(lang)
}

export function Home({ onOpen, onNew, onImport, openPaths, initialSection }: Props) {
  const t = useT()
  const settings = useSettings()
  const lang = document.documentElement.lang || 'en'
  const [items, setItems] = useState<ProjectInfo[] | null>(null)
  const [section, setSection] = useState<Section>(initialSection ?? 'recent')
  const [query, setQuery] = useState('')
  const [favOpen, setFavOpen] = useState(true)
  const greeting = useMemo(() => greetingFor(), [])
  const refresh = () => backend.library.list().then(setItems)
  useEffect(() => {
    refresh()
  }, [])

  const fav = new Set(settings.favorites)
  const toggleFav = (p: string) =>
    setSettings({ favorites: fav.has(p) ? settings.favorites.filter((x) => x !== p) : [...settings.favorites, p] })

  const shown = useMemo(() => {
    let list = items ?? []
    if (section === 'favorites') list = list.filter((p) => fav.has(p.path))
    if (query.trim()) list = list.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()))
    const by = settings.homeSort
    return [...list].sort((a, b) =>
      by === 'name' ? a.name.localeCompare(b.name, lang) : by === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt
    )
  }, [items, section, query, settings.homeSort, settings.favorites, lang]) // eslint-disable-line react-hooks/exhaustive-deps

  // moving to Gigma's Trash is reversible, so no confirmation needed
  const trash = async (p: ProjectInfo) => {
    await backend.library.trash(p.path)
    if (fav.has(p.path)) toggleFav(p.path)
    refresh()
    backend.library.listTrash().then((l) => setTrashCount(l.length))
  }
  const [trashCount, setTrashCount] = useState(0)
  useEffect(() => {
    backend.library.listTrash().then((l) => setTrashCount(l.length))
  }, [section])
  const doImport = async () => {
    if (onImport) return onImport()
    const p = await backend.library.importFile()
    if (p) onOpen(p)
  }

  return (
    <div className="home">
      <aside className="home-side">
        <div className="side-brand">
          <span>
            Gigma <span className="brand-year">26</span>
          </span>
        </div>
        <label className="side-search">
          {I.search}
          <input placeholder={t('Search')} value={query} onChange={(e) => setQuery(e.target.value)} onFocus={() => section === 'settings' && setSection('recent')} />
        </label>
        <nav>
          <button className={'side-item' + (section === 'recent' ? ' active' : '')} onClick={() => setSection('recent')}>
            {I.clock}
            {t('Recent')}
          </button>
          <button className={'side-item' + (section === 'favorites' ? ' active' : '')} onClick={() => setSection('favorites')}>
            {I.star()}
            {t('Favorites')}
            {fav.size > 0 && <span className="side-count">{fav.size}</span>}
          </button>
          <button className={'side-item' + (section === 'trash' ? ' active' : '')} onClick={() => setSection('trash')}>
            {Icons.trash}
            {t('Trash')}
            {trashCount > 0 && <span className="side-count">{trashCount}</span>}
          </button>
        </nav>
        <div className="side-scroll">
        {(items ?? []).some((p) => fav.has(p.path)) && (
          <div className="side-group">
            <button className="side-group-title" onClick={() => setFavOpen(!favOpen)}>
              <span className={'chev-mini' + (favOpen ? ' open' : '')}>▸</span>
              {t('Starred')}
            </button>
            {favOpen &&
              (items ?? [])
                .filter((p) => fav.has(p.path))
                .map((p) => (
                  <button key={p.path} className="side-item small" onClick={() => onOpen(p.path)} title={p.name}>
                    <FileBadge />
                    <span className="side-name">{p.name}</span>
                  </button>
                ))}
          </div>
        )}
        </div>
        <button className={'side-settings' + (section === 'settings' ? ' active' : '')} onClick={() => setSection('settings')}>
          {I.gear}
          {t('Settings')}
          <span className="side-settings-chev">›</span>
        </button>
      </aside>

      <main className="home-main">
        {section === 'settings' ? (
          <SettingsView />
        ) : section === 'trash' ? (
          <TrashView
            query={query}
            onChanged={() => {
              refresh()
              backend.library.listTrash().then((l) => setTrashCount(l.length))
            }}
          />
        ) : (
          <>
            <div className="home-head">
              <h1>{t(greeting)}</h1>
              <button className="chip" onClick={onNew}>
                <span className="chip-icon blue">{Icons.plus}</span>
                {t('New design')}
              </button>
              <button className="chip" onClick={doImport}>
                <span className="chip-icon purple">{Icons.export}</span>
                {t('Import .gigma')}
              </button>
            </div>
            <div className="home-toolbar">
              <div className="text-tabs">
                <button className={section === 'recent' ? 'on' : ''} onClick={() => setSection('recent')}>
                  {t('Recently viewed')}
                </button>
                <button className={section === 'favorites' ? 'on' : ''} onClick={() => setSection('favorites')}>
                  {t('Favorites')}
                </button>
              </div>
              <div style={{ flex: 1 }} />
              <Select
                variant="pill"
                prefix={t('Sort') + ':'}
                value={settings.homeSort}
                minWidth={190}
                onChange={(v) => setSettings({ homeSort: v })}
                options={[
                  { value: 'edited', label: t('Last edited') },
                  { value: 'created', label: t('Date created') },
                  { value: 'name', label: t('Name') }
                ]}
              />
              <div className="pill-seg">
                <button className={settings.homeView === 'grid' ? 'on' : ''} title={t('Grid')} onClick={() => setSettings({ homeView: 'grid' })}>
                  {I.grid}
                </button>
                <button className={settings.homeView === 'list' ? 'on' : ''} title={t('List')} onClick={() => setSettings({ homeView: 'list' })}>
                  {I.list}
                </button>
              </div>
            </div>

            {items && shown.length === 0 && (
              <div className="empty">
                {query
                  ? t('Nothing found')
                  : section === 'favorites'
                    ? t('No favorites yet. Hover a project and click the star.')
                    : t('No projects yet. Create a new design to start. Everything stays on this computer.')}
              </div>
            )}

            {settings.homeView === 'grid' ? (
              <div className="home-grid">
                {shown.map((p) => (
                  <div key={p.path} className="card" onClick={() => onOpen(p.path)}>
                    <div className="thumb">{p.thumb && <img src={p.thumb} alt="" draggable={false} />}</div>
                    <div className="meta">
                      <FileBadge />
                      <div className="meta-text">
                        <b>
                          <span className="card-name">{p.name}</span>
                          {openPaths?.has(p.path) && <span className="open-badge">{t('open')}</span>}
                        </b>
                        <span className="muted">
                          {t('Edited')} {relTime(p.updatedAt, lang)}
                        </span>
                      </div>
                    </div>
                    <div className={'card-actions' + (fav.has(p.path) ? ' pinned' : '')}>
                      <button
                        className={'round-btn' + (fav.has(p.path) ? ' fav' : '')}
                        title={fav.has(p.path) ? t('Remove from favorites') : t('Add to favorites')}
                        onClick={(e) => (e.stopPropagation(), toggleFav(p.path))}
                      >
                        {I.star(fav.has(p.path))}
                      </button>
                      <button className="round-btn danger" title={t('Move to trash')} onClick={(e) => (e.stopPropagation(), void trash(p))}>
                        {Icons.trash}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              shown.length > 0 && (
                <div className="home-table">
                  <div className="tr th">
                    <span />
                    <span>{t('File')}</span>
                    <span>{t('Edited')}</span>
                    <span>{t('Created')}</span>
                    <span />
                  </div>
                  {shown.map((p) => (
                    <div key={p.path} className="tr" onClick={() => onOpen(p.path)}>
                      <span className="mini-thumb" style={p.thumb ? { backgroundImage: `url(${p.thumb})` } : undefined} />
                      <span className="td-name">
                        {p.name}
                        {openPaths?.has(p.path) && <span className="open-badge">{t('open')}</span>}
                      </span>
                      <span className="muted">{relTime(p.updatedAt, lang)}</span>
                      <span className="muted">{new Date(p.createdAt).toLocaleDateString(lang)}</span>
                      <span className="td-actions">
                        <button
                          className={'round-btn' + (fav.has(p.path) ? ' fav' : '')}
                          title={fav.has(p.path) ? t('Remove from favorites') : t('Add to favorites')}
                          onClick={(e) => (e.stopPropagation(), toggleFav(p.path))}
                        >
                          {I.star(fav.has(p.path))}
                        </button>
                        <button className="round-btn danger" title={t('Move to trash')} onClick={(e) => (e.stopPropagation(), void trash(p))}>
                          {Icons.trash}
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )
            )}
          </>
        )}
      </main>
    </div>
  )
}

function SettingsView() {
  const t = useT()
  const s = useSettings()
  const [mcp, setMcp] = useState<McpStatus | null>(null)
  const [dir, setDir] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    backend.mcp.status().then(setMcp)
    backend.library.dir().then(setDir)
  }, [])
  return (
    <div className="settings">
      <h1>{t('Settings')}</h1>

      <section>
        <h2>{t('Appearance')}</h2>
        <div className="set-row">
          <span>{t('Theme')}</span>
          <div className="pill-seg wide">
            {(['dark', 'light', 'system'] as const).map((v) => (
              <button key={v} className={s.theme === v ? 'on' : ''} onClick={() => setSettings({ theme: v })}>
                {t(v === 'dark' ? 'Dark' : v === 'light' ? 'Light' : 'System')}
              </button>
            ))}
          </div>
        </div>
        <div className="set-row">
          <span>{t('Language')}</span>
          <div className="pill-seg wide">
            {(
              [
                ['ru', 'Русский'],
                ['en', 'English'],
                ['system', t('System')]
              ] as const
            ).map(([v, label]) => (
              <button key={v} className={s.language === v ? 'on' : ''} onClick={() => setSettings({ language: v })}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section>
        <h2>{t('AI (MCP)')}</h2>
        {mcp && (
          <>
            <p>
              <span className="status-dot" style={{ background: mcp.running ? '#14ae5c' : '#f24822' }} />
              {mcp.running ? (
                <>
                  {t('Local MCP server is running at')} <code>{mcp.url}</code>. {t('Only this computer can connect.')}
                </>
              ) : (
                (mcp.error ?? t('MCP server is not running.'))
              )}
            </p>
            {mcp.running && (
              <>
                <p className="muted">{t('Claude Desktop: Settings → Developer → Edit Config, paste the config and restart Claude.')}</p>
                <pre>{mcp.claudeDesktopConfig}</pre>
                <button
                  className="pill"
                  onClick={async () => {
                    await backend.mcp.copyConfig()
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  }}
                >
                  {copied ? t('Copied') + ' ✓' : t('Copy Claude Desktop config')}
                </button>
                <p className="muted" style={{ marginTop: 14 }}>
                  {t('HTTP clients (Cursor, VS Code, Claude Code, LM Studio): add a server of type “http” with this URL.')}
                </p>
                <p className="muted">{t('ChatGPT only connects to MCP servers reachable over HTTPS from the internet; it needs a tunnel you set up yourself.')}</p>
              </>
            )}
          </>
        )}
      </section>

      <FigmaSection />

      <section>
        <h2>{t('Storage')}</h2>
        <div className="set-row">
          <span>{t('Projects folder')}</span>
          <code className="path">{dir}</code>
          <button className="pill" onClick={() => backend.library.reveal()}>
            {t('Open folder')}
          </button>
        </div>
      </section>

      <section>
        <h2>{t('About')}</h2>
        <p>
          Gigma {t('Version')} {backend.appVersion}
        </p>
        <p className="muted">{t('Gigma is free and open source. Your files never leave this computer.')}</p>
      </section>
    </div>
  )
}

function FigmaSection() {
  const t = useT()
  const s = useSettings()
  const [token, setToken] = useState(s.figmaToken ?? '')
  const [saved, setSaved] = useState(false)
  useEffect(() => setToken(s.figmaToken ?? ''), [s.figmaToken])
  return (
    <section>
      <h2>{t('Figma')}</h2>
      <p className="muted">{t('Used only to load images of layers pasted from Figma (Figma does not copy image files). Stored only on this computer.')}</p>
      <div className="set-row">
        <span>{t('Personal access token')}</span>
        <input
          className="set-input"
          type="password"
          placeholder="figd_…"
          value={token}
          spellCheck={false}
          onChange={(e) => {
            setToken(e.target.value)
            setSaved(false)
          }}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <button
          className="pill"
          onClick={() => {
            setSettings({ figmaToken: token.trim() || undefined })
            setSaved(true)
            setTimeout(() => setSaved(false), 2000)
          }}
        >
          {saved ? t('Saved') + ' ✓' : t('Save')}
        </button>
      </div>
      <p className="muted">{t('How to get a token: Figma → Settings → Security → Personal access tokens → Generate (scope: File content, read-only).')}</p>
    </section>
  )
}

function TrashView({ query, onChanged }: { query: string; onChanged: () => void }) {
  const t = useT()
  const lang = document.documentElement.lang || 'en'
  const [items, setItems] = useState<ProjectInfo[] | null>(null)
  const load = () => backend.library.listTrash().then(setItems)
  useEffect(() => {
    load()
  }, [])
  const done = () => {
    load()
    onChanged()
  }
  const shown = (items ?? []).filter((p) => !query.trim() || p.name.toLowerCase().includes(query.trim().toLowerCase()))
  return (
    <>
      <div className="home-head">
        <h1>{t('Trash')}</h1>
        {!!items?.length && (
          <button
            className="chip"
            onClick={async () => {
              if (!confirm(t('Delete all {n} projects in Trash forever?', { n: String(items.length) }))) return
              await backend.library.emptyTrash()
              done()
            }}
          >
            <span className="chip-icon red">{Icons.trash}</span>
            {t('Empty trash')}
          </button>
        )}
      </div>
      <div className="home-toolbar">
        <span className="muted">{t('Projects in Trash are deleted forever after 30 days.')}</span>
      </div>
      {items && shown.length === 0 && <div className="empty">{t('Trash is empty')}</div>}
      <div className="home-grid">
        {shown.map((p) => (
          <div key={p.path} className="card trashed">
            <div className="thumb">{p.thumb && <img src={p.thumb} alt="" draggable={false} />}</div>
            <div className="meta">
              <FileBadge />
              <div className="meta-text">
                <b>
                  <span className="card-name">{p.name}</span>
                </b>
                <span className="muted">
                  {t('Deleted')} {relTime(p.trashedAt ?? p.updatedAt, lang)}
                </span>
              </div>
            </div>
            <div className="trash-actions">
              <button
                className="pill-btn"
                onClick={async () => {
                  await backend.library.restore(p.path)
                  done()
                }}
              >
                {t('Restore')}
              </button>
              <button
                className="pill-btn danger"
                onClick={async () => {
                  if (!confirm(t('Delete "{name}" forever?', { name: p.name }))) return
                  await backend.library.deleteForever(p.path)
                  done()
                }}
              >
                {t('Delete forever')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

/** small file-type tile (like Figma's design-file badge) */
function FileBadge() {
  return (
    <span className="file-badge">
      <img src={logoUrl} width={18} height={18} alt="" draggable={false} />
    </span>
  )
}

export function Logo({ size = 28 }: { size?: number }) {
  return <img src={logoUrl} width={size} height={size} alt="" draggable={false} />
}
