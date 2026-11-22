import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpClient } from './cdp.ts'

export type Page = {
  sessionId: string
  requests(): string[]
  navigate(url: string): Promise<void>
  evaluate<T>(expression: string): Promise<T>
  waitFor(expression: string, timeoutMs?: number): Promise<void>
  waitForRequest(fragment: string, timeoutMs?: number): Promise<void>
  click(expression: string): Promise<void>
  fill(expression: string, value: string): Promise<void>
  close(): Promise<void>
}

export type Browser = {
  newPage(): Promise<Page>
  close(): Promise<void>
}

const CHROMIUM = process.env.E2E_CHROMIUM ?? '/usr/bin/chromium'
const FROZEN_CLOCK = 1764547200000
const VIEWPORT = { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const clockScript = [
  '(() => {',
  `  const frozen = ${FROZEN_CLOCK}`,
  '  const NativeDate = Date',
  '  class FrozenDate extends NativeDate {',
  '    constructor(...args) {',
  '      if (args.length === 0) {',
  '        super(frozen)',
  '        return',
  '      }',
  '      super(...args)',
  '    }',
  '    static now() {',
  '      return frozen',
  '    }',
  '  }',
  '  globalThis.Date = FrozenDate',
  `  try { localStorage.setItem('chat-demo:locale', 'zh-CN') } catch (error) {}`,
  '})()',
].join('\n')

const freePort = async (): Promise<number> => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

const waitForEndpoint = async (port: number, timeoutMs = 30000): Promise<string> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) {
        const body = (await response.json()) as { webSocketDebuggerUrl?: string }
        if (body.webSocketDebuggerUrl) {
          return body.webSocketDebuggerUrl
        }
      }
    } catch {
      await sleep(100)
    }
    if (Date.now() > deadline) {
      throw new Error('chromium did not expose the CDP endpoint')
    }
    await sleep(100)
  }
}

export const launchBrowser = async (options: { headful?: boolean } = {}): Promise<Browser> => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'chat-demo-e2e-profile-'))
  const port = await freePort()
  const args = [
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--metrics-recording-only',
    '--window-size=1280,900',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
  ]
  if (!options.headful) {
    args.push('--headless=new')
  }
  args.push('about:blank')
  const child: ChildProcess = spawn(CHROMIUM, args, {
    env: { ...process.env, TZ: 'UTC' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.resume()
  child.stderr?.resume()

  const endpoint = await waitForEndpoint(port)
  const cdp = await CdpClient.connect(endpoint)

  const newPage = async (): Promise<Page> => {
    const context = await cdp.send<{ browserContextId: string }>('Target.createBrowserContext', {
      disposeOnDetach: false,
    })
    const created = await cdp.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
      browserContextId: context.browserContextId,
    })
    const attached = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true,
    })
    const sessionId = attached.sessionId
    const requests: string[] = []

    cdp.on(
      'Network.requestWillBeSent',
      (params) => {
        const request = params.request as { url?: string } | undefined
        requests.push(request?.url ?? '')
      },
      sessionId
    )

    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Network.enable', {}, sessionId)
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' }, sessionId)
    await cdp.send('Emulation.setLocaleOverride', { locale: 'zh-CN' }, sessionId)
    await cdp.send('Emulation.setDeviceMetricsOverride', VIEWPORT, sessionId)
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: clockScript }, sessionId)

    const evaluate = async <T>(expression: string): Promise<T> => {
      const response = await cdp.send<{
        result: { value?: unknown }
        exceptionDetails?: { text: string; exception?: { description?: string } }
      }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
      if (response.exceptionDetails) {
        throw new Error(
          response.exceptionDetails.exception?.description ?? response.exceptionDetails.text
        )
      }
      return response.result.value as T
    }

    const waitFor = async (expression: string, timeoutMs = 20000): Promise<void> => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const ready = await evaluate<boolean>(
          `(() => { try { return Boolean(${expression}) } catch (error) { return false } })()`
        )
        if (ready) {
          return
        }
        if (Date.now() > deadline) {
          throw new Error(`timeout while waiting for ${expression}`)
        }
        await sleep(50)
      }
    }

    const waitForRequest = async (fragment: string, timeoutMs = 20000): Promise<void> => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        if (requests.some((url) => url.includes(fragment))) {
          return
        }
        if (Date.now() > deadline) {
          throw new Error(`timeout while waiting for the request ${fragment}`)
        }
        await sleep(50)
      }
    }

    const navigate = async (url: string): Promise<void> => {
      const loaded = new Promise<void>((resolve) => {
        const off = cdp.on(
          'Page.loadEventFired',
          () => {
            off()
            resolve()
          },
          sessionId
        )
        setTimeout(() => {
          off()
          resolve()
        }, 20000)
      })
      await cdp.send('Page.navigate', { url }, sessionId)
      await loaded
    }

    const click = async (expression: string): Promise<void> => {
      const box = await evaluate<{ x: number; y: number } | null>(`(() => {
        const element = ${expression}
        if (!element) {
          return null
        }
        element.scrollIntoView({ block: 'center', inline: 'center' })
        const rect = element.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) {
          return null
        }
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      })()`)
      if (!box) {
        throw new Error(`cannot click ${expression}`)
      }
      await cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x: box.x, y: box.y },
        sessionId
      )
      await cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 },
        sessionId
      )
      await cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 },
        sessionId
      )
    }

    const fill = async (expression: string, value: string): Promise<void> => {
      await evaluate(`(() => {
        const element = ${expression}
        if (!element) {
          throw new Error('the field to fill is missing')
        }
        const prototype =
          element instanceof window.HTMLTextAreaElement
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
        if (!setter) {
          throw new Error('the value setter is missing')
        }
        setter.call(element, ${JSON.stringify(value)})
        element.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
    }

    const close = async (): Promise<void> => {
      await cdp.send('Target.closeTarget', { targetId: created.targetId }).catch(() => undefined)
    }

    return {
      sessionId,
      requests: () => requests.slice(),
      navigate,
      evaluate,
      waitFor,
      waitForRequest,
      click,
      fill,
      close,
    }
  }

  const close = async (): Promise<void> => {
    cdp.close()
    child.kill('SIGKILL')
    await rm(userDataDir, { recursive: true, force: true })
  }

  return { newPage, close }
}
