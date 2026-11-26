import { useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SidebarSession, SidebarView } from '../app/sidebar.ts'
import type { PanelBridge } from './panel-bridge.ts'
import { SidebarGlyph, workspaceProject } from './sidebar.tsx'
import { useSidebar, type SidebarStore } from './sidebar-store.ts'
import type { T } from './text.ts'
import styles from './sidebar.css?raw'

const PROJECTS = 'dsh-superagent.sidebar.projectsCollapsed'
const WORKSPACES = 'dsh-superagent.sidebar.workspacesCollapsed'
const PROJECT = 'dsh-superagent.sidebar.projectExpanded.'
const stored = (key: string, fallback: boolean) => {
  try { const value = localStorage.getItem(key); return value === null ? fallback : value === 'true' } catch { return fallback }
}
function remember(key: string, value: boolean) {
  try { localStorage.setItem(key, String(value)) } catch { /* Restricted renderer storage. */ }
}
const projectState = (project: SidebarView['projects'][number]) => project.failed > 0 ? 'failed' : project.waiting > 0 ? 'waiting' : project.running > 0 ? 'running' : 'idle'
const workerPriority = { failed: 0, waiting: 1, running: 2, queued: 3, idle: 4, done: 5 }
const worker = (row: SidebarSession): row is Extract<SidebarSession, { kind: 'worker' }> => row.kind === 'worker'

type Options = { store: SidebarStore; workspaces?: WorkspaceSource; bridge: PanelBridge; openRouter(id: string): Promise<void>;
  openSession(id: string, signal: AbortSignal): Promise<boolean>; t: T }
