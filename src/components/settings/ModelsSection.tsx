import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { loadProviders, saveSelection, useProviders } from '../../services/providers.js'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { ProviderEditor } from './ProviderEditor.js'
import styles from './Settings.module.css'

export const ModelsSection = () => {
  const t = useTranslate()
  const status = useProviders((state) => state.status)
  const providers = useProviders((state) => state.providers)
  const active = useProviders((state) => state.active)
  const error = useProviders((state) => state.error)
  const [editing, setEditing] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    void loadProviders()
  }, [])

  const choose = async (provider: string, model: string) => {
    if (pending) {
      return
    }
    setPending(`${provider}/${model}`)
    setFailure(null)
    try {
      await saveSelection(provider, model)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(null)
    }
  }

  return (
    <div className={styles.modelsSection}>
      <div className={styles.modelsTitle}>{t('settingsModelsTitle')}</div>
      <p className={styles.modelsIntro}>{t('settingsModelsIntro')}</p>

      {status === 'error' ? (
        <div className={styles.modelsError}>
          <span>{t('settingsModelsLoadFailed', { message: error })}</span>
          <Button variant="outlined" size="m" onClick={() => void loadProviders(true)}>
            {t('settingsModelsRetry')}
          </Button>
        </div>
      ) : null}
      {failure ? <div className={styles.error}>{failure}</div> : null}

      <div
        role="radiogroup"
        aria-label={t('settingsModelsProviderGroup')}
        className={styles.providerList}
      >
        {providers.map((provider) => {
          const selected = active.provider === provider.id
          const model = provider.selectedModel ?? provider.models[0]?.id ?? ''
          return (
            <div key={provider.id} className={styles.providerRow}>
              <div className={styles.providerHead}>
                <label className={styles.providerIdentity}>
                  <input
                    type="radio"
                    name="chat-demo-provider"
                    className={styles.providerRadio}
                    checked={selected}
                    disabled={!provider.models.length || pending !== null}
                    onChange={() => void choose(provider.id, model)}
                  />
                  <span className={styles.providerName}>{provider.displayName || provider.id}</span>
                  <span
                    className={clsx(
                      styles.credentialDot,
                      provider.credential.configured
                        ? styles.credentialDotReady
                        : styles.credentialDotMissing
                    )}
                    role="img"
                    aria-label={
                      provider.credential.configured
                        ? t('settingsModelsCredentialReady')
                        : t('settingsModelsCredentialMissing')
                    }
                    title={
                      provider.credential.configured
                        ? t('settingsModelsCredentialReady')
                        : t('settingsModelsCredentialMissing')
                    }
                  />
                </label>
                <Button
                  variant="outlined"
                  size="m"
                  onClick={() => setEditing(editing === provider.id ? null : provider.id)}
                >
                  {editing === provider.id ? t('settingsModelsClose') : t('settingsModelsEdit')}
                </Button>
              </div>

              {selected ? (
                <fieldset className={styles.modelGroup}>
                  <legend className={styles.fieldLabel}>{t('settingsModelsModels')}</legend>
                  {provider.models.map((item) => (
                    <label key={item.id} className={styles.modelOption}>
                      <input
                        type="radio"
                        name={`chat-demo-model-${provider.id}`}
                        className={styles.providerRadio}
                        checked={active.model === item.id}
                        disabled={pending !== null}
                        onChange={() => void choose(provider.id, item.id)}
                      />
                      <span className={styles.modelName}>{item.name || item.id}</span>
                    </label>
                  ))}
                </fieldset>
              ) : null}

              {editing === provider.id ? (
                <ProviderEditor provider={provider} onClose={() => setEditing(null)} />
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
