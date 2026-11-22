export const findScrollContainer = (element: HTMLElement | null): HTMLElement | null => {
  let current = element?.parentElement ?? null
  while (current && current !== document.body) {
    const style = getComputedStyle(current)
    if (
      style.overflowY === 'auto' ||
      style.overflowY === 'scroll' ||
      style.overflow === 'auto' ||
      style.overflow === 'scroll'
    ) {
      return current
    }
    current = current.parentElement
  }
  return null
}

export const isInHorizontalScrollContainer = (target: EventTarget | null) => {
  for (
    let element = target instanceof Element ? target : null;
    element && element !== document.body;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element)
    if (/auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth) {
      return true
    }
  }
  return false
}
