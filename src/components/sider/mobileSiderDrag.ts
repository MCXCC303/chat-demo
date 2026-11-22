type SiderTargets = {
  drawer: HTMLElement | null
  mask: HTMLElement | null
  main: HTMLElement | null
}

const targets: SiderTargets = { drawer: null, mask: null, main: null }
let frame = 0
let pending: { offset: number; progress: number; width: number } | null = null

export const setSiderDragTarget = <K extends keyof SiderTargets>(
  key: K,
  element: SiderTargets[K]
) => {
  targets[key] = element
}

const paint = () => {
  frame = 0
  const next = pending
  pending = null
  if (!next) {
    return
  }
  if (targets.drawer) {
    targets.drawer.style.transform = `translateX(${next.offset - next.width}px)`
  }
  if (targets.mask) {
    targets.mask.style.transition = 'none'
    targets.mask.style.opacity = String(next.progress)
  }
  if (targets.main) {
    targets.main.style.transform = `translateX(${next.offset}px)`
  }
}

export const paintSiderOffset = (offset: number, progress: number, width: number) => {
  pending = { offset, progress, width }
  frame ||= requestAnimationFrame(paint)
}

export const clearSiderOffset = () => {
  if (frame) {
    cancelAnimationFrame(frame)
    frame = 0
  }
  pending = null
  for (const element of [targets.drawer, targets.mask, targets.main]) {
    if (element) {
      element.style.removeProperty('transform')
      element.style.removeProperty('opacity')
      element.style.removeProperty('transition')
    }
  }
}
