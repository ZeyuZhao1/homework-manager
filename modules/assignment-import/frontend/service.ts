import { invoke, isTauri } from '@tauri-apps/api/core'
import { service } from '../../../src/service'
import type { AiDraft, AiResult, ModuleConfig, ProviderInput } from './types'

const previewKey = 'homeworkbook-assignment-import-preview'
const emptyConfig: ModuleConfig = { providers: [], assignment_provider_id: '', material_provider_id: '', prompt_directory: '%APPDATA%\\app.homeworkbook.local\\modules\\assignment-import\\prompts' }
function previewConfig(): ModuleConfig {
  try { return { ...emptyConfig, ...JSON.parse(localStorage.getItem(previewKey) || '{}') } } catch { return { ...emptyConfig } }
}
function persist(config: ModuleConfig) { localStorage.setItem(previewKey, JSON.stringify(config)) }

export const assignmentImportService = {
  async config(): Promise<ModuleConfig> { return isTauri() ? invoke<ModuleConfig>('get_config') : previewConfig() },
  async saveProvider(payload: ProviderInput): Promise<string> {
    if (isTauri()) return invoke<string>('save_provider', { payload })
    const config = previewConfig()
    const id = payload.id || crypto.randomUUID()
    config.providers = [...config.providers.filter(item => item.id !== id), { ...payload, id, has_key: !!payload.api_key || payload.has_key }]
    persist(config)
    return id
  },
  async deleteProvider(id: string): Promise<void> {
    if (isTauri()) return invoke<void>('delete_provider', { id })
    const config = previewConfig()
    config.providers = config.providers.filter(item => item.id !== id)
    if (config.assignment_provider_id === id) config.assignment_provider_id = ''
    if (config.material_provider_id === id) config.material_provider_id = ''
    persist(config)
  },
  async saveRouting(assignment_provider_id: string, material_provider_id: string): Promise<void> {
    if (isTauri()) return invoke<void>('save_routing', { payload: { assignment_provider_id, material_provider_id } })
    persist({ ...previewConfig(), assignment_provider_id, material_provider_id })
  },
  async openPromptDirectory(): Promise<void> { if (isTauri()) return invoke<void>('open_prompt_directory') },
  async analyze(text: string, paths: string[], moduleId: string): Promise<AiResult> {
    if (isTauri()) return service.invokeModule<AiResult>(moduleId, 'assignment.extract', { text, paths })
    return { assignments: [{ course_name: 'Calculus', course_id: 'preview-course-1', title: text.match(/(?:作业|Problem Set)[^\n。]*/)?.[0] || '示例导入作业', description: text.slice(0, 150), due_at: null, submission_label: '', submission_url: '', submission_notes: '', evidence: '浏览器预览示例' }] }
  },
  async saveDrafts(drafts: AiDraft[], paths: string[], sourceName: string, sourceText: string): Promise<string[]> {
    const assignments = drafts.map(draft => ({ id: '', course_id: draft.course_id, title: draft.title, description: draft.description, due_at: draft.due_at, status: 'todo' as const, submission_label: draft.submission_label, submission_url: draft.submission_url, submission_notes: draft.submission_notes, source_name: sourceName, source_text: sourceText, created_at: '', updated_at: '', custom_fields: {} }))
    return service.saveAssignmentsBatch(assignments, paths, 'prompt')
  },
}
