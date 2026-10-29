import { useEffect, useState } from 'react'
import { service } from '../service'
import type { FileAsset } from '../types'
import { desktopSync } from './desktop'
import { webSync } from './web'

export function FileTransferActions({ file }: { file: FileAsset }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    if (!service.isDesktop) return
    let alive = true
    const load = () => { void desktopSync.status().then(status => { if (alive) setConnected(status.connected) }).catch(() => {}) }
    load(); window.addEventListener('homeworkbook:sync-settings-changed', load)
    return () => { alive = false; window.removeEventListener('homeworkbook:sync-settings-changed', load) }
  }, [])
  const run = async (work: () => Promise<unknown>) => { setBusy(true); setMessage(''); try { await work(); window.dispatchEvent(new Event('homeworkbook:sync-refreshed')); setMessage('操作完成') } catch (e) { setMessage(e instanceof Error ? e.message : '操作失败') } finally { setBusy(false) } }
  if (!service.isDesktop && !service.isCloud) return null
  if (service.isDesktop && !connected && !file.cloud_available) return null
  const name = file.name || file.path.split(/[\\/]/).at(-1) || 'attachment'
  return <div className="file-transfer-actions"><small>{file.cloud_available ? '云端内容可用' : '仅附件元数据'}</small><button className="button button-quiet" disabled={busy || (service.isDesktop && file.missing)} onClick={() => void run(() => service.isDesktop ? desktopSync.upload(file.id, name) : webSync.uploadFile(file.id))}>{busy ? '处理中…' : '手动上传内容'}</button>{service.isDesktop && file.cloud_available ? <button className="button button-quiet" disabled={busy} onClick={() => void run(() => desktopSync.download(file.id, name))}>下载到所选位置</button> : null}{file.cloud_available ? <button className="button button-quiet" disabled={busy} onClick={() => { if (window.confirm('移除云端附件内容？文件元数据和本地文件都会保留。')) void run(() => service.isDesktop ? desktopSync.removeContent(file.id) : webSync.request(`/files/${encodeURIComponent(file.id)}/content`, undefined, 'DELETE')) }}>移除云端内容</button> : null}{message ? <small role="status">{message}</small> : null}</div>
}
