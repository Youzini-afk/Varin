//! Actual source authorities and typed resource owners. The Host fixture uses only
//! the existing stdio rendezvous and direct Router; no product listener is started.
use super::web_domain_review::Host;
use crate::{
    error::KernelError,
    source_resources::{self, SourceDispatch},
    storage::Storage,
    tools::KernelResourceClient,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
use varin_runtime::execution::*;
use varin_runtime::{Catalog, RunState, SubmitInput};

struct ResourceActor {
    requests: Option<mpsc::Sender<crate::tools::ResourceCall>>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl ResourceActor {
    fn send(&self, request: crate::tools::ResourceCall) -> Result<(), KernelError> {
        self.requests
            .as_ref()
            .unwrap()
            .send(request)
            .map_err(|_| KernelError::Storage("fixture resource owner stopped".into()))
    }
}
impl Drop for ResourceActor {
    fn drop(&mut self) {
        self.requests.take();
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}

#[derive(Clone)]
struct Owner {
    storage: Arc<Mutex<Storage>>,
    resources: KernelResourceClient,
    tasks: Arc<Mutex<HashMap<String, CancellationToken>>>,
    root: PathBuf,
    host: &'static str,
    generation: &'static str,
    epoch: &'static str,
}
impl Owner {
    fn new(
        root: PathBuf,
        host: &'static str,
        generation: &'static str,
        epoch: &'static str,
    ) -> Self {
        let mut storage = Storage::open(&root, host).unwrap();
        if let Some(executable) = std::env::var_os("VARIN_TEST_KERNEL_EXECUTABLE") {
            storage.set_test_process_worker_executable(executable.into());
        }
        let controls: crate::process::ProcessControlRegistry = Default::default();
        storage.set_process_controls(controls.clone());
        let storage = Arc::new(Mutex::new(storage));
        let actor = storage.clone();
        let interactions = crate::storage::process_interactions::Client::new(move |command| {
            actor
                .lock()
                .unwrap()
                .serve_interaction(command, epoch, host, generation);
            Ok(())
        });
        let actor_storage = storage.clone();
        let (requests, queued) = mpsc::channel::<crate::tools::ResourceCall>();
        // Match the production Storage actor's lifetime. On Linux the guardian's
        // parent-death signal follows its creating thread, not the whole process;
        // a per-RPC thread would stop the process as soon as spawn returned.
        let worker = std::thread::spawn(move || {
            while let Ok(request) = queued.recv() {
                let result = crate::tools::serve_resource(
                    &mut actor_storage.lock().unwrap(),
                    epoch,
                    host,
                    generation,
                    &request,
                );
                let _ = request.reply.send(result);
            }
        });
        let actor = ResourceActor {
            requests: Some(requests),
            worker: Some(worker),
        };
        let resources = KernelResourceClient::new(
            move |request| actor.send(request),
            |_| Ok(()),
            controls,
        )
        .with_process_interactions(interactions);
        Self {
            storage,
            resources,
            tasks: Default::default(),
            root,
            host,
            generation,
            epoch,
        }
    }
    fn rpc(
        &self,
        method: &str,
        params: Value,
        grant_id: Option<&str>,
    ) -> Result<Value, KernelError> {
        crate::protocol::validate_method_params(method, &params)?;
        if method.starts_with("source.") {
            if method == "source.resource.cancel" {
                let address: source_resources::SourceResourceControlParams =
                    serde_json::from_value(params.clone())?;
                self.storage.lock().unwrap().source_authority(
                    &source_resources::SourceAuthorityAddress {
                        principal_id: address.principal_id,
                        coordinator_host_id: address.coordinator_host_id,
                        authority_id: address.authority_id.clone(),
                        resource_epoch: address.resource_epoch,
                    },
                    false,
                    self.epoch,
                )?;
                if let Some(cancel) = self.tasks.lock().unwrap().get(&format!(
                    "{}:{}",
                    address.authority_id, address.operation_id
                )) {
                    cancel.cancel();
                }
            }
            let work = source_resources::prepare_request(
                &mut self.storage.lock().unwrap(),
                method,
                params,
                self.epoch,
                self.host,
                self.generation,
            )?;
            if let SourceDispatch::Ready(value) = work {
                return Ok(value);
            }
            let key = work.key().unwrap();
            let cancel = CancellationToken::default();
            {
                let mut tasks = self.tasks.lock().unwrap();
                if tasks.contains_key(&key) {
                    return Err(KernelError::Operation(
                        "Original source request is in flight".into(),
                    ));
                }
                tasks.insert(key.clone(), cancel.clone());
            }
            let result = work
                .execute(self.resources.clone(), cancel)
                .and_then(|value| value.finish(&mut self.storage.lock().unwrap()));
            self.tasks.lock().unwrap().remove(&key);
            return result;
        }
        super::web_domain_review::storage_rpc(
            &self.storage,
            &self.root,
            method,
            params,
            grant_id,
            self.epoch,
            self.host,
            self.generation,
        )
    }
    fn bind_live(&self, work: &Path, grant: &str, epoch: u64) -> (Value, Value) {
        self.bind_live_identity(work, grant, epoch, "client", "coordinator")
    }
    fn bind_live_identity(
        &self,
        work: &Path,
        grant: &str,
        epoch: u64,
        principal: &str,
        coordinator: &str,
    ) -> (Value, Value) {
        self.rpc("authority.grant.issue",json!({"grantId":grant,"hostGeneration":self.generation,"storageIdentity":self.root,"sessionId":null,"owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"thread","runId":"run","capabilities":["storage.read","storage.write","process"],"pathScopes":[""]}),None).unwrap();
        let root=self.rpc("file.root.register",json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":work}),Some(grant)).unwrap();
        let live = json!({"hostId":self.host,"rootId":root["rootId"],"canonicalRoot":root["canonicalRoot"]});
        let source = json!({"resource_owner":{"kind":"managed_host","hostId":self.host,"connectionId":"original-connection","endpointIdentity":"original-endpoint"},"workspace_id":"workspace","execution_workspace_id":"workspace","mode":"live_root","branch_id":null,"revision":null,"live_root":live,"environment_run_id":null});
        let opened=self.rpc("source.authority.open",json!({"principalId":principal,"coordinatorHostId":coordinator,"scope":{"kind":"run","threadId":"thread","runId":"run","epoch":epoch},"source":source,"grantId":grant,"enabledTools":["file_read","file_write","process_spawn","process_write","process_inspect","process_read"],"purpose":"source"}),None).unwrap();
        let address = json!({"principalId":principal,"coordinatorHostId":coordinator,"authorityId":opened["authorityId"],"resourceEpoch":opened["resourceEpoch"]});
        let mut bind = address.clone();
        bind["physicalRoot"] = live;
        bind["toolBinding"] = json!({"resourceOwner":source["resource_owner"],"grantId":grant,"runId":"run","threadId":"thread","workspaceId":"workspace","executionWorkspaceId":"workspace","rootId":root["rootId"],"sourceMode":"live_root","liveRoot":source["live_root"],"enabledTools":["file_read","file_write","process_spawn","process_write","process_inspect","process_read"]});
        self.rpc("source.authority.bind", bind, None).unwrap();
        (address, source)
    }
    fn tool(
        &self,
        address: &Value,
        name: &str,
        id: &str,
        args: Value,
    ) -> Result<Value, KernelError> {
        let mut input = address.clone();
        input["call"] = json!({"runId":"run","operationId":format!("request:tool:{id}"),"origin":{"kind":"model_step","request_id":"request"},"callId":id,"name":name,"schemaVersion":"1","arguments":args});
        self.rpc("source.resource.execute", input, None)
    }
}
#[test]
fn managed_source_original_effects_survive_epoch_fence_and_reject_foreign_authority() {
    let root =
        std::env::temp_dir().join(format!("varin-source-authority-{}", uuid::Uuid::new_v4()));
    let work = root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    std::fs::write(work.join("note.txt"), "before").unwrap();
    let owner = Owner::new(
        root.join("storage"),
        "managed-target",
        "managed-target-generation",
        "managed-target-epoch",
    );
    let (address, source) = owner.bind_live(&work, "first", 1);
    let read = owner
        .tool(&address, "file_read", "read", json!({"path":"note.txt"}))
        .unwrap();
    let version = read["result"]["completion"]["content"]["data"]["readVersion"].clone();
    assert!(version.is_string(), "{read}");
    let applied = owner
        .tool(
            &address,
            "file_write",
            "write",
            json!({"path":"note.txt","readVersion":version,"content":"after"}),
        )
        .unwrap();
    assert_eq!(
        applied["result"]["completion"]["effect"], "confirmed",
        "{applied}"
    );
    assert_eq!(
        std::fs::read_to_string(work.join("note.txt")).unwrap(),
        "after"
    );
    let (_next, _) = owner.bind_live(&work, "second", 2);
    assert!(owner
        .tool(
            &address,
            "file_write",
            "stale",
            json!({"path":"note.txt","readVersion":version,"content":"forbidden"})
        )
        .is_err());
    let mut observe = address.clone();
    observe["operationId"] = json!("request:tool:write");
    let receipt = owner
        .rpc("source.resource.observe", observe.clone(), None)
        .unwrap();
    assert_eq!(receipt["executorStopped"], true);
    assert_eq!(receipt["result"]["completion"]["effect"], "confirmed");
    let mut foreign = observe.clone();
    foreign["principalId"] = json!("other-client");
    assert!(owner.rpc("source.resource.observe", foreign, None).is_err());
    let mut missing = observe;
    missing["operationId"] = json!("request:tool:missing");
    let absent = owner.rpc("source.resource.observe", missing, None).unwrap();
    assert_eq!(absent["accepted"], false);
    assert_eq!(absent["executorStopped"], false);
    assert_eq!(
        std::fs::read_to_string(work.join("note.txt")).unwrap(),
        "after"
    );
    assert_eq!(source["resource_owner"]["hostId"], "managed-target");
    drop(owner);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn managed_source_two_hosts_original_storage_and_direct_router() {
    let root = std::env::temp_dir().join(format!(
        "varin-managed-source-host-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let a = Owner::new(
        root.join("storage-a"),
        "managed-coordinator",
        "managed-coordinator-generation",
        "managed-coordinator-epoch",
    );
    let b = Owner::new(
        root.join("storage-b"),
        "managed-target",
        "managed-target-generation",
        "managed-target-epoch",
    );
    let mut catalog = Catalog::open(&root.join("coordinator-catalog")).unwrap();
    catalog
        .publish_bot_gate(varin_runtime::catalog::bot::BotGate {
            bot_id: "managed-review-bot".into(),
            profile_revision: 1,
            activity_operation_id: Some("active".into()),
            permitted: true,
        })
        .unwrap();
    catalog
        .create_bot_thread("thread:managed-review", "main", "managed-review-bot")
        .unwrap();
    let admission = catalog
        .prepare_submission(
            SubmitInput {
                key: "managed-source-input".into(),
                thread_id: "thread:managed-review".into(),
                branch_id: "main".into(),
                expected_head: None,
                input: json!("read the selected managed source"),
                configuration: json!({}),
            },
            None,
            None,
        )
        .unwrap();
    let submitted = catalog
        .admit_submission(admission.load(None, false).unwrap())
        .unwrap();
    let catalog = Arc::new(Mutex::new(catalog));
    let (private_send, private_frames) = mpsc::sync_channel(32);
    let bridge = crate::host_query::OwnerChannel::new("source-resource", private_send);
    bridge.initialize(a.epoch);
    let mut host = Host::with_script(
        "packages/web/application-host/lib/harness/managed-source-host.test-helper.ts",
    );
    host.send(json!({"kind":"fixture-init","root":root,"storageRootA":a.root,"storageRootB":b.root,"epochA":a.epoch,"epochB":b.epoch,"runId":submitted.run_id}));
    let release_attempts: Arc<Mutex<HashMap<String, usize>>> = Default::default();
    let mut released_hashes = std::collections::HashSet::new();
    let (send, completed) = mpsc::channel();
    let deadline = Instant::now() + Duration::from_secs(90);
    let result = loop {
        assert!(Instant::now() < deadline, "managed source helper timed out");
        while let Ok(frame) = completed.try_recv() {
            host.send(frame);
        }
        while let Ok(frame) = private_frames.try_recv() {
            if frame["query"]["kind"] == "control" && frame["query"]["phase"] == "release" {
                {
                    let _owner = b.storage.lock().unwrap();
                    let db = rusqlite::Connection::open_with_flags(
                        b.root.join("catalog.sqlite"),
                        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                    )
                    .unwrap();
                    let hash: Option<String> = db.query_row("SELECT json_extract(result_json,'$.objectHash') FROM operations WHERE operation_id=?1", [frame["query"]["context"]["operation_id"].as_str().unwrap()], |row|row.get(0)).unwrap();
                    if let Some(hash) = hash {
                        released_hashes.insert(hash);
                    }
                }
                let mut attempts = release_attempts.lock().unwrap();
                let first = attempts.is_empty();
                *attempts
                    .entry(
                        frame["query"]["context"]["operation_id"]
                            .as_str()
                            .unwrap()
                            .into(),
                    )
                    .or_default() += 1;
                if first {
                    bridge.receive(json!({"v":1,"kind":"source-resource-response","id":frame["id"],"kernelEpoch":a.epoch,"result":{"ok":false,"message":"fixture delivery cleanup unavailable"}}));
                    continue;
                }
            }
            host.send(json!({"kind":"fixture-coordinator-frame","frame":frame}));
        }
        let Some(frame) = host.next_frame(Duration::from_millis(5)) else {
            continue;
        };
        match frame["kind"].as_str().unwrap_or("") {
            "fixture-request" => {
                let owner = match frame["target"].as_str() {
                    Some("a") => a.clone(),
                    Some("b") => b.clone(),
                    _ => panic!("unknown resource Host {frame}"),
                };
                let send = send.clone();
                std::thread::spawn(move || {
                    let value = owner.rpc(
                        frame["method"].as_str().unwrap(),
                        frame["params"].clone(),
                        frame["grantId"].as_str(),
                    );
                    let response = match value {
                        Ok(value) => {
                            json!({"kind":"fixture-response","target":frame["target"],"id":frame["id"],"ok":true,"result":value})
                        }
                        Err(error) => {
                            json!({"kind":"fixture-response","target":frame["target"],"id":frame["id"],"ok":false,"error":error.to_string()})
                        }
                    };
                    let _ = send.send(response);
                });
            }
            "fixture-coordinator-tool" => {
                let send = send.clone();
                let catalog = catalog.clone();
                let resources = a
                    .resources
                    .clone()
                    .with_source_bridge(bridge.clone())
                    .with_journal_catalog(catalog.clone());
                let submitted = submitted.clone();
                let release_attempts = release_attempts.clone();
                std::thread::spawn(move || {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        coordinator_read(
                            catalog,
                            resources,
                            &submitted.run_id,
                            &submitted.input_id,
                            frame,
                            release_attempts,
                        )
                    }))
                    .unwrap_or_else(|_| Err("original coordinator fixture worker panicked".into()));
                    let value = match result {
                        Ok(receipt) => {
                            json!({"kind":"fixture-coordinator-result","ok":true,"result":receipt})
                        }
                        Err(message) => {
                            json!({"kind":"fixture-coordinator-result","ok":false,"error":message})
                        }
                    };
                    let _ = send.send(value);
                });
            }
            "fixture-frame" => {
                assert_eq!(frame["target"], "a");
                bridge.receive(frame["frame"].clone());
            }
            "fixture-result" => break frame,
            "fixture-error" | "fixture-failed" => panic!("actual managed Host failed: {frame}"),
            _ => panic!("unexpected original Host frame {frame}"),
        }
    };
    assert_eq!(result["ok"], true, "{result}");
    assert!(a.tasks.lock().unwrap().is_empty());
    assert!(b.tasks.lock().unwrap().is_empty());
    {
        let _owner = b.storage.lock().unwrap();
        let db = rusqlite::Connection::open_with_flags(
            b.root.join("catalog.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        for key in ["dispatch", "continuationId", "unacceptedDispatch"] {
            let pin = format!("child-pin:{}", result["child"][key].as_str().unwrap());
            assert!(!db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM pins WHERE pin_id=?1)",
                    [pin],
                    |row| row.get::<_, bool>(0)
                )
                .unwrap());
        }
        let continuation = result["child"]["continuationId"].as_str().unwrap();
        assert!(!db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pins WHERE pin_id=?1)",
                [format!("child-source-pin:{continuation}")],
                |row| row.get::<_, bool>(0)
            )
            .unwrap());
        assert!(!db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM branches WHERE branch_id=?1)",
                [format!("child-source:{continuation}")],
                |row| row.get::<_, bool>(0)
            )
            .unwrap());
        for id in release_attempts.lock().unwrap().keys() {
            let body: String = db
                .query_row(
                    "SELECT result_json FROM operations WHERE operation_id=?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap();
            let body: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(body["released"], true, "{id}: {body}");
            assert!(body.get("objectHash").is_none());
        }
    }
    b.rpc("authority.grant.issue",json!({"grantId":"delivery-gc","hostGeneration":b.generation,"storageIdentity":b.root,"sessionId":null,"owningWorkspace":"workspace","executionWorkspace":"workspace","capabilities":["storage.admin"],"pathScopes":[""]}),None).unwrap();
    b.rpc(
        "storage.gc",
        json!({"operationId":"delivered-read-gc"}),
        Some("delivery-gc"),
    )
    .unwrap();
    assert!(!released_hashes.is_empty());
    for hash in released_hashes {
        assert!(!crate::protocol::object_path(&b.root, &hash)
            .unwrap()
            .exists());
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while Arc::strong_count(&catalog) > 1 {
        assert!(
            Instant::now() < deadline,
            "delivery worker retained original Catalog"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    drop(catalog);
    let mut reopened = Catalog::open(&root.join("coordinator-catalog")).unwrap();
    for id in release_attempts.lock().unwrap().keys() {
        let read = reopened.capture_operation_read(reopened.operation(id).unwrap());
        let body = serde_json::to_string(&read.load().unwrap()).unwrap();
        assert!(body.contains("B_ORIGINAL_SOURCE"), "{id}: {body}");
        assert!(!body.contains("A_PRIVATE_SOURCE"));
    }
    let suspension = varin_runtime::catalog::bot::BotSuspension {
        bot_id: "managed-review-bot".into(),
        profile_revision: 2,
        activity_operation_id: "delete-original".into(),
    };
    reopened
        .publish_bot_gate(varin_runtime::catalog::bot::BotGate {
            bot_id: suspension.bot_id.clone(),
            profile_revision: 2,
            activity_operation_id: Some(suspension.activity_operation_id.clone()),
            permitted: false,
        })
        .unwrap();
    reopened.suspend_bot_scope(suspension.clone()).unwrap();
    let catalog = Arc::new(Mutex::new(reopened));
    let worker_catalog = catalog.clone();
    let resources = a
        .resources
        .clone()
        .with_source_bridge(bridge.clone())
        .with_journal_catalog(catalog.clone());
    let run_id = submitted.run_id.clone();
    let (deletion_done, deletion) = mpsc::channel();
    std::thread::spawn(move || {
        let cancellation = std::sync::atomic::AtomicBool::new(false);
        assert!(super::bot_scope_commands::remove(
            &worker_catalog,
            &resources,
            suspension.clone(),
            &cancellation
        )
        .is_err());
        assert!(
            worker_catalog.lock().unwrap().run(&run_id).is_ok(),
            "failed original cleanup must preserve its scope"
        );
        let result = super::bot_scope_commands::remove(
            &worker_catalog,
            &resources,
            suspension,
            &cancellation,
        );
        let _ = deletion_done.send(result);
    });
    let mut reject_cleanup = true;
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        assert!(Instant::now() < deadline, "Bot deletion cleanup timed out");
        if let Ok(result) = deletion.try_recv() {
            assert_eq!(result.unwrap()["removed"], true);
            break;
        }
        while let Ok(frame) = completed.try_recv() {
            host.send(frame);
        }
        while let Ok(frame) = private_frames.try_recv() {
            if reject_cleanup && frame["query"]["phase"] == "release" {
                reject_cleanup = false;
                bridge.receive(json!({"v":1,"kind":"source-resource-response","id":frame["id"],"kernelEpoch":a.epoch,"result":{"ok":false,"message":"fixture delete cleanup unavailable"}}));
            } else {
                host.send(json!({"kind":"fixture-coordinator-frame","frame":frame}));
            }
        }
        let Some(frame) = host.next_frame(Duration::from_millis(5)) else {
            continue;
        };
        match frame["kind"].as_str().unwrap_or("") {
            "fixture-frame" => {
                bridge.receive(frame["frame"].clone());
            }
            "fixture-request" => {
                let owner = if frame["target"] == "b" {
                    b.clone()
                } else {
                    a.clone()
                };
                let send = send.clone();
                std::thread::spawn(move || {
                    let result = owner.rpc(
                        frame["method"].as_str().unwrap(),
                        frame["params"].clone(),
                        frame["grantId"].as_str(),
                    );
                    let response = match result {
                        Ok(value) => {
                            json!({"kind":"fixture-response","target":frame["target"],"id":frame["id"],"ok":true,"result":value})
                        }
                        Err(error) => {
                            json!({"kind":"fixture-response","target":frame["target"],"id":frame["id"],"ok":false,"error":error.to_string()})
                        }
                    };
                    let _ = send.send(response);
                });
            }
            _ => panic!("unexpected cleanup Host frame {frame}"),
        }
    }
    assert!(matches!(
        catalog.lock().unwrap().run(&submitted.run_id),
        Err(varin_runtime::RuntimeError::NotFound(_))
    ));
    bridge.close();
    drop(host);
    drop(a);
    drop(b);
    drop(catalog);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn managed_source_pre_spawn_failures_settle_original_receipt_without_guardian_output() {
    for block_receipt_directory in [false, true] {
        let root = std::env::temp_dir().join(format!(
            "varin-source-pre-spawn-{}",
            uuid::Uuid::new_v4()
        ));
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let owner = Owner::new(
            root.join("storage"),
            "managed-target",
            "managed-target-generation",
            "managed-target-epoch",
        );
        let (address, _) = owner.bind_live(&work, "original-spawn", 1);
        owner
            .storage
            .lock()
            .unwrap()
            .set_test_process_worker_executable(root.join("missing-guardian"));
        if block_receipt_directory {
            std::fs::write(owner.root.join("process-receipts"), "directory obstruction").unwrap();
        }
        let args = json!({"cwd":"","command":"unused-target","mode":"pipe","args":[]});
        let failed = owner
            .tool(&address, "process_spawn", "process", args.clone())
            .unwrap();
        // A known pre-spawn failure retains its original receipt without reporting an unknown effect.
        assert_eq!(failed["accepted"], false, "{failed}");
        assert_eq!(failed["executorStopped"], true, "{failed}");
        assert_eq!(failed["result"]["completion"]["kind"], "not_dispatched", "{failed}");
        let mut observe = address.clone();
        observe["operationId"] = json!("request:tool:process");
        let receipt = owner
            .rpc("source.resource.observe", observe.clone(), None)
            .unwrap();
        assert_eq!(receipt["accepted"], true, "{receipt}");
        assert_eq!(receipt["executorStopped"], true, "{receipt}");
        assert_eq!(receipt["result"]["completion"]["outcome"], "failed", "{receipt}");
        assert_eq!(receipt["process"]["status"], "failed", "{receipt}");
        assert_eq!(receipt["process"]["writerActive"], false, "{receipt}");
        assert_eq!(receipt["process"]["treeConfirmed"], true, "{receipt}");
        assert_eq!(receipt["process"]["spawned"], false, "{receipt}");
        assert_eq!(receipt["process"]["outputAvailable"], false, "{receipt}");
        assert!(receipt["process"]["pid"].is_null(), "{receipt}");
        assert!(!crate::process::receipt_path(&owner.root, "request:tool:process").exists());

        // Repeating the exact command recalls its failed identity instead of spawning again.
        owner.tool(&address, "process_spawn", "process", args).unwrap();
        assert_eq!(
            owner.rpc("source.resource.cancel", observe.clone(), None).unwrap(),
            receipt
        );
        drop(owner);
        let reopened = Owner::new(
            root.join("storage"),
            "managed-target",
            "managed-target-generation",
            "managed-target-reopened",
        );
        assert_eq!(
            reopened.rpc("source.resource.observe", observe, None).unwrap(),
            receipt
        );
        if block_receipt_directory {
            assert!(reopened.root.join("process-receipts").is_file());
        }
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn managed_source_interaction_recalls_original_receipt_after_reopen_without_replaying_input() {
    let root = std::env::temp_dir().join(format!("varin-source-input-{}", uuid::Uuid::new_v4()));
    let work = root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let owner = Owner::new(
        root.join("storage"),
        "managed-target",
        "managed-target-generation",
        "managed-target-epoch",
    );
    let (address, _) = owner.bind_live(&work, "input-first", 1);
    let node = std::env::var("VARIN_NODE").unwrap_or_else(|_| "node".into());
    let accepted=owner.tool(&address,"process_spawn","process",json!({"cwd":"","command":node,"mode":"pipe","args":["-e","const fs=require('node:fs');process.stdin.on('data',b=>fs.appendFileSync('received',b));setInterval(()=>{},1000)"]})).unwrap();
    assert_eq!(
        accepted["result"]["completion"]["kind"], "job_accepted",
        "{accepted}"
    );
    let sent = owner
        .tool(
            &address,
            "process_write",
            "input",
            json!({"processId":"request:tool:process","text":"ONCE","eof":false}),
        )
        .unwrap();
    assert_eq!(
        sent["result"]["completion"]["content"]["data"]["state"], "applied",
        "{sent}"
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while std::fs::read_to_string(work.join("received")).unwrap_or_default() != "ONCE" {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    for (principal, coordinator, grant) in [
        ("other-client", "coordinator", "foreign-client"),
        ("client", "other-coordinator", "foreign-coordinator"),
    ] {
        let (foreign, _) = owner.bind_live_identity(&work, grant, 1, principal, coordinator);
        let read = owner
            .tool(
                &foreign,
                "process_read",
                grant,
                json!({"processId":"request:tool:process","cursor":0}),
            )
            .unwrap();
        assert_eq!(
            read["result"]["completion"]["kind"], "not_dispatched",
            "{read}"
        );
        assert!(owner
            .tool(
                &foreign,
                "process_write",
                &format!("{grant}-input"),
                json!({"processId":"request:tool:process","text":"FORBIDDEN"})
            )
            .is_err());
        let mut observation = foreign.clone();
        observation["requestId"] = json!(grant);
        observation["clientCapabilities"] =
            json!(["filesystem:read", "terminal:use", "process:control"]);
        observation["operation"] = json!({"kind":"native_resource","context":{"run_id":"run","operation_id":format!("request:tool:{grant}-observe"),"origin":{"kind":"model_step","request_id":"request"}},"authorizeOnly":false,"action":{"kind":"process_observation","source_run_id":"run","lineage":null,"process_id":"request:tool:process","read":null}});
        assert!(owner.rpc("source.service.call", observation, None).is_err());
    }
    assert_eq!(
        std::fs::read_to_string(work.join("received")).unwrap(),
        "ONCE"
    );
    owner.bind_live(&work, "input-next", 2);
    let mut inspect = address.clone();
    inspect["operationId"] = json!("request:tool:input");
    let recalled = owner
        .rpc("source.resource.observe", inspect.clone(), None)
        .unwrap();
    assert_eq!(recalled["result"], sent["result"]);
    assert_eq!(recalled["executorStopped"], true);
    let mut stop = address.clone();
    stop["operationId"] = json!("request:tool:process");
    owner
        .rpc("source.resource.cancel", stop.clone(), None)
        .unwrap();
    loop {
        let receipt = owner
            .rpc("source.resource.observe", stop.clone(), None)
            .unwrap();
        if receipt["executorStopped"] == true {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(owner);
    let reopened = Owner::new(
        root.join("storage"),
        "managed-target",
        "managed-target-generation",
        "managed-target-reopened",
    );
    let recovered = reopened
        .rpc("source.resource.observe", inspect, None)
        .unwrap();
    assert_eq!(recovered["result"], sent["result"]);
    assert_eq!(
        std::fs::read_to_string(work.join("received")).unwrap(),
        "ONCE"
    );
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}

/// The compiler and candidate Catalog are on A; frozen content and its actual
/// Source grants/pins are on B. Only transport delivery and model choices vary.
#[test]
fn managed_extension_package_uses_original_capture_and_releases_after_reader_drain() {
    let root = std::env::temp_dir().join(format!("varin-managed-package-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let a = Owner::new(
        root.join("storage-a"),
        "managed-coordinator",
        "managed-coordinator-generation",
        "managed-coordinator-epoch",
    );
    let b = Owner::new(
        root.join("storage-b"),
        "managed-target",
        "managed-target-generation",
        "managed-target-epoch",
    );
    let mut db = Catalog::open(root.join("catalog")).unwrap();
    db.create_thread("thread:managed-review", "main").unwrap();
    let admission = db
        .prepare_submission(
            SubmitInput {
                key: "managed-package-source".into(),
                thread_id: "thread:managed-review".into(),
                branch_id: "main".into(),
                expected_head: None,
                input: json!("prepare target Source"),
                configuration: json!({}),
            },
            None,
            None,
        )
        .unwrap();
    let submitted = db
        .admit_submission(admission.load(None, false).unwrap())
        .unwrap();
    let catalog = Arc::new(Mutex::new(db));
    let mut host = Host::with_script(
        "packages/web/application-host/lib/harness/managed-source-host.test-helper.ts",
    );
    host.send(json!({"kind":"fixture-init","scenario":"extension-package","root":root,"storageRootA":a.root,
        "storageRootB":b.root,"epochA":a.epoch,"epochB":b.epoch,"runId":submitted.run_id}));
    let (send, completed) = mpsc::channel();
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        assert!(
            Instant::now() < deadline,
            "managed extension package helper timed out"
        );
        while let Ok(response) = completed.try_recv() {
            host.send(response);
        }
        let Some(frame) = host.next_frame(Duration::from_millis(5)) else {
            continue;
        };
        match frame["kind"].as_str().unwrap_or("") {
            "fixture-request" => {
                let owner = if frame["target"] == "b" {
                    b.clone()
                } else {
                    a.clone()
                };
                let target = b.clone();
                let catalog = catalog.clone();
                let send = send.clone();
                std::thread::spawn(move || {
                    let result = (|| -> Result<Value, KernelError> {
                        let method = frame["method"].as_str().unwrap();
                        let params = frame["params"].clone();
                        if method == "fixture.package.begin" {
                            return begin_package_call(&mut catalog.lock().unwrap(), params);
                        }
                        if method == "fixture.package.gc" {
                            let grant = format!("package-gc:{}", uuid::Uuid::new_v4());
                            target.rpc("authority.grant.issue", json!({"grantId":grant,"hostGeneration":target.generation,
                                "storageIdentity":target.root,"sessionId":null,"owningWorkspace":"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
                                "executionWorkspace":"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa","capabilities":["storage.admin"],"pathScopes":[""]}), None)?;
                            target.rpc("storage.gc", json!({"operationId":format!("package-gc:{}",uuid::Uuid::new_v4())}), Some(&grant))?;
                            return Ok(
                                json!({"present":params["hashes"].as_array().unwrap().iter().map(|hash|
                                crate::protocol::object_path(&target.root,hash.as_str().unwrap()).unwrap().exists()).collect::<Vec<_>>()}),
                            );
                        }
                        if method == "runtime.run.inspect" {
                            return Ok(serde_json::to_value(
                                catalog
                                    .lock()
                                    .unwrap()
                                    .run(params["runId"].as_str().unwrap())
                                    .map_err(super::domain)?,
                            )?);
                        }
                        if method == "runtime.operation.inspect" {
                            return Ok(serde_json::to_value(
                                catalog
                                    .lock()
                                    .unwrap()
                                    .operation(params["operationId"].as_str().unwrap())
                                    .map_err(super::domain)?,
                            )?);
                        }
                        if method == "runtime.launch.inspect" {
                            let read = catalog
                                .lock()
                                .unwrap()
                                .capture_launch(params["runId"].as_str().unwrap())
                                .map_err(super::domain)?;
                            return Ok(serde_json::to_value(
                                read.map(|r| r.load()).transpose().map_err(super::domain)?,
                            )?);
                        }
                        owner.rpc(method, params, frame["grantId"].as_str())
                    })();
                    let response = match result {
                        Ok(value) => {
                            json!({"kind":"fixture-response","id":frame["id"],"ok":true,"result":value})
                        }
                        Err(error) => {
                            json!({"kind":"fixture-response","id":frame["id"],"ok":false,"error":error.to_string()})
                        }
                    };
                    let _ = send.send(response);
                });
            }
            "fixture-result" => {
                assert_eq!(frame["ok"], true);
                assert_eq!(frame["result"]["captures"], 3);
                break;
            }
            _ => panic!("original managed package Host failed: {frame}"),
        }
    }
    assert!(a.tasks.lock().unwrap().is_empty());
    assert!(b.tasks.lock().unwrap().is_empty());
    drop(host);
    drop(catalog);
    drop(a);
    drop(b);
    std::fs::remove_dir_all(root).unwrap();
}

fn begin_package_call(db: &mut Catalog, params: Value) -> Result<Value, KernelError> {
    let fail = super::domain;
    let serial = uuid::Uuid::new_v4().to_string();
    let thread = format!("thread:package:{serial}");
    let branch = format!("branch:package:{serial}");
    db.create_thread(&thread, &branch).map_err(fail)?;
    let admission = db
        .prepare_submission(
            SubmitInput {
                key: serial.clone(),
                thread_id: thread.clone(),
                branch_id: branch.clone(),
                expected_head: None,
                input: json!("stage this original Source package"),
                configuration: json!({}),
            },
            None,
            None,
        )
        .map_err(fail)?;
    let submitted = db
        .admit_submission(admission.load(None, false).map_err(fail)?)
        .map_err(fail)?;
    let schema = ToolSchema {
        name: "extension_package".into(),
        version: "1".into(),
        description: String::new(),
        schema: json!({"type":"object"}),
        requirements: None,
        output_schema: None,
        metadata: None,
    };
    let binding = RequestBinding {
        tokenizer: None,
        request_context: None,
        child_dispatch: None,
        goal: None,
        resource_activations: vec![],
        resource_checkpoint_id: None,
        connection_identity: "fixture".into(),
        provider_family: "fixture".into(),
        model: "fixture".into(),
        credential_ref: None,
        configuration_generation: 1,
        tool_schema_generation: 1,
        tools: vec![schema],
        instruction_sources: vec![],
        memory_checkpoint: None,
        attachment_refs: vec![],
        environment_cursor: 0,
        history_range: HistoryRange {
            branch_id: branch,
            ancestor_id: None,
            leaf_id: Some(submitted.input_id),
        },
    };
    let source = serde_json::from_value(params["source"].clone())?;
    let policy = PolicyIdentity {
        name: "fixture".into(),
        version: "1".into(),
    };
    db.bind_launch(
        &submitted.run_id,
        varin_runtime::catalog::launches::LaunchSelection::from_binding(
            &binding,
            policy.clone(),
            Some(source),
        ),
    )
    .map_err(fail)?;
    let epoch = db
        .prepare_execution(&submitted.run_id, binding.clone(), policy, Value::Null)
        .map_err(fail)?
        .owner_generation;
    let request_id = format!("package-request:{serial}");
    let call = ToolCall {
        call_id: "stage".into(),
        name: "extension_package".into(),
        schema_version: "1".into(),
        arguments: json!({"action":"stage","packagePath":params["packagePath"],"expectedRevision":params["expectedRevision"]}),
    };
    let origin = ToolOrigin::ModelStep {
        request_id: request_id.clone(),
    };
    let context = ToolExecutionContext {
        run_id: submitted.run_id.clone(),
        operation_id: origin.operation_id(&call.call_id),
        origin: origin.clone(),
    };
    let owner = varin_runtime::ExecutorOwner::External {
        identity: "extension-package@1".into(),
        epoch: "managed-package-host".into(),
    };
    for record in [
        ExecutionRecord::StateChanged {
            state: RunState::Runnable,
            waiting_on: None,
        },
        ExecutionRecord::RequestPrepared {
            snapshot: RequestSnapshot {
                view: RequestView {
                    request_id: request_id.clone(),
                    run_id: submitted.run_id.clone(),
                    origin: RequestOrigin::Conversation {
                        compaction: None, step: 1,
                        history_range: binding.history_range.clone(),
                    },
                    binding,
                    history: vec![],
                },
                serialized: json!({"fixture":true}).into(),
            }
            .into(),
        },
        ExecutionRecord::ModelDispatched {
            request_id: request_id.clone(),
        },
        ExecutionRecord::ModelFinished {
            request_id,
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::ToolCalls),
            items: vec![ProviderItem {
                id: "package-call".into(),
                content: Content::ToolCall { call: call.clone() },
                opaque: None,
            }],
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: None,
        },
        ExecutionRecord::ToolAdmitted {
            context: context.clone(),
            tool: AdmittedTool {
                call: call.clone(),
                contract: ToolContract {
                    name: call.name.clone(),
                    schema_version: "1".into(),
                    read_only: false,
                    completion: CompletionKind::Result,
                    lifetime: varin_runtime::Lifetime::Run,
                    resources: vec![],
                },
            },
        },
        ExecutionRecord::ToolDispatched {
            context: context.clone(),
            executor_owner: owner.clone(),
        },
    ] {
        db.commit_execution(&submitted.run_id, epoch, &record)
            .map_err(fail)?;
    }
    assert_eq!(
        db.operation(&context.operation_id).map_err(fail)?.phase,
        varin_runtime::OperationPhase::Running
    );
    let selected = db
        .capture_launch(&submitted.run_id)
        .map_err(fail)?
        .unwrap()
        .load()
        .map_err(fail)?
        .selection
        .source;
    Ok(
        json!({"invocationId":serial,"runId":submitted.run_id,"threadId":thread,"operationId":context.operation_id,
        "callId":call.call_id,"executorOwner":owner,"origin":origin,"source":selected,"toolName":call.name,
        "operation":"effect","completion":"result","arguments":call.arguments}),
    )
}

fn coordinator_read(
    catalog: Arc<Mutex<Catalog>>,
    resources: KernelResourceClient,
    run: &str,
    input: &str,
    frame: Value,
    release_attempts: Arc<Mutex<HashMap<String, usize>>>,
) -> Result<Value, String> {
    fn invoke(
        catalog: Arc<Mutex<Catalog>>,
        resources: KernelResourceClient,
        run: &str,
        input: &str,
        frame: Value,
        release_attempts: Arc<Mutex<HashMap<String, usize>>>,
    ) -> Result<Value, Box<dyn std::error::Error>> {
        let source: varin_runtime::catalog::launches::SourceSelection =
            serde_json::from_value(frame["binding"]["source"].clone())?;
        let address = &frame["binding"];
        let binding: crate::tools::ToolBinding = serde_json::from_value(
            json!({"resourceOwner":source.resource_owner,"grantId":address["authorityId"],"runId":run,"threadId":"thread:managed-review","workspaceId":source.workspace_id,"executionWorkspaceId":source.execution_workspace_id,"rootId":address["physicalRoot"]["rootId"],"sourceMode":"live_root","liveRoot":source.live_root,"enabledTools":["file_read"],"remoteAuthority":{"authorityId":address["authorityId"],"resourceEpoch":address["resourceEpoch"],"executionOwner":address["executionOwner"]}}),
        )?;
        let schemas = crate::tools::KernelToolExecutor::selected_schemas(&binding.enabled_tools);
        let read_schema = schemas[0].clone();
        let mut request = RequestBinding {
            tokenizer: None,
            request_context: None,
            child_dispatch: None,
            goal: None,
            resource_activations: vec![],
            resource_checkpoint_id: None,
            connection_identity: "fixture".into(),
            provider_family: "fixture".into(),
            model: "fixture".into(),
            credential_ref: None,
            configuration_generation: 1,
            tool_schema_generation: 1,
            tools: schemas.clone(),
            instruction_sources: vec![],
            memory_checkpoint: None,
            attachment_refs: vec![],
            environment_cursor: 0,
            history_range: HistoryRange {
                branch_id: "main".into(),
                ancestor_id: None,
                leaf_id: Some(input.into()),
            },
        };
        let policy = PolicyIdentity {
            name: "fixture".into(),
            version: "1".into(),
        };
        let epoch = {
            let mut db = catalog.lock().unwrap();
            db.bind_launch(
                run,
                varin_runtime::catalog::launches::LaunchSelection::from_binding(
                    &request,
                    policy.clone(),
                    Some(source.clone()),
                ),
            )?;
            db.prepare_execution(run, request.clone(), policy.clone(), Value::Null)?
                .owner_generation
        };
        catalog.commit(
            run,
            epoch,
            &ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None,
            },
        )?;
        let call = ToolCall {
            call_id: "managed-read".into(),
            name: "file_read".into(),
            schema_version: "1".into(),
            arguments: json!({"path":"source.txt"}),
        };
        let request_id = "coordinator-request".to_string();
        catalog.commit(
            run,
            epoch,
            &ExecutionRecord::RequestPrepared {
                snapshot: RequestSnapshot {
                    view: RequestView {
                        request_id: request_id.clone(),
                        run_id: run.into(),
                        origin: RequestOrigin::Conversation {
                            compaction: None, step: 1,
                            history_range: request.history_range.clone(),
                        },
                        binding: request.clone(),
                        history: vec![],
                    },
                    serialized: json!({"fixture":true}).into(),
                }.into(),
            },
        )?;
        catalog.commit(
            run,
            epoch,
            &ExecutionRecord::ModelDispatched {
                request_id: request_id.clone(),
            },
        )?;
        catalog.commit(
            run,
            epoch,
            &ExecutionRecord::ModelFinished {
                request_id: request_id.clone(),
                outcome: ModelOutcome::Completed,
                finish_reason: Some(FinishReason::ToolCalls),
                items: vec![ProviderItem {
                    id: "original-managed-call".into(),
                    content: Content::ToolCall { call: call.clone() },
                    opaque: None,
                }],
                interrupted_deltas: vec![],
                usage: UsageReceipt::default(),
                failure: None,
            },
        )?;
        let origin = ToolOrigin::ModelStep { request_id };
        let context = ToolExecutionContext {
            run_id: run.into(),
            operation_id: origin.operation_id(&call.call_id),
            origin: origin.clone(),
        };
        let frozen = FrozenToolContext {
            child_dispatch: None,
            resource_activations: vec![],
            resource_checkpoint_id: None,
            run_id: run.into(),
            origin,
            tool_schema_generation: 1,
            tools: Arc::new(schemas),
            source: Some(source),
        };
        let executor = Arc::new(crate::tools::KernelToolExecutor::new(
            binding,
            resources.clone(),
        )?);
        let cancel = CancellationToken::default();
        let bound = executor.clone().bind_call(&call, &frozen, &cancel)?;
        let contract = bound.prepare(&cancel)?;
        catalog.commit(
            run,
            epoch,
            &ExecutionRecord::ToolAdmitted {
                context: context.clone(),
                tool: AdmittedTool {
                    call,
                    contract: contract.clone(),
                },
            },
        )?;
        bound.authorize(&context, &contract, &cancel)?;
        let owner = bound.executor_owner();
        catalog.commit(
            run,
            epoch,
            &ExecutionRecord::ToolDispatched {
                context: context.clone(),
                executor_owner: owner.clone(),
            },
        )?;
        let receipt = bound.execute(&context, &contract, &cancel);
        // Discard the successful delivery at A, preserving the real dispatched
        // operation as Unknown. Original recovery must hydrate B's stored receipt.
        catalog.commit(
            run,
            epoch,
            &ExecutionRecord::ToolSettled {
                context: context.clone(),
                completion: ToolCompletion::Result {
                    outcome: varin_runtime::Outcome::Indeterminate,
                    effect: varin_runtime::Effect::None,
                    content: json!({"reason":"fixture lost original delivery"}).into(),
                },
                executor_stopped: false,
            },
        )?;
        let pending = catalog.lock().unwrap().operation(&context.operation_id)?;
        assert!(crate::reconcile::reconcile_managed_read(
            &catalog, &resources, &pending
        )?);
        let operation = catalog.lock().unwrap().operation(&context.operation_id)?;
        assert_eq!(operation.execution_owner, Some(owner));
        assert_eq!(operation.outcome, Some(varin_runtime::Outcome::Succeeded));
        // The production policy runner freezes the original ToolDirectory and
        // commits its External read before SelectedCall forwards delivery cleanup.
        request.history_range.leaf_id = catalog.lock().unwrap().head("main")?;
        let (execution, recovery) = catalog.lock().unwrap().prepare_recovered_execution(
            run,
            request,
            policy,
            Value::Null,
        )?;
        let directory = varin_runtime::composition::tools::ToolDirectory::assemble(vec![
            varin_runtime::composition::tools::ToolDeclaration::new(read_schema, executor.clone()),
        ])?;
        let engine = ExecutionEngine {
            persistence: catalog.clone(),
            context_preparation: Arc::new(NoopContextPreparation),
            provider: Arc::new(NoModel),
            tools: Arc::new(directory),
            policy: Arc::new(ReadPolicy),
            progress: ProgressSink::default(),
        };
        let report = engine.run_recovered(execution, CancellationToken::default(), recovery)?;
        assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
        let delivered = catalog.lock().unwrap().delivered_external_operations()?;
        let policy_read = delivered
            .iter()
            .find(|op| op.id != context.operation_id && crate::reconcile::is_managed_read(op))
            .expect("policy read has its actual Catalog Operation");
        assert!(catalog
            .lock()
            .unwrap()
            .external_delivery_persisted(&policy_read.id)?);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !release_attempts
            .lock()
            .unwrap()
            .contains_key(&policy_read.id)
        {
            assert!(
                Instant::now() < deadline,
                "actual SelectedCall delivery hook did not run"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        resources.replay_source_delivery_releases()?;
        while release_attempts
            .lock()
            .unwrap()
            .get(&context.operation_id)
            .copied()
            .unwrap_or_default()
            < 2
        {
            assert!(
                Instant::now() < deadline,
                "original delivery cleanup replay did not retry"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        let body = serde_json::to_value(receipt)?;
        assert!(body.to_string().contains("B_ORIGINAL_SOURCE"));
        assert!(!body.to_string().contains("A_PRIVATE_SOURCE"));
        Ok(body)
    }
    invoke(catalog, resources, run, input, frame, release_attempts)
        .map_err(|error| error.to_string())
}

#[test]
fn generated_source_and_media_params_use_their_real_typed_owners() {
    let caps =
        json!({"mode":"fixed_branch","managed":true,"clientCapabilities":["filesystem:read"]});
    assert!(crate::protocol::validate_method_params("source.capabilities", &caps).is_ok());
    let mut invalid = caps;
    invalid["unrecognizedPrivilege"] = json!(true);
    assert!(crate::protocol::validate_method_params("source.capabilities", &invalid).is_err());
    let media = json!({"threadId":"thread","branchId":"branch","holder":{"kind":"history","itemId":"item"},"partIndex":0,"chunkIndex":0,"expectedContentRef":"body"});
    assert!(crate::protocol::validate_method_params("runtime.output.media.read", &media).is_ok());
    let mut invalid = media;
    invalid["objectHash"] = json!("foreign-store-hash");
    assert!(
        crate::protocol::validate_method_params("runtime.output.media.read", &invalid).is_err()
    );
}

#[test]
fn managed_read_receipt_survives_lost_reply_revoke_gc_and_reopen_until_original_release() {
    let root = std::env::temp_dir().join(format!("varin-source-read-{}", uuid::Uuid::new_v4()));
    let work = root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let body = "original managed body\n".repeat(16_000);
    std::fs::write(work.join("large.txt"), &body).unwrap();
    let owner = Owner::new(
        root.join("storage"),
        "managed-target",
        "managed-target-generation",
        "managed-target-epoch",
    );
    let (address, _) = owner.bind_live(&work, "read-owner", 1);
    let delivered = owner
        .tool(
            &address,
            "file_read",
            "large",
            json!({"path":"large.txt","length":body.len()}),
        )
        .unwrap();
    assert!(delivered.to_string().len() > 256 * 1024, "{delivered}");
    let mut observe = address.clone();
    observe["operationId"] = json!("request:tool:large");
    assert_eq!(
        owner
            .rpc("source.resource.observe", observe.clone(), None)
            .unwrap(),
        delivered
    );
    std::fs::write(
        work.join("large.txt"),
        "later bytes must never replace the original receipt",
    )
    .unwrap();
    assert_eq!(
        owner
            .tool(
                &address,
                "file_read",
                "large",
                json!({"path":"large.txt","length":body.len()})
            )
            .unwrap(),
        delivered
    );
    assert!(owner
        .tool(
            &address,
            "file_read",
            "large",
            json!({"path":"large.txt","length":1})
        )
        .is_err());
    owner.rpc("authority.grant.issue",json!({"grantId":"gc-owner","hostGeneration":owner.generation,"storageIdentity":owner.root,"sessionId":null,"owningWorkspace":"workspace","executionWorkspace":"workspace","capabilities":["storage.admin","storage.read","storage.write"],"pathScopes":[""]}),None).unwrap();
    for (id, run_worker) in [("cancelled-read", true), ("interrupted-read", false)] {
        let mut input = address.clone();
        input["call"] = json!({"runId":"run","operationId":format!("request:tool:{id}"),"origin":{"kind":"model_step","request_id":"request"},"callId":id,"name":"file_read","schemaVersion":"1","arguments":{"path":"large.txt"}});
        let work = source_resources::prepare_request(
            &mut owner.storage.lock().unwrap(),
            "source.resource.execute",
            input,
            owner.epoch,
            owner.host,
            owner.generation,
        )
        .unwrap();
        let mut address = address.clone();
        address["operationId"] = json!(format!("request:tool:{id}"));
        let pending = owner
            .rpc("source.resource.observe", address.clone(), None)
            .unwrap();
        assert_eq!(pending["accepted"], true);
        assert_eq!(pending["executorStopped"], false);
        assert_eq!(pending["result"]["completion"]["outcome"], "indeterminate");
        assert_eq!(
            owner
                .rpc("source.resource.release", address.clone(), None)
                .unwrap()["released"],
            false
        );
        if run_worker {
            let key = work.key().unwrap();
            let token = CancellationToken::default();
            owner
                .tasks
                .lock()
                .unwrap()
                .insert(key.clone(), token.clone());
            assert_eq!(
                owner
                    .rpc("source.resource.cancel", address.clone(), None)
                    .unwrap()["executorStopped"],
                false
            );
            assert!(token.is_cancelled());
            let prepared = work.execute(owner.resources.clone(), token).unwrap();
            // Collection while the completed body is still only staged cannot remove it.
            owner
                .rpc(
                    "storage.gc",
                    json!({"operationId":"read-publication-gc"}),
                    Some("gc-owner"),
                )
                .unwrap();
            prepared.finish(&mut owner.storage.lock().unwrap()).unwrap();
            owner.tasks.lock().unwrap().remove(&key);
            let stopped = owner
                .rpc("source.resource.observe", address.clone(), None)
                .unwrap();
            assert_eq!(stopped["executorStopped"], true);
            assert_eq!(stopped["result"]["completion"]["outcome"], "failed");
            assert_eq!(stopped["result"]["completion"]["effect"], "none");
            assert_eq!(
                owner
                    .rpc("source.resource.release", address.clone(), None)
                    .unwrap()["released"],
                true
            );
            address.as_object_mut().unwrap().remove("operationId");
            assert!(owner
                .tool(&address, "file_read", id, json!({"path":"large.txt"}))
                .is_err());
        } else {
            drop(work);
        }
    }
    let mut never_dispatched = address.clone();
    never_dispatched["operationId"] = json!("request:tool:not-dispatched");
    assert_eq!(
        owner
            .rpc("source.resource.release", never_dispatched.clone(), None)
            .unwrap()["released"],
        true
    );
    assert!(owner
        .tool(
            &address,
            "file_read",
            "not-dispatched",
            json!({"path":"large.txt"})
        )
        .is_err());
    assert_eq!(
        owner
            .rpc("source.resource.release", never_dispatched, None)
            .unwrap()["released"],
        true
    );
    owner
        .rpc(
            "authority.grant.revoke",
            json!({"grantId":"read-owner"}),
            None,
        )
        .unwrap();
    owner
        .rpc(
            "storage.gc",
            json!({"operationId":"receipt-gc"}),
            Some("gc-owner"),
        )
        .unwrap();
    let short = owner
        .rpc(
            "operation.get",
            json!({"operationId":"request:tool:large"}),
            Some("gc-owner"),
        )
        .unwrap();
    assert!(short.to_string().len() < 2048);
    let hash = short["result"]["objectHash"].as_str().unwrap().to_string();
    assert!(crate::protocol::object_path(&owner.root, &hash)
        .unwrap()
        .exists());
    assert_eq!(
        owner
            .rpc("source.resource.observe", observe.clone(), None)
            .unwrap(),
        delivered
    );
    drop(owner);
    let reopened = Owner::new(
        root.join("storage"),
        "managed-target",
        "managed-target-generation",
        "managed-target-reopened",
    );
    assert_eq!(
        reopened
            .rpc("source.resource.observe", observe.clone(), None)
            .unwrap(),
        delivered
    );
    let mut interrupted = address.clone();
    interrupted["operationId"] = json!("request:tool:interrupted-read");
    let unknown = reopened
        .rpc("source.resource.observe", interrupted, None)
        .unwrap();
    assert_eq!(unknown["accepted"], true);
    assert_eq!(unknown["executorStopped"], false);
    assert_eq!(unknown["result"]["completion"]["outcome"], "indeterminate");
    reopened.rpc("authority.grant.issue",json!({"grantId":"gc-reopen","hostGeneration":reopened.generation,"storageIdentity":reopened.root,"sessionId":null,"owningWorkspace":"workspace","executionWorkspace":"workspace","capabilities":["storage.admin","storage.read","storage.write"],"pathScopes":[""]}),None).unwrap();
    let retained = source_resources::prepare_request(
        &mut reopened.storage.lock().unwrap(),
        "source.resource.observe",
        observe.clone(),
        reopened.epoch,
        reopened.host,
        reopened.generation,
    )
    .unwrap();
    assert_eq!(
        reopened
            .rpc("source.resource.release", observe.clone(), None)
            .unwrap()["released"],
        true
    );
    reopened
        .rpc(
            "storage.gc",
            json!({"operationId":"receipt-retained-gc"}),
            Some("gc-reopen"),
        )
        .unwrap();
    assert!(crate::protocol::object_path(&reopened.root, &hash)
        .unwrap()
        .exists());
    let hydrated = retained
        .execute(reopened.resources.clone(), CancellationToken::default())
        .unwrap()
        .finish(&mut reopened.storage.lock().unwrap())
        .unwrap();
    assert_eq!(hydrated, delivered);
    reopened
        .rpc(
            "storage.gc",
            json!({"operationId":"receipt-final-gc"}),
            Some("gc-reopen"),
        )
        .unwrap();
    assert!(!crate::protocol::object_path(&reopened.root, &hash)
        .unwrap()
        .exists());
    assert_eq!(
        reopened
            .rpc("source.resource.release", observe.clone(), None)
            .unwrap()["released"],
        true
    );
    assert!(reopened
        .rpc("source.resource.observe", observe, None)
        .is_err());
    let tombstone = reopened
        .rpc(
            "operation.get",
            json!({"operationId":"request:tool:large"}),
            Some("gc-reopen"),
        )
        .unwrap();
    assert_eq!(tombstone["result"]["released"], true);
    assert!(tombstone["result"].get("objectHash").is_none());
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}

struct NoModel;
impl ModelProvider for NoModel {
    fn serialize(&self, _: &RequestView, _reuse: Option<&mut varin_runtime::execution::RequestCompileReuse>) -> Result<varin_runtime::execution::RequestBody, ExecutionError> {
        panic!("policy-only fixture cannot compile a model request")
    }
    fn generate(
        &self,
        _: &RequestSnapshot,
        _: &CancellationToken,
        _: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        panic!("policy-only fixture cannot invoke a provider")
    }
}
struct ReadPolicy;
impl AgentPolicy for ReadPolicy {
    fn identity(&self) -> PolicyIdentity {
        PolicyIdentity {
            name: "fixture".into(),
            version: "1".into(),
        }
    }
    fn decide(
        &self,
        _: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        _: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        let action = match event {
            PolicyEvent::Started | PolicyEvent::ToolsCompleted { .. } => PolicyAction::ToolGraph {
                nodes: vec![PolicyToolNode {
                    id: "managed-policy-read".into(),
                    depends_on: vec![],
                    call: ToolCall {
                        call_id: "managed-policy-read".into(),
                        name: "file_read".into(),
                        schema_version: "1".into(),
                        arguments: json!({"path":"source.txt"}),
                    },
                }],
            },
            PolicyEvent::ModelCompleted { tool_calls, .. } if *tool_calls > 0 => {
                PolicyAction::ExecuteTools
            }
            PolicyEvent::ToolGraphCompleted { receipts, .. } => {
                assert_eq!(receipts.len(), 1);
                assert_eq!(receipts[0].outcome(), varin_runtime::Outcome::Succeeded);
                PolicyAction::Complete
            }
            _ => panic!("unexpected policy event: {event:?}"),
        };
        Ok(PolicyDecision {
            action,
            state: state.clone(),
        })
    }
}

#[test]
fn managed_file_followup_original_catalog_storage_documents_and_lost_accept() {
    use crate::host_query::OwnerChannel;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let root = std::env::temp_dir().join(format!("varin-managed-file-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let mut a = Owner::new(
        root.join("storage-a"),
        "managed-coordinator",
        "managed-coordinator-generation",
        "managed-coordinator-epoch",
    );
    let mut b = Owner::new(
        root.join("storage-b"),
        "managed-target",
        "managed-target-generation",
        "managed-target-epoch",
    );
    let mut db = Catalog::open(root.join("catalog")).unwrap();
    db.publish_bot_gate(varin_runtime::catalog::bot::BotGate {
        bot_id: "file-bot".into(),
        profile_revision: 1,
        activity_operation_id: Some("active".into()),
        permitted: true,
    })
    .unwrap();
    db.create_bot_thread("thread:managed-review", "main", "file-bot")
        .unwrap();
    let p = db
        .prepare_submission(
            SubmitInput {
                key: "file-source".into(),
                thread_id: "thread:managed-review".into(),
                branch_id: "main".into(),
                expected_head: None,
                input: json!("observe selected target"),
                configuration: json!({}),
            },
            None,
            None,
        )
        .unwrap()
        .load(None, false)
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
    let runtime = Arc::new(varin_runtime::supervisor::RunSupervisor::new(db));
    let (source_tx, source_rx) = mpsc::sync_channel(32);
    let source = OwnerChannel::new("source-resource", source_tx);
    source.initialize(a.epoch);
    let (watch_tx, watch_rx) = mpsc::sync_channel(32);
    let watch = OwnerChannel::new("file-observation", watch_tx);
    watch.initialize(b.epoch);
    let (local_tx, _local_rx) = mpsc::sync_channel(32);
    let local = OwnerChannel::new("file-observation", local_tx);
    local.initialize(a.epoch);
    let a_storage = a.storage.clone();
    let b_storage = b.storage.clone();
    let a_files = crate::file_observation::Client::new(
        move |c| {
            c.serve(
                Some(&mut a_storage.lock().unwrap()),
                "managed-coordinator-epoch",
                "managed-coordinator",
                "managed-coordinator-generation",
            );
            Ok(())
        },
        local.clone(),
    )
    .with_source_bridge(source.clone());
    let reads = Arc::new(AtomicUsize::new(0));
    let read_count = reads.clone();
    let b_files = crate::file_observation::Client::new(
        move |c| {
            if matches!(&c, crate::file_observation::Command::Prepare { .. }) {
                read_count.fetch_add(1, Ordering::SeqCst);
            }
            c.serve(
                Some(&mut b_storage.lock().unwrap()),
                "managed-target-epoch",
                "managed-target",
                "managed-target-generation",
            );
            Ok(())
        },
        watch.clone(),
    );
    a.resources = a.resources.clone().with_file_observations(a_files);
    b.resources = b.resources.clone().with_file_observations(b_files);
    let mut host = Host::with_script(
        "packages/web/application-host/lib/harness/managed-source-host.test-helper.ts",
    );
    host.send(json!({"kind":"fixture-init","scenario":"file-followup","root":root,"storageRootA":a.root,"storageRootB":b.root,"epochA":a.epoch,"epochB":b.epoch,"runId":run}));
    let reject_release = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (send, completed) = mpsc::channel();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        assert!(Instant::now() < deadline, "managed file helper timed out");
        while let Ok(frame) = completed.try_recv() {
            host.send(frame);
        }
        while let Ok(frame) = source_rx.try_recv() {
            if frame["query"]["action"]["kind"] == "release"
                && reject_release.swap(false, Ordering::SeqCst)
            {
                source.receive(json!({"v":1,"kind":"source-resource-response","id":frame["id"],"kernelEpoch":a.epoch,"result":{"ok":false,"message":"original B temporarily unavailable"}}));
            } else {
                host.send(json!({"kind":"fixture-coordinator-frame","frame":frame}));
            }
        }
        while let Ok(frame) = watch_rx.try_recv() {
            host.send(json!({"kind":"fixture-target-frame","frame":frame}));
        }
        let Some(frame) = host.next_frame(Duration::from_millis(5)) else {
            continue;
        };
        match frame["kind"].as_str().unwrap_or("") {
            "fixture-frame" => {
                if frame["target"] == "b" {
                    watch.receive(frame["frame"].clone())
                } else {
                    source.receive(frame["frame"].clone())
                }
            }
            "fixture-request" => {
                let owner = if frame["target"] == "b" {
                    b.clone()
                } else {
                    a.clone()
                };
                let runtime = runtime.clone();
                let run = run.clone();
                let reads = reads.clone();
                let reject_release = reject_release.clone();
                let send = send.clone();
                std::thread::spawn(move || {
                    let result = (|| -> Result<Value, KernelError> {
                        let method = frame["method"].as_str().unwrap();
                        let params = frame["params"].clone();
                        if method == "fixture.file.stats" {
                            return Ok(json!({"reads":reads.load(Ordering::SeqCst)}));
                        }
                        if method == "fixture.file.launch" {
                            let launch = serde_json::from_value(
                                json!({"extension_bindings":[],"connection_identity":"fixture","provider_family":"fixture","model":"fixture","configuration_generation":1,"tool_schema_generation":1,"tools":[crate::followup_tools::schema()],"policy":{"name":"fixture","version":"1"},"source":params["source"]}),
                            )?;
                            runtime
                                .catalog()
                                .lock()
                                .unwrap()
                                .bind_launch(&run, launch)
                                .map_err(super::domain)?;
                            return Ok(json!({"bound":true}));
                        }
                        if method == "fixture.file.native" {
                            return native_file_followup(
                                runtime.catalog(),
                                owner.resources.clone(),
                                &run,
                                &params["binding"],
                            )
                            .map_err(|e| KernelError::Operation(e.to_string()));
                        }
                        if method == "fixture.file.delete" {
                            let suspension = varin_runtime::catalog::bot::BotSuspension {
                                bot_id: "file-bot".into(),
                                profile_revision: 2,
                                activity_operation_id: "delete-file-bot".into(),
                            };
                            {
                                let catalog = runtime.catalog();
                                let mut db = catalog.lock().unwrap();
                                db.publish_bot_gate(varin_runtime::catalog::bot::BotGate {
                                    bot_id: suspension.bot_id.clone(),
                                    profile_revision: 2,
                                    activity_operation_id: Some(
                                        suspension.activity_operation_id.clone(),
                                    ),
                                    permitted: false,
                                })
                                .map_err(super::domain)?;
                                db.suspend_bot_scope(suspension.clone())
                                    .map_err(super::domain)?;
                            }
                            reject_release.store(params["fail"] == true, Ordering::SeqCst);
                            return super::bot_scope_commands::remove(
                                &runtime.catalog(),
                                &owner.resources,
                                suspension,
                                &std::sync::atomic::AtomicBool::new(false),
                            );
                        }
                        if method == "runtime.run.inspect" {
                            return Ok(serde_json::to_value(
                                runtime
                                    .catalog()
                                    .lock()
                                    .unwrap()
                                    .run(&run)
                                    .map_err(super::domain)?,
                            )?);
                        }
                        if method == "runtime.launch.inspect" {
                            let r = runtime
                                .catalog()
                                .lock()
                                .unwrap()
                                .capture_launch(&run)
                                .map_err(super::domain)?;
                            return Ok(serde_json::to_value(
                                r.map(|r| r.load()).transpose().map_err(super::domain)?,
                            )?);
                        }
                        if method == "runtime.followup.control" {
                            return Ok(serde_json::to_value(
                                runtime
                                    .catalog()
                                    .lock()
                                    .unwrap()
                                    .control_followup(
                                        params["followupId"].as_str().unwrap(),
                                        params["expectedRevision"].as_u64().unwrap(),
                                        serde_json::from_value(params["action"].clone())?,
                                    )
                                    .map_err(super::domain)?,
                            )?);
                        }
                        if method.starts_with("runtime.followup.") {
                            crate::protocol::validate_method_params(method, &params)?;
                            let cancel = CancellationToken::default();
                            return super::followup_commands::execute(
                                runtime,
                                owner.resources.clone(),
                                method,
                                params,
                                &cancel.shared_flag(),
                                Some(cancel.clone()),
                            );
                        }
                        owner.rpc(method, params, frame["grantId"].as_str())
                    })();
                    let response = match result {
                        Ok(value) => {
                            json!({"kind":"fixture-response","id":frame["id"],"ok":true,"result":value})
                        }
                        Err(e) => {
                            json!({"kind":"fixture-response","id":frame["id"],"ok":false,"error":e.to_string()})
                        }
                    };
                    let _ = send.send(response);
                });
            }
            "fixture-result" => {
                assert_eq!(frame["ok"], true);
                break;
            }
            _ => panic!("managed file Host failed {frame}"),
        }
    }
    assert!(reads.load(Ordering::SeqCst) >= 4);
    assert!(matches!(
        runtime.catalog().lock().unwrap().run(&run),
        Err(varin_runtime::RuntimeError::NotFound(_))
    ));
    let persisted = rusqlite::Connection::open_with_flags(
        root.join("catalog/conversation.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let leftovers:i64=persisted.query_row("SELECT count(*) FROM commands WHERE id LIKE 'followup-register:%' OR id LIKE 'followup-register-cancel:%'",[],|r|r.get(0)).unwrap();
    assert_eq!(
        leftovers, 0,
        "deleted Bot leaves no registration ContentStore root"
    );
    drop(persisted);
    source.close();
    watch.close();
    local.close();
    drop(host);
    drop(a);
    drop(b);
    drop(runtime);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn environment_forward_canonical_acceptance_survives_unknown_and_terminal_host_receipts() {
    use varin_runtime::{Effect, ExecutorOwner, Lifetime, Outcome};
    let root =
        std::env::temp_dir().join(format!("varin-forward-acceptance-{}", uuid::Uuid::new_v4()));
    let mut db = Catalog::open(&root).unwrap();
    db.create_thread("forward-thread", "forward-main").unwrap();
    let submitted = db
        .prepare_submission(
            SubmitInput {
                key: "forward".into(),
                thread_id: "forward-thread".into(),
                branch_id: "forward-main".into(),
                expected_head: None,
                input: json!("forward selected service"),
                configuration: json!({}),
            },
            None,
            None,
        )
        .unwrap()
        .load(None, false)
        .unwrap();
    let submitted = db.admit_submission(submitted).unwrap();
    let run = submitted.run_id;
    let schema:ToolSchema=serde_json::from_value(json!({"name":"environment_forward","version":"1","description":"Forward a selected service","schema":{"type":"object"},"metadata":{"service_id":"environment.forward","service_version":1,"completion":"job","operation":"effect","lifetime":"thread"}})).unwrap();
    let binding = RequestBinding {
        tokenizer: None,
        request_context: None,
        child_dispatch: None,
        goal: None,
        resource_activations: vec![],
        resource_checkpoint_id: None,
        connection_identity: "fixture".into(),
        provider_family: "fixture".into(),
        model: "fixture".into(),
        credential_ref: None,
        configuration_generation: 1,
        tool_schema_generation: 1,
        tools: vec![schema],
        instruction_sources: vec![],
        memory_checkpoint: None,
        attachment_refs: vec![],
        environment_cursor: 0,
        history_range: HistoryRange {
            branch_id: "forward-main".into(),
            ancestor_id: None,
            leaf_id: Some(submitted.input_id),
        },
    };
    let policy = PolicyIdentity {
        name: "fixture".into(),
        version: "1".into(),
    };
    db.bind_launch(
        &run,
        varin_runtime::catalog::launches::LaunchSelection::from_binding(
            &binding,
            policy.clone(),
            None,
        ),
    )
    .unwrap();
    let epoch = db
        .prepare_execution(&run, binding.clone(), policy, Value::Null)
        .unwrap()
        .owner_generation;
    db.commit_execution(
        &run,
        epoch,
        &ExecutionRecord::StateChanged {
            state: RunState::Runnable,
            waiting_on: None,
        },
    )
    .unwrap();
    let call = ToolCall {
        call_id: "forward-call".into(),
        name: "environment_forward".into(),
        schema_version: "1".into(),
        arguments: json!({"port":8123}),
    };
    db.commit_execution(
        &run,
        epoch,
        &ExecutionRecord::RequestPrepared {
            snapshot: RequestSnapshot {
                view: RequestView {
                    request_id: "forward-request".into(),
                    run_id: run.clone(),
                    origin: RequestOrigin::Conversation {
                        compaction: None, step: 1,
                        history_range: binding.history_range.clone(),
                    },
                    binding,
                    history: vec![],
                },
                serialized: json!({"fixture":true}).into(),
            }.into(),
        },
    )
    .unwrap();
    db.commit_execution(
        &run,
        epoch,
        &ExecutionRecord::ModelDispatched {
            request_id: "forward-request".into(),
        },
    )
    .unwrap();
    db.commit_execution(
        &run,
        epoch,
        &ExecutionRecord::ModelFinished {
            request_id: "forward-request".into(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::ToolCalls),
            items: vec![ProviderItem {
                id: "forward-item".into(),
                content: Content::ToolCall { call: call.clone() },
                opaque: None,
            }],
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: None,
        },
    )
    .unwrap();
    let origin = ToolOrigin::ModelStep {
        request_id: "forward-request".into(),
    };
    let context = ToolExecutionContext {
        run_id: run.clone(),
        operation_id: origin.operation_id(&call.call_id),
        origin: origin.clone(),
    };
    db.commit_execution(
        &run,
        epoch,
        &ExecutionRecord::ToolAdmitted {
            context: context.clone(),
            tool: AdmittedTool {
                call: call.clone(),
                contract: ToolContract {
                    name: call.name.clone(),
                    schema_version: "1".into(),
                    read_only: false,
                    completion: CompletionKind::Job,
                    lifetime: Lifetime::Thread,
                    resources: vec![],
                },
            },
        },
    )
    .unwrap();
    let owner = ExecutorOwner::External {
        identity: "environment.forward@1".into(),
        epoch: "forward-owner".into(),
    };
    db.commit_execution(
        &run,
        epoch,
        &ExecutionRecord::ToolDispatched {
            context: context.clone(),
            executor_owner: owner.clone(),
        },
    )
    .unwrap();
    let runtime = Arc::new(varin_runtime::supervisor::RunSupervisor::new(db));
    let catalog = runtime.catalog();
    let host_binding = json!({"operationId":context.operation_id,"executionOwner":owner,"domain":"environment.forward","domainVersion":1,"subject":{"kind":"environment_forward","hostId":"coordinator","hostEpoch":"forward-owner","target":{"kind":"local"},"serviceHost":"127.0.0.1","servicePort":8123}});
    let invoke = |method: &str, params: Value| {
        super::host_job_commands::execute(
            runtime.clone(),
            method,
            params,
            &std::sync::atomic::AtomicBool::new(false),
        )
    };
    let mut forged = host_binding.clone();
    forged["subject"]["servicePort"] = json!(9999);
    assert!(invoke("runtime.host_job.begin", json!({"binding":forged})).is_err());
    invoke("runtime.host_job.begin", json!({"binding":host_binding})).unwrap();
    catalog
        .commit(
            &run,
            epoch,
            &ExecutionRecord::ToolSettled {
                context: context.clone(),
                completion: ToolCompletion::Result {
                    outcome: Outcome::Indeterminate,
                    effect: Effect::Unknown,
                    content: json!({"unknown":"transport"}).into(),
                },
                executor_stopped: false,
            },
        )
        .unwrap();
    invoke("runtime.host_job.accept",json!({"binding":host_binding,"content":{"data":{"state":"live","targetHost":"B"},"parts":[]}})).unwrap();
    let original = invoke(
        "runtime.host_job.acceptance",
        json!({"operationId":context.operation_id}),
    )
    .unwrap();
    assert_eq!(original["kind"], "job_accepted");
    assert_eq!(original["content"]["data"]["state"], "live");
    {
        let prep = catalog.lock().unwrap().prepare_result_content();
        let receipt = prep
            .write_external_receipt(varin_runtime::ExternalReceipt {
                executor: call.name.clone(),
                identity: context.operation_id.clone(),
                epoch: "forward-owner".into(),
                outcome: Outcome::Succeeded,
                effect: Effect::Confirmed,
                result: json!({"state":"stopped"}).into(),
            })
            .unwrap();
        catalog
            .lock()
            .unwrap()
            .record_host_job_terminal(
                &serde_json::from_value(host_binding.clone()).unwrap(),
                receipt,
                true,
            )
            .unwrap();
    }
    let recalled = invoke(
        "runtime.host_job.acceptance",
        json!({"operationId":context.operation_id}),
    )
    .unwrap();
    assert_eq!(recalled, original);
    let late = |completion: Value| {
        serde_json::from_value::<crate::host_tools::LateReceipt>(json!({"v":1,"kind":"host-tool-late-receipt","id":"late","kernelEpoch":"transport","executionOwner":owner,"call":{"runId":run,"operationId":context.operation_id,"origin":origin,"callId":call.call_id,"name":call.name,"schemaVersion":call.schema_version,"arguments":call.arguments},"receipt":{"completion":completion,"executor_stopped":false}})).unwrap().apply(&catalog)
    };
    let mut current = original.clone();
    current["content"]["data"]["state"] = json!("stopped");
    assert!(late(current).is_err());
    late(recalled).unwrap();
    let historical = catalog
        .lock()
        .unwrap()
        .capture_call_completion(&context.operation_id)
        .unwrap()
        .load()
        .unwrap();
    assert!(matches!(
        historical,
        ToolCompletion::Result {
            outcome: Outcome::Indeterminate,
            ..
        }
    ));
    drop(runtime);
    drop(catalog);
    std::fs::remove_dir_all(root).unwrap();
}

fn native_file_followup(
    catalog: Arc<Mutex<Catalog>>,
    resources: KernelResourceClient,
    run: &str,
    remote: &Value,
) -> Result<Value, Box<dyn std::error::Error>> {
    let source: varin_runtime::catalog::launches::SourceSelection =
        serde_json::from_value(remote["source"].clone())?;
    let binding: crate::tools::ToolBinding = serde_json::from_value(
        json!({"resourceOwner":source.resource_owner,"grantId":remote["authorityId"],"runId":run,"threadId":"thread:managed-review","workspaceId":source.workspace_id,"executionWorkspaceId":source.execution_workspace_id,"rootId":remote["physicalRoot"]["rootId"],"sourceMode":"live_root","liveRoot":source.live_root,"enabledTools":["file_read","file_write","file_search","process_spawn","process_read","process_inspect"],"remoteAuthority":{"authorityId":remote["authorityId"],"resourceEpoch":remote["resourceEpoch"],"executionOwner":remote["executionOwner"]}}),
    )?;
    let schema = crate::followup_tools::schema();
    let request = RequestBinding {
        tokenizer: None,
        request_context: None,
        child_dispatch: None,
        goal: None,
        resource_activations: vec![],
        resource_checkpoint_id: None,
        connection_identity: "fixture".into(),
        provider_family: "fixture".into(),
        model: "fixture".into(),
        credential_ref: None,
        configuration_generation: 1,
        tool_schema_generation: 1,
        tools: vec![schema.clone()],
        instruction_sources: vec![],
        memory_checkpoint: None,
        attachment_refs: vec![],
        environment_cursor: 0,
        history_range: HistoryRange {
            branch_id: "main".into(),
            ancestor_id: None,
            leaf_id: catalog.lock().unwrap().head("main")?,
        },
    };
    let epoch = catalog
        .lock()
        .unwrap()
        .prepare_execution(
            run,
            request.clone(),
            PolicyIdentity {
                name: "fixture".into(),
                version: "1".into(),
            },
            Value::Null,
        )?
        .owner_generation;
    catalog.commit(
        run,
        epoch,
        &ExecutionRecord::StateChanged {
            state: RunState::Runnable,
            waiting_on: None,
        },
    )?;
    let call = ToolCall {
        call_id: "native-file".into(),
        name: schema.name.clone(),
        schema_version: schema.version.clone(),
        arguments: json!({"action":"register","trigger":{"kind":"file","path":"source.txt","condition":"changed"},"instruction":"Original native file continuation"}),
    };
    catalog.commit(
        run,
        epoch,
        &ExecutionRecord::RequestPrepared {
            snapshot: RequestSnapshot {
                view: RequestView {
                    request_id: "native-file-request".into(),
                    run_id: run.into(),
                    origin: RequestOrigin::Conversation {
                        compaction: None, step: 1,
                        history_range: request.history_range.clone(),
                    },
                    binding: request,
                    history: vec![],
                },
                serialized: json!({"fixture":true}).into(),
            }.into(),
        },
    )?;
    catalog.commit(
        run,
        epoch,
        &ExecutionRecord::ModelDispatched {
            request_id: "native-file-request".into(),
        },
    )?;
    catalog.commit(
        run,
        epoch,
        &ExecutionRecord::ModelFinished {
            request_id: "native-file-request".into(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::ToolCalls),
            items: vec![ProviderItem {
                id: "native-file-item".into(),
                content: Content::ToolCall { call: call.clone() },
                opaque: None,
            }],
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: None,
        },
    )?;
    let origin = ToolOrigin::ModelStep {
        request_id: "native-file-request".into(),
    };
    let context = ToolExecutionContext {
        run_id: run.into(),
        operation_id: origin.operation_id(&call.call_id),
        origin: origin.clone(),
    };
    let frozen = FrozenToolContext {
        child_dispatch: None,
        resource_activations: vec![],
        resource_checkpoint_id: None,
        run_id: run.into(),
        origin,
        tool_schema_generation: 1,
        tools: Arc::new(vec![schema]),
        source: Some(source),
    };
    let directory = Arc::new(varin_runtime::composition::tools::ToolDirectory::assemble(
        vec![crate::followup_tools::declaration(
            catalog.clone(),
            Some(binding),
            Some(resources),
        )],
    )?);
    let cancel = CancellationToken::default();
    let mut denied = frozen.clone();
    denied.tools = Arc::new(vec![]);
    assert!(
        directory
            .clone()
            .bind_call(&call, &denied, &cancel)
            .is_err(),
        "missing selected original tool never admits a managed observer"
    );
    let bound = directory.bind_call(&call, &frozen, &cancel)?;
    let contract = bound.prepare(&cancel)?;
    catalog.commit(
        run,
        epoch,
        &ExecutionRecord::ToolAdmitted {
            context: context.clone(),
            tool: AdmittedTool {
                call: call.clone(),
                contract: contract.clone(),
            },
        },
    )?;
    bound.authorize(&context, &contract, &cancel)?;
    catalog.commit(
        run,
        epoch,
        &ExecutionRecord::ToolDispatched {
            context: context.clone(),
            executor_owner: bound.executor_owner(),
        },
    )?;
    let receipt = bound.execute(&context, &contract, &cancel);
    catalog.commit(
        run,
        epoch,
        &ExecutionRecord::ToolSettled {
            context,
            completion: receipt.completion.clone(),
            executor_stopped: receipt.executor_stopped,
        },
    )?;
    Ok(serde_json::to_value(receipt.completion)?)
}

#[test]
fn managed_package_delivery_cleanup_recovers_original_catalog_without_replaying_stage() {
    let root = std::env::temp_dir().join(format!("varin-package-delivery-{}", uuid::Uuid::new_v4()));
    let mut db = Catalog::open(root.join("catalog")).unwrap();
    let source = json!({"resource_owner":{"kind":"managed_host","hostId":"b","connectionId":"original-b","endpointIdentity":"identity-b"},
        "mode":"fixed_branch","workspace_id":"workspace","execution_workspace_id":"workspace","branch_id":"source-branch","revision":3,"live_root":null,"environment_run_id":null});
    let original = begin_package_call(&mut db, json!({"source":source,"packagePath":"package","expectedRevision":0})).unwrap();
    let id = original["operationId"].as_str().unwrap().to_string();
    let run = original["runId"].as_str().unwrap().to_string();
    let context = ToolExecutionContext { run_id: run.clone(), operation_id: id.clone(),
        origin: serde_json::from_value(original["origin"].clone()).unwrap() };
    let receipt = json!({"outcome":"installed_disabled","artifactIntegrity":"original-artifact","catalogRevision":1});
    let catalog = Arc::new(Mutex::new(db));
    let (tx, rx) = mpsc::sync_channel(8);
    let bridge = crate::host_query::OwnerChannel::new("source-resource", tx);
    bridge.initialize("coordinator-epoch");
    let resources = KernelResourceClient::new(|_| panic!("cleanup cannot execute stage or Storage effects"), |_| Ok(()), Default::default())
        .with_journal_catalog(catalog.clone()).with_source_bridge(bridge.clone());
    // A running invocation has no trusted delivery/stop evidence.
    resources.release_delivered_package_source(&id).unwrap();
    assert!(rx.try_recv().is_err());
    {
        let mut db = catalog.lock().unwrap();
        let epoch = db.epoch();
        db.commit_execution(&run, epoch, &ExecutionRecord::ToolSettled { context,
            completion: ToolCompletion::Result { outcome: varin_runtime::Outcome::Succeeded,
                effect: varin_runtime::Effect::Confirmed, content: receipt.clone().into() }, executor_stopped: true }).unwrap();
        assert!(db.external_delivery_persisted(&id).unwrap());
    }
    let retry = resources.clone();
    let operation = id.clone();
    let first = std::thread::spawn(move || retry.release_delivered_package_source(&operation));
    let frame = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(frame["query"]["kind"], "package_cleanup");
    assert_eq!(frame["query"]["operationId"], id);
    assert_eq!(frame["query"]["runId"], run);
    assert_eq!(frame["query"]["threadId"], original["threadId"]);
    assert_eq!(frame["query"]["source"], source);
    assert!(catalog.try_lock().is_ok(), "network cleanup must not hold Catalog");
    bridge.receive(json!({"v":1,"kind":"source-resource-response","id":frame["id"],"kernelEpoch":"coordinator-epoch",
        "result":{"ok":false,"message":"release did not reach B"}}));
    assert!(first.join().unwrap().is_err());
    drop(resources);
    drop(catalog);
    let reopened = Arc::new(Mutex::new(Catalog::open(root.join("catalog")).unwrap()));
    let resources = KernelResourceClient::new(|_| panic!("recovery cannot rerun stage"), |_| Ok(()), Default::default())
        .with_journal_catalog(reopened.clone()).with_source_bridge(bridge.clone());
    resources.replay_source_delivery_releases().unwrap();
    let replay = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(replay["query"], frame["query"]);
    assert!(reopened.try_lock().is_ok());
    bridge.receive(json!({"v":1,"kind":"source-resource-response","id":replay["id"],"kernelEpoch":"coordinator-epoch",
        "result":{"ok":true,"value":{"operationId":id,"released":true}}}));
    let deadline = Instant::now() + Duration::from_secs(5);
    while Arc::strong_count(&reopened) > 2 {
        assert!(Instant::now() < deadline, "cleanup worker did not settle");
        std::thread::sleep(Duration::from_millis(2));
    }
    let operation = { let db = reopened.lock().unwrap(); db.capture_operation_read(db.operation(&id).unwrap()) }.load().unwrap();
    assert_eq!(operation.outcome, Some(varin_runtime::Outcome::Succeeded));
    assert!(serde_json::to_value(operation).unwrap().to_string().contains("original-artifact"));
    assert!(rx.try_recv().is_err(), "cleanup emitted no stage invocation");
    drop(resources); drop(reopened); bridge.close();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn package_capture_storage_reopen_releases_exact_pin_and_original_temporary_owners() {
    use base64::Engine;
    let root = std::env::temp_dir().join(format!("varin-package-pins-{}", uuid::Uuid::new_v4()));
    let owner = Owner::new(root.join("storage"), "b", "generation-one", "epoch-one");
    owner.rpc("authority.grant.issue", json!({"grantId":"source-grant","hostGeneration":owner.generation,
        "storageIdentity":owner.root,"sessionId":null,"owningWorkspace":"workspace","executionWorkspace":"workspace",
        "threadId":"thread","runId":"run","operationId":"package-stage",
        "capabilities":["storage.read","storage.write","storage.admin"],"pathScopes":[""]}), None).unwrap();
    let mut hashes = Vec::new();
    for (name, content) in [("package", b"package-only".as_slice()), ("durable-handoff", b"other-consumer".as_slice()), ("unfinished-capture", b"partial-capture".as_slice())] {
        let upload = json!({"operationId":format!("upload-{name}"),"streamId":name,"workspaceId":"workspace","byteLength":content.len()});
        owner.rpc("storage.putBlob.begin", upload.clone(), Some("source-grant")).unwrap();
        owner.rpc("storage.putBlob.chunk", json!({"streamId":name,"sequence":0,
            "bytesBase64":base64::engine::general_purpose::STANDARD.encode(content)}), Some("source-grant")).unwrap();
        let body = owner.rpc("storage.putBlob.finish", json!({"operationId":format!("upload-{name}"),
            "streamId":name,"workspaceId":"workspace"}), Some("source-grant")).unwrap();
        hashes.push(body["hash"].as_str().unwrap().to_string());
        if name == "unfinished-capture" { continue; }
        owner.rpc("branch.create.begin", json!({"operationId":format!("create-{name}"),"builderId":name,
            "workspaceId":"workspace","branchId":name,"draftBasePaths":[],"captureScopes":[]}), Some("source-grant")).unwrap();
        let state = crate::model::PathState::RegularFile {
            object_hash: body["hash"].as_str().unwrap().to_string(), byte_length: content.len() as u64, mode: 0o644,
        };
        owner.rpc("branch.create.append", json!({"builderId":name,"sequence":0,"entries":[{"path":"body.txt",
            "state":state,"ownerId":body["ownerId"]}]}), Some("source-grant")).unwrap();
        owner.rpc("branch.create.finish", json!({"operationId":format!("create-{name}"),"builderId":name}), Some("source-grant")).unwrap();
        owner.rpc("branch.pin", json!({"operationId":format!("pin-{name}"),"branchId":name,"revision":0,"pinId":format!("{name}-pin")}), Some("source-grant")).unwrap();
        owner.rpc("branch.delete", json!({"operationId":format!("delete-{name}"),"branchId":name}), Some("source-grant")).unwrap();
    }
    let record = json!({"operationId":"capture-intent","recordId":"extension.package-capture:capture","workspaceId":"workspace",
        "recordType":"extension.package-capture","state":"capturing","threadId":"thread","runId":"run",
        "payloadJson":json!({"id":"capture","workspaceId":"workspace","captureId":"original-capture","packagePath":".",
            "identity":{"principalId":"a-principal","coordinatorHostId":"a","authorityId":"source-authority","resourceEpoch":"epoch-one",
                "operationId":"package-stage","scope":{"kind":"run","threadId":"thread","runId":"run","epoch":1},
                "source":{"workspace_id":"workspace","mode":"fixed_branch","branch_id":"package","revision":0}}}).to_string(),
        "ownerIds":[],"references":[]});
    owner.rpc("storage.record.put", record, Some("source-grant")).unwrap();
    drop(owner);
    let owner = Owner::new(root.join("storage"), "b", "generation-two", "epoch-two");
    owner.rpc("authority.grant.issue", json!({"grantId":"cleanup","hostGeneration":owner.generation,"storageIdentity":owner.root,"sessionId":null,
        "owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"thread","runId":"run","operationId":"package-stage",
        "capabilities":["storage.read","storage.write","storage.maintenance","storage.gc"],"pathScopes":[""]}), None).unwrap();
    let invoke = |method, params| owner.rpc(method, params, Some("cleanup")).unwrap();
    assert!(invoke("storage.record.get", json!({"workspaceId":"workspace","recordId":"extension.package-capture:capture"})).is_object());
    invoke("storage.gc", json!({"operationId":"gc-before"}));
    for hash in &hashes { assert!(crate::protocol::object_path(&owner.root, hash).unwrap().exists()); }
    assert_eq!(invoke("branch.unpin", json!({"operationId":"cleanup-pin","branchId":"package","pinId":"package-pin"}))["released"], true);
    invoke("storage.record.release", json!({"operationId":"cleanup-record","workspaceId":"workspace","recordId":"extension.package-capture:capture"}));
    owner.rpc("authority.grant.retire", json!({"target":{"kind":"grant","grantId":"source-grant"}}), None).unwrap();
    invoke("storage.gc", json!({"operationId":"gc-after"}));
    assert!(!crate::protocol::object_path(&owner.root, &hashes[0]).unwrap().exists());
    assert!(crate::protocol::object_path(&owner.root, &hashes[1]).unwrap().exists(), "another consumer's durable pin survives");
    assert!(!crate::protocol::object_path(&owner.root, &hashes[2]).unwrap().exists(), "retirement releases undelivered capture owners");
    assert_eq!(invoke("pin.read", json!({"pinId":"durable-handoff-pin","includeEntries":false}))["pinId"], "durable-handoff-pin");
    drop(owner);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn script_source_stop_fences_late_spawn_and_recalls_original_after_reopen() {
    let root = std::env::temp_dir().join(format!("varin-script-source-{}", uuid::Uuid::new_v4()));
    let work = root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let owner = Owner::new(root.join("storage"), "script-host", "script-generation", "script-epoch");
    let bind = |grant: &str, process: &str| {
        owner.rpc("authority.grant.issue", json!({"grantId":grant,"hostGeneration":owner.generation,
            "storageIdentity":owner.root,"sessionId":null,"owningWorkspace":"workspace","executionWorkspace":"workspace",
            "threadId":"thread","runId":"run","operationId":process,
            "capabilities":["storage.read","storage.write","process"],"pathScopes":[""]}), None).unwrap();
        let physical=owner.rpc("file.root.register",json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":work}),Some(grant)).unwrap();
        let live=json!({"hostId":owner.host,"rootId":physical["rootId"],"canonicalRoot":physical["canonicalRoot"]});
        let source=json!({"resource_owner":{"kind":"managed_host","hostId":owner.host,"connectionId":"original","endpointIdentity":"original"},
            "workspace_id":"workspace","execution_workspace_id":"workspace","mode":"live_root","branch_id":null,"revision":null,"live_root":live,"environment_run_id":null});
        let opened=owner.rpc("source.authority.open",json!({"principalId":"client","coordinatorHostId":"a",
            "scope":{"kind":"run","threadId":"thread","runId":"run","epoch":1},"source":source,"grantId":grant,"enabledTools":[],
            "purpose":"script_environment","operationId":process}),None).unwrap();
        owner.rpc("source.authority.bind",json!({"principalId":"client","coordinatorHostId":"a","authorityId":opened["authorityId"],
            "resourceEpoch":opened["resourceEpoch"],"physicalRoot":live,"toolBinding":{"resourceOwner":source["resource_owner"],
                "grantId":grant,"runId":"run","threadId":"thread","workspaceId":"workspace","executionWorkspaceId":"workspace",
                "rootId":physical["rootId"],"sourceMode":"live_root","liveRoot":live,"enabledTools":[]}}),None).unwrap();
        (source, physical["rootId"].clone())
    };
    let (source, root_id) = bind("late-grant", "late-process");
    let control=|id: &str, stop: bool|json!({"principalId":"client","coordinatorHostId":"a","threadId":"thread","runId":"run","processId":id,"source":source,"stop":stop});
    let spawn=|id: &str|json!({"processId":id,"workspaceId":"workspace","rootId":root_id,"cwd":"","command":std::env::var("VARIN_NODE").unwrap_or_else(|_|"node".into()),
        "args":["-e","process.stdout.write('original');setInterval(()=>{},1000)"],"env":[],"mode":"pipe","cols":80,"rows":24});
    let fenced = owner.rpc("source.script.control", control("late-process", true), None).unwrap();
    assert_eq!(fenced["accepted"], false);
    assert_eq!(fenced["executorStopped"], false, "missing acceptance is not proof of a stopped evaluator");
    assert!(owner.rpc("process.spawn", spawn("late-process"), Some("late-grant")).is_err(), "late original spawn must fail its revoked grant");
    let (same_source, _) = bind("active-grant", "active-process");
    assert_eq!(same_source, source);
    bind("unrelated-grant", "unrelated-process");
    let started=owner.rpc("process.spawn",spawn("active-process"),Some("active-grant")).unwrap();
    assert_eq!(started["processId"], "active-process");
    let mut foreign=control("active-process",true);foreign["principalId"]=json!("other-client");
    assert!(owner.rpc("source.script.control",foreign,None).is_err());
    let first=owner.rpc("source.script.control",control("active-process",true),None).unwrap();
    assert_eq!(first["accepted"],true);
    let deadline=Instant::now()+Duration::from_secs(10);
    let terminal=loop {
        let receipt=owner.rpc("source.script.control",control("active-process",false),None).unwrap();
        if receipt["executorStopped"]==true {break receipt;}
        assert!(Instant::now()<deadline,"original evaluator stop did not confirm: {receipt}");
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(terminal["process"]["treeConfirmed"],true);
    assert_eq!(terminal["process"]["writerActive"],false);
    assert!(owner.rpc("file.root.register",json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":work}),Some("unrelated-grant")).is_ok());
    drop(owner);
    let reopened=Owner::new(root.join("storage"),"script-host","new-generation","new-epoch");
    let recalled=reopened.rpc("source.script.control",control("active-process",true),None).unwrap();
    assert_eq!(recalled["process"]["kernelEpoch"],"script-epoch");
    assert_eq!(recalled["executorStopped"],true);
    assert_eq!(recalled["process"]["processId"],"active-process");
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn original_mcp_holders_seal_scope_retirement_fence_replay_and_survive_reopen() {
    let root = std::env::temp_dir().join(format!("varin-mcp-owner-{}", uuid::Uuid::new_v4()));
    let work = root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let owner = Owner::new(root.join("storage"), "mcp-host", "mcp-generation", "mcp-epoch");
    let (ordinary, source) = owner.bind_live(&work, "ordinary-run-grant", 1);
    let open_mcp = |grant: &str| {
        owner.rpc("authority.grant.issue", json!({"grantId":grant,"hostGeneration":owner.generation,
            "storageIdentity":owner.root,"sessionId":null,"owningWorkspace":"workspace","executionWorkspace":"workspace",
            "threadId":"thread","runId":"run","capabilities":["storage.read","storage.write","process"],"pathScopes":[""]}), None).unwrap();
        let physical = owner.rpc("file.root.register", json!({"workspaceId":"workspace",
            "executionWorkspaceId":"workspace","canonicalRoot":work}), Some(grant)).unwrap();
        let open = json!({"principalId":"client","coordinatorHostId":"coordinator",
            "scope":{"kind":"run","threadId":"thread","runId":"run","epoch":1},
            "source":source,"grantId":grant,"enabledTools":[],"purpose":"mcp_owner"});
        let mut invalid = open.clone();
        invalid["enabledTools"] = json!(["file_read"]);
        assert!(owner.rpc("source.authority.open", invalid, None).is_err());
        let mut invalid = open.clone();
        invalid["operationId"] = json!("must-not-rewrite-grant-owner");
        assert!(owner.rpc("source.authority.open", invalid, None).is_err());
        let mut invalid = open.clone();
        invalid["scope"]["epoch"] = json!(2);
        assert!(owner.rpc("source.authority.open", invalid, None).is_err());
        let opened = owner.rpc("source.authority.open", open, None).unwrap();
        assert_eq!(opened["mcpHolders"], json!([]));
        assert!(opened["operationId"].is_null());
        assert_eq!(opened["firstPreparation"], false);
        let address = json!({"principalId":"client","coordinatorHostId":"coordinator",
            "authorityId":opened["authorityId"],"resourceEpoch":opened["resourceEpoch"]});
        let mut bind = address.clone();
        bind["physicalRoot"] = source["live_root"].clone();
        bind["toolBinding"] = json!({"resourceOwner":source["resource_owner"],"grantId":grant,
            "runId":"run","threadId":"thread","workspaceId":"workspace","executionWorkspaceId":"workspace",
            "rootId":physical["rootId"],"sourceMode":"live_root","liveRoot":source["live_root"],"enabledTools":[]});
        owner.rpc("source.authority.bind", bind.clone(), None).unwrap();
        (address, bind)
    };
    let (address, bind) = open_mcp("original-mcp-grant");
    let (revocable, _) = open_mcp("revocable-mcp-grant");
    let (directly_revoked, _) = open_mcp("directly-revoked-mcp-grant");
    let grant = |id: &str| -> Value {
        let conn = rusqlite::Connection::open_with_flags(root.join("storage/catalog.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let body: String = conn.query_row("SELECT grant_json FROM grants WHERE grant_id=?1", [id], |row| row.get(0)).unwrap();
        serde_json::from_str(&body).unwrap()
    };
    let gc = |owner: &Owner, id: &str| {
        owner.rpc("authority.grant.issue", json!({"grantId":id,"hostGeneration":owner.generation,
            "storageIdentity":owner.root,"sessionId":null,"owningWorkspace":"workspace","executionWorkspace":"workspace",
            "threadId":"thread","runId":"run","operationId":id,
            "capabilities":["storage.maintenance","storage.gc"],"pathScopes":[""]}), None).unwrap();
        owner.rpc("storage.gc", json!({"operationId":id}), Some(id)).unwrap()
    };
    let initial_grant = grant("original-mcp-grant");
    let binding = |id: &str, purpose: &str| json!({"operationId":id,
        "executionOwner":{"kind":"external","identity":"original-mcp-owner","epoch":"original-mcp-owner-epoch"},
        "purpose":purpose,"endpoint":{"server":"original-server","resourceKey":"original-resource",
            "configurationVersion":"original-config","credentialVersion":"original-credentials"}});
    let holder = |address: &Value, binding: &Value, action: &str| {
        let mut params = address.clone();
        params["binding"] = binding.clone();
        params["action"] = json!(action);
        params
    };
    let receipt = |address: &Value, binding: &Value, action: &str, outcome: Option<&Value>| {
        let mut params = holder(address, binding, action);
        if action != "inspect" { params["requestHash"] = json!("original-request-hash"); }
        if let Some(outcome) = outcome { params["outcome"] = outcome.clone(); }
        params
    };
    let accepted = json!({"kind":"accepted","response":{"task":{"taskId":"receiver-created-task",
        "status":"working","createdAt":"2026-10-13T00:00:00Z","lastUpdatedAt":"2026-10-13T00:00:00Z",
        "ttl":60000,"pollInterval":5},"result":{"task":{"taskId":"receiver-created-task"},
            "_meta":{"original":"creation-response","body":"accepted metadata ".repeat(4096)}}}});
    let failed = json!({"kind":"failed","error":{"code":"mcp_protocol_error","dispatched":true,
        "settlement":"rpc_response","taskKind":"protocol","rpcCode":-32602,
        "protocolError":{"code":-32602,"message":"original rejection","data":{"detail":[1,true],"body":"failed protocol data ".repeat(2048)}},
        "interactionProblem":"original-interaction"}});
    let task = binding("original-task", "task");
    let observer = binding("original-observer", "resource_observer");
    owner.rpc("source.mcp.holder", holder(&directly_revoked, &observer, "retain"), None).unwrap();
    owner.rpc("authority.grant.revoke", json!({"grantId":"directly-revoked-mcp-grant"}), None).unwrap();
    let revoked_projection = owner.rpc("source.mcp.holder", holder(&directly_revoked, &observer, "inspect"), None).unwrap();
    assert_eq!(revoked_projection["grantState"], "revoked", "direct grant revocation remains visible outside Source authority release");
    assert_eq!(owner.rpc("source.mcp.holder", holder(&directly_revoked, &observer, "release"), None).unwrap()["holder"]["released"], true);

    assert!(owner.rpc("source.mcp.holder", holder(&ordinary, &task, "retain"), None).is_err());
    assert!(owner.rpc("source.mcp.holder", holder(&address, &task, "inspect"), None).is_err());
    for malformed in [json!({"kind":"kernel"}), json!({"kind":"external","identity":"","epoch":"epoch"})] {
        let mut invalid = task.clone();
        invalid["executionOwner"] = malformed;
        assert!(owner.rpc("source.mcp.holder", holder(&address, &invalid, "retain"), None).is_err());
    }
    let unstarted = binding("unstarted-recovery", "task");
    let fenced = owner.rpc("source.mcp.holder", holder(&address, &unstarted, "release_unstarted"), None).unwrap();
    assert_eq!(fenced["holder"]["released"], true);
    assert_eq!(fenced["holder"]["creationReceipt"], Value::Null);
    assert!(owner.rpc("source.mcp.creation_receipt", receipt(&address, &unstarted, "begin", None), None).is_err());
    let unstarted_observer = binding("unstarted-observer", "resource_observer");
    assert_eq!(owner.rpc("source.mcp.holder", holder(&address, &unstarted_observer, "release_unstarted"), None).unwrap()["holder"]["released"], true);
    assert!(owner.rpc("source.mcp.creation_receipt", receipt(&address, &unstarted_observer, "begin", None), None).is_err());
    let cancelled = binding("cancelled-before-retain", "task");
    let closed = owner.rpc("source.mcp.holder", holder(&address, &cancelled, "release"), None).unwrap();
    assert_eq!(closed["holder"]["released"], true);
    assert_eq!(owner.rpc("source.mcp.holder", holder(&address, &cancelled, "retain"), None).unwrap(), closed);
    assert!(owner.rpc("source.mcp.creation_receipt", receipt(&address, &cancelled, "begin", None), None).is_err(),
        "a released tombstone must never readmit an unbegun task");
    assert!(owner.rpc("source.mcp.creation_receipt", receipt(&address, &task, "settle", Some(&accepted)), None).is_err());
    assert!(owner.rpc("source.mcp.holder", holder(&address, &task, "inspect"), None).is_err(),
        "settlement must not allocate a missing holder");
    let retained = owner.rpc("source.mcp.holder", holder(&address, &task, "retain"), None).unwrap();
    assert_eq!(retained["holder"]["binding"], task);
    assert_eq!(retained["holder"]["released"], false);
    assert_eq!(retained["holder"]["creationReceipt"], Value::Null);
    assert_eq!(owner.rpc("source.mcp.creation_receipt", receipt(&address, &task, "inspect", None), None).unwrap()["holder"], retained["holder"]);
    assert!(owner.rpc("source.mcp.creation_receipt", receipt(&address, &task, "settle", Some(&accepted)), None).is_err(),
        "settlement must not manufacture the original dispatch intent");
    let retained = owner.rpc("source.mcp.creation_receipt", receipt(&address, &task, "begin", None), None).unwrap();
    assert_eq!(retained["dispatch"], true);
    assert_eq!(retained["holder"]["creationReceipt"], json!({"requestHash":"original-request-hash","outcomeRef":null}));
    let replay = owner.rpc("source.mcp.creation_receipt", receipt(&address, &task, "begin", None), None).unwrap();
    assert_eq!(replay["dispatch"], false, "a lost begin reply never permits replay");
    assert_eq!(replay["holder"], retained["holder"]);
    assert_eq!(owner.rpc("source.mcp.holder", holder(&address, &task, "release_unstarted"), None).unwrap()["holder"]["released"], false,
        "an original begun creation cannot be retired by the pre-dispatch recovery fence");
    let mut missing_required = retained["holder"].clone();
    missing_required.as_object_mut().unwrap().remove("creationReceipt");
    assert!(serde_json::from_value::<crate::source_resources::SourceMcpHolder>(missing_required).is_err());
    let mut missing_required = retained["holder"].clone();
    missing_required["creationReceipt"].as_object_mut().unwrap().remove("outcomeRef");
    assert!(serde_json::from_value::<crate::source_resources::SourceMcpHolder>(missing_required).is_err());
    for action in ["begin", "inspect", "settle"] {
        let mut changed = receipt(&address, &task, action, if action == "settle" { Some(&accepted) } else { None });
        changed["requestHash"] = json!("different-request");
        assert!(owner.rpc("source.mcp.creation_receipt", changed, None).is_err());
    }
    for bad in [json!({"kind":"accepted","response":{"task":accepted["response"]["task"],"result":[]}}),
        json!({"kind":"failed","error":{"code":"failed","dispatched":true,"settlement":"stopped"}}),
        json!({"kind":"failed","error":{"code":"failed","dispatched":true,"settlement":"unknown","taskKind":"expired"}}),
        json!({"kind":"failed","error":{"code":"failed","dispatched":true,"settlement":"unknown","protocolError":[]}})] {
        assert!(owner.rpc("source.mcp.creation_receipt", receipt(&address, &task, "settle", Some(&bad)), None).is_err());
    }
    assert!(owner.rpc("source.mcp.creation_receipt", receipt(&ordinary, &task, "begin", None), None).is_err());
    let subscribed = json!({"kind":"subscribed","listenerId":"original-listener",
        "acknowledgement":{"_meta":{"body":"original subscribe acknowledgement ".repeat(4096)}}});
    let observer_receipt = owner.rpc("source.mcp.creation_receipt", receipt(&address, &observer, "begin", None), None).unwrap();
    assert_eq!(observer_receipt["dispatch"], true);
    assert_eq!(owner.rpc("source.mcp.creation_receipt", receipt(&address, &observer, "begin", None), None).unwrap()["dispatch"], false);
    assert_eq!(owner.rpc("source.mcp.holder", holder(&address, &observer, "release_unstarted"), None).unwrap()["holder"]["released"], false);
    assert!(owner.rpc("source.mcp.creation_receipt", receipt(&address, &task, "settle", Some(&subscribed)), None).is_err());
    for bad in [accepted.clone(), json!({"kind":"subscribed","listenerId":"","acknowledgement":{}}),
        json!({"kind":"subscribed","listenerId":"listener","acknowledgement":[]})] {
        assert!(owner.rpc("source.mcp.creation_receipt", receipt(&address, &observer, "settle", Some(&bad)), None).is_err());
    }
    let revocable_receipt = owner.rpc("source.mcp.creation_receipt", receipt(&revocable, &task, "begin", None), None).unwrap();
    assert_eq!(revocable_receipt["dispatch"], true, "one save acquires the original holder and creation intent");
    assert_eq!(revocable_receipt["holder"]["released"], false);
    let unbegun = binding("retained-without-creation", "task");
    owner.rpc("source.mcp.holder", holder(&revocable, &unbegun, "retain"), None).unwrap();
    let mut validate = address.clone();
    validate["requestId"] = json!("validate-original-mcp");
    validate["clientCapabilities"] = json!(["filesystem:read"]);
    validate["operation"] = json!({"kind":"validate"});
    assert!(owner.rpc("source.service.call", validate.clone(), None).is_ok());
    assert!(owner.tool(&address, "file_read", "forbidden-mcp-tool", json!({"path":"note.txt"})).is_err());
    for field in ["principalId", "coordinatorHostId", "resourceEpoch"] {
        let mut foreign = holder(&address, &task, "release");
        foreign[field] = json!("foreign");
        assert!(owner.rpc("source.mcp.holder", foreign, None).is_err());
        for action in ["begin", "inspect", "settle"] {
            let mut foreign = receipt(&address, &task, action, if action == "settle" { Some(&accepted) } else { None });
            foreign[field] = json!("foreign");
            assert!(owner.rpc("source.mcp.creation_receipt", foreign, None).is_err());
        }
    }
    for path in [vec!["purpose"], vec!["executionOwner", "identity"], vec!["executionOwner", "epoch"],
        vec!["endpoint", "server"], vec!["endpoint", "resourceKey"], vec!["endpoint", "configurationVersion"], vec!["endpoint", "credentialVersion"]] {
        let mut changed = task.clone();
        if path.len() == 1 { changed[path[0]] = json!("resource_observer"); }
        else { changed[path[0]][path[1]] = json!("changed"); }
        for action in ["retain", "inspect", "release"] {
            assert!(owner.rpc("source.mcp.holder", holder(&address, &changed, action), None).is_err());
        }
        for action in ["begin", "inspect", "settle"] {
            assert!(owner.rpc("source.mcp.creation_receipt", receipt(&address, &changed, action,
                if action == "settle" { Some(&accepted) } else { None }), None).is_err());
        }
    }
    // Staging does not publish an object or reserve another Task ledger. A
    // concurrent exact release must fence even a first settlement's publication.
    let racing = binding("creation-settlement-release-race", "task");
    owner.rpc("source.mcp.creation_receipt", receipt(&address, &racing, "begin", None), None).unwrap();
    let mut racing_outcome = accepted.clone();
    racing_outcome["response"]["task"]["taskId"] = json!("release-raced-task");
    let staging = source_resources::prepare_request(&mut owner.storage.lock().unwrap(),
        "source.mcp.creation_receipt", receipt(&address, &racing, "settle", Some(&racing_outcome)), owner.epoch,
        owner.host, owner.generation).unwrap();
    let staged = staging.execute(owner.resources.clone(), CancellationToken::default()).unwrap();
    owner.rpc("source.mcp.holder", holder(&address, &racing, "release"), None).unwrap();
    gc(&owner, "mcp-receipt-gc-staged");
    let raced = staged.finish(&mut owner.storage.lock().unwrap()).unwrap();
    assert_eq!(raced["holder"]["released"], true);
    assert_eq!(raced["outcome"], Value::Null);
    let racing_path = crate::protocol::object_path(&owner.root,
        raced["holder"]["creationReceipt"]["outcomeRef"]["objectHash"].as_str().unwrap()).unwrap();
    assert!(!racing_path.exists(), "release overtaking settlement cannot publish a retained body");
    assert_eq!(owner.rpc("source.mcp.creation_receipt", receipt(&address, &racing, "settle", Some(&racing_outcome)), None).unwrap(), raced);
    assert!(owner.rpc("source.mcp.creation_receipt", receipt(&address, &racing, "settle", Some(&accepted)), None).is_err());
    let sealed = owner.rpc("source.authority.seal", address.clone(), None).unwrap();
    assert_eq!(sealed["phase"], "retaining");
    assert_eq!(sealed["grantId"], "original-mcp-grant");
    assert!(sealed["operationId"].is_null());
    assert_eq!(grant("original-mcp-grant"), initial_grant, "holder/seal never rewrites original grant ownership");
    assert!(owner.rpc("source.authority.bind", bind, None).is_err());
    assert!(owner.rpc("source.service.call", validate, None).is_err());
    assert!(owner.rpc("source.mcp.holder", holder(&address, &binding("late-holder", "task"), "retain"), None).is_err());
    assert!(owner.rpc("source.mcp.creation_receipt", receipt(&address, &binding("late-holder", "task"), "begin", None), None).is_err());
    assert!(owner.rpc("source.mcp.creation_receipt", receipt(&revocable, &unbegun, "begin", None), None).is_err(),
        "a retained holder without a creation intent cannot bypass the sealed scope");
    assert_eq!(owner.rpc("source.mcp.creation_receipt", receipt(&address, &task, "begin", None), None).unwrap()["dispatch"], false);
    assert_eq!(owner.rpc("source.mcp.holder", holder(&address, &task, "retain"), None).unwrap()["holder"], retained["holder"]);
    let scope = json!({"principalId":"client","coordinatorHostId":"coordinator","threadId":"thread","runId":"run","mode":"retire"});
    let retired_scope = owner.rpc("source.authority.release_scope", scope, None).unwrap();
    assert_eq!(retired_scope["pendingAuthorities"], json!([]));
    let retained_owner = retired_scope["released"].as_array().unwrap().iter()
        .find(|value| value["authorityId"] == address["authorityId"]).unwrap();
    assert_eq!(retained_owner["phase"], "retaining");
    assert_eq!(retained_owner["grantIds"], json!([]));
    assert_eq!(retained_owner["receipt"]["retainedMcpHolders"].as_array().unwrap().len(), 2);
    assert_eq!(grant("original-mcp-grant"), initial_grant);
    assert_eq!(grant("ordinary-run-grant")["state"], "retired");
    let mut revoke = revocable.clone();
    revoke["mode"] = json!("revoke");
    assert_eq!(owner.rpc("source.authority.release", revoke, None).unwrap()["phase"], "revoked");
    assert_eq!(grant("revocable-mcp-grant")["state"], "revoked");
    assert!(owner.rpc("source.mcp.creation_receipt", receipt(&revocable, &unbegun, "begin", None), None).is_err());
    assert_eq!(owner.rpc("source.mcp.creation_receipt", receipt(&revocable, &task, "begin", None), None).unwrap()["dispatch"], false);
    let rejected = owner.rpc("source.mcp.creation_receipt", receipt(&revocable, &task, "settle", Some(&failed)), None).unwrap();
    assert_eq!(rejected["dispatch"], false);
    assert_eq!(rejected["outcome"], failed, "late original failure settles after grant revocation");
    assert_eq!(owner.rpc("source.mcp.creation_receipt", receipt(&revocable, &task, "settle", Some(&failed)), None).unwrap(), rejected);
    assert!(owner.rpc("source.mcp.creation_receipt", receipt(&revocable, &task, "settle", Some(&accepted)), None).is_err());
    assert!(owner.rpc("source.mcp.holder", holder(&revocable, &task, "retain"), None).is_err());
    assert_eq!(owner.rpc("source.mcp.holder", holder(&revocable, &task, "inspect"), None).unwrap()["holder"]["released"], false);
    let rejected_ref = rejected["holder"]["creationReceipt"]["outcomeRef"].clone();
    let rejected_path = crate::protocol::object_path(&owner.root, rejected_ref["objectHash"].as_str().unwrap()).unwrap();
    gc(&owner, "mcp-receipt-gc-revoked");
    assert!(rejected_path.exists(), "an unreleased holder retains its body after Source revocation");
    let mut retire_revoked = revocable.clone();
    retire_revoked["mode"] = json!("retire");
    assert_eq!(owner.rpc("source.authority.release", retire_revoked, None).unwrap()["phase"], "revoked");
    drop(owner);
    let reopened = Owner::new(root.join("storage"), "mcp-host", "new-generation", "new-epoch");
    let recalled = reopened.rpc("source.mcp.holder", holder(&address, &task, "inspect"), None).unwrap();
    assert_eq!(recalled["authority"]["resourceEpoch"], "mcp-epoch");
    assert_eq!(recalled["grantState"], "active", "old epoch inspection does not reacquire or reject the original active grant");
    assert_eq!(recalled["authority"]["grantId"], "original-mcp-grant");
    assert_eq!(recalled["holder"], retained["holder"]);
    let unknown = reopened.rpc("source.mcp.creation_receipt", receipt(&address, &task, "inspect", None), None).unwrap();
    assert_eq!(unknown["holder"], retained["holder"]);
    assert_eq!(reopened.rpc("source.mcp.creation_receipt", receipt(&address, &task, "begin", None), None).unwrap()["dispatch"], false,
        "reopening an unknown creation never dispatches again");
    let settled = reopened.rpc("source.mcp.creation_receipt", receipt(&address, &task, "settle", Some(&accepted)), None).unwrap();
    assert_eq!(settled["dispatch"], false);
    assert_eq!(settled["outcome"], accepted);
    assert_eq!(reopened.rpc("source.mcp.creation_receipt", receipt(&address, &task, "settle", Some(&accepted)), None).unwrap(), settled,
        "a lost settlement reply recalls exactly the original response");
    let mut newer_task_status = accepted.clone();
    newer_task_status["response"]["task"]["status"] = json!("completed");
    assert!(reopened.rpc("source.mcp.creation_receipt", receipt(&address, &task, "settle", Some(&newer_task_status)), None).is_err(),
        "subsequent Task status cannot rewrite the creation receipt");
    assert_eq!(reopened.rpc("source.mcp.creation_receipt", receipt(&revocable, &task, "inspect", None), None).unwrap()["outcome"], failed);
    let subscribed_settled = reopened.rpc("source.mcp.creation_receipt", receipt(&address, &observer, "settle", Some(&subscribed)), None).unwrap();
    assert_eq!(subscribed_settled["outcome"], subscribed, "the original observer settles across owner restart and Source retirement");
    assert_eq!(reopened.rpc("source.mcp.creation_receipt", receipt(&address, &observer, "inspect", None), None).unwrap(), subscribed_settled);
    let subscribed_ref = subscribed_settled["holder"]["creationReceipt"]["outcomeRef"].clone();
    let subscribed_path = crate::protocol::object_path(&reopened.root, subscribed_ref["objectHash"].as_str().unwrap()).unwrap();
    assert_eq!(std::fs::read(&subscribed_path).unwrap(), serde_json::to_vec(&subscribed).unwrap());
    let accepted_ref = settled["holder"]["creationReceipt"]["outcomeRef"].clone();
    let accepted_path = crate::protocol::object_path(&reopened.root, accepted_ref["objectHash"].as_str().unwrap()).unwrap();
    let accepted_bytes = serde_json::to_vec(&accepted).unwrap();
    assert_eq!(accepted_ref["byteLength"], accepted_bytes.len() as u64);
    assert_eq!(std::fs::read(&accepted_path).unwrap(), accepted_bytes);
    gc(&reopened, "mcp-receipt-gc-reopened");
    assert!(accepted_path.exists());
    assert!(rejected_path.exists(), "reopening preserves the original revoked holder's GC root");
    for control in [reopened.rpc("source.mcp.holder", holder(&address, &task, "inspect"), None).unwrap(),
        reopened.rpc("source.authority.inspect", address.clone(), None).unwrap()] {
        assert!(serde_json::to_vec(&control).unwrap().len() < accepted_bytes.len() / 4,
            "holder/authority control projections contain metadata, not repeated MCP bodies");
        assert!(!control.to_string().contains("accepted metadata"));
        assert!(!control.to_string().contains("failed protocol data"));
    }
    assert_eq!(reopened.rpc("source.mcp.holder", holder(&revocable, &task, "release"), None).unwrap()["authority"]["phase"], "revoked");
    let revoked_released = reopened.rpc("source.mcp.creation_receipt", receipt(&revocable, &task, "inspect", None), None).unwrap();
    assert_eq!(revoked_released["holder"]["creationReceipt"]["outcomeRef"], rejected_ref);
    assert_eq!(revoked_released["outcome"], Value::Null);
    // Admission retains the exact hash while a body worker is still pending.
    let reader = source_resources::prepare_request(&mut reopened.storage.lock().unwrap(),
        "source.mcp.creation_receipt", receipt(&address, &task, "inspect", None), reopened.epoch,
        reopened.host, reopened.generation).unwrap();
    assert_eq!(grant("original-mcp-grant"), initial_grant, "reopening does not recreate or reissue the original owner");
    assert!(reopened.rpc("source.mcp.holder", holder(&address, &task, "retain"), None).is_err());
    let first = reopened.rpc("source.mcp.holder", holder(&address, &task, "release"), None).unwrap();
    assert_eq!(first["authority"]["phase"], "retaining");
    gc(&reopened, "mcp-receipt-gc-reading");
    assert!(accepted_path.exists(), "the existing transient reader root protects a concurrently released body");
    assert!(!rejected_path.exists(), "exact holder release makes its body collectible");
    let read = reader.execute(reopened.resources.clone(), CancellationToken::default()).unwrap()
        .finish(&mut reopened.storage.lock().unwrap()).unwrap();
    assert_eq!(read["outcome"], accepted);
    gc(&reopened, "mcp-receipt-gc-released");
    assert!(!accepted_path.exists(), "body is reclaimed after both holder release and reader completion");
    for action in ["inspect", "begin", "settle"] {
        let recalled = reopened.rpc("source.mcp.creation_receipt", receipt(&address, &task, action,
            if action == "settle" { Some(&accepted) } else { None }), None).unwrap();
        assert_eq!(recalled["dispatch"], false);
        assert_eq!(recalled["holder"]["released"], true);
        assert_eq!(recalled["holder"]["creationReceipt"]["outcomeRef"], accepted_ref);
        assert_eq!(recalled["outcome"], Value::Null);
        assert!(!accepted_path.exists(), "late exact settle cannot resurrect a released body");
    }
    assert!(reopened.rpc("source.mcp.creation_receipt", receipt(&address, &task, "settle", Some(&newer_task_status)), None).is_err());

    let drained = reopened.rpc("source.mcp.holder", holder(&address, &observer, "release"), None).unwrap();
    assert_eq!(drained["authority"]["phase"], "draining");
    gc(&reopened, "mcp-observer-receipt-gc-released");
    assert!(!subscribed_path.exists());
    for action in ["inspect", "begin", "settle"] {
        let recalled = reopened.rpc("source.mcp.creation_receipt", receipt(&address, &observer, action,
            if action == "settle" { Some(&subscribed) } else { None }), None).unwrap();
        assert_eq!(recalled["dispatch"], false);
        assert_eq!(recalled["outcome"], Value::Null);
        assert_eq!(recalled["holder"]["creationReceipt"]["outcomeRef"], subscribed_ref);
    }
    let mut changed_subscribed = subscribed.clone();
    changed_subscribed["listenerId"] = json!("replacement-listener");
    assert!(reopened.rpc("source.mcp.creation_receipt", receipt(&address, &observer, "settle", Some(&changed_subscribed)), None).is_err());
    assert_eq!(grant("original-mcp-grant"), initial_grant, "last release cannot claim actual daemon drainage or retire its grant");
    assert_eq!(reopened.rpc("source.mcp.holder", holder(&address, &observer, "retain"), None).unwrap()["holder"]["released"], true);
    let mut retire = address.clone();
    retire["mode"] = json!("retire");
    let done = reopened.rpc("source.authority.release", retire, None).unwrap();
    assert_eq!(done["phase"], "retired");
    assert_eq!(done["grantIds"], json!(["original-mcp-grant"]));
    assert_eq!(grant("original-mcp-grant")["state"], "retired");
    assert_eq!(reopened.rpc("source.mcp.holder", holder(&address, &observer, "inspect"), None).unwrap()["grantState"], "retired");
    assert_eq!(reopened.rpc("source.mcp.creation_receipt", receipt(&address, &task, "begin", None), None).unwrap()["dispatch"], false);
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn original_mcp_scope_closure_fences_late_grants_and_preserves_newer_run_epochs() {
    let root = std::env::temp_dir().join(format!("varin-mcp-scope-fence-{}", uuid::Uuid::new_v4()));
    let work = root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let owner = Owner::new(root.join("storage"), "mcp-host", "mcp-generation", "mcp-epoch");
    let (_, source) = owner.bind_live(&work, "ordinary-epoch-one", 1);
    let open = |grant: &str, epoch: u64, purpose: &str| -> Result<(Value, Value), KernelError> {
        owner.rpc("authority.grant.issue", json!({"grantId":grant,"hostGeneration":owner.generation,
            "storageIdentity":owner.root,"sessionId":null,"owningWorkspace":"workspace","executionWorkspace":"workspace",
            "threadId":"thread","runId":"run","capabilities":["storage.read","storage.write","process"],"pathScopes":[""]}), None)?;
        let physical = owner.rpc("file.root.register", json!({"workspaceId":"workspace",
            "executionWorkspaceId":"workspace","canonicalRoot":work}), Some(grant))?;
        let opened = owner.rpc("source.authority.open", json!({"principalId":"client","coordinatorHostId":"coordinator",
            "scope":{"kind":"run","threadId":"thread","runId":"run","epoch":epoch},
            "source":source,"grantId":grant,"enabledTools":[],"purpose":purpose}), None)?;
        let address = json!({"principalId":"client","coordinatorHostId":"coordinator",
            "authorityId":opened["authorityId"],"resourceEpoch":opened["resourceEpoch"]});
        let mut bind = address.clone();
        bind["physicalRoot"] = source["live_root"].clone();
        bind["toolBinding"] = json!({"resourceOwner":source["resource_owner"],"grantId":grant,
            "runId":"run","threadId":"thread","workspaceId":"workspace","executionWorkspaceId":"workspace",
            "rootId":physical["rootId"],"sourceMode":"live_root","liveRoot":source["live_root"],"enabledTools":[]});
        Ok((address, bind))
    };
    let scope = json!({"principalId":"client","coordinatorHostId":"coordinator","threadId":"thread","runId":"run","mode":"retire"});
    let empty_mcp_scope = owner.rpc("source.authority.release_scope", scope.clone(), None).unwrap();
    assert_eq!(empty_mcp_scope["released"].as_array().unwrap().len(), 1);
    assert!(open("late-first-mcp-grant", 1, "mcp_owner").is_err(), "scope retirement must fence a late owner even before any MCP authority existed");
    owner.bind_live(&work, "ordinary-epoch-two", 2);
    let (original, bind) = open("original-epoch-two-mcp", 2, "mcp_owner").unwrap();
    owner.rpc("source.authority.bind", bind, None).unwrap();
    let (_, pending_bind) = open("pending-epoch-two-mcp", 2, "mcp_owner").unwrap();
    let mut holder = original.clone();
    holder["binding"] = json!({"operationId":"held-original-task",
        "executionOwner":{"kind":"external","identity":"original-owner","epoch":"original-owner-epoch"},
        "purpose":"task","endpoint":{"server":"server","resourceKey":"original-key",
            "configurationVersion":"config","credentialVersion":"credentials"}});
    holder["action"] = json!("retain");
    let retained = owner.rpc("source.mcp.holder", holder.clone(), None).unwrap();
    assert_eq!(owner.rpc("source.authority.seal", original.clone(), None).unwrap()["phase"], "retaining");
    assert!(owner.rpc("source.authority.bind", pending_bind, None).is_err(), "seal also fences a sibling owner admitted before it could bind");
    assert!(open("late-after-seal-mcp", 2, "mcp_owner").is_err());
    for purpose in ["result", "process_view"] {
        let (_, bind) = open(&format!("ordinary-{purpose}"), 2, purpose).unwrap();
        assert!(owner.rpc("source.authority.bind", bind, None).is_ok(), "MCP closure must not fence unrelated Source purposes");
    }
    owner.bind_live(&work, "ordinary-epoch-three", 3);
    let (_, bind) = open("fresh-epoch-three-mcp", 3, "mcp_owner").unwrap();
    owner.rpc("source.authority.bind", bind, None).unwrap();
    owner.rpc("source.authority.seal", original, None).unwrap();
    assert!(open("fresh-after-old-owner-seal", 3, "mcp_owner").is_ok(), "sealing an old owner must not fence a newer coordinator epoch");
    assert_eq!(owner.rpc("source.mcp.holder", holder, None).unwrap()["holder"], retained["holder"], "old holders keep the frozen original authority");
    let retired = owner.rpc("source.authority.release_scope", scope, None).unwrap();
    assert_eq!(retired["pendingAuthorities"], json!([]));
    assert!(open("late-after-snapshot-mcp", 3, "mcp_owner").is_err(), "new grant identity cannot bypass the scope fence");
    drop(owner);
    let reopened = Owner::new(root.join("storage"), "mcp-host", "mcp-generation", "mcp-epoch");
    let late = json!({"principalId":"client","coordinatorHostId":"coordinator",
        "scope":{"kind":"run","threadId":"thread","runId":"run","epoch":3},"source":source,
        "grantId":"late-after-snapshot-mcp","enabledTools":[],"purpose":"mcp_owner"});
    assert!(reopened.rpc("source.authority.open", late, None).is_err(), "scope admission closure must survive reopening");
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn original_mcp_delivery_receipts_fence_send_ack_release_and_survive_source_retirement() {
    let root = std::env::temp_dir().join(format!("varin-mcp-delivery-{}", uuid::Uuid::new_v4()));
    let work = root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let owner = Owner::new(root.join("storage"), "delivery-host", "delivery-generation", "delivery-epoch");
    let (ordinary, source) = owner.bind_live(&work, "ordinary-delivery-grant", 1);
    let open_mcp = |grant: &str| {
        owner.rpc("authority.grant.issue", json!({"grantId":grant,"hostGeneration":owner.generation,
            "storageIdentity":owner.root,"sessionId":null,"owningWorkspace":"workspace","executionWorkspace":"workspace",
            "threadId":"thread","runId":"run","capabilities":["storage.read","storage.write","process"],"pathScopes":[""]}), None).unwrap();
        let physical = owner.rpc("file.root.register", json!({"workspaceId":"workspace",
            "executionWorkspaceId":"workspace","canonicalRoot":work}), Some(grant)).unwrap();
        let opened = owner.rpc("source.authority.open", json!({"principalId":"client","coordinatorHostId":"coordinator",
            "scope":{"kind":"run","threadId":"thread","runId":"run","epoch":1},
            "source":source,"grantId":grant,"enabledTools":[],"purpose":"mcp_owner"}), None).unwrap();
        assert_eq!(opened["mcpDeliveries"], json!([]));
        let address = json!({"principalId":"client","coordinatorHostId":"coordinator",
            "authorityId":opened["authorityId"],"resourceEpoch":opened["resourceEpoch"]});
        let mut bind = address.clone();
        bind["physicalRoot"] = source["live_root"].clone();
        bind["toolBinding"] = json!({"resourceOwner":source["resource_owner"],"grantId":grant,
            "runId":"run","threadId":"thread","workspaceId":"workspace","executionWorkspaceId":"workspace",
            "rootId":physical["rootId"],"sourceMode":"live_root","liveRoot":source["live_root"],"enabledTools":[]});
        owner.rpc("source.authority.bind", bind, None).unwrap();
        address
    };
    let address = open_mcp("delivery-grant");
    let revoked = open_mcp("revoked-delivery-grant");
    let task_source = open_mcp("task-delivery-grant");
    let cleanup_source = open_mcp("cleanup-delivery-grant");
    let binding = json!({"operationId":"original-operation",
        "executionOwner":{"kind":"external","identity":"original-mcp-owner","epoch":"original-mcp-generation"},
        "endpoint":{"server":"server","resourceKey":"resource","configurationVersion":"config","credentialVersion":"credentials"},
        "connectionId":"original-sdk-connection","source":{"kind":"server_request","requestId":"original-request",
            "relation":{"kind":"rpc_response_stream","outgoingRequestId":7}}});
    let params = |address: &Value, id: &str, action: &str, extra: Value| {
        let mut params = address.clone();
        params["binding"] = binding.clone();
        params["deliveryId"] = json!(id);
        params["action"] = json!(action);
        params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        params
    };
    let open = json!({"kind":"elicitation","requestHash":"a".repeat(64)});
    let begin = json!({"responseHash":"b".repeat(64)});
    let call = |owner: &Owner, address: &Value, id: &str, action: &str, extra: Value| {
        owner.rpc("source.mcp.delivery", params(address, id, action, extra), None)
    };
    assert!(call(&owner, &ordinary, "delivery", "open", open.clone()).is_err());
    for invalid in [json!({"kind":"elicitation","requestHash":"not-a-hash"}),
        json!({"kind":"error","requestHash":"a".repeat(64)}),
        json!({"kind":"elicitation","requestHash":"a".repeat(64),"request":{"secret":"no-body-store"}})] {
        assert!(call(&owner, &address, "delivery", "open", invalid).is_err());
    }
    call(&owner, &address, "independent", "open", open.clone()).unwrap();
    call(&owner, &address, "independent", "close", json!({"availability":"cancelled"})).unwrap();
    call(&owner, &address, "independent", "ack", json!({"revision":2})).unwrap();
    assert_eq!(call(&owner, &address, "independent", "release", json!({"revision":2})).unwrap()["phase"], "ready",
        "releasing one delivery never seals an active original Source");
    let opened = call(&owner, &address, "delivery", "open", open.clone()).unwrap();
    assert_eq!(opened["receipt"]["revision"], 1);
    assert_eq!(opened["dispatch"], false);
    assert_eq!(opened["created"], true);
    let mut duplicate = opened.clone();
    duplicate["created"] = json!(false);
    assert_eq!(call(&owner, &address, "delivery", "open", open.clone()).unwrap(), duplicate);
    assert_eq!(call(&owner, &address, "delivery", "inspect", json!({})).unwrap()["created"], false);
    assert!(call(&owner, &address, "delivery", "open", json!({"kind":"elicitation","requestHash":"c".repeat(64)})).is_err());
    assert!(call(&owner, &revoked, "delivery", "inspect", json!({})).is_err());
    for field in ["principalId", "coordinatorHostId", "resourceEpoch", "authorityId"] {
        let mut foreign = params(&address, "delivery", "inspect", json!({}));
        foreign[field] = json!("another-original");
        assert!(owner.rpc("source.mcp.delivery", foreign, None).is_err());
    }
    for field in ["operationId", "connectionId"] {
        let mut foreign = params(&address, "delivery", "inspect", json!({}));
        foreign["binding"][field] = json!("another-binding");
        assert!(owner.rpc("source.mcp.delivery", foreign, None).is_err());
    }
    for field in ["executionOwner", "endpoint", "source"] {
        let mut foreign = params(&address, "delivery", "inspect", json!({}));
        match field {
            "executionOwner" => foreign["binding"][field]["identity"] = json!("other-owner"),
            "endpoint" => foreign["binding"][field]["credentialVersion"] = json!("other-credential"),
            _ => foreign["binding"][field]["requestId"] = json!("other-request"),
        }
        assert!(owner.rpc("source.mcp.delivery", foreign, None).is_err());
    }
    assert!(call(&owner, &address, "delivery", "settle", json!({"delivery":"sent"})).is_err());
    let begun = call(&owner, &address, "delivery", "begin", begin.clone()).unwrap();
    assert_eq!(begun["dispatch"], true);
    assert_eq!(begun["created"], false);
    assert_eq!(begun["receipt"]["revision"], 2);
    assert_eq!(call(&owner, &address, "delivery", "begin", begin.clone()).unwrap()["dispatch"], false);
    assert!(call(&owner, &address, "delivery", "begin", json!({"responseHash":"c".repeat(64)})).is_err());
    call(&owner, &address, "delivery", "settle", json!({"delivery":"unknown"})).unwrap();
    let sent = call(&owner, &address, "delivery", "settle", json!({"delivery":"sent"})).unwrap();
    assert_eq!(sent["receipt"]["revision"], 4);
    assert_eq!(call(&owner, &address, "delivery", "settle", json!({"delivery":"unknown"})).unwrap(), sent);
    assert!(call(&owner, &address, "delivery", "settle", json!({"delivery":"not_sent"})).is_err());
    assert!(call(&owner, &address, "delivery", "ack", json!({"revision":5})).is_err());
    assert!(call(&owner, &address, "delivery", "release", json!({"revision":4})).is_err());
    call(&owner, &address, "delivery", "ack", json!({"revision":4})).unwrap();
    let closed = call(&owner, &address, "delivery", "close", json!({"availability":"rpc_closed"})).unwrap();
    assert_eq!(closed["receipt"]["revision"], 5);
    assert!(call(&owner, &address, "delivery", "release", json!({"revision":4})).is_err());
    assert!(call(&owner, &address, "delivery", "release", json!({"revision":5})).is_err());
    call(&owner, &address, "pending", "open", open.clone()).unwrap();
    call(&owner, &address, "lost-heap", "open", open.clone()).unwrap();
    call(&owner, &revoked, "delivery", "open", open.clone()).unwrap();
    call(&owner, &revoked, "pending", "open", open.clone()).unwrap();
    call(&owner, &revoked, "delivery", "begin", begin.clone()).unwrap();
    owner.rpc("authority.grant.revoke", json!({"grantId":"revoked-delivery-grant"}), None).unwrap();
    assert!(call(&owner, &revoked, "pending", "begin", begin.clone()).is_err());
    assert!(call(&owner, &revoked, "new", "open", open.clone()).is_err());
    assert_eq!(call(&owner, &revoked, "delivery", "begin", begin.clone()).unwrap()["dispatch"], false);
    let recalled = call(&owner, &revoked, "delivery", "settle", json!({"delivery":"sent"})).unwrap();
    assert_eq!(recalled["grantState"], "revoked");
    // The original retained Task may admit later callbacks; arbitrary new work
    // on a sealed Source still cannot acquire a delivery reference.
    let mut task = task_source.clone();
    task["binding"] = json!({"operationId":binding["operationId"],"executionOwner":binding["executionOwner"],
        "endpoint":binding["endpoint"],"purpose":"task"});
    task["action"] = json!("begin");
    task["requestHash"] = json!("original-task-request");
    owner.rpc("source.mcp.creation_receipt", task.clone(), None).unwrap();
    let mut observer = cleanup_source.clone();
    observer["binding"] = json!({"operationId":"original-observer-operation","executionOwner":binding["executionOwner"],
        "endpoint":binding["endpoint"],"purpose":"resource_observer"});
    observer["action"] = json!("begin");
    observer["requestHash"] = json!("original-observer-request");
    owner.rpc("source.mcp.creation_receipt", observer.clone(), None).unwrap();
    let retire = |owner: &Owner, address: &Value| {
        let mut release = address.clone(); release["mode"] = json!("retire");
        owner.rpc("source.authority.release", release, None).unwrap()
    };
    assert_eq!(retire(&owner, &task_source)["phase"], "retaining");
    call(&owner, &task_source, "task-callback", "open", open.clone()).unwrap();
    let mut task_release = task_source.clone();
    task_release["binding"] = task["binding"].clone();
    task_release["action"] = json!("release");
    assert_eq!(owner.rpc("source.mcp.holder", task_release, None).unwrap()["authority"]["phase"], "retaining");
    // An explicit unsubscribe is a new real control Operation. Only its
    // exact original observer proof can admit a callback after holder release.
    let mut seal = cleanup_source.clone();
    assert_eq!(owner.rpc("source.authority.seal", seal.clone(), None).unwrap()["phase"], "retaining");
    seal["binding"] = observer["binding"].clone();
    seal["action"] = json!("release");
    assert_eq!(owner.rpc("source.mcp.holder", seal, None).unwrap()["authority"]["phase"], "draining");
    assert!(call(&owner, &cleanup_source, "unsubscribe", "open", open.clone()).is_err());
    let mut cleanup_open = open.clone();
    cleanup_open["cleanupHolder"] = observer["binding"].clone();
    for field in ["operationId", "purpose", "endpoint"] {
        let mut forged = cleanup_open.clone();
        if field == "endpoint" { forged["cleanupHolder"][field]["credentialVersion"] = json!("replacement"); }
        else { forged["cleanupHolder"][field] = json!("replacement"); }
        assert!(call(&owner, &cleanup_source, "unsubscribe", "open", forged).is_err());
    }
    let cleanup = call(&owner, &cleanup_source, "unsubscribe", "open", cleanup_open.clone()).unwrap();
    assert_eq!(cleanup["phase"], "retaining");
    assert_eq!(cleanup["receipt"]["cleanupHolder"], observer["binding"]);
    assert_eq!(cleanup["receipt"]["binding"]["operationId"], "original-operation");
    assert_eq!(cleanup["created"], true);
    let mut duplicate_cleanup = cleanup.clone();
    duplicate_cleanup["created"] = json!(false);
    assert_eq!(call(&owner, &cleanup_source, "unsubscribe", "open", cleanup_open.clone()).unwrap(), duplicate_cleanup);
    assert!(call(&owner, &cleanup_source, "unsubscribe", "open", open.clone()).is_err());
    assert_eq!(call(&owner, &cleanup_source, "unsubscribe", "begin", begin.clone()).unwrap()["dispatch"], true);
    let cleanup = call(&owner, &cleanup_source, "unsubscribe", "settle", json!({"delivery":"sent"})).unwrap();
    call(&owner, &cleanup_source, "unsubscribe", "ack", json!({"revision":cleanup["receipt"]["revision"]})).unwrap();
    assert_eq!(call(&owner, &cleanup_source, "unsubscribe", "release", json!({"revision":cleanup["receipt"]["revision"]})).unwrap()["phase"], "draining");
    let mut explicit_revoke = task_source.clone();
    explicit_revoke["mode"] = json!("revoke");
    assert_eq!(owner.rpc("source.authority.release", explicit_revoke, None).unwrap()["phase"], "revoked");
    assert_eq!(call(&owner, &task_source, "task-callback", "complete", json!({})).unwrap()["grantState"], "revoked");
    let retaining = retire(&owner, &address);
    assert_eq!(retaining["phase"], "retaining");
    assert_eq!(retaining["receipt"]["retainedMcpDeliveries"].as_array().unwrap().len(), 3);
    assert!(call(&owner, &address, "new", "open", open.clone()).is_err());
    assert_eq!(call(&owner, &address, "pending", "begin", begin.clone()).unwrap()["dispatch"], true);
    // URL completion remains receivable after the finite parent RPC was closed.
    let completed = call(&owner, &address, "delivery", "complete", json!({})).unwrap();
    assert_eq!(completed["receipt"]["revision"], 6);
    assert_eq!(completed["receipt"]["completed"], true);
    call(&owner, &address, "delivery", "ack", json!({"revision":6})).unwrap();
    assert_eq!(call(&owner, &address, "delivery", "release", json!({"revision":6})).unwrap()["receipt"]["released"], true);
    drop(owner);
    let reopened = Owner::new(root.join("storage"), "delivery-host", "delivery-generation-next", "delivery-epoch-next");
    let stored = call(&reopened, &address, "delivery", "inspect", json!({})).unwrap();
    assert_eq!(stored["receipt"]["revision"], 6);
    assert_eq!(stored["receipt"]["delivery"], "sent");
    assert_eq!(stored["receipt"]["completed"], true);
    assert_eq!(stored["receipt"]["released"], true);
    assert!(call(&reopened, &address, "lost-heap", "begin", begin.clone()).is_err());
    assert!(call(&reopened, &cleanup_source, "new-unsubscribe", "open", cleanup_open).is_err(),
        "an original cleanup proof never bypasses the current resource epoch");
    assert!(call(&reopened, &address, "new", "open", open).is_err());
    assert_eq!(call(&reopened, &address, "pending", "begin", begin).unwrap()["dispatch"], false);
    call(&reopened, &address, "pending", "settle", json!({"delivery":"unknown"})).unwrap();
    let stopped = call(&reopened, &address, "pending", "settle", json!({"delivery":"not_sent"})).unwrap();
    assert_eq!(stopped["receipt"]["delivery"], "not_sent");
    assert!(call(&reopened, &address, "pending", "settle", json!({"delivery":"sent"})).is_err());
    for id in ["pending", "lost-heap"] {
        let closed = call(&reopened, &address, id, "close", json!({"availability":"owner_unavailable"})).unwrap();
        let revision = closed["receipt"]["revision"].clone();
        call(&reopened, &address, id, "ack", json!({"revision":revision})).unwrap();
        call(&reopened, &address, id, "release", json!({"revision":revision})).unwrap();
    }
    let authorities = reopened.rpc("source.authority.inspect_scope", json!({"principalId":"client", "coordinatorHostId":"coordinator",
        "threadId":"thread","runId":"run"}), None).unwrap();
    assert_eq!(authorities.as_array().unwrap().iter().find(|item| item["authorityId"] == address["authorityId"]).unwrap()["phase"], "draining");
    assert_eq!(retire(&reopened, &address)["phase"], "retired");
    assert_eq!(call(&reopened, &address, "delivery", "inspect", json!({})).unwrap()["grantState"], "retired");
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn original_mcp_child_definition_references_fence_release_and_retain_storage_bodies() {
    let root = std::env::temp_dir().join(format!("varin-mcp-child-{}", uuid::Uuid::new_v4()));
    let work = root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let owner = Owner::new(root.join("storage"), "child-host", "child-generation", "child-epoch");
    let (ordinary, source) = owner.bind_live(&work, "ordinary-child-grant", 1);
    let grant = "mcp-child-grant";
    owner.rpc("authority.grant.issue", json!({"grantId":grant,"hostGeneration":owner.generation,
        "storageIdentity":owner.root,"sessionId":null,"owningWorkspace":"workspace","executionWorkspace":"workspace",
        "threadId":"thread","runId":"run","capabilities":["storage.read","storage.write","process"],"pathScopes":[""]}), None).unwrap();
    let physical = owner.rpc("file.root.register", json!({"workspaceId":"workspace",
        "executionWorkspaceId":"workspace","canonicalRoot":work}), Some(grant)).unwrap();
    let opened = owner.rpc("source.authority.open", json!({"principalId":"client","coordinatorHostId":"coordinator",
        "scope":{"kind":"run","threadId":"thread","runId":"run","epoch":1},
        "source":source,"grantId":grant,"enabledTools":[],"purpose":"mcp_owner"}), None).unwrap();
    assert_eq!(opened["mcpChildren"], json!([]));
    let address = json!({"principalId":"client","coordinatorHostId":"coordinator",
        "authorityId":opened["authorityId"],"resourceEpoch":opened["resourceEpoch"]});
    let mut bind = address.clone();
    bind["physicalRoot"] = source["live_root"].clone();
    bind["toolBinding"] = json!({"resourceOwner":source["resource_owner"],"grantId":grant,
        "runId":"run","threadId":"thread","workspaceId":"workspace","executionWorkspaceId":"workspace",
        "rootId":physical["rootId"],"sourceMode":"live_root","liveRoot":source["live_root"],"enabledTools":[]});
    owner.rpc("source.authority.bind", bind, None).unwrap();
    let selection = json!({"reference":"original-selection","generation":1,"tools":[],"routes":{},
        "resources":{"server:deferred":"original-resource"},"provenance":{"servers":{"deferred":{
            "definition_version":"frozen-definition","resource_key":"original-resource","owner":{
                "resource_owner":source["resource_owner"],"source_authority":{
                    "coordinator_host_id":"coordinator","authority_id":address["authorityId"],"resource_epoch":address["resourceEpoch"]},
                "configuration":{"agent_dir":"/agent","config_cwd":"/project","project_trusted":true},"execution_scope":"workspace"}}}}});
    let params = |id: &str, action: &str| {
        let mut params = address.clone();
        params["binding"] = json!({"operationId":id,"parentRunId":"run","executionOwner":{"kind":"kernel"},"executionEpoch":3});
        params["action"] = json!(action);
        if action == "retain" { params["selection"] = selection.clone(); }
        params
    };
    let gc = |owner: &Owner, id: &str| {
        owner.rpc("authority.grant.issue", json!({"grantId":id,"hostGeneration":owner.generation,
            "storageIdentity":owner.root,"sessionId":null,"owningWorkspace":"workspace","executionWorkspace":"workspace",
            "threadId":"thread","runId":"run","operationId":id,
            "capabilities":["storage.maintenance","storage.gc"],"pathScopes":[""]}), None).unwrap();
        owner.rpc("storage.gc", json!({"operationId":id}), Some(id)).unwrap();
    };
    let mut wrong = params("dispatch", "retain"); wrong["authorityId"] = ordinary["authorityId"].clone();
    assert!(owner.rpc("source.mcp.child", wrong, None).is_err());
    for field in ["principalId", "coordinatorHostId", "resourceEpoch"] {
        let mut wrong = params("dispatch", "retain"); wrong[field] = json!("other");
        assert!(owner.rpc("source.mcp.child", wrong, None).is_err());
    }
    let mut wrong = params("dispatch", "retain"); wrong["selection"]["provenance"]["servers"]["deferred"]["owner"]["source_authority"]["authority_id"] = json!("other");
    assert!(owner.rpc("source.mcp.child", wrong, None).is_err());
    let retained = owner.rpc("source.mcp.child", params("dispatch", "retain"), None).unwrap();
    assert_eq!(retained["reference"]["released"], false);
    assert!(retained["selection"].is_null(), "control metadata never embeds the full selection");
    assert_eq!(retained["created"], true);
    let mut recalled = retained.clone(); recalled["created"] = json!(false);
    assert_eq!(owner.rpc("source.mcp.child", params("dispatch", "retain"), None).unwrap(), recalled);
    let body = crate::protocol::object_path(&owner.root, retained["reference"]["selectionRef"]["objectHash"].as_str().unwrap()).unwrap();
    assert!(body.exists());
    assert_eq!(owner.rpc("source.mcp.child", params("dispatch", "read"), None).unwrap()["selection"], selection);
    for field in ["parentRunId", "executionEpoch", "executionOwner"] {
        let mut wrong = params("dispatch", "release");
        wrong["binding"][field] = match field { "executionEpoch"=>json!(4), "executionOwner"=>json!({"kind":"external","identity":"other","epoch":"other"}), _=>json!("other") };
        assert!(owner.rpc("source.mcp.child", wrong, None).is_err());
    }
    let mut changed = params("dispatch", "retain"); changed["selection"]["generation"] = json!(2);
    assert!(owner.rpc("source.mcp.child", changed, None).is_err());
    // The exact cancel fence wins while hashing/fsync run outside Storage.
    let staging = source_resources::prepare_request(&mut owner.storage.lock().unwrap(), "source.mcp.child",
        params("overtaken", "retain"), owner.epoch, owner.host, owner.generation).unwrap();
    let staged = staging.execute(owner.resources.clone(), CancellationToken::default()).unwrap();
    let released = owner.rpc("source.mcp.child", params("overtaken", "release"), None).unwrap();
    assert_eq!(released["reference"]["selectionRef"], Value::Null);
    assert_eq!(staged.finish(&mut owner.storage.lock().unwrap()).unwrap(), released);
    assert_eq!(owner.rpc("source.mcp.child", params("overtaken", "retain"), None).unwrap(), released);
    // Sealing denies a staging worker that had not durably retained a reference.
    let staging = source_resources::prepare_request(&mut owner.storage.lock().unwrap(), "source.mcp.child",
        params("not-yet-retained", "retain"), owner.epoch, owner.host, owner.generation).unwrap();
    let staged = staging.execute(owner.resources.clone(), CancellationToken::default()).unwrap();
    assert_eq!(owner.rpc("source.authority.seal", address.clone(), None).unwrap()["phase"], "retaining");
    assert!(staged.finish(&mut owner.storage.lock().unwrap()).is_err());
    assert!(owner.rpc("source.mcp.child", params("new-after-seal", "retain"), None).is_err());
    assert_eq!(owner.rpc("source.mcp.child", params("dispatch", "retain"), None).unwrap()["reference"], retained["reference"]);
    let mut retire = address.clone(); retire["mode"] = json!("retire");
    let retirement = owner.rpc("source.authority.release", retire, None).unwrap();
    assert_eq!(retirement["phase"], "retaining"); assert_eq!(retirement["grantIds"], json!([]));
    gc(&owner, "child-body-live-gc"); assert!(body.exists());
    owner.rpc("authority.grant.revoke", json!({"grantId":grant}), None).unwrap();
    assert!(owner.rpc("source.mcp.child", params("dispatch", "retain"), None).is_err());
    drop(owner);
    let reopened = Owner::new(root.join("storage"), "child-host", "new-generation", "new-epoch");
    let recall = reopened.rpc("source.mcp.child", params("dispatch", "read"), None).unwrap();
    assert_eq!(recall["selection"], selection); assert_eq!(recall["grantState"], "revoked");
    gc(&reopened, "child-body-reopen-gc"); assert!(body.exists());
    // A read already captured before release remains a real temporary object root.
    let reading = source_resources::prepare_request(&mut reopened.storage.lock().unwrap(), "source.mcp.child",
        params("dispatch", "read"), reopened.epoch, reopened.host, reopened.generation).unwrap();
    assert_eq!(reopened.rpc("source.mcp.child", params("dispatch", "release"), None).unwrap()["phase"], "draining");
    gc(&reopened, "child-body-reading-gc"); assert!(body.exists());
    let read = reading.execute(reopened.resources.clone(), CancellationToken::default()).unwrap().finish(&mut reopened.storage.lock().unwrap()).unwrap();
    assert_eq!(read["selection"], selection);
    gc(&reopened, "child-body-released-gc"); assert!(!body.exists());
    assert_eq!(reopened.rpc("source.mcp.child", params("dispatch", "read"), None).unwrap()["selection"], Value::Null);
    drop(reopened); std::fs::remove_dir_all(root).unwrap();
}
