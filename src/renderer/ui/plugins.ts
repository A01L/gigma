// Installed plugins, shared by the menus, the actions palette and the settings page.
import { useEffect, useState } from 'react'
import type { PluginInfo } from '@shared/api'

let cache: PluginInfo[] = []
const subs = new Set<() => void>()
let started = false

const api = () => (typeof window !== 'undefined' ? window.gigma?.plugins : undefined)

async function refresh(): Promise<void> {
  try {
    cache = (await api()?.list()) ?? []
  } catch {
    cache = []
  }
  subs.forEach((f) => f())
}

function start(): void {
  if (started) return
  started = true
  api()?.onChanged(() => void refresh())
  void refresh()
}

export function usePlugins(): PluginInfo[] {
  const [, tick] = useState(0)
  useEffect(() => {
    start()
    const f = () => tick((n) => n + 1)
    subs.add(f)
    return () => void subs.delete(f)
  }, [])
  return cache
}

export const installedPlugins = () => (start(), cache)
export const refreshPlugins = refresh

/** open a plugin in the editor of this tab */
export function runPlugin(id: string): void {
  window.dispatchEvent(new CustomEvent('gigma-run-plugin', { detail: id }))
}
