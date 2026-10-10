//! Original guardian behavior, without substituting a fake Host transport.
use crate::error::KernelError;
use crate::process::interaction::{Input, Receipt, State};
use crate::storage::{
    process_interactions::{Address, Client, Context},
    Storage,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use varin_runtime::execution::CancellationToken;
const HOST: &str = "input-review-host";
const GENERATION: &str = "input-review-generation";
const EPOCH: &str = "input-review-epoch";
struct Fixture {
    root: PathBuf,
    storage: Arc<Mutex<Option<Storage>>>,
    client: Client,
    root_id: String,
    epoch: Arc<Mutex<String>>,
}
impl Fixture {
    fn new() -> Self {
        let executable = std::env::var_os("VARIN_TEST_KERNEL_EXECUTABLE")
            .map(PathBuf::from)
            .expect("fresh kernel binary required");
        assert!(executable.is_file());
        let root =
            std::env::temp_dir().join(format!("varin-input-review-{}", uuid::Uuid::new_v4()));
        let cwd = root.join("work");
        std::fs::create_dir_all(&cwd).unwrap();
        let mut storage = Storage::open(&root.join("storage"), HOST).unwrap();
        storage.set_test_process_worker_executable(executable);
        for (grant, run) in [
            ("original", "run"),
            ("current", "run"),
            ("foreign", "other-run"),
        ] {
            storage.issue_grant(&json!({"grantId":grant,"hostGeneration":GENERATION,"capabilities":["storage.admin","process"],"pathScopes":[""],"owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"thread","runId":run}),HOST,GENERATION,&root.join("storage").to_string_lossy(),EPOCH).unwrap();
        }
        let params = json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":cwd});
        let (grant, params) = storage
            .authorize(
                Some("original"),
                EPOCH,
                HOST,
                GENERATION,
                "file.root.register",
                &params,
            )
            .unwrap();
        let registered = storage
            .dispatch("file.root.register", &params, Some("original"), &grant)
            .unwrap();
        let root_id = registered["rootId"].as_str().unwrap().to_string();
        let storage = Arc::new(Mutex::new(Some(storage)));
        let owner = storage.clone();
        let epoch = Arc::new(Mutex::new(EPOCH.to_string()));
        let selected_epoch = epoch.clone();
        let client = Client::new(move |command| {
            owner.lock().unwrap().as_mut().unwrap().serve_interaction(
                command,
                &selected_epoch.lock().unwrap(),
                HOST,
                GENERATION,
            );
            Ok(())
        });
        Self {
            root,
            storage,
            client,
            root_id,
            epoch,
        }
    }
    fn context(&self, grant: &str) -> Context {
        Context {
            grant_id: grant.into(),
            epoch: Some(self.epoch.lock().unwrap().clone()),
            binding: None,
        }
    }
    fn address(&self, process: &str, operation: &str) -> Address {
        Address {
            workspace_id: "workspace".into(),
            process_id: process.into(),
            operation_id: operation.into(),
            root_id: Some(self.root_id.clone()),
        }
    }
    fn dispatch(&self, method: &str, params: Value) -> Result<Value, KernelError> {
        let mut locked = self.storage.lock().unwrap();
        let storage = locked.as_mut().unwrap();
        let (grant, params) =
            storage.authorize(Some("original"), EPOCH, HOST, GENERATION, method, &params)?;
        storage.dispatch(method, &params, Some("original"), &grant)
    }
    fn spawn(&self, id: &str, script: &str, mode: &str) -> Result<Value, KernelError> {
        self.dispatch("process.spawn",json!({"workspaceId":"workspace","rootId":self.root_id,"processId":id,"__runId":"run","cwd":"","command":"/bin/sh","args":["-c",script],"env":[],"mode":mode,"cols":80,"rows":24}))
    }
    fn write(&self, id: &str, operation: &str, bytes: Vec<u8>, eof: bool) -> Receipt {
        self.client
            .invoke(
                self.context("current"),
                self.address(id, operation),
                || {
                    Ok(Input::Write {
                        bytes: bytes.into(),
                        eof,
                    })
                },
                None,
                CancellationToken::default(),
            )
            .unwrap()
    }
    fn read(&self, id: &str) -> Value {
        self.dispatch("process.read",json!({"workspaceId":"workspace","processId":id,"rootId":self.root_id,"cursor":0,"maxBytes":65536})).unwrap()
    }
    fn wait(&self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let observed = self
                .dispatch(
                    "process.inspect",
                    json!({"workspaceId":"workspace","rootId":self.root_id,"processId":id}),
                )
                .unwrap();
            if observed["writerActive"] == false {
                return observed;
            }
            assert!(
                Instant::now() < deadline,
                "process did not stop: {observed}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self
            .storage
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .shutdown_processes();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
#[test]
#[ignore = "requires a freshly built kernel executable"]
fn real_guardian_input_shared_sequence_dedup_large_body_and_durable_receipt() {
    let f = Fixture::new();
    f.spawn(
        "pipe",
        "IFS= read -r first; IFS= read -r second; printf '%s:%s' \"${#first}\" \"$second\"",
        "pipe",
    )
    .unwrap();
    let mut large = vec![b'a'; 140_000];
    large.push(b'\n');
    let first = f.write("pipe", "first", large.clone(), false);
    assert!(
        matches!(&first,Receipt::Write{identity,requested_bytes:140001,confirmed_bytes:140001,eof_applied:false,..} if identity.state==State::Applied),
        "{first:?}"
    );
    assert_eq!(f.write("pipe", "first", large, false), first);
    assert!(f
        .client
        .invoke(
            f.context("current"),
            f.address("pipe", "first"),
            || Ok(Input::Write {
                bytes: Arc::from(b"different".as_slice()),
                eof: false
            }),
            None,
            CancellationToken::default()
        )
        .is_err());
    let second = f.write("pipe", "second", b"end\n".to_vec(), true);
    assert_eq!(second.identity().sequence, first.identity().sequence + 1);
    assert_eq!(second.identity().state, State::Applied);
    f.wait("pipe");
    let read = f.read("pipe");
    let text = read["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|chunk| {
            use base64::Engine;
            String::from_utf8(
                base64::engine::general_purpose::STANDARD
                    .decode(chunk["bytesBase64"].as_str().unwrap())
                    .unwrap(),
            )
            .unwrap()
        })
        .collect::<String>();
    assert_eq!(text, "140000:end");
    assert_eq!(
        f.client
            .inspect(f.context("current"), f.address("pipe", "first"))
            .unwrap(),
        Some(first)
    );
    assert!(f
        .client
        .inspect(f.context("foreign"), f.address("pipe", "first"))
        .is_err());
    assert!(f
        .client
        .inspect(f.context("current"), f.address("pipe", "missing"))
        .unwrap()
        .is_none());
}
#[test]
#[ignore = "requires a freshly built kernel executable"]
fn blocked_input_cancel_keeps_process_and_storage_live_then_reports_actual_partial() {
    let f = Fixture::new();
    f.spawn("blocked","dd bs=1 count=1 >/dev/null 2>/dev/null; printf started; while [ ! -f release ]; do sleep 0.01; done; head -c 65535 >/dev/null; sleep 20","pipe").unwrap();
    let cancel = CancellationToken::default();
    let worker_cancel = cancel.clone();
    let client = f.client.clone();
    let context = f.context("current");
    let address = f.address("blocked", "blocked-write");
    let worker = std::thread::spawn(move || {
        client.invoke(
            context,
            address,
            || {
                Ok(Input::Write {
                    bytes: vec![b'x'; 2 * 1024 * 1024].into(),
                    eof: false,
                })
            },
            None,
            worker_cancel,
        )
    });
    // One byte has reached the actual child, which now waits on a separate release file.
    // The much larger write is blocked and cannot finish until this test releases it.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let read = f.read("blocked");
        if read["endCursor"].as_u64().unwrap_or(0) > 0 {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
    cancel.cancel();
    let result = worker.join().unwrap().unwrap();
    assert_eq!(result.identity().state, State::Unknown);
    let alive = f
        .dispatch(
            "process.inspect",
            json!({"workspaceId":"workspace","rootId":f.root_id,"processId":"blocked"}),
        )
        .unwrap();
    assert_eq!(alive["writerActive"], true);
    // Independent process admission and I/O still use the same Storage owner.
    f.spawn("other", "printf independent", "pipe").unwrap();
    f.wait("other");
    assert_eq!(
        f.client
            .inspect(f.context("current"), f.address("blocked", "blocked-write"))
            .unwrap()
            .unwrap()
            .identity()
            .state,
        State::Unknown
    );
    std::fs::write(f.root.join("work/release"), b"release").unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    let receipt = loop {
        let receipt = f
            .client
            .inspect(f.context("current"), f.address("blocked", "blocked-write"))
            .unwrap()
            .unwrap();
        if receipt.identity().state != State::Unknown {
            break receipt;
        }
        assert!(
            Instant::now() < deadline,
            "input did not settle: {receipt:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(
        matches!(&receipt,Receipt::Write{identity,confirmed_bytes,requested_bytes:2097152,eof_applied:false,..} if identity.state==State::Partial && *confirmed_bytes>0 && *confirmed_bytes<2097152 && *confirmed_bytes%65536==0),
        "{receipt:?}"
    );
    assert!(receipt.identity().cancelled);
    f.dispatch(
        "process.kill",
        json!({"workspaceId":"workspace","rootId":f.root_id,"processId":"blocked","force":true}),
    )
    .unwrap();
    f.wait("blocked");
}
#[test]
#[ignore = "requires a freshly built kernel executable and a real PTY"]
fn real_pty_resize_ack_input_and_eof_rejection() {
    let f = Fixture::new();
    f.spawn(
        "pty",
        "IFS= read -r line; stty size; printf '%s' \"$line\"",
        "pty",
    )
    .unwrap();
    // Start the later worker first after both real reservations. It must not
    // resize ahead of the earlier accepted operation and leave the PTY stale.
    let (larger, resized) = std::thread::scope(|scope| {
        let f = &f;
        let (first_ready, first_admitted) = std::sync::mpsc::channel();
        let (release, held) = std::sync::mpsc::channel();
        let held = Mutex::new(held);
        let first = f.client.clone().with_watch(move |_, _| {
            first_ready.send(()).unwrap();
            held.lock().unwrap().recv().unwrap();
            Ok(varin_runtime::execution_capacity::AdmissionControlGuard::new(|| {}))
        });
        let first_run = scope.spawn(move || {
            first
                .invoke(
                    f.context("current"),
                    f.address("pty", "larger-than-ui"),
                    || {
                        Ok(Input::Resize {
                            cols: 1001,
                            rows: 501,
                        })
                    },
                    None,
                    CancellationToken::default(),
                )
                .unwrap()
        });
        first_admitted.recv_timeout(Duration::from_secs(5)).unwrap();
        let (second_ready, second_admitted) = std::sync::mpsc::channel();
        let second = f.client.clone().with_watch(move |_, _| {
            second_ready.send(()).unwrap();
            Ok(varin_runtime::execution_capacity::AdmissionControlGuard::new(|| {}))
        });
        let (done, result) = std::sync::mpsc::channel();
        scope.spawn(move || {
            done.send(
                second
                    .invoke(
                        f.context("current"),
                        f.address("pty", "resize"),
                        || {
                            Ok(Input::Resize {
                                cols: 111,
                                rows: 41,
                            })
                        },
                        None,
                        CancellationToken::default(),
                    )
                    .unwrap(),
            )
            .unwrap();
        });
        second_admitted
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        let premature = result.recv_timeout(Duration::from_millis(100));
        release.send(()).unwrap();
        let larger = first_run.join().unwrap();
        assert!(
            premature.is_err(),
            "later resize bypassed original accepted order"
        );
        (larger, result.recv_timeout(Duration::from_secs(5)).unwrap())
    });
    assert_eq!(larger.identity().state, State::Applied);
    assert_eq!(resized.identity().state, State::Applied);
    assert_eq!(resized.identity().sequence, larger.identity().sequence + 1);
    assert!(f
        .client
        .invoke(
            f.context("current"),
            f.address("pty", "eof"),
            || Ok(Input::Write {
                bytes: Arc::from([]),
                eof: true
            }),
            None,
            CancellationToken::default()
        )
        .is_err());
    let written = f.write("pty", "pty-input", b"hello\n".to_vec(), false);
    assert_eq!(written.identity().state, State::Applied);
    assert_eq!(written.identity().sequence, resized.identity().sequence + 1);
    f.wait("pty");
    let read = f.read("pty");
    let text = read["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|chunk| {
            use base64::Engine;
            String::from_utf8_lossy(
                &base64::engine::general_purpose::STANDARD
                    .decode(chunk["bytesBase64"].as_str().unwrap())
                    .unwrap(),
            )
            .into_owned()
        })
        .collect::<String>();
    assert!(text.contains("41 111"), "{text}");
    assert!(text.contains("hello"), "{text}");
}

#[test]
#[ignore = "requires a freshly built kernel executable"]
fn original_guardian_receipt_recovers_after_storage_reopen_without_replaying_bytes() {
    use crate::storage::process_interactions::{Admission, Command};
    let mut f = Fixture::new();
    f.spawn("reopen", "IFS= read -r line; printf '%s' \"$line\"", "pipe")
        .unwrap();
    let input = Input::Write {
        bytes: Arc::from(b"once\n".as_slice()),
        eof: true,
    };
    let (reply, receive) = std::sync::mpsc::channel();
    f.storage
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .serve_interaction(
            Command::Prepare {
                context: f.context("current"),
                address: f.address("reopen", "lost-reply"),
                digest: input.digest(),
                input: input.clone(),
                native: None,
                reply,
            },
            EPOCH,
            HOST,
            GENERATION,
        );
    let Admission::New { intent, task } = receive.recv().unwrap().unwrap() else {
        panic!("expected original reservation")
    };
    // A prior uncertain observation must not hide the guardian's later final file.
    let (reply, done) = std::sync::mpsc::channel();
    f.storage
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .serve_interaction(
            Command::Finish {
                receipt: intent.receipt.clone(),
                intent,
                reply,
            },
            EPOCH,
            HOST,
            GENERATION,
        );
    done.recv().unwrap().unwrap();
    assert_eq!(
        f.client
            .inspect(f.context("current"), f.address("reopen", "lost-reply"))
            .unwrap()
            .unwrap()
            .identity()
            .state,
        State::Unknown
    );
    let mut observed = None;
    task.run(input, CancellationToken::default(), |receipt, finished| {
        assert!(finished);
        observed = Some(receipt);
    });
    let actual = observed.unwrap();
    assert_eq!(actual.identity().state, State::Applied);
    f.wait("reopen");
    let old = f.storage.lock().unwrap().take().unwrap();
    drop(old);
    let mut storage = Storage::open(&f.root.join("storage"), HOST).unwrap();
    let fresh = "input-review-reopened-epoch";
    storage.issue_grant(&json!({"grantId":"reopened","hostGeneration":GENERATION,"capabilities":["storage.admin","process"],"pathScopes":[""],"owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"thread","runId":"run"}),HOST,GENERATION,&f.root.join("storage").to_string_lossy(),fresh).unwrap();
    let params = json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":f.root.join("work")});
    let (grant, params) = storage
        .authorize(
            Some("reopened"),
            fresh,
            HOST,
            GENERATION,
            "file.root.register",
            &params,
        )
        .unwrap();
    let registered = storage
        .dispatch("file.root.register", &params, Some("reopened"), &grant)
        .unwrap();
    f.root_id = registered["rootId"].as_str().unwrap().into();
    *f.epoch.lock().unwrap() = fresh.into();
    *f.storage.lock().unwrap() = Some(storage);
    let recovered = f
        .client
        .inspect(f.context("reopened"), f.address("reopen", "lost-reply"))
        .unwrap()
        .unwrap();
    assert_eq!(recovered, actual);
    assert_eq!(
        f.client
            .inspect(f.context("reopened"), f.address("reopen", "lost-reply"))
            .unwrap(),
        Some(actual)
    );
    assert!(f
        .client
        .invoke(
            f.context("reopened"),
            f.address("reopen", "new-write"),
            || Ok(Input::Write {
                bytes: Arc::from(b"again".as_slice()),
                eof: false
            }),
            None,
            CancellationToken::default()
        )
        .is_err());
}

#[test]
#[ignore = "requires a freshly built kernel executable"]
fn receipt_publication_failure_keeps_actual_prefix_and_never_replays_input() {
    let f = Fixture::new();
    f.spawn(
        "disk",
        "IFS= read -r first; IFS= read -r second; printf '%s:%s' \"$first\" \"$second\"",
        "pipe",
    )
    .unwrap();
    let path = crate::process::interaction::path(
        &crate::process::receipt_path(&f.root.join("storage"), "disk"),
        "first",
    );
    let blocked = path.with_extension("interaction.tmp");
    std::fs::create_dir(&blocked).unwrap();
    let receipt = f.write("disk", "first", b"first\n".to_vec(), false);
    assert!(
        matches!(&receipt,Receipt::Write{identity,confirmed_bytes:6,..} if identity.state==State::Unknown),
        "{receipt:?}"
    );
    assert_eq!(
        f.write("disk", "first", b"first\n".to_vec(), false),
        receipt
    );
    std::fs::remove_dir(blocked).unwrap();
    let second = f.write("disk", "second", b"second\n".to_vec(), true);
    assert_eq!(second.identity().state, State::Applied);
    f.wait("disk");
    let read = f.read("disk");
    let text = read["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|chunk| {
            use base64::Engine;
            String::from_utf8_lossy(
                &base64::engine::general_purpose::STANDARD
                    .decode(chunk["bytesBase64"].as_str().unwrap())
                    .unwrap(),
            )
            .into_owned()
        })
        .collect::<String>();
    assert_eq!(text, "first:second");
}
#[test]
#[ignore = "requires a freshly built kernel executable"]
fn failed_control_registration_is_durable_no_effect_and_releases_stdin_reservation() {
    let f = Fixture::new();
    f.spawn("watch", "IFS= read -r line; printf '%s' \"$line\"", "pipe")
        .unwrap();
    let rejected = f
        .client
        .clone()
        .with_watch(|_, _| Err(KernelError::Storage("injected registration failure".into())));
    let receipt = rejected
        .invoke(
            f.context("current"),
            f.address("watch", "rejected"),
            || {
                Ok(Input::Write {
                    bytes: Arc::from(b"never\n".as_slice()),
                    eof: false,
                })
            },
            None,
            CancellationToken::default(),
        )
        .unwrap();
    assert_eq!(receipt.identity().state, State::NotApplied);
    assert_eq!(
        f.client
            .inspect(f.context("current"), f.address("watch", "rejected"))
            .unwrap(),
        Some(receipt)
    );
    let actual = f.write("watch", "actual", b"actual\n".to_vec(), true);
    assert_eq!(actual.identity().state, State::Applied);
    f.wait("watch");
}

#[test]
#[ignore = "requires a freshly built kernel executable"]
fn native_subscription_tracks_both_grants_and_alias_detach_keeps_original_process() {
    let f = Fixture::new();
    let (events, received) = std::sync::mpsc::sync_channel(64);
    f.storage
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .set_process_subscriptions(crate::process::subscriptions::ProcessSubscriptions::new(
            events,
        ));
    f.spawn(
        "subscriptions",
        "IFS= read -r line; printf '%s' \"$line\"",
        "pipe",
    )
    .unwrap();
    let subscribe = |actor: &str, id: &str| {
        let mut owner = f.storage.lock().unwrap();
        let storage = owner.as_mut().unwrap();
        let params = json!({"workspaceId":"workspace","rootId":f.root_id,"processId":"subscriptions","subscriptionId":id,"cursor":0});
        let (grant, params) = storage
            .authorize(
                Some(actor),
                EPOCH,
                HOST,
                GENERATION,
                "process.subscribe",
                &params,
            )
            .unwrap();
        storage
            .dispatch("process.subscribe", &params, Some(actor), &grant)
            .unwrap();
    };
    let closed = |id: &str| {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let event = received
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            if event["subscriptionId"] == id && event["stream"] == "closed" {
                assert!(event["error"].as_str().unwrap().contains("revoked"));
                break;
            }
        }
    };
    subscribe("current", "current-view");
    let revoked = f
        .storage
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .revoke_grant(&json!({"grantId":"current"}), HOST)
        .unwrap();
    assert_eq!(revoked["pendingProcesses"], json!([]));
    closed("current-view");
    let alive = f
        .dispatch(
            "process.inspect",
            json!({"workspaceId":"workspace","rootId":f.root_id,"processId":"subscriptions"}),
        )
        .unwrap();
    assert_eq!(alive["writerActive"], true);
    f.storage.lock().unwrap().as_mut().unwrap().issue_grant(&json!({"grantId":"alias2","hostGeneration":GENERATION,"capabilities":["storage.admin","process"],"pathScopes":[""],"owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"thread","runId":"run"}),HOST,GENERATION,&f.root.join("storage").to_string_lossy(),EPOCH).unwrap();
    subscribe("alias2", "dependent-view");
    f.storage
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .revoke_grant(&json!({"grantId":"original"}), HOST)
        .unwrap();
    closed("dependent-view");
    assert!(f
        .client
        .inspect(f.context("alias2"), f.address("subscriptions", "missing"))
        .is_err());
}
