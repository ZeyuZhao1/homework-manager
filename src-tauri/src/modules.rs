//! Capability based local modules. Built-ins and user-installed process entries share one JSON contract.
use crate::db::AppState;
#[path = "../../modules/registry.rs"]
mod builtin_registry;
pub use builtin_registry::assignment_import;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::{Component, Path, PathBuf}, process::Stdio, time::Duration};
use tauri::State;
use tokio::{io::AsyncWriteExt, process::Command, time::timeout};

pub type InitializeModule = fn(&Connection, &Path) -> Result<(), String>;
pub type BeforeSnapshot = fn(&mut Connection) -> Result<(), String>;
pub type AssignmentHook = fn(&Connection, &str) -> Result<(), String>;
pub type ManageModule = fn(&mut Connection, &str, Value) -> Result<Value, String>;

#[derive(Clone, Copy)]
pub struct BuiltinModuleRegistration {
    pub descriptor: fn() -> ModuleDescriptor,
    pub initialize: InitializeModule,
    pub before_snapshot: Option<BeforeSnapshot>,
    pub assignment_saved: Option<AssignmentHook>,
    pub assignment_deleted: Option<AssignmentHook>,
    pub manage: Option<ManageModule>,
}

fn builtin_modules() -> [BuiltinModuleRegistration; 2] {
    builtin_registry::registrations()
}

pub fn initialize(conn: &Connection, data_dir: &Path) -> Result<(), String> {
    for module in builtin_modules() { (module.initialize)(conn, data_dir)?; }
    Ok(())
}

pub fn before_snapshot(conn: &mut Connection) -> Result<(), String> {
    for module in builtin_modules() {
        let descriptor = (module.descriptor)();
        if enabled(conn, &descriptor.id)? {
            if let Some(hook) = module.before_snapshot { hook(conn)?; }
        }
    }
    Ok(())
}

pub fn assignment_saved(conn: &Connection, assignment_id: &str) -> Result<(), String> {
    for module in builtin_modules() {
        let descriptor = (module.descriptor)();
        if enabled(conn, &descriptor.id)? {
            if let Some(hook) = module.assignment_saved { hook(conn, assignment_id)?; }
        }
    }
    Ok(())
}

