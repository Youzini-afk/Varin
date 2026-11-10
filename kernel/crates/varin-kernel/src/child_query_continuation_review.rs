//! Actual frozen children consume model-visible pages, not handcrafted continuation DTOs.
use super::*;
#[allow(dead_code)]
#[path = "fixtures/query_schemas_v93.rs"]
mod original;

type Step = Box<dyn Fn(&RequestSnapshot) -> (String, Value) + Send + Sync>;
struct QuerySequence { schemas: Vec<ToolSchema>, steps: Vec<Step>, next: AtomicUsize }
fn accepts(schema: &Value, value: &Value) -> bool {
    if schema.get("const").is_some_and(|expected| expected != value) { return false; }
    if schema["enum"].as_array().is_some_and(|values| !values.contains(value)) { return false; }
    if schema["required"].as_array().is_some_and(|keys| keys.iter().any(|key| value.get(key.as_str().unwrap()).is_none())) { return false; }
    if let Some(properties) = schema["properties"].as_object() {
        let Some(fields) = value.as_object() else { return false; };
        if schema["additionalProperties"] == false && fields.keys().any(|key| !properties.contains_key(key)) { return false; }
        if fields.iter().any(|(key, value)| properties.get(key).is_some_and(|schema| !accepts(schema, value))) { return false; }
    }
    if schema["oneOf"].as_array().is_some_and(|variants| variants.iter().filter(|schema| accepts(schema, value)).count() != 1) { return false; }
    if schema["anyOf"].as_array().is_some_and(|variants| !variants.iter().any(|schema| accepts(schema, value))) { return false; }
    true
}
fn output(request: &RequestSnapshot, step: usize) -> &varin_runtime::output::OutputBody {
    let result = request.view.history.iter().find_map(|item| match &item.content {
        Content::ToolResult { result } if result.call_id == format!("query-contract-{step}") => Some(&result.completion),
        _ => None,
    }).expect("the next model step must consume the persisted original result");
    match result {
        ToolCompletion::Result { outcome: Outcome::Succeeded, content, .. }
        | ToolCompletion::JobAccepted { content: Some(content), .. } => content,
        _ => panic!("original query failed: {result:?}"),
    }
}
fn initial(name: &str, arguments: Value) -> Step {
    let name = name.to_owned();
    Box::new(move |_| (name.clone(), arguments.clone()))
}
impl ModelProvider for QuerySequence {
    fn serialize(&self, view: &RequestView, _: Option<&mut varin_runtime::execution::RequestCompileReuse>) -> Result<varin_runtime::execution::RequestBody, ExecutionError> {
        Ok(serde_json::to_value(view).unwrap().into())
    }
    fn generate(&self, request: &RequestSnapshot, _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>) -> Result<FinishReason, ModelFailure> {
        for schema in &self.schemas { assert!(request.view.binding.tools.contains(schema)); }
        let step = self.next.fetch_add(1, Ordering::SeqCst);
        let call = self.steps.get(step).map(|make| {
            let (name, arguments) = make(request);
            let schema = self.schemas.iter().find(|schema| schema.name == name).unwrap();
            assert!(accepts(&schema.schema, &arguments), "call must be expressible using the original declaration: {name} {arguments}");
            ToolCall { call_id: format!("query-contract-{step}"), name,
                schema_version: schema.version.clone(), arguments }
        });
        if call.is_none() { for step in 0..self.steps.len() { output(request, step); } }
        let called = call.is_some();
        emit(ProviderEvent::ItemCompleted { item: ProviderItem { id: request.view.request_id.clone(), opaque: None,
            content: call.map_or(Content::Text { text: "The original reader completed its continuation".into() }, |call| Content::ToolCall { call }) } }).unwrap();
        Ok(if called { FinishReason::ToolCalls } else { FinishReason::Stop })
    }
}
fn run_sequence(f: &Fixture, schemas: Vec<ToolSchema>, steps: Vec<Step>) {
    let schemas=schemas.into_iter().filter(|schema|f.original.tools.contains(schema)).collect();
    let count = vec![ToolCall { call_id: String::new(), name: String::new(), schema_version: String::new(), arguments: Value::Null }; steps.len()];
    execute_with_provider(f, true, count, &mut OwnerReplies::default(), false,
        Arc::new(QuerySequence { schemas, steps, next: AtomicUsize::new(0) }));
}
fn retained(f: &Fixture, step: usize) -> varin_runtime::output::OutputBody {
    f.catalog().lock().unwrap().execution_history(&f.run.branch_id).unwrap().into_iter().find_map(|item| match &item.content {
        Content::ToolResult { result } if result.call_id == format!("query-contract-{step}") => match &result.completion {
            ToolCompletion::Result { outcome: Outcome::Succeeded, content, .. }
            | ToolCompletion::JobAccepted { content: Some(content), .. } => Some(content.clone()),
            other => panic!("query completion: {other:?}"),
        }, _ => None,
    }).unwrap()
}

