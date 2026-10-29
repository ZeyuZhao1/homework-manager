import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
const temp=await mkdtemp(join(tmpdir(),'homework-recovery-'))
await writeFile(join(temp,'store.mjs'),`export class ApiError extends Error { constructor(status,message){super(message);this.status=status} }`)
for(const name of ['auth','recovery']){const source=await readFile(new URL(`../src/${name}.ts`,import.meta.url),'utf8');const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replaceAll("'./auth'","'./auth.mjs'").replaceAll("'./store'","'./store.mjs'");await writeFile(join(temp,`${name}.mjs`),js)}
const {recovery, recoveryNavigation, providerStatus, unlinkIdentity}=await import(pathToFileURL(join(temp,'recovery.mjs')))
after(()=>rm(temp,{recursive:true,force:true}))
const env={PUBLIC_ORIGIN:'https://app.invalid',GITHUB_CLIENT_ID:'local-client',GITHUB_CLIENT_SECRET:'test-only',GOOGLE_CLIENT_ID:'local-client',GOOGLE_CLIENT_SECRET:'test-only'}
function authFixture(){
 const states=new Map(),identities=new Map();let current,issued=0
 const auth={sql:{exec(query,...args){let result=[]
   if(query.startsWith('INSERT INTO oauth'))states.set(args[0],{provider:args[1],verifier:args[2],expires:args[3],device_id:args[4]})
   if(query.startsWith('SELECT * FROM oauth')){const row=states.get(args[0]);if(row&&row.provider===args[1]&&row.expires>args[2])result=[row]}
   if(query.startsWith('DELETE FROM oauth WHERE state='))states.delete(args[0])
   if(query.startsWith('DELETE FROM oauth WHERE provider='))for(const [key,row] of states)if(row.provider===args[0])states.delete(key)
   if(query.startsWith('SELECT subject')&&identities.has(args[0]))result=[{subject:identities.get(args[0])}]
   if(query.startsWith('INSERT INTO identities')&&!identities.has(args[0]))identities.set(args[0],args[1])
   if(query.startsWith('DELETE FROM identities'))identities.delete(args[0])
   return{toArray:()=>result}
 }},rate:async()=>{},authenticate:async(_request,optional)=>{if(!current&&!optional){const error=new Error('Device authorization required');error.status=401;throw error}return current},issue:async()=>{issued++;return{token:'ephemeral-result',device:{client_type:'web'}}}}
 return {auth,states,identities,setCurrent:v=>current=v,issued:()=>issued}
}
const browser={id:'authorized-device',client_type:'web'}
async function start(fixture,provider='github',intent){
 const response=await recovery(new Request(`https://app.invalid/api/recovery/${provider}/start${intent?`?intent=${intent}`:''}`),env,fixture.auth,provider,'start')
 const target=new URL(response.headers.get('Location'))
 assert.equal(response.status,302);assert.equal(target.searchParams.get('code_challenge_method'),'S256');assert.ok(target.searchParams.get('code_challenge'))
 assert.equal(target.searchParams.get('redirect_uri'),`https://app.invalid/api/recovery/${provider}/callback`)
 assert.match(response.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Lax/)
 return target.searchParams.get('state')
}
function callback(state,provider='github',{cookie=`__Host-homework_oauth=${state}`,error,code='ephemeral-code'}={}){
 const url=new URL(`https://app.invalid/api/recovery/${provider}/callback`)
 url.searchParams.set('state',state)
 if(error)url.searchParams.set('error',error)
 else if(code!==undefined)url.searchParams.set('code',code)
 return new Request(url,{headers:{Cookie:cookie}})
}
function navigation(fixture,request,provider='github',action='callback',privateEnv=env){return recoveryNavigation(request,privateEnv,fixture.auth,provider,action)}
function assertRedirect(response,result,failed=true,provider='github'){
 assert.equal(response.status,303)
 assert.equal(response.headers.get('location'),`https://app.invalid/?${failed?'auth_error':'auth'}=${result}&provider=${provider}`)
 assert.match(response.headers.get('set-cookie'),/__Host-homework_oauth=;.*Max-Age=0/)
 assert.equal(response.headers.get('cache-control'),'no-store')
 assert.equal(response.headers.get('referrer-policy'),'no-referrer')
}
function providerMock(t,getSubject=()=>101){
 let calls=0
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  calls++
  if(String(url).includes('token')){assert.ok(options.body.get('code_verifier'));return Response.json({access_token:'test-only-access'})}
  return Response.json(String(url).includes('google')?{sub:getSubject(),email:'mutable@example.invalid'}:{id:getSubject(),login:'mutable-name'})
 })
 return ()=>calls
}
test('provider discovery exposes configured status publicly and bound booleans only to authorized devices',async()=>{
 const fixture=authFixture();fixture.identities.set('github','private-subject')
 const privateEnv={...env,GOOGLE_CLIENT_SECRET:undefined}
 const request=new Request('https://app.invalid/api/recovery/providers')
 let response=await providerStatus(request,privateEnv,fixture.auth)
 assert.deepEqual(await response.json(),{providers:[{id:'github',enabled:true},{id:'google',enabled:false}]})
 fixture.setCurrent(browser)
 response=await providerStatus(request,privateEnv,fixture.auth)
 assert.deepEqual(await response.json(),{providers:[{id:'github',enabled:true,bound:true},{id:'google',enabled:false,bound:false}]})
 response=await providerStatus(request,{...env,PUBLIC_ORIGIN:'http://app.invalid'},fixture.auth)
 assert.deepEqual((await response.json()).providers.map(value=>value.enabled),[false,false])
})
test('legacy flow binds only an authorized browser and recovers only the stable bound subject',async t=>{
 const fixture=authFixture();let subject='101';providerMock(t,()=>subject)
 let state=await start(fixture)
 assertRedirect(await navigation(fixture,callback(state)),'unbound');assert.equal(fixture.issued(),0)
 assertRedirect(await navigation(fixture,callback(state)),'state')
 fixture.setCurrent(browser);state=await start(fixture)
 assertRedirect(await navigation(fixture,callback(state)),'bound',false);assert.equal(fixture.identities.get('github'),'101')
 fixture.setCurrent(undefined);state=await start(fixture)
 const response=await navigation(fixture,callback(state));assertRedirect(response,'complete',false)
 assert.match(response.headers.get('set-cookie'),/__Host-homework_session=.*HttpOnly; Secure/);assert.equal(fixture.issued(),1)
 subject='202';state=await start(fixture)
 assertRedirect(await navigation(fixture,callback(state)),'unbound');assert.equal(fixture.issued(),1)
})
test('explicit binding rejects unauthenticated and desktop devices before creating state',async()=>{
 const fixture=authFixture()
 await assert.rejects(()=>start(fixture,'github','bind'),/authorization required/)
 fixture.setCurrent({id:'desktop-device',client_type:'desktop'})
 await assert.rejects(()=>start(fixture,'github','bind'),/browser authorization required/)
 assert.equal(fixture.states.size,0)
})
test('explicit login while authorized never binds an unbound provider',async t=>{
 const fixture=authFixture();fixture.setCurrent(browser);providerMock(t)
 const state=await start(fixture,'github','login')
 assert.equal([...fixture.states.values()][0].device_id,null)
 assertRedirect(await navigation(fixture,callback(state)),'unbound')
 assert.equal(fixture.identities.size,0);assert.equal(fixture.issued(),0)
 fixture.identities.set('github','101')
 const login=await start(fixture,'github','login')
 assertRedirect(await navigation(fixture,callback(login)),'complete',false)
 assert.equal(fixture.issued(),1)
})
test('tampered, expired, cancelled and replayed states do not contact providers and clear the cookie',async t=>{
 const fixture=authFixture(),calls=providerMock(t)
 const state=await start(fixture)
 assertRedirect(await navigation(fixture,callback(state,'github',{cookie:'__Host-homework_oauth=different'})),'state')
 assertRedirect(await navigation(fixture,callback('nonexistent')),'state')
 assert.equal(calls(),0)
 assertRedirect(await navigation(fixture,callback(state,'github',{error:'access_denied<private-detail>'})),'cancelled')
 assertRedirect(await navigation(fixture,callback(state)),'state');assert.equal(calls(),0)
 const expired=await start(fixture);[...fixture.states.values()][0].expires=0
 assertRedirect(await navigation(fixture,callback(expired)),'state');assert.equal(calls(),0)
})
test('OAuth cookie is recognized after unrelated cookies',async t=>{
 const fixture=authFixture();fixture.identities.set('github','101');const calls=providerMock(t)
 const state=await start(fixture)
 assertRedirect(await navigation(fixture,callback(state,'github',{cookie:`preferences=compact; __Host-homework_oauth=${state}; another=value`})),'complete',false)
 assert.equal(calls(),2);assert.equal(fixture.issued(),1)
})
test('binding callback requires the original browser device',async t=>{
 const fixture=authFixture();fixture.setCurrent(browser);providerMock(t)
 const state=await start(fixture,'github','bind')
 fixture.setCurrent({id:'other-browser',client_type:'web'})
 assertRedirect(await navigation(fixture,callback(state)),'bind_session')
 assert.equal(fixture.identities.size,0);assert.equal(fixture.issued(),0)
})
test('concurrent bindings cannot replace the first completed identity',async t=>{
 const fixture=authFixture();fixture.setCurrent(browser)
 const first=await start(fixture,'github','bind'),second=await start(fixture,'github','bind')
 let identityCalls=0,arrived=0,releaseBoth
 const bothAuthenticated=new Promise(resolve=>{releaseBoth=resolve})
 fixture.auth.authenticate=async()=>{
  arrived++
  if(arrived===2)releaseBoth()
  await bothAuthenticated
  return browser
 }
 t.mock.method(globalThis,'fetch',async url=>{
  if(String(url).includes('token'))return Response.json({access_token:'test-only-access'})
  return Response.json({id:++identityCalls===1?101:202})
 })
 const [firstResult,secondResult]=await Promise.all([navigation(fixture,callback(first)),navigation(fixture,callback(second))])
 const results=[firstResult,secondResult].map(response=>new URL(response.headers.get('location')))
 assert.equal(results.filter(url=>url.searchParams.get('auth')==='bound').length,1)
 assert.equal(results.filter(url=>url.searchParams.get('auth_error')==='already_bound').length,1)
 assert.ok(['101','202'].includes(fixture.identities.get('github')))
})
test('Google uses immutable sub and configured provider failure is a fixed friendly error',async t=>{
 const fixture=authFixture();fixture.identities.set('google','immutable-sub');const calls=providerMock(t,()=> 'immutable-sub')
 const state=await start(fixture,'google')
 assertRedirect(await navigation(fixture,callback(state,'google'),'google'),'complete',false,'google')
 assert.equal(fixture.issued(),1);assert.equal(calls(),2)
 assertRedirect(await navigation(fixture,new Request('https://app.invalid/api/recovery/google/start'),'google','start',{}),'unavailable',true,'google')
})
test('provider exceptions and invalid responses never appear in friendly redirects',async t=>{
 const fixture=authFixture()
 t.mock.method(globalThis,'fetch',async()=>{throw Error('private provider debug detail')})
 let state=await start(fixture)
 assertRedirect(await navigation(fixture,callback(state)),'token_network')
 assertRedirect(await navigation(fixture,callback(state)),'state')
 t.mock.restoreAll()
 t.mock.method(globalThis,'fetch',async()=>Response.json({error_description:'private provider detail'},{status:503}))
 state=await start(fixture)
 assertRedirect(await navigation(fixture,callback(state)),'unavailable')
})
test('unlinking invalidates in-flight binding callbacks',async t=>{
 const fixture=authFixture();fixture.setCurrent(browser);fixture.identities.set('github','101');const calls=providerMock(t)
 const state=await start(fixture,'github','bind')
 assert.deepEqual(await unlinkIdentity(fixture.auth,'github').json(),{removed:true})
 assertRedirect(await navigation(fixture,callback(state)),'state')
 assert.equal(fixture.identities.size,0);assert.equal(calls(),0)
})


