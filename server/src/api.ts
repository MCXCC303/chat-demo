import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CredentialStore } from './credentials.ts'
import { homeDisplay } from './home.ts'
import {
  DEFAULT_PROVIDER_ID,
  describeProvider,
  type ProviderProfile,
  type ProviderStore,
} from './providers.ts'
import type { Storage } from './storage.ts'
import type { SessionService } from './session-events.ts'
import { createSessionRoutes } from './session-routes.ts'

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

const verifyProviderKey = async (
  baseURL: string,
  value: string
): Promise<{ ok: true } | { ok: false; status: number; message: string }> => {
  try {
    const response = await fetch(new URL('/models', baseURL), {
      headers: { 'x-api-key': value, authorization: `Bearer ${value}` },
    })
    if (response.ok) {
      return { ok: true }
    }
    const text = await response.text().catch(() => '')
    return { ok: false, status: response.status, message: text }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export type ApiOptions = {
  storage: Storage
  credentials: CredentialStore
  sessions: SessionService
  providers: ProviderStore
  home: string
  version: string
}

export const createApi =
  (options: ApiOptions) =>
  async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const { storage, credentials, providers } = options
    const method = req.method ?? 'GET'

    if (path === '/api/status' && method === 'GET') {
      const active = await providers.readActive()
      const fallback = await providers.read(active.provider)
      sendJson(res, 200, {
        version: options.version,
        mode: 'server',
        storage: 'server',
        home: homeDisplay(options.home),
        active,
        credential: fallback
          ? await credentials.describe(fallback.apiKeyRef)
          : { configured: false, writable: true },
      })
      return
    }

    if (path === '/api/control' && method === 'GET') {
      await createSessionRoutes(options.sessions).control(req, res)
      return
    }

    if (path.startsWith('/api/sessions/') && path.endsWith('/commands') && method === 'POST') {
      const id = decodeURIComponent(path.slice('/api/sessions/'.length, -'/commands'.length))
      await createSessionRoutes(options.sessions).commands(req, res, id)
      return
    }

    if (path.startsWith('/api/sessions/') && path.endsWith('/history') && method === 'GET') {
      const id = decodeURIComponent(path.slice('/api/sessions/'.length, -'/history'.length))
      await createSessionRoutes(options.sessions).history(req, res, id)
      return
    }

    if (path.startsWith('/api/sessions/') && path.endsWith('/stream') && method === 'GET') {
      const id = decodeURIComponent(path.slice('/api/sessions/'.length, -'/stream'.length))
      const url = new URL(req.url ?? '/', 'http://localhost')
      const after = Number(url.searchParams.get('after') ?? '0')
      await createSessionRoutes(options.sessions).stream(
        req,
        res,
        id,
        Number.isFinite(after) && after > 0 ? after : 0
      )
      return
    }

    if (path === '/api/providers' && method === 'GET') {
      const list = await providers.list()
      sendJson(res, 200, {
        defaultId: DEFAULT_PROVIDER_ID,
        active: await providers.readActive(),
        providers: await Promise.all(
          list.map(
            async (profile) =>
              await describeProvider(profile, providers.isBuiltin(profile.id), credentials)
          )
        ),
      })
      return
    }

    if (path === '/api/providers/selection' && method === 'PUT') {
      const body = (await readJsonBody(req)) as { provider?: unknown; model?: unknown } | undefined
      const provider = typeof body?.provider === 'string' ? body.provider : ''
      const model = typeof body?.model === 'string' ? body.model : ''
      try {
        const active = await providers.writeActive(provider, model)
        sendJson(res, 200, { active })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (path.startsWith('/api/providers/')) {
      const rest = path.slice('/api/providers/'.length)
      const slash = rest.indexOf('/')
      const id = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash))
      const action = slash === -1 ? '' : rest.slice(slash + 1)
      const profile = await providers.read(id)
      if (!profile) {
        sendJson(res, 404, { error: `unknown provider: ${id}` })
        return
      }
      const summarize = async (target: ProviderProfile) =>
        await describeProvider(target, providers.isBuiltin(target.id), credentials)

      if (action === '' && method === 'PUT') {
        const body = (await readJsonBody(req)) as Partial<ProviderProfile> | undefined
        try {
          const saved = await providers.write({
            ...profile,
            displayName:
              typeof body?.displayName === 'string' ? body.displayName : profile.displayName,
            baseURL: typeof body?.baseURL === 'string' ? body.baseURL : profile.baseURL,
            apiKeyRef: typeof body?.apiKeyRef === 'string' ? body.apiKeyRef : profile.apiKeyRef,
            models: Array.isArray(body?.models) ? body.models : profile.models,
          })
          sendJson(res, 200, await summarize(saved))
        } catch (error) {
          sendJson(res, 400, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
        return
      }

      if (action === '' && method === 'DELETE') {
        const removed = await providers.remove(id)
        if (!removed) {
          sendJson(res, 400, { error: 'built-in provider cannot be removed' })
          return
        }
        sendJson(res, 200, { ok: true })
        return
      }

      if (action === 'credential' && method === 'PUT') {
        const body = (await readJsonBody(req)) as { value?: unknown } | undefined
        const value = typeof body?.value === 'string' ? body.value.trim() : ''
        if (!value) {
          sendJson(res, 400, { error: 'credential value must not be empty' })
          return
        }
        const verified = await verifyProviderKey(profile.baseURL, value)
        if (!verified.ok) {
          const status = verified.status === 401 || verified.status === 403 ? 401 : 502
          sendJson(res, status, { error: verified.message })
          return
        }
        await credentials.set(profile.apiKeyRef, value)
        sendJson(res, 200, await summarize(profile))
        return
      }

      if (action === 'credential' && method === 'DELETE') {
        await credentials.unset(profile.apiKeyRef)
        sendJson(res, 200, await summarize(profile))
        return
      }
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
      await createSessionRoutes(options.sessions).list(req, res)
      return
    }

    if (path === '/api/sessions/replace' && method === 'POST') {
      await createSessionRoutes(options.sessions).replace(req, res)
      return
    }

    if (path.startsWith('/api/sessions/') && method === 'GET') {
      const id = decodeURIComponent(path.slice('/api/sessions/'.length))
      await createSessionRoutes(options.sessions).readSession(req, res, id)
      return
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
