export function validDriveId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{10,180}$/.test(value) }
export function validDriveKey(value: unknown): value is string | undefined { return value === undefined || typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value) }
export function driveFileUrl(id: string, resourceKey?: string) {
  if (!validDriveId(id) || !validDriveKey(resourceKey)) throw new Error('Drive 文件链接无效')
  const url = new URL(`https://drive.google.com/file/d/${id}/view`)
  if (resourceKey) url.searchParams.set('resourcekey', resourceKey)
  return url.href
}
