export type CdpHandler = (params: Record<string, unknown>) => void

type CdpSubscription = {
  sessionId?: string
  handler: CdpHandler
}

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type CdpMessage = {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  sessionId?: string
  error?: { message: string }
}

export class CdpClient {
  private readonly socket: WebSocket
  private readonly pending = new Map<number, PendingCall>()
  private readonly subscriptions = new Map<string, CdpSubscription[]>()
  private nextId = 1
  private closed = false

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener('message', (event) => {
      this.dispatch(String(event.data))
    })
    socket.addEventListener('close', () => {
      this.closed = true
      for (const call of this.pending.values()) {
        call.reject(new Error('the CDP connection is closed'))
      }
      this.pending.clear()
    })
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener(
        'error',
        () => reject(new Error(`cannot reach the CDP endpoint ${url}`)),
        {
          once: true,
        }
      )
    })
    return new CdpClient(socket)
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('the CDP connection is closed'))
    }
    const id = this.nextId
    this.nextId += 1
    const payload =
      sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
      this.socket.send(JSON.stringify(payload))
    })
  }

  on(method: string, handler: CdpHandler, sessionId?: string): () => void {
    const subscription: CdpSubscription = { handler, sessionId }
    const list = this.subscriptions.get(method) ?? []
    list.push(subscription)
    this.subscriptions.set(method, list)
    return () => {
      const current = this.subscriptions.get(method) ?? []
      this.subscriptions.set(
        method,
        current.filter((item) => item !== subscription)
      )
    }
  }

  close(): void {
    this.closed = true
    this.socket.close()
  }

  private dispatch(raw: string): void {
    let message: CdpMessage
    try {
      message = JSON.parse(raw) as CdpMessage
    } catch {
      return
    }
    if (typeof message.id === 'number') {
      const call = this.pending.get(message.id)
      if (!call) {
        return
      }
      this.pending.delete(message.id)
      if (message.error) {
        call.reject(new Error(message.error.message))
        return
      }
      call.resolve(message.result)
      return
    }
    if (!message.method) {
      return
    }
    for (const subscription of this.subscriptions.get(message.method) ?? []) {
      if (subscription.sessionId !== undefined && subscription.sessionId !== message.sessionId) {
        continue
      }
      subscription.handler(message.params ?? {})
    }
  }
}
