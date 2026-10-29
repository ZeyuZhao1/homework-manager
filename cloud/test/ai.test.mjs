import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
const temp = await mkdtemp(join(tmpdir(), 'homework-ai-test-'))
for (const name of ['ai', 'ai-prompts', 'ai-credentials']) {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace("'./ai-prompts'", "'./ai-prompts.mjs'").replace("'./ai-credentials'", "'./ai-credentials.mjs'")
  await writeFile(join(temp, `${name}.mjs`), js)
}
const { readAiCredential, saveAiCredential, deleteAiCredential } = await import(pathToFileURL(join(temp, 'ai-credentials.mjs')))
const { handleAi, extractAssignments } = await import(pathToFileURL(join(temp, 'ai.mjs')))
after(() => rm(temp, { recursive: true, force: true }))
class Store {
  rows = new Map()
  add(type, id, data) { this.rows.set(`${type}:${id}`, { entity_type: type, entity_id: id, data, seq: 1 }); return this }
  read(type, id) { return this.rows.get(`${type}:${id}`) }
  snapshot() { return { entities: [...this.rows.values()] } }
  commit() { assert.fail('AI must never persist unreviewed drafts') }
}
const setup = (kind = 'deepseek', model = 'deepseek-flash') => new Store().add('ai_setting', 'assignment_provider_id', { value: 'provider' }).add('provider', 'provider', { kind, model, base_url: 'https://provider.invalid/v1' }).add('course', 'course', { name: 'Calculus', code: 'M1' })
const request = (text = 'announcement', file_ids = []) => new Request('https://app.invalid/api/ai/analyze', { method: 'POST', body: JSON.stringify({ text, file_ids }) })
const draft = { title: 'Homework', course_name: 'm1', course_id: 'untrusted-id', due_at: '2026-02-30T10:00:00' }
const compatible = content => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] })
const environment = files => ({ AI_PROVIDER_KEYS: JSON.stringify({ provider: 'ephemeral-test-only' }), FILES: { get: async path => files?.[path] } })

