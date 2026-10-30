#[path = "fixtures/child_dispatch.rs"]
mod child_dispatch;
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::{json, Value};
use varin_runtime::catalog::{launches, threads};
use varin_runtime::*;
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("varin-attention-{}", id())))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn submit(db: &mut Catalog, thread: &str, branch: &str) -> Receipt {
    db.create_thread(thread, branch).unwrap();
    // Directory titles are deliberately public metadata; keep the confidential body separate.
    db.update_thread(&threads::ThreadUpdate {
        key: format!("title:{thread}"),
        thread_id: thread.into(),
        expected_revision: 1,
        title: Some(format!("Task {thread}")),
        pinned: None,
        archived: None,
    })
    .unwrap();
    db.submit(&SubmitInput {
        key: format!("input:{thread}"),
        thread_id: thread.into(),
        branch_id: branch.into(),
        expected_head: None,
        input: json!({"text":"private body must not escape"}),
        configuration: json!({}),
    })
    .unwrap()
}
#[test]
fn attention_is_one_snapshot_and_owner_replacement_is_not_empty_success() {
    let root = Fixture::new();
    let mut db = Catalog::open(&root.0).unwrap();
    let first = submit(&mut db, "first", "first-branch");
    for bot in ["original-bot", "concurrent-bot"] {
        db.publish_bot_gate(varin_runtime::catalog::bot::BotGate {
            bot_id: bot.into(),
            profile_revision: 1,
            activity_operation_id: None,
            permitted: true,
        })
        .unwrap();
    }
    db.create_bot_thread("bot-thread", "bot-branch", "original-bot")
        .unwrap();
    db.fork_branch("bot-branch", "bot-fork", None).unwrap();
    let read = db.capture_attention_read();
    let before = db.event_cursor().unwrap();
    let calls = std::cell::Cell::new(0);
    let writer = std::cell::RefCell::new(&mut db);
    let snapshot = read
        .load(&|| {
            let n = calls.get();
            calls.set(n + 1);
            if n == 1 {
                writer
                    .borrow_mut()
                    .create_bot_thread("concurrent", "concurrent-branch", "concurrent-bot")
                    .unwrap();
                writer
                    .borrow_mut()
                    .publish_bot_gate(varin_runtime::catalog::bot::BotGate {
                        bot_id: "original-bot".into(),
                        profile_revision: 2,
                        activity_operation_id: None,
                        permitted: true,
                    })
                    .unwrap();
            }
            false
        })
        .unwrap();
    assert_eq!(snapshot.event_cursor, before);
    assert_eq!(snapshot.bot_gates.len(), 1);
    assert_eq!(snapshot.bot_gates[0].profile_revision, 1);
    assert_eq!(snapshot.bot_gates[0].kernel_epoch, snapshot.epoch);
    assert_eq!(snapshot.branches.len(), 3);
    assert_eq!(snapshot.counts.action_required, 0);
    let direct = snapshot
        .branches
        .iter()
        .find(|b| b.thread_id == "first")
        .unwrap();
    assert_eq!(direct.bot_id, None);
    assert_eq!(direct.current_run.as_ref().unwrap().id, first.run_id);
    for branch in snapshot
        .branches
        .iter()
        .filter(|b| b.thread_id == "bot-thread")
    {
        assert_eq!(branch.bot_id.as_deref(), Some("original-bot"));
        assert_eq!(branch.parent_thread_id, None);
    }
    let wire = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(
        wire["branches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["threadId"] == "first")
            .unwrap()
            .get("botId"),
        Some(&Value::Null)
    );
    assert!(!wire.to_string().contains("private body"));
    drop(writer);
    let next = db.capture_attention_read().load(&|| false).unwrap();
    assert_eq!(next.branches.len(), 4);
    assert!(next.event_cursor > before);
    assert_eq!(
        next.bot_gates
            .iter()
            .find(|gate| gate.bot_id == "original-bot")
            .unwrap()
            .profile_revision,
        2
    );
    assert_eq!(
        next.branches
            .iter()
            .find(|b| b.thread_id == "concurrent")
            .unwrap()
            .bot_id
            .as_deref(),
        Some("concurrent-bot")
    );
    let old = db.capture_attention_read();
    drop(db);
    let _next = Catalog::open(&root.0).unwrap();
    assert!(matches!(
        old.load(&|| false),
        Err(RuntimeError::Conflict(_))
    ));
}
#[test]
fn attention_is_compact_at_concurrency_and_cancellation_is_not_zero() {
    let root = Fixture::new();
    let mut db = Catalog::open(&root.0).unwrap();
    for n in 0..64 {
        submit(&mut db, &format!("thread-{n}"), &format!("branch-{n}"));
    }
    // Representative retained tool history alongside live branches, not only empty threads.
    let first_run = db.inspect_thread("thread-0").unwrap()["branches"][0]["active_run_id"]
        .as_str()
        .unwrap()
        .to_owned();
    for n in 0..256 {
        let op = format!("historical-{n}");
        let epoch = db.epoch();
        db.admit_operation(&op, &first_run, epoch, Lifetime::Run, Value::Null)
            .unwrap();
        db.dispatch_operation(&op, epoch, "fixture", false).unwrap();
        db.settle_operation(&op, epoch, Outcome::Succeeded, Effect::None, Value::Null)
            .unwrap();
    }
    let sql = rusqlite::Connection::open(root.0.join("conversation.sqlite")).unwrap();
    let mut plan=sql.prepare("EXPLAIN QUERY PLAN SELECT o.id FROM operations o JOIN runs r ON r.id=o.run_id WHERE json_extract(o.body,'$.phase')!='terminal' OR json_extract(o.body,'$.effect')='unknown'").unwrap();
    let plan = plan
        .query_map([], |r| r.get::<_, String>(3))
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap();
    eprintln!("attention retained-history query plan: {plan:?}");
    let start = std::time::Instant::now();
    let snapshot = db.capture_attention_read().load(&|| false).unwrap();
    assert_eq!(snapshot.branches.len(), 64);
    assert_eq!(snapshot.counts.action_required, 0);
    let encoded = serde_json::to_string(&snapshot).unwrap();
    assert!(!encoded.contains("private body"));
    assert!(encoded.len() < 100_000);
    eprintln!(
        "attention 64 concurrent branches + 256 terminal operations: {} bytes, {:?}",
        encoded.len(),
        start.elapsed()
    );
    assert!(matches!(
        db.capture_attention_read().load(&|| true),
        Err(RuntimeError::DispatchCancelled)
    ));
    let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    assert!(matches!(
        db.capture_attention_read().load_cancellable(cancelled),
        Err(RuntimeError::DispatchCancelled)
    ));
}
#[test]
fn attention_keeps_hidden_unsettled_work_but_not_hidden_idle_history() {
    let root = Fixture::new();
    let mut db = Catalog::open(&root.0).unwrap();
    submit(&mut db, "busy", "busy-branch");
    db.create_thread("idle", "idle-branch").unwrap();
    for thread in ["busy", "idle"] {
        db.update_thread(&threads::ThreadUpdate {
            key: format!("archive:{thread}"),
            thread_id: thread.into(),
            expected_revision: db.inspect_thread(thread).unwrap()["revision"]
                .as_u64()
                .unwrap(),
            title: None,
            pinned: None,
            archived: Some(true),
        })
        .unwrap();
    }
    let snapshot = db.capture_attention_read().load(&|| false).unwrap();
    assert_eq!(snapshot.branches.len(), 1);
    assert_eq!(snapshot.branches[0].thread_id, "busy");
    assert!(snapshot.branches[0].archived);
}
#[test]
fn attention_retains_unknown_effect_from_terminal_prior_owner_without_hydrating_result() {
    let root = Fixture::new();
    let mut db = Catalog::open(&root.0).unwrap();
    let r = submit(&mut db, "thread", "branch");
    let epoch = db.epoch();
    db.admit_operation(
        "effect",
        &r.run_id,
        epoch,
        Lifetime::Thread,
        json!({"secret":"not presentation"}),
    )
    .unwrap();
    db.dispatch_operation("effect", epoch, "original-executor", true)
        .unwrap();
    db.request_cancel_operation("effect").unwrap();
    drop(db);
    let db = Catalog::open(&root.0).unwrap();
    let op = db.operation("effect").unwrap();
    assert_eq!(op.effect, Effect::Unknown);
    let snapshot = db.capture_attention_read().load(&|| false).unwrap();
    assert_eq!(snapshot.counts.action_required, 0);
    assert_eq!(snapshot.counts.unknown_effects, 1);
    let effect = snapshot
        .items
        .iter()
        .find(|i| i.kind == "effect_unknown")
        .unwrap();
    assert_eq!(effect.run_id, r.run_id);
    assert_eq!(effect.operation_id.as_deref(), Some("effect"));
    let encoded = serde_json::to_string(&snapshot).unwrap();
    assert!(!encoded.contains("not presentation"));
}
#[test]
fn attention_preparation_failure_is_waiting_and_multiple_branches_keep_identity() {
    let root = Fixture::new();
    let mut db = Catalog::open(&root.0).unwrap();
    let r = submit(&mut db, "thread", "branch");
    let launch:launches::LaunchSelection=serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"fixture","provider_family":"fixture","model":"fixture","configuration_generation":1,"tool_schema_generation":1,"tools":[],"policy":{"name":"agent","version":"1"},"source":null})).unwrap();
    db.select_launch(&r.run_id, launch).unwrap();
    db.fail_launch_metadata(&r.run_id, "preparation_failed", Some("private diagnostic"))
        .unwrap();
    db.fork_branch("branch", "fork", None).unwrap();
    let snapshot = db.capture_attention_read().load(&|| false).unwrap();
    assert_eq!(snapshot.branches.len(), 2);
    let entry = snapshot
        .items
        .iter()
        .find(|i| i.kind == "preparation_failed")
        .unwrap();
    assert_eq!(entry.branch_id, "branch");
    assert_eq!(entry.run_id, r.run_id);
    assert!(!entry.actionable);
    assert!(!snapshot.items.iter().any(|i| i.kind == "run_failed"));
    assert_eq!(
        snapshot
            .branches
            .iter()
            .find(|b| b.branch_id == "branch")
            .unwrap()
            .current_run
            .as_ref()
            .unwrap()
            .state,
        RunState::Waiting
    );
    assert!(!serde_json::to_string(&snapshot)
        .unwrap()
        .contains("private diagnostic"));
}

