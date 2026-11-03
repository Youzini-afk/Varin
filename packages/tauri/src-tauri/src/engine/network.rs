//! Chromium's network service, without a browser's cookies or page privileges.
//!
//! One CEF callback thread per active request permits actual stream backpressure:
//! CEF's SimpleURLLoader calls its resume closure only after OnDownloadData returns.
//! Blocking that dedicated thread never blocks the UI or another request. A fixed
//! sized ring file crosses the process boundary; JSON carries cursors, not bytes.
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::Manager;
use tauri_runtime_cef::cef::{
    self, CefString, CefStringMultimap, ComInitMode, ImplPostData, ImplPostDataElement,
    ImplRequest, ImplResponse, ImplTask, ImplTaskRunner, ImplThread, ImplUrlrequest,
    ImplUrlrequestClient, MessageLoopType, RequestContext, RequestContextSettings, Task,
    TaskRunner, Thread, ThreadPriority, Urlrequest, UrlrequestClient, UrlrequestStatus, WrapTask,
    WrapUrlrequestClient, rc::Rc as _, wrap_task, wrap_urlrequest_client,
};

use super::network_ring::Window;

const CAPACITY: u64 = 1024 * 1024;
const MAX_TRANSFERS: usize = 64;
type Emit = Arc<dyn Fn(Value) + Send + Sync>;
#[derive(Default)]
struct Progress {
    started: bool,
    cancelled: bool,
    terminal: bool,
    headers: bool,
    ring: Window,
    failure: Option<String>,
}
struct Native {
    thread: Thread,
    runner: TaskRunner,
}
struct Transfer {
    id: String,
    directory: PathBuf,
    request_path: PathBuf,
    response: Mutex<Option<File>>,
    progress: Mutex<Progress>,
    readable: Condvar,
    native: Mutex<Option<Native>>,
    // Only access URLRequest methods on this transfer's dedicated CEF thread.
    request: Mutex<Option<Urlrequest>>,
    ended: tokio::sync::watch::Sender<bool>,
    released: tokio::sync::Mutex<bool>,
    emit: Emit,
}
#[derive(Clone)]
pub struct NetworkService {
    app: tauri::AppHandle,
    root: Arc<PathBuf>,
    transfers: Arc<Mutex<HashMap<String, Arc<Transfer>>>>,
    context: Arc<Mutex<Option<RequestContext>>>,
    closing: Arc<AtomicBool>,
    shutdown_result: Arc<tokio::sync::Mutex<Option<Result<(), String>>>>,
    emit: Emit,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Start {
    request_id: String,
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    has_body: bool,
}

impl NetworkService {
    /// `emit` must enqueue events in order, without blocking a CEF callback.
    pub fn new(app: tauri::AppHandle, root: PathBuf, emit: Emit) -> Result<Self, String> {
        private_directory(&root)?;
        let root = fs::canonicalize(root).map_err(|_| "Network spool root is unavailable")?;
        Ok(Self {
            app,
            root: Arc::new(root),
            transfers: Default::default(),
            context: Default::default(),
            closing: Default::default(),
            shutdown_result: Default::default(),
            emit,
        })
    }

