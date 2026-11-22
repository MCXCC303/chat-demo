import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export type RecordedRequest = {
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

export type MockPlan = {
  chunks: number
  chunkDelayMs: number
  truncateFirst: boolean
}

export type MockUpstream = {
  origin: string
  requests: RecordedRequest[]
  reset(): void
  setPlan(plan: Partial<MockPlan>): void
  close(): Promise<void>
}

const DEFAULT_PLAN: MockPlan = { chunks: 1, chunkDelayMs: 0, truncateFirst: false }

export const chunkTexts = (count: number): string[] =>
  Array.from(
    { length: count },
    (_, index) =>
      `mock-chunk-${String(index + 1).padStart(2, '0')}${index === count - 1 ? '' : ' '}`
  )

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const readBody = async (req: IncomingMessage): Promise<string> => {
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
  return new TextDecoder().decode(result)
}

const collectHeaders = (req: IncomingMessage): Record<string, string> => {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue
    }
    headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return headers
}

const frame = (type: string, payload: unknown): string =>
  `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`

const usage = {
  input_tokens: 12,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 8,
}

const writeFrame = async (res: ServerResponse, text: string, delayMs: number): Promise<boolean> => {
  if (delayMs > 0) {
    await sleep(delayMs)
  }
  if (res.writableEnded || res.destroyed) {
    return false
  }
  res.write(text)
  return true
}

const streamReply = async (
  res: ServerResponse,
  options: { thinking: boolean; stopReason: string; chunks: string[]; chunkDelayMs: number }
): Promise<void> => {
  const { thinking, stopReason, chunks, chunkDelayMs } = options
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  const started = await writeFrame(
    res,
    frame('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_mock_0000000000000001',
        model: 'deepseek-flash',
        usage: { ...usage, output_tokens: 0 },
      },
    }),
    0
  )
  if (!started) {
    return
  }
  let textIndex = 0
  if (thinking) {
    textIndex = 1
    await writeFrame(
      res,
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      }),
      0
    )
    await writeFrame(
      res,
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'mock-thinking' },
      }),
      0
    )
    await writeFrame(
      res,
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'mock-signature' },
      }),
      0
    )
    await writeFrame(res, frame('content_block_stop', { type: 'content_block_stop', index: 0 }), 0)
  }
  await writeFrame(
    res,
    frame('content_block_start', {
      type: 'content_block_start',
      index: textIndex,
      content_block: { type: 'text', text: '' },
    }),
    0
  )
  for (const chunk of chunks) {
    const written = await writeFrame(
      res,
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: textIndex,
        delta: { type: 'text_delta', text: chunk },
      }),
      chunkDelayMs
    )
    if (!written) {
      return
    }
  }
  await writeFrame(
    res,
    frame('content_block_stop', { type: 'content_block_stop', index: textIndex }),
    0
  )
  await writeFrame(
    res,
    frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage,
    }),
    0
  )
  await writeFrame(res, frame('message_stop', { type: 'message_stop' }), 0)
  res.end()
}

export const startMockUpstream = async (): Promise<MockUpstream> => {
  const requests: RecordedRequest[] = []
  let plan: MockPlan = { ...DEFAULT_PLAN }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'POST' && url.pathname === '/anthropic/v1/messages') {
      const body = await readBody(req)
      requests.push({
        method: req.method,
        path: url.pathname,
        headers: collectHeaders(req),
        body,
      })
      const parsed = (() => {
        try {
          return JSON.parse(body) as { thinking?: { type?: string } }
        } catch {
          return {} as { thinking?: { type?: string } }
        }
      })()
      const stopReason = plan.truncateFirst && requests.length === 1 ? 'max_tokens' : 'end_turn'
      await streamReply(res, {
        thinking: parsed.thinking?.type === 'enabled',
        stopReason,
        chunks: chunkTexts(plan.chunks),
        chunkDelayMs: plan.chunkDelayMs,
      })
      return
    }
    if (url.pathname === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
      }
      res.end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    reset: () => {
      requests.length = 0
    },
    setPlan: (next) => {
      plan = { ...plan, ...next }
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
