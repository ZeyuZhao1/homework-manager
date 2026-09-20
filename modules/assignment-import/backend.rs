use crate::db::{id_or_new, AppState};
use super::ModuleDescriptor;
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{multipart, Client};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}};
use tauri::State;

pub const ID: &str = "builtin.ai.assignment-import";
const CAPABILITY: &str = "assignment.extract";
const SYSTEM_PROMPT: &str = include_str!("prompts/assignment_system.txt");
const USER_PROMPT: &str = include_str!("prompts/assignment_user.txt");
const LEGACY_SYSTEM_PROMPT: &str = include_str!("prompts/legacy/assignment_system_v0.2.txt");
const LEGACY_USER_PROMPT: &str = include_str!("prompts/legacy/assignment_user_v0.2.txt");

pub fn descriptor() -> ModuleDescriptor {
    let manifest: Value = serde_json::from_str(include_str!("module.json")).expect("bundled assignment-import manifest");
    ModuleDescriptor {
        id: manifest["id"].as_str().unwrap_or(ID).into(),
        name: manifest["name"].as_str().unwrap_or("AI 作业导入").into(),
        version: manifest["version"].as_str().unwrap_or(env!("CARGO_PKG_VERSION")).into(),
        capabilities: vec![CAPABILITY.into()],
        builtin: true,
        enabled: true,
    }
}

pub async fn invoke(state: State<'_, AppState>, capability: &str, input: Value) -> Result<Value, String> {
    if capability != CAPABILITY { return Err("模块不支持此功能".into()); }
    let payload: AiRequest = serde_json::from_value(input).map_err(|e| format!("作业识别输入无效：{e}"))?;
    serde_json::to_value(analyze_assignment(state, payload).await?).map_err(|e| e.to_string())
}

fn prompt_dir(data_dir: &Path) -> PathBuf { data_dir.join("modules").join("assignment-import").join("prompts") }
fn state_prompt_dir(state: &AppState) -> Result<PathBuf, String> {
    Ok(prompt_dir(state.modules_dir.parent().ok_or("模块目录无效")?))
}

fn key_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("app.homeworkbook.local", id).map_err(|e| e.to_string())
}
fn provider_key(id: &str) -> Result<String, String> {
    key_entry(id)?.get_password().map_err(|_| "此服务商尚未保存 API Key".to_string())
}

fn table_exists(conn: &rusqlite::Connection, name: &str) -> Result<bool, String> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)", [name], |r| r.get(0)).map_err(|e| e.to_string())
}

pub fn initialize(conn: &rusqlite::Connection, data_dir: &Path) -> Result<(), String> {
    let prompts = prompt_dir(data_dir);
    fs::create_dir_all(&prompts).map_err(|e| e.to_string())?;
    let old_prompts = data_dir.join("prompts");
    for (name, bundled, legacy) in [
        ("assignment_system.txt", SYSTEM_PROMPT, LEGACY_SYSTEM_PROMPT),
        ("assignment_user.txt", USER_PROMPT, LEGACY_USER_PROMPT),
    ] {
        let destination = prompts.join(name);
        let existing = fs::read_to_string(&destination).ok();
        let old = fs::read_to_string(old_prompts.join(name)).ok();
        let replacement = if existing.is_some() { existing } else { old };
        if replacement.is_none() || replacement.as_deref() == Some(legacy) {
            fs::write(&destination, bundled).map_err(|e| format!("无法初始化提示词 {}：{e}", destination.display()))?;
        } else if !destination.exists() {
            fs::write(&destination, replacement.unwrap()).map_err(|e| format!("无法迁移提示词 {}：{e}", destination.display()))?;
        }
    }
    conn.execute_batch("CREATE TABLE IF NOT EXISTS assignment_import_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS assignment_import_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);").map_err(|e| e.to_string())?;
    let migrated: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM assignment_import_settings WHERE key='legacy_migrated')", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !migrated {
        if table_exists(conn, "providers")? {
            conn.execute("INSERT OR IGNORE INTO assignment_import_providers(id,name,kind,base_url,model) SELECT id,name,kind,base_url,model FROM providers", []).map_err(|e| e.to_string())?;
        }
        for key in ["assignment_provider_id", "material_provider_id"] {
            conn.execute("INSERT OR IGNORE INTO assignment_import_settings(key,value) SELECT key,value FROM settings WHERE key=?1", [key]).map_err(|e| e.to_string())?;
        }
        conn.execute("INSERT INTO assignment_import_settings(key,value) VALUES ('legacy_migrated','1')", []).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct Provider { id:String, name:String, kind:String, base_url:String, model:String, has_key:bool }
