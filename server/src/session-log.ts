import { appendFile, mkdir, open, readFile, readdir, rm, stat, truncate } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import type { SessionSummary } from '../../src/services/chat/types.ts'
import type { SessionEvent, SessionEventType } from '../../src/services/session/types.ts'
import { withLock } from './atomic.ts'
import { homePath } from './home.ts'
import { isSessionEvent, type SessionLog } from './session-events.ts'
import { SessionIndex, type SessionIndexRecord } from './session-index.ts'
import { assertValidId } from './storage.ts'

export type SessionLogOptions = {
  home: string
  sessionsDir?: string
}

type Listener = (event: SessionEvent) => void

const TAIL_BYTES = 64 * 1024

const assertSessionId = (id: string): string => {
  const checked = assertValidId(id)
  if (checked === '.' || checked === '..') {
    throw new Error(`invalid session id: ${id}`)
  }
  return checked
}

const parseEvents = (buffer: Uint8Array | Buffer): SessionEvent[] => {
  const events: SessionEvent[] = []
  for (const part of new TextDecoder().decode(buffer).split('\n')) {
    const line = part.trim()
    if (!line) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (isSessionEvent(parsed)) {
      events.push(parsed)
    }
  }
  return events
}

const readTail = async (path: string, size: number): Promise<Uint8Array> => {
  const length = Math.min(size, TAIL_BYTES)
  const buffer = new Uint8Array(length)
  const handle = await open(path, 'r')
  try {
    await handle.read(buffer, 0, length, size - length)
  } finally {
    await handle.close()
  }
  return buffer
}

export class SessionLogStore implements SessionLog {
  private readonly sessionsDir: string
  private readonly index: SessionIndex
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly deliveries = new Map<string, Promise<void>>()

  constructor(options: SessionLogOptions) {
    this.sessionsDir = options.sessionsDir ?? homePath(options.home, 'data', 'sessions')
    this.index = new SessionIndex(this.sessionsDir)
  }

  get root(): string {
    return this.sessionsDir
  }

  sessionDir(id: string): string {
    return join(this.sessionsDir, assertSessionId(id))
  }

  logPath(id: string): string {
    return join(this.sessionDir(id), 'log.jsonl')
  }

