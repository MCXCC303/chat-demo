import { randomBytes } from 'node:crypto'
import { getVisibleMessages, normalizeSession } from '../../src/services/chat/branches.ts'
import { canContinueReply, settleReply } from '../../src/services/chat/reply.ts'
import type { ChatModel, MessageStreamEvent } from '../../src/services/api/types.ts'
import type {
  AssistantMessage,
  Message,
  Session,
  UserMessage,
} from '../../src/services/chat/types.ts'
import type {
  CommandResult,
  SessionCommand,
  SessionEvent,
  SessionEventType,
} from '../../src/services/session/types.ts'
import {
  AgentError,
  buildRequestBody,
  createLatestReminder,
  runAssistantStream,
  streamUpstream,
  toFailure,
  type ServerSettings,
} from './agent.ts'
import type { CredentialStore } from './credentials.ts'
import type { ActiveResolver, ProviderResolver } from './providers.ts'
import type { SessionLog } from './session-events.ts'

export type SettingsSource = {
  read(): Promise<ServerSettings>
}

export type CommandHandlerOptions = {
  log: SessionLog
  resolveProvider: ProviderResolver
  readActive: ActiveResolver
  credentials: CredentialStore
  settings: SettingsSource
  now?: () => number
  createId?: () => string
}

export type SessionState = {
  id: string
  title: string
  pinned: boolean
  createdAt: number
  updatedAt: number
  rootMessageId: string | null
  messages: Message[]
  hasMeta: boolean
}

export class CommandError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'CommandError'
    this.status = status
  }
}

type TurnHandle = {
  controller: AbortController
  sessionId: string
  seqs: number[]
  promise?: Promise<void>
}

const applyMessage = (state: SessionState, message: Message): void => {
  const index = state.messages.findIndex((item) => item.id === message.id)
  if (index === -1) {
    state.messages.push(message)
  } else {
    state.messages[index] = message
  }
  if (message.parentId === undefined || message.parentId === null) {
    state.rootMessageId = message.id
  }
}

const applyBranch = (
  state: SessionState,
  parentId: string | null,
  selectedChildId: string | null
): void => {
  if (parentId === null) {
    state.rootMessageId = selectedChildId
    return
  }
  const index = state.messages.findIndex((item) => item.id === parentId)
  const parent = state.messages[index]
  if (parent) {
    state.messages[index] = { ...parent, selectedChildId: selectedChildId ?? undefined }
  }
}

const rebuildState = (sessionId: string, events: SessionEvent[]): SessionState => {
  const state: SessionState = {
    id: sessionId,
    title: '',
    pinned: false,
    createdAt: 0,
    updatedAt: 0,
    rootMessageId: null,
    messages: [],
    hasMeta: false,
  }
  for (const event of events) {
    if (event.type === 'session/meta') {
      const payload = event.payload as {
        title: string
        pinned: boolean
        createdAt: number
        updatedAt: number
      }
      state.title = payload.title
      state.pinned = payload.pinned
      state.createdAt = payload.createdAt
      state.updatedAt = payload.updatedAt
      state.hasMeta = true
      continue
    }
    if (event.type === 'message/upsert') {
      const payload = event.payload as { message: Message }
      applyMessage(state, payload.message)
      continue
    }
    if (event.type === 'branch/selected') {
      const payload = event.payload as { parentId: string | null; selectedChildId: string | null }
      applyBranch(state, payload.parentId, payload.selectedChildId)
    }
  }
  return state
}

const visibleMessages = (state: SessionState): Message[] =>
  getVisibleMessages({
    id: state.id,
    title: state.title,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    messages: state.messages,
    rootMessageId: state.rootMessageId,
    pinned: state.pinned,
  })

export type PendingSessionEvent = {
  type: SessionEventType
  payload: unknown
}

export type LegacySessionEnvelope = {
  id: string
  schemaVersion?: number
  session: Session
  summary?: unknown
}

