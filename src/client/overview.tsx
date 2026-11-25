/** Overview page: pending Tickets requiring human action, active system problems, 24-hour flow counts, and Executor load. */
import { useRef, useState, type ReactNode } from 'react'
import type { LocalSubmission } from '../app/local-intake.ts'
import { Field } from './settings-kit.tsx'
import { usePoll, type Problem } from './api.ts'
import { Button, Icon, Input } from './controls.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { setupPage, settingsRoute, type Route } from './route.ts'
import { TicketLine } from './rows.tsx'
import { healthText, localized, reasonLabel, valueLabel, readableMarkers } from './text.ts'
import { CheckSetupButton, ConfirmButton, Hint, LoadState, Section, SetupMessage } from './widgets.tsx'

function ProblemLine({ problem, onChanged }: { problem: Problem; onChanged: () => Promise<void> }) {
  const { t, call, navigate } = usePanel()
  const post = useAction((request: () => Promise<unknown>) => request(), { reload: onChanged })
  const row = (title: string, detail: ReactNode, route: Route | undefined, hint?: string, actions?: ReactNode) => <li
    className="dt-row dt-link dt-att dt-att-error">
    <div className="dt-row-main">
      <div className="dt-att-what">{route ? <button type="button" className="dt-open dt-open-wrap"
        onClick={() => navigate(route)}>{title}</button> : title}</div>
      {detail}{hint && <Hint>{hint}</Hint>}{actions && <div className="dt-row-meta dt-row-buttons">{actions}</div>}
    </div>
  </li>
  const go = (label: string, route: Route) => <Button variant="outline" size="sm" icon={<Icon name="settings"
    size={14} />} onClick={() => navigate(route)}>{label}</Button>
  const raw = (text: string | undefined) => text && <p className="dt-error dt-clamp dt-mono">{text}</p>
  const worded = (text: string) => <p className="dt-error">{text}</p>
  switch (problem.kind) {
    // A failed Feishu bot check pauses only the Feishu Source; other setup problems halt the entire service.
    case 'setup': return row(t(problem.place === 'feishu' ? 'problemSetupFeishu' : 'problemSetup'), <p className="dt-error"><SetupMessage
      problem={problem} /></p>,
      setupPage(problem.place), t(`problemSetupFix.${problem.place}`), <CheckSetupButton />)
    case 'no-source': return row(t('problemNoSource'), undefined, settingsRoute('source'), undefined, go(t('actionOpenSources'),
      settingsRoute('source')))
    case 'no-allowed': return row(t('problemNoAllowed'), undefined, settingsRoute('eval'), undefined, go(t('actionAddAllowed'),
      settingsRoute('eval')))
    case 'executor-paused': return row(t('problemPaused'), undefined, { page: 'execution' }, undefined,
      <ConfirmButton variant="outline" icon="play" label={t('resumeProcessing')} title={t('resumeProcessing')}
        message={t('resumeProcessingConfirm')}
        onConfirm={async () => { await call('POST resume'); await onChanged() }} />)
    case 'runtime-error': return row(t('problemRuntime', { name: valueLabel(t, 'health', problem.name) }), raw(problem.detail), undefined)
    case 'source-error': {
      const health = problem.source.health
      return row(t('sourceError', { source: localized(t, problem.source.title) }), health.code ? worded(healthText(t, health))
        : raw(health.detail), { page: 'source' }, t('sourceErrorHint'))
    }
    case 'eval-overdue': return row(t('problemEvalOverdue', { thread: readableMarkers(t, problem.thread.title) }), undefined, { page: 'trigger',
      id: problem.thread.key })
    case 'eval-unavailable': return row(t('problemEvalUnavailable', { thread: readableMarkers(t, problem.thread.title) }), raw(reasonLabel(t,
      problem.reason)),
      { page: 'trigger', id: problem.thread.key, query: { trigger: problem.triggerId } }, undefined, <>
        <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST triggers/:id/requeue', { id: problem.triggerId })) }}>{t('requeue')}</Button>
        <Button variant="outline" size="sm" icon={<Icon name="dismiss" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST decisions/:id/dismiss', { id: problem.decisionId })) }}>{t('dismiss')}</Button>
      </>)
    case 'outgoing': return row(t('problemReply', { source: valueLabel(t, 'source', problem.outgoing.channel.source),
      attempts: problem.outgoing.attempts }),
      raw(problem.outgoing.error), undefined)
  }
}

export function OverviewPage() {
  const { t, call, navigate, activeProjectId } = usePanel()
  const { setup, state, reload: reloadState } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET overview', activeProjectId === 'all' ? undefined : { query: { project: activeProjectId } }), [call, activeProjectId])
  const refresh = async () => { await Promise.all([reload(), reloadState()]) }
  if (!data) return <LoadState error={error} loading />
  const stat = (label: string, value: ReactNode, route?: Route) => <span className="dt-stat">
    <span className="dt-stat-label">{label}</span>
    {route ? <button type="button" className="dt-textlink dt-stat-value" onClick={() => navigate(route)}>{value}</button> : <span
      className="dt-stat-value">{value}</span>}
  </span>
  const more = (route: Route) => <button type="button" className="dt-textlink dt-more-link"
    onClick={() => navigate(route)}>{t('details')}</button>
  return <>
    {state?.startupHold && <Section title={t('heldTasks', { count: state.startupHoldCount })}>
      <ConfirmButton variant="outline" icon="play" label={t('resumeHeldTasks')} title={t('resumeHeldTasks')}
        message={t('resumeProcessingConfirm')} onConfirm={async () => { await call('POST resume'); await refresh() }} />
    </Section>}
    {!setup?.problem && <NewLocalTicket refresh={refresh} />}
    {error && <LoadState error={error} loading={false} />}
    <Section title={t('pendingTickets')} count={data.person.length}>
      {data.person.length ? <ul className="dt-list dt-cards">{data.person.map(ticket => <TicketLine key={ticket.id} ticket={ticket} question
        onChanged={refresh} />)}</ul>
        : <Hint>{t('needsYouNone')}</Hint>}
    </Section>
    {data.problems.length > 0 && <Section title={t('problems')} count={data.problems.length}>
      <ul className="dt-list dt-cards">{data.problems.map((problem, index) => <ProblemLine key={index} problem={problem}
        onChanged={refresh} />)}</ul>
    </Section>}
    <Section title={t('lastDay')} action={more({ page: 'trigger', query: { filter: 'recent' } })}>
      {/* Received and evaluated counts operate on Triggers rather than Threads or Decisions, so they do not link to filtered views. */}
      <div className="dt-stats">
        {stat(t('flowReceivedLabel'), data.flow.received)}
        {stat(t('flowFilteredLabel'), data.flow.filtered, data.flow.filtered ? { page: 'source' } : undefined)}
        {stat(t('flowJudgedLabel'), data.flow.judged)}
        {stat(t('flowAcceptedLabel'), data.flow.accepted, { page: 'eval', query: { window: '24h' } })}
        {data.flow.dropped > 0 && stat(t('flowDroppedLabel'), data.flow.dropped, { page: 'source' })}
      </div>
    </Section>
    <Section title={t('term.executor')} action={more({ page: 'execution' })}>
      {/* Pauses surface in `problems` above, so Executor counts render the same in both states; while setup waits, nothing runs. */}
      {setup?.problem ? <Hint>{t('executorWaitingSetup')}</Hint> : <div className="dt-stats">
        {stat(t('globalRunning'), `${data.executor.running} / ${data.executor.maxWorkers}`)}
        {stat(t('queuedLabel'), data.executor.queued)}
        {stat(t('idleLabel'), data.executor.idle)}
      </div>}
    </Section>
  </>
}

const DESKS = ['mentor', 'thesis', 'format', 'experiment', 'proto', 'infra'] as const

function workspaceName(title: string): string {
  const words = title.toLowerCase().normalize('NFKD').match(/[a-z]+[a-z0-9]*/g)?.slice(0, 4) ?? []
  const [first, ...rest] = words
  return first ? [first.replace(/\d.*$/, ''), ...rest].join('-').slice(0, 32).replace(/-$/, '') : 'local-ticket'
}

function NewLocalTicket({ refresh }: { refresh: () => Promise<void> }) {
  const { call, notify, t, navigate, activeProjectId } = usePanel()
  const { projects } = usePanelData()
  const available = projects?.items.filter(project => !project.archived) ?? []
  const [projectId, setProjectId] = useState('')
  const choose = (id: string) => { setProjectId(id); setDesk(available.find(item => item.id === id)?.desks[0] ?? 'mentor') }
  const [open, setOpen] = useState(false)
  const [desk, setDesk] = useState('mentor')
  const [custom, setCustom] = useState('')
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [ticket, setTicket] = useState<string>()
  const pending = useRef<{ payload: string; id: string } | undefined>(undefined)
  const action = useAction(async () => {
    const value: Omit<LocalSubmission, 'request_id'> = { ...(projectId ? { project_id: projectId } : {}), desk: desk === 'custom' ? custom.trim() : desk,
      title: title.trim(), text, workspace_name: workspace.trim() || workspaceName(title) }
    const payload = JSON.stringify(value)
    if (pending.current?.payload !== payload) pending.current = { payload, id: globalThis.crypto.randomUUID() }
    const receipt = await call('POST local/submit', { body: { ...value, request_id: pending.current.id } })
    pending.current = undefined
    if (projectId) globalThis.localStorage?.setItem('dsh-superagent/last-ticket-project', projectId)
    setTicket(receipt.ticket_id); setOpen(false); setTitle(''); setText(''); setWorkspace('')
    notify(t('newTicketSuccess'))
    await refresh()
  })
  return <Section title={t('newTicket')} action={<Button type="button" size="sm" variant="outline" aria-expanded={open}
    onClick={() => {
      if (!open) { const preferred = activeProjectId !== 'all' ? activeProjectId : globalThis.localStorage?.getItem('dsh-superagent/last-ticket-project'); choose(available.some(row => row.id === preferred) ? preferred! : projects?.defaultId ?? '') }
      setOpen(!open)
    }}>{open ? t('close') : `+ ${t('newTicket')}`}</Button>}>
    {ticket && <button type="button" className="dt-textlink" onClick={() => navigate({ page: 'execution', id: ticket })}>
      {t('newTicketOpen')}</button>}
    {open && <form className="dt-form" onSubmit={event => { event.preventDefault(); void action.run() }}>
      {available.length > 0 && <Field label={t('projectLabel')}><select className="dt-select" value={projectId} onChange={event => choose(event.target.value)}>{available.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>}
      <Field label={t('ticketDesk')}><select className="dt-select" value={desk} onChange={event => setDesk(event.target.value)}>
        {(available.find(item => item.id === projectId)?.desks ?? DESKS).map(value => <option value={value} key={value}>{value}</option>)}
        <option value="custom">{t('ticketCustomDesk')}</option>
      </select></Field>
      {desk === 'custom' && <Field label={t('ticketCustomDesk')}><Input value={custom} required pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"
        onChange={event => setCustom(event.target.value)} /></Field>}
      <Field label={t('ticketTitleInput')}><Input value={title} required maxLength={200} onChange={event => setTitle(event.target.value)} /></Field>
      <Field label={t('ticketInstructions')}><textarea className="dt-input" value={text} required maxLength={60_000}
        rows={5} onChange={event => setText(event.target.value)} /></Field>
      <Field label={t('ticketWorkspaceInput')}><Input value={workspace} placeholder={workspaceName(title)} maxLength={32}
        pattern="[a-z]+(?:-[a-z0-9]+){0,3}" onChange={event => setWorkspace(event.target.value)} /></Field>
      <Button type="submit" variant="primary" disabled={action.busy || !title.trim() || !text.trim()}>{t('newTicketSubmit')}</Button>
    </form>}
  </Section>
}
