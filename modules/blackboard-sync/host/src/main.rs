use serde_json::{json, Value};
use std::{
    env, fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

const EXTENSION_ORIGIN: &str = "chrome-extension://khcipngaeiianinnofmmiofnbbbinlkm/";
const SERVICE: &str = "app.homeworkbook.bbreader";
const MAX_REQUEST: usize = 4_000_000;

fn require_origin(origin: &str) -> Result<(), String> {
    if origin == EXTENSION_ORIGIN {
        Ok(())
    } else {
        Err("扩展来源无权访问本地主机".into())
    }
}

fn only_keys(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|object| object.keys().all(|key| keys.contains(&key.as_str())))
}

fn inbox_path() -> Result<PathBuf, String> {
    let exe = env::current_exe().map_err(|e| e.to_string())?;
    Ok(exe.parent().ok_or("模块目录不可用")?.join("inbox.json"))
}

fn credential() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, "campus-login")
        .map_err(|e| format!("打开 Windows 凭据管理器失败：{e}"))
}

fn validate_snapshot(value: &Value) -> Result<(), String> {
    if !only_keys(
        value,
        &[
            "protocol",
            "account_key",
            "checked_at",
            "courses",
            "assignments",
            "warnings",
        ],
    ) || value.get("protocol").and_then(Value::as_u64) != Some(1)
        || value
            .get("account_key")
            .and_then(Value::as_str)
            .is_none_or(|s| s.is_empty() || s.len() > 120)
        || value.get("checked_at").and_then(Value::as_str).is_none()
        || value
            .get("courses")
            .and_then(Value::as_array)
            .is_none_or(|a| a.len() > 300)
        || value
            .get("assignments")
            .and_then(Value::as_array)
            .is_none_or(|a| a.len() > 2000)
    {
        return Err("作业快照格式无效".into());
    }
    if value
        .get("courses")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .any(|course| !only_keys(course, &["id", "name", "code", "term"]))
        || value
            .get("assignments")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .any(|assignment| {
                !only_keys(
                    assignment,
                    &[
                        "id",
                        "course_id",
                        "title",
                        "description",
                        "due_at",
                        "status",
                        "url",
                    ],
                )
            })
    {
        return Err("作业快照包含未声明字段".into());
    }
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source_w: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target_w: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let ok = unsafe {
        MoveFileExW(
            source_w.as_ptr(),
            target_w.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(format!("保存同步结果失败：{}", io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    fs::rename(source, target).map_err(|e| e.to_string())
}

fn write_snapshot(path: &Path, snapshot: &Value) -> Result<(), String> {
    validate_snapshot(snapshot)?;
    let mut merged = snapshot.clone();
    if let Ok(previous_bytes) = fs::read(path) {
        if let Ok(previous) = serde_json::from_slice::<Value>(&previous_bytes) {
            if validate_snapshot(&previous).is_ok()
                && previous["account_key"] == snapshot["account_key"]
            {
                let selected: std::collections::HashSet<&str> = snapshot["courses"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|course| course["id"].as_str())
                    .collect();
                let assignments = merged["assignments"].as_array_mut().unwrap();
                let mut preserved = 0;
                for old in previous["assignments"].as_array().unwrap() {
                    let course_id = old["course_id"].as_str().unwrap_or("");
                    let assignment_id = old["id"].as_str().unwrap_or("");
                    if selected.contains(course_id)
                        && !assignments.iter().any(|item| {
                            item["course_id"] == course_id && item["id"] == assignment_id
                        })
                        && assignments.len() < 2000
                    {
                        assignments.push(old.clone());
                        preserved += 1;
                    }
                }
                if preserved > 0 {
                    let warnings = merged
                        .as_object_mut()
                        .unwrap()
                        .entry("warnings")
                        .or_insert_with(|| json!([]));
                    let list = warnings.as_array_mut().ok_or("扫描警告格式无效")?;
                    if list.len() < 100 {
                        list.push(json!(format!("本次未读到 {preserved} 项上次已确认的作业；已保留待审核，请在 Blackboard 核对。")));
                    }
                }
            }
        }
    }
    validate_snapshot(&merged)?;
    let bytes = serde_json::to_vec(&merged).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_REQUEST {
        return Err("作业快照过大".into());
    }
    let parent = path.parent().ok_or("模块目录不可用")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = parent.join(format!(
        ".inbox-{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    ));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        replace_file(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

fn handle_native(input: Value, path: &Path) -> Result<Value, String> {
    match input.get("op").and_then(Value::as_str).unwrap_or("") {
        "status" => Ok(json!({"ok":true})),
        "publish" => {
            let snapshot = input.get("snapshot").ok_or("缺少作业快照")?;
            write_snapshot(path, snapshot)?;
            Ok(json!({"ok":true}))
        }
        "saveCredentials" => {
            let username = input
                .get("username")
                .and_then(Value::as_str)
                .ok_or("缺少账号")?;
            let password = input
                .get("password")
                .and_then(Value::as_str)
                .ok_or("缺少密码")?;
            if username.trim().is_empty()
                || username.len() > 128
                || username.contains(['\r', '\n'])
                || password.is_empty()
                || password.len() > 1024
            {
                return Err("账号或密码格式无效".into());
            }
            credential()?
                .set_password(&json!({"username":username.trim(),"password":password}).to_string())
                .map_err(|e| format!("保存凭据失败：{e}"))?;
            Ok(json!({"ok":true}))
        }
        "readCredentials" => {
            let value = credential()?
                .get_password()
                .map_err(|_| "没有可用的校园登录凭据")?;
            let credentials: Value =
                serde_json::from_str(&value).map_err(|_| "保存的登录凭据无效")?;
            Ok(
                json!({"ok":true,"configured":true,"username":credentials.get("username"),"password":credentials.get("password")}),
            )
        }
        "deleteCredentials" => {
            let _ = credential()?.delete_credential();
            Ok(json!({"ok":true}))
        }
        _ => Err("未知操作".into()),
    }
}

fn read_frame(reader: &mut impl Read) -> Result<Value, String> {
    let mut length = [0u8; 4];
    reader
        .read_exact(&mut length)
        .map_err(|e| format!("读取消息长度失败：{e}"))?;
    let size = u32::from_le_bytes(length) as usize;
    if size == 0 || size > MAX_REQUEST {
        return Err("原生消息大小无效".into());
    }
    let mut bytes = vec![0u8; size];
    reader
        .read_exact(&mut bytes)
        .map_err(|e| format!("读取原生消息失败：{e}"))?;
    serde_json::from_slice(&bytes).map_err(|_| "原生消息不是有效 JSON".into())
}

fn write_frame(writer: &mut impl Write, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > 1_000_000 {
        return Err("原生响应过大".into());
    }
    writer
        .write_all(&(bytes.len() as u32).to_le_bytes())
        .map_err(|e| e.to_string())?;
    writer.write_all(&bytes).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

fn run_native(origin: &str) -> Result<(), String> {
    require_origin(origin)?;
    let input = read_frame(&mut io::stdin())?;
    let result = handle_native(input, &inbox_path()?)
        .unwrap_or_else(|error| json!({"ok":false,"error":error}));
    write_frame(&mut io::stdout(), &result)
}

fn run_module() -> Result<(), String> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(2_000_001)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 2_000_000 {
        return Err("模块请求过大".into());
    }
    let request: Value = serde_json::from_slice(&bytes).map_err(|_| "模块请求不是有效 JSON")?;
    if request.get("protocol").and_then(Value::as_u64) != Some(1)
        || request.get("capability").and_then(Value::as_str) != Some("assignment.sync.snapshot")
    {
        return Err("模块能力或协议版本无效".into());
    }
    let bytes =
        fs::read(inbox_path()?).map_err(|_| "尚无同步结果；请先在 Chrome 扩展中完成检查")?;
    if bytes.len() > MAX_REQUEST {
        return Err("同步结果过大".into());
    }
    let snapshot: Value = serde_json::from_slice(&bytes).map_err(|_| "同步结果已损坏")?;
    validate_snapshot(&snapshot)?;
    let response = json!({"protocol":1,"ok":true,"result":snapshot});
    io::stdout()
        .write_all(&serde_json::to_vec(&response).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let result = if args
        .first()
        .is_some_and(|a| a.starts_with("chrome-extension://"))
    {
        run_native(&args[0])
    } else {
        run_module()
    };
    if let Err(error) = result {
        if args
            .first()
            .is_some_and(|a| a.starts_with("chrome-extension://"))
        {
            let _ = write_frame(&mut io::stdout(), &json!({"ok":false,"error":error}));
        } else {
            let _ = io::stdout().write_all(
                &serde_json::to_vec(&json!({"protocol":1,"ok":false,"error":error}))
                    .unwrap_or_default(),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_is_atomic_and_rejects_bad_data() {
        let path = env::temp_dir().join(format!("bb-import-{}.json", std::process::id()));
        let good = json!({"protocol":1,"account_key":"abc","checked_at":"2026-09-28T00:00:00Z","courses":[],"assignments":[]});
        write_snapshot(&path, &good).unwrap();
        assert!(write_snapshot(&path, &json!({"protocol":2})).is_err());
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&path).unwrap()).unwrap(),
            good
        );
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn framing_rejects_oversize_and_invalid_json() {
        assert!(read_frame(&mut (MAX_REQUEST as u32 + 1).to_le_bytes().as_slice()).is_err());
        let mut input = Vec::new();
        input.extend_from_slice(&3u32.to_le_bytes());
        input.extend_from_slice(b"bad");
        assert!(read_frame(&mut input.as_slice()).is_err());
    }
    #[test]
    fn origin_is_fixed_and_credentials_cannot_enter_inbox() {
        assert!(require_origin(EXTENSION_ORIGIN).is_ok());
        assert!(require_origin("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/").is_err());
        let path = env::temp_dir().join(format!("bb-import-private-{}.json", std::process::id()));
        let leaked = json!({"protocol":1,"account_key":"abc","checked_at":"2026-09-28T00:00:00Z","courses":[],"assignments":[],"password":"secret"});
        assert!(write_snapshot(&path, &leaked).is_err());
        assert!(!path.exists());
    }
    #[test]
    fn incomplete_scan_keeps_previous_confirmed_items_for_review() {
        let path = env::temp_dir().join(format!("bb-import-backlog-{}.json", std::process::id()));
        let course = json!({"id":"course","name":"Course","code":"CS100","term":"2026 秋"});
        let assignment = json!({"id":"work","course_id":"course","title":"Homework","description":"","due_at":null,"status":"unknown","url":"https://bb.sustech.edu.cn/task"});
        let first = json!({"protocol":1,"account_key":"account","checked_at":"2026-09-28T00:00:00Z","courses":[course],"assignments":[assignment],"warnings":[]});
        write_snapshot(&path, &first).unwrap();
        let second = json!({"protocol":1,"account_key":"account","checked_at":"2026-09-29T00:00:00Z","courses":[course],"assignments":[],"warnings":["作业详情读取失败"]});
        write_snapshot(&path, &second).unwrap();
        let stored: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored["assignments"].as_array().unwrap().len(), 1);
        assert!(stored["warnings"].as_array().unwrap().len() > 1);
        fs::remove_file(path).unwrap();
    }
}
