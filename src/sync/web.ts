import type { CloudSnapshot, EntityData, EntityType, SyncMutation, SyncResponse } from './protocol'
import { syncLimits } from './protocol'
import type { Assignment, CommonFile, Course, FileHistoryEvent, FileLink, LinkBatchInput, LinkInput, ModuleDescriptor, Semester, Settings, Snapshot } from '../types'

let cloud = false
let state: CloudSnapshot = { cursor: 0, entities: [], server_time: '' }
const picked = new Map<string, File>()
const selectedIds = new Map<string, string>()
// Form spreads preserve this symbol, while JSON serialization never transmits it.
// Compare edits with what the user opened, even if background refresh pulled newer fields.
const baseline = Symbol('cloud-form-baseline')
function editable<T extends object>(row: T): T { return Object.assign(row, { [baseline]: { ...row } }) }
export class SessionRequired extends Error {}
async function request<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (response.status === 401) { window.dispatchEvent(new Event('homeworkbook:session-required')); throw new SessionRequired('请先授权此设备') }
  if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(typeof result.error === 'string' ? result.error : `请求失败 (${response.status})`) }
  return response.status === 204 ? undefined as T : response.json()
}
function entities(type: EntityType) { return state.entities.filter(row => row.entity_type === type && row.data !== null).map(row => ({ ...row.data, id: row.entity_id })) as (EntityData & { id: string })[] }
async function refresh() { const next = await request<CloudSnapshot>('/snapshot'); if (next.cursor >= state.cursor) state = next; return state }
async function mutate(changes: SyncMutation[]) {
  if (!changes.length) return
  // Keep the operation ID stable across transport failures, so an explicit retry cannot replay a mutation.
  const operation = { operation_id: crypto.randomUUID(), changes }
  const send = () => request<SyncResponse>('/sync', { cursor: state.cursor, operations: [operation] })
  try { await send() } catch (error) { if (error instanceof TypeError) await send(); else throw error }
  await refresh()
}
function patch(type: EntityType, id: string, data: EntityData, original?: EntityData): SyncMutation {
  const old = original || entities(type).find(row => row.id === id)
  return { entity_type: type, entity_id: id, data: Object.fromEntries(Object.entries(data).filter(([key, value]) => key !== 'id' && JSON.stringify(old?.[key]) !== JSON.stringify(value))) }
}
async function save(type: EntityType, input: { id?: string }, data: EntityData) { const id = input.id || crypto.randomUUID(); const original = (input as { [baseline]?: EntityData })[baseline]; await mutate([patch(type, id, data, original)]); return id }
const remove = (type: EntityType, id: string) => mutate([{ entity_type: type, entity_id: id, data: null }])
function history(fileId: string, event: FileHistoryEvent['event_type'], link?: Partial<FileLink>): SyncMutation {
  const file = entities('file').find(row => row.id === fileId)
  return { entity_type: 'history', entity_id: crypto.randomUUID(), data: { file_id: fileId, link_id: link?.id || '', assignment_id: link?.assignment_id || '', assignment_title: entities('assignment').find(row => row.id === link?.assignment_id)?.title || '', event_type: event, file_name: String(file?.name || ''), occurred_at: new Date().toISOString() } }
}
function snapshot(): Snapshot {
  const rows = <T,>(type: EntityType) => entities(type) as unknown as T[]
  const settings: Settings = { theme: 'light', naming_template: '{course_code}-{material}-hw-{scope}' }
  for (const row of entities('setting')) if (row.id === 'theme' || row.id === 'naming_template') Object.assign(settings, { [row.id]: row.value })
  return { semesters: rows<Semester>('semester').map(row => editable({ ...row, source_root: '' })), courses: rows<Course>('course').map(row => editable({ ...row, folder_path: '' })), assignments: rows<Assignment>('assignment').map(row => editable({ ...row, custom_fields: row.custom_fields || {} })), files: entities('file').map(row => ({ id: row.id, name: String(row.name || '未命名文件'), path: `cloud:${row.id}/${String(row.name || '未命名文件')}`, missing: false, cloud_available: !!row.cloud_version })), links: rows<FileLink>('link').map(editable), common_files: rows('common_file'), module_file_links: rows('module_file_link'), renames: [], file_history: entities('history').map(row => ({ ...row, path: String(row.file_name || ''), details: '', file_size: null, modified_at_ms: null })) as unknown as FileHistoryEvent[], settings: editable(settings), recent_values: {} }
}
async function resolveFile(path: string) {
  const selectedId = selectedIds.get(path)
  if (selectedId && entities('file').some(row => row.id === selectedId)) return selectedId
  const existing = entities('file').find(row => row.id === path || path.startsWith(`cloud:${row.id}/`))
  if (existing) return existing.id
  const file = picked.get(path)
  if (!file) throw new Error('请重新选择文件；本地路径不能作为云端附件')
  const id = await save('file', {}, { name: file.name, mime: file.type || 'application/octet-stream', size: file.size })
  // Selecting a file only creates metadata. Content transfer has a separate, explicit action.
  picked.set(id, file)
  selectedIds.set(path, id)
  return id
}
async function upload(id: string, file: File) {
  if (file.size > syncLimits.maxFileBytes) throw new Error('文件不能超过 20 MB')
  if (!window.confirm(`上传“${file.name}”的完整内容到个人云端？\n仅本次上传；后续修改不会自动上传。`)) throw new Error('已取消上传；仅保留附件元数据')
  const response = await fetch(`/api/files/${encodeURIComponent(id)}/content`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Upload-Confirmed': 'true' }, body: file })
  if (!response.ok) throw new Error('附件上传失败，请检查授权和连接后重试')
  picked.delete(id)
  await refresh()
}
async function pickFiles(): Promise<string[]> {
  return new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; input.multiple = true
    input.onchange = () => { const ids = Array.from(input.files || []).map(file => { const id = `selected:${crypto.randomUUID()}/${file.name}`; picked.set(id, file); return id }); resolve(ids); input.remove() }
    input.oncancel = () => { resolve([]); input.remove() }; input.style.display = 'none'; document.body.append(input); input.click()
  })
}
const desktopOnly = async (): Promise<never> => { throw new Error('此功能需要桌面应用') }
export const webSync = {
  get isCloud() { return cloud }, request, entities, mutate, patch, refresh, snapshot, pickFiles,
  pendingBaselines() { return state.pending_baselines || [] },
  async initialize() { if (import.meta.env.DEV) return false; cloud = true; await request('/health'); await refresh(); return true },
  async uploadFile(id: string) { let file = picked.get(id); if (!file) { const ids = await pickFiles(); file = ids[0] ? picked.get(ids[0]) : undefined } if (!file) throw new Error('未选择文件，未上传任何内容'); await upload(id, file) },
  stageFile(file: File) { const id = `selected:${crypto.randomUUID()}/${file.name}`; picked.set(id, file); return id },
  async prepareAiFiles(paths: string[]) { const ids: string[] = []; for (const path of paths) { const id = await resolveFile(path); if (!entities('file').find(row => row.id === id)?.cloud_version) { const file = picked.get(id); if (!file) throw new Error('请先为附件上传内容'); await upload(id, file) } ids.push(id) } return ids },
}
export const cloudService = {
  async snapshot() { await refresh(); return snapshot() },
  saveSemester: (input: Semester) => save('semester', input, { name: input.name }),
  async deleteSemester(id: string) { if (entities('semester').length <= 1) throw new Error('至少需要保留一个学期'); await remove('semester', id) },
  saveCourse: (input: Course) => save('course', input, { semester_id: input.semester_id, name: input.name, code: input.code }),
  saveAssignment: (input: Assignment) => save('assignment', input, { ...input }),
  deleteAssignment: (id: string) => remove('assignment', id),
  async saveAssignmentsBatch(assignments: Assignment[], paths: string[], role: LinkInput['role']) { const ids = []; for (const assignment of assignments) { const id = await cloudService.saveAssignment(assignment); for (const path of paths) await cloudService.linkFile({ id: '', assignment_id: id, path, role, page: '', chapter: '', problem: '', note: '' }); ids.push(id) } return ids },
  saveSettings: (settings: Settings) => { const original = (settings as unknown as { [baseline]?: EntityData })[baseline]; return mutate(Object.entries(settings).filter(([key, value]) => !original || original[key] !== value).map(([key, value]) => patch('setting', key, { value }))) },
  async linkFile(input: LinkInput) { const file_id = await resolveFile(input.path); const id = input.id || crypto.randomUUID(); const data = { assignment_id: input.assignment_id, file_id, role: input.role, page: input.page, chapter: input.chapter, problem: input.problem, note: input.note }; await mutate([patch('link', id, data), history(file_id, input.id ? 'link_updated' : 'linked', { ...data, id })]); return id },
  async linkFilesBatch(input: LinkBatchInput) { for (const path of input.paths) await cloudService.linkFile({ ...input, path, id: '' }); return input.paths.length },
  saveFileLink: (input: FileLink) => mutate([patch('link', input.id, { ...input }, (input as unknown as { [baseline]?: EntityData })[baseline]), history(input.file_id, 'link_updated', input)]),
  async unlinkFile(id: string) { const link = entities('link').find(row => row.id === id) as unknown as FileLink | undefined; await mutate([{ entity_type: 'link', entity_id: id, data: null }, ...(link ? [history(link.file_id, 'unlinked', link)] : [])]) },
  async saveCommonFile(input: { course_id: string; path: string; kind: CommonFile['kind']; label: string }) { const file_id = await resolveFile(input.path); const id = `${input.course_id}:${file_id}`; const existed = entities('common_file').some(row => row.id === id); await mutate([patch('common_file', id, { course_id: input.course_id, file_id, kind: input.kind, label: input.label }), history(file_id, existed ? 'common_updated' : 'common_added')]); return file_id },
  removeCommonFile: (courseId: string, fileId: string) => mutate([{ entity_type: 'common_file', entity_id: `${courseId}:${fileId}`, data: null }, history(fileId, 'common_removed')]),
  async linkModuleFiles(input: { module_id: string; owner_type: string; owner_id: string; owner_label: string; paths: string[]; role: string; note: string }) { let count = 0; for (const path of input.paths) { const file_id = await resolveFile(path); if (entities('module_file_link').some(row => row.module_id === input.module_id && row.owner_id === input.owner_id && row.file_id === file_id)) continue; await mutate([patch('module_file_link', crypto.randomUUID(), { module_id: input.module_id, owner_type: input.owner_type, owner_id: input.owner_id, owner_label: input.owner_label, file_id, role: input.role, note: input.note }), history(file_id, 'module_linked')]); count++ } return count },
  async unlinkModuleFile(id: string) { const link = entities('module_file_link').find(row => row.id === id); await mutate([{ entity_type: 'module_file_link', entity_id: id, data: null }, ...(link ? [history(String(link.file_id), 'module_unlinked')] : [])]) },
  async browseDirectory() { return snapshot().files.map(file => ({ name: file.path.split('/').at(-1) || file.path, path: file.path, is_dir: false })) },
  async searchCourseFiles(_courseId: string, query: string) { return (await cloudService.browseDirectory()).filter(file => file.name.toLowerCase().includes(query.toLowerCase())) },
  pickFiles,
  async openFile(id: string) { const file = entities('file').find(row => row.id === id); if (!file?.cloud_version) throw new Error('此附件只有元数据，尚未上传内容'); const response = await fetch(`/api/files/${encodeURIComponent(id)}/content`, { credentials: 'same-origin' }); if (!response.ok) throw new Error('无法读取附件'); const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = String(file.name || 'attachment'); link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); return { used_module: false, location_applied: false, warning: null } },
  async listModules(builtins: Omit<ModuleDescriptor, 'enabled'>[] = []) { await refresh(); return builtins.map(module => ({ ...module, enabled: entities('module_state').find(row => row.id === module.id)?.enabled !== false })) },
  setModuleEnabled: (id: string, enabled: boolean) => mutate([patch('module_state', id, { enabled })]),
  modulesDirectory: async () => '桌面专属',
  pickDirectory: desktopOnly, pickBackupSave: desktopOnly, pickBackupOpen: desktopOnly, backup: desktopOnly, restore: desktopOnly, compactDatabase: desktopOnly, openFileDirectory: desktopOnly, openModulesDirectory: desktopOnly, relinkFile: desktopOnly, previewRename: desktopOnly, renameFile: desktopOnly, undoRename: desktopOnly, invokeModule: desktopOnly, previewAssignmentImport: desktopOnly, applyAssignmentImport: desktopOnly,
}
