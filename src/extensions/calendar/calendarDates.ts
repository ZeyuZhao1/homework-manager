import type { ActionItem } from '../../actionQueue'

/** Local calendar key: date-only values must not be interpreted as UTC. */
export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function deadlineDate(value: string | null): Date | null {
  if (!value) return null
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value)
  if (dateParts) {
    const year = Number(dateParts[1]), month = Number(dateParts[2]), day = Number(dateParts[3])
    const date = new Date(year, month - 1, day, 12)
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
    if (value.length === 10) return date
  }
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

export function calendarOverdue(value: string | null, now: number): boolean {
  const date = deadlineDate(value)
  if (!date) return false
  if (/^\d{4}-\d{2}-\d{2}$/.test(value || '')) {
    return dateKey(date) < dateKey(new Date(now))
  }
  return date.getTime() < now
}

export function formatCalendarDeadline(value: string | null, now: number): string {
  if (!value) return '未安排日期'
  const date = deadlineDate(value)
  if (!date) return '日期无效'
  const today = new Date(now)
  const calendarDay = (day: Date) => Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) / 86400000
  const difference = calendarDay(date) - calendarDay(today)
  const label = difference === -1 ? '昨天' : difference === 0 ? '今天' : difference === 1 ? '明天' : `${date.getFullYear() === today.getFullYear() ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日`
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return label
  return `${label} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function monthStart(date: Date, offset = 0): Date {
  return new Date(date.getFullYear(), date.getMonth() + offset, 1, 12)
}

/** Six Monday-first weeks; noon avoids midnight transitions around DST. */
export function monthDays(month: Date): Date[] {
  const first = monthStart(month)
  const mondayOffset = (first.getDay() + 6) % 7
  return Array.from({ length: 42 }, (_, index) => new Date(first.getFullYear(), first.getMonth(), 1 - mondayOffset + index, 12))
}

export function indexCalendarItems(items: ActionItem[]): { byDay: Map<string, ActionItem[]>; undated: ActionItem[] } {
  const byDay = new Map<string, ActionItem[]>()
  const undated: ActionItem[] = []
  const timestamps = new Map<ActionItem, number>()
  for (const item of items) {
    const date = deadlineDate(item.assignment.due_at)
    timestamps.set(item, date?.getTime() ?? Infinity)
    if (!date) { undated.push(item); continue }
    const key = dateKey(date)
    const bucket = byDay.get(key) || []
    bucket.push(item)
    byDay.set(key, bucket)
  }
  const compare = (a: ActionItem, b: ActionItem) => (timestamps.get(a) ?? Infinity) - (timestamps.get(b) ?? Infinity) || a.assignment.title.localeCompare(b.assignment.title) || a.assignment.id.localeCompare(b.assignment.id)
  for (const bucket of byDay.values()) bucket.sort(compare)
  undated.sort(compare)
  return { byDay, undated }
}
