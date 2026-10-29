import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectCloudConfig, inspectDeploymentExample, inspectPublicText, checkCloudPrivacy } from './check-cloud-privacy.mjs'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('public local bindings are permitted while deployment identifiers are rejected', () => {
  assert.deepEqual(inspectCloudConfig({ name: 'homework-local-example', r2_buckets: [{ binding: 'FILES', bucket_name: 'homework-local-example-files' }] }), [])
  assert.ok(inspectCloudConfig({ account_id: 'a'.repeat(32) }).length)
  assert.ok(inspectCloudConfig({ r2_buckets: [{ bucket_name: 'personal-course-files' }] }).length)
  assert.ok(inspectCloudConfig({ vars: { PUBLIC_ORIGIN: 'https://personal.invalid' } }).length)
  assert.ok(inspectCloudConfig({ routes: ['personal.invalid/*'] }).length)
  assert.ok(inspectCloudConfig({ r2_buckets: [{ binding: 'FILES', remote: true }] }).length)
  assert.ok(inspectCloudConfig({ workers_dev: true }).length)
  assert.ok(inspectCloudConfig({ durable_objects: { bindings: [{ script_name: 'other-worker' }] } }).length)
})

test('source and documentation indicators are reported without reproducing sensitive input', () => {
  for (const value of [
    ['https://synthetic.', 'workers.dev'].join(''),
    ['<a href="https://synthetic.', 'workers.dev">Connect</a>'].join(''),
    ['https://synthetic.', 'r2.cloudflarestorage.com'].join(''),
    ['12345678901-synthetic.', 'apps.googleusercontent.com'].join(''),
    ['ghp_', 'a'.repeat(36)].join(''),
    ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
  ]) {
    const errors = inspectPublicText(value)
    assert.ok(errors.length)
    assert.ok(errors.every(error => !error.includes(value)))
  }
  assert.deepEqual(inspectPublicText('https://<YOUR_WORKER_NAME>.<YOUR_WORKERS_SUBDOMAIN>.workers.dev https://service.example.test'), [])
})

test('deployment example can enable workers.dev but cannot carry actual identities or custom origins', () => {
  const example = { name: '<YOUR_WORKER_NAME>', account_id: '<YOUR_ACCOUNT_ID>', workers_dev: true, vars: { PUBLIC_ORIGIN: 'https://<YOUR_WORKER_NAME>.<YOUR_WORKERS_SUBDOMAIN>.workers.dev' } }
  assert.deepEqual(inspectDeploymentExample(example), [])
  assert.ok(inspectDeploymentExample({ ...example, account_id: 'a'.repeat(32) }).length)
  assert.ok(inspectDeploymentExample({ ...example, vars: { PUBLIC_ORIGIN: 'https://service.example.test' } }).length)
  assert.ok(inspectDeploymentExample({ ...example, vars: { ...example.vars, BOOTSTRAP_SECRET: 'synthetic-value' } }).length)
})

test('public candidates include untracked source and force-added ignored credential files', () => {
  const root = mkdtempSync(join(tmpdir(), 'homework-privacy-'))
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    writeFileSync(join(root, '.gitignore'), '.env\n')
    writeFileSync(join(root, '.env'), 'SYNTHETIC=only-for-testing')
    writeFileSync(join(root, 'services.json'), '{"version":1,"sync":{"server_url":"https://service.example.test"}}')
    execFileSync('git', ['add', '--force', '.env'], { cwd: root })
    writeFileSync(join(root, 'client.ts'), ['https://synthetic.', 'workers.dev'].join(''))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/workflows/publish.yml'), 'env:\n  CLOUDFLARE_API_TOKEN: $' + '{{ secrets.SYNTHETIC }}')
    const errors = checkCloudPrivacy(root)
    assert.ok(errors.some(error => error.startsWith('.env:')))
    assert.ok(errors.some(error => error.startsWith('services.json:')))
    assert.ok(errors.some(error => error.startsWith('client.ts:')))
    assert.ok(errors.some(error => error.startsWith('.github/workflows/publish.yml:')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
