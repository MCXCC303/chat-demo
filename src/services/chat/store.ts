import { create } from 'zustand'
import { showToast } from '../../components/base/toastState.js'
import { createId } from '../../utils/id.js'
import { API_ORIGIN } from '../api/client.js'
import { cancelUpload, checkImageFileIds, uploadAttachment, useUploads } from '../attachments.js'
import { useSettings } from '../settings.js'
import { sendSessionCommand, SessionCommandError } from '../session/commands.js'
import { fetchSessionHistoryPage } from '../session/history.js'
import { fetchSessionPage } from '../session/list.js'
import { applyFrame, createProjection, type SessionProjection } from '../session/projection.js'
import { subscribeControl, subscribeSession } from '../session/stream.js'
import type { ControlEvent, SessionCommand, SessionStreamFrame } from '../session/types.js'
import { getVisibleMessages } from './branches.js'
import {
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
  setDraftText,
} from './drafts.js'
import { canContinueReply } from './reply.js'
import { getRepository } from './repository.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Message,
  type Session,
  type SessionSummary,
} from './types.js'

const SESSION_CACHE_LIMIT = 5
const PAGE_SIZE = 50
const HISTORY_PAGE_SIZE = 20
const CONTROL_FALLBACK_DELAY = 2000
const CONTROL_RECONNECT_DELAY = 2000

export type SessionHistoryState = {
  hasMore: boolean
  loading: boolean
  error: boolean
}

type ChatState = {
  ready: boolean
  initError: boolean
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  hasMore: boolean
  loadingMore: boolean
  loadMoreError: boolean
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  history: Record<string, SessionHistoryState>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  streaming: Record<string, boolean>
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  importingHistory: false,
  sessions: [],
  hasMore: false,
  loadingMore: false,
  loadMoreError: false,
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  history: {},
  activeId: null,
  streaming: {},
}))

const { getState: get, setState: set } = useChatStore

const projections = new Map<string, SessionProjection>()
const sessionStreams = new Map<string, AbortController>()
const pendingTurns = new Set<string>()
const sessionAccess = new Map<string, number>()
const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<boolean>>()
let accessSequence = 0
let controlReady: Promise<void> | undefined
let markControlReady: (() => void) | undefined
const dirty = new Set<string>()
let frame = 0

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) {
      return a.pinned ? -1 : 1
    }
    return b.updatedAt - a.updatedAt
  })

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title &&
  a.createdAt === b.createdAt &&
  a.updatedAt === b.updatedAt &&
  Boolean(a.pinned) === Boolean(b.pinned)

