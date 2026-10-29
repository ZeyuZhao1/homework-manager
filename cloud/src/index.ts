import { DurableObject } from 'cloudflare:workers'
import { Auth, body, boundedBytes, json } from './auth'
import { ApiError, SqlEntityStore } from './store'
import { recoveryNavigation, providerStatus, unlinkIdentity } from './recovery'
import { runRecurrence, recurringAction } from './recurrence'
import { handleAi } from './ai'
import { appearanceAsset } from './appearance'
import { CredentialError, readAiCredential, saveAiCredential, deleteAiCredential } from './ai-credentials'
import { syncLimits, type SyncRequest } from '../../src/sync/protocol'

export class PersonalSpace extends DurableObject<Env> {
  private store:SqlEntityStore
  private auth:Auth
  constructor(ctx:DurableObjectState,env:Env){super(ctx,env);this.store=new SqlEntityStore(ctx.storage);this.auth=new Auth(ctx.storage,env);ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS active_baselines(device_id TEXT PRIMARY KEY,started_at INTEGER NOT NULL)')}
  private baselinePending(){return this.ctx.storage.sql.exec('SELECT device_id FROM active_baselines LIMIT 1').toArray().length>0}
  async tick(){ if(!this.baselinePending())runRecurrence(this.store,new Date()) }
  async fetch(request:Request):Promise<Response>{
    try{return await this.route(request)}catch(error){return json({error:error instanceof ApiError||error instanceof CredentialError?error.message:'Request failed'},error instanceof ApiError||error instanceof CredentialError?error.status:500)}
  }
  private async route(request:Request):Promise<Response>{
    const path=new URL(request.url).pathname,method=request.method
    const origin=request.headers.get('origin')
    if(origin && origin!==new URL(request.url).origin && !['GET','HEAD'].includes(method))throw new ApiError(403,'Same-origin request required')
    if(path==='/api/health'&&method==='GET')return json({protocol:1,service:'homework-personal-sync'})
    if(path==='/api/bootstrap'&&method==='POST')return this.auth.bootstrap(request)
    if(path==='/api/pair/start'&&method==='POST')return this.auth.start(request)
    if(path==='/api/pair/poll'&&method==='POST')return this.auth.poll(request)
    if(path==='/api/recovery/providers'&&method==='GET')return providerStatus(request,this.env,this.auth)
    const recover=path.match(/^\/api\/recovery\/(github|google)\/(start|callback)$/)
    if(recover&&method==='GET')return recoveryNavigation(request,this.env,this.auth,recover[1],recover[2])
    const device=await this.auth.authenticate(request)
    if(!device)throw new ApiError(401,'Device authorization required')
    const identity=path.match(/^\/api\/recovery\/(github|google)$/)
    if(identity&&method==='DELETE')return unlinkIdentity(this.auth,identity[1])
    if(path==='/api/pair/approve'&&method==='POST')return this.auth.approve(request)
    if(path==='/api/devices'&&method==='GET')return this.auth.list(device.id)
    if(path==='/api/logout'&&method==='POST'){this.ctx.storage.sql.exec('DELETE FROM active_baselines WHERE device_id=?',device.id);return this.auth.revoke(device.id)}
    const revoke=path.match(/^\/api\/devices\/([\w-]+)$/)
    if(revoke&&method==='DELETE'){this.ctx.storage.sql.exec('DELETE FROM active_baselines WHERE device_id=?',revoke[1]);return this.auth.revoke(revoke[1])}
    if(path==='/api/snapshot'&&method==='GET'){
      await this.tick()
      const pending_baselines=this.ctx.storage.sql.exec('SELECT b.device_id,b.started_at,d.name FROM active_baselines b JOIN devices d ON d.id=b.device_id ORDER BY b.started_at,b.device_id').toArray().map(row=>({device_id:String(row.device_id),name:String(row.name),started_at:new Date(Number(row.started_at)).toISOString()}))
      return json({...this.store.snapshot(),pending_baselines})
    }
    if(path==='/api/sync'&&method==='POST'){
      const input=await body(request) as unknown as SyncRequest
      if(!Number.isSafeInteger(input.cursor)||input.cursor<0||input.cursor>this.store.cursor()||!Array.isArray(input.operations)||input.operations.length>syncLimits.maxOperations||input.operations.reduce((sum,op)=>sum+(Array.isArray(op?.changes)?op.changes.length:syncLimits.maxChanges+1),0)>syncLimits.maxChanges)throw new ApiError(400,'Invalid sync request')
      const baseline=input.baseline
      if(baseline!==undefined && (!['begin','complete'].includes(baseline)||device.client_type!=='desktop'||input.operations.length))throw new ApiError(400,'Invalid baseline request')
      // Entire batch either commits or rolls back. The operation ledger, entity fields and sequence share the transaction.
      const hadSemester=this.ctx.storage.sql.exec("SELECT id FROM entities WHERE type='semester' AND data IS NOT NULL LIMIT 1").toArray().length>0
      this.ctx.storage.transactionSync(()=>{
        if(baseline==='begin')this.ctx.storage.sql.exec('INSERT INTO active_baselines(device_id,started_at) VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET started_at=excluded.started_at',device.id,Date.now())
        const importing=this.ctx.storage.sql.exec('SELECT device_id FROM active_baselines WHERE device_id=?',device.id).toArray().length>0
        for(const op of input.operations){
          if(typeof op.operation_id==='string'&&this.store.hasOperation(op.operation_id))continue
          if(op.changes.some(change=>!change||typeof change!=='object'))throw new ApiError(400,'Invalid mutation')
          // A baseline carries full local rows. Existing occurrence schedules and generated
          // assignment IDs remain server-owned; retain only the user's skip/override intent.
          const changes=op.changes.map(change=>{
            if(!importing||change.entity_type!=='recurring_occurrence'||!change.data||typeof change.data!=='object'||Array.isArray(change.data)||!this.store.read('recurring_occurrence',change.entity_id)?.data)return change
            const data:Record<string,unknown>={}
            if(change.data.overridden===1)data.overridden=1
            if(change.data.state==='skipped'&&change.data.assignment_id===null){data.state='skipped';data.assignment_id=null}
            if(Object.keys(data).length&&typeof change.data.updated_at==='string')data.updated_at=change.data.updated_at
            return {...change,data}
          })
          for(const change of changes){
            if(change.entity_type!=='recurring_occurrence'||change.data===null)continue
            const existing=this.store.read('recurring_occurrence',change.entity_id)
            if(!existing){if(!importing)throw new ApiError(400,'Occurrences are server managed')}
            else if(existing.data!==null && Object.keys(change.data).some(key=>!['overridden','state','assignment_id','updated_at'].includes(key)))throw new ApiError(400,'Occurrences are server managed')
            if(existing?.data){
              const merged={...existing.data,...change.data}
              if('assignment_id' in change.data&&(change.data.assignment_id!==null||merged.state!=='skipped'))throw new ApiError(400,'Occurrences are server managed')
              if('state' in change.data&&(merged.state!=='skipped'||merged.assignment_id!==null))throw new ApiError(400,'Invalid occurrence transition')
            }
          }
          this.store.commit(op.operation_id,changes)
        }
        if(hadSemester&&!this.ctx.storage.sql.exec("SELECT id FROM entities WHERE type='semester' AND data IS NOT NULL LIMIT 1").toArray().length)throw new ApiError(409,'At least one semester must remain')
        if(baseline==='complete')this.ctx.storage.sql.exec('DELETE FROM active_baselines WHERE device_id=?',device.id)
        if(!this.baselinePending())try{runRecurrence(this.store,new Date())}catch{throw new ApiError(400,'Invalid recurrence configuration')}
      })
      const limit=Math.min(syncLimits.pageSize,Math.max(1,Number.isSafeInteger(input.limit)?input.limit!:syncLimits.pageSize)),changes=this.store.changes(input.cursor,limit),cursor=changes.at(-1)?.seq??input.cursor
      return json({cursor,changes,acknowledged:input.operations.map(op=>op.operation_id),has_more:cursor<this.store.cursor(),server_time:new Date().toISOString()})
    }
    if(path==='/api/recurring/action'&&method==='POST'){if(this.baselinePending())throw new ApiError(409,'Desktop baseline upload is pending');const input=await body(request);try{return json(recurringAction(this.store,input,new Date()))}catch{throw new ApiError(400,'Invalid recurrence action')}}
    if(path==='/api/ai/credentials'&&method==='GET'){
      await this.auth.rate(request,'ai-credentials-read')
      const credentials:Record<string,{has_key:boolean}>=Object.create(null)
      for(const provider of this.store.snapshot().entities.filter(row=>row.entity_type==='provider'&&row.data))credentials[provider.entity_id]={has_key:!!await readAiCredential(this.env,provider.entity_id)}
      return json({credentials})
    }
    const credential=path.match(/^\/api\/ai\/providers\/([\w.:@-]{1,200})\/credential$/)
    if(credential&&['PUT','DELETE'].includes(method)){
      await this.auth.rate(request,'ai-credentials-write')
      const id=credential[1]
      if(!this.store.read('provider',id)?.data)throw new ApiError(404,'Provider not found')
      if(method==='PUT'){
        let input:unknown
        try{input=JSON.parse(new TextDecoder().decode(await boundedBytes(request,8192)))}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400,'Invalid JSON')}
        if(!input||typeof input!=='object'||Array.isArray(input)||typeof (input as Record<string,unknown>).api_key!=='string'||Object.keys(input).some(key=>key!=='api_key'))throw new ApiError(400,'Expected api_key string')
        await saveAiCredential(this.env,id,(input as {api_key:string}).api_key)
      }else await deleteAiCredential(this.env,id)
      return json({provider_id:id,has_key:method==='PUT'})
    }
    const file=path.match(/^\/api\/files\/([\w.:@-]+)\/content$/)
    if(file){const id=file[1],record=this.store.read('file',id);if(!record?.data)throw new ApiError(404,'File not found');const version=record.data.cloud_version
      if(typeof version==='string'&&!version.startsWith(`content/${id}/`))throw new ApiError(404,'No uploaded content')
      if(method==='GET'){if(typeof version!=='string')throw new ApiError(404,'No uploaded content');const object=await this.env.FILES.get(version);if(!object)throw new ApiError(404,'No uploaded content');const headers=new Headers({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'attachment'});object.writeHttpMetadata(headers);return new Response(object.body,{headers})}
      if(method==='PUT'){
        if(request.headers.get('X-Upload-Confirmed')!=='true')throw new ApiError(400,'Explicit upload confirmation required')
        if(Number(request.headers.get('content-length'))>syncLimits.maxFileBytes)throw new ApiError(413,'File too large')
        const content=await boundedBytes(request,syncLimits.maxFileBytes);if(content.byteLength>syncLimits.maxFileBytes)throw new ApiError(413,'File too large')
        const next=`content/${id}/${crypto.randomUUID()}`,mime=request.headers.get('content-type')??'application/octet-stream'
        await this.env.FILES.put(next,content,{httpMetadata:{contentType:mime}})
        try{this.store.setFileVersion(id,next,mime,content.byteLength)}catch(error){await this.env.FILES.delete(next);throw error}
        if(typeof version==='string')await this.env.FILES.delete(version)
        return json({uploaded:true,cloud_version:next})
      }
      if(method==='DELETE'){this.store.setFileVersion(id,null);if(typeof version==='string')await this.env.FILES.delete(version);return json({removed:true})}
    }
    if(path==='/api/ai/analyze'&&method==='POST')return handleAi(request,this.env,this.store)
    throw new ApiError(404,'API route not found')
  }
}
export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const url=new URL(request.url)
    if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))return json({error:'HTTPS required'},400)
    if(url.pathname==='/api'||url.pathname.startsWith('/api/'))return env.SPACE.getByName(env.SPACE_NAME??'personal').fetch(request)
    const asset = await appearanceAsset(request,env.ASSETS)
    const response = new Response(asset.body, asset)
    response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")
    response.headers.set('Referrer-Policy', 'no-referrer')
    response.headers.set('X-Content-Type-Options', 'nosniff')
    return response
  },
  async scheduled(_controller:ScheduledController,env:Env){await env.SPACE.getByName(env.SPACE_NAME??'personal').tick()},
} satisfies ExportedHandler<Env>
