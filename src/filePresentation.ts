import type { FileAsset } from './types'

export function isDriveReference(value: string | FileAsset | undefined) { return typeof value === 'string' ? value.startsWith('gdrive:') : !!value && (!!value.drive_id || value.path.startsWith('gdrive:')) }
export function isCloudReference(path: string) { return path.startsWith('cloud:') }
export function readableFileName(path: string) {
  if (isDriveReference(path)) return 'Google Drive 文件'
  if (path.startsWith('cloud://')) return '云端附件'
  return (path.startsWith('/') ? path.split('/') : path.split(/[\\/]/)).at(-1) || path
}
export function attachmentName(file: FileAsset) { return file.name || readableFileName(file.path) }
export function attachmentLocation(file: FileAsset) {
  if (isDriveReference(file)) return file.drive_unavailable ? 'Google Drive · 暂不可访问' : 'Google Drive · 仅链接'
  if (!isCloudReference(file.path)) return file.path
  return file.cloud_available ? '云端附件 · 内容已上传' : '云端附件 · 仅元数据'
}
export function canOpenAttachment(file: FileAsset | undefined, web: boolean) {
  if (isDriveReference(file)) return true
  return !!file && !file.missing && !(file.path.startsWith('cloud://')) && (!web || !!file.cloud_available)
}
export function attachmentHint(file: FileAsset, web: boolean) {
  if (isDriveReference(file)) return file.drive_unavailable ? '暂不可访问 · 可在 Google Drive 中检查权限，或刷新信息' : '仅链接 · 在 Google Drive 中打开'
  if (!file.cloud_available && (web || isCloudReference(file.path))) return '仅元数据 · 请先手动上传内容'
  if (isCloudReference(file.path) && !web) return '云端内容可用 · 请到文件页下载到本机'
  return file.missing ? '本机文件未找到' : ''
}
