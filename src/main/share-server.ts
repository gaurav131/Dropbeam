import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rm, statfs } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { extname, join, parse } from 'node:path'
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
const MAX_CONCURRENT_UPLOADS = 4
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
export const MAX_SESSION_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024
const MIN_FREE_DISK_BYTES = 512 * 1024 * 1024

export type ReceivedFileRecord = {
  path: string
  name: string
  size: number
  receivedAt: string
}

type ShareServerOptions = {
  uploadDirectory?: string
  onUpload?: (file: ReceivedFileRecord) => void | Promise<void>
  isUploadEnabled?: () => boolean
  maxSessionUploadBytes?: number
  minFreeDiskBytes?: number
}

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

function renderDownloadPage(
  token: string,
  files: SharedFileRecord[],
  uploadsEnabled: boolean,
  scriptNonce: string,
): string {
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

  const uploadPanel = uploadsEnabled
    ? `<section class="upload-panel">
      <div><h2>Send files to this Mac</h2><p>Choose files from this device. They save directly to the Mac.</p></div>
      <div class="upload-actions">
        <label class="upload-action photo-action" for="photo-input">
          <span>Choose photos</span>
          <input class="upload-input" id="photo-input" type="file" accept="image/*" multiple>
        </label>
        <label class="upload-action" for="file-input">
          <span>Choose files</span>
          <input class="upload-input" id="file-input" type="file" multiple>
        </label>
      </div>
      <p id="upload-status" class="upload-status" role="status" aria-live="polite"></p>
    </section>`
    : ''
  const uploadScript = uploadsEnabled
    ? `<script nonce="${scriptNonce}">
      const inputs = Array.from(document.querySelectorAll('.upload-input'));
      const status = document.getElementById('upload-status');
      const setInputsDisabled = (disabled) => {
        inputs.forEach((item) => {
          item.disabled = disabled;
          const action = item.closest('.upload-action');
          action.classList.toggle('is-disabled', disabled);
          action.setAttribute('aria-disabled', String(disabled));
        });
      };
      const uploadSelected = async (input) => {
        const files = Array.from(input.files || []);
        if (!files.length) return;
        setInputsDisabled(true);
        let sent = 0;
        for (const file of files) {
          status.textContent = 'Sending ' + file.name + ' (' + (sent + 1) + ' of ' + files.length + ')...';
          try {
            const response = await fetch('/${token}/upload?name=' + encodeURIComponent(file.name), {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: file,
            });
            if (!response.ok) throw new Error(await response.text() || 'Upload failed');
            sent += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Upload failed';
            status.textContent = 'Could not send ' + file.name + ': ' + message;
            setInputsDisabled(false);
            return;
          }
        }
        status.textContent = sent + (sent === 1 ? ' file sent.' : ' files sent.');
        input.value = '';
        setInputsDisabled(false);
      };
      inputs.forEach((input) => {
        input.addEventListener('change', () => uploadSelected(input));
      });
    </script>`
    : ''

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
    .upload-panel { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px 18px; margin-top: 18px; padding: 20px; border: 1px solid #d7ddd3; border-radius: 8px; background: white; }
    .upload-panel h2 { margin: 0; color: #17211e; font-size: 18px; }
    .upload-panel p { margin: 4px 0 0; color: #7c8882; font-size: 13px; }
    .upload-actions { display: flex; align-items: center; gap: 8px; }
    .upload-action { position: relative; min-height: 44px; display: inline-flex; align-items: center; padding: 9px 15px; border-radius: 6px; color: #163c35; background: #d8ec73; font-size: 12px; font-weight: 700; cursor: pointer; }
    .upload-action.photo-action { color: white; background: #e35635; }
    .upload-action:focus-within { outline: 3px solid #163c35; outline-offset: 3px; }
    .upload-action.is-disabled { opacity: .55; cursor: wait; pointer-events: none; }
    .upload-input { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .upload-status { grid-column: 1 / -1; min-height: 18px; color: #315e50 !important; font-weight: 600; }
    footer { padding: 24px 0; color: #7c8882; font-size: 12px; text-align: center; }
    @media (max-width: 520px) { .upload-panel { grid-template-columns: 1fr; } .upload-actions { display: grid; grid-template-columns: 1fr 1fr; } .upload-action { justify-content: center; } }
  </style>
</head>
<body>
  <header><div class="wrap">
    <div class="brand"><span class="brand-mark">DB</span> Dropbeam</div>
    <h1>Share files nearby.</h1>
    <p>Download from this Mac or send files back to it.</p>
  </div></header>
  <main>
    <div class="summary" role="region" aria-label="File summary"><span>${files.length} ${files.length === 1 ? 'file' : 'files'}</span><span>${formatBytes(totalSize)}</span></div>
    <ul>${fileRows}</ul>
    ${uploadPanel}
    <footer>No cloud upload. Use this link only on a trusted local network.</footer>
  </main>
  ${uploadScript}
</body>
</html>`
}

function sanitizeUploadName(value: string): string | undefined {
  const withoutControls = [...value]
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
    .join('')
  const cleaned = withoutControls
    .replace(/[\\/]/g, '-')
    .trim()
  let name = ''
  for (const character of cleaned) {
    if (Buffer.byteLength(name + character) > 200) break
    name += character
  }
  return name && name !== '.' && name !== '..' ? name : undefined
}

async function createUploadTarget(
  directory: string,
  requestedName: string,
): Promise<{ fileHandle: Awaited<ReturnType<typeof open>>; path: string; name: string }> {
  await mkdir(directory, { recursive: true })
  const { name, ext } = parse(requestedName)

  for (let index = 0; index < 10_000; index += 1) {
    const fileName = index === 0 ? requestedName : `${name} (${index})${ext}`
    const path = join(directory, fileName)
    try {
      return { fileHandle: await open(path, 'wx'), path, name: fileName }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }

  throw new Error('Could not create a unique file name.')
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
  options: ShareServerOptions = {},
): Promise<ShareServer> {
  let token = randomBytes(18).toString('base64url')
  let activeDownloads = 0
  let activeUploads = 0
  let completedUploadBytes = 0
  let reservedUploadBytes = 0
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
    const uploadsEnabled = Boolean(options.uploadDirectory) && (options.isUploadEnabled?.() ?? true)

    if ((method === 'GET' || method === 'HEAD') && (requestUrl.pathname === pagePath || requestUrl.pathname === `${pagePath}/`)) {
      const scriptNonce = randomBytes(18).toString('base64url')
      const body = renderDownloadPage(token, files, uploadsEnabled, scriptNonce)
      sendHeaders(response, 200, {
        'Content-Length': String(Buffer.byteLength(body)),
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'`,
      })
      response.end(method === 'HEAD' ? undefined : body)
      return
    }

    if (method === 'POST' && requestUrl.pathname === `${pagePath}/upload` && options.uploadDirectory) {
      if (!uploadsEnabled) {
        sendHeaders(response, 403, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('Receiving is paused on this Mac.')
        return
      }

      const requestedName = sanitizeUploadName(requestUrl.searchParams.get('name') ?? '')
      const contentLength = Number(request.headers['content-length'])

      if (!requestedName) {
        sendHeaders(response, 400, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('A valid file name is required.')
        return
      }
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        sendHeaders(response, 411, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('A valid Content-Length header is required.')
        return
      }
      if (contentLength > MAX_UPLOAD_BYTES) {
        sendHeaders(response, 413, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end(`Files must be ${formatBytes(MAX_UPLOAD_BYTES)} or smaller.`)
        return
      }
      const sessionUploadLimit = options.maxSessionUploadBytes ?? MAX_SESSION_UPLOAD_BYTES
      if (completedUploadBytes + reservedUploadBytes + contentLength > sessionUploadLimit) {
        sendHeaders(response, 413, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('This receiving session has reached its upload limit.')
        return
      }
      if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
        sendHeaders(response, 429, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Retry-After': '2',
        })
        response.end('Too many simultaneous uploads.')
        return
      }

      activeUploads += 1
      reservedUploadBytes += contentLength
      let target: Awaited<ReturnType<typeof createUploadTarget>> | undefined
      try {
        await mkdir(options.uploadDirectory, { recursive: true })
        const fileSystem = await statfs(options.uploadDirectory)
        const availableBytes = fileSystem.bavail * fileSystem.bsize
        const minimumFreeBytes = options.minFreeDiskBytes ?? MIN_FREE_DISK_BYTES
        if (availableBytes < reservedUploadBytes + minimumFreeBytes) {
          sendHeaders(response, 507, { 'Content-Type': 'text/plain; charset=utf-8' })
          response.end('There is not enough free disk space to receive this file.')
          return
        }

        target = await createUploadTarget(options.uploadDirectory, requestedName)
        let receivedBytes = 0
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          receivedBytes += buffer.length
          if (receivedBytes > contentLength || receivedBytes > MAX_UPLOAD_BYTES) {
            throw new Error('Upload exceeded its declared size.')
          }
          let offset = 0
          while (offset < buffer.length) {
            const { bytesWritten } = await target.fileHandle.write(
              buffer,
              offset,
              buffer.length - offset,
            )
            if (bytesWritten === 0) throw new Error('Upload could not be written.')
            offset += bytesWritten
          }
        }
        if (receivedBytes !== contentLength) throw new Error('Upload was incomplete.')
        await target.fileHandle.close()
        completedUploadBytes += receivedBytes

        const receivedFile: ReceivedFileRecord = {
          path: target.path,
          name: target.name,
          size: receivedBytes,
          receivedAt: new Date().toISOString(),
        }
        try {
          await options.onUpload?.(receivedFile)
        } catch (error) {
          console.error('Dropbeam saved an upload but could not publish it.', error)
        }
        sendHeaders(response, 201, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ name: receivedFile.name, size: receivedFile.size }))
      } catch {
        await target?.fileHandle.close().catch(() => undefined)
        if (target) await rm(target.path, { force: true }).catch(() => undefined)
        if (!response.headersSent) {
          sendHeaders(response, 400, { 'Content-Type': 'text/plain; charset=utf-8' })
          response.end('The upload could not be saved.')
        }
      } finally {
        activeUploads -= 1
        reservedUploadBytes -= contentLength
      }
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
  server.requestTimeout = 15 * 60_000
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