  async append(sessionId: string, type: SessionEventType, payload: unknown): Promise<number> {
    const id = assertSessionId(sessionId)
    const path = this.logPath(id)
    return withLock(path, async () => {
      await mkdir(this.sessionDir(id), { recursive: true, mode: 0o700 })
      const seq = await this.reserveSeq(path)
      const event: SessionEvent = { seq, type, payload }
      await appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 })
      if (type === 'session/meta') {
        await this.applyMeta(id, payload)
      }
      this.scheduleDelivery(id, event)
      return seq
    })
  }

  async read(sessionId: string): Promise<SessionEvent[]> {
    const id = assertSessionId(sessionId)
    const events = await this.readEvents(this.logPath(id))
    return events.sort((left, right) => left.seq - right.seq)
  }

  async readFrom(sessionId: string, after: number): Promise<SessionEvent[]> {
    const events = await this.read(sessionId)
    return events.filter((event) => event.seq > after)
  }

  subscribe(sessionId: string, listener: Listener): () => void {
    const id = assertSessionId(sessionId)
    const group = this.listeners.get(id) ?? new Set<Listener>()
    group.add(listener)
    this.listeners.set(id, group)
    return () => {
      group.delete(listener)
      if (group.size === 0) {
        this.listeners.delete(id)
      }
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    const ids = await this.scanSessionIds()
    await this.index.load()
    for (const id of ids) {
      const mtime = await this.logMtime(id)
      const record = this.index.get(id)
      if (record && record.logMtime === mtime) {
        continue
      }
      const meta = await this.deriveMeta(id)
      if (meta.deleted) {
        this.index.remove(id)
        continue
      }
      this.index.set({ ...meta.record, logMtime: mtime })
    }
    for (const id of this.index.ids()) {
      if (!ids.includes(id)) {
        this.index.remove(id)
      }
    }
    await this.index.save()
    return this.index.list().sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async deleteSession(sessionId: string): Promise<void> {
    const id = assertSessionId(sessionId)
    const events = await this.read(id)
    const last = events[events.length - 1]
    if (!last || last.type !== 'session/deleted') {
      await this.append(id, 'session/deleted', { sessionId: id })
    }
    await rm(this.sessionDir(id), { recursive: true, force: true })
    await this.index.load()
    this.index.remove(id)
    await this.index.save()
  }

  private async readEvents(path: string): Promise<SessionEvent[]> {
    let buffer: Buffer
    try {
      buffer = await readFile(path)
    } catch {
      return []
    }
    return parseEvents(buffer)
  }

  private async reserveSeq(path: string): Promise<number> {
    let size = 0
    try {
      size = (await stat(path)).size
    } catch {
      return 1
    }
    if (size === 0) {
      return 1
    }
    const tail = await readTail(path, size)
    let end = tail.length
    if (tail[end - 1] !== 0x0a) {
      const lastNewline = tail.lastIndexOf(0x0a)
      const keep = lastNewline === -1 ? 0 : size - tail.length + lastNewline + 1
      await truncate(path, keep)
      if (keep === 0) {
        return 1
      }
      end = lastNewline + 1
    }
    let start = end - 1
    while (start > 0 && tail[start - 1] !== 0x0a) {
      start -= 1
    }
    const line = new TextDecoder().decode(tail.subarray(start, end - 1)).trim()
    if (!line) {
      return 1
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      const events = await this.readEvents(path)
      let highest = 0
      for (const event of events) {
        if (event.seq > highest) {
          highest = event.seq
        }
      }
      return highest + 1
    }
    const event = parsed as Partial<SessionEvent>
    return typeof event.seq === 'number' ? event.seq + 1 : 1
  }

  private scheduleDelivery(id: string, event: SessionEvent): void {
    const previous = this.deliveries.get(id) ?? Promise.resolve()
    const next = previous.then(
      () => this.deliver(id, event),
      () => this.deliver(id, event)
    )
    this.deliveries.set(
      id,
      next.then(
        () => undefined,
        () => undefined
      )
    )
  }

  private deliver(id: string, event: SessionEvent): void {
    const group = this.listeners.get(id)
    if (!group) {
      return
    }
    for (const listener of [...group]) {
      try {
        listener(event)
      } catch {
        continue
      }
    }
  }

  private async applyMeta(id: string, payload: unknown): Promise<void> {
    if (typeof payload !== 'object' || payload === null) {
      return
    }
    const meta = payload as Partial<SessionSummary>
    await this.index.load()
    const current = this.index.get(id)
    const now = Date.now()
    this.index.set({
      id,
      title: typeof meta.title === 'string' ? meta.title : (current?.title ?? ''),
      pinned: typeof meta.pinned === 'boolean' ? meta.pinned : (current?.pinned ?? false),
      createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : (current?.createdAt ?? now),
      updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : now,
      logMtime: await this.logMtime(id),
    })
    await this.index.save()
  }

  private async deriveMeta(id: string): Promise<{ record: SessionIndexRecord; deleted: boolean }> {
    const events = await this.readEvents(this.logPath(id))
    let record: SessionIndexRecord = {
      id,
      title: '',
      pinned: false,
      createdAt: 0,
      updatedAt: 0,
      logMtime: 0,
    }
    let deleted = false
    for (const event of events) {
      if (event.type === 'session/deleted') {
        deleted = true
        continue
      }
      if (event.type !== 'session/meta') {
        continue
      }
      if (typeof event.payload !== 'object' || event.payload === null) {
        continue
      }
      const meta = event.payload as Partial<SessionSummary>
      record = {
        ...record,
        title: typeof meta.title === 'string' ? meta.title : record.title,
        pinned: typeof meta.pinned === 'boolean' ? meta.pinned : record.pinned,
        createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : record.createdAt,
        updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : record.updatedAt,
      }
    }
    if (record.createdAt === 0 || record.updatedAt === 0) {
      let mtime = 0
      try {
        mtime = (await stat(this.logPath(id))).mtimeMs
      } catch {
        mtime = 0
      }
      record = {
        ...record,
        createdAt: record.createdAt === 0 ? mtime : record.createdAt,
        updatedAt: record.updatedAt === 0 ? mtime : record.updatedAt,
      }
    }
    return { record, deleted }
  }

  private async logMtime(id: string): Promise<number> {
    try {
      return (await stat(this.logPath(id))).mtimeMs
    } catch {
      return 0
    }
  }

  private async scanSessionIds(): Promise<string[]> {
    let entries: Dirent[]
    try {
      entries = await readdir(this.sessionsDir, { withFileTypes: true })
    } catch {
      return []
    }
    const ids: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      try {
        const info = await stat(join(this.sessionsDir, entry.name, 'log.jsonl'))
        if (info.isFile()) {
          ids.push(entry.name)
        }
      } catch {
        continue
      }
    }
    return ids
  }
}