    pub async fn handle(&self, method: &str, params: Value) -> Result<Value, String> {
        if method == "network.allocate" {
            return self.allocate();
        }
        let id = params["requestId"]
            .as_str()
            .ok_or("Network request identity is missing")?;
        let transfer = self
            .transfers
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("Unknown network request")?;
        match method {
            "network.start" => {
                if self.closing.load(Ordering::Acquire) {
                    return Err("Native network owner is stopping".into());
                }
                let start: Start =
                    serde_json::from_value(params).map_err(|_| "Invalid network request")?;
                validate(&start)?;
                if start.request_id != transfer.id {
                    return Err("Network request identity changed".into());
                }
                {
                    let mut progress = transfer.progress.lock().unwrap();
                    if progress.started || progress.terminal {
                        return Err("Network request cannot be started again".into());
                    }
                    progress.started = true;
                }
                let (send, receive) = tokio::sync::oneshot::channel();
                let failed = transfer.clone();
                let context = self.context.clone();
                if self
                    .app
                    .run_on_main_thread(move || {
                        let result = start_native(transfer.clone(), start, context);
                        if result.is_err() {
                            transfer.finish("failed", Some("Chromium request could not start"));
                        }
                        let _ = send.send(result);
                    })
                    .is_err()
                {
                    failed.finish("failed", Some("Chromium main loop is unavailable"));
                    return Err("Chromium main loop is unavailable".into());
                }
                receive
                    .await
                    .map_err(|_| "Network start outcome is unknown")??;
                Ok(json!({"started":true}))
            }
            "network.ack" => {
                let consumed = params["consumed"]
                    .as_u64()
                    .ok_or("Invalid network read cursor")?;
                let mut progress = transfer.progress.lock().unwrap();
                progress.ring.acknowledge(consumed)?;
                if let Some(available) = progress.ring.notification(false) {
                    // Emit under the state lock: complete cannot overtake this
                    // acknowledgment-triggered final unread cursor.
                    (transfer.emit)(
                        json!({"kind":"data","requestId":transfer.id,"available":available}),
                    );
                }
                transfer.readable.notify_all();
                Ok(json!({"acknowledged":true}))
            }
            "network.cancel" => {
                cancel(&transfer);
                Ok(json!({"requested":true}))
            }
            "network.release" => {
                if !transfer.progress.lock().unwrap().terminal {
                    return Err("Original network request has not completed".into());
                }
                self.release(transfer).await?;
                Ok(json!({"released":true}))
            }
            _ => Err("Unknown native network method".into()),
        }
    }

    fn allocate(&self) -> Result<Value, String> {
        let mut transfers = self.transfers.lock().unwrap();
        if self.closing.load(Ordering::Acquire) {
            return Err("Native network owner is stopping".into());
        }
        if transfers.len() >= MAX_TRANSFERS {
            return Err("Native network concurrency limit reached (64 owned requests)".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let directory = self.root.join(&id);
        private_directory(&directory)?;
        let request_path = directory.join("request.body");
        let response_path = directory.join("response.ring");
        let created = (|| {
            private_file(&request_path)?;
            let response = private_file(&response_path)?;
            response
                .set_len(CAPACITY)
                .map_err(|_| "Network response spool could not be allocated")?;
            Ok::<_, String>(response)
        })();
        let response = match created {
            Ok(file) => file,
            Err(error) => {
                let _ = fs::remove_dir_all(&directory);
                return Err(error);
            }
        };
        let result = json!({"requestId":id,"requestPath":request_path,"responsePath":response_path,"responseCapacity":CAPACITY});
        let (ended, _) = tokio::sync::watch::channel(false);
        let transfer = Arc::new(Transfer {
            id: id.clone(),
            directory,
            request_path,
            response: Mutex::new(Some(response)),
            progress: Default::default(),
            readable: Condvar::new(),
            native: Default::default(),
            request: Default::default(),
            ended,
            released: tokio::sync::Mutex::new(false),
            emit: self.emit.clone(),
        });
        transfers.insert(id, transfer);
        Ok(result)
    }

    async fn release(&self, transfer: Arc<Transfer>) -> Result<(), String> {
        let mut released = transfer.released.lock().await;
        if *released {
            return Ok(());
        }
        let (send, receive) = tokio::sync::oneshot::channel();
        let owned = transfer.clone();
        self.app
            .run_on_main_thread(move || {
                // Stop must run on the thread that created the CEF thread, never on
                // that thread itself. Joining also waits for the last callback.
                if let Some(native) = owned.native.lock().unwrap().take() {
                    native.thread.stop();
                }
                let _ = send.send(());
            })
            .map_err(|_| "Network thread termination is unknown")?;
        receive
            .await
            .map_err(|_| "Network thread termination is unknown")?;
        // Explicitly close the shell descriptor even if a completed CEF task
        // still retains a harmless Arc until its task queue is destroyed.
        transfer.response.lock().unwrap().take();
        // Caller closes its descriptors before release. Our File must also be
        // closed before deletion on Windows; removing the map is insufficient
        // because this function still owns an Arc. Delete files via drop below.
        self.transfers.lock().unwrap().remove(&transfer.id);
        match fs::remove_dir_all(&transfer.directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Completed network spool could not be removed".into()),
        }
        *released = true;
        Ok(())
    }

    /// Call before CEF shutdown. Never claim an aborted observer stopped I/O.
    pub async fn shutdown(&self) -> Result<(), String> {
        let mut completed = self.shutdown_result.lock().await;
        if let Some(result) = completed.as_ref() {
            return result.clone();
        }
        let result = self.shutdown_once().await;
        *completed = Some(result.clone());
        result
    }
    async fn shutdown_once(&self) -> Result<(), String> {
        let transfers: Vec<_> = {
            let transfers = self.transfers.lock().unwrap();
            self.closing.store(true, Ordering::Release);
            transfers.values().cloned().collect()
        };
        for transfer in &transfers {
            cancel(transfer);
        }
        for transfer in transfers {
            let mut ended = transfer.ended.subscribe();
            while !*ended.borrow_and_update() {
                ended
                    .changed()
                    .await
                    .map_err(|_| "Network termination is unknown")?;
            }
            self.release(transfer).await?;
        }
        let context = self.context.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        self.app
            .run_on_main_thread(move || {
                context.lock().unwrap().take();
                let _ = send.send(());
            })
            .map_err(|_| "Chromium context disposal is unknown")?;
        receive
            .await
            .map_err(|_| "Chromium context disposal is unknown")?;
        Ok(())
    }
}

fn private_directory(path: &std::path::Path) -> Result<(), String> {
    // Refuse symlinks at the boundary. Existing user data ancestors are owned
    // by the application; the UUID child cannot be supplied by a caller.
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
            return Err("Network spool path is not a private directory".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut options = fs::DirBuilder::new();
            options.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                options.mode(0o700);
            }
            options
                .create(path)
                .map_err(|_| "Network spool directory could not be created")?;
        }
        Err(_) => return Err("Network spool directory could not be inspected".into()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Network spool could not be secured")?;
    }
    Ok(())
}
fn private_file(path: &std::path::Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.create_new(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|_| "Network spool file could not be created".into())
}
fn validate(start: &Start) -> Result<(), String> {
    let url = url::Url::parse(&start.url).map_err(|_| "Invalid network URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Native network requests require HTTP(S) without URL credentials".into());
    }
    if start.method.is_empty() || !start.method.bytes().all(token_byte) {
        return Err("Invalid HTTP method".into());
    }
    if start.headers.iter().any(|(name, value)| {
        name.is_empty()
            || !name.bytes().all(token_byte)
            || value.bytes().any(|b| b == 0 || b == b'\r' || b == b'\n')
    }) {
        return Err("Invalid HTTP headers".into());
    }
    Ok(())
}
fn token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte)
}