#[derive(Debug, Deserialize)]
pub struct ProviderInput { id:String, name:String, kind:String, base_url:String, model:String, api_key:String }
#[derive(Debug, Serialize)]
pub struct ModuleConfig { providers: Vec<Provider>, assignment_provider_id:String, material_provider_id:String, prompt_directory:String }

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> Result<ModuleConfig, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let providers = conn.prepare("SELECT id,name,kind,base_url,model FROM assignment_import_providers ORDER BY name").map_err(|e| e.to_string())?
        .query_map([], |r| { let id:String=r.get(0)?; Ok(Provider { has_key:provider_key(&id).is_ok(), id, name:r.get(1)?,kind:r.get(2)?,base_url:r.get(3)?,model:r.get(4)? }) }).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    let setting = |key: &str| -> Result<String,String> { Ok(conn.query_row("SELECT value FROM assignment_import_settings WHERE key=?1", [key], |r| r.get(0)).optional().map_err(|e| e.to_string())?.unwrap_or_default()) };
    Ok(ModuleConfig { providers, assignment_provider_id:setting("assignment_provider_id")?, material_provider_id:setting("material_provider_id")?, prompt_directory:state_prompt_dir(&state)?.to_string_lossy().to_string() })
}

#[tauri::command]
pub fn save_provider(state: State<'_, AppState>, mut payload: ProviderInput) -> Result<String, String> {
    if !["bailian","deepseek","gemini","custom"].contains(&payload.kind.as_str()) { return Err("无效的服务商类型".into()); }
    if payload.name.trim().is_empty() || payload.model.trim().is_empty() { return Err("请填写服务商名称和模型".into()); }
    let url = reqwest::Url::parse(payload.base_url.trim()).map_err(|_| "服务地址无效")?;
    if url.scheme() != "https" && !(url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))) { return Err("服务地址必须使用 HTTPS".into()); }
    payload.id = id_or_new(&payload.id);
    if !payload.api_key.trim().is_empty() { key_entry(&payload.id)?.set_password(payload.api_key.trim()).map_err(|e| e.to_string())?; }
    else if provider_key(&payload.id).is_err() { return Err("请填写 API Key".into()); }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO assignment_import_providers(id,name,kind,base_url,model) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,base_url=excluded.base_url,model=excluded.model", params![payload.id,payload.name.trim(),payload.kind,url.as_str().trim_end_matches('/'),payload.model.trim()]).map_err(|e| e.to_string())?;
    Ok(payload.id)
}

