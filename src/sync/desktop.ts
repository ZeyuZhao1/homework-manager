import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import type { PairResult, SyncDevice, SyncStatus } from './protocol'
export interface DesktopSyncStatus extends SyncStatus { baseline_counts?: Record<string, number> }
let inFlight: Promise<DesktopSyncStatus> | undefined
function synchronize() {
  if (!inFlight) inFlight = invoke<DesktopSyncStatus>('sync_now').finally(() => { inFlight = undefined })
  return inFlight
}
export const desktopSync = {
  status: () => invoke<DesktopSyncStatus>('sync_status'),
  start: (serverUrl: string, deviceName: string) => invoke<{ pair_id: string; code: string; expires_at: string }>('sync_pair_start', { serverUrl, deviceName }),
  poll: () => invoke<PairResult>('sync_pair_poll'),
  bootstrap: (serverUrl: string, deviceName: string, bootstrapSecret: string) => invoke<DesktopSyncStatus>('sync_bootstrap', { serverUrl, deviceName, bootstrapSecret }),
  async setEnabled(enabled: boolean) { const result = await invoke<DesktopSyncStatus>('sync_set_enabled', { enabled }); window.dispatchEvent(new Event('homeworkbook:sync-settings-changed')); return result },
  now: synchronize,
  devices: () => invoke<{ devices: SyncDevice[] }>('sync_devices'),
  approve: (code: string) => invoke<void>('sync_approve_pair', { code }),
  revoke: (deviceId: string) => invoke<void>('sync_revoke_device', { deviceId }),
  disconnect: () => invoke<DesktopSyncStatus>('sync_disconnect'),
  async upload(fileId: string, name: string) { if (!window.confirm(`上传“${name}”的完整内容到个人云端？\n仅本次上传；后续本地修改不会自动上传。`)) throw new Error('已取消上传'); await synchronize(); await invoke('sync_upload_file', { fileId, confirmed: true }); await synchronize() },
  async download(fileId: string, name: string) { const path = await save({ defaultPath: name }); if (!path) throw new Error('已取消下载'); if (!window.confirm('下载云端附件，并将此设备的附件定位到所选位置？不会覆盖已有文件。')) throw new Error('已取消下载'); await invoke('sync_download_file', { fileId, path, confirmed: true }) },
  async removeContent(fileId: string) { await invoke('sync_remove_cloud_file', { fileId }); const status=await desktopSync.status(); if(status.enabled) await synchronize() },
}
