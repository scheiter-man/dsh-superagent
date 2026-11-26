// @vitest-environment jsdom
import { act, useState, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError, caller, usePoll } from '../src/client/api.ts'
import { apply } from '../src/client/index.tsx'
import { zh } from '../src/client/locales.ts'
import { SettingsSchema } from '../src/policy.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Entry = { options: { name: string; id?: string; key?: string; order?: number; locale?: string; label?: () => string }; component: ComponentType<Record<string, unknown>> }
const t = ((key: keyof typeof zh) => zh[key] ?? key) as never
function fixture(listed: string[], native = false) {
  const entries: Entry[] = []
  const dispose: (() => void)[] = []
  const menus: unknown[] = []
  const selectPanel = vi.fn()
  const dictionaries: Record<string, unknown> = {}
  const ctx = {
    slots: { inject: (_name: string, register: () => void) => register(), register: (options: Entry['options'], component: Entry['component']) => { entries.push({ options, component }); return () => {} } },
    locale: { register: (ns: string, value: unknown) => { dictionaries[ns] = value; return () => {} }, bind: () => t },
    effect: (effect: () => unknown) => { const cleanup = effect(); if (typeof cleanup === 'function') dispose.push(cleanup as () => void) },
    inject: (names: string[], register: (ctx: unknown) => void) => { if (native) register(ctx); return names },
    contextMenus: { register: (entry: unknown) => { menus.push(entry); return () => {} } },
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: Object.fromEntries(listed.map(id => [id, {}])) }) }, refresh: vi.fn(async () => {}) },
    uiWorkspace: { openSession: vi.fn() },
    // Omit config form service so Deployment renders read-only.
    get: (key: string) => native && key === 'layout' ? { selectPanel } : undefined,
  }
  apply(ctx as never)
  const entry = (name: string) => entries.find(item => item.options.name === name)!
  return { ctx, entries, dictionaries, menus, selectPanel, dispose: () => dispose.forEach(fn => fn()), main: entry('main'), nav: entry('sidebar.panellist') }
}
async function render(entry: Entry, props: Record<string, unknown>) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<entry.component {...props} />) })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return { container, dispose: () => { act(() => { root.unmount() }); container.remove() } }
}
const openMaster = async (container: HTMLElement) => {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === zh.openMaster)!
  await act(async () => { button.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const fixtureProjects = [{ id: 'alpha', name: 'Alpha', masterId: 'router-alpha', repositoryRoot: 'C:\\Dev\\Alpha', worktreeRoot: 'C:\\Work',
  desks: ['review'], active: 2, running: 1, waiting: 1, archived: false, revision: 1, prepareMode: 'git', prepare: '' }]
const serve = (native = false) => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
  if (native && path === '/api/dsh-superagent/sidebar') return Response.json({ projects: fixtureProjects, totals: { open: 2, running: 1, waiting: 1, failed: 0 }, sessions: {
    'router-alpha': { kind: 'router', projectId: 'alpha', projectName: 'Alpha', active: 2, running: 1, waiting: 1, desks: ['review'] },
    'worker-fixture': { kind: 'worker', projectId: 'alpha', projectName: 'Alpha', ticketId: 'fixture', ticketTitle: 'Fix sample', desk: 'review', status: 'running', branch: 'task/review' },
  } })
  if (native && path === 'projects') return Response.json({ defaultId: 'alpha', items: fixtureProjects, workspaces: [] })
  if (native && path === 'projects/alpha/router') return Response.json({ masterId: 'router-alpha' })
  if (path === 'overview') return Response.json({ problems: [], person: [], executor: { running: 0, queued: 0, maxWorkers: 3, idle: 0 }, flow: { triggers: 0, filtered: 0, judged: 0, accepted: 0, evaluating: 0 }, policyVersion: 'v' })
  if (path === 'state') return Response.json({ masterId: 'master', settings: SettingsSchema.parse({}), revisions: { policy: 0, eval: 0, executor: 0 }, sources: [], policy_version: 'v', health: {}, outgoing: [], load: { running: 0, queued: 0 },
    setup: { machine: { stateDir: '/srv/state', worktreeRoot: '/srv/state/worktrees', blockedCommands: [], promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 }, problem: null, feishuProblem: null, accounts: null } })
  return Response.json({ error: 'unavailable' }, { status: 503 })
}))
afterEach(() => { vi.unstubAllGlobals() })

