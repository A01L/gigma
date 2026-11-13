// Window shell: Figma Desktop-style tab bar + the Home (file browser) tab.
// Project tabs are separate views placed by the main process right under this bar.
import { useEffect, useState } from 'react'
import type { SpecBoardItem, TabsState } from '@shared/api'
import { backend } from '../backend'
import { Home, type Section } from './Home'
import { Icons } from './icons'
import logoUrl from '../assets/logo.svg'
import { useT } from './i18n'

export function Shell() {
  const t = useT()
  const [state, setState] = useState<TabsState>({ activeId: null, tabs: [] })
  const [homeSection, setHomeSection] = useState<Section | undefined>(undefined)
  const [homeKey, setHomeKey] = useState(0)
  // Spec tasks of the open projects, for the board on Home
  const [specs, setSpecs] = useState<SpecBoardItem[]>([])

  useEffect(() => {
    backend.tabs.onUpdate(setState)
    backend.tabs.state().then(setState)
    backend.library.onChanged(() => setHomeKey((k) => k + 1))
    backend.specs.onUpdate(setSpecs)
    backend.specs.list().then(setSpecs)
    backend.onMenu((a) => {
      if (a === 'settings') {
        setHomeSection('settings')
        setHomeKey((k) => k + 1)
      }
    })
    backend.ready()
  }, [])

  const isMac = backend.platform === 'darwin'
  return (
    <div className="shell">
      <div className="tabbar" style={{ paddingLeft: isMac ? 78 : 6, paddingRight: isMac ? 8 : 140 }}>
        {!isMac && (
          <button
            className="tab-menu no-drag"
            title={t('Menu')}
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              void backend.tabs.popupMenu(Math.round(r.left), Math.round(r.bottom))
            }}
          >
            <img src={logoUrl} width={22} height={22} alt="" draggable={false} />
          </button>
        )}
        <button className={'tab home-tab no-drag' + (state.activeId === null ? ' active' : '')} title={t('Home')} onClick={() => backend.tabs.activate(null)}>
          {Icons.home}
        </button>
        <div className="tabs">
          {state.tabs.map((tab) => (
            <div
              key={tab.id}
              className={'tab no-drag' + (tab.id === state.activeId ? ' active' : '')}
              title={tab.name}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  void backend.tabs.close(tab.id)
                }
              }}
              onClick={() => backend.tabs.activate(tab.id)}
            >
              <span className="tab-name">{tab.name}</span>
              <button
                className="tab-close"
                title={t('Close tab (Ctrl+W)')}
                onClick={(e) => {
                  e.stopPropagation()
                  void backend.tabs.close(tab.id)
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.3">
                  <path d="M2 2l6 6M8 2l-6 6" />
                </svg>
              </button>
            </div>
          ))}
          <button className="tab-new no-drag" title={t('New project (Ctrl+N)')} onClick={() => backend.tabs.newProject()}>
            {Icons.plus}
          </button>
        </div>
      </div>
      <div className="shell-body">
        {state.activeId === null && (
          <Home
            key={homeKey}
            onOpen={(p) => void backend.tabs.open(p)}
            onNew={() => void backend.tabs.newProject()}
            initialSection={homeSection}
            onSection={setHomeSection}
            specs={specs}
            onImport={async () => {
              const p = await backend.library.importFile()
              if (p) await backend.tabs.open(p)
            }}
            openPaths={new Set(state.tabs.map((t) => t.path))}
          />
        )}
      </div>
    </div>
  )
}
