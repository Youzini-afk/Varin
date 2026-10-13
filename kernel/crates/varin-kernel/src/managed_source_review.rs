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
        let actor = storage.clone();
        let resources = KernelResourceClient::new(
            move |request| {
                let result = crate::tools::serve_resource(
                    &mut actor.lock().unwrap(),
                    epoch,
                    host,
                    generation,
                    &request,
                );
                let _ = request.reply.send(result);
                Ok(())
            },
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
                            step: 1,
                            history_range: request.history_range.clone(),
                        },
                        binding: request.clone(),
                        history: vec![],
                    },
                    serialized: json!({"fixture":true}),
                },
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
        resources.replay_read_receipt_releases()?;
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
    fn serialize(&self, _: &RequestView) -> Result<Value, ExecutionError> {
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
