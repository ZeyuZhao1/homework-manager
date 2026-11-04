import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { statusLabels } from './types'
import type { Assignment, Course } from './types'
import type { AssignmentGroup } from './moduleTypes'
import { buildActionQueue, formatActionDeadline } from './actionQueue'
import type { ActionTab } from './actionQueue'
import './overview.css'

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
  const [now, setNow] = useState(() => Date.now())
  const [tab, setTab] = useState<ActionTab>('handling')
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000)
    return () => window.clearInterval(timer)
  }, [])
  const queue = buildActionQueue(assignments, groups, courses, now)
  const visible = queue[tab]

  return <div className="overview-content">
    <p className="overview-summary" aria-label={`${queue.items.length} 项未提交，${queue.overdueCount} 项逾期`}>
      <span>{queue.items.length} 项</span><span aria-hidden="true"> · </span><span className={queue.overdueCount ? 'is-overdue' : ''}>{queue.overdueCount} 项逾期</span>
    </p>
    <div className="overview-tabs" role="group" aria-label="筛选待办">
      <button type="button" className={tab === 'handling' ? 'active' : ''} aria-pressed={tab === 'handling'} onClick={() => setTab('handling')}>需要处理</button>
      <button type="button" className={tab === 'done' ? 'active' : ''} aria-pressed={tab === 'done'} onClick={() => setTab('done')}>待提交 <span>{queue.done.length}</span></button>
    </div>
    <section className="overview-queue" aria-labelledby="overview-queue-title">
      <h2 id="overview-queue-title">按截止时间</h2>
      {visible.length ? <div className="overview-queue-list">{visible.map(({ assignment, course, series, overdue }) =>
        <button type="button" className={`overview-queue-item${selectedId === assignment.id ? ' selected' : ''}`} key={assignment.id} onClick={() => onOpenAssignment(assignment.id)}>
          <span className="overview-queue-main"><strong>{assignment.title}</strong><span className="overview-queue-meta">{course}{series ? ` · ${series}` : ''}</span></span>
          <span className="overview-queue-aside"><span className={`overview-queue-date${overdue ? ' is-overdue' : ''}`}>{formatActionDeadline(assignment.due_at, now)}</span><span className={`overview-queue-status ${overdue ? 'is-overdue' : `is-${assignment.status}`}`}>{overdue ? '已逾期' : statusLabels[assignment.status]}</span></span>
          <ChevronRight className="overview-queue-arrow" size={18} aria-hidden="true" />
        </button>)}</div> : <p className="overview-queue-empty">{tab === 'handling' ? '暂无需要处理的作业' : '暂无待提交的作业'}</p>}
    </section>
    <div className="overview-all"><button type="button" onClick={() => onViewAll('all')}>查看全部作业 <ChevronRight size={17} aria-hidden="true" /></button></div>
  </div>
}
