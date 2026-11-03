//! Same native Chromium pages for automation and user presentation. This module
//! owns views and CDP transport, not Agent execution or browser business state.
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering},
    },
};
use tauri::{AppHandle, Manager, Webview, WebviewUrl, Window, webview::WebviewBuilder};
use tauri_runtime_cef::{
    AsCefWebviewAttributes, DevToolsProtocol, FrameEventKind, WebviewBuilderCefExt, WebviewCefExt,
    allocate_devtools_message_id,
    cef::{self, *},
};
use tokio::sync::oneshot;

type Reply = Result<Value, String>;
type Pending = Arc<Mutex<HashMap<i32, oneshot::Sender<Reply>>>>;
#[derive(Clone)]
struct NativePage {
    native_id: Arc<AtomicI32>,
    closing: Arc<AtomicBool>,
    view: Webview,
    state: Arc<Mutex<Value>>,
    viewport: Arc<Mutex<Value>>,
    pending: Pending,
    closed: tokio::sync::watch::Sender<bool>,
    presentation: Arc<Mutex<Option<(String, String)>>>,
    presentation_revision: Arc<AtomicU64>,
    presentation_args: Arc<Mutex<Option<Value>>>,
}
/// A close attempt parks pages before their native parent can disappear. A
/// refusal restores only the unchanged original presentation generation.
pub(crate) struct DetachedWindow {
    owner: BrowserViews,
    pages: Vec<(String, NativePage, u64, Value)>,
}
impl DetachedWindow {
    pub(crate) fn restore(self) -> Result<(), String> {
        for (id, original, revision, args) in self.pages {
            let Ok(page) = self.owner.page(&id) else {
                continue;
            };
            if !Arc::ptr_eq(&page.native_id, &original.native_id)
                || page.closing.load(Ordering::Acquire)
            {
                continue;
            }
            let mut presentation = page
                .presentation
                .lock()
                .map_err(|_| "Browser presentation unavailable")?;
            if presentation.is_some()
                || page.presentation_revision.load(Ordering::Acquire) != revision
            {
                continue;
            }
            let label = required(&args, "windowLabel")?;
            if !crate::desktop::is_application_window(&self.owner.app, label) {
                continue;
            }
            let Some(window) = self.owner.app.get_window(label) else {
                continue;
            };
            let visible = args["visible"] == true;
            let target = if visible {
                window
            } else {
                self.owner.parking()?
            };
            let (x, y, width, height) = bounds(&args["bounds"])?;
            page.view.reparent(&target).map_err(|e| e.to_string())?;
            page.view
                .set_position(tauri::LogicalPosition::new(
                    if visible { x } else { 0. },
                    if visible { y } else { 0. },
                ))
                .map_err(|e| e.to_string())?;
            page.view
                .set_size(tauri::LogicalSize::new(width, height))
                .map_err(|e| e.to_string())?;
            page.view.show().map_err(|e| e.to_string())?;
            *presentation = Some((label.into(), required(&args, "viewId")?.into()));
            *page
                .presentation_args
                .lock()
                .map_err(|_| "Browser layout unavailable")? = Some(args);
            page.presentation_revision.fetch_add(1, Ordering::AcqRel);
        }
        Ok(())
    }
}

