import type { ComponentType } from 'react'
import type { Assignment, ModuleDescriptor, Snapshot } from './types'

export interface AssignmentGroup {
  id: string
  module_id: string
  course_id: string
  title: string
  subtitle: string
  status: string
  next_at: string | null
  assignment_ids: string[]
  completed: number
  active: number
  planned: number
  skipped: number
  search_text: string
}

export interface AssignmentListExtension {
  loadGroups: (snapshot: Snapshot) => Promise<AssignmentGroup[]>
  Row: ComponentType<{ group: AssignmentGroup; selected: boolean; courseName: string; fileCount: number; onSelect: () => void }>
  Detail: ComponentType<{ group: AssignmentGroup; snapshot: Snapshot; onRefresh: () => Promise<void>; onEditAssignment: (assignment: Assignment) => void }>
  AssignmentAddon?: ComponentType<{ assignment: Assignment; snapshot: Snapshot }>
}

export interface AppModule {
  id: string
  descriptor: Omit<ModuleDescriptor, 'enabled'>
  savedMessage: string
  Action: ComponentType<{ onOpen: () => void }>
  Overlay: ComponentType<{ snapshot: Snapshot; onClose: () => void; onSettings: () => void; onSaved: () => Promise<void> }>
  SettingsCard: ComponentType<{ enabled: boolean; snapshot: Snapshot; onToggle: (enabled: boolean) => void }>
  assignmentList?: AssignmentListExtension
}