test('real HTTP adapter selects synchronized routing, authenticates privately, sends prompts and returns review drafts', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++; assert.equal(url, 'https://provider.invalid/v1/chat/completions'); assert.equal(options.headers.Authorization, 'Bearer ephemeral-test-only'); assert.equal(options.redirect, 'manual'); assert.ok(options.signal)
    const body = JSON.parse(options.body); assert.deepEqual(body.response_format, { type: 'json_object' }); assert.match(body.messages[1].content[0].text, /"name":"Calculus","code":"M1"/); assert.match(body.messages[1].content[0].text, /announcement/)
    return compatible({ assignments: [draft] })
  })
  const response = await handleAi(request(), environment(), setup()); assert.equal(response.status, 200)
  const result = await response.json(); assert.equal(result.assignments[0].course_id, 'course'); assert.equal(result.assignments[0].due_at, null); assert.equal(calls, 1)
})
test('provider errors and network exceptions never expose remote body, key or input', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('REMOTE_PRIVATE_CONTENT', { status: 429 }))
  let response = await handleAi(request('PRIVATE_ANNOUNCEMENT'), environment(), setup()); assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /REMOTE_PRIVATE_CONTENT|ephemeral-test-only|PRIVATE_ANNOUNCEMENT/)
  globalThis.fetch.mock.mockImplementation(async () => { throw new Error('secret or URL with credentials') })
  response = await handleAi(request(), environment(), setup()); assert.doesNotMatch(await response.text(), /credentials/)
})
test('missing private secret, disabled module and unconfirmed R2 attachments fail before provider requests', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('must not send'))
  let response = await handleAi(request(), { FILES: {} }, setup()); assert.equal(response.status, 503)
  const store = setup().add('file', 'f', { name: 'a.png', size: 1 })
  response = await handleAi(request('', ['f']), environment(), store); assert.equal(response.status, 400)
  store.add('module_state', 'builtin.ai.assignment-import', { enabled: false })
  response = await handleAi(request(), environment(), store); assert.equal(response.status, 400)
})
test('R2 confirmed image is read only by stored immutable version and encoded for Gemini', async t => {
  const version = 'content/f/random-version'
  const store = setup('gemini', 'gemini-2.5-flash').add('file', 'f', { name: 'notice.png', cloud_version: version, size: 3 })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(url, /models\/gemini-2.5-flash:generateContent$/); assert.equal(options.headers['x-goog-api-key'], 'ephemeral-test-only')
    const body = JSON.parse(options.body); assert.deepEqual(body.contents[0].parts[1], { inline_data: { mime_type: 'image/png', data: 'AQID' } })
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'private reasoning' }, { text: JSON.stringify([draft]) }] } }] })
  })
  const response = await handleAi(request('', ['f']), environment({ [version]: { size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } }), store); assert.equal(response.status, 200)
})
test('qwen file upload cleans remote temporary files even when generation fails', async t => {
  const store = setup('bailian', 'qwen-long').add('file', 'f', { name: 'notice.docx', cloud_version: 'content/f/v', size: 1 })
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([url, options.method])
    if (options.method === 'DELETE') return new Response(null, { status: 204 })
    if (url.endsWith('/files')) { assert.ok(options.body instanceof FormData); return Response.json({ id: 'file-id' }) }
    assert.equal(JSON.parse(options.body).messages[1].content, 'fileid://file-id'); return new Response('private remote error', { status: 500 })
  })
  const response = await handleAi(request('', ['f']), environment({ 'content/f/v': { size: 1, arrayBuffer: async () => new Uint8Array([1]).buffer } }), store)
  assert.equal(response.status, 502); assert.deepEqual(calls.map(c => c[1]), ['POST', 'POST', 'DELETE'])
})
test('capability, aggregate memory and request limits reject before reading R2', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('must not send'))
  const store = setup().add('file', 'f', { name: 'a.pdf', cloud_version: 'content/f/v', size: 1 })
  let response = await handleAi(request('', ['f']), environment(), store); assert.equal(response.status, 400)
  for (let i = 0; i < 2; i++) store.add('file', `f${i}`, { name: 'a.png', cloud_version: `content/f${i}/v`, size: 11 * 1024 * 1024 })
  response = await handleAi(request('', ['f0', 'f1']), environment(), store); assert.equal(response.status, 400)
  response = await handleAi(request('x'.repeat(2 * 1024 * 1024)), environment(), store); assert.equal(response.status, 400)
})
test('strict outer JSON parsing, field types, course ambiguity and actual calendar dates', () => {
  const courses = [{ id: 'a', name: 'Calculus', code: 'M1' }]
  const result = extractAssignments('```json\n<think>ignored</think>\n' + JSON.stringify([draft]) + '\n``` trailing', courses)
  assert.equal(result.assignments[0].course_id, 'a'); assert.equal(result.assignments[0].due_at, null)
  assert.throws(() => extractAssignments('{"assignments":[' + JSON.stringify(draft), courses), /不完整/)
  assert.throws(() => extractAssignments(JSON.stringify({ assignments: [{ title: 1 }] }), courses), /title/)
  assert.throws(() => extractAssignments('{} {}', courses), /多个/)
  assert.equal(extractAssignments(JSON.stringify(draft), [...courses, { id: 'b', name: 'Other', code: 'M1' }]).assignments[0].course_id, '')
  assert.equal(extractAssignments('<think>not data</think>' + JSON.stringify({ ...draft, due_at: '2024-02-29T10:00:00' }), courses).assignments[0].due_at, '2024-02-29T10:00:00')
})
test('truncation, refusals, blocked content and empty responses are distinct and omit raw model data', async t => {
  const cases = [
    [{ choices: [{ finish_reason: 'length', message: { content: 'private' } }] }, /长度上限/],
    [{ choices: [{ message: { refusal: 'private' } }] }, /拒绝/],
    [{ choices: [{ finish_reason: 'content_filter' }] }, /拦截/],
    [{ choices: [{ message: { reasoning_content: 'private', content: '' } }] }, /没有返回文字/],
  ]
  const mocked = t.mock.method(globalThis, 'fetch', async () => Response.json(cases[0][0]))
  for (const [value, pattern] of cases) { mocked.mock.mockImplementation(async () => Response.json(value)); const response = await handleAi(request(), environment(), setup()); const text = await response.text(); assert.equal(response.status, 400); assert.match(text, pattern); assert.doesNotMatch(text, /private/) }
})
test('custom compatible APIs retain text requests without unsupported JSON mode', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body); assert.equal(body.response_format, undefined); assert.equal(body.messages[1].content[0].type, 'text')
    return Response.json({ choices: [{ message: { content: [{ type: 'reasoning', text: 'not data' }, { type: 'text', text: JSON.stringify(draft) }] } }] })
  })
  assert.equal((await handleAi(request(), environment(), setup('custom', 'model'))).status, 200)
})
test('provider response body is bounded even without content-length', async t => {
  let cancelled = false
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)) }, cancel() { cancelled = true } })))
  const response = await handleAi(request(), environment(), setup()); assert.equal(response.status, 400); assert.equal(cancelled, true)
})
test('network generation receives finite timeout and aborts without leaking exception text', async t => {
  const timeout = t.mock.method(globalThis, 'setTimeout', callback => { queueMicrotask(callback); return 0 })
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.signal.aborted) throw new Error('private timed-out content')
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('private timed-out content')), { once: true }))
  })
  const response = await handleAi(request(), environment(), setup()); assert.equal(response.status, 502); assert.match(await response.text(), /超时/); assert.equal(timeout.mock.calls[0].arguments[1], 120000)
})
test('relative-date prompt uses validated caller timezone, with Asia/Shanghai default', async t => {
  const prompts = []
  t.mock.method(globalThis, 'fetch', async (_url, options) => { prompts.push(JSON.parse(options.body).messages[1].content[0].text); return compatible(draft) })
  const body = timezone => new Request('https://app.invalid/api/ai/analyze', { method: 'POST', body: JSON.stringify({ text: 'announcement', timezone }) })
  const now = new Date(); const date = zone => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  assert.equal((await handleAi(body('America/Los_Angeles'), environment(), setup())).status, 200)
  assert.match(prompts[0], new RegExp(date('America/Los_Angeles')))
  assert.equal((await handleAi(body(undefined), environment(), setup())).status, 200)
  assert.match(prompts[1], new RegExp(date('Asia/Shanghai')))
  assert.equal((await handleAi(body('not-a-timezone'), environment(), setup())).status, 400); assert.equal(prompts.length, 2)
})