#[tauri::command]
pub fn delete_provider(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM assignment_import_providers WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    conn.execute("UPDATE assignment_import_settings SET value='' WHERE value=?1 AND key IN ('assignment_provider_id','material_provider_id')", [&id]).map_err(|e| e.to_string())?;
    let _ = key_entry(&id).and_then(|e| e.delete_credential().map_err(|e| e.to_string()));
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct RoutingInput { assignment_provider_id:String, material_provider_id:String }
#[tauri::command]
pub fn save_routing(state: State<'_, AppState>, payload: RoutingInput) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    for (key,value) in [("assignment_provider_id",payload.assignment_provider_id),("material_provider_id",payload.material_provider_id)] {
        if !value.is_empty() && !conn.query_row("SELECT EXISTS(SELECT 1 FROM assignment_import_providers WHERE id=?1)", [&value], |r| r.get::<_,bool>(0)).map_err(|e| e.to_string())? { return Err("服务商不存在".into()); }
        conn.execute("INSERT INTO assignment_import_settings(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,value]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct AiRequest {
    pub text: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiDraft {
    #[serde(default)] pub course_name: String,
    #[serde(default)] pub course_id: String,
    #[serde(default)] pub title: String,
    #[serde(default)] pub description: String,
    #[serde(default)] pub due_at: Option<String>,
    #[serde(default)] pub submission_label: String,
    #[serde(default)] pub submission_url: String,
    #[serde(default)] pub submission_notes: String,
    #[serde(default)] pub evidence: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AiResult {
    pub assignments: Vec<AiDraft>,
}

#[derive(Debug)]
struct ProviderConfig { id:String, kind:String, base_url:String, model:String }

fn classify(path: &str) -> Result<&'static str, String> {
    let ext = Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    match ext.as_str() {
        "pdf" => Ok("pdf"), "docx" => Ok("docx"),
        "png" | "jpg" | "jpeg" | "gif" | "webp" => Ok("image"),
        _ => Err(format!("不支持的导入文件格式：{ext}")),
    }
}

fn image_mime(path: &str) -> &'static str {
    match Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
        "png" => "image/png", "gif" => "image/gif", "webp" => "image/webp", _ => "image/jpeg"
    }
}

fn check_capability(provider: &ProviderConfig, paths: &[String]) -> Result<(), String> {
    let model = provider.model.to_lowercase();
    let file_model = provider.kind == "bailian" && (model.starts_with("qwen-long") || model == "qwen-doc-turbo");
    if model == "qwen-doc-turbo" && paths.len() > 1 { return Err("qwen-doc-turbo 一次只支持一个文件，请分批导入或切换 qwen-long".into()); }
    for path in paths {
        let kind = classify(path)?;
        if kind == "pdf" {
            if provider.kind != "bailian" && provider.kind != "gemini" { return Err("所选服务商不支持直接传入 PDF。请切换到支持 PDF 文件输入的百炼或 Gemini 模型。".into()); }
            if provider.kind == "bailian" && !model.starts_with("qwen3.8-") && !file_model {
                return Err("此百炼模型未标记为支持 PDF。请选择 qwen3.8 系列、qwen-long 或 qwen-doc-turbo。".into());
            }
        }
        if kind == "docx" && !file_model {
            return Err("所选模型不支持直接传入 DOCX。请选择百炼 qwen-long 或 qwen-doc-turbo。".into());
        }
        if kind == "image" && !file_model && !(provider.kind == "gemini" || (provider.kind == "deepseek" && model == "deepseek-flash") || (provider.kind == "bailian" && (model.starts_with("qwen3.8-") || model.contains("vl")))) {
            return Err("所选模型未标记为支持图片。请使用百炼视觉模型、qwen-long、qwen-doc-turbo 或 deepseek-flash。".into());
        }
    }
    Ok(())
}

fn extract_json(content: &str) -> Result<AiResult, String> {
    let text = content.trim();
    let data = if text.starts_with('{') { text } else {
        let start = text.find('{').ok_or("模型未返回可解析的作业数据")?;
        let end = text.rfind('}').ok_or("模型未返回完整的作业数据")?;
        &text[start..=end]
    };
    let mut result: AiResult = serde_json::from_str(data).map_err(|_| "模型返回格式无效，请重试或改用手动录入".to_string())?;
    result.assignments.retain(|a| !a.title.trim().is_empty());
    if result.assignments.is_empty() { return Err("未识别出独立作业，请检查输入内容".into()); }
    for item in &mut result.assignments {
        if let Some(due) = &item.due_at {
            if chrono::NaiveDateTime::parse_from_str(due, "%Y-%m-%dT%H:%M:%S").is_err() {
                item.due_at = None;
            }
        }
    }
    Ok(result)
}