it('registers a localized main panel, sidebar entry and Plugin Manager row page, and no settings section', () => {
  const { entries, dictionaries, main, nav, dispose } = fixture([])
  expect(entries.map(entry => entry.options.name)).toEqual(['sidebar.session.row.leading', 'sidebar.session.row.trailing', 'sidebar.session.row.hover', 'main', 'sidebar.panellist', 'plugins.row.config'])
  expect(entries.find(item => item.options.name === 'plugins.row.config')!.options).toMatchObject({ key: 'dsh-superagent#dsh-superagent', locale: 'dshSuperagent' })
  expect(Object.keys(dictionaries)).toEqual(['dshSuperagent'])
  expect(main.options).toMatchObject({ key: 'dsh-superagent', locale: 'dshSuperagent' })
  expect(nav.options).toMatchObject({ id: 'dsh-superagent', order: 10, locale: 'dshSuperagent' })
  expect(nav.options.label?.()).toBe('Superagent')
  dispose()
})

it('opens a listed Session through the workspace from the main panel', async () => {
  serve()
  const { ctx, main, dispose } = fixture(['master'])
  const view = await render(main, { t })
  await openMaster(view.container)
  expect(ctx.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith('master')
  view.dispose(); dispose()
})

it('reports a Session missing from the catalog in the interface language', async () => {
  serve()
  const { ctx, main, dispose } = fixture([])
  const view = await render(main, { t })
  await openMaster(view.container)
  expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain(zh.sessionNotListed)
  view.dispose(); dispose()
})

it('polls one request at a time, keeps the data while new dependencies load, and polls less while hidden', async () => {
  vi.useFakeTimers()
  const calls: { limit: number; done: (value: string[]) => void }[] = []
  let shown: { data?: string[]; limit: number } = { limit: 0 }
  let setLimit = (_limit: number) => {}
  function Harness() {
    const [limit, update] = useState(1)
    setLimit = update
    const { data } = usePoll(() => new Promise<string[]>(done => { calls.push({ limit, done }) }), [limit], 1000)
    shown = { ...data ? { data } : {}, limit }
    return null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => { root.render(<Harness />) })
  expect(calls).toHaveLength(1)
  // A slow response holds the next poll back instead of overlapping.
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls).toHaveLength(1)
  await act(async () => { calls[0]!.done(['a']) })
  expect(shown.data).toEqual(['a'])
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(calls).toHaveLength(2)
  await act(async () => { setLimit(2) })
  expect(shown).toEqual({ data: ['a'], limit: 2 })
  await act(async () => { calls[2]!.done(['a', 'b']) })
  expect(shown.data).toEqual(['a', 'b'])
  // A late response to the superseded request must not replace the newer result.
  await act(async () => { calls[1]!.done(['stale']) })
  expect(shown.data).toEqual(['a', 'b'])
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  await act(async () => { calls[3]!.done(['a', 'b']) })
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls).toHaveLength(4)
  hidden.mockRestore()
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(calls).toHaveLength(5)
  act(() => { root.unmount() })
  vi.useRealTimers()
})

