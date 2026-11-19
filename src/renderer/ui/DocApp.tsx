// One project tab (its own renderer process).
import { useEffect, useState } from 'react'
import { backend } from '../backend'
import { editor } from '../editor/editor'
import { installCommandBus } from '../editor/commands'
import { flushGuides, initGuides } from '../editor/guides'
import { initSpecBoard } from '../editor/spec-board'
import { EditorView } from './EditorView'
import { saveThumbnail } from './actions'
import { Preloader } from './Preloader'
// loaded with the tab, so the list of installed fonts is read while the tab is on screen
import '../editor/text-outline'

/** a project that opens faster than this never shows the preloader: small ones just appear */
const PRELOADER_AFTER = 220
/** once shown, the preloader stays at least this long, so it never just flashes */
const PRELOADER_MIN = 650

/** history kept in the file is capped: a few huge steps (a pasted page of images) must not make closing slow */
const HISTORY_MAX_CHARS = 24_000_000

/** keep the undo / redo steps in the project file; called right after a flush, so they match what is on disk */
async function saveHistory(): Promise<void> {
  try {
    const data = editor.historyData() as { v: number; undo: unknown[]; redo: unknown[] }
    let json = JSON.stringify(data)
    // too large: keep the newest steps
    while (json.length > HISTORY_MAX_CHARS && data.undo.length + data.redo.length > 0) {
      if (data.undo.length) data.undo = data.undo.slice(Math.ceil(data.undo.length / 2))
      else data.redo = data.redo.slice(0, Math.floor(data.redo.length / 2))
      json = JSON.stringify(data)
    }
    await backend.doc.saveHistory(json)
  } catch {
    /* the history is a convenience: the document itself is already saved */
  }
}

export function DocApp({ path }: { path: string }) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 'off' → 'on' (the project is slow to open) → 'leaving' (the editor is drawn, fade out) → 'off'
  const [loader, setLoader] = useState<'off' | 'on' | 'leaving'>('off')

  useEffect(() => {
    installCommandBus()
    backend.onMenu((action) => window.dispatchEvent(new CustomEvent('gigma-menu', { detail: action })))
    backend.onBeforeClose(async () => {
      // an edit still open (a popover, a drag, text being typed) is closed first, so it is saved and can be undone
      editor.closeOpenEdits()
      await flushGuides()
      await editor.flush()
      await saveHistory()
      await saveThumbnail()
    })
    let shownAt = 0
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      shownAt = performance.now()
      setLoader('on')
    }, PRELOADER_AFTER)
    /** the editor is on screen: let the preloader go */
    const reveal = () => {
      done = true
      clearTimeout(timer)
      if (!shownAt) return
      setTimeout(() => {
        setLoader('leaving')
        setTimeout(() => setLoader('off'), 300)
      }, Math.max(0, PRELOADER_MIN - (performance.now() - shownAt)))
    }
    backend.doc
      .open(path)
      .then(async (snap) => {
        // reading a big file took a while and the preloader is up: let it be painted before the heavy work below.
        // (A timer, not a frame: a window that is covered draws no frames, and the project must open all the same.)
        if (shownAt) await new Promise((r) => setTimeout(r, 30))
        editor.load(snap)
        // Ctrl+Z goes on from where it was when the project was closed
        if (snap.history) editor.restoreHistory(snap.history)
        // the shared guideline library: load it and keep this document in step with it
        initGuides()
        // Home shows the Spec tasks of open projects: report ours and keep them fresh
        initSpecBoard()
        setLoaded(true)
        // two frames later the canvas has drawn the page; the timer is for a window that draws no frames
        let revealed = false
        const once = () => {
          if (revealed) return
          revealed = true
          reveal()
        }
        requestAnimationFrame(() => requestAnimationFrame(once))
        setTimeout(once, 500)
      })
      .catch((e) => {
        done = true
        clearTimeout(timer)
        setLoader('off')
        setError(String(e?.message ?? e))
      })
    const h = () => void editor.flush()
    window.addEventListener('beforeunload', h)
    // keep the Home thumbnail fresh when the user switches away from this tab
    const vis = () => document.visibilityState === 'hidden' && void flushGuides().then(() => editor.flush()).then(saveHistory).then(saveThumbnail)
    document.addEventListener('visibilitychange', vis)
    return () => {
      done = true
      clearTimeout(timer)
      window.removeEventListener('beforeunload', h)
      document.removeEventListener('visibilitychange', vis)
    }
  }, [path])

  if (error) return <div className="empty">Could not open project: {error}</div>
  return (
    <>
      {loaded && <EditorView onHome={() => void backend.tabs.home()} />}
      {loader !== 'off' && <Preloader leaving={loader === 'leaving'} />}
    </>
  )
}
