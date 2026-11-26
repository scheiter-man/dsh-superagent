// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SidebarView } from '../src/app/sidebar.ts'
import { mountSidebarSections } from '../src/client/sidebar-sections.tsx'
import type { SidebarStore } from '../src/client/sidebar-store.ts'
import { panelBridge } from '../src/client/panel-bridge.ts'
import { zh } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const t = ((key: keyof typeof zh, values?: Record<string, unknown>) => String(zh[key]).replace(/\{(\w+)\}/g, (_, k) => String(values?.[k]))) as T
const settle = () => act(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
const row = (id: string) => `<div role="treeitem" data-row-key="workspace:${id}"><span>Folder</span><span class="fixture_rowActions"><button>Original</button></span></div>`

it('adds projects and exact Workspace badges, preserves search and purges all owned nodes on disposal', async () => {
  document.body.innerHTML = `<div id="dock"><div data-sidebar-scrollport><nav></nav><div id="native"><div data-sidebar-workspace-header><span>Workspaces</span><button aria-expanded="false">Search</button><input></div><div data-sidebar-list-area>${row('repo')}${row('work')}${row('other')}</div></div></div></div>`
  const select = vi.fn(), bridge = panelBridge(select), openRouter = vi.fn(async () => {}), openSession = vi.fn(async () => true)
  const subscriptions = new Set<() => void>(), workspaceSubscriptions = new Set<() => void>()
  const subscribe = (set: Set<() => void>) => (listener: () => void) => { set.add(listener); return () => { set.delete(listener) } }
  const project = { id: 'alpha', name: 'Alpha', masterId: 'blank-router', repositoryRoot: 'C:\\Repos\\Alpha', worktreeRoot: 'C:\\Worktrees', desks: ['dev'], active: 2, running: 1, waiting: 1, failed: 1, archived: false, routerWorkspace: null }
  let snapshot: SidebarView = { projects: [project, { ...project, id: 'empty', name: 'Empty project', repositoryRoot: '/srv/empty', worktreeRoot: '', active: 0, running: 0, waiting: 0, failed: 0 }], totals: { open: 2, running: 1, waiting: 1, failed: 1 }, sessions: {
    'worker-queued': { kind: 'worker', projectId: 'alpha', projectName: 'Alpha', ticketId: 'queued', ticketTitle: 'Queued ticket', desk: 'dev', status: 'queued', branch: 'task/queued' },
    'worker-ticket': { kind: 'worker', projectId: 'alpha', projectName: 'Alpha', ticketId: 'ticket', ticketTitle: 'Blocked ticket', desk: 'dev', status: 'failed', branch: 'task/ticket' },
    'worker-done': { kind: 'worker', projectId: 'alpha', projectName: 'Alpha', ticketId: 'done', ticketTitle: 'Finished ticket', desk: 'dev', status: 'done', branch: '' },
  } }
  let items = [{ workspaceId: 'repo', path: 'c:/repos/ALPHA/' }, { workspaceId: 'work', path: 'C:/WorkTrees/bug' }, { workspaceId: 'other', path: 'c:/worktrees-sibling/bug' }]
  const store = { subscribe: subscribe(subscriptions), getSnapshot: () => snapshot } as unknown as SidebarStore
  const workspaces = { subscribe: subscribe(workspaceSubscriptions), getSnapshot: () => ({ items }) } as unknown as WorkspaceSource
  const saved = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) })
  const dispose = mountSidebarSections({ store, workspaces, bridge, openRouter, openSession, t })
  const node = (selector: string) => document.querySelector<HTMLElement>(selector)!
  const click = (selector: string) => act(async () => { node(selector).click() })
  try {
    await settle()
    expect(node('[data-sa-projects-host]').nextElementSibling?.id).toBe('native')
    expect(node('[data-project="empty"]').textContent).toContain('Empty project')
    expect(node('[data-row-key="workspace:repo"] .sa-ws-mark').dataset).toMatchObject({ kind: 'project', state: 'failed' })
    expect(node('[data-row-key="workspace:repo"] .sa-ws-mark').nextElementSibling?.className).toBe('fixture_rowActions')
    expect(node('[data-row-key="workspace:work"] .sa-ws-mark').dataset.kind).toBe('worktree')
    expect(node('[data-row-key="workspace:other"] .sa-ws-mark')).toBeNull()
    expect(node('.sa-section-worker').textContent).toContain('Blocked ticket')
    expect(node('.sa-project-section').textContent).not.toContain('Finished ticket')
    await click('[data-project="empty"] [aria-expanded]')
    await click('[data-project="empty"] + div .sa-section-child')
    expect(openRouter).toHaveBeenCalledWith('empty')
    await click('.sa-section-worker .sa-section-child')
    expect(bridge.take()).toMatchObject({ projectId: 'alpha', ticketId: 'ticket' })
    await click('.sa-section-worker .sa-section-shortcut')
    expect(openSession).toHaveBeenCalledWith('worker-ticket', expect.any(AbortSignal))
    await click('[data-sa-workspaces-toggle]')
    expect(node('[data-sidebar-list-area]').classList.contains('sa-ws-collapsed')).toBe(true)
    await act(async () => { node('[data-sidebar-workspace-header] button:not([data-sa-workspaces-toggle])').setAttribute('aria-expanded', 'true') })
    await settle()
    expect(node('[data-sidebar-list-area]').classList.contains('sa-ws-collapsed')).toBe(false)
    await act(async () => { node('[data-sidebar-workspace-header] button:not([data-sa-workspaces-toggle])').setAttribute('aria-expanded', 'false') })
    await settle()
    expect(node('[data-sidebar-list-area]').classList.contains('sa-ws-collapsed')).toBe(true)
    await click('.sa-section-header [aria-expanded]')
    expect(localStorage.getItem('dsh-superagent.sidebar.projectsCollapsed')).toBe('true')
    expect(node('[data-project="alpha"]')).toBeNull()
    items = items.slice(0, 2).filter(item => item.workspaceId !== 'work')
    workspaceSubscriptions.forEach(listener => listener())
    await settle()
    expect(node('[data-row-key="workspace:work"] .sa-ws-mark')).toBeNull()
    await act(async () => { snapshot = { ...snapshot, projects: [] }; subscriptions.forEach(listener => listener()) })
    await settle()
    expect(document.querySelectorAll('.sa-ws-mark')).toHaveLength(0)
    node('#dock').dataset.sidebarCollapsed = 'true'
    await settle()
    expect(node('[data-sa-projects-host]')).toBeNull()
    delete node('#dock').dataset.sidebarCollapsed
    await settle()
    expect(node('.sa-section-header [aria-expanded]').getAttribute('aria-expanded')).toBe('false')
    expect(node('[data-sidebar-list-area]').classList.contains('sa-ws-collapsed')).toBe(true)
  } finally { await act(async () => { dispose() }); vi.unstubAllGlobals() }
  expect(node('[data-sa-projects-host], [data-sa-workspaces-toggle], .sa-ws-mark, .sa-ws-collapsed')).toBeNull()
  expect(subscriptions.size + workspaceSubscriptions.size).toBe(0)
  expect(node('.fixture_rowActions button').textContent).toBe('Original')
})
