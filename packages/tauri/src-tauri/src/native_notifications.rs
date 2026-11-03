//! OS notification presentation with Host-scoped deduplication. Native click
//! destinations never come from renderer-supplied runtimeConfig/sourceUrl.
use crate::native_presentation::{self as policy, NotificationClaims};
#[cfg(windows)]
#[path = "native_notifications_windows.rs"]
mod windows;
#[cfg(windows)]
#[path = "native_notifications_windows_policy.rs"]
mod windows_policy;
use serde_json::{Value, json};
#[cfg(target_os = "linux")]
use std::sync::atomic::AtomicI32;
use std::{
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};
use tauri::{AppHandle, Manager};
#[cfg(target_os = "linux")]
use tauri_plugin_notification::NotificationExt;

struct Destination {
    label: String,
    bootstrap: Value,
    action: Value,
}
pub struct NativeNotifications {
    claims: Mutex<NotificationClaims>,
    pending: Mutex<HashMap<String, Destination>>,
    #[cfg(target_os = "linux")]
    sequence: AtomicI32,
    installed: AtomicBool,
    stopped: AtomicBool,
    #[cfg(windows)]
    windows: Mutex<Option<windows::Owner>>,
}
impl NativeNotifications {
    pub fn new() -> Self {
        Self {
            claims: Mutex::new(NotificationClaims::default()),
            pending: Mutex::new(HashMap::new()),
            #[cfg(target_os = "linux")]
            sequence: AtomicI32::new(1),
            installed: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            #[cfg(windows)]
            windows: Mutex::new(None),
        }
    }
    pub fn install(&self, app: &AppHandle) -> Result<(), String> {
        if self.installed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        #[cfg(target_os = "linux")]
        {
            let handle = app.clone();
            if let Err(error) = app.notification().on_action(move |action| {
                if action.action_id() != "tap" {
                    return;
                }
                if let Some(token) = action
                    .notification()
                    .and_then(|n| n.extra().get("varinNativeToken"))
                    .and_then(|value| value.as_str())
                {
                    activate(&handle, token);
                }
            }) {
                self.installed.store(false, Ordering::Release);
                return Err(error.to_string());
            }
        }
        #[cfg(target_os = "macos")]
        {
            // The installed bundle's original app identity owns notifications.
            // Terminal is used only for an unbundled development executable, as
            // in the Tauri plugin, never as a production fallback.
            if notify_rust::set_application(if tauri::is_dev() {
                "com.apple.Terminal"
            } else {
                &app.config().identifier
            })
            .is_err()
            {
                self.installed.store(false, Ordering::Release);
                return Err("The notification application identity could not be registered".into());
            }
        }
        #[cfg(windows)]
        {
            let result = (|| -> Result<(), String> {
                let directory = app
                    .path()
                    .app_local_data_dir()
                    .map_err(|_| "Notification assets directory is unavailable")?;
                std::fs::create_dir_all(&directory)
                    .map_err(|_| "Notification assets directory could not be created")?;
                let icon = directory.join("notification-icon.png");
                let bytes = crate::native_menu::APPLICATION_ICON_PNG;
                if std::fs::read(&icon).ok().as_deref() != Some(bytes) {
                    std::fs::write(&icon, bytes)
                        .map_err(|_| "Notification icon could not be installed")?;
                }
                let activate_app = app.clone();
                let release_app = app.clone();
                let owner = windows::Owner::start(
                    tauri::is_dev(),
                    std::env::current_exe()
                        .map_err(|_| "Notification executable is unavailable")?,
                    icon,
                    move |token| {
                        let handle = activate_app.clone();
                        let token = token.to_owned();
                        let _ = activate_app.run_on_main_thread(move || activate(&handle, &token));
                    },
                    move |token| release(&release_app, token),
                )?;
                let mut current = self
                    .windows
                    .lock()
                    .map_err(|_| "Windows notification owner is unavailable")?;
                if self.stopped.load(Ordering::Acquire) {
                    return Err("Desktop notifications are shutting down".into());
                }
                *current = Some(owner);
                Ok(())
            })();
            if result.is_err() {
                self.installed.store(false, Ordering::Release);
            }
            result?;
        }
        Ok(())
    }
    pub fn show(
        &self,
        app: &AppHandle,
        label: &str,
        bootstrap: &Value,
        raw: &Value,
    ) -> Result<(), String> {
        if self.stopped.load(Ordering::Acquire) {
            return Err("Desktop notifications are shutting down".into());
        }
        if !self.installed.load(Ordering::Acquire) {
            self.install(app)?;
        }
        let payload = policy::notification_payload(raw);
        if policy::notification_requires_hidden(&payload)
            && app.webview_windows().values().any(|window| {
                crate::desktop::is_application_window(app, window.label())
                    && window.is_focused().unwrap_or(false)
            })
        {
            return Ok(());
        }
        let key = policy::notification_claim_key(&payload, bootstrap);
        if !self
            .claims
            .lock()
            .map_err(|_| "Notification claims unavailable")?
            .claim(key.clone(), Instant::now())
        {
            return Ok(());
        }
        let token = uuid::Uuid::new_v4().simple().to_string();
        let action = if let (Some(thread), Some(branch)) = (
            policy::nonempty(&payload["threadId"]),
            policy::nonempty(&payload["branchId"]),
        ) {
            json!({"type":"focus-thread","threadId":thread,"branchId":branch,"directory":policy::nonempty(&payload["directory"]).unwrap_or_default()})
        } else {
            json!({"type":"focus-runtime-window"})
        };
        self.pending
            .lock()
            .map_err(|_| "Notification destinations unavailable")?
            .insert(
                token.clone(),
                Destination {
                    label: label.into(),
                    bootstrap: bootstrap.clone(),
                    action,
                },
            );
        let title = policy::nonempty(&payload["title"])
            .unwrap_or("Varin")
            .to_owned();
        let body = payload["body"].as_str().unwrap_or_default().to_owned();
        let result = self.present(app, &token, &title, &body);
        if result.is_err() {
            release(app, &token);
            if let Ok(mut claims) = self.claims.lock() {
                claims.release(&key);
            }
        }
        result
    }
    #[cfg(target_os = "linux")]
    fn present(&self, app: &AppHandle, token: &str, title: &str, body: &str) -> Result<(), String> {
        let receipt = Receipt {
            app: app.clone(),
            token: token.into(),
        };
        app.notification()
            .builder()
            .id(self.sequence.fetch_add(1, Ordering::Relaxed))
            .title(title)
            .body(body)
            // Only this random correlation token enters plugin metadata. No URL,
            // bearer, directory, or other Host bootstrap is passed to the OS.
            .extra("varinNativeToken", token)
            // Dropping an undelivered callback also drops Receipt, releasing the
            // destination if D-Bus notification creation failed asynchronously.
            .on_close(move || drop(receipt))
            .show()
            .map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    fn present(
        &self,
        _app: &AppHandle,
        token: &str,
        title: &str,
        body: &str,
    ) -> Result<(), String> {
        let owner = self
            .windows
            .lock()
            .map_err(|_| "Windows notification owner is unavailable")?;
        owner
            .as_ref()
            .ok_or("Windows notifications are not initialized")?
            .show(token, title, body)
    }
    #[cfg(target_os = "macos")]
    fn present(&self, app: &AppHandle, token: &str, title: &str, body: &str) -> Result<(), String> {
        let receipt = Receipt {
            app: app.clone(),
            token: token.into(),
        };
        let mut notification = notify_rust::Notification::new();
        notification.summary(title).body(body);
        notification.sound_name("Glass");
        // The plugin exposes no close callback on macOS. Its same
        // native transport is used directly so destination lifetime follows the
        // real click/close/error, with no retention timeout or idle polling.
        std::thread::Builder::new()
            .name("varin-notification".into())
            .spawn(move || {
                if let Ok(handle) = notification.show() {
                    let _ =
                        handle.wait_for_response(|response: &notify_rust::NotificationResponse| {
                            if matches!(response, notify_rust::NotificationResponse::Default) {
                                activate(&receipt.app, &receipt.token);
                            }
                        });
                }
                drop(receipt);
            })
            .map(|_| ())
            .map_err(|_| "Native notification could not start".into())
    }
    pub fn shutdown(&self, app: &AppHandle) {
        self.stopped.store(true, Ordering::Release);
        #[cfg(windows)]
        if let Ok(mut owner) = self.windows.lock() {
            owner.take();
        }
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
        #[cfg(target_os = "linux")]
        let _ = app.notification().remove_all_active();
        #[cfg(not(target_os = "linux"))]
        let _ = app;
    }
}
#[cfg(not(windows))]
struct Receipt {
    app: AppHandle,
    token: String,
}
#[cfg(not(windows))]
impl Drop for Receipt {
    fn drop(&mut self) {
        release(&self.app, &self.token);
    }
}
fn release(app: &AppHandle, token: &str) {
    if let Some(owner) = app.try_state::<NativeNotifications>() {
        if let Ok(mut pending) = owner.pending.lock() {
            pending.remove(token);
        }
    }
}
fn activate(app: &AppHandle, token: &str) {
    let Some(owner) = app.try_state::<NativeNotifications>() else {
        return;
    };
    if owner.stopped.load(Ordering::Acquire) {
        return;
    }
    let target = owner
        .pending
        .lock()
        .ok()
        .and_then(|mut pending| pending.remove(token));
    if let Some(target) = target {
        crate::desktop::native_presentation_action(
            app,
            &target.label,
            target.bootstrap,
            target.action,
        );
    }
}
