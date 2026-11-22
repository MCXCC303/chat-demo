import { ApiError, API_ORIGIN } from '../api/client.js'
import type { CommandResult, SessionCommand } from './types.js'

export type SessionCommandFailure = 'network' | 'rejected'

export class SessionCommandError extends ApiError {
  readonly failure: SessionCommandFailure
  readonly code: string

  constructor(failure: SessionCommandFailure, code: string, message: string, status?: number) {
    super(failure === 'network' ? 'network' : 'http', message, status)
    this.name = 'SessionCommandError'
    this.failure = failure
    this.code = code
  }
}

const ERROR_CODE = /^[a-z][a-z0-9_]*$/

const readRejection = async (response: Response): Promise<SessionCommandError> => {
  const text = await response.text().catch(() => '')
  let code = 'rejected'
  let message = text || response.statusText
  try {
    const body = JSON.parse(text) as Record<string, unknown>
    const error = body.error
    if (typeof error === 'string') {
      if (ERROR_CODE.test(error)) {
        code = error
      } else {
        message = error
      }
    } else if (typeof error === 'object' && error !== null) {
      const detail = error as Record<string, unknown>
      if (typeof detail.code === 'string') {
        code = detail.code
      }
      if (typeof detail.message === 'string') {
        message = detail.message
      }
    }
    if (typeof body.code === 'string') {
      code = body.code
    }
    if (typeof body.message === 'string') {
      message = body.message
    }
  } catch {
    message = text || response.statusText
  }
  return new SessionCommandError('rejected', code, message, response.status)
}

export const sendSessionCommand = async (
  sessionId: string,
  command: SessionCommand,
  signal?: AbortSignal
): Promise<number[]> => {
  let response: Response
  try {
    response = await fetch(`${API_ORIGIN}/api/sessions/${encodeURIComponent(sessionId)}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
      signal,
    })
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    throw new SessionCommandError(
      'network',
      'network_unreachable',
      error instanceof Error ? error.message : String(error)
    )
  }
  if (!response.ok) {
    throw await readRejection(response)
  }
  let result: CommandResult
  try {
    result = (await response.json()) as CommandResult
  } catch {
    throw new ApiError('protocol', '服务端没有返回命令结果')
  }
  if (!result || !Array.isArray(result.accepted)) {
    throw new ApiError('protocol', '服务端没有返回被接受的事件序号')
  }
  return result.accepted.filter((value): value is number => typeof value === 'number')
}
