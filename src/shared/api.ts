import type { DocChanges, DocSnapshot, GNode, GuideData, Page } from './types'
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
}

/** what Gigma keeps on disk, for Settings → Storage (sizes in bytes) */
export interface StorageStats {
  projects: number
  trash: number
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
}

export interface TabsState {
  activeId: string | null // null = Home
  tabs: TabInfo[]
}

/** manifest.json of a plugin package (.plug.gigma) */
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
    /** pick a .plug.gigma file and install it; null = cancelled */
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
    /** save as a .guide.gigma file; false = cancelled */
    exportFile(id: string): Promise<boolean>
    /** pick a .guide.gigma file and add it to the library; null = cancelled */
    importFile(): Promise<GuideData | null>
    onChanged(handler: () => void): void
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
  doc: {
    open(path: string): Promise<DocSnapshot>
    close(): Promise<void>
    apply(changes: DocChanges): Promise<void>
    setThumb(dataUrl: string): Promise<void>
    exportProject(): Promise<boolean>
    exportPages(pageIds: string[]): Promise<boolean>
    importPages(): Promise<{ pages: Page[]; nodes: GNode[] } | null>
  }
  blob: {
    put(bytes: Uint8Array, mime: string): Promise<string>
    url(hash: string): string
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
