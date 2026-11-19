import type { DocChanges, DocSnapshot, GNode, GuideData, Page, GuideFrames } from './types'
import type { CommandRequest, CommandResponse } from './commands'

export interface ProjectInfo {
  path: string
  name: string
  updatedAt: number
  createdAt: number
  thumb: string | null
  trashedAt?: number
  /** size of the project file on disk, bytes */
  size?: number
  /** archived projects: when it was put away, and how large it was before it was packed */
  archivedAt?: number
  originalSize?: number
}

/** what Gigma keeps on disk, for Settings → Storage (sizes in bytes) */
export interface StorageStats {
  projects: number
  trash: number
  /** projects packed away in the archive */
  archive: number
  plugins: { id: string; name: string; size: number }[]
  /** the guideline library, one entry per guideline */
  guides: { id: string; name: string; size: number }[]
  /** the disk that holds the library */
  diskFree: number
  diskTotal: number
}

export type ThemePref = 'dark' | 'light' | 'system'
export type LanguagePref = 'ru' | 'en' | 'system'

export interface AppSettings {
  theme: ThemePref
  language: LanguagePref
  homeView: 'grid' | 'list'
  homeSort: 'edited' | 'created' | 'name'
  favorites: string[] // project paths
  /** Figma personal access token (stored locally), used only to fetch images of pasted Figma layers */
  figmaToken?: string
  /** look for a new release on GitHub when the app starts; default true. false = never go to the network for it */
  autoUpdate?: boolean
  /** how much of Gigma the MCP clients see; lighter levels cost the AI fewer tokens. Default 'ultra' */
  mcpLevel?: McpLevel
}

/** ultra = every tool; balanced / economy = fewer tools and smaller answers; local = read only, the AI places its design as SVG */
export type McpLevel = 'ultra' | 'balanced' | 'economy' | 'local'

/**
 * Where the app is with updates. link = a newer release exists but this build cannot install it by itself (macOS):
 * `url` is its page. ready = downloaded, a restart installs it.
 */
export interface UpdateState {
  status: 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'link' | 'error'
  version?: string
  /** downloading: 0..100 */
  percent?: number
  url?: string
  message?: string
}

export interface FigmaImageFetchResult {
  /** figma image hash -> Gigma blob hash (usually identical) */
  mapped: Record<string, string>
  failed: string[]
  error?: string
}

export interface McpStatus {
  running: boolean
  port: number
  url: string
  error?: string
  claudeDesktopConfig: string
}

export interface TabInfo {
  id: string
  name: string
  path: string
  /** an AI client has just worked in this tab (over MCP): the tab bar marks it */
  ai?: boolean
}

/** a Spec task (not RULES) of an open project, as the Home board shows it */
export interface SpecTask {
  id: string
  title: string
  /** the first lines of the task text */
  excerpt: string
  status: 'TODO' | 'IN_PROGRESS' | 'DONE'
  page: string
  /** names of the frames or sections the spec is wired to */
  frames: string[]
  /** the AI client that last changed the spec over MCP in this session (Claude, Codex…) */
  client?: string
}
export interface SpecBoardItem extends SpecTask {
  tabId: string
  project: string
}

export interface TabsState {
  activeId: string | null // null = Home
  /** the tab MCP commands act on: the AI works there in the background, whatever tab the user looks at */
  aiTabId?: string | null
  tabs: TabInfo[]
}

/** manifest.json of a plugin package (.gplug) */
export interface PluginManifest {
  /** unique id: lowercase latin letters, digits and dashes */
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** HTML page that is the plugin (default index.html) */
  main?: string
  /** image inside the package shown in menus (svg / png) */
  icon?: string
  /** size of the plugin window; false = no window (the plugin runs hidden and closes itself) */
  ui?: { width?: number; height?: number } | false
  /** "network": gigma.fetch and gigma.capturePage may reach the internet */
  permissions?: string[]
}

export interface PluginInfo extends PluginManifest {
  /** address of the plugin page for the sandboxed frame */
  url: string
  iconUrl: string | null
  /** installed from a folder (developer mode): files are read from that folder on every run */
  devPath?: string
}

export interface PageCapture {
  /** PNG / JPEG bytes of the whole page */
  bytes: Uint8Array
  mime: string
  /** size of the page in CSS pixels */
  width: number
  height: number
  title: string
}

