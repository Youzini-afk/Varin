#![cfg(windows)]
//! These tests start the shipped helper and its real same-user named pipe.
//! They never query an application, capture the desktop, focus or inject input.
use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Helper {
    child: Child,
    input: Option<ChildStdin>,
    responses: mpsc::Receiver<std::result::Result<Value, String>>,
}
impl Helper {
    fn start(role: &str, pipe: Option<&str>) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_VarinComputer"));
        command
            .env("VARIN_DRIVER_ROLE", role)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if let Some(pipe) = pipe {
            command.env("VARIN_DRIVER_CONTROL_PIPE", pipe);
        } else {
            command.env_remove("VARIN_DRIVER_CONTROL_PIPE");
        }
        let mut child = command.spawn().unwrap();
        let input = child.stdin.take();
        let output = child.stdout.take().unwrap();
        let (sender, responses) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else {
                    break;
                };
                if sender
                    .send(
                        serde_json::from_str(&line)
                            .map_err(|_| "Non-protocol output on helper stdout".to_owned()),
                    )
                    .is_err()
                {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            responses,
        }
    }
    fn request(&mut self, value: Value) -> Value {
        writeln!(self.input.as_mut().unwrap(), "{value}").unwrap();
        self.input.as_mut().unwrap().flush().unwrap();
        let response = self
            .responses
            .recv_timeout(Duration::from_secs(10))
            .expect("helper protocol response")
            .expect("stdout contains only JSON protocol");
        assert_eq!(response["id"], value["id"]);
        response
    }
    fn close(mut self) {
        self.input.take();
        for _ in 0..100 {
            if self.child.try_wait().unwrap().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("helper did not exit after Host stdin EOF");
    }
}
impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn command(pipe: &mut BufReader<File>, value: Value) -> Value {
    writeln!(pipe.get_mut(), "{value}").unwrap();
    pipe.get_mut().flush().unwrap();
    let mut line = String::new();
    pipe.read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}
#[test]
fn capture_handshake_is_native_and_rejects_mutations() {
    let mut helper = Helper::start("capture", None);
    let ping = helper.request(json!({"id":"hello","tool":"ping"}));
    assert_eq!(ping["ok"], true);
    assert_eq!(ping["protocolVersion"], 1);
    assert!(ping["build"]["buildId"].is_string());
    let rejected = helper.request(
        json!({"id":"not-input","tool":"inject_input","kind":"text","text":"must not be injected"}),
    );
    assert_eq!(rejected["ok"], false);
    assert_eq!(rejected["rejected"], true);
    assert_eq!(rejected["receipt"]["effect"], "none");
    helper.close();
}
#[test]
fn control_pipe_cancels_before_dispatch_reuses_health_and_retires_permanently() {
    let pipe = format!(
        r"\\.\pipe\varin-computer-test-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let mut helper = Helper::start("input", Some(&pipe));
    assert_eq!(
        helper.request(json!({"id":"ready","tool":"ping"}))["ok"],
        true
    );
    let mut channel = BufReader::new(
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(&pipe)
            .unwrap(),
    );
    assert_eq!(
        command(
            &mut channel,
            json!({"id":"cancel","command":"cancel","requestId":"future"})
        )["released"],
        true
    );
    let cancelled = helper.request(json!({"id":"future","tool":"ping"}));
    assert_eq!(cancelled["cancelled"], true);
    assert_eq!(cancelled["receipt"]["effect"], "none");
    assert_eq!(
        helper.request(json!({"id":"healthy","tool":"ping"}))["ok"],
        true
    );
    assert_eq!(
        command(
            &mut channel,
            json!({"id":"stop","command":"interrupt","restoreFocus":false})
        )["released"],
        true
    );
    assert_eq!(
        helper.request(json!({"id":"retired","tool":"ping"}))["cancelled"],
        true
    );
    helper.close();
}
#[test]
fn malformed_request_returns_original_id_without_echoing_contents() {
    let mut helper = Helper::start("capture", None);
    let response = helper.request(json!({"id":"bad","tool":17,"text":"private data"}));
    assert_eq!(response["id"], "bad");
    assert_eq!(response["rejected"], true);
    assert!(!response.to_string().contains("private data"));
    helper.close();
}

#[test]
fn launched_commands_do_not_inherit_the_helper_protocol() {
    use windows::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0},
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    let pipe = format!(
        r"\\.\pipe\varin-computer-test-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let mut helper = Helper::start("input", Some(&pipe));
    assert_eq!(
        helper.request(json!({"id":"ready","tool":"ping"}))["ok"],
        true
    );
    let _control = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&pipe)
        .unwrap();
    let response=helper.request(json!({"id":"open","tool":"open","command":"cmd.exe","args":["/d","/c","echo protocol-must-not-appear"]}));
    assert_eq!(response["ok"], true);
    unsafe {
        if let Ok(process) = OpenProcess(
            PROCESS_SYNCHRONIZE,
            false,
            response["pid"].as_u64().unwrap() as u32,
        ) {
            let result = WaitForSingleObject(process, 5000);
            let _ = CloseHandle(process);
            assert_eq!(result, WAIT_OBJECT_0);
        }
    }
    assert_eq!(
        helper.request(json!({"id":"after-open","tool":"ping"}))["ok"],
        true
    );
    helper.close();
}
