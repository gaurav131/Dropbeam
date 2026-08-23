import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
} from 'electron'
import { registerIpcHandlers, type IpcRegistrar } from './ipc-handlers.js'
import { startShareServer, type ShareServer } from './share-server.js'
import { ShareSession } from './share-session.js'
import type { ShareState } from '../shared/contracts.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
let shareServer: ShareServer | undefined
let shareSession: ShareSession | undefined
let networkMonitor: NodeJS.Timeout | undefined
let isClosingServer = false

function getShareState(): ShareState {
  if (!shareSession) {
    return { files: [], share: { url: '', address: '', port: 0 } }
  }
  return shareSession.getState()
}

function publishShareState(state = getShareState()): ShareState {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('share:state-changed', state)
  }
  return state
}

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 640,
    show: false,
    backgroundColor: '#f4f6f1',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  window.on('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

async function runPackagedSmokeTest(
  window: BrowserWindow,
  server: ShareServer,
): Promise<void> {
  const rendererReady: unknown = await window.webContents.executeJavaScript(
    "document.title === 'Dropbeam' && typeof window.dropbeam?.getState === 'function'",
  )
  if (rendererReady !== true) throw new Error('Renderer or preload bridge did not initialize.')

  const state: unknown = await window.webContents.executeJavaScript(
    'window.dropbeam.getState()',
  )
  if (!state || typeof state !== 'object' || !('files' in state)) {
    throw new Error('Preload bridge returned an invalid state.')
  }

  const serverUrl = new URL(server.getInfo().url)
  serverUrl.hostname = '127.0.0.1'
  const response = await fetch(serverUrl)
  if (!response.ok) throw new Error(`Share server returned HTTP ${response.status}.`)

  console.log('PACKAGED_SMOKE_OK')
}

void app.whenReady().then(async () => {
  shareServer = await startShareServer(() => shareSession?.getRecords() ?? [])
  shareSession = new ShareSession(shareServer)
  const rendererFile = join(__dirname, '../renderer/index.html')
  const rendererUrl = process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(rendererFile).href
  registerIpcHandlers({
    ipc: ipcMain as IpcRegistrar,
    dialog,
    clipboard,
    getSession: () => shareSession,
    publishState: publishShareState,
    rendererUrl,
  })
  const window = await createWindow()

  if (process.argv.includes('--smoke-test')) {
    await runPackagedSmokeTest(window, shareServer)
    app.quit()
    return
  }

  let lastAddress = shareServer.getInfo().address
  networkMonitor = setInterval(() => {
    const currentAddress = shareServer?.getInfo().address ?? ''
    if (currentAddress === lastAddress) return
    lastAddress = currentAddress
    if (shareSession) void shareSession.refreshAddress().then(publishShareState)
  }, 3_000)
  networkMonitor.unref()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
}).catch((error: unknown) => {
  console.error('Dropbeam failed to start.', error)
  app.quit()
})

app.on('window-all-closed', () => {
  if (shareSession) void shareSession.clear().then(publishShareState)
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (isClosingServer || !shareServer) return
  event.preventDefault()
  isClosingServer = true
  if (networkMonitor) clearInterval(networkMonitor)
  void shareServer.close().finally(() => app.quit())
})