/** Bridge exposed by the preload script as window.gigma */
export interface GigmaApi {
  plugins: {
    list(): Promise<PluginInfo[]>
    /** pick a .gplug file and install it; null = cancelled */
    install(): Promise<PluginInfo | null>
    /** developer mode: use a folder with manifest.json as a plugin */
    installFolder(): Promise<PluginInfo | null>
    /** install a package given as a dropped File or as a path */
    installPath(file: File | string): Promise<PluginInfo>
    remove(id: string): Promise<void>
    onChanged(handler: () => void): void
    openFolder(): Promise<void>
    /** save the plugin documentation (Markdown) / a starter plugin; false = cancelled */
    saveDocs(): Promise<boolean>
    saveTemplate(): Promise<boolean>
    /** full text of the documentation, for the in-app viewer */
    docs(): Promise<string>
    // ---- used by the plugin host of a project tab ----
    command(pluginId: string, name: string, args: unknown): Promise<unknown>
    fetch(pluginId: string, url: string, as: 'text' | 'json' | 'dataURL'): Promise<unknown>
    capture(pluginId: string, opts: { url: string; width: number; mobile?: boolean; maxHeight?: number }): Promise<PageCapture>
    storageGet(pluginId: string, key: string): Promise<unknown>
    storageSet(pluginId: string, key: string, value: unknown): Promise<void>
  }
  /** the guideline library, shared by every project */
  guides: {
    list(): Promise<{ guides: GuideData[]; deleted: string[] }>
    save(data: GuideData): Promise<GuideData>
    /** delete from the library and from every project */
    remove(id: string): Promise<void>
    /**
     * save as a .gguide file; false = cancelled. `frames` = the frames wired to the guideline in the open project:
     * they go into the file (and are kept beside the guideline in the library)
     */
    exportFile(id: string, frames?: GuideFrames | null): Promise<boolean>
    /** the frames that came with the guideline (from a .gguide file or the last export), or null */
    frames(id: string): Promise<GuideFrames | null>
    /** pick a .gguide file and add it to the library; null = cancelled */
    importFile(): Promise<GuideData | null>
    /** add a .gguide file to the library by its path */
    importPath(path: string): Promise<GuideData>
    onChanged(handler: () => void): void
  }
  /** background removal: the model runs in the app, on this computer */
  matting: {
    /** false when this build has no model file */
    available(): Promise<boolean>
    /** rgba = 1024 × 1024 pixels; mask = one byte per pixel (255 = kept); device = what it ran on */
    run(rgba: Uint8Array): Promise<{ mask: Uint8Array; device: string; ms: number }>
  }
  updates: {
    state(): Promise<UpdateState>
    /** look for a new release now */
    check(): Promise<UpdateState>
    /** restart into the downloaded update (or open the page of the release when it cannot install itself) */
    install(): Promise<void>
    onState(handler: (s: UpdateState) => void): void
  }
  platform: string
  /** id of the project tab this renderer belongs to (null in the shell / web mode) */
  tabId: string | null
  library: {
    list(): Promise<ProjectInfo[]>
    create(name: string): Promise<string>
    trash(path: string): Promise<void>
    importFile(): Promise<string | null>
    onChanged(handler: () => void): void
    dir(): Promise<string>
    reveal(): Promise<void>
    listTrash(): Promise<ProjectInfo[]>
    stats(): Promise<StorageStats>
    restore(path: string): Promise<string>
    deleteForever(path: string): Promise<void>
    emptyTrash(): Promise<void>
    /** the archive: projects packed away to save space. They leave Home and come back with unarchive */
    listArchive(): Promise<ProjectInfo[]>
    archive(path: string): Promise<void>
    unarchive(path: string): Promise<string>
    deleteArchived(path: string): Promise<void>
  }
  settings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
    onChanged(handler: (s: AppSettings) => void): void
  }
  appVersion: string
  tabs: {
    state(): Promise<TabsState>
    open(path: string): Promise<void>
    newProject(): Promise<void>
    activate(id: string | null): Promise<void>
    close(id: string): Promise<void>
    home(): Promise<void>
    openSettings(): Promise<void>
    onUpdate(handler: (s: TabsState) => void): void
    popupMenu(x: number, y: number): Promise<void>
  }
  /** the task board on Home: Spec tasks of the projects open in tabs */
  specs: {
    /** a project tab tells the app its Spec tasks (sent again whenever they change) */
    report(tasks: SpecTask[]): void
    list(): Promise<SpecBoardItem[]>
    onUpdate(handler: (items: SpecBoardItem[]) => void): void
    /** switch to the tab and show the spec on its canvas */
    focus(tabId: string, id: string): Promise<void>
    onFocus(handler: (id: string) => void): void
  }
  doc: {
    open(path: string): Promise<DocSnapshot>
    close(): Promise<void>
    apply(changes: DocChanges): Promise<void>
    setThumb(dataUrl: string): Promise<void>
    /** keep the undo / redo steps in the file (JSON), for the next time the project is opened */
    saveHistory(json: string): Promise<void>
    exportProject(): Promise<boolean>
    exportPages(pageIds: string[]): Promise<boolean>
    importPages(): Promise<{ pages: Page[]; nodes: GNode[] } | null>
  }
  blob: {
    put(bytes: Uint8Array, mime: string): Promise<string>
    url(hash: string): string
  }
  files: {
    /**
     * Save exported files. One file opens a Save dialog; several open a folder picker and every file is written
     * into the chosen folder under its own name. Null = cancelled.
     */
    save(files: { name: string; bytes: Uint8Array }[]): Promise<{ dir: string; paths: string[] } | null>
    /** show a saved file in the file manager */
    reveal(path: string): Promise<void>
  }
  pdf: {
    /** one PDF page per entry: the SVG of a layer on a page of width × height points */
    render(pages: { svg: string; width: number; height: number; background?: string }[]): Promise<Uint8Array>
  }
  code: {
    /** render HTML + CSS to PNG bytes (desktop: sandboxed offscreen window) */
    render(html: string, css: string, w: number, h: number, scale: number): Promise<Uint8Array> | null
  }
  figma: {
    /** download original images of pasted Figma layers into this project (needs a token) */
    fetchImages(fileKey: string, hashes: string[]): Promise<FigmaImageFetchResult>
  }
  mcp: {
    status(): Promise<McpStatus>
    copyConfig(): Promise<void>
  }
  onCommand(handler: (req: CommandRequest) => void): void
  respondCommand(res: CommandResponse): void
  onMenu(handler: (action: string) => void): void
  /** called before the tab is closed: flush edits, then resolve */
  onBeforeClose(handler: () => Promise<void>): void
  ready(): void
}
