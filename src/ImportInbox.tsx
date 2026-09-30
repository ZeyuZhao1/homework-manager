import { useCallback, useEffect, useState } from 'react'
import { Check, RefreshCw, X } from 'lucide-react'
import { service } from './service'
import { errorText } from './ui'
import type { ModuleDescriptor, Snapshot } from './types'
import type { ApplyImport, CourseChoice, ImportDecision, ImportItem, ImportPreview, RemoteAssignment, RemoteSnapshot } from './importSync'
import './ImportInbox.css'

const key = (item: ImportItem) => `${item.remote.course_id}:${item.remote.id}`
const fields = [
  ['title', '标题'], ['description', '说明'], ['due_at', '截止时间'],
  ['submission_url', '提交链接'], ['status', '提交状态'],
] as const
function sourceValue(item: RemoteAssignment, field: string) {
  if (field === 'submission_url') return item.url
  if (field === 'status') return item.status === 'unknown' ? '未确认提交' : '已提交'
  return String(item[field as keyof RemoteAssignment] ?? '未设置')
}
function localValue(local: ImportItem['local'], field: string) {
  return String(local?.[field as keyof NonNullable<ImportItem['local']>] ?? '未设置')
}
function defaultFields(item: ImportItem) {
  if (!item.local) return []
  return fields.filter(([field]) => {
    if (field === 'status') return item.remote.status !== 'unknown' && item.local?.status !== 'submitted'
    const source = field === 'submission_url' ? item.remote.url : item.remote[field]
    const current = item.local?.[field]
    if (source === current) return false
    if (!item.baseline) return false
    const before = field === 'submission_url' ? item.baseline.url : item.baseline[field]
    return current === before
  }).map(([field]) => field)
}

