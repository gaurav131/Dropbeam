import type { IpcMainInvokeEvent, OpenDialogOptions, OpenDialogReturnValue } from 'electron'
import type { ShareState } from '../shared/contracts.js'
import type { ShareSession } from './share-session.js'

export type IpcHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown

export type IpcRegistrar = {
  handle: (channel: string, listener: IpcHandler) => void
}

type DialogAdapter = {
  showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>
}

type ClipboardAdapter = {
  writeText: (text: string) => void
}

type RegisterIpcHandlersOptions = {
  ipc: IpcRegistrar
  dialog: DialogAdapter
  clipboard: ClipboardAdapter
  getSession: () => ShareSession | undefined
  publishState: (state?: ShareState) => ShareState
  rendererUrl: string
}

function assertTrustedSender(
  event: IpcMainInvokeEvent,
  rendererUrl: string,
): void {
  let sender: URL
  let renderer: URL
  try {
    sender = new URL(event.senderFrame?.url ?? '')
    renderer = new URL(rendererUrl)
  } catch {
    throw new Error('Untrusted IPC sender.')
  }

  const trusted = renderer.protocol === 'file:'
    ? sender.href === renderer.href
    : sender.origin === renderer.origin

  if (!trusted) throw new Error('Untrusted IPC sender.')
}

function requireSession(getSession: () => ShareSession | undefined): ShareSession {
  const session = getSession()
  if (!session) throw new Error('Sharing is not ready yet.')
  return session
}

export function registerIpcHandlers({
  ipc,
  dialog,
  clipboard,
  getSession,
  publishState,
  rendererUrl,
}: RegisterIpcHandlersOptions): void {
  ipc.handle('files:select', async (event) => {
    assertTrustedSender(event, rendererUrl)
    const result = await dialog.showOpenDialog({
      title: 'Choose files to share',
      buttonLabel: 'Add files',
      properties: ['openFile', 'multiSelections'],
    })

    const session = requireSession(getSession)
    return result.canceled
      ? session.getState()
      : publishState(await session.addPaths(result.filePaths))
  })

  ipc.handle('files:add-paths', async (event, paths: unknown) => {
    assertTrustedSender(event, rendererUrl)
    const validPaths = Array.isArray(paths)
      ? paths.filter((path): path is string => typeof path === 'string')
      : []
    if (!Array.isArray(paths) || validPaths.length !== paths.length) {
      throw new TypeError('Dropped files must be provided as an array of paths.')
    }
    return publishState(await requireSession(getSession).addPaths(validPaths))
  })

  ipc.handle('files:remove', async (event, id: unknown) => {
    assertTrustedSender(event, rendererUrl)
    if (typeof id !== 'string') throw new TypeError('File id must be a string.')
    return publishState(await requireSession(getSession).remove(id))
  })

  ipc.handle('files:clear', async (event) => {
    assertTrustedSender(event, rendererUrl)
    return publishState(await requireSession(getSession).clear())
  })

  ipc.handle('share:get-state', (event) => {
    assertTrustedSender(event, rendererUrl)
    return requireSession(getSession).getState()
  })

  ipc.handle('share:copy-link', (event) => {
    assertTrustedSender(event, rendererUrl)
    const url = requireSession(getSession).getState().share.url
    if (!url) return false
    clipboard.writeText(url)
    return true
  })
}