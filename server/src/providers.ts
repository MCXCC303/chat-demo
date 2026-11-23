import { readFile } from 'node:fs/promises'
import { withLock, writeFileAtomic } from './atomic.ts'
import { API_KEY_REF, type CredentialInfo, type CredentialStore } from './credentials.ts'
import { homePath } from './home.ts'

export type ProviderModelProfile = {
  id: string
  name?: string
  input: ('text' | 'image')[]
}

export type ProviderProfile = {
  id: string
  displayName: string
  baseURL: string
  apiKeyRef: string
  selectedModel?: string
  models: ProviderModelProfile[]
}

export type ActiveSelection = {
  provider: string
  model: string
}

export type ProviderSummary = ProviderProfile & {
  builtin: boolean
  credential: CredentialInfo
}

export type ProviderResolver = (id?: string) => Promise<ProviderProfile>

export type ActiveResolver = () => Promise<ActiveSelection>

export const DEFAULT_PROVIDER_ID = 'deepseek-official'
export const DEFAULT_BASE_URL = 'https://api.deepseek.com'
export const DEFAULT_MODEL = 'deepseek-flash'

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const REF_PATTERN = /^[A-Z][A-Z0-9_]*$/

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderConfigError'
  }
}

export const builtinProviders = (defaultBaseURL: string): ProviderProfile[] => [
  {
    id: DEFAULT_PROVIDER_ID,
    displayName: 'DeepSeek',
    baseURL: defaultBaseURL,
    apiKeyRef: API_KEY_REF,
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', input: ['text', 'image'] },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', input: ['text'] },
    ],
  },
]

type ProviderDocument = {
  version: number
  providers: Record<string, ProviderProfile>
  activeProvider?: string
}

const emptyDocument = (): ProviderDocument => ({ version: 1, providers: {} })

