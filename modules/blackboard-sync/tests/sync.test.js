import test from 'node:test'
import assert from 'node:assert/strict'
import {parseDue,readURL,campusDay} from '../extension/core.js'

test('deadline parser keeps campus time and does not invent a time',()=>{
  assert.equal(parseDue('2026年9月28日 23:59'), '2026-09-28T15:59:00.000Z')
  assert.equal(parseDue('2026年9月28日'),null)
  assert.equal(parseDue('2026年2月30日 12:00'),null)
  assert.equal(campusDay(Date.parse('2026-09-27T17:00:00Z')),'2026-09-28')
})
test('school URL allowlist rejects writes and other origins',()=>{
  assert.throws(()=>readURL('https://other.example.edu/task'))
  assert.throws(()=>readURL('https://bb.sustech.edu.cn/webapps/assignment/uploadAssignment?action=submit'))
  assert.match(readURL('https://bb.sustech.edu.cn/webapps/assignment/uploadAssignment?course_id=_1_1'),/course_id/)
})

const ORIGIN='https://bb.sustech.edu.cn'
const course={id:'_1_1',name:'Test course',code:'CS100-2026FA',url:`${ORIGIN}/webapps/blackboard/execute/launcher?type=Course&id=_1_1&url=`,term:'2026 秋'}
const content=`${ORIGIN}/webapps/blackboard/content/listContent.jsp?course_id=_1_1&content_id=_2_1`
const detail=`${ORIGIN}/webapps/assignment/uploadAssignment?course_id=_1_1&content_id=_3_1&mode=view`
let state={},published=[],portalCalls=0,failDetail=false
const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn)}})
const alarms=new Map()
globalThis.chrome={
  storage:{local:{async get(){return{state:structuredClone(state)}},async set(value){state=structuredClone(value.state)}}},
  runtime:{id:'test',getURL:path=>`chrome-extension://test/${path}`,getContexts:async()=>[{}],onMessage:event(),onStartup:event(),onInstalled:event(),sendNativeMessage:async(_,msg)=>{if(msg.op==='publish')published.push(msg.snapshot);return{ok:true}},sendMessage:async msg=>{
    if(msg.kind==='identity')return{ok:true,data:{userId:'_42_1'}}
    if(msg.kind==='enrollments')return{ok:true,data:{terms:[{id:'_58_1',name:'2026秋（Fall 2026）',duration:'从 2026年7月10日 至 2027年3月1日'}],courses:[course]}}
    if(msg.kind==='course')return{ok:true,data:{valid:true,courseId:course.id,pages:[{url:content}],assignments:[]}}
    if(msg.kind==='content')return{ok:true,data:{valid:true,courseId:course.id,pages:[],assignments:[{id:'_3_1',title:'Homework',url:detail,due:null,status:'unknown'}]}}
    if(msg.kind==='detail')return failDetail?{ok:false,error:'detail offline'}:{ok:true,data:{due:'2026-09-28T15:59:00.000Z',description:'Read chapter 1',status:'unknown'}}
    if(msg.kind==='grades')return{ok:true,data:[]}
    throw Error(`unexpected parser ${msg.kind}`)
  }},
  tabs:{async create(){portalCalls++;return{id:1}},async get(){return{status:'complete',url:`${ORIGIN}/webapps/portal/execute/tabs/tabAction`}},async remove(){}},
  scripting:{executeScript:async()=>[{result:{label:'Student',settingsURL:`${ORIGIN}/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1&forwardUrl=edit_module%2F_3_1%2Fbbcourseorg%3Fcmd%3Dedit`}}]},
  alarms:{async get(name){return alarms.get(name)},async create(name,value){alarms.set(name,value)},onAlarm:event()},
  action:{onClicked:event()},offscreen:{createDocument:async()=>{}},
}
globalThis.fetch=async url=>{
  const response=new Response(String(url).includes('calendarData')?'[]':'fixture',{headers:{'content-type':String(url).includes('calendarData')?'application/json':'text/html'}})
  Object.defineProperty(response,'url',{value:url});return response
}
const {start,pump,outbound}=await import('../extension/background.js')
test('daily scan publishes only confirmed tasks and runs once per campus day',async()=>{
  const realNow=Date.now;Date.now=()=>Date.parse('2026-09-28T10:00:00+08:00')
  try{
    state={courses:[],assignments:[],enabled:true,warnings:[],integrationMode:'browser'};published=[];portalCalls=0;failDetail=false
    await start(true)
    while(state.job)await pump()
    assert.equal(published.length,1)
    assert.equal(published[0].assignments.length,1)
    assert.equal(published[0].assignments[0].due_at,'2026-09-28T23:59:00')
    assert.equal(published[0].assignments[0].status,'unknown')
    await start(true)
    assert.equal(portalCalls,1)
  }finally{Date.now=realNow}
})
test('detail failure preserves old local data but excludes it from new export',async()=>{
  const realNow=Date.now;Date.now=()=>Date.parse('2026-09-29T10:00:00+08:00')
  try{
    failDetail=true;published=[]
    await start(true)
    while(state.job)await pump()
    assert.equal(published.length,1)
    assert.equal(published[0].assignments.length,0)
    assert.match(published[0].warnings.join(' '),/detail offline/)
    assert.equal(state.assignments[0].title,'Homework')
  }finally{Date.now=realNow;failDetail=false}
})
test('outbound includes overdue and undated confirmed assignments',()=>{
  const result=outbound({account:'a',warnings:[],courses:[{...course,enabled:true}],assignments:[
    {id:'one',courseId:course.id,title:'Late',description:'',url:detail,due:'2026-09-01T00:00:00Z',status:'unknown',seen:1,checked:1},
    {id:'two',courseId:course.id,title:'No due',description:'',url:detail,due:null,status:'unknown',seen:1,checked:1},
  ]},1)
  assert.equal(result.assignments.length,2)
  assert.equal(result.assignments[1].due_at,null)
})
