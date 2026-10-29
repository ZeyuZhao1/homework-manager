import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

// Exercise the actual drawer state and submit handler without desktop/browser side effects.
const source = await readFile(new URL('../modules/recurring-assignments/frontend/index.tsx', import.meta.url), 'utf8')
const drawer = source.slice(source.indexOf('function SeriesDrawer('), source.indexOf('function Overlay('))
const helpers = source.slice(source.indexOf('const localSeconds'), source.indexOf('function Action('))
const compiled = ts.transpileModule(`${helpers}\n${drawer}`, { compilerOptions: { target:ts.ScriptTarget.ES2023, jsx:ts.JsxEmit.React, jsxFactory:'element', jsxFragmentFactory:'fragment' } }).outputText
function fixture(initial) {
  const state=[], saved=[], alerts=[]; let cursor=0
  const useState = value => { const i=cursor++; if(!(i in state))state[i]=value; return [state[i],next=>{state[i]=typeof next==='function'?next(state[i]):next}] }
  const element=(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)})
  const dependencies={useRef:value=>({current:value}),useDialogFocus:()=>{},useState,element,fragment:'fragment',CalendarClock:'icon',X:'icon',Link2:'icon',ChevronRight:'icon',recurring:{save:async payload=>{saved.push(payload);return 'series'}},service:{},manifest:{id:'recurring'},errorText:String,window:{alert:value=>alerts.push(value)}}
  const component=new Function(...Object.keys(dependencies),`${compiled}\nreturn SeriesDrawer`)(...Object.values(dependencies))
  const render=()=>{cursor=0;return component({snapshot:{courses:[{id:'course',semester_id:'semester',name:'Course'}],semesters:[{id:'semester'}]},initial,onClose(){},onSaved:async()=>{}})}
  const find=(tree,predicate)=>predicate(tree)?tree:tree.children?.filter(v=>v&&typeof v==='object').map(v=>find(v,predicate)).find(Boolean)
  const field=(tree,label)=>find(tree,n=>n.type==='label'&&n.children.includes(label)).children.find(n=>n?.type==='input')
  const save=async()=>{find(render(),n=>n.type==='button'&&n.children.includes('保存周期')).props.onClick();await new Promise(resolve=>setImmediate(resolve))}
  return {render,field,save,saved,alerts}
}
const input=kind=>({id:'series',course_id:'course',name:'Weekly',title_template:'Original',rule:{kind,version:1,timezone:'America/New_York',start_at:'2026-01-01T09:00:00',first_at:'2026-01-01T09:00:00',dates:['2026-01-01T09:00:00']},due_rule:{kind:'none'},max_occurrences:3})
test('editing only a title preserves the explicit timezone for every recurrence mode',async()=>{
  for(const kind of ['timed','sequence','academic_week','custom_dates']){
    const f=fixture(input(kind));f.field(f.render(),'作业标题模板').props.onChange({target:{value:'Changed title'}});await f.save()
    assert.equal(f.saved.length,1);assert.equal(f.saved[0].rule.timezone,'America/New_York');assert.equal(f.saved[0].title_template,'Changed title');assert.deepEqual(f.saved[0].rule,input(kind).rule)
  }
})
test('new schedules default to Shanghai and accept a user selected IANA timezone',async()=>{
  const f=fixture();let tree=f.render();assert.equal(f.field(tree,'计划时区（IANA）').props.value,'Asia/Shanghai')
  f.field(tree,'周期名称').props.onChange({target:{value:'New series'}});f.field(f.render(),'计划时区（IANA）').props.onChange({target:{value:'Europe/London'}});await f.save()
  assert.equal(f.saved[0].rule.timezone,'Europe/London')
})
test('invalid timezone prevents saving',async()=>{
  const f=fixture(input('timed'));f.field(f.render(),'计划时区（IANA）').props.onChange({target:{value:'Invalid/Place'}});await f.save()
  assert.equal(f.saved.length,0);assert.match(f.alerts[0],/IANA/)
})

test('cloud recurring save compares against opened form and preserves timezone stored on the series row',async()=>{
 const serviceSource=await readFile(new URL('../modules/recurring-assignments/frontend/service.ts',import.meta.url),'utf8')
 const serviceJs=ts.transpileModule(serviceSource.split('\n').filter(line=>!line.startsWith('import ')).join('\n').replace('export const recurring','const recurring'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.None}}).outputText
 const webSource=await readFile(new URL('../src/sync/web.ts',import.meta.url),'utf8')
 const patchSource=webSource.slice(webSource.indexOf('function patch('),webSource.indexOf('async function save('))
 const row={id:'series',course_id:'course',name:'Weekly',title_template:'Original',description:'',submission_label:'',submission_url:'',submission_notes:'',rule_json:JSON.stringify({version:1,kind:'timed',start_at:'2026-01-01T09:00:00',frequency:'day',every:1}),due_rule_json:JSON.stringify({version:1,kind:'none'}),max_occurrences:3,end_at:null,status:'active',timezone:'America/New_York'}
 const rows=[row], sent=[]
 const entities=type=>type==='recurring_series'?rows:[]
 const patchJs=ts.transpileModule(patchSource,{compilerOptions:{target:ts.ScriptTarget.ES2023}}).outputText
 const patch=new Function('entities',`${patchJs};return patch`)(entities)
 const api=new Function('isTauri','localStorage','webSync',`${serviceJs};return recurring`)(()=>false,{getItem:()=>null},{isCloud:true,entities,patch,mutate:async changes=>sent.push(...changes)})
 const initial=(await api.detail('series')).series
 assert.equal(initial.rule.timezone,'America/New_York')
 rows[0]={...row,name:'Changed remotely',rule_json:JSON.stringify({...initial.rule,every:2})}
 await api.save({...initial,title_template:'Changed title'},initial)
 assert.equal(sent[0].data.title_template,'Changed title');assert.ok(!('name' in sent[0].data));assert.ok(!('rule_json' in sent[0].data))
})
