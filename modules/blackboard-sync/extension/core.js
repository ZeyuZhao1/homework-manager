// Adapted from BBReader 0.3.1, Copyright (c) 2026 Carbene, MIT license.
export const ORIGIN='https://bb.sustech.edu.cn'
export const PORTAL=`${ORIGIN}/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1`
const DAY=86400000
export const campusDay=(now=Date.now())=>new Date(now+8*3600000).toISOString().slice(0,10)
export const checkTime=value=>/^([01]\d|2[0-3]):[0-5]\d$/.test(value||'')?value:'09:00'
const checkToday=(now,time)=>Date.parse(`${campusDay(now)}T${checkTime(time)}:00+08:00`)
export const nextCheck=(now=Date.now(),time)=>{const today=checkToday(now,time);return today>now?today:today+DAY}
export const dailyDue=(lastDay,now=Date.now(),time)=>now>=checkToday(now,time)&&lastDay!==campusDay(now)
export function bbURL(value,base=ORIGIN){
  try{const url=new URL(value,base);return url.origin===ORIGIN&&!url.username&&!url.password?url:null}catch{return null}
}
export function readURL(value){
  const url=bbURL(value)
  const paths=['/webapps/blackboard/execute/launcher','/webapps/blackboard/execute/courseMain',
    '/webapps/blackboard/execute/personalInfo','/webapps/blackboard/content/listContent.jsp',
    '/webapps/blackboard/content/listContentEditable.jsp','/webapps/assignment/uploadAssignment',
    '/webapps/bb-mygrades-BBLEARN/myGrades','/webapps/calendar/calendarData/calendars',
    '/webapps/calendar/calendarData/events']
  if(!url||!paths.includes(url.pathname)||url.searchParams.has('action')||url.searchParams.has('method'))throw new Error('拒绝读取非白名单地址')
  return url.href
}
export async function digest(text){return[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(value=>value.toString(16).padStart(2,'0')).join('')}
export function parseDue(text){
  const value=String(text).replace(/\s+/g,' ').trim()
  let year,month,day
  const cn=value.match(/(20\d{2})\s*(?:年|[-/])\s*(\d{1,2})\s*(?:月|[-/])\s*(\d{1,2})/)
  const en=value.match(/(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(20\d{2})/i)
  if(cn)[,year,month,day]=cn.map(Number)
  else if(en){year=+en[3];month=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(en[1].slice(0,3).toLowerCase())+1;day=+en[2]}
  else return null
  const tm=value.match(/(?:(上午|下午)\s*)?(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|上午|下午)?/i)
  if(!tm)return null
  let hour=+tm[2];const minute=+tm[3],mer=(tm[1]||tm[4]||'').toUpperCase()
  if(mer&&(hour<1||hour>12))return null
  if(mer)hour=hour%12+(/PM|下午/.test(mer)?12:0)
  if(hour>23||minute>59||month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate())return null
  return new Date(Date.UTC(year,month-1,day,hour-8,minute)).toISOString()
}
export function calendarDate(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value))return null
  const withZone=/(?:Z|[+-]\d\d:?\d\d)$/.test(value)?value:`${value}+08:00`
  return Number.isFinite(Date.parse(withZone))?new Date(withZone).toISOString():null
}
