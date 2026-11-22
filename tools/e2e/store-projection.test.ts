import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const resolve = (specifier: string, context: any, nextResolve: any) => {
  if (specifier.endsWith('client.js')) {
    return { url: new URL('./store-api-client-stub.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)
    if (existsSync(fileURLToPath(candidate))) {
      return { url: candidate.href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
registerHooks({ resolve })

const globals = globalThis as Record<string, unknown>
globals.requestAnimationFrame = (callback: (time: number) => void) =>
  setTimeout(() => callback(Date.now()), 0)
globals.cancelAnimationFrame = (id: unknown) => clearTimeout(id as NodeJS.Timeout)

type Frame = { seq: number; type: string; payload: unknown }

const frameText = (frame: Frame): string =>
  `id: ${frame.seq}\nevent: ${frame.type}\ndata: ${JSON.stringify({
    seq: frame.seq,
    payload: frame.payload,
  })}\n\n`

const log = new Map<string, Frame[]>()
const streams = new Map<string, Set<ServerResponse>>()
const commands: { sessionId: string; body: any }[] = []
let controlEnabled = false

const append = (sessionId: string, type: string, payload: unknown): number => {
  const frames = log.get(sessionId) ?? []
  const seq = (frames.at(-1)?.seq ?? 0) + 1
  const frame = { seq, type, payload }
  frames.push(frame)
  log.set(sessionId, frames)
  for (const response of streams.get(sessionId) ?? []) {
    response.write(frameText(frame))
  }
  return seq
}

const readBody = async (req: import('node:http').IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

const sessionSummary = { id: 's1', title: '第一会话', createdAt: 1, updatedAt: 1, pinned: false }

append('s1', 'session/meta', { sessionId: 's1', ...sessionSummary })
append('s1', 'message/upsert', {
  message: { id: 'u1', role: 'user', content: '旧消息', files: [], createdAt: 1, parentId: null },
})
append('s1', 'branch/selected', { parentId: null, selectedChildId: 'u1' })
append('s1', 'message/upsert', {
  message: {
    id: 'a1',
    role: 'assistant',
    createdAt: 2,
    model: 'deepseek-flash',
    prefix: true,
    status: 'done',
    blocks: [{ type: 'text', text: '旧回答' }],
    parentId: 'u1',
  },
})
append('s1', 'branch/selected', { parentId: 'u1', selectedChildId: 'a1' })

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const sessionId = url.pathname.split('/')[3] ?? ''
    if (req.method === 'POST' && url.pathname.endsWith('/commands')) {
      const body = JSON.parse((await readBody(req)) || '{}')
      commands.push({ sessionId, body })
      const accepted: number[] = []
      if (body.command === 'send') {
        if (!log.has(sessionId)) {
          accepted.push(
            append(sessionId, 'session/meta', {
              sessionId,
              title: '',
              pinned: false,
              createdAt: 10,
              updatedAt: 10,
            })
          )
        }
        accepted.push(
          append(sessionId, 'message/upsert', {
            message: {
              id: 'u2',
              role: 'user',
              content: body.content,
              files: [],
              createdAt: 3,
              parentId: sessionId === 's1' ? 'a1' : null,
            },
          })
        )
        accepted.push(
          append(sessionId, 'branch/selected', {
            parentId: sessionId === 's1' ? 'a1' : null,
            selectedChildId: 'u2',
          })
        )
        accepted.push(
          append(sessionId, 'message/upsert', {
            message: {
              id: 'a2',
              role: 'assistant',
              createdAt: 4,
              model: body.model,
              thinking: body.thinking,
              search: body.search,
              prefix: true,
              status: 'pending',
              blocks: [],
              turnId: 'turn-1',
              parentId: 'u2',
            },
          })
        )
        accepted.push(
          append(sessionId, 'branch/selected', { parentId: 'u2', selectedChildId: 'a2' })
        )
        accepted.push(append(sessionId, 'turn/state', { turnId: 'turn-1', status: 'running' }))
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ accepted }))
      return
    }
    if (url.pathname === '/api/sessions') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ sessions: [{ id: 's1', summary: sessionSummary }] }))
      return
    }
    if (url.pathname === '/api/control') {
      if (!controlEnabled) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      res.write(
        frameText({ seq: 1, type: 'sessions/snapshot', payload: { sessions: [sessionSummary] } })
      )
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    const after = Number(url.searchParams.get('after') ?? '0')
    const frames = (log.get(sessionId) ?? []).filter((frame) => frame.seq > after)
    res.write(frames.map(frameText).join(''))
    const set = streams.get(sessionId) ?? new Set<ServerResponse>()
    set.add(res)
    streams.set(sessionId, set)
    res.on('close', () => {
      set.delete(res)
    })
  })()
})

