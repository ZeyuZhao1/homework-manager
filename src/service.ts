import { invoke, isTauri } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { Assignment, CommonFile, Course, DirectoryEntry, FileHistoryEvent, FileLink, FileRole, LinkBatchInput, LinkInput, ModuleDescriptor, NamingInput, RenamePreview, Semester, Settings, Snapshot } from './types'

const desktop = isTauri()
const root = 'D:\\share\\University\\Year 1 Fall'
const semesterId = 'preview-semester'
const previewCourses: Course[] = ['思政', 'Calculus', 'Earth Science', 'Linear Algebra', 'Physics'].map((name, index) => ({ id: `preview-course-${index}`, semester_id: semesterId, name, code: ['', 'MA117', '', 'MA113', 'PHY105'][index], folder_path: `${root}\\${name}` }))
const previewAssignments: Assignment[] = [
  { id: 'sample-1', course_id: previewCourses[1].id, title: '第 3 次作业：微分方程', description: '完成指定习题并上传 PDF。', due_at: '2026-09-20T23:59:00', status: 'doing', submission_label: 'Moodle', submission_url: 'https://moodle.example.edu', submission_notes: '按课程要求提交 PDF。', source_name: '课程平台', source_text: '', created_at: '', updated_at: '', custom_fields: {} },
  { id: 'sample-2', course_id: previewCourses[1].id, title: '第 4 次作业：多元函数', description: '教材第 84 页第 3–6 题', due_at: '2026-09-27T23:59:00', status: 'todo', submission_label: '课程平台', submission_url: '', submission_notes: '', source_name: '', source_text: '', created_at: '', updated_at: '', custom_fields: {} },
  { id: 'sample-3', course_id: previewCourses[1].id, title: '习题课练习 2', description: '', due_at: '2026-09-18T18:00:00', status: 'done', submission_label: '邮件', submission_url: '', submission_notes: '', source_name: '', source_text: '', created_at: '', updated_at: '', custom_fields: {} },
]
let previewState: Snapshot = {
  semesters: [{ id: semesterId, name: '2026 秋季', source_root: root }], courses: previewCourses, assignments: previewAssignments,
  files: [
    { id: 'sample-file-1', path: `${root}\\Calculus\\03-problems\\homework\\calextra 2026 Fall.pdf`, missing: false },
    { id: 'sample-file-2', path: `${root}\\Calculus\\03-problems\\solutions\\MA117-Textbook-Homework-1.pdf`, missing: false },
  ],
  links: [
    { id: 'sample-link-1', assignment_id: 'sample-1', file_id: 'sample-file-1', role: 'prompt', page: '', chapter: '', problem: '', note: '' },
    { id: 'sample-link-2', assignment_id: 'sample-1', file_id: 'sample-file-2', role: 'solution', page: '', chapter: '', problem: '', note: '' },
  ],
  common_files: [], renames: [], file_history: [], settings: { theme: 'light', naming_template: '{course_code}-{material}-hw-{scope}' }, recent_values: {},
}

try { const saved = localStorage.getItem('homeworkbook-preview'); if (saved) previewState = JSON.parse(saved) as Snapshot; previewState.recent_values ||= {}; previewState.common_files ||= []; previewState.file_history ||= []; previewState.assignments.forEach(a => { a.custom_fields ||= {} }); if (['{course}-{assignment}-{role}-v{version}','{course_code}-{material}-hw-{sections}'].includes(previewState.settings.naming_template)) previewState.settings.naming_template = '{course_code}-{material}-hw-{scope}' } catch { /* preview data is disposable */ }
function persist() { localStorage.setItem('homeworkbook-preview', JSON.stringify(previewState)) }
function clone(): Snapshot { return structuredClone(previewState) }
function newId() { return crypto.randomUUID() }
let previewModuleEnabled = localStorage.getItem('homeworkbook-preview-module-assignment-import') !== 'false'
function trackPreview(fileId: string, eventType: FileHistoryEvent['event_type'], path: string, link?: Partial<FileLink>, details = '') {
  previewState.file_history.unshift({ id:newId(), file_id:fileId, link_id:link?.id || '', assignment_id:link?.assignment_id || '', assignment_title:previewState.assignments.find(a => a.id === link?.assignment_id)?.title || '', event_type:eventType, path, details, file_size:null, modified_at_ms:null, occurred_at:new Date().toISOString() })
}

