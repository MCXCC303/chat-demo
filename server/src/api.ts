import type { IncomingMessage, ServerResponse } from 'node:http'
import { API_KEY_REF, type CredentialStore } from './credentials.ts'
import { homeDisplay } from './home.ts'
import type { SessionEnvelope, Storage } from './storage.ts'

const sendJson = (res: ServerResponse, status: number, value: unknown): void => {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

const readBody = async (req: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> => {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk))
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
  const raw = await readBody(req)
  if (raw.byteLength === 0) {
    return undefined
  }
  return JSON.parse(new TextDecoder().decode(raw))
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name.toLowerCase()]
  return typeof value === 'string' ? value : undefined
}

export type ApiOptions = {
  storage: Storage
  credentials: CredentialStore
  home: string
  version: string
  upstream: string
}

export const createApi =
  (options: ApiOptions) =>
  async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const { storage, credentials } = options
    const method = req.method ?? 'GET'

    if (path === '/api/status' && method === 'GET') {
      sendJson(res, 200, {
        version: options.version,
        mode: 'server',
        storage: 'server',
        home: homeDisplay(options.home),
        credential: await credentials.describe(API_KEY_REF),
      })
      return
    }

    if (path === '/api/credential') {
      if (method === 'GET') {
        sendJson(res, 200, await credentials.describe(API_KEY_REF))
        return
      }
      if (method === 'PUT') {
        const body = (await readJsonBody(req)) as { value?: unknown } | undefined
        const value = typeof body?.value === 'string' ? body.value.trim() : ''
        if (!value) {
          sendJson(res, 400, { error: 'credential value must not be empty' })
          return
        }
        await credentials.set(API_KEY_REF, value)
        sendJson(res, 200, await credentials.describe(API_KEY_REF))
        return
      }
      if (method === 'DELETE') {
        await credentials.unset(API_KEY_REF)
        sendJson(res, 200, await credentials.describe(API_KEY_REF))
        return
      }
    }

    if (path === '/api/credential/verify' && method === 'POST') {
      const body = (await readJsonBody(req)) as { value?: unknown } | undefined
      const candidate =
        typeof body?.value === 'string' && body.value.trim().length > 0
          ? body.value.trim()
          : undefined
      const credential = candidate
        ? { value: candidate, source: 'store' as const }
        : await credentials.resolve(API_KEY_REF)
      if (!credential) {
        sendJson(res, 400, { error: `${API_KEY_REF} is not configured` })
        return
      }
      try {
        const response = await fetch(new URL('/models', options.upstream), {
          headers: { 'x-api-key': credential.value, authorization: `Bearer ${credential.value}` },
        })
        if (response.ok) {
          sendJson(res, 200, { ok: true })
          return
        }
        const text = await response.text().catch(() => '')
        sendJson(res, 200, { ok: false, status: response.status, message: text })
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          status: 0,
          message: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }

    if (path === '/api/settings') {
      if (method === 'GET') {
        sendJson(res, 200, await storage.readSettings())
        return
      }
      if (method === 'PUT') {
        const body = await readJsonBody(req)
        await storage.writeSettings(body ?? {})
        sendJson(res, 200, body ?? {})
        return
      }
    }

    if (path === '/api/sessions' && method === 'GET') {
      sendJson(res, 200, { sessions: await storage.listSessions() })
      return
    }

    if (path === '/api/sessions/replace' && method === 'POST') {
      const body = (await readJsonBody(req)) as
        | {
            sessions?: {
              id?: unknown
              schemaVersion?: unknown
              session?: unknown
              summary?: unknown
            }[]
          }
        | undefined
      const updatedAt = new Date().toISOString()
      const items = (body?.sessions ?? []).flatMap((entry) => {
        if (typeof entry.id !== 'string') {
          return []
        }
        return [
          {
            id: entry.id,
            envelope: {
              schemaVersion: typeof entry.schemaVersion === 'number' ? entry.schemaVersion : 1,
              session: entry.session,
              summary: entry.summary,
              updatedAt,
            },
          },
        ]
      })
      await storage.replaceSessions(items)
      sendJson(res, 200, {
        sessions: items.map((item) => ({
          id: item.id,
          summary: item.envelope.summary,
          updatedAt: item.envelope.updatedAt,
        })),
      })
      return
    }

    if (path.startsWith('/api/sessions/')) {
      const id = decodeURIComponent(path.slice('/api/sessions/'.length))
      if (method === 'GET') {
        const envelope = await storage.readSession(id)
        if (!envelope) {
          sendJson(res, 404, { error: 'session not found' })
          return
        }
        sendJson(res, 200, envelope)
        return
      }
      if (method === 'PUT') {
        const body = (await readJsonBody(req)) as Partial<SessionEnvelope> | undefined
        if (!body || typeof body !== 'object') {
          sendJson(res, 400, { error: 'invalid session document' })
          return
        }
        const envelope: SessionEnvelope = {
          schemaVersion: typeof body.schemaVersion === 'number' ? body.schemaVersion : 1,
          session: body.session,
          summary: body.summary,
          updatedAt: new Date().toISOString(),
        }
        await storage.writeSession(id, envelope)
        sendJson(res, 200, envelope)
        return
      }
      if (method === 'DELETE') {
        await storage.deleteSession(id)
        sendJson(res, 200, { ok: true })
        return
      }
    }

    if (path === '/api/files' && method === 'POST') {
      const id = header(req, 'x-file-id')
      const name = decodeURIComponent(header(req, 'x-file-name') ?? 'file')
      const mimeType = header(req, 'x-file-type') ?? 'application/octet-stream'
      if (!id) {
        sendJson(res, 400, { error: 'missing file id' })
        return
      }
      const data = await readBody(req)
      const entry = await storage.putFile(id, name, mimeType, data)
      sendJson(res, 200, entry)
      return
    }

    if (path.startsWith('/api/files/')) {
      const id = decodeURIComponent(path.slice('/api/files/'.length))
      if (method === 'GET') {
        const found = await storage.readFile(id)
        if (!found) {
          sendJson(res, 404, { error: 'file not found' })
          return
        }
        res.writeHead(200, {
          'content-type': found.entry.mimeType || 'application/octet-stream',
          'content-length': found.data.byteLength,
          'cache-control': 'no-store',
        })
        res.end(Buffer.from(found.data))
        return
      }
      if (method === 'DELETE') {
        await storage.deleteFile(id)
        sendJson(res, 200, { ok: true })
        return
      }
    }

    sendJson(res, 404, { error: 'unknown endpoint' })
  }