#[test]
fn frozen_family_queries_continue_visible_cursors_and_offsets_after_reopen() {
    for legacy in [true, false] {
        let schemas = if legacy { original::family_schemas() } else { crate::family_tools::schemas() };
        let f = Fixture::with_tools(false, schemas.clone(), vec!["threads".into(), "read_thread".into()]);
        let item = {
            let catalog=f.catalog(); let mut db=catalog.lock().unwrap();
            let parent=db.history("branch:parent").unwrap().last().unwrap().clone();
            let epoch=db.epoch();
            db.append_history(&parent.run_id,epoch,Some(&parent.id),varin_runtime::HistorySource::Assistant,
                json!({"id":"original-large-history","provenance":{"kind":"assistant"},"opaque":null,
                    "content":{"kind":"text","text":"Original UTF-8 history 原文🙂 ".repeat(100)}}),None).unwrap().id
        };
        let f = f.reopen();
        let mut steps = vec![initial("threads", json!({"includeSelf":true,"limit":1}))];
        steps.push(Box::new(move |request| {
            let page=&output(request,0).model_data()["page"];
            let arguments=if legacy { assert!(page["nextCursor"].is_string()); json!({"includeSelf":true,"limit":1,"cursor":page["nextCursor"]}) }
                else { assert!(page.get("nextCursor").is_none()); page["nextRead"]["arguments"].clone() };
            ("threads".into(),arguments)
        }));
        steps.push(initial("read_thread",json!({"threadId":"thread:parent","branchId":"branch:parent","query":{"kind":"recent","limit":1}})));
        steps.push(Box::new(move |request| {
            let page=&output(request,2).model_data()["page"];
            let arguments=if legacy { assert!(page["anchor"].is_string()); assert!(page["nextCursor"].is_string());
                json!({"threadId":page["threadId"],"branchId":page["branchId"],"anchor":page["anchor"],"cursor":page["nextCursor"],"query":{"kind":"recent","limit":1}}) }
                else { assert!(page.get("anchor").is_none()); page["nextRead"]["arguments"].clone() };
            ("read_thread".into(),arguments)
        }));
        steps.push(initial("read_thread",json!({"threadId":"thread:parent","branchId":"branch:parent","query":{"kind":"item","itemId":item,"maxBytes":31}})));
        steps.push(Box::new(move |request| {
            let page=&output(request,4).model_data()["page"];
            let arguments=if legacy { assert!(page["nextOffset"].as_u64().unwrap()>0);
                json!({"threadId":page["threadId"],"branchId":page["branchId"],"anchor":page["anchor"],
                    "query":{"kind":"item","itemId":page["itemId"],"offset":page["nextOffset"],"maxBytes":31}}) }
                else { assert!(page["ref"].is_string()); page["nextRead"]["arguments"].clone() };
            ("read_thread".into(),arguments)
        }));
        run_sequence(&f, schemas, steps);
        let f=f.reopen();
        assert_ne!(retained(&f,0).data["page"]["members"][0]["threadId"],retained(&f,1).data["page"]["members"][0]["threadId"]);
        assert_ne!(retained(&f,2).data["page"]["items"][0]["id"],retained(&f,3).data["page"]["items"][0]["id"]);
        assert_eq!(retained(&f,5).data["page"]["offset"],retained(&f,4).data["page"]["nextOffset"]);
        assert_eq!(f.catalog().lock().unwrap().launch_intent(&f.run.id).unwrap().unwrap().selection.tools,f.original.tools);
        f.finish();
    }
}

