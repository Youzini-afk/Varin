//! Actual admitted children and RunAssembly. Domain replies are controlled bridge fixtures;
//! the Host owner's CAS/storage implementation is tested by its own consumer tests.
use super::*;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use varin_runtime::Effect;

fn calls() -> Vec<ToolCall> {
    [
        ("memory", json!({"action":"read","scope":"currentThread"})),
        ("memory", json!({"action":"save","scope":"currentThread","revision":0,"content":"Child private note"})),
        ("todo", json!({"action":"read"})),
        ("todo", json!({"action":"update","expectedRef":null,"items":[{"text":"Child step","status":"in_progress"}]})),
        ("todo", json!({"action":"update","expectedRef":null,"items":[]})),
        ("todo", json!({"action":"read"})),
        ("todo", json!({"action":"update","expectedRef":"child-plan-1","items":[{"text":"Child step","status":"completed"}]})),
    ].into_iter().enumerate().map(|(i,(name, arguments))| ToolCall {
        call_id: format!("child-call-{i}"), name:name.into(), schema_version:"1".into(), arguments,
    }).collect()
}
fn fixture(selected: Vec<String>) -> Fixture {
    Fixture::with_tools(
        false,
        vec![crate::memory::schema(true), crate::plan::schema()],
        selected,
    )
}
struct ModelCalls {
    calls: Vec<ToolCall>,
    next: AtomicUsize,
}
impl ModelProvider for ModelCalls {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        Ok(serde_json::to_value(view).unwrap())
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let call = self.calls.get(self.next.fetch_add(1, Ordering::SeqCst));
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: request.view.request_id.clone(),
                opaque: None,
                content: call.map_or(
                    Content::Text {
                        text: "Child finished".into(),
                    },
                    |call| Content::ToolCall { call: call.clone() },
                ),
            },
        })
        .unwrap();
        Ok(if call.is_some() {
            FinishReason::ToolCalls
        } else {
            FinishReason::Stop
        })
    }
}
#[derive(Default)]
struct OwnerReplies {
    plan_ref: Option<String>,
    plan_reads: Vec<Option<String>>,
    note: Option<Value>,
    revision: u64,
    receipts: BTreeMap<String, Value>,
    queries: Vec<Value>,
}
impl OwnerReplies {
    fn frame(&mut self, f: &Fixture, frame: &Value, uncertain: bool) -> bool {
        let kind = frame["kind"].as_str().unwrap();
        if kind != "memory-request" && kind != "plan-request" {
            return false;
        }
        let q = &frame["query"];
        if kind == "memory-request" && q["action"] == "synchronize" {
            assert_eq!(q["scope"]["sessionId"], f.run.thread_id);
            let checkpoint = &q["checkpoint"];
            let result = json!({"status":"ready","context":{"resources":checkpoint["resources"],
                "effectiveSystemPrompt":checkpoint["proposal"]["effective_system_prompt"],
                "instructionSources":checkpoint["proposal"]["instruction_sources"],
                "memoryCheckpoint":checkpoint["proposal"]["memory_checkpoint"],"personalization":checkpoint["personalization"]},
                "state":{"revision":self.revision,"memories":self.note.iter().collect::<Vec<_>>(),
                    "noteRevisions":if self.revision == 0 {json!({})} else {json!({"1":self.revision})},"known":{}}});
            f.assembly.memory.receive(json!({"v":1,"kind":"memory-response","id":frame["id"],"kernelEpoch":EPOCH,"result":result}));
            return true;
        }
        self.queries.push(q.clone());
        let key = serde_json::to_string(&q["origin"]).unwrap();
        let result = if q["action"] == "receipt" {
            self.receipts
                .get(&key)
                .expect("only original receipt lookup")
                .clone()
        } else if kind == "memory-request" {
            assert_eq!(q["runId"], f.run.id);
            assert_eq!(q["scope"]["sessionId"], f.run.thread_id);
            assert_eq!(q["scope"]["projectId"], json!(f.child.project_id));
            if q["arguments"]["action"] == "save" {
                assert_eq!(q["arguments"]["revision"], self.revision);
                self.revision += 1;
                let scope = json!({"kind":"session","id":f.run.thread_id});
                self.note = Some(
                    json!({"id":1,"scope":scope,"content":q["arguments"]["content"],"updatedAt":"2026-10-10T00:00:00Z"}),
                );
                let result = json!({"status":"ready","memoryReceipt":{"origin":q["origin"],"revision":self.revision,
                    "changes":[{"id":1,"scope":scope,"note":self.note}]}});
                self.receipts.insert(key, result.clone());
                result
            } else {
                json!({"status":"ready","revision":self.revision,"memories":self.note.iter().collect::<Vec<_>>()})
            }
        } else {
            assert_eq!(q["view"]["threadId"], f.run.thread_id);
            assert_eq!(q["view"]["branchId"], f.run.branch_id);
            assert_eq!(
                q["view"]["inheritedRef"],
                Value::Null,
                "initial child never copies parent plan"
            );
            assert_eq!(q["view"]["forkBasis"], Value::Null);
            assert_eq!(q["origin"]["runId"], f.run.id);
            if q["action"] == "read" {
                self.plan_reads.push(self.plan_ref.clone());
                json!({"status":"ready","plan":self.plan_ref.as_ref().map(|reference|json!({"ref":reference}))})
            } else {
                let applied = q["arguments"]["expectedRef"] == json!(self.plan_ref);
                if applied {
                    self.plan_ref = Some(
                        if self.plan_ref.is_none() {
                            "child-plan-1"
                        } else {
                            "child-plan-2"
                        }
                        .into(),
                    );
                }
                let result = json!({"status":"ready","mutation":{"receipt":{"threadId":q["view"]["threadId"],
                    "branchId":q["view"]["branchId"],"origin":q["origin"],"intentHash":"fixture-intent",
                    "status":if applied {"applied"} else {"conflict"},"ref":self.plan_ref},"plan":{"ref":self.plan_ref}}});
                self.receipts.insert(key, result.clone());
                result
            }
        };
        let mutation = q["action"] == "mutate"
            || (q["action"] == "tool" && q["arguments"]["action"] == "save");
        // The plan owner accepted the effect, but its response has not reached the caller.
        // The driver cancels the in-flight call below, then asks only for this receipt.
        if uncertain && q["action"] == "mutate" {
            return true;
        }
        let result = if uncertain && mutation {
            json!({"status":"unknown"})
        } else {
            result
        };
        let reply = json!({"v":1,"kind":if kind == "memory-request" {"memory-response"} else {"plan-response"},
            "id":frame["id"],"kernelEpoch":EPOCH,"result":result});
        if kind == "memory-request" {
            f.assembly.memory.receive(reply);
        } else {
            f.assembly.plan.receive(reply);
        }
        true
    }
}
fn execute(
    f: &Fixture,
    model: bool,
    calls: Vec<ToolCall>,
    owner: &mut OwnerReplies,
    uncertain: bool,
) {
    f.prepare_policy(0, "http://127.0.0.1:1/unused-planner");
    let mut start = f.start(0);
    start.provider = Arc::new(ModelCalls {
        calls: calls.clone(),
        next: AtomicUsize::new(0),
    });
    let input = f
        .catalog()
        .lock()
        .unwrap()
        .prepare_execution(
            &f.run.id,
            start.binding.clone(),
            start.policy.identity(),
            Value::Null,
        )
        .unwrap();
    let engine = make_engine(f, start);
    let (tx, done) = mpsc::channel();
    let cancel = CancellationToken::default();
    let worker_cancel = cancel.clone();
    let worker = std::thread::spawn(move || tx.send(engine.run(input, worker_cancel)).unwrap());
    let deadline = Instant::now() + Duration::from_secs(10);
    let report = loop {
        assert!(Instant::now() < deadline, "child execution stalled");
        if let Ok(report) = done.try_recv() {
            break report.unwrap();
        }
        let frame = match f.frames.recv_timeout(Duration::from_millis(20)) {
            Ok(frame) => frame,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(e) => panic!("{e}"),
        };
        if owner.frame(f, &frame, uncertain) {
            if uncertain && frame["kind"] == "plan-request" && frame["query"]["action"] == "mutate"
            {
                f.catalog()
                    .lock()
                    .unwrap()
                    .request_cancel_run(&f.run.id)
                    .unwrap();
                cancel.cancel();
            }
            continue;
        }
        if f.ordinary_frame(&frame) || (uncertain && frame["kind"] == "plan-cancel") {
            continue;
        }
        assert_eq!(frame["kind"], "agent-policy-request", "{frame}");
        let event = frame["input"]["event"]["kind"].as_str().unwrap();
        let stage = frame["input"]["state"]["stage"].as_u64().unwrap_or(0) as usize;
        let action = if event == "delivered" {
            json!({"kind":"complete"})
        } else if model
            && event == "model_completed"
            && frame["input"]["event"]["tool_calls"].as_u64().unwrap_or(0) > 0
        {
            json!({"kind":"execute_tools"})
        } else if model && matches!(event, "started" | "tools_completed") {
            json!({"kind":"request_model"})
        } else if !model && stage < calls.len() {
            let call = &calls[stage];
            json!({"kind":"tool_graph","nodes":[{"id":call.call_id,"depends_on":[],"call":call}]})
        } else if uncertain {
            json!({"kind":"pause","reason":"Observe original owner receipts"})
        } else {
            json!({"kind":"deliver","text":"Child notes and plan are settled"})
        };
        let next = if action["kind"] == "tool_graph" {
            stage + 1
        } else {
            stage
        };
        f.reply(&frame, json!({"state":{"stage":next},"action":action}));
    };
    worker.join().unwrap();
    assert_eq!(
        report.state,
        if uncertain {
            RunState::Cancelled
        } else {
            RunState::Completed
        },
        "{:?}",
        report.failure
    );
    assert_eq!(
        report.model_steps,
        if model {
            calls.len() as u64 + u64::from(!uncertain)
        } else {
            0
        }
    );
}
#[test]
fn selected_child_memory_and_plan_execute_through_both_origins_and_keep_report_separate() {
    for model in [false, true] {
        let f = fixture(vec!["memory".into(), "todo".into()]);
        let mut owner = OwnerReplies::default();
        execute(&f, model, calls(), &mut owner, false);
        assert_eq!(owner.queries.len(), 7);
        assert_eq!(owner.plan_reads, vec![None, Some("child-plan-1".into())]);
        assert_eq!(owner.plan_ref.as_deref(), Some("child-plan-2"));
        let db = f.catalog();
        let db = db.lock().unwrap();
        let state = db.memory_state(&f.run.branch_id).unwrap().unwrap();
        assert_eq!(state.memories[0]["scope"]["id"], f.run.thread_id);
        assert!(db.memory_state("branch:parent").unwrap().is_none());
        let admitted = db
            .capture_admitted_checkpoint(&f.run.id)
            .unwrap()
            .unwrap()
            .load()
            .unwrap();
        assert!(
            admitted
                .personalization
                .unwrap()
                .memory_snapshot
                .memories
                .is_empty(),
            "a note mutation must not rewrite the admitted system snapshot"
        );
        let memory_query = &owner.queries[1];
        let operation_id = memory_query["origin"]
            .as_str()
            .unwrap()
            .strip_prefix(&format!("run:{}:", f.run.id))
            .unwrap();
        let memory_op = db.operation(operation_id).unwrap();
        assert_eq!(memory_op.effect, Effect::Confirmed);
        assert_eq!(
            memory_op.intent["origin"]["kind"],
            if model { "model_step" } else { "policy_action" }
        );
        for foreign in ["thread:parent", "thread:sibling"] {
            let receipt = json!({"revision":2,"changes":[{"id":2,"scope":{"kind":"session","id":foreign},"note":null}]});
            assert!(db
                .prepare_memory_receipt(&f.run.id, receipt)
                .unwrap()
                .load()
                .is_err());
        }
        for query in owner.queries.iter().filter(|q| q["action"] == "mutate") {
            let op = db
                .operation(query["origin"]["operationId"].as_str().unwrap())
                .unwrap();
            assert_eq!(
                op.intent["origin"]["kind"],
                if model { "model_step" } else { "policy_action" }
            );
            assert_eq!(op.intent["origin"], query["origin"]["toolOrigin"]);
            let applied = query["arguments"]["items"].as_array().unwrap().len() == 1;
            assert_eq!(
                op.effect,
                if applied {
                    Effect::Confirmed
                } else {
                    Effect::None
                }
            );
            assert_eq!(
                op.outcome,
                Some(if applied {
                    Outcome::Succeeded
                } else {
                    Outcome::Failed
                })
            );
        }
        let reports = db.capture_child_reports().unwrap();
        drop(db);
        let reports = reports.load().unwrap();
        for report in reports {
            f.catalog()
                .lock()
                .unwrap()
                .admit_child_report(report)
                .unwrap();
        }
        let child = f
            .catalog()
            .lock()
            .unwrap()
            .child_task(&f.child.operation_id)
            .unwrap();
        assert_eq!(
            child.code_result,
            varin_runtime::catalog::collaboration::ChildCodeResult::NoChanges
        );
        // The original conflict stays Failed/None above; a later legal update and normal
        // textual completion are independent report facts for either tool origin.
        assert_eq!(child.report.unwrap().outcome, Outcome::Succeeded);
        f.finish();
    }
}
#[test]
fn available_but_unselected_child_helpers_do_not_enter_assembly() {
    let f = fixture(vec!["helper".into()]);
    f.prepare_policy(0, "http://127.0.0.1:1/unused");
    let start = f.start(0);
    let frozen = FrozenToolContext {
        run_id: f.run.id.clone(),
        origin: ToolOrigin::ModelStep {
            request_id: "unselected".into(),
        },
        tool_schema_generation: start.binding.tool_schema_generation,
        tools: Arc::new(start.binding.tools.clone()),
        source: f.original.source.clone(),
        child_dispatch: None,
        resource_checkpoint_id: None,
        resource_activations: vec![],
    };
    for call in calls().into_iter().take(4) {
        assert!(start
            .tools
            .prepare(&call, &frozen, &CancellationToken::default())
            .is_err());
    }
    assert!(
        crate::plan::eligible(&f.catalog().lock().unwrap(), &f.run.id).unwrap(),
        "user plan scope is independent of model tool selection"
    );
    drop(start);
    f.finish();
}
#[test]
fn cancelled_child_reopen_reconciles_original_note_and_plan_receipts_without_replay() {
    for model in [false, true] {
        let f = fixture(vec!["memory".into(), "todo".into()]);
        let mut owner = OwnerReplies::default();
        let writes = calls()
            .into_iter()
            .take(4)
            .filter(|call| {
                call.arguments["action"] == "save"
                    || (call.name == "todo"
                        && call.arguments["items"]
                            .as_array()
                            .is_some_and(|items| items.len() == 1))
            })
            .collect();
        execute(&f, model, writes, &mut owner, true);
        let original = owner.queries.clone();
        // The owner subsequently accepts a UI edit. A late original receipt must not replace it.
        owner.plan_ref = Some("later-ui-plan".into());
        owner.revision = 2;
        owner.note.as_mut().unwrap()["content"] = json!("Later UI note");
        let later = json!({"revision":2,"changes":[{"id":1,"scope":owner.note.as_ref().unwrap()["scope"],"note":owner.note}]});
        let prepared = f
            .catalog()
            .lock()
            .unwrap()
            .prepare_memory_receipt(&f.run.id, later)
            .unwrap()
            .load()
            .unwrap();
        assert!(f
            .catalog()
            .lock()
            .unwrap()
            .publish_memory_state(prepared)
            .unwrap());
        f.assembly.runtime.cancel(&f.run.id).unwrap();
        let f = f.reopen();
        let (tx, done) = mpsc::sync_channel(2);
        crate::memory::reconcile(
            f.assembly.runtime.clone(),
            f.assembly.memory.clone(),
            f.run.id.clone(),
            "memory-reconcile".into(),
            tx.clone().into(),
            Arc::new(|_| {}),
        )
        .unwrap();
        crate::plan::reconcile(
            f.assembly.runtime.clone(),
            f.assembly.plan.clone(),
            f.run.id.clone(),
            "plan-reconcile".into(),
            tx.into(),
            Arc::new(|_| {}),
        )
        .unwrap();
        let mut responses = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while responses.len() < 2 {
            assert!(Instant::now() < deadline, "receipt reconciliation stalled");
            while let Ok(response) = done.try_recv() {
                responses.push(response);
            }
            if responses.len() == 2 {
                break;
            }
            if let Ok(frame) = f.frames.recv_timeout(Duration::from_millis(20)) {
                assert!(
                    owner.frame(&f, &frame, false) || f.ordinary_frame(&frame),
                    "{frame}"
                );
            }
        }
        assert_eq!(
            owner.queries.len(),
            4,
            "only two original receipts; no mutation replay"
        );
        for response in responses {
            assert_eq!(
                response["result"]["reconciled"].as_array().unwrap().len(),
                1,
                "{response}"
            );
        }
        for first in original {
            let recovered = owner
                .queries
                .iter()
                .find(|q| q["action"] == "receipt" && q["origin"] == first["origin"])
                .unwrap();
            assert_eq!(recovered["arguments"], first["arguments"]);
            assert_eq!(recovered["view"], first["view"]);
        }
        assert_eq!(owner.plan_ref.as_deref(), Some("later-ui-plan"));
        let db = f.catalog();
        let db = db.lock().unwrap();
        assert_eq!(db.run(&f.run.id).unwrap().state, RunState::Cancelled);
        assert_eq!(
            db.memory_state(&f.run.branch_id).unwrap().unwrap().memories[0]["content"],
            "Later UI note"
        );
        drop(db);

        f.finish();
    }
}

