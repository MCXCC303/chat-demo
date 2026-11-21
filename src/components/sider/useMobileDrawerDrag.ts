import { useEffect } from 'react'
import {
  closeMobileSider,
  openMobileSider,
  setMobileSiderOffset,
  useMobileSider,
} from './mobileSiderState.js'

const ENGAGE_THRESHOLD = 10
const FALLBACK_WIDTH = 261

const readDrawerWidth = () => {
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

    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!touch) {
        return
      }
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
      const deltaX = touch.clientX - startX
      const deltaY = touch.clientY - startY
      if (!dragging) {
        if (Math.abs(deltaX) < ENGAGE_THRESHOLD || Math.abs(deltaX) <= Math.abs(deltaY)) {
          return
        }
        dragging = true
      }
      if (event.cancelable) {
        event.preventDefault()
      }
      const offset = Math.min(width, Math.max(0, base + deltaX))
      setMobileSiderOffset(offset, offset / width, true)
    }

    const onTouchEnd = () => {
      if (!dragging) {
        return
      }
      dragging = false
      const { offset } = useMobileSider.getState()
      setMobileSiderOffset(offset, offset / width, false)
      if (offset > width * 0.4) {
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
