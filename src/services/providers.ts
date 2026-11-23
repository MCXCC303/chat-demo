import { create } from 'zustand'
import { useBackend, type CredentialInfo } from './backend.js'
import { useSettings } from './settings.js'

export type ProviderModel = {
  id: string
  name?: string
  input: ('text' | 'image')[]
}

export type ProviderSummary = {
  id: string
  displayName: string
  baseURL: string
  apiKeyRef: string
  selectedModel?: string
  models: ProviderModel[]
  builtin: boolean
  credential: CredentialInfo
}

export type ActiveSelection = {
  provider: string
  model: string
}

export type ProviderProfilePatch = {
  displayName?: string
  baseURL?: string
}

type ProvidersState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  providers: ProviderSummary[]
  defaultId: string
  active: ActiveSelection
  error: string
}

export const DEFAULT_PROVIDER_ID = 'deepseek-official'

const LOCAL_PROVIDER: ProviderSummary = {
  id: DEFAULT_PROVIDER_ID,
  displayName: 'DeepSeek',
  baseURL: 'https://api.deepseek.com',
  apiKeyRef: 'DEEPSEEK_API_KEY',
  models: [
    { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', input: ['text', 'image'] },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', input: ['text'] },
  ],
  builtin: true,
  credential: { configured: false, writable: true },
}

export const useProviders = create<ProvidersState>(() => ({
  status: 'idle',
  providers: [],
  defaultId: DEFAULT_PROVIDER_ID,
  active: { provider: DEFAULT_PROVIDER_ID, model: 'deepseek-flash' },
  error: '',
}))

export class ProviderRequestError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ProviderRequestError'
    this.status = status
  }
}

const request = async (url: string, init?: RequestInit): Promise<unknown> => {
  const response = await fetch(url, { cache: 'no-store', ...init })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `请求失败：${response.status}`
    throw new ProviderRequestError(message, response.status)
  }
  return payload
}

const localProviders = (): ProviderSummary[] => {
  const apiKey = useSettings.getState().apiKey
  return [
    {
      ...LOCAL_PROVIDER,
      credential: {
        configured: Boolean(apiKey),
        writable: true,
        masked: apiKey ? '*'.repeat(apiKey.length) : undefined,
      },
    },
  ]
}

export const loadProviders = async (force = false): Promise<void> => {
  const state = useProviders.getState()
  if (!force && (state.status === 'loading' || state.status === 'ready')) {
    return
  }
  useProviders.setState({ status: 'loading', error: '' })
  if (useBackend.getState().mode !== 'server') {
    useProviders.setState({ status: 'ready', providers: localProviders(), error: '' })
    return
  }
  try {
    const payload = (await request('/api/providers')) as {
      defaultId?: string
      active?: ActiveSelection
      providers?: ProviderSummary[]
    }
    const providers = payload.providers ?? []
    useProviders.setState({
      status: 'ready',
      defaultId: payload.defaultId ?? DEFAULT_PROVIDER_ID,
      providers,
      active: payload.active ?? {
        provider: DEFAULT_PROVIDER_ID,
        model: providers[0]?.models[0]?.id ?? 'deepseek-flash',
      },
      error: '',
    })
  } catch (error) {
    useProviders.setState({
      status: 'error',
      providers: [],
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

const replaceProvider = (provider: ProviderSummary) => {
  const state = useProviders.getState()
  const providers = state.providers.map((item) => (item.id === provider.id ? provider : item))
  useProviders.setState({ providers })
  if (provider.id === state.active.provider && useBackend.getState().mode === 'server') {
    useBackend.setState({ credential: provider.credential })
  }
}

export const saveSelection = async (provider: string, model: string): Promise<void> => {
  if (useBackend.getState().mode !== 'server') {
    useProviders.setState({ active: { provider, model } })
    return
  }
  const payload = (await request('/api/providers/selection', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider, model }),
  })) as { active?: ActiveSelection }
  const active = payload.active ?? { provider, model }
  useProviders.setState({
    active,
    providers: useProviders
      .getState()
      .providers.map((item) =>
        item.id === active.provider ? { ...item, selectedModel: active.model } : item
      ),
  })
  const target = useProviders.getState().providers.find((item) => item.id === active.provider)
  if (target && useBackend.getState().mode === 'server') {
    useBackend.setState({ credential: target.credential })
  }
}

export const saveProviderProfile = async (
  id: string,
  patch: ProviderProfilePatch
): Promise<ProviderSummary> => {
  const provider = (await request(`/api/providers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })) as ProviderSummary
  replaceProvider(provider)
  return provider
}

export const saveProviderKey = async (id: string, value: string): Promise<ProviderSummary> => {
  const provider = (await request(`/api/providers/${encodeURIComponent(id)}/credential`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value }),
  })) as ProviderSummary
  replaceProvider(provider)
  return provider
}

export const removeProviderKey = async (id: string): Promise<ProviderSummary> => {
  const provider = (await request(`/api/providers/${encodeURIComponent(id)}/credential`, {
    method: 'DELETE',
  })) as ProviderSummary
  replaceProvider(provider)
  return provider
}
