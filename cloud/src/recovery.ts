import { Auth, hash, secret, sessionCookie, boundedBytes, json } from './auth'
import { ApiError } from './store'

type RecoveryFailureCode = 'token_config' | 'token_code' | 'token_redirect' | 'token_network' | 'token_response' | 'identity_network' | 'identity_denied' | 'identity_response' | 'bind_session' | 'bind_storage' | 'session_issue'
class RecoveryFailure extends ApiError {
  constructor(readonly reason: RecoveryFailureCode) { super(502, 'Identity authorization could not be completed') }
}

export const identityProviders = ['github', 'google'] as const
function config(env: Env, provider: string) {
  if (provider === 'github' && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) return { id: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET, authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', identity: 'https://api.github.com/user', scope: 'read:user' }
  if (provider === 'google' && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) return { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET, authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', identity: 'https://openidconnect.googleapis.com/v1/userinfo', scope: 'openid profile' }
  throw new ApiError(404, 'Recovery provider unavailable')
}
function publicOrigin(env: Env) {
  const origin = env.PUBLIC_ORIGIN
  if (!origin || !origin.startsWith('https://')) throw new ApiError(503, 'Recovery not configured')
  try { if (new URL(origin).origin !== origin) throw 0 } catch { throw new ApiError(503, 'Recovery not configured') }
  return origin
}
const clearCookie = '__Host-homework_oauth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
function redirect(origin: string, result: string, provider: string, failed = false) {
  const target = new URL(origin)
  target.searchParams.set(failed ? 'auth_error' : 'auth', result)
  target.searchParams.set('provider', provider)
  return new Response(null, { status: 303, headers: { Location: target.href, 'Set-Cookie': clearCookie, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
}
function base64url(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') }
export async function providerStatus(request: Request, env: Env, auth: Auth) {
  const device = await auth.authenticate(request, true)
  return json({ providers: identityProviders.map(id => {
    let enabled = false
    try { config(env, id); publicOrigin(env); enabled = true } catch { /* Incomplete private configuration is unavailable. */ }
    return { id, enabled, ...(device ? { bound: auth.sql.exec('SELECT subject FROM identities WHERE provider=?', id).toArray().length > 0 } : {}) }
  }) })
}
export function unlinkIdentity(auth: Auth, provider: string) {
  if (!identityProviders.includes(provider as typeof identityProviders[number])) throw new ApiError(404, 'Not found')
  auth.sql.exec('DELETE FROM identities WHERE provider=?', provider)
  // Invalidate pending authorization states before another tab begins its callback.
  auth.sql.exec('DELETE FROM oauth WHERE provider=?', provider)
  return json({ removed: true })
}
export async function recovery(request: Request, env: Env, auth: Auth, provider: string, action: string) {
  await auth.rate(request, 'recovery')
  const cfg = config(env, provider), origin = publicOrigin(env)
  const callback = `${origin}/api/recovery/${provider}/callback`, url = new URL(request.url)
  if (action === 'start') {
    if (request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError(403, 'Same-origin request required')
    // The OAuth state cookie and callback must live on the same canonical host.
    if (url.origin !== origin) return new Response(null, { status: 303, headers: { Location: `${origin}${url.pathname}${url.search}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
    const intent = url.searchParams.get('intent')
    if (intent && !['bind', 'login'].includes(intent)) throw new ApiError(400, 'Invalid authorization intent')
    const device = intent === 'login' ? undefined : await auth.authenticate(request, intent !== 'bind')
    if (device && device.client_type !== 'web') throw new ApiError(403, 'Existing browser authorization required')
    const state = secret(), verifier = secret(), challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
    auth.sql.exec('DELETE FROM oauth WHERE expires<?', Date.now())
    auth.sql.exec('INSERT INTO oauth(state,provider,verifier,expires,device_id) VALUES(?,?,?,?,?)', await hash(state), provider, verifier, Date.now() + 600000, device?.id ?? null)
    const target = new URL(cfg.authorize)
    for (const [key, value] of Object.entries({ client_id: cfg.id, redirect_uri: callback, response_type: 'code', scope: cfg.scope, state, code_challenge: challenge, code_challenge_method: 'S256', ...(provider === 'google' ? { prompt: 'select_account' } : {}) })) target.searchParams.set(key, value)
    return new Response(null, { status: 302, headers: { Location: target.href, 'Set-Cookie': `__Host-homework_oauth=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
  }
  if (action !== 'callback') throw new ApiError(404, 'Not found')
  const state = url.searchParams.get('state'), code = url.searchParams.get('code'), cookie = request.headers.get('cookie')?.match(/(?:^|;\s*)__Host-homework_oauth=([^;]+)/)?.[1]
  if (!state || state.length > 200 || state !== cookie) throw new ApiError(403, 'Invalid recovery state')
  const stateHash = await hash(state), record = auth.sql.exec('SELECT * FROM oauth WHERE state=? AND provider=? AND expires>?', stateHash, provider, Date.now()).toArray()[0]
  if (!record) throw new ApiError(403, 'Recovery state expired')
  // Consume before any provider requests; errors and cancellation cannot replay state.
  auth.sql.exec('DELETE FROM oauth WHERE state=?', stateHash)
  if (url.searchParams.has('error')) return redirect(origin, 'cancelled', provider, true)
  if (!code || code.length > 4096) throw new ApiError(403, 'Recovery authorization failed')
  // Workers supports follow/manual, but rejects redirect:error before sending.
  // Never follow provider redirects carrying authorization codes or bearer tokens.
  let response: Response
  try {
    response = await fetch(cfg.token, { method: 'POST', redirect: 'manual', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Homework-Personal-Cloud' }, body: new URLSearchParams({ client_id: cfg.id, client_secret: cfg.secret, code, redirect_uri: callback, grant_type: 'authorization_code', code_verifier: String(record.verifier) }), signal: AbortSignal.timeout(15000) })
  } catch { throw new RecoveryFailure('token_network') }
  if (response.status >= 300 && response.status < 400) throw new ApiError(502, 'Identity provider unavailable')
  let result: { access_token?: string; error?: string }
  try { result = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 2 * 1024 * 1024))) } catch { throw new RecoveryFailure('token_response') }
  // GitHub reports OAuth errors as HTTP 200 JSON. Only fixed error categories
  // may leave this boundary; provider descriptions can contain sensitive data.
  if (result?.error === 'incorrect_client_credentials' || result?.error === 'invalid_client') throw new RecoveryFailure('token_config')
  if (result?.error === 'bad_verification_code' || result?.error === 'invalid_grant') throw new RecoveryFailure('token_code')
  if (result?.error === 'redirect_uri_mismatch') throw new RecoveryFailure('token_redirect')
  if (!response.ok) throw new ApiError(502, 'Identity provider unavailable')
  if (typeof result?.access_token !== 'string' || !result.access_token || result.access_token.length > 16384 || result.error) throw new RecoveryFailure('token_response')
  let identityResponse: Response
  try {
    identityResponse = await fetch(cfg.identity, { redirect: 'manual', headers: { Authorization: `Bearer ${result.access_token}`, 'User-Agent': 'Homework-Personal-Cloud', Accept: provider === 'github' ? 'application/vnd.github+json' : 'application/json' }, signal: AbortSignal.timeout(15000) })
  } catch { throw new RecoveryFailure('identity_network') }
  if (!identityResponse.ok) throw new RecoveryFailure('identity_denied')
  let identity: { id?: number | string; sub?: string }
  try { identity = JSON.parse(new TextDecoder().decode(await boundedBytes(identityResponse, 2 * 1024 * 1024))) } catch { throw new RecoveryFailure('identity_response') }
  const subject = provider === 'github' ? (typeof identity?.id === 'number' && Number.isSafeInteger(identity.id) && identity.id > 0 ? String(identity.id) : typeof identity?.id === 'string' && /^[1-9]\d*$/.test(identity.id) ? identity.id : '') : identity?.sub
  if (typeof subject !== 'string' || !subject || subject.length > 255) throw new RecoveryFailure('identity_response')
  if (record.device_id) {
    let current
    try { current = await auth.authenticate(request) } catch { throw new RecoveryFailure('bind_session') }
    if (current?.id !== record.device_id || current.client_type !== 'web') throw new RecoveryFailure('bind_session')
    // No await between checking and inserting: concurrent binds cannot replace an identity.
    const existing = auth.sql.exec('SELECT subject FROM identities WHERE provider=?', provider).toArray()[0]
    if (existing && existing.subject !== subject) throw new ApiError(409, 'Provider already bound')
    try { auth.sql.exec('INSERT INTO identities(provider,subject) VALUES(?,?) ON CONFLICT(provider) DO NOTHING', provider, subject) } catch { throw new RecoveryFailure('bind_storage') }
    return redirect(origin, 'bound', provider)
  }
  const existing = auth.sql.exec('SELECT subject FROM identities WHERE provider=?', provider).toArray()[0]
  if (!existing || existing.subject !== subject) throw new ApiError(403, 'Identity is not bound to this space')
  let recovered
  try { recovered = await auth.issue(`${provider === 'github' ? 'GitHub' : 'Google'} 浏览器`, 'web') } catch { throw new RecoveryFailure('session_issue') }
  const responseRedirect = redirect(origin, 'complete', provider)
  responseRedirect.headers.append('Set-Cookie', sessionCookie(recovered.token))
  return responseRedirect
}
// Navigation errors return to the app; never show provider tokens or raw error pages.
export async function recoveryNavigation(request: Request, env: Env, auth: Auth, provider: string, action: string) {
  try { return await recovery(request, env, auth, provider, action) } catch (error) {
    const message = error instanceof ApiError ? error.message : ''
    const reason = error instanceof RecoveryFailure ? error.reason : message.includes('not bound') ? 'unbound' : message === 'Provider already bound' ? 'already_bound' : message.includes('state') ? 'state' : message.includes('authorization required') ? 'session' : message.includes('unavailable') || message === 'Recovery not configured' ? 'unavailable' : error instanceof ApiError && error.status === 429 ? 'rate' : 'failed'
    return redirect(new URL(request.url).origin, reason, provider, true)
  }
}