const sameStreaming = (a: Record<string, boolean>, b: Record<string, boolean>) => {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const clearSessionLoadError = (id: string) => {
  set((state) =>
    Object.hasOwn(state.sessionLoadErrors, id)
      ? { sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }
      : state
  )
}

const setSessionHistory = (id: string, patch: Partial<SessionHistoryState>) => {
  set((state) => {
    const current = state.history[id] ?? { hasMore: false, loading: false, error: false }
    const next = { ...current, ...patch }
    if (
      current.hasMore === next.hasMore &&
      current.loading === next.loading &&
      current.error === next.error
    ) {
      return state
    }
    return { history: { ...state.history, [id]: next } }
  })
}

const isGenerating = (id: string): boolean => {
  if (pendingTurns.has(id)) {
    return true
  }
  const projection = projections.get(id)
  if (!projection) {
    return false
  }
  if (Object.values(projection.turns).some((status) => status === 'running')) {
    return true
  }
  return (
    projection.session?.messages.some(
      (message) =>
        message.role === 'assistant' &&
        (message.status === 'pending' || message.status === 'streaming')
    ) ?? false
  )
}

const deriveStreaming = (): Record<string, boolean> => {
  const streaming: Record<string, boolean> = {}
  for (const id of new Set([...projections.keys(), ...pendingTurns])) {
    if (isGenerating(id)) {
      streaming[id] = true
    }
  }
  return streaming
}

const refreshStreaming = () => {
  set((state) => {
    const streaming = deriveStreaming()
    return sameStreaming(state.streaming, streaming) ? state : { streaming }
  })
}

const withRoot = (session: Session): Session => {
  if (session.rootMessageId) {
    return session
  }
  const root =
    session.messages.find(
      (message) => message.parentId === undefined || message.parentId === null
    ) ?? session.messages[0]
  return root ? { ...session, rootMessageId: root.id } : session
}

const reduceFrame = (
  projection: SessionProjection,
  event: SessionStreamFrame
): SessionProjection => {
  const next = applyFrame(projection, event)
  if (!next.session) {
    return next
  }
  if (event.type === 'branch/selected') {
    const { parentId, selectedChildId } = event.payload as {
      parentId: string | null
      selectedChildId: string | null
    }
    if (parentId === null && selectedChildId) {
      return { ...next, session: { ...next.session, rootMessageId: selectedChildId } }
    }
  }
  return { ...next, session: withRoot(next.session) }
}

const flush = () => {
  frame = 0
  const ids = [...dirty]
  dirty.clear()
  if (ids.length === 0) {
    return
  }
  set((state) => {
    const sessionCache = { ...state.sessionCache }
    let summaries = state.sessions
    let listChanged = false
    for (const id of ids) {
      const session = projections.get(id)?.session
      if (!session) {
        continue
      }
      if (state.activeId === id || Object.hasOwn(state.sessionCache, id) || isGenerating(id)) {
        sessionCache[id] = session
      }
      const summary = toSessionSummary(session)
      const index = summaries.findIndex((item) => item.id === id)
      if (index === -1) {
        summaries = [...summaries, summary]
        listChanged = true
      } else if (!sameSummary(summaries[index], summary)) {
        summaries = summaries.map((item, position) => (position === index ? summary : item))
        listChanged = true
      }
    }
    const streaming = deriveStreaming()
    return {
      sessionCache,
      sessions: listChanged ? sortSessions(summaries) : summaries,
      streaming: sameStreaming(state.streaming, streaming) ? state.streaming : streaming,
    }
  })
}

const scheduleFlush = () => {
  if (frame) {
    return
  }
  frame = requestAnimationFrame(flush)
}

const flushProjections = () => {
  cancelAnimationFrame(frame)
  frame = 0
  flush()
}

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter((id) => id !== state.activeId && !isGenerating(id) && !deletingSessions.has(id))
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
    sessionStreams.get(id)?.abort()
    sessionStreams.delete(id)
    projections.delete(id)
  }
  if (evicted.size > 0) {
    set((state) => ({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
      history: Object.fromEntries(Object.entries(state.history).filter(([id]) => !evicted.has(id))),
    }))
  }
}