#[test]
fn attention_uses_original_bot_ancestry_without_rewriting_child_identity() {
    let mut f = child_dispatch::Fixture::new_in_bot("owning-bot");
    let child = f.accept();
    let snapshot = f.db.capture_attention_read().load(&|| false).unwrap();
    let branch = snapshot
        .branches
        .iter()
        .find(|b| b.thread_id == child.child_thread_id)
        .unwrap();
    assert_eq!(branch.bot_id.as_deref(), Some("owning-bot"));
    assert_eq!(branch.branch_id, child.child_branch_id);
    assert_eq!(branch.parent_thread_id.as_deref(), Some("thread:parent"));
    let relation = &snapshot.delegations[0];
    assert_eq!(relation.operation_id, child.operation_id);
    assert_eq!(relation.child_branch_id, child.child_branch_id);
    assert_eq!(relation.parent_branch_id, child.parent_branch_id);
    assert_eq!(relation.accepted_cursor, Some(child.cursor));
    f.settle_exchange();
    f.db.cancel_child(&child.operation_id).unwrap();
    let after = f.db.capture_attention_read().load(&|| false).unwrap();
    assert_eq!(after.delegations[0].accepted_cursor, Some(child.cursor));
    assert_eq!(after.delegations[0].parent_run_id, child.parent_run_id);
    let wire = serde_json::to_string(&snapshot).unwrap();
    assert!(!wire.contains("credential-ref"));
}

