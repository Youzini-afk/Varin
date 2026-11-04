//! Registered application-window authority. Native labels select the original
//! record; renderer arguments cannot select another window or supply Host secrets.
//! CEF handles are generic only so this same ledger can run without a GUI.
use serde_json::{Value, json};
use std::collections::HashMap;
use tokio::sync::watch;
use url::Url;

pub(crate) struct WindowRecord<C, D> {
    pub mini_thread: Option<(String, String)>,
    pub document_nonce: String,
    pub renderer_ready: bool,
    pub navigation: Vec<Value>,
    pub native_ready: watch::Sender<Option<Result<bool, String>>>,
    pub origin: Url,
    pub bootstrap: Option<Value>,
    pub close: Option<C>,
    pub cdp: Option<D>,
}

pub(crate) fn authorize<'a, C, D>(
    windows: &'a HashMap<String, WindowRecord<C, D>>,
    native_label: &str,
    document_url: &Url,
) -> Result<&'a WindowRecord<C, D>, String> {
    let record = windows
        .get(native_label)
        .ok_or("This webview has no desktop authority")?;
    if !crate::security::same_application_origin(document_url, &record.origin) {
        return Err("Desktop commands are unavailable for this document".into());
    }
    Ok(record)
}

/// Open-in-main retains the caller's Host and draft context. A partial thread
/// identity is an error, never permission to discard it and focus another Host.
pub(crate) fn main_window_action(args: &Value) -> Result<Value, String> {
    let value = |key: &str| args[key].as_str().unwrap_or("").trim();
    let thread = value("threadId");
    let branch = value("branchId");
    if thread.is_empty() != branch.is_empty() {
        return Err("Both thread and branch identities are required".into());
    }
    Ok(if !thread.is_empty() {
        json!({"type":"focus-thread", "threadId":thread, "branchId":branch, "directory":value("directory")})
    } else if args["mode"] == "draft" {
        json!({"type":"new-thread", "directory":value("directory"), "projectId":value("projectId")})
    } else {
        json!({"type":"focus-runtime-window"})
    })
}

pub(crate) fn workbench_target<C, D>(
    windows: &HashMap<String, WindowRecord<C, D>>,
    source: &str,
    bootstrap: &Value,
) -> Option<String> {
    let key = crate::native_presentation::runtime_key(bootstrap);
    windows
        .iter()
        .filter(|(label, record)| {
            (label.as_str() == "main" || label.starts_with("workbench-"))
                && record.close.is_some()
                && record.bootstrap.as_ref().is_some_and(|candidate| {
                    crate::native_presentation::runtime_key(candidate) == key
                })
        })
        .min_by_key(|(label, _)| {
            (
                if label.as_str() == source {
                    0
                } else if label.as_str() == "main" {
                    1
                } else {
                    2
                },
                label.as_str(),
            )
        })
        .map(|(label, _)| label.clone())
}

pub(crate) fn navigation_event(action: &Value) -> Result<&'static str, String> {
    match action["type"].as_str() {
        Some("transfer-draft") => Ok("varin:transfer-draft"),
        Some("focus-thread") => Ok("varin:open-thread"),
        Some("new-thread") => Ok("varin:open-draft-thread"),
        Some("check-for-updates") => Ok("varin:check-for-updates"),
        _ => Err("Unknown workbench navigation action".into()),
    }
}

/// A pending document owns its queued intent until its own readiness receipt.
/// Never silently drop it because startup is slow or a fixed queue fills up.
pub(crate) fn queue_navigation<C, D>(
    windows: &mut HashMap<String, WindowRecord<C, D>>,
    label: &str,
    bootstrap: &Value,
    mut action: Value,
) -> Result<Option<Value>, String> {
    navigation_event(&action)?;
    let record = windows
        .get_mut(label)
        .ok_or("Navigation window is closed")?;
    let target = record
        .bootstrap
        .as_ref()
        .ok_or("Navigation window is not ready")?;
    if crate::native_presentation::runtime_key(target)
        != crate::native_presentation::runtime_key(bootstrap)
    {
        return Err("Navigation window changed its Host".into());
    }
    if action["type"] != "transfer-draft" {
        action["apiBaseUrl"] = bootstrap["apiBaseUrl"].clone();
        action["relayHostId"] = bootstrap["relayHostId"].clone();
    }
    if record.renderer_ready {
        Ok(Some(action))
    } else {
        record.navigation.push(action);
        Ok(None)
    }
}

