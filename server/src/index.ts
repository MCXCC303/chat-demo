import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApi } from './api.ts'
import { CredentialStore } from './credentials.ts'
import { homeDisplay, resolveHome } from './home.ts'
import { buildFrontend, bundleExists } from './build.ts'
import { createProxy } from './proxy.ts'
import {
  DEFAULT_BASE_URL,
  DEFAULT_PROVIDER_ID,
  ProviderStore,
  type ProviderProfile,
} from './providers.ts'
import { createStatic } from './static.ts'
import {
  cookieName,
  createLaunchToken,
  issueSessionCookie,
  loadSigningSecret,
  readCookie,
  sessionCookieHeader,
  tokenMatches,
  verifySessionCookie,
} from './session.ts'
import { SessionLogStore } from './session-log.ts'
import { createSessionService } from './session-service.ts'
import { Storage } from './storage.ts'
import { assertTrustedAuthority, isLoopbackHost, isTrustedRequest } from './trust.ts'

const VERSION = '0.2.0'
const LABEL = 'deepseek-web'
const DEFAULT_PORT = 8090
const DEFAULT_HOST = '127.0.0.1'

type BuildMode = 'auto' | 'always' | 'never'

type Options = {
  home?: string
  port: number
  host: string
  defaultBaseURL: string
  staticRoot: string
  trustHosts: string[]
  auth: boolean
  cookieDays: number
  open: boolean
  build: BuildMode
  portFile?: string
  help: boolean
}

const HELP = [
  'Usage: pnpm server [options]',
  '',
  'Serve the chat-demo web UI and the local API it owns.',
  '',
  'Options:',
  '  --home <path>       data home; defaults to $CHAT_DEMO_HOME, then ~/.chat-demo',
  '  --port <port>       listen port; pass 0 to let the OS pick a free one',
  '  --host <host>       bind address; defaults to 127.0.0.1',
  '  --static <dir>      frontend bundle directory; defaults to dist-server',
  '  --trust-host <host> extra authority the browser trust fence accepts (repeatable)',
  '  --no-auth           serve without the browser entry key; the trust fence alone guards the port',
  '  --cookie-days <n>   session cookie lifetime in days; defaults to 30',
  '  --build             rebuild the frontend bundle before serving',
  '  --no-build          serve the frontend bundle as-is',
  '  --no-open           do not open the web UI in the default browser',
  '  --port-file <path>  write the actual listen URL to this file',
  '  -h, --help          show this help',
  '',
  'Examples:',
  '  pnpm server --port 8091',
  '  pnpm server --port 8091 --no-open',
  '  pnpm server --home ~/chat-demo-data',
].join('\n')

class UsageError extends Error {}

const parseArgs = (argv: string[]): Options => {
  const options: Options = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    defaultBaseURL: DEFAULT_BASE_URL,
    staticRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist-server'),
    trustHosts: [],
    auth: true,
    cookieDays: 30,
    open: true,
    build: 'auto',
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = (name: string): string => {
      const found = argv[(index += 1)]
      if (found === undefined || found.startsWith('--')) {
        throw new UsageError(`${name} requires a value`)
      }
      return found
    }
    if (arg === '--home') {
      options.home = value('--home')
    } else if (arg === '--port') {
      const port = value('--port')
      if (!/^\d+$/.test(port)) {
        throw new UsageError(`--port must be a number, got ${JSON.stringify(port)}`)
      }
      options.port = Number(port)
    } else if (arg === '--host') {
      options.host = value('--host')
    } else if (arg === '--static') {
      options.staticRoot = resolve(value('--static'))
    } else if (arg === '--trust-host') {
      options.trustHosts.push(value('--trust-host'))
    } else if (arg === '--no-auth') {
      options.auth = false
    } else if (arg === '--cookie-days') {
      const days = value('--cookie-days')
      if (!/^\d+$/.test(days) || Number(days) < 1) {
        throw new UsageError(`--cookie-days must be a positive number, got ${JSON.stringify(days)}`)
      }
      options.cookieDays = Number(days)
    } else if (arg === '--build') {
      options.build = 'always'
    } else if (arg === '--no-build') {
      options.build = 'never'
    } else if (arg === '--no-open') {
      options.open = false
    } else if (arg === '--port-file') {
      options.portFile = value('--port-file')
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new UsageError(`unknown option ${JSON.stringify(arg)}`)
    }
  }
  if (process.env.CHAT_DEMO_PORT) {
    const port = process.env.CHAT_DEMO_PORT
    if (!/^\d+$/.test(port)) {
      throw new UsageError(`CHAT_DEMO_PORT must be a number, got ${JSON.stringify(port)}`)
    }
    options.port = Number(port)
  }
  if (process.env.DEEPSEEK_API_ORIGIN) {
    options.defaultBaseURL = process.env.DEEPSEEK_API_ORIGIN
  }
  return options
}

const writeUnauthorized = (res: import('node:http').ServerResponse): void => {
  res.writeHead(401, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
  })
  res.end('unauthorized')
}

const writeAuthenticationHint = (res: import('node:http').ServerResponse): void => {
  res.writeHead(401, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
  })
  res.end('chat-demo authentication required; reopen the URL printed by pnpm server.\n')
}

