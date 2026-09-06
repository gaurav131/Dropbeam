import assert from 'node:assert/strict'
import { once } from 'node:events'
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  startShareServer,
  type SharedFileRecord,
  type ShareServer,
} from '../src/main/share-server.ts'

function loopbackUrl(server: ShareServer): string {
  const url = new URL(server.getInfo().url)
  url.hostname = '127.0.0.1'
  return url.toString().replace(/\/$/, '')
}

async function createRecord(
  path: string,
  file: SharedFileRecord['file'],
): Promise<SharedFileRecord> {
  const fileStat = await lstat(path)
  return { path, device: fileStat.dev, inode: fileStat.ino, file }
}

async function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const clientRequest = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    clientRequest.once('error', reject)
    clientRequest.end()
  })
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await check()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for the expected server state.')
}

async function startPartialUpload(
  port: number,
  tokenPath: string,
  name: string,
): Promise<Socket> {
  const socket = createConnection({ host: '127.0.0.1', port })
  await once(socket, 'connect')
  socket.write(
    `POST ${tokenPath}/upload?name=${encodeURIComponent(name)} HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${port}\r\n` +
    'Content-Type: application/octet-stream\r\n' +
    'Content-Length: 10\r\n' +
    'Connection: close\r\n\r\n' +
    'x',
  )
  return socket
}

