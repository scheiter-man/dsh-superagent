import { Field } from './settings-kit.tsx'
import { useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import type { ProjectInput } from '../app/projects.ts'
import { Button, Input, Tag } from './controls.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'

type Row = ApiResponse<'GET projects'>['items'][number]
export function ProjectsPage() {
  const { t, call, openSession } = usePanel()
  const { projects, reloadProjects } = usePanelData()
  const [editing, edit] = useState<Row | 'new'>()
  const open = useAction(async (id: string) => openSession((await call('POST projects/:id/router', { id })).masterId), { reload: reloadProjects })
  return <div className="dt-form">
    <Button variant="outline" onClick={() => edit('new')}>+ {t('projectAdd')}</Button>
    {projects?.items.map(project => <section className="dt-block dt-project-card" key={project.id}>
      <div><strong>{project.name}</strong> <Tag>{project.id}</Tag> {project.id === projects.defaultId && <Tag tone="info">{t('projectDefault')}</Tag>}
        {project.archived && <Tag>{t('projectArchived')}</Tag>}<div className="dt-hint">{project.repositoryRoot}</div>
        <div>{project.desks.map(desk => <Tag key={desk}>{desk}</Tag>)}</div></div>
      <div className="dt-toolbar"><Button size="sm" variant="outline" onClick={() => edit(project)}>{t('projectEdit')}</Button>
        <Button size="sm" variant="outline" disabled={project.archived || open.busy} onClick={() => void open.run(project.id)}>{t('openMaster')}</Button></div>
    </section>)}
    {editing && <ProjectEditor key={editing === 'new' ? editing : editing.id} row={editing === 'new' ? undefined : editing} close={() => edit(undefined)} />}
  </div>
}
function ProjectEditor({ row, close }: { row: Row | undefined; close(): void }) {
  const { t, call } = usePanel()
  const { projects, reloadProjects } = usePanelData()
  const [value, set] = useState<ProjectInput>(() => row ? { id: row.id, name: row.name, repositoryRoot: row.repositoryRoot, worktreeRoot: row.worktreeRoot,
    prepareMode: row.prepareMode, prepare: row.prepare, desks: row.desks, archived: row.archived } : { id: '', name: '', repositoryRoot: '', worktreeRoot: '', prepareMode: 'git', prepare: '', desks: ['dev', 'review', 'ops'], archived: false })
  const [desks, setDesks] = useState(value.desks.join(', '))
  const [makeDefault, setDefault] = useState(false)
  const field = <K extends keyof ProjectInput>(key: K, next: ProjectInput[K]) => set(previous => ({ ...previous, [key]: next }))
  const save = useAction(async () => {
    await call('PUT projects/:id', { id: value.id, body: { revision: row?.revision ?? 0, makeDefault, project: { ...value, desks: desks.split(/[,\s]+/).filter(Boolean) } } })
    await reloadProjects(); close()
  })
  return <form className="dt-form dt-block" onSubmit={event => { event.preventDefault(); void save.run() }}>
    <Field label={t('projectId')}><Input required pattern="[a-z][a-z0-9-]{0,47}" disabled={!!row} value={value.id} onChange={event => field('id', event.target.value)} /></Field>
    <Field label={t('projectName')}><Input required value={value.name} onChange={event => field('name', event.target.value)} /></Field>
    {!!projects?.workspaces.length && <Field label={t('projectWorkspace')}><select className="dt-select" value="" onChange={event => field('repositoryRoot', event.target.value)}>
      <option value="">{t('projectWorkspace')}</option>{projects.workspaces.map(workspace => <option key={workspace.id} value={workspace.path}>{workspace.title} · {workspace.path}</option>)}
    </select></Field>}
    <Field label={t('projectRepository')}><Input required={value.prepareMode === 'git'} value={value.repositoryRoot} onChange={event => field('repositoryRoot', event.target.value)} /></Field>
    <Field label={t('projectWorktree')}><Input value={value.worktreeRoot} onChange={event => field('worktreeRoot', event.target.value)} /></Field>
    <Field label={t('projectPrepare')}><select className="dt-select" value={value.prepareMode} onChange={event => field('prepareMode', event.target.value === 'git' ? 'git' : 'shell')}>
      <option value="git">{t('projectGit')}</option><option value="shell">{t('projectShell')}</option></select></Field>
    {value.prepareMode === 'shell' && <Field label={t('projectShell')}><textarea className="dt-input" value={value.prepare} onChange={event => field('prepare', event.target.value)} /></Field>}
    <Field label={t('projectDesks')}><Input required value={desks} onChange={event => setDesks(event.target.value)} /></Field>
    <label><input type="checkbox" checked={makeDefault} disabled={value.archived} onChange={event => setDefault(event.target.checked)} /> {t('projectSetDefault')}</label>
    {row && <label><input type="checkbox" checked={value.archived} disabled={row.id === projects?.defaultId || row.active > 0} onChange={event => field('archived', event.target.checked)} /> {t('projectArchive')}</label>}
    <div className="dt-toolbar"><Button type="submit" variant="primary" disabled={save.busy}>{t('save')}</Button>
      <Button type="button" variant="outline" onClick={close}>{t('close')}</Button></div>
  </form>
}
