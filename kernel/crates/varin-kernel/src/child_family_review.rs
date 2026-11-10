//! Real child RunAssembly and actual ModelStep/PolicyAction invoke the same family reader.
use super::*;
fn family_fixture(selected: Vec<String>) -> Fixture {
    Fixture::with_tools(false, crate::family_tools::schemas(), selected)
}
fn family_calls() -> Vec<ToolCall> {
    [("threads",json!({})),
  ("read_thread",json!({"threadId":"thread:parent","branchId":"branch:parent","query":{"kind":"recent","limit":2}})),
  ("read_thread",json!({"query":{"kind":"runs","limit":1}})),
 ].into_iter().enumerate().map(|(n,(name,arguments))|ToolCall{call_id:format!("family-{n}"),name:name.into(),schema_version:crate::family_tools::schemas().into_iter().find(|schema|schema.name==name).unwrap().version,arguments}).collect()
}
#[test]
fn selected_family_tools_execute_from_real_model_and_policy_origins() {
    for model in [true, false] {
        let f = family_fixture(vec!["threads".into(), "read_thread".into()]);
        let mut calls = family_calls();
        let item_id = f.catalog().lock().unwrap().history("branch:parent").unwrap().last().unwrap().id.clone();
        calls.push(ToolCall { call_id: "read-original-item".into(), name: "read_thread".into(), schema_version: "2".into(),
            arguments: json!({"threadId":"thread:parent","branchId":"branch:parent","query":{"kind":"item","itemId":item_id,"maxBytes":512}}) });
        let output_id = {
            let catalog = f.catalog();
            let mut db = catalog.lock().unwrap();
            let parent = db.history("branch:parent").unwrap().last().unwrap().clone();
            let output = json!({"id":"output-page","provenance":{"kind":"assistant"},"opaque":null,
                "content":{"kind":"output","output":{"data":{"records":[{"body":"whole row"}]},"parts":[]}}});
            let epoch = db.epoch();
            db.append_history(&parent.run_id, epoch, Some(&parent.id), varin_runtime::HistorySource::Assistant, output, None).unwrap().id
        };
        calls.push(ToolCall { call_id:"read-output".into(), name:"read_thread".into(), schema_version:"2".into(),
            arguments:json!({"threadId":"thread:parent","branchId":"branch:parent","query":{"kind":"output","itemId":output_id,"pointer":"/data/records","maxBytes":1}}) });
        let original_command = "printf '原文🙂'\n".repeat(800);
        let observation_id = {
            use varin_runtime::catalog::context_observations::{ContextObservationCaptureBatch, ContextObservationSources};
            let catalog = f.catalog();
            let mut db = catalog.lock().unwrap();
            // The delegated child uses a fixed branch, which correctly rejects live
            // external captures. Its parent has a separate ordinary live-source branch.
            let branch="branch:observations";
            let head=db.head("branch:parent").unwrap();
            db.fork_branch("branch:parent",branch,head.as_deref()).unwrap();
            let binding:RequestBinding=serde_json::from_value(json!({"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"fixture","provider_family":"fixture","model":"fixture","credential_ref":null,"configuration_generation":1,"tool_schema_generation":1,"tools":[],"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":branch,"ancestor_id":null,"leaf_id":head}})).unwrap();
            let source=serde_json::from_value(json!({"resource_owner":{"kind":"local"},"mode":"live_root","workspace_id":"workspace-live","execution_workspace_id":"workspace-live","branch_id":null,"revision":null,"live_root":{"hostId":"host","rootId":"live","canonicalRoot":"/workspace-live"}})).unwrap();
            let launch=LaunchSelection::from_binding(&binding,PolicyIdentity{name:"default".into(),version:"1".into()},Some(source));
            let run=db.submit_with_launch(&varin_runtime::SubmitInput{key:"live-source".into(),thread_id:"thread:parent".into(),branch_id:branch.into(),expected_head:head,input:json!("Observe local changes"),configuration:json!({})},Some(launch)).unwrap();
            let owner = db.context_observation_sources(&ContextObservationSources {run_id:Some(run.run_id.clone())}).unwrap().into_iter().find(|owner|owner.run_id==run.run_id).unwrap();
            let command:ContextObservationCaptureBatch=serde_json::from_value(json!({"owner":owner,"captures":[{"captureId":"original-command","event":{"kind":"command","at":100,"source":"user","body":{"terminalId":"terminal","commandId":"command","command":original_command,"exitCode":7}}}]})).unwrap();
            let prepared=db.prepare_context_observation_captures(command).unwrap().load().unwrap();
            let receipt=db.admit_context_observation_captures(prepared).unwrap().remove(0);
            assert!(receipt.representation.omitted);
            let epoch=db.epoch();let head=db.head(branch).unwrap();
            let prepared=db.prepare_input_delivery(&run.run_id,epoch,head.as_deref()).unwrap().load().unwrap();
            assert!(db.admit_input_delivery(prepared).unwrap().is_some());
            receipt.id
        };
        calls.push(ToolCall {call_id:"read-observation-original".into(),name:"read_thread".into(),schema_version:"2".into(),
            arguments:json!({"threadId":"thread:parent","branchId":"branch:observations","query":{"kind":"observation","observationId":observation_id,"maxBytes":65536}})});
        let mut owner = OwnerReplies::default();
        execute(&f, model, calls.clone(), &mut owner, false);
        assert!(
            owner.queries.is_empty(),
            "conversation reads need no source/memory/plan service access"
        );
        let catalog = f.catalog();
        let db = catalog.lock().unwrap();
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
            assert_eq!(results.len(), 6);
            for result in &results {
                let ToolCompletion::Result {
                    outcome,
                    effect,
                    content,
                } = &result.completion
                else {
                    panic!("expected result")
                };
                assert_eq!(*outcome, Outcome::Succeeded, "{content:?}");
                assert_eq!(*effect, Effect::None);
                assert!(
                    content.data["trust"]
                        .as_str()
                        .unwrap()
                        .contains("other-agent")
                );
            }
            let ToolCompletion::Result { content, .. } = &results[0].completion else {
                unreachable!()
            };
            assert_eq!(content.data["page"]["members"].as_array().unwrap().len(), 1);
            assert_eq!(content.data["page"]["current"]["branchId"], f.run.branch_id);
            assert_eq!(content.data["page"]["current"]["threadId"], f.run.thread_id);
            assert_eq!(
                content.data["page"]["members"][0]["threadId"],
                "thread:parent"
            );
            let ToolCompletion::Result { content, .. } = &results[1].completion else {
                unreachable!()
            };
            assert!(content.data["page"]["items"].as_array().unwrap().len() > 0);
            assert_eq!(content.data["page"]["threadId"], "thread:parent");
            let ToolCompletion::Result { content, .. } = &results[2].completion else { unreachable!() };
            assert_eq!(content.data["page"]["branchId"], f.run.branch_id);
            let ToolCompletion::Result { content, .. } = &results[3].completion else { unreachable!() };
            assert_eq!(content.data["page"]["itemId"], item_id);
            assert!(content.data["page"]["anchor"].as_str().is_some());
            let ToolCompletion::Result { content, .. } = &results[4].completion else { unreachable!() };
            assert_eq!(content.data["page"]["format"], "records");
            assert_eq!(content.data["page"]["value"], json!([{"body":"whole row"}]));
            let ToolCompletion::Result {content,..}=&results[5].completion else {unreachable!()};
            assert_eq!(content.data["page"]["format"],"environment_observation_json");
            assert_eq!(content.data["page"]["observationId"],observation_id);
            assert!(content.data["page"]["nextOffset"].is_null());
            let raw:Value=serde_json::from_str(content.data["page"]["text"].as_str().unwrap()).unwrap();
            assert_eq!(raw["body"]["command"],original_command);
            assert_eq!(raw["body"]["exitCode"],7);
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
            assert_eq!(receipts.len(), 6);
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
        drop(catalog);
        f.finish();
    }
}
#[test]
fn available_family_capabilities_do_not_enter_unselected_child_or_restore() {
    let f = family_fixture(vec!["helper".into()]);
    f.prepare_policy(0, "http://127.0.0.1:1/unused");
    let start = f.start(0);
    let context = FrozenToolContext { tool_output_visible_bytes: None, execution_environment: None, direct_tools: None,
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

#[test]
fn original_family_item_and_continuation_references_are_directly_consumable() {
    use varin_runtime::catalog::{family::{ItemRequest,ReadRequest,FamilyReadQuery},model_references::ReferenceKind};
    let f=family_fixture(vec!["read_thread".into()]);
    let (item_ref,next_ref,first_text,next_text)={
        let catalog=f.catalog();let mut db=catalog.lock().unwrap();
        let page=db.capture_family_read(&f.run.thread_id,Some("thread:parent"),Some("branch:parent")).unwrap()
            .read(ReadRequest {run_id:None,anchor:None,cursor:None,query:FamilyReadQuery::Recent{limit:Some(1),max_item_bytes:Some(16)}},&||false).unwrap();
        let item=page.items[0].id.clone();
        let first=db.capture_family_read(&f.run.thread_id,Some("thread:parent"),Some("branch:parent")).unwrap()
            .item(ItemRequest{run_id:None,anchor:Some(page.anchor.clone()),item_id:item.clone(),offset:None,max_bytes:Some(31)},&||false).unwrap();
        let second=db.capture_family_read(&f.run.thread_id,Some("thread:parent"),Some("branch:parent")).unwrap()
            .item(ItemRequest{run_id:None,anchor:Some(page.anchor.clone()),item_id:item.clone(),offset:first.next_offset,max_bytes:Some(31)},&||false).unwrap();
        let mut args=json!({"threadId":"thread:parent","branchId":"branch:parent","anchor":page.anchor,"query":{"kind":"item","itemId":item,"maxBytes":31}});
        let target=db.model_history_read_target("read_thread",&args).unwrap();
        let first_ref=db.register_model_reference(ReferenceKind::Item,"history",&target,&f.run.id).unwrap();
        args["query"]["offset"]=json!(first.next_offset.unwrap());
        let target=db.model_history_read_target("read_thread",&args).unwrap();
        let next_ref=db.register_model_reference(ReferenceKind::Read,"history",&target,&f.run.id).unwrap();
        (first_ref,next_ref,first.text,second.text)
    };
    let calls=[item_ref,next_ref].into_iter().enumerate().map(|(index,reference)|ToolCall{call_id:format!("short-history-{index}"),name:"read_thread".into(),schema_version:"2".into(),arguments:json!({"ref":reference})}).collect();
    execute(&f,true,calls,&mut OwnerReplies::default(),false);
    let catalog=f.catalog();let db=catalog.lock().unwrap();
    let results=db.history(&f.run.branch_id).unwrap().into_iter()
        .filter_map(|item|serde_json::from_value::<ConversationItem>(item.content).ok())
        .filter_map(|item|if let Content::ToolResult{result}=item.content {Some(result)}else{None}).collect::<Vec<_>>();
    assert_eq!(results.len(),2);
    for (result,expected) in results.iter().zip([first_text,next_text]) {
        let ToolCompletion::Result{outcome,content,..}=&result.completion else {panic!("read result")};
        assert_eq!(*outcome,Outcome::Succeeded,"{content:?}");
        assert_eq!(content.data["page"]["text"],expected);
        let model=content.model_data.as_ref().unwrap();
        assert!(model["page"]["anchor"].is_null());
        if content.data["page"]["nextOffset"].is_null() {
            assert!(model["page"]["nextRead"].is_null(),"the last page must not invent a continuation");
        } else {
            assert!(model["page"]["nextRead"]["arguments"]["ref"].as_str().unwrap().starts_with("read:"));
        }
    }
    drop(db);drop(catalog);f.finish();
}

#[test]
fn native_execution_references_read_the_exact_original_run_and_list_as_usable_targets() {
    let f=family_fixture(vec!["read_thread".into()]);
    let (execution,original_run)={
        let catalog=f.catalog();let db=catalog.lock().unwrap();
        let original=db.history("branch:parent").unwrap().last().unwrap().run_id.clone();
        (db.execution_reference(&original).unwrap().reference,original)
    };
    let calls=vec![
        ToolCall{call_id:"native-exact-thread".into(),name:"read_thread".into(),schema_version:"2".into(),arguments:json!({"threadId":execution,"query":{"kind":"recent","limit":20}})},
        ToolCall{call_id:"native-exact-run".into(),name:"read_thread".into(),schema_version:"2".into(),arguments:json!({"runId":execution,"query":{"kind":"overview"}})},
        ToolCall{call_id:"native-runs".into(),name:"read_thread".into(),schema_version:"2".into(),arguments:json!({"threadId":"thread:parent","query":{"kind":"runs"}})},
    ];
    execute(&f,true,calls,&mut OwnerReplies::default(),false);
    let catalog=f.catalog();let db=catalog.lock().unwrap();
    let results=db.history(&f.run.branch_id).unwrap().into_iter().filter_map(|item|serde_json::from_value::<ConversationItem>(item.content).ok())
        .filter_map(|item|if let Content::ToolResult{result}=item.content {Some(result)}else{None}).collect::<Vec<_>>();
    assert_eq!(results.len(),3);
    for result in &results {let ToolCompletion::Result{outcome,content,..}=&result.completion else {panic!("read result")};assert_eq!(*outcome,Outcome::Succeeded,"{content:?}");}
    let ToolCompletion::Result{content,..}=&results[0].completion else {unreachable!()};
    assert_eq!(content.data["page"]["runId"],original_run);
    let ToolCompletion::Result{content,..}=&results[1].completion else {unreachable!()};
    assert_eq!(content.model_data.as_ref().unwrap()["page"]["executions"][0]["ref"],execution);
    let ToolCompletion::Result{content,..}=&results[2].completion else {unreachable!()};
    let runs=content.model_data.as_ref().unwrap()["page"]["runs"].as_array().unwrap();
    assert!(runs.iter().any(|run|run["ref"]==execution && run["nextRead"]["arguments"]["threadId"]==execution));
    assert!(runs.iter().all(|run|run["runId"].is_null() && run["branchId"].is_null()));
    drop(db);drop(catalog);f.finish();
}
