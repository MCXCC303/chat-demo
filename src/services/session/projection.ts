import type { ContentBlockDelta, OutputBlockStart } from '../api/types.js'
import { toReplyBlock } from '../chat/reply.js'
import type { AssistantMessage, Message, ReplyBlock, Session } from '../chat/types.js'
import type { SessionStreamFrame } from './types.js'

export type SessionProjection = {
  session: Session | null
  seq: number
  turns: Record<string, 'running' | 'done' | 'stopped' | 'error'>
}

export const createProjection = (): SessionProjection => ({
  session: null,
  seq: 0,
  turns: {},
})

const replaceBlock = (blocks: ReplyBlock[], index: number, block: ReplyBlock): ReplyBlock[] => {
  const next = [...blocks]
  next[index] = block
  return next
}

const upsertMessage = (session: Session, message: Message): Session => {
  const messages = session.messages.some((item) => item.id === message.id)
    ? session.messages.map((item) => (item.id === message.id ? message : item))
    : [...session.messages, message]
  return {
    ...session,
    messages,
    rootMessageId: message.parentId ? session.rootMessageId : message.id,
    updatedAt: Date.now(),
  }
}

const updateAssistant = (
  session: Session,
  messageId: string,
  update: (message: AssistantMessage) => AssistantMessage
): Session => ({
  ...session,
  messages: session.messages.map((message) =>
    message.id === messageId && message.role === 'assistant' ? update(message) : message
  ),
  updatedAt: Date.now(),
})

const applyBlock = (
  message: AssistantMessage,
  index: number,
  block: OutputBlockStart
): AssistantMessage => {
  const reply = toReplyBlock(block, Date.now())
  if (!reply) {
    return message
  }
  const blocks = [...message.blocks]
  blocks[index] = reply
  return { ...message, blocks }
}

const applyDelta = (
  message: AssistantMessage,
  index: number,
  delta: ContentBlockDelta
): AssistantMessage => {
  const block = message.blocks[index]
  if (!block) {
    return message
  }
  if (block.type === 'text' && delta.type === 'text_delta') {
    return {
      ...message,
      blocks: replaceBlock(message.blocks, index, { ...block, text: block.text + delta.text }),
    }
  }
  if (block.type === 'thinking' && delta.type === 'thinking_delta') {
    return {
      ...message,
      blocks: replaceBlock(message.blocks, index, {
        ...block,
        thinking: block.thinking + delta.thinking,
      }),
    }
  }
  if (block.type === 'thinking' && delta.type === 'signature_delta') {
    return {
      ...message,
      blocks: replaceBlock(message.blocks, index, {
        ...block,
        signature: (block.signature ?? '') + delta.signature,
      }),
    }
  }
  if (block.type === 'text' && delta.type === 'citations_delta') {
    return {
      ...message,
      blocks: replaceBlock(message.blocks, index, {
        ...block,
        citations: [...(block.citations ?? []), delta.citation],
      }),
    }
  }
  return message
}

export const applyFrame = (
  projection: SessionProjection,
  frame: SessionStreamFrame
): SessionProjection => {
  const seq = Math.max(projection.seq, frame.seq)
  switch (frame.type) {
    case 'session/meta': {
      const meta = frame.payload as {
        sessionId: string
        title: string
        pinned: boolean
        createdAt: number
        updatedAt: number
      }
      const session: Session = projection.session
        ? { ...projection.session, ...meta }
        : {
            id: meta.sessionId,
            title: meta.title,
            pinned: meta.pinned,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
            messages: [],
            rootMessageId: null,
          }
      return { ...projection, seq, session }
    }
    case 'message/upsert': {
      const { message } = frame.payload as { message: Message }
      if (!projection.session) {
        return { ...projection, seq }
      }
      return { ...projection, seq, session: upsertMessage(projection.session, message) }
    }
    case 'message/block': {
      const { messageId, index, block } = frame.payload as {
        messageId: string
        index: number
        block: OutputBlockStart
      }
      if (!projection.session) {
        return { ...projection, seq }
      }
      return {
        ...projection,
        seq,
        session: updateAssistant(projection.session, messageId, (message) =>
          applyBlock(message, index, block)
        ),
      }
    }
    case 'message/delta': {
      const { messageId, index, delta } = frame.payload as {
        messageId: string
        index: number
        delta: ContentBlockDelta
      }
      if (!projection.session) {
        return { ...projection, seq }
      }
      return {
        ...projection,
        seq,
        session: updateAssistant(projection.session, messageId, (message) =>
          applyDelta(message, index, delta)
        ),
      }
    }
    case 'message/block-end': {
      const { messageId, index } = frame.payload as { messageId: string; index: number }
      if (!projection.session) {
        return { ...projection, seq }
      }
      return {
        ...projection,
        seq,
        session: updateAssistant(projection.session, messageId, (message) => {
          const block = message.blocks[index]
          if (!block || block.type !== 'thinking' || block.endedAt !== undefined) {
            return message
          }
          return {
            ...message,
            blocks: replaceBlock(message.blocks, index, { ...block, endedAt: Date.now() }),
          }
        }),
      }
    }
    case 'branch/selected': {
      const { parentId, selectedChildId } = frame.payload as {
        parentId: string | null
        selectedChildId: string | null
      }
      if (!projection.session) {
        return { ...projection, seq }
      }
      return {
        ...projection,
        seq,
        session: {
          ...projection.session,
          rootMessageId:
            parentId === null ? (selectedChildId ?? null) : projection.session.rootMessageId,
          messages: projection.session.messages.map((message) =>
            message.id === parentId
              ? { ...message, selectedChildId: selectedChildId ?? undefined }
              : message
          ),
        },
      }
    }
    case 'turn/state': {
      const { turnId, status } = frame.payload as {
        turnId: string
        status: 'running' | 'done' | 'stopped' | 'error'
      }
      return { ...projection, seq, turns: { ...projection.turns, [turnId]: status } }
    }
    case 'session/deleted': {
      return { ...projection, seq, session: null }
    }
    default:
      return { ...projection, seq }
  }
}
