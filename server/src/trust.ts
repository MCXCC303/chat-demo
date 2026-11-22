import type { IncomingMessage } from 'node:http'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

const parseAuthority = (
  authority: string,
  scheme: 'http:' | 'https:' = 'http:'
): URL | undefined => {
  try {
    return new URL(`${scheme}//${authority}`)
  } catch {
    return undefined
  }
}

const canonicalAuthority = (parsed: URL): string =>
  parsed.port === '' ? parsed.hostname : `${parsed.hostname}:${parsed.port}`

const hostnameOf = (host: string): string => {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end === -1 ? host : host.slice(1, end)
  }
  const index = host.lastIndexOf(':')
  return index === -1 ? host : host.slice(0, index)
}

export const isLoopbackHost = (host: string): boolean =>
  LOOPBACK_HOSTS.has(hostnameOf(host.toLowerCase()))

export const assertTrustedAuthority = (entry: string): void => {
  const parsed = parseAuthority(entry)
  if (parsed !== undefined && canonicalAuthority(parsed) === entry.toLowerCase()) {
    return
  }
  throw new Error(`trusted host ${JSON.stringify(entry)} is not a bare host or host:port authority`)
}

const matchesTrusted = (host: string, trustedHosts: readonly string[]): boolean => {
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) {
    return false
  }
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) {
      return false
    }
    const entryCanonical = canonicalAuthority(entryUrl)
    if (entryCanonical === entryUrl.hostname) {
      return entryUrl.hostname === hostUrl.hostname
    }
    return entryCanonical === canonicalAuthority(hostUrl)
  })
}

const sameAuthorityOrigin = (origin: string, host: string): boolean => {
  let originUrl: URL
  try {
    originUrl = new URL(origin)
  } catch {
    return false
  }
  const scheme =
    originUrl.protocol === 'https:'
      ? 'https:'
      : originUrl.protocol === 'http:'
        ? 'http:'
        : undefined
  if (scheme === undefined) {
    return false
  }
  const hostUrl = parseAuthority(host, scheme)
  return hostUrl !== undefined && originUrl.host === hostUrl.host
}

export const isTrustedRequest = (
  req: IncomingMessage,
  boundHost: string,
  trustedHosts: readonly string[] = []
): boolean => {
  const host = req.headers.host
  if (!host) {
    return false
  }
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) {
    return false
  }
  if (
    !isLoopbackHost(host) &&
    hostnameOf(host.toLowerCase()) !== boundHost.toLowerCase() &&
    !matchesTrusted(host, trustedHosts)
  ) {
    return false
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    return false
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && !sameAuthorityOrigin(origin, host)) {
    return false
  }
  return true
}
