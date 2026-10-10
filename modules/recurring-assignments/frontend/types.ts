import type { AssignmentGroup } from '../../../src/moduleTypes'

export interface SeriesSummary { id:string; course_id:string; name:string; title_template:string; status:string; rule_label:string; due_label:string; range_label:string; total:number; completed:number; active:number; planned:number; skipped:number; next_at:string|null; assignment_ids:string[]; pending_catch_up:number }
export interface Occurrence { id:string; series_id:string; sequence_no:number; scheduled_at:string|null; due_at:string|null; state:string; assignment_id:string|null; assignment_status:string|null; assignment_title:string|null; overridden:boolean }
export interface SeriesInput { id:string; course_id:string; name:string; title_template:string; description:string; submission_label:string; submission_url:string; submission_notes:string; rule:Record<string,unknown>; due_rule:Record<string,unknown>; max_occurrences:number|null; end_at:string|null }
export interface SeriesDetail { series:SeriesInput; status:string; summary:SeriesSummary; occurrences:Occurrence[] }
export interface SemesterCalendar { semester_id:string; week1_start_date:string }

export function asGroup(value: SeriesSummary): AssignmentGroup {
  return { id:value.id,module_id:'builtin.assignment.recurring',course_id:value.course_id,title:value.name,subtitle:`${value.rule_label} · ${value.range_label}`,status:value.status,next_at:value.next_at,assignment_ids:value.assignment_ids,completed:value.completed,active:value.active,planned:value.planned,skipped:value.skipped,search_text:`${value.name} ${value.title_template} ${value.rule_label}` }
}
