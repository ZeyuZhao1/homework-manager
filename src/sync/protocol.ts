/** Public, infrastructure-independent synchronization wire contract. */
export const entityTypes = [
  'semester', 'course', 'assignment', 'file', 'link', 'common_file',
  'module_file_link', 'setting', 'module_state', 'provider', 'ai_setting',
  'recurring_series', 'recurring_occurrence', 'calendar', 'history',
  'import_course_map', 'import_link', 'import_ignored',
] as const

export type EntityType = typeof entityTypes[number]
export type EntityData = Record<string, unknown>
export interface SyncMutation {
  entity_type: EntityType
  entity_id: string
  /** Changed fields only; null is a deletion, never an implicit restore. */
  data: EntityData | null
}
export interface SyncOperation {
  operation_id: string
  changes: SyncMutation[]
}
export interface SyncEntity extends SyncMutation {
  seq: number
}
export interface SyncRequest {
  cursor: number
  operations: SyncOperation[]
  limit?: number
  /** Pause cloud generation while an existing desktop baseline is imported. */
  baseline?: 'begin' | 'complete'
}
export interface SyncResponse {
  cursor: number
  changes: SyncEntity[]
  acknowledged: string[]
  has_more: boolean
  server_time: string
}
export interface CloudSnapshot {
  cursor: number
  entities: SyncEntity[]
  server_time: string
  pending_baselines?: { device_id: string; name: string; started_at: string }[]
}
export interface SyncDevice {
  id: string
  name: string
  client_type: 'desktop' | 'web'
  created_at: string
  last_seen_at: string
  current?: boolean
}
export interface PairRequest {
  pair_id: string
  poll_secret: string
  code: string
  expires_at: string
}
export interface PairResult {
  state: 'pending' | 'approved' | 'expired'
  token?: string
  device?: SyncDevice
}
export interface SyncStatus {
  enabled: boolean
  server_url: string
  device_id: string
  device_name: string
  connected: boolean
  pending: number
  cursor: number
  last_synced_at: string | null
  error: string | null
}

export const syncLimits = {
  maxOperations: 100,
  maxChanges: 500,
  pageSize: 500,
  maxFileBytes: 20 * 1024 * 1024,
  maxBodyBytes: 2 * 1024 * 1024,
} as const

/** AI returns suggestions only; callers must review before saving assignments. */
export interface AiAnalyzeRequest {
  text: string
  file_ids?: string[]
  /** IANA timezone for relative dates; defaults to Asia/Shanghai. */
  timezone?: string
}
