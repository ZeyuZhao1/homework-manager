import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { ActionItem } from '../../actionQueue'
import { statusLabels } from '../../types'
import { calendarOverdue, dateKey, formatCalendarDeadline, indexCalendarItems, monthDays, monthStart } from './calendarDates'
import './calendar.css'

export function CalendarView({ items, now, onOpenAssignment, filterKey = '' }: { items: ActionItem[]; now: number; onOpenAssignment: (id: string) => void; filterKey?: string }) {
  const [month, setMonth] = useState(() => monthStart(new Date(now)))
  const [selected, setSelected] = useState(() => dateKey(new Date(now)))
  const [showUndated, setShowUndated] = useState(false)
  const [selectionVersion, setSelectionVersion] = useState(0)
  const { byDay, undated } = useMemo(() => indexCalendarItems(items), [items])
  const days = useMemo(() => monthDays(month), [month])
  const today = dateKey(new Date(now))
  const selectedItems = showUndated ? undated : byDay.get(selected) || []
  const selectedLabel = showUndated ? '未安排日期' : selected.replace(/^(\d+)-(\d+)-(\d+)$/, (_, y, m, d) => `${y}年${Number(m)}月${Number(d)}日`)
  const selectDay = (date: Date) => { setSelected(dateKey(date)); setMonth(monthStart(date)); setShowUndated(false); setSelectionVersion(version => version + 1) }
  const moveMonth = (offset: number) => selectDay(monthStart(month, offset))

  return <section className="calendar-view" aria-label="作业日历">
    <div className="calendar-heading"><h2 aria-live="polite">{month.getFullYear()}年 {month.getMonth() + 1}月</h2><div className="calendar-controls">
      <button type="button" onClick={() => moveMonth(-1)} aria-label="上个月"><ChevronLeft size={17} aria-hidden="true" /></button>
      <button type="button" onClick={() => selectDay(new Date(now))}>今天</button>
      <button type="button" onClick={() => moveMonth(1)} aria-label="下个月"><ChevronRight size={17} aria-hidden="true" /></button>
    </div></div>
    <div className="calendar-layout"><div className="calendar-month">
      <div className="calendar-weekdays" aria-hidden="true">{['一', '二', '三', '四', '五', '六', '日'].map(day => <span key={day}>{day}</span>)}</div>
      <div className="calendar-days">{days.map(day => {
        const key = dateKey(day), count = byDay.get(key)?.length || 0
        return <button type="button" key={key} className={`calendar-day${day.getMonth() !== month.getMonth() ? ' is-outside' : ''}${key === today ? ' is-today' : ''}${!showUndated && key === selected ? ' is-selected' : ''}`} aria-label={`${day.getFullYear()}年${day.getMonth() + 1}月${day.getDate()}日，${count}项作业${key === today ? '，今天' : ''}`} aria-pressed={!showUndated && key === selected} onClick={() => selectDay(day)}><span>{day.getDate()}</span>{count > 0 && <small>{count > 99 ? '99+' : count}</small>}</button>
      })}</div>
      <button className={`calendar-undated${showUndated ? ' is-selected' : ''}`} type="button" aria-pressed={showUndated} onClick={() => { setShowUndated(true); setSelectionVersion(version => version + 1) }}>未安排日期 <span>{undated.length}</span></button>
    </div><CalendarAgenda key={`${filterKey}:${showUndated ? 'undated' : selected}:${selectionVersion}`} items={selectedItems} label={selectedLabel} showUndated={showUndated} now={now} onOpenAssignment={onOpenAssignment} /></div>
  </section>
}


function CalendarAgenda({ items, label, showUndated, now, onOpenAssignment }: { items: ActionItem[]; label: string; showUndated: boolean; now: number; onOpenAssignment: (id: string) => void }) {
  const [visibleCount, setVisibleCount] = useState(50)
  return <div className="calendar-agenda"><div className="calendar-agenda-heading"><h3>{label}</h3><span>{items.length} 项作业</span></div>
    {items.length ? <div className="calendar-agenda-list">{items.slice(0, visibleCount).map(({ assignment, course, series }) => {
      const overdue = calendarOverdue(assignment.due_at, now)
      return <button type="button" key={assignment.id} className="calendar-agenda-item" onClick={() => onOpenAssignment(assignment.id)}><span className="calendar-agenda-main"><strong>{assignment.title}</strong><span>{course}{series ? ` · ${series}` : ''}</span></span><span className="calendar-agenda-meta"><span className={overdue ? 'is-overdue' : ''}>{formatCalendarDeadline(assignment.due_at, now)}</span><span>{overdue ? '已逾期' : statusLabels[assignment.status]}</span></span><ChevronRight size={16} aria-hidden="true" /></button>
    })}{items.length > visibleCount && <button type="button" className="calendar-more" onClick={() => setVisibleCount(count => count + 50)}>显示更多（已显示 {visibleCount} / {items.length}）</button>}</div> : <p className="calendar-empty">{showUndated ? '没有未安排日期的作业' : '这一天没有作业'}</p>}
  </div>
}
