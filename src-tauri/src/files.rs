use crate::db::{current_settings, id_or_new, now, AppState, FileLink};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, path::{Path, PathBuf}, time::UNIX_EPOCH};
use tauri::State;
use uuid::Uuid;
use walkdir::WalkDir;

#[derive(Debug, Deserialize)]
pub struct LinkInput {
    pub id: String,
    pub assignment_id: String,
    pub path: String,
    pub role: String,
    pub page: String,
    pub chapter: String,
    pub problem: String,
    pub note: String,
}

#[derive(Debug, Deserialize)]
pub struct LinkBatchInput {
    pub assignment_id: String,
    pub paths: Vec<String>,
    pub role: String,
    pub page: String,
    pub chapter: String,
    pub problem: String,
    pub note: String,
}

#[derive(Debug, Serialize)]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
pub struct OpenFileResult {
    pub used_module: bool,
    pub location_applied: bool,
    pub warning: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RenamePreview {
    pub file_id: String,
    pub old_path: String,
    pub new_path: String,
    pub conflict: bool,
    pub unchanged: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NamingInput { pub material: String, pub sections: String, pub version: String, #[serde(default)] pub scope_kind: String }

#[derive(Debug, Deserialize)]
pub struct CommonFileInput { pub course_id: String, pub path: String, pub kind: String, pub label: String }

#[derive(Debug, Deserialize)]
pub struct ModuleFileBatchInput {
    pub module_id: String,
    pub owner_type: String,
    pub owner_id: String,
    pub owner_label: String,
    pub paths: Vec<String>,
    pub role: String,
    pub note: String,
}

pub(crate) fn remove_module_owner_files(conn: &rusqlite::Connection, module_id: &str, owner_type: &str, owner_id: &str) -> Result<(), String> {
    let affected = {
        let mut stmt = conn.prepare("SELECT l.id,l.file_id,f.path,l.owner_label FROM module_file_links l JOIN file_assets f ON f.id=l.file_id WHERE l.module_id=?1 AND l.owner_type=?2 AND l.owner_id=?3").map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![module_id,owner_type,owner_id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?
    };
    for (link_id,file_id,path,label) in affected {
        record_file_history(conn,&file_id,&link_id,"","module_unlinked",&path,&format!("模块关联：{label}"))?;
    }
    conn.execute("DELETE FROM module_file_links WHERE module_id=?1 AND owner_type=?2 AND owner_id=?3", params![module_id,owner_type,owner_id]).map_err(|e| e.to_string())?;
    crate::db::prune_unused_files(conn)
}

#[tauri::command]
pub fn link_module_files(state: State<'_, AppState>, payload: ModuleFileBatchInput) -> Result<usize, String> {
    if payload.module_id.trim().is_empty() || payload.owner_type.trim().is_empty() || payload.owner_id.trim().is_empty() { return Err("模块文件关联缺少所有者".into()); }
    if !["shared","prompt","reference","solution"].contains(&payload.role.as_str()) { return Err("无效的文件角色".into()); }
    if payload.paths.is_empty() { return Err("请选择文件".into()); }
    let canonical = payload.paths.iter().map(|raw| {
        let path = fs::canonicalize(raw).map_err(|_| format!("文件不存在：{raw}"))?;
        if !path.is_file() { return Err(format!("请选择文件：{raw}")); }
        Ok(normal_path(&path))
    }).collect::<Result<HashSet<_>,String>>()?;
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut created = 0;
    for path in canonical {
        tx.execute("INSERT OR IGNORE INTO file_assets(id,path) VALUES (?1,?2)", params![Uuid::new_v4().to_string(),path]).map_err(|e| e.to_string())?;
        let file_id: String = tx.query_row("SELECT id FROM file_assets WHERE path=?1", [&path], |r| r.get(0)).map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        let changed = tx.execute("INSERT OR IGNORE INTO module_file_links(id,module_id,owner_type,owner_id,owner_label,file_id,role,note,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![id,payload.module_id,payload.owner_type,payload.owner_id,payload.owner_label.trim(),file_id,payload.role,payload.note,now()]).map_err(|e| e.to_string())?;
        if changed > 0 {
            record_file_history(&tx,&file_id,&id,"","module_linked",&path,&format!("模块关联：{}",payload.owner_label.trim()))?;
            created += 1;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(created)
}

#[tauri::command]
pub fn unlink_module_file(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut connection = state.db.lock().map_err(|e| e.to_string())?;
    let conn = connection.transaction().map_err(|e| e.to_string())?;
    let (file_id,path,label): (String,String,String) = conn.query_row("SELECT l.file_id,f.path,l.owner_label FROM module_file_links l JOIN file_assets f ON f.id=l.file_id WHERE l.id=?1", [&id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_| "模块文件关联不存在".to_string())?;
    record_file_history(&conn,&file_id,&id,"","module_unlinked",&path,&format!("模块关联：{label}"))?;
    conn.execute("DELETE FROM module_file_links WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    crate::db::prune_unused_files(&conn)?;
    conn.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_common_file(state: State<'_, AppState>, payload: CommonFileInput) -> Result<String, String> {
    if !["textbook","extra","other"].contains(&payload.kind.as_str()) { return Err("无效的常用文件类型".into()); }
    let path = fs::canonicalize(&payload.path).map_err(|_| "文件不存在".to_string())?;
    if !path.is_file() { return Err("请选择文件".into()); }
    let path = normal_path(&path);
    let mut connection = state.db.lock().map_err(|e| e.to_string())?;
    let conn = connection.transaction().map_err(|e| e.to_string())?;
    let course_exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM courses WHERE id=?1)", [&payload.course_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !course_exists { return Err("课程不存在".into()); }
    conn.execute("INSERT OR IGNORE INTO file_assets(id,path) VALUES (?1,?2)", params![Uuid::new_v4().to_string(),path]).map_err(|e| e.to_string())?;
    let file_id: String = conn.query_row("SELECT id FROM file_assets WHERE path=?1", [&path], |r| r.get(0)).map_err(|e| e.to_string())?;
    let label = if payload.label.trim().is_empty() { Path::new(&path).file_name().unwrap_or_default().to_string_lossy().to_string() } else { payload.label.trim().to_owned() };
    let existed: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM common_files WHERE course_id=?1 AND file_id=?2)", params![payload.course_id,file_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO common_files(course_id,file_id,kind,label) VALUES (?1,?2,?3,?4) ON CONFLICT(course_id,file_id) DO UPDATE SET kind=excluded.kind,label=excluded.label", params![payload.course_id,file_id,payload.kind,label]).map_err(|e| e.to_string())?;
    record_file_history(&conn,&file_id,"","",if existed { "common_updated" } else { "common_added" },&path,&format!("常用文件：{label}"))?;
    conn.commit().map_err(|e| e.to_string())?;
    Ok(file_id)
}

#[tauri::command]
pub fn remove_common_file(state: State<'_, AppState>, course_id: String, file_id: String) -> Result<(), String> {
    let mut connection = state.db.lock().map_err(|e| e.to_string())?;
    let conn = connection.transaction().map_err(|e| e.to_string())?;
    let (path,label): (String,String) = conn.query_row("SELECT f.path,c.label FROM common_files c JOIN file_assets f ON f.id=c.file_id WHERE c.course_id=?1 AND c.file_id=?2", params![course_id,file_id], |r| Ok((r.get(0)?,r.get(1)?))).map_err(|_| "常用文件不存在".to_string())?;
    record_file_history(&conn,&file_id,"","","common_removed",&path,&format!("取消常用文件：{label}"))?;
    conn.execute("DELETE FROM common_files WHERE course_id=?1 AND file_id=?2", params![course_id,file_id]).map_err(|e| e.to_string())?;
    crate::db::prune_unused_files(&conn)?;
    conn.commit().map_err(|e| e.to_string())
}

fn clean_segment(raw: &str) -> String {
    let mapped = raw.chars().map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '-' } else { c }).collect::<String>();
    let trimmed = mapped.trim().trim_end_matches(['.', ' ']);
    if trimmed.is_empty() { "未命名".into() } else { trimmed.chars().take(100).collect() }
}

fn metadata_signature(path: &Path) -> Result<(i64, i64), String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let time = meta.modified().map_err(|e| e.to_string())?.duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as i64;
    Ok((meta.len() as i64, time))
}

fn link_details(role: &str, page: &str, chapter: &str, problem: &str, note: &str) -> String {
    let role = match role { "prompt" => "题目材料", "reference" => "教材参考", "solution" => "我的解答", _ => role };
    let mut parts = vec![format!("角色：{role}")];
    for (label, value) in [("页码",page),("章节",chapter),("题号",problem),("备注",note)] {
        if !value.trim().is_empty() { parts.push(format!("{label}：{}", value.trim())); }
    }
    parts.join(" · ")
}

pub(crate) fn record_file_history(
    conn: &rusqlite::Connection,
    file_id: &str,
    link_id: &str,
    assignment_id: &str,
    event_type: &str,
    path: &str,
    details: &str,
) -> Result<(), String> {
    let assignment_title = if assignment_id.is_empty() { String::new() } else {
        conn.query_row("SELECT title FROM assignments WHERE id=?1", [assignment_id], |r| r.get(0)).optional().map_err(|e| e.to_string())?.unwrap_or_default()
    };
    let (file_size, modified_at_ms) = metadata_signature(Path::new(path)).map(|(size,modified)| (Some(size),Some(modified))).unwrap_or((None,None));
    conn.execute(
        "INSERT INTO file_history(id,file_id,link_id,assignment_id,assignment_title,event_type,path,details,file_size,modified_at_ms,occurred_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![Uuid::new_v4().to_string(),file_id,link_id,assignment_id,assignment_title,event_type,path,details,file_size,modified_at_ms,now()]
    ).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn normal_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") { format!(r"\\{}",rest) }
    else if let Some(rest) = raw.strip_prefix(r"\\?\") { rest.to_owned() }
    else { raw.to_string() }
}

#[tauri::command]
pub fn link_file(state: State<'_, AppState>, payload: LinkInput) -> Result<String, String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = link_file_impl(&tx, payload)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn link_files_batch(state: State<'_, AppState>, payload: LinkBatchInput) -> Result<usize, String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    link_files_batch_impl(&mut conn, payload)
}

fn link_files_batch_impl(conn: &mut rusqlite::Connection, payload: LinkBatchInput) -> Result<usize, String> {
    if !["prompt", "reference", "solution"].contains(&payload.role.as_str()) { return Err("无效的文件角色".into()); }
    if payload.paths.is_empty() { return Err("请至少选择一个文件".into()); }
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    for raw in &payload.paths {
        let path = fs::canonicalize(raw).map_err(|_| format!("文件不存在：{raw}"))?;
        if !path.is_file() { return Err(format!("请选择文件：{raw}")); }
        let path = normal_path(&path);
        if seen.insert(path.to_lowercase()) { paths.push(path); }
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut created = 0;
    for path in paths {
        tx.execute("INSERT OR IGNORE INTO file_assets(id,path) VALUES (?1,?2)", params![Uuid::new_v4().to_string(),path]).map_err(|e| e.to_string())?;
        let file_id: String = tx.query_row("SELECT id FROM file_assets WHERE path=?1", [&path], |r| r.get(0)).map_err(|e| e.to_string())?;
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM assignment_files WHERE assignment_id=?1 AND file_id=?2 AND role=?3)", params![payload.assignment_id,file_id,payload.role], |r| r.get(0)).map_err(|e| e.to_string())?;
        if !exists {
            let link_id = Uuid::new_v4().to_string();
            tx.execute("INSERT INTO assignment_files(id,assignment_id,file_id,role,page,chapter,problem,note) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)", params![link_id,payload.assignment_id,file_id,payload.role,payload.page,payload.chapter,payload.problem,payload.note]).map_err(|e| e.to_string())?;
            record_file_history(&tx,&file_id,&link_id,&payload.assignment_id,"linked",&path,&link_details(&payload.role,&payload.page,&payload.chapter,&payload.problem,&payload.note))?;
            created += 1;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(created)
}

#[tauri::command]
pub async fn open_file(state: State<'_, AppState>, file_id: String, link_id: Option<String>) -> Result<OpenFileResult, String> {
    let (path, location, navigation_modules) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let path: String = conn.query_row("SELECT path FROM file_assets WHERE id=?1", [&file_id], |r| r.get(0)).map_err(|_| "文件关联不存在".to_string())?;
        let location = link_id.as_deref().filter(|id| !id.trim().is_empty()).and_then(|id| {
            conn.query_row(
                "SELECT page,chapter,problem FROM assignment_files WHERE id=?1 AND file_id=?2",
                params![id,file_id],
                |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)),
            ).optional().ok().flatten()
        });
        let modules = crate::modules::external_modules_for_capability(&state.modules_dir, "document.navigation.open")
            .into_iter().filter(|module| crate::modules::enabled(&conn, &module.id).unwrap_or(false)).collect::<Vec<_>>();
        (path, location, modules)
    };
    if !Path::new(&path).is_file() { return Err("文件不存在，请先重新定位".into()); }
    if let Some((page,chapter,problem)) = location.filter(|(page,chapter,_)| !page.trim().is_empty() || !chapter.trim().is_empty()) {
        let mut failures = Vec::new();
        for module in &navigation_modules {
            let input = serde_json::json!({"path":path,"page":page,"chapter":chapter,"problem":problem});
            match crate::modules::invoke_external_module(&state.modules_dir, &module.id, "document.navigation.open", input).await {
                Ok(result) if result.get("handled").and_then(serde_json::Value::as_bool) == Some(true) => {
                    return Ok(OpenFileResult {
                        used_module: true,
                        location_applied: result.get("location_applied").and_then(serde_json::Value::as_bool).unwrap_or(true),
                        warning: result.get("warning").and_then(serde_json::Value::as_str).map(str::to_owned),
                    });
                }
                Ok(_) => {}
                Err(error) => failures.push(format!("{}：{error}",module.name)),
            }
        }
        open::that(&path).map_err(|e| format!("无法用默认程序打开文件：{e}"))?;
        let warning = if failures.is_empty() {
            navigation_modules.first().map(|_| "该文件格式不支持定位，已按普通方式打开".to_string())
        } else {
            Some(format!("定位模块未能完成跳转，已按普通方式打开（{}）", failures.join("；")))
        };
        return Ok(OpenFileResult { used_module:false, location_applied:false, warning });
    }
    open::that(&path).map_err(|e| format!("无法用默认程序打开文件：{e}"))?;
    Ok(OpenFileResult { used_module:false, location_applied:false, warning:None })
}

fn file_directory(conn: &rusqlite::Connection, file_id: &str) -> Result<PathBuf, String> {
    let path: String = conn.query_row("SELECT path FROM file_assets WHERE id=?1", [file_id], |r| r.get(0)).map_err(|_| "文件关联不存在".to_string())?;
    let directory = Path::new(&path).parent().filter(|path| path.is_absolute() && path.is_dir()).ok_or("所在文件夹不存在，请先重新定位文件")?;
    Ok(directory.to_path_buf())
}

#[tauri::command]
pub fn open_file_directory(state: State<'_, AppState>, file_id: String) -> Result<(), String> {
    let directory = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        file_directory(&conn, &file_id)?
    };
    open::that(directory).map_err(|e| format!("无法打开所在文件夹：{e}"))
}

fn link_file_impl(conn: &rusqlite::Connection, payload: LinkInput) -> Result<String, String> {
    if !["prompt", "reference", "solution"].contains(&payload.role.as_str()) { return Err("无效的文件角色".into()); }
    let path = fs::canonicalize(&payload.path).map_err(|_| "文件不存在，请重新选择".to_string())?;
    if !path.is_file() { return Err("请选择文件，而非文件夹".into()); }
    let path = normal_path(&path);
    let file_id: String = match conn.query_row("SELECT id FROM file_assets WHERE path=?1", [&path], |r| r.get(0)).optional().map_err(|e| e.to_string())? {
        Some(id) => id,
        None => {
            let id = Uuid::new_v4().to_string();
            conn.execute("INSERT INTO file_assets(id,path) VALUES (?1,?2)", params![id,path]).map_err(|e| e.to_string())?;
            id
        }
    };
    let is_update = !payload.id.trim().is_empty() && conn.query_row("SELECT EXISTS(SELECT 1 FROM assignment_files WHERE id=?1)", [&payload.id], |r| r.get::<_,bool>(0)).map_err(|e| e.to_string())?;
    let id = id_or_new(&payload.id);
    conn.execute("INSERT INTO assignment_files(id,assignment_id,file_id,role,page,chapter,problem,note) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET file_id=excluded.file_id,role=excluded.role,page=excluded.page,chapter=excluded.chapter,problem=excluded.problem,note=excluded.note", params![id,payload.assignment_id,file_id,payload.role,payload.page,payload.chapter,payload.problem,payload.note]).map_err(|e| e.to_string())?;
    record_file_history(conn,&file_id,&id,&payload.assignment_id,if is_update { "link_updated" } else { "linked" },&path,&link_details(&payload.role,&payload.page,&payload.chapter,&payload.problem,&payload.note))?;
    Ok(id)
}

#[tauri::command]
pub fn save_file_link(state: State<'_, AppState>, payload: FileLink) -> Result<(), String> {
    let mut connection = state.db.lock().map_err(|e| e.to_string())?;
    let conn = connection.transaction().map_err(|e| e.to_string())?;
    let (file_id,path): (String,String) = conn.query_row("SELECT f.id,f.path FROM assignment_files l JOIN file_assets f ON f.id=l.file_id WHERE l.id=?1", [&payload.id], |r| Ok((r.get(0)?,r.get(1)?))).map_err(|_| "文件关联不存在".to_string())?;
    conn.execute("UPDATE assignment_files SET role=?2,page=?3,chapter=?4,problem=?5,note=?6 WHERE id=?1", params![payload.id,payload.role,payload.page,payload.chapter,payload.problem,payload.note]).map_err(|e| e.to_string())?;
    record_file_history(&conn,&file_id,&payload.id,&payload.assignment_id,"link_updated",&path,&link_details(&payload.role,&payload.page,&payload.chapter,&payload.problem,&payload.note))?;
    conn.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn unlink_file(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut connection = state.db.lock().map_err(|e| e.to_string())?;
    let conn = connection.transaction().map_err(|e| e.to_string())?;
    let (assignment_id,file_id,path,role,page,chapter,problem,note): (String,String,String,String,String,String,String,String) = conn.query_row("SELECT l.assignment_id,f.id,f.path,l.role,l.page,l.chapter,l.problem,l.note FROM assignment_files l JOIN file_assets f ON f.id=l.file_id WHERE l.id=?1", [&id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).map_err(|_| "文件关联不存在".to_string())?;
    record_file_history(&conn,&file_id,&id,&assignment_id,"unlinked",&path,&link_details(&role,&page,&chapter,&problem,&note))?;
    conn.execute("DELETE FROM assignment_files WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    crate::db::prune_unused_files(&conn)?;
    conn.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn relink_file(state: State<'_, AppState>, file_id: String, path: String) -> Result<(), String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    relink_file_impl(&tx, &file_id, &path)?;
    tx.commit().map_err(|e| e.to_string())
}

fn relink_file_impl(conn: &rusqlite::Connection, file_id: &str, path: &str) -> Result<(), String> {
    let old_path: String = conn.query_row("SELECT path FROM file_assets WHERE id=?1", [file_id], |r| r.get(0)).map_err(|_| "文件关联不存在".to_string())?;
    let path = fs::canonicalize(path).map_err(|_| "新文件路径不存在".to_string())?;
    if !path.is_file() { return Err("请选择文件".into()); }
    let path = normal_path(&path);
    conn.execute("UPDATE file_assets SET path=?2 WHERE id=?1", params![file_id,path]).map_err(|e| e.to_string())?;
    record_file_history(conn,file_id,"","","relocated",&path,&format!("原路径：{old_path}"))?;
    Ok(())
}

fn course_root(conn: &rusqlite::Connection, course_id: &str) -> Result<PathBuf, String> {
    let root: String = conn.query_row("SELECT folder_path FROM courses WHERE id=?1", [course_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if root.is_empty() { return Err("此课程尚未关联文件夹".into()); }
    fs::canonicalize(root).map_err(|_| "课程文件夹不存在".into())
}

#[tauri::command]
pub fn browse_directory(state: State<'_, AppState>, course_id: String, relative_path: String) -> Result<Vec<DirectoryEntry>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let root = course_root(&conn, &course_id)?;
    let requested = fs::canonicalize(root.join(relative_path)).map_err(|_| "文件夹不存在".to_string())?;
    if !requested.starts_with(&root) || !requested.is_dir() { return Err("路径超出课程文件夹".into()); }
    let mut entries = Vec::new();
    for entry in fs::read_dir(requested).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" { continue; }
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        if meta.is_dir() || meta.is_file() {
            entries.push(DirectoryEntry { name, path:normal_path(&entry.path()), is_dir:meta.is_dir() });
        }
    }
    entries.sort_by(|a,b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

#[tauri::command]
pub fn search_course_files(state: State<'_, AppState>, course_id: String, query: String) -> Result<Vec<DirectoryEntry>, String> {
    if query.trim().len() < 2 { return Ok(Vec::new()); }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let root = course_root(&conn, &course_id)?;
    let needle = query.to_lowercase();
    let mut results = Vec::new();
    for entry in WalkDir::new(root).max_depth(12).into_iter().filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.') && e.file_name() != "node_modules") {
        let Ok(entry) = entry else { continue };
        if entry.file_type().is_file() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.to_lowercase().contains(&needle) {
                results.push(DirectoryEntry { name, path:normal_path(entry.path()), is_dir:false });
                if results.len() >= 100 { break; }
            }
        }
    }
    Ok(results)
}

fn make_preview(conn: &rusqlite::Connection, link_id: &str, naming: &NamingInput) -> Result<RenamePreview, String> {
    let (file_id,old_path,course,code,assignment,role,chapter): (String,String,String,String,String,String,String) = conn.query_row(
        "SELECT f.id,f.path,c.name,c.code,a.title,l.role,l.chapter FROM assignment_files l JOIN file_assets f ON l.file_id=f.id JOIN assignments a ON l.assignment_id=a.id JOIN courses c ON a.course_id=c.id WHERE l.id=?1",
        [link_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))
    ).map_err(|e| e.to_string())?;
    let path = Path::new(&old_path);
    if !path.is_file() { return Err("原文件不存在，请先重新定位".into()); }
    let role_name = match role.as_str() { "prompt" => "题目", "reference" => "参考", _ => "解答" };
    let template = current_settings(conn)?.naming_template;
    let semester: String = conn.query_row("SELECT s.name FROM semesters s JOIN courses c ON s.id=c.semester_id JOIN assignments a ON c.id=a.course_id JOIN assignment_files l ON a.id=l.assignment_id WHERE l.id=?1", [link_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    let path_lower = old_path.to_lowercase();
    let material = if naming.material.trim().is_empty() { if path_lower.contains("extra") || path_lower.contains("supplement") { "extra" } else if path_lower.contains("textbook") || role == "reference" { "textbook" } else if role == "solution" { "solution" } else { "assignment" } } else { naming.material.trim() };
    let section_source = if naming.sections.trim().is_empty() { chapter.as_str() } else { naming.sections.trim() };
    if (template.contains("{scope}") || template.contains("{sections}")) && section_source.trim().is_empty() { return Err("请填写范围，例如 s2.5&s2.6 或 ch3".into()); }
    let scope_kind = if naming.scope_kind.is_empty() { if section_source.starts_with("ch") { "chapter" } else { "section" } } else { naming.scope_kind.as_str() };
    if !["chapter","section"].contains(&scope_kind) { return Err("范围类型无效".into()); }
    let prefix = if scope_kind == "chapter" { "ch" } else { "s" };
    let scope = if section_source.starts_with(prefix) { section_source.to_owned() } else { format!("{prefix}{}",section_source.trim_start_matches("ch").trim_start_matches('s')) };
    let base = template.replace("{course_code}", &clean_segment(if code.trim().is_empty() { &course } else { &code }))
        .replace("{material}", &clean_segment(material)).replace("{scope}",&clean_segment(&scope)).replace("{sections}",&clean_segment(&scope))
        .replace("{semester}", &clean_segment(&semester)).replace("{course}", &clean_segment(&course))
        .replace("{assignment}", &clean_segment(&assignment)).replace("{role}",role_name).replace("{version}",&clean_segment(&naming.version));
    if base.contains('{') || base.contains('}') { return Err("命名模板包含未知占位符".into()); }
    let ext = path.extension().map(|x| format!(".{}", x.to_string_lossy())).unwrap_or_default();
    let new_path = path.with_file_name(format!("{}{}", clean_segment(&base), ext));
    let unchanged = new_path == path;
    let conflict = !unchanged && new_path.exists();
    Ok(RenamePreview { file_id, old_path, new_path:new_path.to_string_lossy().to_string(), conflict, unchanged })
}

#[tauri::command]
pub fn preview_rename(state: State<'_, AppState>, link_id: String, naming: NamingInput) -> Result<RenamePreview, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    make_preview(&conn, &link_id, &naming)
}

#[tauri::command]
pub fn rename_file(state: State<'_, AppState>, link_id: String, naming: NamingInput) -> Result<String, String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    rename_file_impl(&mut conn, &link_id, &naming)
}

fn rename_file_impl(conn: &mut rusqlite::Connection, link_id: &str, naming: &NamingInput) -> Result<String, String> {
    let preview = make_preview(conn, link_id, naming)?;
    if preview.unchanged { return Err("文件名已经符合模板".into()); }
    if preview.conflict { return Err("目标文件名已经存在".into()); }
    let old = Path::new(&preview.old_path);
    let new = Path::new(&preview.new_path);
    let (size,modified) = metadata_signature(old)?;
    fs::rename(old,new).map_err(|e| format!("重命名失败：{e}"))?;
    let id = Uuid::new_v4().to_string();
    let result = (|| -> Result<(), String> {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let (assignment_id,role): (String,String) = tx.query_row("SELECT assignment_id,role FROM assignment_files WHERE id=?1", [link_id], |r| Ok((r.get(0)?,r.get(1)?))).map_err(|e| e.to_string())?;
        tx.execute("UPDATE file_assets SET path=?2 WHERE id=?1", params![preview.file_id,preview.new_path]).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO rename_history(id,file_id,old_path,new_path,file_size,modified_at_ms,changed_at) VALUES (?1,?2,?3,?4,?5,?6,?7)", params![id,preview.file_id,preview.old_path,preview.new_path,size,modified,now()]).map_err(|e| e.to_string())?;
        record_file_history(&tx,&preview.file_id,link_id,&assignment_id,"renamed",&preview.new_path,&format!("{} · 原路径：{}",link_details(&role,"","","",""),preview.old_path))?;
        tx.commit().map_err(|e| e.to_string())
    })();
    if let Err(error) = result { let _ = fs::rename(new,old); return Err(error); }
    Ok(id)
}

#[tauri::command]
pub fn undo_rename(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    undo_rename_impl(&mut conn, &id)
}

fn undo_rename_impl(conn: &mut rusqlite::Connection, id: &str) -> Result<(), String> {
    let (file_id,old_path,new_path,size,modified,undone): (String,String,String,i64,i64,Option<String>) = conn.query_row("SELECT file_id,old_path,new_path,file_size,modified_at_ms,undone_at FROM rename_history WHERE id=?1", [&id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).map_err(|e| e.to_string())?;
    if undone.is_some() { return Err("这次改名已经撤回".into()); }
    let latest: String = conn.query_row("SELECT id FROM rename_history WHERE file_id=?1 AND undone_at IS NULL ORDER BY changed_at DESC,rowid DESC LIMIT 1", [&file_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if latest != id { return Err("请先撤回此文件较新的改名".into()); }
    let current: String = conn.query_row("SELECT path FROM file_assets WHERE id=?1", [&file_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if current != new_path || !Path::new(&new_path).is_file() { return Err("文件已在应用外移动或改名，无法安全撤回".into()); }
    if Path::new(&old_path).exists() { return Err("原文件名已被占用".into()); }
    if metadata_signature(Path::new(&new_path))? != (size,modified) { return Err("文件内容或修改时间已变化，无法安全撤回".into()); }
    fs::rename(&new_path,&old_path).map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("UPDATE file_assets SET path=?2 WHERE id=?1", params![file_id,old_path]).map_err(|e| e.to_string())?;
        tx.execute("UPDATE rename_history SET undone_at=?2 WHERE id=?1", params![id,now()]).map_err(|e| e.to_string())?;
        record_file_history(&tx,&file_id,"","","rename_undone",&old_path,&format!("撤回名称：{new_path}"))?;
        tx.commit().map_err(|e| e.to_string())
    })();
    if let Err(error) = result { let _ = fs::rename(&old_path,&new_path); return Err(error); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn link(assignment_id: &str, path: &Path, role: &str) -> LinkInput {
        LinkInput { id:String::new(),assignment_id:assignment_id.into(),path:path.to_string_lossy().to_string(),role:role.into(),page:String::new(),chapter:String::new(),problem:String::new(),note:String::new() }
    }
    fn naming(section: &str) -> NamingInput { NamingInput { material:"textbook".into(),sections:section.into(),version:"1".into(),scope_kind:"section".into() } }

    #[test]
    fn file_directory_uses_current_path_and_allows_missing_file() {
        let dir = std::env::temp_dir().join(format!("homeworkbook-folder-test-{}", Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let source = dir.join("解答 with spaces.txt");
        fs::write(&source, "temporary answer").unwrap();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE file_assets(id TEXT PRIMARY KEY,path TEXT UNIQUE);").unwrap();
        conn.execute("INSERT INTO file_assets VALUES('f',?1)", [source.to_string_lossy().as_ref()]).unwrap();
        assert_eq!(file_directory(&conn, "f").unwrap(), dir);
        fs::remove_file(&source).unwrap();
        assert_eq!(file_directory(&conn, "f").unwrap(), dir);
        assert!(file_directory(&conn, "unknown").is_err());
        let moved = dir.join("moved");
        fs::create_dir(&moved).unwrap();
        conn.execute("UPDATE file_assets SET path=?1 WHERE id='f'", [moved.join("renamed.txt").to_string_lossy().as_ref()]).unwrap();
        assert_eq!(file_directory(&conn, "f").unwrap(), moved);
        fs::remove_dir(&moved).unwrap();
        assert!(file_directory(&conn, "f").is_err());
        fs::remove_dir(&dir).unwrap();
    }

    #[test]
    fn shared_files_conflicts_and_reopen_undo() {
        let dir = std::env::temp_dir().join(format!("homeworkbook-test-{}",Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let db_path = dir.join("sample.db");
        let source = dir.join("answer.txt");
        let other = dir.join("textbook.txt");
        fs::write(&source,"a temporary answer").unwrap();
        fs::write(&other,"a temporary reference").unwrap();
        let mut conn = Connection::open(&db_path).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE semesters(id TEXT PRIMARY KEY,name TEXT);
            CREATE TABLE courses(id TEXT PRIMARY KEY,semester_id TEXT,name TEXT,code TEXT);
            CREATE TABLE assignments(id TEXT PRIMARY KEY,course_id TEXT,title TEXT);
            CREATE TABLE file_assets(id TEXT PRIMARY KEY,path TEXT UNIQUE);
            CREATE TABLE assignment_files(id TEXT PRIMARY KEY,assignment_id TEXT,file_id TEXT,role TEXT,page TEXT,chapter TEXT,problem TEXT,note TEXT);
            CREATE TABLE rename_history(id TEXT PRIMARY KEY,file_id TEXT,old_path TEXT,new_path TEXT,file_size INTEGER,modified_at_ms INTEGER,changed_at TEXT,undone_at TEXT);
            CREATE TABLE file_history(id TEXT PRIMARY KEY,file_id TEXT,link_id TEXT,assignment_id TEXT,assignment_title TEXT,event_type TEXT,path TEXT,details TEXT,file_size INTEGER,modified_at_ms INTEGER,occurred_at TEXT);
            CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
            INSERT INTO semesters VALUES('s','2026 秋季');
            INSERT INTO courses VALUES('c','s','Calculus','MA117');
            INSERT INTO assignments VALUES('a1','c','作业一');
            INSERT INTO assignments VALUES('a2','c','作业二');").unwrap();
        let first = link_file_impl(&conn,link("a1",&source,"solution")).unwrap();
        let second = link_file_impl(&conn,link("a2",&source,"solution")).unwrap();
        link_file_impl(&conn,link("a1",&other,"reference")).unwrap();
        let added = link_files_batch_impl(&mut conn,LinkBatchInput { assignment_id:"a2".into(),paths:vec![source.to_string_lossy().to_string(),other.to_string_lossy().to_string(),other.to_string_lossy().to_string()],role:"reference".into(),page:String::new(),chapter:"2.5&s2.6".into(),problem:String::new(),note:String::new() }).unwrap();
        assert_eq!(added,2);
        let duplicate = link_files_batch_impl(&mut conn,LinkBatchInput { assignment_id:"a2".into(),paths:vec![other.to_string_lossy().to_string()],role:"reference".into(),page:String::new(),chapter:String::new(),problem:String::new(),note:String::new() }).unwrap();
        assert_eq!(duplicate,0);
        let shared_count: i64 = conn.query_row("SELECT COUNT(*) FROM file_assets",[],|r|r.get(0)).unwrap();
        assert_eq!(shared_count,2);
        let shared_ids: Vec<String> = [&first,&second].iter().map(|id| conn.query_row("SELECT file_id FROM assignment_files WHERE id=?1",[id],|r|r.get(0)).unwrap()).collect();
        assert_eq!(shared_ids[0],shared_ids[1]);
        conn.execute("INSERT INTO settings(key,value) VALUES ('naming_template','{course_code}-{material}-hw-{scope}')",[]).unwrap();
        let chapter = make_preview(&conn,&first,&NamingInput { material:"extra".into(),sections:"3".into(),version:"1".into(),scope_kind:"chapter".into() }).unwrap();
        assert!(chapter.new_path.ends_with("MA117-extra-hw-ch3.txt"));
        let target = dir.join("MA117-textbook-hw-s2.5&s2.6.txt");
        fs::write(&target,"occupied").unwrap();
        assert!(make_preview(&conn,&first,&naming("2.5&s2.6")).unwrap().conflict);
        assert!(rename_file_impl(&mut conn,&first,&naming("2.5&s2.6")).is_err());
        fs::remove_file(&target).unwrap();
        let event = rename_file_impl(&mut conn,&first,&naming("2.5&s2.6")).unwrap();
        assert!(!source.exists() && target.exists());
        let actual: String = conn.query_row("SELECT path FROM file_assets WHERE id=?1",[&shared_ids[0]],|r|r.get(0)).unwrap();
        assert_eq!(Path::new(&actual).file_name(), target.file_name());
        assert!(Path::new(&actual).exists());
        drop(conn);
        let mut reopened = Connection::open(&db_path).unwrap();
        undo_rename_impl(&mut reopened,&event).unwrap();
        assert!(source.exists() && !target.exists());
        assert!(undo_rename_impl(&mut reopened,&event).is_err());
        fs::remove_file(&source).unwrap();
        assert!(make_preview(&reopened,&first,&naming("2.5&s2.6")).is_err());
        let relocated = dir.join("moved-answer.txt");
        fs::write(&relocated,"a temporary answer").unwrap();
        relink_file_impl(&reopened,&shared_ids[0],&relocated.to_string_lossy()).unwrap();
        assert!(make_preview(&reopened,&first,&naming("3.1")).is_ok());
        drop(reopened);
        fs::remove_file(&relocated).unwrap();
        fs::remove_file(&other).unwrap();
        fs::remove_file(&db_path).unwrap();
        fs::remove_dir(&dir).unwrap();
    }
}
