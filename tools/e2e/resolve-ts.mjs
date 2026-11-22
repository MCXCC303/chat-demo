import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const apiClientStub = new URL('./api-client-stub.mjs', import.meta.url)

export const resolve = (specifier, context, nextResolve) => {
  if (specifier.endsWith('/api/client.js')) {
    return { url: apiClientStub.href, shortCircuit: true }
  }
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)
    if (existsSync(fileURLToPath(candidate))) {
      return { url: candidate.href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
