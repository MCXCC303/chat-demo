import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { IconChevronDownOutline14 } from '../base/icons.js'
import { useScrollToLatest } from './scrollContext.js'
import styles from './ScrollToBottomButton.module.css'

type HaloState = 'hidden' | 'active' | 'fading'

export const ScrollToBottomButton = () => {
  const t = useTranslate()
  const { visible, streaming, scrollToLatest } = useScrollToLatest()
  const [halo, setHalo] = useState<HaloState>('hidden')

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
