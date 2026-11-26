import { ticketStage } from '../core/index.ts'
import { workerSessionId } from '../executor/dsh.ts'
import type { HttpHost } from './http.ts'

export type SidebarStatus = 'running' | 'waiting' | 'failed' | 'done' | 'queued' | 'idle'
export type SidebarSession =
  | { kind: 'router'; projectId: string; projectName: string; active: number; running: number; waiting: number; desks: string[] }
  | { kind: 'worker'; projectId: string; projectName: string; ticketId: string; ticketTitle: string; desk: string; status: SidebarStatus; branch: string }

/** Projects the existing ticket and session ownership records without opening sessions. */
export function sidebarView(host: HttpHost) {
  const totals = { open: 0, running: 0, waiting: 0, failed: 0 }
  const sessions: Record<string, SidebarSession> = Object.create(null) as Record<string, SidebarSession>
  const projects = (host.projects?.list() ?? []).map(project => ({ id: project.id, name: project.name,
    masterId: host.masterIdOf?.(project.id) ?? host.masterId, repositoryRoot: project.repositoryRoot,
    worktreeRoot: project.worktreeRoot || (project.revision ? host.projects?.worktreeRoot(project.id) ?? '' : ''),
    desks: project.desks, active: 0, running: 0, waiting: 0, archived: project.archived,
    routerWorkspace: host.routerWorkspace?.(project.id) ?? null }))
  const byId = new Map(projects.map(project => [project.id, project]))
  for (const ticket of host.store.tickets.list()) {
    const project = byId.get(host.projects?.scope(ticket) ?? '')
    if (!project) continue
    const step = ticketStage(ticket)
    const running = !ticket.ended && (host.executor.isRunning?.(ticket) ?? (step.stage === 'working' && step.action !== 'queued'))
    const failed = step.stage === 'person' && (step.action === 'failed' || step.action === 'blocked' || step.action === 'delivery')
    const waiting = step.stage === 'person'
    if (!ticket.ended) { totals.open++; project.active++ }
    if (waiting) { totals.waiting++; project.waiting++ }
    if (running) { totals.running++; project.running++ }
    if (failed) totals.failed++
    sessions[workerSessionId(ticket.id)] = { kind: 'worker', projectId: project.id, projectName: project.name,
      ticketId: ticket.id, ticketTitle: ticket.title, desk: ticket.desk || (typeof ticket.mandate.basis.scope?.desk === 'string' ? ticket.mandate.basis.scope.desk : ''),
      status: ticket.ended ? 'done' : failed ? 'failed' : waiting ? 'waiting' : running ? 'running' : step.stage === 'working' ? 'queued' : 'idle',
      branch: ticket.execution?.plan?.branch ?? '' }
  }
  for (const project of projects) if (!project.archived) sessions[project.masterId] = { kind: 'router', projectId: project.id, projectName: project.name,
    active: project.active, running: project.running, waiting: project.waiting, desks: project.desks }
  return { totals, projects, sessions }
}
export type SidebarView = ReturnType<typeof sidebarView>
