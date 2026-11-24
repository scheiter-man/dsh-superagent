import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentModel, modelSelectionProjectionDefinition, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { initializeRoleModel } from '../src/app/role-models.ts'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })
/** An Agent whose `model` is DSH's AgentModel over the Session's model-selection fold, with the host default as its live options. */
function fixture() {
  const ctx = new Context(); contexts.push(ctx)
  const resolve = vi.fn(async (value: ModelSelection) => value)
  const flush = vi.fn(async () => {})
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  ctx.reflect.provide('sessionPersistence', { flush })
  const session = Session.create(SessionId('role-model'))
  const { apply } = modelSelectionProjectionDefinition
  type State = { lastUsed: ModelSelection | null; pending: ModelSelection | null }
  const fold = apply as unknown as (state: State, event: unknown) => State
  const state = () => session.snapshotEvents().reduce(fold, { lastUsed: null, pending: null })
  const options = { provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') }
  const model = new AgentModel(state, session, options as never)
  const agent = { ctx, session, model } as unknown as Agent
  const record = (selection: ModelSelection) => { session.append('request/header', { header: { config: selection }, reason: 'initial' }) }
  return { ctx, agent, resolve, flush, record }
}
it('records the role model in the Session, which its steps use, without saving the host default', async () => {
  const { ctx, agent, flush, record } = fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker-provider', model: 'worker-model' })
  expect(agent.model.current()).toEqual({ provider: 'worker-provider', model: 'worker-model' })
  expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(1)
  expect(flush).toHaveBeenCalledOnce()
  // Once a step used it, later steps keep it.
  record({ provider: 'worker-provider', model: 'worker-model' })
  expect(agent.model.current()).toEqual({ provider: 'worker-provider', model: 'worker-model' })
})
it('keeps the reasoning effort the role names', async () => {
  const { ctx, agent } = fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'one', reasoningEffort: 'low' })
  expect(agent.model.current()).toEqual({ provider: 'worker', model: 'one', reasoningEffort: 'low' })
})
it('lets a later explicit selection win', async () => {
  const { ctx, agent } = fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'one' })
  const manual = { provider: 'manual', model: 'two', reasoningEffort: ReasoningEffortId('low') }
  agent.model.select(manual)
  expect(agent.model.current()).toEqual(manual)
})
it.each(['header', 'selection'])('preserves a resumed Session with existing %s', async kind => {
  const { ctx, agent, resolve } = fixture()
  const existing = { provider: 'existing', model: 'keep' }
  if (kind === 'header') agent.session.append('request/header', { header: { config: existing }, reason: 'initial' })
  else agent.session.append('model/selection', existing)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(resolve).not.toHaveBeenCalled()
  expect(agent.model.current()).toMatchObject(existing)
})
it('inherits the host when unset and fails unavailable routes before recording a selection', async () => {
  const { ctx, agent, resolve } = fixture()
  await initializeRoleModel(ctx, agent, null)
  expect(agent.model.current()).toMatchObject({ provider: 'host', model: 'default' })
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  await expect(initializeRoleModel(ctx, agent, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(false)
})
