import { useState } from 'react'
import { IconEditOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { Button } from '../base/Button.js'
import { verifyApiKey } from '../../services/api/client.js'
import { useBackend } from '../../services/backend.js'
import {
  ProviderRequestError,
  loadProviders,
  removeProviderKey,
  saveProviderKey,
  saveProviderProfile,
  type ProviderSummary,
} from '../../services/providers.js'
import { setApiKey } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './Settings.module.css'

export const ProviderEditor = ({
  provider,
  onClose,
}: {
  provider: ProviderSummary
  onClose: () => void
}) => {
  const t = useTranslate()
  const serverMode = useBackend((state) => state.mode === 'server')
  const [editingKey, setEditingKey] = useState(!provider.credential.configured)
  const [keyValue, setKeyValue] = useState('')
  const [displayName, setDisplayName] = useState(provider.displayName)
  const [baseURL, setBaseURL] = useState(provider.baseURL)
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const describeFailure = (error: unknown): string => {
    if (error instanceof ProviderRequestError && error.status === 401) {
      return t('apiKeyInvalid')
    }
    return error instanceof Error ? error.message : String(error)
  }

  const submit = async () => {
    if (busy) {
      return
    }
    setBusy(true)
    setFailure(null)
    try {
      if (serverMode) {
        if (displayName !== provider.displayName || baseURL !== provider.baseURL) {
          await saveProviderProfile(provider.id, { displayName, baseURL })
        }
        if (keyValue.trim()) {
          await saveProviderKey(provider.id, keyValue.trim())
        }
      } else if (keyValue.trim()) {
        await verifyApiKey(keyValue.trim())
        setApiKey(keyValue.trim())
        await loadProviders(true)
      }
      setKeyValue('')
      onClose()
    } catch (error) {
      setFailure(describeFailure(error))
    } finally {
      setBusy(false)
    }
  }

  const clearKey = async () => {
    setBusy(true)
    setFailure(null)
    try {
      await removeProviderKey(provider.id)
      onClose()
    } catch (error) {
      setFailure(describeFailure(error))
    } finally {
      setBusy(false)
    }
  }

  const keySaved = provider.credential.configured && !editingKey

  return (
    <div className={styles.providerCard}>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t('settingsModelsKeyLabel')}</span>
        {keySaved ? (
          <div className={styles.apiKeySaved}>
            <span className={styles.apiKeyMask}>{provider.credential.masked ?? ''}</span>
            <IconButton
              tone="primary"
              icon={<IconEditOutline16 />}
              tooltip={t('apiKeyEdit')}
              onClick={() => setEditingKey(true)}
            />
          </div>
        ) : (
          <div className={styles.apiKeyInput}>
            <input
              type="password"
              placeholder={t('apiKeyPlaceholder')}
              autoComplete="new-password"
              spellCheck={false}
              value={keyValue}
              onChange={(event) => setKeyValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  void submit()
                }
              }}
            />
            <span className={styles.divider} />
            <button
              type="button"
              className={styles.confirm}
              disabled={busy}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void submit()}
            >
              {t('confirm')}
            </button>
          </div>
        )}
      </div>

      {serverMode ? (
        <>
          <button
            type="button"
            className={styles.advancedToggle}
            aria-expanded={advanced}
            onClick={() => setAdvanced((current) => !current)}
          >
            {t('settingsModelsAdvanced')}
          </button>
          {advanced ? (
            <div className={styles.advancedBody}>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>{t('settingsModelsName')}</span>
                <input
                  className={styles.fieldInput}
                  type="text"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </div>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>{t('settingsModelsEndpoint')}</span>
                <input
                  className={styles.fieldInput}
                  type="url"
                  value={baseURL}
                  onChange={(event) => setBaseURL(event.target.value)}
                />
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <p className={styles.description}>{t('settingsModelsStandalone')}</p>
      )}

      {failure ? <div className={styles.error}>{failure}</div> : null}

      <div className={styles.editorActions}>
        {provider.credential.configured && serverMode ? (
          <Button variant="dangerOutlined" size="m" disabled={busy} onClick={() => void clearKey()}>
            {t('settingsModelsRemoveKey')}
          </Button>
        ) : null}
        <Button variant="outlined" size="m" disabled={busy} onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button variant="primary" size="m" disabled={busy} onClick={() => void submit()}>
          {t('settingsModelsSave')}
        </Button>
      </div>
    </div>
  )
}
