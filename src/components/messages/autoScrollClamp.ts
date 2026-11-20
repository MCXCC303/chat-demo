export type ScrollClampResult = {
  target: number
  shouldStop: boolean
}

export const clampScrollTop = ({
  scrollHeight,
  clientHeight,
  scrollTop,
  bodyTopOffset,
  stopped,
}: {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
  bodyTopOffset: number | null
  stopped: boolean
}): ScrollClampResult => {
  const bottomTarget = scrollHeight - clientHeight
  if (!Number.isFinite(bottomTarget)) {
    return { target: scrollTop, shouldStop: false }
  }
  if (stopped || bodyTopOffset === null || bodyTopOffset < -1) {
    return { target: bottomTarget, shouldStop: false }
  }
  const bodyTop = scrollTop + bodyTopOffset
  if (!Number.isFinite(bodyTop) || bodyTop >= bottomTarget - 1) {
    return { target: bottomTarget, shouldStop: false }
  }
  return { target: Math.max(bodyTop, scrollTop), shouldStop: true }
}
