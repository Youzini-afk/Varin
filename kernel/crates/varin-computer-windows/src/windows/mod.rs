pub mod capture;
mod control;
pub mod input;
mod operations;
pub mod uia;
pub mod window;
use crate::protocol::{Failure, Request, Result};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Write},
    sync::{Arc, Mutex, mpsc},
    thread,
};
use windows::Win32::{
    System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize},
    UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext},
};

#[derive(Clone)]
pub struct Output(Arc<Mutex<io::Stdout>>);
impl Output {
    pub fn send(&self, value: &Value) -> Result<()> {
        let mut stream = self.0.lock().unwrap_or_else(|poison| poison.into_inner());
        serde_json::to_writer(&mut *stream, value).map_err(|_| {
            Failure::new("driver-error", "Could not write Computer protocol response")
        })?;
        stream
            .write_all(b"\n")
            .and_then(|_| stream.flush())
            .map_err(|_| Failure::new("driver-error", "The Application Host connection is closed"))
    }
    pub fn gesture(
        &self,
        request: &Request,
        phase: &str,
        mechanism: &str,
        point: Option<crate::protocol::Point>,
        to: Option<crate::protocol::Point>,
        target: Option<crate::protocol::Rect>,
    ) {
        if !request.boolean("visual_feedback") {
            return;
        }
        let mut event =
            json!({"id":request.id,"type":"gesture","phase":phase,"mechanism":mechanism});
        if let Some(point) = point {
            event["point"] = json!(point);
        }
        if let Some(to) = to {
            event["to"] = json!(to);
        }
        if let Some(target) = target {
            event["target"] = json!(target);
        }
        let _ = self.send(&event);
    }
}
pub fn run() -> Result<()> {
    let role = std::env::var("VARIN_DRIVER_ROLE").unwrap_or_else(|_| "input".into());
    if role != "input" && role != "capture" {
        return Err(Failure::new("driver-error", "Unknown Computer helper role"));
    }
    let capture_only = role == "capture";
    // The manifest normally sets this before startup. This fallback is for an
    // explicit source build; an already-established context is not changed.
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let owner = Arc::new(input::InputOwner::default());
    if !capture_only {
        let name = std::env::var("VARIN_DRIVER_CONTROL_PIPE").map_err(|_| {
            Failure::new(
                "driver-error",
                "The Application Host did not provide a Computer control pipe",
            )
        })?;
        control::start(&name, owner.clone())?;
    }
    let output = Output(Arc::new(Mutex::new(io::stdout())));
    let (sender, receiver) = mpsc::channel::<Request>();
    let worker_owner = owner.clone();
    let worker_output = output.clone();
    thread::Builder::new()
        .name("computer-mta".into())
        .spawn(move || {
            let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok();
            if initialized.is_err() {
                eprintln!("Varin Computer: Could not initialize the Windows COM apartment");
                std::process::exit(1);
            }
            let mut runtime =
                operations::Runtime::new(worker_owner.clone(), worker_output.clone(), capture_only);
            while let Ok(request) = receiver.recv() {
                let result = worker_owner
                    .begin_request(&request.id, !request.is_action())
                    .and_then(|_| runtime.execute(&request));
                let mut response = match result {
                    Ok(mut response) => {
                        if request.is_action() {
                            response["receipt"] = worker_owner.receipt(None);
                        }
                        response
                    }
                    Err(error) => {
                        // Automatic actions and failed human requests release only
                        // this instance's tracked input. Unknown semantic effects stay unknown.
                        let release = if request.is_action() {
                            worker_owner.release(false)
                        } else {
                            Ok(())
                        };
                        let mut response = worker_owner.failure(&error);
                        if release.is_err() {
                            response["inputReleased"] = json!(false);
                        }
                        response
                    }
                };
                response["id"] = json!(request.id);
                worker_owner.end();
                if worker_output.send(&response).is_err() {
                    worker_owner.interrupt(false);
                    std::process::exit(0);
                }
            }
            drop(runtime);
            unsafe {
                CoUninitialize();
            }
        })
        .map_err(|_| {
            Failure::new(
                "driver-error",
                "Could not start the Computer operation worker",
            )
        })?;
    // Main thread is exclusively the Host connection monitor. It never joins
    // a blocked UIA worker before fencing and releasing input on EOF.
    for line in io::stdin().lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        match Request::parse(&line) {
            Ok(request) => {
                if sender.send(request).is_err() {
                    break;
                }
            }
            Err(error) => {
                let id = serde_json::from_str::<Value>(&line)
                    .ok()
                    .and_then(|value| value.get("id").and_then(Value::as_str).map(str::to_owned));
                let _ =
                    output.send(&json!({"id":id,"ok":false,"rejected":true,"error":error.message}));
            }
        }
    }
    owner.interrupt(false);
    // Process exit closes COM/capture/pipe handles even when the provider never
    // returns. The Host observes actual process closure, not merely a rejected wait.
    std::process::exit(0);
}
