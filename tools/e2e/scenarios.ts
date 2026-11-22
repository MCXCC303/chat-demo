import type { Page } from './lib/browser.ts'
import { sleep } from './lib/browser.ts'
import type { MockPlan, MockUpstream } from './lib/mock-upstream.ts'
import type { TcpProxy } from './lib/tcp-proxy.ts'

export const SELECTORS = {
  chatInput: "document.querySelector('textarea[placeholder]')",
  sendButton: 'document.querySelector(\'button[aria-label="发送"], button[aria-label="Send"]\')',
  thinkingToggle:
    'document.querySelector(\'button[aria-label="深度思考"], button[aria-label="DeepThink"]\')',
  searchToggle:
    'document.querySelector(\'button[aria-label="智能搜索"], button[aria-label="Search"]\')',
  editButton:
    'document.querySelector(\'button[aria-label="编辑消息"], button[aria-label="Edit message"]\')',
  editorTextarea:
    'document.querySelector(\'textarea[aria-label="编辑消息"], textarea[aria-label="Edit message"]\')',
  editorSendButton: `(() => {
    const textarea = document.querySelector('textarea[aria-label="编辑消息"], textarea[aria-label="Edit message"]')
    if (!textarea || !textarea.parentElement) {
      return null
    }
    return (
      [...textarea.parentElement.querySelectorAll('button')].find((button) => {
        const text = button.textContent?.trim()
        return text === '发送' || text === 'Send'
      }) ?? null
    )
  })()`,
  continueButton: `(() => {
    return (
      [...document.querySelectorAll('button')].find((button) => {
        const text = button.textContent?.trim()
        return text === '继续生成' || text === 'Continue'
      }) ?? null
    )
  })()`,
  regenerateButtonLast: `(() => {
    const buttons = document.querySelectorAll('button[aria-label="重新生成"], button[aria-label="Regenerate"]')
    return buttons.length === 0 ? null : buttons[buttons.length - 1]
  })()`,
  replyText: `(() => {
    const button = document.querySelector('button[aria-label="重新生成"], button[aria-label="Regenerate"]')
    const root = button?.closest('[data-message-id]')
    return root?.textContent ?? ''
  })()`,
}

export type ScenarioContext = {
  page: Page
  mock: MockUpstream
  proxy: TcpProxy
  log: (message: string) => void
}

export type Scenario = {
  name: string
  title: string
  settings: { thinking: boolean; search: boolean }
  plan?: Partial<MockPlan>
  run: (context: ScenarioContext) => Promise<void>
}

export const waitForRequests = async (
  mock: MockUpstream,
  count: number,
  timeoutMs = 30000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (mock.requests.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`timeout while waiting for ${count} upstream requests`)
    }
    await sleep(50)
  }
}

export const waitForReply = async (
  page: Page,
  mock: MockUpstream,
  count: number
): Promise<void> => {
  await waitForRequests(mock, count)
  await page.waitFor(`${SELECTORS.sendButton} !== null`)
  await page.waitFor(`${SELECTORS.regenerateButtonLast} !== null`)
}

export const sendMessage = async (page: Page, text: string): Promise<void> => {
  await page.fill(SELECTORS.chatInput, text)
  await page.click(SELECTORS.sendButton)
}

export const ensureToggle = async (page: Page, selector: string): Promise<void> => {
  const pressed = await page.evaluate<boolean | null>(
    `(() => {
      const button = ${selector}
      return button ? button.getAttribute('aria-pressed') === 'true' : null
    })()`
  )
  if (pressed === null) {
    throw new Error(`the toggle ${selector} is missing`)
  }
  if (!pressed) {
    await page.click(selector)
  }
}

export const scenarios: Scenario[] = [
  {
    name: 'send',
    title: '发送一条消息',
    settings: { thinking: false, search: false },
    run: async ({ page, mock }) => {
      await sendMessage(page, 'golden-e2e 发送消息')
      await waitForReply(page, mock, 1)
    },
  },
  {
    name: 'regenerate',
    title: '重新生成回答',
    settings: { thinking: false, search: false },
    run: async ({ page, mock }) => {
      await sendMessage(page, 'golden-e2e 重新生成')
      await waitForReply(page, mock, 1)
      await page.click(SELECTORS.regenerateButtonLast)
      await waitForReply(page, mock, 2)
    },
  },
  {
    name: 'edit',
    title: '编辑提问后重发',
    settings: { thinking: false, search: false },
    run: async ({ page, mock }) => {
      await sendMessage(page, 'golden-e2e 编辑前')
      await waitForReply(page, mock, 1)
      await page.click(SELECTORS.editButton)
      await page.waitFor(`${SELECTORS.editorTextarea} !== null`)
      await page.fill(SELECTORS.editorTextarea, 'golden-e2e 编辑后')
      await page.waitFor(
        `(() => {
          const button = ${SELECTORS.editorSendButton}
          return button ? !button.disabled : false
        })()`
      )
      await page.click(SELECTORS.editorSendButton)
      await waitForReply(page, mock, 2)
    },
  },
  {
    name: 'continue',
    title: '续写未完成的回答',
    settings: { thinking: false, search: false },
    plan: { truncateFirst: true },
    run: async ({ page, mock }) => {
      await sendMessage(page, 'golden-e2e 续写')
      await waitForReply(page, mock, 1)
      await page.waitFor(`${SELECTORS.continueButton} !== null`)
      await page.click(SELECTORS.continueButton)
      await waitForReply(page, mock, 2)
    },
  },
  {
    name: 'thinking',
    title: '开启深度思考',
    settings: { thinking: true, search: false },
    run: async ({ page, mock }) => {
      await ensureToggle(page, SELECTORS.thinkingToggle)
      await sendMessage(page, 'golden-e2e 深度思考')
      await waitForReply(page, mock, 1)
    },
  },
  {
    name: 'search',
    title: '开启智能搜索',
    settings: { thinking: false, search: true },
    run: async ({ page, mock }) => {
      await ensureToggle(page, SELECTORS.searchToggle)
      await sendMessage(page, 'golden-e2e 智能搜索')
      await waitForReply(page, mock, 1)
    },
  },
]
