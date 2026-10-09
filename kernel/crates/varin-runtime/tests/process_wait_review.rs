//! Independent Catalog counterexamples. These exercise real committed model origins and reopen;
//! guardian, Storage grant authorization and Host continuation require the native integration lane.
use serde_json::{json, Value};
use varin_runtime::catalog::launches::LaunchSelection;
use varin_runtime::catalog::process_wait::WAIT_TOOL;
use varin_runtime::execution::*;
use varin_runtime::*;

struct Fixture { root: std::path::PathBuf, db: Catalog, run: String }
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("varin-process-wait-review-{}", uuid::Uuid::new_v4()));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("thread", "branch").unwrap();
        let launch: LaunchSelection = serde_json::from_value(json!({"connection_identity":"fixture",
            "provider_family":"fixture","model":"model","configuration_generation":1,"tool_schema_generation":1,
            "tools":[],"policy":{"name":"fixture","version":"1"},"source":null})).unwrap();
        let receipt = db.submit_with_launch(&SubmitInput { key:"input".into(),thread_id:"thread".into(),branch_id:"branch".into(),
            expected_head:None,input:json!("Observe process"),configuration:json!({}) }, Some(launch)).unwrap();
        let mut f = Self { root, db, run:receipt.run_id };
        f.state(RunState::Runnable, None);
        // Real accepted external owner: the observer does not synthesize a process completion.
        f.db.admit_operation("process", &f.run, f.db.epoch(), Lifetime::Thread, json!({})).unwrap();
        f.db.dispatch_operation("process", f.db.epoch(), "process_spawn", true).unwrap();
        f.db.handoff_operation("process", f.db.epoch()).unwrap();
        f
    }
    fn record(&mut self, r: ExecutionRecord) { self.db.commit_execution(&self.run, self.db.epoch(), &r).unwrap(); }
    fn state(&mut self, state:RunState, waiting_on:Option<String>) { self.record(ExecutionRecord::StateChanged{state,waiting_on}); }
    fn wait(&mut self, suffix:&str) -> Wait {
        let request = format!("request-{suffix}");
        let range = HistoryRange {branch_id:"branch".into(),ancestor_id:None,leaf_id:self.db.head("branch").unwrap()};
        let schema=ToolSchema{name:WAIT_TOOL.into(),version:"1".into(),schema:json!({"type":"object"})};
        let binding=RequestBinding{connection_identity:"fixture".into(),provider_family:"fixture".into(),model:"model".into(),
            credential_ref:None,configuration_generation:1,tool_schema_generation:1,tools:vec![schema],instruction_sources:vec![],
            memory_checkpoint:None,attachment_refs:vec![],environment_cursor:0,history_range:range.clone()};
        self.record(ExecutionRecord::RequestPrepared{snapshot:RequestSnapshot{view:RequestView{request_id:request.clone(),run_id:self.run.clone(),
            origin:RequestOrigin::Conversation{step:1,history_range:range},binding,history:vec![]},serialized:json!({})}});
        self.record(ExecutionRecord::ModelDispatched{request_id:request.clone()});
        let call=ToolCall{call_id:"wait".into(),name:WAIT_TOOL.into(),schema_version:"1".into(),arguments:json!({"processId":"process"})};
        self.record(ExecutionRecord::ModelFinished{request_id:request.clone(),outcome:ModelOutcome::Completed,finish_reason:Some(FinishReason::ToolCalls),
            items:vec![ProviderItem{id:format!("item-{suffix}"),content:Content::ToolCall{call:call.clone()},opaque:None}],
            interrupted_deltas:vec![],usage:UsageReceipt::default(),failure:None});
        self.record(ExecutionRecord::ToolsAdmitted{request_id:request.clone(),tools:vec![AdmittedTool{call,
            contract:ToolContract{name:WAIT_TOOL.into(),schema_version:"1".into(),read_only:true,completion:CompletionKind::Job,lifetime:Lifetime::Thread,resources:vec![]}}]});
        self.record(ExecutionRecord::ToolDispatched{request_id:request.clone(),call_id:"wait".into()});
        let context=ToolExecutionContext{run_id:self.run.clone(),operation_id:format!("{request}:tool:wait"),origin:ToolOrigin::ModelStep{request_id:request.clone()}};
        let wait=self.db.wait_for_process(&context,"process").unwrap();
        let result=ToolResult{request_id:request.clone(),call_id:"wait".into(),completion:ToolCompletion::JobAccepted{
            operation_id:context.operation_id,phase:"awaiting_process".into(),effect:Effect::None,lifetime:Lifetime::Thread}};
        self.record(ExecutionRecord::ToolSettled{result:result.clone()});
        self.record(ExecutionRecord::ToolBatchCommitted{request_id:request,results:vec![result]});
        self.state(RunState::Waiting,Some(wait.id.clone()));
        wait
    }
    fn terminal(&mut self) {
        self.db.record_external_receipt_with_stop("process",ExternalReceipt{executor:"process_spawn".into(),identity:"process".into(),
            epoch:"process-epoch".into(),outcome:Outcome::Succeeded,effect:Effect::Confirmed,
            result:json!({"processId":"process","kernelEpoch":"process-epoch","treeConfirmed":true,"exitCode":0,"signal":null,"outputAvailable":true})},true).unwrap();
    }
    fn reopen(self) -> Self {
        let Self{root,db,run}=self; drop(db);
        let db=Catalog::open(&root).unwrap(); Self{root,db,run}
    }
    fn cleanup(self) { let Self{root,db,..}=self;drop(db);std::fs::remove_dir_all(root).unwrap(); }
    fn facts(&self) -> Vec<Value> { self.db.history("branch").unwrap().into_iter().filter(|h|h.source==HistorySource::Environment).map(|h|h.content).collect() }
}