struct Download {
    page_id: String,
    before: Option<BeforeDownloadCallback>,
    control: Option<DownloadItemCallback>,
    terminal: tokio::sync::watch::Sender<bool>,
    cancelling: bool,
}
impl Download {
    fn new(page_id: String) -> Self {
        Self {
            page_id,
            before: None,
            control: None,
            terminal: tokio::sync::watch::channel(false).0,
            cancelling: false,
        }
    }
}
type SmokeObserver = (uuid::Uuid, Arc<dyn Fn(Value) + Send + Sync>);
/// Scope-bound, bounded observation of the same production owner's callbacks.
/// This never replaces the Node emitter or creates a second Browser owner.
pub(crate) struct SmokeObserverGuard {
    observers: std::sync::Weak<Mutex<Option<SmokeObserver>>>,
    id: uuid::Uuid,
}
impl Drop for SmokeObserverGuard {
    fn drop(&mut self) {
        if let Some(observers) = self.observers.upgrade() {
            if let Ok(mut observer) = observers.lock() {
                if observer.as_ref().is_some_and(|(id, _)| *id == self.id) {
                    observer.take();
                }
            }
        }
    }
}
fn smoke_event_fits(value: &Value, budget: &mut usize) -> bool {
    let charge = match value {
        Value::String(s) => s.len().saturating_add(2),
        Value::Array(_) | Value::Object(_) => 2,
        _ => 32,
    };
    let Some(remaining) = budget.checked_sub(charge) else {
        return false;
    };
    *budget = remaining;
    match value {
        Value::Array(values) => values.iter().all(|v| smoke_event_fits(v, budget)),
        Value::Object(values) => values.iter().all(|(key, v)| {
            let Some(remaining) = budget.checked_sub(key.len().saturating_add(3)) else {
                return false;
            };
            *budget = remaining;
            smoke_event_fits(v, budget)
        }),
        _ => true,
    }
}
#[derive(Clone)]
pub struct BrowserViews {
    app: AppHandle,
    emit: Arc<dyn Fn(Value) + Send + Sync>,
    data_dir: PathBuf,
    pages: Arc<Mutex<HashMap<String, NativePage>>>,
    downloads: Arc<Mutex<HashMap<String, Download>>>,
    captures: Arc<Mutex<HashMap<String, PathBuf>>>,
    closing: Arc<AtomicBool>,
    lifecycle: Arc<tokio::sync::RwLock<()>>,
    shutdown: Arc<tokio::sync::Mutex<()>>,
    smoke_observer: Arc<Mutex<Option<SmokeObserver>>>,
}
impl BrowserViews {
    pub fn new(app: AppHandle, emit: Arc<dyn Fn(Value) + Send + Sync>, data_dir: PathBuf) -> Self {
        Self {
            app,
            emit,
            data_dir,
            pages: Arc::default(),
            downloads: Arc::default(),
            captures: Arc::default(),
            closing: Arc::default(),
            lifecycle: Arc::default(),
            shutdown: Arc::default(),
            smoke_observer: Arc::default(),
        }
    }
    pub(crate) fn smoke_observe(
        &self,
        observer: Arc<dyn Fn(Value) + Send + Sync>,
    ) -> Result<SmokeObserverGuard, String> {
        if !crate::smoke::requested() {
            return Err("Native Browser observation requires the isolated smoke invocation".into());
        }
        let mut slot = self
            .smoke_observer
            .lock()
            .map_err(|_| "Native Browser observer registry unavailable")?;
        if slot.is_some() {
            return Err("The original Browser owner already has a smoke observer".into());
        }
        let id = uuid::Uuid::new_v4();
        *slot = Some((id, observer));
        Ok(SmokeObserverGuard {
            observers: Arc::downgrade(&self.smoke_observer),
            id,
        })
    }
    fn event(&self, payload: Value) {
        let observer = self
            .smoke_observer
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(|(_, observer)| observer.clone()));
        let observation = observer.and_then(|observer| {
            // Frame pixels are tested through the production binary Host route,
            // never duplicated into this callback log. Retain terminal native
            // facts only; unrelated CDP traffic can contain arbitrary page data.
            if !matches!(
                payload["kind"].as_str(),
                Some("download-start" | "download-progress" | "closed" | "crashed")
            ) {
                return None;
            }
            if !payload["pageId"]
                .as_str()
                .is_some_and(|id| id.starts_with("native-smoke-"))
            {
                return None;
            }
            // Only the fixed isolated fixture's bounded metadata can be copied.
            // Large arbitrary pages/frames are not retained by this diagnostic.
            let value = if smoke_event_fits(&payload, &mut (256 * 1024)) {
                payload.clone()
            } else {
                json!({"kind":"smoke-overflow"})
            };
            Some((observer, value))
        });
        // Actual production Node delivery always precedes diagnostic delivery.
        (self.emit)(payload);
        if let Some((observer, payload)) = observation {
            observer(payload)
        }
    }
    pub async fn shutdown(&self) -> Result<(), String> {
        self.closing.store(true, Ordering::Release);
        let _serial = self.shutdown.lock().await;
        // Only creation/registration is leased. CDP effects are settled by real
        // close below, never awaited before closing their original page.
        let _admission = self.lifecycle.write().await;
        let pages: Vec<_> = self
            .pages
            .lock()
            .map_err(|_| "Browser registry unavailable")?
            .iter()
            .map(|(id, p)| (id.clone(), p.clone()))
            .collect();
        let mut closing = tokio::task::JoinSet::new();
        for (id, page) in pages {
            let owner = self.clone();
            closing.spawn(async move { owner.close_page(&id, &page).await });
        }
        let mut errors = Vec::new();
        while let Some(result) = closing.join_next().await {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => errors.push(error),
                Err(_) => errors.push("Browser cleanup task ended without a receipt".into()),
            }
        }
        let captures: Vec<_> = self
            .captures
            .lock()
            .map_err(|_| "Capture registry unavailable")?
            .iter()
            .map(|(id, path)| (id.clone(), path.clone()))
            .collect();
        for (id, path) in captures {
            match std::fs::remove_file(&path) {
                Ok(()) => {
                    self.captures.lock().unwrap().remove(&id);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    self.captures.lock().unwrap().remove(&id);
                }
                Err(_) => errors.push("Browser capture cleanup failed".into()),
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
    async fn close_page(&self, id: &str, page: &NativePage) -> Result<(), String> {
        // Download identities outlive the page. Observe each original download's
        // terminal callback before destroying the browser and its file handles.
        page.closing.store(true, Ordering::Release);
        let downloads: Vec<_> = self
            .downloads
            .lock()
            .map_err(|_| "Download owner unavailable")?
            .iter()
            .filter(|(_, d)| d.page_id == id)
            .map(|(id, _)| id.clone())
            .collect();
        for download in downloads {
            self.cancel_download(&download).await?;
        }
        let mut observed = page.closed.subscribe();
        if !*observed.borrow() {
            native_action(page, |browser| {
                if let Some(host) = browser.host() {
                    host.close_browser(1);
                }
            })
            .await?;
        }
        while !*observed.borrow_and_update() {
            observed
                .changed()
                .await
                .map_err(|_| "Original browser termination could not be observed")?;
        }
        self.pages
            .lock()
            .map_err(|_| "Browser registry unavailable")?
            .remove(id);
        self.downloads
            .lock()
            .map_err(|_| "Download owner unavailable")?
            .retain(|_, download| download.page_id != id);
        Ok(())
    }
    async fn cancel_download(&self, id: &str) -> Result<(), String> {
        let (before, control, mut terminal) = {
            let mut downloads = self
                .downloads
                .lock()
                .map_err(|_| "Download owner unavailable")?;
            let d = downloads
                .get_mut(id)
                .ok_or("Original download no longer exists")?;
            d.cancelling = true;
            (d.before.take(), d.control.clone(), d.terminal.subscribe())
        };
        if !*terminal.borrow() {
            cef_action(move || {
                drop(before);
                if let Some(mut control) = control {
                    control.cancel();
                }
            })
            .await?;
        }
        while !*terminal.borrow_and_update() {
            terminal
                .changed()
                .await
                .map_err(|_| "Original download termination is unknown")?;
        }
        Ok(())
    }
    pub(crate) fn benchmark_sessions(&self) -> Vec<(String, crate::cdp::Session)> {
        self.pages
            .lock()
            .map(|pages| {
                pages
                    .iter()
                    .filter(|(_, page)| {
                        !page.closing.load(Ordering::Acquire) && !*page.closed.borrow()
                    })
                    .map(|(id, page)| {
                        (
                            format!("browser:{id}"),
                            crate::cdp::Session::from_owned(
                                page.view.clone(),
                                page.pending.clone(),
                            ),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
    pub(crate) async fn smoke_presentation(&self, id: &str) -> Reply {
        let page = self.page(id)?;
        let scale = page
            .view
            .window()
            .scale_factor()
            .map_err(|_| "Native window scale unavailable")?;
        let (send, receive) = oneshot::channel();
        page.view.with_cef_webview(move|view|{
            let state=view.snapshot();
            let bounds=state.bounds.map(|bounds|{let rect=bounds.to_logical::<f64,f64>(scale);json!({"x":rect.position.x,"y":rect.position.y,"width":rect.size.width,"height":rect.size.height})});
            let _=send.send(json!({"parentMatches":state.parent_matches,"visible":state.visible,"windowLabel":state.window_label,"browserId":state.browser_id,"bounds":bounds,"scale":scale}));
        }).map_err(|_|"Native presentation observation could not dispatch")?;
        receive
            .await
            .map_err(|_| "Native presentation observation was lost".into())
    }
    pub async fn capture_legacy(&self, id: i32, label: &str) -> Reply {
        let page = self
            .pages
            .lock()
            .map_err(|_| "Browser registry unavailable")?
            .values()
            .find(|page| {
                page.native_id.load(Ordering::Acquire) == id
                    && page.presentation.lock().is_ok_and(|target| {
                        target.as_ref().is_some_and(|(window, _)| window == label)
                    })
            })
            .cloned()
            .ok_or("Native browser page is not presented in this application window")?;
        let result=self.command(&page,"Page.captureScreenshot",json!({"format":"jpeg","quality":82,"fromSurface":true,"captureBeyondViewport":false}),None).await?;
        let viewport = page
            .viewport
            .lock()
            .map_err(|_| "Browser viewport unavailable")?;
        Ok(
            json!({"mime":"image/jpeg","base64":result["data"],"width":viewport["width"],"height":viewport["height"]}),
        )
    }
    pub(crate) fn detach_window(&self, label: &str) -> Result<DetachedWindow, String> {
        let pages: Vec<_> = self
            .pages
            .lock()
            .map_err(|_| "Browser registry unavailable")?
            .iter()
            .map(|(id, page)| (id.clone(), page.clone()))
            .collect();
        let mut detached = DetachedWindow {
            owner: self.clone(),
            pages: Vec::new(),
        };
        let result = (|| -> Result<(), String> {
            for (id, page) in pages {
                let mut presented = page
                    .presentation
                    .lock()
                    .map_err(|_| "Browser presentation unavailable")?;
                if presented
                    .as_ref()
                    .is_some_and(|(window, _)| window == label)
                {
                    let args = page
                        .presentation_args
                        .lock()
                        .map_err(|_| "Browser layout unavailable")?
                        .clone()
                        .ok_or("Original Browser layout is unavailable")?;
                    page.view
                        .reparent(&self.parking()?)
                        .map_err(|e| e.to_string())?;
                    *presented = None;
                    let revision = page.presentation_revision.fetch_add(1, Ordering::AcqRel) + 1;
                    detached.pages.push((id, page.clone(), revision, args));
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            detached.restore()?;
            return Err(error);
        }
        Ok(detached)
    }
    fn refresh_history(&self, id: &str) {
        let Ok(page) = self.page(id) else { return };
        let owner = self.clone();
        let id = id.to_owned();
        let _ = page.view.with_cef_webview(move |view| {
            let browser = view.browser();
            let snapshot = {
                let mut state = page.state.lock().unwrap();
                state["canGoBack"] = json!(browser.can_go_back() != 0);
                state["canGoForward"] = json!(browser.can_go_forward() != 0);
                state.clone()
            };
            owner.event(json!({"pageId":id,"kind":"changed","state":snapshot}));
        });
    }
    fn page(&self, id: &str) -> Result<NativePage, String> {
        self.pages
            .lock()
            .map_err(|_| "Browser registry unavailable")?
            .get(id)
            .cloned()
            .ok_or("The original browser page is closed".into())
    }
    fn parking(&self) -> Result<Window, String> {
        if let Some(window) = self.app.get_window("browser-parking") {
            return Ok(window);
        }
        tauri::window::WindowBuilder::new(&self.app, "browser-parking")
            .title("Varin Browser")
            .visible(false)
            .skip_taskbar(true)
            .inner_size(1280., 800.)
            .build()
            .map_err(|e| e.to_string())
    }
    pub async fn request(&self, method: &str, args: Value) -> Reply {
        if method == "browser.releaseCapture" {
            let id = required(&args, "captureId")?;
            let path = self
                .captures
                .lock()
                .map_err(|_| "Capture registry unavailable")?
                .remove(id);
            if let Some(path) = path {
                std::fs::remove_file(path).map_err(|_| "Captured image could not be released")?;
            }
            return Ok(Value::Null);
        }
        if method.starts_with("browser.download.") {
            return self.download(method, args).await;
        }
        let page_id = required(&args, "pageId")?.to_owned();
        if self.closing.load(Ordering::Acquire)
            && !matches!(method, "browser.close" | "browser.stop" | "browser.detach")
        {
            return Err("Browser owner is shutting down".into());
        }
        if method == "browser.create" {
            return self
                .create(&page_id, required(&args, "requestContext")?)
                .await;
        }
        let page = self.page(&page_id)?;
        match method {
            "browser.command" => {
                self.command(
                    &page,
                    required(&args, "method")?,
                    args["params"].clone(),
                    args["sessionId"].as_str(),
                )
                .await
            }
            "browser.load" => {
                let url = browser_url(required(&args, "url")?)?;
                page.view.navigate(url).map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            "browser.stop" => {
                native_action(&page, |b| {
                    b.stop_load();
                })
                .await?;
                Ok(Value::Null)
            }
            "browser.back" => {
                native_action(&page, |b| {
                    b.go_back();
                })
                .await?;
                Ok(Value::Null)
            }
            "browser.forward" => {
                native_action(&page, |b| {
                    b.go_forward();
                })
                .await?;
                Ok(Value::Null)
            }
            "browser.reload" => {
                page.view.reload().map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            "browser.present" | "browser.layout" => {
                let label = required(&args, "windowLabel")?;
                let view_id = required(&args, "viewId")?;
                let visible = args["visible"]
                    .as_bool()
                    .ok_or("Browser visibility must be boolean")?;
                let requested = self
                    .app
                    .get_window(label)
                    .ok_or("Presentation window is closed")?;
                if !crate::desktop::is_application_window(&self.app, label) {
                    return Err("Browser presentation target is not a trusted workbench".into());
                }
                let mut presentation = page
                    .presentation
                    .lock()
                    .map_err(|_| "Browser presentation unavailable")?;
                if method == "browser.layout"
                    && presentation.as_ref() != Some(&(label.to_owned(), view_id.to_owned()))
                {
                    return Ok(Value::Null);
                }
                let (x, y, width, height) = bounds(&args["bounds"])?;
                let target = if visible { requested } else { self.parking()? };
                page.view.reparent(&target).map_err(|e| e.to_string())?;
                page.view
                    .set_position(tauri::LogicalPosition::new(
                        if visible { x } else { 0. },
                        if visible { y } else { 0. },
                    ))
                    .map_err(|e| e.to_string())?;
                page.view
                    .set_size(tauri::LogicalSize::new(width, height))
                    .map_err(|e| e.to_string())?;
                page.view.show().map_err(|e| e.to_string())?;
                *presentation = Some((label.to_owned(), view_id.to_owned()));
                *page
                    .presentation_args
                    .lock()
                    .map_err(|_| "Browser layout unavailable")? = Some(args.clone());
                page.presentation_revision.fetch_add(1, Ordering::AcqRel);
                *page
                    .viewport
                    .lock()
                    .map_err(|_| "Browser viewport unavailable")? = json!({"width":width,"height":height,"scale":target.scale_factor().unwrap_or(1.)});
                self.event(json!({"pageId":page_id,"kind":"changed","state":page.state.lock().unwrap().clone(),"viewport":page.viewport.lock().unwrap().clone()}));
                Ok(Value::Null)
            }
            "browser.detach" => {
                let label = required(&args, "windowLabel")?;
                let view_id = required(&args, "viewId")?;
                let mut presentation = page
                    .presentation
                    .lock()
                    .map_err(|_| "Browser presentation unavailable")?;
                if presentation.as_ref() == Some(&(label.to_owned(), view_id.to_owned())) {
                    page.view
                        .reparent(&self.parking()?)
                        .map_err(|e| e.to_string())?;
                    page.view
                        .set_position(tauri::LogicalPosition::new(0., 0.))
                        .map_err(|e| e.to_string())?;
                    *presentation = None;
                    *page
                        .presentation_args
                        .lock()
                        .map_err(|_| "Browser layout unavailable")? = None;
                    page.presentation_revision.fetch_add(1, Ordering::AcqRel);
                }
                Ok(Value::Null)
            }
            "browser.capture" => {
                let result = self
                    .command(
                        &page,
                        "Page.captureScreenshot",
                        json!({"format":"png","captureBeyondViewport":false,"fromSurface":true}),
                        None,
                    )
                    .await?;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(required(&result, "data")?)
                    .map_err(|_| "Browser capture is malformed")?;
                if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
                    return Err("Browser capture is not PNG".into());
                }
                let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
                let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
                let _lease = self.lifecycle.read().await;
                if self.closing.load(Ordering::Acquire) {
                    return Err("Browser capture ended during shutdown".into());
                }
                let id = uuid::Uuid::new_v4().to_string();
                let directory = self.data_dir.join("browser-transfers");
                std::fs::create_dir_all(&directory)
                    .map_err(|_| "Browser capture directory unavailable")?;
                let file = directory.join(format!("capture-{id}.png"));
                use std::io::Write;
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut output = options
                    .open(&file)
                    .map_err(|_| "Browser capture could not be stored")?;
                output
                    .write_all(&bytes)
                    .map_err(|_| "Browser capture could not be stored")?;
                output
                    .sync_all()
                    .map_err(|_| "Browser capture could not be committed")?;
                self.captures
                    .lock()
                    .map_err(|_| "Capture registry unavailable")?
                    .insert(id.clone(), file.clone());
                Ok(
                    json!({"captureId":id,"file":file,"size":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes)),"width":width,"height":height}),
                )
            }
            "browser.close" => {
                self.close_page(&page_id, &page).await?;
                Ok(Value::Null)
            }
            _ => Err("Unknown native browser operation".into()),
        }
    }
    async fn create(&self, id: &str, request_context: &str) -> Reply {
        let admission = self.lifecycle.read().await;
        if self.closing.load(Ordering::Acquire) {
            return Err("Browser owner is shutting down".into());
        }
        if !matches!(request_context, "interactive" | "web-render") {
            return Err("Unknown browser request context".into());
        }
        let isolated = request_context == "web-render";
        {
            let pages = self
                .pages
                .lock()
                .map_err(|_| "Browser registry unavailable")?;
            if pages.contains_key(id) {
                return Err("Browser page already exists".into());
            }
            if pages.len() >= 64 {
                return Err("Native browser page capacity reached".into());
            }
        }
        let label = format!("browser-{}", uuid::Uuid::new_v4());
        let state = Arc::new(Mutex::new(
            json!({"title":"","url":"about:blank","loading":false,"canGoBack":false,"canGoForward":false,"destroyed":false}),
        ));
        let viewport = Arc::new(Mutex::new(json!({"width":1280,"height":800,"scale":1})));
        let pending: Pending = Arc::default();
        let (closed, _) = tokio::sync::watch::channel(false);
        let observer = self.clone();
        let observed_id = id.to_owned();
        let observed_state = state.clone();
        let crashed_pending = pending.clone();
        let title_owner = self.clone();
        let title_id = id.to_owned();
        let title_state = state.clone();
        let popup_owner = self.clone();
        let popup_page = id.to_owned();
        let mut builder: WebviewBuilder<tauri::DynRuntime> = WebviewBuilder::new(&label,WebviewUrl::External("about:blank".parse().unwrap()))
            .incognito(isolated)
            .data_directory(self.data_dir.join(if isolated {"cef/web-render"} else {"cef/browser"}))
            .position(tauri::LogicalPosition::new(0.,0.)).size(tauri::LogicalSize::new(1280.,800.))
            .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
            .on_navigation(|url|browser_url(url.as_str()).is_ok())
            .on_new_window(move|url,_|{
                // Match the original BrowserOwner: a popup navigates this same
                // owned page, never creates an untracked renderer/window family.
                if browser_url(url.as_str()).is_ok(){if let Ok(page)=popup_owner.page(&popup_page){let _=page.view.navigate(url);}}
                tauri::webview::NewWindowResponse::Deny
            })
            .on_document_title_changed(move|_,title|{
                let snapshot={let mut state=title_state.lock().unwrap();state["title"]=json!(title);state.clone()};
                title_owner.event(json!({"pageId":title_id,"kind":"changed","state":snapshot}));
            })
            .on_frame_event(move|event|{
                let mut current=observed_state.lock().unwrap();
                match event.kind{
                    FrameEventKind::AddressChanged{url}|FrameEventKind::DocumentCommitted{url} if event.is_main=>current["url"]=json!(url.as_str()),
                    FrameEventKind::LoadingStateChanged{is_loading}=>current["loading"]=json!(is_loading),
                    FrameEventKind::RendererTerminated=>{drop(current);for(_,reply)in crashed_pending.lock().unwrap().drain(){let _=reply.send(Err("Browser renderer terminated; effect outcome is unknown".into()));}observer.event(json!({"pageId":observed_id,"kind":"crashed","reason":"Chromium renderer terminated; no effects were replayed"}));return;}
                    _=>return
                }
                observer.event(json!({"pageId":observed_id,"kind":"changed","state":current.clone()}));
                drop(current);observer.refresh_history(&observed_id);
            });
        builder
            .runtime_specific_attributes_mut()
            .as_cef_webview_attributes_mut()
            .ok_or("CEF browser attributes unavailable")?
            .native_only = true;
        let download_owner = self.clone();
        let download_page = id.to_owned();
        builder
            .runtime_specific_attributes_mut()
            .as_cef_webview_attributes_mut()
            .ok_or("CEF browser attributes unavailable")?
            .native_download_handler = Some(Arc::new(move || {
            BrowserDownloadHandler::new(download_owner.clone(), download_page.clone())
        }));
        let closed_receipt = closed.clone();
        let closed_owner = self.clone();
        let closed_id = id.to_owned();
        let closed_pending = pending.clone();
        let closed_state = state.clone();
        builder
            .runtime_specific_attributes_mut()
            .as_cef_webview_attributes_mut()
            .ok_or("CEF browser attributes unavailable")?
            .native_close_handler = Some(Arc::new(move || {
            closed_state.lock().unwrap()["destroyed"] = json!(true);
            closed_receipt.send_replace(true);
            for (_, reply) in closed_pending.lock().unwrap().drain() {
                let _ = reply.send(Err(
                    "Browser closed before its response; effect outcome is unknown".into(),
                ));
            }
            closed_owner.event(json!({"pageId":closed_id,"kind":"closed"}));
        }));
        let view = self
            .parking()?
            .add_child(builder)
            .map_err(|e| e.to_string())?;
        let page = NativePage {
            native_id: Arc::new(AtomicI32::new(-1)),
            closing: Arc::default(),
            view: view.clone(),
            state,
            viewport,
            pending: pending.clone(),
            closed,
            presentation: Arc::default(),
            presentation_revision: Arc::default(),
            presentation_args: Arc::default(),
        };
        self.pages
            .lock()
            .map_err(|_| "Browser registry unavailable")?
            .insert(id.into(), page.clone());
        let owner = self.clone();
        let page_id = id.to_owned();
        view.on_dev_tools_protocol(move|message|{
            // Raw messages preserve nested target sessionId (cross-origin frames).
            // Results are matched only to IDs allocated by the runtime's allocator.
            if let DevToolsProtocol::Message(bytes)=message{
                if let Ok(message)=serde_json::from_slice::<Value>(&bytes){
                    if let Some(id)=message["id"].as_i64().and_then(|v|i32::try_from(v).ok()){
                        if let Some(reply)=pending.lock().unwrap().remove(&id){
                            let result=if message["error"].is_object(){Err(message["error"]["message"].as_str().unwrap_or("Browser command failed").to_owned())}else{Ok(message["result"].clone())};
                            let _=reply.send(result);
                        }
                    }else if let Some(method)=message["method"].as_str(){
                        if method=="Runtime.bindingCalled" && message["params"]["name"]=="__varin_native_input"{
                            owner.event(json!({"pageId":page_id,"kind":"input"}));
                        }else{
                            let mut event=json!({"pageId":page_id,"kind":"cdp","method":method,"params":message["params"]});
                            if message["sessionId"].is_string(){event["sessionId"]=message["sessionId"].clone();}
                            owner.event(event);
                        }
                    }
                }
            }
        }).map_err(|e|e.to_string())?;
        drop(admission);
        let initialized:Reply=async {
        let (identity,identified)=oneshot::channel();let native_id=page.native_id.clone();
        view.with_cef_webview(move|view|{let id=view.browser().identifier();native_id.store(id,Ordering::Release);let _=identity.send(id);}).map_err(|_|"Native browser identity unavailable")?;
        identified.await.map_err(|_|"Native browser identity could not be observed")?;
        let version=self.command(&page,"Browser.getVersion",json!({}),None).await?;
        self.command(&page,"Runtime.addBinding",json!({"name":"__varin_native_input"}),None).await?;
        self.command(&page,"Page.addScriptToEvaluateOnNewDocument",json!({"source":"for (const name of ['keydown','mousedown','wheel']) addEventListener(name, event => { if (event.isTrusted) globalThis.__varin_native_input?.('input'); }, {capture:true,passive:true});"}),None).await?;
        let state=page.state.lock().unwrap().clone();let viewport=page.viewport.lock().unwrap().clone();
        Ok(json!({"state":state,"viewport":viewport,"version":version,"requestContext":request_context}))
        }.await;
        if initialized.is_err() {
            let _ = self.close_page(id, &page).await;
        }
        initialized
    }
    async fn command(
        &self,
        page: &NativePage,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Reply {
        // Browser/Target lifecycle remains under this native owner. A nested frame
        // session can be controlled, but cannot be used to create arbitrary tabs.
        if matches!(
            method,
            "Target.createTarget"
                | "Browser.close"
                | "Target.closeTarget"
                | "Target.createBrowserContext"
                | "Target.disposeBrowserContext"
        ) {
            return Err("Browser lifecycle is owned by the page authority".into());
        }
        let id = allocate_devtools_message_id().map_err(|e| e.to_string())?;
        let (send, receive) = oneshot::channel();
        page.pending
            .lock()
            .map_err(|_| "Browser transport unavailable")?
            .insert(id, send);
        let mut message =
            json!({"id":id,"method":method,"params":if params.is_null(){json!({})}else{params}});
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        if page
            .view
            .send_dev_tools_message(
                &serde_json::to_vec(&message).map_err(|_| "CDP request malformed")?,
            )
            .is_err()
        {
            page.pending.lock().unwrap().remove(&id);
            return Err("Browser command could not be observed; effect outcome is unknown".into());
        }
        receive
            .await
            .map_err(|_| "Browser response lost; effect outcome is unknown".to_owned())?
    }
    async fn download(&self, method: &str, args: Value) -> Reply {
        let id = required(&args, "downloadId")?.to_owned();
        if method == "browser.download.release" {
            let mut downloads = self
                .downloads
                .lock()
                .map_err(|_| "Download owner unavailable")?;
            if let Some(download) = downloads.get(&id) {
                if !*download.terminal.borrow() {
                    return Err("Original download has not terminated".into());
                }
            }
            downloads.remove(&id);
            return Ok(Value::Null);
        }
        if method == "browser.download.cancel" {
            self.cancel_download(&id).await?;
            return Ok(Value::Null);
        }
        if method != "browser.download.save" {
            return Err("Unknown download operation".into());
        }
        if self.closing.load(Ordering::Acquire) {
            return Err("Browser owner is shutting down".into());
        }
        let raw = PathBuf::from(required(&args, "filePath")?);
        let parent = raw
            .parent()
            .ok_or("Download destination is invalid")?
            .canonicalize()
            .map_err(|_| "Private download directory is unavailable")?;
        let root = self
            .data_dir
            .join("browser-transfers")
            .canonicalize()
            .map_err(|_| "Private browser transfers are unavailable")?;
        if parent.parent() != Some(root.as_path())
            || !parent
                .file_name()
                .is_some_and(|s| s.to_string_lossy().starts_with("download-"))
            || raw.file_name() != Some(std::ffi::OsStr::new("content"))
        {
            return Err("Download destination is outside the original private owner".into());
        }
        let callback = {
            let mut downloads = self
                .downloads
                .lock()
                .map_err(|_| "Download owner unavailable")?;
            let d = downloads
                .get_mut(&id)
                .ok_or("Original download no longer exists")?;
            if d.cancelling || *d.terminal.borrow() {
                return Err("Original download is no longer available".into());
            }
            d.before.take()
        };
        let Some(mut callback) = callback else {
            return Err("Original download was already admitted".into());
        };
        let path = parent.join("content").to_string_lossy().into_owned();
        cef_action(move || {
            callback.cont(Some(&CefStringUtf16::from(path.as_str())), 0);
        })
        .await?;
        Ok(Value::Null)
    }
}
fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("{key} is required"))
}
use crate::security::browser_url;
fn bounds(value: &Value) -> Result<(f64, f64, f64, f64), String> {
    let values: Vec<_> = ["x", "y", "width", "height"]
        .iter()
        .map(|key| value[key].as_f64().filter(|v| v.is_finite()))
        .collect();
    if values.iter().any(Option::is_none) {
        return Err("Browser bounds must be finite".into());
    }
    let v: Vec<_> = values.into_iter().map(Option::unwrap).collect();
    if v[2] <= 0. || v[3] <= 0. {
        return Err("Browser viewport must be positive".into());
    }
    Ok((v[0], v[1], v[2], v[3]))
}
async fn native_action(
    page: &NativePage,
    action: impl FnOnce(cef::Browser) + Send + 'static,
) -> Result<(), String> {
    let (send, receive) = oneshot::channel();
    page.view
        .with_cef_webview(move |view| {
            action(view.browser());
            let _ = send.send(());
        })
        .map_err(|e| e.to_string())?;
    receive
        .await
        .map_err(|_| "Original browser action could not be observed".into())
}
wrap_download_handler! {
    struct BrowserDownloadHandler { owner:BrowserViews,page_id:String, }
    impl DownloadHandler{
        fn can_download(&self,_browser:Option<&mut Browser>,_url:Option<&CefStringUtf16>,_method:Option<&CefStringUtf16>)->std::os::raw::c_int{(!self.owner.closing.load(Ordering::Acquire)&&self.owner.page(&self.page_id).is_ok_and(|page|!page.closing.load(Ordering::Acquire))&&self.owner.downloads.lock().unwrap().len()<1024)as i32}
        fn on_before_download(&self,_browser:Option<&mut Browser>,item:Option<&mut DownloadItem>,name:Option<&CefStringUtf16>,callback:Option<&mut BeforeDownloadCallback>)->std::os::raw::c_int{
            let(Some(item),Some(callback))=(item,callback)else{return 0};
            let id=format!("{}:{}",self.page_id,item.id());
            {let mut downloads=self.owner.downloads.lock().unwrap();
            if self.owner.closing.load(Ordering::Acquire)||!self.owner.page(&self.page_id).is_ok_and(|page|!page.closing.load(Ordering::Acquire))||downloads.len()>=1024{return 1}
            let download=downloads.entry(id.clone()).or_insert_with(||Download::new(self.page_id.clone()));
            if download.cancelling{return 1}download.before=Some(callback.clone());}
            self.owner.event(json!({"pageId":self.page_id,"kind":"download-start","downloadId":id,"name":name.map(ToString::to_string).unwrap_or_else(||"download".into()),
                "url":CefString::from(&item.url()).to_string(),"receivedBytes":item.received_bytes(),"totalBytes":item.total_bytes().max(0),"state":"progressing"}));1
        }
        fn on_download_updated(&self,_browser:Option<&mut Browser>,item:Option<&mut DownloadItem>,callback:Option<&mut DownloadItemCallback>){
            let Some(item)=item else{return};let id=format!("{}:{}",self.page_id,item.id());
            let state=if item.is_complete()!=0{"completed"}else if item.is_canceled()!=0{"cancelled"}else if item.is_in_progress()!=0{"progressing"}else{"interrupted"};
            let should_cancel={let mut downloads=self.owner.downloads.lock().unwrap();
            if !downloads.contains_key(&id) && (self.owner.closing.load(Ordering::Acquire)||!self.owner.page(&self.page_id).is_ok_and(|page|!page.closing.load(Ordering::Acquire))||downloads.len()>=1024){drop(downloads);if let Some(callback)=callback{callback.cancel();}return;}
            let download=downloads.entry(id.clone()).or_insert_with(||Download::new(self.page_id.clone()));
            download.control=callback.as_ref().map(|callback|(**callback).clone());
            if matches!(state,"completed"|"cancelled"){download.before.take();download.control.take();download.terminal.send_replace(true);}
            let cancel=!matches!(state,"completed"|"cancelled")&&(download.cancelling||self.owner.closing.load(Ordering::Acquire));
            if cancel{download.cancelling=true;}cancel};
            // Cancel may synchronously notify observers on CEF's UI thread.
            // Never invoke it while retaining the download registry mutex.
            if should_cancel{if let Some(callback)=callback{callback.cancel();}}
            self.owner.event(json!({"pageId":self.page_id,"kind":"download-progress","downloadId":id,"receivedBytes":item.received_bytes(),"totalBytes":item.total_bytes().max(0),"state":state,"terminal":matches!(state,"completed"|"cancelled")}));
        }
    }
}

wrap_task! {
    struct BrowserAction { action:Arc<Mutex<Option<Box<dyn FnOnce()+Send>>>>, }
    impl Task {fn execute(&self){if let Some(action)=self.action.lock().unwrap().take(){action();}}}
}
async fn cef_action(action: impl FnOnce() + Send + 'static) -> Result<(), String> {
    let (send, receive) = oneshot::channel();
    let action = Arc::new(Mutex::new(Some(Box::new(move || {
        action();
        let _ = send.send(());
    }) as Box<dyn FnOnce() + Send>)));
    if cef::post_task(
        cef::sys::cef_thread_id_t::TID_UI.into(),
        Some(&mut BrowserAction::new(action)),
    ) == 0
    {
        return Err("Chromium control dispatch was not accepted".into());
    }
    receive
        .await
        .map_err(|_| "Chromium control dispatch could not be observed".into())
}