server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
globals.__API_ORIGIN__ = origin

const { getVisibleMessages } = await import('../../src/services/chat/branches.ts')
const { setDraftText } = await import('../../src/services/chat/drafts.ts')
const store = await import('../../src/services/chat/store.ts')

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`等待超时：${label}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test.after(() => {
  server.closeAllConnections()
  server.close()
  setTimeout(() => process.exit(0), 50)
})

test('控制流不可用时退回列表接口', async () => {
  await store.initChat()
  assert.equal(store.useChatStore.getState().ready, true)
  assert.deepEqual(
    store.useChatStore.getState().sessions.map((item) => item.id),
    ['s1']
  )
  controlEnabled = true
})

test('选中会话后按事件流投影出消息', async () => {
  store.selectSession('s1')
  await waitFor(
    () => store.useChatStore.getState().sessionCache.s1?.messages.length === 2,
    '会话详情投影'
  )
  const session = store.useChatStore.getState().sessionCache.s1
  assert.ok(session)
  assert.deepEqual(
    getVisibleMessages(session).map((message) => message.id),
    ['u1', 'a1']
  )
  assert.equal(store.useChatStore.getState().streaming.s1, undefined)
})

test('发送消息走命令，消息由事件回灌', async () => {
  setDraftText('s1', '新问题')
  assert.equal(store.sendMessage('s1'), true)
  await waitFor(() => commands.length === 1, '命令下发')
  assert.equal(commands[0].body.command, 'send')
  assert.equal(commands[0].body.content, '新问题')
  assert.equal(commands[0].body.model, 'deepseek-flash')
  await waitFor(
    () => (store.useChatStore.getState().sessionCache.s1?.messages.length ?? 0) === 4,
    '新消息投影'
  )
  const session = store.useChatStore.getState().sessionCache.s1
  assert.ok(session)
  assert.deepEqual(
    getVisibleMessages(session).map((message) => message.id),
    ['u1', 'a1', 'u2', 'a2']
  )
  assert.equal(store.useChatStore.getState().streaming.s1, true)
})

test('停止生成按投影里的轮次标识下发', async () => {
  store.stopReply('s1')
  await waitFor(() => commands.length === 2, '停止命令')
  assert.equal(commands[1].body.command, 'stop')
  assert.equal(commands[1].body.turnId, 'turn-1')
})

test('新对话用本地生成的 id 建会话并投影回消息', async () => {
  setDraftText(null, '新会话的第一句')
  assert.equal(store.sendMessage(null), true)
  await waitFor(() => commands.length === 3, '新会话命令')
  const command = commands[2]
  assert.equal(command.body.command, 'send')
  assert.equal(command.body.content, '新会话的第一句')
  assert.notEqual(command.sessionId, 's1')
  assert.equal(store.useChatStore.getState().activeId, command.sessionId)
  await waitFor(
    () =>
      (store.useChatStore.getState().sessionCache[command.sessionId]?.messages.length ?? 0) === 2,
    '新会话投影'
  )
  const session = store.useChatStore.getState().sessionCache[command.sessionId]
  assert.ok(session)
  assert.deepEqual(
    getVisibleMessages(session).map((message) => message.id),
    ['u2', 'a2']
  )
})
