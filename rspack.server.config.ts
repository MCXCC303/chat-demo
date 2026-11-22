import { resolve } from 'node:path'
import { defineConfig } from '@rspack/cli'
import { createConfig } from './rspack.config.js'

const config = createConfig({ apiOrigin: '' })

// eslint-disable-next-line import/no-default-export
export default defineConfig({
  ...config,
  output: {
    ...config.output,
    path: resolve(process.cwd(), 'dist-server'),
  },
})
