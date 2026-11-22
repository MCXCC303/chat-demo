import { indexedDbRepository } from './indexedDbRepository.js'
import { getRepository, type StoredFile } from './repository.js'

export const migrateToServer = async (): Promise<number> => {
  const summaries = await indexedDbRepository.loadSessionSummaries()
  if (summaries.length === 0) {
    return 0
  }
  const repository = getRepository()
  const existing = await repository.loadSessionSummaries()
  if (existing.length > 0) {
    return 0
  }
  let migrated = 0
  for (const summary of summaries) {
    const session = await indexedDbRepository.loadSession(summary.id)
    if (!session) {
      continue
    }
    const files: StoredFile[] = []
    for (const message of session.messages) {
      if (message.role !== 'user') {
        continue
      }
      for (const file of message.files) {
        const blob = await indexedDbRepository.loadFile(file.id)
        if (blob) {
          files.push({ id: file.id, blob })
        }
      }
    }
    await repository.saveSession(session, files)
    migrated += 1
  }
  return migrated
}
