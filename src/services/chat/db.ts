import { indexedDbRepository } from './indexedDbRepository.js'
import { getRepository, setRepository, type StoredFile } from './repository.js'
import type { Session } from './types.js'

export type { StoredFile } from './repository.js'

setRepository(indexedDbRepository)

export const loadSessionSummaries = () => getRepository().loadSessionSummaries()

export const loadSession = (id: string) => getRepository().loadSession(id)

export const saveSession = (session: Session, files: StoredFile[] = []) =>
  getRepository().saveSession(session, files)

export const renameSession = (id: string, title: string) => getRepository().renameSession(id, title)

export const setSessionPinned = (id: string, pinned: boolean) =>
  getRepository().setSessionPinned(id, pinned)

export const deleteSession = (id: string) => getRepository().deleteSession(id)

export const loadFile = (id: string) => getRepository().loadFile(id)

export const clearStaging = () => getRepository().clearStaging()

export const addStagingSession = (session: Session) => getRepository().addStagingSession(session)

export const saveStagingFiles = (files: StoredFile[]) => getRepository().saveStagingFiles(files)

export const updateStagingFileTypes = (types: ReadonlyMap<string, string>) =>
  getRepository().updateStagingFileTypes(types)

export const commitStaging = () => getRepository().commitStaging()

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
