//! Portable references live in SQLite; callers receive paths for this machine.
use rusqlite::{params, Connection};
use std::{fs, io::ErrorKind, path::{Path, PathBuf}};

const PREFIX: &str = "course://";

pub(crate) fn validate_reference(path: &str) -> Result<(), String> {
    let reference = path.strip_prefix(PREFIX).ok_or("课程相对引用无效")?;
    let (id, relative) = reference.split_once('/').ok_or("课程相对引用无效")?;
    if id.is_empty() || id.contains(['\\', ':']) || path.chars().any(char::is_control)
        || relative.split('/').any(|part| part.is_empty() || part == "." || part == ".." || part.contains('\\')) {
        return Err("课程相对引用无效".into());
    }
    Ok(())
}

fn windows_path(path: &str) -> bool {
    path.starts_with(r"\\") || (path.as_bytes().get(1) == Some(&b':') && matches!(path.as_bytes().get(2), Some(b'/' | b'\\')))
}

fn relative_to(root: &str, path: &str) -> Option<String> {
    if root.is_empty() { return None; }
    let windows = windows_path(root);
    let normalize = |value: &str| if windows { value.replace('\\', "/") } else { value.to_owned() };
    let base = normalize(root).trim_end_matches('/').to_owned() + "/";
    let path = normalize(path);
    let matches = if windows { path.get(..base.len()).is_some_and(|prefix| prefix.eq_ignore_ascii_case(&base)) } else { path.starts_with(&base) };
    if !matches { return None; }
    let relative = &path[base.len()..];
    if relative.is_empty() || relative.split('/').any(|s| s == ".." || s == "." || s.is_empty()) { return None; }
    Some(relative.replace('%', "%25").replace('\\', "%5C"))
}

fn roots(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    conn.prepare("SELECT id,folder_path FROM courses WHERE folder_path<>'' ORDER BY length(folder_path) DESC,id").map_err(|e| e.to_string())?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub(crate) fn stored(conn: &Connection, path: &str) -> Result<String, String> {
    if path.starts_with(PREFIX) || path.starts_with("gdrive:") || path.starts_with("cloud://") { return Ok(path.into()); }
    for (id, root) in roots(conn)? {
        // Canonical roots cover symlinked course folders as well as picker paths.
        let canonical = Path::new(&root).is_absolute().then(|| fs::canonicalize(&root).ok()).flatten().map(|p| crate::files::normal_path(&p));
        if let Some(relative) = relative_to(&root, path).or_else(|| canonical.as_deref().and_then(|root| relative_to(root, path))) {
            let reference = format!("{PREFIX}{id}/{relative}");
            validate_reference(&reference)?;
            let root = Path::new(&root);
            if !root.is_absolute() || root_is_offline(root)
                || join_reference(root, &relative).is_ok_and(|file| check_containment(root, &file).is_ok())
            {
                return Ok(reference);
            }
        }
    }
    Ok(path.into())
}

pub(crate) fn resolve(conn: &Connection, path: &str) -> Result<String, String> {
    let Some(reference) = path.strip_prefix(PREFIX) else { return Ok(path.into()); };
    validate_reference(path)?;
    let (id, relative) = reference.split_once('/').ok_or("课程相对路径无效")?;
    let root: String = conn.query_row("SELECT folder_path FROM courses WHERE id=?1", [id], |r| r.get(0)).map_err(|_| "文件所属课程不存在")?;
    if root.is_empty() || !Path::new(&root).is_absolute() { return Err("请设置本机的课程文件夹".into()); }
    let result = join_reference(Path::new(&root), relative)?;
    check_containment(Path::new(&root), &result)?;
    Ok(crate::files::normal_path(&result))
}

fn join_reference(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let mut result = root.to_path_buf();
    for part in relative.split('/') {
        let part = part.replace("%5C", "\\").replace("%25", "%");
        if part.is_empty() || part == "." || part == ".." || part.contains('/')
            || (cfg!(windows) && (part.contains('\\') || part.contains(':') || part.ends_with(['.', ' ']))) {
            return Err("课程相对路径无效或与本机路径规则不兼容".into());
        }
        result.push(part);
    }
    Ok(result)
}

fn check_containment(root: &Path, result: &Path) -> Result<(), String> {
    let base = fs::canonicalize(root).map_err(|_| "课程文件夹不存在或无法访问")?;
    if !base.is_dir() {
        return Err("课程路径不是文件夹".into());
    }
    // Use symlink_metadata so a dangling symlink itself is checked. Treat
    // permission and lookup errors as failures instead of as missing files.
    for ancestor in result.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => {
                let actual = fs::canonicalize(ancestor).map_err(|_| "课程文件的符号链接无效或路径无法访问")?;
                return if actual.starts_with(&base) { Ok(()) } else { Err("路径超出课程文件夹".into()) };
            }
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(_) => return Err("课程文件路径无法访问".into()),
        }
    }
    Err("课程相对路径无效".into())
}

