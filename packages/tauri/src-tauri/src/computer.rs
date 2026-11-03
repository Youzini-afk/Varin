//! Native Computer Use presentation, not an input/execution owner.
//! Fixed control links call the original Host with its private holder identity.
//! Only Windows has the original capture-safe desktop overlays; other platforms
//! retain the shared viewer presentation, never pretend these overlays are safe.
use crate::{engine::offscreen, host::HostProcess, native_menu::text};
use base64::Engine as _;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_runtime_cef::{
    AsCefWebviewAttributes, DevToolsProtocol, FrameEventKind, WebviewCefExt,
    WebviewWindowBuilderCefExt, allocate_devtools_message_id,
};
use tokio::sync::{mpsc, oneshot, watch};

const FEEDBACK_HTML: &str = include_str!(concat!(env!("OUT_DIR"), "/computer-feedback.html"));
const CONTROLS_HTML: &str = include_str!(concat!(env!("OUT_DIR"), "/computer-controls.html"));
type Reply = Result<Value, String>;
type Pending = Arc<Mutex<HashMap<i32, oneshot::Sender<Reply>>>>;

enum Message {
    Event(String, Value),
    Locale(String),
    Refresh,
    Command(String),
    CommandDone(u64, Result<(), String>),
    Dispose(oneshot::Sender<Result<(), String>>),
}
#[derive(Clone)]
pub struct ComputerPresentation {
    app: AppHandle,
    send: mpsc::Sender<Message>,
    failure: Arc<Mutex<Option<String>>>,
    disposed: Arc<AtomicBool>,
    close_result: Arc<tokio::sync::Mutex<Option<Result<(), String>>>>,
}
impl ComputerPresentation {
    pub fn new(app: AppHandle, process: HostProcess, data_dir: PathBuf) -> Self {
        let (send, receive) = mpsc::channel(128);
        let owner = Self {
            app: app.clone(),
            send: send.clone(),
            failure: Arc::default(),
            disposed: Arc::default(),
            close_result: Arc::default(),
        };
        let mut state = Presentation {
            app,
            process,
            data_dir,
            send,
            holder: None,
            control: Value::Null,
            locale: "en".into(),
            busy: false,
            command_sequence: 0,
            error: String::new(),
            controls: None,
            feedback: HashMap::new(),
            generation: Arc::new(AtomicU64::new(0)),
            protected: HashMap::new(),
            failure: owner.failure.clone(),
        };
        let disposed = owner.disposed.clone();
        tauri::async_runtime::spawn(async move {
            state.run(receive).await;
            disposed.store(true, Ordering::Release);
        });
        owner
    }
    /// Call in the order received on the private Host pipe. No renderer gets
    /// computerControlsReady or its holder identity.
    pub fn event(&self, name: &str, payload: Value) -> Result<(), String> {
        if !matches!(
            name,
            "computerControlsReady" | "computerControl" | "computerGesture"
        ) {
            return Ok(());
        }
        if self.disposed.load(Ordering::Acquire) {
            return Err("Computer presentation is closed".into());
        }
        self.send
            .try_send(Message::Event(name.into(), payload))
            .map_err(|_| {
                "Computer presentation event budget exceeded; state must be resynchronized".into()
            })
    }
    pub fn set_locale(&self, locale: &str) -> Result<(), String> {
        self.send
            .try_send(Message::Locale(locale.into()))
            .map_err(|_| "Computer presentation is not accepting locale updates".into())
    }
    /// Refresh capture protection after adding any application window.
    pub fn refresh_windows(&self) -> Result<(), String> {
        self.send
            .try_send(Message::Refresh)
            .map_err(|_| "Computer presentation window refresh could not be queued".into())
    }
    pub fn last_error(&self) -> Option<String> {
        self.failure.lock().unwrap().clone()
    }
    pub fn handles(&self) -> Result<Vec<u64>, String> {
        window_handles(&self.app)
    }
    pub async fn dispose(&self) -> Result<(), String> {
        let mut completed = self.close_result.lock().await;
        if let Some(result) = completed.as_ref() {
            return result.clone();
        }
        self.disposed.store(true, Ordering::Release);
        let (send, receive) = oneshot::channel();
        let result = if self.send.send(Message::Dispose(send)).await.is_err() {
            Err("Computer overlay termination is unknown".into())
        } else {
            receive
                .await
                .unwrap_or_else(|_| Err("Computer overlay termination is unknown".into()))
        };
        *completed = Some(result.clone());
        result
    }
}

