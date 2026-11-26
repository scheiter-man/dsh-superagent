import { stat } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { LEGACY_PROJECT, projectMasterKey, type Projects } from './projects.ts'
/** Lifecycle, prompt/tool/skill decoration, message delivery, and budget retry tracking for orchestrator and worker DSH sessions. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { dirname } from 'node:path'
import { z } from 'zod'
import { key, liveTicket, type Ticket } from '../core/index.ts'
import { mandateInstructions, ticketOfSession } from '../executor/dsh.ts'
import type { HealthEntry } from '../infra/health.ts'
import { AgentDelivery, messageId } from './delivery.ts'
import { Later, type Effects } from './effects.ts'
import type { Variable } from './execution-environment.ts'
import { RetryHealth } from './retry-health.ts'
import { initializeRoleModel } from './role-models.ts'
import { bundledSkills } from './skill-files.ts'
import { SKILL_PREFIX, type PromptVersion, type Prompts } from './prompts.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'
import type { RegisterTool, Tool } from './tools/tool.ts'

/** Host dependencies used by `Sessions`. */
export interface SessionsHost {
  /** DSH Cordis context: sessions, agents, persistence, and their events. */
  readonly context: Context
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'keys'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  /** The `models` health entry, which reports managed sessions waiting on a model-budget retry. */
  readonly health: HealthEntry
  /** The main Session's id at startup; a replacement of an archived one is recorded under `KV.runtime.masterId`. */
  readonly projects?: Projects
  promptsOf?(projectId: string): SessionsHost['prompts']
  readonly masterId: string
  /** The workspace directory a main Session is created in. */
  readonly masterCwd: string
  readonly lifetime: AbortSignal
  paused(): boolean
  startupHeld(): boolean
  closing(): boolean
  /** Execution environment variables for `ticket`, rendered into its worker's system prompt. */
  environment(ticket: Ticket): Variable[]
  /** Tools to register on the main Session (`ticket === undefined`) or on `ticket`'s worker Session. */
  tools(agent: Agent, ticket?: Ticket): Tool[]
}

/**
 * What Sessions registered for an agent it decorated: the releases of its prompt section, tools and skill scope, the scope
 * its skills are registered in, and the skills of one prompt revision; for a worker's subagent, only its tool limits.
 */
interface SessionBinding { disposers: (() => void)[]; scope?: Context; skills?: { revision: number; dispose: () => void }; subagent?: true }

/** The agent presets Executor Sessions and the main Session are created with, which the bundle's patch defines. */
export const WORKER_PRESET = 'dsh-superagent-worker', ROUTER_PRESET = 'dsh-superagent-router'
/** The main Session's title in DSH's session list. */
const MASTER_TITLE = 'dsh-superagent orchestrator'
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** DSH's agent preset registry selected `agentPreset` for a Session. */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void
  }
}
/**
 * The DSH tools an Executor Session works with: files, search, the shell and its jobs, the web, skills, its todo list and
 * subagents. It gets no other tool the profile has, whenever it was registered: none that asks or shows a person something,
 * changes the profile, schedules work or starts goals outside the worker slots, the pause and a person's hold, starts or
 * messages other Sessions, or edits documents.
 */
const WORK_TOOLS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill', 'web_search',
  'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent']
const ROUTER_TOOLS = ['skill', 'bash', 'pwsh', 'read', 'read_image', 'job_output', 'job_list', 'job_kill']
/** What the main Session is told when it would wait: what it waits for comes to it, and a waiting step holds back the next. */
const NO_WAIT = 'Reports, follow_up notices, new candidates and a background job\'s end with its output arrive by themselves as messages; '
  + 'end the turn instead of waiting for them.'
/** What a main Session under `standard` is told when its command would wait the shell's default. */
const DEFAULT_WAIT = 'This shell waits up to 60 seconds by default: pass timeoutMs of at most 30000, or run_in_background, '
  + 'as a waiting step holds back new candidates.'
