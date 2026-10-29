import { body, boundedBytes, hash, json, secret } from './auth'
import { ApiError, validDriveId, validResourceKey } from './store'
import { deleteDriveCredential, driveConfigured, readDriveCredential, saveDriveCredential, type DriveCredential } from './drive-credentials'
import type { DriveFileInfo, DriveFlowResult } from '../../src/drive/types'
const scope = 'https://www.googleapis.com/auth/drive.file'
export function parseDriveUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) throw new ApiError(400, 'Google Drive 链接无效')
  let url: URL
  try { url = new URL(value) } catch { throw new ApiError(400, 'Google Drive 链接无效') }
  if (url.protocol !== 'https:' || !['drive.google.com', 'docs.google.com'].includes(url.hostname) || url.username || url.password || url.port || url.hash) throw new ApiError(400, 'Google Drive 链接无效')
  const match = url.pathname.match(/^\/(?:file\/d|document\/d|spreadsheets\/d|presentation\/d|drawings\/d|forms\/d)\/([-_A-Za-z0-9]+)(?:\/(?:edit|view|preview))?\/?$/)
  const id = match?.[1] ?? (['/open', '/uc'].includes(url.pathname) ? url.searchParams.get('id') : undefined)
  const resource_key = url.searchParams.get('resourcekey') ?? undefined
  if (!validDriveId(id) || !validResourceKey(resource_key)) throw new ApiError(400, 'Google Drive 链接无效')
  return { file_id: id, ...(resource_key ? { resource_key } : {}) }
}
// No caller-controlled URLs or redirects may receive the OAuth bearer credential.
async function google(url: string, options: RequestInit = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, { ...options, redirect: 'manual', signal: controller.signal })
    if (response.status >= 300 && response.status < 400) throw new ApiError(502, 'Google Drive 服务发生意外跳转，请稍后重试')
    const bytes = await boundedBytes(response, 65536)
    let data: Record<string, unknown>
    try { data = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new ApiError(502, 'Google Drive 服务响应无效，请稍后重试') }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ApiError(502, 'Google Drive 服务响应无效，请稍后重试')
    return { status: response.status, data }
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(502, '暂时无法访问 Google Drive，请稍后重试') }
  finally { clearTimeout(timer) }
}
interface Flow { id: string; device: string; state: string; verifier: string; poll: string; expires: number; generation: number; result: string | null; claimed: number; purpose: string; requested_id: string | null; requested_key: string | null }
// Inspect only fixed Google codes, never descriptions or project/account details.
function checkGoogleApiError(response: { status: number; data: Record<string, unknown> }) {
  if (response.status === 200) return
  const error = response.data.error as { status?: unknown; errors?: unknown; details?: unknown } | undefined
  const codes = new Set<string>()
  if (typeof error?.status === 'string') codes.add(error.status)
  for (const items of [error?.errors, error?.details]) if (Array.isArray(items)) for (const item of items) {
    if (item && typeof item === 'object' && typeof item.reason === 'string') codes.add(item.reason)
  }
  if (response.status === 403 && ['accessNotConfigured', 'SERVICE_DISABLED'].some(code => codes.has(code))) throw new ApiError(503, 'Google Drive API 尚未启用，请在 Google Cloud 项目中启用后重试')
  if (response.status === 429 || response.status === 403 && ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded', 'RESOURCE_EXHAUSTED'].some(code => codes.has(code))) throw new ApiError(429, 'Google Drive 请求额度已用尽，请稍后重试')
  if (response.status === 401 || response.status === 403 && ['UNAUTHENTICATED', 'authError', 'insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'].some(code => codes.has(code))) throw new ApiError(409, 'Google Drive 授权已失效或权限不足，请重新连接')
}
function accountText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).length > maxBytes || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return
  return value.trim()
}
export class Drive {
  constructor(private ctx: DurableObjectState, private env: Env) {
    this.sql.exec('CREATE TABLE IF NOT EXISTS drive_meta(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL); INSERT OR IGNORE INTO drive_meta VALUES(1,0); CREATE TABLE IF NOT EXISTS drive_flows(id TEXT PRIMARY KEY,device TEXT,state TEXT UNIQUE,verifier TEXT,poll TEXT,expires INTEGER,generation INTEGER,result TEXT,claimed INTEGER DEFAULT 0,purpose TEXT,requested_id TEXT,requested_key TEXT)')
    if(!this.sql.exec('PRAGMA table_info(drive_flows)').toArray().some(row=>row.name==='requested_id'))this.sql.exec('ALTER TABLE drive_flows ADD COLUMN requested_id TEXT')
    if(!this.sql.exec('PRAGMA table_info(drive_flows)').toArray().some(row=>row.name==='requested_key'))this.sql.exec('ALTER TABLE drive_flows ADD COLUMN requested_key TEXT')
  }
  private get sql() { return this.ctx.storage.sql }
  private generation() { return Number(this.sql.exec('SELECT generation FROM drive_meta WHERE id=1').one().generation) }
  private alive(device: string) { return this.sql.exec('SELECT id FROM devices WHERE id=? AND revoked=0', device).toArray().length > 0 }
  private guard(device: string, generation: number, expires = Infinity) { if (!this.alive(device) || this.generation() !== generation || expires < Date.now()) throw new ApiError(409, 'Google Drive 授权已变更，请重新操作') }
  private async locked<T>(action: () => Promise<T>): Promise<T> {
    // A rejected blockConcurrencyWhile callback resets the DO. Propagate API errors outside the gate.
    const outcome = await this.ctx.blockConcurrencyWhile(async () => {
      try { return { ok: true as const, value: await action() } } catch(error) { return { ok: false as const, error } }
    })
    if(!outcome.ok)throw outcome.error
    return outcome.value
  }
  private async token(fields: Record<string, string>) {
    const response = await google('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...fields, client_id: this.env.DRIVE_GOOGLE_CLIENT_ID!, client_secret: this.env.DRIVE_GOOGLE_CLIENT_SECRET! }) })
    if (response.status !== 200 || typeof response.data.access_token !== 'string' || !response.data.access_token.trim() || response.data.access_token.length>4096 || /[\u0000-\u0020\u007f]/.test(response.data.access_token)) throw new ApiError(response.status === 400 || response.status === 401 ? 409 : 502, 'Google Drive 授权已失效，请重新连接')
    if ((fields.grant_type==='authorization_code'&&response.data.scope===undefined) || response.data.scope!==undefined&&response.data.scope!==scope) throw new ApiError(403, 'Google Drive 授权范围无效，请重新连接')
    if(response.data.refresh_token!==undefined&&(typeof response.data.refresh_token!=='string'||!response.data.refresh_token.trim()||response.data.refresh_token.length>4096||/[\u0000-\u0020\u007f]/.test(response.data.refresh_token)))throw new ApiError(502,'Google Drive 服务响应无效，请稍后重试')
    return response.data
  }
  private async credential(device: string, generation: number): Promise<DriveCredential> {
    let credential = await this.locked(() => readDriveCredential(this.env))
    this.guard(device, generation)
    if (!credential || credential.needs_reconnect) throw new ApiError(409, 'Google Drive 授权已失效，请重新连接')
    if (credential.expires_at > Date.now() + 30000) return credential
    try {
      const token = await this.token({ grant_type: 'refresh_token', refresh_token: credential.refresh_token })
      credential = { ...credential, access_token: String(token.access_token), ...(typeof token.refresh_token==='string'?{refresh_token:token.refresh_token}:{}), expires_at: Date.now() + Math.min(Number(token.expires_in) || 3600, 3600) * 1000 }
      await this.locked(async () => { this.guard(device, generation); await saveDriveCredential(this.env, credential!) })
      return credential
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) await this.locked(async () => { this.guard(device, generation); await saveDriveCredential(this.env, { ...credential!, needs_reconnect: true }) })
      throw error
    }
  }
  private async metadata(credential: DriveCredential, id: string, resourceKey?: string): Promise<DriveFileInfo | undefined> {
    const response = await google(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType,trashed,resourceKey&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${credential.access_token}`, ...(resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${id}/${resourceKey}` } : {}) } })
    checkGoogleApiError(response)
    if (response.status === 403 || response.status === 404) return
    const data = response.data
    if (response.status !== 200) throw new ApiError(502, '暂时无法获取 Google Drive 文件信息')
    if (data.trashed === true) return
    if (data.id !== id || typeof data.name !== 'string' || !data.name.trim() || new TextEncoder().encode(data.name).length > 1024 || /[\u0000-\u001f\u007f-\u009f]/.test(data.name) || typeof data.mimeType !== 'string' || data.mimeType === 'application/vnd.google-apps.folder' || !validResourceKey(data.resourceKey)) throw new ApiError(400, '不支持此 Google Drive 文件或文件夹')
    return { id, name: data.name, mime_type: data.mimeType, ...(typeof data.resourceKey === 'string' ? { resource_key: data.resourceKey } : resourceKey ? { resource_key: resourceKey } : {}) }
  }
  async route(request: Request, device: string) {
    const path = new URL(request.url).pathname
    if (path === '/api/drive/status' && request.method === 'GET') {
      if (!driveConfigured(this.env)) return json({ configured: false, connected: false })
      const credential = await this.locked(() => readDriveCredential(this.env))
      return json({ configured: true, connected: !!credential, ...(credential ? { account_name: credential.name, account_email: credential.email, needs_reconnect: !!credential.needs_reconnect } : {}) })
    }
    if (path === '/api/drive/connection' && request.method === 'DELETE') {
      await this.locked(async () => { this.sql.exec('UPDATE drive_meta SET generation=generation+1 WHERE id=1'); this.sql.exec('DELETE FROM drive_flows'); await deleteDriveCredential(this.env) })
      return json({ disconnected: true })
    }
    if (!driveConfigured(this.env)) throw new ApiError(503, 'Google Drive 尚未配置，请先配置独立的 Google Drive OAuth 与加密密钥')
    if (path === '/api/drive/flows' && request.method === 'POST') {
      const generation=this.generation()
      const input = await body(request)
      if (!['connect', 'pick'].includes(String(input.purpose)) || input.file_id !== undefined && !validDriveId(input.file_id) || !validResourceKey(input.resource_key)) throw new ApiError(400, 'Google Drive 文件选择无效')
      const id = crypto.randomUUID(), state = secret(), verifier = secret(), poll = secret(), expires = Date.now() + 600000
      const [stateHash, pollHash, challenge] = await Promise.all([hash(state), hash(poll), crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))])
      this.guard(device, generation)
      this.sql.exec('DELETE FROM drive_flows WHERE expires<?', Date.now())
      if(Number(this.sql.exec('SELECT COUNT(*) AS n FROM drive_flows').one().n)>=100)throw new ApiError(429,'待完成的 Google Drive 授权过多，请稍后重试')
      this.sql.exec('INSERT INTO drive_flows(id,device,state,verifier,poll,expires,generation,purpose,requested_id,requested_key) VALUES(?,?,?,?,?,?,?,?,?,?)', id, device, stateHash, verifier, pollHash, expires, generation, String(input.purpose), typeof input.file_id==='string'?input.file_id:null, typeof input.resource_key==='string'?input.resource_key:null)
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      const params: Record<string, string> = { client_id: this.env.DRIVE_GOOGLE_CLIENT_ID!, redirect_uri: `${new URL(this.env.PUBLIC_ORIGIN!).origin}/api/drive/callback`, response_type: 'code', scope, include_granted_scopes: 'false', access_type: 'offline', prompt: 'consent select_account', state, code_challenge: btoa(String.fromCharCode(...new Uint8Array(challenge))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), code_challenge_method: 'S256', ...(input.purpose === 'pick' ? { trigger_onepick: 'true', allow_multiple: 'true', allow_folder_selection: 'false' } : {}) }
      if (typeof input.file_id === 'string') params.file_ids = input.file_id
      url.search = new URLSearchParams(params).toString()
      return json({ flow_id: id, poll_secret: poll, authorization_url: url.href, expires_at: new Date(expires).toISOString() })
    }
    const poll = path.match(/^\/api\/drive\/flows\/([\w-]+)\/poll$/)
    if (poll && request.method === 'POST') {
      const input = await body(request)
      if(typeof input.poll_secret!=='string'||input.poll_secret.length>256)throw new ApiError(404,'Google Drive 授权流程不存在或已失效')
      const pollHash=await hash(input.poll_secret)
      const row = this.sql.exec('SELECT * FROM drive_flows WHERE id=?', poll[1]).toArray()[0]
      if (!row || row.device !== device || row.poll !== pollHash) throw new ApiError(404, 'Google Drive 授权流程不存在或已失效')
      if (Number(row.expires) < Date.now() || Number(row.generation)!==this.generation()) { this.sql.exec('DELETE FROM drive_flows WHERE id=?', poll[1]); return json({ state: 'expired' }) }
      if (!row.result) return json({ state: 'pending' })
      this.sql.exec('DELETE FROM drive_flows WHERE id=?', poll[1])
      return json(JSON.parse(String(row.result)))
    }
    if (['/api/drive/files/resolve', '/api/drive/files/refresh'].includes(path) && request.method === 'POST') {
      const input = await body(request), resolve = path.endsWith('/resolve'), selection = resolve ? parseDriveUrl(input.url) : { file_id: input.drive_id, resource_key: input.resource_key }
      if (!validDriveId(selection.file_id) || !validResourceKey(selection.resource_key)) throw new ApiError(400, 'Google Drive 文件信息无效')
      const generation = this.generation(), credential = await this.credential(device, generation)
      let file: DriveFileInfo | undefined
      try { file = await this.metadata(credential, selection.file_id, selection.resource_key) } catch(error) {
        if(error instanceof ApiError && error.status===409) await this.locked(async()=>{this.guard(device,generation);await saveDriveCredential(this.env,{...credential,needs_reconnect:true})})
        throw error
      }
      this.guard(device, generation)
      return json(resolve ? file ? { state: 'ready', file } : { state: 'selection_required', ...selection } : { ...(file ? { file } : {}), unavailable: !file })
    }
    throw new ApiError(404, 'Google Drive 接口不存在')
  }
  async callback(request: Request) {
    const url = new URL(request.url), state = url.searchParams.get('state') || ''
    if(state.length>256)return completion()
    const row = this.sql.exec('SELECT * FROM drive_flows WHERE state=?', await hash(state)).toArray()[0] as unknown as Flow | undefined
    if (!row || row.claimed || row.expires < Date.now()) return completion()
    this.sql.exec('UPDATE drive_flows SET claimed=1 WHERE id=?', row.id)
    let result: DriveFlowResult = { state: 'failed', error: 'Google Drive 授权未完成，请重新尝试' }
    try {
      this.guard(row.device, row.generation, row.expires)
      const code = url.searchParams.get('code')
      if (!code || code.length > 4096 || url.searchParams.has('error')) throw new ApiError(400, '已取消 Google Drive 授权')
      const token = await this.token({ grant_type: 'authorization_code', code, code_verifier: row.verifier, redirect_uri: `${new URL(this.env.PUBLIC_ORIGIN!).origin}/api/drive/callback` })
      this.guard(row.device, row.generation, row.expires)
      const identity = await google('https://www.googleapis.com/drive/v3/about?fields=user(permissionId,displayName,emailAddress)', { headers: { Authorization: `Bearer ${token.access_token}` } })
      checkGoogleApiError(identity)
      if (identity.status === 403) throw new ApiError(409, '无法读取 Google Drive 账号信息，请检查账号权限后重新连接')
      if (identity.status !== 200) throw new ApiError(502, '暂时无法获取 Google Drive 账号信息，请稍后重试')
      const user = identity.data.user as Record<string, unknown> | undefined
      // permissionId binds the shared connection to one account. Optional profile fields do not.
      if (!user || typeof user.permissionId !== 'string' || !/^[-_A-Za-z0-9]{1,256}$/.test(user.permissionId)) throw new ApiError(502, 'Google Drive 未返回有效的账号标识，请重新连接')
      const email = accountText(user.emailAddress, 320)
      const name = accountText(user.displayName, 1024) ?? email ?? 'Google Drive 账号'
      const previous = await this.locked(() => readDriveCredential(this.env))
      this.guard(row.device, row.generation, row.expires)
      if (previous && previous.subject !== user.permissionId) throw new ApiError(409, '请先断开 Google Drive，再连接其他账号')
      const refresh = typeof token.refresh_token === 'string' ? token.refresh_token : previous?.refresh_token
      if (!refresh) throw new ApiError(409, 'Google Drive 授权已失效，请重新连接')
      const credential: DriveCredential = { access_token: String(token.access_token), refresh_token: refresh, expires_at: Date.now() + Math.min(Number(token.expires_in) || 3600, 3600) * 1000, subject: user.permissionId, name, ...(email ? { email } : {}) }
      const ids = row.purpose==='pick' ? (url.searchParams.get('picked_file_ids') || '').split(',').filter(Boolean) : []
      if (row.purpose === 'pick' && ids.length === 0) throw new ApiError(400, '未选择 Google Drive 文件')
      if(row.requested_id && (ids.length!==1 || ids[0]!==row.requested_id))throw new ApiError(400,'所选文件与粘贴的 Google Drive 链接不一致，请重试')
      if (ids.length > 100 || ids.some(id => !validDriveId(id))) throw new ApiError(400, 'Google Drive 文件选择无效')
      const files: DriveFileInfo[] = []
      for (const id of [...new Set(ids)]) { const file = await this.metadata(credential, id, row.requested_id===id ? row.requested_key??undefined : undefined); this.guard(row.device, row.generation, row.expires); if (file) files.push(file) }
      await this.locked(async () => {
        this.guard(row.device, row.generation, row.expires)
        const latest = await readDriveCredential(this.env)
        if (latest && latest.subject !== credential.subject) throw new ApiError(409, '请先断开 Google Drive，再连接其他账号')
        await saveDriveCredential(this.env, credential)
        this.sql.exec('UPDATE drive_meta SET generation=generation+1 WHERE id=1')
        this.sql.exec('UPDATE drive_flows SET generation=?,result=?,verifier=? WHERE id=?', this.generation(), JSON.stringify({state:'complete',files}), '', row.id)
      })
      return completion()
    } catch (error) { result = { state: 'failed', error: error instanceof ApiError ? error.message : 'Google Drive 授权未完成，请重新尝试' } }
    if (this.alive(row.device) && this.generation() === row.generation) this.sql.exec('UPDATE drive_flows SET result=?,verifier=? WHERE id=?', JSON.stringify(result), '', row.id)
    return completion()
  }
}
function completion() {
  return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>返回作业簿</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f6f8;color:#18202b;font:16px/1.8 system-ui,sans-serif}main{max-width:420px;margin:24px;padding:32px;border:1px solid #dfe4eb;border-radius:16px;background:white}h1{font-size:24px;margin:0 0 12px}p{margin:0;color:#586475}</style><main><h1>请返回作业簿</h1><p>Google Drive 授权操作已结束。请关闭此标签页并返回作业簿查看结果。</p></main></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff' } })
}