#[test]
fn frozen_followup_queries_continue_original_occurrences_after_reopen() {
    use varin_runtime::catalog::followups::*;
    for legacy in [true,false] {
        let schema=if legacy {original::followup_schema()} else {crate::followup_tools::schema()};
        let f=Fixture::with_tools(false,vec![schema.clone()],vec!["follow_up".into()]);
        let job=accepted_family_job(&f,"original-query-pages");
        let id={
            let owner=f.catalog();let mut db=owner.lock().unwrap();
            let p=db.prepare_followup_registration("original-query-log",&f.run.id,FollowupRegistration {
                repeat:FollowupRepeat::Each,trigger:FollowupRegistrationTrigger::LogLiteral {
                    operation_id:job.operation_id.clone(),stream:LogStream::Stdout,literal:"record".into(),from_offset:None},
                instruction:"Inspect every original record".into(),wait:None}).unwrap().load().unwrap();
            let admitted=db.admit_followup_registration(p).unwrap();
            for n in 0..66u64 {
                let work=db.followup_research_works(None).unwrap().0.into_iter().find(|work|work.key.followup_id==admitted.followup.id).unwrap();
                let expected=work.log.clone().unwrap();let end=(n+1)*6;
                db.apply_log_observation(FollowupLogObservation {key:work.key,binding:job.clone(),expected,
                    next:FollowupLogState {offset:end,matched_prefix:0,ended:false,failure_code:None},
                    evidence:Some(FollowupLogEvidence::LogLiteral {binding:job.clone(),stream:LogStream::Stdout,
                        start_offset:n*6,end_offset:end,published_bytes:end,job_revision:n+2})}).unwrap();
            }
            admitted.followup.id
        };
        let f=f.reopen();
        let continuation_id=id.clone();let occurrence_id=id.clone();
        let steps=vec![initial("follow_up",json!({"action":"occurrences","followupId":id})),
            Box::new(move |request:&RequestSnapshot| {
                let page=output(request,0).model_data();
                let arguments=if legacy {assert!(page["nextCursor"].is_u64());json!({"action":"occurrences","followupId":continuation_id,"after":page["nextCursor"]})}
                    else {assert!(page.get("nextCursor").is_none());page["nextRead"]["arguments"].clone()};
                ("follow_up".into(),arguments)
            }) as Step,
            Box::new(move |request:&RequestSnapshot| {
                let page=output(request,1).model_data();assert_eq!(page["occurrences"].as_array().unwrap().len(),2);
                let arguments=if legacy {json!({"action":"occurrence","followupId":occurrence_id,"occurrenceId":page["occurrences"][0]["id"]})}
                    else {page["occurrences"][0]["read"]["arguments"].clone()};
                ("follow_up".into(),arguments)
            }) as Step];
        run_sequence(&f,vec![schema],steps);
        let f=f.reopen();
        assert_eq!(retained(&f,0).data["occurrences"].as_array().unwrap().len(),64);
        assert_eq!(retained(&f,1).data["occurrences"][0]["id"],retained(&f,2).data["occurrence"]["id"]);
        assert_eq!(f.catalog().lock().unwrap().launch_intent(&f.run.id).unwrap().unwrap().selection.tools,f.original.tools);
        f.finish();
    }
}

#[test]
fn frozen_message_receipts_advertise_a_declared_family_reader() {
    for legacy in [true,false] {
        let mut schemas=if legacy {original::family_schemas()} else {crate::family_tools::schemas()};
        schemas.push(crate::message_tools::schema());schemas.sort_by(|a,b|a.name.cmp(&b.name));
        let f=Fixture::with_tools(false,schemas.clone(),vec!["send".into(),"read_thread".into()]).reopen();
        let steps=vec![initial("send",json!({"targetThreadId":"thread:parent","targetBranchId":"branch:parent","kind":"inform","text":"The original child can still inspect its recipient"})),
            Box::new(move |request:&RequestSnapshot| {
                let message=&output(request,0).model_data()["message"];
                assert!(message["ref"].as_str().unwrap().starts_with("msg:"));
                if legacy {assert!(message["nextRead"]["arguments"].get("ref").is_none());}
                else {assert!(message["nextRead"]["arguments"]["ref"].is_string());}
                ("read_thread".into(),message["nextRead"]["arguments"].clone())
            }) as Step];
        run_sequence(&f,schemas,steps);f.finish();
    }
}

