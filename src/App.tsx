import { useEffect, useRef, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import {
  Archive,
  Check,
  Copy,
  File,
  FileText,
  FolderOpen,
  Image,
  Inbox,
  Music,
  PauseCircle,
  Plus,
  Radio,
  Trash2,
  Upload,
  Video,
  X,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import type { ShareState } from './shared/contracts'
import './dropbeam.css'

const emptyState: ShareState = {
  files: [],
  receivedFiles: [],
  receivingEnabled: false,
  share: { url: '', address: '', port: 0 },
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`
}

function FileTypeIcon({ extension }: { extension: string }): ReactNode {
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg'].includes(extension)) {
    return <Image aria-hidden="true" />
  }
  if (['mov', 'mp4', 'm4v', 'avi', 'webm'].includes(extension)) {
    return <Video aria-hidden="true" />
  }
  if (['mp3', 'wav', 'm4a', 'aac', 'flac'].includes(extension)) {
    return <Music aria-hidden="true" />
  }
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)) {
    return <Archive aria-hidden="true" />
  }
  if (['txt', 'md', 'pdf', 'doc', 'docx', 'rtf', 'csv'].includes(extension)) {
    return <FileText aria-hidden="true" />
  }
  return <File aria-hidden="true" />
}

function App() {
  const [shareState, setShareState] = useState<ShareState>(emptyState)
  const [isDragging, setIsDragging] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  const [copied, setCopied] = useState(false)
  const [status, setStatus] = useState<{ kind: 'error' | 'success'; message: string } | null>(null)
  const copyTimer = useRef<number | undefined>(undefined)
  const latestReceivedId = useRef<string | undefined>(undefined)

  useEffect(() => {
    let isMounted = true
    void window.dropbeam.getState()
      .then((state) => {
        if (isMounted) {
          setShareState(state)
          latestReceivedId.current = state.receivedFiles[state.receivedFiles.length - 1]?.id
        }
      })
      .catch((error: unknown) => {
        if (isMounted) setStatus({ kind: 'error', message: getErrorMessage(error) })
      })
    const unsubscribe = window.dropbeam.onStateChanged((state) => {
      if (!isMounted) return
      setShareState(state)
      const latest = state.receivedFiles[state.receivedFiles.length - 1]
      if (latest && latest.id !== latestReceivedId.current) {
        setStatus({ kind: 'success', message: `${latest.name} received in Downloads/Dropbeam.` })
      }
      latestReceivedId.current = latest?.id
    })
    return () => {
      isMounted = false
      unsubscribe()
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current)
    }
  }, [])

  const { files, receivedFiles, receivingEnabled, share: shareInfo } = shareState

  const addSelectedFiles = async () => {
    setIsAdding(true)
    setStatus(null)
    try {
      setShareState(await window.dropbeam.selectFiles())
    } catch (error) {
      setStatus({ kind: 'error', message: getErrorMessage(error) })
    } finally {
      setIsAdding(false)
    }
  }

  const handleDrop = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    setIsDragging(false)
    setIsAdding(true)
    setStatus(null)
    try {
      setShareState(await window.dropbeam.addDroppedFiles([...event.dataTransfer.files]))
    } catch (error) {
      setStatus({ kind: 'error', message: getErrorMessage(error) })
    } finally {
      setIsAdding(false)
    }
  }

  const copyLink = async () => {
    setStatus(null)
    try {
      const didCopy = await window.dropbeam.copyLink()
      if (!didCopy) throw new Error('The share link is not ready yet.')
      setCopied(true)
      setStatus({ kind: 'success', message: 'Share link copied.' })
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => {
        setCopied(false)
        setStatus(null)
      }, 1800)
    } catch (error) {
      setStatus({ kind: 'error', message: getErrorMessage(error) })
    }
  }

  const stopSharing = async () => {
    setStatus(null)
    try {
      setShareState(await window.dropbeam.clearFiles())
      setStatus({ kind: 'success', message: 'Files removed from the share.' })
    } catch (error) {
      setStatus({ kind: 'error', message: getErrorMessage(error) })
    }
  }

  const removeFile = async (id: string) => {
    setStatus(null)
    try {
      setShareState(await window.dropbeam.removeFile(id))
    } catch (error) {
      setStatus({ kind: 'error', message: getErrorMessage(error) })
    }
  }

  const revealReceivedFile = async (id: string) => {
    setStatus(null)
    try {
      const didReveal = await window.dropbeam.revealReceivedFile(id)
      if (!didReveal) throw new Error('That received file is no longer available.')
    } catch (error) {
      setStatus({ kind: 'error', message: getErrorMessage(error) })
    }
  }

  const clearReceivedFiles = async () => {
    setStatus(null)
    try {
      setShareState(await window.dropbeam.clearReceivedFiles())
    } catch (error) {
      setStatus({ kind: 'error', message: getErrorMessage(error) })
    }
  }

  const toggleReceiving = async () => {
    setStatus(null)
    try {
      const state = await window.dropbeam.setReceivingEnabled(!receivingEnabled)
      setShareState(state)
      setStatus({
        kind: 'success',
        message: state.receivingEnabled
          ? 'Receiving started with a new share link.'
          : 'Receiving paused. The previous link no longer accepts uploads.',
      })
    } catch (error) {
      setStatus({ kind: 'error', message: getErrorMessage(error) })
    }
  }

  const totalSize = files.reduce((sum, file) => sum + file.size, 0)

  return (
    <div
      className={`app-shell${isDragging ? ' is-dragging' : ''}`}
      onDragEnter={(event) => {
        event.preventDefault()
        setIsDragging(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsDragging(false)
        }
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark"><Radio aria-hidden="true" /></span>
          <span>Dropbeam</span>
        </div>
        <div className="network-status">
          <span className="status-dot" />
          Local network
        </div>
      </header>

      <div className={`status-message${status ? ` is-${status.kind}` : ''}`} role={status?.kind === 'error' ? 'alert' : 'status'} aria-live="polite">
        {status?.message ?? ''}
      </div>

      <main className="workspace">
        <section className="files-pane" aria-labelledby="files-title">
          <div className="pane-heading">
            <div>
              <span className="eyebrow">Ready to beam</span>
              <h1 id="files-title">Files to send</h1>
            </div>
            {files.length > 0 && (
              <button className="text-button danger" type="button" onClick={stopSharing}>
                <Trash2 aria-hidden="true" /> Stop sharing
              </button>
            )}
          </div>

          <button className="drop-zone" type="button" onClick={addSelectedFiles} disabled={isAdding} aria-busy={isAdding}>
            <span className="drop-icon"><Upload aria-hidden="true" /></span>
            <span className="drop-title">{isDragging ? 'Release to add' : isAdding ? 'Adding files...' : 'Drop files here'}</span>
            <span className="drop-meta">or choose from your Mac</span>
            <span className="choose-action"><Plus aria-hidden="true" /> Choose files</span>
          </button>

          <div className="file-section">
            <div className="file-summary">
              <span>{files.length} {files.length === 1 ? 'file' : 'files'}</span>
              <span>{formatBytes(totalSize)}</span>
            </div>

            {files.length === 0 ? (
              <div className="empty-list"><File aria-hidden="true" /><p>Selected files will appear here.</p></div>
            ) : (
              <ul className="file-list">
                {files.map((file) => (
                  <li key={file.id}>
                    <span className={`file-icon type-${file.extension || 'other'}`}>
                      <FileTypeIcon extension={file.extension} />
                    </span>
                    <span className="file-details">
                      <strong title={file.name}>{file.name}</strong>
                      <small>{file.extension ? file.extension.toUpperCase() : 'FILE'} / {formatBytes(file.size)}</small>
                    </span>
                    <button
                      className="icon-button"
                      type="button"
                      title={`Remove ${file.name}`}
                      aria-label={`Remove ${file.name}`}
                      onClick={() => void removeFile(file.id)}
                    >
                      <X aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <section className="received-section" aria-labelledby="received-title">
            <div className="received-heading">
              <div>
                <span className="eyebrow">Saved to Downloads/Dropbeam</span>
                <h2 id="received-title">Received on this Mac</h2>
              </div>
              <div className="received-actions">
                <button className="text-button" type="button" onClick={toggleReceiving}>
                  {receivingEnabled ? <PauseCircle aria-hidden="true" /> : <Radio aria-hidden="true" />}
                  {receivingEnabled ? 'Pause receiving' : 'Start receiving'}
                </button>
                {receivedFiles.length > 0 && (
                  <button className="text-button" type="button" onClick={clearReceivedFiles}>
                    <Trash2 aria-hidden="true" /> Clear history
                  </button>
                )}
              </div>
            </div>
            {receivedFiles.length === 0 ? (
              <div className="empty-list"><Inbox aria-hidden="true" /><p>Files sent from nearby devices will appear here.</p></div>
            ) : (
              <ul className="file-list received-list">
                {[...receivedFiles].reverse().map((file) => (
                  <li key={file.id}>
                    <span className={`file-icon type-${file.extension || 'other'}`}>
                      <FileTypeIcon extension={file.extension} />
                    </span>
                    <span className="file-details">
                      <strong title={file.name}>{file.name}</strong>
                      <small>{formatBytes(file.size)} / {new Date(file.receivedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small>
                    </span>
                    <button
                      className="icon-button"
                      type="button"
                      title={`Show ${file.name} in Finder`}
                      aria-label={`Show ${file.name} in Finder`}
                      onClick={() => void revealReceivedFile(file.id)}
                    >
                      <FolderOpen aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </section>

        <aside className="share-pane" aria-labelledby="share-title">
          <div className="share-heading">
            <span className="eyebrow light">Nearby sharing</span>
            <h2 id="share-title">Scan to share</h2>
            <p>{files.length > 0
              ? `Download ${files.length} ${files.length === 1 ? 'file' : 'files'}${receivingEnabled ? ' or send files back' : ''}.`
              : receivingEnabled
                ? 'Ready to receive files from a nearby device.'
                : 'Sharing is paused.'}</p>
          </div>

          <div className="qr-frame">
            {shareInfo.url ? (
              <QRCodeSVG value={shareInfo.url} size={220} level="M" marginSize={3} bgColor="#ffffff" fgColor="#173c35" title="Dropbeam download link" />
            ) : (
              <div className="qr-loading" />
            )}
          </div>

          <div className="link-box">
            <span className="link-copy">
              <small>Share address</small>
              <strong>{shareInfo.address ? `${shareInfo.address}:${shareInfo.port}` : 'Starting server...'}</strong>
            </span>
            <button className="copy-button" type="button" title="Copy share link" aria-label="Copy share link" disabled={!shareInfo.url} onClick={copyLink}>
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            </button>
          </div>

          <div className="privacy-note">
            <span><Radio aria-hidden="true" /></span>
            <p><strong>Direct, with no cloud upload</strong>{receivingEnabled ? 'Receiving is active. ' : ''}Files travel over your local network. Use Dropbeam only on Wi-Fi you trust.</p>
          </div>
        </aside>
      </main>

      {isDragging && (
        <div className="drag-overlay" aria-hidden="true">
          <span><Upload /></span>
          <strong>Drop to add files</strong>
        </div>
      )}
    </div>
  )
}

export default App
