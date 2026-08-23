export type SharedFile = {
  id: string
  name: string
  extension: string
  size: number
}

export type ShareInfo = {
  url: string
  address: string
  port: number
}

export type ShareState = {
  files: SharedFile[]
  share: ShareInfo
}

export type DropbeamApi = {
  selectFiles: () => Promise<ShareState>
  addDroppedFiles: (files: File[]) => Promise<ShareState>
  removeFile: (id: string) => Promise<ShareState>
  clearFiles: () => Promise<ShareState>
  getState: () => Promise<ShareState>
  copyLink: () => Promise<boolean>
  onStateChanged: (listener: (state: ShareState) => void) => () => void
}