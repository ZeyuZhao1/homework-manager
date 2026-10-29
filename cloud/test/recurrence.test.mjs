import { test } from 'node:test'
import assert from 'node:assert/strict'
import { candidateDates, runRecurrence, recurringAction, zonedNow } from '../src/recurrence.ts'
class MemoryStore {
  entities = new Map(); commits = 0
  snapshot() { return { entities: [...this.entities.values()], cursor:0, server_time:'' } }
  read(type,id) { return this.entities.get(`${type}:${id}`) }
  commit(_id,changes) { this.commits++; for(const c of changes) this.entities.set(`${c.entity_type}:${c.entity_id}`,{...c,seq:this.commits}) }
  add(type,id,data) { this.entities.set(`${type}:${id}`,{entity_type:type,entity_id:id,data,seq:0}) }
  rows(type) { return this.snapshot().entities.filter(e=>e.entity_type===type&&e.data).map(e=>({...e.data,id:e.entity_id})) }
}
const timed = {version:1,kind:'timed',start_at:'2026-01-31T09:00:00',frequency:'month',every:1,month_day:31}
const series = (rule=timed,extra={}) => ({id:'s',course_id:'c',name:'每周',title_template:'第 {num} 次 {date}',description:'描述',rule_json:JSON.stringify(rule),due_rule_json:JSON.stringify({version:1,kind:'after_days',days:1,time:'23:59'}),max_occurrences:3,status:'active',...extra})
function setup(rule=timed,extra={}) { const store=new MemoryStore();store.add('recurring_series','s',series(rule,extra));return store }
const now=new Date('2026-04-01T00:00:00Z')
test('monthly clamp handles leap years and nth weekday clamps fifth to last',()=>{
 assert.deepEqual(candidateDates(series({...timed,start_at:'2024-01-31T09:00:00'}),[]).map(v=>v.at),['2024-01-31T09:00:00','2024-02-29T09:00:00','2024-03-31T09:00:00'])
 assert.equal(candidateDates(series({...timed,start_at:'2026-02-01T09:00:00',month_mode:'nth_weekday',month_week:5,month_weekday:1}),[])[0].at,'2026-02-23T09:00:00')
 assert.equal(candidateDates(series({...timed,start_at:'2026-02-01T09:00:00',month_mode:'nth_weekday',month_week:-1,month_weekday:7}),[])[0].at,'2026-02-22T09:00:00')
})
test('weekly interval uses start anchored weeks, custom dedup, max/end and academic weeks',()=>{
 assert.deepEqual(candidateDates(series({...timed,start_at:'2026-09-02T09:00:00',frequency:'week',every:2,weekdays:[3,5]}),[]).map(v=>v.at),['2026-09-02T09:00:00','2026-09-04T09:00:00','2026-09-16T09:00:00'])
 assert.deepEqual(candidateDates(series({version:1,kind:'custom_dates',dates:['2026-03-02T09:00:00','2026-03-01T09:00:00','2026-03-02T09:00:00']},{end_at:'2026-03-01T10:00:00'}),[]),[{number:1,at:'2026-03-01T09:00:00'}])
 assert.deepEqual(candidateDates(series({version:1,kind:'academic_week',semester_id:'semester',weeks:[3,1,3],weekday:3,time:'09:30'}),[{id:'semester',week1_start_date:'2026-09-07'}]),[{number:1,at:'2026-09-09T09:30:00'},{number:3,at:'2026-09-23T09:30:00'}])
})
test('timezone comparison and repeated scheduler keep one assignment per occurrence atomically',()=>{
 assert.equal(zonedNow(new Date('2026-01-01T16:01:00Z')),'2026-01-02T00:01:00')
 const store=setup(); runRecurrence(store,now); assert.equal(store.rows('assignment').length,3);assert.equal(store.commits,1)
 runRecurrence(store,now);assert.equal(store.rows('assignment').length,3); assert.equal(store.commits,1)
 const o=store.rows('recurring_occurrence')[0];assert.equal(recurringAction(store,{action:'generate',id:o.id},now).assignment_id,o.assignment_id)
})
test('migration preserves occurrence and assignment IDs; edits never overwrite generated overrides',()=>{
 const store=setup();store.add('assignment','legacy-assignment',{course_id:'c',title:'自定义',description:'changed',status:'todo'});store.add('recurring_occurrence','legacy-node',{series_id:'s',sequence_no:1,scheduled_at:'2026-01-31T09:00:00',due_at:null,state:'generated',assignment_id:'legacy-assignment',overridden:0})
 runRecurrence(store,now);assert.equal(store.rows('recurring_occurrence').find(o=>o.sequence_no===1).id,'legacy-node');assert.equal(store.read('assignment','legacy-assignment').data.title,'自定义');assert.equal(store.read('recurring_occurrence','legacy-node').data.overridden,1)
})
test('pause and archive prevent automatic and manual generation; catchup >10 requires explicit decisions',()=>{
 const paused=setup(timed,{status:'paused'});runRecurrence(paused,now);assert.equal(paused.rows('assignment').length,0)
 const many=setup({...timed,start_at:'2026-01-01T09:00:00',frequency:'day'},{max_occurrences:11});runRecurrence(many,now);assert.equal(many.rows('assignment').length,0)
 const os=many.rows('recurring_occurrence');recurringAction(many,{action:'catchup',decisions:[{occurrence_id:os[0].id,action:'generate'},{occurrence_id:os[1].id,action:'skip'}]},now)
 assert.equal(many.rows('assignment').length,1);assert.equal(many.read('recurring_occurrence',os[1].id).data.state,'skipped')
 many.add('recurring_series','s',series(timed,{status:'archived'}));runRecurrence(many,now);assert.equal(many.read('recurring_occurrence',os[2].id).data.state,'cancelled');assert.throws(()=>recurringAction(many,{action:'generate',id:os[2].id},now))
})
test('sequence advances only after configured completion status, exactly once, and respects end',()=>{
 const rule={version:1,kind:'sequence',first_at:'2026-01-01T09:00:00',start_num:1,end_num:3,completion_trigger:'submitted'}
 const store=setup(rule);runRecurrence(store,now);assert.equal(store.rows('assignment').length,1)
 const a=store.rows('assignment')[0];store.add('assignment',a.id,{...a,status:'done'});runRecurrence(store,now);assert.equal(store.rows('assignment').length,1)
 store.add('assignment',a.id,{...a,status:'submitted'});runRecurrence(store,now);assert.equal(store.rows('assignment').length,2);runRecurrence(store,now);assert.equal(store.rows('assignment').length,2)
 const last=store.rows('assignment').find(v=>v.id!==a.id);store.add('assignment',last.id,{...last,status:'submitted'});store.add('recurring_series','s',series(rule,{end_at:'2026-04-01T08:01:00'}));runRecurrence(store,new Date('2026-04-02T00:00:00Z'));assert.equal(store.rows('assignment').length,2)
})
test('invalid dates reject; tombstoned occurrences are never recreated',()=>{
 assert.throws(()=>candidateDates(series({...timed,start_at:'2026-02-30T09:00:00'}),[]))
 const store=setup();runRecurrence(store,now);const o=store.rows('recurring_occurrence')[0];store.add('recurring_occurrence',o.id,null);runRecurrence(store,now);assert.equal(store.read('recurring_occurrence',o.id).data,null)
})

