import { useSyncExternalStore } from 'react'
import { editor, type Topic } from '../editor/editor'

/** Re-render when any of the given editor topics change. */
export function useEditor(...topics: Topic[]): number {
  return useSyncExternalStore(
    (cb) => {
      const offs = topics.map((t) => editor.subscribe(t, cb))
      return () => offs.forEach((o) => o())
    },
    () => topics.reduce((s, t) => s * 31 + editor.version(t), 7)
  )
}
