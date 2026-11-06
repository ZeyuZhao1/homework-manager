import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { statusLabels } from './types'
import type { Assignment, Course } from './types'
import type { AssignmentGroup } from './moduleTypes'
import { buildActionQueue, formatActionDeadline } from './actionQueue'
import type { ActionTab } from './actionQueue'
import { CalendarBoundary } from './extensions/calendar/CalendarBoundary'
import { setTodoLayout, useCalendarEnabled, useTodoLayout } from './extensions/calendar/preferences'
import './overview.css'

const CalendarView = lazy(() => import('./extensions/calendar/CalendarView').then(module => ({ default: module.CalendarView })))

export type OverviewFilter = 'overdue' | 'week' | 'done' | 'all'

export function Overview({ assignments, groups, courses, onOpenAssignment, onViewAll, selectedId = '' }: {
  selectedId?: string
  assignments: Assignment[]
  groups: AssignmentGroup[]
  courses: Course[]
  onOpenAssignment: (id: string) => void
  onOpenGroup: (id: string) => void
  onViewAll: (filter: OverviewFilter) => void
}) {
  const calendarEnabled = useCalendarEnabled()
  const layout = useTodoLayout()
  const [layoutError, setLayoutError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [tab, setTab] = useState<ActionTab>('handling')
  const [visibleCount, setVisibleCount] = useState(50)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000)
    return () => window.clearInterval(timer)
  }, [])
  const queue = useMemo(() => buildActionQueue(assignments, groups, courses, now), [assignments, groups, courses, now])
  const visible = queue[tab]
  const chooseLayout = (next: 'list' | 'calendar') => { setLayoutError(''); try { setTodoLayout(next) } catch (error) { setLayoutError(error instanceof Error ? error.message : '无法切换视图') } }

  return <div className="overview-content">
    <p className="overview-summary" aria-label={`${queue.items.length} 项未提交，${queue.overdueCount} 项逾期`}>
      <span>{queue.items.length} 项</span><span aria-hidden="true"> · </span><span className={queue.overdueCount ? 'is-overdue' : ''}>{queue.overdueCount} 项逾期</span>
    </p>
    {calendarEnabled ? <div className="overview-layout" role="group" aria-label="待办视图">{([['list', '清单'], ['calendar', '日历']] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={layout === key} className={layout === key ? 'active' : ''} onClick={() => chooseLayout(key)}>{label}</button>)}</div> : null}
    {layoutError && calendarEnabled ? <p role="alert" className="inline-error">{layoutError}</p> : null}
    <div className="overview-tabs" role="group" aria-label="筛选待办">
      <button type="button" className={tab === 'handling' ? 'active' : ''} aria-pressed={tab === 'handling'} onClick={() => { setTab('handling'); setVisibleCount(50) }}>需要处理</button>
      <button type="button" className={tab === 'done' ? 'active' : ''} aria-pressed={tab === 'done'} onClick={() => { setTab('done'); setVisibleCount(50) }}>待提交 <span>{queue.done.length}</span></button>
    </div>
    {calendarEnabled && layout === 'calendar' ? <CalendarBoundary onFallback={() => chooseLayout('list')}><Suspense fallback={<p className="overview-queue-empty" role="status">正在打开日历…</p>}><CalendarView filterKey={tab} items={visible} now={now} onOpenAssignment={onOpenAssignment} /></Suspense></CalendarBoundary> : <section className="overview-queue" aria-labelledby="overview-queue-title">
      <h2 id="overview-queue-title">按截止时间</h2>
      {visible.length ? <div className="overview-queue-list">{visible.slice(0, visibleCount).map(({ assignment, course, series, overdue }) =>
        <button type="button" className={`overview-queue-item${selectedId === assignment.id ? ' selected' : ''}`} key={assignment.id} onClick={() => onOpenAssignment(assignment.id)}>
          <span className="overview-queue-main"><strong>{assignment.title}</strong><span className="overview-queue-meta">{course}{series ? ` · ${series}` : ''}</span></span>
          <span className="overview-queue-aside"><span className={`overview-queue-date${overdue ? ' is-overdue' : ''}`}>{formatActionDeadline(assignment.due_at, now)}</span><span className={`overview-queue-status ${overdue ? 'is-overdue' : `is-${assignment.status}`}`}>{overdue ? '已逾期' : statusLabels[assignment.status]}</span></span>
          <ChevronRight className="overview-queue-arrow" size={18} aria-hidden="true" />
        </button>)}</div> : <p className="overview-queue-empty">{tab === 'handling' ? '暂无需要处理的作业' : '暂无待提交的作业'}</p>}
      {visible.length > visibleCount ? <div className="overview-more"><span>已显示 {visibleCount} / {visible.length} 项</span><button className="button button-quiet" onClick={() => setVisibleCount(count => count + 50)}>显示更多</button></div> : null}
    </section>}
    <div className="overview-all"><button type="button" onClick={() => onViewAll('all')}>查看全部作业 <ChevronRight size={17} aria-hidden="true" /></button></div>
  </div>
}
