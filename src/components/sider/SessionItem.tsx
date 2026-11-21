import clsx from 'clsx'
import { memo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCheckOutline16,
  IconEditOutline16,
  IconPushPinOutline16,
  IconSelectListOutline14,
  IconEllipsisOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { renameSession, selectSession } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  onDelete,
  selectMode,
  selected,
  onToggleSelect,
  onEnterSelectMode,
  onTogglePin,
}: {
  session: SessionSummary
  active: boolean
  onDelete: () => void
  selectMode: boolean
  selected: boolean
  onToggleSelect: () => void
  onEnterSelectMode: () => void
  onTogglePin: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const [press, setPress] = useState<{ x: number; y: number } | null>(null)
  const openMenu = useRef<(() => void) | null>(null)
  const pressTimer = useRef(0)
  const longPressed = useRef(false)
  const displayTitle = session.title || t('untitledChat')
  const cancelPress = () => window.clearTimeout(pressTimer.current)

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <div
      className={clsx(styles.item, active && styles.active, press && styles.pressed)}
      style={
        press
          ? ({ '--press-x': press.x + 'px', '--press-y': press.y + 'px' } as CSSProperties)
          : undefined
      }
      onPointerDown={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        setPress({ x: event.clientX - rect.left, y: event.clientY - rect.top })
        longPressed.current = false
        pressTimer.current = window.setTimeout(() => {
          longPressed.current = true
          openMenu.current?.()
        }, 500)
      }}
      onPointerUp={() => {
        setPress(null)
        cancelPress()
      }}
      onPointerLeave={() => {
        setPress(null)
        cancelPress()
      }}
      onPointerCancel={() => {
        setPress(null)
        cancelPress()
      }}
      onClick={() => {
        if (longPressed.current) {
          longPressed.current = false
          return
        }
        if (selectMode) {
          onToggleSelect()
          return
        }
        selectSession(session.id)
        closeMobileSider()
      }}
    >
      {selectMode ? (
        <span className={clsx(styles.checkbox, selected && styles.checkboxSelected)}>
          {selected ? <IconCheckOutline16 /> : null}
        </span>
      ) : null}
      <div className={styles.title}>{displayTitle}</div>
      <div className={styles.action} onClick={(event) => event.stopPropagation()}>
        <Menu
          options={[
            {
              key: 'rename',
              label: t('sessionItemMenuRenameOption'),
              icon: <IconEditOutline16 />,
              onSelect: () => setEditing(true),
            },
            {
              key: 'pin',
              label: session.pinned ? t('unpinConversation') : t('pinConversation'),
              icon: <IconPushPinOutline16 />,
              onSelect: onTogglePin,
            },
            {
              key: 'multiSelect',
              label: t('multiSelect'),
              icon: <IconSelectListOutline14 />,
              onSelect: onEnterSelectMode,
            },
            {
              key: 'delete',
              label: t('delete'),
              icon: <IconTrashOutline16 />,
              danger: true,
              onSelect: onDelete,
            },
          ]}
        >
          {({ toggle }) => {
            openMenu.current = toggle
            return (
              <IconButton
                icon={<IconEllipsisOutline16 />}
                aria-label={t('more')}
                onClick={toggle}
              />
            )
          }}
        </Menu>
      </div>
    </div>
  )
})
