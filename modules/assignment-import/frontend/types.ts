export interface Provider {
  id: string
  name: string
  kind: 'bailian' | 'deepseek' | 'gemini' | 'custom'
  base_url: string
  model: string
  has_key: boolean
}
export interface ProviderInput extends Provider { api_key: string }
export interface ModuleConfig {
  providers: Provider[]
  assignment_provider_id: string
  material_provider_id: string
  prompt_directory: string
}
export interface AiDraft {
  course_name: string
  course_id: string
  title: string
  description: string
  due_at: string | null
  submission_label: string
  submission_url: string
  submission_notes: string
  evidence: string
}
export interface AiResult { assignments: AiDraft[] }
