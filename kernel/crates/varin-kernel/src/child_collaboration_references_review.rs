//! Real frozen child declarations consume durable collaboration receipts after reopen.
use super::*;

fn schemas(legacy: bool) -> Vec<ToolSchema> {
    let mut current = crate::collaboration::schemas(Vec::new());
    current.sort_by(|a,b| a.name.cmp(&b.name));
    if !legacy { return current; }
    // Verbatim declarations from main f81c03c87d31972146b3da01dd8dbcd700b9469c.
    // The versions match current ones; changing only a version is not an old consumer.
    let mut readers: Vec<ToolSchema> = serde_json::from_str(include_str!("../../varin-runtime/tests/fixtures/collaboration_readers_main.json")).unwrap();
    readers.push(current.into_iter().find(|schema| schema.name == "dispatch").unwrap());
    readers.sort_by(|a,b| a.name.cmp(&b.name));
    readers
}
fn prepare_source_free(db: &mut Catalog, child: &ChildTask) -> ChildTask {
    let proposal = varin_runtime::catalog::context::ContextProposal {
        key: format!("report-context:{}", child.execution_id), branch_id: child.child_branch_id.clone(),
        through_id: None, expected_revision: 0, summary: String::new(),
        effective_system_prompt: "Report original work".into(), instruction_sources: vec![], memory_checkpoint: None,
    };
    let basis = serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,
        "configurationDigest":"report-contract","memorySnapshot":{"revision":0,"memories":[]},
        "threadId":child.child_thread_id,"projectId":child.project_id,
        "originalSections":[{"name":"preamble","content":"Report original work"}],"instructionSources":[]})).unwrap();
    let prepared = db.capture_child_preparation(&child.execution_id, None, proposal, basis).unwrap().load().unwrap();
    db.admit_child(prepared).unwrap()
}
fn fixture(schemas: Vec<ToolSchema>) -> Fixture {
    let dispatch = schemas.iter().find(|schema| schema.name == "dispatch").unwrap().clone();
    let status = schemas.iter().find(|schema| schema.name == "child_status").unwrap().clone();
    let selected = schemas.clone();
    let mut parent = dispatch::Fixture::new_parent_custom(0, status, dispatch,
        false, false, false, move |input, launch| {
            input.tools = Some(selected.iter().map(|schema| schema.name.clone()).collect());
            input.work_mode = Some(varin_runtime::catalog::dispatch::ChildWorkMode::ReadOnly);
            launch.tools = selected;
            launch.source = None;
        });
    let selected = parent.db.capture_child_dispatch_invocation(&parent.context).unwrap().load().unwrap()
        .resolve(&parent.input).unwrap();
    parent.launch.tools = schemas;
    parent.launch.source = None;
    parent.launch.policy = crate::observations::default_policy_identity();
    let launch = parent.db.prepare_child_launch(&parent.context.run_id, parent.launch.clone(), selected).unwrap().load().unwrap();
    let admission = parent.db.prepare_child_admission(&parent.context, parent.input.clone(), None, launch).unwrap().load().unwrap();
    let child = parent.db.accept_child_references(admission).unwrap();
    let child = prepare_source_free(&mut parent.db, &child);
    let run = parent.db.run(&child.receipt.as_ref().unwrap().run_id).unwrap();
    let original = parent.db.launch_intent(&run.id).unwrap().unwrap().selection;
    assert!(original.source.is_none());
    let params = json!({"runId":run.id,"credentialScope":original.credential_scope});
    Fixture::from_catalog(parent.root, child, run, original, params, parent.db).reopen()
}
fn completion(request: &RequestSnapshot, step: usize) -> &varin_runtime::output::OutputBody {
    request.view.history.iter().find_map(|item| match &item.content {
        Content::ToolResult { result } if result.call_id == format!("collaboration-contract-{step}") => match &result.completion {
            ToolCompletion::JobAccepted { content: Some(content), .. }
            | ToolCompletion::Result { outcome: Outcome::Succeeded, content, .. } => Some(content),
            other => panic!("the original collaboration call must succeed: {other:?}"),
        }, _ => None,
    }).expect("the model must consume the persisted original result")
}
struct Roundtrip {
    legacy: bool,
    schemas: Vec<ToolSchema>,
    catalog: Arc<Mutex<Catalog>>,
    next: AtomicUsize,
    calls: Arc<Mutex<Vec<ToolCall>>>,
}
impl Roundtrip {
    fn finish_report(&self, visible: &Value) {
        let mut db = self.catalog.lock().unwrap();
        let operation = if self.legacy { visible["operationId"].as_str().unwrap().to_owned() }
            else { match db.resolve_execution_reference(visible["executionRef"].as_str().unwrap()).unwrap().target {
                varin_runtime::catalog::model_references::ExecutionTarget::Delegated { operation_id, .. } => operation_id,
                _ => panic!("native delegation"),
            } };
        let child = db.child_task(&operation).unwrap();
        let child = prepare_source_free(&mut db, &child);
        let run = &child.receipt.as_ref().unwrap().run_id;
        let grandchild = db.launch_intent(run).unwrap().unwrap().selection;
        for original in &self.schemas { assert!(grandchild.tools.contains(original), "default delegation must retain the exact original declaration"); }
        let epoch = db.epoch();
        db.commit_execution(run, epoch, &ExecutionRecord::StateChanged { state: RunState::Runnable, waiting_on: None }).unwrap();
        let head = db.head(&child.child_branch_id).unwrap();
        db.append_history(run, epoch, head.as_deref(), varin_runtime::HistorySource::Assistant,
            serde_json::to_value(ConversationItem { id: "original-child-answer".into(), resource_activation: None,
                provenance: Provenance::Assistant, content: Content::<varin_runtime::output::ResolvedMedia>::Text { text: "Original answer".into() }, opaque: None }).unwrap(), None).unwrap();
        db.commit_execution(run, epoch, &ExecutionRecord::StateChanged { state: RunState::Completed, waiting_on: None }).unwrap();
        db.reconcile_child_reports().unwrap();
    }
}
impl ModelProvider for Roundtrip {
    fn serialize(&self, view: &RequestView, _: Option<&mut varin_runtime::execution::RequestCompileReuse>) -> Result<varin_runtime::execution::RequestBody, ExecutionError> {
        Ok(serde_json::to_value(view).unwrap().into())
    }
    fn generate(&self, request: &RequestSnapshot, _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>) -> Result<FinishReason, ModelFailure> {
        for schema in &self.schemas { assert!(request.view.binding.tools.contains(schema)); }
        let step = self.next.fetch_add(1, Ordering::SeqCst);
        let (name, arguments) = match step {
            0 => ("dispatch", json!({"task":"Return the original answer", "workMode":"read_only"})),
            1 => {
                let receipt = completion(request, 0);
                let visible = receipt.model_data();
                if self.legacy {
                    assert_eq!(visible, &receipt.data);
                    assert!(visible["operationId"].is_string());
                } else {
                    assert!(visible["operationId"].is_null());
                    assert!(visible["read"]["arguments"]["target"].is_string());
                }
                self.finish_report(visible);
                ("child_status", if self.legacy {json!({"operationId":visible["operationId"]})}
                    else {visible["read"]["arguments"].clone()})
            }
            2 => {
                let status = completion(request, 1);
                let visible = status.model_data();
                let mut arguments = if self.legacy {
                    assert_eq!(visible, &status.data);
                    json!({"operationId":visible["operation_id"], "itemId":visible["report"]["history_ids"][0]})
                } else {
                    assert!(visible["report"]["history_ids"].is_null());
                    visible["nextRead"]["arguments"].clone()
                };
                arguments["maxBytes"] = json!(8);
                ("child_report", arguments)
            }
            3 => {
                let page = completion(request, 2).model_data();
                assert_eq!(page["page"]["text"], "Original");
                ("child_report", if self.legacy {
                    json!({"operationId":page["page"]["operation_id"],"itemId":page["page"]["item_id"],"offset":page["page"]["next_offset"]})
                } else { page["nextRead"]["arguments"].clone() })
            }
            _ => {
                assert_eq!(completion(request, 3).model_data()["page"]["text"], " answer");
                emit(ProviderEvent::ItemCompleted { item: ProviderItem { id: request.view.request_id.clone(), opaque: None,
                    content: Content::Text { text: "Original collaboration contracts remain usable".into() } } }).unwrap();
                return Ok(FinishReason::Stop);
            }
        };
        let schema = self.schemas.iter().find(|schema| schema.name == name).unwrap();
        let fields = arguments.as_object().unwrap();
        let properties = schema.schema["properties"].as_object().unwrap();
        for field in fields.keys() { assert!(properties.contains_key(field), "undeclared argument {field}"); }
        for field in schema.schema["required"].as_array().into_iter().flatten() {
            assert!(fields.contains_key(field.as_str().unwrap()), "missing required argument {field}");
            assert!(fields[field.as_str().unwrap()].is_string());
        }
        let call = ToolCall { call_id: format!("collaboration-contract-{step}"), name:name.into(), schema_version:schema.version.clone(), arguments };
        self.calls.lock().unwrap().push(call.clone());
        emit(ProviderEvent::ItemCompleted { item: ProviderItem { id: request.view.request_id.clone(), opaque: None, content:Content::ToolCall {call} } }).unwrap();
        Ok(FinishReason::ToolCalls)
    }
}
#[test]
fn frozen_collaboration_readers_roundtrip_dispatch_status_and_report_after_reopen() {
    for legacy in [true, false] {
        let schemas = schemas(legacy);
        let f = fixture(schemas.clone());
        let calls = Arc::new(Mutex::new(Vec::new()));
        let provider = Arc::new(Roundtrip {legacy, schemas, catalog:f.catalog(), next:AtomicUsize::new(0), calls:calls.clone()});
        let count = vec![ToolCall {call_id:String::new(), name:String::new(), schema_version:String::new(), arguments:Value::Null}; 4];
        let expected_model = varin_runtime::catalog::dispatch::ChildModelBinding {
            configuration: serde_json::from_value(f.run.configuration.clone()).unwrap(),
            credential_scope: f.original.credential_scope.clone(),
        };
        assert!(expected_model.credential_scope.is_some());
        let mut retained = None;
        let mut released = false;
        // This controlled Host acknowledgement retains only the exact original model
        // credentials. No extension, MCP or source capability is granted by the fixture.
        execute_with_provider_frames(&f, true, count, &mut OwnerReplies::default(), false, provider, &mut |f, frame| {
            match frame["kind"].as_str().unwrap() {
                "host-tool-child-retain" => {
                    assert_eq!(frame["kernelEpoch"], EPOCH);
                    assert_eq!(frame["parentRunId"], f.run.id);
                    assert_eq!(frame["extensionBindings"], json!([]));
                    assert!(frame["mcpBinding"].is_null());
                    assert_eq!(frame["modelBinding"], serde_json::to_value(&expected_model).unwrap());
                    let operation_id = frame["childOperationId"].as_str().unwrap();
                    let catalog = f.catalog();
                    let db = catalog.lock().unwrap();
                    let operation = db.operation(operation_id).unwrap();
                    assert_eq!(operation.run_id, f.run.id);
                    assert_eq!(operation.intent["call"]["name"], "dispatch");
                    assert_eq!(operation.intent["call"]["call_id"], "collaboration-contract-0");
                    assert_eq!(frame["executionOwner"], json!(operation.execution_owner));
                    assert_eq!(frame["executionEpoch"], operation.epoch);
                    assert!(db.child_task(operation_id).is_err(), "retention must precede child acceptance");
                    assert!(retained.replace(operation_id.to_owned()).is_none(), "one original dispatch retention");
                    drop(db);
                    f.assembly.tools.bridge().receive(json!({"v":1,"kind":"host-tool-response","id":frame["id"],"kernelEpoch":EPOCH,"ok":true}));
                    true
                }
                "host-tool-child-release" => {
                    assert_eq!(frame["kernelEpoch"], EPOCH);
                    assert_eq!(frame["parentRunId"], f.run.id);
                    assert_eq!(frame["childOperationId"], json!(retained));
                    assert!(!released, "release only the exact retained dependency once");
                    released = true;
                    true
                }
                _ => false,
            }
        });
        assert!(retained.is_some());
        assert!(!released, "successful admission hands retention to the accepted child");
        let f = f.reopen();
        let catalog = f.catalog();
        let db = catalog.lock().unwrap();
        let history = db.execution_history(&f.run.branch_id).unwrap();
        for call in calls.lock().unwrap().iter() {
            assert!(history.iter().any(|item| matches!(&item.content, Content::ToolCall {call: original} if original == call)));
        }
        assert_eq!(db.launch_intent(&f.run.id).unwrap().unwrap().selection.tools, f.original.tools);
        drop(db); drop(catalog); f.finish();
    }
}
