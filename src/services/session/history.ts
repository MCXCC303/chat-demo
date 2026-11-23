import { API_ORIGIN } from '../api/client.js'
import type { Session } from '../chat/types.js'
import type { SessionHistoryPage } from './types.js'

export const fetchSessionHistoryPage = async (
  sessionId: string,
  before: string | null,
  limit: number,
  signal?: AbortSignal
): Promise<SessionHistoryPage> => {
  const params = new URLSearchParams({ limit: String(limit) })
  if (before !== null) {
    params.set('before', before)
  }
  const response = await fetch(
    `${API_ORIGIN}/api/sessions/${encodeURIComponent(sessionId)}/history?${params}`,
    { cache: 'no-store', signal }
  )
  if (!response.ok) {
    throw new Error(`history page failed: ${response.status}`)
  }
  const body = (await response.json()) as {
    session?: Partial<Session>
    seq?: unknown
    hasMore?: unknown
    before?: unknown
  }
  if (
    typeof body.session !== 'object' ||
    body.session === null ||
    !Array.isArray(body.session.messages) ||
    typeof body.seq !== 'number' ||
    !Number.isFinite(body.seq)
  ) {
    throw new Error('invalid history page')
  }
  return {
    session: body.session as Session,
    seq: body.seq,
    hasMore: body.hasMore === true,
    before: typeof body.before === 'string' ? body.before : null,
  }
}
