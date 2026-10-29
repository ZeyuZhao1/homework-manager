import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectCloudConfig } from './check-cloud-privacy.mjs'

test('public local bindings are permitted while deployment identifiers are rejected', () => {
  assert.deepEqual(inspectCloudConfig({ name: 'homework-local-example', r2_buckets: [{ binding: 'FILES', bucket_name: 'homework-local-example-files' }] }), [])
  assert.ok(inspectCloudConfig({ account_id: 'a'.repeat(32) }).length)
  assert.ok(inspectCloudConfig({ r2_buckets: [{ bucket_name: 'personal-course-files' }] }).length)
  assert.ok(inspectCloudConfig({ vars: { PUBLIC_ORIGIN: 'https://personal.invalid' } }).length)
  assert.ok(inspectCloudConfig({ routes: ['personal.invalid/*'] }).length)
})
