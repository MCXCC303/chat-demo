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
  TurnStatePayload,
} from '../../src/services/session/types.js'
import type { SessionSummary } from '../../src/services/chat/types.js'

export interface SessionLog {
  append(sessionId: string, type: SessionEventType, payload: unknown): Promise<number>
  read(sessionId: string): Promise<SessionEvent[]>
  readFrom(sessionId: string, after: number): Promise<SessionEvent[]>
  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void
  listSessions(): Promise<SessionSummary[]>
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
  handle(sessionId: string, command: SessionCommand): Promise<number[]>
  readFrom(sessionId: string, after: number): Promise<SessionEvent[]>
  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void
  subscribeControl(listener: (frame: { seq: number; type: string; payload: unknown }) => void): () => void
}

export const isSessionEvent = (value: unknown): value is SessionEvent => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const event = value as Partial<SessionEvent>
  return typeof event.seq === 'number' && typeof event.type === 'string'
}
