import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { outsideRepository, productionConfiguration, deploymentArguments } from './cloud-deploy.mjs'
import { setupCloudDirectory } from './cloud-setup.mjs'

test('deployment source paths are fixed and credentials cannot be configured as variables', () => {
  const template = { main: 'src/index.ts', assets: { binding: 'ASSETS', run_worker_first: ['/api/*'] }, durable_objects: { bindings: [] }, migrations: [] }
  const deployment = { name: 'synthetic-private-worker', account_id: 'a'.repeat(32), workers_dev: true, vars: { PUBLIC_ORIGIN: 'https://service.example.test' }, r2_buckets: [{ binding: 'FILES', bucket_name: 'synthetic-private-bucket' }] }
  const root = resolve('synthetic-checkout')
  const result = productionConfiguration(template, deployment, root)
  assert.equal(result.main, join(root, 'cloud/src/index.ts'))
  assert.equal(result.assets.directory, join(root, 'dist'))
  assert.throws(() => productionConfiguration(template, { ...deployment, vars: { ...deployment.vars, BOOTSTRAP_SECRET: 'synthetic-unsafe-value' } }, root), /Worker secrets/)
  for (const change of [
    { name: '<YOUR_WORKER_NAME>' }, { account_id: '' },
    { r2_buckets: [{ binding: 'FILES', bucket_name: 'homework-local-example-files' }] },
    { workers_dev: false }, { vars: { PUBLIC_ORIGIN: 'http://service.example.test' } },
    { vars: { PUBLIC_ORIGIN: 'https://service.example.test/path' } },
  ]) assert.throws(() => productionConfiguration(template, { ...deployment, ...change }, root))
  const protectedAssets = productionConfiguration(template, { ...deployment, assets: { binding: 'UNSAFE', directory: '/other', run_worker_first: false } }, root)
  assert.equal(protectedAssets.assets.binding, 'ASSETS')
  assert.deepEqual(protectedAssets.assets.run_worker_first, ['/api/*'])
  assert.equal(protectedAssets.logpush, false)
  assert.equal(protectedAssets.preview_urls, false)
})

test('deployment and secret commands require explicit targets and accept no credential arguments', () => {
  const prefix = ['--config', '/synthetic/private/cloud.json']
  assert.deepEqual(deploymentArguments([...prefix, '--secret', 'BOOTSTRAP_SECRET'], '/private/generated.json', '/private'), ['exec', 'wrangler', 'secret', 'put', 'BOOTSTRAP_SECRET', '--config', '/private/generated.json'])
  assert.ok(deploymentArguments([...prefix, '--dry-run'], '/private/generated.json', '/private').includes('--dry-run'))
  assert.throws(() => deploymentArguments([], '/private/generated.json', '/private'))
  assert.throws(() => deploymentArguments([...prefix, '--secret', 'BOOTSTRAP_SECRET', 'synthetic-secret'], '/private/generated.json', '/private'), /interactive prompt/)
  assert.throws(() => deploymentArguments([...prefix, '--secret', 'BOOTSTRAP_SECRET', '--dry-run'], '/private/generated.json', '/private'))
})

test('malformed private JSON never echoes its contents in deployment errors', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'homework-invalid-config-'))
  try {
    const config = join(temporary, 'cloud.json')
    const sentinel = 'synthetic-confidential-sentinel'
    writeFileSync(config, '{"broken":' + sentinel)
    const result = spawnSync(process.execPath, ['scripts/cloud-deploy.mjs', '--config', config, '--dry-run'], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Invalid private configuration JSON/)
    assert.ok(!result.stderr.includes(sentinel))
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

test('setup creates an unfilled private template without overwriting or following symlinks into source', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'homework-setup-'))
  try {
    const root = join(temporary, 'checkout')
    mkdirSync(join(root, 'deploy/cloudflare'), { recursive: true })
    writeFileSync(join(root, 'deploy/cloudflare/config.example.json'), '{"name":"<YOUR_WORKER_NAME>"}')
    const directory = join(temporary, 'private')
    setupCloudDirectory(directory, root)
    const config = join(directory, 'cloud.json')
    assert.match(readFileSync(config, 'utf8'), /<YOUR_WORKER_NAME>/)
    if (process.platform !== 'win32') assert.equal(statSync(config).mode & 0o777, 0o600)
    assert.throws(() => setupCloudDirectory(directory, root), /EEXIST/)
    assert.throws(() => setupCloudDirectory(join(root, 'private'), root), /outside/)
    if (process.platform !== 'win32') {
      const disguised = join(temporary, 'disguised')
      symlinkSync(root, disguised)
      assert.throws(() => setupCloudDirectory(join(disguised, 'private'), root), /outside/)
      const linkedDir = join(temporary, 'linked')
      mkdirSync(linkedDir)
      symlinkSync(join(root, 'deploy/cloudflare/config.example.json'), join(linkedDir, 'cloud.json'))
      assert.throws(() => setupCloudDirectory(linkedDir, root), /EEXIST/)
    }
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

test('private configurations inside checkout remain rejected through symlinks', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'homework-deploy-'))
  try {
    const root = join(temporary, 'checkout')
    mkdirSync(root)
    const internal = join(root, 'config.json')
    const external = join(temporary, 'private.json')
    writeFileSync(internal, '{}'); writeFileSync(external, '{}')
    assert.equal(outsideRepository(internal, root), false)
    assert.equal(outsideRepository(external, root), true)
    if (process.platform !== 'win32') {
      const disguised = join(temporary, 'disguised.json')
      symlinkSync(internal, disguised)
      assert.equal(outsideRepository(disguised, root), false)
    }
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})
