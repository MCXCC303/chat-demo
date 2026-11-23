import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CredentialStore } from './credentials.ts'
import type { ProviderResolver } from './providers.ts'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'accept-encoding',
])

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

export type ProxyOptions = {
  resolveProvider: ProviderResolver
  credentials: CredentialStore
}

export const createProxy =
  (options: ProxyOptions) =>
  async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const provider = await options.resolveProvider()
    const credential = await options.credentials.resolve(provider.apiKeyRef)
    if (!credential) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            type: 'authentication_error',
            message: `${provider.apiKeyRef} is not configured on this machine`,
          },
        })
      )
      return
    }

    const target = new URL(req.url ?? '/', provider.baseURL)
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) {
        continue
      }
      headers[name] = Array.isArray(value) ? value.join(', ') : value
    }
    headers['x-api-key'] = credential.value
    headers.authorization = `Bearer ${credential.value}`
    headers['accept-encoding'] = 'identity'

    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) {
        controller.abort()
      }
    })

    try {
      const response = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req),
        signal: controller.signal,
        redirect: 'manual',
      })
      const outHeaders: Record<string, string> = {}
      response.headers.forEach((value, name) => {
        if (!HOP_BY_HOP.has(name.toLowerCase())) {
          outHeaders[name] = value
        }
      })
      res.writeHead(response.status, outHeaders)
      if (!response.body) {
        res.end()
        return
      }
      const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
      stream.on('error', () => {
        res.end()
      })
      stream.pipe(res)
    } catch (error) {
      if (controller.signal.aborted) {
        res.end()
        return
      }
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            type: 'api_error',
            message: error instanceof Error ? error.message : String(error),
          },
        })
      )
    }
  }
