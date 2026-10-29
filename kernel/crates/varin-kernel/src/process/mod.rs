//! One native process service for PTYs and protocol pipes. Per-process guardians
//! are private instances of this executable, not Host/Pi processes or authorities.
//! The kernel owns grants, durable identities, admission and raw byte cursors.
pub(crate) mod interaction;
pub(crate) mod platform;
pub(crate) mod receipt_wake;
pub(crate) mod subscriptions;
pub(crate) mod worker;
pub(crate) mod text;
mod paging;
mod program;
pub(crate) mod launch;
use crate::{
    error::KernelError,
    protocol::{read_frame, write_frame},
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
    file_end: u64,
    output_closed: bool,
    output_error: Option<String>,
    end: u64,
    closed: bool,
    discard: bool,
    pid: Option<u32>,
    receipt: Option<Value>,
    control_error: Option<String>,
    interactions: interaction::Interactions,
    input_sequence: i64,
    input_error: Option<String>,
}
struct Shared {
    buffer: Mutex<Buffer>,
    changed: Condvar,
    publication: Mutex<()>,
    interaction_wakes: Mutex<HashMap<String, SyncSender<()>>>,
    // Seek metadata only; reading never consumes or deletes retained output.
    spool_index: Mutex<SpoolIndex>,
    text_pages: Mutex<paging::Boundaries>,
}
impl Shared {
    fn new() -> Self {
        Self {
            buffer: Mutex::new(Buffer {
                input_sequence: -1,
                ..Buffer::default()
            }),
            changed: Condvar::new(),
            publication: Mutex::new(()),
            interaction_wakes: Mutex::new(HashMap::new()),
            spool_index: Mutex::new(SpoolIndex::default()),
            text_pages: Mutex::new(paging::Boundaries::default()),
        }
    }
    fn notify(&self) {
        self.changed.notify_all();
        for wake in self
            .interaction_wakes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
        {
            let _ = wake.try_send(());
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
    run_id: Option<String>,
    state: Mutex<ControlState>,
    shared: Arc<Shared>,
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
        self.shared.notify();
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
pub(crate) struct ProcessObservationGuard { control: Arc<ProcessControl>, id: String }
impl Drop for ProcessObservationGuard {
    fn drop(&mut self) { self.control.shared.interaction_wakes.lock().unwrap_or_else(|e|e.into_inner()).remove(&self.id); }
}
impl ProcessControlRegistry {
    fn stop_registered(&self,id:&str,force:bool)->Result<Option<Value>,KernelError>{
        let control=self.0.lock().map_err(|_|failure("process controls poisoned"))?.live.get(id).and_then(Weak::upgrade);
        control.map(|control|control.stop(force).map(|requested|json!({"requested":requested,"exited":control.stopped()}))).transpose()
    }
    /// Wait outside Storage/manager locks for the original process AND its output.
    /// The caller's existing observation budget includes both phases; no extra grace delay.
    pub(crate) fn wait_for_completion(&self, id: &str, run: &str, budget: Duration,
        cancel: &varin_runtime::execution::CancellationToken) -> Result<(), KernelError> {
        if budget.is_zero() || cancel.is_cancelled() { return Ok(()); }
        let started = Instant::now();
        let control = self.0.lock().map_err(|_|failure("process controls poisoned"))?.live.get(id).and_then(Weak::upgrade);
        let Some(control) = control else { return Ok(()) };
        if control.run_id.as_deref() != Some(run) { return Err(KernelError::Authorization("process observation Run changed".into())); }
        let (sender, receiver) = mpsc::sync_channel(1);
        let _cancel = cancel.wake_on_cancel(sender.clone());
        let key = uuid::Uuid::new_v4().to_string();
        control.shared.interaction_wakes.lock().unwrap_or_else(|e|e.into_inner()).insert(key.clone(),sender);
        let _observation = ProcessObservationGuard { control: control.clone(), id: key };
        loop {
            let (output_closed, broken, control_closed) = {
                let buffer = control.shared.lock();
                (buffer.output_closed, buffer.output_error.is_some() || buffer.control_error.is_some(), buffer.closed)
            };
            let stopped = control.stopped();
            let finished = stopped && output_closed || broken || !stopped && control_closed;
            if finished || cancel.is_cancelled() { break; }
            let remaining = budget.saturating_sub(started.elapsed());
            if remaining.is_zero() || receiver.recv_timeout(remaining).is_err() { break; }
        }
        Ok(())
    }
    pub(crate) fn cancel_known_process(&self, id: &str) -> Result<bool, KernelError> {
        let control = self
            .0
            .lock()
            .map_err(|_| failure("process controls poisoned"))?
            .live
            .get(id)
            .and_then(Weak::upgrade);
        match control {
            Some(control) if control.run_id.is_some() => control.stop(true),
            _ => Ok(false),
        }
    }
    pub(crate) fn cancel_process(&self, id: &str, run_id: &str) -> Result<bool, KernelError> {
        let mut controls = self
            .0
            .lock()
            .map_err(|_| failure("process controls poisoned"))?;
        if let Some(control) = controls.live.get(id).and_then(Weak::upgrade) {
            if control.run_id.as_deref() != Some(run_id) {
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
            if control.run_id.as_deref() != Some(run_id.as_str()) {
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
}
#[derive(Default)]
struct SpoolIndex {
    checkpoints: Vec<SpoolFrame>,
    tail: Option<SpoolFrame>,
}
impl SpoolIndex {
    fn record(&mut self, frame:SpoolFrame) {
        // Physical intervals bound metadata even for one-byte transport frames.
        if self.checkpoints.last().is_none_or(|checkpoint|frame.position-checkpoint.position>=CHUNK_BYTES as u64) {
            self.checkpoints.push(frame.clone());
        }
        self.tail=Some(frame);
    }
}
#[derive(Clone)]
struct SpoolFrame {
    offset: u64,
    position: u64,
    length: usize,
    channel: &'static str,
}
#[derive(Default)]
pub(crate) struct ProcessManager {
    #[cfg(test)]
    worker_executable: Option<PathBuf>,
    outputs: HashMap<String, OutputHandle>,
    live: HashMap<String, LiveProcess>,
    starting: HashMap<String, launch::Starting>,
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
    pub(crate) fn is_live(&self, id: &str) -> bool {
        self.live.contains_key(id)
    }
    #[cfg(test)]
    pub(crate) fn set_test_worker_executable(&mut self, executable: PathBuf) {
        self.worker_executable = Some(executable);
    }
    pub(crate) fn set_subscriptions(&mut self, subscriptions: subscriptions::ProcessSubscriptions) {
        self.subscriptions = Some(subscriptions);
    }
    pub(crate) fn revoke_subscriptions(&self, grant_id: &str) {
        if let Some(subscriptions) = &self.subscriptions {
            subscriptions.close_grant(grant_id);
        }
    }
    pub(crate) fn subscribe(
        &self,
        id: &str,
        process_id: &str,
        grant_id: &str,
        epoch: &str,
        cursor: u64,
        snapshot: Value,
        original_grant_id: String,
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
                original_grant_id,
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
            let mut index = SpoolIndex::default();
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
                index.record(SpoolFrame {offset:end,position,length:count as usize,channel:if header[4]==1 {"stdout"} else {"stderr"}});
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
            *shared.spool_index.lock().unwrap_or_else(|error|error.into_inner())=index;
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
            "stopApplied":buffer.receipt.as_ref().and_then(|receipt|receipt.get("stopApplied")).and_then(Value::as_bool),
            "reason":reason, "writerActive":!matches!(status,"exited"|"failed"),
            "treeConfirmed":matches!(status,"exited"|"failed"), "outputAvailable":true,
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
        read_output(output, cursor, limit)
    }
    pub(crate) fn read_text(&self, id: &str, cursor: u64, limit: usize, encoding: Option<&str>, record: &Value) -> Result<Value, KernelError> {
        let output = self.outputs.get(id).ok_or_else(|| failure("process output storage unavailable"))?;
        paging::read(output, cursor, limit, encoding, record)
    }
    pub(crate) fn kill(&mut self, id: &str, force: bool) -> Result<Value, KernelError> {
        if let Some(starting)=self.starting.get(id){
            let requested=!starting.cancelled.swap(true,std::sync::atomic::Ordering::AcqRel);
            if let Some(run)=&starting.run {let _=self.controls.cancel_process(id,run)?;}
            return Ok(json!({"requested":requested,"exited":false}));
        }
        if !self.live.contains_key(id) {
            return self.controls.stop_registered(id,force)?.ok_or_else(||failure("process handle is not live in this epoch"));
        }
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
            // Keep control alive until the guardian can durably report the actual tree stop.
            // Windows EOF aborts the whole Job, including the guardian that writes that receipt.
            if !live.guardian_exited {
                let _ = live.control.stop(true);
            }
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        let result = (|| -> Result<(), KernelError> {
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
        })();
        // A failed stop remains uncertain. Closing control still invokes the guardian's loss path.
        for live in self.live.values_mut() {
            if let Ok(mut input) = live.input.lock() {
                input.take();
            }
        }
        result
    }
}
impl Drop for ProcessManager {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn read_output(
    live: &OutputHandle,
    cursor: u64,
    limit: usize,
) -> Result<Value, KernelError> {
    let (end, file_end, input_sequence, input_error, output_error, output_complete) = {
        let buffer = live.shared.lock();
        (buffer.end, buffer.file_end, buffer.input_sequence, buffer.input_error.clone(),
            buffer.output_error.clone(), buffer.output_closed && buffer.output_error.is_none())
    };
    if cursor > end {
        return Err(failure(format!("process output cursor {cursor} is outside retained range [0, {end}]; read from any cursor in that range")));
    }
    let mut file = File::open(&live.output_path)?;
    let header=|file:&mut File, position:u64, offset:u64| -> Result<SpoolFrame,KernelError> {
        file.seek(SeekFrom::Start(position))?;
        let mut header = [0u8;5]; file.read_exact(&mut header)?;
        let length = u32::from_le_bytes(header[..4].try_into().expect("fixed header")) as usize;
        if length == 0 || length > CHUNK_BYTES || position + 5 + length as u64 > file_end {
            return Err(failure("invalid process output storage frame"));
        }
        let channel = match header[4] {1 => "stdout",2 => "stderr",_ => return Err(failure("invalid stored output channel"))};
        Ok(SpoolFrame {offset,position,length,channel})
    };
    let mut index = live.shared.spool_index.lock().map_err(|_|failure("output index poisoned"))?;
    let target = cursor.saturating_add(limit as u64).min(end);
    while index.tail.as_ref().map_or(0, |frame|frame.offset + frame.length as u64) < target {
        let (offset, position) = index.tail.as_ref().map_or((0,0), |frame|(frame.offset + frame.length as u64, frame.position + 5 + frame.length as u64));
        let frame=header(&mut file,position,offset)?;
        index.record(frame);
    }
    let mut frame=if cursor<target {
        let start=index.checkpoints.partition_point(|frame|frame.offset<=cursor).saturating_sub(1);
        let checkpoint=index.checkpoints[start].clone();
        Some(index.tail.as_ref().filter(|tail|tail.offset<=cursor).cloned().unwrap_or(checkpoint))
    } else {None};
    drop(index);
    let mut raw_chunks: Vec<(&str, u64, Vec<u8>)> = Vec::new();
    let mut remaining = limit;
    let mut next = cursor;
    while let Some(current)=frame {
        if current.offset+current.length as u64<=next {
            frame=Some(header(&mut file,current.position+5+current.length as u64,current.offset+current.length as u64)?);
            continue;
        }
        let channel = current.channel;
        let skip = (next - current.offset) as usize;
        let count = remaining.min(current.length - skip);
        file.seek(SeekFrom::Start(current.position + 5 + skip as u64))?;
        let mut bytes = vec![0u8; count];
        file.read_exact(&mut bytes)?;
        // Storage frames are transport boundaries, not character boundaries.
        // Join adjacent output from one channel before projecting UTF-8.
        if let Some((_, _, previous)) = raw_chunks.last_mut().filter(|(previous,_,_)| *previous==channel) {
            previous.extend_from_slice(&bytes);
        } else {
            raw_chunks.push((channel,next,bytes));
        }
        next += count as u64;
        remaining -= count;
        frame=if next<target {Some(header(&mut file,current.position+5+current.length as u64,current.offset+current.length as u64)?)} else {None};
    }
    let chunks=raw_chunks.into_iter().map(|(channel,offset,bytes)|{
        let mut chunk=json!({"channel":channel,"offset":offset,"byteLength":bytes.len(),"bytesBase64":BASE64.encode(&bytes),"encoding":"base64"});
        match std::str::from_utf8(&bytes) {
            Ok(text) if !text.contains('\0') => {chunk["text"]=json!(text);chunk["encoding"]=json!("utf8");},
            Err(error) if error.error_len().is_none() || (error.valid_up_to()==0 && bytes.first().is_some_and(|byte|byte & 0xc0 == 0x80)) => {
                chunk["encodingReason"]=json!("UTF-8 character crosses an output page or channel boundary; concatenate raw bytes from the same channel to decode.");
            },
            _ => {chunk["encodingReason"]=json!("Output contains binary data or a non-UTF-8 encoding; raw bytes are preserved.");}
        }
        chunk
    }).collect::<Vec<_>>();
    Ok(json!({"chunks":chunks,"nextCursor":next,"endCursor":end,"startCursor":0,
            "inputSequence":input_sequence,"inputError":input_error,"outputError":output_error,"outputComplete":output_complete}))
}

#[cfg(test)]
mod output_projection_tests {
    use super::*;
    fn spool(bytes:&[u8]) -> OutputHandle {
        let path=std::env::temp_dir().join(format!("varin-spool-{}",uuid::Uuid::new_v4()));
        let mut file=File::create(&path).unwrap();
        for bytes in bytes.chunks(997) {
            file.write_all(&(bytes.len() as u32).to_le_bytes()).unwrap();
            file.write_all(&[1]).unwrap();file.write_all(bytes).unwrap();
        }
        let shared=Arc::new(Shared::new());
        {let mut state=shared.lock();state.file_end=file.metadata().unwrap().len();state.end=bytes.len() as u64;state.output_closed=true;}
        OutputHandle{shared,output_path:path}
    }
    #[test]
    fn text_pages_align_gbk_utf8_and_utf16_without_consuming_raw_bytes() {
        for (encoding,text) in [(encoding_rs::GBK,"中文错误abcd"),(encoding_rs::UTF_8,"中文🙂abcd"),(encoding_rs::UTF_16LE,"中文🙂abcd")] {
            let text=text.repeat(20000);
            let bytes=if encoding==encoding_rs::UTF_16LE {text.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>()} else {encoding.encode(&text).0.into_owned()};
            let handle=spool(&bytes);
            let record=json!({"mode":"pipe","outputCodePage":936});
            let mut cursor=0;
            let mut decoded=String::new();
            for limit in [1,7,65535].into_iter().cycle() {
                let mut page=paging::read(&handle,cursor,limit,Some(encoding.name()),&record).unwrap();
                assert!(page["nextCursor"].as_u64().unwrap()>cursor,"{page}");
                cursor=page["nextCursor"].as_u64().unwrap();
                page["process"]=record.clone();text::project(&mut page,&text::Mode::Text,Some(encoding.name()));
                for chunk in page["chunks"].as_array().unwrap(){decoded.push_str(chunk["text"].as_str().unwrap());}
                if cursor==bytes.len() as u64 {break;}
            }
            assert_eq!(decoded,text);
            for cursor in [199997,2,0,65537] {
                let page=paging::read(&handle,cursor,311,Some(encoding.name()),&record).unwrap();
                assert_eq!(page["characterAligned"],true);
                let data=page["chunks"].as_array().unwrap().iter().flat_map(|chunk|BASE64.decode(chunk["bytesBase64"].as_str().unwrap()).unwrap()).collect::<Vec<_>>();
                assert!(encoding.decode_without_bom_handling_and_without_replacement(&data).is_some());
                let raw=read_output(&handle,cursor,311).unwrap();
                let data=raw["chunks"].as_array().unwrap().iter().flat_map(|chunk|BASE64.decode(chunk["bytesBase64"].as_str().unwrap()).unwrap()).collect::<Vec<_>>();
                assert_eq!(data,&bytes[cursor as usize..cursor as usize+311]);
            }
            std::fs::remove_file(&handle.output_path).unwrap();
        }
    }
    #[test]
    fn automatic_pages_keep_mixed_pipe_lines_readable_at_tiny_and_large_edges() {
        let (gbk,_,_)=encoding_rs::GBK.encode("活动代码页 936：中文错误\r\n");
        let expected="活动代码页 936：中文错误\r\nUTF-8 输出：体检通过 ✓ 🚀\n";
        let source=[gbk.as_ref(),"UTF-8 输出：体检通过 ✓ 🚀\n".as_bytes()].concat().repeat(2300);
        let handle=spool(&source);
        let record=json!({"mode":"pipe","outputCodePage":936});
        let mut cursor=0;let mut decoded=String::new();
        for limit in [1,7,311,65535].into_iter().cycle() {
            let mut page=paging::read(&handle,cursor,limit,None,&record).unwrap();
            assert_eq!(page["characterAligned"],true,"{page}");
            let next=page["nextCursor"].as_u64().unwrap();assert!(next>cursor);cursor=next;
            page["process"]=record.clone();text::project(&mut page,&text::Mode::Text,None);
            for chunk in page["chunks"].as_array().unwrap(){decoded.push_str(chunk["text"].as_str().unwrap());}
            if cursor==source.len() as u64 {break;}
        }
        assert_eq!(decoded,expected.repeat(2300));
        std::fs::remove_file(&handle.output_path).unwrap();
    }
    #[test]
    fn spool_frames_join_utf8_while_page_boundaries_preserve_exact_bytes() {
        let path=std::env::temp_dir().join(format!("varin-spool-{}",uuid::Uuid::new_v4()));
        let text="中文🙂\n".as_bytes();let mut file=File::create(&path).unwrap();
        for bytes in [&text[..2],&text[2..7],&text[7..]] {
            file.write_all(&(bytes.len() as u32).to_le_bytes()).unwrap();file.write_all(&[1]).unwrap();file.write_all(bytes).unwrap();
        }
        let size=file.metadata().unwrap().len();drop(file);
        let shared=Arc::new(Shared::new());{let mut state=shared.lock();state.file_end=size;state.end=text.len() as u64;state.output_closed=true;}
        let handle=OutputHandle{shared,output_path:path.clone()};
        let all=read_output(&handle,0,65536).unwrap();
        assert_eq!(all["chunks"].as_array().unwrap().len(),1);assert_eq!(all["chunks"][0]["text"],"中文🙂\n");
        let first=read_output(&handle,0,2).unwrap();
        assert_eq!(first["chunks"][0]["encoding"],"base64");assert!(first["chunks"][0]["encodingReason"].as_str().unwrap().contains("boundary"));
        let second=read_output(&handle,2,65536).unwrap();
        let bytes=first["chunks"].as_array().unwrap().iter().chain(second["chunks"].as_array().unwrap()).flat_map(|chunk|BASE64.decode(chunk["bytesBase64"].as_str().unwrap()).unwrap()).collect::<Vec<_>>();
        assert_eq!(bytes,text);assert_eq!(second["outputComplete"],true);assert_eq!(second["nextCursor"],text.len());
        std::fs::remove_file(path).unwrap();
    }
}
