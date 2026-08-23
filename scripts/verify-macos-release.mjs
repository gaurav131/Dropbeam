import { execFileSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
)
const appPath = resolve(
  process.argv[2] ?? join('release', 'mac-universal', 'Dropbeam.app'),
)
const dmgPath = resolve(
  process.argv[3] ?? join('release', `Dropbeam-${packageJson.version}-universal.dmg`),
)
const executable = join(appPath, 'Contents', 'MacOS', 'Dropbeam')
const infoPlist = join(appPath, 'Contents', 'Info.plist')

await Promise.all([access(executable), access(infoPlist), access(dmgPath)])

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath])
run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath])
run('/usr/bin/xcrun', ['stapler', 'validate', appPath])
run('/usr/bin/hdiutil', ['verify', dmgPath])

const architectures = new Set(run('/usr/bin/lipo', ['-archs', executable]).split(/\s+/))
for (const requiredArchitecture of ['arm64', 'x86_64']) {
  if (!architectures.has(requiredArchitecture)) {
    throw new Error(`Release is missing ${requiredArchitecture} support.`)
  }
}

const arbitraryLoads = run('/usr/bin/plutil', [
  '-extract',
  'NSAppTransportSecurity.NSAllowsArbitraryLoads',
  'raw',
  infoPlist,
])
if (arbitraryLoads !== 'false') {
  throw new Error('NSAllowsArbitraryLoads must be false in production.')
}

for (const key of [
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
]) {
  try {
    run('/usr/bin/plutil', ['-extract', key, 'raw', infoPlist])
    throw new Error(`${key} must not be present in production.`)
  } catch (error) {
    if (error instanceof Error && error.message.includes('must not be present')) throw error
  }
}

console.log(`Verified signed, notarized universal release: ${dmgPath}`)