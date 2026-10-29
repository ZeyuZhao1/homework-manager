import { useEffect, useRef, useState } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { service } from '../service'
import type { FileAsset } from '../types'
import { driveService } from './service'
import type { DriveSelection } from './service'
import type { DriveFileInfo, DriveStatus } from './types'
import './drive.css'

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)
// One cancellable operation per mounted control, including the browser authorization wait.
function useDriveOperation() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; pending.current?.abort() } }, [])
  const run = async (operation: (signal: AbortSignal) => Promise<void>) => {
    if (pending.current) return
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError('')
    try { await operation(controller.signal) } catch (reason) { if (alive.current && !controller.signal.aborted) setError(messageOf(reason)) }
    finally { if (pending.current === controller) pending.current = null; if (alive.current) setBusy(false) }
  }
  return { busy, error, run, cancel: () => pending.current?.abort() }
}
async function requireDevice() {
  if (!await driveService.connectedDesktop()) throw new Error('请先在“个人多设备同步”中连接个人云端并授权此设备，再使用 Google Drive。暂停同步后仍可手动使用 Drive。')
}

export function DriveFilePicker({ onPicked, disabled = false }: { onPicked: (files: DriveSelection[]) => void; disabled?: boolean }) {
  const [url, setUrl] = useState('')
  const { busy, error, run, cancel } = useDriveOperation()
  const select = (paste: boolean) => void run(async signal => {
    if (service.isDesktop) await requireDevice()
    if (signal.aborted) return
    const files: DriveFileInfo[] = paste ? await driveService.addUrl(url.trim(), signal) : await driveService.pick(signal)
    if (signal.aborted) return
    const selected = await driveService.register(files)
    if (!signal.aborted) { onPicked(selected); if (paste) setUrl('') }
  })
  return <div className="drive-picker"><button type="button" className="button button-quiet" disabled={disabled || busy} onClick={() => select(false)}>从 Google Drive 选择</button><details className="drive-paste"><summary>粘贴 Drive 链接</summary><label className="form-field">Google Drive 文件链接<input type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://drive.google.com/…" disabled={busy} /></label><button type="button" className="button button-quiet" disabled={disabled || busy || !url.trim()} onClick={() => select(true)}>添加链接</button></details>{busy ? <div className="drive-progress" role="status">请在浏览器中完成授权或选择文件。<button type="button" className="text-link" onClick={cancel}>取消等待</button></div> : null}<small className="helper-text">仅保存文件信息和链接；在 Google Drive 中打开，不导入文件内容。</small>{error ? <p className="drive-error" role="alert">{error}</p> : null}</div>
}

export function DriveSettings() {
  const [status, setStatus] = useState<DriveStatus | null>(null)
  const { busy, error, run, cancel } = useDriveOperation()
  const load = () => void run(async signal => { await requireDevice(); if (signal.aborted) return; const next = await driveService.status(); if (!signal.aborted) setStatus(next) })
  // Desktop status reads must remain an explicit action when synchronization is paused.
  useEffect(() => { if (service.isCloud) load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return <section className="settings-card drive-settings"><div className="settings-card-title"><div><h2>Google Drive</h2><p>同一 Google 账号供个人云端的已授权设备共用。附件仅保存信息和链接。</p></div></div>{status ? <p className="drive-account">{status.connected ? `已连接${status.account_email || status.account_name ? ` · ${status.account_email || status.account_name}` : ''}` : status.configured ? '尚未连接 Google 账号' : '个人云端尚未配置 Google Drive'}{status.needs_reconnect ? ' · 需要重新授权' : ''}</p> : <p className="helper-text">点击检查连接状态，然后在浏览器中授权 Google 账号。</p>}<div className="drive-buttons"><button type="button" className="button button-quiet" disabled={busy} onClick={load}>检查连接状态</button>{!status || status.configured ? <button type="button" className="button button-primary" disabled={busy} onClick={() => void run(async signal => { if (service.isDesktop) await requireDevice(); if (signal.aborted) return; await driveService.connect(signal); if (!signal.aborted) { const next = await driveService.status(); if (!signal.aborted) setStatus(next) } })}>{status?.connected ? '重新授权' : '连接 Google Drive'}</button> : null}{status?.connected ? <button type="button" className="button button-quiet" disabled={busy} onClick={() => { if (window.confirm('断开 Google Drive 账号？所有已授权设备都将断开，已关联的文件链接会保留。')) void run(async signal => { await driveService.disconnect(); if (!signal.aborted) setStatus(current => current ? { ...current, connected: false, account_email: undefined, account_name: undefined } : null) }) }}>断开连接</button> : null}</div>{busy ? <p className="drive-progress" role="status">处理中，请在浏览器中完成授权。<button type="button" className="text-link" onClick={cancel}>取消等待</button></p> : null}{error ? <p className="drive-error" role="alert">{error}</p> : null}<p className="helper-text">暂停自动同步后，仍可手动选择文件和刷新信息；断开账号不会移除已有作业关联。</p></section>
}

export function DriveFileActions({ file, open = false }: { file: FileAsset; open?: boolean }) {
  const { busy, error, run } = useDriveOperation()
  return <div className="drive-file-actions"><span className="drive-pill">仅链接</span><button type="button" className="button button-quiet" disabled={busy} onClick={() => void run(async signal => { await requireDevice(); if (!signal.aborted) await driveService.refresh(file) })}><RefreshCw size={14} />{busy ? '刷新中…' : '刷新信息'}</button>{open ? <button type="button" className="button button-quiet" onClick={() => void run(async () => { await service.openFile(file.id) })} disabled={busy}><ExternalLink size={14} />在 Drive 中打开</button> : null}{error ? <small className="drive-error" role="alert">{error}</small> : null}</div>
}
