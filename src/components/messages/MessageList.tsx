import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import {
  buildMessageVersions,
  getVisibleMessages,
  type MessageVersions,
} from '../../services/chat/branches.js'
import { selectMessageVersion } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { AssistantMessage } from './AssistantMessage.js'
import { clampScrollTop } from './autoScrollClamp.js'
import { ScrollBar } from '../base/ScrollBar.js'
import { ScrollNav, type ScrollNavItem } from './ScrollNav.js'
import { ScrollToBottomContext, ScrollToLatestContext } from './scrollContext.js'
import { UserMessage } from './UserMessage.js'
import { WidthHandles } from './WidthHandles.js'
import type { Message } from '../../services/chat/types.js'

/**
 * 会话共用可重试的附件上传失败入口，覆盖当前提问与历史消息中的附件。
 * 点击后按失败的回答重新补传附件并请求。
 */
const getUploadRetryId = (messages: Message[], streaming: boolean) => {
  const last = messages.at(-1)
  return !streaming &&
    last?.role === 'assistant' &&
    last.status === 'error' &&
    last.error?.kind === 'upload' &&
    last.error.retryable
    ? last.id
    : null
}
import styles from './MessageList.module.css'

/** 距底部小于该值时视为在底部，流式内容增长时跟随 */
const STICKY_THRESHOLD = 40
const SCROLL_BOTTOM_THRESHOLD = 52
const EMPTY_VERSIONS: MessageVersions = { ids: [], index: -1 }

const isScrollBottomVisible = (el: HTMLElement) =>
  el.scrollTop + el.clientHeight <= el.scrollHeight - SCROLL_BOTTOM_THRESHOLD

const findActiveQuestionId = (
  el: HTMLElement,
  messages: Message[],
  inputHeight: number
): string | null => {
  const rect = el.getBoundingClientRect()
  const visible = rect.height - inputHeight
  const maxScroll = el.scrollHeight - el.clientHeight
  if (visible <= 0 || maxScroll <= 0) {
    return null
  }
  const line =
    maxScroll < visible
      ? rect.top + (el.scrollTop / maxScroll) * visible
      : el.scrollTop >= visible
        ? rect.top + visible
        : rect.top + el.scrollTop

  let current: string | null = null
  let lastAbove: string | null = null
  for (const element of el.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const box = element.getBoundingClientRect()
    if (box.bottom < line) {
      lastAbove = element.getAttribute('data-message-id')
      continue
    }
    if (box.top <= line) {
      current = element.getAttribute('data-message-id')
    }
    break
  }
  const messageId = current ?? lastAbove
  if (!messageId) {
    return null
  }
  const message = messages.find((item) => item.id === messageId)
  if (!message) {
    return null
  }
  return message.role === 'assistant' ? (message.parentId ?? null) : message.id
}

