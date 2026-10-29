//! Local document preparation; the WebView's native print dialog owns all printer settings.
use crate::db::AppState;
use rusqlite::Connection;
use std::{fs::File, io::Read, path::PathBuf};
use tauri::{State, WebviewWindow};

const PRINT_WINDOW: &str = "main";
const MAX_BYTES: u64 = 50 * 1024 * 1024;

fn document_path(conn: &Connection, file_id: &str) -> Result<PathBuf, String> {
    let path: String = conn.query_row("SELECT path FROM file_assets WHERE id=?1", [file_id], |row| row.get(0))
        .map_err(|_| "文件记录不存在".to_string())?;
    let path = PathBuf::from(path).canonicalize().map_err(|e| format!("无法读取打印文件：{e}"))?;
    if !path.is_file() { return Err("打印路径不是文件".into()); }
    let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(extension.as_str(), "pdf" | "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp") {
        return Err("系统打印支持 PDF、PNG、JPEG、WebP、GIF 和 BMP；请先将此文档导出为 PDF，或选择兼容的外部打印模块".into());
    }
    Ok(path)
}

fn read_document(path: &std::path::Path) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|e| format!("打开打印文件失败：{e}"))?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_BYTES { return Err("系统打印的单文件上限为 50 MiB，请先拆分文件".into()); }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|e| format!("读取打印文件失败：{e}"))?;
    if bytes.len() as u64 > MAX_BYTES { return Err("文件在读取时超过 50 MiB，请先拆分文件".into()); }
    if bytes.is_empty() { return Err("无法打印空文件".into()); }
    Ok(bytes)
}

#[tauri::command]
pub async fn read_system_print_document(window: WebviewWindow, state: State<'_, AppState>, file_id: String) -> Result<tauri::ipc::Response, String> {
    if window.label() != PRINT_WINDOW { return Err("只能在主窗口读取打印内容".into()); }
    let path = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        document_path(&conn, &file_id)?
    };
    tauri::async_runtime::spawn_blocking(move || read_document(&path))
        .await.map_err(|e| e.to_string())?.map(tauri::ipc::Response::new)
}

#[tauri::command]
pub fn show_system_print_dialog(window: WebviewWindow) -> Result<(), String> {
    if window.label() != PRINT_WINDOW { return Err("只能从主窗口打开系统打印对话框".into()); }
    // Tauri dispatches to WebView2, NSPrintOperation, or WebKitGTK PrintOperation.
    // This result only acknowledges opening the dialog, never completion or queueing.
    window.print().map_err(|e| format!("打开系统打印对话框失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_record_format_missing_file_and_size() {
        let root = std::env::temp_dir().join(format!("homework-print-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE file_assets(id TEXT PRIMARY KEY, path TEXT);").unwrap();
        assert!(document_path(&conn, "unknown").is_err());
        for (id, name) in [("pdf", "作业 ' #.PDF"), ("office", "test.docx"), ("missing", "missing.pdf"), ("directory", "folder.pdf")] {
            let path = root.join(name);
            if id == "directory" { std::fs::create_dir(&path).unwrap(); }
            else if id != "missing" { std::fs::write(&path, b"%PDF-1.7").unwrap(); }
            conn.execute("INSERT INTO file_assets VALUES(?1,?2)", rusqlite::params![id,path.to_str().unwrap()]).unwrap();
        }
        let path = document_path(&conn, "pdf").unwrap();
        assert_eq!(read_document(&path).unwrap(), b"%PDF-1.7");
        for id in ["office", "missing", "directory"] { assert!(document_path(&conn, id).is_err()); }
        File::create(&path).unwrap().set_len(MAX_BYTES + 1).unwrap();
        assert!(read_document(&path).unwrap_err().contains("50 MiB"));
        File::create(&path).unwrap();
        assert!(read_document(&path).unwrap_err().contains("空文件"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
