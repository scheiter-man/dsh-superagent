import { useSyncExternalStore } from 'react'
import { caller, type SidebarView } from './api.ts'

export function sidebarStore(doc: Document = document, interval = 15_000) {
  const listeners = new Set<() => void>()
  let snapshot: SidebarView | undefined, active = true, token: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined, inflight: Promise<void> | undefined, again = false
  const messages = () => ({ offline: '', notRunning: '', serverError: () => '', requestFailed: () => '', setup: () => '', user: () => '' })
  const refresh = (): Promise<void> => {
    if (!active) return Promise.resolve()
    if (inflight) { again = true; return inflight }
    clearTimeout(timer)
    inflight = caller(messages, token)('GET sidebar').catch(() => undefined).then(next => {
      if (!active) return
      if (JSON.stringify(next) === JSON.stringify(snapshot)) return
      snapshot = next
      listeners.forEach(listener => listener())
    }).finally(() => {
      inflight = undefined
      if (!active) return
      if (again) { again = false; void refresh() }
      else if (!doc.hidden) timer = setTimeout(() => { void refresh() }, interval)
    })
    return inflight
  }
  const visibility = () => { clearTimeout(timer); if (!doc.hidden) void refresh() }
  doc.addEventListener('visibilitychange', visibility)
  void refresh()
  return { refresh, getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    unlock(value?: string) { if (token !== value) { token = value; void refresh() } },
    openRouter: (id: string) => caller(messages, token)('POST projects/:id/router', { id }),
    dispose() { active = false; clearTimeout(timer); doc.removeEventListener('visibilitychange', visibility); listeners.clear() } }
}
export type SidebarStore = ReturnType<typeof sidebarStore>
const empty = () => undefined
const noop = () => () => {}
export function useSidebar(store?: SidebarStore) { return useSyncExternalStore(store?.subscribe ?? noop, store?.getSnapshot ?? empty) }
