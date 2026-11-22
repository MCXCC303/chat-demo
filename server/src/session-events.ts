import type {
  BranchSelectedPayload,
  MessageBlockEndPayload,
  MessageBlockPayload,
  MessageDeltaPayload,
  MessageUpsertPayload,
  SessionCommand,
  SessionEvent,
  SessionEventType,
  SessionMetaPayload,
  SessionPage,
  TurnStatePayload,
} from '../../src/services/session/types.js'
import type { SessionSummary } from '../../src/services/chat/types.js'
import type { LegacySessionEnvelope } from './commands.ts'

export interface SessionLog {
  append(sessionId: string, type: SessionEventType, payload: unknown): Promise<number>
  read(sessionId: string): Promise<SessionEvent[]>
  readFrom(sessionId: string, after: number): Promise<SessionEvent[]>
  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void
  listSessions(): Promise<SessionSummary[]>
  writeSession(sessionId: string, events: PendingEvent[]): Promise<void>
  deleteSession(sessionId: string): Promise<void>
}

export type PendingEvent = {
  type: SessionEventType
  payload: unknown
}

export type SessionEventPayloads = {
  'session/meta': SessionMetaPayload
  'session/deleted': { sessionId: string }
  'message/upsert': MessageUpsertPayload
  'message/delta': MessageDeltaPayload
  'message/block': MessageBlockPayload
  'message/block-end': MessageBlockEndPayload
  'branch/selected': BranchSelectedPayload
  'turn/state': TurnStatePayload
}

export type SessionEventOf<T extends SessionEventType> = {
  seq: number
  type: T
  payload: SessionEventPayloads[T]
}

export interface SessionService {
  listSessions(): Promise<SessionSummary[]>
  listSessionPage(offset: number, limit: number): Promise<SessionPage>
  handle(sessionId: string, command: SessionCommand): Promise<number[]>
  readFrom(sessionId: string, after: number): Promise<SessionEvent[]>
  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void
  subscribeControl(
    listener: (frame: { seq: number; type: string; payload: unknown }) => void
  ): () => void
  readSession(sessionId: string): Promise<LegacySessionEnvelope | undefined>
  importSessions(items: LegacySessionEnvelope[]): Promise<SessionSummary[]>
}

export const isSessionEvent = (value: unknown): value is SessionEvent => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const event = value as Partial<SessionEvent>
  return typeof event.seq === 'number' && typeof event.type === 'string'
}
