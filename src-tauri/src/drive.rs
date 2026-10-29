//! Drive references are metadata only. Native credentials stay in sync's keyring adapter.
use crate::db::AppState;
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::State;

pub(crate) fn validate_id(id: &str) -> Result<(), String> {
    if !(10..=180).contains(&id.len())
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("无效的 Drive 文件 ID".into());
    }
    Ok(())
}
fn validate_key(key: &str) -> Result<(), String> {
    if key.len() > 256
        || key.is_empty()
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("无效的 Drive resource key".into());
    }
    Ok(())
}
#[derive(Debug, Deserialize)]
pub struct DriveFileInfo {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub resource_key: Option<String>,
    #[serde(default)]
    pub unavailable: bool,
}
impl DriveFileInfo {
    fn validate(&self) -> Result<(), String> {
        validate_id(&self.id)?;
        if self.name.trim().is_empty()
            || self.name.len() > 1024
            || self.name.chars().any(char::is_control)
        {
            return Err("Drive 文件名无效".into());
        }
        if self.mime_type.len() > 255
            || !self.mime_type.contains('/')
            || self
                .mime_type
                .bytes()
                .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
        {
            return Err("Drive MIME 类型无效".into());
        }
        if self.mime_type == "application/vnd.google-apps.folder" {
            return Err("请选择 Drive 文件，不能关联文件夹".into());
        }
        if let Some(key) = &self.resource_key {
            validate_key(key)?;
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn drive_request(
    state: State<'_, AppState>,
    action: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    let body = payload.unwrap_or_else(|| json!({}));
    if serde_json::to_vec(&body)
        .map_err(|_| "Drive 请求无效")?
        .len()
        > 64 * 1024
    {
        return Err("Drive 请求过大".into());
    }
    use reqwest::Method;
    let (method, path, payload) = match action.as_str() {
        "status" => (Method::GET, "/api/drive/status".into(), None),
        "start" => (Method::POST, "/api/drive/flows".into(), Some(body)),
        "poll" => {
            let id = body
                .get("flow_id")
                .and_then(Value::as_str)
                .ok_or("缺少 Drive 流程 ID")?;
            if id.is_empty()
                || id.len() > 200
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return Err("Drive 流程 ID 无效".into());
            }
            let secret = body
                .get("poll_secret")
                .and_then(Value::as_str)
                .ok_or("缺少 Drive 流程凭据")?;
            if secret.is_empty() || secret.len() > 512 {
                return Err("Drive 流程凭据无效".into());
            }
            (
                Method::POST,
                format!("/api/drive/flows/{id}/poll"),
                Some(json!({"poll_secret":secret})),
            )
        }
        "disconnect" => (Method::DELETE, "/api/drive/connection".into(), None),
        "resolve" => (Method::POST, "/api/drive/files/resolve".into(), Some(body)),
        "refresh" => (Method::POST, "/api/drive/files/refresh".into(), Some(body)),
        _ => return Err("不支持的 Drive 操作".into()),
    };
    crate::sync::drive_request(&state, method, &path, payload).await
}

#[tauri::command]
pub fn register_drive_files(
    state: State<'_, AppState>,
    files: Vec<DriveFileInfo>,
) -> Result<Vec<String>, String> {
    let mut conn = state.db.lock().map_err(|_| "数据库繁忙")?;
    register(&mut conn, files)
}
pub(super) fn register(
    conn: &mut rusqlite::Connection,
    files: Vec<DriveFileInfo>,
) -> Result<Vec<String>, String> {
    if files.is_empty() || files.len() > 100 {
        return Err("每次请选择 1 至 100 个 Drive 文件".into());
    }
    for file in &files {
        file.validate()?;
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut ids = Vec::new();
    for file in files {
        let id = format!("gdrive-{}", file.id);
        let path = format!("gdrive:{}", file.id);
        let previous: Option<(String, bool)> = tx
            .query_row(
                "SELECT name,drive_unavailable FROM sync_files WHERE id=?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let old_path: Option<String> = tx
            .query_row("SELECT path FROM file_assets WHERE id=?1", [&id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        if old_path.is_some_and(|p| p != path) {
            return Err("Drive 文件标识冲突".into());
        }
        tx.execute(
            "INSERT OR IGNORE INTO file_assets(id,path) VALUES(?1,?2)",
            params![id, path],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO sync_files(id,name,mime,drive_id,drive_resource_key,drive_unavailable) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET name=excluded.name,mime=excluded.mime,drive_id=excluded.drive_id,drive_resource_key=coalesce(excluded.drive_resource_key,sync_files.drive_resource_key),drive_unavailable=excluded.drive_unavailable",params![id,file.name,file.mime_type,file.id,file.resource_key,file.unavailable]).map_err(|e|e.to_string())?;
        if previous
            .is_some_and(|(name, unavailable)| name != file.name || unavailable != file.unavailable)
        {
            crate::files::record_file_history(
                &tx,
                &id,
                "",
                "",
                "metadata_refreshed",
                &path,
                "已更新 Drive 文件名称或可访问状态",
            )?;
        }
        ids.push(id);
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ids)
}

pub(crate) fn browser_url(id: &str, key: Option<&str>) -> Result<String, String> {
    validate_id(id)?;
    let mut url = reqwest::Url::parse(&format!("https://drive.google.com/file/d/{id}/view"))
        .map_err(|_| "Drive 链接无效")?;
    if let Some(key) = key {
        validate_key(key)?;
        url.query_pairs_mut().append_pair("resourcekey", key);
    }
    Ok(url.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn file(name: &str, unavailable: bool) -> DriveFileInfo {
        DriveFileInfo {
            id: "abcdefghij_123".into(),
            name: name.into(),
            mime_type: "application/pdf".into(),
            resource_key: Some("key_123".into()),
            unavailable,
        }
    }
    #[test]
    fn registration_is_atomic_and_only_changes_audit_metadata() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE file_assets(id TEXT PRIMARY KEY,path TEXT UNIQUE); CREATE TABLE assignments(id TEXT,title TEXT); CREATE TABLE file_history(id TEXT,file_id TEXT,link_id TEXT,assignment_id TEXT,assignment_title TEXT,event_type TEXT,path TEXT,details TEXT,file_size INTEGER,modified_at_ms INTEGER,occurred_at TEXT);").unwrap();
        crate::sync::migrate(&conn).unwrap();
        assert_eq!(
            register(&mut conn, vec![file("Notes", false)]).unwrap(),
            vec!["gdrive-abcdefghij_123"]
        );
        register(&mut conn, vec![file("Notes", false)]).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM file_history", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        register(&mut conn, vec![file("Renamed notes", true)]).unwrap();
        assert_eq!(
            conn.query_row("SELECT event_type FROM file_history", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "metadata_refreshed"
        );
        let mut invalid = file("Bad", false);
        invalid.id = "../bad".into();
        assert!(register(&mut conn, vec![file("Must not apply", false), invalid]).is_err());
        assert_eq!(
            conn.query_row("SELECT name FROM sync_files", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "Renamed notes"
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM sync_outbox", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn browser_links_only_use_canonical_google_origin() {
        assert_eq!(
            browser_url("abcdefghij_123", Some("key_123")).unwrap(),
            "https://drive.google.com/file/d/abcdefghij_123/view?resourcekey=key_123"
        );
        assert!(browser_url("../evil.test", None).is_err());
        assert!(browser_url("abcdefghij_123", Some("x&redirect=evil")).is_err());
    }
}
