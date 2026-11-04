import test from 'node:test'
import assert from 'node:assert/strict'
import { buildActionQueue, formatActionDeadline } from '../src/actionQueue.ts'

const assignment = (id, status, due_at, title = id) => ({ id, status, due_at, title, course_id: 'course', source_name: '', source_text: '' })
const courses = [{ id: 'course', name: '数学' }]
const groups = [{ id: 'series', title: '每周练习', assignment_ids: ['first', 'second', 'first'] }]
const now = new Date(2026, 10, 4, 12).getTime()

test('counts concrete unsubmitted assignments once, including each recurring child', () => {
  const first = assignment('first', 'todo', '2026-11-03T18:00:00')
  const second = assignment('second', 'doing', '2026-11-05T18:00:00')
  const ready = assignment('ready', 'done', '2026-11-02T18:00:00')
  const queue = buildActionQueue([first, second, first, ready, assignment('submitted', 'submitted', '2026-11-01T18:00:00')], groups, courses, now)
  assert.equal(queue.items.length, 3)
  assert.equal(queue.overdueCount, 2)
  assert.deepEqual(queue.handling.map(item => item.assignment.id), ['first', 'second'])
  assert.deepEqual(queue.done.map(item => item.assignment.id), ['ready'])
  assert.deepEqual(queue.handling.map(item => item.series), ['每周练习', '每周练习'])
})

test('sorts by deadline with unscheduled and invalid dates last', () => {
  const queue = buildActionQueue([
    assignment('undated', 'todo', null),
    assignment('later', 'todo', '2026-11-06T18:00:00'),
    assignment('invalid', 'doing', 'invalid'),
    assignment('earlier', 'todo', '2026-11-04T18:00:00'),
  ], [], courses, now)
  assert.deepEqual(queue.handling.map(item => item.assignment.id), ['earlier', 'later', 'invalid', 'undated'])
  assert.equal(queue.overdueCount, 0)
})

test('shows local relative dates and preserves a different year', () => {
  assert.equal(formatActionDeadline(null, now), '未安排日期')
  assert.equal(formatActionDeadline('invalid', now), '日期无效')
  assert.equal(formatActionDeadline('2026-11-03T18:00:00', now), '昨天 18:00')
  assert.equal(formatActionDeadline('2026-11-04T23:59:00', now), '今天 23:59')
  assert.equal(formatActionDeadline('2026-11-05T09:00:00', now), '明天 09:00')
  assert.equal(formatActionDeadline('2027-01-02T09:00:00', now), '2027年1月2日 09:00')
})
