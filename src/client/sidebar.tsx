import type { SidebarSession, SidebarView } from '../app/sidebar.ts'
import type { PanelBridge } from './panel-bridge.ts'
import { useSidebar, type SidebarStore } from './sidebar-store.ts'
import type { T } from './text.ts'
import styles from './sidebar.css?raw'

export const MENU_ICON = 'dsh-superagent.project'
export const workspacePath = (path: string) => {
  const value = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:|^\/\//i.test(value) ? value.toLowerCase() : value
}
export function workspaceProject(snapshot: SidebarView | undefined, path: string) {
  const cwd = workspacePath(path)
  const projects = snapshot?.projects.filter(project => !project.archived) ?? []
  const project = projects.find(item => item.repositoryRoot && workspacePath(item.repositoryRoot) === cwd)
  if (project) return { project, kind: 'project' as const }
  const worktree = projects.filter(item => item.worktreeRoot && cwd.startsWith(`${workspacePath(item.worktreeRoot)}/`))
    .sort((a, b) => workspacePath(b.worktreeRoot).length - workspacePath(a.worktreeRoot).length)[0]
  return worktree ? { project: worktree, kind: 'worktree' as const } : undefined
}

export function workspaceActions(snapshot: SidebarView | undefined, path: string, name: string, bridge: PanelBridge,
  openRouter: (id: string) => Promise<void>, t: T) {
  const open = (id: string) => ({ id: 'router', label: t('sideOpenRouter'), icon: { key: MENU_ICON }, run: () => openRouter(id) })
  const board = (id: string) => ({ id: 'board', label: t('sideOpenProject'), icon: { key: MENU_ICON }, run: () => bridge.openProject(id) })
  const match = workspaceProject(snapshot, path)
  if (!match) return [{ id: 'register', label: t('sideRegisterWorkspace'), icon: { key: MENU_ICON }, run: () => bridge.registerWorkspace(path, name) }]
  const { kind, project: { id } } = match
  return kind === 'project' ? [open(id), board(id), { id: 'new', label: t('sideNewTicket'), icon: { key: MENU_ICON }, run: () => bridge.newTicket(id) }]
    : [board(id), open(id)]
}
export function SidebarGlyph({ worker = false, size = 14 }: { worker?: boolean; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {worker ? <path d="M4 6h16v4a2 2 0 0 0 0 4v4H4v-4a2 2 0 0 0 0-4zM10 9h5m-5 6h5" /> : <path d="M6 4h9l4 2v2l-4 2H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm4 6v10a2 2 0 0 0 4 0V10" />}
  </svg>
}
export function SidebarIcon({ store, size }: { store: SidebarStore; size: number }) {
  const totals = useSidebar(store)?.totals
  return <span className="sa-side-entry"><style>{styles}</style><SidebarGlyph size={size} />
    {totals && (totals.waiting > 0 || totals.running > 0) && <i className="sa-side-dot" data-state={totals.waiting > 0 ? 'waiting' : 'running'} aria-hidden="true" />}</span>
}
function open(session: SidebarSession, bridge: PanelBridge) {
  if (session.kind === 'router') bridge.openProject(session.projectId)
  else bridge.openTicket(session.projectId, session.ticketId)
}
export type RowPlace = 'leading' | 'trailing' | 'hover' | 'action' | 'menu'
export function SidebarRow({ sessionId, store, bridge, t, place, dismiss }: {
  sessionId: string; store: SidebarStore; bridge: PanelBridge; t: T; place: RowPlace; dismiss?: () => void
}) {
  const row = useSidebar(store)?.sessions[sessionId]
  if (!row) return null
  const router = row.kind === 'router'
  const state = router ? row.waiting ? 'waiting' : row.running ? 'running' : 'idle' : row.status
  const title = router ? t('sideRouter') : row.desk || t('sideWorker')
  const text = router ? t('sideOpenProject') : t('sideOpenTicket')
  if (place === 'leading') return <SidebarGlyph worker={!router} />
  if (place === 'trailing') return <span className="sa-side-badge" data-state={state}>{title}{router && row.active > 0 ? ` · ${row.active}` : ''}</span>
  if (place === 'hover') return <div className="sa-side-hover"><strong>{row.projectName} · {title}</strong>
    <span>{router ? t('sideRouterLoad', { active: row.active, waiting: row.waiting }) : `${row.ticketTitle} · ${t(`sideStatus.${row.status}`)}`}</span>
    {!router && row.branch && <code>{row.branch}</code>}</div>
  return <button type="button" className={place === 'action' ? 'sa-side-action' : undefined} role={place === 'menu' ? 'menuitem' : undefined}
    aria-label={text} title={text} onClick={event => { event.stopPropagation(); dismiss?.(); open(row, bridge) }}>
    {place === 'action' ? <SidebarGlyph worker={!router} /> : text}</button>
}
