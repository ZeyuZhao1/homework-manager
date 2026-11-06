import test from 'node:test'
import assert from 'node:assert/strict'
import { calendarOverdue, dateKey, deadlineDate, formatCalendarDeadline, indexCalendarItems, monthDays, monthStart } from '../src/extensions/calendar/calendarDates.ts'

test('month navigation starts on day one across years and leap years', () => {
  assert.equal(dateKey(monthStart(new Date(2024, 0, 31), 1)), '2024-02-01')
  assert.equal(dateKey(monthStart(new Date(2024, 0, 31), -1)), '2023-12-01')
  const days = monthDays(new Date(2024, 1, 29))
  assert.equal(days.length, 42)
  assert.equal(days[0].getDay(), 1)
  assert.ok(days.some(day => dateKey(day) === '2024-02-29'))
  assert.equal(deadlineDate('2023-02-29'), null)
})

test('local days remain consecutive through daylight saving changes', () => {
  const previous = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    const days = monthDays(new Date(2024, 2, 1))
    assert.deepEqual(days.slice(12, 16).map(dateKey), ['2024-03-09', '2024-03-10', '2024-03-11', '2024-03-12'])
    assert.equal(dateKey(deadlineDate('2024-03-10')), '2024-03-10')
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous }
})

test('index groups local deadlines, sorts by time, and retains missing or invalid dates', () => {
  const item = (id, due_at, title = id) => ({ assignment: { id, due_at, title }, course: '', series: null, overdue: false })
  const { byDay, undated } = indexCalendarItems([item('later', '2024-02-29T23:00:00'), item('none', null), item('early', '2024-02-29T09:00:00'), item('bad', 'invalid')])
  assert.deepEqual(byDay.get('2024-02-29').map(value => value.assignment.id), ['early', 'later'])
  assert.deepEqual(undated.map(value => value.assignment.id), ['bad', 'none'])
})

test('offset timestamps resolve to the same local day and date-only values stay local', () => {
  const previous = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
  try {
    assert.equal(dateKey(deadlineDate('2024-03-01T01:30:00+08:00')), dateKey(deadlineDate('2024-02-29T17:30:00Z')))
    assert.equal(dateKey(deadlineDate('2024-03-01')), '2024-03-01')
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous }
})


test('date-only and invalid deadlines display and expire consistently in Los Angeles', () => {
  const previous = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
  try {
    const midday = new Date(2026, 1, 28, 12).getTime()
    assert.equal(formatCalendarDeadline('2026-02-28', midday), '今天')
    assert.equal(calendarOverdue('2026-02-28', midday), false)
    assert.equal(calendarOverdue('2026-02-28', new Date(2026, 2, 1, 0).getTime()), true)
    assert.equal(formatCalendarDeadline('2026-02-30', midday), '日期无效')
    assert.equal(calendarOverdue('2026-02-30', midday), false)
    assert.equal(formatCalendarDeadline(null, midday), '未安排日期')
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous }
})
