//! Generic, reviewed assignment imports. Source modules never write core tables.
use crate::{
    db::{self, AppState},
    modules,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteCourse {
    pub id: String,
    pub name: String,
    pub code: String,
    pub term: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RemoteAssignment {
    pub id: String,
    pub course_id: String,
    pub title: String,
    pub description: String,
    pub due_at: Option<String>,
    pub status: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteSnapshot {
    pub protocol: u32,
    pub account_key: String,
    pub checked_at: String,
    pub courses: Vec<RemoteCourse>,
    pub assignments: Vec<RemoteAssignment>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct CourseMatch {
    pub remote: RemoteCourse,
    pub local_course_id: String,
}

#[derive(Debug, Serialize)]
pub struct ImportItem {
    pub remote: RemoteAssignment,
    pub linked_assignment_id: String,
    pub suggested_assignment_ids: Vec<String>,
    pub local: Option<LocalAssignment>,
    pub baseline: Option<RemoteAssignment>,
}

#[derive(Debug, Serialize)]
pub struct LocalAssignment {
    pub title: String,
    pub description: String,
    pub due_at: Option<String>,
    pub status: String,
    pub submission_url: String,
}

#[derive(Debug, Serialize)]
pub struct ImportPreview {
    pub courses: Vec<CourseMatch>,
    pub items: Vec<ImportItem>,
}

#[derive(Debug, Deserialize)]
pub struct CourseChoice {
    pub remote_course_id: String,
    pub course_id: String,
    pub semester_id: String,
    pub new_name: String,
}

#[derive(Debug, Deserialize)]
pub struct ImportDecision {
    pub remote_course_id: String,
    pub remote_assignment_id: String,
    pub action: String,
    pub assignment_id: String,
    pub fields: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct ApplyImport {
    pub module_id: String,
    pub snapshot: RemoteSnapshot,
    pub courses: Vec<CourseChoice>,
    pub decisions: Vec<ImportDecision>,
}

/// Versioned, unambiguous source identity shared by independent devices.
pub(crate) fn source_id(kind: &str, parts: &[&str]) -> String {
    let key = format!("homework-manager/import/v1/{kind}/{}", serde_json::to_string(parts).expect("string array"));
    Uuid::new_v5(&Uuid::NAMESPACE_URL, key.as_bytes()).to_string()
}

pub fn initialize(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS assignment_import_course_map (
        module_id TEXT NOT NULL, account_key TEXT NOT NULL, remote_course_id TEXT NOT NULL,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        PRIMARY KEY(module_id,account_key,remote_course_id));
      CREATE TABLE IF NOT EXISTS assignment_import_links (
        module_id TEXT NOT NULL, account_key TEXT NOT NULL, remote_course_id TEXT NOT NULL,
        remote_assignment_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
        baseline TEXT NOT NULL,
        PRIMARY KEY(module_id,account_key,remote_course_id,remote_assignment_id),
        UNIQUE(module_id,assignment_id));
      CREATE TABLE IF NOT EXISTS assignment_import_ignored (
        module_id TEXT NOT NULL, account_key TEXT NOT NULL, remote_course_id TEXT NOT NULL,
        remote_assignment_id TEXT NOT NULL, baseline TEXT NOT NULL,
        PRIMARY KEY(module_id,account_key,remote_course_id,remote_assignment_id));",
    )
    .map_err(|e| e.to_string())
}

fn valid_key(s: &str) -> bool {
    !s.is_empty() && s.len() <= 120 && !s.chars().any(char::is_control)
}

fn validate(snapshot: &RemoteSnapshot) -> Result<(), String> {
    if snapshot.protocol != 1
        || !valid_key(&snapshot.account_key)
        || snapshot.courses.len() > 300
        || snapshot.assignments.len() > 2000
        || snapshot.warnings.len() > 100
    {
        return Err("导入快照版本或大小无效".into());
    }
    chrono::DateTime::parse_from_rfc3339(&snapshot.checked_at).map_err(|_| "检查时间无效")?;
    let mut course_ids = std::collections::HashSet::new();
    for c in &snapshot.courses {
        if !valid_key(&c.id)
            || c.name.trim().is_empty()
            || c.name.len() > 200
            || c.code.len() > 100
            || c.term.len() > 200
            || !course_ids.insert(&c.id)
        {
            return Err("课程数据无效或重复".into());
        }
    }
    let mut keys = std::collections::HashSet::new();
    for a in &snapshot.assignments {
        if !valid_key(&a.id)
            || !course_ids.contains(&a.course_id)
            || !keys.insert((&a.course_id, &a.id))
            || a.title.trim().is_empty()
            || a.title.len() > 500
            || a.description.len() > 10000
            || !["unknown", "submitted", "graded"].contains(&a.status.as_str())
            || a.url.len() > 2048
        {
            return Err("作业数据无效或重复".into());
        }
        if !a.url.is_empty() && !(a.url.starts_with("https://") && !a.url.contains('@')) {
            return Err("作业网址必须是 HTTPS".into());
        }
        if let Some(due) = &a.due_at {
            chrono::NaiveDateTime::parse_from_str(due, "%Y-%m-%dT%H:%M:%S")
                .map_err(|_| "截止时间无效")?;
        }
    }
    Ok(())
}

fn check_module(conn: &Connection, root: &std::path::Path, module_id: &str) -> Result<(), String> {
    if !modules::enabled(conn, module_id)?
        || !modules::external_has_capability(root, module_id, "assignment.sync.snapshot")
    {
        return Err("导入模块未安装、未启用或缺少同步能力".into());
    }
    Ok(())
}

#[tauri::command]
pub fn preview_assignment_import(
    state: State<'_, AppState>,
    module_id: String,
    snapshot: RemoteSnapshot,
) -> Result<ImportPreview, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    check_module(&conn, &state.modules_dir, &module_id)?;
    preview(&conn, &module_id, &snapshot)
}

fn preview(
    conn: &Connection,
    module_id: &str,
    snapshot: &RemoteSnapshot,
) -> Result<ImportPreview, String> {
    validate(snapshot)?;
    let mut courses = Vec::new();
    for remote in &snapshot.courses {
        let mapped = conn.query_row("SELECT course_id FROM assignment_import_course_map WHERE module_id=?1 AND account_key=?2 AND remote_course_id=?3",params![module_id,snapshot.account_key,remote.id],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?;
        let local_course_id = if let Some(id) = mapped {
            id
        } else {
            let mut stmt=conn.prepare("SELECT id FROM courses WHERE lower(name)=lower(?1) OR (code<>'' AND lower(code)=lower(?2))").map_err(|e|e.to_string())?;
            let found = stmt
                .query_map(params![remote.name, remote.code], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            if found.len() == 1 {
                found[0].clone()
            } else {
                String::new()
            }
        };
        courses.push(CourseMatch {
            remote: remote.clone(),
            local_course_id,
        });
    }
    let mut items = Vec::new();
    for remote in &snapshot.assignments {
        let link = conn.query_row("SELECT assignment_id,baseline FROM assignment_import_links WHERE module_id=?1 AND account_key=?2 AND remote_course_id=?3 AND remote_assignment_id=?4",params![module_id,snapshot.account_key,remote.course_id,remote.id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional().map_err(|e|e.to_string())?;
        let encoded = serde_json::to_string(remote).map_err(|e| e.to_string())?;
        if let Some((_, baseline)) = &link {
            if baseline == &encoded {
                continue;
            }
        }
        if link.is_none() {
            if remote.status != "unknown" {
                continue;
            }
            let ignored=conn.query_row("SELECT baseline FROM assignment_import_ignored WHERE module_id=?1 AND account_key=?2 AND remote_course_id=?3 AND remote_assignment_id=?4",params![module_id,snapshot.account_key,remote.course_id,remote.id],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?;
            if ignored.as_deref() == Some(&encoded) {
                continue;
            }
        }
        let local = if let Some((id, _)) = &link {
            conn.query_row("SELECT title,description,due_at,status,submission_url FROM assignments WHERE id=?1",[id],|r|Ok(LocalAssignment{title:r.get(0)?,description:r.get(1)?,due_at:r.get(2)?,status:r.get(3)?,submission_url:r.get(4)?})).optional().map_err(|e|e.to_string())?
        } else {
            None
        };
        let suggested_assignment_ids = if link.is_none() {
            let course_id = &courses
                .iter()
                .find(|c| c.remote.id == remote.course_id)
                .ok_or("课程不存在")?
                .local_course_id;
            if course_id.is_empty() {
                vec![]
            } else {
                let mut stmt=conn.prepare("SELECT id FROM assignments WHERE course_id=?1 AND lower(trim(title))=lower(trim(?2)) LIMIT 10").map_err(|e|e.to_string())?;
                let found = stmt
                    .query_map(params![course_id, remote.title], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                found
            }
        } else {
            vec![]
        };
        items.push(ImportItem {
            remote: remote.clone(),
            linked_assignment_id: link.as_ref().map(|x| x.0.clone()).unwrap_or_default(),
            suggested_assignment_ids,
            local,
            baseline: link.as_ref().and_then(|x| serde_json::from_str(&x.1).ok()),
        });
    }
    Ok(ImportPreview { courses, items })
}

#[tauri::command]
pub fn apply_assignment_import(
    state: State<'_, AppState>,
    payload: ApplyImport,
) -> Result<usize, String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    check_module(&conn, &state.modules_dir, &payload.module_id)?;
    apply(&mut conn, payload)
}

fn apply(conn: &mut Connection, payload: ApplyImport) -> Result<usize, String> {
    validate(&payload.snapshot)?;
    if payload.courses.len() > payload.snapshot.courses.len()
        || payload.decisions.len() > payload.snapshot.assignments.len()
    {
        return Err("审核数据数量无效".into());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut map = std::collections::HashMap::new();
    for choice in &payload.courses {
        let remote = payload
            .snapshot
            .courses
            .iter()
            .find(|c| c.id == choice.remote_course_id)
            .ok_or("未知来源课程")?;
        if map.contains_key(&remote.id) {
            return Err("课程选择重复".into());
        }
        let id = if !choice.course_id.is_empty() {
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM courses WHERE id=?1)",
                    [&choice.course_id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if !exists {
                return Err("所选课程已不存在".into());
            }
            choice.course_id.clone()
        } else {
            if choice.new_name.trim().is_empty() || choice.new_name.len() > 200 {
                return Err("新课程名称无效".into());
            }
            let mapped = tx.query_row("SELECT course_id FROM assignment_import_course_map WHERE module_id=?1 AND account_key=?2 AND remote_course_id=?3",params![payload.module_id,payload.snapshot.account_key,remote.id],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?;
            let id = mapped.unwrap_or_else(|| source_id("course", &[&payload.module_id,&payload.snapshot.account_key,&remote.id]));
            tx.execute(
                "INSERT OR IGNORE INTO courses(id,semester_id,name,code,folder_path) VALUES (?1,?2,?3,?4,'')",
                params![id, choice.semester_id, choice.new_name.trim(), remote.code],
            )
            .map_err(|e| e.to_string())?;
            id
        };
        tx.execute("INSERT INTO assignment_import_course_map(module_id,account_key,remote_course_id,course_id) VALUES (?1,?2,?3,?4) ON CONFLICT(module_id,account_key,remote_course_id) DO UPDATE SET course_id=excluded.course_id",params![payload.module_id,payload.snapshot.account_key,remote.id,id]).map_err(|e|e.to_string())?;
        map.insert(remote.id.clone(), id);
    }
    let mut used = std::collections::HashSet::new();
    let mut changed = 0;
    for decision in &payload.decisions {
        if !used.insert((&decision.remote_course_id, &decision.remote_assignment_id)) {
            return Err("作业审核重复".into());
        }
        let remote = payload
            .snapshot
            .assignments
            .iter()
            .find(|a| {
                a.course_id == decision.remote_course_id && a.id == decision.remote_assignment_id
            })
            .ok_or("未知来源作业")?;
        let encoded = serde_json::to_string(remote).map_err(|e| e.to_string())?;
        if decision.action == "defer" {
            continue;
        }
        let linked=tx.query_row("SELECT assignment_id FROM assignment_import_links WHERE module_id=?1 AND account_key=?2 AND remote_course_id=?3 AND remote_assignment_id=?4",params![payload.module_id,payload.snapshot.account_key,remote.course_id,remote.id],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?;
        if decision.action == "ignore" {
            if let Some(id) = linked {
                tx.execute("UPDATE assignment_import_links SET baseline=?1 WHERE module_id=?2 AND account_key=?3 AND remote_course_id=?4 AND remote_assignment_id=?5",params![encoded,payload.module_id,payload.snapshot.account_key,remote.course_id,remote.id]).map_err(|e|e.to_string())?;
                let _ = id;
            } else {
                tx.execute("INSERT INTO assignment_import_ignored(module_id,account_key,remote_course_id,remote_assignment_id,baseline) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(module_id,account_key,remote_course_id,remote_assignment_id) DO UPDATE SET baseline=excluded.baseline",params![payload.module_id,payload.snapshot.account_key,remote.course_id,remote.id,encoded]).map_err(|e|e.to_string())?;
            }
            continue;
        }
        let course_id = map.get(&remote.course_id).ok_or("请先匹配来源课程")?;
        let assignment_id = if decision.action == "create" {
            if linked.is_some() || remote.status != "unknown" {
                return Err("此作业不能新建".into());
            }
            let id = source_id("assignment", &[&payload.module_id,&payload.snapshot.account_key,&remote.course_id,&remote.id]);
            let now = db::now();
            tx.execute("INSERT INTO assignments(id,course_id,title,description,due_at,status,submission_label,submission_url,submission_notes,source_name,source_text,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,'todo','',?6,'',?7,'',?8,?8)",params![id,course_id,remote.title.trim(),remote.description,remote.due_at,remote.url,payload.module_id,now]).map_err(|e|e.to_string())?;
            id
        } else if decision.action == "link" || decision.action == "update" {
            let id = if let Some(id) = linked {
                if decision.action != "update" || decision.assignment_id != id {
                    return Err("关联作业不一致".into());
                }
                id
            } else {
                if decision.action != "link" || decision.assignment_id.is_empty() {
                    return Err("请选择要关联的作业".into());
                }
                decision.assignment_id.clone()
            };
            let actual_course: String = tx
                .query_row(
                    "SELECT course_id FROM assignments WHERE id=?1",
                    [&id],
                    |r| r.get(0),
                )
                .map_err(|_| "关联的作业不存在")?;
            if &actual_course != course_id {
                return Err("关联作业不属于所选课程".into());
            }
            if decision.fields.iter().any(|f| {
                !["title", "description", "due_at", "submission_url", "status"]
                    .contains(&f.as_str())
            }) {
                return Err("未知更新字段".into());
            }
            for field in &decision.fields {
                match field.as_str() {
                    "title" => {
                        tx.execute(
                            "UPDATE assignments SET title=?1,updated_at=?2 WHERE id=?3",
                            params![remote.title.trim(), db::now(), id],
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    "description" => {
                        tx.execute(
                            "UPDATE assignments SET description=?1,updated_at=?2 WHERE id=?3",
                            params![remote.description, db::now(), id],
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    "due_at" => {
                        tx.execute(
                            "UPDATE assignments SET due_at=?1,updated_at=?2 WHERE id=?3",
                            params![remote.due_at, db::now(), id],
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    "submission_url" => {
                        tx.execute(
                            "UPDATE assignments SET submission_url=?1,updated_at=?2 WHERE id=?3",
                            params![remote.url, db::now(), id],
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    "status" if remote.status == "submitted" || remote.status == "graded" => {
                        tx.execute(
                            "UPDATE assignments SET status='submitted',updated_at=?1 WHERE id=?2",
                            params![db::now(), id],
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    "status" => return Err("来源未确认提交".into()),
                    _ => unreachable!(),
                }
            }
            id
        } else {
            return Err("未知审核操作".into());
        };
        tx.execute("INSERT INTO assignment_import_links(module_id,account_key,remote_course_id,remote_assignment_id,assignment_id,baseline) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(module_id,account_key,remote_course_id,remote_assignment_id) DO UPDATE SET baseline=excluded.baseline",params![payload.module_id,payload.snapshot.account_key,remote.course_id,remote.id,assignment_id,encoded]).map_err(|e|e.to_string())?;
        tx.execute("DELETE FROM assignment_import_ignored WHERE module_id=?1 AND account_key=?2 AND remote_course_id=?3 AND remote_assignment_id=?4",params![payload.module_id,payload.snapshot.account_key,remote.course_id,remote.id]).map_err(|e|e.to_string())?;
        changed += 1;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;
          CREATE TABLE semesters(id TEXT PRIMARY KEY,name TEXT,source_root TEXT);
          INSERT INTO semesters VALUES('term','2026 秋季','');
          CREATE TABLE courses(id TEXT PRIMARY KEY,semester_id TEXT NOT NULL REFERENCES semesters(id),name TEXT NOT NULL,code TEXT NOT NULL,folder_path TEXT NOT NULL);
          INSERT INTO courses VALUES('course','term','Calculus','MA117','');
          CREATE TABLE assignments(id TEXT PRIMARY KEY,course_id TEXT NOT NULL REFERENCES courses(id),title TEXT NOT NULL,description TEXT NOT NULL,due_at TEXT,status TEXT NOT NULL,submission_label TEXT NOT NULL,submission_url TEXT NOT NULL,submission_notes TEXT NOT NULL,source_name TEXT NOT NULL,source_text TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);").unwrap();
        initialize(&conn).unwrap();
        conn
    }
    fn snapshot(status: &str, title: &str) -> RemoteSnapshot {
        RemoteSnapshot {
            protocol: 1,
            account_key: "account".into(),
            checked_at: "2026-09-28T01:00:00Z".into(),
            courses: vec![RemoteCourse {
                id: "remote-course".into(),
                name: "Calculus".into(),
                code: "MA117".into(),
                term: "2026 秋".into(),
            }],
            assignments: vec![RemoteAssignment {
                id: "remote-a".into(),
                course_id: "remote-course".into(),
                title: title.into(),
                description: "Read chapter 1".into(),
                due_at: None,
                status: status.into(),
                url: "https://lms.example.edu/task".into(),
            }],
            warnings: vec![],
        }
    }
    fn choice() -> CourseChoice {
        CourseChoice {
            remote_course_id: "remote-course".into(),
            course_id: "course".into(),
            semester_id: String::new(),
            new_name: String::new(),
        }
    }
    fn decision(action: &str, assignment_id: &str, fields: &[&str]) -> ImportDecision {
        ImportDecision {
            remote_course_id: "remote-course".into(),
            remote_assignment_id: "remote-a".into(),
            action: action.into(),
            assignment_id: assignment_id.into(),
            fields: fields.iter().map(|s| s.to_string()).collect(),
        }
    }
    #[test]
    fn independent_devices_use_the_same_source_identity() {
        let mut ids = Vec::new();
        for _ in 0..2 {
            let mut conn = database();
            apply(&mut conn, ApplyImport {
                module_id: "test.sync".into(), snapshot: snapshot("unknown", "Homework"),
                courses: vec![CourseChoice {remote_course_id:"remote-course".into(),course_id:String::new(),semester_id:"term".into(),new_name:"New course".into()}],
                decisions: vec![decision("create", "", &[])],
            }).unwrap();
            ids.push(conn.query_row("SELECT course_id,assignment_id FROM assignment_import_links JOIN assignment_import_course_map USING(module_id,account_key,remote_course_id)",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap());
        }
        assert_eq!(ids[0], ids[1]);
        assert_ne!(ids[0].0, ids[0].1);
        // JSON arrays prevent ambiguous delimiter-containing source keys.
        assert_ne!(source_id("assignment", &["a:b", "c"]), source_id("assignment", &["a", "b:c"]));
    }

    #[test]
    fn existing_random_source_mapping_ids_are_preserved() {
        let mut conn = database();
        conn.execute("INSERT INTO assignment_import_course_map VALUES('test.sync','account','remote-course','course')",[]).unwrap();
        conn.execute("INSERT INTO assignments VALUES('legacy-random-id','course','Old','',NULL,'todo','','','','test.sync','','now','now')",[]).unwrap();
        conn.execute("INSERT INTO assignment_import_links VALUES('test.sync','account','remote-course','remote-a','legacy-random-id','{}')",[]).unwrap();
        apply(&mut conn, ApplyImport {
            module_id:"test.sync".into(),snapshot:snapshot("unknown","Updated"),
            courses:vec![CourseChoice{remote_course_id:"remote-course".into(),course_id:String::new(),semester_id:"term".into(),new_name:"Unused".into()}],
            decisions:vec![decision("update","legacy-random-id",&["title"])],
        }).unwrap();
        assert_eq!(conn.query_row("SELECT id FROM assignments",[],|r|r.get::<_,String>(0)).unwrap(),"legacy-random-id");
        assert_eq!(conn.query_row("SELECT course_id FROM assignment_import_course_map",[],|r|r.get::<_,String>(0)).unwrap(),"course");
        assert_eq!(conn.query_row("SELECT count(*) FROM courses",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }

    #[test]
    fn repeated_scan_and_submitted_change_require_review() {
        let mut conn = database();
        let first = snapshot("unknown", "Homework 1");
        assert_eq!(preview(&conn, "test.sync", &first).unwrap().items.len(), 1);
        assert_eq!(
            apply(
                &mut conn,
                ApplyImport {
                    module_id: "test.sync".into(),
                    snapshot: first.clone(),
                    courses: vec![choice()],
                    decisions: vec![decision("create", "", &[])]
                }
            )
            .unwrap(),
            1
        );
        assert!(preview(&conn, "test.sync", &first)
            .unwrap()
            .items
            .is_empty());
        let id: String = conn
            .query_row("SELECT id FROM assignments", [], |r| r.get(0))
            .unwrap();
        let (label, source): (String, String) = conn.query_row(
            "SELECT submission_label,source_name FROM assignments WHERE id=?1", [&id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert!(label.is_empty(), "generic imports must not invent a submission platform");
        assert_eq!(source, "test.sync");
        conn.execute(
            "UPDATE assignments SET title='My edited title' WHERE id=?1",
            [&id],
        )
        .unwrap();
        let submitted = snapshot("submitted", "Homework 1 revised");
        let pending = preview(&conn, "test.sync", &submitted).unwrap();
        assert_eq!(pending.items.len(), 1);
        assert_eq!(
            pending.items[0].local.as_ref().unwrap().title,
            "My edited title"
        );
        apply(
            &mut conn,
            ApplyImport {
                module_id: "test.sync".into(),
                snapshot: submitted.clone(),
                courses: vec![choice()],
                decisions: vec![decision("update", &id, &["status"])],
            },
        )
        .unwrap();
        let (title, status): (String, String) = conn
            .query_row(
                "SELECT title,status FROM assignments WHERE id=?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "My edited title");
        assert_eq!(status, "submitted");
        assert!(preview(&conn, "test.sync", &submitted)
            .unwrap()
            .items
            .is_empty());
    }
    #[test]
    fn manual_match_and_ignored_revision_do_not_duplicate() {
        let mut conn = database();
        conn.execute("INSERT INTO assignments VALUES('manual','course','Homework 1','','','todo','','','','','','','')",[]).unwrap();
        let first = snapshot("unknown", "Homework 1");
        let pending = preview(&conn, "test.sync", &first).unwrap();
        assert_eq!(pending.items[0].suggested_assignment_ids, vec!["manual"]);
        apply(
            &mut conn,
            ApplyImport {
                module_id: "test.sync".into(),
                snapshot: first.clone(),
                courses: vec![choice()],
                decisions: vec![decision("link", "manual", &[])],
            },
        )
        .unwrap();
        let revised = snapshot("unknown", "Homework 1 updated");
        assert_eq!(
            preview(&conn, "test.sync", &revised).unwrap().items.len(),
            1
        );
        apply(
            &mut conn,
            ApplyImport {
                module_id: "test.sync".into(),
                snapshot: revised.clone(),
                courses: vec![],
                decisions: vec![decision("ignore", "", &[])],
            },
        )
        .unwrap();
        assert!(preview(&conn, "test.sync", &revised)
            .unwrap()
            .items
            .is_empty());
        assert_eq!(
            conn.query_row("SELECT count(*) FROM assignments", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn invalid_decision_rolls_back_new_course() {
        let mut conn = database();
        let snapshot = snapshot("unknown", "Homework 1");
        let result = apply(
            &mut conn,
            ApplyImport {
                module_id: "test.sync".into(),
                snapshot,
                courses: vec![CourseChoice {
                    remote_course_id: "remote-course".into(),
                    course_id: String::new(),
                    semester_id: "term".into(),
                    new_name: "New".into(),
                }],
                decisions: vec![decision("update", "missing", &[])],
            },
        );
        assert!(result.is_err());
        assert_eq!(
            conn.query_row("SELECT count(*) FROM courses", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM assignment_import_course_map",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
}
