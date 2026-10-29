import type { ModuleConfig, Provider } from './types'

export const previewKey = 'homeworkbook-assignment-import-preview'
export const emptyConfig: ModuleConfig = { providers: [], assignment_provider_id: '', material_provider_id: '', prompt_directory: '桌面应用的本地提示词目录' }
const string = (value: unknown) => typeof value === 'string' ? value : ''
/** Explicit allowlist: never inspect or copy historical credential fields. */
export function safePreviewConfig(value: unknown): ModuleConfig {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const providers: Provider[] = []
  if (Array.isArray(raw.providers)) for (const item of raw.providers) {
    if (!item || typeof item !== 'object') continue
    const { id, name, kind, base_url, model } = item
    if (!['bailian', 'deepseek', 'gemini', 'custom'].includes(kind)) continue
    providers.push({ id: string(id), name: string(name), kind, base_url: string(base_url), model: string(model), has_key: false })
  }
  return { ...emptyConfig, providers, assignment_provider_id: string(raw.assignment_provider_id), material_provider_id: string(raw.material_provider_id) }
}
export function loadPreviewConfig(storage: Pick<Storage, 'getItem' | 'setItem'>): ModuleConfig {
  let config: ModuleConfig
  try { config = safePreviewConfig(JSON.parse(storage.getItem(previewKey) || '{}')) } catch { config = safePreviewConfig(null) }
  // Replaces historical records with metadata only, without accessing secret field values.
  storage.setItem(previewKey, JSON.stringify(config))
  return config
}
