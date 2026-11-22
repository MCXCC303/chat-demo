import type { Session, SessionSummary } from './types.js'

export type StoredFile = {
  id: string
  blob: Blob
}

export interface ChatRepository {
  loadSessionSummaries(): Promise<SessionSummary[]>
  loadSession(id: string): Promise<Session | undefined>
  saveSession(session: Session, files?: StoredFile[]): Promise<void>
  renameSession(id: string, title: string): Promise<void>
  setSessionPinned(id: string, pinned: boolean): Promise<void>
  deleteSession(id: string): Promise<void>
  loadFile(id: string): Promise<Blob | undefined>
  clearStaging(): Promise<void>
  addStagingSession(session: Session): Promise<void>
  saveStagingFiles(files: StoredFile[]): Promise<void>
  updateStagingFileTypes(types: ReadonlyMap<string, string>): Promise<void>
  commitStaging(): Promise<SessionSummary[]>
}

let active: ChatRepository | null = null

export const setRepository = (repository: ChatRepository): void => {
  active = repository
}

export const getRepository = (): ChatRepository => {
  if (!active) {
    throw new Error('存储实现尚未初始化')
  }
  return active
}
