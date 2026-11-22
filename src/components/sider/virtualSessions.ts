import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

export type ListMetrics = {
  itemHeight: number
  headerHeight: number
  sectionGap: number
  sectionPadding: number
}

export type ItemRange = { start: number; end: number }

const FALLBACK: ListMetrics = {
  itemHeight: 40,
  headerHeight: 22,
  sectionGap: 16,
  sectionPadding: 4,
}

const OVERSCAN = 320
const INITIAL_VISIBLE = 20

const readToken = (styles: CSSStyleDeclaration, name: string, fallback: number): number => {
  const value = Number.parseFloat(styles.getPropertyValue(name))
  return Number.isFinite(value) ? value : fallback
}

export const readListMetrics = (): ListMetrics => {
  const styles = getComputedStyle(document.body)
  return {
    itemHeight: readToken(styles, '--dsw-session-item-height', FALLBACK.itemHeight),
    headerHeight: readToken(styles, '--dsw-session-header-height', FALLBACK.headerHeight),
    sectionGap: readToken(styles, '--dsw-session-section-gap', FALLBACK.sectionGap),
    sectionPadding: readToken(styles, '--dsw-session-section-padding', FALLBACK.sectionPadding),
  }
}

const sectionPitch = (metrics: ListMetrics, index: number): number =>
  (index === 0 ? 0 : metrics.sectionGap) + metrics.sectionPadding + metrics.headerHeight

export const sectionTops = (counts: number[], metrics: ListMetrics): number[] => {
  const tops: number[] = []
  let offset = 0
  for (let index = 0; index < counts.length; index += 1) {
    offset += sectionPitch(metrics, index)
    tops.push(offset)
    offset += counts[index] * metrics.itemHeight
  }
  return tops
}

export const visibleRange = (
  top: number,
  count: number,
  metrics: ListMetrics,
  scrollTop: number,
  viewport: number
): ItemRange => {
  const first = Math.floor((scrollTop - OVERSCAN - top) / metrics.itemHeight)
  const last = Math.ceil((scrollTop + viewport + OVERSCAN - top) / metrics.itemHeight)
  const start = Math.min(Math.max(first, 0), count)
  const end = Math.min(Math.max(last, start), count)
  return { start, end }
}

const sameRanges = (left: ItemRange[], right: ItemRange[]): boolean =>
  left.length === right.length &&
  left.every((range, index) => range.start === right[index].start && range.end === right[index].end)

export const useVirtualSessions = (
  containerRef: RefObject<HTMLDivElement | null>,
  counts: number[]
) => {
  const [metrics, setMetrics] = useState<ListMetrics>(FALLBACK)
  const [ranges, setRanges] = useState<ItemRange[]>([])
  const countsRef = useRef(counts)
  countsRef.current = counts
  const countsKey = counts.join(',')

  const compute = useCallback(() => {
    const list = containerRef.current
    const current = countsRef.current
    if (!list || current.length === 0) {
      setRanges((previous) => (previous.length === 0 ? previous : []))
      return
    }
    const tops = sectionTops(current, metrics)
    const next = current.map((count, index) =>
      visibleRange(tops[index], count, metrics, list.scrollTop, list.clientHeight)
    )
    setRanges((previous) => (sameRanges(previous, next) ? previous : next))
  }, [containerRef, metrics])

  useEffect(() => {
    setMetrics(readListMetrics())
  }, [])

  useEffect(() => {
    compute()
  }, [compute, countsKey])

  useEffect(() => {
    const list = containerRef.current
    if (!list) {
      return
    }
    let frame = 0
    const schedule = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0
        compute()
      })
    }
    const observer = new ResizeObserver(() => {
      setMetrics(readListMetrics())
      schedule()
    })
    observer.observe(list)
    list.addEventListener('scroll', schedule, { passive: true })
    return () => {
      observer.disconnect()
      list.removeEventListener('scroll', schedule)
      if (frame) {
        cancelAnimationFrame(frame)
      }
    }
  }, [containerRef, compute])

  const resolved =
    ranges.length === counts.length && counts.length > 0
      ? ranges
      : counts.map((count) => ({ start: 0, end: Math.min(count, INITIAL_VISIBLE) }))

  return { metrics, ranges: resolved }
}
