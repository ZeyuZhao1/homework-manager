/** Drive references contain metadata only. OAuth credentials never enter these records. */
export interface DriveFileInfo { id: string; name: string; mime_type: string; resource_key?: string; unavailable?: boolean }
export interface DriveStatus { configured: boolean; connected: boolean; account_name?: string; account_email?: string; needs_reconnect?: boolean }
export interface DriveFlow { flow_id: string; poll_secret: string; authorization_url: string; expires_at: string }
export interface DriveFlowResult { state: 'pending' | 'complete' | 'failed' | 'expired'; files?: DriveFileInfo[]; error?: string }
export type DriveResolveResult = { state: 'ready'; file: DriveFileInfo } | { state: 'selection_required'; file_id: string; resource_key?: string }
export interface DriveRefreshResult { file?: DriveFileInfo; unavailable: boolean }
