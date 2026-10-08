//! One native process service for PTYs and protocol pipes. Per-process guardians
//! are private instances of this executable, not Host/Pi processes or authorities.
//! The kernel owns grants, durable identities, admission and raw byte cursors.
pub(crate) mod platform;
pub(crate) mod subscriptions;
pub(crate) mod worker;
use crate::{
    error::KernelError,
    protocol::{hash_json, read_frame, write_frame},
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        mpsc::{self, SyncSender},
        Arc, Condvar, Mutex, Weak,
    },
    thread,
    time::{Duration, Instant},
};

pub(crate) const CHUNK_BYTES: usize = 64 * 1024;
/// Produced only by the owning guardian control reader, never by a frontend/model message.
#[derive(Debug, Clone)]
pub(crate) struct ProcessTerminal {
    pub process_id: String,
    pub kernel_epoch: String,
    pub receipt: Value,
}
#[derive(Default)]
struct Buffer {
    read_position: u64,
    frame_start: u64,
    file_end: u64,
    output_closed: bool,
    output_error: Option<String>,
    base: u64,
    end: u64,
    closed: bool,
    discard: bool,
    pid: Option<u32>,
    receipt: Option<Value>,
    control_error: Option<String>,
    input_sequence: i64,
    queued_sequence: i64,
    input_hash: String,
    input_error: Option<String>,
}
struct Shared {
    buffer: Mutex<Buffer>,
    changed: Condvar,
    publication: Mutex<()>,
}
impl Shared {
    fn new() -> Self {
        Self {
            buffer: Mutex::new(Buffer {
                input_sequence: -1,
                queued_sequence: -1,
                ..Buffer::default()
            }),
            changed: Condvar::new(),
            publication: Mutex::new(()),
        }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, Buffer> {
        self.buffer
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
}
struct ControlState {
    ready: bool,
    terminal: bool,
    requested: u8,
}
struct ProcessControl {
    guardian: Arc<Mutex<Child>>,
    containment: Arc<platform::Containment>,
    input: Arc<Mutex<Option<SyncSender<Value>>>>,
    native_run_id: Option<String>,
    state: Mutex<ControlState>,
}
impl ProcessControl {
    fn apply(&self, state: &ControlState) -> Result<bool, KernelError> {
        if state.terminal || !state.ready || state.requested == 0 {
            return Ok(false);
        }
        let mut guardian = self
            .guardian
            .lock()
            .map_err(|_| failure("guardian control poisoned"))?;
        if guardian.try_wait()?.is_some() {
            return Ok(false);
        }
        #[cfg(unix)]
        self.containment.terminate(&guardian, state.requested > 1)?;
        #[cfg(windows)]
        self.input
            .lock()
            .map_err(|_| failure("guardian input poisoned"))?
            .as_ref()
            .ok_or_else(|| failure("guardian input closed"))?
            .try_send(json!({"type":"stop","force":state.requested>1}))
            .map_err(|_| failure("guardian control backpressure; stop remains requested"))?;
        Ok(true)
    }
    fn stop(&self, force: bool) -> Result<bool, KernelError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| failure("guardian control poisoned"))?;
        if state.terminal {
            return Ok(false);
        }
        state.requested = state.requested.max(if force { 2 } else { 1 });
        self.apply(&state)?;
        // Before readiness this is an owned stop request, not a claim the target has stopped.
        Ok(true)
    }
    fn ready(&self) -> Result<(), KernelError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| failure("guardian control poisoned"))?;
        state.ready = true;
        self.apply(&state)?;
        Ok(())
    }
    fn terminal(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.terminal = true;
        }
    }
    fn stopped(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.terminal)
            .unwrap_or(false)
    }
    fn stop_requested(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.requested > 0)
            .unwrap_or(true)
    }
}
#[derive(Default)]
struct Controls {
    live: HashMap<String, Weak<ProcessControl>>,
    pending: HashMap<String, (String, bool)>,
}
/// Fast control references to the same live guardians, not another process authority. No PID
/// loaded from disk is ever signalled. Pending markers require a Catalog-verified native owner.
#[derive(Clone, Default)]
pub(crate) struct ProcessControlRegistry(Arc<Mutex<Controls>>);
impl ProcessControlRegistry {
    pub(crate) fn cancel_known_process(&self, id: &str) -> Result<bool, KernelError> {
        let control = self
            .0
            .lock()
            .map_err(|_| failure("process controls poisoned"))?
            .live
            .get(id)
            .and_then(Weak::upgrade);
        match control {
            Some(control) if control.native_run_id.is_some() => control.stop(true),
            _ => Ok(false),
        }
    }
    pub(crate) fn cancel_process(&self, id: &str, run_id: &str) -> Result<bool, KernelError> {
        let mut controls = self
            .0
            .lock()
            .map_err(|_| failure("process controls poisoned"))?;
        if let Some(control) = controls.live.get(id).and_then(Weak::upgrade) {
            if control.native_run_id.as_deref() != Some(run_id) {
                return Err(KernelError::Authorization(
                    "process control Run does not match operation owner".into(),
                ));
            }
            drop(controls);
            return control.stop(true);
        }
        if controls
            .pending
            .get(id)
            .is_some_and(|(owner, _)| owner != run_id)
        {
            return Err(KernelError::Authorization(
                "pending process stop belongs to another Run".into(),
            ));
        }
        controls.pending.insert(id.into(), (run_id.into(), true));
        Ok(false)
    }
    fn register(&self, id: &str, control: &Arc<ProcessControl>) -> Result<(), KernelError> {
        let mut controls = self
            .0
            .lock()
            .map_err(|_| failure("process controls poisoned"))?;
        if let Some((run_id, force)) = controls.pending.get(id) {
            if control.native_run_id.as_deref() != Some(run_id.as_str()) {
                return Err(KernelError::Authorization(
                    "pending process stop owner mismatch".into(),
                ));
            }
            control.stop(*force)?;
        }
        controls.pending.remove(id);
        controls.live.insert(id.into(), Arc::downgrade(control));
        Ok(())
    }
    fn release(&self, id: &str) {
        if let Ok(mut controls) = self.0.lock() {
            controls.live.remove(id);
            controls.pending.remove(id);
        }
    }
}
struct LiveProcess {
    guardian: Arc<Mutex<Child>>,
    containment: Arc<platform::Containment>,
    input: Arc<Mutex<Option<SyncSender<Value>>>>,
    control: Arc<ProcessControl>,
    shared: Arc<Shared>,
    guardian_exited: bool,
    output_path: PathBuf,
}
#[derive(Clone)]
struct OutputHandle {
    shared: Arc<Shared>,
    output_path: PathBuf,
    cursor: Arc<Mutex<SpoolCursor>>,
}
#[derive(Clone, Default)]
struct SpoolCursor {
    base: u64,
    read_position: u64,
    frame_start: u64,
}
#[derive(Default)]
pub(crate) struct ProcessManager {
    outputs: HashMap<String, OutputHandle>,
    live: HashMap<String, LiveProcess>,
    terminal: Option<mpsc::Sender<ProcessTerminal>>,
    controls: ProcessControlRegistry,
    subscriptions: Option<subscriptions::ProcessSubscriptions>,
}
fn failure(message: impl Into<String>) -> KernelError {
    KernelError::Operation(message.into())
}
pub(crate) fn receipt_path(root: &Path, process_id: &str) -> PathBuf {
    root.join("process-receipts").join(format!(
        "{}.json",
        hex::encode(Sha256::digest(process_id.as_bytes()))
    ))
}
pub(crate) fn output_path(root: &Path, process_id: &str) -> PathBuf {
    receipt_path(root, process_id).with_extension("output")
}
pub(crate) fn output_marker_path(root: &Path, process_id: &str) -> PathBuf {
    receipt_path(root, process_id).with_extension("output.complete")
}
pub(crate) fn job_name(root: &Path, process_id: &str) -> String {
    format!(
        "Local\\Varin-{}",
        hex::encode(Sha256::digest(
            format!("{}\0{process_id}", root.display()).as_bytes()
        ))
    )
}
pub(crate) fn read_receipt(
    root: &Path,
    process_id: &str,
    epoch: &str,
) -> Result<Option<Value>, KernelError> {
    let raw = match std::fs::read(receipt_path(root, process_id)) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let value: Value = serde_json::from_slice(&raw)?;
    if value["processId"].as_str() != Some(process_id)
        || value["kernelEpoch"].as_str() != Some(epoch)
        || value["treeConfirmed"].as_bool() != Some(true)
        || !matches!(value["status"].as_str(), Some("exited" | "failed"))
    {
        return Err(failure("process exit receipt identity is invalid"));
    }
    Ok(Some(value))
}
impl ProcessManager {
    pub(crate) fn set_subscriptions(&mut self, subscriptions: subscriptions::ProcessSubscriptions) {
        self.subscriptions = Some(subscriptions);
    }
    pub(crate) fn subscribe(
        &self,
        id: &str,
        process_id: &str,
        grant_id: &str,
        epoch: &str,
        cursor: u64,
        snapshot: Value,
    ) -> Result<Value, KernelError> {
        let output = self
            .outputs
            .get(process_id)
            .ok_or_else(|| failure("process output storage unavailable"))?
            .clone();
        self.subscriptions
            .as_ref()
            .ok_or_else(|| failure("process subscriptions are unavailable"))?
            .subscribe(
                id,
                process_id,
                grant_id,
                epoch,
                cursor,
                snapshot,
                output,
                self.live.contains_key(process_id),
            )
    }
    pub(crate) fn set_controls(&mut self, controls: ProcessControlRegistry) {
        self.controls = controls;
    }
    /// Reopen retained log bytes only. A complete log is not evidence that a process tree stopped.
    pub(crate) fn restore_output(
        &mut self,
        root: &Path,
        id: &str,
        epoch: &str,
    ) -> Result<Value, KernelError> {
        if !self.outputs.contains_key(id) {
            let path = output_path(root, id);
            let mut file = match File::open(&path) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    return Ok(
                        json!({"outputAvailable":false,"outputComplete":false,"outputError":"retained process output is missing"}),
                    );
                }
                Err(error) => return Err(error.into()),
            };
            let length = file.metadata()?.len();
            let mut position = 0u64;
            let mut end = 0u64;
            let mut truncated = false;
            while position < length {
                if length - position < 5 {
                    truncated = true;
                    break;
                }
                file.seek(SeekFrom::Start(position))?;
                let mut header = [0u8; 5];
                file.read_exact(&mut header)?;
                let count = u32::from_le_bytes(header[..4].try_into().expect("header")) as u64;
                if count == 0 || count > CHUNK_BYTES as u64 || !matches!(header[4], 1 | 2) {
                    return Err(failure("retained output frame is corrupt"));
                }
                if length - position - 5 < count {
                    truncated = true;
                    break;
                }
                end = end
                    .checked_add(count)
                    .ok_or_else(|| failure("retained output cursor overflow"))?;
                position += 5 + count;
            }
            let marker = match std::fs::read(output_marker_path(root, id)) {
                Ok(bytes) => Some(serde_json::from_slice::<Value>(&bytes)?),
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
            };
            let complete = if let Some(marker) = marker {
                if truncated
                    || marker["processId"].as_str() != Some(id)
                    || marker["kernelEpoch"].as_str() != Some(epoch)
                    || marker["fileBytes"].as_u64() != Some(length)
                    || marker["endCursor"].as_u64() != Some(end)
                    || marker["complete"].as_bool() != Some(true)
                {
                    return Err(failure(
                        "retained output completion marker is corrupt or mismatched",
                    ));
                }
                true
            } else {
                false
            };
            let shared = Arc::new(Shared::new());
            {
                let mut buffer = shared.lock();
                buffer.end = end;
                buffer.file_end = position;
                buffer.output_closed = true;
                if !complete {
                    buffer.output_error = Some(
                        if truncated {
                            "process output capture was interrupted in a frame"
                        } else {
                            "process output capture ended without a durable completion marker"
                        }
                        .into(),
                    );
                }
            }
            self.outputs.insert(
                id.into(),
                OutputHandle {
                    shared,
                    output_path: path,
                    cursor: Arc::new(Mutex::new(SpoolCursor::default())),
                },
            );
        }
        let buffer = self.outputs.get(id).expect("restored output").shared.lock();
        Ok(
            json!({"outputAvailable":true,"outputComplete":buffer.output_closed&&buffer.output_error.is_none(),"outputError":buffer.output_error}),
        )
    }
    pub(crate) fn set_terminal_sender(&mut self, terminal: mpsc::Sender<ProcessTerminal>) {
        self.terminal = Some(terminal);
    }
    pub(crate) fn replay_terminal(&self, process_id: &str, kernel_epoch: &str, receipt: Value) {
        if let Some(sender) = &self.terminal {
            let _ = sender.send(ProcessTerminal {
                process_id: process_id.into(),
                kernel_epoch: kernel_epoch.into(),
                receipt,
            });
        }
    }
    pub(crate) fn spawn(&mut self, id: &str, config: Value) -> Result<(), KernelError> {
        if self.live.contains_key(id) {
            return Err(failure("process identity is already live"));
        }
        let mut command = Command::new(std::env::current_exe()?);
        command
            .arg("--process-worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Guardian stderr is a private framed data stream; stdout is control-only.
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut guardian = command.spawn()?;
        let containment = match platform::Containment::admit(
            config["jobName"].as_str().unwrap_or_default(),
            &guardian,
        ) {
            Ok(containment) => containment,
            Err(error) => {
                let _ = guardian.kill();
                let _ = guardian.wait();
                return Err(error.into());
            }
        };
        let mut stdin = guardian
            .stdin
            .take()
            .ok_or_else(|| failure("guardian stdin missing"))?;
        let mut stdout = guardian
            .stdout
            .take()
            .ok_or_else(|| failure("guardian stdout missing"))?;
        let mut data = guardian
            .stderr
            .take()
            .ok_or_else(|| failure("guardian data pipe missing"))?;
        let spool_path = PathBuf::from(
            config["receiptPath"]
                .as_str()
                .ok_or_else(|| failure("receipt path missing"))?,
        )
        .with_extension("output");
        let mut spool = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&spool_path)
        {
            Ok(file) => file,
            Err(error) => {
                let _ = guardian.kill();
                let _ = guardian.wait();
                return Err(error.into());
            }
        };
        let process_id = id.to_string();
        let kernel_epoch = config["kernelEpoch"]
            .as_str()
            .ok_or_else(|| failure("kernel epoch missing"))?
            .to_string();
        let terminal = self.terminal.clone();
        let data_process_id = process_id.clone();
        let data_epoch = kernel_epoch.clone();
        let marker_path = spool_path.with_extension("output.complete");
        let shared = Arc::new(Shared::new());
        let (input, input_rx) = mpsc::sync_channel::<Value>(4);
        let guardian = Arc::new(Mutex::new(guardian));
        let containment = Arc::new(containment);
        let input = Arc::new(Mutex::new(Some(input)));
        let control = Arc::new(ProcessControl {
            guardian: guardian.clone(),
            containment: containment.clone(),
            input: input.clone(),
            native_run_id: config["nativeRunId"].as_str().map(str::to_owned),
            state: Mutex::new(ControlState {
                ready: false,
                terminal: false,
                requested: 0,
            }),
        });
        if let Err(error) = self.controls.register(id, &control) {
            if let Ok(mut child) = guardian.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Err(error);
        }
        let writer_shared = shared.clone();
        thread::spawn(move || {
            // This is the first message; the guardian cannot spawn before it.
            let result = write_frame(&mut stdin, &config).and_then(|_| {
                for event in input_rx {
                    write_frame(&mut stdin, &event)?;
                }
                Ok(())
            });
            if result.is_err() {
                writer_shared.lock().control_error =
                    Some("native process control pipe closed".into());
                writer_shared.changed.notify_all();
            }
            // Dropping stdin triggers the guardian's EOF cleanup, even on Host loss.
        });
        let reader_shared = shared.clone();
        let reader_control = control.clone();
        thread::spawn(move || {
            let mut terminal_sent = false;
            let result = (|| -> io::Result<()> {
                while let Some(frame) = read_frame(&mut stdout)? {
                    let value: Value = serde_json::from_slice(&frame)?;
                    match value["type"].as_str() {
                        Some("ready") => reader_control.ready().map_err(io::Error::other)?,
                        Some("started") => {
                            reader_shared.lock().pid = value["pid"].as_u64().map(|pid| pid as u32)
                        }
                        Some("receipt") => {
                            let receipt = &value["value"];
                            if receipt["processId"].as_str() != Some(process_id.as_str())
                                || receipt["kernelEpoch"].as_str() != Some(kernel_epoch.as_str())
                                || receipt["treeConfirmed"].as_bool() != Some(true)
                                || !matches!(receipt["status"].as_str(), Some("exited" | "failed"))
                            {
                                return Err(io::Error::other("invalid native terminal receipt"));
                            }
                            reader_control.terminal();
                            reader_shared.lock().receipt = Some(receipt.clone());
                            if !terminal_sent {
                                if let Some(sender) = &terminal {
                                    let _ = sender.send(ProcessTerminal {
                                        process_id: process_id.clone(),
                                        kernel_epoch: kernel_epoch.clone(),
                                        receipt: receipt.clone(),
                                    });
                                }
                                terminal_sent = true;
                            }
                        }
                        Some("input") => {
                            let mut buffer = reader_shared.lock();
                            buffer.input_sequence = value["sequence"].as_i64().unwrap_or(-1);
                            buffer.input_error = value["error"].as_str().map(str::to_string);
                        }
                        Some("output-error") => {
                            reader_shared.lock().output_error =
                                Some("native output stream failed; log may be incomplete".into())
                        }
                        Some("control-error") => {
                            reader_shared.lock().control_error =
                                Some("native PTY control failed".into())
                        }
                        _ => return Err(io::Error::other("invalid native control event")),
                    }
                    reader_shared.changed.notify_all();
                }
                Ok(())
            })();
            {
                let mut buffer = reader_shared.lock();
                if result.is_err() {
                    buffer.control_error =
                        Some("native control stream ended without a complete frame".into());
                }
                buffer.closed = true;
                reader_shared.changed.notify_all();
            }
            if !terminal_sent {
                if let Some(sender) = &terminal {
                    let _ = sender.send(ProcessTerminal {
                    process_id:process_id.clone(), kernel_epoch:kernel_epoch.clone(),
                    receipt:json!({"processId":process_id,"kernelEpoch":kernel_epoch,"status":"unknown",
                        "treeConfirmed":false,"reason":"guardian control closed without a terminal receipt"}) });
                }
            }
            if result.is_ok() {
                // Only normal EOF from this trusted guardian means its stdout owner exited.
                // Reap the same Child here; native callback users need not poll observation.
                if let Ok(mut guardian) = reader_control.guardian.lock() {
                    let _ = guardian.wait();
                }
            }
        });
        let data_shared = shared.clone();
        thread::spawn(move || {
            let result = (|| -> io::Result<()> {
                while let Some(frame) = read_frame(&mut data)? {
                    let value: Value = serde_json::from_slice(&frame)?;
                    if value["type"] != "output" {
                        return Err(io::Error::other("invalid native data event"));
                    }
                    let bytes = BASE64
                        .decode(value["bytesBase64"].as_str().unwrap_or_default())
                        .map_err(io::Error::other)?;
                    if bytes.is_empty() || bytes.len() > CHUNK_BYTES {
                        return Err(io::Error::other("invalid native output chunk size"));
                    }
                    let channel = match value["channel"].as_str() {
                        Some("stdout") => 1u8,
                        Some("stderr") => 2u8,
                        _ => return Err(io::Error::other("invalid native output channel")),
                    };
                    if data_shared.lock().discard {
                        continue;
                    }
                    // Disk I/O never holds the control-state mutex. A slow disk cannot hold the
                    // terminal/ack reader hostage; complete log bytes are not a UI RAM queue.
                    spool.write_all(&(bytes.len() as u32).to_le_bytes())?;
                    spool.write_all(&[channel])?;
                    spool.write_all(&bytes)?;
                    let position = spool.stream_position()?;
                    let mut buffer = data_shared.lock();
                    buffer.end = buffer
                        .end
                        .checked_add(bytes.len() as u64)
                        .ok_or_else(|| io::Error::other("process output cursor overflow"))?;
                    buffer.file_end = position;
                    data_shared.changed.notify_all();
                }
                spool.sync_data()?;
                let (end, file_end, discarded) = {
                    let buffer = data_shared.lock();
                    (buffer.end, buffer.file_end, buffer.discard)
                };
                let _publication = data_shared
                    .publication
                    .lock()
                    .map_err(|_| io::Error::other("output publication poisoned"))?;
                let released = data_shared.lock().discard;
                if !discarded && !released {
                    let temporary = marker_path.with_extension("complete.tmp");
                    let mut marker = File::create(&temporary)?;
                    marker.write_all(
                        serde_json::to_string(
                            &json!({"processId":data_process_id,"kernelEpoch":data_epoch,
                        "endCursor":end,"fileBytes":file_end,"complete":true}),
                        )?
                        .as_bytes(),
                    )?;
                    marker.sync_all()?;
                    drop(marker);
                    crate::storage::durable_rename(&temporary, &marker_path)?;
                    if let Some(parent) = marker_path.parent() {
                        crate::storage::sync_directory(parent)?;
                    }
                }
                Ok(())
            })();
            if result.is_err() {
                let _ = std::fs::remove_file(marker_path.with_extension("complete.tmp"));
            }
            let mut buffer = data_shared.lock();
            if let Err(error) = result {
                buffer.output_error = Some(format!(
                    "process output storage failed; log is incomplete: {error}"
                ));
            }
            buffer.output_closed = true;
            data_shared.changed.notify_all();
            // Closing a failed data pipe makes guardian readers request stopping and drain/discard
            // remaining target output. No successful complete-log claim is made.
        });
        self.outputs.insert(
            id.into(),
            OutputHandle {
                shared: shared.clone(),
                output_path: spool_path.clone(),
                cursor: Arc::new(Mutex::new(SpoolCursor::default())),
            },
        );
        self.live.insert(
            id.into(),
            LiveProcess {
                guardian,
                containment,
                input,
                control,
                shared,
                guardian_exited: false,
                output_path: spool_path,
            },
        );
        Ok(())
    }
    pub(crate) fn observation(&mut self, id: &str) -> Result<Option<Value>, KernelError> {
        let Some(live) = self.live.get_mut(id) else {
            return Ok(None);
        };
        if !live.guardian_exited
            && live
                .guardian
                .lock()
                .map_err(|_| failure("guardian control poisoned"))?
                .try_wait()?
                .is_some()
        {
            live.guardian_exited = true;
        }
        let buffer = live.shared.lock();
        let mut status = if buffer.pid.is_some() {
            "running"
        } else {
            "starting"
        };
        let mut reason = buffer.control_error.clone();
        let mut exit_code = Value::Null;
        let mut signal = Value::Null;
        if let Some(receipt) = buffer.receipt.as_ref() {
            // A validated, durable tree receipt proves target writers stopped. The guardian may
            // still be draining its separate log pipe; that is not a live workspace writer.
            status = receipt["status"].as_str().unwrap_or("unknown");
            exit_code = receipt["exitCode"].clone();
            signal = receipt["signal"].clone();
            reason = receipt["reason"].as_str().map(str::to_string).or(reason);
        } else if live.guardian_exited && buffer.closed {
            #[cfg(windows)]
            {
                if !live.containment.empty()? {
                    live.control.stop(true)?;
                }
                if live.containment.empty()? {
                    status = "exited";
                    reason = Some("native Job exited; target exit status unavailable".into());
                }
            }
            #[cfg(unix)]
            {
                status = "unknown";
                reason = Some("guardian exited without proof that the process tree stopped".into());
            }
        }
        Ok(Some(
            json!({"status":status, "pid":buffer.pid, "exitCode":exit_code, "signal":signal,
            "reason":reason, "writerActive":!matches!(status,"exited"|"failed"), "outputAvailable":true,
            "outputComplete":buffer.output_closed && buffer.output_error.is_none(),"outputError":buffer.output_error}),
        ))
    }
    pub(crate) fn read(
        &mut self,
        id: &str,
        cursor: u64,
        limit: usize,
    ) -> Result<Value, KernelError> {
        let output = self
            .outputs
            .get(id)
            .ok_or_else(|| failure("process output storage unavailable"))?;
        let mut state = output
            .cursor
            .lock()
            .map_err(|_| failure("output cursor poisoned"))?;
        read_output(output, &mut state, cursor, limit)
    }
    pub(crate) fn write(
        &mut self,
        id: &str,
        sequence: i64,
        bytes: &str,
        eof: bool,
    ) -> Result<Value, KernelError> {
        let live = self
            .live
            .get_mut(id)
            .ok_or_else(|| failure("process handle is not live in this epoch"))?;
        if live.guardian_exited || live.control.stop_requested() {
            return Err(failure("process is stopping or exited"));
        }
        let decoded = BASE64
            .decode(bytes)
            .map_err(|_| failure("stdin bytes are not valid base64"))?;
        if decoded.len() > CHUNK_BYTES {
            return Err(failure("stdin chunk exceeds the native transport bound"));
        }
        let hash = hash_json(&json!({"bytes":bytes,"eof":eof}))?;
        let mut buffer = live.shared.lock();
        if sequence == buffer.queued_sequence && hash == buffer.input_hash {
            return Ok(json!({"queued":true,"sequence":sequence}));
        }
        if sequence != buffer.queued_sequence + 1 || buffer.queued_sequence != buffer.input_sequence
        {
            return Err(failure(
                "process stdin sequence is stale or awaiting its write receipt",
            ));
        }
        live.input
            .lock()
            .map_err(|_| failure("guardian input poisoned"))?
            .as_ref()
            .ok_or_else(|| failure("process input is closed"))?
            .try_send(json!({"type":"write","sequence":sequence,"bytesBase64":bytes,"eof":eof}))
            .map_err(|_| failure("process control backpressure; stdin was not queued"))?;
        buffer.queued_sequence = sequence;
        buffer.input_hash = hash;
        Ok(json!({"queued":true,"sequence":sequence}))
    }
    pub(crate) fn resize(&mut self, id: &str, cols: u16, rows: u16) -> Result<Value, KernelError> {
        let live = self
            .live
            .get(id)
            .ok_or_else(|| failure("process handle is not live in this epoch"))?;
        live.input
            .lock()
            .map_err(|_| failure("guardian input poisoned"))?
            .as_ref()
            .ok_or_else(|| failure("process input is closed"))?
            .try_send(json!({"type":"resize","cols":cols,"rows":rows}))
            .map_err(|_| failure("process control backpressure; resize was not queued"))?;
        Ok(json!({"queued":true}))
    }
    pub(crate) fn kill(&mut self, id: &str, force: bool) -> Result<Value, KernelError> {
        let live = self
            .live
            .get_mut(id)
            .ok_or_else(|| failure("process handle is not live in this epoch"))?;
        let requested = if !live.guardian_exited {
            live.control.stop(force)?
        } else {
            false
        };
        Ok(json!({"requested":requested,"exited":live.control.stopped()}))
    }
    pub(crate) fn release(
        &mut self,
        id: &str,
        cleanup: impl FnOnce() -> Result<(), KernelError>,
    ) -> Result<(), KernelError> {
        let shared = self.outputs.get(id).map(|output| output.shared.clone());
        // Publication is separate from the control-state mutex. Cleanup cannot return while
        // a writer can still resurrect a completion marker, and control/terminal stays live.
        let _publication = shared
            .as_ref()
            .map(|shared| {
                shared
                    .publication
                    .lock()
                    .map_err(|_| failure("output publication poisoned"))
            })
            .transpose()?;
        self.controls.release(id);
        if let Some(subscriptions) = &self.subscriptions {
            subscriptions.close_process(id, "process output released");
        }
        self.outputs.remove(id);
        if let Some(live) = self.live.remove(id) {
            live.shared.lock().discard = true;
        }
        if let Some(shared) = shared.as_ref() {
            shared.lock().discard = true;
        }
        cleanup()
    }
    pub(crate) fn shutdown(&mut self) -> Result<(), KernelError> {
        for live in self.live.values_mut() {
            live.shared.lock().discard = true;
            // EOF is a native guardian stop request, not a fabricated exit.
            if !live.guardian_exited {
                let _ = live.control.stop(true);
            }
            if let Ok(mut input) = live.input.lock() {
                input.take();
            }
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut pending = false;
            let ids: Vec<_> = self.live.keys().cloned().collect();
            for id in ids {
                if self
                    .observation(&id)?
                    .is_some_and(|value| value["writerActive"].as_bool() != Some(false))
                {
                    pending = true;
                }
            }
            if !pending {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(failure(
                    "native process exit remains unconfirmed; durable writers are retained",
                ));
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for ProcessManager {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn read_output(
    live: &OutputHandle,
    cursor_state: &mut SpoolCursor,
    cursor: u64,
    limit: usize,
) -> Result<Value, KernelError> {
    let (
        base,
        end,
        mut position,
        mut frame_start,
        file_end,
        input_sequence,
        input_error,
        output_error,
        output_complete,
    ) = {
        let buffer = live.shared.lock();
        (
            cursor_state.base,
            buffer.end,
            cursor_state.read_position,
            cursor_state.frame_start,
            buffer.file_end,
            buffer.input_sequence,
            buffer.input_error.clone(),
            buffer.output_error.clone(),
            buffer.output_closed && buffer.output_error.is_none(),
        )
    };
    if cursor < base || cursor > end {
        return Err(failure("process output cursor is outside retained bytes"));
    }
    let mut file = File::open(&live.output_path)?;
    let header = |file: &mut File, position: u64| -> Result<(usize, &'static str), KernelError> {
        file.seek(SeekFrom::Start(position))?;
        let mut header = [0u8; 5];
        file.read_exact(&mut header)?;
        let length = u32::from_le_bytes(header[..4].try_into().expect("fixed header")) as usize;
        if length == 0 || length > CHUNK_BYTES {
            return Err(failure("invalid process output storage frame"));
        }
        let channel = match header[4] {
            1 => "stdout",
            2 => "stderr",
            _ => return Err(failure("invalid stored output channel")),
        };
        Ok((length, channel))
    };
    while frame_start < cursor {
        let (length, _) = header(&mut file, position)?;
        if frame_start + length as u64 > cursor {
            break;
        }
        position += 5 + length as u64;
        frame_start += length as u64;
    }
    cursor_state.base = cursor;
    cursor_state.read_position = position;
    cursor_state.frame_start = frame_start;
    let mut chunks = Vec::new();
    let mut remaining = limit;
    let mut next = cursor;
    while remaining > 0 && next < end && position < file_end {
        let (length, channel) = header(&mut file, position)?;
        let skip = (next - frame_start) as usize;
        let count = remaining.min(length - skip);
        file.seek(SeekFrom::Start(position + 5 + skip as u64))?;
        let mut bytes = vec![0u8; count];
        file.read_exact(&mut bytes)?;
        chunks.push(json!({"channel":channel,"offset":next,"bytesBase64":BASE64.encode(bytes)}));
        next += count as u64;
        remaining -= count;
        if skip + count == length {
            position += 5 + length as u64;
            frame_start += length as u64;
        }
    }
    Ok(json!({"chunks":chunks,"nextCursor":next,"endCursor":end,
            "inputSequence":input_sequence,"inputError":input_error,"outputError":output_error,"outputComplete":output_complete}))
}
