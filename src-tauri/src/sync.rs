//! Optional, explicit personal synchronization. Payloads are constructed from a fixed whitelist.
use crate::db::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::State;

const MAX_FILE: usize = 20 * 1024 * 1024;
const MAX_BODY: usize = 2 * 1024 * 1024;
static RUNNING: AtomicBool = AtomicBool::new(false);
struct Running;
impl Drop for Running {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::Release);
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Mutation {
    pub entity_type: String,
    pub entity_id: String,
    pub data: Option<Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Operation {
    pub operation_id: String,
    pub changes: Vec<Mutation>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entity {
    pub entity_type: String,
    pub entity_id: String,
    pub data: Option<Value>,
    pub seq: i64,
}
#[derive(Debug, Deserialize)]
struct Response {
    cursor: i64,
    changes: Vec<Entity>,
    acknowledged: Vec<String>,
    has_more: bool,
    server_time: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub client_type: String,
    pub created_at: String,
    pub last_seen_at: String,
    pub current: Option<bool>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct PairRequest {
    pub pair_id: String,
    pub poll_secret: String,
    pub code: String,
    pub expires_at: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct PairResult {
    pub state: String,
    #[serde(skip_serializing)]
    pub token: Option<String>,
    pub device: Option<Device>,
}
#[derive(Debug, Serialize)]
pub struct Status {
    enabled: bool,
    server_url: String,
    device_id: String,
    device_name: String,
    connected: bool,
    pending: i64,
    cursor: i64,
    last_synced_at: Option<String>,
    error: Option<String>,
    pub baseline_counts: Value,
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct Config {
    #[serde(default)]
    server_url: String,
    #[serde(default)]
    device_id: String,
    #[serde(default)]
    device_name: String,
    #[serde(default)]
    pair_id: String,
    #[serde(default)]
    last_synced_at: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

// All names below are compile-time constants. Paths, native signatures and credentials are absent.
struct Spec {
    kind: &'static str,
    table: &'static str,
    key: &'static str,
    columns: &'static [&'static str],
    filter: &'static str,
}
const SPECS: &[Spec] = &[
    Spec {
        kind: "semester",
        table: "semesters",
        key: "id",
        columns: &["name"],
        filter: "1",
    },
    Spec {
        kind: "course",
        table: "courses",
        key: "id",
        columns: &["semester_id", "name", "code"],
        filter: "1",
    },
    Spec {
        kind: "assignment",
        table: "assignments",
        key: "id",
        columns: &[
            "course_id",
            "title",
            "description",
            "due_at",
            "status",
            "submission_label",
            "submission_url",
            "submission_notes",
            "source_name",
            "source_text",
            "created_at",
            "updated_at",
        ],
        filter: "1",
    },
    Spec {
        kind: "file",
        table: "sync_files",
        key: "id",
        columns: &["name", "mime", "size", "cloud_version", "drive_id", "drive_resource_key", "drive_unavailable"],
        filter: "1",
    },
    Spec {
        kind: "link",
        table: "assignment_files",
        key: "id",
        columns: &[
            "assignment_id",
            "file_id",
            "role",
            "page",
            "chapter",
            "problem",
            "note",
        ],
        filter: "1",
    },
    Spec {
        kind: "common_file",
        table: "common_files",
        key: "course_id || ':' || file_id",
        columns: &["course_id", "file_id", "kind", "label"],
        filter: "1",
    },
    Spec {
        kind: "setting",
        table: "settings",
        key: "key",
        columns: &["value"],
        filter: "key IN ('theme','naming_template')",
    },
    Spec {
        kind: "module_state",
        table: "module_states",
        key: "module_id",
        columns: &["enabled"],
        filter: "module_id IN ('builtin.assignment.recurring','builtin.ai.assignment-import')",
    },
    Spec {
        kind: "provider",
        table: "assignment_import_providers",
        key: "id",
        columns: &["name", "kind", "base_url", "model"],
        filter: "1",
    },
    Spec {
        kind: "ai_setting",
        table: "assignment_import_settings",
        key: "key",
        columns: &["value"],
        filter: "key IN ('assignment_provider_id','material_provider_id')",
    },
    Spec {
        kind: "recurring_series",
        table: "recurring_series",
        key: "id",
        columns: &[
            "course_id",
            "name",
            "title_template",
            "description",
            "submission_label",
            "submission_url",
            "submission_notes",
            "rule_json",
            "due_rule_json",
            "max_occurrences",
            "end_at",
            "status",
            "created_at",
            "updated_at",
        ],
        filter: "1",
    },
    Spec {
        kind: "recurring_occurrence",
        table: "recurring_occurrences",
        key: "id",
        columns: &[
            "series_id",
            "sequence_no",
            "scheduled_at",
            "due_at",
            "state",
            "assignment_id",
            "overridden",
        ],
        filter: "1",
    },
    Spec {
        kind: "module_file_link",
        table: "module_file_links",
        key: "id",
        columns: &[
            "module_id",
            "owner_type",
            "owner_id",
            "owner_label",
            "file_id",
            "role",
            "note",
            "created_at",
        ],
        filter: "module_id='builtin.assignment.recurring'",
    },
    Spec {
        kind: "import_course_map", table: "assignment_import_course_map",
        key: "sync_source_id('import_course_map',json_array(module_id,account_key,remote_course_id))",
        columns: &["module_id", "account_key", "remote_course_id", "course_id"], filter: "1",
    },
    Spec {
        kind: "import_link", table: "assignment_import_links",
        key: "sync_source_id('import_link',json_array(module_id,account_key,remote_course_id,remote_assignment_id))",
        columns: &["module_id", "account_key", "remote_course_id", "remote_assignment_id", "assignment_id", "baseline"], filter: "1",
    },
    Spec {
        kind: "import_ignored", table: "assignment_import_ignored",
        key: "sync_source_id('import_ignored',json_array(module_id,account_key,remote_course_id,remote_assignment_id))",
        columns: &["module_id", "account_key", "remote_course_id", "remote_assignment_id", "baseline"], filter: "1",
    },
    Spec {
        kind: "history",
        table: "sync_business_history",
        key: "id",
        columns: &[
            "file_id",
            "link_id",
            "assignment_id",
            "assignment_title",
            "event_type",
            "occurred_at",
        ],
        filter: "1",
    },
    Spec {
        kind: "calendar",
        table: "recurring_semester_calendars",
        key: "semester_id",
        columns: &["semester_id", "week1_start_date"],
        filter: "1",
    },
];
fn sql_error(e: rusqlite::Error) -> String {
    format!("同步数据库操作失败：{e}")
}
fn exists(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |r| r.get(0),
    )
    .map_err(sql_error)
}
pub fn cloud_managed(conn: &Connection) -> Result<bool, String> {
    if !exists(conn, "sync_runtime")? {
        return Ok(false);
    }
    conn.query_row(
        "SELECT cloud_managed FROM sync_runtime WHERE id=1",
        [],
        |r| r.get::<_, bool>(0),
    )
    .map_err(sql_error)
}
fn prefixed(raw: &str, prefix: &str) -> String {
    // Only the two fixed composite key expressions need qualification.
    if raw.starts_with("sync_source_id(") {
        let (head, fields) = raw.split_once("json_array(").expect("static key");
        let fields = fields
            .trim_end_matches(')')
            .split(',')
            .map(|field| format!("{prefix}.{field}"))
            .collect::<Vec<_>>()
            .join(",");
        format!("{head}json_array({fields}))")
    } else if raw == "course_id || ':' || file_id" {
        format!("{prefix}.course_id || ':' || {prefix}.file_id")
    } else {
        format!("{prefix}.{raw}")
    }
}
fn filter(spec: &Spec, prefix: &str) -> String {
    if spec.filter == "1" {
        "1".into()
    } else {
        spec.filter
            .replace("module_id", &format!("{prefix}.module_id"))
            .replace("key ", &format!("{prefix}.key "))
    }
}
fn object(spec: &Spec, prefix: &str) -> String {
    let mut fields = spec
        .columns
        .iter()
        .filter(|c| !(spec.kind == "file" && **c == "cloud_version"))
        .map(|c| {
            if spec.kind == "module_state" && *c == "enabled" {
                format!("'{c}',json(CASE WHEN {prefix}.{c} THEN 'true' ELSE 'false' END)")
            } else {
                format!("'{c}',{prefix}.{c}")
            }
        })
        .collect::<Vec<_>>();
    if spec.kind == "assignment" {
        fields.push(format!("'custom_fields',json(COALESCE((SELECT json_group_object(field_key,field_value) FROM assignment_custom_fields WHERE assignment_id={prefix}.id),'{{}}'))"));
    }
    format!("json_object({})", fields.join(","))
}
fn queue_sql(kind: &str, key: &str, data: &str) -> String {
    format!("INSERT INTO sync_outbox(entity_type,entity_id,data) VALUES('{kind}',{key},{data});")
}

/// Versioned, repeatable migration shared by startup and restore. Module schemas must exist first.
pub fn migrate(conn: &Connection) -> Result<(), String> {
    conn.create_scalar_function(
        "sync_source_id",
        2,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let kind = ctx.get::<String>(0)?;
            let encoded = ctx.get::<String>(1)?;
            let parts: Vec<String> = serde_json::from_str(&encoded)
                .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?;
            Ok(crate::import_sync::source_id(
                &kind,
                &parts.iter().map(String::as_str).collect::<Vec<_>>(),
            ))
        },
    )
    .map_err(sql_error)?;
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(sql_error)?;
    if version > 8 {
        return Err("数据库由较新版本创建，请升级应用".into());
    }
    conn.execute_batch("SAVEPOINT sync_migrate")
        .map_err(sql_error)?;
    let result = (|| -> Result<(), String> {
        conn.execute_batch("CREATE TABLE IF NOT EXISTS sync_runtime(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,replaying INTEGER NOT NULL DEFAULT 0,cloud_managed INTEGER NOT NULL DEFAULT 0,cursor INTEGER NOT NULL DEFAULT 0,baseline_done INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO sync_runtime(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS sync_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) UNIQUE,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,data TEXT);
      CREATE TABLE IF NOT EXISTS sync_shadow(entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,data TEXT,seq INTEGER NOT NULL,PRIMARY KEY(entity_type,entity_id));
      CREATE TABLE IF NOT EXISTS sync_business_history(id TEXT PRIMARY KEY,file_id TEXT NOT NULL DEFAULT '',link_id TEXT NOT NULL DEFAULT '',assignment_id TEXT NOT NULL DEFAULT '',assignment_title TEXT NOT NULL DEFAULT '',event_type TEXT NOT NULL,occurred_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_files(id TEXT PRIMARY KEY REFERENCES file_assets(id) ON DELETE CASCADE,name TEXT NOT NULL,mime TEXT NOT NULL DEFAULT 'application/octet-stream',size INTEGER,cloud_version TEXT);
      PRAGMA user_version=8;").map_err(sql_error)?;
        let columns = { let mut stmt = conn.prepare("PRAGMA table_info(sync_files)").map_err(sql_error)?;
            let rows = stmt.query_map([], |r| r.get::<_,String>(1)).map_err(sql_error)?;
            rows.collect::<Result<Vec<_>,_>>().map_err(sql_error)? };
        for (column, definition) in [("drive_id", "TEXT"), ("drive_resource_key", "TEXT"), ("drive_unavailable", "INTEGER NOT NULL DEFAULT 0")] {
            if !columns.iter().any(|c| c == column) { conn.execute_batch(&format!("ALTER TABLE sync_files ADD COLUMN {column} {definition}")).map_err(sql_error)?; }
        }
        let has_baseline: bool = {
            let mut stmt = conn
                .prepare("PRAGMA table_info(sync_runtime)")
                .map_err(sql_error)?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .map_err(sql_error)?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(sql_error)?
                .iter()
                .any(|s| s == "baseline_pending")
        };
        if !has_baseline {
            conn.execute_batch(
                "ALTER TABLE sync_runtime ADD COLUMN baseline_pending INTEGER NOT NULL DEFAULT 0",
            )
            .map_err(sql_error)?;
        }
        conn.execute_batch("CREATE TRIGGER IF NOT EXISTS drive_asset_identity BEFORE UPDATE OF id,path ON file_assets WHEN OLD.path LIKE 'gdrive:%' AND (NEW.path IS NOT OLD.path OR NEW.id IS NOT OLD.id) BEGIN SELECT RAISE(ABORT,'Drive identity is immutable'); END;
          CREATE TRIGGER IF NOT EXISTS drive_metadata_identity BEFORE UPDATE OF drive_id ON sync_files WHEN OLD.drive_id IS NOT NULL AND NEW.drive_id IS NOT OLD.drive_id BEGIN SELECT RAISE(ABORT,'Drive identity is immutable'); END;").map_err(sql_error)?;
        install_triggers(conn)
    })();
    match result {
        Ok(()) => conn
            .execute_batch("RELEASE sync_migrate")
            .map_err(sql_error),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK TO sync_migrate; RELEASE sync_migrate");
            Err(e)
        }
    }
}
fn install_triggers(conn: &Connection) -> Result<(), String> {
    for spec in SPECS {
        if !exists(conn, spec.table)? {
            continue;
        }
        let guard = "(SELECT enabled=1 AND replaying=0 FROM sync_runtime WHERE id=1)";
        for (event, prefix) in [("INSERT", "NEW"), ("DELETE", "OLD")] {
            let data = if event == "DELETE" {
                "NULL".into()
            } else {
                object(spec, prefix)
            };
            conn.execute_batch(&format!("DROP TRIGGER IF EXISTS sync_{}_{}; CREATE TRIGGER sync_{}_{} AFTER {event} ON {} WHEN {guard} AND ({}) BEGIN {} END;",spec.kind,event.to_lowercase(),spec.kind,event.to_lowercase(),spec.table,filter(spec,prefix),queue_sql(spec.kind,&prefixed(spec.key,prefix),&data))).map_err(sql_error)?;
        }
        if import_keys(spec.kind).is_some() {
            let changed = spec
                .columns
                .iter()
                .map(|col| format!("NEW.{col} IS NOT OLD.{col}"))
                .collect::<Vec<_>>()
                .join(" OR ");
            conn.execute_batch(&format!("DROP TRIGGER IF EXISTS sync_{}_update; CREATE TRIGGER sync_{}_update AFTER UPDATE ON {} WHEN {guard} AND ({changed}) BEGIN {} END;",spec.kind,spec.kind,spec.table,queue_sql(spec.kind,&prefixed(spec.key,"NEW"),&object(spec,"NEW")))).map_err(sql_error)?;
            continue;
        }
        if spec.kind == "recurring_occurrence" {
            // These fields describe one user intent. Splitting a deletion into separate
            // state and assignment patches lets the server observe an invalid half-state.
            for col in ["state", "assignment_id", "overridden"] {
                conn.execute_batch(&format!(
                    "DROP TRIGGER IF EXISTS sync_recurring_occurrence_update_{col}"
                ))
                .map_err(sql_error)?;
            }
            conn.execute_batch(&format!("DROP TRIGGER IF EXISTS sync_recurring_occurrence_update_intent; CREATE TRIGGER sync_recurring_occurrence_update_intent AFTER UPDATE OF state,assignment_id,overridden ON recurring_occurrences WHEN {guard} AND (NEW.state IS NOT OLD.state OR NEW.assignment_id IS NOT OLD.assignment_id OR NEW.overridden IS NOT OLD.overridden) BEGIN {} END;",queue_sql(spec.kind,"NEW.id","json_object('state',NEW.state,'assignment_id',NEW.assignment_id,'overridden',NEW.overridden)"))).map_err(sql_error)?;
        }
        for col in spec.columns {
            if spec.kind == "recurring_occurrence"
                && matches!(*col, "state" | "assignment_id" | "overridden")
            {
                continue;
            }
            if spec.kind == "file" && *col == "cloud_version" {
                conn.execute_batch("DROP TRIGGER IF EXISTS sync_file_update_cloud_version")
                    .map_err(sql_error)?;
                continue;
            }
            conn.execute_batch(&format!("DROP TRIGGER IF EXISTS sync_{}_update_{col}; CREATE TRIGGER sync_{}_update_{col} AFTER UPDATE OF {col} ON {} WHEN {guard} AND ({}) AND NEW.{col} IS NOT OLD.{col} BEGIN {} END;",spec.kind,spec.kind,spec.table,filter(spec,"NEW"),queue_sql(spec.kind,&prefixed(spec.key,"NEW"),&if spec.kind=="module_state"&&*col=="enabled"{format!("json_object('{col}',json(CASE WHEN NEW.{col} THEN 'true' ELSE 'false' END))")}else{format!("json_object('{col}',NEW.{col})")}))).map_err(sql_error)?;
        }
    }
    if exists(conn, "assignment_custom_fields")? {
        for (event, prefix) in [("INSERT", "NEW"), ("UPDATE", "NEW"), ("DELETE", "OLD")] {
            conn.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS sync_custom_{} AFTER {event} ON assignment_custom_fields WHEN (SELECT enabled=1 AND replaying=0 FROM sync_runtime WHERE id=1) AND EXISTS(SELECT 1 FROM assignments WHERE id={prefix}.assignment_id) BEGIN {} END;",event.to_lowercase(),queue_sql("assignment",&format!("{prefix}.assignment_id"),&format!("json_object('custom_fields',json(COALESCE((SELECT json_group_object(field_key,field_value) FROM assignment_custom_fields WHERE assignment_id={prefix}.assignment_id),'{{}}')))")))).map_err(sql_error)?;
        }
    }
    // New local file identities acquire only their basename. No absolute path enters sync_files.
    if exists(conn, "file_assets")? {
        for event in ["INSERT", "UPDATE OF path"] {
            let suffix = if event == "INSERT" {
                "insert"
            } else {
                "update"
            };
            conn.execute_batch(&format!("DROP TRIGGER IF EXISTS sync_file_identity_{suffix}; CREATE TRIGGER sync_file_identity_{suffix} AFTER {event} ON file_assets WHEN (SELECT enabled=1 AND replaying=0 FROM sync_runtime WHERE id=1) AND NEW.path NOT LIKE 'cloud://%' AND NEW.path NOT LIKE 'gdrive:%' BEGIN INSERT INTO sync_files(id,name) VALUES(NEW.id,(WITH RECURSIVE parts(s) AS (SELECT replace(NEW.path,char(92),'/') UNION ALL SELECT substr(s,instr(s,'/')+1) FROM parts WHERE instr(s,'/')>0) SELECT s FROM parts WHERE instr(s,'/')=0)) ON CONFLICT(id) DO UPDATE SET name=excluded.name; END;")).map_err(sql_error)?;
        }
    }
    if exists(conn, "file_history")? {
        conn.execute_batch("CREATE TRIGGER IF NOT EXISTS sync_business_audit AFTER INSERT ON file_history WHEN (SELECT enabled=1 AND replaying=0 FROM sync_runtime WHERE id=1) AND NEW.event_type NOT IN ('tracking_started','content_changed','renamed','rename_undone','relocated') BEGIN INSERT OR IGNORE INTO sync_business_history(id,file_id,link_id,assignment_id,assignment_title,event_type,occurred_at) VALUES(NEW.id,NEW.file_id,NEW.link_id,NEW.assignment_id,NEW.assignment_title,NEW.event_type,NEW.occurred_at); END;").map_err(sql_error)?;
    }
    Ok(())
}

fn config_path(state: &AppState) -> Result<PathBuf, String> {
    Ok(state
        .modules_dir
        .parent()
        .ok_or("数据目录无效")?
        .join("sync-device.json"))
}
fn read_config(state: &AppState) -> Result<Config, String> {
    let p = config_path(state)?;
    if !p.exists() {
        return Ok(Config::default());
    }
    serde_json::from_slice(&std::fs::read(p).map_err(|_| "无法读取本机同步设置")?)
        .map_err(|_| "本机同步设置损坏，请断开后重新配对".into())
}
fn write_config(state: &AppState, c: &Config) -> Result<(), String> {
    let p = config_path(state)?;
    let temp = p.with_extension("tmp");
    let bytes = serde_json::to_vec(c).map_err(|_| "无法保存同步设置")?;
    std::fs::write(&temp, bytes).map_err(|_| "无法保存同步设置")?;
    // Windows rename cannot replace an existing destination.
    if p.exists() {
        std::fs::remove_file(&p).map_err(|_| "无法替换同步设置")?;
    }
    std::fs::rename(temp, p).map_err(|_| "无法保存同步设置".into())
}
fn key(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("app.homeworkbook.local.sync", id)
        .map_err(|_| "无法访问系统凭据存储".into())
}
fn secret(id: &str) -> Result<String, String> {
    key(id)?
        .get_password()
        .map_err(|_| "请解锁系统凭据存储或重新配对设备".into())
}
fn save_secret(id: &str, value: &str) -> Result<(), String> {
    key(id)?
        .set_password(value)
        .map_err(|_| "无法保存到系统凭据存储；不会回退到明文".into())
}
fn forget_secret(id: &str) {
    if let Ok(k) = key(id) {
        let _ = k.delete_credential();
    }
}
fn validate_url(raw: &str) -> Result<String, String> {
    let u = reqwest::Url::parse(raw).map_err(|_| "同步服务地址无效")?;
    let loopback = matches!(
        u.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if !(u.scheme() == "https" || (u.scheme() == "http" && loopback))
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.host_str().is_none()
        || u.path() != "/"
    {
        return Err("请输入 HTTPS 服务源地址（本机开发可用 HTTP），不得含路径、凭据或参数".into());
    }
    Ok(u.as_str().trim_end_matches('/').into())
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法创建同步连接".into())
}
async fn json_response(r: reqwest::Response) -> Result<Value, String> {
    if !r.status().is_success() {
        return Err(format!("同步请求失败（HTTP {}）", r.status().as_u16()));
    }
    if r.content_length().is_some_and(|n| n > MAX_BODY as u64) {
        return Err("同步响应超出大小限制".into());
    }
    let mut r = r;
    let mut bytes = Vec::new();
    while let Some(chunk) = r.chunk().await.map_err(|_| "同步响应读取失败")? {
        if bytes.len() + chunk.len() > MAX_BODY {
            return Err("同步响应超出大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&bytes).map_err(|_| "同步服务返回格式无效".into())
}
async fn request(
    c: &Config,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    auth: bool,
) -> Result<Value, String> {
    let url = validate_url(&c.server_url)?;
    let mut req = client()?.request(method, format!("{url}{path}"));
    if auth {
        if c.device_id.is_empty() {
            return Err("请先配对设备".into());
        }
        req = req.bearer_auth(secret(&c.device_id)?);
    }
    if let Some(b) = body {
        req = req.json(&b)
    }
    json_response(
        req.send()
            .await
            .map_err(|_| "无法连接同步服务，请检查网络或设备授权")?,
    )
    .await
}
fn counts(conn: &Connection) -> Result<Value, String> {
    let mut result = Map::new();
    for spec in SPECS {
        if exists(conn, spec.table)? {
            let n: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM {} WHERE {}", spec.table, spec.filter),
                    [],
                    |r| r.get(0),
                )
                .map_err(sql_error)?;
            result.insert(spec.kind.into(), json!(n));
        }
    }
    Ok(Value::Object(result))
}
fn ensure_active(state: &AppState, expected: &Config) -> Result<(), String> {
    let actual = read_config(state)?;
    if actual.device_id != expected.device_id || actual.server_url != expected.server_url {
        return Err("设备连接已改变，已停止本轮同步".into());
    }
    let conn = state.db.lock().map_err(|_| "数据库繁忙")?;
    let enabled: bool = conn
        .query_row("SELECT enabled FROM sync_runtime WHERE id=1", [], |r| {
            r.get(0)
        })
        .map_err(sql_error)?;
    if !enabled {
        return Err("同步已暂停".into());
    }
    Ok(())
}
fn status(state: &AppState) -> Result<Status, String> {
    let c = read_config(state)?;
    let conn = state.db.lock().map_err(|_| "数据库繁忙")?;
    let (enabled, cursor): (bool, i64) = conn
        .query_row(
            "SELECT enabled,cursor FROM sync_runtime WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(sql_error)?;
    let pending = conn
        .query_row("SELECT count(*) FROM sync_outbox", [], |r| r.get(0))
        .map_err(sql_error)?;
    Ok(Status {
        enabled,
        server_url: c.server_url,
        connected: !c.device_id.is_empty(),
        device_id: c.device_id,
        device_name: c.device_name,
        pending,
        cursor,
        last_synced_at: c.last_synced_at,
        error: c.error,
        baseline_counts: counts(&conn)?,
    })
}
#[tauri::command]
pub fn sync_status(state: State<'_, AppState>) -> Result<Status, String> {
    status(&state)
}
#[tauri::command]
pub async fn sync_pair_start(
    state: State<'_, AppState>,
    server_url: String,
    device_name: String,
) -> Result<Value, String> {
    if device_name.trim().is_empty() || device_name.len() > 100 {
        return Err("请输入不超过100字符的设备名称".into());
    }
    if !read_config(&state)?.device_id.is_empty() {
        return Err("请先断开当前设备连接".into());
    }
    let c = Config {
        server_url: validate_url(&server_url)?,
        device_name: device_name.trim().into(),
        ..Config::default()
    };
    let v = request(
        &c,
        reqwest::Method::POST,
        "/api/pair/start",
        Some(json!({"device_name":c.device_name,"client_type":"desktop"})),
        false,
    )
    .await?;
    let pair: PairRequest = serde_json::from_value(v).map_err(|_| "配对响应无效")?;
    save_secret(&format!("pair:{}", pair.pair_id), &pair.poll_secret)?;
    let c = Config {
        pair_id: pair.pair_id.clone(),
        ..c
    };
    write_config(&state, &c)?;
    Ok(json!({"pair_id":pair.pair_id,"code":pair.code,"expires_at":pair.expires_at}))
}
fn accept_device(state: &AppState, mut c: Config, result: &PairResult) -> Result<(), String> {
    let device = result.device.as_ref().ok_or("配对响应缺少设备")?;
    let token = result.token.as_ref().ok_or("配对响应缺少凭据")?;
    if device.id.is_empty() || token.is_empty() {
        return Err("设备授权无效".into());
    }
    save_secret(&device.id, token)?;
    if !c.pair_id.is_empty() {
        forget_secret(&format!("pair:{}", c.pair_id));
    }
    c.device_id = device.id.clone();
    c.device_name = device.name.clone();
    c.pair_id.clear();
    c.error = None;
    write_config(state, &c)?;
    let conn = state.db.lock().map_err(|_| "数据库繁忙")?;
    conn.execute_batch("UPDATE sync_runtime SET enabled=0,cursor=0,baseline_done=0,baseline_pending=0; DELETE FROM sync_outbox; DELETE FROM sync_shadow;").map_err(sql_error)
}
#[tauri::command]
pub async fn sync_pair_poll(state: State<'_, AppState>) -> Result<PairResult, String> {
    let c = read_config(&state)?;
    if c.pair_id.is_empty() {
        return Err("没有等待中的配对请求".into());
    }
    let poll = secret(&format!("pair:{}", c.pair_id))?;
    let v = request(
        &c,
        reqwest::Method::POST,
        "/api/pair/poll",
        Some(json!({"pair_id":c.pair_id,"poll_secret":poll})),
        false,
    )
    .await?;
    let r: PairResult = serde_json::from_value(v).map_err(|_| "配对响应无效")?;
    if r.state == "approved" {
        accept_device(&state, c, &r)?;
    }
    Ok(r)
}
#[tauri::command]
pub async fn sync_bootstrap(
    state: State<'_, AppState>,
    server_url: String,
    device_name: String,
    bootstrap_secret: String,
) -> Result<Status, String> {
    if !read_config(&state)?.device_id.is_empty() {
        return Err("请先断开当前设备连接".into());
    }
    if device_name.trim().is_empty() || device_name.len() > 100 || bootstrap_secret.is_empty() {
        return Err("设备名称或初始化授权无效".into());
    }
    let c = Config {
        server_url: validate_url(&server_url)?,
        device_name: device_name.trim().into(),
        ..Config::default()
    };
    let v=request(&c,reqwest::Method::POST,"/api/bootstrap",Some(json!({"bootstrap_secret":bootstrap_secret,"device_name":c.device_name,"client_type":"desktop"})),false).await?;
    let r = PairResult {
        state: "approved".into(),
        token: v.get("token").and_then(Value::as_str).map(str::to_owned),
        device: Some(
            serde_json::from_value(v.get("device").cloned().ok_or("初始化响应无效")?)
                .map_err(|_| "初始化设备无效")?,
        ),
    };
    accept_device(&state, c, &r)?;
    status(&state)
}

fn seed_files(conn: &Connection) -> Result<(), String> {
    let rows = {
        let mut stmt = conn
            .prepare("SELECT id,path FROM file_assets WHERE id NOT IN (SELECT id FROM sync_files)")
            .map_err(sql_error)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(sql_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sql_error)?
    };
    for (id, path) in rows {
        let name = Path::new(&path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "附件".into());
        conn.execute(
            "INSERT OR IGNORE INTO sync_files(id,name) VALUES(?1,?2)",
            params![id, name],
        )
        .map_err(sql_error)?;
    }
    Ok(())
}
fn seed_baseline(conn: &Connection) -> Result<(), String> {
    seed_files(conn)?;
    if exists(conn, "file_history")? {
        conn.execute_batch("INSERT OR IGNORE INTO sync_business_history(id,file_id,link_id,assignment_id,assignment_title,event_type,occurred_at) SELECT id,file_id,link_id,assignment_id,assignment_title,event_type,occurred_at FROM file_history WHERE event_type NOT IN ('tracking_started','content_changed','renamed','rename_undone','relocated')").map_err(sql_error)?;
    }
    for spec in SPECS {
        if !exists(conn, spec.table)? {
            continue;
        }
        let rows = {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {},{} FROM {} x WHERE {}",
                    prefixed(spec.key, "x"),
                    object(spec, "x"),
                    spec.table,
                    filter(spec, "x")
                ))
                .map_err(sql_error)?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(sql_error)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(sql_error)?
        };
        for (id, raw) in rows {
            let current: Value = serde_json::from_str(&raw).map_err(|_| "本地同步数据无效")?;
            let old: Option<Option<String>> = conn
                .query_row(
                    "SELECT data FROM sync_shadow WHERE entity_type=?1 AND entity_id=?2",
                    params![spec.kind, id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(sql_error)?;
            if matches!(old, Some(None)) {
                continue;
            } // tombstones are never implicitly restored
            let old_data = old
                .flatten()
                .and_then(|v| serde_json::from_str::<Value>(&v).ok());
            let mut patch: Map<String, Value> = current
                .as_object()
                .ok_or("同步实体格式无效")?
                .iter()
                .filter(|(k, v)| old_data.as_ref().and_then(|d| d.get(*k)) != Some(*v))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            if !patch.is_empty() {
                if let Some(keys) = import_keys(spec.kind) {
                    for key in keys {
                        patch.insert((*key).into(), current[*key].clone());
                    }
                }
            }
            // Re-enable computes a diff instead of firing triggers, but must preserve
            // the same atomic recurrence intent as a live edit.
            if spec.kind == "recurring_occurrence"
                && ["state", "assignment_id", "overridden"]
                    .iter()
                    .any(|key| patch.contains_key(*key))
            {
                for key in ["state", "assignment_id", "overridden"] {
                    patch.insert(key.into(), current[key].clone());
                }
            }
            if !patch.is_empty() {
                conn.execute(
                    "INSERT INTO sync_outbox(entity_type,entity_id,data) VALUES(?1,?2,?3)",
                    params![spec.kind, id, Value::Object(patch).to_string()],
                )
                .map_err(sql_error)?;
            }
        }
        let gone = {
            let mut stmt=conn.prepare("SELECT entity_id,data FROM sync_shadow WHERE entity_type=?1 AND data IS NOT NULL").map_err(sql_error)?;
            let rows = stmt
                .query_map([spec.kind], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(sql_error)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(sql_error)?
        };
        for (id, raw) in gone {
            let data: Value = serde_json::from_str(&raw).map_err(|_| "同步基线损坏")?;
            let keys = sql_key(spec, &id, &data)?;
            let predicate = keys
                .iter()
                .enumerate()
                .map(|(i, (k, _))| format!("{k}=?{}", i + 1))
                .collect::<Vec<_>>()
                .join(" AND ");
            let exists: bool = conn
                .query_row(
                    &format!(
                        "SELECT EXISTS(SELECT 1 FROM {} WHERE {predicate})",
                        spec.table
                    ),
                    rusqlite::params_from_iter(keys.iter().map(|(_, v)| value_sql(v))),
                    |r| r.get(0),
                )
                .map_err(sql_error)?;
            if !exists {
                conn.execute(
                    "INSERT INTO sync_outbox(entity_type,entity_id,data) VALUES(?1,?2,NULL)",
                    params![spec.kind, id],
                )
                .map_err(sql_error)?;
            }
        }
    }
    Ok(())
}
#[tauri::command]
pub fn sync_set_enabled(state: State<'_, AppState>, enabled: bool) -> Result<Status, String> {
    let c = read_config(&state)?;
    if enabled {
        if c.device_id.is_empty() {
            return Err("请先配对设备".into());
        }
        secret(&c.device_id)?;
    }
    {
        let mut conn = state.db.lock().map_err(|_| "数据库繁忙")?;
        configure_enabled(&mut conn, enabled)?;
    }
    status(&state)
}
fn configure_enabled(conn: &mut Connection, enabled: bool) -> Result<(), String> {
    let tx = conn.transaction().map_err(sql_error)?;
    if enabled {
        let baseline: bool = tx
            .query_row(
                "SELECT baseline_done FROM sync_runtime WHERE id=1",
                [],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        if !baseline {
            seed_baseline(&tx)?;
            tx.execute("UPDATE sync_runtime SET baseline_pending=1 WHERE id=1", [])
                .map_err(sql_error)?;
        }
        tx.execute(
            "UPDATE sync_runtime SET enabled=1,cloud_managed=1,baseline_done=1 WHERE id=1",
            [],
        )
        .map_err(sql_error)?;
    } else {
        tx.execute(
            "UPDATE sync_runtime SET enabled=0,baseline_done=0 WHERE id=1",
            [],
        )
        .map_err(sql_error)?;
    }
    tx.commit().map_err(sql_error)
}
fn pending(conn: &Connection, limit: usize) -> Result<Vec<Operation>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT operation_id,entity_type,entity_id,data FROM sync_outbox ORDER BY id LIMIT ?1",
        )
        .map_err(sql_error)?;
    let rows = stmt
        .query_map([limit as i64], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(sql_error)?;
    rows.map(|row| {
        let (id, kind, key, data) = row.map_err(sql_error)?;
        Ok(Operation {
            operation_id: id,
            changes: vec![Mutation {
                entity_type: kind,
                entity_id: key,
                data: data
                    .map(|s| serde_json::from_str(&s))
                    .transpose()
                    .map_err(|_| "待同步数据损坏")?,
            }],
        })
    })
    .collect()
}
fn merge(base: Option<Value>, patch: &Value) -> Value {
    let mut out = base
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    if let Some(fields) = patch.as_object() {
        for (k, v) in fields {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}
fn value_sql(v: &Value) -> rusqlite::types::Value {
    match v {
        Value::Null => rusqlite::types::Value::Null,
        Value::Bool(b) => rusqlite::types::Value::Integer(i64::from(*b)),
        Value::Number(n) => rusqlite::types::Value::Integer(n.as_i64().unwrap_or(0)),
        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        other => rusqlite::types::Value::Text(other.to_string()),
    }
}
fn import_keys(kind: &str) -> Option<&'static [&'static str]> {
    match kind {
        "import_course_map" => Some(&["module_id", "account_key", "remote_course_id"]),
        "import_link" | "import_ignored" => Some(&[
            "module_id",
            "account_key",
            "remote_course_id",
            "remote_assignment_id",
        ]),
        _ => None,
    }
}
fn sql_key(spec: &Spec, id: &str, data: &Value) -> Result<Vec<(&'static str, Value)>, String> {
    if let Some(keys) = import_keys(spec.kind) {
        keys.iter()
            .map(|&key| {
                let value = data
                    .get(key)
                    .and_then(Value::as_str)
                    .ok_or("来源映射键无效")?;
                Ok((key, json!(value)))
            })
            .collect()
    } else if spec.kind == "common_file" {
        let course = data
            .get("course_id")
            .and_then(Value::as_str)
            .or_else(|| id.split_once(':').map(|v| v.0))
            .ok_or("常用文件键无效")?;
        let file = data
            .get("file_id")
            .and_then(Value::as_str)
            .or_else(|| id.split_once(':').map(|v| v.1))
            .ok_or("常用文件键无效")?;
        Ok(vec![("course_id", json!(course)), ("file_id", json!(file))])
    } else {
        Ok(vec![(spec.key, json!(id))])
    }
}
fn keys_contains(spec: &Spec, key: &str) -> bool {
    if let Some(keys) = import_keys(spec.kind) {
        keys.contains(&key)
    } else if spec.kind == "common_file" {
        matches!(key, "course_id" | "file_id")
    } else {
        spec.key == key
    }
}
fn apply_entity(
    conn: &Connection,
    kind: &str,
    id: &str,
    data: Option<&Value>,
) -> Result<(), String> {
    let Some(spec) = SPECS.iter().find(|s| s.kind == kind) else {
        if kind == "history" {
            return Ok(());
        }
        return Err("未知同步实体".into());
    };
    let empty = json!({});
    let payload = data.unwrap_or(&empty);
    let delete_payload;
    let payload = if data.is_none() && import_keys(kind).is_some() {
        let raw: Option<String> = conn
            .query_row(
                &format!(
                    "SELECT {} FROM {} x WHERE {}=?1",
                    object(spec, "x"),
                    spec.table,
                    prefixed(spec.key, "x")
                ),
                [id],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql_error)?;
        let Some(raw) = raw else {
            return Ok(());
        };
        delete_payload = serde_json::from_str::<Value>(&raw).map_err(|_| "来源映射数据无效")?;
        &delete_payload
    } else {
        payload
    };
    let keys = sql_key(spec, id, payload)?;
    let where_sql = keys
        .iter()
        .enumerate()
        .map(|(i, (k, _))| format!("{k}=?{}", i + 1))
        .collect::<Vec<_>>()
        .join(" AND ");
    let key_values = keys.iter().map(|(_, v)| value_sql(v)).collect::<Vec<_>>();
    if data.is_none() {
        conn.execute(
            &format!("DELETE FROM {} WHERE {where_sql}", spec.table),
            rusqlite::params_from_iter(key_values.clone()),
        )
        .map_err(sql_error)?;
        return Ok(());
    }
    if !payload.is_object() {
        return Err("同步实体格式无效".into());
    }
    if kind == "file" {
        let drive = payload.get("drive_id").and_then(Value::as_str);
        if let Some(drive) = drive {
            crate::drive::validate_id(drive)?;
            if id != format!("gdrive-{drive}") { return Err("Drive 文件标识不一致".into()); }
        }
        let existing: Option<String> = conn.query_row("SELECT path FROM file_assets WHERE id=?1", [id], |r| r.get(0)).optional().map_err(sql_error)?;
        if let Some(existing) = existing {
            if drive.is_some_and(|d| existing != format!("gdrive:{d}")) { return Err("Drive 文件标识不可更改".into()); }
        }
        conn.execute(
            "INSERT OR IGNORE INTO file_assets(id,path) VALUES(?1,?2)",
            params![id, drive.map(|d| format!("gdrive:{d}")).unwrap_or_else(|| format!("cloud://{id}"))],
        )
        .map_err(sql_error)?;
    }
    let mut fields = keys;
    for col in spec.columns {
        if fields.iter().any(|(k, _)| k == col) {
            continue;
        }
        if let Some(v) = payload.get(*col) {
            fields.push((col, v.clone()));
        }
    }
    // Fields with no SQL defaults are synthesized only for a new row; they are never sent as patches.
    let is_new: bool = !conn
        .query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM {} WHERE {where_sql})",
                spec.table
            ),
            rusqlite::params_from_iter(key_values.clone()),
            |r| r.get::<_, bool>(0),
        )
        .map_err(sql_error)?;
    if is_new {
        for col in spec.columns {
            if !fields.iter().any(|(k, _)| k == col) {
                let v = match *col {
                    "max_occurrences" | "end_at" | "scheduled_at" | "due_at" | "assignment_id"
                    | "size" | "cloud_version" | "drive_id" | "drive_resource_key" => Value::Null,
                    "sequence_no" | "overridden" | "drive_unavailable" => json!(0),
                    "enabled" => json!(true),
                    "status" => json!(if kind == "assignment" {
                        "todo"
                    } else {
                        "active"
                    }),
                    "state" => json!("planned"),
                    _ => json!(""),
                };
                fields.push((col, v));
            }
        }
        if kind == "recurring_occurrence" {
            fields.push(("created_at", json!(crate::db::now())));
            fields.push(("updated_at", json!(crate::db::now())));
        }
        if matches!(kind, "module_state" | "calendar") {
            fields.push(("updated_at", json!(crate::db::now())));
        }
    }
    if is_new {
        let cols = fields.iter().map(|(k, _)| *k).collect::<Vec<_>>();
        let marks = (1..=cols.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>();
        let updates = cols
            .iter()
            .filter(|c| !keys_contains(spec, c))
            .map(|c| format!("{c}=excluded.{c}"))
            .collect::<Vec<_>>();
        let conflict = if kind == "common_file" {
            "course_id,file_id".to_string()
        } else if let Some(keys) = import_keys(kind) {
            keys.join(",")
        } else {
            spec.key.to_string()
        };
        let action = if updates.is_empty() {
            "DO NOTHING".into()
        } else {
            format!("DO UPDATE SET {}", updates.join(","))
        };
        conn.execute(
            &format!(
                "INSERT INTO {}({}) VALUES({}) ON CONFLICT({conflict}) {action}",
                spec.table,
                cols.join(","),
                marks.join(",")
            ),
            rusqlite::params_from_iter(fields.iter().map(|(_, v)| value_sql(v))),
        )
        .map_err(sql_error)?;
    } else {
        let changed = fields
            .iter()
            .filter(|(k, _)| !keys_contains(spec, k))
            .collect::<Vec<_>>();
        if !changed.is_empty() {
            let assignments = changed
                .iter()
                .enumerate()
                .map(|(i, (k, _))| format!("{k}=?{}", i + 1))
                .collect::<Vec<_>>()
                .join(",");
            let predicate = sql_key(spec, id, payload)?
                .iter()
                .enumerate()
                .map(|(i, (k, _))| format!("{k}=?{}", changed.len() + i + 1))
                .collect::<Vec<_>>()
                .join(" AND ");
            let mut vals = changed
                .iter()
                .map(|(_, v)| value_sql(v))
                .collect::<Vec<_>>();
            vals.extend(key_values);
            conn.execute(
                &format!("UPDATE {} SET {assignments} WHERE {predicate}", spec.table),
                rusqlite::params_from_iter(vals),
            )
            .map_err(sql_error)?;
        }
    }
    if kind == "history" && exists(conn, "file_history")? {
        let file_id = payload.get("file_id").and_then(Value::as_str).unwrap_or("");
        conn.execute("INSERT OR IGNORE INTO file_history(id,file_id,link_id,assignment_id,assignment_title,event_type,path,details,occurred_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'',?8)",params![id,file_id,payload.get("link_id").and_then(Value::as_str).unwrap_or(""),payload.get("assignment_id").and_then(Value::as_str).unwrap_or(""),payload.get("assignment_title").and_then(Value::as_str).unwrap_or(""),payload.get("event_type").and_then(Value::as_str).unwrap_or("synced"),format!("cloud://{file_id}"),payload.get("occurred_at").and_then(Value::as_str).unwrap_or("")]).map_err(sql_error)?;
    }
    if kind == "assignment" {
        if let Some(custom) = payload.get("custom_fields") {
            let fields = custom.as_object().ok_or("自定义字段格式无效")?;
            conn.execute(
                "DELETE FROM assignment_custom_fields WHERE assignment_id=?1",
                [id],
            )
            .map_err(sql_error)?;
            for (k, v) in fields {
                let value = v.as_str().ok_or("自定义字段值无效")?;
                conn.execute("INSERT INTO assignment_custom_fields(assignment_id,field_key,field_value) VALUES(?1,?2,?3)",params![id,k,value]).map_err(sql_error)?;
            }
        }
    }
    Ok(())
}
fn replay(conn: &mut Connection, response: &Response) -> Result<(), String> {
    let tx = conn.transaction().map_err(sql_error)?;
    tx.execute("UPDATE sync_runtime SET replaying=1 WHERE id=1", [])
        .map_err(sql_error)?;
    tx.execute_batch("PRAGMA defer_foreign_keys=ON")
        .map_err(sql_error)?;
    for id in &response.acknowledged {
        tx.execute("DELETE FROM sync_outbox WHERE operation_id=?1", [id])
            .map_err(sql_error)?;
    }
    for e in &response.changes {
        let old: Option<(Option<String>, i64)> = tx
            .query_row(
                "SELECT data,seq FROM sync_shadow WHERE entity_type=?1 AND entity_id=?2",
                params![e.entity_type, e.entity_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(sql_error)?;
        if old.as_ref().is_some_and(|(_, seq)| *seq >= e.seq) {
            continue;
        }
        let data = match &e.data {
            None => None,
            Some(patch) => Some(merge(
                old.and_then(|(v, _)| v.and_then(|s| serde_json::from_str(&s).ok())),
                patch,
            )),
        };
        tx.execute("INSERT INTO sync_shadow(entity_type,entity_id,data,seq) VALUES(?1,?2,?3,?4) ON CONFLICT(entity_type,entity_id) DO UPDATE SET data=excluded.data,seq=excluded.seq",params![e.entity_type,e.entity_id,data.as_ref().map(Value::to_string),e.seq]).map_err(sql_error)?;
        apply_entity(&tx, &e.entity_type, &e.entity_id, data.as_ref())?;
        // A server tombstone invalidates stale queued edits rather than resurrecting the row.
        if data.is_none() {
            tx.execute(
                "DELETE FROM sync_outbox WHERE entity_type=?1 AND entity_id=?2",
                params![e.entity_type, e.entity_id],
            )
            .map_err(sql_error)?;
        }
    }
    for op in pending(&tx, usize::MAX / 2)? {
        for change in op.changes {
            apply_entity(
                &tx,
                &change.entity_type,
                &change.entity_id,
                change.data.as_ref(),
            )?;
        }
    }
    tx.execute(
        "UPDATE sync_runtime SET replaying=0,cursor=?1 WHERE id=1",
        [response.cursor],
    )
    .map_err(sql_error)?;
    tx.commit().map_err(sql_error)
}
fn replay_active(
    state: &AppState,
    expected: &Config,
    response: &Response,
    phase: Option<i64>,
) -> Result<(), String> {
    let mut conn = state.db.lock().map_err(|_| "数据库繁忙")?;
    let actual = read_config(state)?;
    let enabled: bool = conn
        .query_row("SELECT enabled FROM sync_runtime WHERE id=1", [], |r| {
            r.get(0)
        })
        .map_err(sql_error)?;
    if !enabled
        || actual.device_id != expected.device_id
        || actual.server_url != expected.server_url
    {
        return Err("同步已暂停或设备连接已改变".into());
    }
    replay(&mut conn, response)?;
    if let Some(phase) = phase {
        conn.execute(
            "UPDATE sync_runtime SET baseline_pending=?1 WHERE id=1",
            [phase],
        )
        .map_err(sql_error)?;
    }
    Ok(())
}

async fn sync_rounds(state: &AppState, config: &mut Config) -> Result<(), String> {
    for _ in 0..100 {
        ensure_active(state, config)?;
        let (cursor, operations, baseline_pending) = {
            let mut conn = state.db.lock().map_err(|_| "数据库繁忙")?;
            let tx = conn.transaction().map_err(sql_error)?;
            seed_files(&tx)?;
            let (cursor, phase) = tx
                .query_row(
                    "SELECT cursor,baseline_pending FROM sync_runtime WHERE id=1",
                    [],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
                )
                .map_err(sql_error)?;
            let operations = pending(&tx, 100)?;
            tx.commit().map_err(sql_error)?;
            (cursor, operations, phase)
        };
        if baseline_pending == 1 {
            // Pause cloud generation before importing any existing occurrence/assignment pair.
            let value = request(
                config,
                reqwest::Method::POST,
                "/api/sync",
                Some(json!({"cursor":cursor,"operations":[],"baseline":"begin","limit":500})),
                true,
            )
            .await?;
            let response: Response =
                serde_json::from_value(value).map_err(|_| "同步基线响应无效")?;
            replay_active(state, config, &response, Some(2))?;
            continue;
        }
        let mut body = json!({"cursor":cursor,"operations":operations,"limit":500});
        while serde_json::to_vec(&body).map_err(|_| "同步数据无效")?.len() > MAX_BODY {
            let operations = body["operations"].as_array_mut().ok_or("同步数据无效")?;
            if operations.len() <= 1 {
                return Err("单条同步数据超出大小限制".into());
            }
            operations.pop();
        }
        ensure_active(state, config)?;
        let value = request(config, reqwest::Method::POST, "/api/sync", Some(body), true).await?;
        let response: Response = serde_json::from_value(value).map_err(|_| "同步响应格式无效")?;
        replay_active(state, config, &response, None)?;
        config.last_synced_at = Some(response.server_time);
        config.error = None;
        let has_pending = {
            let conn = state.db.lock().map_err(|_| "数据库繁忙")?;
            conn.query_row("SELECT EXISTS(SELECT 1 FROM sync_outbox)", [], |r| {
                r.get::<_, bool>(0)
            })
            .map_err(sql_error)?
        };
        if !response.has_more && !has_pending {
            if baseline_pending == 2 {
                ensure_active(state, config)?;
                let value=request(config,reqwest::Method::POST,"/api/sync",Some(json!({"cursor":response.cursor,"operations":[],"baseline":"complete","limit":500})),true).await?;
                let completion: Response =
                    serde_json::from_value(value).map_err(|_| "同步基线完成响应无效")?;
                replay_active(state, config, &completion, Some(0))?;
                // Cloud generation can now publish new records. Drain any resulting pages as well.
                continue;
            }
            return Ok(());
        }
    }
    Err("本轮同步量较大，请再次同步以继续".into())
}

#[tauri::command]
pub async fn sync_now(state: State<'_, AppState>) -> Result<Status, String> {
    if RUNNING.swap(true, Ordering::AcqRel) {
        return Err("同步正在进行".into());
    }
    let _running = Running;
    let mut config = read_config(&state)?;
    let result = sync_rounds(&state, &mut config).await;
    if let Err(ref error) = result {
        config.error = Some(error.clone());
    }
    let actual = read_config(&state)?;
    if actual.device_id != config.device_id || actual.server_url != config.server_url {
        return Err("设备连接已改变，已停止本轮同步".into());
    }
    write_config(&state, &config)?;
    result?;
    status(&state)
}
#[tauri::command]
pub async fn sync_devices(state: State<'_, AppState>) -> Result<Value, String> {
    request(
        &read_config(&state)?,
        reqwest::Method::GET,
        "/api/devices",
        None,
        true,
    )
    .await
}
#[tauri::command]
pub async fn sync_approve_pair(state: State<'_, AppState>, code: String) -> Result<Value, String> {
    request(
        &read_config(&state)?,
        reqwest::Method::POST,
        "/api/pair/approve",
        Some(json!({"code":code})),
        true,
    )
    .await
}
fn safe_id(id: &str) -> Result<&str, String> {
    if id.is_empty()
        || id.len() > 200
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    {
        return Err("同步标识无效".into());
    }
    Ok(id)
}
#[tauri::command]
pub async fn sync_revoke_device(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<Value, String> {
    let c = read_config(&state)?;
    let result = request(
        &c,
        reqwest::Method::DELETE,
        &format!("/api/devices/{}", safe_id(&device_id)?),
        None,
        true,
    )
    .await?;
    if device_id == c.device_id {
        disconnect(&state)?;
    }
    Ok(result)
}
#[tauri::command]
pub async fn sync_recurring_action(
    state: State<'_, AppState>,
    operation: String,
    payload: Value,
) -> Result<Value, String> {
    {
        let conn = state.db.lock().map_err(|_| "数据库繁忙")?;
        let enabled: bool = conn
            .query_row("SELECT enabled FROM sync_runtime WHERE id=1", [], |r| {
                r.get(0)
            })
            .map_err(sql_error)?;
        if !enabled {
            return Err("请先开启同步并联网同步计划".into());
        }
    }
    sync_now(state.clone()).await?;
    let body = match operation.as_str() {
        "generate" | "skip" => {
            json!({"action":operation,"id":payload.get("id").cloned().ok_or("周期节点参数无效")?})
        }
        "catchup" | "resolve_catch_up" => {
            json!({"action":"catchup","decisions":payload.get("decisions").cloned().ok_or("补齐参数无效")?})
        }
        _ => return Err("不支持的云周期操作".into()),
    };
    let value = request(
        &read_config(&state)?,
        reqwest::Method::POST,
        "/api/recurring/action",
        Some(body),
        true,
    )
    .await?;
    sync_now(state).await?;
    Ok(value)
}
fn disconnect(state: &AppState) -> Result<(), String> {
    let c = read_config(state)?;
    forget_secret(&c.device_id);
    if !c.pair_id.is_empty() {
        forget_secret(&format!("pair:{}", c.pair_id));
    }
    {
        let conn = state.db.lock().map_err(|_| "数据库繁忙")?;
        conn.execute_batch("UPDATE sync_runtime SET enabled=0,cursor=0,baseline_done=0,baseline_pending=0; DELETE FROM sync_outbox; DELETE FROM sync_shadow;").map_err(sql_error)?;
    }
    write_config(state, &Config::default())
}
#[tauri::command]
pub async fn sync_disconnect(state: State<'_, AppState>) -> Result<Status, String> {
    let c = read_config(&state)?;
    // Local disconnection is always possible offline; device revocation can be completed by another device.
    let token = secret(&c.device_id).ok();
    disconnect(&state)?;
    if let Some(token) = token {
        if let Ok(client) = client() {
            let _ = client
                .post(format!("{}/api/logout", c.server_url))
                .bearer_auth(token)
                .send()
                .await;
        }
    }
    status(&state)
}
pub fn after_restore(state: &AppState) -> Result<(), String> {
    disconnect(state)
}
#[tauri::command]
pub async fn sync_upload_file(
    state: State<'_, AppState>,
    file_id: String,
    confirmed: bool,
) -> Result<Value, String> {
    if !confirmed {
        return Err("上传文件内容需要本次明确确认".into());
    }
    safe_id(&file_id)?;
    { let conn = state.db.lock().map_err(|_| "数据库繁忙")?;
      let path: Option<String> = conn.query_row("SELECT path FROM file_assets WHERE id=?1", [&file_id], |r| r.get(0)).optional().map_err(sql_error)?;
      if path.is_some_and(|p| p.starts_with("gdrive:")) { return Err("Drive 引用不支持云端附件内容操作".into()); }
    }
    sync_now(state.clone()).await?;
    let c = read_config(&state)?;
    let path = {
        let conn = state.db.lock().map_err(|_| "数据库繁忙")?;
        let enabled: bool = conn
            .query_row("SELECT enabled FROM sync_runtime WHERE id=1", [], |r| {
                r.get(0)
            })
            .map_err(sql_error)?;
        if !enabled {
            return Err("请先开启同步".into());
        }
        conn.query_row(
            "SELECT path FROM file_assets WHERE id=?1",
            [&file_id],
            |r| r.get::<_, String>(0),
        )
        .map_err(sql_error)?
    };
    if path.starts_with("gdrive:") { return Err("Drive 引用不支持上传或下载文件内容".into()); }
    if path.starts_with("cloud://") {
        return Err("请先选择本机文件位置".into());
    }
    let file = std::fs::File::open(path).map_err(|_| "无法读取本机文件")?;
    if file.metadata().map_err(|_| "无法读取文件信息")?.len() > MAX_FILE as u64 {
        return Err("文件不能超过20 MB".into());
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take((MAX_FILE + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取文件失败")?;
    if bytes.len() > MAX_FILE {
        return Err("文件不能超过20 MB".into());
    }
    ensure_active(&state, &c)?;
    let token = secret(&c.device_id)?;
    let r = client()?
        .put(format!(
            "{}/api/files/{file_id}/content",
            validate_url(&c.server_url)?
        ))
        .bearer_auth(token)
        .header("X-Upload-Confirmed", "true")
        .header("Content-Type", "application/octet-stream")
        .body(bytes)
        .send()
        .await
        .map_err(|_| "上传失败，请检查网络")?;
    let result = json_response(r).await?;
    sync_now(state).await?;
    Ok(result)
}
#[tauri::command]
pub async fn sync_download_file(
    state: State<'_, AppState>,
    file_id: String,
    path: String,
    confirmed: bool,
) -> Result<(), String> {
    if !confirmed {
        return Err("下载到本机需要本次明确确认".into());
    }
    safe_id(&file_id)?;
    { let conn = state.db.lock().map_err(|_| "数据库繁忙")?;
      let path: Option<String> = conn.query_row("SELECT path FROM file_assets WHERE id=?1", [&file_id], |r| r.get(0)).optional().map_err(sql_error)?;
      if path.is_some_and(|p| p.starts_with("gdrive:")) { return Err("Drive 引用不支持云端附件内容操作".into()); }
    }
    let target = PathBuf::from(&path);
    if !target.is_absolute() || target.exists() {
        return Err("请选择尚未存在的绝对文件路径，不会覆盖文件".into());
    }
    let parent = target.parent().ok_or("下载目录无效")?;
    if !parent.is_dir() {
        return Err("下载目录不存在".into());
    }
    let c = read_config(&state)?;
    let token = secret(&c.device_id)?;
    let mut r = client()?
        .get(format!(
            "{}/api/files/{file_id}/content",
            validate_url(&c.server_url)?
        ))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "下载失败，请检查网络")?;
    if !r.status().is_success() {
        return Err("云端文件不可用或设备未授权".into());
    }
    if r.content_length().is_some_and(|n| n > MAX_FILE as u64) {
        return Err("云端文件超过20 MB".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = r.chunk().await.map_err(|_| "下载中断")? {
        if bytes.len() + chunk.len() > MAX_FILE {
            return Err("云端文件超过20 MB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|_| "无法创建文件，路径可能已被占用")?;
    if file
        .write_all(&bytes)
        .and_then(|_| file.sync_all())
        .is_err()
    {
        drop(file);
        let _ = std::fs::remove_file(&target);
        return Err("写入下载文件失败".into());
    }
    drop(file);
    let result = {
        let mut conn = state.db.lock().map_err(|_| "数据库繁忙")?;
        let tx = conn.transaction().map_err(sql_error)?;
        let p = std::fs::canonicalize(&target).map_err(|_| "下载文件路径无效")?;
        let old: String = tx
            .query_row(
                "SELECT path FROM file_assets WHERE id=?1",
                [&file_id],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        tx.execute(
            "UPDATE file_assets SET path=?2 WHERE id=?1",
            params![file_id, crate::files::normal_path(&p)],
        )
        .map_err(sql_error)?;
        crate::files::record_file_history(
            &tx,
            &file_id,
            "",
            "",
            "relocated",
            &crate::files::normal_path(&p),
            &format!("下载云端文件；原位置：{old}"),
        )?;
        tx.commit().map_err(sql_error)
    };
    result
}
#[tauri::command]
pub async fn sync_remove_cloud_file(
    state: State<'_, AppState>,
    file_id: String,
) -> Result<Value, String> {
    { let conn = state.db.lock().map_err(|_| "数据库繁忙")?;
      let path: Option<String> = conn.query_row("SELECT path FROM file_assets WHERE id=?1", [&file_id], |r| r.get(0)).optional().map_err(sql_error)?;
      if path.is_some_and(|p| p.starts_with("gdrive:")) { return Err("Drive 引用不支持云端附件内容操作".into()); }
    }
    let c = read_config(&state)?;
    ensure_active(&state, &c)?;
    let result = request(
        &c,
        reqwest::Method::DELETE,
        &format!("/api/files/{}/content", safe_id(&file_id)?),
        None,
        true,
    )
    .await?;
    sync_now(state).await?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;
          CREATE TABLE semesters(id TEXT PRIMARY KEY,name TEXT NOT NULL,source_root TEXT NOT NULL DEFAULT '');
          CREATE TABLE courses(id TEXT PRIMARY KEY,semester_id TEXT NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,name TEXT NOT NULL,code TEXT NOT NULL DEFAULT '',folder_path TEXT NOT NULL DEFAULT '');
          CREATE TABLE assignments(id TEXT PRIMARY KEY,course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',due_at TEXT,status TEXT NOT NULL DEFAULT 'todo',submission_label TEXT NOT NULL DEFAULT '',submission_url TEXT NOT NULL DEFAULT '',submission_notes TEXT NOT NULL DEFAULT '',source_name TEXT NOT NULL DEFAULT '',source_text TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
          CREATE TABLE assignment_custom_fields(assignment_id TEXT REFERENCES assignments(id) ON DELETE CASCADE,field_key TEXT,field_value TEXT,PRIMARY KEY(assignment_id,field_key));
          CREATE TABLE file_assets(id TEXT PRIMARY KEY,path TEXT UNIQUE);
          CREATE TABLE assignment_files(id TEXT PRIMARY KEY,assignment_id TEXT REFERENCES assignments(id) ON DELETE CASCADE,file_id TEXT REFERENCES file_assets(id),role TEXT,page TEXT DEFAULT '',chapter TEXT DEFAULT '',problem TEXT DEFAULT '',note TEXT DEFAULT '');
          CREATE TABLE file_history(id TEXT PRIMARY KEY,file_id TEXT,link_id TEXT,assignment_id TEXT,assignment_title TEXT,event_type TEXT,path TEXT,details TEXT,file_size INTEGER,modified_at_ms INTEGER,occurred_at TEXT);
          CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
          INSERT INTO semesters VALUES('s','Semester','/private/root');
          INSERT INTO courses VALUES('c','s','Course','','/private/course');
          INSERT INTO assignments(id,course_id,title,created_at,updated_at) VALUES('a','c','Original','now','now');
          PRAGMA user_version=6;").unwrap();
        migrate(&conn).unwrap();
        conn
    }
    fn enable(conn: &Connection) {
        conn.execute("UPDATE sync_runtime SET enabled=1 WHERE id=1", [])
            .unwrap();
    }
    fn response(changes: Vec<Entity>, acknowledged: Vec<String>) -> Response {
        Response {
            cursor: 10,
            changes,
            acknowledged,
            has_more: false,
            server_time: "2026-10-28T00:00:00Z".into(),
        }
    }
    #[test]
    fn disabled_capture_and_path_fields_never_leave_device() {
        let conn = database();
        conn.execute("UPDATE assignments SET title='Offline' WHERE id='a'", [])
            .unwrap();
        assert!(pending(&conn, 100).unwrap().is_empty());
        enable(&conn);
        conn.execute(
            "UPDATE courses SET folder_path='/another/private/path' WHERE id='c'",
            [],
        )
        .unwrap();
        assert!(pending(&conn, 100).unwrap().is_empty());
        conn.execute("UPDATE courses SET name='Changed' WHERE id='c'", [])
            .unwrap();
        let ops = pending(&conn, 100).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].changes[0].data, Some(json!({"name":"Changed"})));
        conn.execute(
            "INSERT INTO file_assets(id,path) VALUES('f','/private/very-secret/course/notes.pdf')",
            [],
        )
        .unwrap();
        let ops = pending(&conn, 100).unwrap();
        let wire = serde_json::to_string(&ops).unwrap();
        assert!(!wire.contains("very-secret"));
        assert!(wire.contains("notes.pdf"));
    }
    #[test]
    fn custom_fields_captured_and_transaction_rollback_cancels_outbox() {
        let mut conn = database();
        enable(&conn);
        {
            let tx = conn.transaction().unwrap();
            tx.execute(
                "UPDATE assignments SET title='Rolled back' WHERE id='a'",
                [],
            )
            .unwrap();
        }
        assert!(pending(&conn, 100).unwrap().is_empty());
        conn.execute(
            "INSERT INTO assignment_custom_fields VALUES('a','chapter','3')",
            [],
        )
        .unwrap();
        let ops = pending(&conn, 100).unwrap();
        assert_eq!(
            ops[0].changes[0].data,
            Some(json!({"custom_fields":{"chapter":"3"}}))
        );
    }
    #[test]
    fn replay_has_no_echo_preserves_local_paths_and_pending_fields() {
        let mut conn = database();
        enable(&conn);
        seed_baseline(&conn).unwrap();
        conn.execute("DELETE FROM sync_outbox", []).unwrap();
        conn.execute(
            "UPDATE assignments SET title='Local pending' WHERE id='a'",
            [],
        )
        .unwrap();
        let before = pending(&conn, 100).unwrap();
        let changes = vec![
            Entity {
                entity_type: "course".into(),
                entity_id: "c".into(),
                data: Some(json!({"semester_id":"s","name":"Remote course","code":"X"})),
                seq: 1,
            },
            Entity {
                entity_type: "assignment".into(),
                entity_id: "a".into(),
                data: Some(json!({"course_id":"c","title":"Remote title","status":"done"})),
                seq: 2,
            },
            Entity {
                entity_type: "file".into(),
                entity_id: "cloud-file".into(),
                data: Some(json!({"name":"remote.pdf","cloud_version":"v1"})),
                seq: 3,
            },
        ];
        replay(&mut conn, &response(changes, vec![])).unwrap();
        assert_eq!(pending(&conn, 100).unwrap().len(), before.len());
        let (title, status): (String, String) = conn
            .query_row(
                "SELECT title,status FROM assignments WHERE id='a'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "Local pending");
        assert_eq!(status, "done");
        assert_eq!(
            conn.query_row("SELECT folder_path FROM courses WHERE id='c'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "/private/course"
        );
        assert_eq!(
            conn.query_row(
                "SELECT path FROM file_assets WHERE id='cloud-file'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "cloud://cloud-file"
        );
    }
    #[test]
    fn acknowledgement_cursor_and_failed_replay_are_atomic() {
        let mut conn = database();
        enable(&conn);
        conn.execute("UPDATE assignments SET title='Pending' WHERE id='a'", [])
            .unwrap();
        let op = pending(&conn, 1).unwrap().remove(0);
        let bad = Entity {
            entity_type: "course".into(),
            entity_id: "bad".into(),
            data: Some(json!({"semester_id":"missing","name":"Bad"})),
            seq: 2,
        };
        assert!(replay(
            &mut conn,
            &response(vec![bad], vec![op.operation_id.clone()])
        )
        .is_err());
        assert_eq!(pending(&conn, 100).unwrap().len(), 1);
        assert_eq!(
            conn.query_row("SELECT cursor FROM sync_runtime", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(!conn
            .query_row("SELECT replaying FROM sync_runtime", [], |r| r
                .get::<_, bool>(0))
            .unwrap());
        replay(&mut conn, &response(vec![], vec![op.operation_id])).unwrap();
        assert!(pending(&conn, 100).unwrap().is_empty());
    }
    #[test]
    fn tombstone_drops_stale_edit_and_cascades_are_captured() {
        let mut conn = database();
        enable(&conn);
        conn.execute("UPDATE assignments SET title='Stale' WHERE id='a'", [])
            .unwrap();
        replay(
            &mut conn,
            &response(
                vec![Entity {
                    entity_type: "assignment".into(),
                    entity_id: "a".into(),
                    data: None,
                    seq: 1,
                }],
                vec![],
            ),
        )
        .unwrap();
        assert!(pending(&conn, 100).unwrap().is_empty());
        conn.execute("DELETE FROM semesters WHERE id='s'", [])
            .unwrap();
        let ops = pending(&conn, 100).unwrap();
        assert!(ops
            .iter()
            .any(|o| o.changes[0].entity_type == "course" && o.changes[0].data.is_none()));
        assert!(ops
            .iter()
            .any(|o| o.changes[0].entity_type == "semester" && o.changes[0].data.is_none()));
    }
    #[test]
    fn paused_drive_registration_and_links_are_captured_on_resume() {
        let mut conn = database();
        configure_enabled(&mut conn,true).unwrap();
        conn.execute("DELETE FROM sync_outbox",[]).unwrap();
        configure_enabled(&mut conn,false).unwrap();
        let files = vec![crate::drive::DriveFileInfo { id:"paused_drive_123".into(),name:"Notes / week 1".into(),mime_type:"application/pdf".into(),resource_key:Some("resource_key".into()),unavailable:false }];
        let ids = crate::drive::register(&mut conn,files).unwrap();
        conn.execute("INSERT INTO assignment_files(id,assignment_id,file_id,role) VALUES('drive-link','a',?1,'reference')",[&ids[0]]).unwrap();
        assert!(pending(&conn,100).unwrap().is_empty());
        configure_enabled(&mut conn,true).unwrap();
        let operations = pending(&conn,100).unwrap();
        let changes = operations.iter().flat_map(|op| &op.changes).collect::<Vec<_>>();
        let file = changes.iter().find(|c| c.entity_type == "file" && c.entity_id == ids[0]).unwrap().data.as_ref().unwrap();
        assert_eq!(file["name"],json!("Notes / week 1"));
        assert_eq!(file["drive_id"],json!("paused_drive_123"));
        assert_eq!(file["drive_resource_key"],json!("resource_key"));
        assert_eq!(file["drive_unavailable"],json!(0));
        assert!(changes.iter().any(|c| c.entity_type == "link" && c.entity_id == "drive-link"));
    }

    #[test]
    fn drive_metadata_migrates_and_roundtrips_without_local_paths() {
        let conn = database();
        conn.execute_batch("DROP TABLE sync_files; CREATE TABLE sync_files(id TEXT PRIMARY KEY REFERENCES file_assets(id),name TEXT NOT NULL,mime TEXT DEFAULT 'application/octet-stream',size INTEGER,cloud_version TEXT); PRAGMA user_version=7;").unwrap();
        migrate(&conn).unwrap();
        let id = "gdrive-abcdefghij_123";
        let data = json!({"name":"Course notes", "mime":"application/pdf", "drive_id":"abcdefghij_123", "drive_resource_key":"resource_key", "drive_unavailable":0});
        apply_entity(&conn,"file",id,Some(&data)).unwrap();
        assert_eq!(conn.query_row("SELECT path FROM file_assets WHERE id=?1", [id], |r| r.get::<_,String>(0)).unwrap(), "gdrive:abcdefghij_123");
        assert!(conn.execute("UPDATE file_assets SET path='/local/file' WHERE id=?1",[id]).is_err());
        assert!(conn.execute("UPDATE sync_files SET drive_id=NULL WHERE id=?1",[id]).is_err());
        conn.execute("UPDATE sync_runtime SET enabled=1",[]).unwrap();
        conn.execute("UPDATE sync_files SET name='Renamed',drive_unavailable=1 WHERE id=?1",[id]).unwrap();
        let operations = pending(&conn,100).unwrap();
        assert!(operations.iter().flat_map(|op| &op.changes).any(|op| op.entity_type == "file" && op.data.as_ref().is_some_and(|d| d.get("name") == Some(&json!("Renamed")))));
        seed_baseline(&conn).unwrap();
        assert!(pending(&conn,100).unwrap().iter().flat_map(|op| &op.changes).any(|op| op.entity_type == "file" && op.data.as_ref().is_some_and(|d| d.get("drive_id") == Some(&json!("abcdefghij_123")))));
    }

    #[test]
    fn migration_is_repeatable_and_future_versions_fail_closed() {
        let conn = database();
        migrate(&conn).unwrap();
        assert_eq!(
            conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            8
        );
        conn.execute_batch("PRAGMA user_version=99").unwrap();
        assert!(migrate(&conn).is_err());
    }
    #[test]
    fn reject_credential_urls_redirect_surfaces_and_non_https() {
        for url in [
            "http://example.test",
            "https://user:pass@example.test",
            "https://example.test/path",
            "https://example.test?secret=x",
        ] {
            assert!(validate_url(url).is_err());
        }
        assert_eq!(
            validate_url("http://127.0.0.1:8787").unwrap(),
            "http://127.0.0.1:8787"
        );
    }
    #[test]
    fn file_version_is_readable_but_never_in_outbound_baseline_or_triggers() {
        let conn = database();
        conn.execute(
            "INSERT INTO file_assets VALUES('f','/private/notes.pdf')",
            [],
        )
        .unwrap();
        seed_baseline(&conn).unwrap();
        assert!(pending(&conn, 100).unwrap().iter().all(|op| op
            .changes
            .iter()
            .all(|c| c.entity_type != "file"
                || c.data.as_ref().unwrap().get("cloud_version").is_none())));
        conn.execute("DELETE FROM sync_outbox", []).unwrap();
        enable(&conn);
        conn.execute(
            "UPDATE sync_files SET cloud_version='content/f/version' WHERE id='f'",
            [],
        )
        .unwrap();
        assert!(pending(&conn, 100).unwrap().is_empty());
        conn.execute(
            "INSERT INTO file_assets VALUES('g','C:/private/report.pdf')",
            [],
        )
        .unwrap();
        let ops = pending(&conn, 100).unwrap();
        assert!(ops.iter().all(|o| o.changes[0]
            .data
            .as_ref()
            .unwrap()
            .get("cloud_version")
            .is_none()));
    }
    #[test]
    fn pause_reenable_queues_only_offline_changes_and_remains_cloud_managed() {
        let mut conn = database();
        configure_enabled(&mut conn, true).unwrap();
        assert_eq!(
            conn.query_row("SELECT baseline_pending FROM sync_runtime", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let baseline = pending(&conn, 100).unwrap();
        let changes = baseline
            .iter()
            .enumerate()
            .flat_map(|(i, o)| {
                o.changes.iter().map(move |c| Entity {
                    entity_type: c.entity_type.clone(),
                    entity_id: c.entity_id.clone(),
                    data: c.data.clone(),
                    seq: i as i64 + 1,
                })
            })
            .collect();
        replay(
            &mut conn,
            &response(
                changes,
                baseline.iter().map(|o| o.operation_id.clone()).collect(),
            ),
        )
        .unwrap();
        conn.execute("UPDATE sync_runtime SET baseline_pending=0", [])
            .unwrap();
        configure_enabled(&mut conn, false).unwrap();
        conn.execute(
            "UPDATE assignments SET title='Edited while paused' WHERE id='a'",
            [],
        )
        .unwrap();
        assert!(pending(&conn, 100).unwrap().is_empty());
        assert!(cloud_managed(&conn).unwrap());
        configure_enabled(&mut conn, true).unwrap();
        let ops = pending(&conn, 100).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(
            ops[0].changes[0].data,
            Some(json!({"title":"Edited while paused"}))
        );
        assert_eq!(
            conn.query_row("SELECT baseline_pending FROM sync_runtime", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn source_mappings_round_trip_and_delete_without_echo_or_duplicate_imports() {
        let mut source = database();
        crate::import_sync::initialize(&source).unwrap();
        migrate(&source).unwrap();
        source.execute_batch("INSERT INTO assignment_import_course_map VALUES('test.sync','account','remote-course','c'); INSERT INTO assignment_import_links VALUES('test.sync','account','remote-course','remote-a','a','{}'); INSERT INTO assignment_import_ignored VALUES('test.sync','account','remote-course','ignored-a','{}');").unwrap();
        configure_enabled(&mut source, true).unwrap();
        let baseline = pending(&source, 100).unwrap();
        let changes: Vec<Entity> = baseline
            .iter()
            .enumerate()
            .flat_map(|(i, o)| {
                o.changes.iter().map(move |c| Entity {
                    entity_type: c.entity_type.clone(),
                    entity_id: c.entity_id.clone(),
                    data: c.data.clone(),
                    seq: i as i64 + 1,
                })
            })
            .collect();
        let parent_position = baseline
            .iter()
            .position(|o| o.changes[0].entity_type == "assignment")
            .unwrap();
        for kind in ["import_course_map", "import_link", "import_ignored"] {
            let pos = baseline
                .iter()
                .position(|o| o.changes[0].entity_type == kind)
                .unwrap();
            assert!(pos > parent_position);
            assert!(uuid::Uuid::parse_str(&baseline[pos].changes[0].entity_id).is_ok());
        }
        let mut target = database();
        crate::import_sync::initialize(&target).unwrap();
        migrate(&target).unwrap();
        enable(&target);
        replay(&mut target, &response(changes.clone(), vec![])).unwrap();
        assert!(pending(&target, 100).unwrap().is_empty());
        assert_eq!(
            target
                .query_row(
                    "SELECT assignment_id FROM assignment_import_links",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "a"
        );
        source
            .execute("UPDATE assignment_import_links SET baseline='changed'", [])
            .unwrap();
        let update = pending(&source, 100)
            .unwrap()
            .pop()
            .unwrap()
            .changes
            .remove(0);
        replay(
            &mut target,
            &response(
                vec![Entity {
                    entity_type: update.entity_type,
                    entity_id: update.entity_id,
                    data: update.data,
                    seq: 100,
                }],
                vec![],
            ),
        )
        .unwrap();
        assert_eq!(
            target
                .query_row("SELECT baseline FROM assignment_import_links", [], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
            "changed"
        );
        let tombstones: Vec<Entity> = changes
            .into_iter()
            .filter(|e| e.entity_type.starts_with("import_"))
            .map(|mut e| {
                e.data = None;
                e.seq = 200;
                e
            })
            .collect();
        replay(&mut target, &response(tombstones, vec![])).unwrap();
        for table in [
            "assignment_import_course_map",
            "assignment_import_links",
            "assignment_import_ignored",
        ] {
            assert_eq!(
                target
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        assert!(pending(&target, 100).unwrap().is_empty());
    }

    fn recurring_database() -> Connection {
        let conn = database();
        conn.execute_batch("CREATE TABLE module_states(module_id TEXT PRIMARY KEY,enabled INTEGER,updated_at TEXT); CREATE TABLE module_file_links(id TEXT PRIMARY KEY,module_id TEXT,owner_type TEXT,owner_id TEXT,owner_label TEXT,file_id TEXT REFERENCES file_assets(id),role TEXT,note TEXT,created_at TEXT,UNIQUE(module_id,owner_type,owner_id,file_id,role));").unwrap();
        let dir = std::env::temp_dir().join(format!("sync-recurring-{}", uuid::Uuid::new_v4()));
        crate::modules::initialize(&conn, &dir).unwrap();
        let rule = json!({"version":1,"kind":"custom_dates","dates":["2026-10-01T09:00:00"]});
        conn.execute("INSERT INTO recurring_series(id,course_id,name,title_template,rule_json,due_rule_json,status,created_at,updated_at) VALUES('series','c','Monthly','Homework {num}',?1,?2,'active','now','now')",params![rule.to_string(),json!({"version":1,"kind":"none"}).to_string()]).unwrap();
        conn.execute_batch("INSERT INTO recurring_occurrences(id,series_id,sequence_no,scheduled_at,state,assignment_id,overridden,created_at,updated_at) VALUES('occ','series',1,'2026-10-01T09:00:00','generated','a',0,'now','now');").unwrap();
        migrate(&conn).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
        conn
    }

    #[test]
    fn recurring_delete_hook_queues_one_atomic_intent_after_trigger_upgrade() {
        let conn = recurring_database();
        // Simulate the previous schema to prove startup removes its single-field triggers.
        conn.execute_batch("CREATE TRIGGER sync_recurring_occurrence_update_state AFTER UPDATE OF state ON recurring_occurrences BEGIN INSERT INTO sync_outbox(entity_type,entity_id,data) VALUES('recurring_occurrence',NEW.id,json_object('state',NEW.state)); END;").unwrap();
        migrate(&conn).unwrap();
        enable(&conn);
        crate::modules::assignment_deleted(&conn, "a").unwrap();
        conn.execute("DELETE FROM assignments WHERE id='a'", [])
            .unwrap();
        let ops = pending(&conn, 100).unwrap();
        let intents = ops
            .iter()
            .flat_map(|o| &o.changes)
            .filter(|c| c.entity_type == "recurring_occurrence")
            .collect::<Vec<_>>();
        assert_eq!(intents.len(), 1);
        assert_eq!(
            intents[0].data,
            Some(json!({"state":"skipped","assignment_id":null,"overridden":0}))
        );
        assert!(ops
            .iter()
            .any(|o| o.changes[0].entity_type == "assignment" && o.changes[0].data.is_none()));
    }

    #[test]
    fn disabled_and_paused_deletions_survive_enabling_sync() {
        for previously_synced in [false, true] {
            let mut conn = recurring_database();
            if previously_synced {
                configure_enabled(&mut conn, true).unwrap();
                let baseline = pending(&conn, 100).unwrap();
                let changes = baseline
                    .iter()
                    .enumerate()
                    .flat_map(|(i, o)| {
                        o.changes.iter().map(move |c| Entity {
                            entity_type: c.entity_type.clone(),
                            entity_id: c.entity_id.clone(),
                            data: c.data.clone(),
                            seq: i as i64 + 1,
                        })
                    })
                    .collect();
                replay(
                    &mut conn,
                    &response(
                        changes,
                        baseline.iter().map(|o| o.operation_id.clone()).collect(),
                    ),
                )
                .unwrap();
                configure_enabled(&mut conn, false).unwrap();
            }
            crate::modules::assignment_deleted(&conn, "a").unwrap();
            conn.execute("DELETE FROM assignments WHERE id='a'", [])
                .unwrap();
            assert!(pending(&conn, 100).unwrap().is_empty());
            configure_enabled(&mut conn, true).unwrap();
            let ops = pending(&conn, 100).unwrap();
            let intent = ops
                .iter()
                .flat_map(|o| &o.changes)
                .find(|c| c.entity_type == "recurring_occurrence")
                .unwrap()
                .data
                .as_ref()
                .unwrap();
            assert_eq!(intent["state"], "skipped");
            assert_eq!(intent["assignment_id"], Value::Null);
            assert_eq!(intent["overridden"], 0);
            if previously_synced {
                assert!(ops.iter().any(
                    |o| o.changes[0].entity_type == "assignment" && o.changes[0].data.is_none()
                ));
            } else {
                assert!(ops.iter().all(|o| o.changes[0].entity_type != "assignment"));
            }
        }
    }

    #[test]
    fn exported_legacy_baseline_has_all_entities_in_parent_order() {
        let mut conn = database();
        conn.execute_batch("CREATE TABLE module_file_links(id TEXT PRIMARY KEY,module_id TEXT,owner_type TEXT,owner_id TEXT,owner_label TEXT,file_id TEXT REFERENCES file_assets(id),role TEXT,note TEXT,created_at TEXT,UNIQUE(module_id,owner_type,owner_id,file_id,role)); CREATE TABLE common_files(course_id TEXT REFERENCES courses(id),file_id TEXT REFERENCES file_assets(id),kind TEXT,label TEXT,PRIMARY KEY(course_id,file_id)); CREATE TABLE module_states(module_id TEXT PRIMARY KEY,enabled INTEGER,updated_at TEXT);").unwrap();
        let dir = std::env::temp_dir().join(format!("sync-fixture-{}", uuid::Uuid::new_v4()));
        crate::modules::initialize(&conn, &dir).unwrap();
        conn.execute_batch("INSERT INTO file_assets VALUES('f','/private/legacy/notes.pdf'); INSERT INTO assignment_files VALUES('l','a','f','reference','4','2','3','note'); INSERT INTO common_files VALUES('c','f','textbook','Book'); INSERT INTO module_states VALUES('builtin.assignment.recurring',0,'now'); INSERT INTO assignment_import_providers VALUES('p','Example','custom','https://api.example.test/v1','example-model'); INSERT INTO assignment_import_settings VALUES('assignment_provider_id','p'); INSERT INTO recurring_semester_calendars VALUES('s','2026-09-07','now'); INSERT INTO settings VALUES('theme','light'); INSERT INTO file_history VALUES('h','f','l','a','Original','linked','/private/legacy/notes.pdf','raw path /private/legacy',NULL,NULL,'now');").unwrap();
        crate::import_sync::initialize(&conn).unwrap();
        conn.execute_batch("INSERT INTO assignment_import_course_map VALUES('example.import','synthetic-account','remote-course','c'); INSERT INTO assignment_import_links VALUES('example.import','synthetic-account','remote-course','remote-assignment','a','{}'); INSERT INTO assignment_import_ignored VALUES('example.import','synthetic-account','remote-course','ignored-assignment','{}');").unwrap();
        let source_baseline = |id: &str| json!({"id":id,"course_id":"remote-course","title":"Legacy source item","description":"","due_at":null,"status":"unknown","url":""}).to_string();
        conn.execute("UPDATE assignment_import_links SET baseline=?1", [source_baseline("remote-assignment")]).unwrap();
        conn.execute("UPDATE assignment_import_ignored SET baseline=?1", [source_baseline("ignored-assignment")]).unwrap();
        let rule = json!({"version":1,"kind":"custom_dates","dates":["2026-10-01T09:00:00","2026-11-01T09:00:00"],"timezone":"Asia/Shanghai"});
        conn.execute("INSERT INTO recurring_series(id,course_id,name,title_template,rule_json,due_rule_json,max_occurrences,status,created_at,updated_at) VALUES('series','c','Monthly','Homework {num}',?1,?2,2,'active','now','now')",params![rule.to_string(),json!({"version":1,"kind":"none"}).to_string()]).unwrap();
        conn.execute_batch("INSERT INTO recurring_occurrences(id,series_id,sequence_no,scheduled_at,due_at,state,assignment_id,overridden,created_at,updated_at) VALUES('legacy-node','series',1,'2026-10-01T09:00:00',NULL,'generated','a',1,'now','now'); INSERT INTO module_file_links VALUES('ml','builtin.assignment.recurring','recurring_series','series','Monthly','f','reference','note','now');").unwrap();
        migrate(&conn).unwrap();
        configure_enabled(&mut conn, true).unwrap();
        let operations = pending(&conn, 100).unwrap();
        let position = |kind: &str| {
            operations
                .iter()
                .position(|o| o.changes[0].entity_type == kind)
                .unwrap()
        };
        assert!(position("semester") < position("course"));
        assert!(position("file") < position("link"));
        assert!(position("recurring_series") < position("module_file_link"));
        assert!(position("assignment") < position("recurring_occurrence"));
        assert!(position("course") < position("import_course_map"));
        assert!(position("assignment") < position("import_link"));
        assert!(position("course") < position("import_ignored"));

        let wire =
            serde_json::to_string_pretty(&json!({"cursor":0,"operations":operations,"limit":500}))
                .unwrap();
        assert!(!wire.contains("/private/"));
        assert!(!wire.contains("cloud_version"));
        assert!(!wire.contains("api_key"));
        assert!(wire.contains("legacy-node"));
        let module = operations
            .iter()
            .find(|o| o.changes[0].entity_type == "module_state")
            .unwrap();
        assert_eq!(
            module.changes[0].data.as_ref().unwrap().get("enabled"),
            Some(&json!(false))
        );
        if let Ok(path) = std::env::var("HOMEWORK_SYNC_FIXTURE") {
            std::fs::write(path, wire).unwrap();
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}

/// Manual Drive actions remain available while record synchronization is paused.
pub(super) async fn drive_request(state: &AppState, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value,String> {
    let c = read_config(state)?;
    if c.device_id.is_empty() || c.server_url.is_empty() { return Err("请先配对此私有服务，再连接 Google Drive".into()); }
    request(&c, method, path, body, true).await
}
