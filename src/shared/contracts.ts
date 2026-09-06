export type SharedFile = {
  id: string
  name: string
  extension: string
  size: number
}

export type ReceivedFile = SharedFile & {
  receivedAt: string
}

export type ShareInfo = {
  url: string
  address: string
  port: number
}

export type ShareState = {
  files: SharedFile[]
  receivedFiles: ReceivedFile[]
  receivingEnabled: boolean
  share: ShareInfo
}

export type DropbeamApi = {
  selectFiles: () => Promise<ShareState>
  addDroppedFiles: (files: File[]) => Promise<ShareState>
  removeFile: (id: string) => Promise<ShareState>
  clearFiles: () => Promise<ShareState>
  clearReceivedFiles: () => Promise<ShareState>
  revealReceivedFile: (id: string) => Promise<boolean>
  setReceivingEnabled: (enabled: boolean) => Promise<ShareState>
  getState: () => Promise<ShareState>
  copyLink: () => Promise<boolean>
  onStateChanged: (listener: (state: ShareState) => void) => () => void
}