fn response_content(value: &Value) -> Result<&str, String> {
    value.pointer("/choices/0/message/content").and_then(Value::as_str).ok_or_else(|| "服务商没有返回文字内容".into())
}

fn prompt_file(directory: &Path, name: &str) -> Result<String, String> {
    let path = directory.join(name);
    let metadata = fs::metadata(&path).map_err(|e| format!("提示词文件无法读取（{}）：{e}",path.display()))?;
    if metadata.len() > 64 * 1024 { return Err("单个提示词文件不能超过 64 KB".into()); }
    let content = fs::read_to_string(&path).map_err(|e| format!("提示词文件编码或内容无效：{e}"))?;
    if content.trim().is_empty() { return Err(format!("提示词文件不能为空：{}",path.display())); }
    Ok(content)
}

fn import_prompts(directory: &Path, courses: &str, content: &str) -> Result<(String,String), String> {
    let system = prompt_file(directory,"assignment_system.txt")?;
    let template = prompt_file(directory,"assignment_user.txt")?;
    if !template.contains("{content}") { return Err("assignment_user.txt 必须包含 {content} 占位符".into()); }
    let user = template.replace("{date}",&chrono::Local::now().format("%Y-%m-%d").to_string())
        .replace("{courses}",courses).replace("{content}",content);
    Ok((system,user))
}

#[tauri::command]
pub fn prompt_directory(state: State<'_, AppState>) -> String {
    state_prompt_dir(&state).map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
}

#[tauri::command]
pub fn open_prompt_directory(state: State<'_, AppState>) -> Result<(), String> {
    open::that(state_prompt_dir(&state)?).map_err(|e| format!("无法打开提示词文件夹：{e}"))
}

fn http_error(error: reqwest::Error) -> String {
    if error.is_timeout() { "服务商请求超时，请稍后重试".into() } else { error.to_string() }
}

fn gemini_request(system: &str, prompt: &str, files: &[(String, String)]) -> Value {
    let mut parts = vec![json!({"text":prompt})];
    for (mime, encoded) in files {
        parts.push(json!({"inline_data":{"mime_type":mime,"data":encoded}}));
    }
    json!({
        "systemInstruction":{"parts":[{"text":system}]},
        "contents":[{"role":"user","parts":parts}],
        "generationConfig":{"responseMimeType":"application/json","temperature":0.1}
    })
}

fn gemini_response(value: &Value) -> Result<String, String> {
    let parts = value.pointer("/candidates/0/content/parts").and_then(Value::as_array).ok_or_else(|| {
        let reason = value.pointer("/promptFeedback/blockReason").and_then(Value::as_str).unwrap_or("没有返回候选结果");
        format!("Gemini 未返回识别结果：{reason}")
    })?;
    let text = parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<String>();
    if text.is_empty() { return Err("Gemini 没有返回文字内容".into()); }
    Ok(text)
}

async fn do_gemini_import(client: &Client, provider: &ProviderConfig, key: &str, system: &str, prompt: &str, paths: &[String]) -> Result<AiResult, String> {
    if !provider.model.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')) || provider.model.is_empty() {
        return Err("Gemini 模型名称只能包含字母、数字、连字符、下划线和点".into());
    }
    let mut files = Vec::new();
    for path in paths {
        if !Path::new(path).is_file() { return Err(format!("导入文件不存在：{path}")); }
        let kind = classify(path)?;
        let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
        if size > 20 * 1024 * 1024 { return Err("单个导入文件不能超过 20 MB".into()); }
        let mime = if kind == "pdf" { "application/pdf" } else { image_mime(path) };
        files.push((mime.to_owned(), STANDARD.encode(fs::read(path).map_err(|e| e.to_string())?)));
    }
    let request = gemini_request(system, prompt, &files);
    let url = format!("{}/models/{}:generateContent", provider.base_url.trim_end_matches('/'), provider.model);
    let response = client.post(url).header("x-goog-api-key", key).json(&request).send().await.map_err(http_error)?;
    let status = response.status();
    let value: Value = response.json().await.map_err(http_error)?;
    if !status.is_success() { return Err(format!("Gemini 请求失败（{}）：{}", status, value.get("error").unwrap_or(&value))); }
    extract_json(&gemini_response(&value)?)
}

