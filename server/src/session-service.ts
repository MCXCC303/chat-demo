import type { SessionSummary } from '../../src/services/chat/types.js'
import type { ControlEventType } from '../../src/services/session/types.js'
import { readServerSettings } from './agent.ts'
import { SessionCommands } from './commands.ts'
import type { CredentialStore } from './credentials.ts'
import type { SessionLog, SessionService } from './session-events.ts'
import type { Storage } from './storage.ts'

export type SessionServiceOptions = {
  log: SessionLog
  upstream: string
  credentials: CredentialStore
  storage: Storage
}

export type ControlFrame = {
  seq: number
  type: ControlEventType
  payload: unknown
}

const CONTROL_POLL_INTERVAL = 2000

export const createSessionService = (options: SessionServiceOptions): SessionService => {
  const commands = new SessionCommands({
    log: options.log,
    upstream: options.upstream,
    credentials: options.credentials,
    settings: {
      read: async () => readServerSettings(await options.storage.readSettings()),
    },
  })
  const listeners = new Set<(frame: ControlFrame) => void>()
  let controlSeq = 0
  let lastSnapshot = ''

  const currentFrame = async (): Promise<ControlFrame> => {
    const sessions = await options.log.listSessions()
    const serialized = JSON.stringify(sessions)
    if (serialized !== lastSnapshot) {
      lastSnapshot = serialized
      controlSeq += 1
    }
    return { seq: controlSeq, type: 'sessions/snapshot', payload: { sessions } }
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
    async handle(sessionId, command) {
      const result = await commands.handle(sessionId, command)
      return result.accepted
    },
    readFrom: (sessionId, after) => options.log.readFrom(sessionId, after),
    subscribe: (sessionId, listener) => options.log.subscribe(sessionId, listener),
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
