import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const require = createRequire(realpathSync(new URL('../node_modules/wrangler/package.json', import.meta.url)))
const { build } = require('esbuild')
const { Miniflare, convertV4MiniflareOptions } = require('miniflare')
const origin = 'https://app.invalid'
const fileId = 'synthetic_file_123'
const scope = 'https://www.googleapis.com/auth/drive.file'
const built = await build({ entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'] })
async function setup(t, configured = true) {
  const controls = { status: 200, subject: 'synthetic-person', redirect: false, calls: [], token: 0 }
  const worker = new Miniflare(convertV4MiniflareOptions({ name: 'drive-test', modules: true, script: built.outputFiles[0].text, compatibilityDate: '2026-10-28', durableObjects: { SPACE: { className: 'PersonalSpace', useSQLite: true } }, r2Buckets: ['FILES'], bindings: { BOOTSTRAP_SECRET: 'synthetic-bootstrap', PUBLIC_ORIGIN: origin, ...(configured ? { DRIVE_GOOGLE_CLIENT_ID: 'synthetic-client', DRIVE_GOOGLE_CLIENT_SECRET: 'synthetic-secret', DRIVE_CREDENTIAL_ENCRYPTION_KEY: 'ab'.repeat(32) } : {}) }, outboundService: async request => {
    const url = new URL(request.url)
    controls.calls.push(url.href)
    if (url.href === 'https://oauth2.googleapis.com/token') {
      controls.token++
      if(controls.pause){controls.entered();await controls.pause}
      const fields = new URLSearchParams(await request.text())
      controls.lastTokenFields=fields
      assert.equal(fields.get('client_id'), 'synthetic-client')
      assert.equal(fields.get('client_secret'), 'synthetic-secret')
      if(controls.tokenError)return Response.json({error:'invalid_grant'},{status:400})
      if (controls.redirect) return new Response(null, { status: 307, headers: { Location: 'https://evil.invalid' } })
      return Response.json({ access_token: controls.accessToken ?? 'synthetic-access', refresh_token: controls.refreshToken ?? 'synthetic-refresh', expires_in: controls.expires ?? 3600, ...(controls.omitScope?{}:{scope:controls.scope??scope}) })
    }
    assert.equal(request.headers.get('authorization'), 'Bearer synthetic-access')
    if (url.pathname === '/drive/v3/about') {
      assert.equal(url.searchParams.get('fields'), 'user(permissionId,displayName,emailAddress)')
      return Response.json(controls.aboutStatus && controls.aboutStatus !== 200 ? { error: controls.aboutError } : controls.aboutData ?? { user: { permissionId: controls.subject, displayName: 'Synthetic account', emailAddress: 'synthetic@example.invalid' } }, { status: controls.aboutStatus ?? 200 })
    }
    if (url.pathname === `/drive/v3/files/${fileId}`) {
      controls.lastResourceKey=request.headers.get('X-Goog-Drive-Resource-Keys')
      if(controls.metadataRedirect)return new Response(null,{status:302,headers:{Location:'https://evil.invalid'}})
      assert.equal(url.searchParams.get('fields'), 'id,name,mimeType,trashed,resourceKey')
      assert.equal(url.searchParams.has('alt'), false)
      return Response.json(controls.status === 200 ? { id: fileId, name: 'Example.gdoc', mimeType: 'application/vnd.google-apps.document', ...(controls.omitResourceKey?{}:{resourceKey:'synthetic_key'}) } : { error: controls.metadataError ?? 'synthetic' }, { status: controls.status })
    }
    throw new Error('Unexpected outbound')
  } }))
  t.after(() => worker.dispose())
  const api = (path, options = {}) => worker.dispatchFetch(`${origin}${path}`, { redirect: 'manual', ...options })
  const init = await api('/api/bootstrap', { method: 'POST', body: JSON.stringify({ bootstrap_secret: 'synthetic-bootstrap', device_name: 'Test browser', client_type: 'web' }) })
  assert.equal(init.status, 200)
  const cookie = init.headers.getSetCookie().find(value => value.startsWith('__Host-homework_session=')).split(';')[0]
  const authed = (path, method = 'GET', value) => api(path, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) })
  const start = async (purpose = 'pick', extra = {}) => {
    const response = await authed('/api/drive/flows', 'POST', { purpose, ...extra })
    assert.equal(response.status, 200)
    return response.json()
  }
  const finish = async flow => api(`/api/drive/callback?${new URLSearchParams({ state: new URL(flow.authorization_url).searchParams.get('state'), code: 'synthetic-code', picked_file_ids: fileId })}`)
  const poll = flow => authed(`/api/drive/flows/${flow.flow_id}/poll`, 'POST', { poll_secret: flow.poll_secret })
  return { worker, api, authed, start, finish, poll, controls, cookie }
}
test('Drive metadata uses cookie-independent PKCE flow, encrypted R2, one-use device-bound polling and metadata-only boundaries', async t => {
  const f = await setup(t)
  assert.deepEqual(await (await f.authed('/api/drive/status')).json(), { configured: true, connected: false })
  assert.equal((await f.api('/api/drive/flows', { method: 'POST', body: JSON.stringify({ purpose: 'pick' }) })).status, 401)
  assert.equal((await f.api('/api/drive/flows', { method: 'POST', headers: { Cookie: f.cookie }, body: JSON.stringify({ purpose: 'pick' }) })).status, 403)
  const flow = await f.start()
  const url = new URL(flow.authorization_url)
  assert.equal(url.origin, 'https://accounts.google.com')
  assert.equal(url.searchParams.get('scope'), scope)
  assert.equal(url.searchParams.get('include_granted_scopes'), 'false')
  assert.equal(url.searchParams.get('trigger_onepick'), 'true')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.deepEqual(await (await f.poll(flow)).json(), { state: 'pending' })
  const callback = await f.finish(flow)
  assert.equal(callback.status, 200)
  assert.equal(callback.headers.getSetCookie().length, 0)
  assert.equal((await callback.text()).includes('synthetic'), false)
  assert.ok(callback.headers.get('Content-Security-Policy').includes("default-src 'none'"))
  const complete = await (await f.poll(flow)).json()
  assert.equal(complete.state, 'complete')
  assert.equal(complete.files[0].id, fileId)
  assert.equal((await f.poll(flow)).status, 404)
  const bucket = await f.worker.getR2Bucket('FILES')
  const object = await bucket.get('_private/drive-credentials/account')
  const encrypted = await object.text()
  assert.equal(encrypted.includes('synthetic-refresh'), false)
  assert.equal(encrypted.includes('synthetic-access'), false)
  const resolved = await (await f.authed('/api/drive/files/resolve', 'POST', { url: `https://docs.google.com/document/d/${fileId}/edit` })).json()
  assert.equal(resolved.state, 'ready')
  assert.equal(resolved.file.mime_type, 'application/vnd.google-apps.document')
  const snapshot = await (await f.authed('/api/snapshot')).json()
  assert.equal(JSON.stringify(snapshot).includes('synthetic-access'), false)
  assert.equal(snapshot.entities.length, 0)
  const sync = changes => f.authed('/api/sync', 'POST', { cursor: 0, operations: [{ operation_id: crypto.randomUUID(), changes }] })
  const mutation = { entity_type: 'file', entity_id: `gdrive-${fileId}`, data: { name: 'Example.gdoc', mime: 'application/vnd.google-apps.document', drive_id: fileId, drive_unavailable: 0 } }
  assert.equal((await sync([mutation])).status, 200)
  assert.equal((await f.authed(`/api/files/gdrive-${fileId}/content`, 'PUT', {})).status, 400)
  assert.equal((await f.authed('/api/ai/analyze', 'POST', { text: '', file_ids: [`gdrive-${fileId}`] })).status, 400)
  for (const data of [{ drive_id: 'another_file_123' }, { cloud_version: 'content/synthetic/abc' }, { drive_unavailable: 3 }, { drive_resource_key: 'bad\r\nkey' }, { drive_id: null }]) assert.equal((await sync([{ ...mutation, data }])).status, 400)
  assert.equal((await sync([{...mutation,data:{name:'Folder / document \\ name'}}])).status,200)
  assert.equal((await sync([{...mutation,data:{name:'bad\nname'}}])).status,400)
  f.controls.status = 404
  assert.deepEqual(await (await f.authed('/api/drive/files/refresh', 'POST', { drive_id: fileId })).json(), { unavailable: true })
  assert.equal((await (await f.authed('/api/drive/files/resolve', 'POST', { url: `https://drive.google.com/file/d/${fileId}/view` })).json()).state, 'selection_required')
  f.controls.status = 401
  assert.equal((await f.authed('/api/drive/files/refresh', 'POST', { drive_id: fileId })).status, 409)
  assert.equal((await (await f.authed('/api/drive/status')).json()).needs_reconnect, true)
})
test('Drive rejects hostile URLs, account replacement, redirects and disconnected or revoked pending flows', async t => {
  const f = await setup(t)
  for (const url of ['http://drive.google.com/open?id=synthetic_file_123', 'https://drive.google.com.evil.invalid/open?id=synthetic_file_123', 'https://user@drive.google.com/open?id=synthetic_file_123', 'https://drive.google.com:444/open?id=synthetic_file_123', 'https://docs.google.com/document/d/a/edit', 'https://drive.google.com/drive/folders/synthetic_file_123', 'https://example.invalid/synthetic_file_123', 'https://drive.google.com/open?id=synthetic_file_123&resourcekey=%0d%0a']) assert.equal((await f.authed('/api/drive/files/resolve', 'POST', { url })).status, 400, url)
  const connected = await f.start('connect')
  assert.equal(new URL(connected.authorization_url).searchParams.has('trigger_onepick'), false)
  await f.finish(connected)
  assert.equal((await (await f.poll(connected)).json()).state, 'complete')
  const other = await f.start()
  f.controls.subject = 'another-account'
  await f.finish(other)
  assert.equal((await (await f.poll(other)).json()).state, 'failed')
  assert.equal((await (await f.authed('/api/drive/status')).json()).connected, true)
  const redirected = await f.start()
  f.controls.redirect = true
  await f.finish(redirected)
  assert.equal((await (await f.poll(redirected)).json()).state, 'failed')
  assert.equal(f.controls.calls.some(url => url.includes('evil.invalid')), false)
  const pending = await f.start()
  const before = f.controls.token
  await f.authed('/api/drive/connection', 'DELETE')
  await f.finish(pending)
  assert.equal(f.controls.token, before)
  assert.deepEqual(await (await f.authed('/api/drive/status')).json(), { configured: true, connected: false })
  const revoked = await f.start()
  await f.authed('/api/logout', 'POST')
  await f.finish(revoked)
  assert.equal(f.controls.token, before)
})
test('Drive disabled configuration is readable and cannot start authorization', async t => {
  const f = await setup(t, false)
  assert.deepEqual(await (await f.authed('/api/drive/status')).json(), { configured: false, connected: false })
  assert.equal((await f.authed('/api/drive/flows', 'POST', { purpose: 'connect' })).status, 503)
})

