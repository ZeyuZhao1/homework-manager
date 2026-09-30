// Adapted from BBReader 0.3.1, Copyright (c) 2026 Carbene, MIT license.
import {parseEnrollments} from './courses.js';
import { bbURL, parseDue } from './core.js';
const text = e => (e?.textContent || '').replace(/\s+/g, ' ').trim();
const links = e => [...(e?.querySelectorAll('a[href]') || [])];
export function parseHTML(html, url, kind) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (!bbURL(url) || /\/webapps\/login|\/cas\/login/.test(url) || doc.querySelector('#loginForm,#fm1,input[type=password]')) throw new Error('需要重新登录 Blackboard');
  if(kind==='enrollments')return parseEnrollments(doc);
  if(kind==='identity'){
    const ids=[...new Set([...doc.querySelectorAll('a[href]')].flatMap(a=>{
      const u=bbURL(a.getAttribute('href'),url),id=u?.searchParams.get('id');
      return u?.pathname==='/webapps/blackboard/execute/launcher'&&u.searchParams.get('type')==='PersonalInfo'&&/^_\d+_\d+$/.test(id)?[id]:[];
    }))];
    if(ids.length!==1)throw new Error('无法确认 Blackboard 账户标识，已保留旧数据');
    return {userId:ids[0]};
  }
  doc.querySelectorAll('script,style,textarea,input').forEach(e => e.remove());
  const main = doc.querySelector('#content') || doc.body;
  const href = a => bbURL(a.getAttribute('href'), url)?.href;
  const pageURL = bbURL(url);
  const courseId = pageURL?.searchParams.get('course_id') ||
    (kind === 'course' && /^_\d+_\d+$/.test(pageURL?.searchParams.get('id') || '') ? pageURL.searchParams.get('id') : null);
  if (kind === 'detail') {
    const raw = text(main);
    const dueRaw = raw.match(/(?:Due Date|截止日期|到期日期|截止时间)\s*(.{0,130}?)(?=Points Possible|可能得分|满分|Assignment Submission|作业提交|$)/i)?.[1] || '';
    const due = parseDue(dueRaw);
    const submitted = /Submission Date|提交日期/.test(raw) && !/Draft|草稿/i.test(raw);
    const info = main.querySelector('#assignmentInfo') || main.querySelector('.field');
    return { due, dueRaw: dueRaw.slice(0,150), status: submitted ? 'submitted' : 'unknown', description: text(info).slice(0,2500) };
  }
  if (kind === 'grades') {
    return [...doc.querySelectorAll('#grades_wrapper > *, .gradeRow')].map(row => {
      const title = text(row.querySelector('.gradable > span[id],.gradable > a,.name,.itemName'));
      const activity = text(row.querySelector('.activity,.lastActivity'))+' '+[...row.querySelectorAll('.gradeStatus img[alt]')].map(e=>e.alt).join(' ');
      return { title, status: row.classList.contains('graded_item_row') || /Graded|已评分|已评阅/i.test(activity) ? 'graded' : row.classList.contains('submitted_item_row') || /Submitted|已提交|Needs Grading|需要评分/i.test(activity) ? 'submitted' : 'unknown' };
    }).filter(x => x.title);
  }
  const menu = doc.querySelector('#courseMenuPalette_contents');
  const currentContent = bbURL(url)?.searchParams.get('content_id');
  const pages = [...new Map(links(kind === 'course' ? (menu || main) : main).flatMap(a => {
    const u = bbURL(href(a));
    if (!u || !/\/listContent(?:Editable)?\.jsp$/.test(u.pathname) || u.searchParams.get('course_id') !== courseId) return [];
    const id=u.searchParams.get('content_id');
    if(!id || id===currentContent)return [];
    u.hash='';u.search=new URLSearchParams({course_id:courseId,content_id:id,mode:'reset'});
    return [[id,{ url: u.href, id, title: text(a) || text(a.closest('[id^="contentListItem:"]')?.querySelector('h3')) || '课程内容' }]];
  })).values()];
  const assignments = links(main).flatMap(a => {
    const u = bbURL(href(a)); if (u?.pathname !== '/webapps/assignment/uploadAssignment') return [];
    if (u.searchParams.get('course_id') !== courseId) return [];
    const id = u.searchParams.get('content_id');
    return id ? [{ id, title: text(a), url: u.href, status: 'unknown', due: null }] : [];
  });
  return { pages, assignments, courseId, valid: !!(menu || doc.querySelector('#content_listContainer')) };
}