export const service = {
  isDesktop: desktop,
  async snapshot(): Promise<Snapshot> { return desktop ? invoke<Snapshot>('load_snapshot') : clone() },
  async saveSemester(payload: Semester) {
    if (desktop) return invoke<string>('save_semester', { payload })
    const id = payload.id || newId(); previewState.semesters = [...previewState.semesters.filter(x => x.id !== id), { ...payload, id }]; persist(); return id
  },
  async deleteSemester(id: string) {
    if (desktop) return invoke<void>('delete_semester', { id })
    if (previewState.semesters.length <= 1) throw new Error('至少需要保留一个学期')
    const courseIds = new Set(previewState.courses.filter(c => c.semester_id === id).map(c => c.id))
    const assignmentIds = new Set(previewState.assignments.filter(a => courseIds.has(a.course_id)).map(a => a.id))
    previewState.links.filter(link => assignmentIds.has(link.assignment_id)).forEach(link => { const file = previewState.files.find(f => f.id === link.file_id); if (file) trackPreview(file.id,'unlinked',file.path,link,'因删除学期移除关联') })
    previewState.common_files.filter(item => courseIds.has(item.course_id)).forEach(item => { const file = previewState.files.find(f => f.id === item.file_id); if (file) trackPreview(file.id,'common_removed',file.path,undefined,`删除学期时取消常用文件：${item.label}`) })
    previewState.semesters = previewState.semesters.filter(s => s.id !== id)
    previewState.courses = previewState.courses.filter(c => !courseIds.has(c.id))
    previewState.assignments = previewState.assignments.filter(a => !assignmentIds.has(a.id))
    previewState.links = previewState.links.filter(link => !assignmentIds.has(link.assignment_id))
    previewState.common_files = previewState.common_files.filter(item => !courseIds.has(item.course_id))
    persist()
  },
  async saveCourse(payload: Course) {
    if (desktop) return invoke<string>('save_course', { payload })
    const id = payload.id || newId(); previewState.courses = [...previewState.courses.filter(x => x.id !== id), { ...payload, id }]; persist(); return id
  },
  async saveAssignment(payload: Assignment) {
    if (desktop) return invoke<string>('save_assignment', { payload })
    const id = payload.id || newId(); previewState.assignments = [...previewState.assignments.filter(x => x.id !== id), { ...payload, id }]
    for (const field of ['title', 'submission_label', 'submission_url', 'submission_notes'] as const) { const value = payload[field].trim(); if (value) previewState.recent_values[field] = [value, ...(previewState.recent_values[field] || []).filter(v => v !== value)].slice(0, 12) }
    persist(); return id
  },
  async saveAssignmentsBatch(assignments: Assignment[], paths: string[], fileRole: FileRole): Promise<string[]> {
    if (desktop) return invoke<string[]>('save_assignments_batch', { payload: { assignments, paths, file_role: fileRole } })
    const ids: string[] = []
    for (const assignment of assignments) {
      const id = await this.saveAssignment(assignment)
      for (const path of paths) await this.linkFile({ id: '', assignment_id: id, path, role: fileRole, page: '', chapter: '', problem: '', note: '' })
      ids.push(id)
    }
    return ids
  },
  async deleteAssignment(id: string) {
    if (desktop) return invoke<void>('delete_assignment', { id })
    previewState.links.filter(link => link.assignment_id === id).forEach(link => { const file = previewState.files.find(f => f.id === link.file_id); if (file) trackPreview(file.id,'unlinked',file.path,link,'因删除作业移除关联') })
    previewState.assignments = previewState.assignments.filter(x => x.id !== id); previewState.links = previewState.links.filter(x => x.assignment_id !== id); persist()
  },
  async saveSettings(payload: Settings) {
    if (desktop) return invoke<void>('save_settings', { payload })
    previewState.settings = payload; persist()
  },
  async linkFile(payload: LinkInput) {
    if (desktop) return invoke<string>('link_file', { payload })
    let file = previewState.files.find(x => x.path === payload.path)
    if (!file) { file = { id: newId(), path: payload.path, missing: false }; previewState.files.push(file) }
    const existed = previewState.links.some(x => x.id === payload.id); const id = payload.id || newId(); const link = { ...payload, id, file_id: file.id }; previewState.links = [...previewState.links.filter(x => x.id !== id), link]; trackPreview(file.id,existed ? 'link_updated' : 'linked',file.path,link,`角色：${payload.role}`); persist(); return id
  },
  async linkFilesBatch(payload: LinkBatchInput): Promise<number> {
    if (desktop) return invoke<number>('link_files_batch', { payload })
    let created = 0
    for (const path of [...new Set(payload.paths)]) { await this.linkFile({ ...payload, id: '', path }); created++ }
    return created
  },
  async saveFileLink(payload: FileLink) {
    if (desktop) return invoke<void>('save_file_link', { payload })
    previewState.links = previewState.links.map(x => x.id === payload.id ? payload : x); const file = previewState.files.find(x => x.id === payload.file_id); if (file) trackPreview(file.id,'link_updated',file.path,payload,`角色：${payload.role}`); persist()
  },
  async unlinkFile(id: string) {
    if (desktop) return invoke<void>('unlink_file', { id })
    const link = previewState.links.find(x => x.id === id); const file = previewState.files.find(x => x.id === link?.file_id); if (link && file) trackPreview(file.id,'unlinked',file.path,link,`角色：${link.role}`); previewState.links = previewState.links.filter(x => x.id !== id); persist()
  },
  async saveCommonFile(payload: { course_id: string; path: string; kind: CommonFile['kind']; label: string }) {
    if (desktop) return invoke<string>('save_common_file', { payload })
    let file = previewState.files.find(x => x.path === payload.path)
    if (!file) { file = { id: newId(), path: payload.path, missing: false }; previewState.files.push(file) }
    const existed = previewState.common_files.some(x => x.course_id === payload.course_id && x.file_id === file.id); const label = payload.label || file.path.split(/[\\/]/).at(-1) || file.path; previewState.common_files = [...previewState.common_files.filter(x => x.course_id !== payload.course_id || x.file_id !== file.id), { course_id:payload.course_id, file_id:file.id, kind:payload.kind, label }]; trackPreview(file.id,existed ? 'common_updated' : 'common_added',file.path,undefined,`常用文件：${label}`); persist(); return file.id
  },
  async removeCommonFile(courseId: string, fileId: string) {
    if (desktop) return invoke<void>('remove_common_file', { courseId, fileId })
    const item = previewState.common_files.find(x => x.course_id === courseId && x.file_id === fileId); const file = previewState.files.find(x => x.id === fileId); if (item && file) trackPreview(file.id,'common_removed',file.path,undefined,`取消常用文件：${item.label}`); previewState.common_files = previewState.common_files.filter(x => x.course_id !== courseId || x.file_id !== fileId); persist()
  },
  async relinkFile(fileId: string, path: string) {
    if (desktop) return invoke<void>('relink_file', { fileId, path })
    const oldPath = previewState.files.find(x => x.id === fileId)?.path || ''; previewState.files = previewState.files.map(x => x.id === fileId ? { ...x, path, missing: false } : x); trackPreview(fileId,'relocated',path,undefined,`原路径：${oldPath}`); persist()
  },
  async browseDirectory(courseId: string, relativePath: string): Promise<DirectoryEntry[]> {
    if (desktop) return invoke<DirectoryEntry[]>('browse_directory', { courseId, relativePath })
    return relativePath ? [] : [{ name: '01-sources', path: `${root}\\Calculus\\01-sources`, is_dir: true }, { name: '03-problems', path: `${root}\\Calculus\\03-problems`, is_dir: true }, ...previewState.files.map(f => ({ name: f.path.split('\\').at(-1) || f.path, path: f.path, is_dir: false }))]
  },
  async searchCourseFiles(courseId: string, query: string): Promise<DirectoryEntry[]> {
    if (desktop) return invoke<DirectoryEntry[]>('search_course_files', { courseId, query })
    return previewState.files.filter(f => f.path.toLowerCase().includes(query.toLowerCase())).map(f => ({ name: f.path.split('\\').at(-1) || f.path, path: f.path, is_dir: false }))
  },
  async previewRename(linkId: string, naming: NamingInput): Promise<RenamePreview> {
    if (desktop) return invoke<RenamePreview>('preview_rename', { linkId, naming })
    const link = previewState.links.find(x => x.id === linkId)!
    const file = previewState.files.find(x => x.id === link.file_id)!
    const assignment = previewState.assignments.find(x => x.id === link.assignment_id)!
    const course = previewState.courses.find(x => x.id === assignment.course_id)!
    const extension = file.path.match(/\.[^.\\]+$/)?.[0] || ''
    const sections = naming.sections || link.chapter
    if (['{sections}','{scope}'].some(token => previewState.settings.naming_template.includes(token)) && !sections) throw new Error('请填写章节或节标识')
    const prefix = naming.scope_kind === 'chapter' ? 'ch' : 's'
    const scope = sections.startsWith(prefix) ? sections : `${prefix}${sections.replace(/^(ch|s)/,'')}`
    const newPath = file.path.slice(0, file.path.lastIndexOf('\\') + 1) + `${course.code || course.name}-${naming.material || (file.path.toLowerCase().includes('extra') ? 'extra' : link.role === 'reference' ? 'textbook' : link.role === 'solution' ? 'solution' : 'assignment')}-hw-${scope}${extension}`
    return { file_id: file.id, old_path: file.path, new_path: newPath, conflict: false, unchanged: newPath === file.path }
  },
  async renameFile(linkId: string, naming: NamingInput) {
    if (desktop) return invoke<string>('rename_file', { linkId, naming })
    const p = await this.previewRename(linkId, naming); const id = newId(); const link = previewState.links.find(x => x.id === linkId); previewState.files = previewState.files.map(x => x.id === p.file_id ? { ...x, path: p.new_path } : x); previewState.renames.unshift({ id, file_id: p.file_id, old_path: p.old_path, new_path: p.new_path, changed_at: new Date().toISOString(), undone_at: null }); trackPreview(p.file_id,'renamed',p.new_path,link,`原路径：${p.old_path}`); persist(); return id
  },
  async undoRename(id: string) {
    if (desktop) return invoke<void>('undo_rename', { id })
    const event = previewState.renames.find(x => x.id === id); if (!event) return
    previewState.files = previewState.files.map(x => x.id === event.file_id ? { ...x, path: event.old_path } : x); event.undone_at = new Date().toISOString(); trackPreview(event.file_id,'rename_undone',event.old_path,undefined,`撤回名称：${event.new_path}`); persist()
  },
  async pickFiles(defaultPath?: string): Promise<string[]> { if (!desktop) return []; const picked = await open({ multiple: true, directory: false, defaultPath }); return picked ? (Array.isArray(picked) ? picked : [picked]) : [] },
  async pickDirectory(): Promise<string | null> { if (!desktop) return null; const picked = await open({ directory: true, multiple: false }); return typeof picked === 'string' ? picked : null },
  async pickBackupSave(): Promise<string | null> { if (!desktop) return null; return save({ defaultPath: 'homework-backup.db', filters: [{ name: 'SQLite 数据库', extensions: ['db'] }] }) },
  async pickBackupOpen(): Promise<string | null> { if (!desktop) return null; const picked = await open({ multiple: false, filters: [{ name: 'SQLite 数据库', extensions: ['db'] }] }); return typeof picked === 'string' ? picked : null },
  async backup(path: string) { if (desktop) return invoke<void>('backup_database', { path }) },
  async restore(path: string) { if (desktop) return invoke<void>('restore_database', { path }) },
  async compactDatabase() { if (desktop) return invoke<void>('compact_database') },
  async openFile(fileId: string) { if (desktop) return invoke<void>('open_file', { fileId }) },
  async invokeModule<T>(moduleId: string, capability: string, input: unknown): Promise<T> { if (!desktop) throw new Error('浏览器预览不运行本地模块'); return invoke<T>('invoke_module', { moduleId, capability, input }) },
  async listModules(): Promise<ModuleDescriptor[]> { return desktop ? invoke<ModuleDescriptor[]>('list_modules') : [{ id:'builtin.ai.assignment-import', name:'AI 作业导入', version:'0.4.0', capabilities:['assignment.extract'], builtin:true, enabled:previewModuleEnabled }] },
  async setModuleEnabled(moduleId: string, enabled: boolean) { if (desktop) return invoke<void>('set_module_enabled', { moduleId, enabled }); if (moduleId === 'builtin.ai.assignment-import') { previewModuleEnabled = enabled; localStorage.setItem('homeworkbook-preview-module-assignment-import', String(enabled)) } },
  async modulesDirectory(): Promise<string> { return desktop ? invoke<string>('modules_directory') : '%APPDATA%\\app.homeworkbook.local\\modules' },
  async openModulesDirectory() { if (desktop) return invoke<void>('open_modules_directory') },
  async openUrl(url: string) { if (desktop) return openUrl(url); window.open(url, '_blank', 'noopener,noreferrer') },
}
