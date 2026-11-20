import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { IconChevronDownOutline14 } from '../base/icons.js'
import { useScrollToLatest } from './scrollContext.js'
import styles from './ScrollToBottomButton.module.css'

/** 光环状态：生成中显示，停止后淡出再隐藏 */
type HaloState = 'hidden' | 'active' | 'fading'

/** 回到底部按钮：离开底部时显示，点击回到最新消息并恢复跟随 */
export const ScrollToBottomButton = () => {
  const t = useTranslate()
  const { visible, streaming, scrollToLatest } = useScrollToLatest()
  const [halo, setHalo] = useState<HaloState>('hidden')

  // 生成中显示品牌光环，停止后淡出
  useEffect(() => {
    if (streaming) {
      setHalo('active')
      return
    }
    setHalo((state) => (state === 'active' ? 'fading' : state))
  }, [streaming])

  useEffect(() => {
    if (halo !== 'fading') {
      return
    }
    const timer = setTimeout(() => setHalo('hidden'), 400)
    return () => clearTimeout(timer)
  }, [halo])

  if (!visible) {
    return null
  }
  return (
    <div
      className={clsx(
        styles.wrapper,
        halo !== 'hidden' && styles.halo,
        halo === 'fading' && styles.fading
      )}
    >
      <button
        type="button"
        className={styles.button}
        aria-label={t('scrollToBottom')}
        title={t('scrollToBottom')}
        onClick={scrollToLatest}
      >
        <IconChevronDownOutline14 />
      </button>
    </div>
  )
}
