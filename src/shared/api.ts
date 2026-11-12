import type { DocChanges, DocSnapshot, GNode, Page } from './types'
import type { CommandRequest, CommandResponse } from './commands'

export interface ProjectInfo {
  path: string
  name: string
  updatedAt: number
  createdAt: number
  thumb: string | null
  trashedAt?: number
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

/** Bridge exposed by the preload script as window.gigma */
export interface GigmaApi {
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