#[derive(Clone)]
struct Surface {
    window: WebviewWindow,
    // 0 loading, 1 ready, 2 renderer failed, 3 actual CEF browser closed.
    readiness: watch::Sender<u8>,
    pending: Pending,
    tail: Arc<tokio::sync::Mutex<()>>,
    sequence: Arc<AtomicU64>,
}
impl Surface {
    async fn evaluate(&self, script: String) -> Reply {
        let mut readiness = self.readiness.subscribe();
        loop {
            match *readiness.borrow_and_update() {
                1 => break,
                2 | 3 => return Err("Computer presentation renderer is unavailable".into()),
                _ => {}
            }
            readiness
                .changed()
                .await
                .map_err(|_| "Computer presentation readiness is unknown")?;
        }
        let id = allocate_devtools_message_id().map_err(|e| e.to_string())?;
        let (send, receive) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, send);
        let message = json!({"id":id,"method":"Runtime.evaluate","params":{
            "expression":script,"awaitPromise":true,"returnByValue":true}})
        .to_string();
        if let Err(error) = self.window.send_dev_tools_message(message.as_bytes()) {
            self.pending.lock().unwrap().remove(&id);
            return Err(error.to_string());
        }
        receive
            .await
            .map_err(|_| "Computer presentation receipt was lost")?
    }
    async fn close(self) -> Result<(), String> {
        if *self.readiness.borrow() == 3 {
            return Ok(());
        }
        let mut observed = self.readiness.subscribe();
        self.window.close().map_err(|e| e.to_string())?;
        while *observed.borrow_and_update() != 3 {
            observed
                .changed()
                .await
                .map_err(|_| "Original computer overlay has not confirmed close")?;
        }
        Ok(())
    }
}
struct Presentation {
    app: AppHandle,
    process: HostProcess,
    data_dir: PathBuf,
    send: mpsc::Sender<Message>,
    holder: Option<String>,
    control: Value,
    locale: String,
    busy: bool,
    command_sequence: u64,
    error: String,
    controls: Option<Surface>,
    feedback: HashMap<String, Surface>,
    generation: Arc<AtomicU64>,
    protected: HashMap<String, (usize, u32)>,
    failure: Arc<Mutex<Option<String>>>,
}
impl Presentation {
    async fn run(&mut self, mut receive: mpsc::Receiver<Message>) {
        while let Some(message) = receive.recv().await {
            let result = match message {
                Message::Dispose(reply) => {
                    let result = self.dispose().await;
                    let _ = reply.send(result);
                    break;
                }
                Message::Locale(locale) => {
                    self.locale = locale;
                    self.refresh_locale();
                    self.render_controls().await
                }
                Message::Refresh => self.protect(self.visible()),
                Message::Command(action) => self.command(&action).await,
                Message::CommandDone(sequence, result) => {
                    if sequence != self.command_sequence {
                        continue;
                    }
                    self.busy = false;
                    self.error = result.err().unwrap_or_default();
                    self.render_controls().await
                }
                Message::Event(name, value) => match name.as_str() {
                    "computerControlsReady" => {
                        self.holder = value["holderId"]
                            .as_str()
                            .filter(|id| !id.is_empty())
                            .map(str::to_owned);
                        self.render_controls().await
                    }
                    "computerControl" => {
                        if value["desktopId"] != "local-console" {
                            continue;
                        }
                        self.control = value;
                        self.render_controls().await
                    }
                    "computerGesture" => {
                        if value["desktopId"] != "local-console" {
                            continue;
                        }
                        self.show_feedback(value).await
                    }
                    _ => Ok(()),
                },
            };
            if let Err(error) = result {
                eprintln!("[Computer presentation] {error}");
                *self.failure.lock().unwrap() = Some(error);
            }
        }
    }
    fn visible(&self) -> bool {
        self.control["operator"].is_object()
            || self.control["owner"] == "human"
            || self.control["transitioning"] == true
            || self.busy
    }
    async fn command(&mut self, action: &str) -> Result<(), String> {
        if !matches!(action, "takeover" | "handback" | "cancel") || self.busy {
            return Ok(());
        }
        let Some(holder) = self.holder.clone() else {
            return Err("Original computer control holder is unavailable".into());
        };
        if !self.visible() {
            return Err("Computer control is no longer active".into());
        }
        if action == "handback"
            && (self.control["owner"] != "human" || self.control["holderId"] != holder)
        {
            return Err("This control bar does not own the human input lease".into());
        }
        self.busy = true;
        self.error.clear();
        self.command_sequence += 1;
        let sequence = self.command_sequence;
        let process = self.process.clone();
        let send = self.send.clone();
        let action = action.to_owned();
        // Rendering busy is observation only. The Host owns transitions, input
        // release and cancellation; do not optimistically change owner/status.
        let presentation = self.render_controls().await;
        tauri::async_runtime::spawn(async move {
            let result = process
                .request(
                    "computerControl",
                    json!({"holderId":holder,"action":action}),
                )
                .await
                .map(|_| ());
            let _ = send.send(Message::CommandDone(sequence, result)).await;
        });
        presentation
    }
    async fn render_controls(&mut self) -> Result<(), String> {
        if !cfg!(windows) {
            return Ok(());
        }
        let visible = self.visible();
        self.protect(visible)?;
        if !visible {
            if let Some(surface) = &self.controls {
                surface.window.hide().map_err(|e| e.to_string())?;
            }
            self.error.clear();
            return Ok(());
        }
        if self.controls.is_none() {
            self.controls = Some(self.surface("computer-controls", CONTROLS_HTML, true)?);
            let surface = self.controls.as_ref().unwrap();
            let monitor = self
                .app
                .primary_monitor()
                .map_err(|e| e.to_string())?
                .ok_or("Primary display is unavailable")?;
            self.position_controls(surface, &monitor, true)?;
        }
        let surface = self.controls.as_ref().unwrap().clone();
        let human = self.control["owner"] == "human";
        let own = human
            && self
                .holder
                .as_ref()
                .is_some_and(|holder| self.control["holderId"] == *holder);
        let key = if self.control["workStatus"] == "cancelling" {
            "Cancelling…"
        } else if self.control["workStatus"] == "cancel-unconfirmed" {
            "Input release is unconfirmed"
        } else if self.control["transitioning"] == true || self.busy {
            "Transferring control…"
        } else if human {
            "You are using this computer"
        } else {
            "Varin is using this computer"
        };
        let mut status = text(&self.locale, key);
        if self.control["activity"]["status"] == "running" {
            if let Some(app) = self.control["activity"]["app"].as_str() {
                status.push_str(" · ");
                status.push_str(app);
            }
        }
        let payload = json!({"locale":self.locale,"text":status,"handoff":text(&self.locale,if own {"Hand back to Varin"} else {"Take over"}),
            "command":if own {"handback"} else {"takeover"},"cancel":text(&self.locale,"Cancel computer work"),
            "cancelVisible":self.control["operator"].is_object(),"busy":self.busy||self.control["transitioning"]==true||self.control["workStatus"]=="cancelling","error":self.error});
        let scale = surface.window.scale_factor().map_err(|e| e.to_string())?;
        let size = surface.window.inner_size().map_err(|e| e.to_string())?;
        surface
            .window
            .set_size(PhysicalSize::new(
                size.width,
                ((if self.error.is_empty() { 68. } else { 91. }) * scale).round() as u32,
            ))
            .map_err(|e| e.to_string())?;
        surface
            .evaluate(format!("window.setComputerControl({payload});true"))
            .await?;
        // The surface is permanently non-focusable (WS_EX_NOACTIVATE on Windows).
        surface.window.show().map_err(|e| e.to_string())?;
        Ok(())
    }
    fn position_controls(
        &self,
        surface: &Surface,
        monitor: &tauri::Monitor,
        center: bool,
    ) -> Result<(), String> {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let width = (560. * scale)
            .min(f64::from(area.size.width) - 24. * scale)
            .max(1.)
            .round() as u32;
        let height = ((if self.error.is_empty() { 68. } else { 91. }) * scale).round() as u32;
        surface
            .window
            .set_size(PhysicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        if center {
            surface
                .window
                .set_position(PhysicalPosition::new(
                    area.position.x + ((area.size.width - width) / 2) as i32,
                    area.position.y + area.size.height as i32
                        - height as i32
                        - (12. * scale).round() as i32,
                ))
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    fn avoid(&self, gesture: &Value, monitors: &[tauri::Monitor]) -> Result<(), String> {
        if gesture["phase"] != "target" {
            return Ok(());
        }
        let Some(surface) = &self.controls else {
            return Ok(());
        };
        if !surface.window.is_visible().map_err(|e| e.to_string())? {
            return Ok(());
        }
        let Some((x, y)) = point(&gesture["point"]) else {
            return Ok(());
        };
        let pos = surface.window.outer_position().map_err(|e| e.to_string())?;
        let size = surface.window.outer_size().map_err(|e| e.to_string())?;
        if !contains(
            f64::from(pos.x),
            f64::from(pos.y),
            f64::from(size.width),
            f64::from(size.height),
            x,
            y,
        ) {
            return Ok(());
        }
        let monitor = monitors
            .iter()
            .find(|m| monitor_contains(m, x, y))
            .ok_or("Pointer display is unavailable")?;
        let area = monitor.work_area();
        let margin = (12. * monitor.scale_factor()).round() as i32;
        let top = if y < f64::from(area.position.y) + f64::from(area.size.height) / 2. {
            area.position.y + area.size.height as i32 - size.height as i32 - margin
        } else {
            area.position.y + margin
        };
        surface
            .window
            .set_position(PhysicalPosition::new(area.position.x + margin, top))
            .map_err(|e| e.to_string())
    }
    async fn show_feedback(&mut self, gesture: Value) -> Result<(), String> {
        if !cfg!(windows) {
            return Ok(());
        }
        if gesture["phase"] == "cancelled" {
            self.clear_feedback();
            return Ok(());
        }
        let monitors = self.app.available_monitors().map_err(|e| e.to_string())?;
        self.avoid(&gesture, &monitors)?;
        // Display removal or a DPI/geometry change invalidates the old full-
        // screen surface. Close it with a CEF receipt before allocating another.
        let active: HashSet<String> = monitors.iter().map(monitor_key).collect();
        let obsolete: Vec<String> = self
            .feedback
            .keys()
            .filter(|key| !active.contains(*key))
            .cloned()
            .collect();
        if !obsolete.is_empty() {
            self.generation.fetch_add(1, Ordering::AcqRel);
        }
        for key in obsolete {
            if let Some(surface) = self.feedback.remove(&key) {
                surface.sequence.fetch_add(1, Ordering::AcqRel);
                surface.window.hide().map_err(|e| e.to_string())?;
                surface.close().await?;
            }
        }
        for monitor in monitors {
            let key = monitor_key(&monitor);
            let relevant = if let Some((x, y)) = point(&gesture["point"]) {
                monitor_contains(&monitor, x, y)
            } else if let Some((x, y, w, h)) = rectangle(&gesture["target"]) {
                x < f64::from(monitor.position().x) + f64::from(monitor.size().width)
                    && x + w > f64::from(monitor.position().x)
                    && y < f64::from(monitor.position().y) + f64::from(monitor.size().height)
                    && y + h > f64::from(monitor.position().y)
            } else {
                self.feedback.contains_key(&key)
            };
            if !relevant {
                if let Some(surface) = self.feedback.get(&key) {
                    let _ = surface.window.hide();
                }
                continue;
            }
            if !self.feedback.contains_key(&key) {
                let label = format!("computer-feedback-{}", uuid::Uuid::new_v4());
                let surface = self.surface(&label, FEEDBACK_HTML, false)?;
                self.feedback.insert(key.clone(), surface);
            }
            let surface = self.feedback.get(&key).unwrap().clone();
            surface
                .window
                .set_position(*monitor.position())
                .map_err(|e| e.to_string())?;
            surface
                .window
                .set_size(*monitor.size())
                .map_err(|e| e.to_string())?;
            let mut mapped = gesture.clone();
            let scale = monitor.scale_factor();
            for name in ["point", "to"] {
                if let Some((x, y)) = point(&gesture[name]) {
                    mapped[name] = json!({"x":(x-f64::from(monitor.position().x))/scale,"y":(y-f64::from(monitor.position().y))/scale});
                }
            }
            if let Some((x, y, w, h)) = rectangle(&gesture["target"]) {
                mapped["target"] = json!({"x":(x-f64::from(monitor.position().x))/scale,"y":(y-f64::from(monitor.position().y))/scale,"width":w/scale,"height":h/scale});
            }
            let configuration = json!({"type":"configure","bounds":{"x":0,"y":0,"width":f64::from(monitor.size().width)/scale,"height":f64::from(monitor.size().height)/scale},"fit":false,
                "labels":{"type":"⌨","set_value":"⌨","scroll":"↕","failed":"×"}});
            let event = json!({"type":"gesture","gesture":mapped});
            let admitted = self.generation.load(Ordering::Acquire);
            let generation = self.generation.clone();
            let sequence = surface.sequence.fetch_add(1, Ordering::AcqRel) + 1;
            let final_phase = matches!(gesture["phase"].as_str(), Some("completed" | "failed"));
            let failure = self.failure.clone();
            tauri::async_runtime::spawn(async move {
                let _tail = surface.tail.lock().await;
                if generation.load(Ordering::Acquire) != admitted {
                    return;
                }
                let result=async {
                    surface.window.show().map_err(|e|e.to_string())?;
                    surface.evaluate(format!("window.computerFeedback({configuration});window.computerFeedback({event});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))")).await?;
                    Ok::<_,String>(())
                }.await;
                if let Err(error) = result {
                    let _ = surface.window.hide();
                    *failure.lock().unwrap() = Some(error);
                    return;
                }
                if generation.load(Ordering::Acquire) != admitted {
                    let _ = surface.window.hide();
                    return;
                }
                if final_phase && surface.sequence.load(Ordering::Acquire) == sequence {
                    let tail = surface.clone();
                    let generation = generation.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
                        if generation.load(Ordering::Acquire) == admitted
                            && tail.sequence.load(Ordering::Acquire) == sequence
                        {
                            let _ = tail.window.hide();
                        }
                    });
                }
            });
        }
        Ok(())
    }
    fn clear_feedback(&mut self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        for surface in self.feedback.values() {
            let _ = surface.window.hide();
            let _ = surface
                .window
                .eval("window.computerFeedback({type:'clear'})");
        }
    }
    fn refresh_locale(&self) {
        if let Some(surface) = &self.controls {
            let _ = surface
                .window
                .set_title(&text(&self.locale, "Varin Computer controls"));
        }
        for surface in self.feedback.values() {
            let _ = surface
                .window
                .set_title(&text(&self.locale, "Varin Computer feedback"));
        }
    }
    fn surface(&self, label: &str, html: &str, controls: bool) -> Result<Surface, String> {
        let initial = format!(
            "data:text/html;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(html)
        );
        let initial_url =
            url::Url::parse(&initial).map_err(|_| "Computer presentation URL is invalid")?;
        let (readiness, _) = watch::channel(0);
        let loaded = readiness.clone();
        let failed = readiness.clone();
        let pending: Pending = Arc::default();
        let closed_pending = pending.clone();
        let failed_pending = pending.clone();
        let closed = readiness.clone();
        let send = self.send.clone();
        let command_url = initial.clone();
        let command_failure = self.failure.clone();
        let mut builder: WebviewWindowBuilder<'_, tauri::DynRuntime, AppHandle> =
            WebviewWindowBuilder::new(&self.app, label, WebviewUrl::External(initial_url))
                .visible(false)
                .decorations(false)
                .transparent(true)
                .focusable(false)
                .focused(false)
                .resizable(false)
                .skip_taskbar(true)
                .shadow(false)
                .always_on_top(true)
                .content_protected(true)
                .devtools(false)
                .incognito(true)
                .data_directory(self.data_dir.join("cef/computer-presentation"))
                .title(text(
                    &self.locale,
                    if controls {
                        "Varin Computer controls"
                    } else {
                        "Varin Computer feedback"
                    },
                ))
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
                .on_navigation(move |url| {
                    if url.as_str() == command_url || url.as_str() == "about:blank" {
                        return true;
                    }
                    if controls {
                        if let Some(action) = control_action(url.as_str()) {
                            if send.try_send(Message::Command(action.to_owned())).is_err() {
                                *command_failure.lock().unwrap() = Some("Computer control command could not be queued; its action was not executed".into());
                            }
                        }
                    }
                    false
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .on_page_load(move |_, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
                        && payload.url().scheme() == "data"
                    {
                        loaded.send_replace(1);
                    }
                })
                .on_frame_event(move |event| {
                    if matches!(event.kind, FrameEventKind::RendererTerminated) {
                        failed.send_replace(2);
                        for (_, reply) in failed_pending.lock().unwrap().drain() {
                            let _ = reply.send(Err(
                                "Computer renderer terminated before its receipt".into(),
                            ));
                        }
                    }
                });
        builder = offscreen::transparent(builder, label)?;
        let attrs = builder
            .runtime_specific_attributes_mut()
            .as_cef_webview_attributes_mut()
            .ok_or("Computer presentation requires CEF")?;
        attrs.native_only = true;
        attrs.native_close_handler = Some(Arc::new(move || {
            closed.send_replace(3);
            for (_, reply) in closed_pending.lock().unwrap().drain() {
                let _ = reply.send(Err(
                    "Computer presentation closed before rendering was confirmed".into(),
                ));
            }
        }));
        let window = builder.build().map_err(|e| e.to_string())?;
        if !controls {
            window
                .set_ignore_cursor_events(true)
                .map_err(|e| e.to_string())?;
            window.set_enabled(false).map_err(|e| e.to_string())?;
        }
        let results = pending.clone();
        window
            .on_dev_tools_protocol(move |message| {
                if let DevToolsProtocol::MethodResult {
                    message_id,
                    success,
                    result,
                } = message
                {
                    if let Some(reply) = results.lock().unwrap().remove(&message_id) {
                        let result = serde_json::from_slice::<Value>(&result)
                            .map_err(|_| "Computer presentation result is malformed".to_owned());
                        let result = if success {
                            result.and_then(|value| {
                                if value.get("exceptionDetails").is_some() {
                                    Err("Computer presentation script failed".into())
                                } else {
                                    Ok(value)
                                }
                            })
                        } else {
                            Err("Computer presentation evaluation failed".into())
                        };
                        let _ = reply.send(result);
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Surface {
            window,
            readiness,
            pending,
            tail: Arc::default(),
            sequence: Arc::new(AtomicU64::new(0)),
        })
    }
    fn protect(&mut self, active: bool) -> Result<(), String> {
        #[cfg(windows)]
        {
            if active {
                for (label, window) in self.app.windows() {
                    if self.protected.contains_key(&label) {
                        continue;
                    }
                    let handle = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
                    let previous = capture_affinity(handle)?;
                    set_capture_affinity(handle, 0x11)?; // WDA_EXCLUDEFROMCAPTURE
                    self.protected.insert(label, (handle, previous));
                }
            } else {
                let mut failure = None;
                for (label, (handle, previous)) in std::mem::take(&mut self.protected) {
                    // Never restore a newly created window that recycled a label.
                    if self
                        .app
                        .get_window(&label)
                        .and_then(|w| w.hwnd().ok())
                        .is_some_and(|h| h.0 as usize == handle)
                    {
                        if let Err(error) = set_capture_affinity(handle, previous) {
                            self.protected.insert(label, (handle, previous));
                            failure.get_or_insert(error);
                        }
                    }
                }
                if let Some(error) = failure {
                    return Err(error);
                }
            }
        }
        #[cfg(not(windows))]
        {
            let _ = active;
        }
        Ok(())
    }
    async fn dispose(&mut self) -> Result<(), String> {
        self.clear_feedback();
        let mut error = self.protect(false).err();
        let mut surfaces: Vec<_> = self.feedback.drain().map(|(_, surface)| surface).collect();
        if let Some(surface) = self.controls.take() {
            surfaces.push(surface);
        }
        for surface in surfaces {
            if let Err(cause) = surface.close().await {
                error.get_or_insert(cause);
            }
        }
        match error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

fn monitor_key(monitor: &tauri::Monitor) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        monitor.position().x,
        monitor.position().y,
        monitor.size().width,
        monitor.size().height,
        monitor.scale_factor()
    )
}

fn control_action(url: &str) -> Option<&'static str> {
    match url {
        "varin-computer-control:takeover" => Some("takeover"),
        "varin-computer-control:handback" => Some("handback"),
        "varin-computer-control:cancel" => Some("cancel"),
        _ => None,
    }
}
fn point(value: &Value) -> Option<(f64, f64)> {
    let (x, y) = (value["x"].as_f64()?, value["y"].as_f64()?);
    (x.is_finite() && y.is_finite()).then_some((x, y))
}
fn rectangle(value: &Value) -> Option<(f64, f64, f64, f64)> {
    let (x, y) = point(value)?;
    let (w, h) = (value["width"].as_f64()?, value["height"].as_f64()?);
    (w.is_finite() && h.is_finite() && w >= 0. && h >= 0.).then_some((x, y, w, h))
}
fn contains(left: f64, top: f64, width: f64, height: f64, x: f64, y: f64) -> bool {
    x >= left && y >= top && x < left + width && y < top + height
}
fn monitor_contains(monitor: &tauri::Monitor, x: f64, y: f64) -> bool {
    contains(
        f64::from(monitor.position().x),
        f64::from(monitor.position().y),
        f64::from(monitor.size().width),
        f64::from(monitor.size().height),
        x,
        y,
    )
}
pub fn window_handles(app: &AppHandle) -> Result<Vec<u64>, String> {
    #[cfg(windows)]
    {
        app.windows()
            .values()
            .map(|window| {
                let handle = window.hwnd().map_err(|e| e.to_string())?.0 as usize as u64;
                if handle == 0 || handle > ((1u64 << 53) - 1) {
                    Err("Native capture-exclusion handle cannot be represented safely".into())
                } else {
                    Ok(handle)
                }
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}
#[cfg(windows)]
#[link(name = "user32")]
unsafe extern "system" {
    fn GetWindowDisplayAffinity(window: *mut std::ffi::c_void, affinity: *mut u32) -> i32;
    fn SetWindowDisplayAffinity(window: *mut std::ffi::c_void, affinity: u32) -> i32;
}
#[cfg(windows)]
fn capture_affinity(handle: usize) -> Result<u32, String> {
    let mut value = 0;
    if unsafe { GetWindowDisplayAffinity(handle as *mut _, &mut value) } == 0 {
        Err("Existing capture protection could not be read".into())
    } else {
        Ok(value)
    }
}
#[cfg(windows)]
fn set_capture_affinity(handle: usize, value: u32) -> Result<(), String> {
    if unsafe { SetWindowDisplayAffinity(handle as *mut _, value) } == 0 {
        Err("Capture-safe computer controls are unavailable".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_commands_do_not_accept_other_origins_or_payloads() {
        for action in ["takeover", "handback", "cancel"] {
            assert_eq!(
                control_action(&format!("varin-computer-control:{action}")),
                Some(action)
            );
        }
        for url in [
            "https://x/varin-computer-control:cancel",
            "varin-computer-control:cancel?holderId=stolen",
            "varin-computer-control:cancel#x",
            "varin-computer-control://cancel",
            "varin-computer-control:eval",
        ] {
            assert!(control_action(url).is_none());
        }
    }
    #[test]
    fn negative_monitor_coordinates_and_edges_are_exact() {
        assert!(contains(-1920., -200., 1920., 1080., -1., 100.));
        assert!(!contains(-1920., -200., 1920., 1080., 0., 100.));
        assert!(rectangle(&json!({"x":-1920,"y":-200,"width":1920,"height":1080})).is_some());
        assert!(rectangle(&json!({"x":0,"y":0,"width":-1,"height":20})).is_none());
    }
}
