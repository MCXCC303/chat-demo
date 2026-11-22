import { resolve } from 'node:path'
import { defineConfig } from '@rspack/cli'
import { createConfig } from './rspack.config.js'

/** 本机服务模式：接口地址留空，所有请求打到同源的后端 */
const config = createConfig({ apiOrigin: '' })

// eslint-disable-next-line import/no-default-export
export default defineConfig({
  ...config,
  output: {
    ...config.output,
    path: resolve(process.cwd(), 'dist-server'),
  },
})
