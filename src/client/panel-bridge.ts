/** A one-shot intent from a native workspace row to the management panel. */
export type PanelIntent = { kind: 'project' | 'new'; projectId: string }
  | { kind: 'ticket'; projectId: string; ticketId: string }
  | { kind: 'register'; path: string; name: string }
const key = 'dsh-superagent/panel-intent'

export function panelBridge(select: () => void) {
  const listeners = new Set<() => void>()
  let pending: PanelIntent | undefined
  const take = () => {
    let value = pending
    pending = undefined
    try {
      const serialized = globalThis.sessionStorage?.getItem(key)
      globalThis.sessionStorage?.removeItem(key)
      if (!value && serialized) value = JSON.parse(serialized) as PanelIntent
    } catch { /* Storage can be unavailable in a restricted renderer. */ }
    return value
  }
  const send = (intent: PanelIntent) => {
    pending = intent
    try { globalThis.sessionStorage?.setItem(key, JSON.stringify(intent)) } catch { /* use the in-memory handoff */ }
    select()
    listeners.forEach(listener => listener())
  }
  return { take, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    openProject: (projectId: string) => send({ kind: 'project', projectId }),
    newTicket: (projectId: string) => send({ kind: 'new', projectId }),
    openTicket: (projectId: string, ticketId: string) => send({ kind: 'ticket', projectId, ticketId }),
    registerWorkspace: (path: string, name: string) => send({ kind: 'register', path, name }) }
}
export type PanelBridge = ReturnType<typeof panelBridge>