fn request_snapshot(receipt: &Receipt) -> varin_runtime::execution::RequestSnapshot {
    use varin_runtime::execution::*;
    RequestSnapshot {
        view: RequestView {
            request_id: "model-1".into(),
            run_id: receipt.run_id.clone(),
            origin: RequestOrigin::Conversation {
                compaction: None, step: 1,
                history_range: HistoryRange {
                    branch_id: receipt.branch_id.clone(),
                    ancestor_id: None,
                    leaf_id: Some(receipt.input_id.clone()),
                },
            },
            binding: RequestBinding { mcp_tools: Vec::new(), execution_environment: None, direct_tools: None,
                provider_id: None,
                tokenizer: None,
                request_context: None,
                child_dispatch: None,
                goal: None,
                resource_activations: Vec::new(),
                resource_checkpoint_id: None,
                connection_identity: "fixture-connection".into(),
                provider_family: "test".into(),
                model: "mock".into(),
                credential_ref: None,
                configuration_generation: 1,
                tool_schema_generation: 1,
                tools: vec![],
                instruction_sources: vec![],
                memory_checkpoint: None,
                attachment_refs: vec![],
                environment_cursor: 0,
                history_range: HistoryRange {
                    branch_id: receipt.branch_id.clone(),
                    ancestor_id: None,
                    leaf_id: Some(receipt.input_id.clone()),
                },
            },
            history: vec![],
        },
        serialized: json!({"model":"mock"}).into(),
    }
}

