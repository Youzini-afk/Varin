//! Installed materials tool -> actual Catalog family/permission -> original Storage -> public reader.
//! Delivery is subprocess stdio; no product listener, paid model, external page or file source runs.
use super::web_domain_review::{EPOCH, Fixture, HOST, Host};
use super::*;
use crate::host_tools::ToolBridge;
use crate::storage::Storage;
use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, Instant};
use varin_runtime::catalog::collaboration::ChildTask;
use varin_runtime::catalog::launches::LaunchSelection;
use varin_runtime::execution::*;
use varin_runtime::supervisor::RunStart;
use varin_runtime::{Effect, Outcome, RunState};
#[path = "../../varin-runtime/tests/fixtures/child_dispatch.rs"]
pub(super) mod child_fixture;

struct Script {
    calls: Vec<(&'static str, Value, Outcome, Effect)>,
    results: Arc<Mutex<BTreeMap<String, Value>>>,
}
pub(super) fn substitute(value: &Value, results: &BTreeMap<String, Value>) -> Value {
    match value {
        Value::String(text) if text.starts_with('$') => {
            let (call, pointer) = text[1..].split_once(':').unwrap();
            results[call].pointer(pointer).unwrap().clone()
        }
        Value::Array(values) => {
            Value::Array(values.iter().map(|v| substitute(v, results)).collect())
        }
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(k, v)| (k.clone(), substitute(v, results)))
                .collect(),
        ),
        _ => value.clone(),
    }
}
impl ModelProvider for Script {
    fn serialize(&self, _: &RequestView, _reuse: Option<&mut varin_runtime::execution::RequestCompileReuse>) -> Result<varin_runtime::execution::RequestBody, ExecutionError> {
        Ok(json!({}).into())
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let mut results = self.results.lock().unwrap();
        for item in &request.view.history {
            if let Content::ToolResult { result } = &item.content {
                if let Some((_, _, outcome, effect)) = self
                    .calls
                    .iter()
                    .find(|(id, _, _, _)| *id == result.call_id)
                {
                    let ToolCompletion::Result {
                        outcome: actual,
                        effect: actual_effect,
                        content,
                    } = &result.completion
                    else {
                        panic!("finite materials receipt")
                    };
                    assert_eq!((*actual, *actual_effect), (*outcome, *effect), "{result:?}");
                    results.insert(result.call_id.clone(), content.data.clone());
                }
            }
        }
        let Some((id, args, _, _)) = self
            .calls
            .iter()
            .find(|(id, _, _, _)| !results.contains_key(*id))
        else {
            return Ok(FinishReason::Stop);
        };
        let schema = request
            .view
            .binding
            .tools
            .iter()
            .find(|tool| tool.name == "materials")
            .unwrap();
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: (*id).into(),
                opaque: None,
                content: Content::ToolCall {
                    call: ToolCall {
                        call_id: (*id).into(),
                        name: schema.name.clone(),
                        schema_version: schema.version.clone(),
                        arguments: substitute(args, &results),
                    },
                },
            },
        })
        .unwrap();
        Ok(FinishReason::ToolCalls)
    }
}
struct Policy {
    schema: ToolSchema,
    mutation: bool,
}
impl AgentPolicy for Policy {
    fn identity(&self) -> PolicyIdentity {
        PolicyIdentity {
            name: "default".into(),
            version: "1".into(),
        }
    }
    fn decide(
        &self,
        view: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        cancel: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        if self.mutation
            && matches!(
                event,
                PolicyEvent::ModelCompleted {
                    reason: FinishReason::Stop,
                    ..
                }
            )
        {
            return Ok(PolicyDecision {
                state: state.clone(),
                action: PolicyAction::ToolGraph {
                    nodes: vec![PolicyToolNode {
                        id: "policy-create".into(),
                        depends_on: vec![],
                        call: ToolCall {
                            call_id: "policy-create".into(),
                            name: self.schema.name.clone(),
                            schema_version: self.schema.version.clone(),
                            arguments: json!({"action":"create","name":"policy collection"}),
                        },
                    }],
                },
            });
        }
        if let PolicyEvent::ToolGraphCompleted { receipts, .. } = event {
            assert_eq!(receipts.len(), 1);
            assert_eq!(receipts[0].outcome(), Outcome::Succeeded, "{receipts:?}");
            return Ok(PolicyDecision {
                state: state.clone(),
                action: PolicyAction::Complete,
            });
        }
        DefaultAgentPolicy.decide(view, event, state, cancel)
    }
}
fn fixture(root: &Path, runtime: Arc<RunSupervisor>) -> Fixture {
    let (sender, outgoing) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(sender.into());
    bridge.initialize(EPOCH);
    let storage_root = root.join("storage");
    Fixture {
        host: Host::with_script(
            "packages/web/application-host/lib/kernel/material-collections-host.test-helper.ts",
        ),
        runtime,
        storage: Mutex::new(Storage::open(&storage_root, HOST).unwrap()),
        storage_root,
        bridge,
        outgoing,
    }
}
pub(super) fn accept(f: &mut child_fixture::Fixture, context: &ToolExecutionContext) -> ChildTask {
    let selected =
        f.db.capture_child_dispatch_invocation(context)
            .unwrap()
            .load()
            .unwrap()
            .resolve(&f.input)
            .unwrap();
    let launch =
        f.db.prepare_child_launch(&context.run_id, f.launch.clone(), selected)
            .unwrap()
            .load()
            .unwrap();
    let prepared =
        f.db.prepare_child_admission(context, f.input.clone(), None, launch)
            .unwrap()
            .load()
            .unwrap();
    f.db.accept_child_references(prepared).unwrap()
}
pub(super) fn admit_child(runtime: &Arc<RunSupervisor>, child: &ChildTask) -> String {
    let owner = runtime.catalog();
    let preparation=owner.lock().unwrap().capture_child_preparation(&child.execution_id,None,
        varin_runtime::catalog::context::ContextProposal { key:child.execution_id.clone(),branch_id:child.child_branch_id.clone(),through_id:None,
            expected_revision:0,summary:String::new(),effective_system_prompt:"Read shared material".into(),instruction_sources:vec![],memory_checkpoint:None },
        serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,"configurationDigest":"material-review","memorySnapshot":{"revision":0,"memories":[]},
            "threadId":child.child_thread_id,"projectId":null,"originalSections":[{"name":"preamble","content":"Read shared material"}],"instructionSources":[]})).unwrap()).unwrap();
    let admitted = owner
        .lock()
        .unwrap()
        .admit_child(preparation.load().unwrap())
        .unwrap();
    admitted.receipt.unwrap().run_id
}
pub(super) fn binding(runtime: &Arc<RunSupervisor>, run: &str) -> RequestBinding {
    let owner = runtime.catalog();
    let db = owner.lock().unwrap();
    let launch = db.launch_intent(run).unwrap().unwrap().selection;
    let record = db.run(run).unwrap();
    RequestBinding { tool_output_visible_bytes: None, mcp_tools: Vec::new(), execution_environment: None, direct_tools: None,
        provider_id: None,
        tokenizer: None,
        request_context: None,
        child_dispatch: db
            .launch_metadata(run)
            .unwrap()
            .unwrap()
            .dispatch_context_ref,
        goal: db.goal_binding(run).unwrap(),
        resource_activations: vec![],
        resource_checkpoint_id: None,
        connection_identity: launch.connection_identity,
        provider_family: launch.provider_family,
        model: launch.model,
        credential_ref: launch.credential_scope.map(|scope| scope.reference),
        configuration_generation: launch.configuration_generation,
        tool_schema_generation: launch.tool_schema_generation,
        tools: launch.tools,
        instruction_sources: vec![],
        memory_checkpoint: None,
        attachment_refs: vec![],
        environment_cursor: 0,
        history_range: HistoryRange {
            branch_id: record.branch_id.clone(),
            ancestor_id: None,
            leaf_id: db.head(&record.branch_id).unwrap(),
        },
    }
}
pub(super) fn next_run(runtime: &Arc<RunSupervisor>, previous: &str, key: &str) -> String {
    let old = binding(runtime, previous);
    let selected = runtime
        .catalog()
        .lock()
        .unwrap()
        .launch_intent(previous)
        .unwrap()
        .unwrap()
        .selection;
    let extension = selected.extension_bindings;
    let submission = {
        let owner = runtime.catalog();
        let db = owner.lock().unwrap();
        db.prepare_submission(
            SubmitInput {
                key: key.into(),
                thread_id: "thread:parent".into(),
                branch_id: "branch:parent".into(),
                expected_head: db.head("branch:parent").unwrap(),
                input: json!("Create original material"),
                configuration: db.run(previous).unwrap().configuration,
            },
            None,
            None,
        )
        .unwrap()
    };
    let admitted = runtime
        .catalog()
        .lock()
        .unwrap()
        .admit_submission(submission.load(None, false).unwrap())
        .unwrap();
    let mut launch = LaunchSelection::from_binding(
        &old,
        PolicyIdentity {
            name: "default".into(),
            version: "1".into(),
        },
        None,
    );
    launch.tools = extension.iter().map(|value| value.tool.clone()).collect();
    launch.tools.sort_by(|left, right| left.name.cmp(&right.name));
    launch.extension_bindings = extension;
    launch.credential_scope = selected.credential_scope;
    runtime
        .catalog()
        .lock()
        .unwrap()
        .bind_launch(&admitted.run_id, launch)
        .unwrap();
    admitted.run_id
}
fn execute(
    f: &mut Fixture,
    run: &str,
    live: Value,
    calls: Vec<(&'static str, Value, Outcome, Effect)>,
    policy_mutation: bool,
    lose_reply: bool,
) -> (BTreeMap<String, Value>, Option<String>) {
    let live = live_extension_binding(serde_json::from_value(live).unwrap()).unwrap();
    let schema = live.binding.tool.clone();
    let tools = crate::run_tools::RunTools::new(f.runtime.catalog(), f.bridge.clone());
    let prepared = tools.prepare_scope(run, vec![], None, vec![live]).unwrap();
    let executor = tools.install(run, 1, prepared).unwrap();
    let expected = calls.len();
    let results = Arc::new(Mutex::new(BTreeMap::new()));
    let execution = f
        .runtime
        .start(
            run,
            RunStart {
                binding: binding(&f.runtime, run),
                policy_state: Value::Null,
                provider: Arc::new(Script {
                    calls,
                    results: results.clone(),
                }),
                tools: executor,
                policy: Arc::new(Policy {
                    schema,
                    mutation: policy_mutation,
                }),
                context_preparation: Arc::new(NoopContextPreparation),
                progress: ProgressSink::default(),
            },
        )
        .unwrap();
    let (tx, done) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(execution.wait());
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut dropped = None;
    let report = loop {
        assert!(Instant::now() < deadline, "materials Run stalled");
        if let Ok(report) = done.try_recv() {
            break report.unwrap();
        }
        let frame = f.pump_reply(|request, result| {
            if lose_reply
                && request["method"] == "storage.record.put"
                && request["params"]["payloadJson"]
                    .as_str()
                    .is_some_and(|payload| payload.contains("lost collection"))
            {
                assert!(result.is_ok(), "commit did not occur: {result:?}");
                false
            } else {
                true
            }
        });
        if let Some(frame) = frame {
            assert!(lose_reply);
            assert!(dropped.is_none());
            dropped = Some(frame["params"]["operationId"].as_str().unwrap().to_string());
            f.bridge.close();
        }
    };
    if lose_reply {
        assert_eq!(report.state, RunState::Failed);
        assert_eq!(report.failure.as_ref().unwrap().code, "policy_failed");
    } else {
        assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
    }
    let values = results.lock().unwrap().clone();
    if !lose_reply {
        assert_eq!(
            values.len(),
            expected,
            "controlled model did not consume its actual tool results"
        );
    }
    (values, dropped)
}
#[test]
#[ignore = "requires built ordinary Web builtin and Node/tsx; original Catalog/Storage and subprocess stdio only"]
fn family_collections_share_retain_and_recover_through_original_owners() {
    let root =
        std::env::temp_dir().join(format!("varin-collections-review-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let mut f = fixture(
        &root,
        Arc::new(RunSupervisor::new(
            Catalog::open(root.join("bootstrap")).unwrap(),
        )),
    );
    let initialize = json!({"kind":"fixture-initialize","root":root,"storageRoot":f.storage_root,"epoch":EPOCH,"threadId":"thread:parent","runId":"bootstrap"});
    f.host.send(initialize.clone());
    let initial = f.receive("fixture-prepared");
    let extension: varin_runtime::catalog::launches::ExtensionToolBinding =
        serde_json::from_value(initial["live"]["binding"].clone()).unwrap();
    let dispatch = crate::child_capabilities::schemas()
        .into_iter()
        .find(|tool| tool.name == "dispatch")
        .unwrap();
    let parent_extension = extension.clone();
    let parent_dispatch = dispatch.clone();
    let mut family = child_fixture::Fixture::new_parent_custom(
        0,
        extension.tool.clone(),
        dispatch.clone(),
        false,
        false,
        false,
        move |input, launch| {
            input.task = "Consume explicitly shared materials".into();
            input.tools = Some(vec!["materials".into()]);
            launch.source = None;
            launch.tools = vec![parent_extension.tool.clone(), parent_dispatch];
            launch.extension_bindings = vec![parent_extension];
            launch.policy = PolicyIdentity {
                name: "default".into(),
                version: "1".into(),
            };
        },
    );
    family.launch.source = None;
    family.launch.tools = vec![extension.tool.clone()];
    family.launch.extension_bindings = vec![extension.clone()];
    let parent = family.context.run_id.clone();
    let context = family.context.clone();
    let b = accept(&mut family, &context);
    family.settle_exchange();
    let c_context = family.admit_policy_call(ToolCall {
        call_id: "dispatch-c".into(),
        name: dispatch.name,
        schema_version: dispatch.version,
        arguments: serde_json::to_value(&family.input).unwrap(),
    });
    let c = accept(&mut family, &c_context);
    family.settle_policy_call(&c_context, "preparing_child");
    family
        .db
        .create_thread("thread:foreign", "branch:foreign")
        .unwrap();
    let catalog_root = family.root.clone();
    f.runtime = Arc::new(RunSupervisor::new(family.db));
    f.host.send(json!({"kind":"fixture-select","threadId":"thread:parent","runId":parent,"required":[extension]}));
    let scaffold = f.receive("fixture-prepared");
    execute(
        &mut f,
        &parent,
        scaffold["live"].clone(),
        vec![],
        false,
        false,
    );
    let parent = next_run(&f.runtime, &parent, "material-input");
    f.host.send(json!({"kind":"fixture-select","threadId":"thread:parent","runId":parent,"required":[extension],"seed":true}));
    let prepared = f.receive("fixture-prepared");
    f.host.send(json!({"kind":"fixture-failed-receipt"}));
    f.receive("fixture-failed-receipt-read");
    let snapshots = &prepared["snapshots"];
    let (parent_results, _) = execute(
        &mut f,
        &parent,
        prepared["live"].clone(),
        vec![
            (
                "private",
                json!({"action":"create","name":"private collection"}),
                Outcome::Succeeded,
                Effect::Confirmed,
            ),
            (
                "private-add",
                json!({"action":"add","collectionId":"$private:/collection/collectionId","member":{"kind":"snapshot","snapshotId":snapshots["PRIV"]}}),
                Outcome::Succeeded,
                Effect::Confirmed,
            ),
            (
                "share-b",
                json!({"action":"share","collectionId":"$private:/collection/collectionId","targetThreadId":b.child_thread_id}),
                Outcome::Succeeded,
                Effect::Confirmed,
            ),
            (
                "persisted",
                json!({"action":"create","name":"persisted collection","persist":true}),
                Outcome::Succeeded,
                Effect::Confirmed,
            ),
            (
                "persisted-add",
                json!({"action":"add","collectionId":"$persisted:/collection/collectionId","member":{"kind":"snapshot","snapshotId":snapshots["PUBL"]}}),
                Outcome::Succeeded,
                Effect::Confirmed,
            ),
        ],
        true,
        false,
    );
    let identity = |child: &ChildTask, snapshot: &Value, expected: Option<&str>| json!({"threadId":child.child_thread_id,"branchId":child.child_branch_id,"snapshotId":snapshot,"expected":expected});
    f.host.send(json!({"kind":"fixture-public","cases":[identity(&b,&snapshots["PRIV"],Some("PRIV")),identity(&c,&snapshots["PRIV"],None),identity(&c,&snapshots["PUBL"],Some("PUBL")),
        {"threadId":"thread:foreign","branchId":"branch:foreign","snapshotId":snapshots["PUBL"]}]}));
    f.receive("fixture-public-result");
    let b_run = admit_child(&f.runtime, &b);
    f.host.send(json!({"kind":"fixture-select","threadId":b.child_thread_id,"runId":b_run,"required":[extension]}));
    let child_prepared = f.receive("fixture-prepared");
    let private = &parent_results["private"]["collection"]["collectionId"];
    let (child_results, _) = execute(
        &mut f,
        &b_run,
        child_prepared["live"].clone(),
        vec![
            (
                "search",
                json!({"action":"search","collectionId":private,"query":"PRIV"}),
                Outcome::Succeeded,
                Effect::None,
            ),
            (
                "share-c",
                json!({"action":"share","collectionId":private,"targetThreadId":c.child_thread_id}),
                Outcome::Succeeded,
                Effect::Confirmed,
            ),
            (
                "deny-write",
                json!({"action":"remove","collectionId":private,"memberId":parent_results["private-add"]["member"]["memberId"]}),
                Outcome::Failed,
                Effect::None,
            ),
        ],
        false,
        false,
    );
    assert_eq!(child_results["search"]["status"], "ok");
    assert_eq!(child_results["deny-write"]["status"], "denied");
    f.host
        .send(json!({"kind":"fixture-cleanup","threadId":"thread:parent"}));
    f.receive("fixture-cleaned");
    let retained = json!({"kind":"fixture-public","cases":[identity(&c,&snapshots["PRIV"],Some("PRIV")),identity(&c,&snapshots["PUBL"],Some("PUBL")),identity(&c,&snapshots["ORPH"],None)],
        "image":{"threadId":c.child_thread_id,"branchId":c.child_branch_id,"snapshotId":snapshots["PRIV"]}});
    f.host.send(retained.clone());
    f.receive("fixture-public-result");
    // A new ordinary root Run commits, but the Host never receives record.put's reply.
    let lost_run = next_run(&f.runtime, &parent, "lost-input");
    f.host.send(json!({"kind":"fixture-select","threadId":"thread:parent","runId":lost_run,"required":[extension]}));
    let lost_prepared = f.receive("fixture-prepared");
    let (_, lost) = execute(
        &mut f,
        &lost_run,
        lost_prepared["live"].clone(),
        vec![(
            "lost",
            json!({"action":"create","name":"lost collection"}),
            Outcome::Indeterminate,
            Effect::Unknown,
        )],
        false,
        true,
    );
    assert!(lost.is_some());
    let unknown = {
        let owner = f.runtime.catalog();
        let db = owner.lock().unwrap();
        db.active_thread_operations("thread:parent", None)
            .unwrap()
            .into_iter()
            .find(|op| op.run_id == lost_run && op.effect == Effect::Unknown)
            .unwrap()
            .id
    };
    let delivered = {
        let owner = f.runtime.catalog();
        let db = owner.lock().unwrap();
        db.history("branch:parent")
            .unwrap()
            .into_iter()
            .find(|item| item.content["content"]["result"]["call_id"] == "lost")
            .unwrap()
    };
    assert_eq!(
        delivered.content["content"]["result"]["completion"]["effect"],
        "unknown"
    );
    drop(f); // Actual process termination, then reopen both original persistent owners.
    let mut f = fixture(
        &root,
        Arc::new(RunSupervisor::new(Catalog::open(&catalog_root).unwrap())),
    );
    let mut restart = initialize;
    restart["readerOnly"] = json!(true);
    f.host.send(restart);
    f.receive("fixture-reader-ready");
    f.host.send(json!({"kind":"fixture-recover"}));
    f.receive("fixture-recovered");
    {
        let owner = f.runtime.catalog();
        let db = owner.lock().unwrap();
        let op = db
            .capture_operation_read(db.operation(&unknown).unwrap())
            .load()
            .unwrap();
        assert_eq!(
            (op.outcome, op.effect),
            (Some(Outcome::Succeeded), Effect::Confirmed)
        );
        assert_eq!(
            op.result.unwrap().output().unwrap().data["collection"]["name"],
            "lost collection"
        );
    }
    let revision = f
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .operation(&unknown)
        .unwrap()
        .revision;
    f.host.send(json!({"kind":"fixture-recover"}));
    f.receive("fixture-recovered");
    {
        let owner = f.runtime.catalog();
        let db = owner.lock().unwrap();
        assert_eq!(db.operation(&unknown).unwrap().revision, revision);
        assert_eq!(
            db.history("branch:parent")
                .unwrap()
                .into_iter()
                .find(|item| item.id == delivered.id)
                .unwrap(),
            delivered
        );
    }
    let gc = f
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .prepare_content_collection(Default::default());
    assert_eq!(
        gc.run().status,
        varin_runtime::ContentCollectionStatus::Completed
    );
    f.host
        .send(json!({"kind":"fixture-list","threadId":"thread:parent"}));
    let listed = f.receive("fixture-listed");
    assert_eq!(
        listed["result"]["collections"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["name"] == "lost collection")
            .count(),
        1
    );
    f.host.send(retained);
    f.receive("fixture-public-result");
    f.host.send(json!({"kind":"fixture-finish"}));
    f.receive("fixture-finished");
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
    std::fs::remove_dir_all(catalog_root).unwrap();
}