it('tells a dsh-superagent that does not answer from a record it does not have, and words each failure by what failed', async () => {
  const messages = { offline: 'offline', notRunning: 'not running', serverError: (status: number) => `server ${status}`,
    requestFailed: (status: number) => `request ${status}`, setup: () => 'setup', user: ({ code }: { code: string }) => `user ${code}` }
  const call = caller(() => messages)
  const failure = async (answer: () => Promise<Response>) => {
    vi.stubGlobal('fetch', vi.fn(answer))
    const error = await call('GET tickets/:id', { id: 't1' }).then(() => undefined, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ApiError)
    const { message, status, missing, details } = error as ApiError
    return { message, status, missing, unreachable: !!details.unreachable }
  }
  expect(await failure(async () => { throw new TypeError('Failed to fetch') })).toEqual({ message: 'offline', status: 0, missing: false,
    unreachable: true })
  // DSH's web server answers an empty 404 while dsh-superagent's routes are unregistered.
  expect(await failure(async () => new Response(null, { status: 404 }))).toEqual({ message: 'not running', status: 404, missing: false,
    unreachable: true })
  expect(await failure(async () => new Response(null, { status: 502 }))).toEqual({ message: 'server 502', status: 502, missing: false,
    unreachable: true })
  expect(await failure(async () => new Response('<html>Bad request</html>', { status: 400 }))).toEqual({ message: 'request 400',
    status: 400, missing: false, unreachable: false })
  expect(await failure(async () => Response.json({ error: 'Unknown ticket', code: 'unknownTicket' }, { status: 404 }))).toEqual({
    message: 'user unknownTicket', status: 404, missing: true, unreachable: false })
})


it('renders the five native Session entries and routes Workspace actions into the panel', async () => {
  serve(true)
  const host = fixture(['router-alpha'], true)
  const at = (name: string) => host.entries.find(entry => entry.options.name === name)!
  const views = []
  try {
    const glyph = await render(at('sidebar.session.row.leading'), { sessionId: 'router-alpha' }); views.push(glyph)
    expect(glyph.container.querySelector('svg')).toBeTruthy()
    const badge = await render(at('sidebar.session.row.trailing'), { sessionId: 'router-alpha' }); views.push(badge)
    expect(badge.container.textContent).toContain('总控 · 2')
    expect(badge.container.querySelector('[data-state="waiting"]')).toBeTruthy()
    const hover = await render(at('sidebar.session.row.hover'), { sessionId: 'worker-fixture' }); views.push(hover)
    expect(hover.container.textContent).toContain('task/review')
    const action = await render(at('sidebar.workspaces.session.row.action'), { sessionId: 'worker-fixture' }); views.push(action)
    expect(action.container.querySelector('button')?.getAttribute('aria-label')).toBe(zh.sideOpenTicket)
    const dismiss = vi.fn()
    const menu = await render(at('sidebar.workspaces.session.menu.item'), { sessionId: 'worker-fixture', useMenuOpenState: () => [true, dismiss] }); views.push(menu)
    expect(menu.container.querySelector('[role="menuitem"]')?.textContent).toBe(zh.sideOpenTicket)
    const icon = await render(host.nav, { size: 16 }); views.push(icon)
    expect(icon.container.querySelector('.sa-side-dot[data-state="waiting"]')).toBeTruthy()
    const panel = await render(host.main, { t }); views.push(panel)
    const workspace = host.menus[0] as { resolve(target: { path: string; displayTitle: string }): { id: string; run(): unknown }[] }
    const actions = workspace.resolve({ path: 'c:/DEV/Alpha/', displayTitle: 'Alpha' })
    expect(actions.map(item => item.id)).toEqual(['router', 'board', 'new'])
    expect(workspace.resolve({ path: 'c:/WORK/job', displayTitle: 'Job' }).map(item => item.id)).toEqual(['board', 'router'])
    await act(async () => actions[0]!.run())
    expect(host.ctx.uiWorkspace.openSession).toHaveBeenCalledWith('router-alpha')
    await act(async () => { actions[1]!.run() })
    expect(host.selectPanel).toHaveBeenCalledWith('dsh-superagent')
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).includes('overview?project=alpha'))).toBe(true)
    await act(async () => { actions[2]!.run() })
    expect(panel.container.querySelector<HTMLSelectElement>('.dt-form select')?.value).toBe('alpha')
    await act(async () => { menu.container.querySelector('button')!.click() })
    expect(dismiss).toHaveBeenCalledWith(false)
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).includes('tickets/fixture'))).toBe(true)
    await act(async () => { workspace.resolve({ path: '/new/project', displayTitle: 'New Workspace' })[0]!.run() })
    expect([...panel.container.querySelectorAll('input')].map(input => input.value)).toEqual(expect.arrayContaining(['/new/project', 'New Workspace']))
  } finally { views.reverse().forEach(view => view.dispose()); host.dispose() }
})
