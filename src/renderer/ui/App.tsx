import { useEffect, useState } from 'react'
import { backend } from '../backend'
import { editor } from '../editor/editor'
import { installCommandBus } from '../editor/commands'
import { Home } from './Home'
import { EditorView } from './EditorView'
import { McpDialog } from './McpDialog'
import { saveThumbnail } from './actions'

installCommandBus()

export function App() {
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [mcpOpen, setMcpOpen] = useState(false)

  const open = async (path: string) => {
    const snap = await backend.doc.open(path)
    editor.load(snap)
    setOpenPath(path)
  }

  const goHome = async () => {
    if (openPath) {
      await editor.flush()
      await saveThumbnail()
      await backend.doc.close()
    }
    setOpenPath(null)
  }

  const newProject = async () => {
    await goHome()
    const path = await backend.library.create('Untitled')
    await open(path)
  }

  useEffect(() => {
    backend.onMenu((action) => {
      window.dispatchEvent(new CustomEvent('gigma-menu', { detail: action }))
    })
  }, [])

  useEffect(() => {
    const onMenu = async (e: Event) => {
      const action = (e as CustomEvent<string>).detail
      if (action === 'home') goHome()
      else if (action === 'new-project') newProject()
      else if (action === 'mcp-dialog') setMcpOpen(true)
      else if (action.startsWith('open:')) {
        await goHome()
        await open(action.slice(5))
      }
      else if (action === 'import-library') {
        const p = await backend.library.importFile()
        if (p) {
          await goHome()
          await open(p)
        }
      }
    }
    window.addEventListener('gigma-menu', onMenu)
    return () => window.removeEventListener('gigma-menu', onMenu)
  })

  // persist pending edits before the window closes
  useEffect(() => {
    const h = () => void editor.flush()
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [])

  return (
    <>
      {openPath ? <EditorView onHome={goHome} /> : <Home onOpen={open} onNew={newProject} />}
      {mcpOpen && <McpDialog onClose={() => setMcpOpen(false)} />}
    </>
  )
}
