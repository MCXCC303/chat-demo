import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchBrowser, type Browser } from './lib/browser.ts'
import { startAppServer } from './lib/app-server.ts'
import {
  chunkTexts,
  startMockUpstream,
  type MockUpstream,
  type RecordedRequest,
} from './lib/mock-upstream.ts'
import { startTcpProxy } from './lib/tcp-proxy.ts'
import { scenarios, SELECTORS, sendMessage, type Scenario } from './scenarios.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const baselineDir = join(repoRoot, 'tools', 'e2e', 'baseline')
const stableHeaders = ['content-type', 'accept', 'anthropic-beta']
const secretHeaders = ['x-api-key', 'authorization']

type BaselineRequest = {
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

type Baseline = {
  scenario: string
  title: string
  requests: BaselineRequest[]
}

const log = (message: string): void => {
  process.stdout.write(`${message}\n`)
}

const ensureBundle = async (): Promise<void> => {
  if (existsSync(join(repoRoot, 'dist-server', 'index.html'))) {
    return
  }
  log('dist-server 不存在，先构建前端产物')
  await new Promise<void>((resolveBuild, rejectBuild) => {
    const child = spawn(
      join(repoRoot, 'node_modules', '.bin', 'rspack'),
      ['build', '-c', 'rspack.server.config.ts'],
      {
        cwd: repoRoot,
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'production' },
      }
    )
    child.on('error', rejectBuild)
    child.on('exit', (code) => {
      if (code === 0) {
        resolveBuild()
        return
      }
      rejectBuild(new Error(`the frontend build failed with the exit code ${code}`))
    })
  })
}

const normalizeClockFields = (body: string): string =>
  body.replace(/\d{4}-\d{2}-\d{2},(星期|周)[一二三四五六日天]/g, '<date>')

const toBaseline = (scenario: Scenario, requests: RecordedRequest[]): Baseline => ({
  scenario: scenario.name,
  title: scenario.title,
  requests: requests.map((request) => {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(request.headers)) {
      if (secretHeaders.includes(name)) {
        headers[name] = '<redacted>'
        continue
      }
      headers[name] = name === 'host' ? '<upstream>' : value
    }
    return {
      method: request.method,
      path: request.path,
      headers,
      body: normalizeClockFields(request.body),
    }
  }),
})

