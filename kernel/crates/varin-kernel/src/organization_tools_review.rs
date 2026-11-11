//! Original policy invocations exercise the actual organization executor and external
//! Catalog owner. The rendezvous adapter only translates the existing Host metadata
//! envelope; it never fabricates an external receipt or settles the tool operation.
use super::*;
#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod admission_fixture;
#[path = "../../varin-runtime/tests/fixtures/child_dispatch.rs"]
mod dispatch_fixture;
use admission_fixture::InputAdmission;
use std::{sync::mpsc, time::Duration};
use varin_runtime::{SubmitInput, catalog::external::ExternalCommand};

fn external(db: &mut Catalog, command: Value) -> Value {
    let command: ExternalCommand = serde_json::from_value(command).unwrap();
    let prepared = db.prepare_external(command).load().unwrap();
    db.execute_external(prepared).unwrap().load().unwrap()
}

#[test]
fn original_external_delete_tool_replays_after_owner_commit_before_tool_settlement() {
    let mut fixture = dispatch_fixture::Fixture::new_in_bot("bot");
    let mut launch = fixture
        .db
        .launch_intent(&fixture.context.run_id)
        .unwrap()
        .unwrap()
        .selection;
    launch.tools.push(schema());
    let configuration = fixture
        .db
        .run(&fixture.context.run_id)
        .unwrap()
        .configuration;
    fixture
        .db
        .create_bot_thread("organization-session", "organization-main", "bot")
        .unwrap();
    let run = fixture
        .db
        .submit_with_launch(
            &SubmitInput {
                key: "organization-run".into(),
                thread_id: "organization-session".into(),
                branch_id: "organization-main".into(),
                expected_head: None,
                input: json!({"text":"Delete the selected external conversation"}),
                configuration: configuration.clone(),
            },
            Some(launch.clone()),
        )
        .unwrap();
    let created = external(
        &mut fixture.db,
        json!({"action":"create","id":"external-delete-target","key":"external-create","configurationId":"codex","harness":"codex","title":"Original external conversation","cwd":"/workspace"}),
    );
    assert_eq!(created["id"], "external-delete-target");
    let selected = fixture
        .db
        .external_agent_reference("external-delete-target")
        .unwrap();
    let snapshot = fixture
        .db
        .organization_snapshot(None, OrganizationQuery::default())
        .unwrap();
    let observation = fixture
        .db
        .register_model_reference(
            ReferenceKind::Read,
            "organization_observation",
            &json!({"principal":null,"snapshot":snapshot}),
            &run.run_id,
        )
        .unwrap();
    let call = ToolCall {
        call_id: "delete-external".into(),
        name: schema().name,
        schema_version: "1".into(),
        arguments: json!({"action":"delete","input":{"observation":observation,"reference":selected}}),
    };
    let contract = ToolContract {
        name: call.name.clone(),
        schema_version: call.schema_version.clone(),
        read_only: false,
        completion: CompletionKind::Result,
        lifetime: Lifetime::Run,
        resources: vec![],
    };
    fixture.context.run_id = run.run_id.clone();
    let context = fixture.admit_policy_call_with_contract(call.clone(), contract.clone());
    // A separate real authenticated Bot Run cannot borrow this public observation.
    fixture
        .db
        .create_bot_thread_with_placement(
            "foreign-session",
            "foreign-main",
            "bot",
            Some("alice"),
            None,
        )
        .unwrap();
    let foreign = fixture
        .db
        .submit_with_launch(
            &SubmitInput {
                key: "foreign-run".into(),
                thread_id: "foreign-session".into(),
                branch_id: "foreign-main".into(),
                expected_head: None,
                input: json!({"text":"Try another principal's reference"}),
                configuration,
            },
            Some(launch),
        )
        .unwrap();
    fixture.context.run_id = foreign.run_id;
    let foreign_context = fixture.admit_policy_call_with_contract(call.clone(), contract);
    let root = fixture.root.clone();
    let catalog = Arc::new(Mutex::new(fixture.db));
    let (output, requests) = mpsc::sync_channel(8);
    let bridge = crate::host_query::OwnerChannel::new("resource", output);
    bridge.initialize("organization-replay-epoch");
    let executor = Arc::new(Tools {
        catalog: catalog.clone(),
        bridge: bridge.clone(),
    });
    let mut results = Vec::new();
    for attempt in 0..2 {
        let worker = executor.clone();
        let worker_context = context.clone();
        let worker_call = call.clone();
        let task = std::thread::spawn(move || {
            worker.run(&worker_context, &worker_call, &CancellationToken::default())
        });
        let request = requests
            .recv_timeout(Duration::from_secs(5))
            .expect("original tool must reach the metadata owner even after deletion");
        assert_eq!(request["query"]["request"]["action"], "external_metadata");
        let input = &request["query"]["request"]["input"];
        let result = {
            let mut db = catalog.lock().unwrap();
            // The real Host validates the original invocation and tombstone principal
            // before consulting its metadata receipt. Exercise those exact owners.
            let invocation = db
                .capture_tool_invocation(&context, &call.call_id)
                .unwrap()
                .load()
                .unwrap();
            db.validate_tool_invocation(&invocation, true).unwrap();
            let caller = db.run(&context.run_id).unwrap();
            let before = external(
                &mut db,
                json!({"action":"inspect","id":input["conversationId"]}),
            );
            assert_eq!(
                before["principalId"].as_str(),
                caller.principal_id.as_deref()
            );
            if attempt == 1 {
                assert_eq!(before["deleted"], true);
                assert!(
                    db.organization_conversation(
                        None,
                        &ConversationRef::External {
                            id: "external-delete-target".into()
                        }
                    )
                    .is_err()
                );
            }
            let command = json!({"action":"update","id":input["conversationId"],"key":input["key"],"expectedRevision":input["expectedRevision"],"deleted":input["delete"]});
            let receipt = external(
                &mut db,
                json!({"action":"update_receipt","command":command}),
            );
            let result = if receipt.is_null() {
                external(&mut db, command)
            } else {
                receipt
            };
            json!({"status":"succeeded","result":result})
        };
        bridge.receive(json!({"v":1,"kind":"resource-response","id":request["id"],"kernelEpoch":request["kernelEpoch"],"result":{"status":"ready","result":result}}));
        results.push(task.join().unwrap().unwrap());
    }
    assert_eq!(results[0], results[1]);
    assert!(
        executor
            .run(&foreign_context, &call, &CancellationToken::default())
            .is_err()
    );
    assert!(matches!(
        requests.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    let db = catalog.lock().unwrap();
    assert_eq!(
        db.operation(&context.operation_id).unwrap().phase,
        varin_runtime::OperationPhase::Running
    );
    drop(db);
    bridge.close();
    drop(executor);
    drop(catalog);
    std::fs::remove_dir_all(root).unwrap();
}