export function ImportInbox({ modules, snapshot: appSnapshot, onClose, onSaved }: {
  modules: ModuleDescriptor[]; snapshot: Snapshot; onClose: () => void; onSaved: () => Promise<void>
}) {
  const [moduleId, setModuleId] = useState(modules[0]?.id || '')
  const [source, setSource] = useState<RemoteSnapshot | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [courseChoices, setCourseChoices] = useState<Record<string, CourseChoice>>({})
  const [decisions, setDecisions] = useState<Record<string, ImportDecision>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const load = useCallback(async (id: string) => {
    if (!id) return
    setBusy(true); setError(''); setSaved('')
    try {
      const result = await service.invokeModule<RemoteSnapshot>(id, 'assignment.sync.snapshot', {})
      const review = await service.previewAssignmentImport(id, result)
      setSource(result); setPreview(review)
      setCourseChoices(Object.fromEntries(review.courses.map(item => [item.remote.id, { remote_course_id:item.remote.id, course_id:item.local_course_id, semester_id:appSnapshot.semesters[0]?.id || '', new_name:item.remote.name }])))
      setDecisions(Object.fromEntries(review.items.map(item => [key(item), {
        remote_course_id:item.remote.course_id, remote_assignment_id:item.remote.id,
        action:item.linked_assignment_id ? 'update' : 'create',
        assignment_id:item.linked_assignment_id, fields:defaultFields(item),
      }])))
    } catch (e) { setError(errorText(e)); setSource(null); setPreview(null) }
    finally { setBusy(false) }
  }, [appSnapshot.semesters])
  useEffect(() => { const timer=window.setTimeout(() => void load(moduleId),0); return () => window.clearTimeout(timer) }, [moduleId,load])
  const edit = (id: string, patch: Partial<ImportDecision>) => setDecisions(current => ({...current,[id]:{...current[id],...patch}}))
  const editCourse = (id: string, patch: Partial<CourseChoice>) => setCourseChoices(current => ({...current,[id]:{...current[id],...patch}}))
  const apply = async () => {
    if (!source || !preview) return
    const relevant = Object.values(decisions).filter(item => item.action !== 'defer')
    if (!relevant.length) {onClose();return}
    const needed = new Set(relevant.filter(item => item.action !== 'ignore').map(item => item.remote_course_id))
    const courses = Object.values(courseChoices).filter(item => needed.has(item.remote_course_id))
    if (courses.some(item => !item.course_id && (!item.semester_id || !item.new_name.trim()))) {setError('请先匹配课程，或选择学期并填写新课程名称');return}
    if (relevant.some(item => item.action === 'link' && !item.assignment_id)) {setError('请为关联项选择已有作业');return}
    setBusy(true);setError('')
    try {
      const payload: ApplyImport = {module_id:moduleId,snapshot:source,courses,decisions:relevant}
      const count = await service.applyAssignmentImport(payload)
      await onSaved()
      setSaved(`已处理 ${count} 项作业`)
      await load(moduleId)
    } catch(e) {setError(errorText(e))} finally {setBusy(false)}
  }
  return <div className="import-backdrop" onMouseDown={event => {if(event.target===event.currentTarget)onClose()}}>
    <aside className="import-inbox" role="dialog" aria-modal="true" aria-labelledby="import-inbox-title">
      <header><div><small>外部来源</small><h2 id="import-inbox-title">导入待审核</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={20}/></button></header>
      <div className="import-body">
        <div className="import-toolbar"><label>来源模块<select value={moduleId} onChange={event => setModuleId(event.target.value)}>{modules.map(module => <option key={module.id} value={module.id}>{module.name}</option>)}</select></label><button className="button button-quiet" onClick={() => void load(moduleId)} disabled={busy}><RefreshCw size={16}/>读取最新结果</button></div>
        {source && <p className="helper-text">最近检查：{new Date(source.checked_at).toLocaleString('zh-CN')} · {source.courses.length} 门课程 · {source.assignments.length} 项已确认作业。作业数据仅在你确认后写入主程序。</p>}
        {source?.warnings.map((warning,index) => <p className="import-warning" key={index}>{warning}</p>)}
        {preview?.courses.filter(item => preview.items.some(task => task.remote.course_id===item.remote.id)).map(item => {const choice=courseChoices[item.remote.id];return <div className="import-course" key={item.remote.id}><strong>{item.remote.name}</strong><small>{item.remote.code} · {item.remote.term}</small><label>对应课程<select value={choice?.course_id || ''} onChange={event => editCourse(item.remote.id,{course_id:event.target.value})}><option value="">新建课程</option>{appSnapshot.courses.map(course => <option key={course.id} value={course.id}>{course.name}</option>)}</select></label>{!choice?.course_id && <div className="import-new-course"><label>学期<select value={choice?.semester_id || ''} onChange={event => editCourse(item.remote.id,{semester_id:event.target.value})}>{appSnapshot.semesters.map(semester => <option key={semester.id} value={semester.id}>{semester.name}</option>)}</select></label><label>新课程名称<input value={choice?.new_name || ''} onChange={event => editCourse(item.remote.id,{new_name:event.target.value})}/></label></div>}</div>})}
        {preview?.items.map(item => {const id=key(item),decision=decisions[id];if(!decision)return null;const candidateCourse=courseChoices[item.remote.course_id]?.course_id;const candidates=appSnapshot.assignments.filter(a => a.course_id===candidateCourse);const selected=candidates.find(a=>a.id===decision.assignment_id);const local=item.local||selected&&{title:selected.title,description:selected.description,due_at:selected.due_at,status:selected.status,submission_url:selected.submission_url}||null;return <section className="import-item" key={id}><div className="import-item-heading"><div><strong>{item.remote.title}</strong><small>{item.remote.due_at || '无明确截止时间'} · {item.remote.status==='unknown'?'未确认提交':'BB 已提交'}</small></div><select aria-label={`${item.remote.title} 的处理方式`} value={decision.action} onChange={event => edit(id,{action:event.target.value as ImportDecision['action'],fields:defaultFields(item),assignment_id:item.linked_assignment_id})}><option value={item.linked_assignment_id?'update':'create'}>{item.linked_assignment_id?'审核更新':'创建新作业'}</option>{!item.linked_assignment_id && <option value="link">关联已有作业</option>}<option value="ignore">忽略本次变化</option><option value="defer">暂缓处理</option></select></div>
          {decision.action==='link' && <label>关联到<select value={decision.assignment_id} onChange={event => edit(id,{assignment_id:event.target.value,fields:[]})}><option value="">请选择已有作业</option>{candidates.map(a => <option key={a.id} value={a.id}>{a.title}{item.suggested_assignment_ids.includes(a.id)?' · 建议':''}</option>)}</select></label>}
          {(decision.action==='update'||decision.action==='link'&&local) && <div className="import-diffs">{fields.filter(([field]) => {
            const value=field==='submission_url'?item.remote.url:item.remote[field];const old=decision.action==='link' ? local?.[field as keyof NonNullable<typeof local>] : field==='submission_url'?item.baseline?.url:item.baseline?.[field as keyof RemoteAssignment];return value!==old && (field!=='status'||item.remote.status!=='unknown')
          }).map(([field,label]) => <label className="import-diff" key={field}><input type="checkbox" checked={decision.fields.includes(field)} onChange={event => edit(id,{fields:event.target.checked?[...decision.fields,field]:decision.fields.filter(value => value!==field)})}/><span><b>{label}</b><small>本地：{localValue(local,field)}</small><small>BB：{sourceValue(item.remote,field)}</small></span></label>)}</div>}
          {decision.action==='create' && <p className="helper-text">{item.remote.description || '无说明'}{item.remote.url ? ` · ${item.remote.url}` : ''}</p>}
        </section>})}
        {preview && !preview.items.length && <p className="helper-text">没有需要审核的新增或变化。已忽略的版本不会重复提示。</p>}
        {busy && <p className="helper-text">正在处理…</p>}{error && <p className="import-error">{error}</p>}{saved && <p className="helper-text">{saved}</p>}
      </div><footer><button className="button button-quiet" onClick={onClose}>关闭</button><button className="button button-primary" disabled={busy || !preview?.items.length} onClick={() => void apply()}><Check size={17}/>确认所选处理</button></footer>
    </aside>
  </div>
}
