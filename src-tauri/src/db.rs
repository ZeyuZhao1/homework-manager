use rusqlite::{params, Connection, OptionalExtension, MAIN_DB};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, sync::Mutex};
use tauri::{Manager, State};
use uuid::Uuid;

pub struct AppState {
    pub db: Mutex<Connection>,
    pub modules_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Semester {
    pub id: String,
    pub name: String,
    pub source_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Course {
    pub id: String,
    pub semester_id: String,
    pub name: String,
    pub code: String,
    pub folder_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Assignment {
    pub id: String,
    pub course_id: String,
    pub title: String,
    pub description: String,
    pub due_at: Option<String>,
    pub status: String,
    pub submission_label: String,
    pub submission_url: String,
    pub submission_notes: String,
    pub source_name: String,
    pub source_text: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub custom_fields: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommonFile {
    pub course_id: String,
    pub file_id: String,
    pub kind: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileAsset {
    pub id: String,
    pub path: String,
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileLink {
    pub id: String,
    pub assignment_id: String,
    pub file_id: String,
    pub role: String,
    pub page: String,
    pub chapter: String,
    pub problem: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameEvent {
    pub id: String,
    pub file_id: String,
    pub old_path: String,
    pub new_path: String,
    pub changed_at: String,
    pub undone_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileHistoryEvent {
    pub id: String,
    pub file_id: String,
    pub link_id: String,
    pub assignment_id: String,
    pub assignment_title: String,
    pub event_type: String,
    pub path: String,
    pub details: String,
    pub file_size: Option<i64>,
    pub modified_at_ms: Option<i64>,
    pub occurred_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub theme: String,
    pub naming_template: String,
}

#[derive(Debug, Serialize)]
pub struct Snapshot {
    pub semesters: Vec<Semester>,
    pub courses: Vec<Course>,
    pub assignments: Vec<Assignment>,
    pub files: Vec<FileAsset>,
    pub links: Vec<FileLink>,
    pub common_files: Vec<CommonFile>,
    pub renames: Vec<RenameEvent>,
    pub file_history: Vec<FileHistoryEvent>,
    pub settings: Settings,
    pub recent_values: HashMap<String, Vec<String>>,
}

pub fn now() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

pub fn id_or_new(id: &str) -> String {
    if id.trim().is_empty() { Uuid::new_v4().to_string() } else { id.to_owned() }
}

pub fn init(app: &tauri::AppHandle) -> Result<AppState, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let modules_dir = data_dir.join("modules");
    std::fs::create_dir_all(&modules_dir).map_err(|e| e.to_string())?;
    let path = data_dir.join("homework.db");
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA foreign_keys=ON;
         PRAGMA journal_mode=WAL;
         PRAGMA journal_size_limit=1048576;
         PRAGMA wal_autocheckpoint=100;
         CREATE TABLE IF NOT EXISTS semesters (id TEXT PRIMARY KEY, name TEXT NOT NULL, source_root TEXT NOT NULL DEFAULT '');
         CREATE TABLE IF NOT EXISTS courses (id TEXT PRIMARY KEY, semester_id TEXT NOT NULL REFERENCES semesters(id) ON DELETE CASCADE, name TEXT NOT NULL, code TEXT NOT NULL DEFAULT '', folder_path TEXT NOT NULL DEFAULT '');
         CREATE TABLE IF NOT EXISTS assignments (id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', due_at TEXT, status TEXT NOT NULL DEFAULT 'todo', submission_label TEXT NOT NULL DEFAULT '', submission_url TEXT NOT NULL DEFAULT '', submission_notes TEXT NOT NULL DEFAULT '', source_name TEXT NOT NULL DEFAULT '', source_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS assignments_by_course_due ON assignments(course_id, due_at);
         CREATE TABLE IF NOT EXISTS file_assets (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE);
         CREATE TABLE IF NOT EXISTS assignment_files (id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE, file_id TEXT NOT NULL REFERENCES file_assets(id) ON DELETE CASCADE, role TEXT NOT NULL, page TEXT NOT NULL DEFAULT '', chapter TEXT NOT NULL DEFAULT '', problem TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '');
         CREATE INDEX IF NOT EXISTS assignment_files_by_assignment ON assignment_files(assignment_id);
         CREATE TABLE IF NOT EXISTS rename_history (id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES file_assets(id) ON DELETE CASCADE, old_path TEXT NOT NULL, new_path TEXT NOT NULL, file_size INTEGER NOT NULL, modified_at_ms INTEGER NOT NULL, changed_at TEXT NOT NULL, undone_at TEXT);
         CREATE TABLE IF NOT EXISTS file_history (id TEXT PRIMARY KEY, file_id TEXT NOT NULL, link_id TEXT NOT NULL DEFAULT '', assignment_id TEXT NOT NULL DEFAULT '', assignment_title TEXT NOT NULL DEFAULT '', event_type TEXT NOT NULL, path TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', file_size INTEGER, modified_at_ms INTEGER, occurred_at TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS file_history_by_file_time ON file_history(file_id, occurred_at DESC);
         CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS recent_values (field TEXT NOT NULL, value TEXT NOT NULL, used_at TEXT NOT NULL, PRIMARY KEY(field,value));
         CREATE TABLE IF NOT EXISTS assignment_custom_fields (assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE, field_key TEXT NOT NULL, field_value TEXT NOT NULL, PRIMARY KEY(assignment_id,field_key));
         CREATE TABLE IF NOT EXISTS common_files (course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, file_id TEXT NOT NULL REFERENCES file_assets(id) ON DELETE CASCADE, kind TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY(course_id,file_id));
         CREATE TABLE IF NOT EXISTS module_states (module_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
         PRAGMA user_version=4;"
    ).map_err(|e| e.to_string())?;
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM semesters", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if count == 0 {
        let root = PathBuf::from(r"D:\share\University\Year 1 Fall");
        let semester_id = Uuid::new_v4().to_string();
        conn.execute("INSERT INTO semesters(id,name,source_root) VALUES (?1,'2026 秋季',?2)", params![semester_id, if root.is_dir() { root.to_string_lossy().to_string() } else { String::new() }]).map_err(|e| e.to_string())?;
        for folder in ["思政", "Calculus", "Earth Science", "Linear Algebra", "Physics"] {
            let path = root.join(folder);
            if path.is_dir() {
                let code = match folder { "Calculus" => "MA117", "Linear Algebra" => "MA113", "Physics" => "PHY105", _ => "" };
                conn.execute("INSERT INTO courses(id,semester_id,name,code,folder_path) VALUES (?1,?2,?3,?4,?5)", params![Uuid::new_v4().to_string(), semester_id, folder, code, path.to_string_lossy().to_string()]).map_err(|e| e.to_string())?;
            }
        }
    }
    for (folder,code) in [("Calculus","MA117"),("Linear Algebra","MA113"),("Physics","PHY105")] {
        let course_path = PathBuf::from(r"D:\share\University\Year 1 Fall").join(folder).to_string_lossy().to_string();
        conn.execute("UPDATE courses SET code=?1 WHERE name=?2 AND code='' AND folder_path=?3", params![code,folder,course_path]).map_err(|e| e.to_string())?;
    }
    conn.execute("UPDATE settings SET value='{course_code}-{material}-hw-{scope}' WHERE key='naming_template' AND value IN ('{course}-{assignment}-{role}-v{version}','{course_code}-{material}-hw-{sections}')", []).map_err(|e| e.to_string())?;
    conn.execute_batch("INSERT OR IGNORE INTO recent_values(field,value,used_at) SELECT 'title',trim(title),updated_at FROM assignments WHERE trim(title)<>'';
        INSERT OR IGNORE INTO recent_values(field,value,used_at) SELECT 'submission_label',trim(submission_label),updated_at FROM assignments WHERE trim(submission_label)<>'';
        INSERT OR IGNORE INTO recent_values(field,value,used_at) SELECT 'submission_url',trim(submission_url),updated_at FROM assignments WHERE trim(submission_url)<>'';
        INSERT OR IGNORE INTO recent_values(field,value,used_at) SELECT 'submission_notes',trim(submission_notes),updated_at FROM assignments WHERE trim(submission_notes)<>'';").map_err(|e| e.to_string())?;
    prune_unused_files(&conn)?;
    crate::modules::initialize(&conn, &data_dir)?;
    Ok(AppState { db: Mutex::new(conn), modules_dir })
}

pub fn prune_unused_files(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM file_assets WHERE id NOT IN (SELECT file_id FROM assignment_files) AND id NOT IN (SELECT file_id FROM rename_history) AND id NOT IN (SELECT file_id FROM common_files) AND id NOT IN (SELECT file_id FROM file_history)", []).map_err(|e| e.to_string())?;
    Ok(())
}

fn setting(conn: &Connection, key: &str, fallback: &str) -> Result<String, String> {
    Ok(conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0)).optional().map_err(|e| e.to_string())?.unwrap_or_else(|| fallback.to_owned()))
}

pub fn current_settings(conn: &Connection) -> Result<Settings, String> {
    Ok(Settings {
        theme: setting(conn, "theme", "light")?,
        naming_template: setting(conn, "naming_template", "{course_code}-{material}-hw-{scope}")?,
    })
}

pub fn course_identifiers(conn: &Connection) -> Result<Vec<(String,String,String)>, String> {
    conn.prepare("SELECT id,name,code FROM courses ORDER BY name,code").map_err(|e| e.to_string())?
        .query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_snapshot(state: State<'_, AppState>) -> Result<Snapshot, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let semesters = conn.prepare("SELECT id,name,source_root FROM semesters ORDER BY name DESC").map_err(|e| e.to_string())?
        .query_map([], |r| Ok(Semester { id: r.get(0)?, name: r.get(1)?, source_root: r.get(2)? })).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    let courses = conn.prepare("SELECT id,semester_id,name,code,folder_path FROM courses ORDER BY name").map_err(|e| e.to_string())?
        .query_map([], |r| Ok(Course { id:r.get(0)?, semester_id:r.get(1)?, name:r.get(2)?, code:r.get(3)?, folder_path:r.get(4)? })).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    let mut assignments = conn.prepare("SELECT id,course_id,title,description,due_at,status,submission_label,submission_url,submission_notes,source_name,source_text,created_at,updated_at FROM assignments ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,due_at,title").map_err(|e| e.to_string())?
        .query_map([], |r| Ok(Assignment { id:r.get(0)?,course_id:r.get(1)?,title:r.get(2)?,description:r.get(3)?,due_at:r.get(4)?,status:r.get(5)?,submission_label:r.get(6)?,submission_url:r.get(7)?,submission_notes:r.get(8)?,source_name:r.get(9)?,source_text:r.get(10)?,created_at:r.get(11)?,updated_at:r.get(12)?,custom_fields:HashMap::new() })).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    let mut custom_fields: HashMap<String,HashMap<String,String>> = HashMap::new();
    let mut stmt = conn.prepare("SELECT assignment_id,field_key,field_value FROM assignment_custom_fields").map_err(|e| e.to_string())?;
    for row in stmt.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).map_err(|e| e.to_string())? {
        let (id,key,value) = row.map_err(|e| e.to_string())?;
        custom_fields.entry(id).or_default().insert(key,value);
    }
    for assignment in &mut assignments { assignment.custom_fields = custom_fields.remove(&assignment.id).unwrap_or_default(); }
    let files = conn.prepare("SELECT id,path FROM file_assets ORDER BY path").map_err(|e| e.to_string())?
        .query_map([], |r| { let path: String = r.get(1)?; Ok(FileAsset { id:r.get(0)?, missing: !std::path::Path::new(&path).is_file(), path }) }).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    for file in files.iter().filter(|file| !file.missing) {
        let Ok(metadata) = std::fs::metadata(&file.path) else { continue };
        let Ok(modified) = metadata.modified() else { continue };
        let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) else { continue };
        let modified_at_ms = duration.as_millis() as i64;
        let current = (metadata.len() as i64, modified_at_ms);
        let previous = conn.query_row("SELECT file_size,modified_at_ms FROM file_history WHERE file_id=?1 AND file_size IS NOT NULL AND modified_at_ms IS NOT NULL ORDER BY occurred_at DESC,rowid DESC LIMIT 1", [&file.id], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?))).optional().map_err(|e| e.to_string())?;
        match previous {
            None => crate::files::record_file_history(&conn,&file.id,"","","tracking_started",&file.path,"开始记录文件大小和修改时间")?,
            Some(old) if old != current => crate::files::record_file_history(&conn,&file.id,"","","content_changed",&file.path,&format!("文件状态发生变化（原大小 {} 字节）",old.0))?,
            _ => {}
        }
    }
    let links = conn.prepare("SELECT id,assignment_id,file_id,role,page,chapter,problem,note FROM assignment_files").map_err(|e| e.to_string())?
        .query_map([], |r| Ok(FileLink { id:r.get(0)?,assignment_id:r.get(1)?,file_id:r.get(2)?,role:r.get(3)?,page:r.get(4)?,chapter:r.get(5)?,problem:r.get(6)?,note:r.get(7)? })).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    let common_files = conn.prepare("SELECT course_id,file_id,kind,label FROM common_files ORDER BY kind,label").map_err(|e| e.to_string())?
        .query_map([], |r| Ok(CommonFile { course_id:r.get(0)?, file_id:r.get(1)?, kind:r.get(2)?, label:r.get(3)? })).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    let renames = conn.prepare("SELECT id,file_id,old_path,new_path,changed_at,undone_at FROM rename_history ORDER BY changed_at DESC LIMIT 100").map_err(|e| e.to_string())?
        .query_map([], |r| Ok(RenameEvent { id:r.get(0)?,file_id:r.get(1)?,old_path:r.get(2)?,new_path:r.get(3)?,changed_at:r.get(4)?,undone_at:r.get(5)? })).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    let file_history = conn.prepare("SELECT id,file_id,link_id,assignment_id,assignment_title,event_type,path,details,file_size,modified_at_ms,occurred_at FROM file_history ORDER BY occurred_at DESC,rowid DESC LIMIT 1000").map_err(|e| e.to_string())?
        .query_map([], |r| Ok(FileHistoryEvent { id:r.get(0)?,file_id:r.get(1)?,link_id:r.get(2)?,assignment_id:r.get(3)?,assignment_title:r.get(4)?,event_type:r.get(5)?,path:r.get(6)?,details:r.get(7)?,file_size:r.get(8)?,modified_at_ms:r.get(9)?,occurred_at:r.get(10)? })).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    let mut recent_values: HashMap<String,Vec<String>> = HashMap::new();
    let mut stmt = conn.prepare("SELECT field,value FROM recent_values ORDER BY used_at DESC,rowid DESC").map_err(|e| e.to_string())?;
    for row in stmt.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|e| e.to_string())? {
        let (field,value) = row.map_err(|e| e.to_string())?;
        let values = recent_values.entry(field).or_default();
        if values.len() < 12 { values.push(value); }
    }
    Ok(Snapshot { semesters,courses,assignments,files,links,common_files,renames,file_history,settings:current_settings(&conn)?,recent_values })
}

pub fn remember_value(conn: &Connection, field: &str, value: &str) -> Result<(), String> {
    let value = value.trim();
    if !value.is_empty() && value.len() <= 500 {
        conn.execute("INSERT INTO recent_values(field,value,used_at) VALUES (?1,?2,?3) ON CONFLICT(field,value) DO UPDATE SET used_at=excluded.used_at", params![field,value,now()]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn save_semester(state: State<'_, AppState>, mut payload: Semester) -> Result<String, String> {
    payload.id = id_or_new(&payload.id);
    if payload.name.trim().is_empty() { return Err("学期名称不能为空".into()); }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO semesters(id,name,source_root) VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET name=excluded.name,source_root=excluded.source_root", params![payload.id,payload.name.trim(),payload.source_root.trim()]).map_err(|e| e.to_string())?;
    Ok(payload.id)
}

#[tauri::command]
pub fn delete_semester(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let semester_count: i64 = conn.query_row("SELECT COUNT(*) FROM semesters", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if semester_count <= 1 { return Err("至少需要保留一个学期".into()); }
    let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM semesters WHERE id=?1)", [&id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !exists { return Err("学期不存在或已被删除".into()); }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let affected = {
        let mut stmt = tx.prepare("SELECT l.id,l.assignment_id,l.file_id,f.path FROM assignment_files l JOIN file_assets f ON f.id=l.file_id JOIN assignments a ON a.id=l.assignment_id JOIN courses c ON c.id=a.course_id WHERE c.semester_id=?1").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([&id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?
    };
    for (link_id,assignment_id,file_id,path) in affected {
        crate::files::record_file_history(&tx,&file_id,&link_id,&assignment_id,"unlinked",&path,"因删除学期移除关联")?;
    }
    let common_files = {
        let mut stmt = tx.prepare("SELECT cf.file_id,f.path,cf.label FROM common_files cf JOIN file_assets f ON f.id=cf.file_id JOIN courses c ON c.id=cf.course_id WHERE c.semester_id=?1").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([&id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?
    };
    for (file_id,path,label) in common_files {
        crate::files::record_file_history(&tx,&file_id,"","","common_removed",&path,&format!("删除学期时取消常用文件：{label}"))?;
    }
    tx.execute("DELETE FROM semesters WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    prune_unused_files(&tx)?;
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_course(state: State<'_, AppState>, mut payload: Course) -> Result<String, String> {
    payload.id = id_or_new(&payload.id);
    if payload.name.trim().is_empty() { return Err("课程名称不能为空".into()); }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO courses(id,semester_id,name,code,folder_path) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET semester_id=excluded.semester_id,name=excluded.name,code=excluded.code,folder_path=excluded.folder_path", params![payload.id,payload.semester_id,payload.name.trim(),payload.code.trim(),payload.folder_path.trim()]).map_err(|e| e.to_string())?;
    Ok(payload.id)
}

#[tauri::command]
pub fn save_assignment(state: State<'_, AppState>, mut payload: Assignment) -> Result<String, String> {
    payload.id = id_or_new(&payload.id);
    if payload.title.trim().is_empty() { return Err("作业标题不能为空".into()); }
    if !["todo","doing","done","submitted"].contains(&payload.status.as_str()) { return Err("无效的作业状态".into()); }
    if payload.custom_fields.len() > 40 || payload.custom_fields.iter().any(|(k,v)| k.trim().is_empty() || k.len() > 80 || v.len() > 4000) { return Err("自定义字段数量或长度超出限制".into()); }
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let created = tx.query_row("SELECT created_at FROM assignments WHERE id=?1", [&payload.id], |r| r.get::<_,String>(0)).optional().map_err(|e| e.to_string())?.unwrap_or_else(now);
    let updated = now();
    tx.execute("INSERT INTO assignments(id,course_id,title,description,due_at,status,submission_label,submission_url,submission_notes,source_name,source_text,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(id) DO UPDATE SET course_id=excluded.course_id,title=excluded.title,description=excluded.description,due_at=excluded.due_at,status=excluded.status,submission_label=excluded.submission_label,submission_url=excluded.submission_url,submission_notes=excluded.submission_notes,source_name=excluded.source_name,source_text=excluded.source_text,updated_at=excluded.updated_at", params![payload.id,payload.course_id,payload.title.trim(),payload.description,payload.due_at.filter(|v| !v.is_empty()),payload.status,payload.submission_label,payload.submission_url,payload.submission_notes,payload.source_name,payload.source_text,created,updated]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM assignment_custom_fields WHERE assignment_id=?1", [&payload.id]).map_err(|e| e.to_string())?;
    for (key,value) in &payload.custom_fields {
        tx.execute("INSERT INTO assignment_custom_fields(assignment_id,field_key,field_value) VALUES (?1,?2,?3)", params![payload.id,key.trim(),value]).map_err(|e| e.to_string())?;
    }
    for (field,value) in [("title",&payload.title),("submission_label",&payload.submission_label),("submission_url",&payload.submission_url),("submission_notes",&payload.submission_notes)] { remember_value(&tx,field,value)?; }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(payload.id)
}

#[derive(Debug, Deserialize)]
pub struct BatchAssignmentInput {
    assignments: Vec<Assignment>,
    paths: Vec<String>,
    file_role: String,
}

#[tauri::command]
pub fn save_assignments_batch(state: State<'_, AppState>, payload: BatchAssignmentInput) -> Result<Vec<String>, String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    save_assignments_batch_impl(&mut conn, payload)
}

fn save_assignments_batch_impl(conn: &mut Connection, payload: BatchAssignmentInput) -> Result<Vec<String>, String> {
    if payload.assignments.is_empty() { return Err("没有可创建的作业".into()); }
    if !["prompt","reference","solution"].contains(&payload.file_role.as_str()) { return Err("无效的文件角色".into()); }
    for item in &payload.assignments {
        if item.title.trim().is_empty() || item.course_id.trim().is_empty() { return Err("请为每条作业确认课程和标题".into()); }
        if !["todo","doing","done","submitted"].contains(&item.status.as_str()) { return Err("无效的作业状态".into()); }
    }
    let paths = payload.paths.iter().map(|path| {
        let canonical = std::fs::canonicalize(path).map_err(|_| format!("文件不存在：{path}"))?;
        if !canonical.is_file() { return Err(format!("请选择文件：{path}")); }
        Ok(crate::files::normal_path(&canonical))
    }).collect::<Result<Vec<_>, String>>()?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut ids = Vec::with_capacity(payload.assignments.len());
    for item in &payload.assignments {
        let id = Uuid::new_v4().to_string();
        let timestamp = now();
        tx.execute("INSERT INTO assignments(id,course_id,title,description,due_at,status,submission_label,submission_url,submission_notes,source_name,source_text,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12)", params![id,item.course_id,item.title.trim(),item.description,item.due_at,item.status,item.submission_label,item.submission_url,item.submission_notes,item.source_name,item.source_text,timestamp]).map_err(|e| e.to_string())?;
        for (field,value) in [("title",&item.title),("submission_label",&item.submission_label),("submission_url",&item.submission_url),("submission_notes",&item.submission_notes)] { remember_value(&tx,field,value)?; }
        for path in &paths {
            tx.execute("INSERT OR IGNORE INTO file_assets(id,path) VALUES (?1,?2)", params![Uuid::new_v4().to_string(),path]).map_err(|e| e.to_string())?;
            let file_id: String = tx.query_row("SELECT id FROM file_assets WHERE path=?1", [path], |r| r.get(0)).map_err(|e| e.to_string())?;
            let link_id = Uuid::new_v4().to_string();
            tx.execute("INSERT INTO assignment_files(id,assignment_id,file_id,role) VALUES (?1,?2,?3,?4)", params![link_id,id,file_id,payload.file_role]).map_err(|e| e.to_string())?;
            crate::files::record_file_history(&tx,&file_id,&link_id,&id,"linked",path,&format!("角色：{}",payload.file_role))?;
        }
        ids.push(id);
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ids)
}

#[tauri::command]
pub fn delete_assignment(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let affected = {
        let mut stmt = conn.prepare("SELECT l.id,l.file_id,f.path FROM assignment_files l JOIN file_assets f ON f.id=l.file_id WHERE l.assignment_id=?1").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([&id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?
    };
    for (link_id,file_id,path) in affected {
        crate::files::record_file_history(&conn,&file_id,&link_id,&id,"unlinked",&path,"因删除作业移除关联")?;
    }
    conn.execute("DELETE FROM assignments WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    prune_unused_files(&conn)?;
    Ok(())
}

#[tauri::command]
pub fn compact_database(state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    prune_unused_files(&conn)?;
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, payload: Settings) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    for (key,value) in [("theme",payload.theme),("naming_template",payload.naming_template)] {
        conn.execute("INSERT INTO settings(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,value]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn backup_database(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    backup_impl(&conn, &path)
}

fn backup_impl(conn: &Connection, path: &str) -> Result<(), String> {
    if path.trim().is_empty() { return Err("请选择备份路径".into()); }
    conn.backup(MAIN_DB, path, None).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn restore_database(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    restore_impl(&mut conn, &path)?;
    let data_dir = state.modules_dir.parent().ok_or("模块目录无效")?;
    crate::modules::initialize(&conn, data_dir)
}

fn restore_impl(conn: &mut Connection, path: &str) -> Result<(), String> {
    let source = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    let check: String = source.query_row("PRAGMA integrity_check", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if check != "ok" { return Err("备份数据库完整性检查失败".into()); }
    let version: i64 = source.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !(1..=4).contains(&version) { return Err("备份数据库版本不兼容".into()); }
    conn.restore(MAIN_DB, path, None::<fn(rusqlite::backup::Progress)>).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA foreign_keys=ON").map_err(|e| e.to_string())?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS recent_values (field TEXT NOT NULL, value TEXT NOT NULL, used_at TEXT NOT NULL, PRIMARY KEY(field,value));
        CREATE TABLE IF NOT EXISTS assignment_custom_fields (assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE, field_key TEXT NOT NULL, field_value TEXT NOT NULL, PRIMARY KEY(assignment_id,field_key));
        CREATE TABLE IF NOT EXISTS common_files (course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, file_id TEXT NOT NULL REFERENCES file_assets(id) ON DELETE CASCADE, kind TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY(course_id,file_id));
        CREATE TABLE IF NOT EXISTS file_history (id TEXT PRIMARY KEY, file_id TEXT NOT NULL, link_id TEXT NOT NULL DEFAULT '', assignment_id TEXT NOT NULL DEFAULT '', assignment_title TEXT NOT NULL DEFAULT '', event_type TEXT NOT NULL, path TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', file_size INTEGER, modified_at_ms INTEGER, occurred_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS file_history_by_file_time ON file_history(file_id, occurred_at DESC);
        CREATE TABLE IF NOT EXISTS module_states (module_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
        PRAGMA user_version=4; PRAGMA journal_size_limit=1048576; PRAGMA wal_autocheckpoint=100;").map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn batch_creates_multiple_assignments_with_one_shared_file_atomically() {
        let dir = std::env::temp_dir().join(format!("homeworkbook-batch-{}",Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let attachment = dir.join("sheet.pdf");
        std::fs::write(&attachment,b"sample").unwrap();
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;
          CREATE TABLE courses(id TEXT PRIMARY KEY);
          INSERT INTO courses VALUES('course');
          CREATE TABLE assignments(id TEXT PRIMARY KEY,course_id TEXT REFERENCES courses(id),title TEXT,description TEXT,due_at TEXT,status TEXT,submission_label TEXT,submission_url TEXT,submission_notes TEXT,source_name TEXT,source_text TEXT,created_at TEXT,updated_at TEXT);
          CREATE TABLE file_assets(id TEXT PRIMARY KEY,path TEXT UNIQUE);
          CREATE TABLE assignment_files(id TEXT PRIMARY KEY,assignment_id TEXT,file_id TEXT,role TEXT);
          CREATE TABLE file_history(id TEXT PRIMARY KEY,file_id TEXT,link_id TEXT,assignment_id TEXT,assignment_title TEXT,event_type TEXT,path TEXT,details TEXT,file_size INTEGER,modified_at_ms INTEGER,occurred_at TEXT);
          CREATE TABLE recent_values(field TEXT,value TEXT,used_at TEXT,PRIMARY KEY(field,value));").unwrap();
        let make = |title: &str, course_id: &str| Assignment { id:String::new(),course_id:course_id.into(),title:title.into(),description:String::new(),due_at:None,status:"todo".into(),submission_label:String::new(),submission_url:String::new(),submission_notes:String::new(),source_name:"notice".into(),source_text:String::new(),created_at:String::new(),updated_at:String::new(),custom_fields:HashMap::new() };
        let paths = vec![attachment.to_string_lossy().to_string()];
        let ids = save_assignments_batch_impl(&mut conn,BatchAssignmentInput{assignments:vec![make("One","course"),make("Two","course")],paths:paths.clone(),file_role:"prompt".into()}).unwrap();
        assert_eq!(ids.len(),2);
        fn count(conn: &Connection, table: &str) -> i64 { conn.query_row(&format!("SELECT COUNT(*) FROM {table}"),[],|r|r.get(0)).unwrap() }
        assert_eq!(count(&conn,"assignments"),2);
        assert_eq!(count(&conn,"assignment_files"),2);
        assert_eq!(count(&conn,"file_assets"),1);
        assert!(save_assignments_batch_impl(&mut conn,BatchAssignmentInput{assignments:vec![make("Three","course"),make("Bad","missing")],paths,file_role:"prompt".into()}).is_err());
        assert_eq!(count(&conn,"assignments"),2);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn backup_and_restore_records() {
        let dir = std::env::temp_dir().join(format!("homeworkbook-db-test-{}",Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let db_path = dir.join("active.db");
        let backup_path = dir.join("backup.db");
        let mut conn = Connection::open(&db_path).unwrap();
        conn.execute_batch("CREATE TABLE test_records(name TEXT); INSERT INTO test_records VALUES('original');
            CREATE TABLE assignment_custom_fields(assignment_id TEXT,field_key TEXT,field_value TEXT);
            INSERT INTO assignment_custom_fields VALUES('a','教学周','第 3 周');
            CREATE TABLE common_files(course_id TEXT,file_id TEXT,kind TEXT,label TEXT);
            INSERT INTO common_files VALUES('c','f','textbook','课本');
            PRAGMA user_version=2;").unwrap();
        backup_impl(&conn,&backup_path.to_string_lossy()).unwrap();
        conn.execute("INSERT INTO test_records VALUES('later')",[]).unwrap();
        restore_impl(&mut conn,&backup_path.to_string_lossy()).unwrap();
        let names: Vec<String> = conn.prepare("SELECT name FROM test_records").unwrap().query_map([],|row|row.get(0)).unwrap().collect::<Result<_,_>>().unwrap();
        assert_eq!(names,vec!["original"]);
        let field: String = conn.query_row("SELECT field_value FROM assignment_custom_fields",[],|row|row.get(0)).unwrap();
        let common: String = conn.query_row("SELECT kind FROM common_files",[],|row|row.get(0)).unwrap();
        assert_eq!(field,"第 3 周");
        assert_eq!(common,"textbook");
        drop(conn);
        std::fs::remove_file(db_path).unwrap();
        std::fs::remove_file(backup_path).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