async fn upload_file(client: &Client, provider: &ProviderConfig, key: &str, path: &str) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > 20 * 1024 * 1024 { return Err("文件超过首版 20 MB 上传限制".into()); }
    let name = Path::new(path).file_name().unwrap_or_default().to_string_lossy().to_string();
    let mime = match classify(path)? { "pdf" => "application/pdf", "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document", _ => image_mime(path) };
    let part = multipart::Part::bytes(bytes).file_name(name).mime_str(mime).map_err(|e| e.to_string())?;
    let form = multipart::Form::new().text("purpose", "file-extract").part("file", part);
    let response = client.post(format!("{}/files",provider.base_url)).bearer_auth(key).multipart(form).send().await.map_err(http_error)?;
    let status = response.status();
    let value: Value = response.json().await.map_err(http_error)?;
    if !status.is_success() { return Err(format!("文件上传失败：{}", value)); }
    value.get("id").and_then(Value::as_str).map(str::to_owned).ok_or_else(|| "文件上传未返回 ID".into())
}

async fn do_import(provider: &ProviderConfig, key: &str, system: &str, prompt: &str, paths: &[String]) -> Result<AiResult, String> {
    let timeout = std::time::Duration::from_secs(if paths.iter().any(|p| classify(p).ok() == Some("pdf")) { 360 } else { 120 });
    do_import_with_timeout(provider,key,system,prompt,paths,timeout).await
}

async fn do_import_with_timeout(provider: &ProviderConfig, key: &str, system: &str, prompt: &str, paths: &[String], timeout: std::time::Duration) -> Result<AiResult, String> {
    let client = Client::builder().timeout(timeout).build().map_err(|e| e.to_string())?;
    if provider.kind == "gemini" { return do_gemini_import(&client, provider, key, system, prompt, paths).await; }
    let file_model = provider.kind == "bailian" && (provider.model.to_lowercase().starts_with("qwen-long") || provider.model.eq_ignore_ascii_case("qwen-doc-turbo"));
    let mut content = vec![json!({"type":"text","text":prompt})];
    let mut uploaded = Vec::new();
    let outcome = async {
        for path in paths {
            let kind = classify(path)?;
            if !Path::new(path).is_file() { return Err(format!("导入文件不存在：{path}")); }
            let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
            if size > 20 * 1024 * 1024 { return Err("单个导入文件不能超过 20 MB".into()); }
            if file_model {
                let file_id = upload_file(&client,provider,key,path).await?;
                uploaded.push(file_id);
            } else {
                let encoded = STANDARD.encode(fs::read(path).map_err(|e| e.to_string())?);
                if kind == "pdf" {
                    let name = Path::new(path).file_name().unwrap_or_default().to_string_lossy().to_string();
                    content.push(json!({"type":"file","file":{"file_data":format!("data:application/pdf;base64,{encoded}"),"filename":name}}));
                } else {
                    content.push(json!({"type":"image_url","image_url":{"url":format!("data:{};base64,{encoded}", image_mime(path))}}));
                }
            }
        }
        let mut messages = vec![json!({"role":"system","content":system})];
        for file_id in &uploaded { messages.push(json!({"role":"system","content":format!("fileid://{file_id}")})); }
        messages.push(json!({"role":"user","content":if file_model { Value::String(prompt.to_owned()) } else { Value::Array(content) }}));
        let request = json!({"model":provider.model,"messages":messages,"temperature":0.1});
        let response = client.post(format!("{}/chat/completions",provider.base_url)).bearer_auth(key).json(&request).send().await.map_err(http_error)?;
        let status = response.status();
        let value: Value = response.json().await.map_err(http_error)?;
        if !status.is_success() { return Err(format!("模型请求失败（{}）：{}",status,value.get("error").unwrap_or(&value))); }
        extract_json(response_content(&value)?)
    }.await;
    for file_id in uploaded {
        let _ = client.delete(format!("{}/files/{}",provider.base_url,file_id)).bearer_auth(key).send().await;
    }
    outcome
}