const pretty = (body: string): string => {
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

const diffBodies = (expected: string, actual: string): string => {
  const left = pretty(expected).split('\n')
  const right = pretty(actual).split('\n')
  const lines: string[] = []
  const total = Math.max(left.length, right.length)
  for (let index = 0; index < total; index += 1) {
    if (left[index] !== right[index]) {
      lines.push(`    基线: ${left[index] ?? ''}`)
      lines.push(`    本次: ${right[index] ?? ''}`)
    }
  }
  if (lines.length === 0) {
    lines.push(`    基线: ${expected}`)
    lines.push(`    本次: ${actual}`)
  }
  return lines.join('\n')
}

const compareBaseline = async (
  scenario: Scenario,
  requests: RecordedRequest[]
): Promise<string[]> => {
  const path = join(baselineDir, `${scenario.name}.json`)
  let expected: Baseline
  try {
    expected = JSON.parse(await readFile(path, 'utf8')) as Baseline
  } catch {
    return [`缺少基线文件 ${path}`]
  }
  const actual = toBaseline(scenario, requests)
  const problems: string[] = []
  if (expected.requests.length !== actual.requests.length) {
    problems.push(
      `上游请求数量不一致：基线 ${expected.requests.length}，本次 ${actual.requests.length}`
    )
  }
  const total = Math.min(expected.requests.length, actual.requests.length)
  for (let index = 0; index < total; index += 1) {
    const left = expected.requests[index]
    const right = actual.requests[index]
    if (left.body !== right.body) {
      problems.push(`第 ${index + 1} 个上游请求体不一致：\n${diffBodies(left.body, right.body)}`)
    }
    for (const header of stableHeaders) {
      const before = left.headers[header] ?? ''
      const after = right.headers[header] ?? ''
      if (before !== after) {
        problems.push(
          `第 ${index + 1} 个上游请求头 ${header} 不一致：基线 ${before}，本次 ${after}`
        )
      }
    }
  }
  return problems
}

const writeBaseline = async (scenario: Scenario, requests: RecordedRequest[]): Promise<void> => {
  await mkdir(baselineDir, { recursive: true })
  const path = join(baselineDir, `${scenario.name}.json`)
  await writeFile(path, `${JSON.stringify(toBaseline(scenario, requests), null, 2)}\n`, 'utf8')
  log(`  基线已写入 ${path}`)
}

const runScenario = async (
  scenario: Scenario,
  context: { mock: MockUpstream; browser: Browser }
): Promise<RecordedRequest[]> => {
  const home = await mkdtemp(join(tmpdir(), 'chat-demo-e2e-home-'))
  const server = await startAppServer({ repoRoot, upstream: context.mock.origin, home })
  try {
    await server.setSettings({
      locale: 'zh-CN',
      themePreference: 'light',
      location: null,
      ttsVoice: 'stella',
      thinking: scenario.settings.thinking,
      search: scenario.settings.search,
    })
    context.mock.reset()
    context.mock.setPlan(scenario.plan ?? {})
    const proxy = await startTcpProxy(server.port)
    try {
      const page = await context.browser.newPage()
      try {
        await page.navigate(proxy.origin)
        await page.waitForRequest('/api/status')
        await page.waitForRequest('/api/settings')
        await page.waitFor(`${SELECTORS.chatInput} !== null`)
        await scenario.run({ page, mock: context.mock, proxy, log })
      } finally {
        await page.close()
      }
    } finally {
      await proxy.close()
    }
    return context.mock.requests.slice()
  } finally {
    await server.stop()
    await rm(home, { recursive: true, force: true })
  }
}

const runDisconnectCheck = async (context: {
  mock: MockUpstream
  browser: Browser
}): Promise<string[]> => {
  const chunks = 20
  const home = await mkdtemp(join(tmpdir(), 'chat-demo-e2e-home-'))
  const server = await startAppServer({ repoRoot, upstream: context.mock.origin, home })
  try {
    context.mock.reset()
    context.mock.setPlan({ chunks, chunkDelayMs: 60 })
    const proxy = await startTcpProxy(server.port)
    try {
      const page = await context.browser.newPage()
      try {
        await page.navigate(proxy.origin)
        await page.waitForRequest('/api/status')
        await page.waitFor(`${SELECTORS.chatInput} !== null`)
        await sendMessage(page, 'golden-e2e 断线续传')
        await page.waitFor(`document.body.textContent.includes('mock-chunk-01')`)
        proxy.cut()
        await page.waitFor(`${SELECTORS.sendButton} !== null`, 60000)
        await page.waitFor(`${SELECTORS.regenerateButtonLast} !== null`, 60000)
        const text = await page.evaluate<string>(SELECTORS.replyText)
        const missing = chunkTexts(chunks).filter((chunk) => !text.includes(chunk))
        if (missing.length > 0) {
          return [`断线后续传丢失了内容：${missing.join(' ')}`]
        }
        const subscriptions = page
          .requests()
          .filter((url) => url.includes('/api/sessions/') && url.includes('/stream'))
        if (subscriptions.length < 2) {
          return [`断线后没有按 seq 重新订阅轮次事件（只发起了 ${subscriptions.length} 次订阅）`]
        }
        return []
      } finally {
        await page.close()
      }
    } finally {
      await proxy.close()
    }
  } finally {
    await server.stop()
    await rm(home, { recursive: true, force: true })
  }
}

const valueOf = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name)
  if (index === -1) {
    return undefined
  }
  return args[index + 1]
}

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)
  const mode = args.find((arg) => !arg.startsWith('-')) ?? 'compare'
  if (mode !== 'capture' && mode !== 'compare' && mode !== 'disconnect') {
    throw new Error(`未知模式 ${mode}，可用模式：capture、compare、disconnect`)
  }
  const only = valueOf(args, '--scenario')
  const headful = args.includes('--headful')

  await ensureBundle()
  const mock = await startMockUpstream()
  const browser = await launchBrowser({ headful })
  const failures: string[] = []
  try {
    if (mode === 'disconnect') {
      log('断线续传检查：生成途中切断浏览器到服务端的连接')
      const problems = await runDisconnectCheck({ mock, browser })
      failures.push(...problems)
      log(problems.length === 0 ? '断线续传检查通过' : '断线续传检查失败')
    } else {
      for (const scenario of scenarios) {
        if (only !== undefined && scenario.name !== only) {
          continue
        }
        log(`场景 ${scenario.name}：${scenario.title}`)
        const requests = await runScenario(scenario, { mock, browser })
        log(`  上游收到 ${requests.length} 个请求`)
        if (mode === 'capture') {
          await writeBaseline(scenario, requests)
          continue
        }
        const problems = await compareBaseline(scenario, requests)
        if (problems.length === 0) {
          log('  与基线一致')
          continue
        }
        failures.push(`场景 ${scenario.name} 与基线不一致：\n  ${problems.join('\n  ')}`)
        log('  与基线不一致')
      }
    }
  } finally {
    await browser.close()
    await mock.close()
  }

  if (failures.length > 0) {
    log('')
    for (const failure of failures) {
      log(failure)
    }
    process.exitCode = 1
    return
  }
  log(mode === 'capture' ? '采集完成' : mode === 'disconnect' ? '断线续传检查完成' : '比对通过')
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  )
  process.exitCode = 1
})
