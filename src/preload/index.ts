import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ShareState } from '../shared/contracts.js'

contextBridge.exposeInMainWorld('dropbeam', {
  selectFiles: () => ipcRenderer.invoke('files:select'),
  addDroppedFiles: (files: File[]) =>
    ipcRenderer.invoke(
      'files:add-paths',
      files.map((file) => webUtils.getPathForFile(file)),
    ),
  removeFile: (id: string) => ipcRenderer.invoke('files:remove', id),
  clearFiles: () => ipcRenderer.invoke('files:clear'),
  getState: () => ipcRenderer.invoke('share:get-state'),
  copyLink: () => ipcRenderer.invoke('share:copy-link'),
  onStateChanged: (listener: (state: ShareState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ShareState) => listener(state)
    ipcRenderer.on('share:state-changed', handler)
    return () => ipcRenderer.removeListener('share:state-changed', handler)
  },
})