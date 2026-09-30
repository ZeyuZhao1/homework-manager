import {ORIGIN,bbURL,campusDay,parseDue} from './core.js';

export function courseSettingsURL(value){
  const u=bbURL(value);
  if(!u||u.pathname!=='/webapps/portal/execute/tabs/tabAction'||!/^_\d+_\d+$/.test(u.searchParams.get('tab_tab_group_id')||'')||!/^edit_module\/_\d+_\d+\/bbcourseorg\?cmd=edit$/.test(u.searchParams.get('forwardUrl')||'')||[...u.searchParams.keys()].some(k=>!['tab_tab_group_id','forwardUrl','recallUrl'].includes(k)))throw new Error('未找到完整课程列表入口');
  return u.href;
}
export function parseEnrollments(doc){
  const text=e=>(e?.textContent||'').replace(/\s+/g,' ').trim();
  const termTable=doc.querySelector('[id="termDisplay_table_jsListTermDisplay"]');
  const courseTables=[...doc.querySelectorAll('table[id^="blockAttributes_table_jsListFULL_Student_"]')];
  if(!termTable||!courseTables.length)throw new Error('完整课程列表格式变化，已保留上次课程');
  const terms=[...termTable.querySelectorAll('tbody tr')].map(r=>({id:r.id.split(':').at(-1),name:text(r.querySelector('th')),duration:text(r.querySelector('[id^="miniListElement-termduration:"]'))}));
  const courses=courseTables.flatMap(t=>[...t.querySelectorAll('tbody tr')].map(r=>{
    const id=r.id.split(':').at(-1),title=text(r.querySelector('th')),split=title.indexOf(':');
    if(!/^_\d+_\d+$/.test(id)||split<1)throw new Error('课程标识不完整，已保留上次课程');
    return {id,code:title.slice(0,split).trim(),name:title.slice(split+1).trim(),url:`${ORIGIN}/webapps/blackboard/execute/launcher?type=Course&id=${id}&url=`};
  }));
  return {terms,courses:[...new Map(courses.map(c=>[c.id,c])).values()]};
}
function semesterKey(value){
  const s=String(value);
  let m=s.match(/(20\d{2})\s*(春|夏|秋|冬|SP|SU|FA|WI|Spring|Summer|Fall|Autumn|Winter)(?![a-z])/i);
  if(!m){const reversed=s.match(/\b(Spring|Summer|Fall|Autumn|Winter)\s*(20\d{2})\b/i);if(reversed)m=[reversed[0],reversed[2],reversed[1]];}
  if(!m)return null;
  const season={春:'SP',夏:'SU',秋:'FA',冬:'WI',sp:'SP',su:'SU',fa:'FA',wi:'WI',spring:'SP',summer:'SU',fall:'FA',autumn:'FA',winter:'WI'}[m[2].toLowerCase()];
  return `${m[1]}${season}`;
}
export function selectCurrentCourses({terms,courses},now=Date.now()){
  const day=campusDay(now);
  const active=terms.flatMap(t=>{
    const dates=t.duration.match(/20\d{2}年\d{1,2}月\d{1,2}日|(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+20\d{2}/gi)||[];
    if(dates.length!==2||!semesterKey(t.name))return [];
    const start=parseDue(`${dates[0]} 00:00`),end=parseDue(`${dates[1]} 00:00`);
    if(!start||!end)return [];
    return campusDay(Date.parse(start))<=day&&day<=campusDay(Date.parse(end))?[{...t,start,end,key:semesterKey(t.name)}]:[];
  }).sort((a,b)=>Date.parse(b.start)-Date.parse(a.start));
  // 学校学期开放区间会重叠；以最近开始的学期为当前学期。
  if(!active.length)throw new Error('学校未提供当前有效学期，已保留上次课程');
  if(active[1]?.start===active[0].start&&active[1].key!==active[0].key)throw new Error('当前学期不明确，已保留上次课程');
  const term=active[0];
  return {term:{id:term.id,name:term.name,start:term.start,end:term.end},courses:courses.filter(c=>(semesterKey(c.code)||semesterKey(c.name))===term.key).map(c=>({...c,term:term.name,termId:term.id}))};
}
