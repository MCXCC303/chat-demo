import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const bundleExists = (staticRoot: string): boolean =>
  existsSync(resolve(staticRoot, 'index.html'))

export const buildFrontend = async (staticRoot: string): Promise<void> => {
  const binary = resolve(repoRoot, 'node_modules', '.bin', 'rspack')
  if (!existsSync(binary)) {
    throw new Error('rspack not found; install the dependencies first')
  }
  await new Promise<void>((resolveBuild, rejectBuild) => {
    const child = spawn(
      binary,
      ['build', '-c', 'rspack.server.config.ts', '--output-path', staticRoot],
      {
        cwd: repoRoot,
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'production' },
      }
    )
    child.on('error', rejectBuild)
    child.on('exit', (code) => {
      if (code === 0) {
        resolveBuild()
        return
      }
      rejectBuild(new Error(`frontend build failed with exit code ${code}`))
    })
  })
}
