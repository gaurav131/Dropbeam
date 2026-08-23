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
    assert.equal(session.getState().share.url, '')

    const firstState = await session.addPaths([firstPath])
    assert.equal(firstState.files.length, 1)
    assert.match(firstState.share.url, /\/1$/)
    assert.deepEqual(session.getState(), firstState)

    const duplicateState = await session.addPaths([firstPath])
    assert.equal(duplicateState.share.url, firstState.share.url)

    const secondState = await session.addPaths([secondPath])
    assert.equal(secondState.files.length, 2)
    assert.match(secondState.share.url, /\/2$/)

    const refreshedState = await session.refreshAddress()
    assert.match(refreshedState.share.url, /\/3$/)

    const removedState = await session.remove(firstState.files[0].id)
    assert.equal(removedState.files.length, 1)
    assert.match(removedState.share.url, /\/4$/)

    const clearedState = await session.clear()
    assert.deepEqual(clearedState.files, [])
    assert.equal(clearedState.share.url, '')
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
    assert.equal(session.getState().share.url, '')
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
    assert.equal(state.share.url, '')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})