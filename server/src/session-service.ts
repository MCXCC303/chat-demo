import { getVisibleMessages } from '../../src/services/chat/branches.ts'
import type { Message, Session, SessionSummary } from '../../src/services/chat/types.js'
import type { ControlEventType, SessionHistoryPage } from '../../src/services/session/types.js'
import { readServerSettings } from './agent.ts'
import { SessionCommands, toImportEvents, type LegacySessionEnvelope } from './commands.ts'
import type { CredentialStore } from './credentials.ts'
import type { ActiveResolver, ProviderResolver } from './providers.ts'
import type { SessionEvent } from '../../src/services/session/types.js'
import type { SessionLog, SessionService } from './session-events.ts'
import type { Storage } from './storage.ts'

export type SessionServiceOptions = {
  log: SessionLog
  resolveProvider: ProviderResolver
  readActive: ActiveResolver
  credentials: CredentialStore
  storage: Storage
}

export type ControlFrame = {
  seq: number
  type: ControlEventType
  payload: unknown
}

const CONTROL_POLL_INTERVAL = 2000
const HEAD_PAGE_SIZE = 50
const HISTORY_PAGE_MAX = 200
const HISTORY_PAGE_MIN = 10
const HISTORY_MIN_TURNS = 2

const buildSession = (
  sessionId: string,
  events: SessionEvent[]
): LegacySessionEnvelope | undefined => {
  const messages = new Map<string, Message>()
  const order: string[] = []
  let meta: { title: string; pinned: boolean; createdAt: number; updatedAt: number } | undefined
  let root: string | null = null
  for (const event of events) {
    if (event.type === 'session/meta') {
      meta = event.payload as typeof meta
      continue
    }
    if (event.type === 'message/upsert') {
      const { message } = event.payload as { message: Message }
      if (!messages.has(message.id)) {
        order.push(message.id)
      }
      messages.set(message.id, message)
      continue
    }
    if (event.type === 'branch/selected') {
      const { parentId, selectedChildId } = event.payload as {
        parentId: string | null
        selectedChildId: string | null
      }
      if (parentId === null) {
        root = selectedChildId
        continue
      }
      const parent = messages.get(parentId)
      if (parent) {
        messages.set(parentId, { ...parent, selectedChildId: selectedChildId ?? undefined })
      }
    }
  }
  if (!meta) {
    return undefined
  }
  const list = order.flatMap((id) => {
    const message = messages.get(id)
    return message ? [message] : []
  })
  return {
    id: sessionId,
    schemaVersion: 1,
    session: {
      id: sessionId,
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      pinned: meta.pinned,
      messages: list,
      rootMessageId: root,
    },
    summary: {
      id: sessionId,
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      pinned: meta.pinned,
    },
  }
}

const sessionRoot = (session: Session): string | null =>
  session.rootMessageId ??
  session.messages.find((message) => message.parentId === undefined || message.parentId === null)
    ?.id ??
  session.messages[0]?.id ??
  null

const sliceHistoryPage = (
  session: Session,
  before: string | null,
  limit: number
): Omit<SessionHistoryPage, 'seq'> => {
  const visible = getVisibleMessages({ ...session, rootMessageId: sessionRoot(session) })
  let end = visible.length
  if (before !== null) {
    const index = visible.findIndex((message) => message.id === before)
    if (index === -1) {
      return {
        session: { ...session, messages: [], rootMessageId: null },
        hasMore: false,
        before: null,
      }
    }
    end = index
  }
  if (end === 0) {
    return {
      session: { ...session, messages: [], rootMessageId: null },
      hasMore: false,
      before: null,
    }
  }

  let start = Math.max(0, end - limit)
  if (start > 0 && visible[start]?.role === 'assistant') {
    start -= 1
  }
  let turns = visible.slice(start, end).filter((message) => message.role === 'user').length
  while (start > 0 && turns < HISTORY_MIN_TURNS && end - start < limit * 2) {
    start -= 1
    if (visible[start]?.role === 'user') {
      turns += 1
    }
  }

  const page = visible.slice(start, end)
  const ids = new Set(page.map((message) => message.id))
  const parents = new Set(page.map((message) => message.parentId ?? null))
  for (const message of session.messages) {
    if (parents.has(message.parentId ?? null)) {
      ids.add(message.id)
    }
  }
  const messages = session.messages.filter((message) => ids.has(message.id))
  return {
    session: { ...session, messages, rootMessageId: page[0]?.id ?? null },
    hasMore: start > 0,
    before: page[0]?.id ?? null,
  }
}

export const createSessionService = (options: SessionServiceOptions): SessionService => {
  const commands = new SessionCommands({
    log: options.log,
    resolveProvider: options.resolveProvider,
    readActive: options.readActive,
    credentials: options.credentials,
    settings: {
      read: async () => readServerSettings(await options.storage.readSettings()),
    },
  })
  const listeners = new Set<(frame: ControlFrame) => void>()
  let controlSeq = 0
  let lastSnapshot = ''

  const currentFrame = async (): Promise<ControlFrame> => {
    const all = await options.log.listSessions()
    const sessions = all.slice(0, HEAD_PAGE_SIZE)
    const hasMore = all.length > sessions.length
    const serialized = JSON.stringify({ sessions, hasMore })
    if (serialized !== lastSnapshot) {
      lastSnapshot = serialized
      controlSeq += 1
    }
    return { seq: controlSeq, type: 'sessions/snapshot', payload: { sessions, hasMore } }
  }

  const timer = setInterval(() => {
    void currentFrame().then((frame) => {
      for (const listener of [...listeners]) {
        listener(frame)
      }
    })
  }, CONTROL_POLL_INTERVAL)
  timer.unref()

  return {
    async listSessions(): Promise<SessionSummary[]> {
      return await options.log.listSessions()
    },
    async listSessionPage(offset, limit) {
      const all = await options.log.listSessions()
      const start = Math.min(Math.max(offset, 0), all.length)
      const sessions = all.slice(start, start + Math.max(limit, 0))
      return { sessions, hasMore: start + sessions.length < all.length }
    },
    async handle(sessionId, command) {
      const result = await commands.handle(sessionId, command)
      return result.accepted
    },
    readFrom: (sessionId, after) => options.log.readFrom(sessionId, after),
    subscribe: (sessionId, listener) => options.log.subscribe(sessionId, listener),
    async readSession(sessionId) {
      const events = await options.log.read(sessionId)
      return buildSession(sessionId, events)
    },
    async readHistoryPage(sessionId, before, limit) {
      const events = await options.log.read(sessionId)
      const envelope = buildSession(sessionId, events)
      if (!envelope) {
        return undefined
      }
      const size = Math.min(HISTORY_PAGE_MAX, Math.max(HISTORY_PAGE_MIN, limit))
      return {
        ...sliceHistoryPage(envelope.session, before, size),
        seq: events.at(-1)?.seq ?? 0,
      }
    },
    async importSessions(items) {
      const imported = new Set(items.map((item) => item.id))
      for (const summary of await options.log.listSessions()) {
        if (!imported.has(summary.id)) {
          await options.log.deleteSession(summary.id)
        }
      }
      for (const item of items) {
        await options.log.writeSession(item.id, toImportEvents(item))
      }
      return await options.log.listSessions()
    },
    subscribeControl(listener) {
      listeners.add(listener)
      void currentFrame().then((frame) => {
        listener(frame)
      })
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