export const MessageList = ({
  session,
  streaming,
  footer,
}: {
  session: Session
  streaming: boolean
  footer: React.ReactNode
}) => {
  const isMobile = useIsMobile()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const scrollTopRef = useRef(0)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  const streamingIdRef = useRef<string | null>(null)
  const stoppedRef = useRef<string | null>(null)
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const [activeNavId, setActiveNavId] = useState<string | null>(null)
  const messages = getVisibleMessages(session)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  const navItems = useMemo<ScrollNavItem[]>(
    () =>
      messages
        .filter((message) => message.role === 'user')
        .map((message) => ({
          id: message.id,
          title: message.content || message.files[0]?.name || '',
        })),
    [messages]
  )
  const [previousVersions, setPreviousVersions] = useState(() =>
    buildMessageVersions(session, new Map())
  )
  const versions = useMemo(
    () => buildMessageVersions(session, previousVersions),
    [session, previousVersions]
  )
  if (versions !== previousVersions) {
    setPreviousVersions(versions)
  }
  const lastMessage = messages.at(-1)
  const lastMessageId = lastMessage?.id
  const streamingMessageId = streaming && lastMessage?.role === 'assistant' ? lastMessage.id : null

  useLayoutEffect(() => {
    streamingIdRef.current = streamingMessageId
  }, [streamingMessageId])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    if (stickyRef.current) {
      const messageId = streamingIdRef.current
      const body = messageId
        ? el.querySelector<HTMLElement>(
            `[data-message-id="${CSS.escape(messageId)}"] .ds-assistant-message-main-content`
          )
        : null
      const result = clampScrollTop({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollTop: el.scrollTop,
        bodyTopOffset: body
          ? body.getBoundingClientRect().top - el.getBoundingClientRect().top
          : null,
        stopped: messageId !== null && stoppedRef.current === messageId,
      })
      if (result.shouldStop && messageId !== null) {
        stoppedRef.current = messageId
        stickyRef.current = false
      }
      el.scrollTop = result.target
      scrollTopRef.current = el.scrollTop
    }
    setShowScrollBottom(isScrollBottomVisible(el))
  }, [])

  const scrollToLatest = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    stickyRef.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    scrollTopRef.current = el.scrollTop
    setShowScrollBottom(false)
  }, [])

  const navFrameRef = useRef(0)
  const updateActiveNav = useCallback(() => {
    if (navFrameRef.current) {
      return
    }
    navFrameRef.current = requestAnimationFrame(() => {
      navFrameRef.current = 0
      const el = scrollRef.current
      if (!el) {
        return
      }
      const inputArea = el.querySelector('[data-chat-input-area]')
      const inputHeight = inputArea ? inputArea.getBoundingClientRect().height : 0
      setActiveNavId(findActiveQuestionId(el, messagesRef.current, inputHeight))
    })
  }, [])

  const scrollToQuestion = useCallback((messageId: string) => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    const target = el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
    if (!target) {
      return
    }
    const offset = target.getBoundingClientRect().top - el.getBoundingClientRect().top
    stickyRef.current = false
    el.scrollTo({ top: el.scrollTop + offset, behavior: 'smooth' })
  }, [])

  // 内容、键盘和输入框高度变化时，继续遵循当前跟随状态。
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroll = scrollRef.current
    if (!content || !scroll) {
      return
    }
    const observer = new ResizeObserver(scrollToBottom)
    observer.observe(content)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [isMobile, scrollToBottom])

  // 切换版本后将选择器留在原位置，避免回答长短变化导致操作区跳出视口。
  useLayoutEffect(() => {
    const anchor = restoreScrollRef.current
    const scroll = scrollRef.current
    if (anchor && scroll) {
      const switcher = scroll.querySelector<HTMLElement>(
        `[data-message-version="${CSS.escape(anchor.messageId)}"]`
      )
      if (switcher) {
        scroll.scrollTop += switcher.getBoundingClientRect().top - anchor.top
      }
      restoreScrollRef.current = null
      return
    }
    stickyRef.current = true
    scrollToBottom()
  }, [session.id, lastMessageId, scrollToBottom])

  useEffect(closeSearchPanel, [session.id, lastMessageId])

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      restoreScrollRef.current = { messageId, top: anchorTop }
      stickyRef.current = false
      closeSearchPanel()
      selectMessageVersion(session.id, messageId)
    },
    [session.id, streaming]
  )

  // 跨移动端断点时切换滚动层，并保持输入框及当前阅读位置。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    if (stickyRef.current) {
      scrollToBottom()
    } else {
      el.scrollTop = scrollTopRef.current
    }
    const onScroll = () => {
      const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      const nearBottom = distanceToBottom < STICKY_THRESHOLD
      const frozen = stoppedRef.current !== null && stoppedRef.current === streamingIdRef.current
      // 仅在用户向上滚动时停止跟随底部，布局或内容增高时保持跟随状态。
      if (nearBottom && (!frozen || distanceToBottom <= 1)) {
        stickyRef.current = true
      } else if (el.scrollTop < scrollTopRef.current) {
        stickyRef.current = false
      }
      scrollTopRef.current = el.scrollTop
      setShowScrollBottom(isScrollBottomVisible(el))
      updateActiveNav()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [isMobile, scrollToBottom, updateActiveNav])

  const lastIndex = messages.length - 1
  const uploadRetryId = getUploadRetryId(messages, streaming)
  return (
    <ScrollToBottomContext.Provider value={scrollToBottom}>
      <ScrollToLatestContext.Provider
        value={{ visible: showScrollBottom, streaming, scrollToLatest }}
      >
        <div className={styles.listView}>
          <div ref={isMobile ? undefined : scrollRef} className={styles.container}>
            <div ref={isMobile ? scrollRef : undefined} className={styles.scroll}>
              <div ref={contentRef} className={styles.column}>
                {messages.map((message, index) =>
                  message.role === 'user' ? (
                    <UserMessage
                      key={message.id}
                      sessionId={session.id}
                      message={message}
                      retryUploadId={uploadRetryId}
                      isFirst={index === 0}
                      isLast={index === lastIndex || index === lastIndex - 1}
                      busy={streaming}
                      versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                      onSelectVersion={selectVersion}
                    />
                  ) : (
                    <AssistantMessage
                      key={message.id}
                      sessionId={session.id}
                      message={message}
                      isLast={index === lastIndex}
                      streaming={streaming && index === lastIndex}
                      busy={streaming}
                      versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                      onSelectVersion={selectVersion}
                    />
                  )
                )}
              </div>
            </div>
            {footer}
          </div>
          <ScrollBar containerRef={scrollRef} size={6} inset={4} />
          <ScrollNav items={navItems} activeId={activeNavId} onSelect={scrollToQuestion} />
          {isMobile ? null : <WidthHandles containerRef={scrollRef} columnRef={contentRef} />}
        </div>
      </ScrollToLatestContext.Provider>
    </ScrollToBottomContext.Provider>
  )
}
