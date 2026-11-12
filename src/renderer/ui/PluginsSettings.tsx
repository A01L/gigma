// Settings → Plugins: install / remove packages and read the plugin documentation.
import { useEffect, useState } from 'react'
import { backend, isDesktop } from '../backend'
import { useT } from './i18n'
import { refreshPlugins, usePlugins } from './plugins'

/** inline `code`, **bold** and [links](url) */
function inline(text: string, key: number): React.ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g)
  return (
    <span key={key}>
      {parts.map((p, i) => {
        if (p.startsWith('`') && p.endsWith('`') && p.length > 2) return <code key={i}>{p.slice(1, -1)}</code>
        if (p.startsWith('**') && p.endsWith('**') && p.length > 4) return <b key={i}>{p.slice(2, -2)}</b>
        const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(p)
        if (m) return <span key={i}>{m[1]}</span>
        return p
      })}
    </span>
  )
}

/** Small Markdown renderer: headings, fenced code, lists, tables, paragraphs. Enough for the docs. */
function Markdown({ text }: { text: string }) {
  const out: React.ReactNode[] = []
  const lines = text.replace(/\r/g, '').split('\n')
  let i = 0
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
  while (i < lines.length) {
    const l = lines[i]
    if (l.startsWith('```')) {
      const body: string[] = []
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i])
      i++
      out.push(<pre key={out.length}>{body.join('\n')}</pre>)
    } else if (/^#{1,4} /.test(l)) {
      const level = l.indexOf(' ')
      const Tag = (['h2', 'h3', 'h4', 'h5'] as const)[level - 1]
      out.push(<Tag key={out.length}>{inline(l.slice(level + 1), 0)}</Tag>)
      i++
    } else if (l.trim().startsWith('|') && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const head = cells(l)
      const rows: string[][] = []
      for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) rows.push(cells(lines[i]))
      out.push(
        <table key={out.length}>
          <thead>
            <tr>{head.map((c, k) => <th key={k}>{inline(c, k)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, k) => (
              <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c, j)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      )
    } else if (/^\s*([-*]|\d+\.) /.test(l)) {
      const items: string[] = []
      const ordered = /^\s*\d+\. /.test(l)
      for (; i < lines.length && /^\s*([-*]|\d+\.) /.test(lines[i]); i++) items.push(lines[i].replace(/^\s*([-*]|\d+\.) /, ''))
      const List = ordered ? 'ol' : 'ul'
      out.push(<List key={out.length}>{items.map((it, k) => <li key={k}>{inline(it, k)}</li>)}</List>)
    } else if (!l.trim()) i++
    else {
      const para: string[] = []
      for (; i < lines.length && lines[i].trim() && !/^(#{1,4} |```|\s*([-*]|\d+\.) |\|)/.test(lines[i]); i++) para.push(lines[i])
      out.push(<p key={out.length}>{inline(para.join(' '), 0)}</p>)
    }
  }
  return <div className="md">{out}</div>
}

export function PluginsSection() {
  const t = useT()
  const plugins = usePlugins()
  const [error, setError] = useState('')
  const [docs, setDocs] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (open && docs === null) backend.plugins.docs().then(setDocs)
  }, [open, docs])
  if (!isDesktop) return null
  const guard = (fn: () => Promise<unknown>) => async () => {
    setError('')
    try {
      await fn()
      await refreshPlugins()
    } catch (e) {
      // "Error invoking remote method '…': Error: message" -> message
      setError(String((e as Error).message ?? e).replace(/^.*?Error: /, ''))
    }
  }
  // .plug.gigma files can simply be dropped here
  const onDrop = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files).filter((f) => /\.plug\.gigma$|\.zip$/i.test(f.name))
    if (!files.length) return
    e.preventDefault()
    e.stopPropagation()
    void guard(async () => {
      for (const f of files) await backend.plugins.installPath(f)
    })()
  }
  return (
    <section onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <h2>{t('Plugins')}</h2>
      <p className="muted">{t('Plugins add tools to the editor. A plugin is a .plug.gigma file; it runs in a sandbox and can only change the open project.')}</p>
      <div className="set-row" style={{ flexWrap: 'wrap' }}>
        <button className="pill primary" onClick={guard(() => backend.plugins.install())}>
          {t('Install plugin…')}
        </button>
        <button className="pill" title={t('For plugin authors: use a folder with manifest.json without packing it')} onClick={guard(() => backend.plugins.installFolder())}>
          {t('Install from folder…')}
        </button>
        <button className="pill" onClick={() => backend.plugins.openFolder()}>
          {t('Open folder')}
        </button>
      </div>
      {error && <p style={{ color: '#f24822' }}>{error}</p>}
      <div className="plugin-list">
        {plugins.map((p) => (
          <div className="plugin-row" key={p.id}>
            <div className="plugin-icon">{p.iconUrl ? <img src={p.iconUrl} alt="" /> : p.name.charAt(0)}</div>
            <div className="plugin-meta">
              <div className="plugin-name">
                {p.name} <span className="muted">{p.version}</span>
                {p.permissions?.includes('network') && <span className="chip-tag warn">{t('Internet access')}</span>}
                {p.devPath && <span className="chip-tag">{t('Folder')}</span>}
              </div>
              <div className="muted">
                {p.description}
                {p.author ? ` · ${p.author}` : ''}
              </div>
            </div>
            <button className="pill" onClick={guard(() => backend.plugins.remove(p.id))}>
              {t('Remove')}
            </button>
          </div>
        ))}
        {!plugins.length && <p className="muted">{t('No plugins installed yet.')}</p>}
      </div>
      <p className="muted" style={{ marginTop: 14 }}>
        {t('Run a plugin in a project: right click → Plugins, or Ctrl+K and type its name.')}
      </p>

      <h2 style={{ marginTop: 22 }}>{t('Make your own plugin')}</h2>
      <p className="muted">{t('The documentation describes the package format and the whole API. Give it to an AI assistant (Claude, ChatGPT) with a description of what you want and it will write the plugin.')}</p>
      <div className="set-row" style={{ flexWrap: 'wrap' }}>
        <button className="pill primary" onClick={() => backend.plugins.saveDocs()}>
          {t('Download documentation')}
        </button>
        <button className="pill" onClick={() => backend.plugins.saveTemplate()}>
          {t('Download plugin template')}
        </button>
        <button className="pill" onClick={() => setOpen(!open)}>
          {open ? t('Hide documentation') : t('Read here')}
        </button>
      </div>
      {open && <div className="docs-view">{docs === null ? '…' : <Markdown text={docs} />}</div>}
    </section>
  )
}
