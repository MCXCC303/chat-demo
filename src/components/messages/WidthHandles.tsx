import { useCallback, useLayoutEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import styles from './WidthHandles.module.css'

const WIDTH_PREF_KEY = 'chat-demo.message-list-width'
const COLUMN_MIN = 640
const COLUMN_EDGE_BUDGET = 100
const COLUMN_CAP_MARGIN = 40
const POINTER_Y_VAR = '--message-list-handle-pointer-y'

const readPreference = (): number | null => {
  const raw = localStorage.getItem(WIDTH_PREF_KEY)
  if (raw === null) {
    return null
  }
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

const clampColumn = (available: number, preference: number): number => {
  const cap = available - COLUMN_CAP_MARGIN
  const floor = Math.min(COLUMN_MIN, cap)
  const max = Math.max(floor, available - COLUMN_EDGE_BUDGET)
  return Math.min(Math.max(preference, floor), max)
}

const publishColumn = (width: number | null): void => {
  const root = document.documentElement
  if (width === null) {
    root.style.removeProperty('--message-list-width-pref')
    return
  }
  root.style.setProperty('--message-list-width-pref', `${width}px`)
}

const WidthHandle = ({
  side,
  onStart,
  onDrag,
  onCommit,
  onEnd,
}: {
  side: 'left' | 'right'
  onStart: () => number
  onDrag: (width: number) => void
  onCommit: (width: number) => void
  onEnd: () => void
}) => {
  const dragging = useRef(false)
  const base = useRef(0)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)

  const outwardWidth = () => {
    const delta = latest.current - origin.current
    const outward = side === 'right' ? delta : -delta
    return base.current + outward * 2
  }

  const cancelFrame = () => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    origin.current = event.clientX
    latest.current = event.clientX
    base.current = onStart()
    dragging.current = true
    event.currentTarget.toggleAttribute('data-dragging', true)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !event.currentTarget.hasPointerCapture(event.pointerId)) {
      return
    }
    const box = event.currentTarget.getBoundingClientRect()
    event.currentTarget.style.setProperty(POINTER_Y_VAR, `${event.clientY - box.top}px`)
    latest.current = event.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      onDrag(outwardWidth())
    })
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !event.currentTarget.hasPointerCapture(event.pointerId)) {
      return
    }
    dragging.current = false
    event.currentTarget.toggleAttribute('data-dragging', false)
    event.currentTarget.releasePointerCapture(event.pointerId)
    cancelFrame()
    latest.current = event.clientX
    if (latest.current !== origin.current) {
      onCommit(outwardWidth())
    }
    onEnd()
  }

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) {
      return
    }
    dragging.current = false
    event.currentTarget.toggleAttribute('data-dragging', false)
    cancelFrame()
    onEnd()
  }

  return (
    <div
      className={styles.handle}
      data-side={side}
      data-width-handle={side}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    />
  )
}

export const WidthHandles = ({
  containerRef,
  columnRef,
}: {
  containerRef: RefObject<HTMLElement | null>
  columnRef: RefObject<HTMLElement | null>
}) => {
  const applyPreference = useCallback(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const preference = readPreference()
    publishColumn(preference === null ? null : clampColumn(container.clientWidth, preference))
  }, [containerRef])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    applyPreference()
    const observer = new ResizeObserver(() => applyPreference())
    observer.observe(container)
    return () => {
      observer.disconnect()
      publishColumn(null)
    }
  }, [applyPreference, containerRef])

  const onStart = useCallback(() => {
    const column = columnRef.current
    return column ? column.offsetWidth : COLUMN_MIN
  }, [columnRef])

  const onDrag = useCallback(
    (width: number) => {
      const container = containerRef.current
      if (!container) {
        return
      }
      publishColumn(clampColumn(container.clientWidth, width))
    },
    [containerRef]
  )

  const onCommit = useCallback(
    (width: number) => {
      const container = containerRef.current
      if (!container) {
        return
      }
      localStorage.setItem(WIDTH_PREF_KEY, `${clampColumn(container.clientWidth, width)}`)
    },
    [containerRef]
  )

  const onEnd = useCallback(() => applyPreference(), [applyPreference])

  return (['left', 'right'] as const).map((side) => (
    <WidthHandle
      key={side}
      side={side}
      onStart={onStart}
      onDrag={onDrag}
      onCommit={onCommit}
      onEnd={onEnd}
    />
  ))
}