export const toImportEvents = (envelope: LegacySessionEnvelope): PendingSessionEvent[] => {
  const source = (envelope.session ?? {}) as Partial<Session>
  const session = normalizeSession({
    id: source.id ?? envelope.id,
    title: source.title ?? '',
    createdAt: source.createdAt ?? 0,
    updatedAt: source.updatedAt ?? 0,
    pinned: source.pinned,
    messages: source.messages ?? [],
    rootMessageId: source.rootMessageId,
  })
  const events: PendingSessionEvent[] = [
    {
      type: 'session/meta',
      payload: {
        sessionId: envelope.id,
        title: session.title,
        pinned: session.pinned ?? false,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
    },
  ]
  for (const message of session.messages) {
    events.push({ type: 'message/upsert', payload: { message } })
  }
  for (const message of session.messages) {
    if (message.selectedChildId) {
      events.push({
        type: 'branch/selected',
        payload: { parentId: message.id, selectedChildId: message.selectedChildId },
      })
    }
  }
  if (session.rootMessageId) {
    events.push({
      type: 'branch/selected',
      payload: { parentId: null, selectedChildId: session.rootMessageId },
    })
  }
  return events
}

export const readVisibleMessages = (sessionId: string, events: SessionEvent[]): Message[] =>
  visibleMessages(rebuildState(sessionId, events))

const isUserMessage = (message: Message | undefined): message is UserMessage =>
  message?.role === 'user'

const isAssistantMessage = (message: Message | undefined): message is AssistantMessage =>
  message?.role === 'assistant'

export class SessionCommands {
  private readonly log: SessionLog
  private readonly resolveProvider: ProviderResolver
  private readonly readActive: ActiveResolver
  private readonly credentials: CredentialStore
  private readonly settings: SettingsSource
  private readonly now: () => number
  private readonly createId: () => string
  private readonly states = new Map<string, SessionState>()
  private readonly turns = new Map<string, TurnHandle>()

  constructor(options: CommandHandlerOptions) {
    this.log = options.log
    this.resolveProvider = options.resolveProvider
    this.readActive = options.readActive
    this.credentials = options.credentials
    this.settings = options.settings
    this.now = options.now ?? Date.now
    this.createId =
      options.createId ??
      (() =>
        typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
  }

  async handle(sessionId: string, command: SessionCommand): Promise<CommandResult> {
    switch (command.command) {
      case 'send':
        return await this.send(sessionId, command)
      case 'regenerate':
        return await this.regenerate(sessionId, command.messageId)
      case 'edit':
        return await this.edit(sessionId, command.messageId, command.content)
      case 'continue':
        return await this.continueReply(sessionId, command.messageId)
      case 'select':
        return await this.select(sessionId, command.messageId)
      case 'stop':
        return await this.stop(sessionId, command.turnId)
      case 'rename':
        return await this.rename(sessionId, command.title)
      case 'pin':
        return await this.pin(sessionId, command.pinned)
      case 'delete':
        return await this.remove(sessionId)
    }
  }

  private async state(sessionId: string): Promise<SessionState> {
    const cached = this.states.get(sessionId)
    if (cached) {
      return cached
    }
    const state = rebuildState(sessionId, await this.log.read(sessionId))
    this.states.set(sessionId, state)
    return state
  }

  private async upsertMessage(sessionId: string, message: Message): Promise<number> {
    const seq = await this.log.append(sessionId, 'message/upsert', { message })
    const state = this.states.get(sessionId)
    if (state) {
      applyMessage(state, message)
    }
    return seq
  }

  private async selectBranch(
    sessionId: string,
    parentId: string | null,
    selectedChildId: string
  ): Promise<number> {
    const seq = await this.log.append(sessionId, 'branch/selected', { parentId, selectedChildId })
    const state = this.states.get(sessionId)
    if (state) {
      applyBranch(state, parentId, selectedChildId)
    }
    return seq
  }

  private async writeMeta(sessionId: string, state: SessionState): Promise<number> {
    state.updatedAt = this.now()
    if (!state.createdAt) {
      state.createdAt = state.updatedAt
    }
    state.hasMeta = true
    return await this.log.append(sessionId, 'session/meta', {
      sessionId,
      title: state.title,
      pinned: state.pinned,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    })
  }

  private createReply(options: {
    model: ChatModel
    provider: string
    thinking: boolean
    search: boolean
  }): AssistantMessage {
    return {
      id: this.createId(),
      role: 'assistant',
      createdAt: this.now(),
      model: options.model,
      provider: options.provider,
      thinking: options.thinking,
      search: options.search,
      prefix: true,
      status: 'pending',
      blocks: [],
    }
  }

  private async send(
    sessionId: string,
    command: Extract<SessionCommand, { command: 'send' }>
  ): Promise<CommandResult> {
    const state = await this.state(sessionId)
    const settings = await this.settings.read()
    const path = visibleMessages(state)
    const question: UserMessage = {
      id: this.createId(),
      role: 'user',
      content: command.content,
      files: command.files ?? [],
      createdAt: this.now(),
      parentId: path.at(-1)?.id ?? null,
      selectedChildId: undefined,
    }
    const active = await this.readActive()
    const reply = this.createReply({
      model: active.model,
      provider: active.provider,
      thinking: command.thinking ?? settings.thinking,
      search: command.search ?? settings.search,
    })
    const accepted: number[] = []
    if (!state.hasMeta) {
      accepted.push(await this.writeMeta(sessionId, state))
    }
    accepted.push(await this.upsertMessage(sessionId, question))
    accepted.push(await this.selectBranch(sessionId, question.parentId ?? null, question.id))
    accepted.push(
      ...(await this.startTurn({
        sessionId,
        state,
        question,
        history: path,
        reply,
        latestReminder: createLatestReminder(settings, new Date(this.now())),
        title: !state.title,
        selectParentId: question.id,
      }))
    )
    return { accepted }
  }

  private async regenerate(sessionId: string, messageId: string): Promise<CommandResult> {
    const state = await this.state(sessionId)
    const settings = await this.settings.read()
    const path = visibleMessages(state)
    const index = path.findIndex((message) => message.id === messageId)
    const question = path[index - 1]
    if (!isUserMessage(question) || !isAssistantMessage(path[index])) {
      throw new CommandError('只能重新生成回答')
    }
    const active = await this.readActive()
    const reply = this.createReply({
      model: active.model,
      provider: active.provider,
      thinking: settings.thinking,
      search: settings.search,
    })
    const accepted = await this.startTurn({
      sessionId,
      state,
      question,
      history: path.slice(0, index - 1),
      reply,
      latestReminder: createLatestReminder(settings, new Date(this.now())),
      title: !state.title,
      selectParentId: question.id,
    })
    return { accepted }
  }

  private async edit(
    sessionId: string,
    messageId: string,
    content: string
  ): Promise<CommandResult> {
    const state = await this.state(sessionId)
    const settings = await this.settings.read()
    const path = visibleMessages(state)
    const index = path.findIndex((message) => message.id === messageId)
    const previous = path[index]
    const text = content.trim()
    if (!isUserMessage(previous) || (!text && previous.files.length === 0)) {
      throw new CommandError('只能编辑提问')
    }
    const question: UserMessage = {
      id: this.createId(),
      role: 'user',
      content: text,
      files: previous.files,
      createdAt: this.now(),
      parentId: path[index - 1]?.id ?? null,
      selectedChildId: undefined,
    }
    const active = await this.readActive()
    const reply = this.createReply({
      model: active.model,
      provider: active.provider,
      thinking: settings.thinking,
      search: settings.search,
    })
    const accepted: number[] = []
    accepted.push(await this.upsertMessage(sessionId, question))
    accepted.push(await this.selectBranch(sessionId, question.parentId ?? null, question.id))
    accepted.push(
      ...(await this.startTurn({
        sessionId,
        state,
        question,
        history: path.slice(0, index),
        reply,
        latestReminder: createLatestReminder(settings, new Date(this.now())),
        title: !state.title,
        selectParentId: question.id,
      }))
    )
    return { accepted }
  }

  private async continueReply(sessionId: string, messageId: string): Promise<CommandResult> {
    const state = await this.state(sessionId)
    const settings = await this.settings.read()
    const path = visibleMessages(state)
    const question = path.at(-2)
    const previous = path.at(-1)
    if (
      !isUserMessage(question) ||
      !isAssistantMessage(previous) ||
      previous.id !== messageId ||
      !canContinueReply(previous)
    ) {
      throw new CommandError('这条回答不能续写')
    }
    const active = await this.readActive()
    const reply: AssistantMessage = {
      ...previous,
      model: previous.model ?? active.model,
      provider: previous.provider ?? active.provider,
      thinking: previous.thinking ?? settings.thinking,
      search: previous.search ?? settings.search,
      status: 'pending',
      stopReason: undefined,
      stopDetails: undefined,
      error: undefined,
    }
    const accepted = await this.startTurn({
      sessionId,
      state,
      question,
      history: path.slice(0, -2),
      reply,
      prefix: previous,
      latestReminder:
        previous.latestReminder ?? createLatestReminder(settings, new Date(this.now())),
      title: !state.title,
    })
    return { accepted }
  }

  private async select(sessionId: string, messageId: string): Promise<CommandResult> {
    const state = await this.state(sessionId)
    if ([...this.turns.values()].some((handle) => handle.sessionId === sessionId)) {
      throw new CommandError('生成中不能切换版本')
    }
    const message = state.messages.find((item) => item.id === messageId)
    if (!message) {
      throw new CommandError('消息不存在', 404)
    }
    const parentId = message.parentId ?? null
    const path = visibleMessages(state)
    if (!path.some((item) => (item.parentId ?? null) === parentId)) {
      throw new CommandError('只能切换当前路径上的版本')
    }
    const seq = await this.selectBranch(sessionId, parentId, message.id)
    return { accepted: [seq] }
  }

  private async stop(sessionId: string, turnId: string): Promise<CommandResult> {
    const handle = this.turns.get(turnId)
    if (!handle || handle.sessionId !== sessionId) {
      throw new CommandError('轮次不存在或已经结束', 404)
    }
    handle.controller.abort()
    await handle.promise
    return { accepted: [...handle.seqs] }
  }

  private async rename(sessionId: string, title: string): Promise<CommandResult> {
    const state = await this.state(sessionId)
    state.title = title
    return { accepted: [await this.writeMeta(sessionId, state)] }
  }

  private async pin(sessionId: string, pinned: boolean): Promise<CommandResult> {
    const state = await this.state(sessionId)
    state.pinned = pinned
    return { accepted: [await this.writeMeta(sessionId, state)] }
  }

  private async remove(sessionId: string): Promise<CommandResult> {
    for (const handle of this.turns.values()) {
      if (handle.sessionId === sessionId) {
        handle.controller.abort()
      }
    }
    const seq = await this.log.append(sessionId, 'session/deleted', { sessionId })
    this.states.delete(sessionId)
    return { accepted: [seq] }
  }

  private async startTurn(options: {
    sessionId: string
    state: SessionState
    question: UserMessage
    history: Message[]
    reply: AssistantMessage
    prefix?: AssistantMessage
    latestReminder: string
    title: boolean
    selectParentId?: string | null
  }): Promise<number[]> {
    const turnId = `turn_${randomBytes(9).toString('base64url')}`
    const assistant: AssistantMessage = {
      ...options.reply,
      parentId: options.reply.parentId ?? options.question.id,
      turnId,
      latestReminder: options.latestReminder,
    }
    const accepted: number[] = []
    accepted.push(await this.upsertMessage(options.sessionId, assistant))
    if (options.selectParentId !== undefined) {
      accepted.push(
        await this.selectBranch(options.sessionId, options.selectParentId, assistant.id)
      )
    }
    const controller = new AbortController()
    const handle: TurnHandle = { controller, sessionId: options.sessionId, seqs: [] }
    this.turns.set(turnId, handle)
    const running = await this.log.append(options.sessionId, 'turn/state', {
      turnId,
      status: 'running',
    })
    accepted.push(running)
    handle.seqs.push(running)
    handle.promise = this.runTurn({
      ...options,
      turnId,
      assistant,
      controller,
      handle,
    })
    return accepted
  }

  private async *watchTitle(
    source: AsyncGenerator<MessageStreamEvent>,
    sessionId: string,
    allowTitle: boolean
  ): AsyncGenerator<MessageStreamEvent> {
    let applied = false
    for await (const event of source) {
      if (
        !applied &&
        allowTitle &&
        event.type === 'message_delta' &&
        (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'max_tokens') &&
        event.delta.title?.trim()
      ) {
        applied = true
        const state = this.states.get(sessionId)
        if (state && !state.title) {
          state.title = event.delta.title.trim()
          await this.writeMeta(sessionId, state)
        }
      }
      yield event
    }
  }

  private async runTurn(options: {
    sessionId: string
    state: SessionState
    turnId: string
    assistant: AssistantMessage
    question: UserMessage
    history: Message[]
    prefix?: AssistantMessage
    latestReminder: string
    title: boolean
    controller: AbortController
    handle: TurnHandle
  }): Promise<void> {
    const { sessionId, turnId, assistant, controller, handle } = options
    const messageId = assistant.id
    let current = assistant
    try {
      const active = await this.readActive()
      const provider = await this.resolveProvider(current.provider ?? active.provider)
      const credential = await this.credentials.resolve(provider.apiKeyRef)
      if (!credential) {
        throw new AgentError('http', `${provider.apiKeyRef} is not configured on this machine`)
      }
      const body = buildRequestBody({
        history: options.history,
        question: options.question,
        prefix: options.prefix,
        thinking: current.thinking ?? false,
        search: current.search ?? false,
        model: current.model ?? active.model,
        title: options.title,
        latestReminder: options.latestReminder,
      })
      const source = streamUpstream({
        origin: provider.baseURL,
        apiKey: credential.value,
        body,
        signal: controller.signal,
      })
      const events = this.watchTitle(source, sessionId, options.title)
      current = await runAssistantStream({
        reply: current,
        events,
        onProgress: (reply) => {
          current = reply
        },
        sink: {
          block: async (index, block) => {
            handle.seqs.push(
              await this.log.append(sessionId, 'message/block', { messageId, index, block })
            )
          },
          delta: async (index, delta) => {
            handle.seqs.push(
              await this.log.append(sessionId, 'message/delta', { messageId, index, delta })
            )
          },
          blockEnd: async (index) => {
            handle.seqs.push(
              await this.log.append(sessionId, 'message/block-end', { messageId, index })
            )
          },
        },
        now: this.now,
      })
      current = settleReply(current, 'done', this.now())
      await this.settleTurn(sessionId, turnId, current, 'done', handle)
    } catch (error) {
      if (controller.signal.aborted) {
        current = settleReply(current, 'stopped', this.now())
        await this.settleTurn(sessionId, turnId, current, 'stopped', handle)
        return
      }
      const failure = toFailure(error)
      if (failure.kind === 'interrupted' && current.stopReason) {
        current = settleReply(current, 'done', this.now())
        await this.settleTurn(sessionId, turnId, current, 'done', handle)
        return
      }
      current = settleReply(current, 'error', this.now(), failure)
      await this.settleTurn(sessionId, turnId, current, 'error', handle)
    }
  }

  private async settleTurn(
    sessionId: string,
    turnId: string,
    message: AssistantMessage,
    status: 'done' | 'stopped' | 'error',
    handle: TurnHandle
  ): Promise<void> {
    handle.seqs.push(await this.upsertMessage(sessionId, message))
    handle.seqs.push(await this.log.append(sessionId, 'turn/state', { turnId, status }))
    this.turns.delete(turnId)
  }
}
