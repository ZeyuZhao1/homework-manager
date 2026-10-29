import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
const temp = await mkdtemp(join(tmpdir(), 'homework-ai-privacy-'))
const source = name => readFile(new URL(`../modules/assignment-import/frontend/${name}.ts`, import.meta.url), 'utf8')
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
await writeFile(join(temp, 'preview.mjs'), compile(await source('previewConfig')))
const { safePreviewConfig, loadPreviewConfig, previewKey } = await import(pathToFileURL(join(temp, 'preview.mjs')))
let serviceSource = compile(await source('service')).replace(/^import .*$/gm, '')
serviceSource = `import {loadPreviewConfig,previewKey,safePreviewConfig} from './preview.mjs';
const isTauri=()=>false;const service={};const webSync={isCloud:false};const invoke=()=>{throw Error('desktop only')};\n` + serviceSource
await writeFile(join(temp, 'service.mjs'), serviceSource)
const { assignmentImportService } = await import(pathToFileURL(join(temp, 'service.mjs')))
after(() => rm(temp, { recursive: true, force: true }))
const metadata = { id: 'provider', name: 'Test', kind: 'custom', base_url: 'https://provider.invalid/v1', model: 'model' }
function storage(initial = '') { let value = initial; return { getItem: () => value, setItem: (key, next) => { assert.equal(key, previewKey); value = next }, get value() { return value } } }
test('historical preview credentials are purged on load and never copied to persisted configuration', () => {
  const local = storage(JSON.stringify({ providers: [{ ...metadata, api_key: 'historical-test-placeholder', has_key: true, nested: { token: 'old-placeholder' } }], assignment_provider_id: 'provider', api_key: 'top-level-placeholder' }))
  const config = loadPreviewConfig(local)
  assert.equal(config.providers[0].has_key, false); assert.doesNotMatch(local.value, /historical-test-placeholder|old-placeholder|top-level-placeholder|api_key|nested/)
  assert.equal(config.assignment_provider_id, 'provider')
})
test('allowlist migration never accesses historical credential property values', () => {
  const provider = { ...metadata }
  Object.defineProperty(provider, 'api_key', { enumerable: true, get() { assert.fail('historical key must not be accessed') } })
  Object.defineProperty(provider, 'has_key', { enumerable: true, get() { assert.fail('historical credential status must not be trusted') } })
  assert.deepEqual(safePreviewConfig({ providers: [provider] }).providers, [{ ...metadata, has_key: false }])
})
test('preview saveProvider uses metadata only and never reads or persists an entered key', async t => {
  const local = storage(); const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'); Object.defineProperty(globalThis, 'localStorage', { value: local, configurable: true }); t.after(() => { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage })
  const payload = { ...metadata, has_key: true }
  Object.defineProperty(payload, 'api_key', { enumerable: true, get() { assert.fail('browser must not read API key') } })
  await assignmentImportService.saveProvider(payload)
  assert.deepEqual(JSON.parse(local.value).providers, [{ ...metadata, has_key: false }]); assert.doesNotMatch(local.value, /api_key/)
})
test('malformed historical preview state is replaced with safe defaults', () => {
  const local = storage('{broken'); assert.deepEqual(loadPreviewConfig(local).providers, []); assert.doesNotThrow(() => JSON.parse(local.value))
})
