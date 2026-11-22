import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const E2E_API_KEY = 'sk-e2e-local-key'

export type AppServer = {
  origin: string
  port: number
  setSettings(settings: Record<string, unknown>): Promise<void>
  stop(): Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const startAppServer = async (options: {
  repoRoot: string
  upstream: string
  home: string
}): Promise<AppServer> => {
  await mkdir(options.home, { recursive: true })
  const portFile = join(options.home, 'listen-url')
  const child = spawn(
    process.execPath,
    [
      join(options.repoRoot, 'server/src/index.ts'),
      '--port',
      '0',
      '--no-open',
      '--no-build',
      '--no-auth',
      '--port-file',
      portFile,
      '--upstream',
      options.upstream,
      '--home',
      options.home,
    ],
    {
      cwd: options.repoRoot,
      env: { ...process.env, DEEPSEEK_API_KEY: E2E_API_KEY, TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  let diagnostics = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString('utf8')
  })

  let entry = ''
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the local server exited early: ${diagnostics}`)
    }
    try {
      entry = (await readFile(portFile, 'utf8')).trim()
      if (entry) {
        break
      }
    } catch {
      await sleep(100)
    }
  }
  if (!entry) {
    child.kill('SIGKILL')
    throw new Error(`the local server did not start: ${diagnostics}`)
  }

  const origin = new URL(entry).origin
  const port = Number(new URL(entry).port)

  const setSettings = async (settings: Record<string, unknown>): Promise<void> => {
    const response = await fetch(`${origin}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(settings),
    })
    if (!response.ok) {
      throw new Error(`cannot update the settings: ${response.status}`)
    }
  }

  const stop = async (): Promise<void> => {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      const until = Date.now() + 5000
      while (child.exitCode === null && Date.now() < until) {
        await sleep(50)
      }
      if (child.exitCode === null) {
        child.kill('SIGKILL')
      }
    }
  }

  return { origin, port, setSettings, stop }
}
