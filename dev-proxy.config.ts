import { defineConfig } from '@rspack/cli'
import { createConfig } from './rspack.config.js'

const apiOrigin = process.env.API_PROXY === 'off' ? 'https://api.deepseek.com' : ''
const host = process.env.HOST ?? '127.0.0.1'
const proxyTarget = process.env.API_TARGET ?? 'https://api.deepseek.com'
const serverTarget = process.env.CHAT_DEMO_SERVER

const proxy = [
  { context: ['/anthropic'], target: proxyTarget, changeOrigin: true, secure: true },
  { context: ['/models'], target: proxyTarget, changeOrigin: true, secure: true },
  { context: ['/v1/tools'], target: proxyTarget, changeOrigin: true, secure: true },
  ...(serverTarget
    ? [
        {
          context: ['/api', '/config.json'],
          target: serverTarget,
          changeOrigin: true,
          secure: false,
        },
      ]
    : []),
]

export default defineConfig(
  createConfig({
    apiOrigin,
    devServer: {
      host,
      port: Number(process.env.PORT ?? 8090),
      allowedHosts: 'all',
      proxy,
    },
  })
)
