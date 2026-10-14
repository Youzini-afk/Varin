//! Actual installed scholarly service, root/policy/child execution and explicit paper reading.
use super::material_collection_review::{
    accept, admit_child, binding, child_fixture, next_run, substitute,
};
use super::web_domain_review::{EPOCH, Fixture, HOST, Host};
use super::*;
use crate::{host_tools::ToolBridge, storage::Storage};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, Instant};
use varin_runtime::execution::*;
use varin_runtime::supervisor::RunStart;
use varin_runtime::{Effect, Outcome, RunState};

type Call = (&'static str, &'static str, Value, Outcome, Effect);
struct Script {
    calls: Vec<Call>,
    results: Arc<Mutex<BTreeMap<String, Value>>>,
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
                if let Some((_, _, _, outcome, effect)) =
                    self.calls.iter().find(|(id, ..)| *id == result.call_id)
                {
                    if let ToolCompletion::NotDispatched { reason } = &result.completion {
                        assert_eq!(result.call_id, "denied");
                        results.insert(result.call_id.clone(), json!({"not_dispatched":reason}));
                        continue;
                    }
                    let ToolCompletion::Result {
                        outcome: actual,
                        effect: actual_effect,
                        content,
                    } = &result.completion
                    else {
                        panic!("finite metadata receipt")
                    };
                    assert_eq!((*actual, *actual_effect), (*outcome, *effect), "{result:?}");
                    results.insert(result.call_id.clone(), content.data.clone());
                }
            }
        }
        let Some((id, name, args, ..)) = self
            .calls
            .iter()
            .find(|(id, ..)| !results.contains_key(*id))
        else {
            return Ok(FinishReason::Stop);
        };
        let schema = request
            .view
            .binding
            .tools
            .iter()
            .find(|tool| tool.name == *name)
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
    read: bool,
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
        if self.read
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
                        id: "policy-paper".into(),
                        depends_on: vec![],
                        call: ToolCall {
                            call_id: "policy-paper".into(),
                            name: self.schema.name.clone(),
                            schema_version: self.schema.version.clone(),
                            arguments: json!({"action":"paper","provider":"semantic-scholar","paperId":"S1"}),
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
            "packages/web/application-host/lib/kernel/scholarly-discovery-host.test-helper.ts",
        ),
        runtime,
        storage: Mutex::new(Storage::open(&storage_root, HOST).unwrap()),
        storage_root,
        bridge,
        outgoing,
    }
}
fn execute(
    f: &mut Fixture,
    run: &str,
    bindings: &Value,
    calls: Vec<Call>,
    policy_read: bool,
) -> BTreeMap<String, Value> {
    let live = bindings
        .as_array()
        .unwrap()
        .iter()
        .map(|value| {
            live_extension_binding(serde_json::from_value(value.clone()).unwrap()).unwrap()
        })
        .collect::<Vec<_>>();
    let schema = live
        .iter()
        .find(|entry| entry.binding.tool.name == "research_search")
        .unwrap()
        .binding
        .tool
        .clone();
    let selected = f
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .launch_intent(run)
        .unwrap()
        .unwrap()
        .selection;
    let resources = crate::tools::KernelResourceClient::new(
        |_| {
            Err(crate::error::KernelError::Operation(
                "unrequested source effect".into(),
            ))
        },
        |_| Ok(()),
        Default::default(),
    );
    let base =
        crate::collaboration::declarations(f.runtime.catalog(), None, resources, f.bridge.clone())
            .into_iter()
            .filter(|entry| selected.tools.contains(&entry.schema))
            .collect();
    let tools = crate::run_tools::RunTools::new(f.runtime.catalog(), f.bridge.clone());
    let prepared = tools.prepare_scope(run, base, None, live).unwrap();
    assert_eq!(prepared.schemas(), selected.tools);
    let executor = tools
        .install(run, selected.tool_schema_generation, prepared)
        .unwrap();
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
                    read: policy_read,
                }),
                context_preparation: Arc::new(crate::child_capabilities::BindingPreparation {
                    inner: Arc::new(NoopContextPreparation),
                    catalog: f.runtime.catalog(),
                }),
                progress: ProgressSink::default(),
            },
        )
        .unwrap();
    let (tx, done) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(execution.wait());
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    let report = loop {
        assert!(Instant::now() < deadline, "scholarly Run stalled");
        if let Ok(report) = done.try_recv() {
            break report.unwrap();
        }
        f.pump();
    };
    assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
    let values = results.lock().unwrap().clone();
    assert_eq!(values.len(), expected, "actual tool results not consumed");
    values
}