/// Relative user input always uses a course root, never the process directory.
pub(crate) fn input(conn: &Connection, raw: &str, course_id: Option<&str>) -> Result<String, String> {
    if raw.starts_with(PREFIX) { return resolve(conn, raw); }
    if Path::new(raw).is_absolute() || windows_path(raw) { return Ok(raw.into()); }
    let id = course_id.ok_or("相对路径需要指定课程")?;
    let relative = raw.replace('\\', "/");
    let mut relative = relative.as_str();
    while let Some(rest) = relative.strip_prefix("./") { relative = rest; }
    let relative = relative.replace('%', "%25");
    resolve(conn, &format!("{PREFIX}{id}/{relative}"))
}

fn root_is_offline(root: &Path) -> bool {
    fs::symlink_metadata(root).is_err_and(|error| error.kind() == ErrorKind::NotFound)
}

/// Run inside the caller's transaction, before replacing a course's old root.
/// This is lexical so backups from another OS can migrate while files are offline.
pub(crate) fn migrate(conn: &Connection) -> Result<(), String> {
    let paths = conn.prepare("SELECT id,path FROM file_assets WHERE path NOT LIKE 'course://%' AND path NOT LIKE 'gdrive:%' AND path NOT LIKE 'cloud://%'").map_err(|e| e.to_string())?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    for (id, old) in paths {
        let new = stored(conn, &old)?;
        if new == old { continue; }
        // A synced reference and its pre-migration absolute path can already
        // coexist. Preserve both asset IDs and their existing associations.
        let moved = conn.execute(
            "UPDATE file_assets SET path=?2 WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM file_assets WHERE path=?2)",
            params![id,new],
        ).map_err(|e| e.to_string())?;
        if moved == 0 { continue; }
        crate::files::record_file_history(conn, &id, "", "", "relocated", &old, "已保存为课程目录内的相对路径")?;
    }
    // Rename targets must follow the same course when undoing after migration.
    let renames = conn.prepare("SELECT id,old_path,new_path FROM rename_history").map_err(|e| e.to_string())?
        .query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    for (id, old, new) in renames {
        let stored_old = stored(conn, &old)?;
        let stored_new = stored(conn, &new)?;
        if old != stored_old || new != stored_new {
            conn.execute("UPDATE rename_history SET old_path=?2,new_path=?3 WHERE id=?1", params![id,stored_old,stored_new]).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Retain shared assets and undo records when a course is removed/unbound.
pub(crate) fn detach(conn: &Connection, course_id: &str) -> Result<(), String> {
    let root: String = conn.query_row("SELECT folder_path FROM courses WHERE id=?1", [course_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    let prefix = format!("{PREFIX}{course_id}/");
    let root = Path::new(&root);
    let offline = root_is_offline(root);
    let expand = |path: &str| -> Option<String> {
        let relative = path.strip_prefix(&prefix)?;
        if !root.is_absolute() || validate_reference(path).is_err() { return None; }
        let expanded = join_reference(root, relative).ok()?;
        if !offline && check_containment(root, &expanded).is_err() { return None; }
        Some(crate::files::normal_path(&expanded))
    };
    let files = conn.prepare("SELECT id,path FROM file_assets").map_err(|e| e.to_string())?
        .query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    for (id, path) in files {
        if !path.starts_with(&prefix) { continue; }
        let path = expand(&path).unwrap_or_else(|| format!("cloud://{id}"));
        let moved = conn.execute(
            "UPDATE file_assets SET path=?2 WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM file_assets WHERE path=?2 AND id<>?1)",
            params![id,path],
        ).map_err(|e| e.to_string())?;
        if moved == 0 { continue; }
        crate::files::record_file_history(conn, &id, "", "", "relocated", &path, "取消课程目录绑定，保留文件当前位置")?;
    }
    let renames = conn.prepare("SELECT id,old_path,new_path FROM rename_history").map_err(|e| e.to_string())?
        .query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    for (id, old, new) in renames {
        conn.execute("UPDATE rename_history SET old_path=?2,new_path=?3 WHERE id=?1", params![id,expand(&old).unwrap_or(old),expand(&new).unwrap_or(new)]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE courses(id TEXT PRIMARY KEY,folder_path TEXT);
            CREATE TABLE file_assets(id TEXT PRIMARY KEY,path TEXT UNIQUE);
            CREATE TABLE rename_history(id TEXT PRIMARY KEY,file_id TEXT,old_path TEXT,new_path TEXT);
            CREATE TABLE file_history(id TEXT,file_id TEXT,link_id TEXT,assignment_id TEXT,assignment_title TEXT,event_type TEXT,path TEXT,details TEXT,file_size INTEGER,modified_at_ms INTEGER,occurred_at TEXT);").unwrap();
        conn
    }

    #[test]
    fn lexical_paths_are_portable_and_respect_boundaries_and_case() {
        assert_eq!(relative_to(r"D:\课程", r"d:\课程\第一章\题目.pdf").as_deref(), Some("第一章/题目.pdf"));
        assert_eq!(relative_to(r"\\server\share\Course", "//server/share/course/book.pdf").as_deref(), Some("book.pdf"));
        assert_eq!(relative_to("/课程/", "/课程/题目.pdf").as_deref(), Some("题目.pdf"));
        assert_eq!(relative_to("/", "/课程/题目.pdf").as_deref(), Some("课程/题目.pdf"));
        assert_eq!(relative_to("/Course", "/course/a.pdf"), None);
        assert_eq!(relative_to("/Course", "/Course-other/a.pdf"), None);
        assert_eq!(relative_to("/Course", "/Course/../a.pdf"), None);
        assert_eq!(relative_to("/Course", "/Course/100%/a\\b.pdf").as_deref(), Some("100%25/a%5Cb.pdf"));
    }

    #[test]
    fn offline_windows_backup_rebases_without_changing_asset_ids_or_audit_history() {
        let conn = database();
        conn.execute("INSERT INTO courses VALUES('c',?1)", [r"D:\Study\课程"]).unwrap();
        conn.execute("INSERT INTO file_assets VALUES('f',?1)", [r"d:\study\课程\第一章\new.pdf"]).unwrap();
        conn.execute("INSERT INTO rename_history VALUES('r','f',?1,?2)", params![r"D:\Study\课程\第一章\old.pdf",r"D:\Study\课程\第一章\new.pdf"]).unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let stored: String = conn.query_row("SELECT path FROM file_assets WHERE id='f'", [], |r| r.get(0)).unwrap();
        assert_eq!(stored, "course://c/第一章/new.pdf");
        assert_eq!(conn.query_row("SELECT count(*) FROM file_history", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
        let root = std::env::temp_dir().join(format!("course-portable-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("第一章")).unwrap();
        fs::write(root.join("第一章/new.pdf"), b"test").unwrap();
        conn.execute("UPDATE courses SET folder_path=?1 WHERE id='c'", [root.to_str().unwrap()]).unwrap();
        assert!(Path::new(&resolve(&conn, &stored).unwrap()).is_file());
        assert_eq!(input(&conn, r"第一章\new.pdf", Some("c")).unwrap(), resolve(&conn, &stored).unwrap());
        assert_eq!(input(&conn, "./第一章/new.pdf", Some("c")).unwrap(), resolve(&conn, &stored).unwrap());
        assert!(input(&conn, "../outside.pdf", Some("c")).is_err());
        assert!(input(&conn, r"第一章\..\..\outside.pdf", Some("c")).is_err());
        assert!(input(&conn, "new.pdf", None).is_err());
        assert_eq!(conn.query_row("SELECT path FROM file_history", [], |r| r.get::<_,String>(0)).unwrap(), r"d:\study\课程\第一章\new.pdf");
        detach(&conn, "c").unwrap();
        assert_eq!(conn.query_row("SELECT path FROM file_assets", [], |r| r.get::<_,String>(0)).unwrap(), crate::files::normal_path(&root.join("第一章/new.pdf")));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn detach_never_promotes_an_escaping_or_dangling_symlink() {
        let conn = database();
        let temp = std::env::temp_dir().join(format!("course-detach-{}", Uuid::new_v4()));
        let root = temp.join("course");
        let outside = temp.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("example.pdf"), b"test").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
        std::os::unix::fs::symlink(outside.join("missing"), root.join("dangling")).unwrap();
        conn.execute("INSERT INTO courses VALUES('c',?1)", [root.to_str().unwrap()]).unwrap();
        conn.execute("INSERT INTO file_assets VALUES('a','course://c/escape/example.pdf'),('b','course://c/dangling/example.pdf')", []).unwrap();
        assert!(resolve(&conn, "course://c/escape/example.pdf").is_err());
        assert!(resolve(&conn, "course://c/dangling/example.pdf").is_err());
        assert_eq!(stored(&conn, root.join("escape/example.pdf").to_str().unwrap()).unwrap(), root.join("escape/example.pdf").to_str().unwrap());
        detach(&conn, "c").unwrap();
        for id in ["a", "b"] {
            let path: String = conn.query_row("SELECT path FROM file_assets WHERE id=?1", [id], |r| r.get(0)).unwrap();
            assert_eq!(path, format!("cloud://{id}"));
        }
        assert!(outside.join("example.pdf").is_file());
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn migration_keeps_existing_asset_ids_when_paths_collide() {
        let conn = database();
        let root = std::env::temp_dir().join(format!("course-duplicate-{}", Uuid::new_v4()));
        let absolute = root.join("sheet.pdf");
        conn.execute("INSERT INTO courses VALUES('c',?1)", [root.to_str().unwrap()]).unwrap();
        conn.execute("INSERT INTO file_assets VALUES('older',?1),('synced','course://c/sheet.pdf')", [absolute.to_str().unwrap()]).unwrap();
        migrate(&conn).unwrap();
        detach(&conn, "c").unwrap();
        assert_eq!(conn.query_row("SELECT count(*) FROM file_assets", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
        assert_eq!(conn.query_row("SELECT path FROM file_assets WHERE id='synced'", [], |r| r.get::<_, String>(0)).unwrap(), "course://c/sheet.pdf");
    }

    #[test]
    fn nested_roots_percent_names_and_missing_files_keep_their_meaning() {
        let conn = database();
        let root = std::env::temp_dir().join(format!("course-nested-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("nested")).unwrap();
        conn.execute("INSERT INTO courses VALUES('parent',?1)", [root.to_str().unwrap()]).unwrap();
        conn.execute("INSERT INTO courses VALUES('child',?1)", [root.join("nested").to_str().unwrap()]).unwrap();
        let file = root.join("nested/100%25.pdf");
        fs::write(&file, b"test").unwrap();
        let reference = stored(&conn, &crate::files::normal_path(&file)).unwrap();
        assert_eq!(reference, "course://child/100%2525.pdf");
        assert_eq!(input(&conn, "100%25.pdf", Some("child")).unwrap(), resolve(&conn, &reference).unwrap());
        fs::remove_file(&file).unwrap();
        assert_eq!(resolve(&conn, &reference).unwrap(), crate::files::normal_path(&file));
        #[cfg(unix)] {
            let literal = root.join(r"a\b.pdf");
            fs::write(&literal, b"test").unwrap();
            let reference = stored(&conn, literal.to_str().unwrap()).unwrap();
            assert_eq!(resolve(&conn, &reference).unwrap(), literal.to_str().unwrap());
            std::os::unix::fs::symlink(std::env::temp_dir(), root.join("escape")).unwrap();
            assert!(resolve(&conn, "course://parent/escape/missing.pdf").is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }
}
