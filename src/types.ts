export type Status = 'todo' | 'doing' | 'done' | 'submitted'
export type FileRole = 'prompt' | 'reference' | 'solution'
export type Theme = 'light' | 'dark'

export interface Semester { id: string; name: string; source_root: string }
export interface Course { id: string; semester_id: string; name: string; code: string; folder_path: string }
export interface Assignment {
  id: string
  course_id: string
  title: string
  description: string
  due_at: string | null
  status: Status
  submission_label: string
  submission_url: string
  submission_notes: string
  source_name: string
  source_text: string
  created_at: string
  updated_at: string
  custom_fields: Record<string, string>
}
export interface FileAsset { id: string; path: string; missing: boolean }
export interface CommonFile { course_id: string; file_id: string; kind: 'textbook' | 'extra' | 'other'; label: string }
export interface FileLink { id: string; assignment_id: string; file_id: string; role: FileRole; page: string; chapter: string; problem: string; note: string }
export interface RenameEvent { id: string; file_id: string; old_path: string; new_path: string; changed_at: string; undone_at: string | null }
export interface FileHistoryEvent { id: string; file_id: string; link_id: string; assignment_id: string; assignment_title: string; event_type: 'tracking_started' | 'content_changed' | 'linked' | 'link_updated' | 'unlinked' | 'common_added' | 'common_updated' | 'common_removed' | 'relocated' | 'renamed' | 'rename_undone'; path: string; details: string; file_size: number | null; modified_at_ms: number | null; occurred_at: string }
export interface Settings { theme: Theme; naming_template: string }
export interface Snapshot { semesters: Semester[]; courses: Course[]; assignments: Assignment[]; files: FileAsset[]; links: FileLink[]; common_files: CommonFile[]; renames: RenameEvent[]; file_history: FileHistoryEvent[]; settings: Settings; recent_values: Record<string, string[]> }
export interface LinkInput { id: string; assignment_id: string; path: string; role: FileRole; page: string; chapter: string; problem: string; note: string }
export interface LinkBatchInput { assignment_id: string; paths: string[]; role: FileRole; page: string; chapter: string; problem: string; note: string }
export interface DirectoryEntry { name: string; path: string; is_dir: boolean }
export interface RenamePreview { file_id: string; old_path: string; new_path: string; conflict: boolean; unchanged: boolean }
export interface NamingInput { material: string; sections: string; version: string; scope_kind: 'section' | 'chapter' }
export interface ModuleDescriptor { id: string; name: string; version: string; capabilities: string[]; builtin: boolean; enabled: boolean }

export const statusLabels: Record<Status, string> = { todo: '待做', doing: '进行中', done: '待提交', submitted: '已提交' }
export const roleLabels: Record<FileRole, string> = { prompt: '题目材料', reference: '教材参考', solution: '我的解答' }

export function blankAssignment(courseId = ''): Assignment {
  return { id: '', course_id: courseId, title: '', description: '', due_at: null, status: 'todo', submission_label: '', submission_url: '', submission_notes: '', source_name: '', source_text: '', created_at: '', updated_at: '', custom_fields: {} }
}
