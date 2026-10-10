//! Real child RunAssembly and actual ModelStep/PolicyAction invoke the same family reader.
use super::*;
fn family_fixture(selected: Vec<String>) -> Fixture {
    Fixture::with_tools(false, crate::family_tools::schemas(), selected)
}
fn family_calls() -> Vec<ToolCall> {
    [("threads",json!({})),
  ("read_thread",json!({"threadId":"thread:parent","branchId":"branch:parent","query":{"kind":"recent","limit":2}})),
  ("read_thread",json!({"threadId":"thread:parent","branchId":"branch:parent","query":{"kind":"runs","limit":1}})),
 ].into_iter().enumerate().map(|(n,(name,arguments))|ToolCall{call_id:format!("family-{n}"),name:name.into(),schema_version:"1".into(),arguments}).collect()
}
#[test]
fn selected_family_tools_execute_from_real_model_and_policy_origins() {
    for model in [true, false] {
        let f = family_fixture(vec!["threads".into(), "read_thread".into()]);
        let calls = family_calls();
        let mut owner = OwnerReplies::default();
        execute(&f, model, calls.clone(), &mut owner, false);
        assert!(
            owner.queries.is_empty(),
            "conversation reads need no source/memory/plan service access"
        );
        let db = f.catalog();
        let db = db.lock().unwrap();
        let history = db.history(&f.run.branch_id).unwrap();
        if model {
            let results = history
                .into_iter()
                .filter_map(|item| serde_json::from_value::<ConversationItem>(item.content).ok())
                .filter_map(|item| match item.content {
                    Content::ToolResult { result } => Some(result),
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert_eq!(results.len(), 3);
            for result in &results {
                let ToolCompletion::Result {
                    outcome,
                    effect,
                    content,
                } = &result.completion
                else {
                    panic!("expected result")
                };
                assert_eq!(*outcome, Outcome::Succeeded, "{content}");
                assert_eq!(*effect, Effect::None);
                assert!(content["trust"].as_str().unwrap().contains("other-agent"));
            }
            let ToolCompletion::Result { content, .. } = &results[0].completion else {
                unreachable!()
            };
            assert_eq!(content["page"]["members"].as_array().unwrap().len(), 1);
            assert_eq!(content["page"]["members"][0]["threadId"], "thread:parent");
            let ToolCompletion::Result { content, .. } = &results[1].completion else {
                unreachable!()
            };
            assert!(content["page"]["items"].as_array().unwrap().len() > 0);
            assert_eq!(content["page"]["threadId"], "thread:parent");
        } else {
            let raw = rusqlite::Connection::open_with_flags(
                f.root.join("conversation.sqlite"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            let mut statement=raw.prepare("SELECT receipt,outcome FROM policy_graph_nodes n JOIN operations o ON o.id=n.action_id WHERE o.run_id=?1 ORDER BY o.rowid").unwrap();
            let receipts = statement
                .query_map([&f.run.id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert_eq!(receipts.len(), 3);
            for (_, outcome) in receipts {
                assert_eq!(outcome, "\"succeeded\"");
            }
            assert!(
                history
                    .iter()
                    .all(|item| item.source != varin_runtime::HistorySource::Tool),
                "private policy node results are not fabricated as conversation exchanges"
            );
        }
        drop(db);
        f.finish();
    }
}
#[test]
fn available_family_capabilities_do_not_enter_unselected_child_or_restore() {
    let f = family_fixture(vec!["helper".into()]);
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
    for call in family_calls() {
        assert!(
            start
                .tools
                .prepare(&call, &context, &CancellationToken::default())
                .is_err()
        );
    }
    assert!(
        !start
            .binding
            .tools
            .iter()
            .any(|tool| matches!(tool.name.as_str(), "threads" | "read_thread"))
    );
    drop(start);
    let f = f.reopen();
    let restored = f.start(0);
    assert!(
        !restored
            .binding
            .tools
            .iter()
            .any(|tool| matches!(tool.name.as_str(), "threads" | "read_thread"))
    );
    drop(restored);
    f.finish();
}
