use crate::db::{self, Assignment};
use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, Weekday};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub const ID: &str = "builtin.assignment.recurring";
const CAPABILITY: &str = "assignment.schedule";
const OWNER_TYPE: &str = "recurring_series";
const MAX_OCCURRENCES: usize = 5_000;
const AUTO_CATCH_UP_LIMIT: usize = 10;

pub fn registration() -> crate::modules::BuiltinModuleRegistration {
    crate::modules::BuiltinModuleRegistration {
        descriptor,
        initialize,
        before_snapshot: Some(sync),
        assignment_saved: Some(assignment_saved),
        assignment_deleted: Some(assignment_deleted),
        manage: Some(manage),
    }
}

pub fn descriptor() -> crate::modules::ModuleDescriptor {
    let manifest: Value = serde_json::from_str(include_str!("module.json")).expect("bundled recurring assignments manifest");
    crate::modules::ModuleDescriptor {
        id: manifest["id"].as_str().unwrap_or(ID).into(),
        name: manifest["name"].as_str().unwrap_or("周期作业").into(),
        version: manifest["version"].as_str().unwrap_or(env!("CARGO_PKG_VERSION")).into(),
        capabilities: vec![CAPABILITY.into()],
        builtin: true,
        enabled: true,
    }
}

pub fn initialize(conn: &Connection, _data_dir: &std::path::Path) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS recurring_semester_calendars (
            semester_id TEXT PRIMARY KEY REFERENCES semesters(id) ON DELETE CASCADE,
            week1_start_date TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS recurring_series (
            id TEXT PRIMARY KEY,
            course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            title_template TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            submission_label TEXT NOT NULL DEFAULT '',
            submission_url TEXT NOT NULL DEFAULT '',
            submission_notes TEXT NOT NULL DEFAULT '',
            rule_json TEXT NOT NULL,
            due_rule_json TEXT NOT NULL,
            max_occurrences INTEGER,
            end_at TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS recurring_series_by_course ON recurring_series(course_id,status);
        CREATE TABLE IF NOT EXISTS recurring_occurrences (
            id TEXT PRIMARY KEY,
            series_id TEXT NOT NULL REFERENCES recurring_series(id) ON DELETE CASCADE,
            sequence_no INTEGER NOT NULL,
            scheduled_at TEXT,
            due_at TEXT,
            state TEXT NOT NULL,
            assignment_id TEXT UNIQUE REFERENCES assignments(id) ON DELETE SET NULL,
            overridden INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(series_id,sequence_no)
        );
        CREATE INDEX IF NOT EXISTS recurring_occurrences_by_schedule ON recurring_occurrences(series_id,state,scheduled_at);"
    ).map_err(|e| e.to_string())?;
    conn.execute_batch("CREATE TRIGGER IF NOT EXISTS recurring_series_cleanup_module_files BEFORE DELETE ON recurring_series BEGIN DELETE FROM module_file_links WHERE module_id='builtin.assignment.recurring' AND owner_type='recurring_series' AND owner_id=OLD.id; END;").map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM module_file_links WHERE module_id=?1 AND owner_type=?2 AND owner_id NOT IN (SELECT id FROM recurring_series)", params![ID,OWNER_TYPE]).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RecurrenceRule {
    Timed {
        start_at: String,
        frequency: String,
        every: u32,
        #[serde(default)] weekdays: Vec<u32>,
        #[serde(default)] month_mode: Option<String>,
        #[serde(default)] month_day: Option<u32>,
        #[serde(default)] month_week: Option<i32>,
        #[serde(default)] month_weekday: Option<u32>,
    },
    Sequence {
        first_at: String,
        start_num: u32,
        end_num: u32,
        completion_trigger: String,
    },
    AcademicWeek {
        semester_id: String,
        weeks: Vec<u32>,
        weekday: u32,
        time: String,
    },
    CustomDates { dates: Vec<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DueRule {
    None,
    AfterDays { days: u32, time: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeriesInput {
    pub id: String,
    pub course_id: String,
    pub name: String,
    pub title_template: String,
    pub description: String,
    pub submission_label: String,
    pub submission_url: String,
    pub submission_notes: String,
    pub rule: Value,
    pub due_rule: Value,
    pub max_occurrences: Option<u32>,
    pub end_at: Option<String>,
}

#[derive(Debug, Clone)]
struct SeriesRecord {
    input: SeriesInput,
    status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct OccurrenceView {
    pub id: String,
    pub series_id: String,
    pub sequence_no: u32,
    pub scheduled_at: Option<String>,
    pub due_at: Option<String>,
    pub state: String,
    pub assignment_id: Option<String>,
    pub assignment_status: Option<String>,
    pub assignment_title: Option<String>,
    pub overridden: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SeriesSummary {
    pub id: String,
    pub course_id: String,
    pub name: String,
    pub title_template: String,
    pub status: String,
    pub rule_label: String,
    pub due_label: String,
    pub range_label: String,
    pub total: usize,
    pub completed: usize,
    pub active: usize,
    pub planned: usize,
    pub skipped: usize,
    pub next_at: Option<String>,
    pub assignment_ids: Vec<String>,
    pub pending_catch_up: usize,
}

#[derive(Debug, Serialize)]
pub struct SeriesDetail {
    pub series: SeriesInput,
    pub status: String,
    pub summary: SeriesSummary,
    pub occurrences: Vec<OccurrenceView>,
}

#[derive(Debug, Serialize)]
pub struct SemesterCalendar {
    pub semester_id: String,
    pub week1_start_date: String,
}

#[derive(Debug, Deserialize)]
pub struct CatchUpDecision {
    pub occurrence_id: String,
    pub action: String,
}

fn parse_dt(value: &str) -> Result<NaiveDateTime, String> {
    NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S").map_err(|_| format!("日期时间格式无效：{value}"))
}

fn parse_date(value: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| format!("日期格式无效：{value}"))
}

fn parse_time(value: &str) -> Result<NaiveTime, String> {
    NaiveTime::parse_from_str(value, "%H:%M").map_err(|_| format!("时间格式无效：{value}"))
}

fn format_dt(value: NaiveDateTime) -> String { value.format("%Y-%m-%dT%H:%M:%S").to_string() }

fn weekday(value: u32) -> Result<Weekday, String> {
    match value { 1 => Ok(Weekday::Mon), 2 => Ok(Weekday::Tue), 3 => Ok(Weekday::Wed), 4 => Ok(Weekday::Thu), 5 => Ok(Weekday::Fri), 6 => Ok(Weekday::Sat), 7 => Ok(Weekday::Sun), _ => Err("星期必须是 1 至 7".into()) }
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let (next_year,next_month) = if month == 12 { (year + 1,1) } else { (year,month + 1) };
    (NaiveDate::from_ymd_opt(next_year,next_month,1).unwrap() - Duration::days(1)).day()
}

fn month_date(year: i32, month: u32, mode: &str, day: Option<u32>, nth: Option<i32>, day_of_week: Option<u32>) -> Result<NaiveDate, String> {
    if mode == "nth_weekday" {
        let target = weekday(day_of_week.ok_or("请选择星期")?)?;
        let nth = nth.ok_or("请选择第几个星期")?;
        if nth == -1 {
            let mut date = NaiveDate::from_ymd_opt(year,month,days_in_month(year,month)).unwrap();
            while date.weekday() != target { date -= Duration::days(1); }
            return Ok(date)
        }
        if !(1..=5).contains(&nth) { return Err("月内星期序号必须为 1 至 5 或最后一个".into()); }
        let mut date = NaiveDate::from_ymd_opt(year,month,1).unwrap();
        while date.weekday() != target { date += Duration::days(1); }
        date += Duration::days(7 * (nth as i64 - 1));
        if date.month() != month { return Ok(date - Duration::days(7)); }
        return Ok(date)
    }
    let day = day.unwrap_or(1).clamp(1,days_in_month(year,month));
    Ok(NaiveDate::from_ymd_opt(year,month,day).unwrap())
}

fn due_for(scheduled: NaiveDateTime, rule: &DueRule) -> Result<Option<String>, String> {
    match rule {
        DueRule::None => Ok(None),
        DueRule::AfterDays { days,time } => {
            let due = (scheduled.date() + Duration::days(*days as i64)).and_time(parse_time(time)?);
            if due < scheduled { return Err("截止时间不能早于生成时间".into()); }
            Ok(Some(format_dt(due)))
        }
    }
}

fn load_series(conn: &Connection, id: &str) -> Result<SeriesRecord, String> {
    conn.query_row("SELECT id,course_id,name,title_template,description,submission_label,submission_url,submission_notes,rule_json,due_rule_json,max_occurrences,end_at,status FROM recurring_series WHERE id=?1", [id], |r| {
        let rule_raw: String = r.get(8)?;
        let due_raw: String = r.get(9)?;
        Ok(SeriesRecord { input:SeriesInput { id:r.get(0)?,course_id:r.get(1)?,name:r.get(2)?,title_template:r.get(3)?,description:r.get(4)?,submission_label:r.get(5)?,submission_url:r.get(6)?,submission_notes:r.get(7)?,rule:serde_json::from_str(&rule_raw).unwrap_or(Value::Null),due_rule:serde_json::from_str(&due_raw).unwrap_or(Value::Null),max_occurrences:r.get(10)?,end_at:r.get(11)? }, status:r.get(12)? })
    }).map_err(|_| "周期任务不存在".to_string())
}

fn validate_series(conn: &Connection, input: &SeriesInput) -> Result<(RecurrenceRule,DueRule), String> {
    if input.course_id.trim().is_empty() || input.name.trim().is_empty() || input.title_template.trim().is_empty() { return Err("请填写课程、周期名称和作业标题模板".into()); }
    let course_exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM courses WHERE id=?1)", [&input.course_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !course_exists { return Err("课程不存在".into()); }
    if input.max_occurrences.is_none() && input.end_at.is_none() { return Err("请设置生成次数或结束日期".into()); }
    if input.max_occurrences == Some(0) || input.max_occurrences.unwrap_or(1) as usize > MAX_OCCURRENCES { return Err("生成次数必须为 1 至 5000".into()); }
    if let Some(end) = &input.end_at { parse_dt(end)?; }
    if input.rule.get("version").and_then(Value::as_u64) != Some(1) { return Err("周期规则版本无效".into()); }
    if input.due_rule.get("version").and_then(Value::as_u64) != Some(1) { return Err("截止规则版本无效".into()); }
    let rule: RecurrenceRule = serde_json::from_value(input.rule.clone()).map_err(|_| "周期规则格式无效".to_string())?;
    let due: DueRule = serde_json::from_value(input.due_rule.clone()).map_err(|_| "截止规则格式无效".to_string())?;
    match &rule {
        RecurrenceRule::Timed { start_at,frequency,every,weekdays,month_mode,month_day,month_week,month_weekday } => {
            parse_dt(start_at)?;
            if *every == 0 || *every > 365 { return Err("周期步长必须为 1 至 365".into()); }
            if !["day","week","month"].contains(&frequency.as_str()) { return Err("不支持的定时频率".into()); }
            if frequency == "week" && (weekdays.is_empty() || weekdays.iter().any(|d| weekday(*d).is_err())) { return Err("每周规则至少选择一个有效星期".into()); }
            if frequency == "month" { let _ = month_date(2026,1,month_mode.as_deref().unwrap_or("day_of_month"),*month_day,*month_week,*month_weekday)?; }
        }
        RecurrenceRule::Sequence { first_at,start_num,end_num,completion_trigger } => {
            parse_dt(first_at)?;
            if start_num == &0 || end_num < start_num { return Err("序列起止编号无效".into()); }
            if !["done","submitted"].contains(&completion_trigger.as_str()) { return Err("序列触发状态无效".into()); }
        }
        RecurrenceRule::AcademicWeek { semester_id,weeks,weekday:day,time } => {
            if weeks.is_empty() || weeks.iter().any(|week| *week == 0 || *week > 60) { return Err("教学周必须为 1 至 60".into()); }
            let _ = weekday(*day)?; parse_time(time)?;
            let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM recurring_semester_calendars WHERE semester_id=?1)", [semester_id], |r| r.get(0)).map_err(|e| e.to_string())?;
            if !exists { return Err("请先设置该学期的第 1 教学周周一".into()); }
        }
        RecurrenceRule::CustomDates { dates } => {
            if dates.is_empty() { return Err("请至少添加一个自定义日期".into()); }
            for date in dates { parse_dt(date)?; }
        }
    }
    Ok((rule,due))
}

fn candidate_dates(conn: &Connection, series: &SeriesRecord, rule: &RecurrenceRule) -> Result<Vec<(u32,NaiveDateTime)>, String> {
    let maximum = series.input.max_occurrences.map(|v| v as usize).unwrap_or(MAX_OCCURRENCES).min(MAX_OCCURRENCES);
    let end = series.input.end_at.as_deref().map(parse_dt).transpose()?;
    let mut values = Vec::new();
    fn push_candidate(values: &mut Vec<(u32, NaiveDateTime)>, maximum: usize, end: Option<NaiveDateTime>, number: u32, value: NaiveDateTime) {
        if values.len() < maximum && end.is_none_or(|end| value <= end) { values.push((number,value)); }
    }
    match rule {
        RecurrenceRule::Timed { start_at,frequency,every,weekdays,month_mode,month_day,month_week,month_weekday } => {
            let start = parse_dt(start_at)?;
            if frequency == "day" {
                for index in 0..MAX_OCCURRENCES { let value = start + Duration::days(index as i64 * *every as i64); if end.is_some_and(|end| value > end) || values.len() >= maximum { break } push_candidate(&mut values,maximum,end,index as u32 + 1,value); }
            } else if frequency == "week" {
                let chosen = weekdays.iter().copied().collect::<HashSet<_>>();
                let mut date = start.date();
                for _ in 0..(MAX_OCCURRENCES * 7) {
                    let weeks = (date - start.date()).num_days() / 7;
                    let day = date.weekday().number_from_monday();
                    let value = date.and_time(start.time());
                    if weeks % *every as i64 == 0 && chosen.contains(&day) && value >= start { let number = values.len() as u32 + 1; push_candidate(&mut values,maximum,end,number,value); }
                    if end.is_some_and(|end| value > end) || values.len() >= maximum { break }
                    date += Duration::days(1);
                }
            } else {
                let mut year = start.year(); let mut month = start.month();
                for _ in 0..MAX_OCCURRENCES {
                    let date = month_date(year,month,month_mode.as_deref().unwrap_or("day_of_month"),*month_day,*month_week,*month_weekday)?;
                    let value = date.and_time(start.time());
                    if value >= start { let number = values.len() as u32 + 1; push_candidate(&mut values,maximum,end,number,value); }
                    if end.is_some_and(|end| value > end) || values.len() >= maximum { break }
                    let total = year * 12 + month as i32 - 1 + *every as i32;
                    year = total.div_euclid(12); month = total.rem_euclid(12) as u32 + 1;
                }
            }
        }
        RecurrenceRule::Sequence { first_at,start_num,end_num,.. } => {
            let first = parse_dt(first_at)?;
            for number in *start_num..=*end_num { if values.len() >= maximum { break } push_candidate(&mut values,maximum,end,number,first); }
        }
        RecurrenceRule::AcademicWeek { semester_id,weeks,weekday:day,time } => {
            let start_raw: String = conn.query_row("SELECT week1_start_date FROM recurring_semester_calendars WHERE semester_id=?1", [semester_id], |r| r.get(0)).map_err(|_| "未设置教学周起点".to_string())?;
            let start = parse_date(&start_raw)?; let day_offset = weekday(*day)?.num_days_from_monday() as i64; let time = parse_time(time)?;
            let mut unique = weeks.iter().copied().collect::<Vec<_>>(); unique.sort_unstable(); unique.dedup();
            for week in unique { push_candidate(&mut values,maximum,end,week,(start + Duration::days((week as i64 - 1) * 7 + day_offset)).and_time(time)); }
        }
        RecurrenceRule::CustomDates { dates } => {
            let mut unique = dates.iter().map(|value| parse_dt(value)).collect::<Result<Vec<_>,_>>()?; unique.sort_unstable(); unique.dedup();
            for value in unique { let number = values.len() as u32 + 1; push_candidate(&mut values,maximum,end,number,value); }
        }
    }
    if values.is_empty() { return Err("当前规则和结束条件之间没有可生成的节点".into()); }
    Ok(values)
}

fn materialize(conn: &Connection, series_id: &str) -> Result<(), String> {
    let series = load_series(conn,series_id)?;
    let (rule,due_rule) = validate_series(conn,&series.input)?;
    conn.execute("DELETE FROM recurring_occurrences WHERE series_id=?1 AND assignment_id IS NULL AND state IN ('planned','blocked')", [series_id]).map_err(|e| e.to_string())?;
    let candidates = candidate_dates(conn,&series,&rule)?;
    let timestamp = db::now();
    for (index,(number,scheduled)) in candidates.iter().enumerate() {
        let (scheduled_at,state,due_at) = if matches!(rule,RecurrenceRule::Sequence { .. }) && index > 0 { (None,"blocked".to_string(),None) } else { (Some(format_dt(*scheduled)),"planned".to_string(),due_for(*scheduled,&due_rule)?) };
        conn.execute("INSERT OR IGNORE INTO recurring_occurrences(id,series_id,sequence_no,scheduled_at,due_at,state,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?7)", params![Uuid::new_v4().to_string(),series_id,*number,scheduled_at,due_at,state,timestamp]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn render_title(template: &str, number: u32, scheduled: NaiveDateTime, academic_week: Option<u32>) -> String {
    template.replace("{num}",&number.to_string()).replace("{date}",&scheduled.format("%Y-%m-%d").to_string()).replace("{week}",&academic_week.unwrap_or(number).to_string())
}

fn academic_week_for(conn: &Connection, rule: &RecurrenceRule, scheduled: NaiveDateTime) -> Option<u32> {
    let RecurrenceRule::AcademicWeek { semester_id,.. } = rule else { return None };
    let raw: String = conn.query_row("SELECT week1_start_date FROM recurring_semester_calendars WHERE semester_id=?1", [semester_id], |r| r.get(0)).ok()?;
    let start = parse_date(&raw).ok()?;
    Some(((scheduled.date() - start).num_days() / 7 + 1).max(1) as u32)
}

fn generate_occurrence(conn: &Connection, occurrence_id: &str) -> Result<String, String> {
    let (series_id,number,scheduled_at,due_at,state,assignment_id): (String,u32,Option<String>,Option<String>,String,Option<String>) = conn.query_row("SELECT series_id,sequence_no,scheduled_at,due_at,state,assignment_id FROM recurring_occurrences WHERE id=?1", [occurrence_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).map_err(|_| "周期节点不存在".to_string())?;
    if let Some(id) = assignment_id { return Ok(id); }
    if state != "planned" { return Err("该周期节点当前不能生成".into()); }
    let scheduled_raw = scheduled_at.ok_or("周期节点缺少生成时间")?;
    let scheduled = parse_dt(&scheduled_raw)?;
    let series = load_series(conn,&series_id)?;
    let rule: RecurrenceRule = serde_json::from_value(series.input.rule.clone()).map_err(|_| "周期规则格式无效".to_string())?;
    let title = render_title(&series.input.title_template,number,scheduled,academic_week_for(conn,&rule,scheduled));
    let assignment = Assignment { id:String::new(),course_id:series.input.course_id,title,description:series.input.description,due_at,status:"todo".into(),submission_label:series.input.submission_label,submission_url:series.input.submission_url,submission_notes:series.input.submission_notes,source_name:"周期作业".into(),source_text:series.input.name,created_at:String::new(),updated_at:String::new(),custom_fields:HashMap::new() };
    let assignment_id = db::create_generated_assignment(conn,assignment)?;
    conn.execute("UPDATE recurring_occurrences SET state='generated',assignment_id=?2,updated_at=?3 WHERE id=?1", params![occurrence_id,assignment_id,db::now()]).map_err(|e| e.to_string())?;
    Ok(assignment_id)
}

pub fn sync(conn: &mut Connection) -> Result<(), String> {
    conn.execute("UPDATE recurring_occurrences SET state='skipped',updated_at=?1 WHERE state='generated' AND assignment_id IS NULL", [db::now()]).map_err(|e| e.to_string())?;
    let now = db::now();
    let due = {
        let mut stmt = conn.prepare("SELECT o.id FROM recurring_occurrences o JOIN recurring_series s ON s.id=o.series_id WHERE s.status='active' AND o.state='planned' AND o.assignment_id IS NULL AND o.scheduled_at IS NOT NULL AND o.scheduled_at<=?1 ORDER BY o.scheduled_at,o.sequence_no").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([&now], |r| r.get::<_,String>(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?
    };
    if due.len() > AUTO_CATCH_UP_LIMIT { return Ok(()) }
    if due.is_empty() { return Ok(()) }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for id in due { generate_occurrence(&tx,&id)?; }
    tx.commit().map_err(|e| e.to_string())
}

pub fn assignment_saved(conn: &Connection, assignment_id: &str) -> Result<(), String> {
    let occurrence: Option<(String,String,u32)> = conn.query_row("SELECT o.id,o.series_id,o.sequence_no FROM recurring_occurrences o WHERE o.assignment_id=?1", [assignment_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e| e.to_string())?;
    let Some((_occurrence_id,series_id,sequence_no)) = occurrence else { return Ok(()) };
    let series = load_series(conn,&series_id)?;
    let assignment: (String,String,String,Option<String>,String,String,String,String) = conn.query_row("SELECT course_id,title,description,due_at,submission_label,submission_url,submission_notes,status FROM assignments WHERE id=?1", [assignment_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).map_err(|e| e.to_string())?;
    let occurrence_data: (Option<String>,Option<String>) = conn.query_row("SELECT scheduled_at,due_at FROM recurring_occurrences WHERE assignment_id=?1", [assignment_id], |r| Ok((r.get(0)?,r.get(1)?))).map_err(|e| e.to_string())?;
    let expected_title = occurrence_data.0.as_deref().and_then(|v| parse_dt(v).ok()).map(|scheduled| render_title(&series.input.title_template,sequence_no,scheduled,None)).unwrap_or_default();
    let overridden = assignment.0 != series.input.course_id || assignment.1 != expected_title || assignment.2 != series.input.description || assignment.3 != occurrence_data.1 || assignment.4 != series.input.submission_label || assignment.5 != series.input.submission_url || assignment.6 != series.input.submission_notes;
    conn.execute("UPDATE recurring_occurrences SET overridden=?2,updated_at=?3 WHERE assignment_id=?1", params![assignment_id,overridden,db::now()]).map_err(|e| e.to_string())?;
    let rule: RecurrenceRule = serde_json::from_value(series.input.rule.clone()).map_err(|_| "周期规则格式无效".to_string())?;
    let RecurrenceRule::Sequence { completion_trigger,.. } = rule else { return Ok(()) };
    let triggered = if completion_trigger == "submitted" { assignment.7 == "submitted" } else { assignment.7 == "done" || assignment.7 == "submitted" };
    if !triggered || series.status != "active" { return Ok(()) }
    if series.input.end_at.as_deref().is_some_and(|end| end < db::now().as_str()) {
        conn.execute("UPDATE recurring_occurrences SET state='cancelled',updated_at=?2 WHERE series_id=?1 AND state='blocked'", params![series_id,db::now()]).map_err(|e| e.to_string())?;
        return Ok(())
    }
    let next: Option<String> = conn.query_row("SELECT id FROM recurring_occurrences WHERE series_id=?1 AND sequence_no>?2 AND state='blocked' ORDER BY sequence_no LIMIT 1", params![series_id,sequence_no], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    if let Some(next_id) = next {
        let due_rule: DueRule = serde_json::from_value(series.input.due_rule.clone()).map_err(|_| "截止规则格式无效".to_string())?;
        let scheduled = parse_dt(&db::now())?;
        conn.execute("UPDATE recurring_occurrences SET scheduled_at=?2,due_at=?3,state='planned',updated_at=?4 WHERE id=?1", params![next_id,format_dt(scheduled),due_for(scheduled,&due_rule)?,db::now()]).map_err(|e| e.to_string())?;
        generate_occurrence(conn,&next_id)?;
    }
    Ok(())
}

pub fn assignment_deleted(conn: &Connection, assignment_id: &str) -> Result<(), String> {
    conn.execute("UPDATE recurring_occurrences SET state='skipped',assignment_id=NULL,updated_at=?2 WHERE assignment_id=?1", params![assignment_id,db::now()]).map_err(|e| e.to_string())?;
    Ok(())
}

fn rule_label(rule: &RecurrenceRule) -> String {
    match rule {
        RecurrenceRule::Timed { frequency,every,weekdays,.. } if frequency == "day" => format!("每 {every} 天生成"),
        RecurrenceRule::Timed { frequency,every,weekdays,.. } if frequency == "week" => format!("每 {every} 周 · {}",weekdays.iter().map(|v| format!("周{}",["一","二","三","四","五","六","日"][(*v as usize).saturating_sub(1).min(6)])).collect::<Vec<_>>().join("、")),
        RecurrenceRule::Timed { every,.. } => format!("每 {every} 月生成"),
        RecurrenceRule::Sequence { completion_trigger,.. } => if completion_trigger == "submitted" { "提交后产生下一项".into() } else { "完成后产生下一项".into() },
        RecurrenceRule::AcademicWeek { weekday,.. } => format!("教学周 · 周{}",["一","二","三","四","五","六","日"][(*weekday as usize).saturating_sub(1).min(6)]),
        RecurrenceRule::CustomDates { .. } => "自定义日期".into(),
    }
}

fn due_label(rule: &DueRule) -> String { match rule { DueRule::None => "无截止时间".into(), DueRule::AfterDays { days,time } => format!("生成后 {days} 天 {time}") } }

fn occurrences(conn: &Connection, series_id: &str) -> Result<Vec<OccurrenceView>, String> {
    conn.prepare("SELECT o.id,o.series_id,o.sequence_no,o.scheduled_at,o.due_at,o.state,o.assignment_id,a.status,a.title,o.overridden FROM recurring_occurrences o LEFT JOIN assignments a ON a.id=o.assignment_id WHERE o.series_id=?1 ORDER BY o.sequence_no").map_err(|e| e.to_string())?
        .query_map([series_id], |r| Ok(OccurrenceView { id:r.get(0)?,series_id:r.get(1)?,sequence_no:r.get(2)?,scheduled_at:r.get(3)?,due_at:r.get(4)?,state:r.get(5)?,assignment_id:r.get(6)?,assignment_status:r.get(7)?,assignment_title:r.get(8)?,overridden:r.get::<_,bool>(9)? })).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())
}

fn summary(conn: &Connection, series: &SeriesRecord) -> Result<SeriesSummary, String> {
    let rule: RecurrenceRule = serde_json::from_value(series.input.rule.clone()).map_err(|_| "周期规则格式无效".to_string())?;
    let due_rule: DueRule = serde_json::from_value(series.input.due_rule.clone()).map_err(|_| "截止规则格式无效".to_string())?;
    let items = occurrences(conn,&series.input.id)?;
    let completed = items.iter().filter(|item| matches!(item.assignment_status.as_deref(),Some("done"|"submitted"))).count();
    let active = items.iter().filter(|item| matches!(item.assignment_status.as_deref(),Some("todo"|"doing"))).count();
    let planned = items.iter().filter(|item| matches!(item.state.as_str(),"planned"|"blocked")).count();
    let skipped = items.iter().filter(|item| matches!(item.state.as_str(),"skipped"|"cancelled")).count();
    let now = db::now();
    let pending_catch_up = items.iter().filter(|item| item.state == "planned" && item.scheduled_at.as_deref().is_some_and(|date| date <= now.as_str())).count();
    let next_at = items.iter().filter_map(|item| {
        if matches!(item.assignment_status.as_deref(),Some("todo"|"doing"|"done")) { item.due_at.clone().or(item.scheduled_at.clone()) }
        else if matches!(item.state.as_str(),"planned"|"blocked") { item.scheduled_at.clone() }
        else { None }
    }).min();
    let range_start = items.iter().filter_map(|item| item.scheduled_at.clone()).min().unwrap_or_default();
    let range_end = items.iter().filter_map(|item| item.scheduled_at.clone()).max().unwrap_or_default();
    Ok(SeriesSummary { id:series.input.id.clone(),course_id:series.input.course_id.clone(),name:series.input.name.clone(),title_template:series.input.title_template.clone(),status:series.status.clone(),rule_label:rule_label(&rule),due_label:due_label(&due_rule),range_label:if range_start.is_empty() { "等待前序完成".into() } else { format!("{}—{}",&range_start[..10],&range_end[..10]) },total:items.len(),completed,active,planned,skipped,next_at,assignment_ids:items.iter().filter_map(|item| item.assignment_id.clone()).collect(),pending_catch_up })
}

#[derive(Deserialize)]
struct IdInput {
    id: String,
}

#[derive(Deserialize)]
struct StateInput {
    id: String,
    status: String,
}

#[derive(Deserialize)]
struct CatchUpInput {
    decisions: Vec<CatchUpDecision>,
}

#[derive(Deserialize)]
struct CalendarInput {
    semester_id: String,
    week1_start_date: String,
}

fn recurring_overview(conn: &Connection) -> Result<Vec<SeriesSummary>, String> {
    let ids = conn.prepare("SELECT id FROM recurring_series ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'ended' THEN 2 ELSE 3 END,updated_at DESC").map_err(|e| e.to_string())?.query_map([], |r| r.get::<_,String>(0)).map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    ids.iter().map(|id| { let series=load_series(conn,id)?; summary(conn,&series) }).collect()
}

fn get_recurring_series(conn: &Connection, id: String) -> Result<SeriesDetail, String> {
    let series = load_series(conn,&id)?; let summary = summary(conn,&series)?; let occurrences = occurrences(conn,&id)?;
    Ok(SeriesDetail { series:series.input,status:series.status,summary,occurrences })
}

fn save_recurring_series(conn: &mut Connection, mut payload: SeriesInput) -> Result<String, String> {
    validate_series(conn,&payload)?;
    payload.id = db::id_or_new(&payload.id); let now = db::now(); let created = conn.query_row("SELECT created_at FROM recurring_series WHERE id=?1", [&payload.id], |r| r.get::<_,String>(0)).optional().map_err(|e| e.to_string())?.unwrap_or_else(|| now.clone());
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO recurring_series(id,course_id,name,title_template,description,submission_label,submission_url,submission_notes,rule_json,due_rule_json,max_occurrences,end_at,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'active',?13,?14) ON CONFLICT(id) DO UPDATE SET course_id=excluded.course_id,name=excluded.name,title_template=excluded.title_template,description=excluded.description,submission_label=excluded.submission_label,submission_url=excluded.submission_url,submission_notes=excluded.submission_notes,rule_json=excluded.rule_json,due_rule_json=excluded.due_rule_json,max_occurrences=excluded.max_occurrences,end_at=excluded.end_at,updated_at=excluded.updated_at", params![payload.id,payload.course_id,payload.name.trim(),payload.title_template.trim(),payload.description,payload.submission_label,payload.submission_url,payload.submission_notes,payload.rule.to_string(),payload.due_rule.to_string(),payload.max_occurrences,payload.end_at,created,now]).map_err(|e| e.to_string())?;
    materialize(&tx,&payload.id)?;
    tx.execute("UPDATE module_file_links SET owner_label=?2 WHERE module_id=?3 AND owner_type=?4 AND owner_id=?1", params![payload.id,payload.name.trim(),ID,OWNER_TYPE]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    sync(conn)?;
    Ok(payload.id)
}

fn set_recurring_series_state(conn: &mut Connection, id: String, status: String) -> Result<(), String> {
    if !["active","paused","ended","archived"].contains(&status.as_str()) { return Err("无效的周期状态".into()); }
    conn.execute("UPDATE recurring_series SET status=?2,updated_at=?3 WHERE id=?1", params![id,status,db::now()]).map_err(|e| e.to_string())?;
    if matches!(status.as_str(),"ended"|"archived") { conn.execute("UPDATE recurring_occurrences SET state='cancelled',updated_at=?2 WHERE series_id=?1 AND state IN ('planned','blocked')", params![id,db::now()]).map_err(|e| e.to_string())?; }
    if status == "active" { materialize(conn,&id)?; sync(conn)?; }
    Ok(())
}

fn delete_recurring_series(conn: &mut Connection, id: String) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    crate::files::remove_module_owner_files(&tx,ID,OWNER_TYPE,&id)?;
    tx.execute("DELETE FROM recurring_series WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn skip_recurring_occurrence(conn: &Connection, id: String) -> Result<(), String> {
    let changed = conn.execute("UPDATE recurring_occurrences SET state='skipped',updated_at=?2 WHERE id=?1 AND assignment_id IS NULL AND state IN ('planned','blocked')", params![id,db::now()]).map_err(|e| e.to_string())?;
    if changed == 0 { return Err("该节点不能跳过".into()); } Ok(())
}

fn generate_recurring_occurrence(conn: &Connection, id: String) -> Result<String, String> {
    let state_value: String = conn.query_row("SELECT state FROM recurring_occurrences WHERE id=?1", [&id], |r| r.get(0)).map_err(|_| "周期节点不存在".to_string())?;
    if state_value == "blocked" {
        let due_rule_raw: String = conn.query_row("SELECT s.due_rule_json FROM recurring_occurrences o JOIN recurring_series s ON s.id=o.series_id WHERE o.id=?1", [&id], |r| r.get(0)).map_err(|e| e.to_string())?;
        let due_rule: DueRule = serde_json::from_str(&due_rule_raw).map_err(|_| "截止规则格式无效".to_string())?; let scheduled = parse_dt(&db::now())?;
        conn.execute("UPDATE recurring_occurrences SET state='planned',scheduled_at=?2,due_at=?3,updated_at=?4 WHERE id=?1", params![id,format_dt(scheduled),due_for(scheduled,&due_rule)?,db::now()]).map_err(|e| e.to_string())?;
    }
    generate_occurrence(&conn,&id)
}

fn resolve_recurring_catch_up(conn: &mut Connection, decisions: Vec<CatchUpDecision>) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for decision in decisions {
        match decision.action.as_str() { "generate" => { generate_occurrence(&tx,&decision.occurrence_id)?; }, "skip" => { tx.execute("UPDATE recurring_occurrences SET state='skipped',updated_at=?2 WHERE id=?1 AND state='planned' AND assignment_id IS NULL", params![decision.occurrence_id,db::now()]).map_err(|e| e.to_string())?; }, _ => return Err("补齐操作无效".into()) }
    }
    tx.commit().map_err(|e| e.to_string())
}

fn list_semester_calendars(conn: &Connection) -> Result<Vec<SemesterCalendar>, String> {
    let mut statement = conn.prepare("SELECT semester_id,week1_start_date FROM recurring_semester_calendars ORDER BY semester_id").map_err(|e| e.to_string())?;
    let calendars = statement.query_map([], |r| Ok(SemesterCalendar { semester_id:r.get(0)?,week1_start_date:r.get(1)? })).map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    Ok(calendars)
}

fn save_semester_calendar(conn: &Connection, semester_id: String, week1_start_date: String) -> Result<(), String> {
    let date = parse_date(&week1_start_date)?; if date.weekday() != Weekday::Mon { return Err("第 1 教学周起始日必须是周一".into()); }
    conn.execute("INSERT INTO recurring_semester_calendars(semester_id,week1_start_date,updated_at) VALUES (?1,?2,?3) ON CONFLICT(semester_id) DO UPDATE SET week1_start_date=excluded.week1_start_date,updated_at=excluded.updated_at", params![semester_id,week1_start_date,db::now()]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn manage(conn: &mut Connection, operation: &str, payload: Value) -> Result<Value, String> {
    match operation {
        "overview" => serde_json::to_value(recurring_overview(conn)?).map_err(|e| e.to_string()),
        "detail" => {
            let input: IdInput = serde_json::from_value(payload).map_err(|_| "周期详情参数无效".to_string())?;
            serde_json::to_value(get_recurring_series(conn, input.id)?).map_err(|e| e.to_string())
        }
        "save" => {
            let input: SeriesInput = serde_json::from_value(payload).map_err(|_| "周期计划参数无效".to_string())?;
            serde_json::to_value(save_recurring_series(conn, input)?).map_err(|e| e.to_string())
        }
        "set_state" => {
            let input: StateInput = serde_json::from_value(payload).map_err(|_| "周期状态参数无效".to_string())?;
            set_recurring_series_state(conn, input.id, input.status)?;
            Ok(Value::Null)
        }
        "delete" => {
            let input: IdInput = serde_json::from_value(payload).map_err(|_| "删除周期参数无效".to_string())?;
            delete_recurring_series(conn, input.id)?;
            Ok(Value::Null)
        }
        "skip_occurrence" => {
            let input: IdInput = serde_json::from_value(payload).map_err(|_| "跳过节点参数无效".to_string())?;
            skip_recurring_occurrence(conn, input.id)?;
            Ok(Value::Null)
        }
        "generate_occurrence" => {
            let input: IdInput = serde_json::from_value(payload).map_err(|_| "生成节点参数无效".to_string())?;
            serde_json::to_value(generate_recurring_occurrence(conn, input.id)?).map_err(|e| e.to_string())
        }
        "resolve_catch_up" => {
            let input: CatchUpInput = serde_json::from_value(payload).map_err(|_| "补齐清单参数无效".to_string())?;
            resolve_recurring_catch_up(conn, input.decisions)?;
            Ok(Value::Null)
        }
        "list_calendars" => serde_json::to_value(list_semester_calendars(conn)?).map_err(|e| e.to_string()),
        "save_calendar" => {
            let input: CalendarInput = serde_json::from_value(payload).map_err(|_| "教学周日历参数无效".to_string())?;
            save_semester_calendar(conn, input.semester_id, input.week1_start_date)?;
            Ok(Value::Null)
        }
        _ => Err("周期作业操作不存在".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;
          CREATE TABLE semesters(id TEXT PRIMARY KEY,name TEXT,source_root TEXT);
          CREATE TABLE courses(id TEXT PRIMARY KEY,semester_id TEXT REFERENCES semesters(id),name TEXT,code TEXT,folder_path TEXT);
          CREATE TABLE assignments(id TEXT PRIMARY KEY,course_id TEXT REFERENCES courses(id),title TEXT,description TEXT,due_at TEXT,status TEXT,submission_label TEXT,submission_url TEXT,submission_notes TEXT,source_name TEXT,source_text TEXT,created_at TEXT,updated_at TEXT);
          CREATE TABLE assignment_custom_fields(assignment_id TEXT,field_key TEXT,field_value TEXT);
          CREATE TABLE recent_values(field TEXT,value TEXT,used_at TEXT,PRIMARY KEY(field,value));
          CREATE TABLE file_assets(id TEXT PRIMARY KEY,path TEXT UNIQUE);
          CREATE TABLE module_file_links(id TEXT PRIMARY KEY,module_id TEXT,owner_type TEXT,owner_id TEXT,owner_label TEXT,file_id TEXT REFERENCES file_assets(id),role TEXT,note TEXT,created_at TEXT);
          CREATE TABLE file_history(id TEXT PRIMARY KEY,file_id TEXT,link_id TEXT,assignment_id TEXT,assignment_title TEXT,event_type TEXT,path TEXT,details TEXT,file_size INTEGER,modified_at_ms INTEGER,occurred_at TEXT);
          CREATE TABLE module_states(module_id TEXT PRIMARY KEY,enabled INTEGER,updated_at TEXT);
          INSERT INTO semesters VALUES('s','Term',''); INSERT INTO courses VALUES('c','s','Calculus','','');").unwrap();
        initialize(&conn,std::path::Path::new(".")).unwrap(); conn
    }

    #[test]
    fn bundled_manifest_builds_runtime_descriptor() {
        let value=descriptor();
        assert_eq!(value.id,ID);
        assert_eq!(value.capabilities,vec![CAPABILITY.to_string()]);
        assert!(value.builtin && value.enabled);
    }

    #[test]
    fn generic_management_dispatches_inside_the_module() {
        let mut conn = schema();
        let overview = manage(&mut conn,"overview",serde_json::json!({})).unwrap();
        assert_eq!(overview,serde_json::json!([]));
        assert!(manage(&mut conn,"unknown",serde_json::json!({})).is_err());
    }

    fn input(mut rule: Value, max: Option<u32>, end: Option<&str>) -> SeriesInput { rule.as_object_mut().unwrap().insert("version".into(),Value::from(1)); SeriesInput { id:String::new(),course_id:"c".into(),name:"Series".into(),title_template:"Homework {num}".into(),description:String::new(),submission_label:String::new(),submission_url:String::new(),submission_notes:String::new(),rule,due_rule:serde_json::json!({"version":1,"kind":"after_days","days":6,"time":"23:59"}),max_occurrences:max,end_at:end.map(str::to_owned) } }

    fn store(conn: &Connection, id: &str, mut value: SeriesInput) {
        value.id=id.into();
        conn.execute("INSERT INTO recurring_series(id,course_id,name,title_template,description,submission_label,submission_url,submission_notes,rule_json,due_rule_json,max_occurrences,end_at,status,created_at,updated_at) VALUES(?1,?2,?3,?4,'','','','',?5,?6,?7,?8,'active','2000-01-01T00:00:00','2000-01-01T00:00:00')",params![id,value.course_id,value.name,value.title_template,value.rule.to_string(),value.due_rule.to_string(),value.max_occurrences,value.end_at]).unwrap();
        materialize(conn,id).unwrap();
    }

    #[test]
    fn daily_and_end_condition_use_earliest_limit() {
        let conn=schema(); let series=SeriesRecord { input:input(serde_json::json!({"kind":"timed","start_at":"2026-09-01T08:00:00","frequency":"day","every":2}),Some(10),Some("2026-09-06T23:59:00")),status:"active".into() };
        let (rule,_)=validate_series(&conn,&series.input).unwrap(); let values=candidate_dates(&conn,&series,&rule).unwrap();
        assert_eq!(values.len(),3); assert_eq!(format_dt(values[2].1),"2026-09-05T08:00:00");
    }

    #[test]
    fn monthly_day_clamps_to_leap_month_end() {
        assert_eq!(month_date(2028,2,"day_of_month",Some(31),None,None).unwrap().to_string(),"2028-02-29");
        assert_eq!(month_date(2027,2,"day_of_month",Some(31),None,None).unwrap().to_string(),"2027-02-28");
    }

    #[test]
    fn monthly_nth_weekday_and_last_weekday_are_stable() {
        assert_eq!(month_date(2026,9,"nth_weekday",None,Some(3),Some(3)).unwrap().to_string(),"2026-09-16");
        assert_eq!(month_date(2026,9,"nth_weekday",None,Some(-1),Some(3)).unwrap().to_string(),"2026-09-30");
    }

    #[test]
    fn academic_week_uses_semester_monday() {
        let conn=schema(); conn.execute("INSERT INTO recurring_semester_calendars VALUES('s','2026-09-07','now')",[]).unwrap();
        let series=SeriesRecord { input:input(serde_json::json!({"kind":"academic_week","semester_id":"s","weeks":[1,3],"weekday":3,"time":"09:30"}),Some(2),None),status:"active".into() };
        let (rule,_)=validate_series(&conn,&series.input).unwrap(); let values=candidate_dates(&conn,&series,&rule).unwrap();
        assert_eq!(format_dt(values[0].1),"2026-09-09T09:30:00"); assert_eq!(format_dt(values[1].1),"2026-09-23T09:30:00");
    }

    #[test]
    fn custom_dates_are_sorted_and_deduplicated() {
        let conn=schema(); let series=SeriesRecord { input:input(serde_json::json!({"kind":"custom_dates","dates":["2026-09-03T08:00:00","2026-09-01T08:00:00","2026-09-03T08:00:00"]}),Some(10),None),status:"active".into() };
        let (rule,_)=validate_series(&conn,&series.input).unwrap(); let values=candidate_dates(&conn,&series,&rule).unwrap();
        assert_eq!(values.len(),2); assert_eq!(format_dt(values[0].1),"2026-09-01T08:00:00");
    }

    #[test]
    fn catch_up_generates_ten_but_never_partially_generates_eleven() {
        let mut ten=schema(); store(&ten,"ten",input(serde_json::json!({"kind":"timed","start_at":"2000-01-01T08:00:00","frequency":"day","every":1}),Some(10),None));
        sync(&mut ten).unwrap();
        assert_eq!(ten.query_row("SELECT COUNT(*) FROM recurring_occurrences WHERE assignment_id IS NOT NULL",[],|r|r.get::<_,i64>(0)).unwrap(),10);
        let mut eleven=schema(); store(&eleven,"eleven",input(serde_json::json!({"kind":"timed","start_at":"2000-01-01T08:00:00","frequency":"day","every":1}),Some(11),None));
        sync(&mut eleven).unwrap();
        assert_eq!(eleven.query_row("SELECT COUNT(*) FROM recurring_occurrences WHERE assignment_id IS NOT NULL",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }

    #[test]
    fn sequence_respects_done_and_submitted_triggers() {
        for (trigger,status,expected) in [("done","done",2_i64),("submitted","done",1_i64),("submitted","submitted",2_i64)] {
            let mut conn=schema(); let id=format!("{trigger}-{status}");
            store(&conn,&id,input(serde_json::json!({"kind":"sequence","first_at":"2000-01-01T08:00:00","start_num":1,"end_num":3,"completion_trigger":trigger}),Some(3),None));
            sync(&mut conn).unwrap();
            let assignment_id:String=conn.query_row("SELECT assignment_id FROM recurring_occurrences WHERE series_id=?1 AND sequence_no=1",[&id],|r|r.get(0)).unwrap();
            conn.execute("UPDATE assignments SET status=?2 WHERE id=?1",params![assignment_id,status]).unwrap(); assignment_saved(&conn,&assignment_id).unwrap();
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM recurring_occurrences WHERE series_id=?1 AND assignment_id IS NOT NULL",[&id],|r|r.get::<_,i64>(0)).unwrap(),expected);
        }
    }

    #[test]
    fn paused_and_deleted_occurrences_do_not_regenerate() {
        let mut conn=schema(); store(&conn,"paused",input(serde_json::json!({"kind":"timed","start_at":"2000-01-01T08:00:00","frequency":"day","every":1}),Some(2),None));
        conn.execute("UPDATE recurring_series SET status='paused' WHERE id='paused'",[]).unwrap(); sync(&mut conn).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM assignments",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        conn.execute("UPDATE recurring_series SET status='active' WHERE id='paused'",[]).unwrap(); sync(&mut conn).unwrap();
        let assignment_id:String=conn.query_row("SELECT assignment_id FROM recurring_occurrences WHERE series_id='paused' ORDER BY sequence_no LIMIT 1",[],|r|r.get(0)).unwrap();
        assignment_deleted(&conn,&assignment_id).unwrap(); conn.execute("DELETE FROM assignments WHERE id=?1",[assignment_id]).unwrap(); sync(&mut conn).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM recurring_occurrences WHERE series_id='paused' AND state='skipped'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }
}
