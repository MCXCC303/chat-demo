import { readMessageEvent } from '../../src/services/api/parseEvent.ts'
import { readServerSentEvents } from '../../src/services/api/sse.ts'
import { en } from '../../src/i18n/en.ts'
import { zh } from '../../src/i18n/zh.ts'
import { applyEvent, toRequestMessages } from '../../src/services/chat/reply.ts'
import {
  cityNames,
  provinceNames,
  regionCodes,
  regionNameOverrides,
} from '../../src/services/locationData.ts'
import { formatDate } from '../../src/utils/format.ts'
import type {
  ChatModel,
  ContentBlockDelta,
  CreateMessageRequest,
  MessageStreamEvent,
} from '../../src/services/api/types.ts'
import type { UserLocation } from '../../src/services/location.ts'
import type {
  AssistantMessage,
  Message,
  ReplyBlock,
  UserMessage,
} from '../../src/services/chat/types.ts'

export const SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'

export const DEFAULT_MODEL: ChatModel = 'deepseek-flash'

const SAFETY_CHECK = { level: 'high' } as const

const FILES_BETA = 'files-api-2025-04-14'

export type UpstreamFailureKind = 'http' | 'stream' | 'network' | 'interrupted' | 'protocol'

export class AgentError extends Error {
  readonly kind: UpstreamFailureKind
  readonly status?: number

  constructor(kind: UpstreamFailureKind, message: string, status?: number) {
    super(message)
    this.name = 'AgentError'
    this.kind = kind
    this.status = status
  }
}

export type ServerSettings = {
  locale: 'zh-CN' | 'en-US'
  location: UserLocation | null
  thinking: boolean
  search: boolean
}

const regions = new Set(regionCodes)

const provinces = Object.entries(provinceNames).map(([code, name]) => ({
  code,
  name,
  cities: Object.entries(cityNames)
    .filter(([city]) => city.startsWith(code.slice(0, 2)))
    .map(([code, name]) => ({ code, name })),
}))

const regionNames = {
  'zh-CN': new Intl.DisplayNames(['zh-CN'], { type: 'region' }),
  'en-US': new Intl.DisplayNames(['en-US'], { type: 'region' }),
}

export const getRegionName = (code: string, locale: 'zh-CN' | 'en-US'): string =>
  regions.has(code)
    ? (regionNameOverrides[locale][code] ?? regionNames[locale].of(code) ?? code)
    : ''

export const normalizeServerLocation = (value: unknown): UserLocation | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const { region, province, city } = record
  if (typeof region !== 'string' || !regions.has(region)) {
    return null
  }
  if (region !== 'CN') {
    return { region }
  }
  if (province === undefined) {
    return city === undefined ? { region } : null
  }
  const selectedProvince = provinces.find((item) => item.code === province)
  if (!selectedProvince) {
    return null
  }
  if (city === undefined) {
    return { region, province: selectedProvince.code }
  }
  const selectedCity = selectedProvince.cities.find((item) => item.code === city)
  return selectedCity ? { region, province: selectedProvince.code, city: selectedCity.code } : null
}

export const readServerSettings = (value: unknown): ServerSettings => {
  const record = (value ?? {}) as Record<string, unknown>
  return {
    locale: record.locale === 'en-US' ? 'en-US' : 'zh-CN',
    location: normalizeServerLocation(record.location),
    thinking: record.thinking === true,
    search: record.search === true,
  }
}

const locationName = (location: UserLocation | null, locale: 'zh-CN' | 'en-US'): string => {
  if (!location) {
    return ''
  }
  if (location.region === 'CN' && locale === 'zh-CN') {
    const province = provinces.find((item) => item.code === location.province)
    const city = province?.cities.find((item) => item.code === location.city)
    return city?.name ?? province?.name ?? getRegionName('CN', locale)
  }
  return getRegionName(location.region, locale)
}

export const createLatestReminder = (settings: ServerSettings, now = new Date()): string => {
  const locale = settings.locale
  return [
    formatDate(now),
    new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now),
    locationName(settings.location, locale),
    'Web',
    locale === 'zh-CN' ? zh.latestReminderLanguage : en.latestReminderLanguage,
  ].join(',')
}

export const serverTools = (search: boolean): CreateMessageRequest['tools'] => {
  const tools: CreateMessageRequest['tools'] = [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ]
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}

