import type { Assignment, Course } from './types'
import type { AssignmentGroup } from './moduleTypes'

export type ActionTab = 'handling' | 'done'
export type ActionItem = { assignment: Assignment; course: string; series: string | null; overdue: boolean }

function deadline(value: string | null): number {
  if (!value) return Infinity
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : Infinity
}

/** A queue contains real assignments only; recurring series are context, not additional work. */
export function buildActionQueue(assignments: Assignment[], groups: AssignmentGroup[], courses: Course[], now = Date.now()) {
  const courseNames = new Map(courses.map(course => [course.id, course.name]))
  const seriesNames = new Map<string, string>()
  for (const group of groups) for (const id of group.assignment_ids) {
    if (!seriesNames.has(id)) seriesNames.set(id, group.title)
  }
  const unique = new Map<string, Assignment>()
  for (const assignment of assignments) if (!unique.has(assignment.id)) unique.set(assignment.id, assignment)
  const items: ActionItem[] = [...unique.values()]
    .filter(assignment => assignment.status !== 'submitted')
    .map(assignment => ({
      assignment,
      course: courseNames.get(assignment.course_id) || '课程',
      series: seriesNames.get(assignment.id) || (assignment.source_name === '周期作业' ? assignment.source_text || '周期作业' : null),
      overdue: deadline(assignment.due_at) < now,
    }))
    .sort((a, b) => deadline(a.assignment.due_at) - deadline(b.assignment.due_at) || a.assignment.title.localeCompare(b.assignment.title) || a.assignment.id.localeCompare(b.assignment.id))
  return {
    items,
    handling: items.filter(item => item.assignment.status === 'todo' || item.assignment.status === 'doing'),
    done: items.filter(item => item.assignment.status === 'done'),
    overdueCount: items.filter(item => item.overdue).length,
  }
}

export function formatActionDeadline(value: string | null, now = Date.now()): string {
  if (!value) return '未安排日期'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '日期无效'
  const today = new Date(now)
  const calendarDay = (day: Date) => Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) / 86400000
  const difference = calendarDay(date) - calendarDay(today)
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (difference === -1) return `昨天 ${time}`
  if (difference === 0) return `今天 ${time}`
  if (difference === 1) return `明天 ${time}`
  return `${date.getFullYear() === today.getFullYear() ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日 ${time}`
}
