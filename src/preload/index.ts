import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { GigmaApi } from '../shared/api'

const tabArg = process.argv.find((a) => a.startsWith('--gigma-tab='))
const tabId = tabArg ? tabArg.slice('--gigma-tab='.length) : null

const api: GigmaApi = {
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    install: () => ipcRenderer.invoke('plugins:install'),
    installFolder: () => ipcRenderer.invoke('plugins:installFolder'),
    installPath: (file) => ipcRenderer.invoke('plugins:installPath', typeof file === 'string' ? file : webUtils.getPathForFile(file)),
    remove: (id) => ipcRenderer.invoke('plugins:remove', id),
    onChanged: (handler) => {
      ipcRenderer.on('plugins:changed', () => handler())
    },
    openFolder: () => ipcRenderer.invoke('plugins:openFolder'),
    saveDocs: () => ipcRenderer.invoke('plugins:saveDocs'),
    saveTemplate: () => ipcRenderer.invoke('plugins:saveTemplate'),
    docs: () => ipcRenderer.invoke('plugins:docs'),
    command: (pluginId, name, args) => ipcRenderer.invoke('plugins:command', pluginId, name, args),
    fetch: (pluginId, url, as) => ipcRenderer.invoke('plugins:fetch', pluginId, url, as),
    capture: (pluginId, opts) => ipcRenderer.invoke('plugins:capture', pluginId, opts),
    storageGet: (pluginId, key) => ipcRenderer.invoke('plugins:storageGet', pluginId, key),
    storageSet: (pluginId, key, value) => ipcRenderer.invoke('plugins:storageSet', pluginId, key, value)
  },
  guides: {
    list: () => ipcRenderer.invoke('guides:list'),
    save: (data) => ipcRenderer.invoke('guides:save', data),
    remove: (id) => ipcRenderer.invoke('guides:remove', id),
    exportFile: (id) => ipcRenderer.invoke('guides:export', id),
    importFile: () => ipcRenderer.invoke('guides:import'),
    onChanged: (handler) => {
      ipcRenderer.on('guides:changed', () => handler())
    }
  },
  platform: process.platform,
  tabId,
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    create: (name) => ipcRenderer.invoke('library:create', name),
    trash: (path) => ipcRenderer.invoke('library:trash', path),
    importFile: () => ipcRenderer.invoke('library:import'),
    onChanged: (handler) => {
      ipcRenderer.on('library:changed', () => handler())
    },
    dir: () => ipcRenderer.invoke('library:dir'),
    reveal: () => ipcRenderer.invoke('library:reveal'),
    listTrash: () => ipcRenderer.invoke('trash:list'),
    stats: () => ipcRenderer.invoke('library:stats'),
    restore: (path) => ipcRenderer.invoke('trash:restore', path),
    deleteForever: (path) => ipcRenderer.invoke('trash:delete', path),
    emptyTrash: () => ipcRenderer.invoke('trash:empty')
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    onChanged: (handler) => {
      ipcRenderer.on('settings:changed', (_e, s) => handler(s))
    }
  },
  appVersion: (process.argv.find((a) => a.startsWith('--gigma-version=')) ?? '').slice('--gigma-version='.length),
  tabs: {
    state: () => ipcRenderer.invoke('tabs:state'),
    open: (path) => ipcRenderer.invoke('tabs:open', path),
    newProject: () => ipcRenderer.invoke('tabs:new'),
    activate: (id) => ipcRenderer.invoke('tabs:activate', id),
    close: (id) => ipcRenderer.invoke('tabs:close', id),
    home: () => ipcRenderer.invoke('tabs:home'),
    openSettings: () => ipcRenderer.invoke('app:openSettings'),
    onUpdate: (handler) => {
      ipcRenderer.on('tabs:update', (_e, s) => handler(s))
    },
    popupMenu: (x, y) => ipcRenderer.invoke('menu:popup', x, y)
  },
  specs: {
    report: (tasks) => ipcRenderer.send('specs:report', tasks),
    list: () => ipcRenderer.invoke('specs:list'),
    onUpdate: (handler) => {
      ipcRenderer.on('specs:update', (_e, items) => handler(items))
    },
    focus: (tabId, id) => ipcRenderer.invoke('specs:focus', tabId, id),
    onFocus: (handler) => {
      ipcRenderer.on('specs:focus', (_e, id) => handler(id))
    }
  },
  doc: {
    open: (path) => ipcRenderer.invoke('doc:open', path),
    close: () => ipcRenderer.invoke('doc:close'),
    apply: (changes) => ipcRenderer.invoke('doc:apply', changes),
    setThumb: (dataUrl) => ipcRenderer.invoke('doc:thumb', dataUrl),
    exportProject: () => ipcRenderer.invoke('doc:exportProject'),
    exportPages: (ids) => ipcRenderer.invoke('doc:exportPages', ids),
    importPages: () => ipcRenderer.invoke('doc:importPages')
  },
  blob: {
    put: (bytes, mime) => ipcRenderer.invoke('blob:put', bytes, mime),
    url: (hash) => `gigma-blob://t${tabId}/${hash}`
  },
  files: {
    save: (files) => ipcRenderer.invoke('files:save', files),
    reveal: (path) => ipcRenderer.invoke('files:reveal', path)
  },
  pdf: {
    render: (pages) => ipcRenderer.invoke('pdf:render', pages)
  },
  code: {
    render: (html, css, w, h, scale) => ipcRenderer.invoke('code:render', html, css, w, h, scale)
  },
  figma: {
    fetchImages: (fileKey, hashes) => ipcRenderer.invoke('figma:fetchImages', fileKey, hashes)
  },
  mcp: {
    status: () => ipcRenderer.invoke('mcp:status'),
    copyConfig: () => ipcRenderer.invoke('mcp:copyConfig')
  },
  onCommand: (handler) => {
    ipcRenderer.on('cmd:request', (_e, req) => handler(req))
  },
  respondCommand: (res) => ipcRenderer.send('cmd:response', res),
  onMenu: (handler) => {
    ipcRenderer.on('menu', (_e, action) => handler(action))
  },
  onBeforeClose: (handler) => {
    ipcRenderer.on('app:before-close', async (_e, id: string) => {
      try {
        await handler()
      } finally {
        ipcRenderer.send(`tab:closed:${id}`)
      }
    })
  },
  ready: () => ipcRenderer.send('renderer:ready')
}

contextBridge.exposeInMainWorld('gigma', api)