export const hasFileBlock = (body: CreateMessageRequest): boolean =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

export type RequestBodyOptions = {
  history: Message[]
  question: UserMessage
  prefix?: AssistantMessage
  thinking: boolean
  search: boolean
  model: ChatModel
  title: boolean
  latestReminder?: string
}

export const buildRequestBody = (options: RequestBodyOptions): CreateMessageRequest => {
  const messages = toRequestMessages(
    options.history,
    options.question,
    options.prefix,
    options.thinking,
    options.latestReminder
  )
  return {
    model: options.model,
    system: SYSTEM_PROMPT,
    messages,
    thinking: { type: options.thinking ? 'enabled' : 'disabled' },
    safety_check: SAFETY_CHECK,
    tools: serverTools(options.search),
    ...(options.title ? { title: { enabled: true } } : {}),
  }
}

const isErrorBody = (value: unknown): value is { error: { message: string } } =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as { error?: { message?: unknown } }).error?.message === 'string'

const readErrorText = async (response: Response): Promise<string> => {
  const text = await response.text().catch(() => '')
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      return body.error.message
    }
  } catch {
    return text
  }
  return text
}

export type UpstreamOptions = {
  origin: string
  apiKey: string
  body: CreateMessageRequest
  signal: AbortSignal
}

export const streamUpstream = async function* (
  options: UpstreamOptions
): AsyncGenerator<MessageStreamEvent> {
  let response: Response
  try {
    response = await fetch(new URL('/anthropic/v1/messages', options.origin), {
      method: 'POST',
      headers: {
        'x-api-key': options.apiKey,
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(hasFileBlock(options.body) ? { 'anthropic-beta': FILES_BETA } : {}),
      },
      body: JSON.stringify({ ...options.body, stream: true }),
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal.aborted) {
      throw error
    }
    throw new AgentError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw new AgentError(
      'http',
      (await readErrorText(response)) || response.statusText,
      response.status
    )
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw new AgentError('protocol', '上游没有返回流式响应')
  }
  for await (const frame of readServerSentEvents(response.body, options.signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(frame.data)
    } catch {
      if (frame.event === 'error') {
        throw new AgentError('stream', frame.data)
      }
      continue
    }
    if (isErrorBody(payload)) {
      throw new AgentError('stream', payload.error.message)
    }
    if (frame.event === 'error') {
      throw new AgentError('stream', frame.data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  throw new AgentError('interrupted', '')
}

export type StreamSink = {
  block: (index: number, block: ReplyBlock) => void | Promise<void>
  delta: (index: number, delta: ContentBlockDelta) => void | Promise<void>
  blockEnd: (index: number) => void | Promise<void>
}

export const runAssistantStream = async (options: {
  reply: AssistantMessage
  events: AsyncGenerator<MessageStreamEvent>
  sink: StreamSink
  now?: () => number
}): Promise<AssistantMessage> => {
  const now = options.now ?? Date.now
  let reply = options.reply
  const blockIndexes = new Map<number, number>()
  for await (const event of options.events) {
    if (event.type === 'content_block_start') {
      const before = reply.blocks.length
      reply = applyEvent(reply, event, now(), blockIndexes)
      const index = blockIndexes.get(event.index)
      if (index !== undefined && reply.blocks.length > before) {
        await options.sink.block(index, reply.blocks[index])
      }
      continue
    }
    if (event.type === 'content_block_stop') {
      const index = blockIndexes.get(event.index)
      reply = applyEvent(reply, event, now(), blockIndexes)
      if (index !== undefined) {
        await options.sink.blockEnd(index)
      }
      continue
    }
    reply = applyEvent(reply, event, now(), blockIndexes)
    if (event.type === 'content_block_delta') {
      const index = blockIndexes.get(event.index)
      if (index !== undefined) {
        await options.sink.delta(index, event.delta)
      }
    }
  }
  return reply
}

export const toFailure = (
  error: unknown
): {
  kind: UpstreamFailureKind
  message: string
  status?: number
} => {
  if (error instanceof AgentError) {
    return { kind: error.kind, message: error.message, status: error.status }
  }
  return {
    kind: 'protocol',
    message: error instanceof Error ? error.message : String(error),
  }
}
