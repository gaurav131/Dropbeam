import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { parse } from 'node:path'
import type { ReceivedFile, ShareState, SharedFile } from '../shared/contracts.js'
import type { ReceivedFileRecord, SharedFileRecord, ShareServer } from './share-server.js'

const DEFAULT_MAX_FILES = 200
const STAT_BATCH_SIZE = 16

type ReceivedRecord = {
  path: string
  file: ReceivedFile
}

export class ShareSession {
  readonly #records = new Map<string, SharedFileRecord>()
  readonly #receivedRecords = new Map<string, ReceivedRecord>()
  readonly #server: Pick<ShareServer, 'getInfo' | 'rotateToken'>
  readonly #maxFiles: number
  #mutationQueue: Promise<void> = Promise.resolve()
  #receivingEnabled = true

  constructor(
    server: Pick<ShareServer, 'getInfo' | 'rotateToken'>,
    maxFiles = DEFAULT_MAX_FILES,
  ) {
    this.#server = server
    this.#maxFiles = maxFiles
  }

  getRecords(): SharedFileRecord[] {
    return [...this.#records.values()]
  }

  getState(): ShareState {
    const files = this.getRecords().map(({ file }) => file)
    return {
      files,
      receivedFiles: [...this.#receivedRecords.values()].map(({ file }) => file),
      receivingEnabled: this.#receivingEnabled,
      share: files.length > 0 || this.#receivingEnabled
        ? this.#server.getInfo()
        : { ...this.#server.getInfo(), url: '' },
    }
  }

  isReceivingEnabled(): boolean {
    return this.#receivingEnabled
  }

  setReceivingEnabled(enabled: boolean): Promise<ShareState> {
    return this.#mutate(() => {
      if (enabled === this.#receivingEnabled) return this.getState()
      this.#receivingEnabled = enabled
      this.#server.rotateToken()
      return this.getState()
    })
  }

  recordReceived(record: ReceivedFileRecord): Promise<ShareState> {
    return this.#mutate(() => {
      const pathParts = parse(record.name)
      const file: ReceivedFile = {
        id: randomUUID(),
        name: record.name,
        extension: pathParts.ext.slice(1).toLowerCase(),
        size: record.size,
        receivedAt: record.receivedAt,
      }
      this.#receivedRecords.set(file.id, { path: record.path, file })
      while (this.#receivedRecords.size > this.#maxFiles) {
        const oldestId = this.#receivedRecords.keys().next().value
        if (typeof oldestId === 'string') this.#receivedRecords.delete(oldestId)
      }
      return this.getState()
    })
  }

  getReceivedPath(id: string): string | undefined {
    return this.#receivedRecords.get(id)?.path
  }

  clearReceived(): Promise<ShareState> {
    return this.#mutate(() => {
      this.#receivedRecords.clear()
      return this.getState()
    })
  }

  addPaths(paths: string[]): Promise<ShareState> {
    return this.#mutate(async () => {
      if (paths.length > this.#maxFiles) {
        throw new Error(`Dropbeam can share up to ${this.#maxFiles} files at once.`)
      }

      const existingPaths = new Set(
        this.getRecords().map((record) => record.path),
      )
      const uniquePaths = [...new Set(paths)].filter(
        (filePath) => filePath && !existingPaths.has(filePath),
      )

      if (this.#records.size + uniquePaths.length > this.#maxFiles) {
        throw new Error(`Dropbeam can share up to ${this.#maxFiles} files at once.`)
      }

      const records: SharedFileRecord[] = []
      for (let index = 0; index < uniquePaths.length; index += STAT_BATCH_SIZE) {
        const batch = uniquePaths.slice(index, index + STAT_BATCH_SIZE)
        const inspected = await Promise.all(
          batch.map(async (filePath): Promise<SharedFileRecord | undefined> => {
            try {
              const fileStat = await lstat(filePath)
              if (!fileStat.isFile() || fileStat.isSymbolicLink()) return undefined

              const pathParts = parse(filePath)
              const file: SharedFile = {
                id: randomUUID(),
                name: pathParts.base,
                extension: pathParts.ext.slice(1).toLowerCase(),
                size: fileStat.size,
              }
              return {
                path: filePath,
                device: fileStat.dev,
                inode: fileStat.ino,
                file,
              }
            } catch {
              return undefined
            }
          }),
        )
        records.push(
          ...inspected.filter(
            (record): record is SharedFileRecord => record !== undefined,
          ),
        )
      }

      for (const record of records) this.#records.set(record.file.id, record)
      return this.#finishMutation(records.length > 0)
    })
  }

  remove(id: string): Promise<ShareState> {
    return this.#mutate(() => this.#finishMutation(this.#records.delete(id)))
  }

  clear(): Promise<ShareState> {
    return this.#mutate(() => {
      const changed = this.#records.size > 0
      this.#records.clear()
      return this.#finishMutation(changed)
    })
  }

  refreshAddress(): Promise<ShareState> {
    return this.#mutate(() => {
      this.#server.rotateToken()
      return this.getState()
    })
  }

  #finishMutation(changed: boolean): ShareState {
    if (changed) this.#server.rotateToken()
    return this.getState()
  }

  #mutate(operation: () => ShareState | Promise<ShareState>): Promise<ShareState> {
    const result = this.#mutationQueue.then(operation, operation)
    this.#mutationQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}