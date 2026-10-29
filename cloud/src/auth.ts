import { ApiError } from './store'
import type { SyncDevice } from '../../src/sync/protocol'
export const json=(data:unknown,status=200,headers?:HeadersInit)=>Response.json(data,{status,headers:{'Cache-Control':'no-store',...headers}})
export const secret=()=>crypto.randomUUID()+crypto.randomUUID()
export async function secretMatches(a:string,b:string){const encoder=new TextEncoder();const [left,right]=await Promise.all([crypto.subtle.digest('SHA-256',encoder.encode(a)),crypto.subtle.digest('SHA-256',encoder.encode(b))]);return crypto.subtle.timingSafeEqual(left,right)}
export async function hash(value:string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('') }
export async function boundedBytes(request:Request|Response,limit:number):Promise<Uint8Array> {
  if(Number(request.headers.get('content-length'))>limit)throw new ApiError(413,'Request too large')
  const reader=request.body?.getReader();if(!reader)return new Uint8Array()
  const chunks:Uint8Array[]=[];let length=0
  try { while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit){await reader.cancel();throw new ApiError(413,'Request too large')}chunks.push(value)} } finally {reader.releaseLock()}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}return bytes
}
export async function body(request:Request):Promise<Record<string,unknown>> { const raw=new TextDecoder().decode(await boundedBytes(request,2*1024*1024)); try { const result=JSON.parse(raw);if(!result||typeof result!=='object'||Array.isArray(result)) throw 0;return result } catch {throw new ApiError(400,'Invalid JSON')} }
export function sessionCookie(token:string) { return `__Host-homework_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000` }
export class Auth {
  constructor(private storage:DurableObjectStorage, private env:Env) {
    this.sql.exec('CREATE TABLE IF NOT EXISTS auth_meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT,client_type TEXT,created_at TEXT,last_seen_at TEXT,token_hash TEXT UNIQUE,revoked INTEGER DEFAULT 0); CREATE TABLE IF NOT EXISTS pairs(id TEXT PRIMARY KEY,poll_hash TEXT,code TEXT UNIQUE,name TEXT,client_type TEXT,expires INTEGER,approved INTEGER DEFAULT 0); CREATE TABLE IF NOT EXISTS rates(key TEXT PRIMARY KEY,bucket INTEGER,count INTEGER); CREATE TABLE IF NOT EXISTS oauth(state TEXT PRIMARY KEY,provider TEXT,verifier TEXT,expires INTEGER,device_id TEXT); CREATE TABLE IF NOT EXISTS identities(provider TEXT PRIMARY KEY,subject TEXT NOT NULL);')
  }
  get sql(){return this.storage.sql}
  device(row:Record<string,SqlStorageValue>):SyncDevice{return {id:String(row.id),name:String(row.name),client_type:row.client_type as 'desktop'|'web',created_at:String(row.created_at),last_seen_at:String(row.last_seen_at)}}
  async authenticate(request:Request,optional=false):Promise<SyncDevice|undefined> {
    const bearer=request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1]
    const cookie=request.headers.get('cookie')?.match(/(?:^|;\s*)__Host-homework_session=([^;]+)/)?.[1]
    const token=bearer??cookie
    if(!token){if(optional)return;throw new ApiError(401,'Device authorization required')}
    const row=this.sql.exec('SELECT * FROM devices WHERE token_hash=? AND revoked=0',await hash(token)).toArray()[0]
    if(!row){if(optional)return;throw new ApiError(401,'Device authorization required')}
    // Cookie mutations require a same-origin browser request. Bearer clients do not use ambient authority.
    if(!bearer && !['GET','HEAD'].includes(request.method) && request.headers.get('origin')!==new URL(request.url).origin) throw new ApiError(403,'Same-origin request required')
    this.sql.exec('UPDATE devices SET last_seen_at=? WHERE id=?',new Date().toISOString(),row.id)
    return this.device(row)
  }
  async rate(request:Request,category:string) { const key=await hash(`${category}:${request.headers.get('CF-Connecting-IP')??'local'}`),bucket=Math.floor(Date.now()/60000);this.storage.transactionSync(()=>{const row=this.sql.exec('SELECT * FROM rates WHERE key=?',key).toArray()[0];if(row?.bucket===bucket && Number(row.count)>=(category==='pair-poll'?120:12))throw new ApiError(429,'Try again later');this.sql.exec('INSERT INTO rates(key,bucket,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET bucket=excluded.bucket,count=CASE WHEN rates.bucket=excluded.bucket THEN rates.count+1 ELSE 1 END',key,bucket);this.sql.exec('DELETE FROM rates WHERE bucket<?',bucket-2)}) }
  validateClient(input:Record<string,unknown>) { if(typeof input.device_name!=='string'||input.device_name.length<1||input.device_name.length>100||!['desktop','web'].includes(String(input.client_type)))throw new ApiError(400,'Invalid device');return {name:input.device_name,client_type:input.client_type as 'desktop'|'web'} }
  async issue(name:string,clientType:'desktop'|'web') {
    const token=secret(),tokenHash=await hash(token),now=new Date().toISOString(),id=crypto.randomUUID()
    const device:SyncDevice={id,name,client_type:clientType,created_at:now,last_seen_at:now}
    this.sql.exec('INSERT INTO devices(id,name,client_type,created_at,last_seen_at,token_hash) VALUES(?,?,?,?,?,?)',id,name,clientType,now,now,tokenHash)
    return {token,device}
  }
  credentialResponse(result:{token:string,device:SyncDevice},state?:string) {return json({...state?{state}:{},device:result.device,...result.device.client_type==='desktop'?{token:result.token}:{}},200,result.device.client_type==='web'?{'Set-Cookie':sessionCookie(result.token)}:undefined)}
  async bootstrap(request:Request){await this.rate(request,'bootstrap');const input=await body(request),client=this.validateClient(input);if(!this.env.BOOTSTRAP_SECRET||typeof input.bootstrap_secret!=='string'||!await secretMatches(input.bootstrap_secret,this.env.BOOTSTRAP_SECRET))throw new ApiError(403,'Bootstrap unavailable');const resultToken=secret(),tokenHash=await hash(resultToken),now=new Date().toISOString(),id=crypto.randomUUID();this.storage.transactionSync(()=>{if(this.sql.exec("SELECT value FROM auth_meta WHERE key='bootstrapped'").toArray().length)throw new ApiError(409,'Already initialized');this.sql.exec("INSERT INTO auth_meta(key,value) VALUES('bootstrapped','1')");this.sql.exec('INSERT INTO devices(id,name,client_type,created_at,last_seen_at,token_hash) VALUES(?,?,?,?,?,?)',id,client.name,client.client_type,now,now,tokenHash)});return this.credentialResponse({token:resultToken,device:{id,name:client.name,client_type:client.client_type,created_at:now,last_seen_at:now}})}
  async start(request:Request){await this.rate(request,'pair-start');const client=this.validateClient(await body(request)),id=crypto.randomUUID(),poll=secret(),code=crypto.randomUUID().replaceAll('-','').slice(0,10).toUpperCase(),expires=Date.now()+600000;this.sql.exec('DELETE FROM pairs WHERE expires<?',Date.now());this.sql.exec('INSERT INTO pairs(id,poll_hash,code,name,client_type,expires) VALUES(?,?,?,?,?,?)',id,await hash(poll),code,client.name,client.client_type,expires);return json({pair_id:id,poll_secret:poll,code,expires_at:new Date(expires).toISOString()})}
  async approve(request:Request){const input=await body(request);if(typeof input.code!=='string')throw new ApiError(400,'Invalid code');const row=this.sql.exec('SELECT * FROM pairs WHERE code=? AND expires>? AND approved=0',input.code,Date.now()).toArray()[0];if(!row)throw new ApiError(404,'Pairing code unavailable');this.sql.exec('UPDATE pairs SET approved=1,code=NULL WHERE id=?',row.id);return json({approved:true})}
  async poll(request:Request){await this.rate(request,'pair-poll');const input=await body(request);if(typeof input.pair_id!=='string'||typeof input.poll_secret!=='string')throw new ApiError(400,'Invalid pairing');const pollHash=await hash(input.poll_secret);const row=this.sql.exec('SELECT * FROM pairs WHERE id=? AND poll_hash=?',input.pair_id,pollHash).toArray()[0];if(!row||Number(row.expires)<Date.now())return json({state:'expired'});if(!row.approved)return json({state:'pending'}); // Consume before yielding to token hashing; concurrent polls cannot both receive credentials.
    this.sql.exec('DELETE FROM pairs WHERE id=?',row.id);const result=await this.issue(String(row.name),row.client_type as 'desktop'|'web');return this.credentialResponse(result,'approved')}
  list(current:string){return json({devices:this.sql.exec('SELECT * FROM devices WHERE revoked=0 ORDER BY created_at').toArray().map(row=>({...this.device(row),current:row.id===current}))})}
  revoke(id:string){this.sql.exec('UPDATE devices SET revoked=1 WHERE id=?',id);return json({revoked:true})}
}