/** `sleep` at a command position: the start, after ; & | ( { ! ` or a newline, or after a keyword or a command that runs it. */
const SLEEP = /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*\/)?sleep\b/
function noWait({ name, arguments: input }: { name: string; arguments: unknown }, routed: () => boolean): string | undefined {
  const args = (input ?? {}) as { command?: unknown; timeoutMs?: unknown; run_in_background?: unknown; wait?: unknown; timeout_ms?: unknown }
  if (name === 'bash' || name === 'pwsh') {
    const sleeps = typeof args.command === 'string' && SLEEP.test(args.command)
    if (sleeps || typeof args.timeoutMs === 'number' && args.timeoutMs > 30_000) return NO_WAIT
    if (args.timeoutMs === undefined && args.run_in_background !== true && !routed()) return DEFAULT_WAIT
  }
  if (name === 'job_output' && args.wait === true && (typeof args.timeout_ms === 'number' ? args.timeout_ms > 5_000 : !routed())) return NO_WAIT
  return undefined
}
/**
 * Creates and decorates orchestrator and worker DSH `Agent` sessions with role models, system prompt sections from `Prompts`, runtime skills, and restricted tool sets.
 * `Runtime`, `DshExecutor`, `MasterAssessor`, `Settings`, and management routes/tools use it to ensure sessions, deliver deduplicated messages via `AgentDelivery`, and process ordered `relay` and `notice` effects.
 * Feeds session events into `RetryHealth` to report model budget waits on the `models` `HealthEntry`, and durably records which prompt revisions each session has worked under in `Store` (`KV.sessions.prompts`) to authorize prompt version reads.
 */