#[test]
fn provider_phase_and_retry_are_exact_current_owner_observations() {
    use varin_runtime::execution::*;
    use std::sync::Mutex;
    let root = Fixture::new(); let mut catalog = Catalog::open(&root.0).unwrap();
    let receipt = submit(&mut catalog, "phase-thread", "phase-branch"); let epoch = catalog.epoch();
    let snapshot = request_snapshot(&receipt);
    catalog.commit_execution(&receipt.run_id, epoch, &ExecutionRecord::RequestPrepared { snapshot: snapshot.into() }).unwrap();
    catalog.commit_execution(&receipt.run_id, epoch, &ExecutionRecord::StateChanged { state: RunState::Runnable, waiting_on: None }).unwrap();
    catalog.commit_execution(&receipt.run_id, epoch, &ExecutionRecord::StateChanged { state: RunState::Generating, waiting_on: None }).unwrap();
    catalog.commit_execution(&receipt.run_id, epoch, &ExecutionRecord::ModelDispatched { request_id: "model-1".into() }).unwrap();
    let owner = Mutex::new(catalog);
    let current = || { let read = owner.lock().unwrap().capture_attention_read(); serde_json::to_value(read.load(&|| false).unwrap()).unwrap()["branches"][0]["currentRun"].clone() };
    owner.observe_generation(&receipt.run_id, epoch, "model-1", Some(GenerationPhase::Reasoning));
    let first = current()["generation"].clone(); assert_eq!(first["phase"], "reasoning");
    owner.observe_generation(&receipt.run_id, epoch, "model-1", Some(GenerationPhase::Reasoning)); assert_eq!(current()["generation"], first);
    owner.observe_generation(&receipt.run_id, epoch + 1, "model-1", Some(GenerationPhase::Output)); assert_eq!(current()["generation"], first);
    owner.observe_generation(&receipt.run_id, epoch, "old-request", Some(GenerationPhase::Output)); assert_eq!(current()["generation"], first);
    owner.observe_generation(&receipt.run_id, epoch, "model-1", None); assert!(current()["generation"].is_null());
    owner.observe_generation(&receipt.run_id, epoch, "model-1", Some(GenerationPhase::Output));
    owner.lock().unwrap().commit_execution(&receipt.run_id, epoch, &ExecutionRecord::StateChanged { state: RunState::Executing, waiting_on: None }).unwrap();
    assert!(current()["generation"].is_null());
    owner.lock().unwrap().commit_execution(&receipt.run_id, epoch, &ExecutionRecord::StateChanged { state: RunState::Runnable, waiting_on: None }).unwrap();
    owner.lock().unwrap().commit_execution(&receipt.run_id, epoch, &ExecutionRecord::StateChanged { state: RunState::Generating, waiting_on: None }).unwrap();
    assert!(current()["generation"].is_null());
    owner.lock().unwrap().commit_execution(&receipt.run_id, epoch, &ExecutionRecord::ModelFinished { request_id: "model-1".into(), outcome: ModelOutcome::Failed, finish_reason: None,
        items: vec![], interrupted_deltas: vec![], usage: UsageReceipt::default(), failure: Some(ModelFailure { code: "transport_error".into(), message: "private diagnostic".into(), tool_name: None, retry_after_ms: None, provider_request_id: None }) }).unwrap();
    owner.observe_retry(&receipt.run_id, epoch, "model-1", Some((1,0)));
    let retry = current()["retry"].clone(); assert_eq!(retry["attempt"], 1); assert_eq!(retry["scheduledAtMs"], retry["retryAtMs"]);
    assert!(!current()["retry"].is_null()); // Expired clock is not resumed execution.
    owner.observe_retry(&receipt.run_id, epoch+1, "model-1", None); assert_eq!(current()["retry"],retry);
    owner.observe_retry(&receipt.run_id, epoch, "model-1", None); assert!(current()["retry"].is_null());
    owner.observe_retry(&receipt.run_id, epoch, "model-1", Some((2,100)));
    let mut next = request_snapshot(&receipt); next.view.request_id = "model-2".into();
    owner.lock().unwrap().commit_execution(&receipt.run_id,epoch,&ExecutionRecord::RequestPrepared { snapshot: next.into() }).unwrap();
    assert!(current()["retry"].is_null()); owner.observe_retry(&receipt.run_id,epoch,"model-1",Some((3,100))); assert!(current()["retry"].is_null());
    owner.lock().unwrap().commit_execution(&receipt.run_id,epoch,&ExecutionRecord::ModelDispatched { request_id:"model-2".into() }).unwrap();
    owner.observe_generation(&receipt.run_id,epoch,"model-2",Some(GenerationPhase::Reasoning));
    owner.lock().unwrap().request_cancel_run(&receipt.run_id).unwrap(); assert!(current()["generation"].is_null());
    assert!(!current().to_string().contains("private diagnostic"));
    drop(owner); let reopened=Catalog::open(&root.0).unwrap();
    let snapshot=serde_json::to_value(reopened.capture_attention_read().load(&||false).unwrap()).unwrap();
    assert!(snapshot["branches"][0]["currentRun"]["generation"].is_null());
}

