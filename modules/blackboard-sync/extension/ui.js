const $=id=>document.getElementById(id)
const api=async message=>{
  const response=await chrome.runtime.sendMessage(message)
  if(!response?.ok)throw new Error(response?.error||'扩展未响应')
  return response
}
const showError=error=>{$('error').textContent=error?.message||String(error)}
let current={courses:[]}
async function refresh(){
  try{
    current=(await api({op:'state'})).state
    $('status').textContent=current.status||'尚未检查'
    $('enabled').checked=current.enabled!==false
    $('time').value=current.checkTime||'09:00'
    $('connection').textContent=`最近完成：${current.lastSync?new Date(current.lastSync).toLocaleString('zh-CN'):'尚无'}\n本地传输：${current.transferError||'正常'}\n本地主机测试：${current.hostStatus||'尚未测试'}\n登录：${current.authStatus||'使用 Chrome 会话，过期后尝试保存的账号'}`
    $('warnings').replaceChildren(...(current.warnings||[]).map(warning=>{const p=document.createElement('p');p.textContent=warning;return p}))
    $('courses').replaceChildren(...current.courses.map(course=>{const label=document.createElement('label');label.className='course';const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.value=course.id;checkbox.checked=course.enabled!==false;label.append(checkbox,document.createTextNode(`${course.name} ${course.code||''}`));return label}))
    if(!current.courses.length)$('courses').textContent='首次检查后显示课程。'
  }catch(error){showError(error)}
}
async function action(work){$('error').textContent='';try{await work();await refresh()}catch(error){showError(error)}}
$('sync').onclick=()=>action(async()=>{await api({op:'sync'});$('status').textContent='正在检查，请稍后刷新';setTimeout(refresh,1500)})
$('testConnection').onclick=()=>action(()=>api({op:'testConnection'}))
$('openLogin').onclick=()=>action(()=>api({op:'openLogin'}))
$('deleteCredentials').onclick=()=>action(()=>api({op:'deleteCredentials'}))
$('credentials').onsubmit=event=>{event.preventDefault();void action(async()=>{await api({op:'saveCredentials',username:$('username').value,password:$('password').value});$('password').value=''})}
const save=()=>api({op:'settings',enabled:$('enabled').checked,checkTime:$('time').value,selected:[...$('courses').querySelectorAll('input:checked')].map(input=>input.value)})
$('saveSettings').onclick=()=>action(save)
$('saveCourses').onclick=()=>action(save)
chrome.storage.onChanged.addListener(()=>void refresh())
void refresh()