const subscribeSessionStream = (id: string) => {
  if (sessionStreams.has(id)) {
    return
  }
  const projection = projections.get(id) ?? createProjection()
  projections.set(id, projection)
  const controller = new AbortController()
  sessionStreams.set(id, controller)
  void (async () => {
    let loaded = false
    try {
      if (!projection.session) {
        let page: Awaited<ReturnType<typeof fetchSessionHistoryPage>> | undefined
        try {
          page = await fetchSessionHistoryPage(id, null, HISTORY_PAGE_SIZE, controller.signal)
        } catch {
          if (controller.signal.aborted) {
            return
          }
        }
        if (controller.signal.aborted || projections.get(id) !== projection) {
          return
        }
        if (page) {
          projection.session = withRoot(page.session)
          projection.seq = page.seq
          dirty.add(id)
          scheduleFlush()
          setSessionHistory(id, { hasMore: page.hasMore, loading: false, error: false })
          loaded = true
          clearSessionLoadError(id)
        } else {
          setSessionHistory(id, { hasMore: false, loading: false, error: false })
        }
      }
      for await (const event of subscribeSession(id, projection.seq, controller.signal)) {
        const current = projections.get(id)
        if (!current) {
          break
        }
        projections.set(id, reduceFrame(current, event))
        if (event.type === 'message/upsert') {
          const { message } = event.payload as { message: Message }
          if (message.role === 'assistant') {
            pendingTurns.delete(id)
          }
        }
        if (event.type === 'turn/state') {
          pendingTurns.delete(id)
        }
        dirty.add(id)
        scheduleFlush()
        if (!loaded) {
          loaded = true
          clearSessionLoadError(id)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
      }
    } finally {
      if (sessionStreams.get(id) === controller) {
        sessionStreams.delete(id)
      }
    }
  })()
}

const releaseSession = (id: string) => {
  if (isGenerating(id)) {
    return
  }
  sessionStreams.get(id)?.abort()
  sessionStreams.delete(id)
}

const removeSessionFromState = (id: string) => {
  set((state) => ({
    sessions: state.sessions.filter((session) => session.id !== id),
    sessionCache: Object.fromEntries(
      Object.entries(state.sessionCache).filter(([key]) => key !== id)
    ),
    sessionLoadErrors: Object.fromEntries(
      Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
    ),
    sessionSaveErrors: Object.fromEntries(
      Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
    ),
    history: Object.fromEntries(Object.entries(state.history).filter(([key]) => key !== id)),
    activeId: state.activeId === id ? null : state.activeId,
  }))
}

const reportCommandError = (error: unknown) => {
  if (error instanceof SessionCommandError && error.failure === 'network') {
    showToast({ key: 'commonNetworkErrorToast' })
    return
  }
  showToast(error instanceof Error ? error.message : String(error))
}

const sendCommand = async (
  sessionId: string,
  command: SessionCommand,
  turn = false
): Promise<number[]> => {
  if (turn) {
    pendingTurns.add(sessionId)
    refreshStreaming()
  }
  try {
    return await sendSessionCommand(sessionId, command)
  } catch (error) {
    if (turn) {
      pendingTurns.delete(sessionId)
      refreshStreaming()
    }
    throw error
  }
}

const sendTurnCommand = (sessionId: string, command: SessionCommand) => {
  void sendCommand(sessionId, command, true).catch(reportCommandError)
}

const loadSessionList = async (): Promise<SessionSummary[]> => {
  const response = await fetch(`${API_ORIGIN}/api/sessions`, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`会话列表读取失败：${response.status}`)
  }
  const body = (await response.json()) as { sessions?: unknown }
  return toSummaries(body.sessions) ?? []
}

const toSummary = (value: unknown): SessionSummary | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  const source = (
    typeof record.summary === 'object' && record.summary !== null ? record.summary : record
  ) as Record<string, unknown>
  if (typeof source.id !== 'string') {
    return null
  }
  const now = Date.now()
  return {
    id: source.id,
    title: typeof source.title === 'string' ? source.title : '',
    createdAt: typeof source.createdAt === 'number' ? source.createdAt : now,
    updatedAt: typeof source.updatedAt === 'number' ? source.updatedAt : now,
    pinned: Boolean(source.pinned),
  }
}

const toSummaries = (value: unknown): SessionSummary[] | null => {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'object' &&
        value !== null &&
        Array.isArray((value as { sessions?: unknown }).sessions)
      ? (value as { sessions: unknown[] }).sessions
      : null
  if (!list) {
    return null
  }
  const summaries: SessionSummary[] = []
  for (const item of list) {
    const summary = toSummary(item)
    if (summary) {
      summaries.push(summary)
    }
  }
  return summaries
}

const readSessionId = (payload: unknown): string | null => {
  if (typeof payload === 'string') {
    return payload
  }
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const record = payload as Record<string, unknown>
  if (typeof record.sessionId === 'string') {
    return record.sessionId
  }
  return typeof record.id === 'string' ? record.id : null
}

const applyControlEvent = (event: ControlEvent): boolean => {
  switch (event.type) {
    case 'sessions/snapshot': {
      const summaries = toSummaries(event.payload)
      if (!summaries) {
        return false
      }
      const head = sortSessions(summaries)
      const hasMore = (event.payload as { hasMore?: unknown } | null)?.hasMore === true
      set((state) => {
        const headIds = new Set(head.map((item) => item.id))
        const tail = state.sessions.filter((item) => !headIds.has(item.id))
        return {
          ready: true,
          initError: false,
          sessions: tail.length > 0 ? sortSessions([...head, ...tail]) : head,
          hasMore: tail.length > 0 ? state.hasMore : hasMore,
        }
      })
      return true
    }
    case 'session/updated': {
      const summary = toSummary(event.payload)
      if (summary) {
        set((state) => {
          const index = state.sessions.findIndex((item) => item.id === summary.id)
          const sessions =
            index === -1
              ? [...state.sessions, summary]
              : state.sessions.map((item, position) => (position === index ? summary : item))
          return { sessions: sortSessions(sessions) }
        })
      }
      return false
    }
    case 'session/deleted': {
      const id = readSessionId(event.payload)
      if (id) {
        removeSessionFromState(id)
      }
      return false
    }
    default:
      return false
  }
}

