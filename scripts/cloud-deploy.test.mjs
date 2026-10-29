import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { outsideRepository, productionConfiguration } from './cloud-deploy.mjs'

test('deployment source paths are fixed and credentials cannot be configured as variables', () => {
  const template = { main: 'src/index.ts', assets: { binding: 'ASSETS' }, durable_objects: { bindings: [] }, migrations: [] }
  const deployment = { name: 'synthetic-private-worker', r2_buckets: [{ binding: 'FILES', bucket_name: 'synthetic-private-bucket' }] }
  const root = resolve('synthetic-checkout')
  const result = productionConfiguration(template, deployment, root)
  assert.equal(result.main, join(root, 'cloud/src/index.ts'))
  assert.equal(result.assets.directory, join(root, 'dist'))
  assert.throws(() => productionConfiguration(template, { ...deployment, vars: { BOOTSTRAP_SECRET: 'synthetic-unsafe-value' } }, root), /Worker secrets/)
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