#[tauri::command]
pub async fn analyze_assignment(state: State<'_, AppState>, payload: AiRequest) -> Result<AiResult, String> {
    if payload.text.trim().is_empty() && payload.paths.is_empty() { return Err("请粘贴内容或选择文件".into()); }
    let (provider, courses) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let selected: String = conn.query_row("SELECT value FROM assignment_import_settings WHERE key='assignment_provider_id'", [], |r| r.get(0)).optional().map_err(|e| e.to_string())?.unwrap_or_default();
        if selected.is_empty() { return Err("请先在设置中为“作业识别”指定 AI 服务商".into()); }
        let provider = conn.query_row("SELECT id,kind,base_url,model FROM assignment_import_providers WHERE id=?1", [&selected], |r| Ok(ProviderConfig{id:r.get(0)?,kind:r.get(1)?,base_url:r.get(2)?,model:r.get(3)?})).map_err(|e| e.to_string())?;
        let courses = crate::db::course_identifiers(&conn)?;
        (provider,courses)
    };
    check_capability(&provider,&payload.paths)?;
    if !provider.base_url.starts_with("https://") && !provider.base_url.starts_with("http://127.0.0.1") && !provider.base_url.starts_with("http://localhost") { return Err("服务地址必须使用 HTTPS".into()); }
    let key = provider_key(&provider.id)?;
    let course_names = serde_json::to_string(&courses.iter().map(|(_,name,code)| json!({"name":name,"code":code})).collect::<Vec<_>>()).map_err(|e| e.to_string())?;
    let (system,prompt) = import_prompts(&state_prompt_dir(&state)?,&course_names,&payload.text)?;
    let mut result = do_import(&provider,&key,&system,&prompt,&payload.paths).await?;
    resolve_course_ids(&mut result,&courses);
    Ok(result)
}

fn resolve_course_ids(result: &mut AiResult, courses: &[(String,String,String)]) {
    for draft in &mut result.assignments {
        let matches = courses.iter().filter(|(_,name,code)| name.eq_ignore_ascii_case(draft.course_name.trim()) || (!code.is_empty() && code.eq_ignore_ascii_case(draft.course_name.trim()))).collect::<Vec<_>>();
        draft.course_id = if matches.len() == 1 { matches[0].0.clone() } else { String::new() };
    }
}

