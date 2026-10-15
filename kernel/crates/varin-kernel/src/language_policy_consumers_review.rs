//! PolicyAction uses the original selected native executor, then consumes its real result chunks.
//! Model choices and policy decisions are controlled; source, TypeScript, receipts and GC are not.
use super::*;

#[derive(Default)]
struct PolicyReads {
    references: Vec<PolicyEvidenceRef>,
    results: Vec<Value>,
    bytes: Vec<u8>,
    next_chunk: usize,
}

struct ReadingPolicy {
    reads: Arc<Mutex<PolicyReads>>,
}

fn rich_tool(name: &str) -> bool {
    matches!(
        name,
        "language_hover"
            | "language_symbols"
            | "language_document_symbols"
            | "language_call_hierarchy"
    )
}

impl AgentPolicy for ReadingPolicy {
    fn identity(&self) -> PolicyIdentity {
        DefaultAgentPolicy.identity()
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
            // Reuse the admitted calls that the real model continuation just consumed. This
            // avoids maintaining a second position/argument fixture for the same project.
            let prefix = format!("{}:language-", view.run_id);
            let nodes: Vec<_> = view
                .history
                .iter()
                .filter_map(|item| match &item.content {
                    Content::ToolCall { call }
                        if call.call_id.starts_with(&prefix) && rich_tool(&call.name) =>
                    {
                        Some(call.clone())
                    }
                    _ => None,
                })
                .enumerate()
                .map(|(index, mut call)| {
                    let id = format!("policy-rich-{index}");
                    call.call_id = id.clone();
                    PolicyToolNode {
                        id,
                        depends_on: index
                            .checked_sub(1)
                            .map(|previous| format!("policy-rich-{previous}"))
                            .into_iter()
                            .collect(),
                        call,
                    }
                })
                .collect();
            assert_eq!(nodes.len(), 5);
            return Ok(PolicyDecision {
                state: json!({"stage":"querying"}),
                action: PolicyAction::ToolGraph { nodes },
            });
        }
        if let PolicyEvent::ToolGraphCompleted {
            action_id,
            receipts,
        } = event
        {
            let mut reads = self.reads.lock().unwrap();
            assert!(reads.references.is_empty());
            assert_eq!(receipts.len(), 5);
            for receipt in receipts {
                let PolicyNodeCompletion::Result {
                    outcome,
                    effect,
                    output,
                } = &receipt.completion
                else {
                    panic!("finite original language receipt required: {receipt:?}")
                };
                assert_eq!(*outcome, Outcome::Succeeded);
                assert_eq!(*effect, varin_runtime::Effect::None);
                assert_eq!(&output.action_id, action_id);
                assert_eq!(output.node_id, receipt.node_id);
                reads.references.push(output.clone());
            }
            reads
                .references
                .sort_by(|left, right| left.node_id.cmp(&right.node_id));
            return Ok(PolicyDecision {
                state: json!({"stage":"reading","completed":0}),
                action: PolicyAction::ReadResult {
                    reference: reads.references[0].clone(),
                    index: 0,
                },
            });
        }
        if let PolicyEvent::ResultChunk {
            format,
            reference,
            index,
            total_chunks,
            total_bytes,
            bytes,
        } = event
        {
            assert_eq!(
                *format,
                varin_runtime::output::PolicyResultFormat::OutputBody
            );
            let mut reads = self.reads.lock().unwrap();
            assert_eq!(reference, &reads.references[reads.results.len()]);
            assert_eq!(*index, reads.next_chunk);
            reads.bytes.extend_from_slice(bytes);
            reads.next_chunk += 1;
            if reads.next_chunk < *total_chunks {
                return Ok(PolicyDecision {
                    state: state.clone(),
                    action: PolicyAction::ReadResult {
                        reference: reference.clone(),
                        index: reads.next_chunk,
                    },
                });
            }
            assert_eq!(reads.bytes.len() as u64, *total_bytes);
            let body: OutputBody = serde_json::from_slice(&reads.bytes).unwrap();
            assert_eq!(body.data["status"], "ready", "{}", body.data);
            reads.results.push(body.data);
            reads.bytes.clear();
            reads.next_chunk = 0;
            let completed = reads.results.len();
            return Ok(PolicyDecision {
                state: json!({"stage":"reading","completed":completed}),
                action: if completed == reads.references.len() {
                    PolicyAction::Complete
                } else {
                    PolicyAction::ReadResult {
                        reference: reads.references[completed].clone(),
                        index: 0,
                    }
                },
            });
        }
        DefaultAgentPolicy.decide(view, event, state, cancel)
    }
}

