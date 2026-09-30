// Derived from BBReader 0.3.1, Copyright (c) 2026 Carbene, MIT license.
import {courseSettingsURL,selectCurrentCourses} from './courses.js'
import {renewLogin,SSO} from './auth.js'
import {ORIGIN,PORTAL,campusDay,dailyDue,nextCheck,checkTime,readURL,bbURL,digest,calendarDate} from './core.js'

const HOST='app.homeworkbook.bbreader', DAILY='daily-check', RESUME='resume-check'
let running=false,creatingParser
const initial=()=>({courses:[],assignments:[],warnings:[],enabled:true,status:'尚未连接',integrationMode:'browser'})
const get=async()=>({...initial(),...((await chrome.storage.local.get('state')).state||{})})
const put=state=>chrome.storage.local.set({state})
const native=async message=>{
  const result=await chrome.runtime.sendNativeMessage(HOST,message)
  if(!result?.ok)throw new Error(result?.error||'作业簿本地主机未连接')
  return result
}
const renew=options=>renewLogin({native,get,put,readCredentials:async()=>native({op:'readCredentials'}),...options})

async function parse(html,url,kind){
  if(!(await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).length){
    creatingParser ||= chrome.offscreen.createDocument({url:'offscreen.html',reasons:['DOM_PARSER'],justification:'解析 Blackboard 课程和作业 HTML'}).finally(()=>creatingParser=null)
    await creatingParser
  }
  const response=await chrome.runtime.sendMessage({target:'parser',html,url,kind})
  if(!response?.ok)throw new Error(response?.error||'页面解析失败')
  return response.data
}
async function request(url){
  const response=await fetch(readURL(url),{credentials:'include',cache:'no-cache',signal:AbortSignal.timeout(20000)})
  if([401,403].includes(response.status)||!bbURL(response.url)||/\/login|\/cas\//.test(response.url))throw new Error('需要重新登录 Blackboard')
  if(!response.ok)throw new Error(`Blackboard 返回 ${response.status}`)
  return response
}
async function discover(retry=true){
  const tab=await chrome.tabs.create({url:PORTAL,active:false})
  try{
    const deadline=Date.now()+25000
    while((await chrome.tabs.get(tab.id)).status!=='complete'){
      if(Date.now()>deadline)throw new Error('课程门户加载超时')
      await new Promise(resolve=>setTimeout(resolve,300))
    }
    if(!(await chrome.tabs.get(tab.id)).url?.startsWith(ORIGIN+'/'))throw new Error('需要重新登录 Blackboard')
    const [{result}]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:async()=>{
      for(let i=0;i<30;i++){
        const label=[...(document.querySelector('#global-nav-link')?.childNodes||[])].filter(n=>n.nodeType===3).map(n=>n.textContent).join(' ').replace(/\s+/g,' ').trim()
        const settings=[...document.querySelectorAll('a[href]')].find(a=>{
          try{return /^edit_module\/_\d+_\d+\/bbcourseorg\?cmd=edit$/.test(new URL(a.href).searchParams.get('forwardUrl')||'')}catch{return false}
        })
        if(label&&settings)return{label,person:document.title.replace(/^(?:欢迎[，,]|Welcome,)\s*/,'').replace(/\s*[–-]\s*Blackboard Learn$/,''),settingsURL:settings.href}
        if(document.querySelector('input[type=password]'))return{error:'需要重新登录 Blackboard'}
        await new Promise(resolve=>setTimeout(resolve,500))
      }
      return{error:'未找到完整课程列表入口，请确认已登录 Blackboard'}
    }})
    if(!result||result.error)throw new Error(result?.error||'无法读取课程门户')
    const response=await fetch(courseSettingsURL(result.settingsURL),{credentials:'include',cache:'no-cache',signal:AbortSignal.timeout(20000)})
    if([401,403].includes(response.status)||!bbURL(response.url)||/\/login|\/cas\//.test(response.url))throw new Error('需要重新登录 Blackboard')
    if(!response.ok)throw new Error(`完整课程列表读取失败：${response.status}`)
    const enrollment=await parse(await response.text(),response.url,'enrollments')
    const profile=await request(`${ORIGIN}/webapps/blackboard/execute/personalInfo`)
    const identity=await parse(await profile.text(),profile.url,'identity')
    return{...identity,...selectCurrentCourses(enrollment)}
  }catch(error){
    if(retry&&/重新登录/.test(error.message)){await renew();return discover(false)}
    throw error
  }finally{await chrome.tabs.remove(tab.id).catch(()=>{})}
}
const arm=async()=>chrome.alarms.create(DAILY,{when:nextCheck(Date.now(),(await get()).checkTime)})
async function start(automatic=false){
  if(running)return
  running=true
  let state=await get()
  if(state.job){running=false;return pump()}
  if(automatic&&(!state.enabled||!dailyDue(state.lastAutoDay,Date.now(),state.checkTime))){running=false;return}
  if(automatic)state.lastAutoDay=campusDay()
  state.status='正在读取课程';state.warnings=[];await put(state)
  try{
    const found=await discover(),account=(await digest(`${ORIGIN}:${found.userId}`)).slice(0,24)
    state=await get()
    if(state.account&&state.account!==account)throw new Error('检测到其他 Blackboard 账户；请先清空本地索引')
    state.account=account;state.currentTerm=found.term
    state.courses=found.courses.map(course=>({...course,enabled:state.courses.find(old=>old.id===course.id)?.enabled!==false}))
    const selected=state.courses.filter(course=>course.enabled)
    state.job={queue:selected.map(course=>({kind:'course',courseId:course.id,url:course.url,depth:0})),seen:selected.map(course=>`course:${course.url}`),done:0,started:Date.now()}
    state.status=`准备检查 ${selected.length} 门课程`;await put(state)
  }catch(error){state=await get();state.status=error.message;state.lastError=error.message;await put(state)}
  finally{running=false;await arm()}
  if(state.job)await pump()
}
async function calendar(state){
  const response=await request(`${ORIGIN}/webapps/calendar/calendarData/calendars`)
  if(!(response.headers.get('content-type')||'').includes('json'))throw new Error('日历接口未返回 JSON')
  const raw=await response.json(),list=Array.isArray(raw)?raw:raw.calendars
  if(!Array.isArray(list))throw new Error('日历集合格式尚不支持')
  const ids=list.map(item=>item.id).filter(id=>typeof id==='string')
  if(!ids.length)return
  const url=new URL(`${ORIGIN}/webapps/calendar/calendarData/events`)
  url.search=new URLSearchParams({start:String(Date.now()-30*86400000),end:String(Date.now()+120*86400000),course_id:'',calendarIds:ids.join(',')})
  const events=await(await request(url.href)).json()
  if(!Array.isArray(events))throw new Error('日历事件格式尚不支持')
  for(const item of state.assignments){
    const course=state.courses.find(c=>c.id===item.courseId)
    const matches=events.filter(e=>e.title===item.title&&(e.courseId===item.courseId||e.calendarName===course?.name))
    if(matches.length===1&&!item.due){item.due=calendarDate(matches[0].originalStart||matches[0].start);item.dueSource='calendar'}
  }
}
async function step(task,state){
  const course=state.courses.find(c=>c.id===task.courseId)
  const response=await request(task.url),parsed=await parse(await response.text(),response.url,task.kind)
  const add=item=>{const key=`${item.kind}:${item.url}`;if(!state.job.seen.includes(key)){state.job.seen.push(key);state.job.queue.push(item)}}
  if(task.kind==='detail'){
    const item=state.assignments.find(a=>a.courseId===course.id&&a.id===task.id)
    if(item)Object.assign(item,parsed,{checked:Date.now(),dueSource:'detail'})
    return
  }
  if(task.kind==='grades'){
    for(const item of state.assignments.filter(a=>a.courseId===course.id&&a.checked>=state.job.started)){
      const rows=parsed.filter(row=>row.title===item.title)
      if(rows.length===1&&rows[0].status!=='unknown')item.status=rows[0].status
    }
    return
  }
  if(!parsed.valid||parsed.courseId!==course.id)throw new Error('页面不是所选课程的可识别内容，已保留旧数据')
  for(const page of parsed.pages)add({kind:'content',url:page.url,courseId:course.id,depth:(task.depth||0)+1})
  for(const item of parsed.assignments){
    const old=state.assignments.find(a=>a.courseId===course.id&&a.id===item.id)
    const fresh={...item,courseId:course.id,courseName:course.name,seen:state.job.started}
    if(old){fresh.due=old.due;fresh.status=old.status;fresh.checked=old.checked;Object.assign(old,fresh)}
    else state.assignments.push(fresh)
    add({kind:'detail',url:item.url,courseId:course.id,id:item.id})
  }
}
function localDue(value){
  if(!value||!Number.isFinite(Date.parse(value)))return null
  return new Date(Date.parse(value)+8*3600000).toISOString().slice(0,19)
}
function outbound(state,started){
  const confirmed=state.assignments.filter(item=>item.seen===started&&item.checked>=started&&state.courses.some(course=>course.id===item.courseId&&course.enabled))
  return{protocol:1,account_key:state.account,checked_at:new Date().toISOString(),
    courses:state.courses.filter(course=>course.enabled).map(course=>({id:course.id,name:course.name,code:course.code||'',term:course.term||''})),
    assignments:confirmed.map(item=>({id:item.id,course_id:item.courseId,title:item.title,description:item.description||'',due_at:localDue(item.due),status:['submitted','graded'].includes(item.status)?item.status:'unknown',url:item.url||''})),
    warnings:state.warnings.slice(0,100)}
}
async function pump(){
  if(running)return
  running=true
  let state=await get()
  if(state.job)await chrome.alarms.create(RESUME,{when:Date.now()+60000})
  const until=Date.now()+18000
  try{
    while(state.job?.queue.length&&Date.now()<until){
      const task=state.job.queue[0]
      state.status=`正在检查 ${state.courses.find(course=>course.id===task.courseId)?.name||''} · ${state.job.done} 页`
      try{
        if((task.depth||0)>15||state.job.done>1500)throw new Error('页面数量超过限制，请缩小选课范围')
        await step(task,state)
      }catch(error){if(/重新登录/.test(error.message))throw error;state.warnings.push(`${state.courses.find(course=>course.id===task.courseId)?.name}: ${error.message}`)}
      state.job.queue.shift();state.job.done++;await put(state)
    }
    if(state.job&&!state.job.queue.length){
      if(!state.job.gradesQueued){
        state.job.gradesQueued=true
        state.job.queue=state.courses.filter(course=>course.enabled).map(course=>({kind:'grades',courseId:course.id,url:`${ORIGIN}/webapps/bb-mygrades-BBLEARN/myGrades?course_id=${course.id}&stream_name=mygrades&is_stream=false`}))
      }else{
        try{await calendar(state)}catch(error){state.warnings.push(`日历补充：${error.message}`)}
        const started=state.job.started
        state.lastRun=started;state.lastSync=Date.now();state.lastError=null;state.job=null
        try{await native({op:'publish',snapshot:outbound(state,started)});state.transferError=null}
        catch(error){state.transferError=error.message}
        state.status=state.transferError?'检查完成，本地传输失败':state.warnings.length?'检查完成，部分内容需核对':'作业检查完成'
      }
      await put(state)
    }
  }catch(error){state.status=error.message;state.lastError=error.message;state.job=null;await put(state)}
  finally{running=false}
  if(state.job)await chrome.alarms.create(RESUME,{when:Date.now()+30000})
}
async function wake(){await arm();const state=await get();if(state.job)await pump();else if(state.enabled&&state.account&&dailyDue(state.lastAutoDay,Date.now(),state.checkTime))await start(true)}
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===DAILY)void start(true);if(alarm.name===RESUME)void pump()})
chrome.runtime.onStartup.addListener(()=>{void wake()})
chrome.runtime.onInstalled.addListener(details=>{void arm();if(details.reason==='install')void start()})
chrome.action.onClicked.addListener(()=>chrome.tabs.create({url:'index.html'}))
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id||!sender.url?.startsWith(chrome.runtime.getURL('index.html'))||message.target==='parser')return
  ;(async()=>{
    if(message.op==='state')return{ok:true,state:await get()}
    if(message.op==='testConnection'){
      const state=await get()
      try{await native({op:'status'});state.hostStatus='已连接';await put(state);return{ok:true}}
      catch(error){state.hostStatus=error.message;await put(state);throw error}
    }
    if(message.op==='sync'){void start();return{ok:true}}
    if(message.op==='openLogin'){await chrome.tabs.create({url:SSO,active:true});return{ok:true}}
    if(message.op==='saveCredentials'){
      if(typeof message.username!=='string'||typeof message.password!=='string'||!message.username.trim()||!message.password)throw new Error('请输入账号和密码')
      await native({op:'saveCredentials',username:message.username,password:message.password})
      const state=await get();state.browserCredentialLogin=true;state.authBlocked=false;await put(state);return{ok:true}
    }
    if(message.op==='deleteCredentials'){await native({op:'deleteCredentials'});const state=await get();state.browserCredentialLogin=false;await put(state);return{ok:true}}
    if(message.op==='settings'){
      if(checkTime(message.checkTime)!==message.checkTime)throw new Error('检查时间无效')
      const state=await get();state.enabled=!!message.enabled;state.checkTime=message.checkTime
      state.courses.forEach(course=>course.enabled=message.selected.includes(course.id))
      await put(state);await arm();return{ok:true}
    }
    if(message.op==='reset'){const state=initial();await put(state);return{ok:true}}
    throw new Error('未知操作')
  })().then(reply).catch(error=>reply({ok:false,error:error.message}))
  return true
})
chrome.alarms.get(DAILY).then(alarm=>{if(!alarm)void wake()}).catch(()=>{})
export {outbound,start,pump}
