import { ApiError, API_ORIGIN } from '../api/client.js'
import { readServerSentEvents } from '../api/sse.js'
import type {
  ControlEvent,
  ControlEventType,
  SessionEventType,
  SessionStreamFrame,
} from './types.js'

const RECONNECT_BASE_DELAY = 500
const RECONNECT_MAX_DELAY = 10000
const RECONNECT_LIMIT = 30

const backoff = (attempt: number): number => {
  const base = Math.min(RECONNECT_MAX_DELAY, RECONNECT_BASE_DELAY * 2 ** (attempt - 1))
  return Math.round(base * (0.5 + Math.random() * 0.5))
}

const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

type StreamFrame = {
  seq: number | null
  type: string
  payload: unknown
}

const parseFrame = (event: string, data: string): StreamFrame | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const record = parsed as { seq?: unknown; payload?: unknown }
  const seq = typeof record.seq === 'number' && Number.isFinite(record.seq) ? record.seq : null
  return {
    seq,
    type: event,
    payload: 'payload' in record ? record.payload : parsed,
  }
}

class StreamDisconnect extends Error {
  readonly reason: unknown

  constructor(reason: unknown) {
    super('连接中断')
    this.name = 'StreamDisconnect'
    this.reason = reason
  }
}

class StreamFatal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StreamFatal'
  }
}

type StreamTarget = {
  url: (cursor: number) => string
  notFound: string
  interrupted: string
}

const connectFrames = async function* (
  target: StreamTarget,
  cursor: number,
  signal: AbortSignal
): AsyncGenerator<StreamFrame> {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    let response: Response
    try {
      response = await fetch(target.url(cursor), {
        headers: { accept: 'text/event-stream' },
        cache: 'no-store',
        signal: controller.signal,
      })
    } catch (error) {
      throw new StreamDisconnect(error)
    }
    if (response.status === 404) {
      throw new StreamFatal(target.notFound)
    }
    if (!response.ok || !response.body) {
      throw new StreamDisconnect(
        new ApiError('http', `${target.interrupted}：${response.status}`, response.status)
      )
    }
    try {
      for await (const { event, data } of readServerSentEvents(response.body, controller.signal)) {
        const frame = parseFrame(event, data)
        if (frame) {
          yield frame
        }
      }
    } catch (error) {
      throw new StreamDisconnect(error)
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    controller.abort()
  }
}

const subscribeFrames = async function* (
  target: StreamTarget,
  cursor: { value: number },
  signal: AbortSignal
): AsyncGenerator<StreamFrame> {
  let failures = 0
  for (;;) {
    try {
      for await (const frame of connectFrames(target, cursor.value, signal)) {
        failures = 0
        yield frame
      }
      failures += 1
      if (failures > RECONNECT_LIMIT) {
        throw new ApiError('network', target.interrupted)
      }
      await delay(backoff(failures), signal)
    } catch (error) {
      if (error instanceof StreamFatal) {
        throw new ApiError('interrupted', error.message)
      }
      if (!(error instanceof StreamDisconnect)) {
        throw error
      }
      if (signal.aborted) {
        throw error.reason
      }
      failures += 1
      if (failures > RECONNECT_LIMIT) {
        throw new ApiError('network', errorMessage(error.reason))
      }
      await delay(backoff(failures), signal)
    }
  }
}

export async function* subscribeSession(
  sessionId: string,
  after: number,
  signal: AbortSignal
): AsyncGenerator<SessionStreamFrame> {
  const cursor = { value: after > 0 ? after : 0 }
  const target: StreamTarget = {
    url: (value) =>
      `${API_ORIGIN}/api/sessions/${encodeURIComponent(sessionId)}/stream?after=${value}`,
    notFound: '会话不存在',
    interrupted: '会话连接中断',
  }
  const pending = new Map<number, SessionStreamFrame>()
  let gateArmed = after <= 0
  let metaDelivered = false
  for await (const frame of subscribeFrames(target, cursor, signal)) {
    if (frame.seq === null) {
      continue
    }
    const event: SessionStreamFrame = {
      seq: frame.seq,
      type: frame.type as SessionEventType,
      payload: frame.payload,
    }
    if (event.type === 'session/meta') {
      if (metaDelivered && event.seq <= cursor.value) {
        continue
      }
      metaDelivered = true
      gateArmed = false
      cursor.value = Math.max(cursor.value, event.seq)
      yield event
      const buffered = [...pending.values()].sort((a, b) => a.seq - b.seq)
      pending.clear()
      for (const item of buffered) {
        if (item.seq <= cursor.value) {
          continue
        }
        cursor.value = item.seq
        yield item
      }
      continue
    }
    if (gateArmed) {
      pending.set(event.seq, event)
      continue
    }
    if (event.seq <= cursor.value) {
      continue
    }
    cursor.value = event.seq
    yield event
  }
}

export async function* subscribeControl(signal: AbortSignal): AsyncGenerator<ControlEvent> {
  const cursor = { value: 0 }
  const target: StreamTarget = {
    url: (value) => `${API_ORIGIN}/api/control?after=${value}`,
    notFound: '控制流不存在',
    interrupted: '控制流连接中断',
  }
  for await (const frame of subscribeFrames(target, cursor, signal)) {
    if (frame.seq !== null) {
      if (frame.seq <= cursor.value) {
        continue
      }
      cursor.value = frame.seq
    }
    const event: ControlEvent = {
      type: frame.type as ControlEventType,
      payload: frame.payload,
    }
    yield event
  }
}
