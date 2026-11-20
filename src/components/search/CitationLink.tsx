import { useLayoutEffect, useRef, type MouseEvent } from 'react'
import type { Source } from '../../services/chat/view.js'
import { HoverCard, type HoverCardTrigger } from './HoverCard.js'
import { SourceCard } from './SourceCard.js'

const BADGE_HEIGHT = 14
const BADGE_PADDING = 4

export const CitationLink = ({ source }: { source: Source }) => {
  const ghostRef = useRef<HTMLSpanElement | null>(null)
  const numberRef = useRef<HTMLSpanElement | null>(null)
  const badgeRef = useRef<HTMLSpanElement | null>(null)
  const label = String(source.index)
  const minWidth = label.length > 1 ? 20 : 14

  useLayoutEffect(() => {
    const ghost = ghostRef.current
    const number = numberRef.current
    const badge = badgeRef.current
    if (!ghost || !number || !badge) {
      return
    }
    const update = () => {
      const ghostRect = ghost.getBoundingClientRect()
      const vertical = (BADGE_HEIGHT - ghostRect.height) / 2
      badge.style.paddingTop = `${vertical}px`
      badge.style.paddingBottom = `${vertical}px`
      badge.style.paddingLeft = `${BADGE_PADDING}px`
      badge.style.paddingRight = `${BADGE_PADDING}px`
      const available = minWidth - BADGE_PADDING * 2
      const contentWidth = number.getBoundingClientRect().width
      const width = contentWidth < available ? available : contentWidth
      ghost.style.margin = `0 ${(width - ghostRect.width) / 2}px`
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(number)
    return () => observer.disconnect()
  }, [label, minWidth])

  const open = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    window.open(source.url, '_blank', 'noopener,noreferrer')
  }

  const renderTrigger: HoverCardTrigger = ({ domRef, domProps }) => (
    <span
      ref={(node) => {
        badgeRef.current = node
        domRef.current = node
      }}
      className="ds-markdown-cite"
      style={{ display: 'inline' }}
      {...domProps}
      role="link"
      onClick={open}
    >
      <span ref={ghostRef} style={{ opacity: 0 }}>
        -
      </span>
      <span
        ref={numberRef}
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translateX(-50%) translateY(-50%)',
        }}
      >
        {label}
      </span>
    </span>
  )

  return (
    <HoverCard renderTrigger={renderTrigger}>
      <SourceCard source={source} />
    </HoverCard>
  )
}