wrap_task! {
    struct Action { action: Arc<dyn Fn() + Send + Sync>, }
    impl Task { fn execute(&self) { (self.action)(); } }
}
fn post(runner: &TaskRunner, action: impl Fn() + Send + Sync + 'static) -> bool {
    runner.post_task(Some(&mut Action::new(Arc::new(action)))) != 0
}

fn start_native(
    transfer: Arc<Transfer>,
    start: Start,
    shared_context: Arc<Mutex<Option<RequestContext>>>,
) -> Result<(), String> {
    if transfer.progress.lock().unwrap().cancelled {
        transfer.finish("cancelled", None);
        return Ok(());
    }
    if start.has_body {
        let metadata = fs::symlink_metadata(&transfer.request_path)
            .map_err(|_| "Request body spool is unavailable")?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("Request body spool is not a regular file".into());
        }
    }
    // Empty cache_path creates an isolated in-memory context. No cookies,
    // credentials, certificate overrides or Browser Use profile are borrowed.
    let context = {
        let mut shared = shared_context.lock().unwrap();
        if shared.is_none() {
            *shared = cef::request_context_create_context(
                Some(&RequestContextSettings {
                    cookieable_schemes_exclude_defaults: 1,
                    ..Default::default()
                }),
                None,
            );
        }
        shared
            .clone()
            .ok_or("Private Chromium network context is unavailable")?
    };
    let thread = cef::thread_create(
        Some(&CefString::from("Varin network stream")),
        ThreadPriority::NORMAL,
        MessageLoopType::TYPE_DEFAULT,
        1,
        ComInitMode::NONE,
    )
    .ok_or("Chromium network thread could not start")?;
    let runner = thread
        .task_runner()
        .ok_or("Chromium network task runner is unavailable")?;
    *transfer.native.lock().unwrap() = Some(Native {
        thread,
        runner: runner.clone(),
    });
    let cloned = transfer.clone();
    if !post(&runner, move || {
        begin(cloned.clone(), start.clone(), context.clone())
    }) {
        return Err("Chromium network request could not be scheduled".into());
    }
    Ok(())
}
fn begin(transfer: Arc<Transfer>, start: Start, mut context: RequestContext) {
    if transfer.progress.lock().unwrap().cancelled {
        transfer.finish("cancelled", None);
        return;
    }
    let Some(request) = cef::request_create() else {
        transfer.finish("failed", Some("Chromium request allocation failed"));
        return;
    };
    request.set_url(Some(&CefString::from(start.url.as_str())));
    request.set_method(Some(&CefString::from(start.method.as_str())));
    let mut headers = CefStringMultimap::new();
    for (name, value) in &start.headers {
        headers.append(name, value);
    }
    request.set_header_map(Some(&mut headers));
    use cef::sys::cef_urlrequest_flags_t as Flags;
    request.set_flags(
        Flags::UR_FLAG_DISABLE_CACHE.0 as i32
            | Flags::UR_FLAG_STOP_ON_REDIRECT.0 as i32
            | Flags::UR_FLAG_NO_RETRY_ON_5XX.0 as i32,
    );
    if start.has_body {
        let (Some(post), Some(mut element)) =
            (cef::post_data_create(), cef::post_data_element_create())
        else {
            transfer.finish("failed", Some("Chromium request body allocation failed"));
            return;
        };
        element.set_to_file(Some(&CefString::from(
            transfer.request_path.to_string_lossy().as_ref(),
        )));
        if post.add_element(Some(&mut element)) == 0 {
            transfer.finish("failed", Some("Chromium request body was rejected"));
            return;
        }
        request.set_post_data(Some(&mut post.clone()));
    }
    let mut client = StreamClient::new(transfer.clone(), start.method);
    let Some(request) = cef::urlrequest_create(
        Some(&mut request.clone()),
        Some(&mut client),
        Some(&mut context),
    ) else {
        transfer.finish("failed", Some("Chromium rejected the network request"));
        return;
    };
    *transfer.request.lock().unwrap() = Some(request.clone());
    if transfer.progress.lock().unwrap().cancelled {
        request.cancel();
    } else {
        poll_headers(transfer);
    }
}

