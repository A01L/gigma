import { createRoot } from 'react-dom/client'
import { isDesktop } from './backend'
import './ui/styles.css'
import './ui/home-figma.css'
import './ui/select.css'
import './ui/colorpicker.css'
import './ui/layout-guards.css'

// Desktop: the window shell (tab bar + Home) and every project tab load this same bundle,
// distinguished by the URL hash. Web mode (`npm run web`) runs a single in-memory editor.
const hash = location.hash.slice(1)
const root = createRoot(document.getElementById('root')!)

if (isDesktop && hash.startsWith('doc=')) {
  import('./ui/DocApp').then(({ DocApp }) => root.render(<DocApp path={decodeURIComponent(hash.slice(4))} />))
} else if (isDesktop) {
  import('./ui/Shell').then(({ Shell }) => root.render(<Shell />))
} else {
  import('./ui/App').then(({ App }) => root.render(<App />))
}
