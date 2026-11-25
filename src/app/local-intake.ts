/** Authenticated, transactional submission of an explicitly named local ticket. */
import { z } from 'zod'
import { key, type Engine } from '../core/index.ts'
import { KV } from '../kv.ts'
import { LOCAL_SOURCE, localTrigger } from '../sources/local.ts'
import { WorktreeNameSchema } from './assessment.ts'
import type { Projects } from './projects.ts'
import type { Store } from './store.ts'

export const LocalSubmissionSchema = z.object({
  project_id: z.string().optional(),
  cwd: z.string().max(4096).optional(),
  request_id: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),
  desk: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  title: z.string().trim().min(1).max(200),
  workspace_name: WorktreeNameSchema,
  text: z.string().min(1).max(60_000).refine(text => text.trim().length > 0, 'The request must contain text'),
}).strict()
export type LocalSubmission = z.infer<typeof LocalSubmissionSchema>
/** An idempotency conflict or a disabled local intake. */
export class LocalSubmissionConflict extends Error {}

export function submitLocal(store: Store, engine: Engine, submission: LocalSubmission, projects?: Projects) {
  const { request_id, desk, title, workspace_name, text } = submission
  const project = projects?.select(submission.project_id, submission.cwd)
  const trigger = localTrigger(request_id, desk, title, text, new Date().toISOString())
  if (project) { trigger.projectId = project.id; trigger.desk = desk }
  const legacySignature = key(desk, title, workspace_name, text)
  const signature = project ? key(project.id === projects?.legacyId ? 'default' : project.id, legacySignature) : legacySignature
  const receiptKey = KV.local.submission(request_id)
  return store.atomic(() => {
    const previous = store.get(receiptKey)
    if (previous) {
      if (previous.signature !== signature && !(previous.signature === legacySignature && project?.id === projects?.legacyId)) throw new LocalSubmissionConflict('Request ID already names a different submission')
      return { ...previous.receipt, ...(project ? { project_id: project.id } : {}), duplicate: true }
    }
    if (store.settings().sources[LOCAL_SOURCE]?.enabled === false) throw new LocalSubmissionConflict('Local submissions are disabled')
    if (engine.receive(trigger) !== 'stored') throw new LocalSubmissionConflict('The local trigger cannot be admitted')
    const decision = engine.decide(trigger.id, { kind: 'accept', title, scope: title, name: workspace_name,
      reason: 'Accepted on explicit local operator submission' })
    if (!decision.ticketId) throw new LocalSubmissionConflict('The local trigger did not create a ticket')
    const receipt = { request_id, desk, ...(project ? { project_id: project.id } : {}), ticket_id: decision.ticketId, trigger_id: trigger.id }
    store.set(receiptKey, { signature, receipt })
    return { ...receipt, duplicate: false }
  })
}
