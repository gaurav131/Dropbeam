import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { extname } from 'node:path'
import type { SharedFile, ShareInfo } from '../shared/contracts.js'

export type SharedFileRecord = {
  path: string
  device: number
  inode: number
  file: SharedFile
}

export type ShareServer = {
  getInfo: () => ShareInfo
  rotateToken: () => ShareInfo
  close: () => Promise<void>
}

const MAX_CONCURRENT_DOWNLOADS = 8

const mimeTypes: Record<string, string> = {
  '.csv': 'text/csv; charset=utf-8',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
}

function getLanAddress(): string {
  const interfaces = networkInterfaces()
  const preferredNames = ['en0', 'en1']
  const candidates = Object.entries(interfaces)
    .flatMap(([name, addresses]) =>
      (addresses ?? []).map((address) => ({ name, address })),
    )
    .filter(
      ({ name, address }) =>
        address.family === 'IPv4' &&
        !address.internal &&
        !/^(utun|awdl|llw|bridge|vbox|docker)/.test(name),
    )

  candidates.sort((left, right) => {
    const leftIndex = preferredNames.indexOf(left.name)
    const rightIndex = preferredNames.indexOf(right.name)
    return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex)
  })

  return candidates[0]?.address.address ?? '127.0.0.1'
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;',
      })[character] ?? character,
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`
}

function renderDownloadPage(token: string, files: SharedFileRecord[]): string {
  const totalSize = files.reduce((sum, { file }) => sum + file.size, 0)
  const fileRows = files.length
    ? files
        .map(
          ({ file }) => `
            <li>
              <span class="file-mark">${escapeHtml((file.extension || 'file').slice(0, 4))}</span>
              <span class="file-copy">
                <strong>${escapeHtml(file.name)}</strong>
                <small>${formatBytes(file.size)}</small>
              </span>
              <a href="/${token}/download/${file.id}" aria-label="Download ${escapeHtml(file.name)}" download>Download</a>
            </li>`,
        )
        .join('')
    : '<li class="empty">No files are currently available.</li>'

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#163c35">
  <title>Dropbeam files</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: #17211e; background: #edf1e9; font-family: Avenir Next, Avenir, Helvetica Neue, sans-serif; }
    header { padding: 42px 22px 74px; color: white; background: #163c35; }
    .wrap { width: min(100%, 680px); margin: 0 auto; }
    .brand { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .brand-mark { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid #8fc3a8; border-radius: 7px; color: #b9e4ca; }
    h1 { margin: 38px 0 8px; font-size: clamp(34px, 9vw, 54px); line-height: 1.02; letter-spacing: 0; }
    header p { margin: 0; color: #b9cfc7; font-size: 16px; }
    main { width: min(calc(100% - 28px), 680px); margin: -42px auto 0; padding-bottom: 30px; }
    .summary { display: flex; justify-content: space-between; gap: 16px; padding: 18px 20px; border: 1px solid #d7ddd3; border-bottom: 0; border-radius: 8px 8px 0 0; background: #f8faf6; color: #66716c; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
    ul { margin: 0; padding: 0; border: 1px solid #d7ddd3; border-radius: 0 0 8px 8px; overflow: hidden; list-style: none; background: white; }
    li { display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; align-items: center; gap: 13px; min-height: 76px; padding: 12px 14px; border-top: 1px solid #e4e8e1; }
    li:first-child { border-top: 0; }
    .file-mark { display: grid; place-items: center; width: 46px; height: 46px; border-radius: 6px; color: #315e50; background: #dcebe1; font: 700 10px/1 Avenir Next, sans-serif; text-transform: uppercase; }
    .file-copy { min-width: 0; }
    strong, small { display: block; }
    strong { overflow: hidden; color: #17211e; font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }
    small { margin-top: 4px; color: #7c8882; font-size: 12px; }
    a { min-height: 44px; display: inline-flex; align-items: center; padding: 9px 13px; border-radius: 6px; color: white; background: #e35635; font-size: 12px; font-weight: 700; text-decoration: none; }
    .empty { display: block; padding: 32px 20px; color: #7c8882; text-align: center; }
    footer { padding: 24px 0; color: #7c8882; font-size: 12px; text-align: center; }
  </style>
</head>
<body>
  <header><div class="wrap">
    <div class="brand"><span class="brand-mark">DB</span> Dropbeam</div>
    <h1>Files from a nearby Mac.</h1>
    <p>Tap a file below to save it to this device.</p>
  </div></header>
  <main>
    <div class="summary" role="region" aria-label="File summary"><span>${files.length} ${files.length === 1 ? 'file' : 'files'}</span><span>${formatBytes(totalSize)}</span></div>
    <ul>${fileRows}</ul>
    <footer>No cloud upload. Use this link only on a trusted local network.</footer>
  </main>
</body>
</html>`
}