test('Drive callback generation protects disconnect during token exchange; polls are exactly once and device-bound', async t => {
  const f = await setup(t)
  const paired = await (await f.api('/api/pair/start', {method:'POST',body:JSON.stringify({device_name:'Other desktop',client_type:'desktop'})})).json()
  await f.authed('/api/pair/approve','POST',{code:paired.code})
  const other = await (await f.api('/api/pair/poll',{method:'POST',body:JSON.stringify(paired)})).json()
  const flow = await f.start()
  const stolen = await f.api(`/api/drive/flows/${flow.flow_id}/poll`,{method:'POST',headers:{Authorization:`Bearer ${other.token}`},body:JSON.stringify({poll_secret:flow.poll_secret})})
  assert.equal(stolen.status,404)
  await f.finish(flow)
  const polled = await Promise.all([f.poll(flow),f.poll(flow)])
  assert.deepEqual(polled.map(value=>value.status).sort(),[200,404])
  const older = await f.start(), newer = await f.start()
  await f.finish(newer)
  assert.equal((await (await f.poll(newer)).json()).state,'complete')
  const before = f.controls.token
  await f.finish(older)
  assert.equal(f.controls.token,before)
  assert.equal((await (await f.poll(older)).json()).state,'expired')
  const pending = await f.start()
  let release, enter
  f.controls.pause = new Promise(resolve=>{release=resolve})
  const entered = new Promise(resolve=>{enter=resolve})
  f.controls.entered = enter
  const completing = f.finish(pending)
  await entered
  await f.authed('/api/drive/connection','DELETE')
  release()
  await completing
  assert.deepEqual(await (await f.authed('/api/drive/status')).json(),{configured:true,connected:false})
  const bucket = await f.worker.getR2Bucket('FILES')
  assert.equal(await bucket.get('_private/drive-credentials/account'),null)
})
test('Drive encrypted credential rejects tampering instead of exposing or accepting tokens', async t=>{
  const f=await setup(t),flow=await f.start('connect')
  await f.finish(flow)
  const bucket=await f.worker.getR2Bucket('FILES')
  const object=JSON.parse(await (await bucket.get('_private/drive-credentials/account')).text())
  object.ciphertext=object.ciphertext.slice(0,-8)+'AAAAAAAA'
  await bucket.put('_private/drive-credentials/account',JSON.stringify(object))
  const response=await f.authed('/api/drive/status')
  assert.equal(response.status,503)
  assert.equal((await response.text()).includes('synthetic-access'),false)
})

