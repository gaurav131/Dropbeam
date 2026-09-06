import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ShareInfo } from '../src/shared/contracts.ts'
import { ShareSession } from '../src/main/share-session.ts'

function createEndpoint() {
  let token = 0
  const getInfo = (): ShareInfo => ({
    url: `http://127.0.0.1:4321/${token}`,
    address: '127.0.0.1',
    port: 4321,
  })
  return {
    getInfo,
    rotateToken: () => {
      token += 1
      return getInfo()
    },
  }
}

test('hydrates state and rotates the link for every file-set change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dropbeam-session-'))
  const firstPath = join(directory, 'first.txt')
  const secondPath = join(directory, 'second.txt')
  await Promise.all([
    writeFile(firstPath, 'first'),
    writeFile(secondPath, 'second'),
  ])
  const session = new ShareSession(createEndpoint())

  try {
    assert.deepEqual(session.getState().files, [])
    assert.deepEqual(session.getState().receivedFiles, [])
    assert.equal(session.getState().receivingEnabled, true)
    assert.match(session.getState().share.url, /\/0$/)

    const receiveOnlyRefresh = await session.refreshAddress()
    assert.match(receiveOnlyRefresh.share.url, /\/1$/)

    const firstState = await session.addPaths([firstPath])
    assert.equal(firstState.files.length, 1)
    assert.match(firstState.share.url, /\/2$/)
    assert.deepEqual(session.getState(), firstState)

    const duplicateState = await session.addPaths([firstPath])
    assert.equal(duplicateState.share.url, firstState.share.url)

    const secondState = await session.addPaths([secondPath])
    assert.equal(secondState.files.length, 2)
    assert.match(secondState.share.url, /\/3$/)

    const refreshedState = await session.refreshAddress()
    assert.match(refreshedState.share.url, /\/4$/)

    const removedState = await session.remove(firstState.files[0].id)
    assert.equal(removedState.files.length, 1)
    assert.match(removedState.share.url, /\/5$/)

    const clearedState = await session.clear()
    assert.deepEqual(clearedState.files, [])
    assert.match(clearedState.share.url, /\/6$/)
    assert.equal(session.getRecords().length, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('serializes concurrent mutations and enforces the file limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dropbeam-session-'))
  const firstPath = join(directory, 'first.txt')
  const secondPath = join(directory, 'second.txt')
  await Promise.all([
    writeFile(firstPath, 'first'),
    writeFile(secondPath, 'second'),
  ])
  const session = new ShareSession(createEndpoint(), 1)

  try {
    await assert.rejects(
      session.addPaths([firstPath, secondPath]),
      /up to 1 files/,
    )
    assert.equal(session.getState().files.length, 0)

    const addPromise = session.addPaths([firstPath])
    const clearPromise = session.clear()
    await Promise.all([addPromise, clearPromise])
    assert.equal(session.getState().files.length, 0)
    assert.match(session.getState().share.url, /\/2$/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects symbolic links', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dropbeam-session-'))
  const targetPath = join(directory, 'target.txt')
  const linkPath = join(directory, 'link.txt')
  await writeFile(targetPath, 'private')
  await symlink(targetPath, linkPath)
  const session = new ShareSession(createEndpoint())

  try {
    const state = await session.addPaths([linkPath])
    assert.equal(state.files.length, 0)
    assert.match(state.share.url, /\/0$/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('tracks received files without exposing their paths', async () => {
  const session = new ShareSession(createEndpoint())
  const receivedAt = new Date().toISOString()
  const state = await session.recordReceived({
    path: '/Users/test/Downloads/Dropbeam/photo.jpg',
    name: 'photo.jpg',
    size: 42,
    receivedAt,
  })

  assert.equal(state.receivedFiles.length, 1)
  assert.deepEqual(state.receivedFiles[0], {
    id: state.receivedFiles[0].id,
    name: 'photo.jpg',
    extension: 'jpg',
    size: 42,
    receivedAt,
  })
  assert.equal(session.getReceivedPath(state.receivedFiles[0].id), '/Users/test/Downloads/Dropbeam/photo.jpg')

  const cleared = await session.clearReceived()
  assert.deepEqual(cleared.receivedFiles, [])
  assert.equal(session.getReceivedPath(state.receivedFiles[0].id), undefined)
})

test('pauses receiving, revokes its link, and preserves outbound downloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dropbeam-session-'))
  const filePath = join(directory, 'shared.txt')
  await writeFile(filePath, 'shared')
  const session = new ShareSession(createEndpoint())

  try {
    const paused = await session.setReceivingEnabled(false)
    assert.equal(paused.receivingEnabled, false)
    assert.equal(paused.share.url, '')

    const unchanged = await session.setReceivingEnabled(false)
    assert.equal(unchanged.share.url, '')

    const sharingWhilePaused = await session.addPaths([filePath])
    assert.equal(sharingWhilePaused.receivingEnabled, false)
    assert.match(sharingWhilePaused.share.url, /\/2$/)

    const resumed = await session.setReceivingEnabled(true)
    assert.equal(resumed.receivingEnabled, true)
    assert.match(resumed.share.url, /\/3$/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})