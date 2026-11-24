/** A main Session someone archived in DSH's Web UI, which DSH refuses to run, is replaced by a new one on the next delivery. */
import { afterEach, expect, it } from 'vitest'
import { KV } from '../src/kv.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

it('creates a new main Session for a candidate once the main Session was archived, and records its id', async () => {
  h = await startRuntime()
  const previous = h.runtime.masterId
  h.archive(previous)
  h.deliveries.mockClear()
  const message = feishu('1', '@bot 修一下回归')
  h.runtime.receive(message)
  await h.runtime.idle()
  const current = h.runtime.masterId
  expect(current).not.toBe(previous)
  expect(h.runtime.store.get(KV.runtime.masterId)).toBe(current)
  expect(h.controller.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: current, agentPreset: 'dsh-superagent-router' }))
  // The new main Session hears why it replaced the old one, gets the candidate, and carries the main Session's tools.
  const notices = h.agents.get(current)!.inject.mock.calls.map(([notice]) => JSON.parse((notice.content[0] as { text: string }).text))
  expect(notices).toContainEqual(expect.objectContaining({ main_session_replaced: { previous, reason: 'archived' } }))
  expect(h.relays(current).map(item => item.trigger_id)).toEqual([message.id])
  expect(h.relays(previous)).toEqual([])
  expect(h.tools.get(current)!.has('orchestrator_route')).toBe(true)
  expect((await h.api('GET', 'state')).body.masterId).toBe(current)
})

it('replaces an archived main Session once for deliveries that arrive together, and keeps an unarchived one', async () => {
  h = await startRuntime()
  const previous = h.runtime.masterId
  h.runtime.receive(feishu('1', '@bot 看一下这个'))
  await h.runtime.idle()
  expect(h.runtime.masterId).toBe(previous)
  h.archive(previous)
  const created = h.controller.create.mock.calls.length
  h.runtime.sessions.relay('a', JSON.stringify({ kind: 'note', n: 1 }))
  h.runtime.sessions.notify('b', { n: 2 }, 'note')
  h.runtime.receive(feishu('2', '@bot 再看一个'))
  await h.runtime.idle()
  expect(h.controller.create.mock.calls.length - created).toBe(1)
  expect(h.runtime.masterId).not.toBe(previous)
})