test('Drive refresh token exchange fails reconnect without reporting a missing file; metadata redirects fail closed', async t=>{
  const f=await setup(t)
  f.controls.expires=1
  const flow=await f.start('connect')
  await f.finish(flow)
  const before=f.controls.token
  const refresh=await f.authed('/api/drive/files/refresh','POST',{drive_id:fileId})
  assert.equal(refresh.status,200)
  assert.equal(f.controls.token,before+1)
  f.controls.metadataRedirect=true
  assert.equal((await f.authed('/api/drive/files/refresh','POST',{drive_id:fileId})).status,502)
  assert.equal(f.controls.calls.some(url=>url.includes('evil.invalid')),false)
  f.controls.metadataRedirect=false
  f.controls.tokenError=true
  const unavailable=await f.authed('/api/drive/files/refresh','POST',{drive_id:fileId})
  assert.equal(unavailable.status,409)
  assert.equal((await unavailable.json()).unavailable,undefined)
  assert.equal((await (await f.authed('/api/drive/status')).json()).needs_reconnect,true)
})

test('Drive picker enforces the pasted file filter and metadata name byte limits', async t=>{
  const f=await setup(t)
  const filtered=await f.start('pick',{file_id:'different_file_123'})
  assert.equal(new URL(filtered.authorization_url).searchParams.get('file_ids'),'different_file_123')
  await f.finish(filtered)
  const rejected=await (await f.poll(filtered)).json()
  assert.equal(rejected.state,'failed')
  assert.equal(f.controls.calls.some(url=>url.includes('/files/')),false)
  const accepted=await f.start('pick',{file_id:fileId})
  await f.finish(accepted)
  assert.equal((await (await f.poll(accepted)).json()).state,'complete')
  const save=name=>f.authed('/api/sync','POST',{cursor:0,operations:[{operation_id:crypto.randomUUID(),changes:[{entity_type:'file',entity_id:`gdrive-${fileId}`,data:{name,drive_id:fileId}}]}]})
  assert.equal((await save('字'.repeat(341))).status,200)
  assert.equal((await save('字'.repeat(342))).status,400)
})

