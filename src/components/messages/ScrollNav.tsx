import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import styles from './ScrollNav.module.css'

export type ScrollNavItem = {
  id: string
  title: string
}

type Edge = 'none' | 'atTop' | 'atBottom' | 'middle'

type ScrollNavProps = {
  items: ScrollNavItem[]
  activeId: string | null
  onSelect: (id: string) => void
}

export const ScrollNav = ({ items, activeId, onSelect }: ScrollNavProps) => {
  const t = useTranslate()
  const [hovered, setHovered] = useState(false)
  const [edge, setEdge] = useState<Edge>('none')
  const listRef = useRef<HTMLDivElement>(null)

  const updateEdge = useCallback(() => {
    const el = listRef.current
    if (!el) {
      return
    }
    const { scrollHeight, clientHeight, scrollTop } = el
    if (scrollHeight === clientHeight) {
      setEdge('none')
    } else if (scrollTop < 3) {
      setEdge('atTop')
    } else if (scrollTop > scrollHeight - clientHeight - 3) {
      setEdge('atBottom')
    } else {
      setEdge('middle')
    }
  }, [])

  useEffect(() => {
    updateEdge()
  }, [items, hovered, updateEdge])

  if (items.length < 2) {
    return null
  }

  return (
    <div
      className={styles.nav}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-scroll-nav
    >
      <div className={styles.bg} />
      <div className={clsx(styles.wrapper, hovered && styles.show, styles[edge])}>
        <div className={styles.list} ref={listRef} onScroll={updateEdge}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={clsx(styles.item, activeId === item.id && styles.active)}
              aria-label={item.title || t('scrollNav')}
              onClick={() => onSelect(item.id)}
            >
              <span className={styles.title}>{item.title}</span>
              <span className={styles.indicator}>
                <span className={styles.line} />
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