#[test]
#[ignore = "requires bundled TypeScript and fresh Rust process worker; original policy graph and result reader over stdio"]
fn policy_graph_consumes_rich_fixed_language_results_and_reopens_original_receipts() {
    let root = std::env::temp_dir().join(format!("varin-language-policy-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let mut review = Review::open(&root);
    let source = review.initialize(&root, "fixed_branch", false);
    let run = review.admit(source.clone(), "policy-rich-language");
    let (binding, selected) = review.select(&run, &source);
    let reads = Arc::new(Mutex::new(PolicyReads::default()));
    let results = review.execute_with_policy(
        &run,
        binding.clone(),
        false,
        Arc::new(Script),
        Arc::new(ReadingPolicy {
            reads: reads.clone(),
        }),
    );
    assert_results(&results, &selected, &source, false);
    let (references, policy_results) = {
        let reads = reads.lock().unwrap();
        assert_eq!(reads.references.len(), 5);
        assert_eq!(reads.results, results[5..]);
        assert!(reads.bytes.is_empty());
        (reads.references.clone(), reads.results.clone())
    };
    let owner = review.f.runtime.catalog();
    let (history, graph_read) = {
        let db = owner.lock().unwrap();
        let history = db.execution_history(BRANCH).unwrap();
        assert_eq!(
            history
                .iter()
                .filter(|item| matches!(item.content, Content::ToolResult { .. }))
                .count(),
            SCRIPT_CALLS,
            "five policy executions cannot fabricate five additional model exchanges"
        );
        assert!(history.iter().all(|item| match &item.content {
            Content::ToolCall { call } => !call.call_id.starts_with("policy-rich-"),
            Content::ToolResult { result } => !result.call_id.starts_with("policy-rich-"),
            _ => true,
        }));
        let action = &references[0].action_id;
        for reference in &references {
            assert_eq!(&reference.action_id, action);
            let origin = ToolOrigin::PolicyAction {
                action_id: action.clone(),
                node_id: reference.node_id.clone(),
            };
            assert!(
                matches!(db.operation(&origin.operation_id("")), Err(varin_runtime::RuntimeError::NotFound(_))),
                "replayable read-only nodes use their original graph receipts, not a duplicate effect ledger"
            );
        }
        (
            history,
            db.capture_operation_read(db.operation(action).unwrap()),
        )
    };
    let original_graph = graph_read.load().unwrap();
    assert_eq!(original_graph.run_id, run);

    review
        .f
        .host
        .send(json!({"kind":"fixture-release","grantId":binding.grant_id}));
    review.receive("fixture-released");
    review
        .f
        .host
        .send(json!({"kind":"fixture-drain","runId":run}));
    review.receive("fixture-drained");
    let derived = PathBuf::from(
        results[0]["source"]["derivedView"]["canonicalRoot"]
            .as_str()
            .unwrap(),
    );
    assert!(
        !derived.exists(),
        "the final policy query cannot retain a stopped view"
    );
    let collection = owner
        .lock()
        .unwrap()
        .prepare_content_collection(Default::default());
    assert_eq!(
        collection.run().status,
        varin_runtime::ContentCollectionStatus::Completed
    );
    review.f.host.send(json!({"kind":"fixture-gc"}));
    review.receive("fixture-gc-finished");
    review.f.host.send(json!({"kind":"fixture-finish"}));
    let finished = review.receive("fixture-finished");
    assert_eq!(finished["sourceQueries"], SCRIPT_CALLS + references.len());
    assert_eq!(finished["processSpawns"], 1);
    drop(owner);
    drop(review);

    let db = Catalog::open(root.join("catalog")).unwrap();
    assert_eq!(db.execution_history(BRANCH).unwrap(), history);
    let reopened = db
        .capture_operation_read(db.operation(&references[0].action_id).unwrap())
        .load()
        .unwrap();
    assert_eq!(reopened.intent, original_graph.intent);
    assert_eq!(reopened.result, original_graph.result);
    for (reference, expected) in references.iter().zip(&policy_results) {
        let mut bytes = Vec::new();
        let mut index = 0;
        loop {
            // This public fixture reader checks the original graph/node receipt ownership
            // before loading its ContentStore chunks, even after the service has stopped.
            let chunk = db
                .policy_output_chunk(
                    &run,
                    &reference.action_id,
                    &reference.node_id,
                    &reference.content_ref,
                    index,
                )
                .unwrap();
            bytes.extend_from_slice(&chunk.bytes);
            index += 1;
            if index == chunk.chunk_count {
                assert_eq!(bytes.len() as u64, chunk.total_bytes);
                break;
            }
        }
        let body: OutputBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(&body.data, expected);
    }
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
