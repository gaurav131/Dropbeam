# Dropbeam

Dropbeam is a macOS desktop app for sharing selected files directly with devices on the same local network. Add files with the native picker or drag them into the window, then scan the generated QR code to open the download page on another device.

Files are streamed from the Mac over a tokenized, ephemeral HTTP address. Dropbeam does not upload them to a cloud service. Because local transfers use plain HTTP, use Dropbeam only on a network you trust.

The link is rotated whenever the shared file set or local network address changes. Choosing **Stop sharing** or closing the last Dropbeam window revokes the current link immediately.

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

Universal `.app`, `.dmg`, and `.zip` outputs are written to `release/`. Without Apple credentials, electron-builder creates a local unsigned build that must not be distributed.

Distribution builds require these repository secrets:

- `MAC_CSC_LINK`: exported Developer ID Application certificate (`.p12`) as a path, URL, or base64 value
- `MAC_CSC_KEY_PASSWORD`: certificate password
- `APPLE_ID`: Apple developer account email
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password
- `APPLE_TEAM_ID`: Apple Developer team ID

Pushing a `v*` tag creates a GitHub release. Without Apple credentials it is source-only. When all signing secrets are configured, the job also launches the packaged app smoke test and verifies the universal architecture, signature, Gatekeeper assessment, stapled notarization ticket, DMG checksum, and privacy metadata before attaching the `.dmg` and `.zip` files.