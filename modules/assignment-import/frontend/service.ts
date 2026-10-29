import { invoke, isTauri } from '@tauri-apps/api/core'
import { service } from '../../../src/service'
import { webSync } from '../../../src/sync/web'
import type { AiAnalyzeRequest } from '../../../src/sync/protocol'
import { loadPreviewConfig, previewKey, safePreviewConfig } from './previewConfig'
import type { AiDraft, AiResult, ModuleConfig, ProviderInput } from './types'

function previewConfig(): ModuleConfig {
  try { return loadPreviewConfig(localStorage) } catch { return safePreviewConfig(null) }
}
// Purge old preview credentials as soon as the browser loads this module.
if (!isTauri()) previewConfig()
function persist(config: ModuleConfig) { localStorage.setItem(previewKey, JSON.stringify(safePreviewConfig(config))) }

export const assignmentImportService = {
  get isCloud() { return webSync.isCloud },
  get isDesktop() { return isTauri() },
  async savePastedImage(file: File): Promise<string> {
    if (file.size > 20 * 1024 * 1024) throw new Error('粘贴图片不能超过 20 MB')
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请粘贴 PNG、JPEG 或 WebP 图片')
    if (webSync.isCloud) return webSync.stageFile(file)
    if (!isTauri()) return `preview-pasted/${crypto.randomUUID()}.${file.type.split('/')[1]}`
    return invoke<string>('save_pasted_image', { data: Array.from(new Uint8Array(await file.arrayBuffer())) })
  },
  async config(): Promise<ModuleConfig> {
    if (isTauri()) return invoke<ModuleConfig>('get_config')
    // Also purge legacy preview credentials when entering the online application.
    const preview = previewConfig()
    if (!webSync.isCloud) return preview
    const { credentials } = await webSync.request<{ credentials: Record<string, { has_key: boolean }> }>('/ai/credentials')
    const setting = (id: string) => String(webSync.entities('ai_setting').find(row => row.id === id)?.value || '')
    return { providers: webSync.entities('provider').map(row => ({ id: row.id, name: String(row.name || ''), kind: row.kind as ProviderInput['kind'], base_url: String(row.base_url || ''), model: String(row.model || ''), has_key: credentials[row.id]?.has_key === true })), assignment_provider_id: setting('assignment_provider_id'), material_provider_id: setting('material_provider_id'), prompt_directory: '云端使用应用内置默认提示词' }
  },
  async saveProvider(payload: ProviderInput): Promise<string> {
    if (isTauri()) return invoke<string>('save_provider', { payload })
    const config = previewConfig()
    const id = payload.id || crypto.randomUUID()
    const { name, kind, base_url, model } = payload
    const metadata = { name: name.trim(), kind, base_url: base_url.trim().replace(/\/+$/, ''), model: model.trim() }
    const url = new URL(metadata.base_url)
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('服务地址必须使用 HTTPS，且不能包含凭据、查询参数或片段')
    if (!metadata.name || !metadata.model || !['bailian', 'deepseek', 'gemini', 'custom'].includes(kind)) throw new Error('请完整填写服务商信息')
    if (kind === 'gemini' && !/^[A-Za-z0-9_.-]+$/.test(metadata.model)) throw new Error('Gemini 模型名称无效')
    if (webSync.isCloud) {
      await webSync.mutate([webSync.patch('provider', id, metadata)])
      if (payload.api_key.trim()) await webSync.request(`/ai/providers/${encodeURIComponent(id)}/credential`, { api_key: payload.api_key.trim() }, 'PUT')
      return id
    }
    config.providers = [...config.providers.filter(item => item.id !== id), { ...metadata, id, has_key: false }]
    persist(config)
    return id
  },
  async deleteProvider(id: string): Promise<void> {
    if (isTauri()) return invoke<void>('delete_provider', { id })
    if (webSync.isCloud) {
      await assignmentImportService.removeCloudKey(id)
      const config = await assignmentImportService.config()
      await webSync.mutate([
        { entity_type: 'provider', entity_id: id, data: null },
        ...(config.assignment_provider_id === id ? [webSync.patch('ai_setting', 'assignment_provider_id', { value: '' })] : []),
        ...(config.material_provider_id === id ? [webSync.patch('ai_setting', 'material_provider_id', { value: '' })] : []),
      ])
      return
    }
    const config = previewConfig()
    config.providers = config.providers.filter(item => item.id !== id)
    if (config.assignment_provider_id === id) config.assignment_provider_id = ''
    if (config.material_provider_id === id) config.material_provider_id = ''
    persist(config)
  },
  async removeCloudKey(id: string): Promise<void> {
    if (!webSync.isCloud) throw new Error('此操作仅用于网页云端密钥')
    await webSync.request(`/ai/providers/${encodeURIComponent(id)}/credential`, undefined, 'DELETE')
  },
  async saveRouting(assignment_provider_id: string, material_provider_id: string): Promise<void> {
    if (isTauri()) return invoke<void>('save_routing', { payload: { assignment_provider_id, material_provider_id } })
    if (webSync.isCloud) { await webSync.mutate([webSync.patch('ai_setting', 'assignment_provider_id', { value: assignment_provider_id }), webSync.patch('ai_setting', 'material_provider_id', { value: material_provider_id })]); return }
    persist({ ...previewConfig(), assignment_provider_id, material_provider_id })
  },
  async openPromptDirectory(): Promise<void> { if (isTauri()) return invoke<void>('open_prompt_directory') },
  async analyze(text: string, paths: string[], moduleId: string): Promise<AiResult> {
    if (isTauri()) return service.invokeModule<AiResult>(moduleId, 'assignment.extract', { text, paths })
    if (webSync.isCloud) {
      if (moduleId !== 'builtin.ai.assignment-import') throw new Error('网页仅支持内置 AI 识别模块')
      const file_ids = await webSync.prepareAiFiles(paths)
      const payload: AiAnalyzeRequest = { text, file_ids, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai' }
      return webSync.request<AiResult>('/ai/analyze', payload)
    }
    return { assignments: [{ course_name: 'Calculus', course_id: 'preview-course-1', title: text.match(/(?:作业|Problem Set)[^\n。]*/)?.[0] || '示例导入作业', description: text.slice(0, 150), due_at: null, submission_label: '', submission_url: '', submission_notes: '', evidence: '浏览器预览示例' }] }
  },
  async saveDrafts(drafts: AiDraft[], paths: string[], sourceName: string, sourceText: string): Promise<string[]> {
    const assignments = drafts.map(draft => ({ id: '', course_id: draft.course_id, title: draft.title, description: draft.description, due_at: draft.due_at, status: 'todo' as const, submission_label: draft.submission_label, submission_url: draft.submission_url, submission_notes: draft.submission_notes, source_name: sourceName, source_text: sourceText, created_at: '', updated_at: '', custom_fields: {} }))
    return service.saveAssignmentsBatch(assignments, paths, 'prompt')
  },
}
