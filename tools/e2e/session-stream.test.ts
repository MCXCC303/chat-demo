import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { resolve as resolveTs } from './resolve-ts.mjs'

registerHooks({ resolve: resolveTs })

type Frame = { seq: number; type: string; payload: unknown }

const sessionEvents: Frame[] = [
  {
    seq: 1,
    type: 'session/meta',
    payload: {
      sessionId: 's1',
      title: '第一会话',
      pinned: false,
      createdAt: 1,
      updatedAt: 1,
    },
  },
  { seq: 2, type: 'message/upsert', payload: { message: { id: 'm1' } } },
  { seq: 3, type: 'turn/state', payload: { turnId: 't1', status: 'running' } },
  { seq: 4, type: 'message/delta', payload: { messageId: 'm1', index: 0, delta: '你好' } },
  { seq: 5, type: 'turn/state', payload: { turnId: 't1', status: 'done' } },
]

const frameText = (frame: Frame): string =>
  `id: ${frame.seq}\nevent: ${frame.type}\ndata: ${JSON.stringify({
    seq: frame.seq,
    payload: frame.payload,
  })}\n\n`

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

const serverRequests: string[] = []

const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  serverRequests.push(`${req.method} ${url.pathname}${url.search}`)
  const id = url.pathname.split('/')[3] ?? ''
  if (req.method === 'POST' && url.pathname.endsWith('/commands')) {
    const body = JSON.parse((await readBody(req)) || '{}') as { command?: string }
    if (id === 'net') {
      req.socket.destroy()
      return
    }
    if (body.command === 'pin') {
      res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'session_locked', message: '会话正在另一台设备上编辑' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ accepted: [6, 7] }))
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  const after = Number(url.searchParams.get('after') ?? '0')
  if (url.pathname === '/api/control') {
    if (after === 0) {
      res.write(frameText({ seq: 1, type: 'sessions/snapshot', payload: { sessions: [] } }), () => {
        res.socket?.destroy()
      })
      return
    }
    res.write(
      frameText({ seq: 2, type: 'session/lock', payload: { sessionId: 's1', locked: true } })
    )
    return
  }
  if (id === 's2') {
    res.write(frameText({ seq: 1, type: 'message/upsert', payload: { message: { id: 'm9' } } }))
    return
  }
  const pending = sessionEvents.filter((frame) => frame.seq > after)
  if (after === 0) {
    res.write(pending.slice(0, 3).map(frameText).join(''), () => {
      res.socket?.destroy()
    })
    return
  }
  for (const frame of pending) {
    res.write(frameText(frame))
    if (frame.seq === 5) {
      res.write(frameText(frame))
    }
  }
}

const server = createServer((req, res) => {
  void handle(req, res)
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
;(globalThis as Record<string, unknown>).__API_ORIGIN__ = origin

const { subscribeControl, subscribeSession } = await import('../../src/services/session/stream.ts')
const { sendSessionCommand, SessionCommandError } =
  await import('../../src/services/session/commands.ts')

test.after(() => {
  server.closeAllConnections()
  server.close()
})

test('断流后带 after 续订，补齐且不重复', async () => {
  serverRequests.length = 0
  const controller = new AbortController()
  const received: number[] = []
  for await (const frame of subscribeSession('s1', 0, controller.signal)) {
    received.push(frame.seq)
    if (received.length === 5) {
      break
    }
  }
  controller.abort()
  assert.deepEqual(received, [1, 2, 3, 4, 5])
  assert.equal(serverRequests.length, 2)
  assert.match(serverRequests[1] ?? '', /after=3/)
})

test('带 after 续订时只投递更大的 seq', async () => {
  serverRequests.length = 0
  const controller = new AbortController()
  const received: number[] = []
  for await (const frame of subscribeSession('s1', 3, controller.signal)) {
    received.push(frame.seq)
    if (received.length === 2) {
      break
    }
  }
  controller.abort()
  assert.deepEqual(received, [4, 5])
  assert.match(serverRequests[0] ?? '', /after=3/)
})

test('拿到基线之前不产出帧', async () => {
  const controller = new AbortController()
  const received: number[] = []
  const timer = setTimeout(() => controller.abort(), 300)
  try {
    for await (const frame of subscribeSession('s2', 0, controller.signal)) {
      received.push(frame.seq)
    }
  } catch {
  }
  clearTimeout(timer)
  assert.deepEqual(received, [])
})

test('控制流断流后按 after 续订', async () => {
  serverRequests.length = 0
  const controller = new AbortController()
  const received: string[] = []
  for await (const event of subscribeControl(controller.signal)) {
    received.push(event.type)
    if (received.length === 2) {
      break
    }
  }
  controller.abort()
  assert.deepEqual(received, ['sessions/snapshot', 'session/lock'])
  assert.match(serverRequests[1] ?? '', /after=1/)
})

test('命令派发返回被接受的事件序号', async () => {
  const accepted = await sendSessionCommand('s1', { command: 'rename', title: '新标题' })
  assert.deepEqual(accepted, [6, 7])
})

test('业务拒绝与网络失败可区分', async () => {
  await assert.rejects(
    () => sendSessionCommand('s1', { command: 'pin', pinned: true }),
    (error: unknown) => {
      assert.ok(error instanceof SessionCommandError)
      assert.equal(error.failure, 'rejected')
      assert.equal(error.code, 'session_locked')
      assert.equal(error.message, '会话正在另一台设备上编辑')
      assert.equal(error.status, 409)
      return true
    }
  )
  await assert.rejects(
    () => sendSessionCommand('net', { command: 'stop', turnId: 't1' }),
    (error: unknown) => {
      assert.ok(error instanceof SessionCommandError)
      assert.equal(error.failure, 'network')
      assert.equal(error.kind, 'network')
      return true
    }
  )
})
