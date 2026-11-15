//! Accepted external children retain their own cleanup authority after terminal receipts.
#[path = "fixtures/child_dispatch.rs"]
mod fixture;

use fixture::Fixture;
use serde_json::{Value, json};
use std::sync::Mutex;
use varin_runtime::catalog::external_children;
use varin_runtime::execution::ToolSchema;
use varin_runtime::{Catalog, OperationPhase};

fn schema(name: &str) -> ToolSchema {
    ToolSchema {
        name: name.into(),
        version: "1".into(),
        description: String::new(),
        schema: json!({"type":"object"}),
        requirements: None,
        output_schema: None,
        metadata: None,
    }
}

fn external(owner: &Mutex<Catalog>, command: Value) -> Value {
    let prepared = owner
        .lock()
        .unwrap()
        .prepare_external(serde_json::from_value(command).unwrap())
        .load()
        .unwrap();
    owner
        .lock()
        .unwrap()
        .execute_external(prepared)
        .unwrap()
        .load()
        .unwrap()
}

fn completed_external_child() -> (std::path::PathBuf, Mutex<Catalog>, String) {
    let choice = json!({"reference":"exec:EXTERNAL","name":"External worker","availability":"enabled",
        "binding":{"configuration_id":"external","harness":"codex","resource_owner":{"kind":"local"},
            "launch":{"command":"external-fixture","args":[]}}});
    let mut f = Fixture::new_parent_custom(
        7,
        schema("file_read"),
        schema("dispatch"),
        false,
        false,
        false,
        |input, _| {
            input.executor = Some("exec:EXTERNAL".into());
            input.preset = None;
            input.tools = None;
            input.work_mode = Some(varin_runtime::catalog::dispatch::ChildWorkMode::Shared);
        },
    );
    let mut selected =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap();
    assert!(selected.catalog.executors.is_empty());
    // The authenticated executor owner freezes a later choice on the original
    // operation, without rewriting its already-published model request.
    let fixed =
        f.db.freeze_model_target(
            &f.context.operation_id,
            "dispatch-executor",
            &json!({"executor":"exec:EXTERNAL","sourceOwner":{"kind":"local"}}),
            &choice,
        )
        .unwrap();
    selected
        .catalog
        .executors
        .push(serde_json::from_value(fixed).unwrap());
    let preset = selected.external_preset(&f.input).unwrap().unwrap();
    let prepared =
        f.db.prepare_external_child(&f.context, &f.input, &selected, &preset, None)
            .unwrap()
            .load()
            .unwrap();
    let child = f.db.accept_external_child(prepared).unwrap();
    f.settle_exchange();
    assert!(
        f.db.child_tasks().unwrap().is_empty(),
        "external admission must not fabricate native children"
    );
    let owner = Mutex::new(f.db);
    external(
        &owner,
        json!({"action":"create","key":"external-child","id":child.conversation_id,
        "configurationId":"external","harness":"codex","title":"External worker","cwd":"/workspace",
        "parent":{"operationId":child.operation_id,"runId":child.parent_run_id,"threadId":child.parent_thread_id}}),
    );
    let input = external_children::execute(
        &owner,
        json!({"action":"child_input","operationId":child.operation_id}),
    )
    .unwrap();
    let turn = external(
        &owner,
        json!({"action":"admit","id":child.conversation_id,"key":"child-turn","input":input}),
    );
    external_children::execute(
        &owner,
        json!({"action":"child_link","operationId":child.operation_id,"turnId":turn["id"]}),
    )
    .unwrap();
    external(
        &owner,
        json!({"action":"begin","id":child.conversation_id,"turnId":turn["id"]}),
    );
    external(
        &owner,
        json!({"action":"observe","id":child.conversation_id,"turnId":turn["id"],"status":"completed"}),
    );
    external_children::execute(
        &owner,
        json!({"action":"child_finish","operationId":child.operation_id,"released":false}),
    )
    .unwrap();
    let db = owner.lock().unwrap();
    let completed = db.external_child(&child.operation_id).unwrap().unwrap();
    assert!(completed.report.is_some() && completed.receipt_published);
    assert!(
        !completed.resources_released,
        "terminal business receipt is not resource release"
    );
    assert_eq!(
        db.operation(&child.operation_id).unwrap().phase,
        OperationPhase::Terminal
    );
    drop(db);
    (f.root, owner, child.operation_id)
}

#[test]
fn terminal_external_dispatch_never_enters_unaccepted_native_dependency_discovery() {
    let (root, owner, operation) = completed_external_child();
    for released in [false, true] {
        if released {
            external_children::execute(
                &owner,
                json!({"action":"child_finish","operationId":operation,"released":true}),
            )
            .unwrap();
        }
        let db = owner.lock().unwrap();
        assert!(
            db.capture_unaccepted_child_dependencies()
                .unwrap()
                .load()
                .unwrap()
                .is_empty(),
            "an accepted external dispatch is not abandoned native preparation"
        );
        assert_eq!(
            db.external_child(&operation)
                .unwrap()
                .unwrap()
                .resources_released,
            released
        );
    }
    drop(owner);
    let db = Catalog::open(&root).unwrap();
    assert!(
        db.capture_unaccepted_child_dependencies()
            .unwrap()
            .load()
            .unwrap()
            .is_empty()
    );
    assert!(db.child_tasks().unwrap().is_empty());
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_dependency_ack_cannot_claim_an_accepted_external_dispatch() {
    let (root, owner, operation) = completed_external_child();
    for released in [false, true] {
        if released {
            external_children::execute(
                &owner,
                json!({"action":"child_finish","operationId":operation,"released":true}),
            )
            .unwrap();
        }
        let mut db = owner.lock().unwrap();
        let before = db.external_child(&operation).unwrap().unwrap();
        assert!(
            db.mark_unaccepted_child_dependencies_released(&operation)
                .is_err(),
            "only the accepted external child's owner may acknowledge its release"
        );
        assert_eq!(db.external_child(&operation).unwrap().unwrap(), before);
        assert!(
            db.events_after(0, 1000)
                .unwrap()
                .iter()
                .all(|event| event.subject != operation
                    || event.kind != "child.dependencies_released")
        );
    }
    drop(owner);
    let mut db = Catalog::open(&root).unwrap();
    assert!(
        db.mark_unaccepted_child_dependencies_released(&operation)
            .is_err()
    );
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