#[test]
fn newest_executor_stop_keeps_original_old_run_and_never_counts_cancel_as_stop() {
    let root=Fixture::new();let mut db=Catalog::open(&root.0).unwrap();let receipt=submit(&mut db,"stop-thread","stop-branch");let epoch=db.epoch();
    for key in ["first-stop","old-live"] { db.admit_operation(key,&receipt.run_id,epoch,Lifetime::Thread,json!({"command":"private"})).unwrap();db.dispatch_operation(key,epoch,"process-executor",true).unwrap();db.handoff_operation(key,epoch).unwrap(); }
    let stopped=|key:&str| ExternalReceipt { executor:"process-executor".into(),identity:key.into(),epoch:"external-epoch".into(),outcome:Outcome::Cancelled,effect:Effect::Partial,result:json!({"private":"result"}).into() };
    db.request_cancel_operation("first-stop").unwrap();db.record_external_receipt_with_stop("first-stop",stopped("first-stop"),false).unwrap();
    assert!(db.capture_attention_read().load(&||false).unwrap().stopped_executors.is_empty());
    db.record_external_receipt_with_stop("first-stop",stopped("first-stop"),true).unwrap();
    assert_eq!(db.capture_attention_read().load(&||false).unwrap().stopped_executors.len(),1);
    let rev=db.run(&receipt.run_id).unwrap().revision;db.transition_run(&receipt.run_id,epoch,rev,RunState::Cancelled).unwrap();
    let head=db.history("stop-branch").unwrap().last().map(|h|h.id.clone());
    let newer=db.submit(&SubmitInput{key:"new-run".into(),thread_id:"stop-thread".into(),branch_id:"stop-branch".into(),expected_head:head,input:json!({"text":"next"}),configuration:json!({})}).unwrap();
    assert_ne!(newer.run_id,receipt.run_id);
    db.record_external_receipt_with_stop("old-live",stopped("old-live"),true).unwrap();
    let latest=db.capture_attention_read().load(&||false).unwrap();assert_eq!(latest.stopped_executors.len(),1);
    assert_eq!(latest.stopped_executors[0].operation_id,"old-live");assert_eq!(latest.stopped_executors[0].run_id,receipt.run_id);
    assert!(latest.branches[0].has_unsettled_work);assert!(!serde_json::to_string(&latest.stopped_executors).unwrap().contains("private"));
}

