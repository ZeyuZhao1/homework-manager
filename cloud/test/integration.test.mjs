import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let process,base,token,temp
const bootstrap='integration-only-ephemeral-bootstrap'
async function api(path,options={}){const {auth=token,body,method='GET',headers={}}=options;return fetch(base+path,{method,headers:{...auth?{Authorization:`Bearer ${auth}`}:{},...body!==undefined?{'Content-Type':'application/json'}:{},...headers},body:body===undefined?undefined:JSON.stringify(body)})}
async function sync(operations,cursor=0){const r=await api('/api/sync',{method:'POST',body:{cursor,operations}});return {status:r.status,data:await r.json()}}
const op=(id,type,entity,data)=>({operation_id:id,changes:[{entity_type:type,entity_id:entity,data}]})
before(async()=>{
 temp=await mkdtemp(join(tmpdir(),'homework-cloud-'));base='http://127.0.0.1:18879'
 process=spawn('node',['node_modules/wrangler/bin/wrangler.js','dev','--local','--port','18879','--persist-to',temp,'--var',`BOOTSTRAP_SECRET:${bootstrap}`,'--var',`AI_CREDENTIAL_ENCRYPTION_KEY:${[...crypto.getRandomValues(new Uint8Array(32))].map(n=>n.toString(16).padStart(2,'0')).join('')}`],{cwd:new URL('..',import.meta.url),env:{...globalThis.process.env,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']})
 let log='';process.stdout.on('data',v=>log+=v);process.stderr.on('data',v=>log+=v)
 for(let i=0;i<100;i++){try{if((await api('/api/health',{auth:null})).ok)return}catch{}await new Promise(r=>setTimeout(r,200))}
 throw new Error(`Local Worker did not start: ${log}`)
})
after(async()=>{process?.kill('SIGTERM');if(process)await new Promise(resolve=>process.once('exit',resolve));await rm(temp,{recursive:true,force:true})})
test('local Durable Object: authorization, pairing, receipt LWW, dedup, cascades, uploads and revocation',async()=>{
 assert.equal((await api('/api/snapshot',{auth:null})).status,401)
 const publicProviders=await(await api('/api/recovery/providers',{auth:null})).json();assert.deepEqual(publicProviders,{providers:[{id:'github',enabled:false},{id:'google',enabled:false}]})
 assert.equal((await api('/api/recovery/github',{auth:null,method:'DELETE'})).status,401)
 assert.equal((await api('/api/bootstrap',{auth:null,method:'POST',body:{bootstrap_secret:'wrong',device_name:'local',client_type:'desktop'}})).status,403)
 let r=await api('/api/bootstrap',{auth:null,method:'POST',body:{bootstrap_secret:bootstrap,device_name:'local',client_type:'desktop'}});assert.equal(r.status,200);const owner=await r.json();token=owner.token;assert.ok(token)
 assert.deepEqual(await(await api('/api/recovery/providers')).json(),{providers:[{id:'github',enabled:false,bound:false},{id:'google',enabled:false,bound:false}]})
 assert.equal((await api('/api/recovery/github',{method:'DELETE'})).status,200)
 assert.equal((await api('/api/bootstrap',{auth:null,method:'POST',body:{bootstrap_secret:bootstrap,device_name:'again',client_type:'desktop'}})).status,409)
 r=await api('/api/pair/start',{auth:null,method:'POST',body:{device_name:'paired',client_type:'desktop'}});const pair=await r.json();assert.ok(pair.poll_secret)
 assert.equal((await api('/api/pair/approve',{method:'POST',body:{code:pair.code}})).status,200)
 r=await api('/api/pair/poll',{auth:null,method:'POST',body:pair});const paired=await r.json();assert.equal(paired.state,'approved');assert.ok(paired.token)
 r=await api('/api/pair/poll',{auth:null,method:'POST',body:pair});assert.equal((await r.json()).state,'expired')
 let result=await sync([op('create-sem','semester','s',{name:'First'}),op('create-course','course','c',{semester_id:'s',name:'Course',code:'X'}),op('create-assignment','assignment','a',{course_id:'c',title:'A',status:'todo'})]);assert.equal(result.status,200)
 let cursor=result.data.cursor
 result=await sync([op('edit-name','semester','s',{name:'Later'})],cursor);assert.equal(result.status,200)
 result=await sync([op('edit-name','semester','s',{name:'REPLAY MUST NOT WIN'})],result.data.cursor);assert.equal(result.data.changes.length,0)
 result=await sync([op('field-title','assignment','a',{title:'Edited'}),op('field-status','assignment','a',{status:'done'})]);assert.equal(result.status,200)
 r=await api('/api/snapshot');let snapshot=await r.json();let assignment=snapshot.entities.find(e=>e.entity_id==='a');assert.equal(assignment.data.title,'Edited');assert.equal(assignment.data.status,'done')
 for(const [label,data] of [['blank-title',{title:'   '}],['bad-status',{status:'unknown'}],['bad-date',{due_at:'2026-02-30T10:00'}],['bad-fields',{custom_fields:{['x'.repeat(81)]:'v'}}],['bad-count',{custom_fields:Object.fromEntries(Array.from({length:41},(_,i)=>[String(i),'v']))}],['bad-null',{description:null}]])assert.equal((await sync([op(label,'assignment','a',data)])).status,400)
 assert.equal((await sync([op('empty-course','course','empty-c',{semester_id:'s',name:'   '})])).status,400)
 assert.equal((await sync([op('wrong-role','link','invalid-link',{assignment_id:'a',file_id:'missing',role:'unknown'})])).status,400)
 assert.equal((await sync([op('bad-path','course','c',{folder_path:'/private/path'})])).status,400)
 const rollback=await sync([op('rollback-first','semester','should-rollback',{name:'Atomic'}),op('rollback-bad','course','bad-atomic',{semester_id:'absent',name:'Invalid'})]);assert.equal(rollback.status,400)
 assert.equal((await(await api('/api/snapshot')).json()).entities.some(e=>e.entity_id==='should-rollback'),false)
 assert.equal((await sync([op('bad-parent','course','invalid',{semester_id:'absent',name:'Invalid'})])).status,400)
 assert.equal((await sync([op('private-provider','provider','p',{api_key:'not-a-real-key'})])).status,400)
 const importIdentity={module_id:'external.example.source',account_key:'account',remote_course_id:'remote-course'}
 const importBaseline={id:'remote-assignment',course_id:'remote-course',title:'Source task',description:'Description',due_at:null,status:'unknown',url:'https://source.example.test/task'}
 const importRow={...importIdentity,remote_assignment_id:'remote-assignment',assignment_id:'a',baseline:JSON.stringify(importBaseline)}
 assert.equal((await sync([op('import-map','import_course_map','map',{...importIdentity,course_id:'c'}),op('import-link','import_link','source-link',importRow),op('import-ignore','import_ignored','source-ignore',{...importRow,assignment_id:undefined})])).status,200)
 assert.equal((await sync([op('duplicate-import-map','import_course_map','map-copy',{...importIdentity,course_id:'c'})])).status,400)
 assert.equal((await sync([op('duplicate-import-link','import_link','link-copy',importRow)])).status,400)
 for(const [label,data]of [['key',{account_key:'x'.repeat(121)}],['control',{module_id:'bad\nmodule'}],['baseline',{baseline:'[]'}],['identity',{baseline:JSON.stringify({...importBaseline,id:'other'})}],['private-field',{baseline:JSON.stringify({...importBaseline,path:'/device/private'})}],['invalid-date',{baseline:JSON.stringify({...importBaseline,due_at:'2026-02-30T12:00:00'})}],['provider-key',{baseline:JSON.stringify({...importBaseline,api_key:'synthetic'})}]])assert.equal((await sync([op(`invalid-import-${label}`,'import_link','source-link',data)])).status,400)
 // A paginated first desktop baseline pauses snapshot scheduling and preserves legacy occurrence IDs.
 let baselineResponse=await api('/api/sync',{method:'POST',body:{cursor:0,operations:[],baseline:'begin'}});assert.equal(baselineResponse.status,200)
 snapshot=await(await api('/api/snapshot')).json();assert.equal(snapshot.pending_baselines.length,1);assert.equal(snapshot.pending_baselines[0].device_id,owner.device.id);assert.equal(snapshot.pending_baselines[0].name,'local');assert.ok(Number.isFinite(Date.parse(snapshot.pending_baselines[0].started_at)))
 assert.equal((await api('/api/recurring/action',{method:'POST',body:{action:'generate'}})).status,409)
 const recurrence={course_id:'c',name:'Migrated',title_template:'Item {num}',rule_json:JSON.stringify({version:1,kind:'custom_dates',dates:['2025-01-01T09:00:00','2025-01-02T09:00:00']}),due_rule_json:JSON.stringify({version:1,kind:'none'}),max_occurrences:2,status:'active',timezone:'UTC'}
 result=await sync([op('series-import','recurring_series','legacy-series',recurrence)]);assert.equal(result.status,200)
 snapshot=await(await api('/api/snapshot')).json();assert.equal(snapshot.entities.filter(e=>e.entity_type==='recurring_occurrence').length,0)
 const migrated=op('node-import','recurring_occurrence','old-node',{series_id:'legacy-series',sequence_no:1,scheduled_at:'2025-01-01T09:00:00',due_at:null,state:'generated',assignment_id:'a',overridden:1})
 assert.equal((await sync([migrated])).status,200);assert.equal((await sync([migrated])).status,200)
 assert.equal((await sync([op('node-import-2','recurring_occurrence','old-node-two',{series_id:'legacy-series',sequence_no:2,scheduled_at:'2025-01-02T09:00:00',due_at:null,state:'planned',assignment_id:null,overridden:0})])).status,200)
 snapshot=await(await api('/api/snapshot')).json();assert.equal(snapshot.entities.filter(e=>e.entity_type==='assignment'&&e.data).length,1)
 baselineResponse=await api('/api/sync',{method:'POST',body:{cursor:0,operations:[],baseline:'complete'}});assert.equal(baselineResponse.status,200)
 snapshot=await(await api('/api/snapshot')).json();assert.equal(snapshot.entities.filter(e=>e.entity_type==='assignment'&&e.data).length,2);assert.equal(snapshot.entities.find(e=>e.entity_id==='old-node').data.assignment_id,'a');assert.ok(snapshot.entities.find(e=>e.entity_id==='old-node-two').data.assignment_id)
 assert.deepEqual(snapshot.pending_baselines,[])
 // Every change page is ordered and resumable, including changes made during a baseline.
 const pages=[];let pageCursor=0,hasMore=true
 while(hasMore){const response=await api('/api/sync',{method:'POST',body:{cursor:pageCursor,operations:[],limit:2}});assert.equal(response.status,200);const page=await response.json();assert.ok(page.changes.length<=2);for(const change of page.changes){assert.ok(change.seq>pageCursor);pageCursor=change.seq;pages.push(change)}assert.equal(page.cursor,pageCursor);hasMore=page.has_more}
 assert.equal(new Set(pages.map(change=>change.seq)).size,pages.length);assert.equal(pageCursor,snapshot.cursor)
 // A second desktop's full baseline cannot overwrite the cloud scheduler's fields,
 // but must retain an offline skip and override for an existing occurrence.
 const generated=snapshot.entities.find(e=>e.entity_id==='old-node-two').data
 assert.equal((await api('/api/sync',{auth:paired.token,method:'POST',body:{cursor:0,operations:[],baseline:'begin'}})).status,200)
 const skipImport=op('existing-skip-import','recurring_occurrence','old-node-two',{...generated,series_id:'stale-series',sequence_no:99,scheduled_at:'2020-01-01T00:00:00',state:'skipped',assignment_id:null,overridden:1})
 assert.equal((await api('/api/sync',{auth:paired.token,method:'POST',body:{cursor:0,operations:[skipImport]}})).status,200)
 snapshot=await(await api('/api/snapshot')).json();const skipped=snapshot.entities.find(e=>e.entity_id==='old-node-two').data
 assert.equal(skipped.state,'skipped');assert.equal(skipped.assignment_id,null);assert.equal(skipped.overridden,1);assert.equal(skipped.sequence_no,generated.sequence_no);assert.equal(skipped.scheduled_at,generated.scheduled_at);assert.equal(skipped.series_id,generated.series_id)
 assert.equal((await api('/api/sync',{auth:paired.token,method:'POST',body:{cursor:0,operations:[],baseline:'complete'}})).status,200)
 assert.equal((await sync([op('cannot-reassign-occurrence','recurring_occurrence','old-node',{state:'skipped',assignment_id:generated.assignment_id})])).status,400)
 const deleteGenerated={operation_id:'delete-generated',changes:[{entity_type:'assignment',entity_id:'a',data:null},{entity_type:'recurring_occurrence',entity_id:'old-node',data:{state:'skipped',assignment_id:null}}]}
 assert.equal((await sync([deleteGenerated])).status,200);assert.equal((await sync([deleteGenerated])).status,200)
 snapshot=await(await api('/api/snapshot')).json();assert.equal(snapshot.entities.find(e=>e.entity_id==='old-node').data.state,'skipped');assert.equal(snapshot.entities.find(e=>e.entity_id==='old-node').data.assignment_id,null)
 assert.equal(snapshot.entities.find(e=>e.entity_id==='source-link').data,null);assert.ok(snapshot.entities.find(e=>e.entity_id==='source-ignore').data)
 assert.equal((await sync([op('file-create','file','f',{name:'notes.txt',mime:'text/plain',size:null,cloud_version:null})])).status,200)
 for(const [index,size]of [-1,1.2,'12'].entries())assert.equal((await sync([op(`invalid-size-${index}`,'file','f',{size})])).status,400)
 assert.equal((await api('/api/files/f/content',{method:'PUT',headers:{'Content-Type':'text/plain'}})).status,400)
 assert.equal((await api('/api/files/f/content',{auth:null})).status,401)
 r=await fetch(base+'/api/files/f/content',{method:'PUT',headers:{Authorization:`Bearer ${token}`,'X-Upload-Confirmed':'true','Content-Type':'text/plain'},body:'confirmed bytes'});assert.equal(r.status,200)
 assert.equal((await sync([op('cannot-clear-version','file','f',{cloud_version:null})])).status,400)
 assert.equal((await sync([op('unknown-size-cannot-clear-version','file','f',{name:'notes.txt',mime:'text/plain',size:null,cloud_version:null})])).status,400)
 assert.equal((await sync([op('metadata-edit-preserves-upload','file','f',{name:'renamed.txt',size:null})])).status,200)
 r=await api('/api/files/f/content');assert.equal(await r.text(),'confirmed bytes')
 assert.equal((await api('/api/files/f/content',{method:'DELETE'})).status,200)
 assert.equal((await api('/api/files/f/content')).status,404)
 assert.equal((await sync([op('last-semester','semester','s',null)])).status,409)
 assert.equal((await sync([op('retained-semester','semester','retained',{name:'Keep'})])).status,200)
 result=await sync([op('delete-sem','semester','s',null),op('stale','assignment','a',{title:'Resurrection'})]);assert.equal(result.status,200)
 snapshot=await(await api('/api/snapshot')).json();for(const id of ['s','c','a'])assert.equal(snapshot.entities.find(e=>e.entity_id===id).data,null)
 assert.equal(snapshot.entities.find(e=>e.entity_id==='map').data,null);assert.ok(snapshot.entities.find(e=>e.entity_id==='source-ignore').data)
 assert.equal((await api('/api/sync',{auth:paired.token,method:'POST',body:{cursor:0,operations:[],baseline:'begin'}})).status,200)
 assert.equal((await api(`/api/devices/${paired.device.id}`,{method:'DELETE'})).status,200)
 assert.deepEqual((await(await api('/api/snapshot')).json()).pending_baselines,[])
 assert.equal((await api('/api/snapshot',{auth:paired.token})).status,401)
 assert.equal((await api('/api/does-not-exist')).status,404)
 const unavailable=await fetch(base+'/api/recovery/github/start',{redirect:'manual'});assert.equal(unavailable.status,303);assert.equal(new URL(unavailable.headers.get('location')).searchParams.get('auth_error'),'unavailable');assert.match(unavailable.headers.get('set-cookie'),/Max-Age=0/)
 r=await api('/api/pair/start',{auth:null,method:'POST',body:{device_name:'browser',client_type:'web'}});const web=await r.json();await api('/api/pair/approve',{method:'POST',body:{code:web.code}})
 r=await api('/api/pair/poll',{auth:null,method:'POST',body:web});const cookie=r.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Lax/);assert.equal((await r.json()).token,undefined)
 assert.equal((await api('/api/logout',{auth:null,method:'POST',headers:{Cookie:cookie}})).status,403)
 const multiCookie='other=one; '+cookie.split(';')[0];assert.equal((await api('/api/devices',{auth:null,headers:{Cookie:multiCookie}})).status,200)
 assert.equal((await api('/api/recovery/google',{auth:null,method:'DELETE',headers:{Cookie:multiCookie,Origin:'https://cross-origin.example'}})).status,403)
 assert.equal((await api('/api/logout',{method:'POST',headers:{Origin:'https://cross-origin.example'}})).status,403)
 let limited=false;for(let i=0;i<14;i++){const response=await api('/api/pair/start',{auth:null,method:'POST',body:{device_name:'rate-test',client_type:'desktop'}});if(response.status===429)limited=true}assert.equal(limited,true)
 // Credential endpoints require authorization and same-origin writes; keys stay outside snapshots.
 assert.equal((await api('/api/ai/credentials',{auth:null})).status,401)
 const credentialPath='/api/ai/providers/web-provider/credential'
 const ephemeralKey=crypto.randomUUID()
 assert.equal((await sync([op('web-provider','provider','web-provider',{name:'Web',kind:'deepseek',base_url:'https://provider.invalid/v1',model:'deepseek-flash'})])).status,200)
 assert.equal((await api(credentialPath,{auth:null,method:'PUT',body:{api_key:ephemeralKey}})).status,401)
 assert.equal((await api(credentialPath,{method:'PUT',body:{api_key:ephemeralKey},headers:{Origin:'https://cross-origin.example'}})).status,403)
 assert.equal((await api(credentialPath,{auth:null,method:'PUT',body:{api_key:ephemeralKey},headers:{Cookie:cookie}})).status,403)
 assert.equal((await api('/api/ai/providers/missing/credential',{method:'PUT',body:{api_key:ephemeralKey}})).status,404)
 assert.equal((await api(credentialPath,{method:'PUT',body:{api_key:''}})).status,400)
 assert.equal((await api(credentialPath,{method:'PUT',body:{api_key:'x'.repeat(9000)}})).status,413)
 r=await api(credentialPath,{method:'PUT',body:{api_key:ephemeralKey}});assert.equal(r.status,200);assert.deepEqual(await r.json(),{provider_id:'web-provider',has_key:true})
 r=await api('/api/ai/credentials');assert.equal(r.status,200);assert.equal((await r.json()).credentials['web-provider'].has_key,true)
 assert.ok(!(await(await api('/api/snapshot')).text()).includes(ephemeralKey))
 r=await api(credentialPath,{method:'DELETE'});assert.equal(r.status,200);assert.deepEqual(await r.json(),{provider_id:'web-provider',has_key:false})
 assert.equal((await(await api('/api/ai/credentials')).json()).credentials['web-provider'].has_key,false)
 let credentialLimited=false;for(let i=0;i<14;i++){if((await api(credentialPath,{method:'DELETE'})).status===429)credentialLimited=true}assert.equal(credentialLimited,true)
 assert.equal((await sync([op('system-appearance','setting','theme',{value:'system'})])).status,200)
 assert.equal((await(await api('/api/snapshot')).json()).entities.find(row=>row.entity_type==='setting'&&row.entity_id==='theme').data.value,'system')
 assert.equal((await sync([op('invalid-appearance','setting','theme',{value:'unexpected-css'})])).status,400)
 assert.equal((await api('/api/sync',{method:'POST',body:{cursor:0,operations:[],baseline:'begin'}})).status,200)
 assert.equal((await api('/api/logout',{method:'POST'})).status,200)
 assert.deepEqual((await(await api('/api/snapshot',{auth:null,headers:{Cookie:cookie}})).json()).pending_baselines,[])
})


test('appearance HTML and manifest are selected per request, never reused through conditional caching',async()=>{
 for(const [theme,color]of [['light','#f0f3f8'],['dark','#1b1b1d']]){
  const headers={Cookie:`other=value; homeworkbook_theme=${theme}`,Accept:'text/html','If-None-Match':'"stale-index"'}
  const response=await fetch(base+'/',{headers});assert.equal(response.status,200)
  assert.match(response.headers.get('cache-control'),/private, no-store/);assert.equal(response.headers.get('etag'),null)
  const html=await response.text();assert.ok(!html.includes('data-status-bar='));assert.ok(html.includes('data-appearance-rendered="true"'));assert.ok(html.includes(`name="theme-color" content="${color}"`));assert.ok(!html.includes('name="apple-mobile-web-app-status-bar-style"'))
  const manifest=await fetch(base+`/manifest.webmanifest?theme=${theme}&v=3`,{headers:{Cookie:'homeworkbook_theme=light','If-None-Match':'"stale-manifest"'}})
  assert.equal(manifest.status,200);assert.match(manifest.headers.get('cache-control'),/private, no-store/)
  const json=await manifest.json();assert.equal(json.id,'/');assert.equal(json.theme_color,color);assert.equal(json.background_color,color)
  const head=await fetch(base+`/manifest.webmanifest?theme=${theme}`,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'')
 }
 const invalid=await fetch(base+'/',{headers:{Cookie:'homeworkbook_theme=darkevil'}});assert.ok((await invalid.text()).includes('data-theme="light"'))
})