pub fn assignment_deleted(conn: &Connection, assignment_id: &str) -> Result<(), String> {
    for module in builtin_modules() {
        let descriptor = (module.descriptor)();
        if enabled(conn, &descriptor.id)? {
            if let Some(hook) = module.assignment_deleted { hook(conn, assignment_id)?; }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleDescriptor {
    pub id: String,
    pub name: String,
    pub version: String,
    pub capabilities: Vec<String>,
    pub builtin: bool,
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    id: String,
    name: String,
    version: String,
    capabilities: Vec<String>,
    #[serde(default)]
    executable: Option<String>,
    #[serde(default)]
    runtime: Option<String>,
    #[serde(default)]
    entrypoint: Option<String>,
}

#[derive(Debug, Clone)]
enum ModuleLaunch {
    Executable(PathBuf),
    PowerShell(PathBuf),
}

fn valid_token(value: &str) -> bool {
    !value.is_empty() && value.len() <= 100 && value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

fn resolve_module_file(dir: &Path, relative: &str) -> Option<PathBuf> {
    let relative = Path::new(relative);
    if relative.is_absolute() || relative.components().any(|c| !matches!(c, Component::Normal(_))) { return None }
    let root_canonical = dir.canonicalize().ok()?;
    let file = dir.join(relative).canonicalize().ok()?;
    if !file.starts_with(&root_canonical) || !file.is_file() { return None }
    Some(file)
}

fn module_entries(root: &Path) -> Vec<(ModuleDescriptor, ModuleLaunch)> {
    let mut modules = Vec::new();
    let Ok(directories) = fs::read_dir(root) else { return modules };
    for entry in directories.flatten() {
        let dir = entry.path();
        if !dir.is_dir() { continue }
        let Ok(raw) = fs::read_to_string(dir.join("module.json")) else { continue };
        let Ok(manifest) = serde_json::from_str::<Manifest>(&raw) else { continue };
        if !valid_token(&manifest.id) || manifest.id.starts_with("builtin.") || manifest.name.trim().is_empty() || manifest.capabilities.is_empty()
            || manifest.capabilities.iter().any(|value| !valid_token(value)) { continue }
        let launch = match (manifest.runtime.as_deref(), manifest.entrypoint.as_deref(), manifest.executable.as_deref()) {
            (None, None, Some(executable)) => resolve_module_file(&dir, executable).map(ModuleLaunch::Executable),
            (Some("powershell"), Some(entrypoint), None) if entrypoint.to_ascii_lowercase().ends_with(".ps1") => resolve_module_file(&dir, entrypoint).map(ModuleLaunch::PowerShell),
            _ => None,
        };
        let Some(launch) = launch else { continue };
        modules.push((ModuleDescriptor { id:manifest.id, name:manifest.name, version:manifest.version, capabilities:manifest.capabilities, builtin:false, enabled:true }, launch));
    }
    modules.sort_by(|a,b| a.0.name.cmp(&b.0.name));
    modules
}

pub(crate) fn enabled(conn: &Connection, module_id: &str) -> Result<bool, String> {
    Ok(conn.query_row("SELECT enabled FROM module_states WHERE module_id=?1", [module_id], |r| r.get::<_,bool>(0)).optional().map_err(|e| e.to_string())?.unwrap_or(true))
}

#[tauri::command]
pub fn list_modules(state: State<'_, AppState>) -> Result<Vec<ModuleDescriptor>, String> {
    let mut items = builtin_modules().into_iter().map(|module| (module.descriptor)()).collect::<Vec<_>>();
    items.extend(module_entries(&state.modules_dir).into_iter().map(|(descriptor,_)| descriptor));
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    for item in &mut items { item.enabled = enabled(&conn,&item.id)?; }
    Ok(items)
}

pub(crate) fn external_modules_for_capability(root: &Path, capability: &str) -> Vec<ModuleDescriptor> {
    module_entries(root).into_iter().filter_map(|(descriptor,_)| descriptor.capabilities.iter().any(|item| item == capability).then_some(descriptor)).collect()
}

pub(crate) fn external_has_capability(root: &Path, module_id: &str, capability: &str) -> bool {
    module_entries(root).iter().any(|(module,_)| module.id == module_id && module.capabilities.iter().any(|item| item == capability))
}

#[tauri::command]
pub fn set_module_enabled(state: State<'_, AppState>, module_id: String, enabled: bool) -> Result<(), String> {
    let installed = builtin_modules().into_iter().any(|module| (module.descriptor)().id == module_id) || module_entries(&state.modules_dir).iter().any(|(descriptor,_)| descriptor.id == module_id);
    if !installed { return Err("模块未安装或清单无效".into()); }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO module_states(module_id,enabled,updated_at) VALUES (?1,?2,?3) ON CONFLICT(module_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at", rusqlite::params![module_id,enabled,crate::db::now()]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn modules_directory(state: State<'_, AppState>) -> String { state.modules_dir.to_string_lossy().to_string() }

#[tauri::command]
pub fn open_modules_directory(state: State<'_, AppState>) -> Result<(), String> {
    open::that(&state.modules_dir).map_err(|e| format!("打开模块目录失败：{e}"))
}

#[tauri::command]
pub fn manage_builtin_module(state: State<'_, AppState>, module_id: String, operation: String, payload: Value) -> Result<Value, String> {
    let module = builtin_modules().into_iter().find(|module| (module.descriptor)().id == module_id).ok_or("内置模块不存在")?;
    let manage = module.manage.ok_or("此模块没有管理接口")?;
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    if !enabled(&conn, &module_id)? { return Err("模块已关闭，请先在设置中开启".into()); }
    manage(&mut conn, &operation, payload)
}

#[tauri::command]
pub async fn invoke_module(state: State<'_, AppState>, module_id: String, capability: String, input: Value) -> Result<Value, String> {
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        if !enabled(&conn,&module_id)? { return Err("模块已关闭，请先在设置中开启".into()); }
    }
    if module_id == assignment_import::ID {
        return assignment_import::invoke(state, &capability, input).await;
    }
    invoke_external_module(&state.modules_dir, &module_id, &capability, input).await
}

pub(crate) async fn invoke_external_module(root: &Path, module_id: &str, capability: &str, input: Value) -> Result<Value, String> {
    let (descriptor, launch) = module_entries(root).into_iter().find(|(descriptor,_)| descriptor.id == module_id).ok_or("模块未安装或清单无效")?;
    if !descriptor.capabilities.iter().any(|item| item == &capability) { return Err("模块未声明此功能".into()) }
    let request = serde_json::to_vec(&json!({"protocol":1,"capability":capability,"input":input})).map_err(|e| e.to_string())?;
    if request.len() > 2_000_000 { return Err("模块输入过大".into()) }
    let mut command = match launch {
        ModuleLaunch::Executable(executable) => Command::new(executable),
        ModuleLaunch::PowerShell(entrypoint) => {
            let mut command = Command::new(if cfg!(windows) { "powershell.exe" } else { "pwsh" });
            command.args(["-NoLogo", "-NoProfile", "-NonInteractive"]);
            if cfg!(windows) { command.args(["-ExecutionPolicy", "Bypass"]); }
            command.arg("-File").arg(entrypoint);
            command
        }
    };
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn().map_err(|e| format!("启动模块失败：{e}"))?;
    let mut stdin = child.stdin.take().ok_or("模块输入管道不可用")?;
    stdin.write_all(&request).await.map_err(|e| format!("发送模块输入失败：{e}"))?;
    drop(stdin);
    let output = timeout(Duration::from_secs(120), child.wait_with_output()).await.map_err(|_| "模块运行超时（120 秒）".to_string())?.map_err(|e| format!("读取模块结果失败：{e}"))?;
    if !output.status.success() { return Err(format!("模块运行失败：{}",String::from_utf8_lossy(&output.stderr).chars().take(400).collect::<String>())) }
    if output.stdout.len() > 4_000_000 { return Err("模块输出过大".into()) }
    let response: Value = serde_json::from_slice(&output.stdout).map_err(|e| format!("模块返回的 JSON 无效：{e}"))?;
    if response.get("protocol").and_then(Value::as_u64) != Some(1) { return Err("模块协议版本不兼容".into()) }
    if response.get("ok").and_then(Value::as_bool) == Some(false) { return Err(response.get("error").and_then(Value::as_str).unwrap_or("模块执行失败").to_owned()) }
    response.get("result").cloned().ok_or("模块缺少 result 字段".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ignores_modules_with_invalid_ids_and_paths() {
        let root = std::env::temp_dir().join(format!("homeworkbook-modules-{}",uuid::Uuid::new_v4()));
        let dir = root.join("bad"); fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("module.json"), r#"{"id":"builtin.evil","name":"bad","version":"1","capabilities":["file.print"],"executable":"../../escape.exe"}"#).unwrap();
        assert!(module_entries(&root).is_empty());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn discovers_module_with_declared_capabilities() {
        let root = std::env::temp_dir().join(format!("homeworkbook-modules-{}",uuid::Uuid::new_v4()));
        let dir = root.join("sample"); fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("sample.exe"), b"sample").unwrap();
        fs::write(dir.join("module.json"), r#"{"id":"example.documents","name":"Documents","version":"1.0.0","capabilities":["document.parse","file.print"],"executable":"sample.exe"}"#).unwrap();
        let entries = module_entries(&root);
        assert_eq!(entries.len(),1);
        assert_eq!(entries[0].0.capabilities,vec!["document.parse","file.print"]);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn discovers_powershell_module_without_compilation() {
        let root = std::env::temp_dir().join(format!("homeworkbook-modules-{}",uuid::Uuid::new_v4()));
        let dir = root.join("navigation"); fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("module.ps1"), b"{}").unwrap();
        fs::write(dir.join("module.json"), r#"{"id":"example.navigation","name":"Navigation","version":"1.0.0","capabilities":["document.navigation.index"],"runtime":"powershell","entrypoint":"module.ps1"}"#).unwrap();
        let entries = module_entries(&root);
        assert_eq!(entries.len(),1);
        assert!(matches!(entries[0].1,ModuleLaunch::PowerShell(_)));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_powershell_entrypoint_outside_module_directory() {
        let root = std::env::temp_dir().join(format!("homeworkbook-modules-{}",uuid::Uuid::new_v4()));
        let dir = root.join("navigation"); fs::create_dir_all(&dir).unwrap();
        fs::write(root.join("escape.ps1"), b"{}").unwrap();
        fs::write(dir.join("module.json"), r#"{"id":"example.navigation","name":"Navigation","version":"1.0.0","capabilities":["document.navigation.index"],"runtime":"powershell","entrypoint":"../escape.ps1"}"#).unwrap();
        assert!(module_entries(&root).is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
