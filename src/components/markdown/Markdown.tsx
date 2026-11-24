import { memo, useLayoutEffect, useMemo, useRef } from 'react'
import type { Source } from '../../services/chat/view.js'
import { toMdAst } from '../../services/markdown/parse.js'
import { useScrollToBottom } from '../messages/scrollContext.js'
import { StreamTokenContext } from './streamToken.js'
import { MarkdownAstRenderer } from './MarkdownAstRenderer.js'
import { useThrottleMarkdownRender } from './useThrottleMarkdownRender.js'
import './markdown.css'
import './highlight.css'

const TOKEN_CATCHUP_LIMIT = 240

/**
 * 渲染链路：节流 → 解析 AST → 渲染。
 * 传入 sources 时把正文里的 [citation:N] 渲染为角标。
 */
export const Markdown = memo(function Markdown({
  content,
  loading,
  cacheKey,
  className,
  disableLink,
  sources,
}: {
  content: string
  loading: boolean
  cacheKey: string
  className?: string
  disableLink: boolean
  sources?: Source[]
}) {
  const scrollToBottom = useScrollToBottom()
  const throttledMarkdown = useThrottleMarkdownRender(content, loading)
  const previousLengthRef = useRef(0)
  const startedRef = useRef(false)
  const jump = throttledMarkdown.length - previousLengthRef.current
  const animate = loading && jump >= 0 && jump <= TOKEN_CATCHUP_LIMIT
  const initial = !startedRef.current && throttledMarkdown.length > 0
  const tokenState = useMemo(
    () => ({ streaming: loading, animate, initial }),
    [loading, animate, initial]
  )
  useLayoutEffect(() => {
    previousLengthRef.current = throttledMarkdown.length
    if (throttledMarkdown) {
      startedRef.current = true
    }
  }, [throttledMarkdown])
  const ast = useMemo(
    () => (throttledMarkdown ? toMdAst(throttledMarkdown, { sources, disableLink }) : null),
    [throttledMarkdown, sources, disableLink]
  )
  return ast ? (
    <StreamTokenContext.Provider value={tokenState}>
      <MarkdownAstRenderer
        key={cacheKey}
        className={className}
        ast={ast}
        loading={loading}
        onUpdate={scrollToBottom}
      />
    </StreamTokenContext.Provider>
  ) : null
})
