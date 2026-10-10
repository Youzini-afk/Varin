//! Actual private User admission and file adapter with real Storage/Catalog/FS.
//! The selected Host owner is a narrow controlled reply fixture, not Host IPC evidence.
use super::*;
use crate::{
    file_observation::Client, host_query::OwnerChannel, storage::Storage,
    tools::KernelResourceClient,
};
use std::collections::BTreeSet;
use varin_runtime::{
    catalog::{followups::*, launches::LaunchSelection},
    execution::*,
    RunState,
};
const HOST: &str = "file-adapter-host";
const EPOCH: &str = "file-adapter-epoch";
const GENERATION: &str = "file-adapter-generation";
#[derive(Default)]
struct WatchOwner {
    open: BTreeSet<String>,
    begin: usize,
    sequence: u64,
    unstable: bool,
    failure: Option<String>,
}
struct Fixture {
    root: PathBuf,
    root_id: String,
    run: String,
    runtime: Arc<RunSupervisor>,
    storage: Arc<Mutex<Storage>>,
    client: Client,
    resources: KernelResourceClient,
    bridge: OwnerChannel,
    watch: Arc<Mutex<WatchOwner>>,
    hints: mpsc::Receiver<String>,
    host: Option<JoinHandle<()>>,
}
fn dispatch(storage: &mut Storage, grant: &str, method: &str, params: Value) -> Value {
    let (authority, params) = storage
        .authorize(Some(grant), EPOCH, HOST, GENERATION, method, &params)
        .unwrap();
    storage
        .dispatch(method, &params, Some(grant), &authority)
        .unwrap()
}
impl Fixture {
    fn new() -> Self {
        Self::with_fixed(false)
    }
    fn with_fixed(fixed: bool) -> Self {
        let root = std::env::temp_dir().join(format!("file-adapter-{}", uuid::Uuid::new_v4()));
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("result.txt"), b"first").unwrap();
        let mut storage = Storage::open(&root.join("storage"), HOST).unwrap();
        for (id, capabilities, paths) in [
            ("writer", vec!["storage.admin"], vec![""]),
            ("reader", vec!["storage.read"], vec!["result.txt"]),
        ] {
            storage.issue_grant(&json!({"grantId":id,"hostGeneration":GENERATION,"capabilities":capabilities,"pathScopes":paths,"threadId":"thread","owningWorkspace":"workspace","executionWorkspace":"workspace"}),HOST,GENERATION,&root.join("storage").to_string_lossy(),EPOCH).unwrap();
        }
        let registered = dispatch(
            &mut storage,
            "writer",
            "file.root.register",
            json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":work}),
        );
        let root_id = registered["rootId"].as_str().unwrap().to_owned();
        let source = if fixed {
            dispatch(
                &mut storage,
                "writer",
                "branch.create.begin",
                json!({"operationId":"fixed","builderId":"fixed","workspaceId":"workspace","branchId":"fixed","draftBasePaths":[],"captureScopes":[]}),
            );
            dispatch(
                &mut storage,
                "writer",
                "branch.create.append",
                json!({"builderId":"fixed","sequence":0,"entries":[{"path":"result.txt","state":{"kind":"directory","mode":493}}]}),
            );
            dispatch(
                &mut storage,
                "writer",
                "branch.create.finish",
                json!({"operationId":"fixed","builderId":"fixed"}),
            );
            json!({"mode":"fixed_branch","live_root":null,"workspace_id":"workspace","execution_workspace_id":"workspace","branch_id":"fixed","revision":0})
        } else {
            json!({"mode":"live_root","live_root":{"hostId":HOST,"rootId":root_id,"canonicalRoot":work},"workspace_id":"workspace","execution_workspace_id":"workspace","branch_id":null,"revision":null})
        };
        let launch:LaunchSelection=serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"fixture","provider_family":"fixture","model":"fixture","configuration_generation":1,"tool_schema_generation":1,"tools":[crate::followup_tools::schema()],"policy":{"name":"fixture","version":"1"},"source":source})).unwrap();
        let mut db = Catalog::open(root.join("catalog")).unwrap();
        db.create_thread("thread", "branch").unwrap();
        let p = db
            .prepare_submission(
                SubmitInput {
                    key: "initial".into(),
                    thread_id: "thread".into(),
                    branch_id: "branch".into(),
                    expected_head: None,
                    input: json!("Continue when the exact result is ready"),
                    configuration: json!({}),
                },
                None,
                None,
            )
            .unwrap()
            .load(Some(launch), false)
            .unwrap();
        let run = db.admit_submission(p).unwrap().run_id;
        db.commit_execution(
            &run,
            db.epoch(),
            &ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None,
            },
        )
        .unwrap();
        let runtime = Arc::new(RunSupervisor::new(db));
        let (tx, hints) = mpsc::channel();
        storage.set_file_observation_hints(move |hint| {
            if let crate::storage::file_observations::Hint::Root { root_id, .. } = hint {
                let _ = tx.send(root_id);
            }
        });
        let storage = Arc::new(Mutex::new(storage));
        let (tx, rx) = mpsc::sync_channel(64);
        let bridge = OwnerChannel::new("file-observation", tx);
        bridge.initialize(EPOCH);
        let watch = Arc::new(Mutex::new(WatchOwner::default()));
        let host = {
            let bridge = bridge.clone();
            let watch = watch.clone();
            std::thread::spawn(move || {
                while let Ok(frame) = rx.recv() {
                    if frame["kind"] != "file-observation-request" {
                        continue;
                    }
                    let query = &frame["query"];
                    let mut owner = watch.lock().unwrap();
                    let position = json!({"sourceId":"physical-source","generation":1,"sequence":owner.sequence});
                    let failure = owner
                        .failure
                        .clone()
                        .filter(|_| matches!(query["action"].as_str(), Some("begin" | "finish")));
                    let result = if let Some(code) = failure {
                        json!({"ok":false,"code":code})
                    } else {
                        match query["action"].as_str().unwrap() {
                            "open" => {
                                let id = uuid::Uuid::new_v4().to_string();
                                owner.open.insert(id.clone());
                                json!({"ok":true,"watchId":id,"position":position})
                            }
                            "begin" => {
                                assert!(owner.open.contains(query["watchId"].as_str().unwrap()));
                                owner.begin += 1;
                                json!({"ok":true,"token":uuid::Uuid::new_v4().to_string(),"position":position})
                            }
                            "finish" => {
                                json!({"ok":true,"position":position,"stable":!owner.unstable,"managedIdle":true,"gap":false,"targetedChange":query["after"]["sourceId"]=="physical-source" && query["after"]["sequence"].as_u64().is_some_and(|n|n<owner.sequence)})
                            }
                            "discard" => json!({"ok":true,"discarded":true}),
                            "close" => {
                                let closed = owner.open.remove(query["watchId"].as_str().unwrap());
                                json!({"ok":true,"closed":closed})
                            }
                            _ => panic!("unexpected owner query"),
                        }
                    };
                    drop(owner);
                    bridge.receive(json!({"v":1,"kind":"file-observation-response","id":frame["id"],"kernelEpoch":EPOCH,"result":result}));
                }
            })
        };
        let client = {
            let storage = storage.clone();
            Client::new(
                move |command| {
                    command.serve(Some(&mut storage.lock().unwrap()), EPOCH, HOST, GENERATION);
                    Ok(())
                },
                bridge.clone(),
            )
        };
        let resources = KernelResourceClient::new(
            |_| {
                Err(KernelError::Operation(
                    "unexpected ordinary resource call".into(),
                ))
            },
            |_| Ok(()),
            Default::default(),
        )
        .with_file_observations(client.clone());
        Self {
            root,
            root_id,
            run,
            runtime,
            storage,
            client,
            resources,
            bridge,
            watch,
            hints,
            host: Some(host),
        }
    }
    fn invoke(&self, method: &str, params: Value) -> Result<Value, KernelError> {
        let cancel = CancellationToken::default();
        followup_commands::execute(
            self.runtime.clone(),
            self.resources.clone(),
            method,
            params,
            &cancel.shared_flag(),
            Some(cancel.clone()),
        )
    }
    fn registration(&self, key: &str, condition: &str) -> Value {
        json!({"key":key,"runId":self.run,"trigger":{"kind":"file","path":"result.txt","condition":condition},"instruction":"Read original file result","fileAuthority":{"grantId":"reader"}})
    }
    fn work(&self, key: &str) -> FileObservationWork {
        let owner = self.runtime.catalog();
        let db = owner.lock().unwrap();
        let d = db.followup(key).unwrap();
        let file = d.sources[0].file.as_ref().unwrap();
        db.followup_file_work(&FileObservationKey {
            followup_id: key.into(),
            generation: d.generation,
            source_index: 0,
            receipt_id: file.receipt_id.clone(),
            observation_revision: file.revision,
        })
        .unwrap()
    }
    fn other_run(&self) -> String {
        let catalog = self.runtime.catalog();
        let mut owner = catalog.lock().unwrap();
        let launch = owner.launch_intent(&self.run).unwrap().unwrap().selection;
        owner.create_thread("other-thread", "other-branch").unwrap();
        let prepared = owner
            .prepare_submission(
                SubmitInput {
                    key: "other-input".into(),
                    thread_id: "other-thread".into(),
                    branch_id: "other-branch".into(),
                    expected_head: None,
                    input: json!("other original User"),
                    configuration: json!({}),
                },
                None,
                None,
            )
            .unwrap()
            .load(Some(launch), false)
            .unwrap();
        owner.admit_submission(prepared).unwrap().run_id
    }
    fn lease(&self, hold: bool) {
        let method = if hold {
            "file.lease.acquire"
        } else {
            "file.lease.release"
        };
        let mut params =
            json!({"leaseId":"writer","workspaceId":"workspace","rootId":self.root_id});
        if hold {
            params["resources"] = json!([{"path":"result.txt","scope":"exact"}]);
        }
        dispatch(&mut self.storage.lock().unwrap(), "writer", method, params);
    }
    fn finish(mut self) {
        self.bridge.close();
        self.host.take().unwrap().join().unwrap();
        let root = self.root.clone();
        drop(self);
        std::fs::remove_dir_all(root).unwrap();
    }
}
#[test]
fn private_user_registers_under_writer_lease_then_release_hint_readies_same_original_input() {
    let f = Fixture::new();
    f.lease(true);
    let d = f
        .invoke(
            "runtime.followup.register",
            f.registration("ready", "ready"),
        )
        .unwrap();
    assert!(d["sources"][0]["file"]["baseline"].is_null());
    assert_eq!(d["sources"][0]["file"]["failure_code"], "baseline_pending");
    assert!(d["occurrence"].is_null());
    f.storage
        .lock()
        .unwrap()
        .retire_grants(&json!({"target":{"kind":"grant","grantId":"reader"}}), HOST)
        .unwrap();
    f.lease(false);
    assert_eq!(
        f.hints
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap(),
        f.root_id
    );
    let work = f.work("ready");
    let result = f
        .invoke(
            "runtime.followup.file.observe",
            serde_json::to_value(&work.key).unwrap(),
        )
        .unwrap();
    assert_eq!(result["accepted"], true);
    assert_eq!(
        result["followup"]["occurrence"]["evidence"]["proof"],
        "managed_ready"
    );
    let owner = f.runtime.catalog();
    let mut db = owner.lock().unwrap();
    for p in db.capture_followup_continuations().unwrap() {
        db.admit_followup_continuation(p.load().unwrap()).unwrap();
    }
    let p = db
        .prepare_input_delivery(&f.run, db.epoch(), db.head("branch").unwrap().as_deref())
        .unwrap()
        .load()
        .unwrap();
    let delivery = db.admit_input_delivery(p).unwrap().unwrap();
    assert_eq!(delivery.items.len(), 1);
    assert!(serde_json::to_string(&delivery.items)
        .unwrap()
        .contains("Read original file result"));
    drop(db);
    f.invoke(
        "runtime.followup.file.release",
        serde_json::to_value(&f.work("ready").key).unwrap(),
    )
    .unwrap();
    assert!(f.watch.lock().unwrap().open.is_empty());
    f.finish();
}
#[test]
fn same_key_registration_handles_are_independent_and_revocation_precedes_host_begin() {
    let f = Fixture::new();
    let owner = f.runtime.catalog();
    let input = FollowupRegistration {
        trigger: FollowupRegistrationTrigger::File {
            path: "result.txt".into(),
            condition: FileCondition::Changed,
        },
        instruction: "same original intent".into(),
        wait: None,
    };
    let mut one = owner
        .lock()
        .unwrap()
        .prepare_followup_registration("same", &f.run, input.clone())
        .unwrap()
        .load()
        .unwrap();
    let mut two = owner
        .lock()
        .unwrap()
        .prepare_followup_registration("same", &f.run, input)
        .unwrap()
        .load()
        .unwrap();
    let first = f
        .client
        .prepare_registration(
            &owner,
            &mut one,
            "reader",
            None,
            &CancellationToken::default(),
        )
        .unwrap();
    let second = f
        .client
        .prepare_registration(
            &owner,
            &mut two,
            "reader",
            None,
            &CancellationToken::default(),
        )
        .unwrap();
    assert_eq!(f.watch.lock().unwrap().open.len(), 2);
    owner
        .lock()
        .unwrap()
        .admit_followup_registration(one)
        .unwrap();
    drop(second);
    assert_eq!(f.watch.lock().unwrap().open.len(), 1);
    owner
        .lock()
        .unwrap()
        .admit_followup_registration(two)
        .unwrap();
    drop(first);
    assert_eq!(f.watch.lock().unwrap().open.len(), 1);
    f.invoke(
        "runtime.followup.register",
        f.registration("paused", "changed"),
    )
    .unwrap();
    {
        let mut db = owner.lock().unwrap();
        let revision = db.followup("paused").unwrap().revision;
        db.control_followup(
            "paused",
            revision,
            varin_runtime::FollowupControlAction::Pause,
        )
        .unwrap();
    }
    let before = f.watch.lock().unwrap().begin;
    f.storage
        .lock()
        .unwrap()
        .revoke_grant(&json!({"grantId":"reader"}), HOST)
        .unwrap();
    let result = f
        .invoke(
            "runtime.followup.file.observe",
            serde_json::to_value(&f.work("same").key).unwrap(),
        )
        .unwrap();
    assert_eq!(result["accepted"], true);
    assert_eq!(f.watch.lock().unwrap().begin, before);
    assert_eq!(
        result["followup"]["sources"][0]["file"]["failure_code"],
        "authority_revoked"
    );
    let page = f.invoke("runtime.followup.files", json!({})).unwrap();
    assert_eq!(page["bindings"].as_array().unwrap().len(), 2);
    assert!(page["bindings"]
        .as_array()
        .unwrap()
        .iter()
        .all(|b| b["action"] == "release"));
    assert_eq!(f.watch.lock().unwrap().begin, before);
    f.invoke(
        "runtime.followup.file.release",
        serde_json::to_value(&f.work("paused").key).unwrap(),
    )
    .unwrap();
    f.invoke(
        "runtime.followup.file.release",
        serde_json::to_value(&f.work("same").key).unwrap(),
    )
    .unwrap();
    assert!(f.watch.lock().unwrap().open.is_empty());
    f.finish();
}
#[test]
fn unstable_registration_keeps_original_position_and_first_snapshot_does_not_invent_change() {
    let f = Fixture::new();
    {
        let owner = f.runtime.catalog();
        let mut db = owner.lock().unwrap();
        let epoch = db.epoch();
        db.commit_execution(
            &f.run,
            epoch,
            &ExecutionRecord::StateChanged {
                state: RunState::Completed,
                waiting_on: None,
            },
        )
        .unwrap();
    }
    f.watch.lock().unwrap().unstable = true;
    f.invoke(
        "runtime.followup.register",
        f.registration("unstable", "changed"),
    )
    .unwrap();
    assert!(f.work("unstable").file.baseline.is_none());
    f.watch.lock().unwrap().unstable = false;
    f.invoke(
        "runtime.followup.file.observe",
        serde_json::to_value(&f.work("unstable").key).unwrap(),
    )
    .unwrap();
    let work = f.work("unstable");
    assert!(work.file.baseline.is_some());
    assert!(!work.release_required);
    f.watch.lock().unwrap().sequence += 1;
    f.invoke(
        "runtime.followup.file.observe",
        serde_json::to_value(&work.key).unwrap(),
    )
    .unwrap();
    let owner = f.runtime.catalog();
    assert!(owner
        .lock()
        .unwrap()
        .followup("unstable")
        .unwrap()
        .occurrence
        .is_some());
    f.finish();
}

