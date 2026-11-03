//! Supervises only processes started by this shell. Pipe loss and cancel intent
//! do not prove original executors stopped; wait() remains the termination owner.
use crate::{
    host_codec::{self, Decoder, MAX_ASSEMBLIES, MESSAGE_BYTES, Outgoing, PROTOCOL},
    host_scope::ProcessScope,
    manifest::{RuntimePaths, contained_file},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::Path,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, Command},
    sync::{Mutex, OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch},
};

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub enum HostPhase {
    #[default]
    Starting,
    Ready,
    Stopping,
    Failed,
    Exited,
}
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub enum HostMode {
    #[default]
    Host,
    Browser,
}
#[derive(Clone, Default)]
pub struct HostSnapshot {
    pub phase: HostPhase,
    pub mode: HostMode,
    pub origin: Option<String>,
    // Never derive Debug or publish this snapshot; it contains local credentials.
    pub client_token: Option<String>,
    pub error: Option<String>,
    pub exit_code: Option<i32>,
    pub scope_ended: bool,
}
type Reply = Result<Value, String>;
struct Pending {
    reply: oneshot::Sender<Reply>,
    method: String,
}
/// Keep this value alive through callback handling. Dropping it releases the
/// byte budget. There is one receiver: callbacks cannot silently lag or disappear.
pub struct HostMessage {
    frame: Value,
    _budget: OwnedSemaphorePermit,
    _slot: OwnedSemaphorePermit,
}
impl HostMessage {
    pub fn frame(&self) -> &Value {
        &self.frame
    }
}
/// One consumer, with a reserved cancellation lane independent of bulk effects.
pub struct HostEvents {
    normal: mpsc::Receiver<HostMessage>,
    priority: mpsc::Receiver<HostMessage>,
    normal_closed: bool,
    priority_closed: bool,
}
impl HostEvents {
    pub async fn recv(&mut self) -> Option<HostMessage> {
        loop {
            if self.normal_closed && self.priority_closed {
                return None;
            }
            tokio::select! {
                biased;
                message = self.priority.recv(), if !self.priority_closed => match message { Some(message) => return Some(message), None => self.priority_closed = true },
                message = self.normal.recv(), if !self.normal_closed => match message { Some(message) => return Some(message), None => self.normal_closed = true },
            }
        }
    }
}
struct WriteContext {
    done: oneshot::Sender<Result<(), String>>,
    _budget: OwnedSemaphorePermit,
    _slot: OwnedSemaphorePermit,
}
type WriteJob = Outgoing<WriteContext>;
struct Writer {
    queue: mpsc::Sender<WriteJob>,
    close: watch::Sender<bool>,
    budget: Arc<Semaphore>,
    controls: Arc<Semaphore>,
    bulk_slots: Arc<Semaphore>,
    control_slots: Arc<Semaphore>,
    sequence: AtomicU64,
    enqueue: Mutex<()>,
}
impl Writer {
    fn start(mut stdin: ChildStdin) -> Arc<Self> {
        let (queue, mut incoming) = mpsc::channel::<WriteJob>(MAX_ASSEMBLIES * 2);
        let (close, mut closing) = watch::channel(false);
        let writer = Arc::new(Self {
            queue,
            close,
            budget: Arc::new(Semaphore::new(MESSAGE_BYTES)),
            controls: Arc::new(Semaphore::new(MAX_ASSEMBLIES * host_codec::CHUNK_BYTES)),
            bulk_slots: Arc::new(Semaphore::new(MAX_ASSEMBLIES)),
            control_slots: Arc::new(Semaphore::new(MAX_ASSEMBLIES)),
            sequence: AtomicU64::new(0),
            enqueue: Mutex::new(()),
        });
        let running = writer.clone();
        tokio::spawn(async move {
            let mut queued = VecDeque::new();
            let failure = loop {
                if *closing.borrow() {
                    break "Desktop control pipe closed; pending effect outcomes are unknown";
                }
                // Admit queued controls between chunks, never inside a UTF-8 frame.
                while queued.len() < MAX_ASSEMBLIES * 2 {
                    match incoming.try_recv() {
                        Ok(job) => queued.push_back(job),
                        Err(_) => break,
                    }
                }
                if queued.is_empty() {
                    tokio::select! {
                        biased;
                        _ = closing.changed() => continue,
                        job = incoming.recv() => match job { Some(job) => { queued.push_back(job); }, None => break "Desktop control writer ended" },
                    }
                }
                let Some(mut job) = host_codec::next_outgoing(&mut queued) else {
                    continue;
                };
                let (line, last) = job.next_line();
                let result = tokio::select! {
                    biased;
                    _ = closing.changed() => Err("Desktop control pipe closed; effect outcome is unknown"),
                    result = stdin.write_all(&line) => result.map_err(|_| "Desktop control pipe write failed; effect outcome is unknown"),
                };
                if let Err(error) = result {
                    let _ = job.context.done.send(Err(error.into()));
                    break error;
                }
                if last {
                    let _ = job.context.done.send(Ok(()));
                } else {
                    queued.push_back(job);
                }
            };
            incoming.close();
            for job in queued {
                let _ = job.context.done.send(Err(failure.into()));
            }
            while let Some(job) = incoming.recv().await {
                let _ = job.context.done.send(Err(failure.into()));
            }
            running.budget.close();
            running.controls.close();
            running.bulk_slots.close();
            running.control_slots.close();
            running.close.send_replace(true);
            // Dropping this actual pipe asks Node to drain. No force-kill timer.
            drop(stdin);
        });
        writer
    }
    async fn send(&self, value: &Value) -> Result<(), String> {
        if *self.close.borrow() {
            return Err("Desktop service is not running".into());
        }
        // Count without copying the payload before reserving memory. A bounded
        // separate control lane cannot be starved by a maximum-sized CDP result.
        let mut size = EncodedSize(0);
        serde_json::to_writer(&mut size, value)
            .map_err(|_| "Control message could not be encoded")?;
        if size.0 > MESSAGE_BYTES {
            return Err("Desktop control message exceeds its memory budget".into());
        }
        let (source, slots) = if size.0 <= host_codec::CHUNK_BYTES {
            (&self.controls, &self.control_slots)
        } else {
            (&self.budget, &self.bulk_slots)
        };
        let slot = slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "Desktop service is not running")?;
        let budget = source
            .clone()
            .acquire_many_owned(size.0 as u32)
            .await
            .map_err(|_| "Desktop service is not running")?;
        let encoded =
            serde_json::to_string(value).map_err(|_| "Control message could not be encoded")?;
        let enqueue = self.enqueue.lock().await;
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let (done, result) = oneshot::channel();
        let job = Outgoing::from_encoded(
            encoded,
            "shell",
            sequence,
            WriteContext {
                done,
                _budget: budget,
                _slot: slot,
            },
        );
        self.queue
            .send(job)
            .await
            .map_err(|_| "Desktop service control pipe is closed")?;
        drop(enqueue);
        result
            .await
            .map_err(|_| "Desktop service write outcome is unknown".to_owned())?
    }
    fn stop(&self) {
        self.close.send_replace(true);
        self.budget.close();
        self.controls.close();
        self.bulk_slots.close();
        self.control_slots.close();
    }
}
struct EncodedSize(usize);
impl std::io::Write for EncodedSize {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len())
            .ok_or_else(|| std::io::Error::other("Control message is too large"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
struct Shared {
    scope: Arc<ProcessScope>,
    writer: Arc<Writer>,
    pending: Mutex<HashMap<String, Pending>>,
    callbacks: Mutex<HashSet<String>>,
    snapshot: watch::Sender<HostSnapshot>,
    events: Mutex<Option<mpsc::Sender<HostMessage>>>,
    priority_events: Mutex<Option<mpsc::Sender<HostMessage>>>,
    receiver: Mutex<Option<HostEvents>>,
    event_slots: Arc<Semaphore>,
    control_event_slots: Arc<Semaphore>,
    event_budget: Arc<Semaphore>,
    control_event_budget: Arc<Semaphore>,
    sequence: AtomicU64,
    stopping: Mutex<()>,
    drained: AtomicBool,
    stop_acknowledged: AtomicBool,
}
#[derive(Clone)]
pub struct HostProcess {
    shared: Arc<Shared>,
}

impl HostProcess {
    pub fn spawn(runtime: &RuntimePaths, data_dir: &Path) -> Result<Self, String> {
        Self::spawn_command(
            &runtime.node,
            &runtime.host,
            data_dir,
            HostMode::Host,
            &[
                ("VARIN_NODE_PATH", runtime.node.as_os_str()),
                ("VARIN_KERNEL_PATH", runtime.kernel.as_os_str()),
                (
                    "VARIN_DIST_DIR",
                    runtime
                        .frontend
                        .parent()
                        .ok_or("Frontend resource parent is missing")?
                        .as_os_str(),
                ),
                ("VARIN_RESOURCES_PATH", runtime.root.as_os_str()),
            ],
        )
    }
    pub fn spawn_browser(runtime: &RuntimePaths, data_dir: &Path) -> Result<Self, String> {
        let entry = contained_file(&runtime.root, &runtime.manifest.host.browser_entry)
            .map_err(|_| "Browser service entry is unavailable")?;
        runtime
            .verify_file(&runtime.manifest.host.browser_entry)
            .map_err(|_| "Browser service entry failed verification")?;
        Self::spawn_command(
            &runtime.node,
            &entry,
            data_dir,
            HostMode::Browser,
            &[
                ("VARIN_NODE_PATH", runtime.node.as_os_str()),
                (
                    "VARIN_DIST_DIR",
                    runtime
                        .frontend
                        .parent()
                        .ok_or("Frontend resource parent is missing")?
                        .as_os_str(),
                ),
                ("VARIN_RESOURCES_PATH", runtime.root.as_os_str()),
            ],
        )
    }
    fn spawn_command(
        node: &Path,
        entry: &Path,
        data_dir: &Path,
        mode: HostMode,
        env: &[(&str, &std::ffi::OsStr)],
    ) -> Result<Self, String> {
        let mut command = Command::new(node);
        command
            .arg(entry)
            .env("VARIN_DATA_DIR", data_dir)
            .env("VARIN_RUNTIME", "desktop")
            .env_remove("ELECTRON_RUN_AS_NODE")
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_CHANNEL_FD")
            .env_remove("NODE_CHANNEL_SERIALIZATION_MODE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        for (key, value) in env {
            command.env(key, value);
        }
        ProcessScope::prepare(&mut command);
        let mut child = command
            .spawn()
            .map_err(|_| "Bundled desktop service could not start".to_owned())?;
        let scope = match ProcessScope::attach(&child) {
            Ok(scope) => Arc::new(scope),
            Err(error) => {
                let _ = child.start_kill();
                tokio::spawn(async move {
                    let _ = child.wait().await;
                });
                return Err(error);
            }
        };
        let stdin = child
            .stdin
            .take()
            .ok_or("Desktop service input pipe missing")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Desktop service output pipe missing")?;
        let (snapshot, _) = watch::channel(HostSnapshot {
            mode,
            ..Default::default()
        });
        let (events, normal) = mpsc::channel(1024);
        let (priority_events, priority) = mpsc::channel(MAX_ASSEMBLIES);
        let receiver = HostEvents {
            normal,
            priority,
            normal_closed: false,
            priority_closed: false,
        };
        let shared = Arc::new(Shared {
            scope,
            writer: Writer::start(stdin),
            pending: Mutex::new(HashMap::new()),
            callbacks: Mutex::new(HashSet::new()),
            snapshot,
            events: Mutex::new(Some(events)),
            priority_events: Mutex::new(Some(priority_events)),
            receiver: Mutex::new(Some(receiver)),
            event_slots: Arc::new(Semaphore::new(1024)),
            control_event_slots: Arc::new(Semaphore::new(MAX_ASSEMBLIES)),
            event_budget: Arc::new(Semaphore::new(MESSAGE_BYTES)),
            control_event_budget: Arc::new(Semaphore::new(
                MAX_ASSEMBLIES * host_codec::CHUNK_BYTES,
            )),
            sequence: AtomicU64::new(0),
            stopping: Mutex::new(()),
            drained: AtomicBool::new(false),
            stop_acknowledged: AtomicBool::new(false),
        });
        let (reader_done, reader_finished) = oneshot::channel();
        let reader_shared = shared.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut decoder = Decoder::new("host");
            loop {
                let line = match bounded_line(&mut reader).await {
                    Ok(Some(line)) => line,
                    Ok(None) => {
                        if decoder.finish().is_err() {
                            fail(
                                &reader_shared,
                                "Desktop service ended with incomplete control data",
                            )
                            .await;
                        } else if !reader_shared.drained.load(Ordering::Acquire) {
                            fail(
                                &reader_shared,
                                "Desktop service control pipe ended before confirmed drain",
                            )
                            .await;
                        }
                        break;
                    }
                    Err(_) => {
                        fail(
                            &reader_shared,
                            "Desktop service sent malformed control data",
                        )
                        .await;
                        break;
                    }
                };
                let decoded = match decoder.line(&line) {
                    Ok(Some(frame)) => frame,
                    Ok(None) => continue,
                    Err(_) => {
                        fail(
                            &reader_shared,
                            "Desktop service sent invalid control framing",
                        )
                        .await;
                        break;
                    }
                };
                if let Err(error) = accept(&reader_shared, decoded, mode).await {
                    fail(&reader_shared, error).await;
                    break;
                }
            }
            decoder.clear();
            reader_shared.writer.stop();
            let _ = reader_done.send(());
        });
        let exit_shared = shared.clone();
        tokio::spawn(async move {
            let result = child.wait().await;
            let scope = exit_shared.scope.settle_after_node_exit().await;
            // The last response can still be buffered when wait() finishes. Drain
            // the pipe first so a clean stop receipt is never replaced by unknown.
            let _ = reader_finished.await;
            exit_shared.writer.stop();
            exit_shared.event_budget.close();
            exit_shared.control_event_budget.close();
            exit_shared.events.lock().await.take();
            exit_shared.priority_events.lock().await.take();
            exit_shared.event_slots.close();
            exit_shared.control_event_slots.close();
            exit_shared.snapshot.send_modify(|s| {
                s.phase = HostPhase::Exited;
                s.scope_ended = scope.is_ok();
                if !matches!(scope, Ok(true)) { s.error.get_or_insert_with(|| "Managed process scope required abnormal cleanup; effect outcomes remain unknown".into()); }
                s.exit_code = result.as_ref().ok().and_then(|status| status.code());
                if result.is_err() {
                    s.error = Some("Desktop service termination could not be observed".into());
                } else if result.as_ref().is_ok_and(|status| !status.success()) && s.error.is_none()
                {
                    s.error = Some("Desktop service exited unsuccessfully".into());
                }
            });
            for (_, pending) in exit_shared.pending.lock().await.drain() {
                let _ = pending.reply.send(Err(
                    "Desktop service exited before replying; effect outcome is unknown".into(),
                ));
            }
            exit_shared.callbacks.lock().await.clear();
        });
        Ok(Self { shared })
    }
    pub fn same_process(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.shared, &other.shared)
    }
    pub fn snapshot(&self) -> HostSnapshot {
        self.shared.snapshot.borrow().clone()
    }
    pub fn subscribe(&self) -> watch::Receiver<HostSnapshot> {
        self.shared.snapshot.subscribe()
    }
    pub async fn take_events(&self) -> Result<HostEvents, String> {
        self.shared
            .receiver
            .lock()
            .await
            .take()
            .ok_or_else(|| "Desktop service events already have an owner".into())
    }
    pub async fn wait_for_scope_end(&self) -> Result<(), String> {
        let mut observed = self.subscribe();
        loop {
            let state = observed.borrow_and_update().clone();
            if state.phase == HostPhase::Exited {
                return if state.scope_ended {
                    Ok(())
                } else {
                    Err("Managed process scope termination remains unknown".into())
                };
            }
            observed
                .changed()
                .await
                .map_err(|_| "Managed process scope observation ended")?;
        }
    }
    pub async fn ready(&self) -> Result<HostSnapshot, String> {
        let mut observed = self.subscribe();
        loop {
            let snapshot = observed.borrow_and_update().clone();
            match snapshot.phase {
                HostPhase::Ready => return Ok(snapshot),
                HostPhase::Failed | HostPhase::Exited | HostPhase::Stopping => {
                    return Err(snapshot
                        .error
                        .unwrap_or("Desktop service did not become ready".into()));
                }
                HostPhase::Starting => {}
            }
            observed
                .changed()
                .await
                .map_err(|_| "Desktop service observation ended")?;
        }
    }
    pub async fn request(&self, method: &str, params: Value) -> Reply {
        let id = format!(
            "shell:{}",
            self.shared.sequence.fetch_add(1, Ordering::Relaxed)
        );
        let (sender, response) = oneshot::channel();
        self.shared.pending.lock().await.insert(
            id.clone(),
            Pending {
                reply: sender,
                method: method.into(),
            },
        );
        // If the caller drops this future, the original request remains owned.
        // Keep its identity until its real reply/exit; never route a late reply to
        // another invocation and never automatically replay a dropped observer.
        let frame = json!({"protocol":PROTOCOL,"version":1,"kind":"request","id":id,"method":method,"params":params});
        if let Err(error) = self.shared.writer.send(&frame).await {
            self.shared.pending.lock().await.remove(&id);
            return Err(error);
        }
        response.await.map_err(|_| {
            "Desktop service response was lost; effect outcome is unknown".to_owned()
        })?
    }
    pub async fn respond(&self, id: &str, result: Reply) -> Result<(), String> {
        if !host_codec::valid_id(id, "host") || !self.shared.callbacks.lock().await.remove(id) {
            return Err("Unknown Host callback identity".into());
        }
        let frame = match result {
            Ok(value) => {
                json!({"protocol":PROTOCOL,"version":1,"kind":"response","id":id,"ok":true,"result":value})
            }
            Err(_) => {
                json!({"protocol":PROTOCOL,"version":1,"kind":"response","id":id,"ok":false,"error":{"code":"DESKTOP_ACTION_FAILED","message":"Desktop action failed"}})
            }
        };
        self.shared.writer.send(&frame).await
    }
    pub async fn event(&self, event: &str, payload: Value) -> Result<(), String> {
        self.shared.writer.send(&json!({"protocol":PROTOCOL,"version":1,"kind":"event","event":event,"payload":payload})).await
    }
    pub async fn disconnect(&self, reason: &str) {
        fail(&self.shared, reason).await;
    }
    pub async fn stop(&self) -> Result<(), String> {
        let _guard = self.shared.stopping.lock().await;
        let exited = self.snapshot();
        if exited.phase == HostPhase::Exited {
            return self.clean_exit(exited);
        }
        if let Err(error) = self.request("stop", Value::Null).await {
            self.shared.snapshot.send_modify(|s| {
                if s.phase != HostPhase::Exited {
                    s.phase = HostPhase::Failed;
                }
                s.error
                    .get_or_insert_with(|| "Desktop service drain was not confirmed".into());
            });
            return Err(error);
        }
        let mut observed = self.subscribe();
        loop {
            let snapshot = observed.borrow_and_update().clone();
            if snapshot.phase == HostPhase::Exited {
                return self.clean_exit(snapshot);
            }
            observed
                .changed()
                .await
                .map_err(|_| "Desktop service termination is unknown")?;
        }
    }
    fn clean_exit(&self, snapshot: HostSnapshot) -> Result<(), String> {
        if snapshot.exit_code == Some(0)
            && snapshot.error.is_none()
            && self.shared.drained.load(Ordering::Acquire)
        {
            Ok(())
        } else {
            Err(snapshot
                .error
                .unwrap_or("Desktop service did not confirm a clean drain and exit".into()))
        }
    }
}