#[test]
fn unknown_kernel_invocation_is_not_physical_stop_without_original_worker_evidence() {
    use varin_runtime::execution::*;
    let root=Fixture::new();let mut db=Catalog::open(&root.0).unwrap();let receipt=submit(&mut db,"kernel-thread","kernel-branch");let epoch=db.epoch();
    let mut snapshot=request_snapshot(&receipt);snapshot.view.binding.tools=vec![ToolSchema{requirements:None,name:"read".into(),version:"1".into(),description:String::new(),schema:json!({"type":"object"}),output_schema:None,metadata:None}];
    db.commit_execution(&receipt.run_id,epoch,&ExecutionRecord::RequestPrepared{snapshot:snapshot.into()}).unwrap();
    db.commit_execution(&receipt.run_id,epoch,&ExecutionRecord::ModelDispatched{request_id:"model-1".into()}).unwrap();
    let call=ToolCall{call_id:"read".into(),name:"read".into(),schema_version:"1".into(),arguments:json!({})};
    db.commit_execution(&receipt.run_id,epoch,&ExecutionRecord::ModelFinished{request_id:"model-1".into(),outcome:ModelOutcome::Completed,finish_reason:Some(FinishReason::ToolCalls),items:vec![ProviderItem{id:"call".into(),content:Content::ToolCall{call:call.clone()},opaque:None}],interrupted_deltas:vec![],usage:UsageReceipt::default(),failure:None}).unwrap();
    let context=ToolExecutionContext{run_id:receipt.run_id.clone(),operation_id:"model-1:tool:read".into(),origin:ToolOrigin::ModelStep{request_id:"model-1".into()}};
    db.commit_execution(&receipt.run_id,epoch,&ExecutionRecord::ToolAdmitted{context:context.clone(),tool:AdmittedTool{call,contract:ToolContract{name:"read".into(),schema_version:"1".into(),read_only:false,completion:CompletionKind::Result,lifetime:Lifetime::Run,resources:vec![]}}}).unwrap();
    db.commit_execution(&receipt.run_id,epoch,&ExecutionRecord::ToolDispatched{context:context.clone(),executor_owner:ExecutorOwner::Kernel}).unwrap();
    db.commit_execution(&receipt.run_id,epoch,&ExecutionRecord::ToolSettled{context:context.clone(),completion:ToolCompletion::Result{outcome:Outcome::Indeterminate,effect:Effect::Unknown,content:json!({"error":"effect unknown"}).into()},executor_stopped:true}).unwrap();
    assert!(db.events_after(0,1000).unwrap().iter().any(|e|e.kind=="operation.invocation_executor_stopped"));
    assert!(db.capture_attention_read().load(&||false).unwrap().stopped_executors.is_empty());
}

