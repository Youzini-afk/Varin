//! Guardian startup is a detached executor of the original process admission.
//! It returns handles to the same ProcessManager; it never owns durable records.
use super::*;

pub(crate) struct Launch {
    pub(crate) id: String,
    config: Value,
    executable: PathBuf,
    terminal: Option<mpsc::Sender<ProcessTerminal>>,
    controls: ProcessControlRegistry,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
    pub(crate) configuration_possible: Arc<std::sync::atomic::AtomicBool>,
}
pub(super) struct Starting {
    pub(super) run: Option<String>,
    pub(super) cancelled: Arc<std::sync::atomic::AtomicBool>,
}
pub(crate) struct Started {
    id: String,
    live: LiveProcess,
    output: OutputHandle,
}
impl Launch {
    pub(crate) fn run(self) -> Result<Started, KernelError> {
        if self.cancelled.load(std::sync::atomic::Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let id = self.id.as_str();
        let config = self.config;
        let executable = self.executable;
        let mut command = Command::new(executable);
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
            observers: Default::default(),
            guardian: guardian.clone(),
            containment: containment.clone(),
            input: input.clone(),
            run_id: config["runId"].as_str().map(str::to_owned),
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
        if self.cancelled.load(std::sync::atomic::Ordering::Acquire) {
            if let Ok(mut child) = guardian.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Err(KernelError::Cancelled);
        }
        let writer_shared = shared.clone();
        self.configuration_possible
            .store(true, std::sync::atomic::Ordering::Release);
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
                writer_shared.notify();
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
                        Some("input-chunk" | "interaction") => {
                            let receipt: interaction::Receipt =
                                serde_json::from_value(value["receipt"].clone())?;
                            let mut buffer = reader_shared.lock();
                            if receipt.identity().process_id != process_id
                                || receipt.identity().kernel_epoch != kernel_epoch
                            {
                                return Err(io::Error::other("foreign native interaction receipt"));
                            }
                            let Some(progress) = buffer
                                .interactions
                                .active
                                .get_mut(&receipt.identity().operation_id)
                            else {
                                // Final local failure and guardian tree-drain can race. The original
                                // reservation is already settled; a late final cannot reopen it.
                                if value["type"] == "interaction" {
                                    continue;
                                }
                                return Err(io::Error::other(
                                    "unknown native interaction acknowledgement",
                                ));
                            };
                            if !receipt.follows(&progress.receipt) {
                                return Err(io::Error::other(
                                    "invalid native interaction receipt identity",
                                ));
                            }
                            progress.receipt = receipt.clone();
                            progress.chunk = value["chunk"].as_u64().unwrap_or(progress.chunk);
                            progress.final_receipt = value["type"] == "interaction";
                            if progress.final_receipt {
                                buffer.input_sequence = buffer
                                    .input_sequence
                                    .max(receipt.identity().sequence as i64);
                                buffer.input_error = receipt.identity().reason.clone();
                            }
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
                    reader_shared.notify();
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
                reader_shared.notify();
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
                    data_shared.notify();
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
            data_shared.notify();
            // Closing a failed data pipe makes guardian readers request stopping and drain/discard
            // remaining target output. No successful complete-log claim is made.
        });

        Ok(Started {
            id: id.into(),
            output: OutputHandle {
                shared: shared.clone(),
                output_path: spool_path.clone(),
                cursor: Arc::new(Mutex::new(SpoolCursor::default())),
            },
            live: LiveProcess {
                guardian,
                containment,
                input,
                control,
                shared,
                guardian_exited: false,
                output_path: spool_path,
            },
        })
    }
}
impl ProcessManager {
    pub(crate) fn prepare_launch(
        &mut self,
        id: &str,
        config: Value,
    ) -> Result<Launch, KernelError> {
        if self.live.contains_key(id) || self.starting.contains_key(id) {
            return Err(failure("process identity is already live or starting"));
        }
        let executable = std::env::current_exe()?;
        #[cfg(test)]
        let executable = self.worker_executable.clone().unwrap_or(executable);
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        self.starting.insert(
            id.into(),
            Starting {
                run: config["runId"].as_str().map(str::to_owned),
                cancelled: cancelled.clone(),
            },
        );
        Ok(Launch {
            id: id.into(),
            config,
            executable,
            terminal: self.terminal.clone(),
            controls: self.controls.clone(),
            cancelled,
            configuration_possible: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })
    }
    pub(crate) fn finish_launch(
        &mut self,
        id: &str,
        result: Result<Started, KernelError>,
    ) -> Result<(), KernelError> {
        let cancelled = self.starting.remove(id).is_some_and(|starting| {
            starting
                .cancelled
                .load(std::sync::atomic::Ordering::Acquire)
        });
        let started = match result {
            Ok(started) => started,
            Err(error) => {
                self.controls.release(id);
                return Err(error);
            }
        };
        if started.id != id || self.live.contains_key(id) {
            return Err(failure("Original guardian startup identity changed"));
        }
        self.outputs.insert(id.into(), started.output);
        self.live.insert(id.into(), started.live);
        if cancelled {
            let _ = self.kill(id, true);
        }
        Ok(())
    }
    pub(crate) fn is_starting(&self, id: &str) -> bool {
        self.starting.contains_key(id)
    }
    pub(crate) fn abandon_uncertain_launch(&mut self, id: &str) -> Result<(), KernelError> {
        self.starting.remove(id);
        self.controls.stop_registered(id, true).map(|_| ())
    }
}
