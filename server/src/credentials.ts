import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { withLock, writeFileAtomic } from './atomic.ts'
import { homePath } from './home.ts'

export const API_KEY_REF = 'DEEPSEEK_API_KEY'

export type CredentialSource = 'store' | 'env' | 'project-env' | 'home-env'

export type CredentialInfo = {
  configured: boolean
  source?: CredentialSource
  writable: boolean
  masked?: string
}

export type CredentialRecord = {
  kind: 'api-key' | 'grant'
  payload: unknown
}

type CredentialDocument = {
  version: number
  refs: Record<string, string>
  records: Record<string, CredentialRecord>
}

const emptyDocument = (): CredentialDocument => ({ version: 1, refs: {}, records: {} })

const parseEnv = (text: string): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    const index = trimmed.indexOf('=')
    if (index <= 0) {
      continue
    }
    const key = trimmed.slice(0, index).trim()
    let value = trimmed.slice(index + 1).trim()
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    if (quoted && value.length >= 2) {
      value = value.slice(1, -1)
    }
    if (key) {
      result[key] = value
    }
  }
  return result
}

const readEnvFile = async (path: string): Promise<Record<string, string>> => {
  try {
    return parseEnv(await readFile(path, 'utf8'))
  } catch {
    return {}
  }
}

const maskValue = (value: string): string => {
  const separator = value.search(/[-_]/)
  const prefix = separator === -1 ? '' : value.slice(0, separator + 1)
  const secret = separator === -1 ? value : value.slice(separator + 1)
  const points = Array.from(secret)
  if (points.length < 8) {
    return '*'.repeat(Array.from(value).length)
  }
  return `${prefix}${points.slice(0, 5).join('')}…${points.slice(-4).join('')}`
}

export class CredentialStore {
  private readonly home: string
  private readonly launchEnv: Record<string, string | undefined>
  private readonly cwd: string

  constructor(
    home: string,
    options: { env?: Record<string, string | undefined>; cwd?: string } = {}
  ) {
    this.home = home
    this.launchEnv = options.env ?? process.env
    this.cwd = options.cwd ?? process.cwd()
  }

  get path(): string {
    return homePath(this.home, 'config', 'credentials.json')
  }

  private async readDocument(): Promise<CredentialDocument> {
    let text: string
    try {
      const info = await stat(this.path)
      if ((info.mode & 0o077) !== 0) {
        throw new Error(
          `credential file is readable by other users; refusing to load: ${this.path}; run chmod 600`
        )
      }
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyDocument()
      }
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`credential file is not valid JSON: ${this.path}`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`credential file has an invalid shape: ${this.path}`)
    }
    const document = parsed as Partial<CredentialDocument>
    return {
      version: typeof document.version === 'number' ? document.version : 1,
      refs: document.refs && typeof document.refs === 'object' ? document.refs : {},
      records:
        document.records && typeof document.records === 'object'
          ? (document.records as Record<string, CredentialRecord>)
          : {},
    }
  }

  private async writeDocument(document: CredentialDocument): Promise<void> {
    await writeFileAtomic(this.path, `${JSON.stringify(document, null, 2)}\n`, 0o600)
  }

  private async fallbackValue(
    ref: string
  ): Promise<{ value: string; source: CredentialSource } | undefined> {
    const fromLaunch = this.launchEnv[ref]
    if (fromLaunch !== undefined && fromLaunch.length > 0) {
      return { value: fromLaunch, source: 'env' }
    }
    const fromProject = await readEnvFile(join(this.cwd, '.env'))
    if (fromProject[ref]) {
      return { value: fromProject[ref], source: 'project-env' }
    }
    const fromHome = await readEnvFile(homePath(this.home, 'config', '.env'))
    if (fromHome[ref]) {
      return { value: fromHome[ref], source: 'home-env' }
    }
    return undefined
  }

  async resolve(ref: string): Promise<{ value: string; source: CredentialSource } | undefined> {
    const document = await this.readDocument()
    const stored = document.refs[ref]
    if (typeof stored === 'string' && stored.length > 0) {
      return { value: stored, source: 'store' }
    }
    return this.fallbackValue(ref)
  }

  async describe(ref: string): Promise<CredentialInfo> {
    const resolved = await this.resolve(ref)
    if (!resolved) {
      return { configured: false, writable: true }
    }
    return {
      configured: true,
      source: resolved.source,
      writable: true,
      masked: maskValue(resolved.value),
    }
  }

  async set(ref: string, value: string): Promise<void> {
    if (value.length === 0) {
      throw new Error('credential value must not be empty; unset it instead')
    }
    await withLock(this.path, async () => {
      const document = await this.readDocument()
      document.refs[ref] = value
      await this.writeDocument(document)
    })
  }

  private recordKey(owner: string, id: string): string {
    return `${owner}/${id}`
  }

  async readRecord(owner: string, id: string): Promise<CredentialRecord | undefined> {
    const document = await this.readDocument()
    return document.records[this.recordKey(owner, id)]
  }

  async modifyRecord(
    owner: string,
    id: string,
    change: (current: CredentialRecord | undefined) => CredentialRecord | undefined
  ): Promise<CredentialRecord | undefined> {
    const key = this.recordKey(owner, id)
    return withLock(this.path, async () => {
      const document = await this.readDocument()
      const next = change(document.records[key])
      const records = Object.fromEntries(
        Object.entries(document.records).filter(([recordKey]) => recordKey !== key)
      )
      document.records = next === undefined ? records : { ...records, [key]: next }
      await this.writeDocument(document)
      return next
    })
  }

  async unsetRecord(owner: string, id: string): Promise<void> {
    await this.modifyRecord(owner, id, () => undefined)
  }

  async unset(ref: string): Promise<void> {
    await withLock(this.path, async () => {
      const document = await this.readDocument()
      document.refs = Object.fromEntries(
        Object.entries(document.refs).filter(([key]) => key !== ref)
      )
      await this.writeDocument(document)
    })
  }
}
