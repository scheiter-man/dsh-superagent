import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { z } from 'zod'
import { family, record, KV } from '../kv.ts'
import { key, type Ticket, type Trigger } from '../core/index.ts'
import type { Store } from './store.ts'

export const ProjectId = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/).refine(id => id !== 'all')
const absolute = z.string().refine(value => !value || isAbsolute(value))
const Desk = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
export const ProjectInput = z.object({ id: ProjectId, name: z.string().trim().min(1).max(100), repositoryRoot: absolute,
  worktreeRoot: absolute, prepareMode: z.enum(['git', 'shell']), prepare: z.string().max(12000),
  desks: z.array(Desk).min(1).max(30), archived: z.boolean().default(false) }).strict()
export type ProjectInput = z.infer<typeof ProjectInput>
export type Project = ProjectInput & { repositoryIdentity?: string; revision: number }
export const LEGACY_PROJECT = 'default'
const DESKS = ['dev', 'review', 'ops']
const projects = family<Project>('project-config:')
const selected = record<string>('project-default')
const legacy = record<string>('project-legacy')
export const projectMasterKey = (id: string) => id === LEGACY_PROJECT ? KV.runtime.masterId : family<string>('project-master:')(id)
/** A project configuration or routing error surfaced to the operator. */
export class ProjectError extends Error { constructor(message: string, readonly status = 400) { super(message) } }
const environment = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_NAMESPACE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(name)))
export function projectGit(directory: string, ...args: string[]): string {
  try { return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', env: environment(), timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  catch { throw new ProjectError('Cannot resolve the local Git repository or commit') }
}
function directory(path: string) {
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) throw new ProjectError('Choose an existing absolute directory')
  return realpathSync(path)
}
function plannedRoot(path: string): string {
  if (existsSync(path)) return directory(path)
  return join(plannedRoot(dirname(path)), basename(path))
}
export function repositoryIdentity(path: string): string {
  const cwd = directory(path)
  return realpathSync(resolve(cwd, projectGit(cwd, 'rev-parse', '--git-common-dir')))
}
/** Persists project bindings and resolves an immutable plan when a ticket is accepted. */
export class Projects {
  constructor(readonly store: Store, readonly stateDir: string) {}
  get legacyId(): string { return this.store.get(legacy) ?? LEGACY_PROJECT }
  get defaultId(): string { return this.store.get(selected) ?? this.legacyId }
  scope(record: Pick<Ticket | Trigger, 'projectId'> | undefined): string { return record?.projectId ?? this.legacyId }
  get(id: string): Project {
    const saved = this.store.get(projects(id))
    if (saved) return saved
    if (id !== this.legacyId) throw new ProjectError('Unknown project', 404)
    const { executor } = this.store.settings()
    return { id, name: 'Default', repositoryRoot: '', worktreeRoot: executor.directory, prepareMode: 'shell', prepare: executor.prepare, desks: DESKS, archived: false, revision: 0 }
  }
  list(): Project[] { return [this.get(this.legacyId), ...this.store.keys(projects.prefix).map(key => this.store.get(key) as Project).filter(project => project.id !== this.legacyId)] }
  save(input: ProjectInput, revision: number, makeDefault: boolean, adoptLegacy = false): Project {
    const value = ProjectInput.parse(input)
    if (adoptLegacy && (value.id === LEGACY_PROJECT || this.legacyId !== LEGACY_PROJECT || this.store.keys(projects.prefix).length || value.archived)) throw new ProjectError('Legacy adoption is only available before registering projects', 409)
    const current = this.list().find(project => project.id === value.id)
    if (revision !== (current?.revision ?? 0)) throw new ProjectError('Project settings changed; reload before saving', 409)
    if (value.archived && (makeDefault || value.id === this.defaultId || this.store.tickets.open().some(ticket => this.scope(ticket) === value.id))) {
      throw new ProjectError('Archive requires a different default project and no open tickets', 409)
    }
    if (value.worktreeRoot && existsSync(value.worktreeRoot)) value.worktreeRoot = directory(value.worktreeRoot)
    let identity: string | undefined
    if (value.repositoryRoot) {
      value.repositoryRoot = directory(projectGit(directory(value.repositoryRoot), 'rev-parse', '--show-toplevel'))
      identity = repositoryIdentity(value.repositoryRoot)
      if (this.list().some(project => project.id !== value.id && !project.archived && project.repositoryIdentity === identity)) throw new ProjectError('The Git repository is already registered', 409)
    } else if (value.prepareMode === 'git') throw new ProjectError('Git worktree mode requires a source repository')
    const project = { ...value, desks: [...new Set(value.desks)], ...(identity ? { repositoryIdentity: identity } : {}), revision: revision + 1 }
    this.store.atomic(() => {
      this.store.set(projects(value.id), project)
      if (adoptLegacy) {
        this.store.set(legacy, value.id)
        // Earlier local submissions without a project continue to resolve through the legacy project.
        for (const table of ['ticket', 'trigger']) this.store.db.prepare(`UPDATE ${table} SET value = json_set(value, '$.projectId', ?) WHERE value ->> '$.projectId' = ?`).run(value.id, LEGACY_PROJECT)
      }
      if (makeDefault || adoptLegacy) this.store.set(selected, value.id)
    })
    return project
  }
  select(id?: string, cwd?: string): Project {
    if (id) {
      const project = this.get(id)
      if (project.archived) throw new ProjectError('Project is archived')
      return project
    }
    if (!cwd) return this.get(this.defaultId)
    let identity: string | undefined
    try { identity = repositoryIdentity(cwd) } catch { /* explicit selection is required for unregistered directories */ }
    const options = this.list().filter(project => !project.archived)
    const matches = options.filter(project => identity && project.repositoryIdentity === identity)
    if (matches.length === 1) return matches[0]!
    throw new ProjectError(`Choose --project ${options.map(project => project.id).join('|')}`)
  }
  worktreeRoot(id: string): string { return this.get(id).worktreeRoot || join(this.stateDir, 'worktrees', id) }
  plan(id: string, ticketId: string, name: string): NonNullable<Ticket['execution']>['plan'] {
    const project = this.get(id)
    if (project.archived) throw new ProjectError('Project is archived')
    if (!project.revision) return undefined
    return { projectId: id, root: plannedRoot(this.worktreeRoot(id)), mode: project.prepareMode,
      prepare: project.prepare, repository: project.repositoryRoot, identity: project.repositoryIdentity ?? '',
      ...(project.prepareMode === 'git' ? { baseline: projectGit(project.repositoryRoot, 'rev-parse', '--verify', 'HEAD^{commit}'), branch: `task/${name}-${key(ticketId)}` } : {}) }
  }
}
