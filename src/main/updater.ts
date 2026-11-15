// Updates from the releases of the project on GitHub.
//  - Windows: electron-updater reads latest.yml of the newest release, downloads the installer in the background
//    (only the changed blocks when it can) and installs it on restart. No code signing is needed for that.
//  - macOS (and Linux): an update can only install itself from a signed build, so the app just tells that a newer
//    release exists and links to its page.
// The check is the only thing in Gigma that goes to the network by itself, and it can be switched off in Settings.
import { app, net, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/api'
import { getSettings } from './settings'

const REPO = 'A01L/gigma'
/** the page a person downloads a release from */
const RELEASES = `https://github.com/${REPO}/releases/latest`
const SIX_HOURS = 6 * 3600_000

let state: UpdateState = { status: 'idle' }
let notify: (s: UpdateState) => void = () => {}
/** closes the tabs (saving them) before the app goes down for the installer */
let beforeInstall: () => Promise<void> = async () => {}
let wired = false
/** true when this build can replace itself */
const selfUpdating = () => app.isPackaged && process.platform === 'win32'

function set(next: UpdateState): void {
  state = next
  notify(state)
}
export const updateState = (): UpdateState => state

/** "0.3.21" > "0.3.9" */
export function newer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return false
}

function wire(): void {
  if (wired) return
  wired = true
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }))
  autoUpdater.on('update-not-available', () => set({ status: 'none' }))
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', version: state.version, percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version }))
  // a release without latest.yml, no network, GitHub down: nothing to tell unless the check was asked for by hand
  autoUpdater.on('error', (e) => set({ status: 'error', message: String(e?.message ?? e).split('\n')[0].slice(0, 200) }))
}

/** ask GitHub for the newest release and compare (builds that cannot update themselves) */
async function checkByLink(): Promise<void> {
  const r = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Gigma' } })
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`)
  const rel = (await r.json()) as { tag_name?: string; html_url?: string }
  const version = String(rel.tag_name ?? '').replace(/^v/, '')
  if (version && newer(version, app.getVersion())) set({ status: 'link', version, url: rel.html_url || RELEASES })
  else set({ status: 'none' })
}

/** by = 'user': the check was asked for in Settings, so an error is shown; 'auto': quiet */
export async function checkForUpdates(by: 'auto' | 'user' = 'auto'): Promise<UpdateState> {
  if (state.status === 'downloading' || state.status === 'ready') return state
  // a build run from the sources has nothing to update: it only looks whether a newer release exists
  set({ status: 'checking' })
  try {
    if (selfUpdating()) {
      wire()
      await autoUpdater.checkForUpdates()
    } else await checkByLink()
  } catch (e) {
    set(by === 'user' ? { status: 'error', message: String((e as Error).message ?? e).split('\n')[0].slice(0, 200) } : { status: 'idle' })
  }
  if (by === 'auto' && state.status === 'error') set({ status: 'idle' })
  return state
}

/** restart into the downloaded update */
export async function installUpdate(): Promise<void> {
  if (state.status === 'link' && state.url) return void shell.openExternal(state.url)
  if (state.status !== 'ready') return
  await beforeInstall()
  // silent = false: the installer shows its progress; then the app starts again
  autoUpdater.quitAndInstall(false, true)
}

export function initUpdater(opts: { notify: (s: UpdateState) => void; beforeInstall: () => Promise<void> }): void {
  notify = opts.notify
  beforeInstall = opts.beforeInstall
  const auto = () => {
    if (getSettings().autoUpdate === false) return
    void checkForUpdates('auto')
  }
  // a moment after the start, so the window is up first; then a few times a day while the app stays open
  setTimeout(auto, 6000)
  setInterval(auto, SIX_HOURS)
}