function disclosure(open: boolean) { return <span aria-hidden="true" className="sa-section-chevron" data-open={open}>▸</span> }
function Shortcut({ label, icon, run }: { label: string; icon: string; run(): void }) {
  return <button type="button" className="sa-section-shortcut" aria-label={label} title={label} onClick={event => { event.stopPropagation(); run() }}>{icon}</button>
}
function ProjectsSection({ store, bridge, openRouter, openSession, t }: Options) {
  const snapshot = useSidebar(store)
  const [collapsed, collapse] = useState(() => stored(PROJECTS, false))
  const [expansions, expand] = useState<Record<string, boolean>>({})
  const [message, setMessage] = useState('')
  const navigate = (job: () => Promise<unknown>) => {
    setMessage('')
    void job().catch(() => setMessage(t('sideNavigateFailed')))
  }
  const projects = snapshot?.projects.filter(project => !project.archived) ?? []
  const { running = 0, waiting = 0 } = snapshot?.totals ?? {}
  const workers = new Map<string, { id: string; row: Extract<SidebarSession, { kind: 'worker' }> }[]>()
  for (const [id, row] of Object.entries(snapshot?.sessions ?? {})) if (worker(row) && row.status !== 'done') {
    const list = workers.get(row.projectId) ?? []
    list.push({ id, row }); workers.set(row.projectId, list)
  }
  return <section className="sa-project-section" aria-label={t('sideProjects')}>
    <div className="sa-section-header">
      <button type="button" className="sa-section-main" aria-expanded={!collapsed} onClick={() => { remember(PROJECTS, !collapsed); collapse(!collapsed) }}>
        {disclosure(!collapsed)}<SidebarGlyph /><span className="sa-section-title">{t('sideProjects')}</span>{snapshot && <span className="sa-side-badge">{projects.length}</span>}
      </button>
      <Shortcut icon="↗" label={t('panel')} run={bridge.openPanel} />
      <Shortcut icon="+" label={t('sideRegisterWorkspace')} run={() => bridge.registerWorkspace('', '')} />
    </div>
    {!collapsed && <>
      {(running > 0 || waiting > 0) && <div className="sa-section-summary">
        {running > 0 && <span className="sa-side-badge" data-state="running">{t('sideRunningCount', { count: running })}</span>}
        {waiting > 0 && <span className="sa-side-badge" data-state="waiting">{t('sideWaitingCount', { count: waiting })}</span>}
      </div>}
      {snapshot && projects.length === 0 && <div className="sa-section-empty">{t('sideNoProjects')} <button type="button" onClick={() => bridge.registerWorkspace('', '')}>{t('sideAddProject')}</button></div>}
      {projects.map(project => {
        const open = Object.hasOwn(expansions, project.id) ? expansions[project.id]! : stored(PROJECT + project.id, project.active > 0)
        const state = projectState(project)
        const list = (workers.get(project.id) ?? []).sort((a, b) => workerPriority[a.row.status] - workerPriority[b.row.status])
        return <div key={project.id}>
          <div className="sa-section-row" data-project={project.id}>
            <button type="button" className="sa-section-main" title={project.repositoryRoot} aria-expanded={open} onClick={() => {
              remember(PROJECT + project.id, !open); expand(previous => ({ ...previous, [project.id]: !open }))
            }}>
              {disclosure(open)}<span className="sa-project-glyph" data-state={state}><SidebarGlyph /><i aria-hidden="true" /></span>
              <span className="sa-section-title">{project.name}</span><span className="sa-side-badge" data-state={state}>{project.active}</span>
            </button>
            <div className="sa-section-actions">
              <Shortcut icon="↪" label={t('sideOpenRouter')} run={() => navigate(() => openRouter(project.id))} />
              <Shortcut icon="+" label={t('sideNewTicket')} run={() => bridge.newTicket(project.id)} />
              <Shortcut icon="↗" label={t('sideOpenProject')} run={() => bridge.openProject(project.id)} />
            </div>
          </div>
          {open && <div className="sa-section-children">
            <button type="button" className="sa-section-child" onClick={() => navigate(() => openRouter(project.id))}><SidebarGlyph /><span>{t('sideRouter')}</span></button>
            {list.map(({ id, row }) => <div key={id} className="sa-section-row sa-section-worker">
              <button type="button" className="sa-section-child" title={row.ticketTitle} onClick={() => bridge.openTicket(project.id, row.ticketId)}>
                <SidebarGlyph worker /><span className="sa-section-title">{row.ticketTitle}</span><span className="sa-side-badge" data-state={row.status}>{row.desk || t(`sideStatus.${row.status}`)}</span>
              </button>
              <Shortcut icon="↪" label={t('sideOpenWorker')} run={() => navigate(async () => { if (!await openSession(id, AbortSignal.timeout(8000))) throw Error('Session unavailable') })} />
            </div>)}
          </div>}
        </div>
      })}
    </>}
    {message && <div className="sa-section-empty" role="status">{message}</div>}
  </section>
}