#[test]
fn source_failures_remain_distinct_through_private_observe_and_catalog() {
    let f = Fixture::new();
    for code in [
        "source_unavailable",
        "authority_denied",
        "root_changed",
        "watch_unavailable",
    ] {
        f.watch.lock().unwrap().failure = None;
        f.invoke("runtime.followup.register", f.registration(code, "changed"))
            .unwrap();
        f.watch.lock().unwrap().failure = Some(code.into());
        let result = f
            .invoke(
                "runtime.followup.file.observe",
                serde_json::to_value(&f.work(code).key).unwrap(),
            )
            .unwrap();
        assert_eq!(result["accepted"], true);
        assert_eq!(
            result["followup"]["sources"][0]["file"]["failure_code"],
            code
        );
        assert!(result["followup"]["occurrence"].is_null());
    }
    f.finish();
}

fn pending_input() -> FollowupRegistration {
    FollowupRegistration {
        trigger: FollowupRegistrationTrigger::File {
            path: "result.txt".into(),
            condition: FileCondition::Changed,
        },
        instruction: "dispose this original accepted intent".into(),
        wait: None,
    }
}
#[test]
fn pending_user_fixed_acceptance_is_visible_cancelled_and_pin_released_with_durable_fence() {
    let f = Fixture::with_fixed(true);
    let owner = f.runtime.catalog();
    let mut prepared = owner
        .lock()
        .unwrap()
        .prepare_followup_registration("orphan", &f.run, pending_input())
        .unwrap()
        .load()
        .unwrap();
    let guard = f
        .client
        .prepare_registration(
            &owner,
            &mut prepared,
            "reader",
            None,
            &CancellationToken::default(),
        )
        .unwrap();
    drop(guard);
    let pin = "file-observation:orphan:0:pin";
    {
        let mut storage = f.storage.lock().unwrap();
        dispatch(
            &mut storage,
            "reader",
            "pin.read",
            json!({"pinId":pin,"paths":["result.txt"]}),
        );
    }
    let page = f
        .invoke(
            "runtime.followup.registrations.pending",
            json!({"threadId":"thread","branchId":"branch"}),
        )
        .unwrap();
    assert_eq!(page["registrations"].as_array().unwrap().len(), 1);
    assert_eq!(page["registrations"][0]["id"], "orphan");
    assert_eq!(page["registrations"][0]["paths"], json!(["result.txt"]));
    assert!(f
        .invoke(
            "runtime.followup.registration.cancel",
            json!({"key":"unknown","runId":f.run})
        )
        .is_err());
    assert!(!owner
        .lock()
        .unwrap()
        .user_followup_registration_cancelled("unknown", &f.run)
        .unwrap());
    let other = f.other_run();
    assert!(f
        .invoke(
            "runtime.followup.registrations.pending",
            json!({"threadId":"other-thread","branchId":"other-branch"})
        )
        .unwrap()["registrations"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(f
        .invoke(
            "runtime.followup.registration.cancel",
            json!({"key":"orphan","runId":other})
        )
        .is_err());
    assert!(!owner
        .lock()
        .unwrap()
        .user_followup_registration_cancelled("orphan", &f.run)
        .unwrap());
    let result = f
        .invoke(
            "runtime.followup.registration.cancel",
            json!({"key":"orphan","runId":f.run}),
        )
        .unwrap();
    assert!(result["followup"].is_null());
    assert!(owner
        .lock()
        .unwrap()
        .admit_followup_registration(prepared)
        .is_err());
    assert!(owner
        .lock()
        .unwrap()
        .prepare_followup_registration("orphan", &f.run, pending_input())
        .is_err());
    assert!(f
        .invoke(
            "runtime.followup.registration.cancel",
            json!({"key":"orphan","runId":f.run})
        )
        .unwrap()["followup"]
        .is_null());
    let page = f
        .invoke(
            "runtime.followup.registrations.pending",
            json!({"threadId":"thread","branchId":"branch"}),
        )
        .unwrap();
    assert!(page["registrations"].as_array().unwrap().is_empty());
    {
        let mut storage = f.storage.lock().unwrap();
        let (g, p) = storage
            .authorize(
                Some("reader"),
                EPOCH,
                HOST,
                GENERATION,
                "pin.read",
                &json!({"pinId":pin,"paths":["result.txt"]}),
            )
            .unwrap();
        assert!(storage
            .dispatch("pin.read", &p, Some("reader"), &g)
            .is_err());
    }
    f.finish();
}
#[test]
fn explicit_user_disposal_between_storage_acceptance_and_watch_stops_late_admission() {
    let f = Fixture::new();
    let owner = f.runtime.catalog();
    let mut prepared = owner
        .lock()
        .unwrap()
        .prepare_followup_registration("racing", &f.run, pending_input())
        .unwrap()
        .load()
        .unwrap();
    let (accepted, ready) = mpsc::channel();
    let (release, proceed) = mpsc::channel();
    let proceed = Mutex::new(proceed);
    let storage = f.storage.clone();
    let client = Client::new(
        move |command| {
            let hold = matches!(&command, crate::file_observation::Command::Accept { .. });
            command.serve(Some(&mut storage.lock().unwrap()), EPOCH, HOST, GENERATION);
            if hold {
                accepted.send(()).unwrap();
                proceed.lock().unwrap().recv().unwrap();
            }
            Ok(())
        },
        f.bridge.clone(),
    );
    let catalog = owner.clone();
    let worker = std::thread::spawn(move || {
        client
            .prepare_registration(
                &catalog,
                &mut prepared,
                "reader",
                None,
                &CancellationToken::default(),
            )
            .map(drop)
    });
    ready
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    assert!(f
        .invoke(
            "runtime.followup.registration.cancel",
            json!({"key":"racing","runId":f.run})
        )
        .unwrap()["followup"]
        .is_null());
    release.send(()).unwrap();
    assert!(worker.join().unwrap().is_err());
    assert_eq!(f.watch.lock().unwrap().begin, 0);
    assert!(f.watch.lock().unwrap().open.is_empty());
    assert!(owner.lock().unwrap().followup("racing").is_err());
    assert!(f
        .invoke(
            "runtime.followup.registrations.pending",
            json!({"threadId":"thread","branchId":"branch"})
        )
        .unwrap()["registrations"]
        .as_array()
        .unwrap()
        .is_empty());
    f.finish();
}

#[test]
fn corrupt_pending_receipt_is_an_explicit_failure_and_not_an_empty_list() {
    let f = Fixture::with_fixed(true);
    let owner = f.runtime.catalog();
    let mut prepared = owner
        .lock()
        .unwrap()
        .prepare_followup_registration("damaged", &f.run, pending_input())
        .unwrap()
        .load()
        .unwrap();
    drop(
        f.client
            .prepare_registration(
                &owner,
                &mut prepared,
                "reader",
                None,
                &CancellationToken::default(),
            )
            .unwrap(),
    );
    let connection = rusqlite::Connection::open(f.root.join("storage/catalog.sqlite")).unwrap();
    connection.execute("UPDATE operations SET result_json='not-json' WHERE operation_id='file-observation:damaged:0'", []).unwrap();
    let error = f
        .invoke(
            "runtime.followup.registrations.pending",
            json!({"threadId":"thread","branchId":"branch"}),
        )
        .unwrap_err();
    assert!(error.to_string().contains("receipt is corrupt"));
    assert!(f
        .invoke(
            "runtime.followup.registration.cancel",
            json!({"key":"damaged","runId":f.run})
        )
        .is_err());
    assert!(!owner
        .lock()
        .unwrap()
        .user_followup_registration_cancelled("damaged", &f.run)
        .unwrap());
    // A committed definition has its own Catalog authority, so the same corruption
    // may block source release, but must not block its ordinary User cancellation.
    f.invoke(
        "runtime.followup.register",
        f.registration("damaged-defined", "changed"),
    )
    .unwrap();
    connection.execute("UPDATE operations SET result_json='not-json' WHERE operation_id='file-observation:damaged-defined:0'", []).unwrap();
    assert_eq!(
        f.invoke(
            "runtime.followup.registration.cancel",
            json!({"key":"damaged-defined","runId":f.run})
        )
        .unwrap()["followup"]["state"],
        "cancelled"
    );
    assert_eq!(
        f.invoke(
            "runtime.followup.register",
            f.registration("damaged-defined", "changed")
        )
        .unwrap()["state"],
        "cancelled"
    );
    drop(connection);
    f.finish();
}
#[test]
fn explicit_user_disposal_of_committed_definition_preserves_original_retries_and_delivery() {
    let f = Fixture::new();
    let first = f
        .invoke(
            "runtime.followup.register",
            f.registration("defined", "changed"),
        )
        .unwrap();
    assert_eq!(f.watch.lock().unwrap().open.len(), 1);
    let cancelled = f
        .invoke(
            "runtime.followup.registration.cancel",
            json!({"key":"defined","runId":f.run}),
        )
        .unwrap();
    assert_eq!(cancelled["followup"]["state"], "cancelled");
    assert_eq!(
        f.invoke("runtime.followup.files", json!({})).unwrap()["bindings"][0]["action"],
        "release"
    );
    f.invoke(
        "runtime.followup.file.release",
        serde_json::to_value(&f.work("defined").key).unwrap(),
    )
    .unwrap();
    assert!(f.watch.lock().unwrap().open.is_empty());
    assert_eq!(
        f.invoke(
            "runtime.followup.register",
            f.registration("defined", "changed")
        )
        .unwrap()["state"],
        "cancelled"
    );
    assert!(!f
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .user_followup_registration_cancelled("defined", &f.run)
        .unwrap());
    assert_eq!(first["id"], cancelled["followup"]["id"]);

    f.invoke(
        "runtime.followup.register",
        f.registration("delivered", "exists"),
    )
    .unwrap();
    let catalog = f.runtime.catalog();
    {
        let mut db = catalog.lock().unwrap();
        for p in db.capture_followup_continuations().unwrap() {
            db.admit_followup_continuation(p.load().unwrap()).unwrap();
        }
        let p = db
            .prepare_input_delivery(&f.run, db.epoch(), db.head("branch").unwrap().as_deref())
            .unwrap()
            .load()
            .unwrap();
        assert_eq!(db.admit_input_delivery(p).unwrap().unwrap().items.len(), 1);
    }
    let before = catalog.lock().unwrap().followup("delivered").unwrap();
    assert_eq!(before.wait.state, NextRunWaitState::Consumed);
    let cancelled = f
        .invoke(
            "runtime.followup.registration.cancel",
            json!({"key":"delivered","runId":f.run}),
        )
        .unwrap();
    assert_eq!(cancelled["followup"]["wait"]["state"], "consumed");
    let retried = f
        .invoke(
            "runtime.followup.register",
            f.registration("delivered", "exists"),
        )
        .unwrap();
    assert_eq!(retried["wait"]["state"], "consumed");
    assert_eq!(
        retried["occurrence"]["id"],
        json!(before.occurrence.unwrap().id)
    );
    assert!(!catalog
        .lock()
        .unwrap()
        .user_followup_registration_cancelled("delivered", &f.run)
        .unwrap());
    f.finish();
}
