import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { DeepSeekWordmark } from '../base/BrandLogo.js'
import {
  IconPanelLeftOutline16,
  IconSearchOutline16,
  IconSelectListOutline14,
  IconSettingsOutline16,
  NewChatIcon,
} from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { setSessionPinned } from '../../services/chat/store.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { ScrollBar } from '../base/ScrollBar.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(() => groupSessions(sessions, now, t), [sessions, now, t])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [query, setQuery] = useState('')
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  const visibleGroups = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) {
      return groups
    }
    return groups
      .map((group) => ({
        ...group,
        sessions: group.sessions.filter((session) => session.title.toLowerCase().includes(keyword)),
      }))
      .filter((group) => group.sessions.length > 0)
  }, [groups, query])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <div className={styles.brandLogo}>
          <DeepSeekWordmark />
        </div>
        <IconButton
          size="m"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
        />
      </div>
      {mobile ? (
        <div className={styles.search}>
          <span className={styles.searchIcon}>
            <IconSearchOutline16 />
          </span>
          <input
            className={styles.searchInput}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('searchConversations')}
            aria-label={t('searchConversations')}
          />
        </div>
      ) : null}
      <button
        type="button"
        className={styles.newChat}
        onClick={() => {
          newChat()
          closeMobileSider()
        }}
      >
        <span className={styles.newChatIcon}>
          <NewChatIcon />
        </span>
        {t('newChat')}
      </button>
      <div className={styles.listWrap}>
        <div className={styles.list} ref={listRef}>
          {visibleGroups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>
                <span>
                  {selectMode
                    ? t('selectedConversations', { count: selected.length })
                    : group.label}
                </span>
                {mobile ? (
                  <IconButton
                    className={styles.sectionAction}
                    size="xs"
                    icon={<IconSelectListOutline14 />}
                    aria-label={t('selectConversations')}
                    onClick={() => setSelectMode((value) => !value)}
                  />
                ) : null}
              </div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  onDelete={() => setDeleting(session)}
                  selectMode={selectMode}
                  selected={selected.includes(session.id)}
                  onToggleSelect={() =>
                    setSelected((prev) =>
                      prev.includes(session.id)
                        ? prev.filter((id) => id !== session.id)
                        : [...prev, session.id]
                    )
                  }
                  onEnterSelectMode={() => {
                    setSelectMode(true)
                    setSelected((prev) =>
                      prev.includes(session.id) ? prev : [...prev, session.id]
                    )
                  }}
                  onTogglePin={() => setSessionPinned(session.id, !session.pinned)}
                />
              ))}
            </div>
          ))}
        </div>
        {mobile ? null : (
          <ScrollBar containerRef={listRef} className={styles.scrollBar} size={8} inset={8} />
        )}
      </div>
      <div className={styles.bottom}>
        <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
        </button>
      </div>
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  const dragging = useMobileSider((state) => state.dragging)
  return (
    <>
      <div
        className={
          styles.drawerMask +
          (open ? ' ' + styles.drawerMaskActive : '') +
          (dragging && !open ? ' ' + styles.drawerMaskDragging : '')
        }
        onClick={closeMobileSider}
      />
      <div
        className={
          styles.drawer +
          (open ? ' ' + styles.drawerOpen : '') +
          (dragging ? ' ' + styles.drawerDragging : '')
        }
      >
        <Sider mobile />
      </div>
    </>
  )
}
