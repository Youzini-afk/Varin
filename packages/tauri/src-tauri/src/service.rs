//! Private Node/native orchestration. No listener, endpoint or renderer can call
//! these operations. Bounded queues fail closed rather than drop native facts.
use crate::{
    browser::BrowserViews,
    engine::network::NetworkService,
    host::{HostPhase, HostProcess},
};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{Notify, mpsc, watch};

const EVENT_BYTES: usize = 64 * 1024 * 1024;
struct QueuedEvent {
    name: String,
    payload: Value,
    bytes: usize,
    budget: Arc<AtomicUsize>,
}
impl Drop for QueuedEvent {
    fn drop(&mut self) {
        self.budget.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}
fn payload_size(value: &Value) -> usize {
    match value {
        Value::String(s) => s.len().saturating_mul(6).saturating_add(2),
        Value::Array(a) => a.iter().fold(2usize, |size, v| {
            size.saturating_add(payload_size(v)).saturating_add(1)
        }),
        Value::Object(o) => o.iter().fold(2usize, |size, (key, value)| {
            size.saturating_add(key.len().saturating_mul(6))
                .saturating_add(payload_size(value))
                .saturating_add(4)
        }),
        _ => 32,
    }
}
#[derive(Clone)]
pub struct NativeService {
    pub process: HostProcess,
    pub browser: BrowserViews,
    pub network: NetworkService,
    pub companion: crate::companion::CompanionWindows,
    pub computer: crate::computer::ComputerPresentation,
    closing: Arc<AtomicBool>,
    stopped: watch::Sender<bool>,
    cleaned: Arc<tokio::sync::Mutex<bool>>,
}
fn attachment_failure(
    process: &HostProcess,
    admission: &crate::desktop_admission::Permit,
    error: String,
) -> String {
    let ended = process.snapshot().scope_ended;
    let error = if ended { error } else {
        format!("Original desktop service process termination is unconfirmed after attachment failed: {error}")
    };
    admission.failed_resource(ended, error)
}

impl NativeService {
    pub async fn attach(
        app: AppHandle,
        process: HostProcess,
        data_dir: PathBuf,
        admission: &crate::desktop_admission::Permit,
    ) -> Result<Self, String> {
        let mut incoming = match process.take_events().await {
            Ok(incoming) => incoming,
            Err(error) => {
                process.disconnect("Native service attachment could not own its events").await;
                return Err(attachment_failure(&process, admission, error));
            }
        };
        let (send, mut outgoing) = mpsc::channel::<QueuedEvent>(512);
        let event_budget = Arc::new(AtomicUsize::new(0));
        let failed = Arc::new(AtomicBool::new(false));
        let wake = Arc::new(Notify::new());
        let (stopped, _) = watch::channel(false);
        let mut overflow_stopped = stopped.subscribe();
        let overflow_wake = wake.clone();
        let overflow_process = process.clone();
        tauri::async_runtime::spawn(async move {
            tokio::select! {_=overflow_wake.notified()=>overflow_process.disconnect("Native event budget exceeded; earlier outcomes are unknown").await,_=overflow_stopped.changed()=>{}}
        });
        let event = Arc::new(move |name: &str, payload: Value| {
            if failed.load(Ordering::Acquire) {
                return;
            }
            let bytes = payload_size(&payload).saturating_add(name.len());
            if event_budget
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                    used.checked_add(bytes).filter(|next| *next <= EVENT_BYTES)
                })
                .is_err()
            {
                failed.store(true, Ordering::Release);
                wake.notify_one();
                return;
            }
            if send
                .try_send(QueuedEvent {
                    name: name.to_owned(),
                    payload,
                    bytes,
                    budget: event_budget.clone(),
                })
                .is_err()
            {
                failed.store(true, Ordering::Release);
                wake.notify_one();
            }
        });
        let browser_emit = event.clone();
        let browser = BrowserViews::new(
            app.clone(),
            Arc::new(move |payload| browser_emit("browser.native", payload)),
            data_dir.clone(),
        );
        let network_emit = event.clone();
        let network = match NetworkService::new(
            app.clone(),
            data_dir.join("network-spool"),
            Arc::new(move |payload| network_emit("network.native", payload)),
        ) {
            Ok(network) => network,
            Err(error) => {
                process
                    .disconnect("Native service construction failed before ownership transfer")
                    .await;
                let cleanup = process.wait_for_scope_end().await;
                return Err(attachment_failure(&process, admission, cleanup.err().unwrap_or(error)));
            }
        };
        let companion_emit = event.clone();
        let companion = match crate::companion::CompanionWindows::new(
            app.clone(),
            process.clone(),
            data_dir.clone(),
            Arc::new(move |payload| companion_emit("companion.native", payload)),
        ) {
            Ok(companion) => companion,
            Err(error) => {
                process
                    .disconnect("Companion service construction failed before ownership transfer")
                    .await;
                // Process observation failure must not skip the independent
                // native network owner or erase its unconfirmed cleanup.
                let (process_cleanup, network_cleanup) = tokio::join!(
                    process.wait_for_scope_end(), network.shutdown()
                );
                if let Err(error) = &network_cleanup {
                    admission.retain_cleanup_failure(format!(
                        "Original native network cleanup is unconfirmed after attachment failed: {error}"
                    ));
                }
                let failure = process_cleanup.err().or_else(|| network_cleanup.err()).unwrap_or(error);
                return Err(attachment_failure(&process, admission, failure));
            }
        };
        let computer =
            crate::computer::ComputerPresentation::new(app.clone(), process.clone(), data_dir);
        let service = Self {
            process: process.clone(),
            browser,
            network,
            companion,
            computer,
            closing: Arc::default(),
            stopped,
            cleaned: Arc::default(),
        };
        let writer = process.clone();
        let writer_owner = service.clone();
        let mut writer_stopped = service.stopped.subscribe();
        // `outgoing` has one consumer, preserving each native callback's ordering.
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::select! {biased;
                    _=writer_stopped.changed()=>break,
                    message=outgoing.recv()=>match message{Some(mut event)=>if writer.event(&event.name,std::mem::take(&mut event.payload)).await.is_err(){break;},None=>break}
                }
            }
            if !writer_owner.closing.load(Ordering::Acquire)
                && writer.snapshot().phase != HostPhase::Exited
            {
                writer
                    .disconnect("Native event transport ended; earlier outcomes are unknown")
                    .await;
            }
            let _ = writer_owner.cleanup().await;
        });
        let handler = service.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(message) = incoming.recv().await {
                if message.frame()["kind"] == "event" {
                    let frame = message.frame();
                    let name = frame["event"].as_str().unwrap_or("");
                    if handler
                        .computer
                        .event(name, frame["payload"].clone())
                        .is_err()
                    {
                        handler
                            .process
                            .disconnect("Computer presentation lost its authoritative event stream")
                            .await;
                        break;
                    }
                    crate::desktop::service_event(
                        &app,
                        &handler.process,
                        name,
                        frame["payload"].clone(),
                    );
                    continue;
                }
                let service = handler.clone();
                let app = app.clone();
                // HostMessage retains its permit through the response. Independent
                // requests (especially cancel/ACK) cannot wait behind a CDP effect.
                tauri::async_runtime::spawn(async move {
                    let frame = message.frame();
                    if frame["kind"] == "request" {
                        let id = frame["id"].as_str().unwrap_or("");
                        let method = frame["method"].as_str().unwrap_or("");
                        let params = frame["params"].clone();
                        let result = if service.closing.load(Ordering::Acquire) {
                            Err("Native service is shutting down".into())
                        } else if method.starts_with("browser.") {
                            service.browser.request(method, params).await
                        } else if method.starts_with("network.") {
                            service.network.handle(method, params).await
                        } else if method.starts_with("companion.") {
                            service.companion.request(method, params).await
                        } else if matches!(
                            method,
                            "openFilesystemPath"
                                | "platform.openPath"
                                | "platform.showItemInFolder"
                        ) {
                            match params["path"]
                                .as_str()
                                .and_then(|path| std::fs::canonicalize(path).ok())
                            {
                                Some(path) => {
                                    if method == "platform.showItemInFolder" {
                                        app.opener()
                                            .reveal_item_in_dir(path)
                                            .map(|_| Value::Null)
                                            .map_err(|_| {
                                                "Filesystem path could not be revealed".to_owned()
                                            })
                                    } else {
                                        app.opener()
                                            .open_path(path.to_string_lossy(), None::<&str>)
                                            .map(|_| Value::Null)
                                            .map_err(|_| {
                                                "Filesystem path could not be opened".to_owned()
                                            })
                                    }
                                }
                                None => Err("Filesystem path is unavailable".into()),
                            }
                        } else if method == "platform.launchApp" {
                            crate::platform::launch_app(params).await
                        } else if method == "platform.fileIcon" {
                            crate::platform::file_icon(params).await
                        } else if method == "platform.confirmDeepLink" {
                            crate::desktop::confirm_deep_link(&app, params).await
                        } else {
                            Err("Unknown native service operation".into())
                        };
                        let _ = service.process.respond(id, result).await;
                    }
                });
            }
            // EOF alone must wake the native owner, even if no later event write
            // occurs. Closing the original resources settles pending requests.
            let _ = handler.cleanup().await;
        });
        let ended = service.clone();
        let mut observed = process.subscribe();
        tauri::async_runtime::spawn(async move {
            loop {
                if observed.borrow_and_update().phase == HostPhase::Exited {
                    break;
                }
                if observed.changed().await.is_err() {
                    break;
                }
            }
            let _ = ended.cleanup().await;
        });
        Ok(service)
    }
    pub async fn cleanup(&self) -> Result<(), String> {
        self.closing.store(true, Ordering::Release);
        self.stopped.send_replace(true);
        let mut cleaned = self.cleaned.lock().await;
        if *cleaned {
            return Ok(());
        }
        // Start every owner's shutdown before waiting. A blocked browser effect
        // must not prevent network cancellation or transparent surface teardown.
        let (browser, network, companion, computer) = tokio::join!(
            self.browser.shutdown(),
            self.network.shutdown(),
            self.companion.shutdown(),
            self.computer.dispose()
        );
        let errors: Vec<_> = [browser, network, companion, computer]
            .into_iter()
            .filter_map(Result::err)
            .collect();
        if errors.is_empty() {
            *cleaned = true;
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}
