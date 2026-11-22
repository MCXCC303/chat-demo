import type { ChatModel, ContentBlockDelta, OutputBlockStart } from '../api/types.js'
import type { FileAttachment, Message, SessionSummary } from '../chat/types.js'

export type SessionEventType =
  | 'session/meta'
  | 'session/deleted'
  | 'message/upsert'
  | 'message/delta'
  | 'message/block'
  | 'message/block-end'
  | 'branch/selected'
  | 'turn/state'

export type SessionEvent = {
  seq: number
  type: SessionEventType
  payload: unknown
}

export type SessionStreamFrame = {
  seq: number
  type: SessionEventType
  payload: unknown
}

export type SessionMetaPayload = {
  sessionId: string
  title: string
  pinned: boolean
  createdAt: number
  updatedAt: number
}

export type MessageUpsertPayload = {
  message: Message
}

export type MessageDeltaPayload = {
  messageId: string
  index: number
  delta: ContentBlockDelta
}

export type MessageBlockPayload = {
  messageId: string
  index: number
  block: OutputBlockStart
}

export type MessageBlockEndPayload = {
  messageId: string
  index: number
}

export type BranchSelectedPayload = {
  parentId: string | null
  selectedChildId: string | null
}

export type TurnStatePayload = {
  turnId: string
  status: 'running' | 'done' | 'stopped' | 'error'
}

export type SessionCommand =
  | {
      command: 'send'
      content: string
      files: FileAttachment[]
      model: ChatModel
      thinking: boolean
      search: boolean
    }
  | { command: 'regenerate'; messageId: string }
  | { command: 'edit'; messageId: string; content: string }
  | { command: 'continue'; messageId: string }
  | { command: 'select'; messageId: string }
  | { command: 'stop'; turnId: string }
  | { command: 'rename'; title: string }
  | { command: 'pin'; pinned: boolean }
  | { command: 'delete' }

export type CommandResult = {
  accepted: number[]
}

export type SessionPage = {
  sessions: SessionSummary[]
  hasMore: boolean
}

export type ControlEventType =
  | 'sessions/snapshot'
  | 'session/updated'
  | 'session/deleted'
  | 'session/lock'

export type ControlEvent = {
  type: ControlEventType
  payload: unknown
}
