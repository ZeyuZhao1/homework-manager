//! Capability based local modules. Built-ins and user-installed executables share one JSON contract.
use crate::{ai, db::AppState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::{Component, Path, PathBuf}, process::Stdio, time::Duration};
use tauri::State;
use tokio::{io::AsyncWriteExt, process::Command, time::timeout};

const AI_ID: &str = "builtin.ai.assignment-import";
const AI_CAPABILITY: &str = "assignment.extract";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleDescriptor {
    pub id: String,
    pub name: String,
    pub version: String,
    pub capabilities: Vec<String>,
    pub builtin: bool,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    id: String,
    name: String,
    version: String,
    capabilities: Vec<String>,
    executable: String,
}

fn valid_token(value: &str) -> bool {
    !value.is_empty() && value.len() <= 100 && value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

fn module_entries(root: &Path) -> Vec<(ModuleDescriptor, PathBuf)> {
    let mut modules = Vec::new();
    let Ok(directories) = fs::read_dir(root) else { return modules };
    for entry in directories.flatten() {
        let dir = entry.path();
        if !dir.is_dir() { continue }
        let Ok(raw) = fs::read_to_string(dir.join("module.json")) else { continue };
        let Ok(manifest) = serde_json::from_str::<Manifest>(&raw) else { continue };
        if !valid_token(&manifest.id) || manifest.id.starts_with("builtin.") || manifest.name.trim().is_empty() || manifest.capabilities.is_empty()
            || manifest.capabilities.iter().any(|value| !valid_token(value)) { continue }
        let relative = Path::new(&manifest.executable);
        if relative.is_absolute() || relative.components().any(|c| !matches!(c, Component::Normal(_))) { continue }
        let Ok(root_canonical) = dir.canonicalize() else { continue };
        let Ok(executable) = dir.join(relative).canonicalize() else { continue };
        if !executable.starts_with(&root_canonical) || !executable.is_file() { continue }
        modules.push((ModuleDescriptor { id:manifest.id, name:manifest.name, version:manifest.version, capabilities:manifest.capabilities, builtin:false }, executable));
    }
    modules.sort_by(|a,b| a.0.name.cmp(&b.0.name));
    modules
}

#[tauri::command]
pub fn list_modules(state: State<'_, AppState>) -> Vec<ModuleDescriptor> {
    let mut items = vec![ModuleDescriptor { id:AI_ID.into(), name:"AI 作业识别".into(), version:env!("CARGO_PKG_VERSION").into(), capabilities:vec![AI_CAPABILITY.into()], builtin:true }];
    items.extend(module_entries(&state.modules_dir).into_iter().map(|(descriptor,_)| descriptor));
    items
}

#[tauri::command]
pub fn modules_directory(state: State<'_, AppState>) -> String { state.modules_dir.to_string_lossy().to_string() }

#[tauri::command]
pub fn open_modules_directory(state: State<'_, AppState>) -> Result<(), String> {
    open::that(&state.modules_dir).map_err(|e| format!("打开模块目录失败：{e}"))
}

#[tauri::command]
pub async fn invoke_module(state: State<'_, AppState>, module_id: String, capability: String, input: Value) -> Result<Value, String> {
    if module_id == AI_ID {
        if capability != AI_CAPABILITY { return Err("模块不支持此功能".into()) }
        let payload: ai::AiRequest = serde_json::from_value(input).map_err(|e| format!("作业识别输入无效：{e}"))?;
        return serde_json::to_value(ai::analyze_assignment(state,payload).await.map_err(|e| format!("AI 作业识别失败：{e}"))?).map_err(|e| e.to_string());
    }
    let (descriptor, executable) = module_entries(&state.modules_dir).into_iter().find(|(descriptor,_)| descriptor.id == module_id).ok_or("模块未安装或清单无效")?;
    if !descriptor.capabilities.iter().any(|item| item == &capability) { return Err("模块未声明此功能".into()) }
    let request = serde_json::to_vec(&json!({"protocol":1,"capability":capability,"input":input})).map_err(|e| e.to_string())?;
    if request.len() > 2_000_000 { return Err("模块输入过大".into()) }
    let mut child = Command::new(executable).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn().map_err(|e| format!("启动模块失败：{e}"))?;
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
}