function sendHeaders(response: ServerResponse, status: number, headers: Record<string, string>): void {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
}

export async function startShareServer(
  getFiles: () => SharedFileRecord[],
): Promise<ShareServer> {
  let token = randomBytes(18).toString('base64url')
  let activeDownloads = 0
  const server = createServer(async (request, response) => {
    const method = request.method ?? 'GET'
    let requestUrl: URL
    try {
      requestUrl = new URL(request.url ?? '/', 'http://localhost')
    } catch {
      sendHeaders(response, 400, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Bad request')
      return
    }
    const pagePath = `/${token}`
    const files = getFiles()

    if ((method === 'GET' || method === 'HEAD') && (requestUrl.pathname === pagePath || requestUrl.pathname === `${pagePath}/`)) {
      const body = renderDownloadPage(token, files)
      sendHeaders(response, 200, {
        'Content-Length': String(Buffer.byteLength(body)),
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      })
      response.end(method === 'HEAD' ? undefined : body)
      return
    }

    const match = requestUrl.pathname.match(new RegExp(`^/${token}/download/([a-f0-9-]+)$`))
    const record = match ? files.find(({ file }) => file.id === match[1]) : undefined

    if ((method === 'GET' || method === 'HEAD') && record) {
      let fileHandle
      try {
        fileHandle = await open(record.path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const fileStat = await fileHandle.stat()
        if (
          !fileStat.isFile() ||
          fileStat.dev !== record.device ||
          fileStat.ino !== record.inode
        ) {
          await fileHandle.close()
          sendHeaders(response, 404, { 'Content-Type': 'text/plain; charset=utf-8' })
          response.end('File not found')
          return
        }
        const contentType = mimeTypes[extname(record.file.name).toLowerCase()] ?? 'application/octet-stream'
        const asciiName = record.file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        const rangeHeader = request.headers.range
        const rangeMatch = rangeHeader?.match(/^bytes=(\d+)-(\d*)$/)

        if (rangeHeader && !rangeMatch) {
          sendHeaders(response, 416, { 'Content-Range': `bytes */${fileStat.size}` })
          await fileHandle.close()
          response.end()
          return
        }

        if (!rangeMatch && fileStat.size === 0) {
          sendHeaders(response, 200, {
            'Accept-Ranges': 'bytes',
            'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(record.file.name)}`,
            'Content-Length': '0',
            'Content-Type': contentType,
          })
          await fileHandle.close()
          response.end()
          return
        }

        const start = rangeMatch ? Number(rangeMatch[1]) : 0
        const end = rangeMatch?.[2] ? Number(rangeMatch[2]) : fileStat.size - 1

        if (start < 0 || end < start || end >= fileStat.size) {
          sendHeaders(response, 416, { 'Content-Range': `bytes */${fileStat.size}` })
          await fileHandle.close()
          response.end()
          return
        }

        const partial = Boolean(rangeMatch)

        if (method === 'GET' && activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
          sendHeaders(response, 429, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Retry-After': '2',
          })
          await fileHandle.close()
          response.end('Too many simultaneous downloads')
          return
        }

        sendHeaders(response, partial ? 206 : 200, {
          'Accept-Ranges': 'bytes',
          'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(record.file.name)}`,
          'Content-Length': String(end - start + 1),
          'Content-Type': contentType,
          ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${fileStat.size}` } : {}),
        })

        if (method === 'HEAD') {
          await fileHandle.close()
          response.end()
          return
        }

        activeDownloads += 1
        const stream = fileHandle.createReadStream({ start, end })
        let released = false
        const releaseDownload = () => {
          if (released) return
          released = true
          activeDownloads -= 1
        }
        stream.once('close', releaseDownload)
        response.once('close', releaseDownload)
        response.once('error', releaseDownload)
        stream.on('error', () => response.destroy())
        stream.pipe(response)
        return
      } catch {
        await fileHandle?.close().catch(() => undefined)
        sendHeaders(response, 404, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('File not found')
        return
      }
    }

    sendHeaders(response, 404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', () => resolve())
  })

  server.headersTimeout = 10_000
  server.requestTimeout = 30_000
  server.keepAliveTimeout = 5_000
  server.maxConnections = 32

  const serverAddress = server.address()
  if (!serverAddress || typeof serverAddress === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error('Dropbeam could not determine the local server address.')
  }

  const getInfo = (): ShareInfo => {
    const address = getLanAddress()
    return {
      url: `http://${address}:${serverAddress.port}/${token}`,
      address,
      port: serverAddress.port,
    }
  }

  return {
    getInfo,
    rotateToken: () => {
      token = randomBytes(18).toString('base64url')
      return getInfo()
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}