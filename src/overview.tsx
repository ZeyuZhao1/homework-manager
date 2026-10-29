import { useEffect, useState } from 'react'
import { ArrowRight, CalendarDays, CheckCircle2, ChevronRight, Repeat2 } from 'lucide-react'
import { statusLabels } from './types'
import type { Assignment, Course, Status } from './types'
import type { AssignmentGroup } from './moduleTypes'
import { dateLabel, dueState, isOpen } from './ui'
import './overview.css'

export type OverviewFilter = 'overdue' | 'week' | 'done' | 'all'
const WEEK_MS = 7 * 86400000

function isUpcoming(value: string | null, now = Date.now()) {
  if (!value) return false
  const time = new Date(value).getTime()
  return time >= now && time < now + WEEK_MS
}

type StatusChip = { status: Status; count?: number }
type FocusItem = { id: string; title: string; course: string; at: string | null; group: boolean; note: string; statuses: StatusChip[] }
type Section = { key: Exclude<OverviewFilter, 'all'>; title: string; caption: string; empty: string; items: FocusItem[] }

export function Overview({ assignments, groups, courses, onOpenAssignment, onOpenGroup, onViewAll }: {
  assignments: Assignment[]
  groups: AssignmentGroup[]
  courses: Course[]
  onOpenAssignment: (id: string) => void
  onOpenGroup: (id: string) => void
  onViewAll: (filter: OverviewFilter) => void
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000)
    return () => window.clearInterval(timer)
  }, [])
  const courseNames = new Map(courses.map(course => [course.id, course.name]))
  const children = new Set(groups.flatMap(group => group.assignment_ids))
  const byId = new Map(assignments.map(item => [item.id, item]))
  const sections: Section[] = [
    { key: 'overdue', title: '已逾期', caption: '先处理错过截止的作业', empty: '暂无逾期作业', items: [] },
    { key: 'week', title: '未来 7 天', caption: '即将截止的作业与周期安排', empty: '暂无近期安排', items: [] },
    { key: 'done', title: '待提交', caption: '已经完成，记得最后一步', empty: '暂无待提交作业', items: [] },
  ]
  const add = (key: Section['key'], item: FocusItem) => sections.find(section => section.key === key)!.items.push(item)
  for (const item of assignments) {
    if (children.has(item.id) || !isOpen(item)) continue
    const entry: FocusItem = { id: item.id, title: item.title, course: courseNames.get(item.course_id) || '课程', at: item.due_at, group: false, note: item.due_at ? `截止 ${dateLabel(item.due_at)}` : '未设置截止时间', statuses: [{ status: item.status }] }
    if (dueState(item) === 'overdue') add('overdue', entry)
    if (isUpcoming(item.due_at, now)) add('week', entry)
    if (item.status === 'done') add('done', entry)
  }
  for (const group of groups) {
    const groupChildren = group.assignment_ids.flatMap(id => { const item = byId.get(id); return item ? [item] : [] })
    const openChildren = groupChildren.filter(isOpen)
    const statuses = (Object.keys(statusLabels) as Status[]).flatMap(status => {
      const count = groupChildren.filter(item => item.status === status).length
      return count ? [{ status, count }] : []
    })
    const entry: FocusItem = { id: group.id, title: group.title, course: courseNames.get(group.course_id) || '课程', at: group.next_at, group: true, note: '', statuses }
    const overdue = openChildren.filter(item => dueState(item) === 'overdue').sort(byDeadline)
    const upcoming = openChildren.filter(item => isUpcoming(item.due_at, now)).sort(byDeadline)
    const done = openChildren.filter(item => item.status === 'done').sort(byDeadline)
    if (overdue.length) add('overdue', { ...entry, at: overdue[0].due_at, note: `${overdue.length} 项逾期 · 截止 ${dateLabel(overdue[0].due_at)}` })
    if (upcoming.length) add('week', { ...entry, at: upcoming[0].due_at, note: `${upcoming.length} 项即将截止 · ${dateLabel(upcoming[0].due_at)}` })
    else if (group.status === 'active' && group.planned > 0 && isUpcoming(group.next_at, now)) add('week', { ...entry, note: `下次安排 ${dateLabel(group.next_at)}` })
    if (done.length) add('done', { ...entry, at: done[0].due_at, note: `${done.length} 项已完成，等待提交` })
  }
  for (const section of sections) section.items.sort((a, b) => deadline(a.at) - deadline(b.at) || a.title.localeCompare(b.title))
  const overdue = sections[0].items.length
  const pending = sections[2].items.length
  const focusTitle = overdue ? `${overdue} 项待办已逾期` : pending ? `${pending} 项作业待提交` : sections[1].items.length ? '提前安排本周学习' : '当前没有紧急待办'

  return <div className="overview-content">
    <section className={`overview-focus${overdue ? ' has-overdue' : ''}`} aria-label="学习焦点">
      <div className="overview-focus-label"><CalendarDays size={15} /><span>{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(now)}</span></div>
      <h2>{focusTitle}</h2>
      <div className="overview-counts">{sections.map(section => <button key={section.key} onClick={() => onViewAll(section.key)} aria-label={`${section.title} ${section.items.length} 项，查看全部`}><strong>{section.items.length}</strong><span>{section.key === 'week' ? '7 天内' : section.title}</span><ChevronRight size={14} /></button>)}</div>
    </section>
    <div className="overview-sections">{sections.map(section => <section className={`overview-section overview-${section.key}`} key={section.key} aria-labelledby={`overview-${section.key}-title`}>
      <div className="overview-section-heading"><div><h2 id={`overview-${section.key}-title`}>{section.title}<span>{section.items.length}</span></h2></div>{section.items.length > 0 ? <button onClick={() => onViewAll(section.key)}>查看全部<ChevronRight size={14} /></button> : null}</div>
      {section.items.length ? <div className="overview-list">{section.items.slice(0, 3).map(item => <button className="overview-item" key={item.id} onClick={() => item.group ? onOpenGroup(item.id) : onOpenAssignment(item.id)}><div className="overview-item-content"><span className="overview-item-course">{item.course}{item.group ? <><span aria-hidden="true"> · </span><Repeat2 size={12} />周期作业</> : null}</span><div className="overview-item-title"><strong>{item.title}</strong>{!item.group ? <span className={`status status-${item.statuses[0].status} overview-status`}>{statusLabels[item.statuses[0].status]}</span> : null}</div>{item.group ? <span className="overview-item-statuses"><span className="overview-status-label">子作业</span>{item.statuses.length ? item.statuses.map(chip => <span className={`status status-${chip.status} overview-status`} key={chip.status}>{statusLabels[chip.status]} {chip.count}</span>) : <span className="overview-status-label">尚未生成</span>}</span> : null}<span className="overview-item-note">{item.note}</span></div><ChevronRight className="overview-item-arrow" size={17} /></button>)}</div> : <div className="overview-empty"><CheckCircle2 size={18} /><p>{section.empty}</p></div>}
    </section>)}</div>
    <div className="overview-footer"><button onClick={() => onViewAll('all')}>查看全部作业<ArrowRight size={16} /></button></div>
  </div>
}

function deadline(value: string | null) { return value && Number.isFinite(new Date(value).getTime()) ? new Date(value).getTime() : Infinity }
function byDeadline(a: Assignment, b: Assignment) { return deadline(a.due_at) - deadline(b.due_at) }