// The data contract for future textbook-page matching. No model call is made yet.
#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize)]
pub struct MaterialSuggestion {
    pub assignment_id: String,
    pub file_id: String,
    pub page: Option<String>,
    pub chapter: Option<String>,
    pub problem: Option<String>,
    pub evidence: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::Duration;
    #[test]
    fn parses_multiple_assignments_and_unknown_due() {
        let result = extract_json(r#"{"assignments":[{"title":"A","due_at":"2026-09-25T23:59:00"},{"title":"B","due_at":null}]}"#).unwrap();
        assert_eq!(result.assignments.len(),2);
        assert_eq!(result.assignments[1].due_at,None);
    }
    #[test]
    fn editable_prompts_require_content_placeholder() {
        let directory = std::env::temp_dir().join(format!("homework-prompts-{}",Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("assignment_system.txt"),"custom system").unwrap();
        fs::write(directory.join("assignment_user.txt"),"课程 {courses}，内容 {content}").unwrap();
        let (system,user) = import_prompts(&directory,"Calculus","A 和 B").unwrap();
        assert_eq!(system,"custom system");
        assert!(user.contains("A 和 B"));
        fs::write(directory.join("assignment_user.txt"),"missing placeholder").unwrap();
        assert!(import_prompts(&directory,"Calculus","A 和 B").is_err());
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn bundled_prompt_keeps_runtime_data_after_shared_prefix() {
        let dir = std::env::temp_dir().join(format!("homework-prompt-order-{}",Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("assignment_system.txt"),SYSTEM_PROMPT).unwrap();
        fs::write(dir.join("assignment_user.txt"),USER_PROMPT).unwrap();
        let (system,user) = import_prompts(&dir,"[{\"name\":\"Calculus\",\"code\":\"MA117\"}]","作业 A 和作业 B").unwrap();
        assert!(!system.contains("{date}") && !system.contains("{courses}") && !system.contains("{content}"));
        assert!(user.starts_with("请按系统规则"));
        assert!(user.find("\"MA117\"").unwrap() < user.find("本地今天").unwrap());
        assert!(user.find("本地今天").unwrap() < user.find("作业 A 和作业 B").unwrap());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn deepseek_rejects_pdf() {
        let config = ProviderConfig{id:"x".into(),kind:"deepseek".into(),base_url:"https://api.deepseek.com".into(),model:"deepseek-flash".into()};
        assert!(check_capability(&config,&["hw.pdf".into()]).is_err());
        assert!(check_capability(&config,&["board.png".into()]).is_ok());
        assert!(check_capability(&config,&["old.doc".into()]).is_err());
    }
    #[test]
    fn gemini_accepts_pdf_and_images_but_rejects_docx() {
        let config = ProviderConfig{id:"g".into(),kind:"gemini".into(),base_url:"https://generativelanguage.googleapis.com/v1beta".into(),model:"gemini-2.5-flash".into()};
        assert!(check_capability(&config,&["sheet.pdf".into(),"photo.png".into()]).is_ok());
        assert!(check_capability(&config,&["sheet.docx".into()]).is_err());
        let request = gemini_request("rules","homework",&[("application/pdf".into(),"cGRm".into())]);
        assert_eq!(request["systemInstruction"]["parts"][0]["text"],"rules");
        assert_eq!(request["contents"][0]["parts"][1]["inline_data"]["mime_type"],"application/pdf");
        assert_eq!(request["generationConfig"]["responseMimeType"],"application/json");
        let response = json!({"candidates":[{"content":{"parts":[{"text":"{\"assignments\":[{\"title\":\"A\"}]}"}]}}]});
        assert_eq!(extract_json(&gemini_response(&response).unwrap()).unwrap().assignments[0].title,"A");
    }
    #[test]
    fn migrates_legacy_settings_and_custom_prompt_once() {
        let dir = std::env::temp_dir().join(format!("homeworkbook-module-migration-{}",Uuid::new_v4()));
        fs::create_dir_all(dir.join("prompts")).unwrap();
        fs::write(dir.join("prompts/assignment_system.txt"),"my custom rules").unwrap();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT,kind TEXT,base_url TEXT,model TEXT);
          INSERT INTO providers VALUES('old','Previous','deepseek','https://api.deepseek.com','deepseek-flash');
          INSERT INTO settings VALUES('assignment_provider_id','old');").unwrap();
        initialize(&conn,&dir).unwrap();
        let migrated: String = conn.query_row("SELECT value FROM assignment_import_settings WHERE key='assignment_provider_id'",[],|r|r.get(0)).unwrap();
        assert_eq!(migrated,"old");
        assert_eq!(fs::read_to_string(prompt_dir(&dir).join("assignment_system.txt")).unwrap(),"my custom rules");
        conn.execute("DELETE FROM assignment_import_providers WHERE id='old'",[]).unwrap();
        initialize(&conn,&dir).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM assignment_import_providers",[],|r|r.get(0)).unwrap();
        assert_eq!(count,0);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejects_invalid_model_output_and_clears_bad_date() {
        assert!(extract_json("not JSON").is_err());
        assert!(extract_json(r#"{"assignments":[]}"#).is_err());
        let parsed = extract_json(r#"{"assignments":[{"title":"题目","due_at":"下周"}]}"#).unwrap();
        assert!(parsed.assignments[0].due_at.is_none());
    }
    #[test]
    fn qwen_doc_only_accepts_one_file() {
        let config = ProviderConfig{id:"x".into(),kind:"bailian".into(),base_url:"https://dashscope.aliyuncs.com/compatible-mode/v1".into(),model:"qwen-doc-turbo".into()};
        assert!(check_capability(&config,&["hw.docx".into()]).is_ok());
        assert!(check_capability(&config,&["one.pdf".into(),"two.pdf".into()]).is_err());
    }
    #[test]
    fn unknown_course_requires_review() {
        let mut parsed = extract_json(r#"{"assignments":[{"course_name":"Calculus","title":"A"},{"course_name":"Imaginary","title":"B"},{"course_name":"MA117","title":"C"}]}"#).unwrap();
        resolve_course_ids(&mut parsed,&[("course-1".into(),"Calculus".into(),"MA117".into())]);
        assert_eq!(parsed.assignments[0].course_id,"course-1");
        assert!(parsed.assignments[1].course_id.is_empty());
        assert_eq!(parsed.assignments[2].course_id,"course-1");
    }
    #[test]
    fn simulated_provider_response_and_timeout() {
        fn server(body: &str, delay: Duration) -> (String,std::thread::JoinHandle<()>) {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}",listener.local_addr().unwrap());
            let body = body.to_owned();
            let handle = std::thread::spawn(move || {
                let (mut stream,_) = listener.accept().unwrap();
                let mut buffer = [0u8;8192];
                let _ = stream.read(&mut buffer);
                std::thread::sleep(delay);
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
                let _ = stream.write_all(response.as_bytes());
            });
            (url,handle)
        }
        let content = r#"{"assignments":[{"title":"Problem Set 1","due_at":null},{"title":"Problem Set 2","due_at":"2026-09-25T17:00:00"}]}"#;
        let response = json!({"choices":[{"message":{"content":content}}]}).to_string();
        let (url,handle) = server(&response,Duration::ZERO);
        let provider = ProviderConfig{id:"mock".into(),kind:"custom".into(),base_url:url,model:"mock-model".into()};
        let result = tauri::async_runtime::block_on(do_import_with_timeout(&provider,"test","system","sample",&[],Duration::from_secs(2))).unwrap();
        handle.join().unwrap();
        assert_eq!(result.assignments[0].title,"Problem Set 1");
        assert!(result.assignments[0].due_at.is_none());
        assert_eq!(result.assignments[1].title,"Problem Set 2");

        let (url,handle) = server(&response,Duration::from_millis(120));
        let slow = ProviderConfig{base_url:url,..provider};
        let error = tauri::async_runtime::block_on(do_import_with_timeout(&slow,"test","system","sample",&[],Duration::from_millis(20))).unwrap_err();
        handle.join().unwrap();
        assert!(error.contains("超时"), "{error}");
    }
    #[test]
    fn gemini_native_http_request_returns_multiple_assignments() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}/v1beta",listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream,_) = listener.accept().unwrap();
            let mut buffer = [0u8;8192];
            let size = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..size]).to_lowercase();
            assert!(request.starts_with("post /v1beta/models/gemini-2.5-flash:generatecontent "));
            assert!(request.contains("x-goog-api-key: sample-key"));
            let content = r#"{"assignments":[{"title":"Homework 1","due_at":null},{"title":"Homework 2","due_at":null}]}"#;
            let body = json!({"candidates":[{"content":{"parts":[{"text":content}]}}]}).to_string();
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
            stream.write_all(response.as_bytes()).unwrap();
        });
        let provider = ProviderConfig{id:"g".into(),kind:"gemini".into(),base_url,model:"gemini-2.5-flash".into()};
        let result = tauri::async_runtime::block_on(do_import_with_timeout(&provider,"sample-key","system","two assignments",&[],Duration::from_secs(2))).unwrap();
        handle.join().unwrap();
        assert_eq!(result.assignments.len(),2);
    }
}
