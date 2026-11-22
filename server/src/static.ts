import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const sendFile = async (res: ServerResponse, path: string, status: number): Promise<void> => {
  const info = await stat(path)
  res.writeHead(status, {
    'content-type': CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
  })
  createReadStream(path).pipe(res)
}

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export const createStatic =
  (root: string) =>
  async (_req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const rootPath = resolve(root)
    const decoded = (() => {
      try {
        return decodeURIComponent(path)
      } catch {
        return path
      }
    })()
    const candidate = resolve(join(rootPath, normalize(decoded)))
    if (candidate !== rootPath && !candidate.startsWith(rootPath + sep)) {
      res.writeHead(403).end()
      return
    }
    if (await isFile(candidate)) {
      await sendFile(res, candidate, 200)
      return
    }
    try {
      await sendFile(res, join(rootPath, 'index.html'), 200)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('the frontend bundle is missing; run pnpm build first')
    }
  }
