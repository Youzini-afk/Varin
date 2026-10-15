//! Original tool/Goal admission, external receipt recovery and exactly-once accounting.
#[path = "fixtures/input_admission.rs"]
mod admission;
use admission::InputAdmission;
use serde_json::json;
use varin_runtime::{
    catalog::{goals::*, inference::*, launches::LaunchSelection},
    execution::*,
    *,
};
struct Fixture {
    root: std::path::PathBuf,
    db: Catalog,
    run: String,
    context: ToolExecutionContext,
    owner: ExecutorOwner,
}
fn record(db: &mut Catalog, run: &str, value: ExecutionRecord) {
    db.commit_execution(run, db.epoch(), &value).unwrap();
}
impl Fixture {
    fn new(budget: u64) -> Self {
        let root =
            std::env::temp_dir().join(format!("varin-decision-ledger-{}", uuid::Uuid::new_v4()));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("thread", "branch").unwrap();
        let schema:ToolSchema=serde_json::from_value(json!({"name":"research_decide","version":"1","description":"Judge actual material","schema":{"type":"object"},"output_schema":null,"metadata":null})).unwrap();
        let launch:LaunchSelection=serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"fixture","provider_family":"fixture","model":"fixture",
            "configuration_generation":1,"tool_schema_generation":1,"tools":[schema],"policy":{"name":"default","version":"1"},"source":null})).unwrap();
        let run = db
            .submit_with_launch(
                &SubmitInput {
                    key: "input".into(),
                    thread_id: "thread".into(),
                    branch_id: "branch".into(),
                    expected_head: None,
                    input: json!("Judge original candidates"),
                    configuration: json!({}),
                },
                Some(launch),
            )
            .unwrap()
            .run_id;
        record(
            &mut db,
            &run,
            ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None,
            },
        );
        let goal = db
            .prepare_goal_start(
                "goal",
                &run,
                GoalScope {
                    thread_id: "thread".into(),
                    branch_id: "branch".into(),
                },
                "Explicit inference budget".into(),
                Some(GoalBudget {
                    max_output_tokens: budget,
                }),
            )
            .unwrap()
            .load()
            .unwrap();
        db.admit_goal_mutation(goal).unwrap();
        let range = HistoryRange {
            branch_id: "branch".into(),
            ancestor_id: None,
            leaf_id: db.head("branch").unwrap(),
        };
        let binding:RequestBinding=serde_json::from_value(json!({"child_dispatch":null,"goal":db.goal_binding(&run).unwrap(),"resource_activations":[],"resource_checkpoint_id":null,
            "connection_identity":"fixture","provider_family":"fixture","model":"fixture","credential_ref":null,"configuration_generation":1,"tool_schema_generation":1,
            "tools":[schema],"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":range})).unwrap();
        let call = ToolCall {
            call_id: "decide".into(),
            name: "research_decide".into(),
            schema_version: "1".into(),
            arguments: json!({"goal":"Judge original"}),
        };
        record(
            &mut db,
            &run,
            ExecutionRecord::RequestPrepared {
                snapshot: RequestSnapshot {
                    view: RequestView {
                        request_id: "request".into(),
                        run_id: run.clone(),
                        origin: RequestOrigin::Conversation {
                            compaction: None, step: 0,
                            history_range: range,
                        },
                        binding,
                        history: vec![],
                    },
                    serialized: json!({}).into(),
                }.into(),
            },
        );
        record(
            &mut db,
            &run,
            ExecutionRecord::ModelDispatched {
                request_id: "request".into(),
            },
        );
        record(
            &mut db,
            &run,
            ExecutionRecord::ModelFinished {
                request_id: "request".into(),
                outcome: ModelOutcome::Completed,
                finish_reason: Some(FinishReason::ToolCalls),
                items: vec![ProviderItem {
                    id: "tool".into(),
                    opaque: None,
                    content: Content::ToolCall { call: call.clone() },
                }],
                interrupted_deltas: vec![],
                usage: UsageReceipt {
                    measurement: UsageMeasurement::Actual,
                    input_tokens: Some(3),
                    output_tokens: Some(2),
                    ..Default::default()
                },
                failure: None,
            },
        );
        let context = ToolExecutionContext {
            run_id: run.clone(),
            operation_id: "request:tool:decide".into(),
            origin: ToolOrigin::ModelStep {
                request_id: "request".into(),
            },
        };
        record(
            &mut db,
            &run,
            ExecutionRecord::ToolAdmitted {
                context: context.clone(),
                tool: AdmittedTool {
                    call,
                    contract: ToolContract {
                        name: "research_decide".into(),
                        schema_version: "1".into(),
                        read_only: true,
                        completion: CompletionKind::Result,
                        lifetime: Lifetime::Run,
                        resources: vec![],
                    },
                },
            },
        );
        let owner = ExecutorOwner::External {
            identity: "original-host-owner".into(),
            epoch: "original-host-epoch".into(),
        };
        record(
            &mut db,
            &run,
            ExecutionRecord::ToolDispatched {
                context: context.clone(),
                executor_owner: owner.clone(),
            },
        );
        Self {
            root,
            db,
            run,
            context,
            owner,
        }
    }
    fn admit(&mut self, ordinal: u64) -> InferenceOwnerParams {
        self.admit_kind(ordinal, InferenceRequestKind::ModelCompute)
    }
    fn admit_kind(&mut self, ordinal: u64, kind: InferenceRequestKind) -> InferenceOwnerParams {
        self.admit_executor(ordinal, kind, None)
    }
    fn admit_executor(&mut self, ordinal: u64, kind: InferenceRequestKind, executor: Option<InferenceExecutor>) -> InferenceOwnerParams {
        let mut input:InferenceAdmitParams=serde_json::from_value(json!({"parentOperationId":self.context.operation_id,"executionOwner":self.owner,"ordinal":ordinal,
            "binding":{"requestKind":kind,"purpose":"web","providerId":"fixture","modelId":"classifier","configurationId":"frozen-config","executor":{"kind":"http","api":"typesafe-system-one","endpoint":"https://fixture.invalid/systemone",
                "credentialScope":{"reference":"provider:fixture","authority":"original-store","account":"original-account","generation":1}}},
            "request":{"materials":[{"snapshotId":"original","text":"原始材料".repeat(5000)}],"questions":[{"id":"a"}]}})).unwrap();
        if let Some(executor) = executor { input.binding.executor = executor; }
        let body = self
            .db
            .prepare_inference_content()
            .write(&input.request)
            .unwrap();
        let status = self.db.admit_inference(&input, body).unwrap();
        InferenceOwnerParams {
            operation_id: status.operation_id,
            execution_owner: self.owner.clone(),
        }
    }
    fn settle(
        &mut self,
        p: &InferenceOwnerParams,
        started: bool,
        output: Option<u64>,
    ) -> InferenceSettleParams {
        let receipt = InferenceReceipt {
            request_started: Some(started),
            provider_completed: started,
            local_executor_stopped: true,
            usage: if started {
                InferenceUsage {
                    measurement: UsageMeasurement::Actual,
                    input_tokens: Some(11),
                    output_tokens: output,
                    ..InferenceUsage::default()
                }
            } else {
                InferenceUsage::default()
            },
            http_status: if started { Some(200) } else { None },
            problem: if started {
                None
            } else {
                Some(InferenceProblem::NotDispatched)
            },
        };
        let value = InferenceSettleParams {
            operation_id: p.operation_id.clone(),
            execution_owner: p.execution_owner.clone(),
            receipt,
            response: json!({"original":"完整原响应","usage":{"input_tokens":11,"output_tokens":output}}),
        };
        let body = self
            .db
            .prepare_inference_content()
            .write(&value.response)
            .unwrap();
        self.db.settle_inference(&value, body).unwrap();
        value
    }
    fn usage(&self) -> GoalUsage {
        self.db.capture_goal("goal").unwrap().load().unwrap().usage
    }
}
#[test]
fn recovered_original_owner_refines_once_without_restarting_request() {
    for started in [true, false] {
        let mut f = Fixture::new(100);
        let request = f.admit(2);
        assert!(f.db.operation(&format!("inference:{}:1", f.context.operation_id)).is_err());
        f.db.dispatch_inference(&request).unwrap();
        assert_eq!(f.usage().pending_inferences, 1);
        let root = f.root.clone();
        drop(f.db);
        f.db = Catalog::open(&root).unwrap();
        assert!(f.db.inference_session(&InferenceSessionParams {
            parent_operation_id: f.context.operation_id.clone(), execution_owner: f.owner.clone(),
        }).unwrap().has_requests);
        assert_eq!(f.usage().missing_inferences, 1);
        assert_eq!(f.usage().pending_inferences, 0);
        let unknown =
            f.db.inference_status(&request.operation_id, &request.execution_owner)
                .unwrap();
        assert!(unknown.recovered);
        assert_eq!(unknown.outcome, Some(Outcome::Indeterminate));
        assert!(!unknown.receipt.unwrap().local_executor_stopped);
        assert!(f.db.dispatch_inference(&request).is_err());
        let foreign = ExecutorOwner::External {
            identity: "other-host".into(),
            epoch: "fresh-epoch".into(),
        };
        assert!(
            f.db.inference_status(&request.operation_id, &foreign)
                .is_err()
        );
        let value = f.settle(&request, started, Some(7));
        let settled =
            f.db.inference_status(&request.operation_id, &request.execution_owner)
                .unwrap();
        assert_eq!(
            settled.outcome,
            Some(if started {
                Outcome::Succeeded
            } else {
                Outcome::Failed
            })
        );
        assert_eq!(
            f.db.operation(&request.operation_id).unwrap().effect,
            if started {
                Effect::Confirmed
            } else {
                Effect::None
            }
        );
        let usage = f.usage();
        assert_eq!(usage.pending_inferences, 0);
        assert_eq!(usage.missing_inferences, 0);
        assert_eq!(
            usage.actual.input_tokens.known,
            if started { 14 } else { 3 }
        );
        assert_eq!(
            usage.actual.output_tokens.known,
            if started { 9 } else { 2 }
        );
        let revision = f.db.operation(&request.operation_id).unwrap().revision;
        let cursor = f.db.event_cursor().unwrap();
        let body =
            f.db.prepare_inference_content()
                .write(&value.response)
                .unwrap();
        f.db.settle_inference(&value, body).unwrap();
        assert_eq!(
            f.db.operation(&request.operation_id).unwrap().revision,
            revision
        );
        assert_eq!(f.db.event_cursor().unwrap(), cursor);
        assert_eq!(f.usage(), usage);
        let mut invalid = value.clone();
        invalid.execution_owner = foreign;
        let body =
            f.db.prepare_inference_content()
                .write(&invalid.response)
                .unwrap();
        assert!(f.db.settle_inference(&invalid, body).is_err());
        let original =
            f.db.capture_operation_read(f.db.operation(&request.operation_id).unwrap())
                .load()
                .unwrap();
        assert_eq!(
            serde_json::to_value(&original.result).unwrap()["value"]["response"],
            value.response
        );
        assert_eq!(
            f.db.prepare_content_collection(Default::default())
                .run()
                .status,
            ContentCollectionStatus::Completed
        );
        drop(f.db);
        let db = Catalog::open(&root).unwrap();
        assert_eq!(
            db.capture_operation_read(db.operation(&request.operation_id).unwrap())
                .load()
                .unwrap(),
            original
        );
        assert_eq!(
            db.capture_goal("goal").unwrap().load().unwrap().usage,
            usage
        );
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
#[test]
fn budget_fences_new_dispatch_without_cancelling_an_already_admitted_transport() {
    let mut f = Fixture::new(9);
    let a = f.admit(1);
    let b = f.admit(2);
    f.db.dispatch_inference(&a).unwrap();
    f.db.dispatch_inference(&b).unwrap();
    f.settle(&a, true, Some(7));
    assert!(
        f.db.inference_status(&b.operation_id, &b.execution_owner)
            .unwrap()
            .live
    );
    let c = f.admit(3);
    assert!(matches!(
        f.db.dispatch_inference(&c),
        Err(RuntimeError::GoalChanged)
    ));
    f.db.request_cancel_operation(&f.context.operation_id)
        .unwrap();
    assert!(
        !f.db
            .inference_status(&b.operation_id, &b.execution_owner)
            .unwrap()
            .live
    );
    f.settle(&b, false, None);
    f.settle(&c, false, None);
    assert_eq!(f.usage().pending_inferences, 0);
    assert!(!f.db.run(&f.run).unwrap().cancel_requested);
    let root = f.root.clone();
    drop(f.db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn undurable_drained_receipt_keeps_original_send_knowledge_and_late_barrier_is_idempotent() {
    for started in [true, false] {
        let mut f = Fixture::new(100);
        let request = f.admit(1);
        f.db.dispatch_inference(&request).unwrap();
        let pending = InferenceReceiptPendingParams {
            operation_id: request.operation_id.clone(),
            execution_owner: request.execution_owner.clone(),
            request_started: Some(started),
        };
        let status = f.db.inference_receipt_pending(&pending).unwrap();
        assert!(status.receipt_pending);
        assert!(!status.recovered);
        assert_eq!(f.usage().pending_inferences, 0);
        assert_eq!(f.usage().missing_inferences, if started { 1 } else { 0 });
        let before = f.db.event_cursor().unwrap();
        f.db.inference_receipt_pending(&pending).unwrap();
        assert_eq!(f.db.event_cursor().unwrap(), before);
        let mut wrong = pending.clone();
        wrong.request_started = Some(!started);
        assert!(f.db.inference_receipt_pending(&wrong).is_err());
        let final_receipt = f.settle(&request, started, Some(7));
        let usage = f.usage();
        assert_eq!(usage.missing_inferences, 0);
        assert_eq!(
            usage.actual.output_tokens.known,
            if started { 9 } else { 2 }
        );
        let op = f.db.operation(&request.operation_id).unwrap();
        let cursor = f.db.event_cursor().unwrap();
        f.db.inference_receipt_pending(&pending).unwrap();
        assert_eq!(f.db.operation(&request.operation_id).unwrap(), op);
        assert_eq!(f.db.event_cursor().unwrap(), cursor);
        assert_eq!(f.usage(), usage);
        let mut wrong = final_receipt;
        wrong.receipt.request_started = Some(!started);
        let body =
            f.db.prepare_inference_content()
                .write(&wrong.response)
                .unwrap();
        assert!(f.db.settle_inference(&wrong, body).is_err());
        let root = f.root.clone();
        drop(f.db);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn preparations_keep_original_receipts_without_model_usage_or_replay() {
    let mut f = Fixture::new(100);
    let expected_output = f.usage().actual.output_tokens.known + 3;
    let request = f.admit_kind(1, InferenceRequestKind::Preparation);
    let status = f.db.dispatch_inference(&request).unwrap();
    assert_eq!(status.request_kind, InferenceRequestKind::Preparation);
    assert_eq!(f.usage().pending_inferences, 0);
    let compute = f.admit(2);
    f.db.dispatch_inference(&compute).unwrap();
    assert_eq!(f.usage().pending_inferences, 1);
    f.settle(&compute, true, Some(3));
    assert_eq!(f.usage().actual.output_tokens.known, expected_output);
    let root = f.root.clone();
    drop(f.db);
    f.db = Catalog::open(&root).unwrap();
    assert_eq!(f.usage().actual.output_tokens.known, expected_output);
    assert_eq!(f.usage().missing_inferences, 0);
    assert_eq!(f.usage().pending_inferences, 0);
    let status =
        f.db.inference_status(&request.operation_id, &request.execution_owner)
            .unwrap();
    assert!(status.recovered);
    assert_eq!(status.request_kind, InferenceRequestKind::Preparation);
    assert!(!status.receipt.unwrap().local_executor_stopped);
    assert!(f.db.dispatch_inference(&request).is_err());
    f.db.inference_receipt_pending(&InferenceReceiptPendingParams {
        operation_id: request.operation_id.clone(),
        execution_owner: f.owner.clone(),
        request_started: Some(true),
    })
    .unwrap();
    assert_eq!(f.usage().actual.output_tokens.known, expected_output);
    assert_eq!(f.usage().missing_inferences, 0);
    let value = InferenceSettleParams {
        operation_id: request.operation_id.clone(),
        execution_owner: f.owner.clone(),
        receipt: InferenceReceipt {
            request_started: Some(true),
            provider_completed: true,
            local_executor_stopped: true,
            usage: InferenceUsage::default(),
            http_status: Some(200),
            problem: None,
        },
        response: json!({"tokens":[1,2]}),
    };
    let body =
        f.db.prepare_inference_content()
            .write(&value.response)
            .unwrap();
    let settled = f.db.settle_inference(&value, body).unwrap();
    assert_eq!(settled.outcome, Some(Outcome::Succeeded));
    assert_eq!(f.usage().actual.output_tokens.known, expected_output);
    assert_eq!(f.usage().missing_inferences, 0);
    assert_eq!(f.usage().pending_inferences, 0);
    drop(f.db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn local_unknown_entry_keeps_the_original_goal_barrier_and_late_receipt_refines_once() {
    for pending_first in [false, true] {
        let mut f = Fixture::new(100);
        let original_actual = f.usage().actual.inferences;
        let request = f.admit_executor(1, InferenceRequestKind::ModelCompute, Some(InferenceExecutor::LocalComponent {
            component_id: "local-semantic".into(), component_version: "fixture".into(), manifest_digest: "a".repeat(64),
            model_revision: "original-model".into(), worker_protocol: 1,
        }));
        f.db.dispatch_inference(&request).unwrap();
        if pending_first {
            let pending = f.db.inference_receipt_pending(&InferenceReceiptPendingParams {
                operation_id: request.operation_id.clone(), execution_owner: request.execution_owner.clone(), request_started: None,
            }).unwrap();
            assert_eq!(pending.receipt.unwrap().request_started, None);
            assert_eq!(f.usage().missing_inferences, 1);
        }
        let root = f.root.clone();
        drop(f.db); f.db = Catalog::open(&root).unwrap();
        let recovered = f.db.inference_status(&request.operation_id, &request.execution_owner).unwrap();
        assert_eq!(recovered.receipt.as_ref().unwrap().request_started, None);
        assert_eq!(recovered.receipt.unwrap().local_executor_stopped, pending_first);
        assert!(f.db.dispatch_inference(&request).is_err(), "original computation must never replay");
        assert_eq!(f.usage().missing_inferences, 1);
        let receipt = InferenceSettleParams {
            operation_id: request.operation_id.clone(), execution_owner: request.execution_owner.clone(),
            receipt: InferenceReceipt { request_started: Some(true), provider_completed: true, local_executor_stopped: true,
                usage: InferenceUsage { measurement: UsageMeasurement::Estimated, input_tokens: Some(19), output_tokens: Some(0), ..Default::default() },
                http_status: None, problem: None }, response: json!({"vectors":[[1,0]],"basis":"untruncated-tokenizer-estimate"}),
        };
        for _ in 0..2 {
            let body = f.db.prepare_inference_content().write(&receipt.response).unwrap();
            f.db.settle_inference(&receipt, body).unwrap();
        }
        assert_eq!(f.usage().missing_inferences, 0);
        assert_eq!(f.usage().pending_inferences, 0);
        assert_eq!(f.usage().estimated.inferences, 1);
        assert_eq!(f.usage().estimated.input_tokens.known, 19);
        assert_eq!(f.usage().estimated.output_tokens.known, 0);
        assert_eq!(f.usage().actual.inferences, original_actual);
        let operation = f.db.capture_operation_read(f.db.operation(&request.operation_id).unwrap()).load().unwrap();
        assert_eq!(operation.executor.as_deref(), Some("inference.local.v1"));
        assert!(operation.intent["binding"]["executor"].get("credentialScope").is_none());
        assert!(operation.intent["binding"]["executor"].get("endpoint").is_none());
        drop(f.db); std::fs::remove_dir_all(root).unwrap();
    }
    let mut f = Fixture::new(100);
    let request = f.admit(1); f.db.dispatch_inference(&request).unwrap();
    assert!(f.db.inference_receipt_pending(&InferenceReceiptPendingParams {
        operation_id: request.operation_id, execution_owner: request.execution_owner, request_started: None,
    }).is_err(), "the local unknown-entry case does not relax HTTP owner evidence");
    let root = f.root.clone(); drop(f.db); std::fs::remove_dir_all(root).unwrap();
}


fn thread_usage(db: &Catalog, thread: &str, branch: &str) -> varin_runtime::catalog::usage::ThreadUsage {
    db.capture_thread_usage(&varin_runtime::catalog::usage::ThreadUsageParams {
        thread_id: thread.into(), branch_id: branch.into(),
    }).unwrap().load(&|| false).unwrap()
}

#[test]
fn thread_usage_counts_original_inference_once_and_keeps_missing_distinct_from_zero() {
    let mut f = Fixture::new(100);
    let first = f.admit(1); f.db.dispatch_inference(&first).unwrap();
    let pending = thread_usage(&f.db, "thread", "branch");
    let auxiliary = pending.rows.iter().find(|row| row.kind == "auxiliary").unwrap();
    assert_eq!(auxiliary.pending_requests, 1);
    assert_eq!(auxiliary.output_tokens.known, None);
    assert_eq!(auxiliary.output_tokens.missing, 1);
    let second = f.admit(2); f.db.dispatch_inference(&second).unwrap();
    let preparation = f.admit_kind(3, InferenceRequestKind::Preparation);
    f.db.dispatch_inference(&preparation).unwrap();
    let undelivered = f.admit(4); f.db.dispatch_inference(&undelivered).unwrap();
    let receipt = f.settle(&first, true, None);
    let body = f.db.prepare_inference_content().write(&receipt.response).unwrap();
    f.db.settle_inference(&receipt, body).unwrap(); // Original receipt replay never adds a request.
    f.settle(&second, true, Some(0));
    f.settle(&undelivered, false, None);
    let usage = thread_usage(&f.db, "thread", "branch");
    assert_eq!(usage.rows.len(), 2);
    let main = usage.rows.iter().find(|row| row.kind == "conversation").unwrap();
    assert_eq!(main.requests, 1); assert_eq!(main.input_tokens.known.as_deref(), Some("3"));
    let auxiliary = usage.rows.iter().find(|row| row.kind == "auxiliary").unwrap();
    assert_eq!(auxiliary.requests, 2); assert_eq!(auxiliary.pending_requests, 0);
    assert_eq!(auxiliary.input_tokens.known.as_deref(), Some("22"));
    assert_eq!(auxiliary.output_tokens.known.as_deref(), Some("0"));
    assert_eq!(auxiliary.output_tokens.missing, 1);
    assert_eq!(auxiliary.cached_input_tokens.known, None);
    assert_eq!(usage.not_dispatched_requests, 1);
    let root = f.root.clone(); drop(f.db); std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn thread_usage_is_branch_scoped_and_snapshot_cancellation_does_not_mutate_execution() {
    let mut f = Fixture::new(100);
    let request = f.admit(1); f.db.dispatch_inference(&request).unwrap();
    let frozen = f.db.capture_thread_usage(&varin_runtime::catalog::usage::ThreadUsageParams {
        thread_id: "thread".into(), branch_id: "branch".into(),
    }).unwrap();
    f.settle(&request, true, Some(7));
    assert_eq!(frozen.load(&|| false).unwrap().rows.iter().find(|row| row.kind == "auxiliary").unwrap().pending_requests, 1);
    assert_eq!(thread_usage(&f.db, "thread", "branch").rows.iter().find(|row| row.kind == "auxiliary").unwrap().output_tokens.known.as_deref(), Some("7"));
    let original = f.db.model_step("request").unwrap().request;
    let head = original["view"]["binding"]["history_range"]["leaf_id"].as_str();
    f.db.fork_branch("branch", "fork", head).unwrap();
    assert!(thread_usage(&f.db, "thread", "fork").rows.is_empty(), "inherited history does not duplicate execution costs");
    f.db.create_thread("other-thread", "other-branch").unwrap();
    assert!(thread_usage(&f.db, "other-thread", "other-branch").rows.is_empty());
    assert!(f.db.capture_thread_usage(&varin_runtime::catalog::usage::ThreadUsageParams {
        thread_id: "other-thread".into(), branch_id: "branch".into(),
    }).is_err());
    let read = f.db.capture_thread_usage(&varin_runtime::catalog::usage::ThreadUsageParams {
        thread_id: "thread".into(), branch_id: "branch".into(),
    }).unwrap();
    assert!(matches!(read.load(&|| true), Err(RuntimeError::DispatchCancelled)));
    assert_eq!(thread_usage(&f.db, "thread", "branch").rows.iter().map(|row| row.requests).sum::<u64>(), 2);
    let root = f.root.clone(); drop(f.db); std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn thread_usage_ignores_mirrored_model_steps_and_preserves_large_receipt_totals() {
    let mut f = Fixture::new(100);
    let original = f.db.model_step("request").unwrap().request;
    for index in 0..2 {
        let id = format!("large-{index}");
        f.db.prepare_model_step(&id, &f.run, f.db.epoch(), original.clone()).unwrap();
        f.db.dispatch_model_step(&id, f.db.epoch()).unwrap();
        f.db.settle_model_step(&id, f.db.epoch(), ModelStepState::Completed, vec![], Some(serde_json::to_value(UsageReceipt {
            measurement: UsageMeasurement::Actual, input_tokens: Some(u64::MAX), output_tokens: Some(0), ..Default::default()
        }).unwrap())).unwrap();
    }
    let mut mirrored = original.clone();
    mirrored["view"]["origin"] = serde_json::to_value(RequestOrigin::AuxiliaryInference {
        operation_id: "original-inference".into(), parent_operation_id: f.context.operation_id.clone(), purpose: "web".into(),
    }).unwrap();
    f.db.prepare_model_step("mirrored", &f.run, f.db.epoch(), mirrored).unwrap();
    f.db.dispatch_model_step("mirrored", f.db.epoch()).unwrap();
    f.db.settle_model_step("mirrored", f.db.epoch(), ModelStepState::Completed, vec![], Some(serde_json::to_value(UsageReceipt {
        measurement: UsageMeasurement::Actual, input_tokens: Some(100), output_tokens: Some(100), ..Default::default()
    }).unwrap())).unwrap();
    f.db.prepare_model_step("estimated", &f.run, f.db.epoch(), original).unwrap();
    f.db.dispatch_model_step("estimated", f.db.epoch()).unwrap();
    f.db.settle_model_step("estimated", f.db.epoch(), ModelStepState::Interrupted, vec![], Some(serde_json::to_value(UsageReceipt {
        measurement: UsageMeasurement::Estimated, input_tokens: Some(9), ..Default::default()
    }).unwrap())).unwrap();
    let usage = thread_usage(&f.db, "thread", "branch");
    assert_eq!(usage.rows.len(), 2);
    let actual = usage.rows.iter().find(|row| row.measurement == UsageMeasurement::Actual).unwrap();
    assert_eq!(actual.requests, 3);
    assert_eq!(actual.input_tokens.known.as_deref(), Some("36893488147419103233"));
    assert_eq!(actual.output_tokens.known.as_deref(), Some("2"));
    let estimated = usage.rows.iter().find(|row| row.measurement == UsageMeasurement::Estimated).unwrap();
    assert_eq!(estimated.requests, 1); assert_eq!(estimated.input_tokens.known.as_deref(), Some("9"));
    assert_eq!(estimated.output_tokens.known, None);
    let root = f.root.clone(); drop(f.db); std::fs::remove_dir_all(root).unwrap();
}
