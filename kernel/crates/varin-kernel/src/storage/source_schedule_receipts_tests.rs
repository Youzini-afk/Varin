use super::*;
use crate::source_resources::{self, SourceDispatch};
use crate::tools::KernelResourceClient;
use varin_runtime::execution::CancellationToken;

fn resources() -> KernelResourceClient {
    KernelResourceClient::new(
        |_| panic!("receipt cannot execute a resource"),
        |_| Ok(()),
        Default::default(),
    )
}
fn request(
    storage: &mut Storage,
    method: &str,
    input: Value,
    epoch: &str,
) -> Result<Value, KernelError> {
    crate::protocol::validate_method_params(method, &input)?;
    let work =
        source_resources::prepare_request(storage, method, input, epoch, "target", "generation")?;
    if let SourceDispatch::Ready(value) = work {
        return Ok(value);
    }
    work.execute(resources(), CancellationToken::default())?
        .finish(storage)
}
fn with(address: &Value, fields: Value) -> Value {
    let mut value = address.clone();
    value
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    value
}
struct Fixture {
    storage: Storage,
    root: PathBuf,
    address: Value,
    invocation: Value,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("varin-schedule-receipt-{}", Uuid::new_v4()));
        let work = root.join("project");
        fs::create_dir_all(&work).unwrap();
        let mut storage = Storage::open(&root.join("storage"), "target").unwrap();
        let storage_identity = root.join("storage").to_string_lossy().to_string();
        storage.issue_grant(&json!({"grantId":"source","hostGeneration":"generation","storageIdentity":storage_identity,
            "owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"thread","runId":"run",
            "capabilities":["storage.read","storage.write"],"pathScopes":[""]}), "target", "generation", &storage_identity, "epoch").unwrap();
        let grant = storage.load_grant("source").unwrap();
        let registered = storage.file_root_register(&json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":work}), &grant).unwrap();
        let live = json!({"hostId":"target","rootId":registered["rootId"],"canonicalRoot":registered["canonicalRoot"]});
        let source = json!({"resource_owner":{"kind":"managed_host","hostId":"target","connectionId":"connection","endpointIdentity":"endpoint"},
            "workspace_id":"workspace","execution_workspace_id":"workspace","mode":"live_root","live_root":live,
            "branch_id":null,"revision":null,"environment_run_id":null});
        let opened = request(&mut storage, "source.authority.open", json!({"principalId":"principal","coordinatorHostId":"coordinator",
            "scope":{"kind":"run","threadId":"thread","runId":"run","epoch":1},"source":source,"grantId":"source",
            "enabledTools":["file_read"],"purpose":"source"}), "epoch").unwrap();
        let address = json!({"principalId":"principal","coordinatorHostId":"coordinator","authorityId":opened["authorityId"],"resourceEpoch":"epoch"});
        request(&mut storage, "source.authority.bind", with(&address, json!({"physicalRoot":live,"toolBinding":{
            "resourceOwner":source["resource_owner"],"grantId":"source","runId":"run","threadId":"thread","workspaceId":"workspace",
            "executionWorkspaceId":"workspace","rootId":registered["rootId"],"sourceMode":"live_root","liveRoot":live,"enabledTools":["file_read"]}})), "epoch").unwrap();
        let invocation = json!({"invocationId":"invocation","runId":"run","threadId":"thread","operationId":"request:tool:schedule","callId":"schedule",
            "executorOwner":{"kind":"external","identity":"A-extension","epoch":"A-extension-epoch"},"origin":{"kind":"model_step","request_id":"request"},
            "source":source,"toolName":"scheduled_task","operation":"effect","completion":"result","configurationIdentity":"config-original",
            "arguments":{"action":"write_loop","name":"daily","content":"original loop"}});
        Self {
            storage,
            root,
            address,
            invocation,
        }
    }
    fn begin(&mut self) -> Result<Value, KernelError> {
        request(
            &mut self.storage,
            "source.schedule.receipt",
            with(
                &self.address,
                json!({"action":"begin","invocation":self.invocation}),
            ),
            "epoch",
        )
    }
    fn control(&self) -> Value {
        with(
            &self.address,
            json!({"operationId":self.invocation["operationId"]}),
        )
    }
    fn finish(&mut self, receipt: &Value) -> Result<Value, KernelError> {
        request(
            &mut self.storage,
            "source.schedule.receipt",
            with(
                &self.address,
                json!({"action":"finish","operationId":self.invocation["operationId"],"receipt":receipt}),
            ),
            "epoch",
        )
    }
}
fn receipt(body: Value) -> Value {
    json!({"executor_stopped":true,"completion":{"kind":"result","outcome":"succeeded","effect":"confirmed","content":{"data":body,"parts":[]}}})
}
#[test]
fn schedule_receipt_ack_loss_revoke_reopen_and_large_original_body() {
    let mut f = Fixture::new();
    assert_eq!(f.begin().unwrap(), json!({"fresh":true,"receipt":null}));
    // Treat the first ACK as lost: a repeated original begin never grants dispatch.
    assert_eq!(f.begin().unwrap(), json!({"fresh":false,"receipt":null}));
    let owner: String = f
        .storage
        .conn
        .query_row(
            "SELECT workspace_id FROM operation_owners WHERE operation_id='request:tool:schedule'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(owner, "workspace");
    let control = f.control();
    let pending = request(
        &mut f.storage,
        "source.resource.observe",
        control.clone(),
        "epoch",
    )
    .unwrap();
    assert_eq!(pending["executorStopped"], false);
    assert_eq!(pending["result"]["completion"]["effect"], "unknown");
    assert_eq!(
        request(
            &mut f.storage,
            "source.resource.release",
            control.clone(),
            "epoch"
        )
        .unwrap()["released"],
        false
    );
    assert_eq!(
        request(
            &mut f.storage,
            "source.resource.cancel",
            control.clone(),
            "epoch"
        )
        .unwrap()["executorStopped"],
        false
    );
    let result = receipt(json!({"original":"original project receipt\n".repeat(750_000)}));
    assert!(serde_json::to_vec(&result).unwrap().len() > crate::protocol::MAX_FRAME_BYTES);
    // The actual callback has returned, but the observer is cancelled and its grant revoked.
    let work = source_resources::prepare_request(
        &mut f.storage,
        "source.schedule.receipt",
        with(
            &f.address,
            json!({"action":"finish","operationId":f.invocation["operationId"],"receipt":result}),
        ),
        "epoch",
        "target",
        "generation",
    )
    .unwrap();
    f.storage
        .revoke_grant(&json!({"grantId":"source"}), "target")
        .unwrap();
    let cancel = CancellationToken::default();
    cancel.cancel();
    let completed = work.execute(resources(), cancel).unwrap();
    assert_eq!(completed.finish(&mut f.storage).unwrap(), result);
    let stored = f
        .storage
        .operation_get(&json!({"operationId":f.invocation["operationId"]}))
        .unwrap();
    assert!(
        stored.to_string().len() < 2_000,
        "Catalog stores only original identity and body references"
    );
    assert_eq!(stored["result"]["effect"], "confirmed");
    f.storage.gc().unwrap();
    f.storage.drain_gc_files().unwrap();
    // Finish ACK loss is recoverable from this exact original Source, after restart too.
    assert_eq!(f.finish(&result).unwrap(), result);
    let mut changed = result.clone();
    changed["completion"]["effect"] = json!("none");
    assert!(f.finish(&changed).is_err());
    let root = f.root.clone();
    let address = f.address.clone();
    let invocation = f.invocation.clone();
    drop(f);
    let mut reopened = Storage::open(&root.join("storage"), "target").unwrap();
    let observed = request(
        &mut reopened,
        "source.resource.observe",
        control.clone(),
        "new-epoch",
    )
    .unwrap();
    assert_eq!(observed["result"], result);
    assert_eq!(observed["resourceEpoch"], "epoch");
    assert_ne!(observed["executionOwner"], invocation["executorOwner"]);
    assert_eq!(observed["executorStopped"], true);
    assert_eq!(
        request(
            &mut reopened,
            "source.schedule.receipt",
            with(&address, json!({"action":"begin","invocation":invocation})),
            "new-epoch"
        )
        .unwrap()["receipt"],
        result
    );
    let cancelled = request(
        &mut reopened,
        "source.resource.cancel",
        control.clone(),
        "new-epoch",
    )
    .unwrap();
    assert_eq!(cancelled["executorStopped"], true);
    assert!(
        cancelled.to_string().len() < 2_000,
        "control cancellation never hydrates the body"
    );
    let mut new_invocation = invocation.clone();
    new_invocation["callId"] = json!("later");
    new_invocation["operationId"] = json!("request:tool:later");
    assert!(request(
        &mut reopened,
        "source.schedule.receipt",
        with(
            &address,
            json!({"action":"begin","invocation":new_invocation})
        ),
        "new-epoch"
    )
    .is_err());
    drop(reopened);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn schedule_receipt_release_retains_fence_and_reader_gc_until_actual_load() {
    let mut f = Fixture::new();
    f.begin().unwrap();
    let result = receipt(json!({"changed":true}));
    f.finish(&result).unwrap();
    let control = f.control();
    let body = source_resources::prepare_request(
        &mut f.storage,
        "source.resource.observe",
        control.clone(),
        "epoch",
        "target",
        "generation",
    )
    .unwrap();
    let stored = f
        .storage
        .operation_get(&json!({"operationId":f.invocation["operationId"]}))
        .unwrap();
    let hash = stored["result"]["objectHash"].as_str().unwrap();
    let path = object_path(&f.storage.root, hash).unwrap();
    assert_eq!(
        request(
            &mut f.storage,
            "source.resource.release",
            control.clone(),
            "epoch"
        )
        .unwrap()["released"],
        true
    );
    f.storage.gc().unwrap();
    f.storage.drain_gc_files().unwrap();
    assert!(path.exists(), "in-flight body retains its original object");
    assert_eq!(
        body.execute(resources(), CancellationToken::default())
            .unwrap()
            .finish(&mut f.storage)
            .unwrap()["result"],
        result
    );
    f.storage.gc().unwrap();
    f.storage.drain_gc_files().unwrap();
    assert!(
        !path.exists(),
        "delivered body is collectible after reader drainage"
    );
    assert_eq!(f.begin().unwrap(), json!({"fresh":false,"receipt":null}));
    assert!(request(&mut f.storage, "source.resource.observe", control, "epoch").is_err());
    assert_eq!(
        f.finish(&result).unwrap(),
        result,
        "late duplicate completion cannot restore released bytes"
    );
    assert!(!path.exists());
    assert_eq!(
        f.storage
            .operation_release(
                &json!({"operationId":f.invocation["operationId"],"workspaceId":"workspace"})
            )
            .unwrap()["released"],
        false
    );
    let root = f.root.clone();
    drop(f);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn schedule_receipt_rejects_changed_call_foreign_owner_and_false_stop() {
    let mut f = Fixture::new();
    f.begin().unwrap();
    for (field, changed) in [
        ("invocationId", json!("replacement")),
        ("runId", json!("replacement")),
        ("threadId", json!("replacement")),
        ("callId", json!("replacement")),
        ("configurationIdentity", json!("replacement")),
        (
            "arguments",
            json!({"action":"write_loop","content":"other"}),
        ),
        (
            "executorOwner",
            json!({"kind":"external","identity":"other","epoch":"A-extension-epoch"}),
        ),
        (
            "origin",
            json!({"kind":"nested_call","parent_operation_id":"different"}),
        ),
        ("source", Value::Null),
        ("toolName", json!("file_write")),
        ("operation", json!("read")),
        ("completion", json!("job")),
    ] {
        let mut invocation = f.invocation.clone();
        invocation[field] = changed;
        assert!(
            request(
                &mut f.storage,
                "source.schedule.receipt",
                with(
                    &f.address,
                    json!({"action":"begin","invocation":invocation})
                ),
                "epoch"
            )
            .is_err(),
            "changed {field}"
        );
    }
    let mut foreign = f.control();
    foreign["principalId"] = json!("other");
    assert!(request(&mut f.storage, "source.resource.observe", foreign, "epoch").is_err());
    let mut false_stop = receipt(json!({"error":"cancelled observer"}));
    false_stop["executor_stopped"] = json!(false);
    false_stop["completion"]["outcome"] = json!("indeterminate");
    false_stop["completion"]["effect"] = json!("unknown");
    assert!(
        f.finish(&false_stop).is_err(),
        "observer cancellation is not callback completion"
    );
    let pending_id = f.invocation["operationId"].clone();
    let control = f.control();
    let address = f.address.clone();
    let invocation = f.invocation.clone();
    let root = f.root.clone();
    drop(f);
    let mut reopened = Storage::open(&root.join("storage"), "target").unwrap();
    assert_eq!(
        request(
            &mut reopened,
            "source.schedule.receipt",
            with(&address, json!({"action":"begin","invocation":invocation})),
            "new-epoch"
        )
        .unwrap(),
        json!({"fresh":false,"receipt":null})
    );
    assert_eq!(
        request(
            &mut reopened,
            "source.resource.observe",
            control,
            "new-epoch"
        )
        .unwrap()["executorStopped"],
        false
    );
    assert_eq!(
        reopened
            .operation_get(&json!({"operationId":pending_id}))
            .unwrap()["state"],
        "started"
    );
    drop(reopened);
    fs::remove_dir_all(root).unwrap();
}
