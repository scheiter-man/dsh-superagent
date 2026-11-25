import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Projects } from '../src/app/projects.ts'
import { Store } from '../src/app/store.ts'
import { Prompts, defaultPrompts } from '../src/app/prompts.ts'

let root: string, store: Store, projects: Projects
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superagent-projects-'))
  store = new Store(join(root, 'test.sqlite'))
  projects = new Projects(store, root)
})
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim()
function repository(name: string) {
  const cwd = join(root, name)
  mkdirSync(cwd); git(cwd, 'init'); git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Fixture')
  return cwd
}
const project = (id: string, repositoryRoot: string) => ({ id, name: id, repositoryRoot, worktreeRoot: '', prepareMode: 'git' as const, prepare: '', desks: ['dev'], archived: false })

it('routes Git root, nested directories and linked worktrees, freezing the accepted HEAD', () => {
  const alpha = repository('alpha repo'), beta = repository('beta repo')
  const nested = join(alpha, 'sub'); mkdirSync(nested)
  projects.save(project('alpha', alpha), 0, true)
  projects.save(project('beta', beta), 0, false)
  expect(projects.select(undefined, nested).id).toBe('alpha')
  const linked = join(root, 'linked directory')
  git(beta, 'worktree', 'add', '--detach', linked, 'HEAD')
  expect(projects.select(undefined, linked).id).toBe('beta')
  expect(() => projects.select(undefined, root)).toThrow('Choose --project')
  expect(() => projects.save(project('duplicate', linked), 0, false)).toThrow('already registered')
  const plan = projects.plan('alpha', 'ticket-1', 'job')!
  git(alpha, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Second')
  expect(plan.baseline).not.toBe(git(alpha, 'rev-parse', 'HEAD'))
  expect(plan).toMatchObject({ projectId: 'alpha', branch: expect.stringMatching(/^task\/job-/), mode: 'git' })
})

it('keeps the legacy project as the history owner when the default selection changes', () => {
  const alpha = repository('alpha'), beta = repository('beta')
  projects.save(project('alpha', alpha), 0, true, true)
  projects.save(project('beta', beta), 0, true)
  expect(projects.defaultId).toBe('beta')
  expect(projects.scope(undefined)).toBe('alpha')
  expect(projects.list().map(item => item.id)).toEqual(['alpha', 'beta'])
  expect(() => projects.save({ ...project('beta', beta), archived: true }, 1, false)).toThrow('different default')
})

it('stores independent prompt history with the same numeric revisions', () => {
  const prompts = (id: string) => new Prompts(store, () => 100_000, () => undefined, () => false, id)
  const config = defaultPrompts()
  prompts('alpha').save({ ...config, communication: 'Alpha rules' }, 0, 'panel')
  prompts('beta').save({ ...config, communication: 'Beta rules' }, 0, 'panel')
  expect(prompts('alpha').version(1).config.communication).toBe('Alpha rules')
  expect(prompts('beta').version(1).config.communication).toBe('Beta rules')
})
