# Dropbeam

Dropbeam is a macOS desktop app for sharing files directly with devices on the same local network. Add files with the native picker or drag them into the window, then scan the generated QR code. Nearby devices can download those files or send files back to the Mac.

Files are streamed over a tokenized, ephemeral HTTP address. Files received by the Mac are saved to `Downloads/Dropbeam`; name collisions create a numbered copy instead of overwriting an existing file. Each file can be up to 2 GB, receiving is capped at 10 GB per app session, and Dropbeam keeps 512 MB of disk space in reserve. Dropbeam does not upload files to a cloud service. Because local transfers use plain HTTP, use Dropbeam only on a network you trust.

The link is rotated whenever the shared file set, receiving state, or local network address changes. Use **Pause receiving** to revoke upload access without removing outbound files. Closing Dropbeam revokes the current link immediately.

## Features

- Send files from your Mac through a QR code or local link
- Receive photos and files from phones, tablets, and computers
- Stream transfers directly over the local network with no cloud storage
- Preserve existing files by creating numbered copies for name collisions
- Pause incoming uploads independently from outbound downloads
- Limit individual uploads to 2 GB and each app session to 10 GB

## Install

1. Download the universal macOS DMG or ZIP from the [latest release](https://github.com/gaurav131/Dropbeam/releases/latest).
2. Open the DMG and move Dropbeam to Applications, or extract the ZIP and move the app manually.
3. Launch Dropbeam and allow local network access when macOS asks.

Current release builds are unsigned. On first launch, macOS may require you to Control-click Dropbeam, choose **Open**, and confirm. Signed and notarized builds will replace them after Apple signing credentials are configured.

## Requirements

- macOS 12 or later on Apple silicon or Intel
- Node.js 22 or later
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

## Package for macOS

```bash
npm run package:mac
```

Universal `.app`, `.dmg`, and `.zip` outputs are written to `release/`. 