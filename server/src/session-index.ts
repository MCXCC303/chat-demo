import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionSummary } from '../../src/services/chat/types.ts'
import { withLock, writeFileAtomic } from './atomic.ts'

export type SessionIndexRecord = SessionSummary & {
  logMtime: number
}

type IndexFile = {
  version: number
  sessions: SessionIndexRecord[]
}

const INDEX_VERSION = 1

const normalize = (record: SessionIndexRecord): SessionIndexRecord => ({
  id: record.id,
  title: typeof record.title === 'string' ? record.title : '',
  pinned: record.pinned === true,
  createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
  updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
  logMtime: typeof record.logMtime === 'number' ? record.logMtime : 0,
})

export class SessionIndex {
  private readonly path: string
  private readonly records = new Map<string, SessionIndexRecord>()
  private loading: Promise<void> | undefined
  private dirty = false

  constructor(sessionsDir: string) {
    this.path = join(sessionsDir, 'index.json')
  }

  get filePath(): string {
    return this.path
  }

  async load(): Promise<void> {
    this.loading ??= this.readFromDisk()
    await this.loading
  }

  has(id: string): boolean {
    return this.records.has(id)
  }

  get(id: string): SessionIndexRecord | undefined {
    const record = this.records.get(id)
    return record ? { ...record } : undefined
  }

  set(record: SessionIndexRecord): void {
    this.records.set(record.id, normalize(record))
    this.dirty = true
  }

  remove(id: string): void {
    if (this.records.delete(id)) {
      this.dirty = true
    }
  }

  ids(): string[] {
    return [...this.records.keys()]
  }

  list(): SessionSummary[] {
    return [...this.records.values()].map((record) => ({
      id: record.id,
      title: record.title,
      pinned: record.pinned,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }))
  }

  async save(): Promise<void> {
    await withLock(this.path, async () => {
      if (!this.dirty) {
        return
      }
      const sessions = [...this.records.values()]
      await writeFileAtomic(
        this.path,
        `${JSON.stringify({ version: INDEX_VERSION, sessions }, null, 2)}\n`
      )
      this.dirty = false
    })
  }

  private async readFromDisk(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch {
      return
    }
    let parsed: IndexFile
    try {
      parsed = JSON.parse(text) as IndexFile
    } catch {
      return
    }
    if (!Array.isArray(parsed.sessions)) {
      return
    }
    for (const record of parsed.sessions) {
      if (record && typeof record.id === 'string') {
        this.records.set(record.id, normalize(record))
      }
    }
  }
}
