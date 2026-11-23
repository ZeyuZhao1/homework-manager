import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, ListTodo } from 'lucide-react'
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
  const bodyRef = useRef<HTMLDivElement>(null)
  const chooseTab = (next: ActionTab) => {
    setTab(next)
    setVisibleCount(50)
    bodyRef.current?.scrollTo({ top: 0 })
  }
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000)
    return () => window.clearInterval(timer)
  }, [])
  const queue = useMemo(() => buildActionQueue(assignments, groups, courses, now), [assignments, groups, courses, now])
  const visible = queue[tab]
  const chooseLayout = (next: 'list' | 'calendar') => { setLayoutError(''); try { setTodoLayout(next) } catch (error) { setLayoutError(error instanceof Error ? error.message : '无法切换视图') } }

  return <div className="overview-content" data-native-overlap>
    <div className="overview-controls" data-native-fixed>
      <div className="overview-meta">
        <p className="overview-summary" aria-label={`${queue.items.length} 项未提交，${queue.overdueCount} 项逾期`}>
          <span>{queue.items.length} 项未提交</span>{queue.overdueCount ? <> <span aria-hidden="true">·</span> <span className="is-overdue">{queue.overdueCount} 项逾期</span></> : null}
        </p>
        <div className="overview-all"><button type="button" aria-label="查看全部作业" data-native-control="overview-all" data-native-symbol="chevron.right" onClick={() => onViewAll('all')}>全部作业 <ChevronRight size={16} aria-hidden="true" /></button></div>
      </div>
      <div className="overview-selectors">
        <div className="overview-tabs" role="group" aria-label="筛选待办" data-native-control="overview-tabs">
          <button type="button" className={tab === 'handling' ? 'active' : ''} aria-pressed={tab === 'handling'} onClick={() => chooseTab('handling')}>需要处理</button>
          <button type="button" className={tab === 'done' ? 'active' : ''} aria-pressed={tab === 'done'} onClick={() => chooseTab('done')}>待提交{queue.done.length > 0 ? <span>{queue.done.length}</span> : null}</button>
        </div>
        {calendarEnabled ? <div className="overview-layout" role="group" aria-label="待办视图" data-native-control="overview-layout">
          {([['list', '清单'], ['calendar', '日历']] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={layout === key} className={layout === key ? 'active' : ''} onClick={() => chooseLayout(key)}>{label}</button>)}
        </div> : null}
      </div>
      {layoutError && calendarEnabled ? <p role="alert" className="inline-error">{layoutError}</p> : null}
    </div>
    <div className="overview-body" ref={bodyRef} data-native-scroll-under>
      {calendarEnabled && layout === 'calendar' ? <CalendarBoundary onFallback={() => chooseLayout('list')}><Suspense fallback={<p className="overview-queue-empty" role="status">正在打开日历…</p>}><CalendarView filterKey={tab} items={visible} now={now} onOpenAssignment={onOpenAssignment} /></Suspense></CalendarBoundary> : <section className="overview-queue" aria-labelledby="overview-queue-title">
        <h2 id="overview-queue-title">按截止时间</h2>
        {visible.length ? <div className="overview-queue-list">{visible.slice(0, visibleCount).map(({ assignment, course, series, overdue }) =>
          <button type="button" className={`overview-queue-item${selectedId === assignment.id ? ' selected' : ''}`} key={assignment.id} onClick={() => onOpenAssignment(assignment.id)}>
            <span className="overview-queue-main"><strong>{assignment.title}</strong><span className="overview-queue-meta">{course}{series ? ` · ${series}` : ''}</span></span>
            <span className="overview-queue-aside"><span className={`overview-queue-date${overdue ? ' is-overdue' : ''}`}>{formatActionDeadline(assignment.due_at, now)}</span><span className={`overview-queue-status ${overdue ? 'is-overdue' : `is-${assignment.status}`}`}>{overdue ? '已逾期' : statusLabels[assignment.status]}</span></span>
            <ChevronRight className="overview-queue-arrow" size={18} aria-hidden="true" />
          </button>)}</div> : <div className="overview-queue-empty"><ListTodo size={22} aria-hidden="true" /><p>{tab === 'handling' ? '暂无需要处理的作业' : '暂无待提交的作业'}</p></div>}
        {visible.length > visibleCount ? <div className="overview-more"><span>已显示 {visibleCount} / {visible.length} 项</span><button className="button button-quiet" onClick={() => setVisibleCount(count => count + 50)}>显示更多</button></div> : null}
      </section>}
    </div>
  </div>
}
