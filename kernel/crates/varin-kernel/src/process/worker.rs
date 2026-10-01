//! Private native process guardian. It is not a second protocol endpoint: only
//! the owning kernel supplies its framed stdin, after OS containment admission.
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
pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGUSR1, stop_signal as libc::sighandler_t);
        libc::signal(libc::SIGUSR2, stop_signal as libc::sighandler_t);
    }
    #[cfg(target_os = "linux")]
    platform::arm_parent_death_signal()?;
    let config: Config = {
        let Some(frame) = read_frame(&mut io::stdin().lock())? else {
            return Ok(());
        };
        serde_json::from_slice(&frame)?
    };
    #[cfg(windows)]
    let job = Arc::new(platform::WorkerJob::open(&config.job_name)?);
    let output = Arc::new(Mutex::new(io::stdout()));
    let Spawned {
        mut child,
        mut input,
        master,
        readers,
    } = match spawn(&config) {
        Ok(spawned) => spawned,
        Err(error) => {
            let value = json!({"processId": config.process_id, "kernelEpoch": config.kernel_epoch,
                "status": "failed", "pid": null, "exitCode": null, "signal": null,
                "reason": format!("process spawn failed: {error}"), "treeConfirmed": true});
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
        thread::spawn(move || {
            let mut buffer = [0u8; 16384];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => { if send(&output, json!({"type":"output", "channel":channel, "bytesBase64":BASE64.encode(&buffer[..n])})).is_err() { STOP.store(2, Ordering::Release); break; } }
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
    thread::spawn(move || {
        for value in input_rx {
            let sequence = value["sequence"].as_u64().unwrap_or(0);
            let result = BASE64
                .decode(value["bytesBase64"].as_str().unwrap_or_default())
                .map_err(io::Error::other)
                .and_then(|bytes| input.write_all(&bytes))
                .and_then(|_| input.flush());
            let error = result.err().map(|error| error.to_string());
            let eof = value["eof"].as_bool().unwrap_or(false);
            if eof {
                drop(input);
                let _ = send(
                    &input_output,
                    json!({"type":"input", "sequence":sequence, "error":error}),
                );
                return;
            }
            if send(
                &input_output,
                json!({"type":"input", "sequence":sequence, "error":error}),
            )
            .is_err()
            {
                return;
            }
        }
    });
    let control_output = output.clone();
    let control_master = master.clone();
    #[cfg(windows)]
    let control_job = job.clone();
    thread::spawn(move || {
        let mut input = io::stdin().lock();
        while let Ok(Some(frame)) = read_frame(&mut input) {
            let Ok(value) = serde_json::from_slice::<Value>(&frame) else {
                break;
            };
            match value["type"].as_str() {
                Some("write") => {
                    if let Err(error) = input_tx.try_send(value) {
                        let value = match error {
                            mpsc::TrySendError::Full(value)
                            | mpsc::TrySendError::Disconnected(value) => value,
                        };
                        let _ = send(
                            &control_output,
                            json!({"type":"input", "sequence":value["sequence"], "error":"process stdin queue is unavailable"}),
                        );
                    }
                }
                Some("resize") => {
                    let size = PtySize {
                        cols: value["cols"].as_u64().unwrap_or(80) as u16,
                        rows: value["rows"].as_u64().unwrap_or(24) as u16,
                        pixel_width: 0,
                        pixel_height: 0,
                    };
                    if let Ok(master) = control_master.lock() {
                        if master
                            .as_ref()
                            .is_some_and(|master| master.resize(size).is_err())
                        {
                            let _ = send(
                                &control_output,
                                json!({"type":"control-error", "reason":"PTY resize failed"}),
                            );
                        }
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
    let exit = loop {
        if STOP.load(Ordering::Acquire) > 0 {
            let started = stop_started.get_or_insert_with(Instant::now);
            let force =
                STOP.load(Ordering::Acquire) > 1 || started.elapsed() >= Duration::from_secs(1);
            #[cfg(unix)]
            platform::terminate_session(pid, force)?;
            #[cfg(windows)]
            {
                let _ = force;
                child.kill()?;
            }
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| io::Error::other(format!("native target exit observation: {error}")))?
        {
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
    for reader in readers.drain(..) {
        let _ = reader.join();
    }
    let value = json!({"processId":config.process_id, "kernelEpoch":config.kernel_epoch,
        "status":"exited", "pid":pid, "exitCode":if exit.signal().is_none() { Some(exit.exit_code()) } else { None },
        "signal":exit.signal(), "reason":null, "treeConfirmed":true});
    receipt(&config, &value)?;
    send(&output, json!({"type":"receipt", "value":value}))?;
    // Process-local input threads die here. The main binary exits immediately.
    Ok(())
}
