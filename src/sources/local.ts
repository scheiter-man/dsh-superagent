/** Operator submissions use a distinct thread for each request, even on the same Desk. */
import { z } from 'zod'
import { key } from '../core/ids.ts'
import type { ActorRef, Trigger } from '../core/model.ts'
import type { SourceKind } from './kind.ts'

export const LOCAL_SOURCE = 'local'
const operator: ActorRef = { source: LOCAL_SOURCE, id: 'operator' }
export const isLocalOperator = (actor: ActorRef): boolean => actor.source === operator.source && actor.id === operator.id

export const localKind: SourceKind = {
  kind: LOCAL_SOURCE,
  title: { en: 'Local operator', zh: '本地操作员' },
  description: { en: 'Authenticated local submissions, grouped by Desk.', zh: '按专席分组的操作员本机投递。' },
  schema: z.object({}).strict(),
  fields: [],
  health: [],
}

export function localTrigger(requestId: string, desk: string, title: string, text: string, at: string): Trigger {
  const id = key(LOCAL_SOURCE, requestId)
  return { id, source: LOCAL_SOURCE, threads: [{ source: LOCAL_SOURCE, id }], actor: operator,
    addressed: 'direct', human: true, text, at, meta: { desk, title } }
}