const startControlStream = async (onSnapshot: () => void) => {
  const controller = new AbortController()
  for (;;) {
    try {
      for await (const event of subscribeControl(controller.signal)) {
        if (applyControlEvent(event)) {
          onSnapshot()
        }
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, CONTROL_RECONNECT_DELAY))
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, CONTROL_RECONNECT_DELAY))
  }
}

const ensureControlStream = () => {
  if (controlReady) {
    return
  }
  controlReady = new Promise<void>((resolve) => {
    markControlReady = resolve
  })
  void startControlStream(() => {
    markControlReady?.()
  })
}

export const initChat = (): Promise<void> => {
  if (get().ready) {
    return Promise.resolve()
  }
  set({ initError: false })
  ensureControlStream()
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) {
        return
      }
      settled = true
      stop()
      resolve()
    }
    const stop = useChatStore.subscribe((state) => {
      if (state.ready) {
        finish()
      }
    })
    const timer = setTimeout(() => {
      void loadSessionList()
        .then((summaries) => {
          if (!get().ready) {
            set({ ready: true, initError: false, sessions: sortSessions(summaries) })
          }
        })
        .catch(() => {
          if (!get().ready) {
            set({ initError: true })
          }
        })
        .finally(finish)
    }, CONTROL_FALLBACK_DELAY)
    void controlReady?.then(() => {
      clearTimeout(timer)
      finish()
    })
  })
}

export const bindChatPersistence = () => {
  const save = () => {
    if (get().importingHistory) {
      return
    }
    flushProjections()
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      save()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', save)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
  }
}

export const retrySaveSessions = () => {
  set((state) => ({
    sessionSaveErrors: Object.fromEntries(
      Object.entries(state.sessionSaveErrors).filter(([, failed]) => !failed)
    ),
  }))
}

/**
 * 替换历史对话：写入暂存，成功后原子替换旧记录；写入为空即删除全部会话与附件。
 * 期间锁定交互，失败时清除暂存，保留原有记录。
 */
