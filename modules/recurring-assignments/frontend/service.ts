import { invoke, isTauri } from '@tauri-apps/api/core'
import { service } from '../../../src/service'
import { blankAssignment } from '../../../src/types'
import manifest from '../module.json'
import type { SeriesDetail, SeriesInput, SeriesSummary, SemesterCalendar } from './types'

const desktop = isTauri()
const manage = <T>(operation: string, payload: unknown = {}) => invoke<T>('manage_builtin_module', { moduleId:manifest.id, operation, payload })
const key = 'homeworkbook-preview-recurring'
const sample: SeriesDetail[] = [{
  series:{ id:'preview-recurring-calculus',course_id:'preview-course-1',name:'Calculus 每周作业',title_template:'第 {num} 次作业',description:'完成本周指定习题。',submission_label:'Moodle',submission_url:'',submission_notes:'提交 PDF。',rule:{version:1,kind:'timed',start_at:'2026-09-13T09:00:00',frequency:'week',every:1,weekdays:[7]},due_rule:{version:1,kind:'after_days',days:7,time:'23:59'},max_occurrences:8,end_at:'2026-11-08T23:59:00' },status:'active',
  summary:{id:'preview-recurring-calculus',course_id:'preview-course-1',name:'Calculus 每周作业',title_template:'第 {num} 次作业',status:'active',rule_label:'每 1 周 · 周日',due_label:'生成后 7 天 23:59',range_label:'2026-09-13—2026-11-08',total:8,completed:0,active:2,planned:6,skipped:0,next_at:'2026-09-20T23:59:00',assignment_ids:['sample-1','sample-2'],pending_catch_up:0},
  occurrences:[
    {id:'po1',series_id:'preview-recurring-calculus',sequence_no:1,scheduled_at:'2026-09-13T09:00:00',due_at:'2026-09-20T23:59:00',state:'generated',assignment_id:'sample-1',assignment_status:'doing',assignment_title:'第 3 次作业：微分方程',overridden:false},
    {id:'po2',series_id:'preview-recurring-calculus',sequence_no:2,scheduled_at:'2026-09-20T09:00:00',due_at:'2026-09-27T23:59:00',state:'generated',assignment_id:'sample-2',assignment_status:'todo',assignment_title:'第 4 次作业：多元函数',overridden:true},
    ...[3,4,5,6,7,8].map((n,index) => ({id:`po${n}`,series_id:'preview-recurring-calculus',sequence_no:n,scheduled_at:`${['2026-10-04','2026-10-11','2026-10-18','2026-10-25','2026-11-01','2026-11-08'][index]}T09:00:00`,due_at:null,state:'planned',assignment_id:null,assignment_status:null,assignment_title:null,overridden:false})),
  ]
}]
function load(): SeriesDetail[] { try { return JSON.parse(localStorage.getItem(key) || 'null') || structuredClone(sample) } catch { return structuredClone(sample) } }
let preview = load()
const savePreview = () => localStorage.setItem(key,JSON.stringify(preview))
const localStamp = (date:Date) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}T${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}:00`
const summaryFrom = (detail: SeriesDetail): SeriesSummary => ({...detail.summary,id:detail.series.id,course_id:detail.series.course_id,name:detail.series.name,title_template:detail.series.title_template,status:detail.status,total:detail.occurrences.length,completed:detail.occurrences.filter(item => ['done','submitted'].includes(item.assignment_status || '')).length,active:detail.occurrences.filter(item => ['todo','doing'].includes(item.assignment_status || '')).length,planned:detail.occurrences.filter(item => ['planned','blocked'].includes(item.state)).length,skipped:detail.occurrences.filter(item => ['skipped','cancelled'].includes(item.state)).length,assignment_ids:detail.occurrences.flatMap(item => item.assignment_id ? [item.assignment_id] : [])})

export const recurring = {
  async overview(): Promise<SeriesSummary[]> { return desktop ? manage('overview') : preview.map(summaryFrom) },
  async detail(id:string): Promise<SeriesDetail> { if (desktop) return manage('detail',{id}); const value=preview.find(item=>item.series.id===id); if (!value) throw new Error('周期任务不存在'); return structuredClone(value) },
  async save(payload:SeriesInput): Promise<string> { if (desktop) return manage('save',payload); const id=payload.id || crypto.randomUUID(); const count=payload.max_occurrences || 8; const start=String(payload.rule.start_at || payload.rule.first_at || new Date().toISOString().slice(0,19)); const dates=Array.from({length:count},(_,i)=>{ const value=new Date(start); value.setDate(value.getDate()+i*7); return value.toISOString().slice(0,19) }); const detail:SeriesDetail={series:{...payload,id},status:'active',summary:{id,course_id:payload.course_id,name:payload.name,title_template:payload.title_template,status:'active',rule_label:label(payload.rule),due_label:payload.due_rule.kind==='none'?'无截止时间':`生成后 ${payload.due_rule.days} 天 ${payload.due_rule.time}`,range_label:`${dates[0].slice(0,10)}—${dates.at(-1)!.slice(0,10)}`,total:count,completed:0,active:0,planned:count,skipped:0,next_at:dates[0],assignment_ids:[],pending_catch_up:0},occurrences:dates.map((date,i)=>({id:crypto.randomUUID(),series_id:id,sequence_no:i+1,scheduled_at:i||payload.rule.kind!=='sequence'?date:null,due_at:null,state:i||payload.rule.kind!=='sequence'?'planned':'planned',assignment_id:null,assignment_status:null,assignment_title:null,overridden:false}))}; preview=[...preview.filter(item=>item.series.id!==id),detail];savePreview();return id },
  async setState(id:string,status:string){ if(desktop)return manage<void>('set_state',{id,status}); preview=preview.map(item=>item.series.id===id?{...item,status,summary:{...item.summary,status}}:item);savePreview() },
  async remove(id:string){ if(desktop)return manage<void>('delete',{id}); preview=preview.filter(item=>item.series.id!==id);savePreview() },
  async skip(id:string){ if(desktop)return manage<void>('skip_occurrence',{id}); preview=preview.map(detail=>({...detail,occurrences:detail.occurrences.map(item=>item.id===id?{...item,state:'skipped'}:item)}));savePreview() },
  async generate(id:string){
    if(desktop)return manage<string>('generate_occurrence',{id})
    const detail=preview.find(value=>value.occurrences.some(item=>item.id===id));const occurrence=detail?.occurrences.find(item=>item.id===id);if(!detail||!occurrence)throw new Error('周期节点不存在')
    const scheduled=occurrence.scheduled_at||new Date().toISOString().slice(0,19);let due:string|null=null
    if(detail.series.due_rule.kind==='after_days'){const value=new Date(scheduled);value.setDate(value.getDate()+Number(detail.series.due_rule.days||0));const [hours,minutes]=String(detail.series.due_rule.time||'23:59').split(':').map(Number);value.setHours(hours,minutes,0,0);due=localStamp(value)}
    const assignment={...blankAssignment(detail.series.course_id),title:detail.series.title_template.replace('{num}',String(occurrence.sequence_no)).replace('{date}',scheduled.slice(0,10)).replace('{week}',String(occurrence.sequence_no)),description:detail.series.description,due_at:due,submission_label:detail.series.submission_label,submission_url:detail.series.submission_url,submission_notes:detail.series.submission_notes,source_name:'周期作业',source_text:detail.series.name}
    const assignmentId=await service.saveAssignment(assignment);occurrence.assignment_id=assignmentId;occurrence.assignment_status='todo';occurrence.assignment_title=assignment.title;occurrence.state='generated';detail.summary=summaryFrom(detail);savePreview();return assignmentId
  },
  async resolve(decisions:{occurrence_id:string;action:string}[]){ if(desktop)return manage<void>('resolve_catch_up',{decisions}); for(const decision of decisions)if(decision.action==='skip')await this.skip(decision.occurrence_id);else await this.generate(decision.occurrence_id) },
  async calendars():Promise<SemesterCalendar[]>{ return desktop?manage('list_calendars'):[] },
  async saveCalendar(semesterId:string,week1StartDate:string){ if(desktop)return manage<void>('save_calendar',{semester_id:semesterId,week1_start_date:week1StartDate}) },
}

function label(rule:Record<string,unknown>){ if(rule.kind==='sequence')return '完成后产生下一项';if(rule.kind==='academic_week')return '按教学周生成';if(rule.kind==='custom_dates')return '自定义日期';return rule.frequency==='day'?`每 ${rule.every} 天生成`:rule.frequency==='month'?`每 ${rule.every} 月生成`:`每 ${rule.every} 周生成` }
