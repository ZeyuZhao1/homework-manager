// Credentials never enter EntityStore, snapshots, change feeds or application backups.
// Keep this namespace private: file APIs only accept content/<file-id>/ versions.
const PREFIX = '_private/ai-credentials/'
const encoder = new TextEncoder()
export class CredentialError extends Error {
  constructor(message: string, readonly status = 503) { super(message) }
}
function unavailable(): never { throw new CredentialError('网页 AI 密钥存储不可用，请配置有效的 Worker Secret AI_CREDENTIAL_ENCRYPTION_KEY（64 位十六进制）') }
function objectKey(provider: string) { return `${PREFIX}${encodeURIComponent(provider)}` }
async function masterKey(env: Env) {
  if (!/^[a-fA-F0-9]{64}$/.test(env.AI_CREDENTIAL_ENCRYPTION_KEY || '')) unavailable()
  const bytes = Uint8Array.from(env.AI_CREDENTIAL_ENCRYPTION_KEY!.match(/../g)!, pair => parseInt(pair, 16))
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}
function encoded(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)) }
function decoded(value: string) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)) }
function legacyKey(env: Env, provider: string): string | undefined {
  try {
    const keys: unknown = JSON.parse(env.AI_PROVIDER_KEYS || '{}')
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw 0
    const key = Object.hasOwn(keys, provider) ? (keys as Record<string, unknown>)[provider] : undefined
    return typeof key === 'string' && key.trim() ? key : undefined
  } catch { throw new CredentialError('云端 AI 私密配置无效') }
}
export async function readAiCredential(env: Env, provider: string): Promise<string | undefined> {
  try {
    const stored = await env.FILES.get(objectKey(provider))
    if (!stored) return legacyKey(env, provider)
    if (stored.size > 8192) unavailable()
    const value = await stored.json<{ version?: unknown; disabled?: unknown; iv?: unknown; ciphertext?: unknown }>()
    if (value.version !== 1) unavailable()
    // A persistent tombstone prevents a legacy Secret from silently reviving a deleted key.
    if (value.disabled === true) return undefined
    if (typeof value.iv !== 'string' || typeof value.ciphertext !== 'string') unavailable()
    const iv = decoded(value.iv)
    if (iv.length !== 12) unavailable()
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(provider) }, await masterKey(env), decoded(value.ciphertext))
    const key = new TextDecoder().decode(plaintext)
    if (!key.trim() || key.length > 4096 || /[\r\n\u0000]/.test(key)) unavailable()
    return key
  } catch (error) { if (error instanceof CredentialError) throw error; return unavailable() }
}
export async function saveAiCredential(env: Env, provider: string, key: string): Promise<void> {
  if (!key.trim() || key.length > 4096 || /[\r\n\u0000]/.test(key)) throw new CredentialError('API Key 必须为 1–4096 个字符，且不能包含换行或空字符', 400)
  try {
    const master = await masterKey(env)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(provider) }, master, encoder.encode(key))
    await env.FILES.put(objectKey(provider), JSON.stringify({ version: 1, iv: encoded(iv), ciphertext: encoded(new Uint8Array(ciphertext)) }), { httpMetadata: { contentType: 'application/json' } })
  } catch (error) { if (error instanceof CredentialError) throw error; unavailable() }
}
export async function deleteAiCredential(env: Env, provider: string): Promise<void> {
  try { await env.FILES.put(objectKey(provider), JSON.stringify({ version: 1, disabled: true }), { httpMetadata: { contentType: 'application/json' } }) }
  catch { unavailable() }
}
