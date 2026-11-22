import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const chains = new Map<string, Promise<unknown>>()

export const withLock = <T>(key: string, task: () => Promise<T>): Promise<T> => {
  const previous = chains.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  chains.set(
    key,
    next.then(
      () => undefined,
      () => undefined
    )
  )
  return next
}

export const writeFileAtomic = async (
  path: string,
  data: string | Uint8Array,
  mode?: number
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temp, data, mode === undefined ? undefined : { mode })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
