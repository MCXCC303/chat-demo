import { access, mkdir, readdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic.ts'
import { toImportEvents, type LegacySessionEnvelope } from './commands.ts'
import { homePath } from './home.ts'
import { assertValidId } from './storage.ts'

export type MigrationResult = {
  migrated: number
  skipped: number
  failed: number
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export const migrateLegacySessions = async (home: string): Promise<MigrationResult> => {
  const sessionsDir = homePath(home, 'data', 'sessions')
  const archiveRoot = homePath(home, 'data', 'legacy')
  const result: MigrationResult = { migrated: 0, skipped: 0, failed: 0 }

  for (const source of ['sessions', 'documents']) {
    const sourceDir = homePath(home, 'data', source)
    let names: string[]
    try {
      names = await readdir(sourceDir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.json') || name === 'index.json') {
        continue
      }
      const path = join(sourceDir, name)
      const id = name.slice(0, -'.json'.length)
      try {
        assertValidId(id)
      } catch {
        result.failed += 1
        continue
      }
      const archiveDir = join(archiveRoot, source)
      const archive = async () => {
        try {
          await mkdir(archiveDir, { recursive: true, mode: 0o700 })
          await rename(path, join(archiveDir, name))
        } catch {
          return
        }
      }
      const logPath = join(sessionsDir, id, 'log.jsonl')
      if (await exists(logPath)) {
        result.skipped += 1
        await archive()
        continue
      }
      let parsed: Omit<LegacySessionEnvelope, 'id'>
      try {
        parsed = JSON.parse(await readFile(path, 'utf8')) as Omit<LegacySessionEnvelope, 'id'>
      } catch {
        result.failed += 1
        continue
      }
      const events = toImportEvents({ ...parsed, id })
      if (events.length === 0) {
        result.failed += 1
        continue
      }
      const lines = events.map((event, index) =>
        JSON.stringify({ seq: index + 1, type: event.type, payload: event.payload })
      )
      await mkdir(join(sessionsDir, id), { recursive: true, mode: 0o700 })
      await writeFileAtomic(logPath, lines.join('\n') + '\n', 0o600)
      result.migrated += 1
      await archive()
    }
  }

  return result
}
