//! Actual child assembly and ordinary Operation path, both frozen invocation origins.
use super::*;
use varin_runtime::catalog::messages::*;
#[test]
fn selected_send_is_a_durable_effect_from_model_and_policy_with_real_agent_actor() {
    for model in [true, false] {
        let f = Fixture::with_tools(
            false,
            vec![crate::message_tools::schema()],
            vec!["send".into()],
        );
        let calls = vec![ToolCall {
            call_id: "message".into(),
            name: "send".into(),
            schema_version: "1".into(),
            arguments: json!({"targetThreadId":"thread:parent","targetBranchId":"branch:parent","kind":"inform","text":"Child original progress"}),
        }];
        execute(&f, model, calls, &mut OwnerReplies::default(), false);
        let catalog = f.catalog();
        let mut db = catalog.lock().unwrap();
        let page = db
            .capture_message_list(
                "thread:parent".into(),
                "branch:parent".into(),
                MessageDirection::Incoming,
                None,
                None,
            )
            .unwrap()
            .load(&|| false)
            .unwrap();
        assert_eq!(page.messages.len(), 1);
        let receipt = &page.messages[0].receipt;
        let MessageActor::Agent {
            run_id,
            operation_id,
            origin,
        } = &receipt.identity.actor
        else {
            panic!("real Agent required")
        };
        assert_eq!(run_id, &f.run.id);
        assert_eq!(matches!(origin, ToolOrigin::ModelStep { .. }), model);
        let operation = db.operation(operation_id).unwrap();
        let public = db.capture_operation_read(operation.clone()).load().unwrap();
        let invocation: ToolInvocation = serde_json::from_value(public.intent.clone()).unwrap();
        let context = ToolExecutionContext {
            run_id: run_id.clone(),
            operation_id: operation_id.clone(),
            origin: origin.clone(),
        };
        let one = db
            .prepare_tool_message(
                &context,
                invocation.call.clone(),
                crate::message_tools::schema(),
                serde_json::from_value(invocation.call.arguments.clone()).unwrap(),
            )
            .unwrap()
            .load()
            .unwrap();
        let two = db
            .prepare_tool_message(
                &context,
                invocation.call.clone(),
                crate::message_tools::schema(),
                serde_json::from_value(invocation.call.arguments.clone()).unwrap(),
            )
            .unwrap()
            .load()
            .unwrap();
        let replay = db.admit_message(one).unwrap();
        assert!(!replay.accepted);
        assert_eq!(&replay.receipt, receipt);
        assert_eq!(replay.completion, public.call_completion);
        assert_eq!(db.admit_message(two).unwrap().completion, replay.completion);
        let mut changed = invocation.call.clone();
        changed.arguments["text"] = json!("conflicting retry");
        assert!(db
            .prepare_tool_message(
                &context,
                changed.clone(),
                crate::message_tools::schema(),
                serde_json::from_value(changed.arguments.clone()).unwrap()
            )
            .unwrap()
            .load()
            .is_err());
        assert_eq!(operation.effect, Effect::Confirmed);
        assert!(operation.call_completion.is_some());
        assert!(page.messages[0].delivered_run_id.is_none());
        let parent = db.child_task(&f.child.operation_id).unwrap().parent_run_id;
        let head = db.head("branch:parent").unwrap();
        let prepared = db
            .prepare_input_delivery(&parent, db.epoch(), head.as_deref())
            .unwrap()
            .load()
            .unwrap();
        let batch = db.admit_input_delivery(prepared).unwrap().unwrap();
        assert!(!batch.activating);
        assert_eq!(batch.items.len(), 1);
        assert!(
            matches!(&batch.items[0].provenance,Provenance::AgentMessage{thread_id} if thread_id==&f.run.thread_id)
        );
        assert_eq!(
            db.history("branch:parent").unwrap().last().unwrap().source,
            varin_runtime::HistorySource::Agent
        );
        assert_eq!(
            db.execution_history("branch:parent")
                .unwrap()
                .last()
                .unwrap(),
            &batch.items[0]
        );
        let receipt = receipt.clone();
        let completion = public.call_completion;
        drop(db);
        drop(catalog);
        let f = f.reopen();
        let catalog = f.catalog();
        let mut db = catalog.lock().unwrap();
        let prepared = db
            .prepare_tool_message(
                &context,
                invocation.call.clone(),
                crate::message_tools::schema(),
                serde_json::from_value(invocation.call.arguments.clone()).unwrap(),
            )
            .unwrap()
            .load()
            .unwrap();
        let replay = db.admit_message(prepared).unwrap();
        assert_eq!(replay.receipt, receipt);
        assert_eq!(replay.completion, completion);
        assert_eq!(
            db.capture_message(
                "thread:parent",
                "branch:parent",
                &receipt.identity.message_id
            )
            .unwrap()
            .load()
            .unwrap()
            .text,
            "Child original progress"
        );
        drop(db);
        drop(catalog);
        f.finish();
    }
}
#[test]
fn send_rejects_unselected_and_model_supplied_sender_before_any_message_is_accepted() {
    let f = Fixture::with_tools(
        false,
        vec![crate::message_tools::schema()],
        vec!["helper".into()],
    );
    f.prepare_policy(0, "http://127.0.0.1:1/unused");
    let start = f.start(0);
    let context = FrozenToolContext {
        run_id: f.run.id.clone(),
        origin: ToolOrigin::ModelStep {
            request_id: "not-admitted".into(),
        },
        tools: Arc::new(start.binding.tools.clone()),
        tool_schema_generation: start.binding.tool_schema_generation,
        source: f.original.source.clone(),
        child_dispatch: None,
        resource_checkpoint_id: None,
        resource_activations: vec![],
    };
    let call = ToolCall {
        call_id: "reject".into(),
        name: "send".into(),
        schema_version: "1".into(),
        arguments: json!({"targetThreadId":"thread:parent","targetBranchId":"branch:parent","kind":"inform","text":"not selected"}),
    };
    assert!(start
        .tools
        .prepare(&call, &context, &CancellationToken::default())
        .is_err());
    assert!(!start.binding.tools.iter().any(|tool| tool.name == "send"));
    drop(start);
    let f = f.reopen();
    let start = f.start(0);
    assert!(!start.binding.tools.iter().any(|tool| tool.name == "send"));
    drop(start);
    f.finish();
    let f = Fixture::with_tools(
        false,
        vec![crate::message_tools::schema()],
        vec!["send".into()],
    );
    execute(
        &f,
        true,
        vec![ToolCall {
            call_id: "reject".into(),
            name: "send".into(),
            schema_version: "1".into(),
            arguments: json!({"targetThreadId":"thread:parent","targetBranchId":"branch:parent","kind":"inform","text":"forged user","actor":{"kind":"user"}}),
        }],
        &mut OwnerReplies::default(),
        false,
    );
    assert!(f
        .catalog()
        .lock()
        .unwrap()
        .capture_message_list(
            "thread:parent".into(),
            "branch:parent".into(),
            MessageDirection::Incoming,
            None,
            None
        )
        .unwrap()
        .load(&|| false)
        .unwrap()
        .messages
        .is_empty());
    f.finish();
}