test('HTTP 200 OAuth failures are classified without returning provider descriptions or granting access',async t=>{
 for(const [providerError,reason]of [['incorrect_client_credentials','token_config'],['invalid_client','token_config'],['bad_verification_code','token_code'],['invalid_grant','token_code'],['redirect_uri_mismatch','token_redirect'],['unknown-private-error','token_response']]){
  t.mock.restoreAll();const fixture=authFixture();fixture.setCurrent(browser)
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({error:providerError,error_description:'private response detail',access_token:'must-not-use-on-error'})})
  const state=await start(fixture,'github','bind');const response=await navigation(fixture,callback(state));assertRedirect(response,reason)
  assert.equal(calls,1);assert.equal(fixture.identities.size,0);assert.equal(fixture.issued(),0)
 }
})
test('identity fetch failures and malformed payloads use distinct safe results',async t=>{
 for(const [mode,reason]of [['throw','identity_network'],['denied','identity_denied'],['invalid','identity_response']]){
  t.mock.restoreAll();const fixture=authFixture();fixture.setCurrent(browser)
  t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(options.headers['User-Agent'],'Homework-Personal-Cloud');if(String(url).includes('token'))return Response.json({access_token:'test-only-access'});if(mode==='throw')throw Error('private network error');if(mode==='denied')return Response.json({message:'private provider error'},{status:403});return Response.json({id:{invalid:'not-an-id'}})})
  const state=await start(fixture,'github','bind');assertRedirect(await navigation(fixture,callback(state)),reason)
  assert.equal(fixture.identities.size,0)
 }
})
