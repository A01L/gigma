// The launch splash: the layered G of the logo floating right on the desktop, in a small frameless
// transparent window, while the main window loads hidden behind it. Plain HTML and CSS from a data: URL,
// so it paints at once and costs no bundle.
import { BrowserWindow } from 'electron'

/** the splash stays at least this long, then fades and the main window appears */
export const SPLASH_MS = 5000
const FADE_MS = 350
const SIZE = 460

const G = 'M25.78 111.2C13.9 111.2 3.64 108.8 -5 104C-13.64 99.08 -20.3 92.24 -24.98 83.48C-29.66 74.6 -32 64.34 -32 52.7C-32 44.42 -30.74 36.56 -28.22 29.12C-25.7 21.56 -22.16 14.72 -17.6 8.6C-13.04 2.35999 -7.7 -3.04001 -1.58 -7.60001C4.66 -12.16 11.5 -15.7 18.94 -18.22C26.5 -20.74 34.48 -22 42.88 -22C50.8 -22 58 -20.86 64.48 -18.58C70.96 -16.3 76.6 -13.12 81.4 -9.04001C86.2 -5.08 89.92 -0.400002 92.56 4.99999C95.32 10.4 96.76 16.28 96.88 22.64H69.16C68.8 19.4 67.9 16.4 66.46 13.64C65.14 10.88 63.28 8.48 60.88 6.43999C58.6 4.39999 55.72 2.83999 52.24 1.75999C48.88 0.559996 44.98 -0.0400085 40.54 -0.0400085C35.38 -0.0400085 30.58 0.92 26.14 2.84C21.7 4.64 17.62 7.21999 13.9 10.58C10.3 13.94 7.18 17.9 4.54 22.46C1.9 26.9 -0.140001 31.82 -1.58 37.22C-3.02 42.5 -3.74 48.02 -3.74 53.78C-3.74 64.82 -0.98 73.58 4.54 80.06C10.06 86.42 17.62 89.6 27.22 89.6C35.26 89.6 41.86 88.52 47.02 86.36C52.18 84.2 56.44 81.44 59.8 78.08L84.82 87.26C77.26 94.82 68.62 100.7 58.9 104.9C49.18 109.1 38.14 111.2 25.78 111.2ZM57.1 87.26L64.66 54.14L69.16 59.72H34.96L39.82 38.48H96.16L84.82 87.26H57.1Z'

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;-webkit-app-region:drag;user-select:none}
body{display:flex;align-items:center;justify-content:center}
svg{overflow:visible;animation:in .4s ease-out both;filter:drop-shadow(0 10px 24px rgba(0,0,0,.45))}
body.leaving svg{opacity:0;scale:.94;transition:opacity ${FADE_MS}ms ease,scale ${FADE_MS}ms ease}
use{translate:calc(var(--i)*4px) calc(var(--i)*4px);animation:layers 2.6s ease-in-out infinite;animation-delay:calc(var(--i)*-.16s)}
@keyframes in{from{opacity:0;scale:.85}}
@keyframes layers{0%,100%{translate:calc(var(--i)*1.5px) calc(var(--i)*1.5px)}50%{translate:calc(var(--i)*7.5px) calc(var(--i)*7.5px)}}
@media (prefers-reduced-motion:reduce){svg,use{animation:none}}
</style></head><body><svg viewBox="-44 -34 196 196" width="300" height="300">
<defs><path id="g" d="${G}"/><linearGradient id="f" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#d4d6e6"/></linearGradient></defs>
<use href="#g" fill="#17171c" style="--i:5"/><use href="#g" fill="#24242b" style="--i:4"/><use href="#g" fill="#3c3c46" style="--i:3"/>
<use href="#g" fill="#686874" style="--i:2"/><use href="#g" fill="#a6a8b8" style="--i:1"/><use href="#g" fill="url(#f)" style="--i:0"/>
</svg></body></html>`

let splash: BrowserWindow | null = null
let shownAt = 0

/** show the splash in the middle of the screen */
export function showSplash(): void {
  shownAt = Date.now()
  splash = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    center: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, spellcheck: false }
  })
  splash.once('ready-to-show', () => splash?.showInactive())
  splash.on('closed', () => (splash = null))
  void splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
}

/** once the main window is ready: wait out the splash's time, fade it, then reveal the window */
export function revealAfterSplash(show: () => void): void {
  if (!splash || splash.isDestroyed()) return show()
  const s = splash
  setTimeout(() => {
    if (s.isDestroyed()) return show()
    s.webContents.executeJavaScript("document.body.classList.add('leaving')").catch(() => {})
    setTimeout(() => {
      show()
      if (!s.isDestroyed()) s.destroy()
    }, FADE_MS)
  }, Math.max(0, shownAt + SPLASH_MS - FADE_MS - Date.now()))
}

/** the app quits before the splash is done */
export function closeSplash(): void {
  if (splash && !splash.isDestroyed()) splash.destroy()
}