test('Drive rejects empty tokens and missing or broader initial scopes; refresh tokens rotate privately', async t=>{
  const f=await setup(t)
  for(const change of [{accessToken:''},{omitScope:true},{scope:scope+' https://www.googleapis.com/auth/drive'}]){
    Object.assign(f.controls,{accessToken:undefined,omitScope:false,scope:undefined},change)
    const flow=await f.start('connect')
    await f.finish(flow)
    assert.equal((await (await f.poll(flow)).json()).state,'failed')
    assert.equal((await (await f.authed('/api/drive/status')).json()).connected,false)
  }
  Object.assign(f.controls,{accessToken:undefined,omitScope:false,scope:undefined,expires:1})
  const flow=await f.start('connect')
  await f.finish(flow)
  f.controls.refreshToken='synthetic-rotated-refresh'
  f.controls.omitScope=true
  assert.equal((await f.authed('/api/drive/files/refresh','POST',{drive_id:fileId})).status,200)
  assert.equal(f.controls.lastTokenFields.get('refresh_token'),'synthetic-refresh')
  assert.equal((await f.authed('/api/drive/files/refresh','POST',{drive_id:fileId})).status,200)
  assert.equal(f.controls.lastTokenFields.get('refresh_token'),'synthetic-rotated-refresh')
})

