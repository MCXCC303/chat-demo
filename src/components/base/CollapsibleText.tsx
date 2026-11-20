import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import styles from './CollapsibleText.module.css'

type CollapsibleTextProps = {
  content: ReactNode
  collapsedHeight: number
  defaultCollapsed?: boolean
  renderToggle: (state: {
    collapsed: boolean
    setCollapsed: (collapsed: boolean) => void
  }) => ReactNode
}

export const CollapsibleText = ({
  content,
  collapsedHeight,
  defaultCollapsed = true,
  renderToggle,
}: CollapsibleTextProps) => {
  const contentRef = useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const [overflow, setOverflow] = useState(false)

  useLayoutEffect(() => {
    const element = contentRef.current
    if (!element) {
      return
    }
    const measure = () => setOverflow(element.offsetHeight > collapsedHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [content, collapsedHeight])

  return (
    <>
      <div
        className={styles.content}
        style={{ maxHeight: collapsed ? collapsedHeight : undefined }}
      >
        <div ref={contentRef}>{content}</div>
      </div>
      {overflow ? renderToggle({ collapsed, setCollapsed }) : null}
    </>
  )
}
