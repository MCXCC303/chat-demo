import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SessionCommand } from '../../src/services/session/types.js'
import type { SessionEvent } from '../../src/services/session/types.js'
import type { LegacySessionEnvelope } from './commands.js'
import type { SessionService } from './session-events.js'

const HEARTBEAT_INTERVAL = 15000

const sendJson = (res: ServerResponse, status: number, value: unknown): void => {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

const readBody = async (req: IncomingMessage): Promise<string> => {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of req) {
    const bytes =
      typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk)
    text += decoder.decode(bytes, { stream: true })
  }
  return text + decoder.decode()
}

const writeFrame = (res: ServerResponse, seq: number, type: string, payload: unknown): void => {
  if (res.writableEnded) {
    return
  }
  res.write(`id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ seq, payload })}\n\n`)
}

const openStream = (res: ServerResponse): void => {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
}

export type SessionRoutes = {
  list: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  stream: (
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    after: number
  ) => Promise<void>
  commands: (req: IncomingMessage, res: ServerResponse, sessionId: string) => Promise<void>
  control: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  readSession: (req: IncomingMessage, res: ServerResponse, sessionId: string) => Promise<void>
  replace: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

export const createSessionRoutes = (service: SessionService): SessionRoutes => ({
  async list(_req, res) {
    sendJson(res, 200, { sessions: await service.listSessions() })
  },

  async stream(_req, res, sessionId, after) {
    openStream(res)
    let cursor = after
    const pending: SessionEvent[] = []
    let replaying = true
    const deliver = (event: SessionEvent) => {
      if (event.seq <= cursor) {
        return
      }
      cursor = event.seq
      writeFrame(res, event.seq, event.type, event.payload)
    }
    const unsubscribe = service.subscribe(sessionId, (event) => {
      if (replaying) {
        pending.push(event)
        return
      }
      deliver(event)
    })
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': ping\n\n')
      }
    }, HEARTBEAT_INTERVAL)
    res.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
    for (const event of await service.readFrom(sessionId, after)) {
      deliver(event)
    }
    replaying = false
    for (const event of pending) {
      deliver(event)
    }
  },

  async commands(req, res, sessionId) {
    const text = await readBody(req)
    let command: SessionCommand
    try {
      command = JSON.parse(text) as SessionCommand
    } catch {
      sendJson(res, 400, { error: 'invalid command' })
      return
    }
    const accepted = await service.handle(sessionId, command)
    sendJson(res, 200, { accepted })
  },

  async readSession(_req, res, sessionId) {
    const envelope = await service.readSession(sessionId)
    if (!envelope) {
      sendJson(res, 404, { error: 'session not found' })
      return
    }
    sendJson(res, 200, envelope)
  },

  async replace(req, res) {
    const text = await readBody(req)
    let body: { clear?: unknown; sessions?: unknown }
    try {
      body = JSON.parse(text) as { clear?: unknown; sessions?: unknown }
    } catch {
      sendJson(res, 400, { error: 'invalid body' })
      return
    }
    const entries = body.sessions
    if (!Array.isArray(entries)) {
      sendJson(res, 400, { error: 'sessions must be an array' })
      return
    }
    if (entries.length === 0 && body.clear !== true) {
      sendJson(res, 400, { error: 'refusing to clear history without an explicit request' })
      return
    }
    const items: LegacySessionEnvelope[] = []
    for (const entry of entries) {
      const record = (entry ?? {}) as {
        id?: unknown
        schemaVersion?: unknown
        session?: unknown
        summary?: unknown
      }
      const session = record.session as { id?: unknown } | undefined
      const id =
        typeof record.id === 'string'
          ? record.id
          : typeof session?.id === 'string'
            ? session.id
            : undefined
      if (id === undefined) {
        sendJson(res, 400, { error: 'every session entry needs an id' })
        return
      }
      items.push({
        id,
        schemaVersion: typeof record.schemaVersion === 'number' ? record.schemaVersion : 1,
        session: (record.session ?? {}) as LegacySessionEnvelope['session'],
        summary: record.summary,
      })
    }
    sendJson(res, 200, { sessions: await service.importSessions(items) })
  },

  async control(_req, res) {
    openStream(res)
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': ping\n\n')
      }
    }, HEARTBEAT_INTERVAL)
    const unsubscribe = service.subscribeControl((frame) => {
      writeFrame(res, frame.seq, frame.type, frame.payload)
    })
    res.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  },
})