/** Adapts rc.5 DOM anchors. The native header, search, tree and row handlers keep their ownership. */
export function mountSidebarSections(options: Options, doc = document): () => void {
  const win = doc.defaultView
  if (!win || !doc.body) return () => {}
  const root = createRoot(doc.createElement('div'))
  const host = doc.createElement('div'); host.dataset.saProjectsHost = 'true'
  const style = doc.createElement('style'); style.textContent = styles; doc.head.append(style)
  const toggle = doc.createElement('button'); toggle.type = 'button'; toggle.dataset.saWorkspacesToggle = 'true'; toggle.className = 'sa-section-shortcut'
  toggle.title = options.t('sideToggleWorkspaces'); toggle.setAttribute('aria-label', toggle.title)
  const marks = new Map<Element, HTMLElement>()
  let list: HTMLElement | undefined, frame = 0, rendered = false, disposed = false
  let collapsed = stored(WORKSPACES, false)
  const schedule = () => { if (!disposed && !frame) frame = win.requestAnimationFrame(update) }
  toggle.onclick = event => { event.stopPropagation(); collapsed = !collapsed; remember(WORKSPACES, collapsed); update() }
  function update() {
    if (frame) win!.cancelAnimationFrame(frame)
    frame = 0
    const header = doc.querySelector<HTMLElement>('[data-sidebar-scrollport] [data-sidebar-workspace-header]')
    const browser = header?.parentElement
    const nextList = header?.nextElementSibling
    if (list && list !== nextList) list.classList.remove('sa-ws-collapsed')
    list = undefined
    const visible = header && browser && !header.closest('[data-sidebar-collapsed="true"]') && nextList instanceof win!.HTMLElement && nextList.hasAttribute('data-sidebar-list-area')
    const seen = new Set<Element>()
    if (visible) {
      list = nextList
      if (host.nextElementSibling !== browser) browser.before(host)
      if (!rendered) { rendered = true; root.render(createPortal(<ProjectsSection {...options} />, host)) }
      if (toggle.parentElement !== header) header.prepend(toggle)
      const input = header.querySelector('input')
      const searching = Boolean(header.querySelector('button:not([data-sa-workspaces-toggle])[aria-expanded="true"]') || (input && (input === doc.activeElement || input.value)))
      const hide = collapsed && !searching
      list.classList.toggle('sa-ws-collapsed', hide)
      const expanded = String(!hide)
      if (toggle.getAttribute('aria-expanded') !== expanded) toggle.setAttribute('aria-expanded', expanded)
      if (toggle.textContent !== (hide ? '▸' : '▾')) toggle.textContent = hide ? '▸' : '▾'
      const snapshot = options.store.getSnapshot()
      const byId = new Map((options.workspaces?.getSnapshot().items ?? []).map(item => [item.workspaceId as string, item.path]))
      for (const row of list.querySelectorAll<HTMLElement>('[data-row-key^="workspace:"]')) {
        const path = byId.get(row.dataset.rowKey!.slice('workspace:'.length))
        const match = path && workspaceProject(snapshot, path)
        if (!match) continue
        const action = [...row.children].find(node => [...node.classList].some(name => name.endsWith('_rowActions') || name === 'rowActions'))
        if (!action) continue
        seen.add(row)
        let mark = marks.get(row)
        if (!mark) {
          mark = doc.createElement('span'); mark.className = 'sa-ws-mark'
          mark.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 4h9l4 2v2l-4 2H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm4 6v10a2 2 0 0 0 4 0V10"/></svg><span></span>'
          marks.set(row, mark)
        }
        if (mark.nextElementSibling !== action) action.before(mark)
        const { kind, project } = match
        mark.dataset.kind = kind; mark.dataset.state = projectState(project)
        mark.title = options.t(kind === 'project' ? 'sideProjectMark' : 'sideWorktreeMark', { name: project.name })
        const count = project.active ? String(project.active) : ''
        if (mark.lastElementChild!.textContent !== count) mark.lastElementChild!.textContent = count
      }
    } else {
      nextList?.classList.remove('sa-ws-collapsed')
      host.remove(); toggle.remove()
    }
    for (const [row, mark] of marks) if (!seen.has(row)) { mark.remove(); marks.delete(row) }
  }
  const observer = new win.MutationObserver(schedule)
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-sidebar-scrollport', 'data-sidebar-collapsed', 'aria-expanded', 'data-row-key'] })
  const events = ['focusin', 'focusout', 'input'] as const
  for (const name of events) doc.addEventListener(name, schedule)
  const disposeStore = options.store.subscribe(schedule)
  const disposeWorkspaces = options.workspaces?.subscribe(schedule)
  schedule()
  return () => {
    disposed = true; observer.disconnect(); win.cancelAnimationFrame(frame)
    for (const name of events) doc.removeEventListener(name, schedule)
    disposeStore(); disposeWorkspaces?.(); root.unmount(); host.remove(); style.remove(); toggle.remove()
    list?.classList.remove('sa-ws-collapsed')
    for (const mark of marks.values()) mark.remove()
    marks.clear()
  }
}
