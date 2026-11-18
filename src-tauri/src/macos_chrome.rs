use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

#[cfg(target_os = "macos")]
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeState {
    semesters: Vec<Choice>,
    courses: Vec<Choice>,
    semester_id: String,
    course_id: String,
    view: View,
    show_plans: bool,
    show_search: bool,
    search_reset: u32,
    show_add_assignment: bool,
    can_add_assignment: bool,
    assignment_filter: Option<AssignmentFilter>,
    tools: Vec<Choice>,
    theme: Theme,
    blocked: bool,
}

#[cfg(target_os = "macos")]
#[derive(Deserialize, Serialize)]
struct AssignmentFilter {
    selected: String,
    options: Vec<Choice>,
}

#[cfg(target_os = "macos")]
#[derive(Deserialize, Serialize)]
struct Choice {
    id: String,
    name: String,
}

#[cfg(target_os = "macos")]
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum View {
    Overview,
    All,
    Course,
    Plans,
    Files,
    Settings,
}

#[cfg(target_os = "macos")]
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Theme {
    System,
    Light,
    Dark,
}

#[cfg(not(target_os = "macos"))]
type ChromeState = serde_json::Value;

#[cfg(target_os = "macos")]
extern "C" {
    fn homeworkbook_update_macos_chrome(
        window: *mut std::ffi::c_void,
        webview: *mut std::ffi::c_void,
        json: *const std::ffi::c_char,
    ) -> bool;
}

#[tauri::command]
pub async fn update_macos_chrome(
    window: WebviewWindow,
    state: ChromeState,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("只能从主窗口更新 macOS 导航".into());
    }
    #[cfg(target_os = "macos")]
    {
        let json = serde_json::to_vec(&state).map_err(|error| error.to_string())?;
        let json = std::ffi::CString::new(json).map_err(|error| error.to_string())?;
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        window
            .with_webview(move |platform| {
                // with_webview runs on the AppKit thread and owns both handles
                // for the duration of this call. The C function copies its JSON.
                let installed = unsafe {
                    homeworkbook_update_macos_chrome(
                        platform.ns_window(),
                        platform.inner(),
                        json.as_ptr(),
                    )
                };
                let _ = sender.try_send(installed);
            })
            .map_err(|error| error.to_string())?;
        receiver
            .recv()
            .await
            .ok_or_else(|| "无法更新 macOS 导航".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        Ok(false)
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preserves_webview_state_for_appkit() {
        let state = json!({
            "semesters": [{ "id": "s1", "name": "秋季" }, { "id": "s2", "name": "秋季" }],
            "courses": [{ "id": "c1", "name": "课程 “A”" }],
            "semesterId": "s1",
            "courseId": "c1",
            "view": "course",
            "showPlans": false,
            "showSearch": true,
            "searchReset": 7,
            "showAddAssignment": true,
            "canAddAssignment": true,
            "assignmentFilter": { "selected": "open", "options": [{ "id": "open", "name": "未提交" }] },
            "tools": [{ "id": "inbox", "name": "导入待审核 (2)" }],
            "theme": "system",
            "blocked": false,
        });
        let decoded: ChromeState = serde_json::from_value(state.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), state);
    }
}

#[cfg(target_os = "macos")]
extern "C" {
    fn homeworkbook_update_macos_content_controls(
        webview: *mut std::ffi::c_void,
        json: *const std::ffi::c_char,
    ) -> bool;
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentControl {
    id: String,
    kind: ContentKind,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    label: String,
    options: Vec<ContentChoice>,
    selected: String,
    disabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    opaque: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tint: Option<ContentTint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    symbol: Option<ContentSymbol>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ContentKind {
    Button,
    Segments,
    Select,
    Menu,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ContentTint {
    Accent,
    Destructive,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ContentSymbol {
    Plus,
    Pencil,
    Trash,
    #[serde(rename = "chevron.right")]
    ChevronRight,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ContentChoice {
    id: String,
    name: String,
}

impl ContentControl {
    fn valid_geometry(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|value| value.is_finite())
            && self.width > 0.0
            && self.height > 0.0
    }
}

#[tauri::command]
pub async fn update_macos_content_controls(
    window: WebviewWindow,
    controls: Vec<ContentControl>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("只能从主窗口更新 macOS 页面控件".into());
    }
    if controls.iter().any(|control| !control.valid_geometry()) {
        return Err("页面控件位置无效".into());
    }
    #[cfg(target_os = "macos")]
    {
        let json = std::ffi::CString::new(
            serde_json::to_vec(&controls).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        window
            .with_webview(move |platform| {
                let installed = unsafe {
                    homeworkbook_update_macos_content_controls(platform.inner(), json.as_ptr())
                };
                let _ = sender.try_send(installed);
            })
            .map_err(|error| error.to_string())?;
        receiver
            .recv()
            .await
            .ok_or_else(|| "无法更新 macOS 页面控件".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = controls;
        Ok(false)
    }
}

#[cfg(test)]
mod content_contract_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn content_control_contract_rejects_malformed_values() {
        let valid = json!({"id":"content-1", "kind":"select", "x":1.0, "y":2.0, "width":80.0, "height":24.0, "label":"状态", "options":[{"id":"todo", "name":"待做"}], "selected":"todo", "disabled":false});
        let control: ContentControl = serde_json::from_value(valid.clone()).unwrap();
        assert!(control.valid_geometry());
        assert_eq!(serde_json::to_value(control).unwrap(), valid);
        for (field, value) in [
            ("x", json!(null)),
            ("kind", json!("bad")),
            ("options", json!([null])),
            ("tint", json!("purple")),
            ("symbol", json!("invalid")),
        ] {
            let mut invalid = valid.clone();
            invalid[field] = value;
            assert!(serde_json::from_value::<ContentControl>(invalid).is_err());
        }
        let mut tinted = valid.clone();
        tinted["kind"] = json!("button");
        tinted["tint"] = json!("destructive");
        tinted["symbol"] = json!("trash");
        let control = serde_json::from_value::<ContentControl>(tinted.clone()).unwrap();
        assert_eq!(serde_json::to_value(control).unwrap(), tinted);
        let mut zero = valid;
        zero["width"] = json!(0);
        assert!(!serde_json::from_value::<ContentControl>(zero)
            .unwrap()
            .valid_geometry());
    }
}
