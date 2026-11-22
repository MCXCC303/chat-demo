import { createHash } from 'node:crypto'
import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withLock, writeFileAtomic } from './atomic.ts'
import { homePath } from './home.ts'

export type SessionEnvelope = {
  schemaVersion: number
  session: unknown
  summary: unknown
  updatedAt: string
}

export type SessionListEntry = {
  id: string
  summary: unknown
  updatedAt: string
}

export type FileEntry = {
  hash: string
  name: string
  mimeType: string
  size: number
}

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

export const assertValidId = (id: string): string => {
  if (!ID_PATTERN.test(id)) {
    throw new Error(`invalid id: ${id}`)
  }
  return id
}

export class Storage {
  private readonly home: string

  constructor(home: string) {
    this.home = home
  }

  get sessionsDir(): string {
    return homePath(this.home, 'data', 'sessions')
  }

  get filesDir(): string {
    return homePath(this.home, 'data', 'files')
  }

  get filesIndexPath(): string {
    return join(this.filesDir, 'index.json')
  }

  get settingsPath(): string {
    return homePath(this.home, 'config', 'settings.json')
  }

  private sessionPath(id: string): string {
    return join(this.sessionsDir, `${assertValidId(id)}.json`)
  }

  private async readJson<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T
    } catch {
      return undefined
    }
  }

  async listSessions(): Promise<SessionListEntry[]> {
    let names: string[]
    try {
      names = await readdir(this.sessionsDir)
    } catch {
      return []
    }
    const entries: SessionListEntry[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue
      }
      const id = name.slice(0, -'.json'.length)
      const envelope = await this.readJson<SessionEnvelope>(join(this.sessionsDir, name))
      if (!envelope) {
        continue
      }
      entries.push({ id, summary: envelope.summary, updatedAt: envelope.updatedAt })
    }
    return entries
  }

  async readSession(id: string): Promise<SessionEnvelope | undefined> {
    return this.readJson<SessionEnvelope>(this.sessionPath(id))
  }

  async writeSession(id: string, envelope: SessionEnvelope): Promise<void> {
    const path = this.sessionPath(id)
    await withLock(path, async () => {
      await writeFileAtomic(path, `${JSON.stringify(envelope)}\n`)
    })
  }

  async replaceSessions(items: { id: string; envelope: SessionEnvelope }[]): Promise<void> {
    await withLock(this.sessionsDir, async () => {
      let names: string[] = []
      try {
        names = await readdir(this.sessionsDir)
      } catch {
        names = []
      }
      for (const name of names) {
        if (name.endsWith('.json')) {
          await rm(join(this.sessionsDir, name), { force: true })
        }
      }
      for (const item of items) {
        await writeFileAtomic(this.sessionPath(item.id), `${JSON.stringify(item.envelope)}\n`)
      }
    })
  }

  async deleteSession(id: string): Promise<void> {
    const path = this.sessionPath(id)
    await withLock(path, async () => {
      await rm(path, { force: true })
    })
  }

  async readSettings(): Promise<unknown> {
    return (await this.readJson<unknown>(this.settingsPath)) ?? {}
  }

  async writeSettings(value: unknown): Promise<void> {
    const path = this.settingsPath
    await withLock(path, async () => {
      await writeFileAtomic(path, `${JSON.stringify(value)}\n`)
    })
  }

  private async readFileIndex(): Promise<Record<string, FileEntry>> {
    return (await this.readJson<Record<string, FileEntry>>(this.filesIndexPath)) ?? {}
  }

  async putFile(id: string, name: string, mimeType: string, data: Uint8Array): Promise<FileEntry> {
    assertValidId(id)
    const hash = createHash('sha256').update(data).digest('hex')
    const contentPath = join(this.filesDir, hash)
    const entry: FileEntry = { hash, name, mimeType, size: data.byteLength }
    await writeFileAtomic(contentPath, data)
    const indexPath = this.filesIndexPath
    await withLock(indexPath, async () => {
      const index = await this.readFileIndex()
      index[id] = entry
      await writeFileAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`)
    })
    return entry
  }

  async readFile(id: string): Promise<{ entry: FileEntry; data: Uint8Array } | undefined> {
    assertValidId(id)
    const index = await this.readFileIndex()
    const entry = index[id]
    if (!entry) {
      return undefined
    }
    try {
      const data = new Uint8Array(await readFile(join(this.filesDir, entry.hash)))
      return { entry, data }
    } catch {
      return undefined
    }
  }

  async deleteFile(id: string): Promise<void> {
    assertValidId(id)
    const indexPath = this.filesIndexPath
    await withLock(indexPath, async () => {
      const index = await this.readFileIndex()
      const next = Object.fromEntries(Object.entries(index).filter(([key]) => key !== id))
      await writeFileAtomic(indexPath, `${JSON.stringify(next, null, 2)}\n`)
    })
  }
}