#[test]
fn real_provider_callbacks_clear_phase_on_success_failure_abort_and_panic() {
    use varin_runtime::execution::*;
    use std::sync::{Arc,Mutex};
    struct NoTools;
    impl ToolExecutor for NoTools {
        fn plan(&self,_:&ToolCall,_:&FrozenToolContext,_:&CancellationToken)->Result<ToolPreparation,ExecutionError>{unreachable!()}
        fn prepare(&self,_:&ToolCall,_:&FrozenToolContext,_:&CancellationToken)->Result<ToolContract,ExecutionError>{unreachable!()}
        fn authorize(&self,_:&ToolExecutionContext,_:&ToolCall,_:&ToolContract,_:&CancellationToken)->Result<(),ExecutionError>{unreachable!()}
        fn execute(&self,_:&ToolExecutionContext,_:&ToolCall,_:&ToolContract,_:&CancellationToken)->ToolCompletion{unreachable!()}
    }
    struct Provider { owner:Arc<Mutex<Catalog>>, stop:CancellationToken, ending:u8, calls:std::sync::atomic::AtomicUsize }
    impl ModelProvider for Provider {
        fn retry_policy(&self)->varin_runtime::model_retry::RetryPolicy {varin_runtime::model_retry::RetryPolicy::new(Some(&json!({"enabled":self.ending==4,"maxRetries":1,"initialDelayMs":0,"maxDelayMs":0}))).unwrap()}
        fn serialize(&self,view:&RequestView,_:Option<&mut RequestCompileReuse>)->Result<RequestBody,ExecutionError>{Ok(serde_json::to_value(view).unwrap().into())}
        fn generate(&self,_:&RequestSnapshot,_:&CancellationToken,emit:&mut dyn FnMut(ProviderEvent)->Result<(),ExecutionError>)->Result<FinishReason,ModelFailure>{
            let attempt=self.calls.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
            for _ in 0..3 {emit(ProviderEvent::ReasoningDelta{item_id:"thought".into(),text:"private provider words".into()})?;}
            let read=self.owner.lock().unwrap().capture_attention_read();let wire=serde_json::to_value(read.load(&||false).unwrap()).unwrap();
            assert_eq!(wire["branches"][0]["currentRun"]["generation"]["phase"],"reasoning");assert!(!wire.to_string().contains("private provider words"));
            if self.ending==2 {self.stop.cancel();emit(ProviderEvent::TextDelta{item_id:"late".into(),text:"cancelled".into()})?;unreachable!()}
            if self.ending==3 {panic!("provider panic fixture")}
            if self.ending==1 || (self.ending==4 && attempt==0) {return Err(ModelFailure{code:"transport_error".into(),message:"fixture failure".into(),retry_after_ms:None,provider_request_id:None,tool_name:None})}
            emit(ProviderEvent::TextDelta{item_id:"answer".into(),text:"answer".into()})?;
            emit(ProviderEvent::ItemCompleted{item:ProviderItem{id:"answer".into(),content:Content::Text{text:"answer".into()},opaque:None}})?;
            Ok(FinishReason::Stop)
        }
    }
    for ending in 0..5 {
        let root=Fixture::new();let mut db=Catalog::open(&root.0).unwrap();let receipt=submit(&mut db,"real-provider","real-branch");let epoch=db.epoch();
        let snapshot=request_snapshot(&receipt);let input=ExecutionInput{run_id:receipt.run_id.clone(),owner_generation:epoch,binding:snapshot.view.binding,history:db.execution_history("real-branch").unwrap(),policy_state:Value::Null,completed_model_steps:0};
        let owner=Arc::new(Mutex::new(db));let stop=CancellationToken::default();
        let engine=ExecutionEngine{persistence:owner.clone(),context_preparation:Arc::new(NoopContextPreparation),provider:Arc::new(Provider{owner:owner.clone(),stop:stop.clone(),ending,calls:std::sync::atomic::AtomicUsize::new(0)}),tools:Arc::new(NoTools),policy:Arc::new(DefaultAgentPolicy),progress:ProgressSink::default()};
        let _=engine.run(input,stop);
        let db=owner.lock().unwrap();let phases:Vec<_>=db.events_after(0,1000).unwrap().into_iter().filter(|e|e.kind=="generation.phase_changed").collect();
        assert!(!phases.is_empty());assert_eq!(phases.first().unwrap().data["phase"],"reasoning");assert!(phases.last().unwrap().data["phase"].is_null());
        assert_eq!(phases.iter().filter(|e|e.data["phase"]=="reasoning").count(),if ending==4 {2} else {1});
        if ending==4 {
            let retries:Vec<_>=db.events_after(0,1000).unwrap().into_iter().filter(|e|e.kind=="generation.retry_changed").collect();
            assert_eq!(retries.len(),2);assert!(retries[0].data["scheduled"].is_object());assert!(retries[1].data["scheduled"].is_null());
            assert_eq!(retries[0].data["requestId"],retries[1].data["requestId"]);
        }
        assert!(!serde_json::to_string(&phases).unwrap().contains("private provider words"));
        let read=db.capture_attention_read();drop(db);let wire=serde_json::to_value(read.load(&||false).unwrap()).unwrap();assert!(wire["branches"][0]["currentRun"]["generation"].is_null());
    }
}