test('Drive disabled API and quota errors never mark metadata references unavailable or expose provider descriptions', async t=>{
  const f=await setup(t),flow=await f.start('connect')
  await f.finish(flow)
  f.controls.status=403
  for(const [metadataError,status] of [
    [{errors:[{reason:'accessNotConfigured'}]},503],
    [{status:'PERMISSION_DENIED',details:[{reason:'SERVICE_DISABLED'}]},503],
    ...['rateLimitExceeded','userRateLimitExceeded','dailyLimitExceeded','quotaExceeded'].map(reason=>[{errors:[{reason}]},429]),
    [{status:'RESOURCE_EXHAUSTED'},429],
    [{errors:[{reason:'insufficientPermissions'}]},409],
  ]){
    f.controls.metadataError={...metadataError,message:'private synthetic provider description'}
    const response=await f.authed('/api/drive/files/refresh','POST',{drive_id:fileId})
    assert.equal(response.status,status)
    const output=await response.json()
    assert.equal(output.unavailable,undefined)
    assert.equal(JSON.stringify(output).includes('private synthetic provider description'),false)
  }
  assert.equal((await (await f.authed('/api/drive/status')).json()).needs_reconnect,true)
})

test('Drive picker preserves the pasted security-update shared-link resource key privately', async t=>{
  const f=await setup(t)
  f.controls.omitResourceKey=true
  const flow=await f.start('pick',{file_id:fileId,resource_key:'shared_link_key'})
  assert.equal(new URL(flow.authorization_url).searchParams.has('resource_key'),false)
  await f.finish(flow)
  assert.equal(f.controls.lastResourceKey,`${fileId}/shared_link_key`)
  const result=await (await f.poll(flow)).json()
  assert.equal(result.state,'complete')
  assert.equal(result.files[0].resource_key,'shared_link_key')
})

test('Drive about API errors give safe actionable failures without credentials, then a fresh flow can retry', async t => {
  const f = await setup(t)
  const bucket = await f.worker.getR2Bucket('FILES')
  for (const [aboutStatus, aboutError, expected] of [
    [403, { errors: [{ reason: 'accessNotConfigured' }] }, 'Google Drive API 尚未启用，请在 Google Cloud 项目中启用后重试'],
    [403, { status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] }, 'Google Drive API 尚未启用，请在 Google Cloud 项目中启用后重试'],
    ...['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded'].map(reason => [403, { errors: [{ reason }] }, 'Google Drive 请求额度已用尽，请稍后重试']),
    [403, { status: 'RESOURCE_EXHAUSTED' }, 'Google Drive 请求额度已用尽，请稍后重试'],
    [429, {}, 'Google Drive 请求额度已用尽，请稍后重试'],
    ...['insufficientPermissions', 'authError', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'].map(reason => [403, { errors: [{ reason }] }, 'Google Drive 授权已失效或权限不足，请重新连接']),
    [401, { status: 'UNAUTHENTICATED' }, 'Google Drive 授权已失效或权限不足，请重新连接'],
    [403, {}, '无法读取 Google Drive 账号信息，请检查账号权限后重新连接'],
    [500, {}, '暂时无法获取 Google Drive 账号信息，请稍后重试'],
    [404, {}, '暂时无法获取 Google Drive 账号信息，请稍后重试'],
  ]) {
    Object.assign(f.controls, { aboutStatus, aboutError: { ...aboutError, message: 'private synthetic provider description', secret: 'synthetic-access' } })
    const flow = await f.start('connect')
    const callback = await f.finish(flow)
    assert.equal((await callback.text()).includes('synthetic'), false)
    assert.deepEqual(await (await f.poll(flow)).json(), { state: 'failed', error: expected })
    assert.equal(await bucket.get('_private/drive-credentials/account'), null)
    assert.deepEqual(await (await f.authed('/api/drive/status')).json(), { configured: true, connected: false })
  }
  f.controls.aboutStatus = 200
  const retry = await f.start('connect')
  await f.finish(retry)
  assert.deepEqual(await (await f.poll(retry)).json(), { state: 'complete', files: [] })
  assert.equal((await (await f.authed('/api/drive/status')).json()).connected, true)
  const encrypted = await (await bucket.get('_private/drive-credentials/account')).text()
  for (const value of ['synthetic-access', 'synthetic-refresh', 'synthetic-person', 'Synthetic account']) assert.equal(encrypted.includes(value), false)
})

