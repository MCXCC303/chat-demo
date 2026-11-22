import type { ChatRepository, StoredFile } from './repository.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

const SESSION_SCHEMA_VERSION = 1

type SessionPayload = {
  schemaVersion: number
  session: Session
  summary: SessionSummary
}

const request = async (path: string, init?: RequestInit): Promise<Response> => {
  const response = await fetch(path, { cache: 'no-store', ...init })
  if (!response.ok) {
    throw new Error(`存储请求失败：${response.status}`)
  }
  return response
}

const requestJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await request(path, init)
  return (await response.json()) as T
}

const sessionPayload = (session: Session): SessionPayload => ({
  schemaVersion: SESSION_SCHEMA_VERSION,
  session,
  summary: toSessionSummary(session),
})

const putSession = async (session: Session): Promise<void> => {
  await request(`/api/sessions/${encodeURIComponent(session.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sessionPayload(session)),
  })
}

const putFiles = async (files: StoredFile[]): Promise<void> => {
  for (const file of files) {
    await request('/api/files', {
      method: 'POST',
      headers: {
        'x-file-id': file.id,
        'x-file-name': encodeURIComponent(file.id),
        'x-file-type': file.blob.type || 'application/octet-stream',
      },
      body: file.blob,
    })
  }
}

let stagedSessions = new Map<string, Session>()
let stagedFiles = new Map<string, Blob>()

export const httpRepository: ChatRepository = {
  async loadSessionSummaries() {
    const body = await requestJson<{ sessions: { id: string; summary: SessionSummary }[] }>(
      '/api/sessions'
    )
    return body.sessions.map((entry) => entry.summary)
  },

  async loadSession(id) {
    const body = await requestJson<{ session: Session }>(`/api/sessions/${encodeURIComponent(id)}`)
    return body.session
  },

  async saveSession(session, files = []) {
    await putFiles(files)
    await putSession(session)
  },

  async renameSession(id, title) {
    const session = await httpRepository.loadSession(id)
    if (!session) {
      return
    }
    await putSession({ ...session, title })
  },

  async setSessionPinned(id, pinned) {
    const session = await httpRepository.loadSession(id)
    if (!session) {
      return
    }
    await putSession({ ...session, pinned })
  },

  async deleteSession(id) {
    await request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  async loadFile(id) {
    const response = await fetch(`/api/files/${encodeURIComponent(id)}`, { cache: 'no-store' })
    if (!response.ok) {
      return undefined
    }
    return await response.blob()
  },

  async clearStaging() {
    stagedSessions = new Map()
    stagedFiles = new Map()
  },

  async addStagingSession(session) {
    stagedSessions.set(session.id, session)
  },

  async saveStagingFiles(files) {
    for (const file of files) {
      stagedFiles.set(file.id, file.blob)
    }
  },

  async updateStagingFileTypes(types) {
    for (const session of stagedSessions.values()) {
      for (const message of session.messages) {
        if (message.role !== 'user') {
          continue
        }
        for (const file of message.files) {
          file.mimeType = types.get(file.id) ?? ''
        }
      }
    }
  },

  async commitStaging() {
    const sessions = [...stagedSessions.values()]
    await putFiles([...stagedFiles].map(([id, blob]) => ({ id, blob })))
    const body = await requestJson<{ sessions: { summary: SessionSummary }[] }>(
      '/api/sessions/replace',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessions: sessions.map(sessionPayload) }),
      }
    )
    stagedSessions = new Map()
    stagedFiles = new Map()
    return body.sessions.map((entry) => entry.summary)
  },
}
