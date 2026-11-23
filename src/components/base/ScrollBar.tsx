import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import clsx from 'clsx'
import styles from './ScrollBar.module.css'

type ScrollBarProps = {
  containerRef: RefObject<HTMLElement | null>
  size?: number
  inset?: number
  className?: string
  indicator?: boolean
}

export const ScrollBar = ({
  containerRef,
  size = 6,
  inset = 0,
  className,
  indicator = false,
}: ScrollBarProps) => {
  const thumbRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  const update = useCallback(() => {
    const el = containerRef.current
    const thumb = thumbRef.current
    if (!el || !thumb) {
      return
    }
    const { scrollHeight, clientHeight, scrollTop } = el
    const maxScroll = scrollHeight - clientHeight
    if (maxScroll <= 0) {
      thumb.style.height = '0px'
      return
    }
    const height = Math.max((clientHeight * clientHeight) / scrollHeight, 24)
    thumb.style.height = `${height}px`
    thumb.style.transform = `translateY(${(scrollTop / maxScroll) * (clientHeight - height)}px)`
  }, [containerRef])

  useEffect(() => {
    const el = containerRef.current
    if (!el) {
      return
    }
    update()
    let hideTimer: ReturnType<typeof setTimeout> | undefined
    const onScroll = () => {
      update()
      if (!indicator) {
        return
      }
      setVisible(true)
      clearTimeout(hideTimer)
      hideTimer = setTimeout(() => setVisible(false), 800)
    }
    el.addEventListener('scroll', onScroll, { passive: true })

    const resizeObserver = new ResizeObserver(update)
    resizeObserver.observe(el)
    const contentObserver = new ResizeObserver(update)
    const observeContent = () => {
      contentObserver.disconnect()
      for (const child of Array.from(el.children)) {
        contentObserver.observe(child)
      }
    }
    observeContent()
    const mutationObserver = new MutationObserver(() => {
      observeContent()
      update()
    })
    mutationObserver.observe(el, { childList: true })

    const show = () => setVisible(true)
    const hide = () => setVisible(false)
    if (!indicator) {
      el.addEventListener('mouseenter', show)
      el.addEventListener('mouseleave', hide)
    }

    return () => {
      clearTimeout(hideTimer)
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('mouseenter', show)
      el.removeEventListener('mouseleave', hide)
      resizeObserver.disconnect()
      contentObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [containerRef, update, indicator])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = containerRef.current
    const thumb = thumbRef.current
    if (indicator || !el || !thumb) {
      return
    }
    event.preventDefault()
    const startY = event.clientY
    const startScroll = el.scrollTop
    const travel = Math.max(el.clientHeight - thumb.offsetHeight, 1)
    const ratio = (el.scrollHeight - el.clientHeight) / travel
    const move = (moveEvent: PointerEvent) => {
      el.scrollTop = startScroll + (moveEvent.clientY - startY) * ratio
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  return (
    <div
      className={clsx(
        styles.gutter,
        visible && styles.visible,
        indicator && styles.indicator,
        className
      )}
      style={{ paddingTop: inset, paddingBottom: inset }}
      data-scroll-bar
    >
      <div
        ref={thumbRef}
        className={styles.thumb}
        style={{ '--scrollbar-size': `${size}px` } as CSSProperties}
        onPointerDown={indicator ? undefined : onPointerDown}
      />
    </div>
  )
}
