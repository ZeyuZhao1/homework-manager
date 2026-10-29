import { entityTypes, type CloudSnapshot, type EntityType, type SyncEntity, type SyncMutation } from '../../src/sync/protocol'

export function validDriveId(value: unknown): value is string { return typeof value === 'string' && /^[-_A-Za-z0-9]{10,180}$/.test(value) }
export function validResourceKey(value: unknown): value is string | undefined { return value === undefined || typeof value === 'string' && value.length <= 256 && /^[-_A-Za-z0-9]*$/.test(value) }

export class ApiError extends Error { constructor(public status: number, message: string) { super(message) } }
export interface EntityStore {
  snapshot(): CloudSnapshot
  read(type: EntityType, id: string): SyncEntity | undefined
  commit(operationId: string, changes: SyncMutation[]): void
}
const fields: Record<EntityType, string[]> = {
  semester: ['name'], course: ['semester_id','name','code'],
  assignment: ['course_id','title','description','due_at','status','submission_label','submission_url','submission_notes','source_name','source_text','created_at','updated_at','custom_fields'],
  file: ['name','mime','size','cloud_version','drive_id','drive_resource_key','drive_unavailable'], link: ['assignment_id','file_id','role','page','chapter','problem','note'],
  common_file: ['course_id','file_id','kind','label'], module_file_link: ['module_id','owner_type','owner_id','owner_label','file_id','role','note','created_at'],
  setting: ['value'], module_state: ['enabled'], provider: ['name','kind','base_url','model'], ai_setting: ['value'],
  recurring_series: ['course_id','name','title_template','description','submission_label','submission_url','submission_notes','rule_json','due_rule_json','max_occurrences','end_at','status','created_at','updated_at','timezone'],
  recurring_occurrence: ['series_id','sequence_no','scheduled_at','due_at','state','assignment_id','overridden','created_at','updated_at'],
  calendar: ['semester_id','week1_start_date','updated_at'],
  history: ['file_id','link_id','assignment_id','assignment_title','event_type','file_name','occurred_at'],
  import_course_map: ['module_id','account_key','remote_course_id','course_id'],
  import_link: ['module_id','account_key','remote_course_id','remote_assignment_id','assignment_id','baseline'],
  import_ignored: ['module_id','account_key','remote_course_id','remote_assignment_id','baseline'],
}
const builtins = ['builtin.ai.assignment-import', 'builtin.assignment.recurring']
const parents: Partial<Record<EntityType, [string, EntityType][]>> = {
  course: [['semester_id','semester']], assignment: [['course_id','course']], link: [['assignment_id','assignment'],['file_id','file']],
  common_file: [['course_id','course'],['file_id','file']], module_file_link: [['file_id','file']],
  recurring_series: [['course_id','course']], recurring_occurrence: [['series_id','recurring_series'],['assignment_id','assignment']], calendar: [['semester_id','semester']],
  import_course_map: [['course_id','course']], import_link: [['assignment_id','assignment']],
}
export class SqlEntityStore implements EntityStore {
  constructor(private storage: DurableObjectStorage) {
    this.sql.exec('CREATE TABLE IF NOT EXISTS entities(type TEXT NOT NULL,id TEXT NOT NULL,data TEXT,seq INTEGER NOT NULL,PRIMARY KEY(type,id)); CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,id TEXT NOT NULL,data TEXT); CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY);')
  }
  get sql() { return this.storage.sql }
  private decode(row: Record<string, SqlStorageValue>): SyncEntity { return { entity_type: row.type as EntityType, entity_id: row.id as string, data: row.data === null ? null : JSON.parse(row.data as string), seq: row.seq as number } }
  read(type: EntityType,id: string) { const row = this.sql.exec('SELECT * FROM entities WHERE type=? AND id=?',type,id).toArray()[0]; return row ? this.decode(row) : undefined }
  snapshot(): CloudSnapshot { return { cursor:this.cursor(), entities:this.sql.exec('SELECT * FROM entities ORDER BY seq').toArray().map(row=>this.decode(row)),server_time:new Date().toISOString() } }
  cursor() { return this.sql.exec('SELECT COALESCE(MAX(seq),0) AS seq FROM changes').one().seq as number }
  changes(cursor:number,limit:number) { return this.sql.exec('SELECT * FROM changes WHERE seq>? ORDER BY seq LIMIT ?',cursor,limit).toArray().map(row=>this.decode(row)) }
  hasOperation(id:string){return this.sql.exec('SELECT id FROM operations WHERE id=?',id).toArray().length>0}
  commit(operationId: string, changes: SyncMutation[]) {
    if (typeof operationId !== 'string' || operationId.length<1 || operationId.length>200 || !Array.isArray(changes) || changes.length>20000) throw new ApiError(400,'Invalid operation')
    this.storage.transactionSync(()=>{
      if (this.hasOperation(operationId)) return
      for (const change of changes) this.apply(change)
      this.sql.exec('INSERT INTO operations(id) VALUES(?)',operationId)
    })
  }
  private publish(type: EntityType,id: string,data: Record<string,unknown>|null) {
    const encoded=data===null?null:JSON.stringify(data)
    this.sql.exec('INSERT INTO changes(type,id,data) VALUES(?,?,?)',type,id,encoded)
    this.sql.exec('INSERT INTO entities(type,id,data,seq) VALUES(?,?,?,?) ON CONFLICT(type,id) DO UPDATE SET data=excluded.data,seq=excluded.seq',type,id,encoded,this.cursor())
  }
  private apply(change: SyncMutation) {
    if (!change || !entityTypes.includes(change.entity_type) || typeof change.entity_id!=='string' || !/^[\w.:@-]{1,200}$/.test(change.entity_id)) throw new ApiError(400,'Invalid entity')
    const {entity_type:type,entity_id:id,data}=change
    const previous=this.read(type,id)
    if (data === null) { this.publish(type,id,null); this.cascade(type,id); return }
    if (!data || Array.isArray(data) || typeof data!=='object' || Object.keys(data).some(key=>!fields[type].includes(key))) throw new ApiError(400,'Unsupported field')
    if (previous?.data===null) return // Explicit tombstones never resurrect through stale edits.
    const merged={...previous?.data,...data}
    if (type==='setting' && !['theme','naming_template'].includes(id)) throw new ApiError(400,'Private setting')
    if (type==='ai_setting' && !['assignment_provider_id','material_provider_id'].includes(id)) throw new ApiError(400,'Private AI setting')
    if ((type==='module_state' && !builtins.includes(id)) || (type==='module_file_link' && !builtins.includes(String(merged.module_id)))) throw new ApiError(400,'Unsupported module')
    for (const [key,value] of Object.entries(data)) {
      if (key==='custom_fields') { if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length>40 || Object.entries(value).some(([k,v])=>!k.trim() || new TextEncoder().encode(k).length>80 || typeof v!=='string' || new TextEncoder().encode(v).length>4000)) throw new ApiError(400,'Invalid custom fields') }
      else if (value!==null && !['string','number','boolean'].includes(typeof value)) throw new ApiError(400,'Invalid value')
      else if (typeof value==='string' && value.length>100000) throw new ApiError(400,'Value too long')
    }
    const required=(key:string)=>{if(typeof merged[key]!=='string'||!String(merged[key]).trim())throw new ApiError(400,'Required field is empty')}
    if(type==='semester'||type==='course')required('name')
    if(type==='assignment')required('title')
    if(type==='import_course_map'||type==='import_link'||type==='import_ignored'){
      const validKey=(value:unknown)=>typeof value==='string'&&value.length>0&&new TextEncoder().encode(value).length<=120&&!/[\u0000-\u001f\u007f-\u009f]/.test(value)
      const keys=['module_id','account_key','remote_course_id',...(type==='import_course_map'?[]:['remote_assignment_id'])]
      if(keys.some(key=>!validKey(merged[key])))throw new ApiError(400,'Invalid import identity')
      if(type!=='import_course_map'){
        let baseline:Record<string,unknown>
        try{baseline=JSON.parse(String(merged.baseline))}catch{throw new ApiError(400,'Invalid import baseline')}
        const allowed=['id','course_id','title','description','due_at','status','url']
        if(!baseline||typeof baseline!=='object'||Array.isArray(baseline)||Object.keys(baseline).some(key=>!allowed.includes(key))||baseline.id!==merged.remote_assignment_id||baseline.course_id!==merged.remote_course_id||typeof baseline.title!=='string'||!baseline.title.trim()||new TextEncoder().encode(baseline.title).length>500||typeof baseline.description!=='string'||new TextEncoder().encode(baseline.description).length>10000||!['unknown','submitted','graded'].includes(String(baseline.status))||typeof baseline.url!=='string'||new TextEncoder().encode(baseline.url).length>2048||(baseline.url!==''&&(!baseline.url.startsWith('https://')||baseline.url.includes('@'))))throw new ApiError(400,'Invalid import baseline')
        if(baseline.due_at!=null){const date=baseline.due_at;if(typeof date!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(date)||!Number.isFinite(new Date(date+'Z').getTime())||new Date(date+'Z').toISOString().slice(0,19)!==date)throw new ApiError(400,'Invalid import baseline')}
      }
      const predicate=keys.map(key=>`json_extract(data,'$.${key}')=?`).join(' AND ')
      if(this.sql.exec(`SELECT id FROM entities WHERE type=? AND id<>? AND data IS NOT NULL AND ${predicate} LIMIT 1`,type,id,...keys.map(key=>String(merged[key]))).toArray().length)throw new ApiError(400,'Duplicate import identity')
      if(type==='import_link'&&this.sql.exec("SELECT id FROM entities WHERE type='import_link' AND id<>? AND data IS NOT NULL AND json_extract(data,'$.module_id')=? AND json_extract(data,'$.assignment_id')=? LIMIT 1",id,String(merged.module_id),String(merged.assignment_id)).toArray().length)throw new ApiError(400,'Duplicate import assignment')
    }
    if(type==='link'&&!['prompt','reference','solution'].includes(String(merged.role)))throw new ApiError(400,'Invalid file role')
    if(type==='common_file'&&!['textbook','extra','other'].includes(String(merged.kind)))throw new ApiError(400,'Invalid common file kind')
    if(type==='setting'&&id==='theme'&&!['light','dark','system'].includes(String(merged.value)))throw new ApiError(400,'Invalid theme')
    if(type==='module_state'&&![true,false,0,1].includes(merged.enabled as boolean))throw new ApiError(400,'Invalid module state')
    if(type==='file'&&merged.size!=null&&(!Number.isSafeInteger(merged.size)||Number(merged.size)<0))throw new ApiError(400,'Invalid file size')
    for(const key of ['due_at','scheduled_at','end_at']){
      const value=merged[key];if(value==null||value==='')continue
      if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(value))throw new ApiError(400,'Invalid date')
      const date=new Date(`${value.length===16?value+':00':value}Z`);if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,value.length)!==value)throw new ApiError(400,'Invalid calendar date')
    }
    const nullable=['due_at','scheduled_at','end_at','max_occurrences','assignment_id','cloud_version','size','drive_id','drive_resource_key']
    for(const [key,value]of Object.entries(merged))if(value===null&&!nullable.includes(key))throw new ApiError(400,'Invalid null field')
    for(const key of ['size','max_occurrences','sequence_no','overridden'])if(merged[key]!=null&&(!Number.isSafeInteger(merged[key])||Number(merged[key])<0))throw new ApiError(400,'Invalid number')
    if(merged.overridden!==undefined&&![0,1].includes(Number(merged.overridden)))throw new ApiError(400,'Invalid override state')
    if(type==='calendar'){const value=String(merged.week1_start_date??'');if(!/^\d{4}-\d\d-\d\d$/.test(value)||!Number.isFinite(new Date(value+'T00:00:00Z').getTime())||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw new ApiError(400,'Invalid calendar date')}
    const numbers=['size','max_occurrences','sequence_no','overridden','drive_unavailable']
    const booleans=['enabled']
    for(const [key,value]of Object.entries(merged))if(key!=='custom_fields'&&!numbers.includes(key)&&!booleans.includes(key)&&value!==null&&typeof value!=='string')throw new ApiError(400,'Invalid field type')
    if(type==='recurring_occurrence'&&this.sql.exec("SELECT id FROM entities WHERE type='recurring_occurrence' AND id<>? AND data IS NOT NULL AND ((json_extract(data,'$.series_id')=? AND json_extract(data,'$.sequence_no')=?) OR (? IS NOT NULL AND json_extract(data,'$.assignment_id')=?)) LIMIT 1",id,String(merged.series_id??''),Number(merged.sequence_no??0),typeof merged.assignment_id==='string'?merged.assignment_id:null,typeof merged.assignment_id==='string'?merged.assignment_id:null).toArray().length>0)throw new ApiError(400,'Duplicate recurrence occurrence')
    if(type==='recurring_occurrence' && (!Number.isSafeInteger(merged.sequence_no)||Number(merged.sequence_no)<1||!['planned','blocked','generated','skipped','cancelled'].includes(String(merged.state))))throw new ApiError(400,'Invalid occurrence')
    if(type==='file'){
      const drive=merged.drive_id!=null||id.startsWith('gdrive-')
      if(drive){
        if(!validDriveId(merged.drive_id)||id!==`gdrive-${merged.drive_id}`||!validResourceKey(merged.drive_resource_key??undefined)||merged.cloud_version!==undefined||merged.size!=null||merged.drive_unavailable!==undefined&&![0,1].includes(merged.drive_unavailable as number))throw new ApiError(400,'Invalid Google Drive reference')
        if(previous?.data&&previous.data.drive_id!==merged.drive_id)throw new ApiError(400,'Google Drive identity is immutable')
      }else if(merged.drive_resource_key!=null||merged.drive_unavailable!==undefined&&merged.drive_unavailable!==0||previous?.data?.drive_id)throw new ApiError(400,'Invalid Google Drive reference')
    }
    if (type==='file' && (typeof merged.name!=='string' || !merged.name.trim() || (merged.drive_id?new TextEncoder().encode(merged.name).length>1024:merged.name.length>255) || /[\u0000-\u001f\u007f-\u009f]/.test(merged.name) || !merged.drive_id && /[\\/]/.test(merged.name))) throw new ApiError(400,'Invalid file name')
    if (type==='assignment' && !['todo','doing','done','submitted'].includes(String(merged.status??'todo'))) throw new ApiError(400,'Invalid assignment status')
    if (type==='file' && ('cloud_version' in data) && (data.cloud_version!==null||previous?.data?.cloud_version)) throw new ApiError(400,'Cloud content is server managed')
    for (const [key,parentType] of parents[type]??[]) { const parentId=merged[key]; if (key==='assignment_id' && type==='recurring_occurrence' && !parentId) continue; if (typeof parentId!=='string' || !this.read(parentType,parentId)?.data) throw new ApiError(400,'Missing parent') }
    if (type==='calendar' && merged.semester_id!==id) throw new ApiError(400,'Invalid calendar ID')
    if (type==='common_file' && id!==`${merged.course_id}:${merged.file_id}`) throw new ApiError(400,'Invalid association ID')
    if (type==='module_file_link') { if (merged.owner_type!=='recurring_series' || !this.read('recurring_series',String(merged.owner_id))?.data) throw new ApiError(400,'Missing module owner') }
    this.publish(type,id,merged)
  }
  setFileVersion(id:string,version:string|null,mime?:string,size?:number) {
    this.storage.transactionSync(()=>{ const row=this.read('file',id); if (!row?.data) throw new ApiError(404,'File not found'); if(row.data.drive_id||id.startsWith('gdrive-'))throw new ApiError(400,'Google Drive references have no content'); this.publish('file',id,{...row.data,cloud_version:version,...(mime?{mime,size}:{})}) })
  }
  private cascade(type:EntityType,id:string) {
    for (const row of this.snapshot().entities) {
      if (!row.data) continue
      const dependent=(parents[row.entity_type]??[]).some(([key,parentType])=>parentType===type && row.data?.[key]===id)
      const moduleOwner=type==='recurring_series' && row.entity_type==='module_file_link' && row.data.owner_id===id
      if (dependent && type==='assignment' && row.entity_type==='recurring_occurrence') { this.publish('recurring_occurrence',row.entity_id,{...row.data,assignment_id:null,state:'skipped'});continue }
      if (dependent || moduleOwner) {
        if(['link','common_file','module_file_link'].includes(row.entity_type)){const fileId=String(row.data.file_id??'');this.publish('history',crypto.randomUUID(),{file_id:fileId,link_id:row.entity_type==='link'?row.entity_id:'',assignment_id:String(row.data.assignment_id??''),assignment_title:'',event_type:row.entity_type==='common_file'?'common_removed':row.entity_type==='module_file_link'?'module_unlinked':'unlinked',file_name:String(this.read('file',fileId)?.data?.name??''),occurred_at:new Date().toISOString()})}
        this.publish(row.entity_type,row.entity_id,null); this.cascade(row.entity_type,row.entity_id) }
    }
  }
}