#[test]
fn frozen_family_directory_only_advertises_an_original_overview_reader() {
    for reader in ["absent", "legacy", "current"] {
        let mut schemas = crate::family_tools::schemas();
        if reader == "legacy" {
            schemas.retain(|schema| schema.name != "read_thread");
            schemas.push(original::family_schemas().into_iter().find(|schema| schema.name == "read_thread").unwrap());
        }
        schemas.push(crate::message_tools::schema());
        schemas.sort_by(|a,b| a.name.cmp(&b.name));
        let mut selected = vec!["threads".into(), "send".into()];
        if reader != "absent" { selected.push("read_thread".into()); }
        let f = Fixture::with_tools(false, schemas.clone(), selected).reopen();
        let mut steps = vec![initial("threads", json!({"includeSelf":true,"limit":1})),
            Box::new(move |request: &RequestSnapshot| {
                let page = &output(request,0).model_data()["page"];
                for member in page["members"].as_array().unwrap() {
                    assert_eq!(member.get("nextRead").is_some(), reader == "current");
                }
                // Directory pagination is still usable without a history capability.
                assert_eq!(page["nextRead"]["tool"], "threads");
                ("threads".into(), page["nextRead"]["arguments"].clone())
            }) as Step];
        if reader == "current" {
            steps.push(Box::new(|request: &RequestSnapshot| {
                let recipe = &output(request,0).model_data()["page"]["members"][0]["nextRead"];
                assert_eq!(recipe["tool"], "read_thread");
                ("read_thread".into(), recipe["arguments"].clone())
            }));
        }
        run_sequence(&f, schemas, steps);
        let f = f.reopen();
        let raw = retained(&f,0).data;
        assert!(raw["page"]["members"][0]["threadId"].is_string());
        assert!(raw["page"]["nextCursor"].is_string());
        assert_ne!(raw["page"]["members"][0]["threadId"], retained(&f,1).data["page"]["members"][0]["threadId"]);
        assert_eq!(f.catalog().lock().unwrap().launch_intent(&f.run.id).unwrap().unwrap().selection.tools, f.original.tools);
        f.finish();
    }
}

fn prepare_family_peer(parent: &mut dispatch::Fixture, child: &ChildTask) -> ChildTask {
    let mut source = child.source.pin().unwrap().source.clone();
    source.branch_id = Some(format!("child-source:{}", child.execution_id));
    source.revision = Some(0);
    let proposal = varin_runtime::catalog::context::ContextProposal {
        key: format!("family-context:{}", child.execution_id), branch_id: child.child_branch_id.clone(),
        through_id: None, expected_revision: 0, summary: String::new(),
        effective_system_prompt: "Independent family reader".into(), instruction_sources: vec![], memory_checkpoint: None,
    };
    let basis = serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,
        "configurationDigest":"family-reader-contract","memorySnapshot":{"revision":0,"memories":[]},
        "threadId":child.child_thread_id,"projectId":child.project_id,
        "originalSections":[{"name":"preamble","content":"Independent family reader"}],"instructionSources":[]})).unwrap();
    parent.db.prepare_child(&child.operation_id, source, proposal, basis).unwrap()
}

fn family_peer_fixture(schemas: Vec<ToolSchema>, prepared: bool) -> (Fixture, ChildTask) {
    let selected = schemas.iter().map(|schema| schema.name.clone()).collect();
    let mut parent = dispatch::Fixture::new_host_child_with_native(true, false, None, selected, schemas);
    parent.launch.policy = crate::observations::default_policy_identity();
    let peer = parent.accept();
    parent.settle_policy_call(&parent.context.clone(), "preparing_child");
    let peer = if prepared {
        let peer = prepare_family_peer(&mut parent, &peer);
        let run = &peer.receipt.as_ref().unwrap().run_id;
        let epoch = parent.db.epoch();
        parent.db.commit_execution(run, epoch, &ExecutionRecord::StateChanged { state: RunState::Runnable, waiting_on: None }).unwrap();
        let head = parent.db.head(&peer.child_branch_id).unwrap();
        parent.db.append_history(run, epoch, head.as_deref(), varin_runtime::HistorySource::Assistant,
            json!({"id":"original-family-peer-answer","provenance":{"kind":"assistant"},"opaque":null,
                "content":{"kind":"text","text":"Original family peer answer 原文🙂"}}), None).unwrap();
        parent.db.commit_execution(run, epoch, &ExecutionRecord::StateChanged { state: RunState::Completed, waiting_on: None }).unwrap();
        parent.db.reconcile_child_reports().unwrap();
        parent.db.child_task(&peer.operation_id).unwrap()
    } else {
        parent.db.fail_child_preparation(&peer.execution_id, "Original family preparation failure").unwrap()
    };
    parent.context = parent.admit_policy_call(ToolCall { call_id: "family-observer-dispatch".into(), name: "dispatch".into(),
        schema_version: "1".into(), arguments: serde_json::to_value(&parent.input).unwrap() });
    parent.pin.pin_id = "family-observer-source".into();
    let observer = parent.accept();
    let child = prepare_family_peer(&mut parent, &observer);
    let run = parent.db.run(&child.receipt.as_ref().unwrap().run_id).unwrap();
    assert!(parent.db.require_delegated_parent(&run.id, &peer.operation_id, &peer.execution_id).is_err(),
        "a sibling has family read access, not the original requester report authority");
    let original = parent.db.launch_intent(&run.id).unwrap().unwrap().selection;
    let source = original.source.as_ref().unwrap();
    let params = json!({"runId":run.id,"credentialScope":original.credential_scope,
        "toolBinding":{"resourceOwner":{"kind":"local"},"grantId":"family-source-grant","runId":run.id,"threadId":run.thread_id,
            "workspaceId":source.workspace_id,"executionWorkspaceId":source.execution_workspace_id,
            "sourceMode":"fixed_branch","fileSource":{"branchId":source.branch_id,"revision":source.revision},"enabledTools":[]}});
    (Fixture::from_catalog(parent.root, child, run, original, params, parent.db).reopen(), peer)
}

