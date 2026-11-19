import { createRoot } from 'react-dom/client'
import { isDesktop } from './backend'
import './ui/styles.css'
import './ui/home-figma.css'
import './ui/select.css'
import './ui/colorpicker.css'
import './ui/layout-guards.css'
import './ui/plugins.css'

// Desktop: the window shell (tab bar + Home) and every project tab load this same bundle,
// distinguished by the URL hash. Web mode (`npm run web`) runs a single in-memory editor.
const hash = location.hash.slice(1)
const root = createRoot(document.getElementById('root')!)

/** the launch splash (index.html) stays at least this long from the start of the page, then fades out */
const SPLASH_MS = 5000
function hideSplash(minMs = 0): void {
  const el = document.getElementById('boot')
  if (!el) return
  setTimeout(() => {
    el.classList.add('leaving')
    setTimeout(() => el.remove(), 400)
  }, Math.max(0, minMs - performance.now()))
}

if (isDesktop && hash.startsWith('doc=')) {
  hideSplash()
  import('./ui/DocApp').then(({ DocApp }) => root.render(<DocApp path={decodeURIComponent(hash.slice(4))} />))
} else if (isDesktop) {
  import('./ui/Shell').then(({ Shell }) => {
    root.render(<Shell />)
    hideSplash(SPLASH_MS)
  })
} else {
  import('./ui/App').then(({ App }) => {
    root.render(<App />)
    hideSplash()
  })
}
