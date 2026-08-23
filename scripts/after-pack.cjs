const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

const unnecessaryUsageDescriptions = [
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
]

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const infoPlist = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Info.plist',
  )

  execFileSync('/usr/bin/plutil', [
    '-replace',
    'NSAppTransportSecurity.NSAllowsArbitraryLoads',
    '-bool',
    'NO',
    infoPlist,
  ])

  for (const key of unnecessaryUsageDescriptions) {
    execFileSync('/usr/bin/plutil', ['-remove', key, infoPlist])
  }
}