fn cancel(transfer: &Arc<Transfer>) {
    let started = {
        let mut progress = transfer.progress.lock().unwrap();
        if progress.terminal {
            return;
        }
        progress.cancelled = true;
        transfer.readable.notify_all();
        progress.started
    };
    if !started {
        transfer.finish("cancelled", None);
        return;
    }
    let runner = transfer
        .native
        .lock()
        .unwrap()
        .as_ref()
        .map(|native| native.runner.clone());
    if let Some(runner) = runner {
        let transfer = transfer.clone();
        post(&runner, move || {
            let request = transfer.request.lock().unwrap().clone();
            if let Some(request) = request {
                request.cancel();
            }
            // If start has not executed yet, begin observes cancelled itself.
        });
    }
}

fn poll_headers(transfer: Arc<Transfer>) {
    let progress = transfer.progress.lock().unwrap();
    if progress.headers || progress.terminal {
        return;
    }
    drop(progress);
    let request = transfer.request.lock().unwrap().clone();
    if let Some(request) = request {
        let method = request
            .request()
            .map(|r| CefString::from(&r.method()).to_string())
            .unwrap_or_default();
        transfer.headers(&request, &method);
    }
    let progress = transfer.progress.lock().unwrap();
    if progress.headers || progress.terminal {
        return;
    }
    drop(progress);
    let runner = transfer
        .native
        .lock()
        .unwrap()
        .as_ref()
        .map(|n| n.runner.clone());
    if let Some(runner) = runner {
        let mut task = Action::new(Arc::new(move || poll_headers(transfer.clone())));
        runner.post_delayed_task(Some(&mut task), 10);
    }
}