#[test]
fn natural_next_run_queue_counts_successors_not_active_or_cancelled_runs() {
    use varin_runtime::catalog::inputs::EnqueueInput;
    let root=Fixture::new(); let mut db=Catalog::open(&root.0).unwrap();
    let active=submit(&mut db,"queue-thread","queue-branch");
    assert_eq!(db.capture_attention_read().load(&||false).unwrap().branches[0].queued_run_count,0);
    let queued=db.enqueue_input(&EnqueueInput{key:"next".into(),thread_id:"queue-thread".into(),branch_id:"queue-branch".into(),mode:InputMode::NextRun,input:json!({"text":"private next input"}),configuration:None}).unwrap();
    assert_ne!(queued.run_id,active.run_id);
    let snapshot=db.capture_attention_read().load(&||false).unwrap();
    assert_eq!(snapshot.branches[0].queued_run_count,1);
    assert_eq!(snapshot.branches[0].active_run_id.as_deref(),Some(active.run_id.as_str()));
    assert!(snapshot.branches[0].has_unsettled_work);
    let input=db.queued_input(&queued.input_id).unwrap();db.cancel_queued_input(&input.id,input.revision).unwrap();
    assert_eq!(db.capture_attention_read().load(&||false).unwrap().branches[0].queued_run_count,0);
    let next=db.enqueue_input(&EnqueueInput{key:"next-promote".into(),thread_id:"queue-thread".into(),branch_id:"queue-branch".into(),mode:InputMode::NextRun,input:json!({"text":"next"}),configuration:None}).unwrap();
    let epoch=db.epoch();let revision=db.run(&active.run_id).unwrap().revision;
    db.transition_run(&active.run_id,epoch,revision,RunState::Cancelled).unwrap();
    // The original transition promotes its successor; queue metadata must clear.
    let promoted=db.capture_attention_read().load(&||false).unwrap();
    assert_eq!(promoted.branches[0].queued_run_count,0);
    assert_eq!(promoted.branches[0].active_run_id.as_deref(),Some(next.run_id.as_str()));
}
