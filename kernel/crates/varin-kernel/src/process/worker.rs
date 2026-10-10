//! Private native process guardian. It is not a second protocol endpoint: only
//! the owning kernel supplies its framed stdin, after OS containment admission.
use super::interaction::{self, Receipt as InteractionReceipt, State as InteractionState};
use super::platform;
use crate::protocol::{read_frame, write_frame};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs::File,
    io::{self, Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU8, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

static STOP: AtomicU8 = AtomicU8::new(0);
#[cfg(unix)]
extern "C" fn stop_signal(signal: i32) {
    STOP.fetch_max(
        if signal == libc::SIGUSR2 { 2 } else { 1 },
        Ordering::Relaxed,
    );
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub process_id: String,
    pub kernel_epoch: String,
    pub receipt_path: PathBuf,
    pub job_name: String,
    pub cwd: PathBuf,
    pub command: String,
    pub args: Vec<String>,
    #[cfg(windows)]
    pub windows_raw_arguments: Option<String>,
    pub env: Vec<Environment>,
    pub mode: String,
    pub cols: u16,
    pub rows: u16,
}
#[derive(Deserialize)]
pub struct Environment {
    pub name: String,
    pub value: String,
}
type Output = Arc<Mutex<io::Stdout>>;
type DataOutput = Arc<Mutex<io::Stderr>>;
type Input = Box<dyn Write + Send>;
type Reader = (String, Box<dyn Read + Send>);
struct Spawned {
    child: Box<dyn PtyChild + Send + Sync>,
    input: Input,
    master: Option<Box<dyn MasterPty + Send>>,
    readers: Vec<Reader>,
}
fn send(output: &Output, event: Value) -> io::Result<()> {
    write_frame(
        &mut *output
            .lock()
            .map_err(|_| io::Error::other("process output poisoned"))?,
        &event,
    )
}
fn send_data(output: &DataOutput, event: Value) -> io::Result<()> {
    write_frame(
        &mut *output
            .lock()
            .map_err(|_| io::Error::other("process data output poisoned"))?,
        &event,
    )
}
fn spawn(config: &Config) -> Result<Spawned, Box<dyn std::error::Error>> {
    #[cfg(target_os = "linux")]
    platform::prepare_guardian()?;
    if config.mode == "pty" {
        let pair = native_pty_system().openpty(PtySize {
            rows: config.rows,
            cols: config.cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let reader = pair.master.try_clone_reader()?;
        let mut input = pair.master.take_writer()?;
        // portable-pty creates a fresh ConPTY with INHERIT_CURSOR. There is no
        // pre-existing surface cursor to inherit: supply the fresh terminal
        // origin before launching user code, including detached Harness shells.
        #[cfg(windows)]
        {
            input.write_all(b"\x1b[1;1R")?;
            input.flush()?;
        }
        let mut command = CommandBuilder::new(&config.command);
        command.args(&config.args);
        command.cwd(&config.cwd);
        command.env_clear();
        for entry in &config.env {
            command.env(&entry.name, &entry.value);
        }
        let child = pair.slave.spawn_command(command)?;
        drop(pair.slave);
        Ok(Spawned {
            child,
            input,
            master: Some(pair.master),
            readers: vec![("stdout".into(), reader)],
        })
    } else {
        let mut command = Command::new(&config.command);
        command
            .args(&config.args)
            .current_dir(&config.cwd)
            .env_clear()
            .envs(config.env.iter().map(|v| (&v.name, &v.value)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
            if let Some(raw) = &config.windows_raw_arguments {
                command.raw_arg(raw);
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() < 0 {
                        Err(io::Error::last_os_error())
                    } else {
                        Ok(())
                    }
                });
            }
        }
        let mut child = command.spawn()?;
        let input = Box::new(
            child
                .stdin
                .take()
                .ok_or_else(|| io::Error::other("missing stdin"))?,
        );
        let readers: Vec<Reader> = vec![
            (
                "stdout".into(),
                Box::new(
                    child
                        .stdout
                        .take()
                        .ok_or_else(|| io::Error::other("missing stdout"))?,
                ),
            ),
            (
                "stderr".into(),
                Box::new(
                    child
                        .stderr
                        .take()
                        .ok_or_else(|| io::Error::other("missing stderr"))?,
                ),
            ),
        ];
        Ok(Spawned {
            child: Box::new(child),
            input,
            master: None,
            readers,
        })
    }
}
fn receipt(config: &Config, value: &Value) -> io::Result<()> {
    let temporary = config.receipt_path.with_extension("tmp");
    let mut file = File::create(&temporary)?;
    file.write_all(serde_json::to_string(value)?.as_bytes())?;
    file.sync_all()?;
    drop(file);
    crate::storage::durable_rename(&temporary, &config.receipt_path)?;
    if let Some(parent) = config.receipt_path.parent() {
        crate::storage::sync_directory(parent)?;
    }
    Ok(())
}
/// A failed durable publication still reports the actual confirmed prefix as unknown.
fn publish_interaction_receipt(path: &std::path::Path, receipt: &mut InteractionReceipt) {
    if let Err(error) = interaction::persist(
        &interaction::path(path, &receipt.identity().operation_id),
        receipt,
    ) {
        *receipt = receipt.unknown(
            format!("process input receipt could not be persisted: {error}"),
            receipt.identity().cancelled,
        );
    }
}
pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGUSR1, stop_signal as libc::sighandler_t);
        libc::signal(libc::SIGUSR2, stop_signal as libc::sighandler_t);
    }
    #[cfg(target_os = "linux")]
    platform::arm_parent_death_signal()?;
    let output = Arc::new(Mutex::new(io::stdout()));
    let data_output = Arc::new(Mutex::new(io::stderr()));
    // The parent must not deliver Unix signals until the handlers above are installed.
    send(&output, json!({"type":"ready"}))?;
    let config: Config = {
        let Some(frame) = read_frame(&mut io::stdin().lock())? else {
            return Ok(());
        };
        serde_json::from_slice(&frame)?
    };
    #[cfg(windows)]
    let job = Arc::new(platform::WorkerJob::open(&config.job_name)?);
    if STOP.load(Ordering::Acquire) > 0 {
        let value = json!({"processId":config.process_id,"kernelEpoch":config.kernel_epoch,
            "status":"failed","pid":null,"exitCode":null,"signal":null,"reason":"process launch cancelled before spawn",
            "treeConfirmed":true,"stopApplied":true,"spawned":false});
        receipt(&config, &value)?;
        send(&output, json!({"type":"receipt","value":value}))?;
        return Ok(());
    }
    let Spawned {
        mut child,
        input,
        master,
        readers,
    } = match spawn(&config) {
        Ok(spawned) => spawned,
        Err(error) => {
            let value = json!({"processId": config.process_id, "kernelEpoch": config.kernel_epoch,
                "status": "failed", "pid": null, "exitCode": null, "signal": null,
                "reason": format!("process spawn failed: {error}"), "treeConfirmed": true,"spawned":false,"stopApplied":false});
            receipt(&config, &value).map_err(|error| {
                io::Error::other(format!("native exit receipt install: {error}"))
            })?;
            send(&output, json!({"type":"receipt", "value":value}))?;
            return Ok(());
        }
    };
    let pid = child
        .process_id()
        .ok_or_else(|| io::Error::other("process has no OS identity"))?;
    send(&output, json!({"type":"started", "pid":pid}))?;
    let master = Arc::new(Mutex::new(master));
    let mut readers = readers.into_iter().map(|(channel, mut reader)| {
        let output = output.clone();
        let data_output = data_output.clone();
        thread::spawn(move || {
            let mut buffer = [0u8; 16384];
            let mut delivering = true;
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        if delivering && send_data(&data_output, json!({"type":"output", "channel":channel, "bytesBase64":BASE64.encode(&buffer[..n])})).is_err() {
                            STOP.store(2, Ordering::Release);
                            delivering = false;
                            let _ = send(&output, json!({"type":"output-error", "channel":channel}));
                            // Continue draining target pipes during termination. A failed log sink
                            // must not make ConPTY cleanup depend on an abandoned pipe reader.
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    #[cfg(unix)]
                    Err(error) if error.raw_os_error() == Some(libc::EIO) => break,
                    Err(_) => { let _ = send(&output, json!({"type":"output-error", "channel":channel})); break; }
                }
            }
        })
    }).collect::<Vec<_>>();
    let (input_tx, input_rx) = mpsc::sync_channel::<Value>(1);
    let input_output = output.clone();
    let input_receipt_path = config.receipt_path.clone();
    let input_worker = thread::spawn(move || {
        let mut input = Some(input);
        let mut active: Option<(InteractionReceipt, u64)> = None;
        for value in input_rx {
            if value["type"] == "finish" {
                if let Some((mut receipt, chunk)) = active.take() {
                    // A parent/control-side failure can already have settled this reservation.
                    // Do not replace its durable final receipt when draining the stopped tree.
                    if interaction::read(
                        &interaction::path(&input_receipt_path, &receipt.identity().operation_id),
                        &receipt,
                    )
                    .ok()
                    .flatten()
                    .is_some()
                    {
                        return;
                    }
                    let wrote = matches!(receipt,InteractionReceipt::Write{confirmed_bytes,..} if confirmed_bytes>0);
                    let id = receipt.identity_mut();
                    id.state = if wrote {
                        InteractionState::Partial
                    } else {
                        InteractionState::NotApplied
                    };
                    id.reason = Some(
                        "process tree stopped before the remaining input or EOF was sent".into(),
                    );
                    publish_interaction_receipt(&input_receipt_path, &mut receipt);
                    let _ = send(
                        &input_output,
                        json!({"type":"interaction","receipt":receipt,"chunk":chunk}),
                    );
                }
                return;
            }
            let seed: InteractionReceipt = match serde_json::from_value(value["receipt"].clone()) {
                Ok(value) => value,
                Err(_) => return,
            };
            let chunk = value["chunk"].as_u64().unwrap_or(0);
            if active.as_ref().is_none_or(|(receipt, _)| {
                receipt.identity().operation_id != seed.identity().operation_id
            }) {
                if chunk != 1 {
                    return;
                }
                active = Some((seed.clone(), 0));
            }
            let (receipt, previous) = active.as_mut().expect("input interaction");
            if !receipt.same_intent(&seed) || chunk != *previous + 1 {
                return;
            }
            *previous = chunk;
            let cancelled = value["cancelled"].as_bool() == Some(true);
            let last = value["last"].as_bool() == Some(true);
            let mut error = None;
            let bytes = match BASE64.decode(value["bytesBase64"].as_str().unwrap_or_default()) {
                Ok(bytes) if bytes.len() <= super::CHUNK_BYTES => bytes,
                _ => {
                    error = Some("invalid guardian input chunk".to_string());
                    Vec::new()
                }
            };
            if error.is_none() {
                match input.as_mut() {
                    None => error = Some("process stdin is already closed".into()),
                    Some(writer) => {
                        let mut offset = 0;
                        while offset < bytes.len() {
                            match writer.write(&bytes[offset..]) {
                                Ok(0) => {
                                    error = Some("process stdin write made no progress".into());
                                    break;
                                }
                                Ok(n) => {
                                    offset += n;
                                    if let InteractionReceipt::Write {
                                        confirmed_bytes, ..
                                    } = receipt
                                    {
                                        *confirmed_bytes += n as u64;
                                    }
                                }
                                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                                Err(e) => {
                                    error = Some(e.to_string());
                                    break;
                                }
                            }
                        }
                        if error.is_none() {
                            if let Err(e) = writer.flush() {
                                error = Some(e.to_string());
                            }
                        }
                    }
                }
            }
            if error.is_none() && last && value["eof"].as_bool() == Some(true) {
                drop(input.take());
                if let InteractionReceipt::Write { eof_applied, .. } = receipt {
                    *eof_applied = true;
                }
            }
            let finished = last || error.is_some();
            if finished {
                let (written, expected, eof_requested, eof_applied) = match receipt {
                    InteractionReceipt::Write {
                        confirmed_bytes,
                        requested_bytes,
                        eof_requested,
                        eof_applied,
                        ..
                    } => (
                        *confirmed_bytes,
                        *requested_bytes,
                        *eof_requested,
                        *eof_applied,
                    ),
                    _ => return,
                };
                let identity = receipt.identity_mut();
                identity.cancelled = cancelled;
                identity.reason = error.or_else(|| {
                    cancelled
                        .then(|| "input cancelled before remaining bytes or EOF were sent".into())
                });
                identity.state = if !cancelled
                    && identity.reason.is_none()
                    && written == expected
                    && (!eof_requested || eof_applied)
                {
                    InteractionState::Applied
                } else if written > 0 || eof_applied {
                    InteractionState::Partial
                } else {
                    InteractionState::NotApplied
                };
                publish_interaction_receipt(&input_receipt_path, receipt);
            }
            if send(&input_output,json!({"type":if finished{"interaction"}else{"input-chunk"},"receipt":receipt,"chunk":chunk})).is_err(){return;}
            if finished {
                active = None;
            }
        }
    });
    let control_input = input_tx.clone();
    let control_output = output.clone();
    let control_master = master.clone();
    let control_receipt_path = config.receipt_path.clone();
    #[cfg(windows)]
    let control_job = job.clone();
    thread::spawn(move || {
        let mut input = io::stdin().lock();
        while let Ok(Some(frame)) = read_frame(&mut input) {
            let Ok(value) = serde_json::from_slice::<Value>(&frame) else {
                break;
            };
            match value["type"].as_str() {
                Some("stop") => {
                    STOP.fetch_max(
                        if value["force"].as_bool() == Some(true) {
                            2
                        } else {
                            1
                        },
                        Ordering::Release,
                    );
                }
                Some("write") => {
                    if let Err(error) = control_input.try_send(value) {
                        let value = match error {
                            mpsc::TrySendError::Full(value)
                            | mpsc::TrySendError::Disconnected(value) => value,
                        };
                        if let Ok(seed) =
                            serde_json::from_value::<InteractionReceipt>(value["receipt"].clone())
                        {
                            // The chunk did not reach the writer. Prior chunks may already have effects.
                            let mut receipt = interaction::read(
                                &interaction::path(
                                    &control_receipt_path,
                                    &seed.identity().operation_id,
                                ),
                                &seed,
                            )
                            .ok()
                            .flatten()
                            .unwrap_or_else(|| {
                                seed.unknown("process stdin queue became unavailable", false)
                            });
                            publish_interaction_receipt(&control_receipt_path, &mut receipt);
                            let _ = send(
                                &control_output,
                                json!({"type":"interaction","receipt":receipt}),
                            );
                        }
                    }
                }
                Some("resize") => {
                    let Ok(mut receipt) =
                        serde_json::from_value::<InteractionReceipt>(value["receipt"].clone())
                    else {
                        break;
                    };
                    let InteractionReceipt::Resize { cols, rows, .. } = &receipt else {
                        break;
                    };
                    let size = PtySize {
                        cols: *cols,
                        rows: *rows,
                        pixel_width: 0,
                        pixel_height: 0,
                    };
                    match control_master.lock() {
                        Ok(master) => match master.as_ref() {
                            None => {
                                receipt =
                                    receipt.no_effect("process has no live PTY master", false);
                            }
                            Some(master) => match master.resize(size) {
                                Ok(()) => {
                                    let id = receipt.identity_mut();
                                    id.state = InteractionState::Applied;
                                    id.reason = None;
                                }
                                Err(error) => {
                                    receipt = receipt
                                        .no_effect(format!("PTY resize failed: {error}"), false);
                                }
                            },
                        },
                        Err(_) => {
                            receipt = receipt.unknown("PTY master owner failed", false);
                        }
                    }
                    publish_interaction_receipt(&control_receipt_path, &mut receipt);
                    if send(
                        &control_output,
                        json!({"type":"interaction","receipt":receipt}),
                    )
                    .is_err()
                    {
                        break;
                    }
                }
                _ => break,
            }
        }
        STOP.store(2, Ordering::Release);
        #[cfg(windows)]
        control_job.abort();
    });
    let mut stop_started: Option<Instant> = None;
    let mut stop_applied = false;
    let exit =
        loop {
            if let Some(status) = child.try_wait().map_err(|error| {
                io::Error::other(format!("native target exit observation: {error}"))
            })? {
                break status;
            }
            if STOP.load(Ordering::Acquire) > 0 {
                let started = stop_started.get_or_insert_with(Instant::now);
                let force =
                    STOP.load(Ordering::Acquire) > 1 || started.elapsed() >= Duration::from_secs(1);
                #[cfg(unix)]
                {
                    stop_applied |= platform::terminate_session(pid, force)?;
                }
                #[cfg(windows)]
                {
                    let _ = force;
                    child.kill()?;
                    stop_applied = true;
                }
            }
            if let Some(status) = child.try_wait().map_err(|error| {
                io::Error::other(format!("native target exit observation: {error}"))
            })? {
                break status;
            }
            thread::sleep(Duration::from_millis(10));
        };
    // Close ConPTY while its reader is still draining, not after joining it.
    drop(
        master
            .lock()
            .map_err(|_| io::Error::other("PTY master poisoned"))?
            .take(),
    );
    // ConPTY's console host owns the final screen flush. Killing Job members
    // before its output pipe reaches EOF can truncate the last output and race
    // a conhost already tearing down. ClosePseudoConsole above runs alongside
    // the reader; only then drain any remaining Job descendants.
    #[cfg(windows)]
    if config.mode == "pty" {
        for reader in readers.drain(..) {
            let _ = reader.join();
        }
    }
    let drain_started = Instant::now();
    loop {
        if drain_started.elapsed() >= Duration::from_secs(5) {
            return Err(io::Error::other("native process descendants did not confirm exit").into());
        }
        #[cfg(unix)]
        {
            platform::terminate_session(pid, true)?;
            if platform::session_members(pid)?.is_empty() {
                break;
            }
        }
        #[cfg(windows)]
        if job
            .drain_descendants()
            .map_err(|error| io::Error::other(format!("native Job descendant drain: {error}")))?
        {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    // The stopped tree closes pipe/PTY readers and releases blocked input writes. Keep
    // the guardian alive through the writer's final durable receipt; process exit itself
    // must not kill the receipt thread between a successful write and fsync.
    let _ = input_tx.send(json!({"type":"finish"}));
    let _ = input_worker.join();
    let value = json!({"processId":config.process_id, "kernelEpoch":config.kernel_epoch,
        "status":"exited", "pid":pid, "exitCode":if exit.signal().is_none() { Some(exit.exit_code()) } else { None },
        "signal":exit.signal(), "reason":null, "treeConfirmed":true,"spawned":true,"stopApplied":stop_applied});
    receipt(&config, &value)?;
    send(&output, json!({"type":"receipt", "value":value}))?;
    // Tree completion and complete-log delivery are different facts. The control receipt is
    // available before residual output drains, while the guardian stays alive to preserve bytes.
    for reader in readers.drain(..) {
        let _ = reader.join();
    }
    // Process-local input threads die here. The main binary exits immediately.
    Ok(())
}
