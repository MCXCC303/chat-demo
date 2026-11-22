import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { CredentialStore } from './credentials.ts'

const SECRET_BYTES = 32
const COOKIE_PREFIX = 'chat-demo-auth-'
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/

export const RECORD_OWNER = 'browser-session'
export const RECORD_ID = 'signing-key'

const toBytes = (value: Buffer): Uint8Array => new Uint8Array(value)

const encodeBase64Url = (value: Uint8Array): string => Buffer.from(value).toString('base64url')

const decodeBase64Url = (value: string): Uint8Array | undefined => {
  if (!BASE64URL_PATTERN.test(value)) {
    return undefined
  }
  const decoded = toBytes(Buffer.from(value, 'base64url'))
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

const readSecret = (payload: unknown): Uint8Array | undefined => {
  if (payload === null || typeof payload !== 'object') {
    return undefined
  }
  const secret = (payload as { secret?: unknown }).secret
  if (typeof secret !== 'string') {
    return undefined
  }
  const decoded = decodeBase64Url(secret)
  return decoded && decoded.byteLength >= SECRET_BYTES ? decoded : undefined
}

export const createLaunchToken = (): string => encodeBase64Url(toBytes(randomBytes(SECRET_BYTES)))

const constantTimeEqual = (left: string, right: string): boolean => {
  const leftBytes = toBytes(Buffer.from(left, 'utf8'))
  const rightBytes = toBytes(Buffer.from(right, 'utf8'))
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false
  }
  return timingSafeEqual(leftBytes, rightBytes)
}

export const tokenMatches = (actual: string, expected: string): boolean =>
  constantTimeEqual(actual, expected)

export const cookieName = (authority: string): string =>
  COOKIE_PREFIX + encodeBase64Url(toBytes(createHash('sha256').update(authority).digest()))

export type SessionPayload = {
  version: 1
  authority: string
  issuedAt: number
  expiresAt: number
}

const sign = (payload: SessionPayload, secret: Uint8Array): string => {
  const body = encodeBase64Url(toBytes(Buffer.from(JSON.stringify(payload))))
  const mac = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${mac}`
}

export const issueSessionCookie = (
  secret: Uint8Array,
  authority: string,
  maxAgeMilliseconds: number,
  now = Date.now()
): { name: string; value: string; expiresAt: number } => {
  const issuedAt = now
  const expiresAt = issuedAt + maxAgeMilliseconds
  const payload: SessionPayload = { version: 1, authority, issuedAt, expiresAt }
  return { name: cookieName(authority), value: sign(payload, secret), expiresAt }
}

export const verifySessionCookie = (
  secret: Uint8Array,
  value: string,
  authority: string,
  now = Date.now()
): boolean => {
  const [body, mac] = value.split('.')
  if (!body || !mac) {
    return false
  }
  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  if (!constantTimeEqual(mac, expected)) {
    return false
  }
  const decoded = decodeBase64Url(body)
  if (!decoded) {
    return false
  }
  try {
    const payload = JSON.parse(Buffer.from(decoded).toString('utf8')) as SessionPayload
    return payload.version === 1 && payload.authority === authority && payload.expiresAt > now
  } catch {
    return false
  }
}

export const readCookie = (header: string | undefined, name: string): string | undefined => {
  if (!header) {
    return undefined
  }
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) {
      continue
    }
    return segment.slice(at + 1).trim()
  }
  return undefined
}

export const sessionCookieHeader = (
  name: string,
  value: string,
  expiresAt: number,
  maxAgeSeconds: number,
  secure: boolean
): string =>
  `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(
    expiresAt
  ).toUTCString()}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`

export const loadSigningSecret = async (credentials: CredentialStore): Promise<Uint8Array> => {
  const record = await credentials.readRecord(RECORD_OWNER, RECORD_ID)
  const existing = record?.kind === 'grant' ? readSecret(record.payload) : undefined
  if (existing) {
    return existing
  }
  const created = await credentials.modifyRecord(RECORD_OWNER, RECORD_ID, (current) => {
    const kept = current?.kind === 'grant' ? readSecret(current.payload) : undefined
    if (kept) {
      return current
    }
    return {
      kind: 'grant',
      payload: { secret: encodeBase64Url(toBytes(randomBytes(SECRET_BYTES))) },
    }
  })
  const secret = created?.kind === 'grant' ? readSecret(created.payload) : undefined
  if (!secret) {
    throw new Error('could not create the browser session signing key')
  }
  return secret
}
