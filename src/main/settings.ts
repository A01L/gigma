// App settings (theme, language, home view, favorites) stored as JSON in userData.
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings } from '../shared/api'

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  language: 'system',
  homeView: 'grid',
  homeSort: 'edited',
  favorites: []
}

const file = () => join(app.getPath('userData'), 'settings.json')
let cache: AppSettings | null = null

export function getSettings(): AppSettings {
  if (cache) return cache
  try {
    cache = existsSync(file()) ? { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(file(), 'utf8')) } : { ...DEFAULT_SETTINGS }
  } catch {
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache!
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  cache = { ...getSettings(), ...patch }
  writeFileSync(file(), JSON.stringify(cache, null, 2))
  return cache
}