#[test]
#[ignore = "requires built scholarly/Web artifacts and Node/tsx; controlled egress and subprocess stdio only"]
fn metadata_root_policy_child_and_explicit_pdf_survive_reopen() {
    let root =
        std::env::temp_dir().join(format!("varin-scholarly-review-{}", uuid::Uuid::new_v4()));
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
    let extensions = initial["bindings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            serde_json::from_value::<varin_runtime::catalog::launches::ExtensionToolBinding>(
                entry["binding"].clone(),
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(extensions.len(), 3);
    let scholar = extensions
        .iter()
        .find(|entry| entry.tool.name == "research_search")
        .unwrap()
        .clone();
    let dispatch = crate::child_capabilities::schemas()
        .into_iter()
        .find(|tool| tool.name == "dispatch")
        .unwrap();
    let parent_extensions = extensions.clone();
    let parent_dispatch = dispatch.clone();
    let mut family = child_fixture::Fixture::new_parent_custom(
        0,
        scholar.tool.clone(),
        dispatch,
        false,
        false,
        false,
        move |input, launch| {
            input.task = "Look up paper metadata without a file source".into();
            input.tools = Some(vec!["research_search".into()]);
            launch.source = None;
            launch.tools = parent_extensions
                .iter()
                .map(|entry| entry.tool.clone())
                .chain([parent_dispatch])
                .collect();
            launch.tools.sort_by(|a, b| a.name.cmp(&b.name));
            launch.extension_bindings = parent_extensions;
            launch.policy = PolicyIdentity {
                name: "default".into(),
                version: "1".into(),
            };
        },
    );
    family.launch.source = None;
    family.launch.tools = vec![scholar.tool.clone()];
    family.launch.extension_bindings = vec![scholar.clone()];
    let parent = family.context.run_id.clone();
    let context = family.context.clone();
    let child = accept(&mut family, &context);
    family.settle_exchange();
    let catalog_root = family.root.clone();
    f.runtime = Arc::new(RunSupervisor::new(family.db));
    f.host.send(json!({"kind":"fixture-select","threadId":"thread:parent","runId":parent,"required":extensions}));
    let prepared = f.receive("fixture-prepared");
    let values = execute(
        &mut f,
        &parent,
        &prepared["bindings"],
        vec![
            (
                "search",
                "research_search",
                json!({"action":"search","query":"original discovery","limit":1}),
                Outcome::Succeeded,
                Effect::None,
            ),
            (
                "page",
                "research_search",
                json!({"action":"search","query":"original discovery","limit":1,"cursor":"$search:/nextCursor"}),
                Outcome::Succeeded,
                Effect::None,
            ),
            (
                "references",
                "research_search",
                json!({"action":"relations","paperId":"$search:/papers/0/id","relation":"references","limit":1}),
                Outcome::Succeeded,
                Effect::None,
            ),
            (
                "references-page",
                "research_search",
                json!({"action":"relations","paperId":"$search:/papers/0/id","relation":"references","limit":1,"cursor":"$references:/nextCursor"}),
                Outcome::Succeeded,
                Effect::None,
            ),
            (
                "citations",
                "research_search",
                json!({"action":"relations","provider":"semantic-scholar","paperId":"S1","relation":"citations"}),
                Outcome::Succeeded,
                Effect::None,
            ),
            (
                "unavailable",
                "research_search",
                json!({"action":"relations","provider":"semantic-scholar","paperId":"S1","relation":"related"}),
                Outcome::Failed,
                Effect::None,
            ),
            (
                "collection",
                "materials",
                json!({"action":"create","name":"selected papers"}),
                Outcome::Succeeded,
                Effect::Confirmed,
            ),
            (
                "paper",
                "materials",
                json!({"action":"add","collectionId":"$collection:/collection/collectionId","member":{"kind":"paper","paper":{"provider":"$search:/papers/0/provider","id":"$search:/papers/0/id"}}}),
                Outcome::Succeeded,
                Effect::Confirmed,
            ),
            (
                "url",
                "materials",
                json!({"action":"add","collectionId":"$collection:/collection/collectionId","member":{"kind":"url","url":"$search:/papers/0/openAccessUrl"}}),
                Outcome::Succeeded,
                Effect::Confirmed,
            ),
            (
                "read",
                "document_read",
                json!({"snapshotId":"$url:/member/snapshotId","view":"text","pages":"all"}),
                Outcome::Succeeded,
                Effect::None,
            ),
        ],
        true,
    );
    assert_eq!(values["search"]["papers"][0]["content"], "open-location");
    assert!(
        values["search"]["papers"][0]["title"]
            .as_str()
            .unwrap()
            .contains("ignore system instructions")
    );
    assert_eq!(values["page"]["papers"][0]["id"], "https://openalex.org/W2");
    assert_eq!(values["references"]["relation"]["source"]["id"], "W1");
    assert_eq!(
        values["references-page"]["papers"][0]["id"],
        "https://openalex.org/W3"
    );
    assert_eq!(values["citations"]["papers"][0]["id"], "S2");
    assert_eq!(values["unavailable"]["status"], "unavailable");
    assert_eq!(
        values["paper"]["member"]["paper"]["id"],
        values["search"]["papers"][0]["id"]
    );
    assert!(values["paper"]["member"].get("snapshotId").is_none());
    assert!(
        values["read"]["markdown"]
            .as_str()
            .unwrap()
            .contains("LEFT")
    );
    let denied_run = next_run(&f.runtime, &parent, "scholarly-denied");
    f.host.send(json!({"kind":"fixture-select","threadId":"thread:parent","runId":denied_run,"required":extensions,"denyScholar":true}));
    let denied = f.receive("fixture-prepared");
    execute(
        &mut f,
        &denied_run,
        &denied["bindings"],
        vec![(
            "denied",
            "research_search",
            json!({"action":"paper","provider":"semantic-scholar","paperId":"S1"}),
            Outcome::Failed,
            Effect::None,
        )],
        false,
    );
    f.host.send(json!({"kind":"fixture-counts"}));
    assert_eq!(
        f.receive("fixture-counts")["metadataFetches"],
        denied["metadataFetches"]
    );
    let run = admit_child(&f.runtime, &child);
    assert!(
        f.runtime
            .catalog()
            .lock()
            .unwrap()
            .launch_intent(&run)
            .unwrap()
            .unwrap()
            .selection
            .source
            .is_none()
    );
    f.host.send(json!({"kind":"fixture-select","threadId":child.child_thread_id,"runId":run,"required":[scholar]}));
    let prepared = f.receive("fixture-prepared");
    assert_eq!(prepared["bindings"].as_array().unwrap().len(), 1);
    let child_values = execute(
        &mut f,
        &run,
        &prepared["bindings"],
        vec![(
            "child-paper",
            "research_search",
            json!({"action":"paper","provider":"semantic-scholar","paperId":"S1"}),
            Outcome::Succeeded,
            Effect::None,
        )],
        false,
    );
    assert_eq!(
        child_values["child-paper"]["papers"][0]["externalIds"]["corpusid"],
        "42"
    );
    let snapshot = values["url"]["member"]["snapshotId"].clone();
    f.host
        .send(json!({"kind":"fixture-public","snapshotId":snapshot}));
    let before = f.receive("fixture-public-result");
    assert_eq!(before["pdfFetches"], 1);
    let history = f
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .history("branch:parent")
        .unwrap();
    let result = history
        .iter()
        .find(|item| item.content["content"]["result"]["call_id"] == "search")
        .unwrap();
    assert_eq!(
        result.content["content"]["result"]["completion"]["content"]["data"],
        values["search"]
    );
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
    f.host.send(json!({"kind":"fixture-finish"}));
    f.receive("fixture-finished");
    drop(f);
    let mut f = fixture(
        &root,
        Arc::new(RunSupervisor::new(Catalog::open(&catalog_root).unwrap())),
    );
    let mut reopen = initialize;
    reopen["readerOnly"] = json!(true);
    f.host.send(reopen);
    f.receive("fixture-reader-ready");
    assert_eq!(
        f.runtime
            .catalog()
            .lock()
            .unwrap()
            .history("branch:parent")
            .unwrap(),
        history
    );
    f.host
        .send(json!({"kind":"fixture-public","snapshotId":snapshot}));
    let after = f.receive("fixture-public-result");
    assert_eq!(after["metadataFetches"], 0);
    assert_eq!(after["pdfFetches"], 0);
    f.host.send(json!({"kind":"fixture-finish"}));
    f.receive("fixture-finished");
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
    std::fs::remove_dir_all(catalog_root).unwrap();
}