test('disabled module suspends scheduled and explicit generation',()=>{const store=setup();store.add('module_state','builtin.assignment.recurring',{enabled:false});runRecurrence(store,now);assert.equal(store.commits,0);assert.throws(()=>recurringAction(store,{action:'generate',id:'recurring:s:1'},now))})
test('invalid catchup decision commits no partial assignments; explicit timezone controls readiness',()=>{
 const store=setup({...timed,start_at:'2026-01-01T09:00:00',frequency:'day'},{max_occurrences:11});runRecurrence(store,now);const id=store.rows('recurring_occurrence')[0].id, commits=store.commits
 assert.throws(()=>recurringAction(store,{action:'catchup',decisions:[{occurrence_id:id,action:'generate'},{occurrence_id:'missing',action:'generate'}]},now));assert.equal(store.commits,commits);assert.equal(store.rows('assignment').length,0)
 const ny=setup({...timed,start_at:'2026-04-01T09:00:00',frequency:'day',timezone:'America/New_York'},{max_occurrences:1});runRecurrence(ny,new Date('2026-04-01T12:59:00Z'));assert.equal(ny.rows('assignment').length,0);runRecurrence(ny,new Date('2026-04-01T13:00:00Z'));assert.equal(ny.rows('assignment').length,1)
})

test('paused plans reject manual generation and preserve all rows on failure',()=>{
 const store=setup();runRecurrence(store,new Date('2025-01-01T00:00:00Z'));const o=store.rows('recurring_occurrence')[0]
 store.add('recurring_series','s',series(timed,{status:'paused'}));const before=structuredClone(store.snapshot()),commits=store.commits
 assert.throws(()=>recurringAction(store,{action:'generate',id:o.id},now));assert.equal(store.commits,commits);assert.deepEqual(store.snapshot(),before)
})
test('unlocked sequence plan retains its original time while waiting for catchup review',()=>{
 const rule={version:1,kind:'sequence',first_at:'2026-01-01T09:00:00',start_num:1,end_num:3,completion_trigger:'done'}
 const store=setup(rule);runRecurrence(store,now);const a=store.rows('assignment')[0];store.add('assignment',a.id,{...a,status:'done'})
 // Explicit skip of another node causes plan evaluation without automatic generation.
 recurringAction(store,{action:'skip',id:'recurring:s:3'},now)
 assert.equal(store.read('recurring_occurrence','recurring:s:2').data.scheduled_at,'2026-04-01T08:00:00')
 recurringAction(store,{action:'skip',id:'recurring:s:3'},new Date('2026-04-02T00:00:00Z'))
 assert.equal(store.read('recurring_occurrence','recurring:s:2').data.scheduled_at,'2026-04-01T08:00:00')
})

test('sequence numbering may exceed the occurrence count cap and weekly horizon matches the native planner',()=>{
 assert.deepEqual(candidateDates(series({version:1,kind:'sequence',first_at:'2026-01-01T09:00:00',start_num:6000,end_num:6002,completion_trigger:'done'}),[]).map(v=>v.number),[6000,6001,6002])
 const values=candidateDates(series({...timed,start_at:'2026-01-01T09:00:00',frequency:'week',every:365,weekdays:[4]},{max_occurrences:5000}),[])
 assert.equal(values.length,14)
})
