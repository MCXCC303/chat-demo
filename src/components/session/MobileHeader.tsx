import {
  IconMenuOutline20,
  IconNewChatOutline20,
  IconSpeakerMutedOutline20,
  IconSpeakerOutline24,
} from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { newChat } from '../../services/chat/store.js'
import { toggleMuted, useReadAloud } from '../../services/speech/readAloud.js'
import { IconButton } from '../base/IconButton.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import styles from './MobileHeader.module.css'

/** 移动端顶栏：左侧菜单打开侧边栏；会话页再显示标题与开启新对话 */
export const MobileHeader = ({ title }: { title?: string }) => {
  const t = useTranslate()
  const muted = useReadAloud((state) => state.muted)
  return (
    <div className={styles.header}>
      <IconButton
        size="xl"
        tone="primary"
        icon={<IconMenuOutline20 />}
        aria-label={t('expandSiderbarButton')}
        onClick={openMobileSider}
      />
      {title === undefined ? null : <div className={styles.title}>{title}</div>}
      <IconButton
        className={styles.muteButton}
        size="xl"
        tone="primary"
        icon={muted ? <IconSpeakerMutedOutline20 /> : <IconSpeakerOutline24 />}
        aria-label={muted ? t('ttsUnmute') : t('ttsMute')}
        onClick={toggleMuted}
      />
      <IconButton
        className={styles.newChatButton}
        size="xl"
        tone="primary"
        icon={<IconNewChatOutline20 />}
        aria-label={t('newChat')}
        onClick={newChat}
      />
    </div>
  )
}
