export class ApiError extends Error {
  constructor(kind, message, status) {
    super(typeof message === 'string' ? message : String(message))
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
  }
}

export const API_ORIGIN = globalThis.__API_ORIGIN__ ?? ''

export const request = async () => {
  throw new ApiError('protocol', 'api client is stubbed in the e2e harness')
}