test('Drive account identity requires a stable ID but optional display fields safely fall back and persist encrypted', async t => {
  const f = await setup(t)
  const bucket = await f.worker.getR2Bucket('FILES')
  for (const aboutData of [{}, { user: null }, { user: [] }, ...[undefined, null, 123, '', ' ', 'bad\nidentifier', 'x'.repeat(257)].map(permissionId => ({ user: { permissionId, displayName: 'Synthetic account' } }))]) {
    f.controls.aboutData = aboutData
    const flow = await f.start('connect')
    await f.finish(flow)
    assert.deepEqual(await (await f.poll(flow)).json(), { state: 'failed', error: 'Google Drive 未返回有效的账号标识，请重新连接' })
    assert.equal(await bucket.get('_private/drive-credentials/account'), null)
    assert.equal((await (await f.authed('/api/drive/status')).json()).connected, false)
  }
  for (const [optional, name, email] of [
    [{ emailAddress: 'synthetic@example.invalid' }, 'synthetic@example.invalid', 'synthetic@example.invalid'],
    [{}, 'Google Drive 账号', undefined],
    [{ displayName: null, emailAddress: null }, 'Google Drive 账号', undefined],
    [{ displayName: ' \n', emailAddress: 'bad\nemail' }, 'Google Drive 账号', undefined],
    [{ displayName: '字'.repeat(342), emailAddress: 'x'.repeat(321) }, 'Google Drive 账号', undefined],
    [{ displayName: '  Synthetic account  ' }, 'Synthetic account', undefined],
  ]) {
    f.controls.aboutData = { user: { permissionId: 'synthetic-person', ...optional } }
    const flow = await f.start('pick')
    assert.equal(new URL(flow.authorization_url).searchParams.get('scope'), scope)
    await f.finish(flow)
    const result = await (await f.poll(flow)).json()
    assert.equal(result.state, 'complete')
    assert.equal(result.files[0].id, fileId)
    const expected = { configured: true, connected: true, account_name: name, ...(email ? { account_email: email } : {}), needs_reconnect: false }
    // Status re-reads R2 on each request, so a refresh observes the persisted connection.
    assert.deepEqual(await (await f.authed('/api/drive/status')).json(), expected)
    assert.deepEqual(await (await f.authed('/api/drive/status')).json(), expected)
    const serialized = await (await bucket.get('_private/drive-credentials/account')).text()
    for (const privateValue of ['synthetic-access', 'synthetic-refresh', 'synthetic-person', name]) assert.equal(serialized.includes(privateValue), false)
    const envelope = JSON.parse(serialized)
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(0xab), 'AES-GCM', false, ['decrypt'])
    const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(envelope.iv, 'base64'), additionalData: new TextEncoder().encode('_private/drive-credentials/account') }, key, Buffer.from(envelope.ciphertext, 'base64'))
    const saved = JSON.parse(new TextDecoder().decode(raw))
    assert.equal(saved.subject, 'synthetic-person')
    assert.equal(saved.name, name)
    assert.equal(saved.email, email)
    assert.equal(saved.refresh_token, 'synthetic-refresh')
    await f.authed('/api/drive/connection', 'DELETE')
  }
})
