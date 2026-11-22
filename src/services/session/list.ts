import { API_ORIGIN } from '../api/client.js'
import type { SessionPage } from './types.js'

export const fetchSessionPage = async (offset: number, limit: number): Promise<SessionPage> => {
  const response = await fetch(`${API_ORIGIN}/api/sessions?offset=${offset}&limit=${limit}`)
  if (!response.ok) {
    throw new Error(`sessions paging failed: ${response.status}`)
  }
  const body = (await response.json()) as Partial<SessionPage>
  return {
    sessions: Array.isArray(body.sessions)
      ? body.sessions.filter((item) => typeof item?.id === 'string')
      : [],
    hasMore: body.hasMore === true,
  }
}
