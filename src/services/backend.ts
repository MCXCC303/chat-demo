import { create } from 'zustand'

export type BackendMode = 'server' | 'standalone'

export type CredentialInfo = {
  configured: boolean
  source?: string
  writable: boolean
  masked?: string
}

type BackendState = {
  mode: BackendMode
  home: string
  version: string
  credential: CredentialInfo | null
}

export const useBackend = create<BackendState>(() => ({
  mode: 'standalone',
  home: '',
  version: '',
  credential: null,
}))

const readJson = async (url: string, init?: RequestInit): Promise<unknown> => {
  const response = await fetch(url, { cache: 'no-store', ...init })
  if (!response.ok) {
    throw new Error(`请求失败：${response.status}`)
  }
  return response.json()
}

export const detectBackend = async (): Promise<void> => {
  try {
    const config = (await readJson('/config.json')) as {
      mode?: string
      home?: string
      version?: string
    }
    if (config.mode !== 'server') {
      return
    }
    const status = (await readJson('/api/status')) as {
      version: string
      home: string
      credential: CredentialInfo
    }
    useBackend.setState({
      mode: 'server',
      home: status.home,
      version: status.version,
      credential: status.credential,
    })
  } catch {
    useBackend.setState({ mode: 'standalone', credential: null })
  }
}
