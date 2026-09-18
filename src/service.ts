import { invoke, isTauri } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { AiDraft, AiResult, Assignment, CommonFile, Course, DirectoryEntry, FileLink, LinkBatchInput, LinkInput, ModuleDescriptor, NamingInput, ProviderInput, RenamePreview, Semester, Settings, Snapshot } from './types'

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
  common_files: [], renames: [], providers: [], settings: { theme: 'light', naming_template: '{course_code}-{material}-hw-{scope}', assignment_provider_id: '', material_provider_id: '' }, recent_values: {},
}

try { const saved = localStorage.getItem('homeworkbook-preview'); if (saved) previewState = JSON.parse(saved) as Snapshot; previewState.recent_values ||= {}; previewState.common_files ||= []; previewState.assignments.forEach(a => { a.custom_fields ||= {} }); if (['{course}-{assignment}-{role}-v{version}','{course_code}-{material}-hw-{sections}'].includes(previewState.settings.naming_template)) previewState.settings.naming_template = '{course_code}-{material}-hw-{scope}' } catch { /* preview data is disposable */ }
function persist() { localStorage.setItem('homeworkbook-preview', JSON.stringify(previewState)) }
function clone(): Snapshot { return structuredClone(previewState) }
function newId() { return crypto.randomUUID() }

