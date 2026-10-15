//! Input effects belong to the original process owner. Bodies live on workers; the
//! shared owner holds only FIFO reservations and small receipts. A missing receipt
//! never authorizes replaying input.
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use varin_runtime::execution::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum State {
    Applied,
    Partial,
    NotApplied,
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Identity {
    pub process_id: String,
    pub operation_id: String,
    pub kernel_epoch: String,
    pub sequence: u64,
    pub state: State,
    pub reason: Option<String>,
    pub cancelled: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Receipt {
    #[serde(rename_all = "camelCase")]
    Write {
        #[serde(flatten)]
        identity: Identity,
        requested_bytes: u64,
        confirmed_bytes: u64,
        eof_requested: bool,
        eof_applied: bool,
    },
    #[serde(rename_all = "camelCase")]
    Resize {
        #[serde(flatten)]
        identity: Identity,
        cols: u16,
        rows: u16,
    },
}
impl Receipt {
    pub(crate) fn identity(&self) -> &Identity {
        match self {
            Self::Write { identity, .. } | Self::Resize { identity, .. } => identity,
        }
    }
    pub(crate) fn identity_mut(&mut self) -> &mut Identity {
        match self {
            Self::Write { identity, .. } | Self::Resize { identity, .. } => identity,
        }
    }
    pub(crate) fn method(&self) -> &'static str {
        match self {
            Self::Write { .. } => "process.write",
            Self::Resize { .. } => "process.resize",
        }
    }
    pub(crate) fn same_intent(&self, other: &Self) -> bool {
        if self.identity().process_id != other.identity().process_id
            || self.identity().operation_id != other.identity().operation_id
            || self.identity().kernel_epoch != other.identity().kernel_epoch
            || self.identity().sequence != other.identity().sequence
        {
            return false;
        }
        match (self, other) {
            (
                Self::Write {
                    requested_bytes: a,
                    eof_requested: b,
                    ..
                },
                Self::Write {
                    requested_bytes: c,
                    eof_requested: d,
                    ..
                },
            ) => a == c && b == d,
            (
                Self::Resize {
                    cols: a, rows: b, ..
                },
                Self::Resize {
                    cols: c, rows: d, ..
                },
            ) => a == c && b == d,
            _ => false,
        }
    }
    /// Receipts must describe a possible prefix of their original intent.
    pub(crate) fn valid(&self) -> bool {
        match self {
            Self::Write {
                identity,
                requested_bytes,
                confirmed_bytes,
                eof_requested,
                eof_applied,
            } => {
                if confirmed_bytes > requested_bytes || (*eof_applied && !*eof_requested) {
                    return false;
                }
                match identity.state {
                    State::Applied => {
                        confirmed_bytes == requested_bytes && (!*eof_requested || *eof_applied)
                    }
                    State::NotApplied => *confirmed_bytes == 0 && !*eof_applied,
                    State::Partial => *confirmed_bytes > 0 || *eof_applied,
                    State::Unknown => true,
                }
            }
            Self::Resize {
                identity,
                cols,
                rows,
            } => *cols > 0 && *rows > 0 && identity.state != State::Partial,
        }
    }
    pub(crate) fn follows(&self, prior: &Self) -> bool {
        self.same_intent(prior)
            && self.valid()
            && match (self, prior) {
                (
                    Self::Write {
                        confirmed_bytes,
                        eof_applied,
                        ..
                    },
                    Self::Write {
                        confirmed_bytes: previous,
                        eof_applied: previous_eof,
                        ..
                    },
                ) => confirmed_bytes >= previous && (!*previous_eof || *eof_applied),
                _ => true,
            }
    }
    pub(crate) fn unknown(&self, reason: impl Into<String>, cancelled: bool) -> Self {
        let mut value = self.clone();
        let id = value.identity_mut();
        id.state = State::Unknown;
        id.reason = Some(reason.into());
        id.cancelled = cancelled;
        value
    }
    pub(crate) fn no_effect(&self, reason: impl Into<String>, cancelled: bool) -> Self {
        let mut value = self.clone();
        let id = value.identity_mut();
        id.state = State::NotApplied;
        id.reason = Some(reason.into());
        id.cancelled = cancelled;
        value
    }
    fn failed_after_ack(&self, reason: impl Into<String>, cancelled: bool) -> Self {
        let mut value = self.clone();
        let partial = matches!(value,Self::Write{confirmed_bytes,..} if confirmed_bytes>0);
        let id = value.identity_mut();
        id.state = if partial {
            State::Partial
        } else {
            State::NotApplied
        };
        id.reason = Some(reason.into());
        id.cancelled = cancelled;
        value
    }
    pub(crate) fn effect(&self) -> varin_runtime::Effect {
        match self.identity().state {
            State::Applied => match self {
                Self::Write {
                    requested_bytes: 0,
                    eof_applied: false,
                    ..
                } => varin_runtime::Effect::None,
                _ => varin_runtime::Effect::Confirmed,
            },
            State::Partial => varin_runtime::Effect::Partial,
            State::NotApplied => varin_runtime::Effect::None,
            State::Unknown => varin_runtime::Effect::Unknown,
        }
    }
    pub(crate) fn outcome(&self) -> varin_runtime::Outcome {
        match self.identity().state {
            State::Applied => varin_runtime::Outcome::Succeeded,
            State::Unknown => varin_runtime::Outcome::Indeterminate,
            _ if self.identity().cancelled => varin_runtime::Outcome::Cancelled,
            _ => varin_runtime::Outcome::Failed,
        }
    }
}
#[derive(Clone)]
pub(crate) enum Input {
    Write { bytes: Arc<[u8]>, eof: bool },
    Resize { cols: u16, rows: u16 },
}
impl Input {
    pub(crate) fn digest(&self) -> String {
        let mut hash = Sha256::new();
        match self {
            Self::Write { bytes, eof } => {
                hash.update(b"write\0");
                hash.update([*eof as u8]);
                hash.update(bytes);
            }
            Self::Resize { cols, rows } => {
                hash.update(b"resize\0");
                hash.update(cols.to_le_bytes());
                hash.update(rows.to_le_bytes());
            }
        }
        hex::encode(hash.finalize())
    }
    pub(crate) fn receipt(
        &self,
        process_id: &str,
        operation_id: &str,
        epoch: &str,
        sequence: u64,
    ) -> Receipt {
        let identity = Identity {
            process_id: process_id.into(),
            operation_id: operation_id.into(),
            kernel_epoch: epoch.into(),
            sequence,
            state: State::Unknown,
            reason: Some("input was admitted; no final executor receipt is available".into()),
            cancelled: false,
        };
        match self {
            Self::Write { bytes, eof } => Receipt::Write {
                identity,
                requested_bytes: bytes.len() as u64,
                confirmed_bytes: 0,
                eof_requested: *eof,
                eof_applied: false,
            },
            Self::Resize { cols, rows } => Receipt::Resize {
                identity,
                cols: *cols,
                rows: *rows,
            },
        }
    }
}
#[derive(Default)]
pub(super) struct Interactions {
    pub next_sequence: u64,
    pub stdin: VecDeque<String>,
    pub resize: VecDeque<String>,
    pub active: HashMap<String, Progress>,
}
pub(super) struct Progress {
    pub receipt: Receipt,
    pub chunk: u64,
    pub final_receipt: bool,
}
pub(crate) fn path(process_receipt: &Path, operation_id: &str) -> PathBuf {
    process_receipt.with_file_name(format!(
        "{}-{}.interaction",
        process_receipt
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy(),
        hex::encode(Sha256::digest(operation_id.as_bytes()))
    ))
}
pub(crate) fn persist(path: &Path, receipt: &Receipt) -> Result<(), KernelError> {
    if !receipt.valid() {
        return Err(failure("invalid process interaction receipt"));
    }
    let temporary = path.with_extension("interaction.tmp");
    let mut file = File::create(&temporary)?;
    serde_json::to_writer(&mut file, receipt)?;
    file.sync_all()?;
    drop(file);
    crate::storage::durable_rename(&temporary, path)?;
    if let Some(parent) = path.parent() {
        crate::storage::sync_directory(parent)?;
    }
    Ok(())
}
pub(crate) fn read(path: &Path, expected: &Receipt) -> Result<Option<Receipt>, KernelError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let receipt: Receipt = serde_json::from_reader(file)?;
    if !receipt.follows(expected) {
        return Err(failure(
            "process interaction receipt identity does not match its original intent",
        ));
    }
    Ok(Some(receipt))
}
/// Small owned reservation. Execution and durable receipt I/O happen only on a worker.
pub(crate) struct Task {
    shared: Arc<Shared>,
    input: Arc<Mutex<Option<SyncSender<Value>>>>,
    control: Arc<ProcessControl>,
    pub(crate) seed: Receipt,
    pub(crate) receipt_path: PathBuf,
}
impl Task {
    fn send(&self, value: Value) -> Result<(), KernelError> {
        // Never hold the shared state lock while queueing a bounded guardian frame.
        self.input
            .lock()
            .map_err(|_| failure("guardian input poisoned"))?
            .as_ref()
            .ok_or_else(|| failure("guardian input closed"))?
            .try_send(value)
            .map_err(|_| failure("guardian control queue is unavailable"))
    }
    pub(crate) fn run(
        self,
        input: Input,
        cancel: CancellationToken,
        mut observe: impl FnMut(Receipt, bool),
    ) {
        let id = self.seed.identity().operation_id.clone();
        let (wake, changed) = mpsc::sync_channel(1);
        self.shared
            .interaction_wakes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.clone(), wake.clone());
        let _registration = cancel.wake_on_cancel(wake);
        let writing = matches!(input, Input::Write { .. });
        let mut sent = false;
        let mut announced_cancel = false;
        let mut chunk = 0u64;
        let mut offset = 0usize;
        let result = (|| -> Result<Receipt, KernelError> {
            loop {
                let (progress, ready, closed) = {
                    let state = self.shared.lock();
                    let progress = state
                        .interactions
                        .active
                        .get(&id)
                        .ok_or_else(|| failure("process input reservation disappeared"))?;
                    (
                        Progress {
                            receipt: progress.receipt.clone(),
                            chunk: progress.chunk,
                            final_receipt: progress.final_receipt,
                        },
                        if writing {
                            state.interactions.stdin.front() == Some(&id)
                        } else {
                            state.interactions.resize.front() == Some(&id)
                        },
                        state.closed || state.control_error.is_some(),
                    )
                };
                if progress.final_receipt {
                    return Ok(progress.receipt);
                }
                if closed {
                    if let Some(receipt) = read(&self.receipt_path, &self.seed)? {
                        return Ok(receipt);
                    }
                    return Ok(progress.receipt.unknown(
                        "process control ended without a final input receipt",
                        cancel.is_cancelled(),
                    ));
                }
                if cancel.is_cancelled() && !sent {
                    let receipt = self.seed.no_effect("input cancelled before dispatch", true);
                    persist(&self.receipt_path, &receipt)?;
                    return Ok(receipt);
                }
                if cancel.is_cancelled() && sent && !announced_cancel {
                    observe(
                        progress.receipt.unknown(
                            "input cancellation requested while a dispatched chunk is unconfirmed",
                            true,
                        ),
                        false,
                    );
                    announced_cancel = true;
                }
                if !ready {
                    changed
                        .recv()
                        .map_err(|_| failure("process input wake closed"))?;
                    continue;
                }
                if sent && progress.chunk < chunk {
                    changed
                        .recv()
                        .map_err(|_| failure("process input wake closed"))?;
                    continue;
                }
                if self.control.stop_requested() && !sent {
                    let receipt = self.seed.no_effect(
                        "process is stopping; input was not dispatched",
                        cancel.is_cancelled(),
                    );
                    persist(&self.receipt_path, &receipt)?;
                    return Ok(receipt);
                }
                let frame = match &input {
                    Input::Resize { cols, rows } => {
                        if sent {
                            changed
                                .recv()
                                .map_err(|_| failure("process resize wake closed"))?;
                            continue;
                        }
                        json!({"type":"resize","receipt":self.seed,"cols":cols,"rows":rows})
                    }
                    Input::Write { bytes, eof } => {
                        let cancelled = cancel.is_cancelled() || self.control.stop_requested();
                        let end = if cancelled {
                            offset
                        } else {
                            (offset + CHUNK_BYTES).min(bytes.len())
                        };
                        chunk += 1;
                        let last = cancelled || end == bytes.len();
                        let frame = json!({"type":"write","receipt":progress.receipt,"chunk":chunk,"bytesBase64":BASE64.encode(&bytes[offset..end]),"last":last,"eof":*eof&&last&&!cancelled,"cancelled":cancelled});
                        offset = end;
                        frame
                    }
                };
                if let Err(error) = self.send(frame) {
                    let receipt = if sent {
                        progress
                            .receipt
                            .failed_after_ack(error.to_string(), cancel.is_cancelled())
                    } else {
                        self.seed
                            .no_effect(error.to_string(), cancel.is_cancelled())
                    };
                    persist(&self.receipt_path, &receipt)?;
                    return Ok(receipt);
                }
                sent = true;
            }
        })();
        let receipt = result.unwrap_or_else(|error| {
            let current = self
                .shared
                .lock()
                .interactions
                .active
                .get(&id)
                .map(|progress| progress.receipt.clone())
                .unwrap_or_else(|| self.seed.clone());
            current.unknown(error.to_string(), cancel.is_cancelled())
        });
        // The worker owns the final publication; a cancelled observer cannot discard it.
        observe(receipt, true);
        {
            let mut state = self.shared.lock();
            state.interactions.active.remove(&id);
            state.interactions.stdin.retain(|item| item != &id);
            state.interactions.resize.retain(|item| item != &id);
        }
        self.shared
            .interaction_wakes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
        self.shared.notify();
    }
}
impl Drop for Task {
    fn drop(&mut self) {
        let id = &self.seed.identity().operation_id;
        {
            let mut state = self.shared.lock();
            state.interactions.active.remove(id);
            state.interactions.stdin.retain(|item| item != id);
            state.interactions.resize.retain(|item| item != id);
        }
        self.shared.notify();
    }
}
impl ProcessManager {
    pub(crate) fn interaction_progress(
        &self,
        process_id: &str,
        operation_id: &str,
    ) -> Option<Receipt> {
        self.live.get(process_id).and_then(|live| {
            live.shared
                .lock()
                .interactions
                .active
                .get(operation_id)
                .map(|progress| progress.receipt.clone())
        })
    }
    pub(crate) fn reserve_interaction(
        &mut self,
        id: &str,
        operation_id: &str,
        epoch: &str,
        input: &Input,
        root: &Path,
    ) -> Result<Task, KernelError> {
        let live = self
            .live
            .get(id)
            .ok_or_else(|| failure("process handle is not live in this epoch"))?;
        let mut state = live.shared.lock();
        if state.closed
            || state.control_error.is_some()
            || live.control.stop_requested()
            || live.control.stopped()
        {
            return Err(failure("process input is closed or stopping"));
        }
        if state.interactions.active.contains_key(operation_id) {
            return Err(failure("process interaction is already active"));
        }
        let sequence = state.interactions.next_sequence;
        // The wire receipt is a JavaScript number, so identities must stay exactly representable.
        if sequence > 9_007_199_254_740_991 {
            return Err(failure(
                "process input sequence exhausted the wire integer range",
            ));
        }
        state.interactions.next_sequence = sequence
            .checked_add(1)
            .ok_or_else(|| failure("process input sequence exhausted"))?;
        let seed = input.receipt(id, operation_id, epoch, sequence);
        state.interactions.active.insert(
            operation_id.into(),
            Progress {
                receipt: seed.clone(),
                chunk: 0,
                final_receipt: false,
            },
        );
        if matches!(input, Input::Write { .. }) {
            state.interactions.stdin.push_back(operation_id.into());
        } else {
            // Resize has its own accepted order; blocked stdin must not hold it.
            state.interactions.resize.push_back(operation_id.into());
        }
        Ok(Task {
            shared: live.shared.clone(),
            input: live.input.clone(),
            control: live.control.clone(),
            receipt_path: path(&receipt_path(root, id), operation_id),
            seed,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn receipt_state_and_confirmed_prefix_must_match_the_original_intent() {
        let seed = Input::Write {
            bytes: Arc::from(b"1234".as_slice()),
            eof: true,
        }
        .receipt("process", "operation", "epoch", 0);
        let mut partial = seed.clone();
        if let Receipt::Write {
            identity,
            confirmed_bytes,
            ..
        } = &mut partial
        {
            identity.state = State::Partial;
            *confirmed_bytes = 2;
        }
        assert!(partial.follows(&seed));
        let unknown = partial.unknown("receipt lost", true);
        assert!(unknown.follows(&partial));
        assert!(!seed.follows(&partial));
        let mut invalid = partial.clone();
        invalid.identity_mut().state = State::Applied;
        assert!(!invalid.valid());
        if let Receipt::Write {
            confirmed_bytes,
            eof_applied,
            ..
        } = &mut invalid
        {
            *confirmed_bytes = 4;
            *eof_applied = true;
        }
        assert!(invalid.valid());
        assert!(invalid.follows(&partial));
        assert_eq!(
            serde_json::from_value::<Receipt>(serde_json::to_value(&seed).unwrap()).unwrap(),
            seed
        );
        let mut impossible = serde_json::to_value(
            Input::Resize { cols: 1, rows: 1 }.receipt("process", "resize", "epoch", 1),
        )
        .unwrap();
        impossible["eofApplied"] = json!(true);
        assert!(serde_json::from_value::<Receipt>(impossible).is_err());
    }
}
