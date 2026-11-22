import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { DeepSeekWordmark } from '../base/BrandLogo.js'
import {
  IconCloseOutline16,
  IconPanelLeftOutline16,
  IconSelectListOutline14,
  IconSettingsOutline16,
  NewChatIcon,
} from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { setSessionPinned } from '../../services/chat/store.js'
import {
  loadMoreSessions,
  newChat,
  removeSession,
  useChatStore,
} from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { ScrollBar } from '../base/ScrollBar.js'
import { setSiderDragTarget } from './mobileSiderDrag.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import { useVirtualSessions } from './virtualSessions.js'
import styles from './Sider.module.css'

const TOP_FADE_DISTANCE = 20

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(() => groupSessions(sessions, now, t), [sessions, now, t])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<string[]>([])

  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (mobile) {
      return
    }
    setSelectMode(false)
    setSelected([])
  }, [mobile])
  const hasMore = useChatStore((state) => state.hasMore)
  const loadingMore = useChatStore((state) => state.loadingMore)
  const loadMoreError = useChatStore((state) => state.loadMoreError)
  const counts = useMemo(() => groups.map((group) => group.sessions.length), [groups])
  const { metrics, ranges } = useVirtualSessions(
    listRef,
    counts,
    hasMore ? loadMoreSessions : undefined
  )

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

  useEffect(() => {
    const list = listRef.current
    const wrap = list?.parentElement
    if (!list || !wrap) {
      return
    }
    let frame = 0
    const update = () => {
      frame = 0
      const remaining = list.scrollHeight - list.clientHeight - list.scrollTop
      const top = Math.min(1, list.scrollTop / TOP_FADE_DISTANCE)
      const bottom = Math.min(1, remaining / TOP_FADE_DISTANCE)
      wrap.style.setProperty('--top-fade-opacity', top.toFixed(3))
      wrap.style.setProperty('--bottom-fade-opacity', bottom.toFixed(3))
    }
    const schedule = () => {
      frame ||= requestAnimationFrame(update)
    }
    update()
    const resizeObserver = new ResizeObserver(schedule)
    resizeObserver.observe(list)
    list.addEventListener('scroll', schedule, { passive: true })
    return () => {
      resizeObserver.disconnect()
      list.removeEventListener('scroll', schedule)
      if (frame) {
        cancelAnimationFrame(frame)
      }
    }
  }, [groups])

  return (
    <div
      className={clsx(styles.sider, mobile && styles.mobile)}
      data-mobile-sider={mobile || undefined}
    >
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
      {mobile && selectMode ? (
        <div className={styles.selectionBar}>
          <span className={styles.selectionCount}>
            {t('selectedConversations', { count: selected.length })}
          </span>
          <IconButton
            className={styles.sectionAction}
            size="xs"
            icon={<IconCloseOutline16 />}
            aria-label={t('close')}
            onClick={() => {
              setSelectMode(false)
              setSelected([])
            }}
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
          {groups.map((group, index) => {
            const range = ranges[index] ?? { start: 0, end: group.sessions.length }
            const head = range.start * metrics.itemHeight
            const tail = (group.sessions.length - range.end) * metrics.itemHeight
            return (
              <div key={group.key} className={styles.section}>
                <div className={styles.sectionHeader}>
                  <span>{group.label}</span>
                </div>
                {head > 0 ? <div style={{ height: head }} aria-hidden /> : null}
                {group.sessions.slice(range.start, range.end).map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    active={session.id === activeId}
                    onDelete={() => setDeleting(session)}
                    allowSelect={mobile}
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
                {tail > 0 ? <div style={{ height: tail }} aria-hidden /> : null}
              </div>
            )
          })}
          {loadingMore ? (
            <>
              <div className={styles.loadingRow}>
                <span className={styles.loadingBar} />
              </div>
              <div className={styles.loadingRow}>
                <span className={clsx(styles.loadingBar, styles.loadingBarShort)} />
              </div>
            </>
          ) : null}
          {loadMoreError ? (
            <div className={styles.loadMoreError}>{t('sessionLoadMoreOnError')}</div>
          ) : null}
        </div>
        {mobile ? null : (
          <ScrollBar containerRef={listRef} className={styles.scrollBar} size={8} inset={8} />
        )}
        {mobile && !selectMode ? (
          <IconButton
            className={styles.selectEntry}
            size="xs"
            icon={<IconSelectListOutline14 />}
            aria-label={t('selectConversations')}
            onClick={() => setSelectMode(true)}
          />
        ) : null}
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
  const drawerRef = useRef<HTMLDivElement>(null)
  const maskRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setSiderDragTarget('drawer', drawerRef.current)
    setSiderDragTarget('mask', maskRef.current)
  }, [])

  return (
    <>
      <div
        ref={maskRef}
        className={
          styles.drawerMask +
          (open ? ' ' + styles.drawerMaskActive : '') +
          (dragging && !open ? ' ' + styles.drawerMaskDragging : '')
        }
        onClick={closeMobileSider}
      />
      <div
        ref={drawerRef}
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
