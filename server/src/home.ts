import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const HOME_ENV = 'CHAT_DEMO_HOME'
export const HOME_DIR_NAME = '.chat-demo'
export const DEFAULT_HOME_DISPLAY = `~/${HOME_DIR_NAME}`

export type HomeCategory = 'config' | 'data' | 'state' | 'cache' | 'backup'

export const defaultHome = (): string => join(homedir(), HOME_DIR_NAME)

export const expandHomePath = (path: string): string => {
  if (path === '~') {
    return homedir()
  }
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2))
  }
  return path
}

export const resolveHome = (
  configured?: string,
  env: Record<string, string | undefined> = process.env
): string => {
  const fromEnv = env[HOME_ENV]
  const selected =
    configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : defaultHome())
  return resolve(expandHomePath(selected))
}

export const homePath = (home: string, category: HomeCategory, ...segments: string[]): string =>
  join(home, category, ...segments)

export const homeDisplay = (home: string): string =>
  home === resolve(defaultHome()) ? DEFAULT_HOME_DISPLAY : `$${HOME_ENV}`