export const replaceHistory = async (
  write: () => Promise<void>,
  clear = false
): Promise<number> => {
  if (get().importingHistory) {
    throw new Error('History replacement is already in progress')
  }
  set({ importingHistory: true })
  try {
    await Promise.all(deletionTasks)
    const repository = getRepository()
    await repository.clearStaging()
    let summaries: SessionSummary[]
    try {
      await write()
      summaries = await repository.commitStaging(clear)
    } catch (error) {
      await repository.clearStaging().catch(() => {})
      throw error
    }
    sessionAccess.clear()
    clearAllDrafts()
    for (const [id, controller] of sessionStreams) {
      controller.abort()
      sessionStreams.delete(id)
      projections.delete(id)
    }
    pendingTurns.clear()
    const activeId = get().activeId
    const kept = activeId !== null && summaries.some((summary) => summary.id === activeId)
    set({
      ready: true,
      initError: false,
      sessions: sortSessions(summaries),
      sessionCache: {},
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      history: {},
      activeId: kept ? activeId : null,
    })
    refreshStreaming()
    return summaries.length
  } finally {
    set({ importingHistory: false })
    retrySaveSessions()
    const { activeId, ready } = get()
    if (activeId !== null) {
      subscribeSessionStream(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

export const loadMoreSessions = async (): Promise<void> => {
  const state = get()
  if (!state.ready || !state.hasMore || state.loadingMore) {
    return
  }
  set({ loadingMore: true, loadMoreError: false })
  try {
    const page = await fetchSessionPage(state.sessions.length, PAGE_SIZE)
    set((current) => {
      const known = new Set(current.sessions.map((item) => item.id))
      const additions = page.sessions.filter((item) => !known.has(item.id))
      return {
        sessions: sortSessions([...current.sessions, ...additions]),
        hasMore: page.hasMore && additions.length > 0,
        loadingMore: false,
        loadMoreError: false,
      }
    })
  } catch {
    set({ loadingMore: false, loadMoreError: true })
  }
}

export const loadOlderMessages = async (sessionId: string): Promise<void> => {
  const history = get().history[sessionId]
  const projection = projections.get(sessionId)
  const session = projection?.session
  if (!projection || !session || !history?.hasMore || history.loading) {
    return
  }
  const before = session.rootMessageId
  if (!before) {
    setSessionHistory(sessionId, { hasMore: false })
    return
  }
  setSessionHistory(sessionId, { loading: true, error: false })
  try {
    const page = await fetchSessionHistoryPage(sessionId, before, HISTORY_PAGE_SIZE)
    const current = projections.get(sessionId)
    if (!current?.session) {
      setSessionHistory(sessionId, { loading: false })
      return
    }
    const known = new Set(current.session.messages.map((message) => message.id))
    const older = page.session.messages.filter((message) => !known.has(message.id))
    if (older.length > 0) {
      current.session = {
        ...current.session,
        messages: [...older, ...current.session.messages],
        rootMessageId: page.session.rootMessageId ?? older[0]?.id ?? current.session.rootMessageId,
      }
      dirty.add(sessionId)
      flushProjections()
    }
    setSessionHistory(sessionId, { hasMore: page.hasMore, loading: false, error: false })
  } catch {
    setSessionHistory(sessionId, { loading: false, error: true })
  }
}

export const newChat = () => {
  if (!get().importingHistory) {
    const previous = get().activeId
    set({ activeId: null })
    if (previous !== null) {
      releaseSession(previous)
    }
    trimSessionCache()
  }
}

export const selectSession = (id: string) => {
  if (get().importingHistory) {
    return
  }
  if (!get().sessions.some((session) => session.id === id)) {
    return
  }
  const previous = get().activeId
  touchSession(id)
  set({ activeId: id })
  subscribeSessionStream(id)
  const projection = projections.get(id)
  if (projection?.session) {
    set((state) => ({
      sessionCache: { ...state.sessionCache, [id]: projection.session as Session },
    }))
  }
  if (previous !== null && previous !== id) {
    releaseSession(previous)
  }
  trimSessionCache()
}

export const renameSession = (id: string, title: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  set((state) => ({
    sessions: sortSessions(
      state.sessions.map((session) => (session.id === id ? { ...session, title } : session))
    ),
  }))
  void sendCommand(id, { command: 'rename', title }).catch(reportCommandError)
}

export const setSessionPinned = (id: string, pinned: boolean) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  set((state) => ({
    sessions: sortSessions(
      state.sessions.map((session) => (session.id === id ? { ...session, pinned } : session))
    ),
  }))
  void sendCommand(id, { command: 'pin', pinned }).catch(reportCommandError)
}

export const removeSession = (id: string): Promise<boolean> => {
  const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  deletingSessions.add(id)
  try {
    await sendCommand(id, { command: 'delete' })
    sessionStreams.get(id)?.abort()
    sessionStreams.delete(id)
    projections.delete(id)
    pendingTurns.delete(id)
    sessionAccess.delete(id)
    clearDraft(id)
    removeSessionFromState(id)
    refreshStreaming()
    return true
  } catch (error) {
    reportCommandError(error)
    return false
  } finally {
    deletingSessions.delete(id)
  }
}

const findTurnId = (sessionId: string): string | undefined => {
  const session = getSession(sessionId)
  const message = session?.messages.find(
    (item): item is AssistantMessage =>
      item.role === 'assistant' && (item.status === 'pending' || item.status === 'streaming')
  )
  if (message?.turnId) {
    return message.turnId
  }
  const projection = projections.get(sessionId)
  const running = Object.entries(projection?.turns ?? {}).find(([, status]) => status === 'running')
  return running?.[0]
}

export const stopReply = (sessionId: string) => {
  const turnId = findTurnId(sessionId)
  if (!turnId) {
    return
  }
  void sendCommand(sessionId, { command: 'stop', turnId }).catch(reportCommandError)
}

const toAttachments = (
  files: {
    id: string
    serverId: string
    name: string
    size: number
    isImage: boolean
    mimeType: string
  }[]
): FileAttachment[] =>
  files.map(({ id, serverId, name, size, isImage, mimeType }) => ({
    id,
    serverId,
    imageSizeChecked: isImage,
    name,
    size,
    isImage,
    mimeType,
  }))

const prepareAttachments = async (
  files: {
    id: string
    serverId: string
    name: string
    size: number
    isImage: boolean
    mimeType: string
    blob: Blob
  }[]
): Promise<FileAttachment[]> => {
  const attachments = toAttachments(files)
  const controller = new AbortController()
  let checked: Map<string, string | null>
  try {
    checked = await checkImageFileIds(attachments, controller.signal)
  } catch {
    return attachments
  }
  const apiKey = useSettings.getState().apiKey ?? ''
  for (const [id, serverId] of checked) {
    if (serverId !== null) {
      continue
    }
    const file = files.find((item) => item.id === id)
    const index = attachments.findIndex((item) => item.id === id)
    if (!file || index === -1) {
      continue
    }
    try {
      cancelUpload(id)
      const uploaded = await uploadAttachment(apiKey, id, file.blob, file.name, file.isImage)
      attachments[index] = { ...attachments[index], serverId: uploaded }
    } catch {
      return attachments
    }
  }
  return attachments
}

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 消息由服务端事件回灌，这里只下发命令。
 */
export const sendMessage = (targetSessionId: string | null) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const prepared = prepareDraftMessage(getDraft(targetSessionId), useUploads.getState().tasks)
  if (!prepared) {
    return false
  }
  const { text, files } = prepared
  const created = targetSessionId === null
  let sessionId = targetSessionId
  if (sessionId === null) {
    const now = Date.now()
    sessionId = createId()
    const summary: SessionSummary = { id: sessionId, title: '', createdAt: now, updatedAt: now }
    touchSession(sessionId)
    set((state) => ({
      sessions: sortSessions([summary, ...state.sessions]),
      activeId: sessionId,
    }))
  }
  const { thinking, search } = useSettings.getState()
  clearSentDraft(targetSessionId)
  void (async () => {
    const attachments = await prepareAttachments(files)
    await sendCommand(
      sessionId as string,
      { command: 'send', content: text, files: attachments, thinking, search },
      true
    )
    if (created) {
      subscribeSessionStream(sessionId as string)
    }
  })().catch((error: unknown) => {
    reportCommandError(error)
    if (created) {
      removeSessionFromState(sessionId as string)
    }
    setDraftText(get().activeId, text)
  })
  return true
}

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (sessionId: string, messageId?: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || isGenerating(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined
      ? path.length - 1
      : path.findIndex((message) => message.id === messageId)
  const question = path[index - 1]
  const answer = path[index]
  if (question?.role !== 'user' || answer?.role !== 'assistant') {
    return
  }
  sendTurnCommand(sessionId, { command: 'regenerate', messageId: answer.id })
}

/** 编辑提问后新增同父版本，保留原文件；旧问题的所有回答与后续对话仍可切回。 */
export const editMessage = (sessionId: string, messageId: string, content: string): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || isGenerating(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
    return false
  }
  sendTurnCommand(sessionId, { command: 'edit', messageId, content: text })
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  if (isGenerating(sessionId)) {
    return
  }
  void sendCommand(sessionId, { command: 'select', messageId }).catch(reportCommandError)
}

/** 继续最后一条未完成的回答：保留原消息与开关，仅将新流的内容追加到原块之后。 */
export const continueReply = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || isGenerating(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const question = path.at(-2)
  const previous = path.at(-1)
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.id !== messageId ||
    !canContinueReply(previous)
  ) {
    return
  }
  sendTurnCommand(sessionId, { command: 'continue', messageId })
}

export const retryUpload = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || isGenerating(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.error?.kind !== 'upload'
  ) {
    return
  }
  const { thinking, search } = useSettings.getState()
  void (async () => {
    const repository = getRepository()
    const apiKey = useSettings.getState().apiKey ?? ''
    const files: FileAttachment[] = []
    for (const file of question.files) {
      let serverId = file.serverId
      if (!serverId) {
        const blob = await repository.loadFile(file.id).catch(() => undefined)
        if (!blob) {
          continue
        }
        serverId = await uploadAttachment(apiKey, file.id, blob, file.name, file.isImage)
      }
      files.push({ ...file, serverId })
    }
    await sendCommand(
      sessionId,
      { command: 'send', content: question.content, files, thinking, search },
      true
    )
  })().catch(reportCommandError)
}
