use crate::db::{now, provider_key, remember_value, AppState};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{multipart, Client};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::Path};
use tauri::State;
use uuid::Uuid;

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

#[derive(Debug, Deserialize)]
pub struct SaveImportRequest {
    pub drafts: Vec<AiDraft>,
    pub paths: Vec<String>,
    pub source_name: String,
    pub source_text: String,
}

#[tauri::command]
pub fn save_import_drafts(state: State<'_, AppState>, payload: SaveImportRequest) -> Result<Vec<String>, String> {
    if payload.drafts.is_empty() { return Err("没有可创建的作业".into()); }
    for draft in &payload.drafts {
        if draft.title.trim().is_empty() || draft.course_id.trim().is_empty() { return Err("请为每条作业确认课程和标题".into()); }
    }
    let paths = payload.paths.iter().map(|path| {
        let canonical = fs::canonicalize(path).map_err(|_| format!("文件不存在：{path}"))?;
        if !canonical.is_file() { return Err(format!("请选择文件：{path}")); }
        Ok(crate::files::normal_path(&canonical))
    }).collect::<Result<Vec<_>, String>>()?;
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut ids = Vec::with_capacity(payload.drafts.len());
    for draft in &payload.drafts {
        let id = Uuid::new_v4().to_string();
        let timestamp = now();
        tx.execute("INSERT INTO assignments(id,course_id,title,description,due_at,status,submission_label,submission_url,submission_notes,source_name,source_text,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,'todo',?6,?7,?8,?9,?10,?11,?11)", params![id,draft.course_id,draft.title.trim(),draft.description,draft.due_at,draft.submission_label,draft.submission_url,draft.submission_notes,payload.source_name,payload.source_text,timestamp]).map_err(|e| e.to_string())?;
        for (field,value) in [("title",&draft.title),("submission_label",&draft.submission_label),("submission_url",&draft.submission_url),("submission_notes",&draft.submission_notes)] { remember_value(&tx,field,value)?; }
        for path in &paths {
            tx.execute("INSERT OR IGNORE INTO file_assets(id,path) VALUES (?1,?2)", params![Uuid::new_v4().to_string(),path]).map_err(|e| e.to_string())?;
            let file_id: String = tx.query_row("SELECT id FROM file_assets WHERE path=?1", [path], |r| r.get(0)).map_err(|e| e.to_string())?;
            tx.execute("INSERT INTO assignment_files(id,assignment_id,file_id,role) VALUES (?1,?2,?3,'prompt')", params![Uuid::new_v4().to_string(),id,file_id]).map_err(|e| e.to_string())?;
        }
        ids.push(id);
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ids)
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
            if provider.kind != "bailian" { return Err("所选服务商不支持直接传入 PDF。请切换到支持 PDF 文件输入的百炼模型。".into()); }
            if !model.starts_with("qwen3.8-") && !file_model {
                return Err("此百炼模型未标记为支持 PDF。请选择 qwen3.8 系列、qwen-long 或 qwen-doc-turbo。".into());
            }
        }
        if kind == "docx" && !file_model {
            return Err("所选模型不支持直接传入 DOCX。请选择百炼 qwen-long 或 qwen-doc-turbo。".into());
        }
        if kind == "image" && !file_model && !((provider.kind == "deepseek" && model == "deepseek-flash") || (provider.kind == "bailian" && (model.starts_with("qwen3.8-") || model.contains("vl")))) {
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
    state.prompts_dir.to_string_lossy().to_string()
}

#[tauri::command]
pub fn open_prompt_directory(state: State<'_, AppState>) -> Result<(), String> {
    open::that(&state.prompts_dir).map_err(|e| format!("无法打开提示词文件夹：{e}"))
}

fn http_error(error: reqwest::Error) -> String {
    if error.is_timeout() { "服务商请求超时，请稍后重试".into() } else { error.to_string() }
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
        let selected: String = conn.query_row("SELECT value FROM settings WHERE key='assignment_provider_id'", [], |r| r.get(0)).optional().map_err(|e| e.to_string())?.unwrap_or_default();
        if selected.is_empty() { return Err("请先在设置中为“作业识别”指定 AI 服务商".into()); }
        let provider = conn.query_row("SELECT id,kind,base_url,model FROM providers WHERE id=?1", [&selected], |r| Ok(ProviderConfig{id:r.get(0)?,kind:r.get(1)?,base_url:r.get(2)?,model:r.get(3)?})).map_err(|e| e.to_string())?;
        let courses = conn.prepare("SELECT id,name,code FROM courses ORDER BY name,code").map_err(|e| e.to_string())?.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
        (provider,courses)
    };
    check_capability(&provider,&payload.paths)?;
    if !provider.base_url.starts_with("https://") && !provider.base_url.starts_with("http://127.0.0.1") && !provider.base_url.starts_with("http://localhost") { return Err("服务地址必须使用 HTTPS".into()); }
    let key = provider_key(&provider.id)?;
    let course_names = serde_json::to_string(&courses.iter().map(|(_,name,code)| json!({"name":name,"code":code})).collect::<Vec<_>>()).map_err(|e| e.to_string())?;
    let (system,prompt) = import_prompts(&state.prompts_dir,&course_names,&payload.text)?;
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

// The data contract for future textbook-page matching. No model call is made in v1.
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
        fs::write(dir.join("assignment_system.txt"),include_str!("../prompts/assignment_system.txt")).unwrap();
        fs::write(dir.join("assignment_user.txt"),include_str!("../prompts/assignment_user.txt")).unwrap();
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
}