impl Transfer {
    fn headers(&self, request: &Urlrequest, method: &str) {
        if self.progress.lock().unwrap().headers {
            return;
        }
        let Some(response) = request.response().filter(|response| response.status() > 0) else {
            return;
        };
        let status = response.status();
        let mut map = CefStringMultimap::new();
        response.header_map(Some(&mut map));
        let headers: Vec<(String, String)> = map
            .into_iter()
            .flat_map(|(key, values)| values.into_iter().map(move |value| (key.clone(), value)))
            .collect();
        self.progress.lock().unwrap().headers = true;
        (self.emit)(
            json!({"kind":"headers","requestId":self.id,"status":status,"statusText":CefString::from(&response.status_text()).to_string(),
            "headers":headers,"url":CefString::from(&response.url()).to_string(),"noBody":method == "HEAD" || matches!(status,204|205|304) || is_redirect(status)}),
        );
    }
    fn finish(&self, outcome: &str, error: Option<&str>) {
        {
            let mut progress = self.progress.lock().unwrap();
            if progress.terminal {
                return;
            }
            if let Some(available) = progress.ring.notification(true) {
                (self.emit)(json!({"kind":"data","requestId":self.id,"available":available}));
            }
            progress.terminal = true;
            (self.emit)(
                json!({"kind":"complete","requestId":self.id,"outcome":outcome,"error":error}),
            );
            self.readable.notify_all();
        }
        self.ended.send_replace(true);
    }
    fn data(&self, request: &Urlrequest, mut bytes: &[u8]) {
        while !bytes.is_empty() {
            let mut progress = self.progress.lock().unwrap();
            while progress.ring.full(CAPACITY) && !progress.cancelled {
                progress = self.readable.wait(progress).unwrap();
            }
            if progress.cancelled {
                drop(progress);
                request.cancel();
                return;
            }
            let (offset, count) = progress.ring.write_span(CAPACITY, bytes.len());
            let mut handle = self.response.lock().unwrap();
            let Some(file) = handle.as_mut() else {
                progress.failure = Some("Network response spool was closed early".into());
                drop(handle);
                drop(progress);
                request.cancel();
                return;
            };
            let written = file
                .seek(SeekFrom::Start(offset))
                .and_then(|_| file.write_all(&bytes[..count]));
            if written.is_err() {
                progress.failure = Some("Network response spool write failed".into());
                drop(handle);
                drop(progress);
                request.cancel();
                return;
            }
            // No buffered writer. Returning from write_all commits these bytes
            // to other descriptors; disk durability (fsync) is not required.
            progress.ring.commit(count);
            drop(handle);
            if let Some(available) = progress.ring.notification(false) {
                (self.emit)(json!({"kind":"data","requestId":self.id,"available":available}));
            }
            drop(progress);
            bytes = &bytes[count..];
        }
    }
}
fn is_redirect(status: i32) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

wrap_urlrequest_client! {
    struct StreamClient { transfer: Arc<Transfer>, method: String, }
    impl UrlrequestClient {
        fn on_download_progress(&self, request: Option<&mut Urlrequest>, _current: i64, _total: i64) {
            if let Some(request) = request { self.transfer.headers(request, &self.method); }
        }
        fn on_download_data(&self, request: Option<&mut Urlrequest>, data: *const u8, data_length: usize) {
            let Some(request) = request else { return; };
            self.transfer.headers(request, &self.method);
            if data_length > 0 && !data.is_null() {
                // CEF owns this memory only until the callback returns. Copy to
                // the bounded ring before allowing the stream to resume.
                self.transfer.data(request, unsafe { std::slice::from_raw_parts(data, data_length) });
            }
        }
        fn on_request_complete(&self, request: Option<&mut Urlrequest>) {
            let Some(request) = request else { self.transfer.finish("failed", Some("Chromium completion receipt is missing")); return; };
            self.transfer.headers(request, &self.method);
            let progress = self.transfer.progress.lock().unwrap();
            let cancelled = progress.cancelled;
            let failure = progress.failure.clone();
            drop(progress);
            let redirect = request.response().is_some_and(|response| is_redirect(response.status()));
            let status = request.request_status();
            self.transfer.request.lock().unwrap().take();
            if let Some(error) = failure { self.transfer.finish("failed", Some(&error)); }
            else if cancelled { self.transfer.finish("cancelled", None); }
            else if status == UrlrequestStatus::SUCCESS || (redirect && status == UrlrequestStatus::CANCELED) { self.transfer.finish("succeeded", None); }
            else { self.transfer.finish("failed", Some("Chromium network request failed")); }
        }
    }
}