const normalizeBaseURL = (value: string): string => {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) {
    throw new ProviderConfigError('base URL must not be empty')
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new ProviderConfigError(`base URL is not a valid URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderConfigError('base URL must use http or https')
  }
  return trimmed
}

const normalizeModel = (value: unknown): ProviderModelProfile => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderConfigError('model entry must be an object')
  }
  const record = value as Partial<ProviderModelProfile>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!id) {
    throw new ProviderConfigError('model id must not be empty')
  }
  const input = Array.isArray(record.input) ? record.input : []
  const modalities = input.filter(
    (item): item is 'text' | 'image' => item === 'text' || item === 'image'
  )
  if (!modalities.length) {
    throw new ProviderConfigError(`model ${id} must accept at least one input type`)
  }
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  return name ? { id, name, input: modalities } : { id, input: modalities }
}

export const normalizeProvider = (input: ProviderProfile): ProviderProfile => {
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!ID_PATTERN.test(id)) {
    throw new ProviderConfigError(
      `provider id must be lowercase letters, digits and dashes: ${id || '(empty)'}`
    )
  }
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : ''
  if (!displayName) {
    throw new ProviderConfigError('display name must not be empty')
  }
  const apiKeyRef = typeof input.apiKeyRef === 'string' ? input.apiKeyRef.trim() : ''
  if (!REF_PATTERN.test(apiKeyRef)) {
    throw new ProviderConfigError(
      `credential reference must be uppercase letters, digits and underscores: ${apiKeyRef || '(empty)'}`
    )
  }
  const models = Array.isArray(input.models) ? input.models.map(normalizeModel) : []
  const seen = new Set<string>()
  for (const model of models) {
    if (seen.has(model.id)) {
      throw new ProviderConfigError(`duplicate model id: ${model.id}`)
    }
    seen.add(model.id)
  }
  const selectedModel = typeof input.selectedModel === 'string' ? input.selectedModel.trim() : ''
  if (selectedModel && !seen.has(selectedModel)) {
    throw new ProviderConfigError(
      `selected model is not offered by provider ${id}: ${selectedModel}`
    )
  }
  return {
    id,
    displayName,
    baseURL: normalizeBaseURL(input.baseURL),
    apiKeyRef,
    ...(selectedModel ? { selectedModel } : {}),
    models,
  }
}

export class ProviderStore {
  private readonly home: string
  private readonly builtins: ProviderProfile[]

  constructor(home: string, options: { defaultBaseURL?: string } = {}) {
    this.home = home
    this.builtins = builtinProviders(options.defaultBaseURL ?? DEFAULT_BASE_URL)
  }

  get path(): string {
    return homePath(this.home, 'config', 'providers.json')
  }

  isBuiltin(id: string): boolean {
    return this.builtins.some((item) => item.id === id)
  }

  private async readDocument(): Promise<ProviderDocument> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch {
      return emptyDocument()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return emptyDocument()
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return emptyDocument()
    }
    const document = parsed as Partial<ProviderDocument>
    const providers: Record<string, ProviderProfile> = {}
    const stored = document.providers
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      for (const [key, value] of Object.entries(stored)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          continue
        }
        const record = value as Partial<ProviderProfile>
        if (
          typeof record.displayName !== 'string' ||
          typeof record.baseURL !== 'string' ||
          typeof record.apiKeyRef !== 'string' ||
          !Array.isArray(record.models)
        ) {
          continue
        }
        providers[key] = {
          id: typeof record.id === 'string' && record.id ? record.id : key,
          displayName: record.displayName,
          baseURL: record.baseURL,
          apiKeyRef: record.apiKeyRef,
          ...(typeof record.selectedModel === 'string' && record.selectedModel
            ? { selectedModel: record.selectedModel }
            : {}),
          models: record.models as ProviderModelProfile[],
        }
      }
    }
    return {
      version: 1,
      providers,
      ...(typeof document.activeProvider === 'string' && document.activeProvider
        ? { activeProvider: document.activeProvider }
        : {}),
    }
  }

  private async writeDocument(document: ProviderDocument): Promise<void> {
    await withLock(this.path, async () => {
      await writeFileAtomic(this.path, `${JSON.stringify(document, null, 2)}\n`)
    })
  }

  private merge(document: ProviderDocument): ProviderProfile[] {
    const result: ProviderProfile[] = []
    for (const builtin of this.builtins) {
      result.push(document.providers[builtin.id] ?? builtin)
    }
    for (const [id, profile] of Object.entries(document.providers)) {
      if (!this.builtins.some((item) => item.id === id)) {
        result.push(profile)
      }
    }
    return result
  }

  async list(): Promise<ProviderProfile[]> {
    return this.merge(await this.readDocument())
  }

  async read(id: string): Promise<ProviderProfile | undefined> {
    return (await this.list()).find((item) => item.id === id)
  }

  async write(profile: ProviderProfile): Promise<ProviderProfile> {
    const normalized = normalizeProvider(profile)
    const document = await this.readDocument()
    await this.writeDocument({
      ...document,
      providers: { ...document.providers, [normalized.id]: normalized },
    })
    return normalized
  }

  async remove(id: string): Promise<boolean> {
    if (this.isBuiltin(id)) {
      return false
    }
    const document = await this.readDocument()
    if (!document.providers[id]) {
      return false
    }
    const providers = Object.fromEntries(
      Object.entries(document.providers).filter(([key]) => key !== id)
    )
    await this.writeDocument({ ...document, providers })
    return true
  }

  async readActive(): Promise<ActiveSelection> {
    const document = await this.readDocument()
    const list = this.merge(document)
    const activeId =
      document.activeProvider && list.some((item) => item.id === document.activeProvider)
        ? document.activeProvider
        : (list[0]?.id ?? DEFAULT_PROVIDER_ID)
    const profile = list.find((item) => item.id === activeId)
    const model = profile?.selectedModel ?? profile?.models[0]?.id ?? DEFAULT_MODEL
    return { provider: activeId, model }
  }

  async writeActive(provider: string, model: string): Promise<ActiveSelection> {
    const document = await this.readDocument()
    const list = this.merge(document)
    const profile = list.find((item) => item.id === provider)
    if (!profile) {
      throw new ProviderConfigError(`unknown provider: ${provider}`)
    }
    const target = model.trim()
    if (!profile.models.some((item) => item.id === target)) {
      throw new ProviderConfigError(`unknown model for provider ${provider}: ${target}`)
    }
    const next: ProviderProfile = { ...profile, selectedModel: target }
    await this.writeDocument({
      ...document,
      activeProvider: provider,
      providers: { ...document.providers, [provider]: next },
    })
    return { provider, model: target }
  }
}

export const describeProvider = async (
  profile: ProviderProfile,
  builtin: boolean,
  credentials: CredentialStore
): Promise<ProviderSummary> => ({
  ...profile,
  builtin,
  credential: await credentials.describe(profile.apiKeyRef),
})