// Every key and master below is generated for this run; no credentials enter fixtures.
function vaultEnvironment() {
  const objects = new Map()
  return {
    objects,
    AI_CREDENTIAL_ENCRYPTION_KEY: [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join(''),
    FILES: {
      get: async name => objects.has(name) ? { size: objects.get(name).length, json: async () => JSON.parse(objects.get(name)) } : null,
      put: async (name, value) => { objects.set(name, value) },
    },
  }
}
test('vault encrypts with random IVs, binds provider identity, and fails closed on wrong/missing master', async () => {
  const env = vaultEnvironment(), key = crypto.randomUUID()
  await saveAiCredential(env, 'provider', key)
  const first = env.objects.get('_private/ai-credentials/provider')
  assert.doesNotMatch(first, new RegExp(key)); assert.equal(await readAiCredential(env, 'provider'), key)
  await saveAiCredential(env, 'provider', key)
  assert.notEqual(JSON.parse(first).iv, JSON.parse(env.objects.get('_private/ai-credentials/provider')).iv)
  env.objects.set('_private/ai-credentials/other', first)
  await assert.rejects(readAiCredential(env, 'other'), error => error.status === 503)
  await assert.rejects(readAiCredential({ ...env, AI_CREDENTIAL_ENCRYPTION_KEY: undefined }, 'provider'), error => error.status === 503)
  await assert.rejects(readAiCredential({ ...env, AI_CREDENTIAL_ENCRYPTION_KEY: vaultEnvironment().AI_CREDENTIAL_ENCRYPTION_KEY }, 'provider'), error => error.status === 503)
  const empty = vaultEnvironment(); delete empty.AI_CREDENTIAL_ENCRYPTION_KEY
  await assert.rejects(saveAiCredential(empty, 'provider', key), error => error.status === 503)
  assert.equal(empty.objects.size, 0)
  for (const invalid of ['', ' ', 'x'.repeat(4097), 'a\nb', 'a\u0000b']) await assert.rejects(saveAiCredential(env, 'provider', invalid), error => error.status === 400)
})
test('vault deletion persistently disables legacy fallback and replacement powers AI without snapshot changes', async t => {
  const env = vaultEnvironment(), legacy = crypto.randomUUID(), replacement = crypto.randomUUID()
  env.AI_PROVIDER_KEYS = JSON.stringify({ provider: legacy })
  assert.equal(await readAiCredential(env, 'provider'), legacy)
  await deleteAiCredential(env, 'provider'); assert.equal(await readAiCredential(env, 'provider'), undefined)
  await saveAiCredential(env, 'provider', replacement)
  const store = setup(), before = JSON.stringify(store.snapshot())
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${replacement}`)
    return compatible(draft)
  })
  const response = await handleAi(request(), env, store)
  assert.equal(response.status, 200); assert.equal(JSON.stringify(store.snapshot()), before)
  assert.ok(!JSON.stringify(store.snapshot()).includes(replacement)); assert.ok(!(await response.text()).includes(replacement))
  await deleteAiCredential(env, 'provider')
  assert.equal((await handleAi(request(), env, store)).status, 503)
})


test('upstream redirects are rejected without leaking credentials or following Location', async t => {
 let calls=0
 t.mock.method(globalThis, 'fetch', async (_url,options) => {calls++;assert.equal(options.redirect,'manual');return new Response(null,{status:307,headers:{Location:'https://redirect.invalid/private'}})})
 const response=await handleAi(request(),environment(),setup());assert.equal(response.status,502);assert.equal(calls,1);assert.doesNotMatch(await response.text(),/redirect.invalid|ephemeral-test-only/)
})
