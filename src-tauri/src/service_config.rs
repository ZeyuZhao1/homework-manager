//! User-owned runtime endpoints, separate from both application bundles and device authorization.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
};

const MAX_CONFIG: u64 = 16 * 1024;

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SyncService {
    #[serde(default)]
    pub server_url: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Services {
    pub version: u32,
    pub sync: SyncService,
}

pub(crate) fn normalize_origin(raw: &str) -> Result<String, String> {
    let u = reqwest::Url::parse(raw.trim()).map_err(|_| "同步服务地址无效")?;
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

fn validate(mut config: Services) -> Result<Services, String> {
    if config.version != 1 {
        return Err("services.json 版本不受支持；请使用 version: 1，现有文件未修改".into());
    }
    config.sync.server_url = if config.sync.server_url.trim().is_empty() {
        String::new()
    } else {
        normalize_origin(&config.sync.server_url)?
    };
    Ok(config)
}

pub(crate) fn load_or_create(path: &Path, legacy_origin: &str) -> Result<Services, String> {
    match fs::File::open(path) {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take(MAX_CONFIG + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "无法读取 services.json")?;
            if bytes.len() as u64 > MAX_CONFIG {
                return Err("services.json 超过 16 KB 限制，文件未修改".into());
            }
            // Never echo malformed input: it may include an accidentally pasted credential.
            let config = serde_json::from_slice(&bytes).map_err(|_| {
                "services.json 格式无效；只允许 version 和 sync.server_url，文件未修改"
            })?;
            validate(config)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let config = validate(Services {
                version: 1,
                sync: SyncService {
                    server_url: legacy_origin.into(),
                },
            })?;
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(path) {
                Ok(mut file) => {
                    let bytes =
                        serde_json::to_vec_pretty(&config).map_err(|_| "无法生成 services.json")?;
                    file.write_all(&bytes)
                        .and_then(|_| file.sync_all())
                        .map_err(|_| "无法创建 services.json")?;
                    Ok(config)
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    Err("services.json 已存在但无法读取，请检查文件或链接后重试；文件未修改".into())
                }
                Err(_) => Err("无法创建 services.json".into()),
            }
        }
        Err(_) => Err("无法读取 services.json；现有服务配置未修改".into()),
    }
}

/// Replace only after a complete write. A failed replacement leaves the previous file intact.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "无法创建配置临时文件")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "无法保存配置文件")?;
        drop(file);
        fs::rename(&temporary, path).map_err(|_| "无法替换配置文件；原文件已保留")
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(str::to_owned)
}

/// Called only by an explicit connection action; ordinary reads/upgrades never rewrite this file.
pub(crate) fn select_origin(path: &Path, origin: &str) -> Result<(), String> {
    let origin = normalize_origin(origin)?;
    if load_or_create(path, "")?.sync.server_url == origin {
        return Ok(());
    }
    let config = Services {
        version: 1,
        sync: SyncService { server_url: origin },
    };
    atomic_write(
        path,
        &serde_json::to_vec_pretty(&config).map_err(|_| "无法保存服务配置")?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Directory(std::path::PathBuf);
    impl Directory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("homework-services-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn config(&self) -> std::path::PathBuf {
            self.0.join("services.json")
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn existing_configuration_survives_new_default_and_repeated_app_starts_byte_for_byte() {
        let directory = Directory::new();
        let path = directory.config();
        let original =
            b"{\n \"version\": 1, \"sync\": {\"server_url\": \"https://user.example.test/\"}\n}";
        fs::write(&path, original).unwrap();
        for legacy in [
            "",
            "https://old.example.test",
            "https://new-default.example.test",
        ] {
            assert_eq!(
                load_or_create(&path, legacy).unwrap().sync.server_url,
                "https://user.example.test"
            );
            assert_eq!(fs::read(&path).unwrap(), original);
        }
        select_origin(&path, "https://user.example.test").unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn first_run_is_empty_and_legacy_migration_only_creates_a_missing_file() {
        let directory = Directory::new();
        let path = directory.config();
        assert!(load_or_create(&path, "")
            .unwrap()
            .sync
            .server_url
            .is_empty());
        fs::remove_file(&path).unwrap();
        assert_eq!(
            load_or_create(&path, "https://legacy.example.test/")
                .unwrap()
                .sync
                .server_url,
            "https://legacy.example.test"
        );
        assert_eq!(
            load_or_create(&path, "https://different.example.test")
                .unwrap()
                .sync
                .server_url,
            "https://legacy.example.test"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn damaged_unknown_future_or_credential_configurations_fail_without_rewriting_or_echoing() {
        let directory = Directory::new();
        let path = directory.config();
        for input in [
            "{sentinel-confidential-bad-json",
            r#"{"version":99,"sync":{"server_url":"https://user.example.test"}}"#,
            r#"{"version":1,"sync":{"server_url":"https://user.example.test","token":"sentinel-confidential-token"}}"#,
            r#"{"version":1,"sync":{"server_url":"https://user:sentinel-confidential-password@user.example.test"}}"#,
            r#"{"version":1,"sync":{"server_url":"http://remote.example.test"}}"#,
        ] {
            fs::write(&path, input).unwrap();
            let error = load_or_create(&path, "https://legacy.example.test")
                .err()
                .unwrap();
            assert!(!error.contains("sentinel-confidential"));
            assert_eq!(fs::read_to_string(&path).unwrap(), input);
        }
        fs::write(&path, vec![b' '; MAX_CONFIG as usize + 1]).unwrap();
        assert!(load_or_create(&path, "").is_err());
    }

    #[test]
    fn explicit_selection_and_external_edits_are_read_without_recompilation() {
        let directory = Directory::new();
        let path = directory.config();
        load_or_create(&path, "").unwrap();
        select_origin(&path, "https://one.example.test").unwrap();
        assert_eq!(
            load_or_create(&path, "").unwrap().sync.server_url,
            "https://one.example.test"
        );
        fs::write(
            &path,
            r#"{"version":1,"sync":{"server_url":"https://two.example.test"}}"#,
        )
        .unwrap();
        assert_eq!(
            load_or_create(&path, "").unwrap().sync.server_url,
            "https://two.example.test"
        );
        assert!(normalize_origin("http://localhost:8787").is_ok());
    }
}