#[test]
fn plan_scope_rejects_role_only_bot_foreign_and_missing_admissions() {
    use varin_runtime::{catalog::context::ContextProposal, SubmitInput};
    let root = std::env::temp_dir().join(format!("varin-plan-scope-{}", uuid::Uuid::new_v4()));
    let mut db = Catalog::open(&root).unwrap();
    for (index, (mode, role, session, context, expected)) in [
        ("agent", "main", "actual", true, true),
        ("agent", "worker", "actual", true, false),
        ("agent", "read-only", "actual", true, false),
        ("bot", "main", "actual", true, false),
        ("agent", "main", "foreign", true, false),
        ("agent", "main", "actual", false, false),
    ]
    .into_iter()
    .enumerate()
    {
        let thread = format!("thread-{index}");
        let branch = format!("branch-{index}");
        db.create_thread(&thread, &branch).unwrap();
        let basis=serde_json::from_value(json!({"mode":mode,"threadRole":role,"revision":0,
            "configurationDigest":"scope-test","memorySnapshot":{"revision":0,"memories":[]},
            "sessionId":if session=="actual"{&thread}else{session},"projectId":null,
            "originalSections":[{"name":"preamble","content":"Scope test"}],"instructionSources":[]})).unwrap();
        let receipt = db.submit_with_context_snapshot(
            &SubmitInput {
                key: format!("input-{index}"),
                thread_id: thread,
                branch_id: branch.clone(),
                expected_head: None,
                input: json!("Check admission"),
                configuration: json!({}),
            },
            None,
            false,
            context.then_some(ContextProposal {
                key: format!("context-{index}"),
                branch_id: branch,
                through_id: None,
                expected_revision: 0,
                summary: String::new(),
                effective_system_prompt: "Scope test".into(),
                instruction_sources: vec![],
                memory_checkpoint: None,
            }),
            context.then_some(basis),
        );
        if session == "foreign" {
            assert!(
                receipt.is_err(),
                "foreign identity is rejected before scope publication"
            );
            continue;
        }
        let receipt = receipt.unwrap();
        assert_eq!(
            crate::plan::eligible(&db, &receipt.run_id).unwrap(),
            expected,
            "{mode}/{role}/{session}/{context}"
        );
    }
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