const sendJson = (res: import('node:http').ServerResponse, status: number, value: unknown) => {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

const openBrowser = async (url: string): Promise<void> => {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  await new Promise<void>((resolveOpen) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => resolveOpen())
    child.on('spawn', () => resolveOpen())
    child.unref()
  })
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${HELP}\n`)
    return
  }

  for (const entry of options.trustHosts) {
    assertTrustedAuthority(entry)
  }

  const home = resolveHome(options.home)
  const storage = new Storage(home)
  await storage.recover()
  const credentials = new CredentialStore(home)
  const providers = new ProviderStore(home, { defaultBaseURL: options.defaultBaseURL })
  const resolveProvider = async (id: string = DEFAULT_PROVIDER_ID): Promise<ProviderProfile> => {
    const profile = await providers.read(id)
    if (!profile) {
      throw new Error(`unknown provider: ${id}`)
    }
    return profile
  }
  const sessions = createSessionService({
    log: new SessionLogStore({ home }),
    resolveProvider,
    readActive: async () => await providers.readActive(),
    credentials,
    storage,
  })
  const api = createApi({
    storage,
    credentials,
    sessions,
    providers,
    home,
    version: VERSION,
  })
  const proxy = createProxy({ resolveProvider, credentials })
  const signingSecret = options.auth ? await loadSigningSecret(credentials) : null
  const launchToken = options.auth ? createLaunchToken() : ''
  const cookieMaxAgeMilliseconds = options.cookieDays * 24 * 60 * 60 * 1000
  const staticHandler = createStatic(options.staticRoot)

  const needsBuild =
    options.build === 'always' || (options.build === 'auto' && !bundleExists(options.staticRoot))
  if (needsBuild) {
    process.stdout.write(`${LABEL}: building the frontend bundle\n`)
    await buildFrontend(options.staticRoot)
  }

  const server = createServer((req, res) => {
    void (async () => {
      const authority = req.headers.host ?? ''
      const url = new URL(req.url ?? '/', `http://${authority || 'localhost'}`)
      const path = url.pathname
      const isAssetPath = /\.[A-Za-z0-9]+$/.test(path)
      const tokens = url.searchParams.getAll('token')
      const authenticated = (): boolean => {
        if (!signingSecret) {
          return false
        }
        const cookie = readCookie(req.headers.cookie, cookieName(authority))
        return cookie !== undefined && verifySessionCookie(signingSecret, cookie, authority)
      }
      if (options.auth && signingSecret && path === '/' && tokens.length > 0) {
        if (req.method === 'GET' && tokens.length === 1 && tokenMatches(tokens[0], launchToken)) {
          const issued = issueSessionCookie(signingSecret, authority, cookieMaxAgeMilliseconds)
          res.writeHead(303, {
            'cache-control': 'no-store',
            location: './',
            'referrer-policy': 'no-referrer',
            'set-cookie': sessionCookieHeader(
              issued.name,
              issued.value,
              issued.expiresAt,
              Math.floor(cookieMaxAgeMilliseconds / 1000),
              false
            ),
          })
          res.end()
          return
        }
        if (req.method === 'GET' && authenticated()) {
          res.writeHead(303, {
            'cache-control': 'no-store',
            location: './',
            'referrer-policy': 'no-referrer',
          })
          res.end()
          return
        }
        writeAuthenticationHint(res)
        return
      }
      if (!isTrustedRequest(req, options.host, options.trustHosts)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      if (options.auth && signingSecret && !isAssetPath && !authenticated()) {
        writeUnauthorized(res)
        return
      }
      try {
        if (path === '/config.json') {
          sendJson(res, 200, {
            mode: 'server',
            apiOrigin: '',
            version: VERSION,
            home: homeDisplay(home),
          })
          return
        }
        if (path.startsWith('/api/')) {
          await api(req, res, path)
          return
        }
        if (path === '/models' || path.startsWith('/anthropic/') || path.startsWith('/v1/tools/')) {
          await proxy(req, res)
          return
        }
        await staticHandler(req, res, path)
      } catch (error) {
        if (res.headersSent) {
          res.end()
          return
        }
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        rejectListen(
          new Error(`port ${options.port} is already in use; pass --port to choose another one`)
        )
        return
      }
      rejectListen(error)
    })
    server.listen(options.port, options.host, resolveListen)
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  const url = `http://${options.host}:${port}`
  const entryUrl = options.auth ? `${url}/?token=${launchToken}` : url
  if (options.portFile) {
    await writeFile(options.portFile, `${entryUrl}\n`, { mode: 0o600 })
  }

  if (!isLoopbackHost(options.host)) {
    process.stdout.write(
      `${LABEL}: listening on ${options.host} over plain HTTP; restrict this port to a trusted proxy or network\n`
    )
  }
  process.stdout.write(`${LABEL}: ${entryUrl}\n`)

  if (options.open) {
    process.stdout.write(`${LABEL}: opening the default browser; pass --no-open to disable\n`)
    await openBrowser(entryUrl)
  }

  const shutdown = () => {
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`error: ${error.message}\n`)
  } else {
    process.stderr.write(`${LABEL}: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  process.exitCode = 1
})