#[test]
fn frozen_family_overview_continues_original_peer_history_without_report_authority() {
    for report_reader in ["absent", "legacy", "current"] {
        for prepared in [true, false] {
            let mut schemas = crate::family_tools::schemas();
            schemas.retain(|schema| schema.name == "read_thread");
            if report_reader != "absent" {
                let reports: Vec<ToolSchema> = if report_reader == "legacy" {
                    serde_json::from_str(include_str!("../../varin-runtime/tests/fixtures/collaboration_readers_main.json")).unwrap()
                } else { crate::collaboration::schemas(Vec::new()) };
                schemas.push(reports.into_iter().find(|schema| schema.name == "child_report").unwrap());
            }
            schemas.sort_by(|a,b| a.name.cmp(&b.name));
            let (f, peer) = family_peer_fixture(schemas.clone(), prepared);
            let original_report = serde_json::to_value(&peer.report).unwrap();
            let original_receipt = serde_json::to_value(&peer.receipt).unwrap();
            let mut steps = vec![initial("read_thread", json!({"threadId":peer.child_thread_id,"query":{"kind":"overview"}}))];
            if prepared {
                steps.push(Box::new(|request: &RequestSnapshot| {
                    let execution = &output(request,0).model_data()["page"]["executions"][0];
                    let recipe = &execution["nextRead"];
                    assert_eq!(recipe["tool"], "read_thread");
                    assert_eq!(recipe["arguments"]["threadId"], execution["ref"]);
                    ("read_thread".into(), recipe["arguments"].clone())
                }));
                steps.push(Box::new(|request: &RequestSnapshot| {
                    let page = &output(request,1).model_data()["page"];
                    let item = page["items"].as_array().unwrap().iter().find(|item|
                        item["body"]["content"]["text"] == "Original family peer answer 原文🙂").unwrap();
                    assert_eq!(item["nextRead"]["tool"], "read_thread");
                    ("read_thread".into(), item["nextRead"]["arguments"].clone())
                }));
            }
            run_sequence(&f, schemas, steps);
            let f = f.reopen();
            let overview = retained(&f,0);
            assert_eq!(overview.data["page"]["executions"][0]["report"], original_report);
            assert_eq!(overview.data["page"]["executions"][0]["executionId"], peer.execution_id);
            if prepared {
                assert_eq!(retained(&f,1).data["page"]["runId"], peer.receipt.as_ref().unwrap().run_id);
                let item = retained(&f,2);
                assert_eq!(item.data["page"]["format"], "conversation_json");
                let original: Value = serde_json::from_str(item.data["page"]["text"].as_str().unwrap()).unwrap();
                assert_eq!(original["content"]["text"], "Original family peer answer 原文🙂");
            } else {
                assert!(overview.data["page"]["executions"][0].get("runId").is_none());
                assert!(overview.model_data()["page"]["executions"][0]["nextRead"].is_null());
                assert!(!overview.model_data().to_string().contains("child_report"));
            }
            let catalog = f.catalog();
            let db = catalog.lock().unwrap();
            let unchanged = db.child_task(&peer.operation_id).unwrap();
            assert_eq!(serde_json::to_value(&unchanged.report).unwrap(), original_report);
            assert_eq!(serde_json::to_value(&unchanged.receipt).unwrap(), original_receipt);
            assert!(db.require_delegated_parent(&f.run.id, &peer.operation_id, &peer.execution_id).is_err());
            assert_eq!(db.launch_intent(&f.run.id).unwrap().unwrap().selection.tools, f.original.tools);
            drop(db); drop(catalog); f.finish();
        }
    }
}
