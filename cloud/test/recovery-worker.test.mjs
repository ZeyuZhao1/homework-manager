import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(realpathSync(new URL('../node_modules/wrangler/package.json', import.meta.url)))
const { build } = require('esbuild')
const { Miniflare, convertV4MiniflareOptions } = require('miniflare')
const origin = 'https://app.invalid'
const bootstrap = 'synthetic-worker-test-bootstrap'

function cookie(response, name) {
  const values = response.headers.getSetCookie()
  const value = values.find(value => value.startsWith(`${name}=`))
  assert.ok(value, `Expected ${name} cookie`)
  return value.split(';')[0]
}

test('real Worker SQLite binds GitHub and recovers a fresh browser session', async t => {
  const built = await build({
    entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    external: ['cloudflare:workers'],
  })
  let tokenError, redirectStage
  let unexpectedRequests = 0
  const exchanges = []
  const worker = new Miniflare(convertV4MiniflareOptions({
    name: 'recovery-test',
    modules: true, script: built.outputFiles[0].text, compatibilityDate: '2026-10-28',
    durableObjects: { SPACE: { className: 'PersonalSpace', useSQLite: true } },
    r2Buckets: ['FILES'],
    bindings: {
      PUBLIC_ORIGIN: origin, BOOTSTRAP_SECRET: bootstrap,
      GITHUB_CLIENT_ID: 'synthetic-client', GITHUB_CLIENT_SECRET: 'synthetic-secret',
    },
    outboundService: async request => {
      const url = new URL(request.url)
      if (url.href === 'https://github.com/login/oauth/access_token') {
        const body = new URLSearchParams(await request.text())
        exchanges.push(body)
        if (redirectStage === 'token') return new Response(null, { status: 307, headers: { Location: 'https://redirect.invalid/collect' } })
        return Response.json(tokenError ? { error: tokenError } : { access_token: 'synthetic-access-token' })
      }
      if (url.href === 'https://api.github.com/user') {
        assert.equal(request.headers.get('authorization'), 'Bearer synthetic-access-token')
        assert.equal(request.headers.get('user-agent'), 'Homework-Personal-Cloud')
        if (redirectStage === 'identity') return new Response(null, { status: 302, headers: { Location: 'https://redirect.invalid/collect' } })
        return Response.json({ id: 101, login: 'synthetic-user' })
      }
      unexpectedRequests++
      throw new Error('Unexpected outbound request in isolated Worker test')
    },
  }))
  t.after(() => worker.dispose())
  const api = (path, options = {}) => worker.dispatchFetch(`${origin}${path}`, { redirect: 'manual', ...options })
  const initialized = await api('/api/bootstrap', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootstrap_secret: bootstrap, device_name: 'Synthetic browser', client_type: 'web' }),
  })
  assert.equal(initialized.status, 200)
  const browserCookie = cookie(initialized, '__Host-homework_session')

  async function start(intent, session) {
    const response = await api(`/api/recovery/github/start?intent=${intent}`, {
      headers: session ? { Cookie: session } : {},
    })
    assert.equal(response.status, 302)
    const authorization = new URL(response.headers.get('location'))
    assert.equal(authorization.origin, 'https://github.com')
    assert.equal(authorization.searchParams.get('redirect_uri'), `${origin}/api/recovery/github/callback`)
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
    assert.ok(authorization.searchParams.get('code_challenge'))
    return { state: authorization.searchParams.get('state'), oauthCookie: cookie(response, '__Host-homework_oauth'), authorization }
  }
  async function callback(started, session) {
    const query = new URLSearchParams({ state: started.state, code: 'synthetic-authorization-code' })
    return api(`/api/recovery/github/callback?${query}`, {
      headers: { Cookie: [started.oauthCookie, session].filter(Boolean).join('; ') },
    })
  }

  const binding = await start('bind', browserCookie)
  const bound = await callback(binding, browserCookie)
  assert.equal(new URL(bound.headers.get('location')).searchParams.get('auth'), 'bound', `${bound.headers.get('location')} (exchanges: ${exchanges.length})`)
  assert.equal(exchanges.length, 1)
  const exchange = exchanges[0]
  assert.equal(exchange.get('client_id'), 'synthetic-client')
  assert.equal(exchange.get('client_secret'), 'synthetic-secret')
  assert.equal(exchange.get('redirect_uri'), `${origin}/api/recovery/github/callback`)
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(exchange.get('code_verifier')))).toString('base64url')
  assert.equal(challenge, binding.authorization.searchParams.get('code_challenge'))
  const providers = await (await api('/api/recovery/providers', { headers: { Cookie: browserCookie } })).json()
  assert.deepEqual(providers.providers.find(value => value.id === 'github'), { id: 'github', enabled: true, bound: true })

  const login = await start('login')
  const recovered = await callback(login)
  assert.equal(new URL(recovered.headers.get('location')).searchParams.get('auth'), 'complete')
  const recoveredCookie = cookie(recovered, '__Host-homework_session')
  assert.notEqual(recoveredCookie, browserCookie)
  assert.equal((await api('/api/devices')).status, 401)
  const devices = await api('/api/devices', { headers: { Cookie: recoveredCookie } })
  assert.equal(devices.status, 200)
  const data = await devices.json()
  assert.equal(data.devices.length, 2)
  assert.equal(data.devices.filter(device => device.current).length, 1)

  tokenError = 'incorrect_client_credentials'
  const failedLogin = await start('login')
  const failure = await callback(failedLogin)
  assert.equal(new URL(failure.headers.get('location')).searchParams.get('auth_error'), 'token_config')
  assert.equal(failure.headers.getSetCookie().some(value => value.startsWith('__Host-homework_session=')), false)

  tokenError = undefined
  for (const [stage, reason] of [['token', 'unavailable'], ['identity', 'identity_denied']]) {
    redirectStage = stage
    const redirectedLogin = await start('login')
    const rejected = await callback(redirectedLogin)
    assert.equal(new URL(rejected.headers.get('location')).searchParams.get('auth_error'), reason)
    assert.equal(rejected.headers.getSetCookie().some(value => value.startsWith('__Host-homework_session=')), false)
  }
  assert.equal(unexpectedRequests, 0, 'Provider redirects must never be followed')
})
