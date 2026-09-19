# Dropbeam

Dropbeam is a macOS and Windows desktop app for sharing files directly with devices on the same local network. Add files with the native picker or drag them into the window, then scan the generated QR code. Nearby devices can download those files or send files back to the computer.

Files are streamed over a tokenized, ephemeral HTTP address. Received files are saved to `Dropbeam` inside your system Downloads folder; name collisions create a numbered copy instead of overwriting an existing file. Incoming filenames are normalized to avoid Windows-invalid characters and reserved device names on both platforms. Each file can be up to 2 GB, receiving is capped at 10 GB per app session, and Dropbeam keeps 512 MB of disk space in reserve. Dropbeam does not upload files to a cloud service. Because local transfers use plain HTTP, use Dropbeam only on a network you trust.

The link is rotated whenever the shared file set, receiving state, or local network address changes. Use **Pause receiving** to revoke upload access without removing outbound files. Closing Dropbeam revokes the current link immediately.

## Features

- Send files from your Mac or Windows PC through a QR code or local link
- Receive photos and files from phones, tablets, and computers
- Stream transfers directly over the local network with no cloud storage
- Preserve existing files by creating numbered copies for name collisions
- Pause incoming uploads independently from outbound downloads
- Limit individual uploads to 2 GB and each app session to 10 GB

## Changes in 0.3.0

- Windows x64 NSIS installer alongside the existing universal macOS build
- Native Windows window controls and platform-neutral labels
- Portable incoming filenames, including Windows device names and invalid characters
- LAN selection that avoids common VPN and host-only adapters while supporting Hyper-V external switches
- Windows CI checks for file transfers, packaged startup, and installation

## Install

### macOS

1. Download the universal macOS DMG or ZIP from the [latest release](https://github.com/gaurav131/Dropbeam/releases/latest).
2. Open the DMG and move Dropbeam to Applications, or extract the ZIP and move the app manually.
3. Launch Dropbeam and allow local network access when macOS asks.

Current release builds are unsigned. On first launch, macOS may require you to Control-click Dropbeam, choose **Open**, and confirm. Signed and notarized builds will replace them after Apple signing credentials are configured.

### Windows x64

1. Download `Dropbeam-0.3.0-windows-x64-setup.exe` from the [v0.3.0 release](https://github.com/gaurav131/Dropbeam/releases/tag/v0.3.0). Development installers are also available as `dropbeam-windows-x64` artifacts from successful GitHub Actions runs.
2. Run `Dropbeam-<version>-windows-x64-setup.exe` and choose an installation folder.
3. Launch Dropbeam. If Windows Firewall prompts, allow access on **Private networks** only, and use a trusted network marked Private in Windows Settings. Do not disable the firewall.

Windows installers are currently unsigned and may trigger Microsoft Defender SmartScreen warnings. Only run builds from a source you trust. Windows ARM64 is not a build target yet.

## Requirements

- macOS 12 or later on Apple silicon or Intel, or Windows 10 or later on x64
- Node.js 22 or later for development only
- Both devices connected to the same Wi-Fi or local network

## Development

```bash
npm install
npm run dev
```

## Checks

```bash
npm run lint
npm test
npm run build
```

On Windows, the symlink security tests require Developer Mode or an elevated terminal. CI runs these tests without skipping them.

## Package for macOS

```bash
npm run package:mac
```

Universal `.app`, `.dmg`, and `.zip` outputs are written to `release/`.

## Package for Windows x64

```bash
npm run package:win
```

The NSIS installer is written to `release/Dropbeam-<version>-windows-x64-setup.exe`. The unpacked app is in `release/win-unpacked/`; keep that entire folder together if using it without the installer.

This command can run on Windows or macOS, including Apple silicon. The pinned NSIS toolset supports native Apple silicon packaging; the legacy default compiler requires Intel execution support. Building on macOS does not verify Windows runtime behavior.

On Windows, smoke-test the packaged app with:

```bash
npm run test:package
```

CI runs lint, tests, and builds on both macOS and Windows. Its Windows job builds the x64 installer, tests the unpacked app, installs it silently, and tests the installed app before uploading the installer. Tagged releases publish both macOS and Windows artifacts only after these checks succeed. Manual release runs check out the requested tag in every job and require it to match the package version.