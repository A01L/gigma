// One project tab (its own renderer process).
import { useEffect, useState } from 'react'
import { backend } from '../backend'
import { editor } from '../editor/editor'
import { installCommandBus } from '../editor/commands'
import { initGuides } from '../editor/guides'
import { EditorView } from './EditorView'
import { saveThumbnail } from './actions'

export function DocApp({ path }: { path: string }) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    installCommandBus()
    backend.onMenu((action) => window.dispatchEvent(new CustomEvent('gigma-menu', { detail: action })))
    backend.onBeforeClose(async () => {
      await editor.flush()
      await saveThumbnail()
    })
    backend.doc
      .open(path)
      .then((snap) => {
        editor.load(snap)
        // the shared guideline library: load it and keep this document in step with it
        initGuides()
        setLoaded(true)
      })
      .catch((e) => setError(String(e?.message ?? e)))
    const h = () => void editor.flush()
    window.addEventListener('beforeunload', h)
    // keep the Home thumbnail fresh when the user switches away from this tab
    const vis = () => document.visibilityState === 'hidden' && void editor.flush().then(saveThumbnail)
    document.addEventListener('visibilitychange', vis)
    return () => {
      window.removeEventListener('beforeunload', h)
      document.removeEventListener('visibilitychange', vis)
    }
  }, [path])

  if (error) return <div className="empty">Could not open project: {error}</div>
  if (!loaded) return null
  return <EditorView onHome={() => void backend.tabs.home()} />
}
