import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { buildRequestBody } from '../../server/src/agent.ts'
import {
  readVisibleMessages,
  SessionCommands,
  toImportEvents,
  type LegacySessionEnvelope,
} from '../../server/src/commands.ts'
import type { CredentialStore } from '../../server/src/credentials.ts'
import type { SessionLog } from '../../server/src/session-events.ts'
import type { SessionEvent, SessionEventType } from '../../src/services/session/types.ts'
import type { AssistantMessage, Message, UserMessage } from '../../src/services/chat/types.ts'

class MemoryLog implements SessionLog {
  private readonly events = new Map<string, SessionEvent[]>()
  private readonly listeners = new Map<string, Set<(event: SessionEvent) => void>>()

  async append(sessionId: string, type: SessionEventType, payload: unknown): Promise<number> {
    const list = this.events.get(sessionId) ?? []
    const event: SessionEvent = { seq: list.length + 1, type, payload }
    list.push(event)
    this.events.set(sessionId, list)
    for (const listener of this.listeners.get(sessionId) ?? []) {
      listener(event)
    }
    return event.seq
  }

  async read(sessionId: string): Promise<SessionEvent[]> {
    return [...(this.events.get(sessionId) ?? [])]
  }

  async readFrom(sessionId: string, after: number): Promise<SessionEvent[]> {
    return (await this.read(sessionId)).filter((event) => event.seq > after)
  }

  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    const set = this.listeners.get(sessionId) ?? new Set()
    set.add(listener)
    this.listeners.set(sessionId, set)
    return () => {
      set.delete(listener)
    }
  }
}

type Recorded = { path: string; headers: Record<string, string>; body: string }

type Fixture = (res: ServerResponse) => void

const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const usage = { input_tokens: 11, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const textStream = (text: string, stopReason = 'end_turn', title?: string): Fixture => {
  const head = frame('message_start', {
    type: 'message_start',
    message: { id: 'msg_fixture', model: 'deepseek-flash', usage: { ...usage, output_tokens: 0 } },
  })
  const body = [
    frame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    }),
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    frame('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
        ...(title ? { title } : {}),
      },
      usage: { ...usage, output_tokens: 7 },
    }),
    frame('message_stop', { type: 'message_stop' }),
  ].join('')
  return (res) => {
    res.write(head)
    res.write(body)
  }
}

const slowStream = (text: string): Fixture => {
  const head = frame('message_start', {
    type: 'message_start',
    message: { id: 'msg_slow', model: 'deepseek-flash' },
  })
  const body = [
    frame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    }),
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    frame('message_stop', { type: 'message_stop' }),
  ].join('')
  return (res) => {
    res.write(head)
    res.write(body)
    setTimeout(() => res.end(), 5000)
  }
}

const refusalStream = (): Fixture => {
  const body = [
    frame('message_start', {
      type: 'message_start',
      message: { id: 'msg_refusal', model: 'deepseek-flash' },
    }),
    frame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '这段内容不该进入上下文' },
    }),
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    frame('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: 'refusal',
        stop_sequence: null,
        stop_details: { type: 'refusal', category: null, explanation: null },
      },
    }),
    frame('message_stop', { type: 'message_stop' }),
  ].join('')
  return (res) => {
    res.write(body)
  }
}

