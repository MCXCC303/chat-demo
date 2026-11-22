import { useEffect } from 'react'
import {
  closeMobileSider,
  openMobileSider,
  setMobileSiderOffset,
  useMobileSider,
} from './mobileSiderState.js'
import { isInHorizontalScrollContainer } from '../../utils/scroll.js'
import { clearSiderOffset, paintSiderOffset } from './mobileSiderDrag.js'

const ENGAGE_THRESHOLD = 10
const FALLBACK_WIDTH = 261

const readDrawerWidth = () => {
  const drawer = document.querySelector<HTMLElement>('[data-mobile-sider]')
  const measured = drawer?.getBoundingClientRect().width ?? 0
  if (measured > 0) {
    return measured
  }
  const raw = getComputedStyle(document.body).getPropertyValue('--dsw-sider-width')
  const width = Number.parseFloat(raw)
  return Number.isFinite(width) && width > 0 ? width : FALLBACK_WIDTH
}

export const useMobileDrawerDrag = (enabled: boolean) => {
  useEffect(() => {
    if (!enabled) {
      return
    }
    let startX = 0
    let startY = 0
    let width = FALLBACK_WIDTH
    let base = 0
    let dragging = false
    let contentScrollable = false
    let lastOffset = 0

    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!touch) {
        return
      }
      contentScrollable = isInHorizontalScrollContainer(event.target)
      width = readDrawerWidth()
      startX = touch.clientX
      startY = touch.clientY
      base = useMobileSider.getState().open ? width : 0
      dragging = false
    }

    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!touch) {
        return
      }
      if (contentScrollable) {
        return
      }
      const deltaX = touch.clientX - startX
      const deltaY = touch.clientY - startY
      if (!dragging) {
        if (Math.abs(deltaX) < ENGAGE_THRESHOLD || Math.abs(deltaX) <= Math.abs(deltaY)) {
          return
        }
        dragging = true
        setMobileSiderOffset(base, base / width, true)
      }
      if (event.cancelable) {
        event.preventDefault()
      }
      lastOffset = Math.min(width, Math.max(0, base + deltaX))
      paintSiderOffset(lastOffset, lastOffset / width, width)
    }

    const onTouchEnd = () => {
      if (!dragging) {
        return
      }
      dragging = false
      clearSiderOffset()
      setMobileSiderOffset(lastOffset, lastOffset / width, false)
      if (lastOffset > width * 0.4) {
        openMobileSider()
      } else {
        closeMobileSider()
      }
    }

    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', onTouchEnd)
    window.addEventListener('touchcancel', onTouchEnd)
    return () => {
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [enabled])
}
