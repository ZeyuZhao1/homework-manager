import { service } from '../service'
import { desktopSync } from '../sync/desktop'
import { webSync } from '../sync/web'
import type { FileAsset } from '../types'
import type { DriveFileInfo, DriveStatus, DriveFlow, DriveFlowResult, DriveResolveResult, DriveRefreshResult } from './types'

export interface DriveSelection { path: string; name: string }
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(new DOMException('已取消等待', 'AbortError')) }
    signal.addEventListener('abort', cancel, { once: true })
    work.then(value => { signal.removeEventListener('abort', cancel); if (!signal.aborted) resolve(value) }, error => { signal.removeEventListener('abort', cancel); reject(error) })
    if (signal.aborted) cancel()
  })
}
async function api<T>(action: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (service.isDesktop) return abortable(service.driveRequest<T>(action, payload), signal)
  if (!service.isCloud) throw new Error('Google Drive 需要连接个人云端，演示模式不可用')
  const routes: Record<string, [string, string]> = {
    status: ['/drive/status', 'GET'], start: ['/drive/flows', 'POST'], disconnect: ['/drive/connection', 'DELETE'],
    resolve: ['/drive/files/resolve', 'POST'], refresh: ['/drive/files/refresh', 'POST'],
  }
  if (action === 'poll') {
    const input = payload as { flow_id: string; poll_secret: string }
    return abortable(webSync.request<T>(`/drive/flows/${encodeURIComponent(input.flow_id)}/poll`, { poll_secret: input.poll_secret }), signal)
  }
  const route = routes[action]
  if (!route) throw new Error('未知的 Drive 操作')
  return abortable(webSync.request<T>(route[0], payload, route[1]), signal)
}
function reserveWindow() {
  if (service.isDesktop) return null
  const popup = window.open('about:blank', '_blank')
  if (popup) { popup.opener = null; popup.document.title = 'Google Drive'; popup.document.body.textContent = '正在准备 Google Drive，请稍候…' }
  return popup
}
function closeWindow(popup: Window | null) { try { popup?.close() } catch { /* An external browser can outlive its caller. */ } }
function pause(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cancel = () => { window.clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new DOMException('已取消等待', 'AbortError')) }
    const timer = window.setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve() }, 2000)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
  })
}
async function flow(purpose: 'connect' | 'pick', file_id?: string, resource_key?: string, signal?: AbortSignal, reserved?: Window | null): Promise<DriveFileInfo[]> {
  const popup = reserved === undefined ? reserveWindow() : reserved
  try {
    const started = await api<DriveFlow>('start', { purpose, ...(file_id ? { file_id } : {}), ...(resource_key ? { resource_key } : {}) }, signal)
    const target = new URL(started.authorization_url)
    if (target.origin !== 'https://accounts.google.com' || target.pathname !== '/o/oauth2/v2/auth' || target.username || target.password) throw new Error('Drive 授权地址无效')
    signal?.throwIfAborted()
    if (service.isDesktop) await service.openUrl(target.href)
    else if (popup && !popup.closed) popup.location.replace(target.href)
    else throw new Error('浏览器阻止或关闭了授权窗口，请允许弹出窗口后重试')
    const deadline = new Date(started.expires_at).getTime()
    if (!Number.isFinite(deadline) || deadline > Date.now() + 15 * 60000) throw new Error('授权会话无效')
    while (Date.now() < deadline) {
      await pause(signal)
      const result = await api<DriveFlowResult>('poll', { flow_id: started.flow_id, poll_secret: started.poll_secret }, signal)
      if (result.state === 'complete') { closeWindow(popup); return result.files || [] }
      if (result.state === 'failed') throw new Error(result.error || 'Drive 授权未完成，请重试')
      if (result.state === 'expired') break
      if (popup?.closed) throw new Error('授权窗口已关闭，已取消等待')
    }
    throw new Error('Drive 授权已过期，请重新发起')
  } catch (error) { closeWindow(popup); throw error }
}
export const driveService = {
  status: () => api<DriveStatus>('status'),
  async connect(signal?: AbortSignal) { await flow('connect', undefined, undefined, signal) },
  disconnect: () => api<void>('disconnect'),
  pick: (signal?: AbortSignal) => flow('pick', undefined, undefined, signal),
  async addUrl(url: string, signal?: AbortSignal) {
    const popup = reserveWindow()
    try {
      const result = await api<DriveResolveResult>('resolve', { url }, signal)
      if (result.state === 'ready') { closeWindow(popup); return [result.file] }
      return await flow('pick', result.file_id, result.resource_key, signal, popup)
    } catch (error) { closeWindow(popup); throw error }
  },
  async register(files: DriveFileInfo[]): Promise<DriveSelection[]> {
    await service.registerDriveFiles(files)
    return files.map(file => ({ path: `gdrive:${file.id}`, name: file.name }))
  },
  async refresh(file: FileAsset) {
    if (!file.drive_id) throw new Error('此附件不是 Drive 文件')
    // Native Option fields arrive as null; Google requests omit absent keys.
    const resourceKey = file.drive_resource_key || undefined
    const result = await api<DriveRefreshResult>('refresh', { drive_id: file.drive_id, resource_key: resourceKey })
    const info = result.file || { id: file.drive_id, name: file.name || 'Google Drive 文件', mime_type: file.mime || 'application/octet-stream', resource_key: resourceKey }
    await service.registerDriveFiles([{ ...info, unavailable: result.unavailable }])
    window.dispatchEvent(new Event('homeworkbook:sync-refreshed'))
  },
  async connectedDesktop() { return !service.isDesktop || (await desktopSync.status()).connected },
}