pub(crate) fn validate_browser_device_args(args: &Value) -> Result<(), String> {
    let action = args["action"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or("action is required")?;
    if !matches!(action, "status" | "connect" | "disconnect") {
        return Err("Unsupported Browser device action".into());
    }
    if action != "status" {
        let host_id = args["expectedHostId"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or("expectedHostId is required")?;
        uuid::Uuid::parse_str(host_id)
            .map_err(|_| "The original Browser Host identity is invalid")?;
    }
    if action == "connect" && args["shareInteractiveProfile"] != true {
        return Err("Sharing the interactive Browser profile requires explicit consent".into());
    }
    Ok(())
}

pub(crate) fn browser_device_request<C, D>(
    windows: &HashMap<String, WindowRecord<C, D>>,
    native_label: &str,
    args: Value,
) -> Result<Value, String> {
    let record = windows
        .get(native_label)
        .ok_or("This webview has no desktop authority")?;
    let bootstrap = record
        .bootstrap
        .as_ref()
        .ok_or("Window bootstrap is not ready")?;
    // The current native record is the sole target source. expectedHostId is a
    // Host UUID challenge, not a connection alias or credential override.
    Ok(json!({
        "command": "desktop_browser_device", "args": args, "windowLabel": native_label,
        "trustedTarget": {
            "apiBaseUrl": bootstrap["apiBaseUrl"],
            "clientToken": bootstrap["clientToken"],
            "requestHeaders": bootstrap["requestHeaders"],
            "relayHostId": bootstrap["relayHostId"],
            "connectionId": bootstrap["bootOutcome"]["hostId"]
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST_ID: &str = "01ed317b-f27c-4eb7-b1a3-efbbcd3b11f4";
    fn record(endpoint: &str, token: &str, alias: &str) -> WindowRecord<(), ()> {
        WindowRecord {
            mini_thread: None,
            document_nonce: uuid::Uuid::new_v4().to_string(),
            renderer_ready: true,
            navigation: Vec::new(),
            native_ready: watch::channel(Some(Ok(false))).0,
            origin: Url::parse("http://tauri.localhost/index.html").unwrap(),
            bootstrap: Some(json!({
                "apiBaseUrl": endpoint, "clientToken": token,
                "requestHeaders": {"X-Window": alias}, "relayHostId": "",
                "bootOutcome": {"hostId": alias}
            })),
            close: None,
            cdp: None,
        }
    }
    fn windows() -> HashMap<String, WindowRecord<(), ()>> {
        HashMap::from([
            (
                "main".into(),
                record("https://main.example", "main-secret", "main-alias"),
            ),
            (
                "mini-1".into(),
                record("https://mini.example", "mini-secret", "mini-alias"),
            ),
        ])
    }
    fn arguments() -> Value {
        json!({"action":"connect","expectedHostId":HOST_ID,"shareInteractiveProfile":true})
    }
    fn app_url() -> Url {
        Url::parse("http://tauri.localhost/mini-chat.html").unwrap()
    }

    #[test]
    fn open_in_main_keeps_draft_context_and_rejects_partial_thread_identity() {
        assert_eq!(
            main_window_action(
                &json!({"mode":"draft","directory":" /work ","projectId":"project"})
            )
            .unwrap(),
            json!({"type":"new-thread","directory":"/work","projectId":"project"})
        );
        assert_eq!(
            main_window_action(&json!({})).unwrap()["type"],
            "focus-runtime-window"
        );
        for args in [
            json!({"threadId":"t"}),
            json!({"branchId":"b"}),
            json!({"threadId":"t","branchId":" "}),
        ] {
            assert!(main_window_action(&args).is_err());
        }
        assert_eq!(
            main_window_action(&json!({"threadId":"t","branchId":"b","directory":"/remote"}))
                .unwrap()["type"],
            "focus-thread"
        );
    }

    #[test]
    fn mini_chat_handoff_never_selects_a_workbench_on_another_host() {
        let mut windows = windows();
        for record in windows.values_mut() {
            record.close = Some(());
        }
        let source = windows["mini-1"].bootstrap.clone().unwrap();
        assert_eq!(workbench_target(&windows, "mini-1", &source), None);
        let mut remote = record("https://mini.example/", "rotated", "remote");
        remote.close = Some(());
        windows.insert("workbench-1".into(), remote);
        assert_eq!(
            workbench_target(&windows, "mini-1", &source).as_deref(),
            Some("workbench-1")
        );
        windows
            .get_mut("workbench-1")
            .unwrap()
            .bootstrap
            .as_mut()
            .unwrap()["relayHostId"] = json!("other-relay");
        assert_eq!(workbench_target(&windows, "mini-1", &source), None);
    }

    #[test]
    fn navigation_retains_drafts_and_update_checks_until_the_target_is_ready() {
        let mut windows = windows();
        let source = windows["main"].bootstrap.clone().unwrap();
        windows.get_mut("main").unwrap().renderer_ready = false;
        let action =
            main_window_action(&json!({"mode":"draft","directory":"/work","projectId":"p"}))
                .unwrap();
        for _ in 0..40 {
            assert_eq!(
                queue_navigation(&mut windows, "main", &source, action.clone()).unwrap(),
                None
            );
        }
        let updates = json!({"type":"check-for-updates"});
        queue_navigation(&mut windows, "main", &source, updates.clone()).unwrap();
        let record = windows.get_mut("main").unwrap();
        assert_eq!(record.navigation.len(), 41);
        assert_eq!(record.navigation[0]["projectId"], "p");
        assert_eq!(record.navigation[0]["directory"], "/work");
        assert!(record.navigation[0]["clientToken"].is_null());
        assert_eq!(
            navigation_event(record.navigation.last().unwrap()).unwrap(),
            "varin:check-for-updates"
        );
        record.renderer_ready = true;
        assert!(
            queue_navigation(&mut windows, "main", &source, updates.clone())
                .unwrap()
                .is_some()
        );
        assert!(queue_navigation(&mut windows, "mini-1", &source, updates.clone()).is_err());
        windows.remove("main");
        assert!(queue_navigation(&mut windows, "main", &source, updates).is_err());
    }

    #[test]
    fn browser_admission_selects_only_the_native_callers_current_window() {
        let mut windows = windows();
        let main = browser_device_request(&windows, "main", arguments()).unwrap();
        let mini = browser_device_request(&windows, "mini-1", arguments()).unwrap();
        assert_eq!(main["windowLabel"], "main");
        assert_eq!(main["trustedTarget"]["apiBaseUrl"], "https://main.example");
        assert_eq!(main["trustedTarget"]["clientToken"], "main-secret");
        assert_eq!(
            main["trustedTarget"]["requestHeaders"]["X-Window"],
            "main-alias"
        );
        assert_eq!(main["trustedTarget"]["connectionId"], "main-alias");
        assert_eq!(mini["windowLabel"], "mini-1");
        assert_eq!(mini["trustedTarget"]["apiBaseUrl"], "https://mini.example");
        assert_eq!(mini["trustedTarget"]["clientToken"], "mini-secret");
        assert_eq!(
            mini["trustedTarget"]["requestHeaders"]["X-Window"],
            "mini-alias"
        );
        assert_eq!(mini["trustedTarget"]["connectionId"], "mini-alias");

        let changed = windows.get_mut("main").unwrap().bootstrap.as_mut().unwrap();
        changed["apiBaseUrl"] = json!("https://new-main.example");
        changed["clientToken"] = json!("new-main-secret");
        let selected = browser_device_request(&windows, "main", arguments()).unwrap();
        assert_eq!(
            selected["trustedTarget"]["apiBaseUrl"],
            "https://new-main.example"
        );
        assert_eq!(selected["trustedTarget"]["clientToken"], "new-main-secret");
        assert_eq!(
            browser_device_request(&windows, "mini-1", arguments()).unwrap(),
            mini
        );
    }

    #[test]
    fn renderer_target_credentials_and_window_labels_cannot_override_the_ledger() {
        let windows = windows();
        for (key, value) in [
            (
                "trustedTarget",
                json!({"apiBaseUrl":"https://attacker.example","clientToken":"stolen"}),
            ),
            ("apiBaseUrl", json!("https://attacker.example")),
            ("clientToken", json!("stolen")),
            ("requestHeaders", json!({"Authorization":"Bearer stolen"})),
            ("relayHostId", json!("attacker-relay")),
            ("connectionId", json!("mini-alias")),
            ("windowLabel", json!("mini-1")),
        ] {
            let mut args = arguments();
            args[key] = value;
            let request = browser_device_request(&windows, "main", args.clone()).unwrap();
            assert_eq!(request["windowLabel"], "main", "{key}");
            assert_eq!(
                request["trustedTarget"]["clientToken"], "main-secret",
                "{key}"
            );
            assert_eq!(
                request["trustedTarget"]["apiBaseUrl"], "https://main.example",
                "{key}"
            );
            assert_eq!(request["args"], args);
        }
        let original = browser_device_request(&windows, "main", arguments()).unwrap();
        assert_eq!(original["trustedTarget"]["clientToken"], "main-secret");
        assert_eq!(
            original["trustedTarget"]["apiBaseUrl"],
            "https://main.example"
        );
    }

    #[test]
    fn missing_foreign_closed_and_unready_windows_never_borrow_another_host() {
        let mut windows = windows();
        assert!(authorize(&windows, "main", &app_url()).is_ok());
        assert!(authorize(&windows, "mini-1", &app_url()).is_ok());
        assert!(authorize(&windows, "browser-page", &app_url()).is_err());
        for url in [
            "https://website.example",
            "https://tauri.localhost",
            "http://tauri.localhost:123",
            "file:///index.html",
        ] {
            assert!(authorize(&windows, "main", &Url::parse(url).unwrap()).is_err());
        }
        windows.get_mut("main").unwrap().bootstrap = None;
        assert!(browser_device_request(&windows, "main", arguments()).is_err());
        windows.remove("main");
        assert!(authorize(&windows, "main", &app_url()).is_err());
        assert!(browser_device_request(&windows, "main", arguments()).is_err());
        assert_eq!(
            browser_device_request(&windows, "mini-1", arguments()).unwrap()["trustedTarget"]["clientToken"],
            "mini-secret"
        );
    }

    #[test]
    fn browser_admission_requires_explicit_consent_and_the_original_host_uuid() {
        for args in [
            json!({"action":"connect","expectedHostId":HOST_ID,"shareInteractiveProfile":false}),
            json!({"action":"connect","expectedHostId":"main-alias","shareInteractiveProfile":true}),
            json!({"action":"connect","expectedHostId":HOST_ID}),
            json!({"action":"invented"}),
        ] {
            assert!(validate_browser_device_args(&args).is_err());
        }
        assert!(validate_browser_device_args(&arguments()).is_ok());
        assert!(validate_browser_device_args(&json!({"action":"status"})).is_ok());
        assert!(
            validate_browser_device_args(&json!({"action":"disconnect","expectedHostId":HOST_ID}))
                .is_ok()
        );
    }
}
