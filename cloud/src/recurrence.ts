import type { EntityData, EntityType, SyncEntity, SyncMutation } from '../../src/sync/protocol'
import type { EntityStore } from './store'

const LIMIT = 5000
const AUTO_LIMIT = 10
const DAY = 86400000
const localPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/
type Row = EntityData & { id: string }
type Candidate = { number: number; at: string | null }
export type RecurrenceStore = Pick<EntityStore, 'snapshot' | 'read' | 'commit'>
const text = (v: unknown, fallback = '') => typeof v === 'string' ? v : fallback
const integer = (v: unknown, fallback: number) => typeof v === 'number' && Number.isInteger(v) ? v : fallback
const parse = (v: unknown): EntityData => { if (typeof v === 'string') return JSON.parse(v) as EntityData; if (v && typeof v === 'object') return v as EntityData; throw new Error('周期规则格式无效') }
function date(value: unknown): Date {
  const raw = text(value)
  const result = new Date(`${raw}Z`)
  if (!localPattern.test(raw) || !Number.isFinite(result.getTime()) || stamp(result) !== raw) throw new Error('周期日期时间无效')
  return result
}
const stamp = (v: Date) => v.toISOString().slice(0, 19)
const addDays = (at: string, days: number) => stamp(new Date(date(at).getTime() + days * DAY))
const weekday = (d: Date) => d.getUTCDay() || 7
export function zonedNow(now: Date, timezone = 'Asia/Shanghai'): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const p = Object.fromEntries(parts.map(v => [v.type, v.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`
}
function dueAt(at: string, rule: EntityData): string | null {
  if (rule.kind === 'none') return null
  if (rule.kind !== 'after_days' || !/^\d\d:\d\d$/.test(text(rule.time))) throw new Error('截止规则无效')
  const days = integer(rule.days, -1)
  if (days < 0 || days > 36500) throw new Error('截止天数无效')
  const result = `${addDays(at, days).slice(0, 10)}T${rule.time}:00`
  date(result)
  if (result < at) throw new Error('截止时间不能早于生成时间')
  return result
}
function positive(value: unknown, fallback: number, max = LIMIT): number {
  const n = integer(value, fallback)
  if (n < 1 || n > max) throw new Error('周期范围无效')
  return n
}
/** Wall-clock arithmetic deliberately uses UTC containers; actual comparisons use the rule's timezone. */
export function candidateDates(series: Row, calendars: Row[]): Candidate[] {
  const rule = parse(series.rule_json)
  if (rule.version !== 1) throw new Error('周期规则版本无效')
  if (series.max_occurrences == null && series.end_at == null) throw new Error('周期必须有结束条件')
  const max = positive(series.max_occurrences, LIMIT)
  const end = series.end_at == null ? null : stamp(date(series.end_at))
  const values: Candidate[] = []
  const push = (number: number, at: string | null) => { if (values.length < max && (at == null || !end || at <= end)) values.push({ number, at }) }
  if (rule.kind === 'sequence') {
    const at = stamp(date(rule.first_at)), first = positive(rule.start_num, 1, 0xffffffff), last = positive(rule.end_num, first, 0xffffffff)
    if (last < first || !['done', 'submitted'].includes(text(rule.completion_trigger))) throw new Error('序列范围无效')
    if (!end || at <= end) for (let n = first; n <= last && values.length < max; n++) push(n, n === first ? at : null)
  } else if (rule.kind === 'custom_dates') {
    if (!Array.isArray(rule.dates) || !rule.dates.length || rule.dates.length > LIMIT) throw new Error('自定义日期无效')
    for (const at of [...new Set(rule.dates.map(v => stamp(date(v))))].sort()) push(values.length + 1, at)
  } else if (rule.kind === 'academic_week') {
    const calendar = calendars.find(c => c.id === rule.semester_id)
    if (!calendar) throw new Error('请先设置教学周起点')
    const start = stamp(date(`${calendar.week1_start_date}T00:00:00`)), day = positive(rule.weekday, 1, 7)
    if (!Array.isArray(rule.weeks) || !rule.weeks.length) throw new Error('教学周无效')
    for (const week of [...new Set(rule.weeks.map(v => positive(v, 1, 60)))].sort((a,b) => a-b)) {
      const at = `${addDays(start, (week - 1) * 7 + day - 1).slice(0, 10)}T${text(rule.time)}:00`
      push(week, stamp(date(at)))
    }
  } else if (rule.kind === 'timed') {
    const start = stamp(date(rule.start_at)), startDate = date(start), every = positive(rule.every, 1, 365)
    if (rule.frequency === 'day') {
      for (let i = 0; values.length < max && i < LIMIT; i++) { const at = addDays(start, i * every); if (end && at > end) break; push(values.length + 1, at) }
    } else if (rule.frequency === 'week') {
      if (!Array.isArray(rule.weekdays) || !rule.weekdays.length) throw new Error('请选择每周日期')
      const selected = new Set(rule.weekdays.map(v => positive(v, 1, 7)))
      let finished = false
      for (let cycle = 0; cycle * every < LIMIT && values.length < max && !finished; cycle++) {
        for (let offset = 0; offset < 7 && values.length < max; offset++) {
          const at = addDays(start, cycle * every * 7 + offset)
          if (end && at > end) { finished = true; break }
          if (selected.has(weekday(date(at)))) push(values.length + 1, at)
        }
      }
    } else if (rule.frequency === 'month') {
      for (let i = 0; i < LIMIT && values.length < max; i++) {
        const month = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + i * every, 1))
        const last = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate()
        let day: number
        if (rule.month_mode === 'nth_weekday') {
          const target = positive(rule.month_weekday, 1, 7), nth = integer(rule.month_week, 1)
          if (nth !== -1 && (nth < 1 || nth > 5)) throw new Error('月内星期无效')
          if (nth === -1) { month.setUTCDate(last); day = last - (weekday(month) - target + 7) % 7 }
          else { day = 1 + (target - weekday(month) + 7) % 7 + (nth - 1) * 7; if (day > last) day -= 7 }
        } else day = Math.min(positive(rule.month_day, 1, 31), last)
        month.setUTCDate(day)
        const at = `${stamp(month).slice(0,10)}${start.slice(10)}`
        if (end && at > end) break
        if (at >= start) push(values.length + 1, at)
      }
    } else throw new Error('不支持的周期频率')
  } else throw new Error('不支持的周期规则')
  if (!values.length) throw new Error('周期没有可生成节点')
  return values
}
function rows(entities: SyncEntity[], type: EntityType): Row[] { return entities.filter(e => e.entity_type === type && e.data !== null).map(e => ({ ...e.data, id: e.entity_id })) }
function mutation(type: EntityType, row: Row): SyncMutation { const { id, ...data } = row; return { entity_type: type, entity_id: id, data } }
const occurrenceId = (series: string, number: number) => `recurring:${series}:${number}`
const assignmentId = (id: string) => `assignment:${id}`
function title(series: Row, occurrence: Row): string { return text(series.title_template).replaceAll('{num}', String(occurrence.sequence_no)).replaceAll('{week}', String(occurrence.sequence_no)).replaceAll('{date}', text(occurrence.scheduled_at).slice(0,10)) }
function generatedAssignment(series: Row, o: Row, now: string): Row {
  return { id: assignmentId(o.id), course_id: series.course_id, title: title(series,o), description: series.description ?? '', due_at: o.due_at, status: 'todo', submission_label: series.submission_label ?? '', submission_url: series.submission_url ?? '', submission_notes: series.submission_notes ?? '', source_name: '周期作业', source_text: series.name, custom_fields: {}, created_at: now, updated_at: now }
}
function calculate(store: RecurrenceStore, now: Date, action?: { action: string; id?: string; decisions?: { occurrence_id: string; action: string }[] }): { changes: SyncMutation[]; assignment_id?: string } {
  const entities = store.snapshot().entities, seriesRows = rows(entities, 'recurring_series'), calendars = rows(entities, 'calendar')
  const moduleState = rows(entities, 'module_state').find(row => row.id === 'builtin.assignment.recurring')
  if (moduleState && (moduleState.enabled === false || moduleState.enabled === 0)) { if (action) throw new Error('周期作业模块已停用'); return { changes:[] } }
  const occurrenceRows = rows(entities, 'recurring_occurrence'), assignments = new Map(rows(entities, 'assignment').map(a => [a.id, a]))
  const changes: SyncMutation[] = [], all = new Map(occurrenceRows.map(o => [o.id, o])), due: { series: Row; occurrence: Row; now: string }[] = []
  const update = (o: Row) => { all.set(o.id, o); changes.push(mutation('recurring_occurrence', o)) }
  for (const series of seriesRows) {
    const rule = parse(series.rule_json), dueRule = parse(series.due_rule_json)
    const localNow = zonedNow(now, text(rule.timezone, text(series.timezone, 'Asia/Shanghai')))
    if (dueRule.version !== 1) throw new Error('截止规则版本无效')
    const existing = [...all.values()].filter(o => o.series_id === series.id), byNumber = new Map(existing.map(o => [integer(o.sequence_no, 0), o]))
    if (series.status === 'ended' || series.status === 'archived') {
      for (const o of existing) if (!o.assignment_id && ['planned','blocked'].includes(text(o.state))) update({ ...o, state: 'cancelled', updated_at: localNow })
      continue
    }
    // Paused rules retain the plan and cannot create assignments through any entry point.
    if (series.status !== 'active') continue
    const candidates = candidateDates(series, calendars), numbers = new Set(candidates.map(c => c.number))
    for (const o of existing) if (!numbers.has(integer(o.sequence_no,0)) && !o.assignment_id && ['planned','blocked'].includes(text(o.state))) update({ ...o, state:'cancelled', updated_at:localNow })
    for (const c of candidates) {
      const old = byNumber.get(c.number), id = old?.id ?? occurrenceId(series.id, c.number)
      if (!old && store.read('recurring_occurrence', id)?.data === null) continue
      // Reuse migrated IDs and terminal/generated nodes. User overrides are never rewritten.
      let o: Row = old ?? { id, series_id:series.id, sequence_no:c.number, state:c.at ? 'planned':'blocked', scheduled_at:c.at, due_at:c.at ? dueAt(c.at,dueRule):null, assignment_id:null, overridden:0, created_at:localNow, updated_at:localNow }
      if (old && !old.assignment_id && ['planned','blocked'].includes(text(old.state)) && !(rule.kind === 'sequence' && old.state === 'planned' && c.at === null)) o = { ...old, scheduled_at:c.at, due_at:c.at ? dueAt(c.at,dueRule):null, state:c.at ? 'planned':'blocked' }
      if (!old || JSON.stringify(o) !== JSON.stringify(old)) update(o)
      if (o.assignment_id) {
        const assignment = assignments.get(text(o.assignment_id))
        if (!assignment) { update({ ...o, assignment_id:null, state:'skipped', updated_at:localNow }); continue }
        const expected = generatedAssignment(series,o,localNow)
        const overridden = ['course_id','title','description','due_at','submission_label','submission_url','submission_notes'].some(k => assignment[k] !== expected[k])
        if (Boolean(o.overridden) !== overridden) update({ ...o, overridden:overridden ? 1:0, updated_at:localNow })
      }
    }
    if (rule.kind === 'sequence') {
      const sorted = [...all.values()].filter(o => o.series_id === series.id).sort((a,b) => Number(a.sequence_no)-Number(b.sequence_no))
      for (let i = 1; i < sorted.length; i++) {
        const o = sorted[i], previous = sorted[i-1], a = assignments.get(text(previous.assignment_id))
        const completed = a && (rule.completion_trigger === 'submitted' ? a.status === 'submitted' : ['done','submitted'].includes(text(a.status)))
        if (o.state === 'blocked' && completed) {
          if (series.end_at && text(series.end_at) < localNow) update({ ...o, state:'cancelled', updated_at:localNow })
          else update({ ...o, state:'planned', scheduled_at:localNow, due_at:dueAt(localNow,dueRule), updated_at:localNow })
        }
      }
    }
    for (const o of all.values()) if (o.series_id === series.id && o.state === 'planned' && !o.assignment_id && o.scheduled_at && text(o.scheduled_at) <= localNow) due.push({ series, occurrence:o, now:localNow })
  }
  const generate = (series: Row, o: Row, localNow: string) => {
    if (o.assignment_id) return text(o.assignment_id)
    if (series.status !== 'active' || !['planned','blocked'].includes(text(o.state))) throw new Error('该周期节点当前不能生成')
    if (!o.scheduled_at) o = { ...o, scheduled_at:localNow, due_at:dueAt(localNow,parse(series.due_rule_json)) }
    const a = generatedAssignment(series,o,localNow)
    // A tombstoned generated assignment is never recreated by a retry or stale plan.
    if (store.read('assignment', a.id)?.data === null) { update({ ...o, state:'skipped', updated_at:localNow }); throw new Error('该节点作业已删除') }
    if (!assignments.has(a.id)) { changes.push(mutation('assignment',a)); assignments.set(a.id,a) }
    update({ ...o, assignment_id:a.id, state:'generated', updated_at:localNow })
    return a.id
  }
  let result: string | undefined
  if (action) {
    const decisions = action.action === 'catchup' ? action.decisions : [{ occurrence_id:action.id ?? '', action:action.action }]
    if (!decisions?.length || decisions.length > LIMIT) throw new Error('周期操作无效')
    for (const decision of decisions) {
      const o = all.get(decision.occurrence_id), series = seriesRows.find(s => s.id === o?.series_id)
      if (!o || !series) throw new Error('周期节点不存在')
      const localNow = zonedNow(now,text(parse(series.rule_json).timezone,text(series.timezone,'Asia/Shanghai')))
      if (decision.action === 'generate') result = generate(series,o,localNow)
      else if (decision.action === 'skip' && !o.assignment_id && ['planned','blocked','skipped'].includes(text(o.state))) update({ ...o,state:'skipped',updated_at:localNow })
      else throw new Error('该周期操作无效')
    }
  } else if (due.length <= AUTO_LIMIT) for (const item of due) generate(item.series,item.occurrence,item.now)
  // Coalesce intermediate plan/unblock/generate changes to one final row per entity.
  return { changes:[...new Map(changes.map(c => [`${c.entity_type}:${c.entity_id}`,c])).values()].sort((a,b) => Number(b.entity_type === 'assignment') - Number(a.entity_type === 'assignment')), assignment_id:result }
}
function commit(store: RecurrenceStore, changes: SyncMutation[]) {
  if (changes.length) store.commit(`recurrence:${crypto.randomUUID()}`,changes)
}
export function runRecurrence(store: RecurrenceStore, now: Date = new Date()): void { commit(store,calculate(store,now).changes) }
export function recurringAction(store: RecurrenceStore, body: unknown, now: Date = new Date()): { assignment_id?: string } {
  if (!body || typeof body !== 'object') throw new Error('周期操作无效')
  const action = body as { action:string; id?:string; decisions?:{ occurrence_id:string; action:string }[] }
  if (!['generate','skip','catchup'].includes(action.action)) throw new Error('周期操作无效')
  const result = calculate(store,now,action); commit(store,result.changes)
  return { assignment_id:result.assignment_id }
}
