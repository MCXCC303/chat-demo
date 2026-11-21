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
