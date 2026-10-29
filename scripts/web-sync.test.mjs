import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { attachmentName, attachmentLocation, canOpenAttachment } from '../src/filePresentation.ts'

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const protocol = moduleUrl(compile(await readFile(new URL('../src/sync/protocol.ts', import.meta.url), 'utf8')))
const adapter = compile((await readFile(new URL('../src/sync/web.ts', import.meta.url), 'utf8')).replace('import.meta.env.DEV', 'false')).replace(/from ['"]\.\/protocol['"]/g, `from '${protocol}'`)
let instance = 0

async function fixture(t) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const window = new EventTarget()
  window.confirm = () => false
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true })
  t.after(() => { if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window })
  const server = { cursor: 1, calls: [], unauthorized: false, rows: [
    { entity_type: 'semester', entity_id: 's1', seq: 1, data: { name: 'Term' } },
    { entity_type: 'course', entity_id: 'c1', seq: 1, data: { semester_id: 's1', name: 'Course', code: '' } },
    { entity_type: 'assignment', entity_id: 'a1', seq: 1, data: { course_id: 'c1', title: 'Task', description: '', due_at: null, status: 'todo', submission_label: '', submission_url: '', submission_notes: '', source_name: '', source_text: '', created_at: '', updated_at: '', custom_fields: {} } },
  ] }
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    server.calls.push({ url, init })
    assert.ok(url.startsWith('/api/'), 'browser endpoints must remain same origin')
    assert.equal(init.credentials, 'same-origin')
    if (server.unauthorized) return Response.json({ error: 'Session required' }, { status: 401 })
    if (url === '/api/health') return Response.json({ protocol: 1 })
    if (url === '/api/snapshot') return Response.json({ cursor: server.cursor, entities: server.rows, server_time: '2026-10-28T12:00:00Z' })
    if (url === '/api/sync') {
      const input = JSON.parse(init.body)
      for (const operation of input.operations) for (const change of operation.changes) {
        const old = server.rows.find(row => row.entity_id === change.entity_id && row.entity_type === change.entity_type)
        server.rows = server.rows.filter(row => row !== old)
        server.rows.push({ ...change, seq: ++server.cursor, data: change.data === null ? null : { ...old?.data, ...change.data } })
      }
      return Response.json({ cursor: server.cursor, changes: [], acknowledged: input.operations.map(operation => operation.operation_id), has_more: false, server_time: '' })
    }
    if (url.endsWith('/content') && init.method === 'PUT') {
      assert.equal(init.headers['X-Upload-Confirmed'], 'true')
      const id = url.split('/')[3]
      server.rows.find(row => row.entity_type === 'file' && row.entity_id === id).data.cloud_version = 'test-content-version'
      ++server.cursor
      return Response.json({ uploaded: true })
    }
    throw new Error(`Unexpected mocked request: ${url}`)
  })
  const api = await import(`${moduleUrl(adapter)}#instance-${++instance}`)
  await api.webSync.initialize()
  return { ...api, server, window }
}

test('cloud snapshot preserves domain records while local directories stay empty', async t => {
  const { cloudService, webSync } = await fixture(t)
  const snapshot = await cloudService.snapshot()
  assert.equal(webSync.isCloud, true)
  assert.equal(snapshot.courses[0].folder_path, '')
  assert.equal(snapshot.semesters[0].source_root, '')
  assert.equal(snapshot.assignments[0].title, 'Task')
})

test('editing an old form patches only edited fields after a newer remote refresh', async t => {
  const { cloudService, webSync, server } = await fixture(t)
  const opened = webSync.snapshot().assignments[0]
  server.rows.find(row => row.entity_id === 'a1').data.title = 'Updated remotely'
  ++server.cursor
  await webSync.refresh()
  await cloudService.saveAssignment({ ...opened, status: 'doing' })
  const sync = server.calls.find(call => call.url === '/api/sync')
  assert.deepEqual(JSON.parse(sync.init.body).operations[0].changes[0].data, { status: 'doing' })
  assert.equal(webSync.snapshot().assignments[0].title, 'Updated remotely')
})

test('semester and course saves never transmit local path fields', async t => {
  const { cloudService, server } = await fixture(t)
  await cloudService.saveSemester({ id: 's1', name: 'Updated term', source_root: '/private/term-root' })
  await cloudService.saveCourse({ id: 'c1', semester_id: 's1', name: 'Updated course', code: '', folder_path: 'C:\\private\\course-root' })
  const transmitted = server.calls.filter(call => call.url === '/api/sync').map(call => call.init.body).join('\n')
  assert.doesNotMatch(transmitted, /private|source_root|folder_path|course-root|term-root/)
})

test('cancelled content upload creates metadata only and never transfers file bytes', async t => {
  const { webSync, server } = await fixture(t)
  const selected = webSync.stageFile(new File(['synthetic-private-content'], 'notes.pdf', { type: 'application/pdf' }))
  await assert.rejects(webSync.prepareAiFiles([selected]), /取消上传/)
  assert.equal(webSync.entities('file').length, 1)
  assert.equal(server.calls.filter(call => call.init.method === 'PUT').length, 0)
  assert.ok(server.calls.every(call => !String(call.init.body).includes('synthetic-private-content')))
})

test('staged selections reuse metadata across analysis retry and later audited association', async t => {
  const { cloudService, webSync, server, window } = await fixture(t)
  const selected = webSync.stageFile(new File(['test-content'], 'notes.pdf', { type: 'application/pdf' }))
  let confirmations = 0
  window.confirm = () => { confirmations++; return true }
  const ids = await webSync.prepareAiFiles([selected])
  assert.equal(confirmations, 1)
  assert.deepEqual(await webSync.prepareAiFiles([selected]), ids)
  assert.equal(confirmations, 1, 'already uploaded content requires no repeated transfer')
  await cloudService.linkFile({ id: '', assignment_id: 'a1', path: selected, role: 'prompt', page: '', chapter: '', problem: '', note: '' })
  assert.equal(webSync.entities('file').length, 1)
  assert.equal(webSync.snapshot().links[0].file_id, ids[0])
  assert.equal(webSync.snapshot().file_history[0].event_type, 'linked')
  assert.equal(server.calls.filter(call => call.init.method === 'PUT').length, 1)
})

test('expired web authorization fails closed and never restores preview mode', async t => {
  const { cloudService, webSync, SessionRequired, server, window } = await fixture(t)
  let expired = false
  window.addEventListener('homeworkbook:session-required', () => { expired = true })
  server.unauthorized = true
  await assert.rejects(cloudService.snapshot(), SessionRequired)
  assert.equal(expired, true)
  assert.equal(webSync.isCloud, true)
})

test('remote desktop attachment names hide internal locators and require download', () => {
  const remote = { id: 'file-id', path: 'cloud://internal-id', name: 'worksheet.pdf', missing: true, cloud_available: true }
  assert.equal(attachmentName(remote), 'worksheet.pdf')
  assert.doesNotMatch(attachmentLocation(remote), /internal-id|cloud:\/\//)
  assert.equal(canOpenAttachment(remote, false), false)
})

test('metadata-only browser attachments cannot pretend to be openable content', () => {
  const file = { id: 'file-id', path: 'cloud:file-id/worksheet.pdf', name: 'worksheet.pdf', missing: false, cloud_available: false }
  assert.equal(canOpenAttachment(file, true), false)
  assert.equal(canOpenAttachment({ ...file, cloud_available: true }, true), true)
})