const startUpstream = async (
  fixtures: Fixture[]
): Promise<{
  origin: string
  requests: Recorded[]
  close: () => Promise<void>
}> => {
  const requests: Recorded[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
    })
    req.on('end', () => {
      requests.push({
        path: req.url ?? '',
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(',') : (value ?? ''),
          ])
        ),
        body,
      })
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
      })
      const fixture = fixtures.shift() ?? textStream('默认回答')
      fixture(res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const FIXED_NOW = Date.parse('2026-01-02T12:00:00Z')

const REMINDER = '2026-01-02,星期五,,Web,中文'

const credentials = {
  resolve: async () => ({ value: 'test-key', source: 'env' as const }),
} as unknown as CredentialStore

const settings = {
  read: async () => ({
    locale: 'zh-CN' as const,
    location: null,
    thinking: false,
    search: false,
  }),
}

const waitForTurn = async (log: MemoryLog, sessionId: string): Promise<SessionEvent[]> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const events = await log.read(sessionId)
    const last = events.at(-1)
    if (last?.type === 'turn/state' && (last.payload as { status: string }).status !== 'running') {
      return events
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('轮次没有结束')
}

const messageOf = (event: SessionEvent): Message => (event.payload as { message: Message }).message

const assistantOf = (events: SessionEvent[]): AssistantMessage[] =>
  events
    .filter((event) => event.type === 'message/upsert')
    .map((event) => messageOf(event))
    .filter((message): message is AssistantMessage => message.role === 'assistant')

const checkContextAssembly = (): void => {
  const question: UserMessage = {
    id: 'q',
    role: 'user',
    content: '问',
    files: [],
    createdAt: FIXED_NOW,
  }
  const citation = {
    type: 'web_search_result_location' as const,
    url: 'https://example.com',
    title: '例子',
    cited_text: '例子',
    encrypted_index: '',
  }
  const reply: AssistantMessage = {
    id: 'a',
    role: 'assistant',
    createdAt: FIXED_NOW,
    model: 'deepseek-flash',
    prefix: true,
    status: 'done',
    latestReminder: REMINDER,
    blocks: [
      { type: 'text', text: '甲', citations: [citation] },
      { type: 'thinking', thinking: '思考', signature: 'sig' },
      { type: 'text', text: '乙' },
    ],
  }
  const body = buildRequestBody({
    history: [question, reply],
    question,
    thinking: false,
    search: false,
    model: 'deepseek-flash',
    title: false,
    latestReminder: REMINDER,
  })
  assert.deepEqual(
    body.messages,
    [
      { role: 'latest_reminder', content: REMINDER },
      { role: 'user', content: '问' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '甲' },
          { type: 'text', text: '\n\n乙' },
        ],
      },
      { role: 'user', content: '问' },
    ],
    '历史正文去掉引用，思考不回传，被隔开的正文用空行连接'
  )

  const changed = buildRequestBody({
    history: [question, { ...reply, latestReminder: '换过的提醒' }, question, reply],
    question,
    thinking: false,
    search: false,
    model: 'deepseek-flash',
    title: false,
    latestReminder: REMINDER,
  })
  assert.deepEqual(
    changed.messages.map((message) => message.role),
    ['latest_reminder', 'user', 'assistant', 'latest_reminder', 'user', 'assistant', 'user'],
    '提醒只在内容变化时插入'
  )

  const withTool: AssistantMessage = {
    ...reply,
    blocks: [
      { type: 'text', text: '甲' },
      {
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'deepseek_read_url',
        input: { action: 'read_link', url: 'https://example.com' },
        caller: { type: 'direct' },
        kind: 'read_link',
      },
      {
        type: 'web_fetch_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: {
          type: 'web_fetch_result',
          url: 'https://example.com',
          content: {
            type: 'document',
            source: { type: 'text', media_type: 'text/plain', data: '' },
            title: null,
          },
          published_at: null,
        },
        kind: 'read_link',
      },
    ],
  }
  const unsigned = buildRequestBody({
    history: [question, withTool],
    question,
    thinking: false,
    search: false,
    model: 'deepseek-flash',
    title: false,
  })
  assert.deepEqual(
    (unsigned.messages[2] as { content: unknown[] }).content,
    [{ type: 'text', text: '甲' }],
    '未成功阅读的链接调用与结果都不回传'
  )

  const signed: AssistantMessage = {
    ...withTool,
    blocks: (withTool.blocks as AssistantMessage['blocks']).map((block) =>
      block.type === 'web_fetch_tool_result' ? { ...block, signature: '签名' } : block
    ),
  }
  const signedBody = buildRequestBody({
    history: [question, signed],
    question,
    thinking: false,
    search: false,
    model: 'deepseek-flash',
    title: false,
  })
  assert.equal(
    (signedBody.messages[2] as { content: unknown[] }).content.length,
    3,
    '成功阅读的链接保留调用与结果'
  )

  const refused: AssistantMessage = {
    ...reply,
    stopReason: 'refusal',
    blocks: [{ type: 'text', text: '不该出现' }],
  }
  const refusedBody = buildRequestBody({
    history: [question, refused],
    question,
    thinking: false,
    search: false,
    model: 'deepseek-flash',
    title: false,
  })
  assert.deepEqual(
    refusedBody.messages.map((message) => message.role),
    ['user'],
    '被安全拒绝的轮次不进上下文'
  )

  const prefix: AssistantMessage = {
    ...reply,
    blocks: [{ type: 'text', text: '前缀' }],
  }
  const continued = buildRequestBody({
    history: [],
    question,
    prefix,
    thinking: true,
    search: false,
    model: 'deepseek-flash',
    title: false,
  })
  assert.deepEqual(
    continued.messages[continued.messages.length - 1],
    {
      role: 'assistant',
      content: [{ type: 'text', text: '前缀' }],
    },
    '续写只带本轮前缀'
  )
}

