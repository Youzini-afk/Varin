//! Live custom loop over actual Questions, InvocationRunner and original Catalog receipts.
use serde_json::{json, Value};
use std::sync::{mpsc, Arc};
use std::time::Duration;
use varin_runtime::{
    catalog::launches::LaunchSelection,
    composition::tools::ToolDirectory,
    driver::*,
    execution::*,
    supervisor::{RunStart, RunSupervisor},
    *,
};
#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
struct NoModel;
impl ModelProvider for NoModel {
    fn serialize(
        &self,
        _: &RequestView,
        _: Option<&mut RequestCompileReuse>,
    ) -> Result<RequestBody, ExecutionError> {
        panic!("no fabricated model call")
    }
    fn generate(
        &self,
        _: &RequestSnapshot,
        _: &CancellationToken,
        _: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        panic!("no model required")
    }
}
struct AskingDriver {
    selection: DriverSelection,
    opened: mpsc::Sender<String>,
}
impl RunDriver for AskingDriver {
    fn selection(&self) -> DriverSelection {
        self.selection.clone()
    }
    fn run(&self, context: Arc<DriverContext>) -> Result<ExecutionReport, ExecutionError> {
        context.prepare_custom()?;
        let ask=context.tool(DriverToolInput{id:"question".into(),name:"ask_user".into(),arguments:json!({"questions":[{"id":"choice","question":"Which original branch?","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}]})})?;
        assert!(matches!(ask.completion, ToolCompletion::JobAccepted { .. }));
        self.opened.send(ask.operation_id.clone()).unwrap();
        let work = vec![DriverReceiptInput {
            id: "question".into(),
            kind: varin_runtime::catalog::driver::DriverWorkKind::Tool,
        }];
        let mut observed = context.wait(DriverWaitInput {
            after: None,
            work: work.clone(),
        })?;
        while !matches!(
            &observed.receipts[..],
            [DriverReceipt::Tool {
                phase: Some(OperationPhase::Terminal),
                ..
            }]
        ) {
            observed = context.wait(DriverWaitInput {
                after: Some(observed.cursor),
                work: work.clone(),
            })?;
        }
        let current = context.context(DriverContextInput {})?;
        assert!(current
            .history
            .iter()
            .any(|item| item.id == format!("question-answer:{}", ask.operation_id)));
        let status = context.tool(DriverToolInput {
            id: "answer-status".into(),
            name: "question_status".into(),
            arguments: json!({"operationId":ask.operation_id}),
        })?;
        let ToolCompletion::Result { content, .. } = status.completion else {
            panic!("original status receipt required")
        };
        assert_eq!(content.data["status"], "answered");
        assert!(content.data["answer"].as_str().unwrap().contains("B"));
        context.deliver(DriverDeliveryInput {
            id: "answer".into(),
            text: "Same original loop used answer B".into(),
        })?;
        context.finish_custom(Ok(DriverRunOutcome::Complete))
    }
}
#[test]
fn live_driver_question_answer_uses_original_domain_without_quiescing_or_rebinding() {
    let root = std::env::temp_dir().join(format!("varin-driver-question-{}", uuid::Uuid::new_v4()));
    let mut db = Catalog::open(&root).unwrap();
    db.create_thread("thread", "main").unwrap();
    let submitted = db
        .submit(&SubmitInput {
            key: "input".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            expected_head: None,
            input: json!({"text":"Ask without restarting"}),
            configuration: json!({}),
        })
        .unwrap();
    let binding:RequestBinding=serde_json::from_value(json!({"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"fixture","provider_family":"fixture","model":"unused","credential_ref":null,"configuration_generation":1,"tool_schema_generation":1,"tools":crate::questions::schemas(vec![]),"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":"main","ancestor_id":null,"leaf_id":submitted.input_id}})).unwrap();
    let selection = DriverSelection::Extension {
        artifact: DriverArtifact {
            provider_key: "question-driver:host:varin.agent.driver@1".into(),
            extension_id: "question-driver".into(),
            extension_version: "1".into(),
            service_id: "varin.agent.driver".into(),
            service_version: 1,
            artifact_integrity: "original".into(),
            composition: crate::service_composition_fixture::graph(
                "question-driver",
                "1",
                "original",
            ),
            configuration_identity: "original".into(),
            identity: PolicyIdentity {
                name: "question-driver".into(),
                version: "1".into(),
            },
            model_roles: vec![],
            recovery: DriverRecovery::None,
            checkpoint_schema: None,
        },
    };
    db.select_launch(
        &submitted.run_id,
        LaunchSelection::from_binding(&binding, DefaultAgentPolicy.identity(), None),
    )
    .unwrap();
    let prepared = db
        .prepare_run_driver(&submitted.run_id, &selection, vec![])
        .unwrap()
        .load()
        .unwrap();
    let selected = db
        .admit_run_driver(prepared)
        .unwrap()
        .load()
        .unwrap()
        .selection;
    db.bind_launch(&submitted.run_id, selected).unwrap();
    let runtime = Arc::new(RunSupervisor::new(db));
    let owner = runtime.catalog();
    let before = owner
        .lock()
        .unwrap()
        .launch_metadata(&submitted.run_id)
        .unwrap()
        .unwrap();
    let (opened, receive) = mpsc::channel();
    let start = RunStart {
        driver: Arc::new(AskingDriver { selection, opened }),
        binding,
        policy_state: Value::Null,
        provider: Arc::new(NoModel),
        tools: Arc::new(
            ToolDirectory::assemble(vec![
                crate::questions::declaration(owner.clone()),
                crate::questions::status_declaration(owner.clone()),
            ])
            .unwrap(),
        ),
        policy: Arc::new(DefaultAgentPolicy),
        context_preparation: Arc::new(NoopContextPreparation),
        progress: ProgressSink::default(),
    };
    let handle = runtime.start(&submitted.run_id, start).unwrap();
    let operation = receive.recv_timeout(Duration::from_secs(5)).unwrap();
    let read = owner.lock().unwrap().capture_attention_read();
    let attention = read.load(&|| false).unwrap();
    assert!(attention.items.iter().any(|item| item.kind == "question"
        && item.actionable
        && item.operation_id.as_deref() == Some(operation.as_str())));
    assert_eq!(
        owner.lock().unwrap().run(&submitted.run_id).unwrap().state,
        RunState::Runnable
    );
    runtime.quiesce_question(&operation).unwrap();
    let preparation=owner.lock().unwrap().prepare_question_answer(&operation,Some(json!([{"questionId":"choice","selectedOptionIds":["b"],"text":"","skipped":false}]))).unwrap();
    let prepared = preparation.load().unwrap();
    owner
        .lock()
        .unwrap()
        .admit_question_answer(prepared)
        .unwrap();
    let report = handle.wait().unwrap();
    assert_eq!(report.state, RunState::Completed);
    let after = owner
        .lock()
        .unwrap()
        .launch_metadata(&submitted.run_id)
        .unwrap()
        .unwrap();
    assert_eq!(after.bound_epoch, before.bound_epoch);
    assert_eq!(after.requires_rebind, before.requires_rebind);
    assert!(report.history.iter().any(|item|matches!(&item.content,Content::Text{text} if text=="Same original loop used answer B")));
    drop(runtime);
    drop(owner);
    let _ = std::fs::remove_dir_all(root);
}