export class Sessions {
  private readonly agentDelivery: AgentDelivery
  /** Decorated agents mapped to their registered disposers and skill scope until the agent is disposed or `Sessions.dispose()` runs. */
  private readonly bindings = new Map<Agent, SessionBinding>()
  private readonly retryHealth = new RetryHealth()
  private readonly ctx: Context
  /** The current main Session's id. */
  private current: string
  /** A replacement of the archived main Session in progress, which concurrent deliveries wait for. */
  private readonly replacing = new Map<string, Promise<void>>()
  private readonly replacingIds = new Map<string, string>()
  /** Registers ordered `relay` and `notice` effect handlers that deliver to the main Session. */
  constructor(private readonly host: SessionsHost) {
    this.ctx = host.context
    this.current = host.masterId
    this.agentDelivery = new AgentDelivery(host.context)
    // Deliver relays and notices to the main Session in the order they were queued.
    host.effects.handle('relay', ({ text, projectId }, requestId) => this.promptMaster(requestId, text, 'steer', projectId), { ordered: true, limit: () => host.paused() ? 0 : 1 })
    host.effects.handle('notice', ({ value, summary, projectId }, name) => this.inject(name, value, summary, projectId), { ordered: true, limit: () => host.startupHeld() ? 0 : 1 })
  }
  /** Subscribes to host agent and session events so newly created sessions are decorated and model-budget retries are reflected in health. Call once at startup. */
  install(): void {
    const ctx = this.ctx
    ctx.on('agent/disposed', ({ agent }) => {
      if (!this.bindings.has(agent)) return
      this.release(agent)
      this.retryHealth.clear(agent.id); this.updateModelHealth()
    })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      const binding = agent && agent.session === session ? this.bindings.get(agent) : undefined
      if (!agent || !binding || binding.subagent) return
      this.retryHealth.observe(agent.id, event)
      this.updateModelHealth()
    })
    ctx.on('agent/created', async ({ agent }) => { await this.decorate(agent); return undefined })
    // Opening a Session in DSH's Web UI before its first turn may select the default preset for it: select ours again. After
    // its first turn DSH refuses any selection, which leaves it as it is.
    ctx.inject(['agentPresets'], child => {
      child.on('agent-preset/selected', (sessionId, preset) => {
        const ticketId = ticketOfSession(sessionId), agent = ctx.agents.get(sessionId as SessionId)
        const ours = this.routerProject(sessionId) ? ROUTER_PRESET : ticketId && this.host.store.tickets.get(ticketId) ? WORKER_PRESET : undefined
        if (!ours || preset === ours || !agent) return
        const presets = child.get('agentPresets') as { select(agent: Agent, preset: string): Promise<string> }
        presets.select(agent, ours).catch(() => {})
      })
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && this.bindings.has(agent) && !this.host.closing()) { this.retryHealth.clear(agent.id); this.updateModelHealth() }
    })
  }
  /** Resolves or creates session `id` in workspace `cwd`, initializes its role model, decorates it with prompts/skills/tools, applies the configured worker permission preset, and renames it to `title`. */
  async ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker'): Promise<Agent> {
    const ctx = this.ctx
    let result = await ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in result && result.error.code === 'session/not-found') {
      const workspace = await ctx.workspaceRegistry.create(cwd)
      // A Session keeps the preset it was created with, one of the bundle's own (cordis.patch.yml).
      await ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id,
        agentPreset: role === 'worker' ? WORKER_PRESET : ROUTER_PRESET })
      result = await ctx.sessionController.resolveAgent(id as SessionId)
    }
    if ('error' in result) throw result.error
    const attachedCwd = result.agent.session.header?.cwd
    if (role === 'worker' && typeof attachedCwd === 'string' && await realpath(attachedCwd) !== await realpath(cwd)) {
      throw new Error('The worker Session belongs to a different workspace')
    }
    const settings = this.host.store.settings()
    await initializeRoleModel(ctx, result.agent, role === 'orchestrator' ? settings.eval.model : settings.executor.model)
    await this.decorate(result.agent)
    this.applyRolePermission(result.agent, role)
    await ctx.sessionController.rename({ sessionId: id as SessionId, title })
    return result.agent
  }
  /** Returns whether `sessionId` already holds the message delivered under `requestId`, or `false` if the session does not exist. */
  async holds(sessionId: string, requestId: string): Promise<boolean> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    return !('error' in result) && await this.agentDelivery.holds(result.agent, key(requestId))
  }
  private get legacyId() { return this.host.projects?.legacyId ?? LEGACY_PROJECT }
  get masterId(): string { return this.current }
  masterIdOf(projectId = this.legacyId): string {
    return this.replacingIds.get(projectId) ?? (projectId === this.legacyId ? this.current
      : this.host.store.get(projectMasterKey(projectId)) ?? `orchestrator-${key(this.host.masterCwd, projectId)}`)
  }
  masterIds(): string[] { return (this.host.projects?.list().map(project => project.id) ?? [this.legacyId]).map(id => this.masterIdOf(id)) }
  routerProject(sessionId: string): string | undefined {
    return (this.host.projects?.list().map(project => project.id) ?? [this.legacyId]).find(id => this.masterIdOf(id) === sessionId)
  }
  private projectOf(sessionId: string) {
    const ticketId = ticketOfSession(sessionId)
    return this.routerProject(sessionId) ?? this.host.projects?.scope(ticketId ? this.host.store.tickets.get(ticketId) : undefined) ?? this.legacyId
  }
  private promptsOf(sessionId: string) { return this.host.promptsOf?.(this.projectOf(sessionId)) ?? this.host.prompts }
  private masterTitle(projectId: string): string {
    const project = this.host.projects?.get(projectId)
    return project?.revision ? `Superagent · ${project.name}` : MASTER_TITLE
  }
  private readonly anchorChecks = new Map<string, Promise<Agent>>()
  private readonly anchors = new Map<string, { cwd: string; preserved: boolean }>()
  routerWorkspace(projectId: string) { return this.anchors.get(projectId) }
  async masterCwdOf(projectId: string): Promise<string> {
    const root = this.host.projects?.get(projectId).repositoryRoot
    if (!root) return this.host.masterCwd
    try { return (await stat(root)).isDirectory() ? await realpath(root) : this.host.masterCwd }
    catch { return this.host.masterCwd }
  }
  ensureMaster(projectId = this.legacyId): Promise<Agent> {
    const existing = this.anchorChecks.get(projectId)
    if (existing) return existing
    const opening = this.openMaster(projectId).finally(() => { this.anchorChecks.delete(projectId) })
    this.anchorChecks.set(projectId, opening)
    return opening
  }
  private async openMaster(projectId: string): Promise<Agent> {
    await this.replaceArchivedMaster(projectId)
    const id = this.masterIdOf(projectId) as SessionId
    const desired = await this.masterCwdOf(projectId)
    if (desired !== this.host.masterCwd && await this.canAnchor(id)) {
      return this.replaceMaster(projectId, id, 'workspace')
    }
    const agent = await this.ensure(id, desired, this.masterTitle(projectId), 'orchestrator')
    const cwd = agent.session.header?.cwd ?? desired
    this.anchors.set(projectId, { cwd, preserved: cwd !== desired })
    return agent
  }
  private async canAnchor(id: SessionId): Promise<boolean> {
    const { agents, sessionPersistence: persistence, sessionController } = this.ctx
    if (typeof persistence.stat !== 'function' || typeof sessionController.projections !== 'function') return false
    const loaded = agents.get(id)
    if (loaded?.status === 'running') return false
    try {
      const snapshot = await persistence.stat(id, { signal: this.host.lifetime })
      const fallback = await realpath(this.host.masterCwd)
      if (!snapshot?.header.cwd || await realpath(snapshot.header.cwd) !== fallback) return false
      const hasMessages = (events: readonly { type: string }[]) => events.some(event => event.type === 'user/message' || event.type === 'assistant/message')
      if (loaded && hasMessages(loaded.session.snapshotEvents())) return false
      const projection = await sessionController.projections({ sessionId: id }, this.host.lifetime)
      const inbox = projection?.values.inbox
      if (!projection || (inbox && (inbox['next-turn'].length || inbox['next-step'].length))) return false
      await using handle = await persistence.open(id, 'read', { signal: this.host.lifetime })
      for (let from = 0;;) {
        const { events } = await handle.read(from, 128)
        if (hasMessages(events)) return false
        if (events.length < 128) break
        from += events.length
      }
      // Refuse to move a Session whose log or in-memory ownership changed during inspection.
      const current = await persistence.stat(id, { signal: this.host.lifetime })
      const active = agents.get(id)
      return current?.revision === snapshot.revision && active === loaded && active?.status !== 'running'
        && (!active || !hasMessages(active.session.snapshotEvents()))
    } catch { return false }
  }
  private async replaceArchivedMaster(projectId: string): Promise<void> {
    const existing = this.replacing.get(projectId)
    if (existing) return existing
    const previous = this.masterIdOf(projectId)
    if (!this.archived(previous)) return
    const replacement = this.replaceMaster(projectId, previous, 'archived').then(() => {}).finally(() => { this.replacing.delete(projectId) })
    this.replacing.set(projectId, replacement)
    await replacement
  }
  private archived(sessionId: string): boolean {
    try { return this.ctx.workspaceRegistry.archivedSessionIds?.includes(sessionId as SessionId) ?? false } catch { return false }
  }
  private async replaceMaster(projectId: string, previous: string, reason: 'archived' | 'workspace'): Promise<Agent> {
    const at = new Date().toISOString(), next = `orchestrator-${key(previous, at)}`
    this.replacingIds.set(projectId, next)
    let agent: Agent
    try {
      agent = await this.ensure(next, await this.masterCwdOf(projectId), this.masterTitle(projectId), 'orchestrator')
      this.anchors.set(projectId, { cwd: agent.session.header?.cwd ?? await this.masterCwdOf(projectId), preserved: false })
      if (reason === 'workspace' && !await this.canAnchor(previous as SessionId)) {
        this.release(agent)
        this.replacingIds.delete(projectId)
        const original = await this.ensure(previous, this.host.masterCwd, this.masterTitle(projectId), 'orchestrator')
        this.anchors.set(projectId, { cwd: original.session.header?.cwd ?? this.host.masterCwd, preserved: true })
        return original
      }
      if (projectId === this.legacyId) this.current = next
      this.host.store.set(projectId === this.legacyId ? KV.runtime.masterId : projectMasterKey(projectId), next)
    } finally { this.replacingIds.delete(projectId) }
    const old = this.ctx.agents.get(previous as SessionId)
    if (old) this.release(old)
    if (reason === 'archived') {
      this.ctx.logger.warn('dsh-superagent: the main Session %s was archived; %s replaces it', previous, next)
      const text = JSON.stringify({ main_session_replaced: { previous, reason }, at })
      await this.agentDelivery.send(agent, `replaced:${previous}`, text, { inject: 'Main Session replaced' }, this.host.lifetime)
    }
    return agent
  }
  /** Delivers a message to the main Session once per request id, replacing an archived main Session first. */
  async promptMaster(requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, projectId = this.legacyId): Promise<void> {
    if (projectId !== this.legacyId) await this.ensureMaster(projectId)
    else await this.replaceArchivedMaster(projectId)
    const target = this.masterIdOf(projectId)
    const record = KV.runtime.masterDelivery(projectId === this.legacyId ? key(requestId) : key(projectId, requestId))
    const { store } = this.host
    const delivery = store.get(record)
    if (delivery?.delivered) return
    // Check the previous inbox and history before retrying a delivery whose receipt did not commit before archival.
    if (delivery && delivery.sessionId !== target && await this.holds(delivery.sessionId, requestId)) {
      store.set(record, { ...delivery, delivered: true })
      return
    }
    store.set(record, { sessionId: target, delivered: false })
    await this.prompt(target, requestId, text, mode)
    store.set(record, { sessionId: target, delivered: true })
  }
  /** Deliver a message once per request id: to the next turn, the current one, or `inject`ed with its label without waking the agent. */
  async prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw result.error
    await this.agentDelivery.send(result.agent, key(requestId), text, mode, this.host.lifetime, authorize, accepted)
  }
  /** The id of the message `prompt` delivers under `requestId`, which DSH's inbox events name it by. */
  promptedId(requestId: string): MessageId { return messageId(key(requestId)) }
  /** Enqueues a steering relay to the main Session; relays are durable and retried by `Effects` until delivered, at most once per `requestId`. */
  relay(requestId: string, text: string, projectId?: string): void { this.host.effects.enqueue('relay', requestId, { text, ...(projectId ? { projectId } : {}) }) }
  /** Enqueues a durable background notice for injection into the main Session; a new notice with the same `name` replaces a still-waiting notice of that `name`. */
  notify(name: string, value: Record<string, unknown>, summary: string, projectId?: string): void {
    this.host.effects.enqueue('notice', this.noticeKey(name, projectId), { value, summary, ...(projectId ? { projectId } : {}) })
  }
  private noticeKey(name: string, projectId?: string) { return projectId && projectId !== this.legacyId ? `${projectId}:${name}` : name }
  /** Waits for currently runnable `notice` effects to settle and returns `'injected'` if notice `name` has reached the main Session or `'pending'` if it is still queued. */
  async delivery(name: string, projectId?: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', this.noticeKey(name, projectId)) ? 'pending' : 'injected'
  }
  /** Injects a notice into the main Session without waking it, replacing an archived main Session first; no-op if the main Session does not exist yet. */
  private async inject(name: string, value: Record<string, unknown>, summary: string, projectId = this.legacyId): Promise<void> {
    const target = this.masterIdOf(projectId)
    if (this.host.paused() && (!this.ctx.agents.get(target as SessionId) || this.archived(target))) {
      throw new Later('The paused router has not been activated')
    }
    await this.replaceArchivedMaster(projectId)
    if (projectId !== this.legacyId) await this.ensureMaster(projectId)
    const resolved = await this.ctx.sessionController.resolveAgent(this.masterIdOf(projectId) as SessionId)
    if ('error' in resolved) return
    // Deduplicate by notice name and payload hash so retries are idempotent while updated payloads still deliver.
    const text = JSON.stringify(value)
    await this.agentDelivery.send(resolved.agent, `notice:${name}:${key(text)}`, text, { inject: summary }, this.host.lifetime)
  }
  /** Returns the current prompt revision, the active prompt revision of each loaded Session, and whether the main Session still has a pending `'prompts'` notice. */
  status(projectId = this.legacyId) {
    const { store, effects } = this.host
    const prompts = this.host.promptsOf?.(projectId) ?? this.host.prompts
    const sessions = store.keys(KV.sessions.prompts).flatMap(name => {
      const sessionId = name.slice(KV.sessions.prompts.prefix.length), revision = store.get(name)?.at(-1)
      return this.projectOf(sessionId) === projectId && this.ctx.agents.get(sessionId as SessionId) && revision !== undefined ? [{ sessionId, revision }] : []
    })
    return { revision: prompts.current().revision, sessions, notificationPending: effects.pending('notice', this.noticeKey('prompts', projectId)) }
  }
  /** Returns the prompt version a Session runs under (the one bound on its latest model request, or the current version). */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    const prompts = this.promptsOf(sessionId)
    return revision === undefined ? prompts.current() : prompts.version(revision)
  }
  /** Whether a Session is authorized to read `revision` (its active revision or any revision it previously ran under). */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
  }
  /** Returns a tool registrar for `agent` that renders tool output as JSON text and attaches `output.image` as an image when present. */
  private registerTool(agent: Agent, binding: SessionBinding): RegisterTool {
    return (name, description, schema, execute) => {
      binding.disposers.push(agent.ctx.tools.register({ name, description, parameters: z.toJSONSchema(schema),
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
          const text = { type: 'text' as const, text: JSON.stringify(value) }
          const image = value && typeof value === 'object' && 'image' in value ? (value as { image: never }).image : undefined
          return image ? [text, { type: 'image' as const, attachment: image }] : [text]
        } },
        execute: (args, execution) => execute(schema.parse(args), execution.signal) }))
    }
  }
  /** Returns `sessionId`'s active model-budget retry state (`{ model_retry }`) for status listings, or `{}` when not waiting on one. */
  modelRetry(sessionId: string | undefined) {
    const retry = sessionId ? this.retryHealth.get(sessionId) : undefined
    return retry ? { model_retry: retry } : {}
  }
  private updateModelHealth(): void {
    const retries = this.retryHealth.list()
    this.host.health.set(retries.length
      ? { state: 'error', detail: retries.slice(0, 5).map(item => `${item.sessionId}: ${item.provider} is over its model budget; retried ${item.attempts} times, waiting since ${item.since}; the model and retry policy are unchanged`).join('; ') + (retries.length > 5 ? `; ${retries.length - 5} more Sessions` : ''), at: retries.at(-1)!.lastAt }
      : { state: 'ready', detail: 'No managed Session is waiting on a model budget retry' })
  }
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  private applyRolePermission(agent: Agent, role: 'orchestrator' | 'worker'): void {
    const preset = role === 'orchestrator' ? 'danger-full-access' : this.host.store.settings().executor.permissionPreset
    const permissions = this.ctx.permissionPresets
    if (permissions.current?.(agent.session) !== preset) permissions.set(agent.session, preset)
  }
  private routed(agent: Agent): boolean {
    try {
      const presets = this.ctx.get('agentPresets') as { presetForSession?: (session: Agent['session']) => string | null } | undefined
      const projections = this.ctx.get('sessionProjections') as { stateOf?: (session: Agent['session'], key: string) => unknown } | undefined
      const selected = typeof presets?.presetForSession === 'function' ? presets.presetForSession(agent.session)
        : projections?.stateOf?.(agent.session, 'agentPreset')
      return (selected ?? agent.session.header.agentPreset) === ROUTER_PRESET
    } catch { return false }
  }
  private async decorate(agent: Agent): Promise<void> {
    if (this.host.closing() || this.bindings.has(agent)) return
    const host = this.host
    const master = this.routerProject(agent.id) !== undefined
    const ticket = master ? undefined : this.ticketOf(agent)
    if (!master && !ticket) { this.limitSubagent(agent); return }
    const binding: SessionBinding = { disposers: [] }
    this.applyRolePermission(agent, master ? 'orchestrator' : 'worker')
    this.bindings.set(agent, binding)
    const tools = host.tools(agent, ticket)
    if (master) {
      const parent = scopeParentOf(agent)
      const allow = ROUTER_TOOLS.filter(name => agent.ctx.tools.get(name, parent))
      const allowed = new Set([...allow, ...tools.map(tool => tool.name)])
      binding.disposers.push(
        agent.ctx.tools.restrict({ allow }),
        agent.ctx.tools.guard(execution => allowed.has(execution.name)
          ? noWait(execution, () => this.routed(agent))
          : 'The router only has read, shell/job inspection, skill and Superagent routing tools'),
      )
    } else {
      binding.disposers.push(...this.workOnly(agent, ticket!.id))
    }
    this.retryHealth.restore(agent.id, agent.session.snapshotEvents())
    if (agent.status === 'idle') this.retryHealth.clear(agent.id)
    this.updateModelHealth()
    // Disable variable interpolation so literal ${{ ... }} expressions in team prompts are preserved.
    binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-policy', order: 9999, interpolate: false, text: context => {
      const version = this.promptFor(agent, context.signal !== undefined)
      const current = ticket && host.store.tickets.get(ticket.id)
      const composed = host.prompts.compose(version.config, master ? 'orchestrator' : 'worker', current ? host.environment(current) : undefined)
      return `[dsh-superagent prompt revision ${version.revision}]\n${composed}\n${current ? mandateInstructions(current.mandate) : ''}`
    }, ...(master ? { complete: true } : {}) }))
    // A recreated skill scope (e.g. after the skills service restarts) starts empty, so reset `binding.skills` before rebinding.
    const skillScope = agent.ctx.inject(['skills'], scope => {
      binding.scope = scope
      binding.skills = undefined
      this.bindSkills(binding, this.promptsOf(agent.id).current())
    })
    binding.disposers.push(() => { skillScope.dispose().catch((error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release a skill scope: %s', String(error)) }) })
    await skillScope
    // Bail out if the agent was disposed while awaiting the skill scope.
    if (this.bindings.get(agent) !== binding) return
    const register = this.registerTool(agent, binding)
    for (const tool of tools) register(tool.name, tool.description, tool.schema, tool.execute)
  }
  /**
   * An Executor Session's tools: only the profile's work tools, which DSH requires to be known, and none once its ticket
   * ended. A failed or blocked worker keeps its tools, so a person may continue it in its Session; only automated input waits
   * (see the executor). Read inherited tools through the parent scope, which includes the preset's tools. The global view
   * misses preset tools; the agent's own view also includes local tools such as subagent, which restrict refuses to name.
   */
  private workOnly(agent: Agent, ticketId: string): (() => void)[] {
    const store = this.host.store
    const parent = scopeParentOf(agent)
    const allow = WORK_TOOLS.filter(name => agent.ctx.tools.get(name, parent))
    return [agent.ctx.tools.restrict({ allow }), agent.ctx.tools.guard(() => {
      const current = store.tickets.get(ticketId)
      return !current || !liveTicket(current) ? 'Ticket ended; new work needs a new authorized ticket' : undefined
    })]
  }
  /**
   * A subagent of an Executor Session, or of one of its subagents, which runs under DSH's `standard` preset with the worker's
   * permissions, gets the same work tools as the worker, and none once the worker's ticket ended. Any other agent is left as
   * it is.
   */
  private limitSubagent(agent: Agent): void {
    let parent = agent.session.header.parentSession
    // Up the subagents' parents to the worker, which are loaded while their subagents run.
    for (let depth = 0; parent !== undefined && ticketOfSession(parent) === undefined && depth < 8; depth++) {
      parent = this.ctx.agents.get(parent)?.session.header.parentSession
    }
    const ticketId = parent === undefined ? undefined : ticketOfSession(parent)
    if (ticketId === undefined || !this.host.store.tickets.get(ticketId)) return
    this.bindings.set(agent, { disposers: this.workOnly(agent, ticketId), subagent: true })
  }
  /** Register the skills of a prompt version in the agent's skill scope, in place of an earlier version's. */
  private bindSkills(binding: SessionBinding, version: PromptVersion): void {
    const { scope, skills: previous } = binding
    if (!scope || previous?.revision === version.revision) return
    previous?.dispose()
    const disposers: (() => void)[] = []
    for (const [name, content] of this.host.prompts.skills(version.config)) {
      const bundled = name === 'feishu' || name === 'github' ? bundledSkills[name] : undefined
      const body = version.config.skills[name] ?? ''
      const description = bundled?.description ?? (body.replace(/\s+/g, ' ').slice(0, 120) || 'Custom dsh-superagent operational skill.')
      disposers.push(scope.skills.register({ name: `${SKILL_PREFIX}${name}`, description, content, source: 'runtime',
        ...(bundled ? { resourceBase: { kind: 'directory' as const, path: dirname(bundled.path) } } : {}) }))
    }
    binding.skills = { revision: version.revision, dispose: () => { disposers.forEach(dispose => dispose()) } }
  }
  /** Return the current prompt version, updating the agent's skills and recording the revision in Store when bound to a model request. */
  private promptFor(agent: Agent, bind: boolean): PromptVersion {
    const version = this.promptsOf(agent.id).current()
    if (!bind) return version
    const binding = this.bindings.get(agent)
    if (binding) this.bindSkills(binding, version)
    const { store } = this.host
    const revisions = store.get(KV.sessions.prompts(agent.id)) ?? []
    const bound = [...revisions.filter(revision => revision !== version.revision), version.revision]
    if (revisions.at(-1) !== version.revision) store.set(KV.sessions.prompts(agent.id), bound)
    return version
  }
  /** Releases registrations for `agent` in reverse order (LIFO); disposing its skill scope releases its skills as well. */
  private release(agent: Agent): void {
    const binding = this.bindings.get(agent)
    if (!binding) return
    this.bindings.delete(agent)
    binding.skills?.dispose()
    for (const dispose of binding.disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { this.ctx.logger.warn('dsh-superagent could not release what it registered for a Session: %s', String(error)) }
    }
  }
  /** Releases prompt sections, skills, and tools registered by `Sessions` across all decorated agents. */
  dispose(): void { for (const agent of [...this.bindings.keys()]) this.release(agent) }
}