const main = async (): Promise<void> => {
  checkContextAssembly()

  const upstream = await startUpstream([
    textStream('你好，世界', 'end_turn', '寒暄'),
    textStream('第二段回答'),
    textStream('重新生成的容'),
    refusalStream(),
    textStream('文件轮次'),
    textStream('截断的回答', 'max_tokens'),
    textStream('续写的内容'),
    slowStream('慢慢说'),
  ])
  const log = new MemoryLog()
  const commands = new SessionCommands({
    log,
    upstream: upstream.origin,
    credentials,
    settings,
    now: () => FIXED_NOW,
    createId: (() => {
      let index = 0
      return () => `id_${(index += 1)}`
    })(),
  })
  const sessionId = 'session_1'

  const first = await commands.handle(sessionId, {
    command: 'send',
    content: '第一问',
    files: [],
    model: 'deepseek-flash',
    thinking: false,
    search: false,
  })
  assert.deepEqual(first.accepted, [1, 2, 3, 4, 5, 6], '命令返回已接受的事件序号')
  const firstEvents = await waitForTurn(log, sessionId)

  assert.deepEqual(
    firstEvents.map((event) => event.type),
    [
      'session/meta',
      'message/upsert',
      'branch/selected',
      'message/upsert',
      'branch/selected',
      'turn/state',
      'message/block',
      'message/delta',
      'message/block-end',
      'session/meta',
      'message/upsert',
      'turn/state',
    ],
    '事件序列与协议一致'
  )

  const pending = firstEvents[3]
  const pendingMessage = messageOf(pending) as AssistantMessage
  assert.equal(pendingMessage.status, 'pending', '创建时状态为 pending')
  assert.equal(pendingMessage.role, 'assistant')
  assert.equal(messageOf(firstEvents[1]).role, 'user', '提问先落库')

  const block = firstEvents[6]
  assert.deepEqual(
    (block.payload as { index: number; block: unknown }).block,
    { type: 'text', text: '', citations: [] },
    '内容块按 OutputBlockStart 形状下发'
  )
  assert.equal((block.payload as { index: number }).index, 0, 'index 是消息内的块下标')

  const settled = firstEvents[10]
  const finalMessage = messageOf(settled) as AssistantMessage
  assert.equal(finalMessage.status, 'done')
  assert.equal(finalMessage.stopReason, 'end_turn')
  assert.deepEqual(finalMessage.blocks, [{ type: 'text', text: '你好，世界', citations: [] }])
  assert.deepEqual(finalMessage.usage, { ...usage, output_tokens: 7 })
  assert.equal(finalMessage.id, pendingMessage.id, '落定与创建是同一条消息')

  assert.equal(firstEvents[11].type, 'turn/state')
  assert.equal((firstEvents[11].payload as { status: string }).status, 'done')

  const title = firstEvents.find(
    (event) => event.type === 'session/meta' && (event.payload as { title: string }).title
  )
  assert.ok(title, '自动标题写入 session/meta')

  assert.equal(upstream.requests[0].path, '/anthropic/v1/messages')
  assert.equal(upstream.requests[0].headers['x-api-key'], 'test-key')
  assert.equal(upstream.requests[0].headers['authorization'], 'Bearer test-key')
  assert.equal(upstream.requests[0].headers['content-type'], 'application/json')
  assert.equal(upstream.requests[0].headers['accept'], 'text/event-stream')
  assert.equal(upstream.requests[0].headers['anthropic-beta'], undefined, '纯文本不携带 beta')

  assert.equal(
    upstream.requests[0].body,
    JSON.stringify({
      model: 'deepseek-flash',
      system: '该助手为DeepSeek，由深度求索公司创造。',
      messages: [
        { role: 'latest_reminder', content: REMINDER },
        { role: 'user', content: '第一问' },
      ],
      thinking: { type: 'disabled' },
      safety_check: { level: 'high' },
      tools: [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }],
      title: { enabled: true },
      stream: true,
    }),
    '上游请求体逐字节一致'
  )

  await commands.handle(sessionId, {
    command: 'send',
    content: '第二问',
    files: [],
    model: 'deepseek-flash',
    thinking: false,
    search: false,
  })
  await waitForTurn(log, sessionId)

  assert.equal(
    upstream.requests[1].body,
    JSON.stringify({
      model: 'deepseek-flash',
      system: '该助手为DeepSeek，由深度求索公司创造。',
      messages: [
        { role: 'latest_reminder', content: REMINDER },
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: [{ type: 'text', text: '你好，世界' }] },
        { role: 'user', content: '第二问' },
      ],
      thinking: { type: 'disabled' },
      safety_check: { level: 'high' },
      tools: [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }],
      stream: true,
    }),
    '历史轮次进入上下文，思考与引用被丢弃'
  )

  const secondReply = assistantOf(await log.read(sessionId)).at(-1)

  await commands.handle(sessionId, { command: 'regenerate', messageId: secondReply?.id ?? '' })
  await waitForTurn(log, sessionId)

  const regenerateBody = JSON.parse(upstream.requests[2].body) as {
    messages: { role: string; content: unknown }[]
  }
  assert.deepEqual(
    regenerateBody.messages.map((message) => message.role),
    ['latest_reminder', 'user', 'assistant', 'user'],
    '重新生成沿用同一个问题，不带上被替换的回答'
  )

  const pathBeforeSelect = readVisibleMessages(sessionId, await log.read(sessionId))
  assert.deepEqual(
    pathBeforeSelect.map((message) => message.id),
    ['id_1', 'id_2', 'id_3', 'id_5'],
    '重新生成后可见路径指向新版本'
  )

  const selected = await commands.handle(sessionId, { command: 'select', messageId: 'id_4' })
  assert.equal(selected.accepted.length, 1, 'select 只写一条事件')
  const selectEvents = await log.read(sessionId)
  const selectEvent = selectEvents.at(-1)
  assert.equal(selectEvent?.type, 'branch/selected')
  assert.deepEqual(
    selectEvent?.payload,
    { parentId: 'id_3', selectedChildId: 'id_4' },
    '切换版本写入 branch/selected'
  )
  assert.deepEqual(
    readVisibleMessages(sessionId, selectEvents).map((message) => message.id),
    ['id_1', 'id_2', 'id_3', 'id_4'],
    '切换版本后可见路径随之改变'
  )

  await commands.handle(sessionId, { command: 'edit', messageId: 'id_1', content: '改过的问题' })
  await waitForTurn(log, sessionId)

  const editBody = JSON.parse(upstream.requests[3].body) as {
    messages: { role: string; content: unknown }[]
  }
  assert.deepEqual(
    editBody.messages.map((message) => message.role),
    ['latest_reminder', 'user'],
    '编辑提问后只带新问题'
  )
  assert.deepEqual(editBody.messages[1].content, '改过的问题')

  const refusalEvents = await log.read(sessionId)
  const refusalMessage = assistantOf(refusalEvents).find(
    (message) => message.stopReason === 'refusal'
  )
  assert.ok(refusalMessage, '被拒绝的回答已落定')
  assert.deepEqual(refusalMessage.blocks, [], '安全拒绝的回答不保留正文')

  await commands.handle(sessionId, {
    command: 'send',
    content: '带附件的提问',
    files: [
      {
        id: 'file_1',
        serverId: 'file_server_1',
        name: '图.png',
        size: 100,
        isImage: true,
        mimeType: 'image/png',
      },
    ],
    model: 'deepseek-flash',
    thinking: false,
    search: false,
  })
  await waitForTurn(log, sessionId)

  const fileBody = JSON.parse(upstream.requests[4].body) as {
    messages: { role: string; content: unknown }[]
  }
  assert.deepEqual(
    fileBody.messages.at(-1),
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'file', file_id: 'file_server_1' } },
        { type: 'text', text: '带附件的提问' },
      ],
    },
    '文件按 file_id 引用，图片用 image 块'
  )
  assert.equal(
    upstream.requests[4].headers['anthropic-beta'],
    'files-api-2025-04-14',
    '带图片时携带 beta'
  )

  await commands.handle(sessionId, {
    command: 'send',
    content: '会被截断的提问',
    files: [],
    model: 'deepseek-flash',
    thinking: false,
    search: false,
  })
  const truncatedEvents = await waitForTurn(log, sessionId)
  const truncated = assistantOf(truncatedEvents).at(-1)
  assert.equal(truncated?.stopReason, 'max_tokens')

  await commands.handle(sessionId, { command: 'continue', messageId: truncated?.id ?? '' })
  await waitForTurn(log, sessionId)

  const continueBody = JSON.parse(upstream.requests[6].body) as {
    messages: { role: string; content: unknown }[]
  }
  assert.deepEqual(
    continueBody.messages.at(-1),
    { role: 'assistant', content: [{ type: 'text', text: '截断的回答' }] },
    '续写把本轮回答作为前缀'
  )

  await commands.handle(sessionId, {
    command: 'send',
    content: '会被停止的提问',
    files: [],
    model: 'deepseek-flash',
    thinking: false,
    search: false,
  })
  const running = assistantOf(await log.read(sessionId)).at(-1)
  await commands.handle(sessionId, { command: 'stop', turnId: running?.turnId ?? '' })
  const stoppedEvents = await log.read(sessionId)
  const stopped = assistantOf(stoppedEvents).at(-1)
  assert.equal(stopped?.status, 'stopped', '停止后回答标记为 stopped')
  assert.equal(
    (stoppedEvents.at(-1)?.payload as { status: string }).status,
    'stopped',
    '轮次状态同步为 stopped'
  )

  const legacy: LegacySessionEnvelope = {
    id: 'legacy_1',
    schemaVersion: 1,
    summary: { id: 'legacy_1', title: '旧会话' },
    session: {
      id: 'legacy_1',
      title: '旧会话',
      createdAt: 1000,
      updatedAt: 2000,
      pinned: true,
      messages: [
        { id: 'm1', role: 'user', content: '旧提问', files: [], createdAt: 1 },
        {
          id: 'm2',
          role: 'assistant',
          createdAt: 2,
          model: 'deepseek-flash',
          prefix: true,
          status: 'done',
          blocks: [{ type: 'text', text: '旧回答' }],
        },
        { id: 'm3', role: 'user', content: '旧追问', files: [], createdAt: 3 },
      ],
    },
  }
  const importEvents = toImportEvents(legacy)
  assert.equal(importEvents.length, 7, '导入事件条数')
  assert.deepEqual(
    importEvents.map((event) => event.type),
    [
      'session/meta',
      'message/upsert',
      'message/upsert',
      'message/upsert',
      'branch/selected',
      'branch/selected',
      'branch/selected',
    ],
    '导入事件顺序'
  )
  assert.deepEqual(importEvents[0].payload, {
    sessionId: 'legacy_1',
    title: '旧会话',
    pinned: true,
    createdAt: 1000,
    updatedAt: 2000,
  })
  const importLog = new MemoryLog()
  for (const event of importEvents) {
    await importLog.append('legacy_1', event.type, event.payload)
  }
  assert.deepEqual(
    readVisibleMessages('legacy_1', await importLog.read('legacy_1')).map((message) => message.id),
    ['m1', 'm2', 'm3'],
    '导入后可见路径与旧会话一致'
  )

  await upstream.close()
  console.log('会话协议与上游请求体校验通过')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