async fn accept(
    shared: &Shared,
    frame: host_codec::DecodedFrame,
    mode: HostMode,
) -> Result<(), &'static str> {
    let value = frame.value;
    match value["kind"].as_str() {
        Some("response") => {
            let id = value["id"]
                .as_str()
                .filter(|id| host_codec::valid_id(id, "shell"))
                .ok_or("Invalid desktop response direction")?;
            let pending = shared
                .pending
                .lock()
                .await
                .remove(id)
                .ok_or("Unknown desktop response identity")?;
            let result = if value["ok"] == true {
                if pending.method == "stop" {
                    if value["result"]["stopped"] != true {
                        return Err("Desktop service did not confirm stop");
                    }
                    shared.stop_acknowledged.store(true, Ordering::Release);
                }
                Ok(value["result"].clone())
            } else {
                Err(value["error"]["message"]
                    .as_str()
                    .unwrap_or("Desktop service request failed")
                    .to_owned())
            };
            let _ = pending.reply.send(result);
            return Ok(());
        }
        Some("event") if value["event"] == "ready" => {
            let payload = &value["payload"];
            let (origin, token) = if mode == HostMode::Browser {
                if payload["mode"] != "browser"
                    || payload.get("origin").is_some()
                    || payload.get("clientToken").is_some()
                {
                    return Err("Browser-only service returned Host credentials");
                }
                (None, None)
            } else {
                let origin = payload["origin"]
                    .as_str()
                    .filter(|origin| {
                        url::Url::parse(origin).is_ok_and(|url| {
                            url.scheme() == "http"
                                && matches!(
                                    url.host_str(),
                                    Some("127.0.0.1" | "localhost" | "[::1]")
                                )
                                && url.port().is_some()
                                && url.username().is_empty()
                                && url.password().is_none()
                                && url.query().is_none()
                                && url.fragment().is_none()
                                && url.path() == "/"
                        })
                    })
                    .ok_or("Desktop Host returned an invalid local origin")?;
                let token = payload["clientToken"]
                    .as_str()
                    .filter(|token| !token.is_empty())
                    .ok_or("Desktop Host returned no local credential")?;
                (Some(origin.to_owned()), Some(token.to_owned()))
            };
            let phase = shared.snapshot.borrow().phase;
            if phase == HostPhase::Stopping {
                return Ok(());
            }
            if phase != HostPhase::Starting {
                return Err("Desktop service repeated readiness");
            }
            shared.snapshot.send_modify(|s| {
                s.phase = HostPhase::Ready;
                s.origin = origin;
                s.client_token = token;
            });
            return Ok(());
        }
        Some("event") if value["event"] == "stopping" => {
            shared
                .snapshot
                .send_modify(|s| s.phase = HostPhase::Stopping);
            return Ok(());
        }
        Some("event") if value["event"] == "stopped" => {
            shared.drained.store(true, Ordering::Release);
            return Ok(());
        }
        Some("event") if value["event"] == "failed" => {
            return Err("Desktop service failed; original data was retained");
        }
        Some("request") => {
            let id = value["id"]
                .as_str()
                .filter(|id| host_codec::valid_id(id, "host"))
                .ok_or("Invalid Host callback direction")?;
            if !shared.callbacks.lock().await.insert(id.to_owned()) {
                return Err("Duplicate Host callback identity");
            }
        }
        Some("event") => {}
        _ => return Err("Invalid desktop service frame"),
    }
    if *shared.writer.close.borrow() {
        return Err("Desktop service callback transport closed");
    }
    let priority = frame.bytes <= host_codec::CHUNK_BYTES && priority_callback(&value);
    let (lane, slots, queue) = if priority {
        (
            &shared.control_event_budget,
            &shared.control_event_slots,
            &shared.priority_events,
        )
    } else {
        (&shared.event_budget, &shared.event_slots, &shared.events)
    };
    // Never park the sole decoder behind an occupied effect: it must still read
    // that effect's close/cancel/ACK. Overflow is an explicit transport failure,
    // never a dropped callback or an invented successful cancellation.
    let slot = slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Desktop service callback count exceeded")?;
    let budget = lane
        .clone()
        .try_acquire_many_owned(frame.bytes.max(1) as u32)
        .map_err(|_| "Desktop service callback memory budget exceeded")?;
    let events = queue
        .lock()
        .await
        .clone()
        .ok_or("Desktop service callback owner disconnected")?;
    events
        .try_send(HostMessage {
            frame: value,
            _budget: budget,
            _slot: slot,
        })
        .map_err(|_| "Desktop service callback queue exhausted or disconnected")
}
fn priority_callback(value: &Value) -> bool {
    if value["kind"] != "request" {
        return false;
    }
    matches!(
        value["method"].as_str(),
        Some(
            "network.ack"
                | "network.cancel"
                | "network.release"
                | "browser.stop"
                | "browser.close"
                | "browser.detach"
                | "browser.download.cancel"
                | "browser.releaseCapture"
                | "companion.close"
        )
    ) || value["method"] == "browser.command"
        && matches!(
            value["params"]["method"].as_str(),
            Some("Runtime.terminateExecution" | "Page.stopLoading")
        )
}
async fn fail(shared: &Shared, message: &str) {
    let _ = shared.scope.terminate();
    shared.snapshot.send_modify(|s| {
        if s.phase != HostPhase::Exited {
            s.phase = HostPhase::Failed;
        }
        s.error.get_or_insert_with(|| message.to_owned());
    });
    for (_, pending) in shared.pending.lock().await.drain() {
        let _ = pending.reply.send(Err(
            "Desktop service observation failed; outstanding effect outcomes are unknown".into(),
        ));
    }
    shared.writer.stop();
    shared.event_budget.close();
    shared.control_event_budget.close();
    shared.events.lock().await.take();
    shared.priority_events.lock().await.take();
    shared.event_slots.close();
    shared.control_event_slots.close();
    shared.callbacks.lock().await.clear();
}
async fn bounded_line<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<Vec<u8>>, ()> {
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf().await.map_err(|_| ())?;
        if buffer.is_empty() {
            return if line.is_empty() { Ok(None) } else { Err(()) };
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(buffer.len(), |index| index + 1);
        if line.len() + take > host_codec::LINE_BYTES + 1 {
            return Err(());
        }
        line.extend_from_slice(&buffer[..take]);
        reader.consume(take);
        if newline.is_some() {
            line.pop();
            return Ok(Some(line));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    const FIXTURE: &str = r#"
import readline from 'node:readline';
const envelope={protocol:'varin-desktop-host',version:1};
let serial=0;
async function send(frame){
  const body=Buffer.from(JSON.stringify({...envelope,...frame}));
  const write=line=>new Promise((resolve,reject)=>process.stdout.write(line+'\n',error=>error?reject(error):resolve()));
  if(body.length<=65536)return write(body.toString());
  const id='host:chunk'+(++serial);let offset=0,sequence=0;
  while(offset<body.length){let end=Math.min(offset+65536,body.length);while(end<body.length&&(body[end]&0xc0)===0x80)end--;
    await write(JSON.stringify({...envelope,kind:'chunk',id,sequence:sequence++,totalBytes:body.length,final:end===body.length,data:body.subarray(offset,end).toString()}));offset=end;}
}
const reply=(id,result)=>send({kind:'response',id,ok:true,result});
const stopped=()=>send({kind:'event',event:'stopped',payload:null});
const assemblies=new Map();
let onFrame=async()=>{},onEnd=async()=>{await stopped();process.exit(0)};
readline.createInterface({input:process.stdin}).on('line',line=>{
  let frame=JSON.parse(line);
  if(frame.kind==='chunk'){let value=assemblies.get(frame.id)||'';value+=frame.data;assemblies.set(frame.id,value);if(!frame.final)return;assemblies.delete(frame.id);frame=JSON.parse(value)}
  Promise.resolve(onFrame(frame)).catch(()=>process.exit(19));
}).on('close',()=>{Promise.resolve(onEnd()).catch(()=>process.exit(20))});
await send({kind:'event',event:'ready',payload:{mode:'browser',pid:process.pid}});
"#;
    fn fixture(extra: &str) -> (tempfile::TempDir, HostProcess) {
        let directory = tempfile::tempdir().unwrap();
        let entry = directory.path().join("service.mjs");
        std::fs::write(&entry, format!("{FIXTURE}\n{extra}")).unwrap();
        let node = std::env::var_os("VARIN_TEST_NODE_PATH").unwrap_or_else(|| "node".into());
        let process = HostProcess::spawn_command(
            Path::new(&node),
            &entry,
            directory.path(),
            HostMode::Browser,
            &[],
        )
        .unwrap();
        (directory, process)
    }
    async fn exited(process: &HostProcess) -> HostSnapshot {
        let mut state = process.subscribe();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let snapshot = state.borrow_and_update().clone();
                if snapshot.phase == HostPhase::Exited {
                    return snapshot;
                }
                state.changed().await.unwrap();
            }
        })
        .await
        .expect("original Node process must actually exit")
    }
    #[tokio::test]
    async fn stop_waits_for_original_process_after_drain_receipt() {
        let (_directory, process) = fixture(
            r#"onFrame=async frame=>{if(frame.method==='stop'){await stopped();await reply(frame.id,{stopped:true});setTimeout(()=>process.exit(0),160)}}"#,
        );
        let mut events = process.take_events().await.unwrap();
        assert!(process.take_events().await.is_err());
        let ready = process.ready().await.unwrap();
        assert!(ready.origin.is_none());
        assert!(ready.client_token.is_none());
        let start = std::time::Instant::now();
        process.stop().await.unwrap();
        assert!(start.elapsed() >= Duration::from_millis(120));
        assert!(events.recv().await.is_none());
        assert_eq!(process.snapshot().exit_code, Some(0));
    }
    #[tokio::test]
    async fn unexpected_exit_is_not_successful_stop() {
        let (_directory, process) = fixture("setTimeout(()=>process.exit(13),80)");
        process.ready().await.unwrap();
        assert_eq!(exited(&process).await.exit_code, Some(13));
        assert!(process.stop().await.is_err());
    }
    #[tokio::test]
    async fn callbacks_are_lossless_and_private_large_values_roundtrip() {
        let (_directory, process) = fixture(
            r#"
let waiting;
onFrame=async frame=>{
 if(frame.method==='roundtrip'){waiting=frame.id;await send({kind:'request',id:'host:callback',method:'native.fixture',params:frame.params})}
 else if(frame.kind==='response'&&frame.id==='host:callback'){await reply(waiting,frame.result)}
 else if(frame.method==='events'){for(let i=0;i<200;i++)await send({kind:'event',event:'fixture',payload:i});await reply(frame.id,true)}
 else if(frame.method==='stop'){await stopped();await reply(frame.id,{stopped:true});process.exit(0)}
};"#,
        );
        let mut events = process.take_events().await.unwrap();
        process.ready().await.unwrap();
        let copy = process.clone();
        let value = json!({"text":"😀中文".repeat(30000)});
        let expected = value.clone();
        let request = tokio::spawn(async move { copy.request("roundtrip", value).await });
        let callback = events.recv().await.unwrap();
        assert_eq!(callback.frame()["params"], expected);
        process
            .respond("host:callback", Ok(expected.clone()))
            .await
            .unwrap();
        drop(callback);
        assert_eq!(request.await.unwrap().unwrap(), expected);
        assert!(
            process
                .respond("host:callback", Ok(Value::Null))
                .await
                .is_err()
        );
        let copy = process.clone();
        let request = tokio::spawn(async move { copy.request("events", Value::Null).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        for index in 0..200 {
            let event = events.recv().await.unwrap();
            assert_eq!(event.frame()["payload"], index)
        }
        assert_eq!(request.await.unwrap().unwrap(), true);
        process.stop().await.unwrap();
    }
    #[tokio::test]
    async fn disconnect_unblocks_full_callback_queue_and_observes_real_exit() {
        let (_directory, process) = fixture(
            r#"
onFrame=async frame=>{if(frame.method==='flood'){for(let i=0;i<200;i++)await send({kind:'event',event:'fixture',payload:i})}};
onEnd=async()=>{setTimeout(()=>process.exit(0),100)};
process.stdout.on('error',()=>{});
"#,
        );
        let _events = process.take_events().await.unwrap();
        process.ready().await.unwrap();
        let copy = process.clone();
        let request = tokio::spawn(async move { copy.request("flood", Value::Null).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        process.disconnect("Native callback queue failed").await;
        assert!(request.await.unwrap().is_err());
        let state = exited(&process).await;
        assert!(state.scope_ended);
        assert!(state.error.is_some());
        assert!(process.stop().await.is_err());
    }
    #[tokio::test]
    async fn abrupt_node_exit_ends_original_extension_broker_scope_not_independent_processes() {
        let broker = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../extension-host/broker/broker-child.mjs")
            .canonicalize()
            .unwrap();
        let script = format!(
            r#"
const {{fork}}=await import('node:child_process');
const fs=await import('node:fs');
const {{fileURLToPath}}=await import('node:url');
const extension=new URL('./extension.cjs',import.meta.url);
fs.writeFileSync(extension, 'module.exports.activate=context=>{{setInterval(()=>{{}},1000);context.effect(()=>new Promise(()=>{{}}));}};');
const broker=fork({},[],{{execArgv:[],stdio:['ignore','ignore','ignore','ipc']}});
let activated=false;
broker.once('exit',(code,signal)=>{{if(!activated)void send({{kind:'event',event:'brokerExitedBeforeReady',payload:{{code,signal}}}})}});
broker.on('message',async message=>{{
 if(message.kind==='event'&&message.event==='ready')broker.send({{kind:'request',id:'activate',method:'activate',params:{{modulePath:fileURLToPath(extension),packageRoot:fileURLToPath(new URL('.',import.meta.url)),storage:{{data:{{}},revision:'0'}},dependencies:[]}}}});
 if(message.kind==='response'&&message.id==='activate'){{if(!message.success)process.exit(21);activated=true;await send({{kind:'event',event:'brokerReady',payload:{{pid:broker.pid}}}})}}
}});
onFrame=async frame=>{{if(frame.method==='crash')process.exit(13)}};
"#,
            serde_json::to_string(&broker.to_string_lossy()).unwrap()
        );
        let node = std::env::var_os("VARIN_TEST_NODE_PATH").unwrap_or_else(|| "node".into());
        let mut independent = Command::new(node)
            .arg("-e")
            .arg("setInterval(()=>{},1000)")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let (_directory, process) = fixture(&script);
        let mut events = process.take_events().await.unwrap();
        process.ready().await.unwrap();
        let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.frame()["event"], "brokerReady");
        drop(event);
        assert!(process.request("crash", Value::Null).await.is_err());
        tokio::time::timeout(Duration::from_secs(10), process.wait_for_scope_end())
            .await
            .unwrap()
            .unwrap();
        assert!(process.shared.scope.empty().unwrap());
        assert!(process.snapshot().scope_ended);
        assert!(process.stop().await.is_err());
        assert!(
            independent.try_wait().unwrap().is_none(),
            "unrelated process must remain alive"
        );
        independent.start_kill().unwrap();
        independent.wait().await.unwrap();
    }
    #[tokio::test]
    async fn real_maximum_wire_callback_cannot_block_its_close_callback() {
        let (_directory, process) = fixture(
            r#"
onFrame=async frame=>{
 if(frame.method==='bulk'){
   const bulk={...envelope,kind:'request',id:'host:bulk',method:'browser.command',params:{method:'Runtime.evaluate',payload:''}};
   bulk.params.payload='x'.repeat(64*1024*1024-Buffer.byteLength(JSON.stringify(bulk)));
   await send(bulk);await reply(frame.id,true);
 }else if(frame.method==='closeNow'){
   await send({kind:'request',id:'host:close',method:'browser.close',params:{pageId:'original'}});await reply(frame.id,true);
 }else if(frame.method==='stop'){await stopped();await reply(frame.id,{stopped:true});process.exit(0)}
};"#,
        );
        let mut events = process.take_events().await.unwrap();
        process.ready().await.unwrap();
        tokio::time::timeout(
            Duration::from_secs(20),
            process.request("bulk", Value::Null),
        )
        .await
        .unwrap()
        .unwrap();
        let bulk = events.recv().await.unwrap();
        assert_eq!(bulk.frame()["id"], "host:bulk");
        assert_eq!(process.shared.event_budget.available_permits(), 0);
        let copy = process.clone();
        let closing = tokio::spawn(async move { copy.request("closeNow", Value::Null).await });
        let control = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(control.frame()["id"], "host:close");
        process
            .respond("host:close", Ok(Value::Null))
            .await
            .unwrap();
        drop(control);
        closing.await.unwrap().unwrap();
        process
            .respond("host:bulk", Err("Original invocation closed".into()))
            .await
            .unwrap();
        drop(bulk);
        process.stop().await.unwrap();
    }
    #[tokio::test]
    async fn cancellation_has_a_bounded_lane_while_original_bulk_callback_is_held() {
        let (_directory, process) = fixture(
            r#"onFrame=async frame=>{if(frame.method==='stop'){await stopped();await reply(frame.id,{stopped:true});process.exit(0)}}"#,
        );
        let mut events = process.take_events().await.unwrap();
        process.ready().await.unwrap();
        let bulk = json!({"protocol":PROTOCOL,"version":1,"kind":"request","id":"host:bulk","method":"browser.command","params":{"method":"Runtime.evaluate"}});
        accept(
            &process.shared,
            host_codec::DecodedFrame {
                value: bulk,
                bytes: MESSAGE_BYTES,
            },
            HostMode::Browser,
        )
        .await
        .unwrap();
        let held = events.recv().await.unwrap();
        let cancel = json!({"protocol":PROTOCOL,"version":1,"kind":"request","id":"host:cancel","method":"browser.close","params":{"pageId":"original"}});
        tokio::time::timeout(
            Duration::from_secs(1),
            accept(
                &process.shared,
                host_codec::DecodedFrame {
                    value: cancel.clone(),
                    bytes: 200,
                },
                HostMode::Browser,
            ),
        )
        .await
        .unwrap()
        .unwrap();
        let control = events.recv().await.unwrap();
        assert_eq!(control.frame(), &cancel);
        assert!(!priority_callback(
            &json!({"kind":"request","method":"browser.command","params":{"method":"Runtime.evaluate"}})
        ));
        assert!(!priority_callback(
            &json!({"kind":"request","method":"network.start"})
        ));
        drop(control);
        drop(held);
        process.stop().await.unwrap();
    }
    #[tokio::test]
    async fn bounded_reader_rejects_partial_eof_and_long_lines() {
        let mut partial = BufReader::new(&b"{\"partial\":true}"[..]);
        assert!(bounded_line(&mut partial).await.is_err());
        let oversized = vec![b'x'; host_codec::LINE_BYTES + 2];
        let mut reader = BufReader::new(&oversized[..]);
        assert!(bounded_line(&mut reader).await.is_err());
        let mut reader = BufReader::new(&b"{}\n"[..]);
        assert_eq!(bounded_line(&mut reader).await.unwrap().unwrap(), b"{}");
        assert!(bounded_line(&mut reader).await.unwrap().is_none());
    }
}
