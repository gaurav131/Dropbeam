import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { IpcMainInvokeEvent } from 'electron'
import type { ShareInfo, ShareState } from '../src/shared/contracts.ts'
import {
  registerIpcHandlers,
  type IpcHandler,
  type IpcRegistrar,
} from '../src/main/ipc-handlers.ts'
import { ShareSession } from '../src/main/share-session.ts'

const trustedEvent = {
  senderFrame: { url: 'file:///Applications/Dropbeam/index.html' },
} as IpcMainInvokeEvent

function createSession(): ShareSession {
  let token = 0
  const getInfo = (): ShareInfo => ({
    url: `http://127.0.0.1:4321/${token}`,
    address: '127.0.0.1',
    port: 4321,
  })
  return new ShareSession({
    getInfo,
    rotateToken: () => {
      token += 1
      return getInfo()
    },
  })
}

test('IPC handlers select, hydrate, copy, and revoke a share', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dropbeam-ipc-'))
  const filePath = join(directory, 'shared.txt')
  await writeFile(filePath, 'shared')
  const handlers = new Map<string, IpcHandler>()
  const copied: string[] = []
  const revealed: string[] = []
  const published: ShareState[] = []
  const session = createSession()
  const ipc: IpcRegistrar = {
    handle: (channel, handler) => {
      handlers.set(channel, handler)
    },
  }

  registerIpcHandlers({
    ipc,
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [filePath] }),
    },
    clipboard: { writeText: (text) => copied.push(text) },
    shell: { showItemInFolder: (path) => revealed.push(path) },
    getSession: () => session,
    publishState: (state = session.getState()) => {
      published.push(state)
      return state
    },
    rendererUrl: trustedEvent.senderFrame?.url ?? '',
  })

  try {
    const selectState = await handlers.get('files:select')?.(trustedEvent) as ShareState
    assert.equal(selectState.files.length, 1)
    assert.match(selectState.share.url, /\/1$/)
    assert.deepEqual(
      handlers.get('share:get-state')?.(trustedEvent),
      selectState,
    )

    assert.equal(handlers.get('share:copy-link')?.(trustedEvent), true)
    assert.deepEqual(copied, [selectState.share.url])

    const receivedState = await session.recordReceived({
      path: join(directory, 'received.txt'),
      name: 'received.txt',
      size: 12,
      receivedAt: new Date().toISOString(),
    })
    const receivedId = receivedState.receivedFiles[0].id
    assert.equal(handlers.get('received:reveal')?.(trustedEvent, receivedId), true)
    assert.deepEqual(revealed, [join(directory, 'received.txt')])
    assert.equal(handlers.get('received:reveal')?.(trustedEvent, 'missing'), false)
    const clearedReceivedState = await handlers.get('received:clear')?.(trustedEvent) as ShareState
    assert.deepEqual(clearedReceivedState.receivedFiles, [])

    const pausedState = await handlers.get('received:set-enabled')?.(trustedEvent, false) as ShareState
    assert.equal(pausedState.receivingEnabled, false)

    const clearState = await handlers.get('files:clear')?.(trustedEvent) as ShareState
    assert.equal(clearState.files.length, 0)
    assert.equal(clearState.share.url, '')
    assert.equal(handlers.get('share:copy-link')?.(trustedEvent), false)
    assert.equal(published.length, 4)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('IPC handlers reject untrusted senders and malformed dropped paths', async () => {
  const handlers = new Map<string, IpcHandler>()
  const session = createSession()
  registerIpcHandlers({
    ipc: {
      handle: (channel, handler) => handlers.set(channel, handler),
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    clipboard: { writeText: () => undefined },
    shell: { showItemInFolder: () => undefined },
    getSession: () => session,
    publishState: (state = session.getState()) => state,
    rendererUrl: trustedEvent.senderFrame?.url ?? '',
  })

  const untrustedEvent = {
    senderFrame: { url: 'https://attacker.example/' },
  } as IpcMainInvokeEvent
  assert.throws(
    () => handlers.get('share:get-state')?.(untrustedEvent),
    /Untrusted IPC sender/,
  )
  await assert.rejects(
    Promise.resolve(
      handlers.get('files:add-paths')?.(trustedEvent, ['valid', 42]),
    ),
    /array of paths/,
  )
  await assert.rejects(
    Promise.resolve(handlers.get('received:set-enabled')?.(trustedEvent, 'yes')),
    /must be a boolean/,
  )
})