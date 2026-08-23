import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const appPath = resolve(
  process.argv[2] ?? join('release', 'mac-universal', 'Dropbeam.app'),
)
const executable = join(appPath, 'Contents', 'MacOS', 'Dropbeam')
await access(executable)

const child = spawn(executable, ['--smoke-test'], {
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => { stdout += chunk })
child.stderr.on('data', (chunk) => { stderr += chunk })

const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000)
const { code, signal } = await new Promise((resolveExit, reject) => {
  child.once('error', reject)
  child.once('exit', (exitCode, exitSignal) => {
    resolveExit({ code: exitCode, signal: exitSignal })
  })
})
clearTimeout(timeout)

if (code !== 0 || !stdout.includes('PACKAGED_SMOKE_OK')) {
  throw new Error(
    `Packaged smoke test failed (${code ?? signal}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  )
}

console.log(`Packaged smoke test passed: ${appPath}`)