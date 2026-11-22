import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

const main = async () => {
  const args = process.argv.slice(2)
  const portIndex = args.indexOf('--port')
  const uiPort = portIndex === -1 ? 8090 : Number(args[portIndex + 1])

  const dir = await mkdtemp(join(tmpdir(), 'chat-demo-dev-'))
  const portFile = join(dir, 'port')
  const backend = spawn(
    process.execPath,
    [
      join(repoRoot, 'server/src/index.ts'),
      '--port',
      '0',
      '--no-open',
      '--no-build',
      '--no-auth',
      '--port-file',
      portFile,
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  let backendUrl = ''
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      backendUrl = (await readFile(portFile, 'utf8')).trim()
      if (backendUrl) {
        break
      }
    } catch {
      continue
    }
    await sleep(100)
  }
  if (!backendUrl) {
    backend.kill()
    await rm(dir, { recursive: true, force: true })
    throw new Error('the backend failed to start')
  }

  const backendOrigin = backendUrl.split('?')[0]
  const devServer = spawn(
    resolve(repoRoot, 'node_modules/.bin/rspack'),
    ['serve', '-c', 'dev-proxy.config.ts', '--port', String(uiPort)],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, API_TARGET: backendOrigin, CHAT_DEMO_SERVER: backendOrigin },
    }
  )

  const stop = () => {
    backend.kill()
    devServer.kill()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  backend.on('exit', (code) => {
    devServer.kill()
    process.exit(code ?? 0)
  })
  devServer.on('exit', (code) => {
    backend.kill()
    process.exit(code ?? 0)
  })
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
