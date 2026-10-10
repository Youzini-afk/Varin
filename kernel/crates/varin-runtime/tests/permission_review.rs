#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::{json, Value};
use varin_runtime::catalog::launches::LaunchSelection;
use varin_runtime::execution::{AdmittedTool, CompletionKind, ToolCall, ToolContract};
use varin_runtime::{Catalog, Effect, Lifetime, Outcome, SubmitInput};
struct Fixture {
    root: std::path::PathBuf,
    db: Catalog,
    run: String,
    op: String,
    call: Value,
    scope: Value,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("varin-permission-review-{}", uuid::Uuid::new_v4()));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("thread", "branch").unwrap();
        let launch:LaunchSelection=serde_json::from_value(json!({"connection_identity":"fixture","provider_family":"fixture","model":"fixture","configuration_generation":1,"tool_schema_generation":1,"tools":[],"policy":{"name":"agent","version":"1"},"source":null,"credential_scope":{"reference":"actor-ref","authority":"fixture-auth","account":"selected-account","generation":1}})).unwrap();
        let receipt = db
            .submit_with_launch(
                &SubmitInput {
                    key: "input".into(),
                    thread_id: "thread".into(),
                    branch_id: "branch".into(),
                    expected_head: None,
                    input: json!({"text":"call an exact tool"}),
                    configuration: json!({}),
                },
                Some(launch),
            )
            .unwrap();
        let op = "request-1:tool:call-1".to_string();
        let tool = AdmittedTool {
            call: ToolCall {
                call_id: "call-1".into(),
                name: "fixture_send".into(),
                schema_version: "schema-1".into(),
                arguments: json!({"target":"chosen","text":"approved content"}),
            },
            contract: ToolContract {
                name: "fixture_send".into(),
                schema_version: "schema-1".into(),
                read_only: false,
                completion: CompletionKind::Result,
                lifetime: Lifetime::Run,
                resources: vec![],
            },
        };
        db.admit_tool_operation(&op, &receipt.run_id, db.epoch(), &tool)
            .unwrap();
        let call = json!({"runId":receipt.run_id,"requestId":"request-1","operationId":op,"callId":"call-1","name":"fixture_send","schemaVersion":"schema-1","arguments":{"target":"chosen","text":"approved content"}});
        let scope = json!({"ownerReference":"owner-1","ownerGeneration":3,"toolSchemaVersion":"schema-1","policyGeneration":"policy-1","reason":"external effect"});
        Self {
            root,
            db,
            run: receipt.run_id,
            op,
            call,
            scope,
        }
    }
}
#[test]
fn permission_is_exact_one_use_and_denial_or_cancellation_never_authorizes_dispatch() {
    let mut f = Fixture::new();
    for (field, value) in [
        ("runId", json!("other-run")),
        ("requestId", json!("other-request")),
        ("name", json!("other-tool")),
        (
            "arguments",
            json!({"target":"different","text":"approved content"}),
        ),
    ] {
        let mut changed = f.call.clone();
        changed[field] = value;
        assert!(f
            .db
            .open_permission(&f.op, "bad", changed, f.scope.clone())
            .is_err());
    }
    let opened =
        f.db.open_permission(&f.op, "permission-1", f.call.clone(), f.scope.clone())
            .unwrap();
    assert_eq!(
        opened.result.as_ref().unwrap()["permission"]["actor"]["account"],
        "selected-account"
    );
    f.db.decide_permission(&f.op, "permission-1", "allow_once")
        .unwrap();
    let mut changed = f.scope.clone();
    changed["ownerGeneration"] = json!(4);
    assert!(f
        .db
        .consume_permission(&f.op, "permission-1", f.call.clone(), changed)
        .is_err());
    let mut changed = f.scope.clone();
    changed["policyGeneration"] = json!("policy-2");
    assert!(f
        .db
        .consume_permission(&f.op, "permission-1", f.call.clone(), changed)
        .is_err());
    let mut changed = f.call.clone();
    changed["arguments"]["text"] = json!("changed after approval");
    assert!(f
        .db
        .consume_permission(&f.op, "permission-1", changed, f.scope.clone())
        .is_err());
    f.db.consume_permission(&f.op, "permission-1", f.call.clone(), f.scope.clone())
        .unwrap();
    assert!(f
        .db
        .consume_permission(&f.op, "permission-1", f.call.clone(), f.scope.clone())
        .is_err());
    assert!(f
        .db
        .decide_permission(&f.op, "permission-1", "allow_once")
        .is_err());
    // A terminal receipt replaces the active permission. Its audit event must still retain
    // the exact approved bodies, and the Operation must retain its original tool arguments.
    f.db.settle_operation(
        &f.op,
        f.db.epoch(),
        Outcome::Cancelled,
        Effect::None,
        json!({"cancelled":true}),
    )
    .unwrap();
    f.db.collect_content_objects().unwrap();
    let view = f.db.capture_operation_read(opened).load().unwrap();
    let tool: AdmittedTool = serde_json::from_value(view.intent).unwrap();
    assert_eq!(tool.call.arguments, f.call["arguments"]);
    let permission = &view.result.as_ref().unwrap()["permission"];
    assert_eq!(permission["call"], f.call);
    assert_eq!(permission["scope"], f.scope);
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
    for cancelled in [false, true] {
        let mut f = Fixture::new();
        f.db.open_permission(&f.op, "permission-1", f.call.clone(), f.scope.clone())
            .unwrap();
        if cancelled {
            f.db.request_cancel_run(&f.run).unwrap();
            assert!(f
                .db
                .decide_permission(&f.op, "permission-1", "allow_once")
                .is_err());
        } else {
            f.db.decide_permission(&f.op, "permission-1", "deny")
                .unwrap();
        }
        assert!(f
            .db
            .consume_permission(&f.op, "permission-1", f.call.clone(), f.scope.clone())
            .is_err());
        let root = f.root.clone();
        drop(f);
        std::fs::remove_dir_all(root).unwrap();
    }
}
#[test]
fn an_unconsumed_permission_cannot_be_revived_after_kernel_reopen() {
    let mut f = Fixture::new();
    f.db.open_permission(&f.op, "permission-1", f.call.clone(), f.scope.clone())
        .unwrap();
    f.db.decide_permission(&f.op, "permission-1", "allow_once")
        .unwrap();
    let Fixture {
        root,
        db,
        op,
        call,
        scope,
        ..
    } = f;
    drop(db);
    let mut db = Catalog::open(&root).unwrap();
    assert!(db
        .consume_permission(&op, "permission-1", call, scope)
        .is_err());
    assert!(db
        .decide_permission(&op, "permission-1", "allow_once")
        .is_err());
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