export const service = {
  isDesktop: desktop,
  async snapshot(): Promise<Snapshot> { return desktop ? invoke<Snapshot>('load_snapshot') : clone() },
  async saveSemester(payload: Semester) {
    if (desktop) return invoke<string>('save_semester', { payload })
    const id = payload.id || newId(); previewState.semesters = [...previewState.semesters.filter(x => x.id !== id), { ...payload, id }]; persist(); return id
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
  async deleteAssignment(id: string) {
    if (desktop) return invoke<void>('delete_assignment', { id })
    previewState.assignments = previewState.assignments.filter(x => x.id !== id); previewState.links = previewState.links.filter(x => x.assignment_id !== id); persist()
  },
  async saveSettings(payload: Settings) {
    if (desktop) return invoke<void>('save_settings', { payload })
    previewState.settings = payload; persist()
  },
  async saveProvider(payload: ProviderInput) {
    if (desktop) return invoke<string>('save_provider', { payload })
    const id = payload.id || newId(); previewState.providers = [...previewState.providers.filter(x => x.id !== id), { ...payload, id, has_key: !!payload.api_key || payload.has_key }]; persist(); return id
  },
  async deleteProvider(id: string) {
    if (desktop) return invoke<void>('delete_provider', { id })
    previewState.providers = previewState.providers.filter(x => x.id !== id); persist()
  },
  async linkFile(payload: LinkInput) {
    if (desktop) return invoke<string>('link_file', { payload })
    let file = previewState.files.find(x => x.path === payload.path)
    if (!file) { file = { id: newId(), path: payload.path, missing: false }; previewState.files.push(file) }
    const id = payload.id || newId(); previewState.links = [...previewState.links.filter(x => x.id !== id), { ...payload, id, file_id: file.id }]; persist(); return id
  },
  async linkFilesBatch(payload: LinkBatchInput): Promise<number> {
    if (desktop) return invoke<number>('link_files_batch', { payload })
    let created = 0
    for (const path of [...new Set(payload.paths)]) { await this.linkFile({ ...payload, id: '', path }); created++ }
    return created
  },
  async saveFileLink(payload: FileLink) {
    if (desktop) return invoke<void>('save_file_link', { payload })
    previewState.links = previewState.links.map(x => x.id === payload.id ? payload : x); persist()
  },
  async unlinkFile(id: string) {
    if (desktop) return invoke<void>('unlink_file', { id })
    previewState.links = previewState.links.filter(x => x.id !== id); persist()
  },
  async saveCommonFile(payload: { course_id: string; path: string; kind: CommonFile['kind']; label: string }) {
    if (desktop) return invoke<string>('save_common_file', { payload })
    let file = previewState.files.find(x => x.path === payload.path)
    if (!file) { file = { id: newId(), path: payload.path, missing: false }; previewState.files.push(file) }
    previewState.common_files = [...previewState.common_files.filter(x => x.course_id !== payload.course_id || x.file_id !== file.id), { course_id:payload.course_id, file_id:file.id, kind:payload.kind, label:payload.label || file.path.split(/[\\/]/).at(-1) || file.path }]; persist(); return file.id
  },
  async removeCommonFile(courseId: string, fileId: string) {
    if (desktop) return invoke<void>('remove_common_file', { courseId, fileId })
    previewState.common_files = previewState.common_files.filter(x => x.course_id !== courseId || x.file_id !== fileId); persist()
  },
  async relinkFile(fileId: string, path: string) {
    if (desktop) return invoke<void>('relink_file', { fileId, path })
    previewState.files = previewState.files.map(x => x.id === fileId ? { ...x, path, missing: false } : x); persist()
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
    const p = await this.previewRename(linkId, naming); const id = newId(); previewState.files = previewState.files.map(x => x.id === p.file_id ? { ...x, path: p.new_path } : x); previewState.renames.unshift({ id, file_id: p.file_id, old_path: p.old_path, new_path: p.new_path, changed_at: new Date().toISOString(), undone_at: null }); persist(); return id
  },
  async undoRename(id: string) {
    if (desktop) return invoke<void>('undo_rename', { id })
    const event = previewState.renames.find(x => x.id === id); if (!event) return
    previewState.files = previewState.files.map(x => x.id === event.file_id ? { ...x, path: event.old_path } : x); event.undone_at = new Date().toISOString(); persist()
  },
  async analyzeAssignment(text: string, paths: string[], moduleId = 'builtin.ai.assignment-import'): Promise<AiResult> {
    if (desktop) return invoke<AiResult>('invoke_module', { moduleId, capability: 'assignment.extract', input: { text, paths } })
    return { assignments: [{ course_name: 'Calculus', course_id: previewCourses[1].id, title: text.match(/(?:作业|Problem Set)[^\n。]*/)?.[0] || '示例导入作业', description: text.slice(0, 150), due_at: null, submission_label: '', submission_url: '', submission_notes: '', evidence: '浏览器预览示例；桌面版调用已配置的云端模型。' }] }
  },
  async saveImportDrafts(drafts: AiDraft[], paths: string[], sourceName: string, sourceText: string): Promise<string[]> {
    if (desktop) return invoke<string[]>('save_import_drafts', { payload: { drafts, paths, source_name: sourceName, source_text: sourceText } })
    const ids: string[] = []
    for (const draft of drafts) {
      const id = await this.saveAssignment({ id: '', course_id: draft.course_id, title: draft.title, description: draft.description, due_at: draft.due_at, status: 'todo', submission_label: draft.submission_label, submission_url: draft.submission_url, submission_notes: draft.submission_notes, source_name: sourceName, source_text: sourceText, created_at: '', updated_at: '', custom_fields: {} })
      for (const path of paths) await this.linkFile({ id: '', assignment_id: id, path, role: 'prompt', page: '', chapter: '', problem: '', note: 'AI 导入时关联' })
      ids.push(id)
    }
    return ids
  },
  async pickFiles(defaultPath?: string): Promise<string[]> { if (!desktop) return []; const picked = await open({ multiple: true, directory: false, defaultPath }); return picked ? (Array.isArray(picked) ? picked : [picked]) : [] },
  async pickDirectory(): Promise<string | null> { if (!desktop) return null; const picked = await open({ directory: true, multiple: false }); return typeof picked === 'string' ? picked : null },
  async pickBackupSave(): Promise<string | null> { if (!desktop) return null; return save({ defaultPath: 'homework-backup.db', filters: [{ name: 'SQLite 数据库', extensions: ['db'] }] }) },
  async pickBackupOpen(): Promise<string | null> { if (!desktop) return null; const picked = await open({ multiple: false, filters: [{ name: 'SQLite 数据库', extensions: ['db'] }] }); return typeof picked === 'string' ? picked : null },
  async backup(path: string) { if (desktop) return invoke<void>('backup_database', { path }) },
  async restore(path: string) { if (desktop) return invoke<void>('restore_database', { path }) },
  async compactDatabase() { if (desktop) return invoke<void>('compact_database') },
  async openFile(fileId: string) { if (desktop) return invoke<void>('open_file', { fileId }) },
  async promptDirectory(): Promise<string> { return desktop ? invoke<string>('prompt_directory') : '%APPDATA%\\app.homeworkbook.local\\prompts' },
  async openPromptDirectory() { if (desktop) return invoke<void>('open_prompt_directory') },
  async invokeModule<T>(moduleId: string, capability: string, input: unknown): Promise<T> { if (!desktop) throw new Error('浏览器预览不运行本地模块'); return invoke<T>('invoke_module', { moduleId, capability, input }) },
  async listModules(): Promise<ModuleDescriptor[]> { return desktop ? invoke<ModuleDescriptor[]>('list_modules') : [{ id:'builtin.ai.assignment-import', name:'AI 作业识别', version:'preview', capabilities:['assignment.extract'], builtin:true }] },
  async modulesDirectory(): Promise<string> { return desktop ? invoke<string>('modules_directory') : '%APPDATA%\\app.homeworkbook.local\\modules' },
  async openModulesDirectory() { if (desktop) return invoke<void>('open_modules_directory') },
  async openUrl(url: string) { if (desktop) return openUrl(url); window.open(url, '_blank', 'noopener,noreferrer') },
}
