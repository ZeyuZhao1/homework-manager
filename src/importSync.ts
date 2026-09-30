export interface RemoteCourse { id: string; name: string; code: string; term: string }
export interface RemoteAssignment {
  id: string; course_id: string; title: string; description: string
  due_at: string | null; status: 'unknown' | 'submitted' | 'graded'; url: string
}
export interface RemoteSnapshot {
  protocol: 1; account_key: string; checked_at: string
  courses: RemoteCourse[]; assignments: RemoteAssignment[]; warnings: string[]
}
export interface LocalAssignment {
  title: string; description: string; due_at: string | null; status: string; submission_url: string
}
export interface ImportItem {
  remote: RemoteAssignment; linked_assignment_id: string; suggested_assignment_ids: string[]
  local: LocalAssignment | null; baseline: RemoteAssignment | null
}
export interface ImportPreview {
  courses: Array<{ remote: RemoteCourse; local_course_id: string }>
  items: ImportItem[]
}
export interface CourseChoice { remote_course_id: string; course_id: string; semester_id: string; new_name: string }
export interface ImportDecision {
  remote_course_id: string; remote_assignment_id: string
  action: 'create' | 'link' | 'update' | 'ignore' | 'defer'
  assignment_id: string; fields: string[]
}
export interface ApplyImport {
  module_id: string; snapshot: RemoteSnapshot; courses: CourseChoice[]; decisions: ImportDecision[]
}
