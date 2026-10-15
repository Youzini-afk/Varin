//! Original native source and collected Experiment PDF ingestion through Host stdio.
//! The model is controlled and collected records are seeded; product IPC and compute submission are not exercised.
use super::web_domain_review::{EPOCH, Fixture, HOST, Host};
use super::*;
use crate::host_tools::ToolBridge;
use crate::storage::Storage;
use std::time::{Duration, Instant};
use varin_runtime::execution::*;
use varin_runtime::supervisor::RunStart;
use varin_runtime::{Effect, Outcome, RunState};

struct Model {
    expected: String,
    views: Arc<Mutex<Vec<RequestView>>>,
}
impl ModelProvider for Model {
    fn serialize(&self, view: &RequestView, _reuse: Option<&mut varin_runtime::execution::RequestCompileReuse>) -> Result<varin_runtime::execution::RequestBody, ExecutionError> {
        self.views.lock().unwrap().push(view.clone());
        Ok(json!({}).into())
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        assert_eq!(
            request.view.binding.tools.len(),
            1,
            "document_read needs no second tool grant"
        );
        let results: Vec<_> = request
            .view
            .history
            .iter()
            .filter_map(|item| match &item.content {
                Content::ToolResult { result } => Some(result),
                _ => None,
            })
            .collect();
        let data = |id: &str| {
            let result = results.iter().find(|result| result.call_id == id).unwrap();
            let ToolCompletion::Result {
                outcome,
                effect,
                content,
            } = &result.completion
            else {
                panic!("finite PDF result")
            };
            assert_eq!(
                (*outcome, *effect),
                (Outcome::Succeeded, Effect::None),
                "{result:?}"
            );
            content.data.clone()
        };
        let calls = match results.len() {
            0 => vec![(
                "local",
                json!({"path":"paper.pdf","view":"text","pages":"all"}),
            )],
            1 => {
                assert!(
                    data("local")["markdown"]
                        .as_str()
                        .unwrap()
                        .contains(&self.expected)
                );
                vec![(
                    "artifact",
                    json!({"artifact":{"attemptId":"attempt:pdf","artifactId":"artifact:pdf"},"view":"text","pages":"all"}),
                )]
            }
            2 => {
                assert!(
                    data("artifact")["markdown"]
                        .as_str()
                        .unwrap()
                        .contains("BLOB")
                );
                vec![(
                    "pinned",
                    json!({"snapshotId":data("local")["snapshot"]["snapshotId"],"view":"text","pages":"all"}),
                )]
            }
            3 => {
                assert_eq!(data("local")["markdown"], data("pinned")["markdown"]);
                vec![]
            }
            _ => panic!("unexpected repeated source read"),
        };
        for (id, arguments) in &calls {
            let schema = &request.view.binding.tools[0];
            assert_eq!(schema.name, "document_read");
            emit(ProviderEvent::ItemCompleted {
                item: ProviderItem {
                    id: (*id).into(),
                    opaque: None,
                    content: Content::ToolCall {
                        call: ToolCall {
                            call_id: (*id).into(),
                            name: schema.name.clone(),
                            schema_version: schema.version.clone(),
                            arguments: arguments.clone(),
                        },
                    },
                },
            })
            .unwrap();
        }
        Ok(if calls.is_empty() {
            FinishReason::Stop
        } else {
            FinishReason::ToolCalls
        })
    }
}
struct Policy {
    schema: ToolSchema,
}
impl AgentPolicy for Policy {
    fn identity(&self) -> PolicyIdentity {
        PolicyIdentity {
            name: "pdf-source-review".into(),
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
        if matches!(
            event,
            PolicyEvent::ModelCompleted {
                reason: FinishReason::Stop,
                ..
            }
        ) {
            let nodes = [("policy-path", json!({"path":"paper.pdf","view":"text","pages":"all"})),
                ("policy-artifact", json!({"artifact":{"attemptId":"attempt:pdf","artifactId":"artifact:pdf"},"view":"text","pages":"all"}))]
                .into_iter().map(|(id,arguments)| PolicyToolNode { id:id.into(),depends_on:vec![],call:ToolCall {
                    call_id:id.into(),name:self.schema.name.clone(),schema_version:self.schema.version.clone(),arguments } }).collect();
            return Ok(PolicyDecision {
                action: PolicyAction::ToolGraph { nodes },
                state: state.clone(),
            });
        }
        if let PolicyEvent::ToolGraphCompleted { receipts, .. } = event {
            assert_eq!(receipts.len(), 2);
            for receipt in receipts {
                assert_eq!(receipt.outcome(), Outcome::Succeeded, "{receipt:?}");
            }
            return Ok(PolicyDecision {
                action: PolicyAction::Complete,
                state: state.clone(),
            });
        }
        DefaultAgentPolicy.decide(view, event, state, cancel)
    }
}

fn fixture(root: &std::path::Path, runtime: Arc<RunSupervisor>) -> Fixture {
    let (sender, outgoing) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(sender.into());
    bridge.initialize(EPOCH);
    let storage_root = root.join("storage");
    Fixture {
        host: Host::with_script(
            "packages/web/application-host/lib/kernel/pdf-source-host.test-helper.ts",
        ),
        runtime,
        storage: Mutex::new(Storage::open(&storage_root, HOST).unwrap()),
        storage_root,
        bridge,
        outgoing,
    }
}
#[test]
#[ignore = "requires built Web builtin and Node/tsx; original Rust sources and seeded collected artifacts, no listeners"]
fn document_only_native_sources_and_artifacts_reach_public_pdf_reader_and_reopen() {
    for (mode, expected) in [
        ("live_root", "LIVE"),
        ("fixed_branch", "FIXD"),
        ("materialized", "COPY"),
    ] {
        let root = std::env::temp_dir().join(format!("varin-pdf-source-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let catalog_path = root.join("catalog");
        let mut db = Catalog::open(&catalog_path).unwrap();
        db.create_thread("thread:pdf", "branch:pdf").unwrap();
        db.create_thread("thread:foreign", "branch:foreign")
            .unwrap();
        let submission = db
            .prepare_submission(
                SubmitInput {
                    key: "pdf-input".into(),
                    thread_id: "thread:pdf".into(),
                    branch_id: "branch:pdf".into(),
                    expected_head: None,
                    input: json!({"text":"Read original local and artifact PDFs"}),
                    configuration: json!({}),
                },
                None,
                None,
            )
            .unwrap();
        let submitted = db
            .admit_submission(submission.load(None, false).unwrap())
            .unwrap();
        let runtime = Arc::new(RunSupervisor::new(db));
        let mut f = fixture(&root, runtime.clone());
        let initialize = json!({"kind":"fixture-initialize","epoch":EPOCH,"root":root,"storageRoot":f.storage_root,"mode":mode,
            "runId":submitted.run_id,"threadId":"thread:pdf","branchId":"branch:pdf"});
        f.host.send(initialize.clone());
        let prepared = f.receive("fixture-prepared");
        let live: Vec<_> = prepared["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| live_extension_binding(serde_json::from_value(v.clone()).unwrap()).unwrap())
            .collect();
        let schemas: Vec<_> = live.iter().map(|v| v.binding.tool.clone()).collect();
        assert_eq!(schemas.len(), 1);
        let binding:RequestBinding=serde_json::from_value(json!({"goal":null,"resource_activations":[],"resource_checkpoint_id":null,
            "connection_identity":"fixture","provider_family":"fixture","model":"fixture","credential_ref":null,
            "configuration_generation":1,"tool_schema_generation":1,"tools":schemas,"instruction_sources":[],"memory_checkpoint":null,
            "attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":"branch:pdf","ancestor_id":null,"leaf_id":submitted.input_id}})).unwrap();
        let policy: Arc<dyn AgentPolicy> = Arc::new(Policy {
            schema: schemas[0].clone(),
        });
        let mut launch = varin_runtime::catalog::launches::LaunchSelection::from_binding(
            &binding,
            policy.identity(),
            None,
        );
        launch.source = Some(serde_json::from_value(prepared["source"].clone()).unwrap());
        launch.extension_bindings = live.iter().map(|v| v.binding.clone()).collect();
        runtime
            .catalog()
            .lock()
            .unwrap()
            .bind_launch(&submitted.run_id, launch)
            .unwrap();
        let tools = crate::run_tools::RunTools::new(runtime.catalog(), f.bridge.clone());
        let selected = tools
            .prepare_scope(&submitted.run_id, vec![], None, live)
            .unwrap();
        let executor = tools.install(&submitted.run_id, 1, selected).unwrap();
        let views = Arc::new(Mutex::new(Vec::new()));
        let execution = runtime
            .start(
                &submitted.run_id,
                RunStart {
                    binding,
                    policy_state: Value::Null,
                    provider: Arc::new(Model {
                        expected: expected.into(),
                        views: views.clone(),
                    }),
                    tools: executor,
                    policy,
                    context_preparation: Arc::new(NoopContextPreparation),
                    progress: ProgressSink::default(),
                },
            )
            .unwrap();
        let (tx, done) = mpsc::channel();
        thread::spawn(move || {
            let _ = tx.send(execution.wait());
        });
        let deadline = Instant::now() + Duration::from_secs(90);
        let report = loop {
            assert!(
                Instant::now() < deadline,
                "PDF source lifecycle stalled: {mode}"
            );
            if let Ok(result) = done.try_recv() {
                break result.unwrap();
            }
            assert!(f.pump().is_none());
        };
        assert_eq!(
            report.state,
            RunState::Completed,
            "{mode}: {:?}",
            report.failure
        );
        let view = views.lock().unwrap().last().unwrap().clone();
        let local = view
            .history
            .iter()
            .find_map(|item| match &item.content {
                Content::ToolResult { result } if result.call_id == "local" => {
                    match &result.completion {
                        ToolCompletion::Result { content, .. } => {
                            Some(content.data["snapshot"]["snapshotId"].clone())
                        }
                        _ => None,
                    }
                }
                _ => None,
            })
            .unwrap();
        let public = json!({"kind":"fixture-public","local":local,"expected":expected});
        f.host.send(public.clone());
        assert_eq!(f.receive("fixture-public-result")["ok"], true);
        let collection = runtime
            .catalog()
            .lock()
            .unwrap()
            .prepare_content_collection(Default::default())
            .run();
        assert_eq!(
            collection.status,
            varin_runtime::ContentCollectionStatus::Completed
        );
        f.host.send(json!({"kind":"fixture-finish"}));
        f.receive("fixture-finished");
        f.bridge.close();
        drop(tools);
        drop(runtime);
        drop(f);
        let reopened = Catalog::open(&catalog_path).unwrap();
        assert_eq!(
            reopened.run(&submitted.run_id).unwrap().state,
            RunState::Completed
        );
        let mut f = fixture(&root, Arc::new(RunSupervisor::new(reopened)));
        let mut initialize = initialize;
        initialize["readerOnly"] = json!(true);
        f.host.send(initialize);
        f.receive("fixture-reader-ready");
        f.host.send(public);
        assert_eq!(f.receive("fixture-public-result")["ok"], true);
        f.host.send(json!({"kind":"fixture-finish"}));
        f.receive("fixture-finished");
        drop(f);
        std::fs::remove_dir_all(root).unwrap();
    }
}