test('serves pages and complete, partial, and HEAD downloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dropbeam-'))
  const filePath = join(directory, 'hello nearby.txt')
  const contents = 'hello local network'
  const id = '11111111-1111-4111-8111-111111111111'
  await writeFile(filePath, contents)

  const records: SharedFileRecord[] = [
    await createRecord(filePath, {
        id,
        name: 'hello nearby.txt',
        extension: 'txt',
        size: Buffer.byteLength(contents),
      }),
  ]
  const server = await startShareServer(() => records)

  try {
    const baseUrl = loopbackUrl(server)
    const pageResponse = await fetch(baseUrl)
    assert.equal(pageResponse.status, 200)
    const pageBody = await pageResponse.text()
    assert.match(pageBody, /hello nearby\.txt/)
    assert.equal(pageResponse.headers.get('cache-control'), 'no-store')
    assert.equal(pageResponse.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(pageResponse.headers.get('x-content-type-options'), 'nosniff')

    const headPageResponse = await fetch(baseUrl, { method: 'HEAD' })
    assert.equal(headPageResponse.status, 200)
    assert.equal(
      headPageResponse.headers.get('content-length'),
      String(Buffer.byteLength(pageBody)),
    )
    assert.equal(await headPageResponse.text(), '')

    const downloadUrl = `${baseUrl}/download/${id}`
    const downloadResponse = await fetch(downloadUrl)
    assert.equal(downloadResponse.status, 200)
    assert.equal(await downloadResponse.text(), contents)
    assert.match(downloadResponse.headers.get('content-disposition') ?? '', /attachment/)
    assert.match(downloadResponse.headers.get('content-type') ?? '', /text\/plain/)

    const headDownloadResponse = await fetch(downloadUrl, { method: 'HEAD' })
    assert.equal(headDownloadResponse.status, 200)
    assert.equal(headDownloadResponse.headers.get('content-length'), '19')
    assert.equal(await headDownloadResponse.text(), '')

    const rangeResponse = await fetch(downloadUrl, {
      headers: { Range: 'bytes=6-10' },
    })
    assert.equal(rangeResponse.status, 206)
    assert.equal(await rangeResponse.text(), 'local')
    assert.equal(rangeResponse.headers.get('content-range'), 'bytes 6-10/19')

    const invalidRangeResponse = await fetch(downloadUrl, {
      headers: { Range: 'bytes=20-30' },
    })
    assert.equal(invalidRangeResponse.status, 416)
    assert.equal(invalidRangeResponse.headers.get('content-range'), 'bytes */19')

    const malformedRangeResponse = await fetch(downloadUrl, {
      headers: { Range: 'bytes=-5' },
    })
    assert.equal(malformedRangeResponse.status, 416)
    assert.equal(malformedRangeResponse.headers.get('content-range'), 'bytes */19')

    assert.equal((await fetch(baseUrl, { method: 'POST' })).status, 404)
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('accepts uploads, sanitizes names, and preserves existing files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dropbeam-upload-'))
  const received: string[] = []
  await writeFile(join(directory, 'notes.txt'), 'existing')
  const server = await startShareServer(() => [], {
    uploadDirectory: directory,
    onUpload: (file) => received.push(file.name),
  })

  try {
    const baseUrl = loopbackUrl(server)
    const pageResponse = await fetch(baseUrl)
    const pageBody = await pageResponse.text()
    assert.match(pageBody, /Send files to this Mac/)
    assert.match(pageBody, /id="photo-input" type="file" accept="image\/\*" multiple/)
    assert.doesNotMatch(pageBody, /capture=/)
    assert.match(pageResponse.headers.get('content-security-policy') ?? '', /connect-src 'self'/)

    const uploadResponse = await fetch(`${baseUrl}/upload?name=${encodeURIComponent('../notes.txt')}`, {
      method: 'POST',
      body: 'sent nearby',
    })
    assert.equal(uploadResponse.status, 201)
    assert.deepEqual(await uploadResponse.json(), { name: '..-notes.txt', size: 11 })
    assert.equal(await readFile(join(directory, '..-notes.txt'), 'utf8'), 'sent nearby')

    const collisionResponse = await fetch(`${baseUrl}/upload?name=notes.txt`, {
      method: 'POST',
      body: 'new notes',
    })
    assert.equal(collisionResponse.status, 201)
    assert.equal(await readFile(join(directory, 'notes.txt'), 'utf8'), 'existing')
    assert.equal(await readFile(join(directory, 'notes (1).txt'), 'utf8'), 'new notes')
    assert.deepEqual(received, ['..-notes.txt', 'notes (1).txt'])

    const missingName = await fetch(`${baseUrl}/upload`, { method: 'POST', body: 'nope' })
    assert.equal(missingName.status, 400)
    assert.deepEqual((await readdir(directory)).sort(), ['..-notes.txt', 'notes (1).txt', 'notes.txt'])
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('enforces upload length, session quota, and preserves saved files after notification failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dropbeam-upload-limits-'))
  const server = await startShareServer(() => [], {
    uploadDirectory: directory,
    maxSessionUploadBytes: 5,
    minFreeDiskBytes: 0,
    onUpload: () => { throw new Error('renderer unavailable') },
  })

  try {
    const baseUrl = loopbackUrl(server)
    const tokenPath = new URL(baseUrl).pathname
    const missingLength = await rawRequest(server.getInfo().port, `${tokenPath}/upload?name=missing.txt`, {
      'Transfer-Encoding': 'chunked',
    })
    assert.equal(missingLength.status, 411)

    const oversized = await rawRequest(server.getInfo().port, `${tokenPath}/upload?name=large.bin`, {
      'Content-Length': String(2 * 1024 * 1024 * 1024 + 1),
    })
    assert.equal(oversized.status, 413)

    const saved = await fetch(`${baseUrl}/upload?name=saved.txt`, { method: 'POST', body: '12345' })
    assert.equal(saved.status, 201)
    assert.equal(await readFile(join(directory, 'saved.txt'), 'utf8'), '12345')

    const quotaExceeded = await fetch(`${baseUrl}/upload?name=extra.txt`, { method: 'POST', body: '1' })
    assert.equal(quotaExceeded.status, 413)
    assert.match(await quotaExceeded.text(), /session.*limit/i)
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects uploads while receiving is paused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dropbeam-upload-paused-'))
  let enabled = true
  const server = await startShareServer(() => [], {
    uploadDirectory: directory,
    isUploadEnabled: () => enabled,
  })

  try {
    const baseUrl = loopbackUrl(server)
    assert.match(await (await fetch(baseUrl)).text(), /Choose photos/)

    enabled = false
    assert.doesNotMatch(await (await fetch(baseUrl)).text(), /Choose photos/)
    const response = await fetch(`${baseUrl}/upload?name=blocked.txt`, {
      method: 'POST',
      body: 'blocked',
    })
    assert.equal(response.status, 403)
    assert.deepEqual(await readdir(directory), [])
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects uploads without disk reserve', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dropbeam-upload-disk-'))
  const server = await startShareServer(() => [], {
    uploadDirectory: directory,
    minFreeDiskBytes: Number.MAX_SAFE_INTEGER,
  })

  try {
    const response = await fetch(`${loopbackUrl(server)}/upload?name=no-space.txt`, {
      method: 'POST',
      body: 'data',
    })
    assert.equal(response.status, 507)
    assert.deepEqual(await readdir(directory), [])
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('limits concurrent uploads and removes files from aborted requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dropbeam-upload-concurrency-'))
  const server = await startShareServer(() => [], {
    uploadDirectory: directory,
    minFreeDiskBytes: 0,
  })
  const sockets: Socket[] = []

  try {
    const baseUrl = loopbackUrl(server)
    const tokenPath = new URL(baseUrl).pathname
    const partialNames = ['partial-1.bin', 'partial-2.bin', 'partial-3.bin', 'partial-4.bin']
    for (const name of partialNames) {
      sockets.push(await startPartialUpload(server.getInfo().port, tokenPath, name))
    }
    await waitFor(async () => (await readdir(directory)).length === partialNames.length)

    const limited = await fetch(`${baseUrl}/upload?name=limited.bin`, {
      method: 'POST',
      body: 'blocked',
    })
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get('retry-after'), '2')

    for (const socket of sockets) socket.destroy()
    await waitFor(async () => (await readdir(directory)).length === 0)
  } finally {
    for (const socket of sockets) socket.destroy()
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('serves zero-byte files and safely renders unusual names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dropbeam-'))
  const name = 'empty <report> 🎉.txt'
  const filePath = join(directory, name)
  const id = '22222222-2222-4222-8222-222222222222'
  await writeFile(filePath, '')
  const record = await createRecord(filePath, {
    id,
    name,
    extension: 'txt',
    size: 0,
  })
  const server = await startShareServer(() => [record])

  try {
    const baseUrl = loopbackUrl(server)
    const pageBody = await (await fetch(baseUrl)).text()
    assert.match(pageBody, /empty &lt;report&gt; 🎉\.txt/)
    assert.doesNotMatch(pageBody, /<report>/)

    const response = await fetch(`${baseUrl}/download/${id}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-length'), '0')
    assert.equal(await response.text(), '')
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('rotating the token immediately revokes the previous link', async () => {
  const server = await startShareServer(() => [])
  try {
    const oldUrl = loopbackUrl(server)
    assert.equal((await fetch(oldUrl)).status, 200)

    server.rotateToken()
    const newUrl = loopbackUrl(server)
    assert.notEqual(newUrl, oldUrl)
    assert.equal((await fetch(oldUrl)).status, 404)
    assert.equal((await fetch(newUrl)).status, 200)
  } finally {
    await server.close()
  }
})

test('returns 404 when a selected file disappears', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dropbeam-'))
  const filePath = join(directory, 'temporary.txt')
  const id = '33333333-3333-4333-8333-333333333333'
  await writeFile(filePath, 'temporary')
  const record = await createRecord(filePath, {
    id,
    name: 'temporary.txt',
    extension: 'txt',
    size: 9,
  })
  const server = await startShareServer(() => [record])

  try {
    await rm(filePath)
    assert.equal((await fetch(`${loopbackUrl(server)}/download/${id}`)).status, 404)
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects malformed request targets without terminating the server', async () => {
  const server = await startShareServer(() => [])
  try {
    const response = await fetch(`http://127.0.0.1:${server.getInfo().port}`, {
      headers: { Host: '[' },
    })
    assert.equal(response.status, 404)

    const net = await import('node:net')
    const rawResponse = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(
        { host: '127.0.0.1', port: server.getInfo().port },
        () => socket.end('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'),
      )
      let data = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => { data += chunk })
      socket.once('end', () => resolve(data))
      socket.once('error', reject)
    })
    assert.match(rawResponse, /^HTTP\/1\.1 400 Bad Request/)
    assert.equal((await fetch(loopbackUrl(server))).status, 200)
  } finally {
    await server.close()
  }
})

test('refuses a selected path that is replaced by another file or symlink', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dropbeam-identity-'))
  const filePath = join(directory, 'shared.txt')
  const replacementPath = join(directory, 'replacement.txt')
  const secretPath = join(directory, 'secret.txt')
  const id = '44444444-4444-4444-8444-444444444444'
  await Promise.all([
    writeFile(filePath, 'original'),
    writeFile(replacementPath, 'replacement'),
    writeFile(secretPath, 'secret'),
  ])
  const record = await createRecord(filePath, {
    id,
    name: 'shared.txt',
    extension: 'txt',
    size: 8,
  })
  const server = await startShareServer(() => [record])

  try {
    await rm(filePath)
    await writeFile(filePath, 'different inode')
    assert.equal((await fetch(`${loopbackUrl(server)}/download/${id}`)).status, 404)

    await rm(filePath)
    await symlink(secretPath, filePath)
    assert.equal((await fetch(`${loopbackUrl(server)}/download/${id}`)).status, 404)
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})