#[test]
fn reopen_live_process_does_not_treat_recovery_indeterminate_as_a_terminal_fact() {
    let mut f=Fixture::new(); let wait=f.wait("live"); let mut f=f.reopen();
    let pending=f.db.operation("process").unwrap();
    assert_eq!(pending.outcome,Some(Outcome::Indeterminate));
    assert!(pending.external_receipt.is_none());
    assert!(f.db.deliver_process_waits().expect("live guardian has no terminal event yet; observation must remain parked").is_empty());
    assert_eq!(f.db.run(&f.run).unwrap().waiting_on,Some(wait.id));
    assert!(f.facts().is_empty());
    f.terminal(); assert_eq!(f.db.deliver_process_waits().unwrap(),vec![f.run.clone()]);
    assert_eq!(f.facts().len(),1); f.cleanup();
}

#[test]
fn early_terminal_and_delivered_before_host_launch_reopen_keep_one_fact() {
    let mut f=Fixture::new(); f.terminal(); f.wait("early");
    assert_eq!(f.db.deliver_process_waits().unwrap(),vec![f.run.clone()]);
    let facts=f.facts(); assert_eq!(facts.len(),1);
    let mut f=f.reopen();
    assert_eq!(f.db.deliver_process_waits().unwrap(),vec![f.run.clone()]);
    assert_eq!(f.db.deliver_process_waits().unwrap(),vec![f.run.clone()]);
    assert_eq!(f.facts(),facts,"rediscovery of unlaunched continuation cannot duplicate history"); f.cleanup();
}

#[test]
fn cancel_observation_leaves_external_operation_running() {
    let mut f=Fixture::new(); let wait=f.wait("cancel");
    let process=f.db.operation("process").unwrap();
    f.db.cancel_process_wait(wait.id.strip_prefix("process-wait:").unwrap()).unwrap();
    assert_eq!(f.db.deliver_process_waits().unwrap(),vec![f.run.clone()]);
    assert_eq!(f.db.operation("process").unwrap(),process,"observation cancellation cannot cancel or settle process owner");
    f.terminal(); f.db.deliver_process_waits().unwrap();
    assert_eq!(f.facts().len(),1,"cancelled observer receives no late process-result message"); f.cleanup();
}

#[test]
fn durable_observer_cancel_intent_survives_crash_before_wait_flag_write() {
    let mut f=Fixture::new(); let wait=f.wait("cancel-crash");
    // This is exactly the durable boundary between request_cancel_operation and cancel_wait.
    let observer=wait.id.strip_prefix("process-wait:").unwrap();
    f.db.request_cancel_operation(observer).unwrap();
    let mut f=f.reopen();
    assert_eq!(f.db.deliver_process_waits().unwrap(),vec![f.run.clone()],
        "recovery must close the cancelled observation without waiting for the live process");
    assert_eq!(f.db.operation(observer).unwrap().outcome,Some(Outcome::Cancelled));
    assert!(!f.db.operation("process").unwrap().cancel_requested);
    f.cleanup();
}

#[test]
fn duplicate_terminal_and_second_observation_do_not_duplicate_visible_fact() {
    let mut f=Fixture::new(); f.terminal(); f.wait("first");
    f.db.deliver_process_waits().unwrap(); let facts=f.facts(); assert_eq!(facts.len(),1);
    f.terminal(); f.wait("second"); f.db.deliver_process_waits().unwrap();
    assert_eq!(f.facts(),facts,"another wait can settle from the existing ancestor fact");
    f.cleanup();
}

#[test]
fn cancelled_run_never_resumes_from_late_process_terminal() {
    let mut f=Fixture::new(); let wait=f.wait("run-cancel");
    f.state(RunState::Cancelled,None); f.terminal();
    assert!(f.db.deliver_process_waits().unwrap().is_empty());
    assert_eq!(f.db.run(&f.run).unwrap().state,RunState::Cancelled);
    assert_eq!(f.db.operation(wait.id.strip_prefix("process-wait:").unwrap()).unwrap().outcome,Some(Outcome::Cancelled));
    assert_eq!(f.db.operation("process").unwrap().outcome,Some(Outcome::Succeeded));
    assert!(f.facts().is_empty()); f.cleanup();
}

#[test]
fn process_terminal_fact_preserves_the_guardians_string_signal() {
    let mut f=Fixture::new(); f.wait("signal");
    f.db.record_external_receipt_with_stop("process",ExternalReceipt{executor:"process_spawn".into(),identity:"process".into(),
        epoch:"process-epoch".into(),outcome:Outcome::Failed,effect:Effect::Confirmed,
        result:json!({"processId":"process","kernelEpoch":"process-epoch","treeConfirmed":true,"exitCode":null,"signal":"Killed"})},true).unwrap();
    f.db.deliver_process_waits().unwrap();
    let facts=f.facts(); assert_eq!(facts.len(),1);
    let text=facts[0]["content"]["text"].as_str().unwrap();
    let fact:Value=serde_json::from_str(text.lines().last().unwrap()).unwrap();
    assert_eq!(fact["signal"],"Killed"); assert_eq!(fact["outcome"],"failed");
    assert!(fact["exitCode"].is_null()); f.cleanup();
}
