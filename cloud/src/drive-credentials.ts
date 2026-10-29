// Only encrypted OAuth credentials live here; never add this namespace to snapshots.
import { ApiError } from './store'
const key = '_private/drive-credentials/account'
const encoder = new TextEncoder()
export interface DriveCredential { refresh_token: string; access_token: string; expires_at: number; subject: string; name: string; email?: string; needs_reconnect?: boolean }
export function driveConfigured(env: Env) { return !!env.DRIVE_GOOGLE_CLIENT_ID && !!env.DRIVE_GOOGLE_CLIENT_SECRET && /^[a-f\d]{64}$/i.test(env.DRIVE_CREDENTIAL_ENCRYPTION_KEY || '') && /^https:\/\//.test(env.PUBLIC_ORIGIN || '') }
async function master(env: Env) {
  if (!driveConfigured(env)) throw new ApiError(503, 'Google Drive 尚未配置')
  return crypto.subtle.importKey('raw', Uint8Array.from(env.DRIVE_CREDENTIAL_ENCRYPTION_KEY!.match(/../g)!, value => parseInt(value, 16)), 'AES-GCM', false, ['encrypt', 'decrypt'])
}
export async function readDriveCredential(env: Env): Promise<DriveCredential | undefined> {
  try {
    const object = await env.FILES.get(key)
    if (!object) return
    if (object.size > 16384) throw 0
    const value = await object.json<{ iv: string; ciphertext: string; version: number }>()
    if (value.version !== 1) throw 0
    const iv = Uint8Array.from(atob(value.iv), c => c.charCodeAt(0))
    if (iv.length !== 12) throw 0
    const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(key) }, await master(env), Uint8Array.from(atob(value.ciphertext), c => c.charCodeAt(0)))
    const credential = JSON.parse(new TextDecoder().decode(raw)) as DriveCredential
    if (typeof credential.subject !== 'string' || typeof credential.refresh_token !== 'string' || typeof credential.access_token !== 'string' || !Number.isFinite(credential.expires_at)) throw 0
    return credential
  } catch { throw new ApiError(503, 'Google Drive 私密凭据存储不可用，请检查配置') }
}
export async function saveDriveCredential(env: Env, credential: DriveCredential) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(key) }, await master(env), encoder.encode(JSON.stringify(credential)))
  const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value))
  await env.FILES.put(key, JSON.stringify({ version: 1, iv: encode(iv), ciphertext: encode(new Uint8Array(encrypted)) }))
}
export async function deleteDriveCredential(env: Env) { await env.FILES.delete(key) }
