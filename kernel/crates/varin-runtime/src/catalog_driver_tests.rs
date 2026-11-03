use super::*;
use crate::driver::DriverArtifact;
use crate::execution::*;
use crate::test_submission::InputAdmission;
use std::sync::Arc;

struct Fixture {
    root: std::path::PathBuf,
    db: Option<Catalog>,
    run: String,
    binding: RequestBinding,
}
impl Fixture {
    fn new() -> Self {
        Self::with_agent_tools(None)
    }
    fn with_agent_tools(allowed: Option<Vec<String>>) -> Self {
        let root = std::env::temp_dir().join(format!("varin-driver-catalog-{}", Uuid::new_v4()));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("thread", "main").unwrap();
        let receipt = db
            .submit(&SubmitInput {
                key: "input".into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                expected_head: None,
                input: json!({"text":"original input"}),
                configuration: json!({}),
            })
            .unwrap();
        let mut binding:RequestBinding=serde_json::from_value(json!({"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"fixture","provider_family":"fixture","model":"fixture","credential_ref":null,"configuration_generation":1,"tool_schema_generation":1,"tools":[{"name":"inspect","version":"1","description":"Read original input","schema":{"type":"object"},"output_schema":null,"metadata":null}],"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":"main","ancestor_id":null,"leaf_id":receipt.input_id}})).unwrap();
        if allowed.is_some() {
            binding.tools.extend(crate::tool_disclosure::schemas());
            for name in ["erase", "goal_report"] {
                let mut tool = binding.tools[0].clone();
                tool.name = name.into();
                binding.tools.push(tool);
            }
        }
        let mut launch =
            launches::LaunchSelection::from_binding(&binding, DefaultAgentPolicy.identity(), None);
        launch.agent = allowed.map(|tools| launches::AgentSelection {
            profile_id: Some("focused".into()),
            name: None,
            work_focus: "general".into(),
            tools: Some(tools),
        });
        db.select_launch(&receipt.run_id, launch).unwrap();
        Self {
            root,
            db: Some(db),
            run: receipt.run_id,
            binding,
        }
    }
    fn db(&mut self) -> &mut Catalog {
        self.db.as_mut().unwrap()
    }
    fn finish(
        &mut self,
        selection: &DriverSelection,
        outcome: DriverTerminalOutcome,
    ) -> DriverFinishReceipt {
        let run = self.run.clone();
        let epoch = self.db().epoch();
        let prepared = self
            .db()
            .prepare_driver_finish(outcome)
            .unwrap()
            .load()
            .unwrap();
        self.db()
            .admit_driver_finish(&run, epoch, selection, prepared)
            .unwrap()
    }
    fn select(&mut self, selection: &DriverSelection) {
        let run = self.run.clone();
        let prepared = self
            .db()
            .prepare_run_driver(&run, selection, vec![])
            .unwrap()
            .load()
            .unwrap();
        self.db().admit_run_driver(prepared).unwrap();
    }
    fn reopen(&mut self) {
        self.db.take();
        self.db = Some(Catalog::open(&self.root).unwrap());
    }
    fn call(&mut self, selection: &DriverSelection, id: &str, args: Value) -> DriverCallMetadata {
        let run = self.run.clone();
        let binding = self.binding.clone();
        let frozen = FrozenToolContext {
            tool_output_visible_bytes: None,
            execution_environment: None,
            direct_tools: None,
            child_dispatch: None,
            resource_activations: vec![],
            resource_checkpoint_id: None,
            run_id: run.clone(),
            origin: ToolOrigin::Driver {
                invocation_id: format!("driver:tool:{}:{run}:{id}", run.len()),
            },
            tools: Arc::new(binding.tools),
            tool_schema_generation: binding.tool_schema_generation,
            source: None,
        };
        let call = ToolCall {
            call_id: id.into(),
            name: "inspect".into(),
            schema_version: "1".into(),
            arguments: args,
        };
        let prepared = self
            .db()
            .prepare_driver_call(&run)
            .unwrap()
            .call(&call, &frozen, &binding.history_range, &vec![])
            .unwrap();
        let epoch = self.db().epoch();
        self.db()
            .admit_driver_call(&run, epoch, selection, prepared)
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.db.take();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn selection(version: &str) -> DriverSelection {
    use crate::catalog::service_composition::*;
    let mut node = HostCompositionNode {
        id: String::new(),
        extension_id: "fixture".into(),
        entrypoint_id: "host".into(),
        extension_version: version.into(),
        artifact_integrity: format!("artifact-{version}"),
        activation_configuration: Value::Null,
        grants: vec![],
        dependencies: vec![],
    };
    node.id = node.content_identity().unwrap();
    DriverSelection::Extension {
        artifact: DriverArtifact {
            provider_key: "fixture:host:varin.agent.driver@1".into(),
            extension_id: "fixture".into(),
            extension_version: version.into(),
            service_id: "varin.agent.driver".into(),
            service_version: 1,
            artifact_integrity: format!("artifact-{version}"),
            composition: HostServiceComposition {
                schema_version: 1,
                root: node.id.clone(),
                nodes: vec![node],
            },
            configuration_identity: "configuration".into(),
            identity: PolicyIdentity {
                name: "concurrent".into(),
                version: version.into(),
            },
            model_roles: vec![],
            recovery: DriverRecovery::Checkpoint,
            checkpoint_schema: Some("state-1".into()),
        },
    }
}

#[test]
fn first_driver_preparation_pins_one_original_implementation_and_retries_that_receipt() {
    let mut f = Fixture::new();
    let run = f.run.clone();
    let a = selection("a");
    let b = selection("b");
    assert!(
        f.db()
            .capture_launch(&run)
            .unwrap()
            .unwrap()
            .load()
            .unwrap()
            .driver_preparable
    );
    let first = f
        .db()
        .prepare_run_driver(&run, &a, vec![])
        .unwrap()
        .load()
        .unwrap();
    let competing = f
        .db()
        .prepare_run_driver(&run, &b, vec![])
        .unwrap()
        .load()
        .unwrap();
    let committed = f.db().admit_run_driver(first).unwrap().load().unwrap();
    assert_eq!(committed.selection.driver, a);
    assert!(!committed.driver_preparable);
    assert!(f.db().admit_run_driver(competing).is_err());
    let retry = f
        .db()
        .prepare_run_driver(&run, &a, vec![])
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(
        f.db()
            .admit_run_driver(retry)
            .unwrap()
            .load()
            .unwrap()
            .revision,
        committed.revision
    );
    assert!(f.db().prepare_run_driver(&run, &b, vec![]).is_err());
    f.reopen();
    let epoch = f.db().epoch();
    assert_eq!(
        f.db().bind_run_driver(&run, epoch, &a).unwrap().selection,
        a
    );
    assert!(f.db().bind_run_driver(&run, epoch, &b).is_err());
    assert_eq!(
        f.db()
            .capture_launch(&run)
            .unwrap()
            .unwrap()
            .load()
            .unwrap()
            .selection
            .driver,
        a
    );
}

#[test]
fn checkpoints_append_exact_state_refs_reject_foreign_work_and_survive_gc_and_restart() {
    let mut f = Fixture::new();
    let run = f.run.clone();
    let selected = selection("a");
    f.select(&selected);
    let epoch = f.db().epoch();
    let first = f
        .db()
        .start_driver_execution(&run, epoch, &selected)
        .unwrap();
    assert_eq!(first.metadata.started_epoch, None);
    assert!(first.load_checkpoint().unwrap().is_none());
    let call = f.call(&selected, "one", json!({"value":"original arguments"}));
    let first_state = json!({"branch":"a","private":"saved state ".repeat(10000)});
    let checkpoint = f
        .db()
        .prepare_driver_content()
        .checkpoint("state-1", &first_state, &[call.id.clone()])
        .unwrap();
    assert_eq!(
        f.db()
            .commit_driver_checkpoint(&run, epoch, &selected, 0, checkpoint)
            .unwrap()
            .revision,
        1
    );
    let second_state = json!({"branch":"b"});
    let checkpoint = f
        .db()
        .prepare_driver_content()
        .checkpoint("state-1", &second_state, &[call.id.clone()])
        .unwrap();
    f.db()
        .commit_driver_checkpoint(&run, epoch, &selected, 1, checkpoint)
        .unwrap();
    let retry = f
        .db()
        .prepare_driver_content()
        .checkpoint("state-1", &first_state, &[call.id.clone()])
        .unwrap();
    assert_eq!(
        f.db()
            .commit_driver_checkpoint(&run, epoch, &selected, 0, retry)
            .unwrap()
            .revision,
        1
    );
    let changed = f
        .db()
        .prepare_driver_content()
        .checkpoint("state-1", &json!({"changed":true}), &[])
        .unwrap();
    assert!(f
        .db()
        .commit_driver_checkpoint(&run, epoch, &selected, 0, changed)
        .is_err());
    let foreign = f
        .db()
        .prepare_driver_content()
        .checkpoint("state-1", &Value::Null, &["another-run-operation".into()])
        .unwrap();
    assert!(f
        .db()
        .commit_driver_checkpoint(&run, epoch, &selected, 2, foreign)
        .is_err());
    let wrong_schema = f
        .db()
        .prepare_driver_content()
        .checkpoint("state-2", &Value::Null, &[])
        .unwrap();
    assert!(f
        .db()
        .commit_driver_checkpoint(&run, epoch, &selected, 2, wrong_schema)
        .is_err());
    let report = f.db().prepare_content_collection(Default::default()).run();
    assert_eq!(
        report.status,
        ContentCollectionStatus::Completed,
        "{report:?}"
    );
    let previous: DriverCheckpointMetadata = serde_json::from_str(
        &f.db()
            .db
            .query_row(
                "SELECT body FROM driver_checkpoints WHERE run_id=?1 AND revision=1",
                [&run],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        f.db().content.load(&previous.state_ref).unwrap(),
        first_state
    );
    f.reopen();
    let current_epoch = f.db().epoch();
    let recovered = f
        .db()
        .start_driver_execution(&run, current_epoch, &selected)
        .unwrap();
    assert_eq!(recovered.metadata.started_epoch, Some(epoch));
    let recovered = recovered.load_checkpoint().unwrap().unwrap();
    assert_eq!(recovered.revision, 2);
    assert_eq!(recovered.state, second_state);
    assert_eq!(
        f.db()
            .capture_driver_call(&call.id)
            .unwrap()
            .load()
            .unwrap()
            .call
            .arguments,
        json!({"value":"original arguments"})
    );
    assert!(
        f.db().operation(&call.id).is_err(),
        "selection does not fabricate an executed Operation"
    );
}

#[test]
fn selected_call_and_delivery_retries_preserve_original_input_and_do_not_reappend() {
    let mut f = Fixture::new();
    let run = f.run.clone();
    let selected = selection("a");
    f.select(&selected);
    let epoch = f.db().epoch();
    let original = f.call(&selected, "one", json!({"value":1}));
    assert_eq!(f.call(&selected, "one", json!({"value":1})), original);
    let binding = f.binding.clone();
    let read = f.db().capture_driver_input(&run, epoch, binding).unwrap();
    let delivery = f
        .db()
        .prepare_driver_content()
        .delivery(&run, "answer", "answer from the driver", &selected)
        .unwrap();
    let id = f
        .db()
        .commit_driver_delivery(&run, epoch, &selected, delivery)
        .unwrap();
    let retry = f
        .db()
        .prepare_driver_content()
        .delivery(&run, "answer", "answer from the driver", &selected)
        .unwrap();
    assert_eq!(
        f.db()
            .commit_driver_delivery(&run, epoch, &selected, retry)
            .unwrap(),
        id
    );
    let changed = f
        .db()
        .prepare_driver_content()
        .delivery(&run, "answer", "different answer", &selected)
        .unwrap();
    assert!(f
        .db()
        .commit_driver_delivery(&run, epoch, &selected, changed)
        .is_err());
    assert_eq!(f.db().history("main").unwrap().len(), 2);
    assert_eq!(
        read.load().unwrap().history.len(),
        1,
        "captured input reads its original ancestry, not the newer delivery"
    );
    let checkpoint = f
        .db()
        .prepare_driver_content()
        .checkpoint("state-1", &json!({"delivered":true}), &[id.clone()])
        .unwrap();
    f.db()
        .commit_driver_checkpoint(&run, epoch, &selected, 0, checkpoint)
        .unwrap();
    let facts = f.db().driver_work_ids(&run, epoch, &selected).unwrap();
    assert_eq!(
        facts,
        vec![
            DriverWorkReference {
                kind: DriverWorkKind::Tool,
                id: original.id.clone()
            },
            DriverWorkReference {
                kind: DriverWorkKind::Delivery,
                id
            }
        ]
    );
    assert!(
        f.db().driver_tool_stopped(&original.id).unwrap(),
        "selected but never admitted work did not execute"
    );
    f.db().request_cancel_run(&run).unwrap();
    let rejected = f
        .db()
        .prepare_driver_content()
        .delivery(&run, "after-cancel", "must not append", &selected)
        .unwrap();
    assert!(f
        .db()
        .commit_driver_delivery(&run, epoch, &selected, rejected)
        .is_err());
    assert_eq!(f.db().history("main").unwrap().len(), 2);
    let binding = f.binding.clone();
    let cancelled = f
        .db()
        .capture_driver_report(&run, epoch, &selected, binding.clone())
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(cancelled.history.len(), 2);
    assert_eq!(cancelled.completed_model_steps, 0);
    let revision = f.db().run(&run).unwrap().revision;
    f.db()
        .transition_run(&run, epoch, revision, RunState::Cancelled)
        .unwrap();
    let head = f.db().head("main").unwrap();
    f.db()
        .submit(&SubmitInput {
            key: "next".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            expected_head: head,
            input: json!({"text":"a later Run"}),
            configuration: json!({}),
        })
        .unwrap();
    assert_eq!(f.db().history("main").unwrap().len(), 3);
    assert_eq!(
        f.db()
            .capture_driver_report(&run, epoch, &selected, binding)
            .unwrap()
            .load()
            .unwrap()
            .history
            .len(),
        2,
        "a final report never adopts the next Run's head"
    );
}

#[test]
fn driver_tool_stop_uses_original_executor_evidence_not_a_terminal_business_result() {
    let mut f = Fixture::new();
    let run = f.run.clone();
    let selected = selection("a");
    f.select(&selected);
    let epoch = f.db().epoch();
    f.db()
        .commit_execution(
            &run,
            epoch,
            &ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None,
            },
        )
        .unwrap();
    let call = f.call(&selected, "read", json!({}));
    let original = f
        .db()
        .capture_driver_call(&call.id)
        .unwrap()
        .load()
        .unwrap();
    let context = ToolExecutionContext {
        run_id: run.clone(),
        origin: original.frozen.origin,
        operation_id: call.id.clone(),
    };
    f.db()
        .commit_execution(
            &run,
            epoch,
            &ExecutionRecord::ToolAdmitted {
                context: context.clone(),
                tool: AdmittedTool {
                    call: original.call,
                    contract: ToolContract {
                        name: "inspect".into(),
                        schema_version: "1".into(),
                        read_only: true,
                        completion: CompletionKind::Result,
                        lifetime: Lifetime::Run,
                        resources: vec![],
                    },
                },
            },
        )
        .unwrap();
    f.db()
        .commit_execution(
            &run,
            epoch,
            &ExecutionRecord::ToolDispatched {
                context: context.clone(),
                executor_owner: ExecutorOwner::External {
                    identity: "original".into(),
                    epoch: "worker-one".into(),
                },
            },
        )
        .unwrap();
    let completion = ToolCompletion::Result {
        outcome: Outcome::Succeeded,
        effect: Effect::None,
        content: json!("read bytes").into(),
    };
    f.db()
        .commit_execution(
            &run,
            epoch,
            &ExecutionRecord::ToolSettled {
                context: context.clone(),
                completion: completion.clone(),
                executor_stopped: false,
            },
        )
        .unwrap();
    assert_eq!(
        f.db().operation(&call.id).unwrap().phase,
        OperationPhase::Terminal
    );
    assert!(!f.db().driver_tool_stopped(&call.id).unwrap());
    assert_eq!(
        f.finish(&selected, DriverTerminalOutcome::Complete),
        DriverFinishReceipt::WorkPending
    );
    assert_eq!(f.db().run(&run).unwrap().state, RunState::Runnable);
    f.db()
        .commit_execution(
            &run,
            epoch,
            &ExecutionRecord::ToolSettled {
                context: context.clone(),
                completion: completion.clone(),
                executor_stopped: true,
            },
        )
        .unwrap();
    assert!(f.db().driver_tool_stopped(&call.id).unwrap());
    assert_eq!(
        f.finish(&selected, DriverTerminalOutcome::Complete),
        DriverFinishReceipt::Committed {
            state: RunState::Completed
        }
    );
    let original_operation = f.db().operation(&call.id).unwrap();
    f.reopen();
    assert!(f.db().driver_tool_stopped(&call.id).unwrap());
    assert_eq!(f.db().operation(&call.id).unwrap(), original_operation);
    assert_eq!(
        f.db()
            .capture_call_completion(&call.id)
            .unwrap()
            .load()
            .unwrap(),
        completion
    );
}

#[test]
fn driver_call_keeps_agent_capability_cut_and_rechecks_the_original_launch() {
    let mut f = Fixture::with_agent_tools(Some(vec!["inspect".into(), "goal_report".into()]));
    let run = f.run.clone();
    let driver = selection("a");
    f.select(&driver);
    let mut frozen = FrozenToolContext {
        tool_output_visible_bytes: None,
        execution_environment: None,
        direct_tools: None,
        child_dispatch: None,
        resource_activations: vec![],
        resource_checkpoint_id: None,
        run_id: run.clone(),
        origin: ToolOrigin::Driver {
            invocation_id: format!("driver:tool:{}:{run}:inspect", run.len()),
        },
        tools: Arc::new(f.binding.tools.clone()),
        tool_schema_generation: f.binding.tool_schema_generation,
        source: None,
    };
    let call = ToolCall {
        call_id: "inspect".into(),
        name: "inspect".into(),
        schema_version: "1".into(),
        arguments: json!({}),
    };
    let history_range = f.binding.history_range.clone();
    // Even a call to an allowed name cannot retain an enlarged executable directory.
    assert!(f
        .db()
        .prepare_driver_call(&run)
        .unwrap()
        .call(&call, &frozen, &history_range, &vec![])
        .is_err());
    let allowed = vec!["inspect".to_string(), "goal_report".to_string()];
    frozen.tools = Arc::new(crate::tool_disclosure::request_tools(
        &f.binding.tools,
        false,
        Some(&allowed),
    ));
    assert!(!frozen
        .tools
        .iter()
        .any(|tool| tool.name == "erase" || tool.name == "goal_report"));
    let disallowed = ToolCall {
        name: "erase".into(),
        ..call.clone()
    };
    assert!(f
        .db()
        .prepare_driver_call(&run)
        .unwrap()
        .call(&disallowed, &frozen, &history_range, &vec![])
        .is_err());
    let staged = f
        .db()
        .prepare_driver_call(&run)
        .unwrap()
        .call(&call, &frozen, &history_range, &vec![])
        .unwrap();
    let launch = f
        .db()
        .capture_launch(&run)
        .unwrap()
        .unwrap()
        .load()
        .unwrap()
        .selection;
    f.db().bind_launch(&run, launch).unwrap();
    let epoch = f.db().epoch();
    assert!(f
        .db()
        .admit_driver_call(&run, epoch, &driver, staged)
        .is_err());
    // Preparing against the current original launch succeeds with the exact cut,
    // while its commit fence still uses the complete directory's immutable ref.
    let current = f
        .db()
        .prepare_driver_call(&run)
        .unwrap()
        .call(&call, &frozen, &history_range, &vec![])
        .unwrap();
    f.db()
        .admit_driver_call(&run, epoch, &driver, current)
        .unwrap();
}

#[test]
fn selected_only_driver_work_retires_with_its_original_thread() {
    let mut f = Fixture::new();
    let run = f.run.clone();
    let driver = selection("a");
    f.select(&driver);
    let call = f.call(&driver, "selected-only", json!({"private":"arguments"}));
    assert!(f.db().operation(&call.id).is_err());
    for state in [RunState::Runnable, RunState::Completed] {
        let current = f.db().run(&run).unwrap();
        let epoch = f.db().epoch();
        f.db()
            .transition_run(&run, epoch, current.revision, state)
            .unwrap();
    }
    let revision = f.db().inspect_thread("thread").unwrap()["revision"]
        .as_u64()
        .unwrap();
    f.db()
        .delete_thread(&threads::ThreadDelete {
            thread_id: "thread".into(),
            key: "delete".into(),
            expected_revision: revision,
        })
        .unwrap();
    let (retired, pending) = f.db().retire_deleted_threads(&[run]).unwrap();
    assert!(retired > 0);
    assert_eq!(pending, 0);
    for table in ["run_drivers", "driver_calls", "driver_checkpoints"] {
        assert_eq!(
            f.db()
                .db
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    assert_eq!(
        f.db()
            .db
            .query_row(
                "SELECT count(*) FROM events WHERE subject=?1",
                [&call.id],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    let collection = f.db().prepare_content_collection(Default::default()).run();
    assert_eq!(collection.status, crate::ContentCollectionStatus::Completed);
    assert!(collection.removed_objects > 0);
}

#[test]
fn pre_dispatch_rejection_has_its_original_receipt_without_inventing_an_operation() {
    let mut f = Fixture::new();
    let run = f.run.clone();
    let driver = selection("a");
    f.select(&driver);
    let epoch = f.db().epoch();
    let call = f.call(&driver, "declined", json!({"original":true}));
    assert!(f
        .db()
        .capture_driver_pre_dispatch_completion(&run, epoch, &driver, &call.id)
        .unwrap()
        .is_none());
    let completion = ToolCompletion::NotDispatched {
        reason: "original admission was denied".into(),
        error: Some(ExecutionError::new(
            "not_granted",
            "original admission was denied",
        )),
    };
    assert!(f
        .db()
        .prepare_driver_content()
        .pre_dispatch_completion(&call, &completion, false)
        .is_err());
    assert!(f
        .db()
        .prepare_driver_content()
        .pre_dispatch_completion(
            &call,
            &ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                effect: Effect::None,
                content: json!({}).into()
            },
            true
        )
        .is_err());
    let staged = f
        .db()
        .prepare_driver_content()
        .pre_dispatch_completion(&call, &completion, true)
        .unwrap();
    // Cancellation closes new work, not the original runner's non-dispatch receipt.
    f.db().request_cancel_run(&run).unwrap();
    let saved = f
        .db()
        .commit_driver_pre_dispatch_completion(&run, epoch, &driver, staged)
        .unwrap();
    let retry = f
        .db()
        .prepare_driver_content()
        .pre_dispatch_completion(&call, &completion, true)
        .unwrap();
    assert_eq!(
        f.db()
            .commit_driver_pre_dispatch_completion(&run, epoch, &driver, retry)
            .unwrap(),
        saved
    );
    let changed = ToolCompletion::NotDispatched {
        reason: "cancelled".into(),
        error: None,
    };
    let staged = f
        .db()
        .prepare_driver_content()
        .pre_dispatch_completion(&call, &changed, true)
        .unwrap();
    assert!(f
        .db()
        .commit_driver_pre_dispatch_completion(&run, epoch, &driver, staged)
        .is_err());
    assert!(f.db().operation(&call.id).is_err());
    assert_eq!(
        f.db()
            .prepare_content_collection(Default::default())
            .run()
            .status,
        crate::ContentCollectionStatus::Completed
    );
    f.reopen();
    let epoch = f.db().run(&run).unwrap().epoch;
    assert_eq!(
        f.db()
            .capture_driver_pre_dispatch_completion(&run, epoch, &driver, &call.id)
            .unwrap()
            .unwrap()
            .load()
            .unwrap(),
        completion
    );
    assert!(f.db().operation(&call.id).is_err());
    assert!(f.db().driver_tool_stopped(&call.id).unwrap());
}

#[test]
fn native_default_first_binding_closes_future_host_routing_without_host_preparation() {
    let mut f = Fixture::new();
    let run = f.run.clone();
    let epoch = f.db().epoch();
    let default = DriverSelection::default();
    assert!(
        f.db()
            .capture_launch(&run)
            .unwrap()
            .unwrap()
            .load()
            .unwrap()
            .driver_preparable
    );
    f.db().bind_run_driver(&run, epoch, &default).unwrap();
    assert!(
        !f.db()
            .capture_launch(&run)
            .unwrap()
            .unwrap()
            .load()
            .unwrap()
            .driver_preparable
    );
    assert!(f
        .db()
        .prepare_run_driver(&run, &selection("new-route"), vec![])
        .is_err());
    f.reopen();
    let epoch = f.db().epoch();
    assert_eq!(
        f.db()
            .bind_run_driver(&run, epoch, &default)
            .unwrap()
            .selection,
        default
    );
    assert!(f
        .db()
        .prepare_run_driver(&run, &selection("new-route"), vec![])
        .is_err());
}

#[test]
fn execution_capture_does_not_mark_dispatch_and_admission_fences_same_epoch_attempts() {
    let mut f = Fixture::new();
    let run = f.run.clone();
    let driver = selection("a");
    f.select(&driver);
    let epoch = f.db().epoch();
    let prepared = f
        .db()
        .capture_driver_execution(&run, epoch, &driver)
        .unwrap();
    assert_eq!(prepared.metadata.started_epoch, None);
    let original = prepared.metadata.clone();
    assert!(prepared.load_checkpoint().unwrap().is_none());
    assert_eq!(
        f.db()
            .capture_driver_execution(&run, epoch, &driver)
            .unwrap()
            .metadata,
        original,
        "failed preparation has not dispatched an algorithm"
    );
    f.db()
        .admit_driver_execution(&run, epoch, &driver, &original)
        .unwrap();
    assert!(f
        .db()
        .admit_driver_execution(&run, epoch, &driver, &original)
        .is_err());
    let next = f
        .db()
        .capture_driver_execution(&run, epoch, &driver)
        .unwrap()
        .metadata;
    assert_eq!(next.started_epoch, Some(epoch));
    assert_eq!(next.execution_revision, 1);
    f.db()
        .admit_driver_execution(&run, epoch, &driver, &next)
        .unwrap();
    assert!(
        f.db()
            .admit_driver_execution(&run, epoch, &driver, &next)
            .is_err(),
        "same-epoch attempts also advance a durable revision"
    );
}

#[test]
fn driver_activity_tracks_only_its_original_run_and_admitted_input_queue() {
    let mut f = Fixture::new();
    let run = f.run.clone();
    let driver = selection("a");
    f.select(&driver);
    let epoch = f.db().epoch();
    let before = f.db().driver_activity(&run, epoch, &driver).unwrap();
    assert!(!before.input_pending);
    f.db().create_thread("other", "elsewhere").unwrap();
    f.db()
        .submit(&SubmitInput {
            key: "other-input".into(),
            thread_id: "other".into(),
            branch_id: "elsewhere".into(),
            expected_head: None,
            input: json!("unrelated"),
            configuration: json!({}),
        })
        .unwrap();
    assert_eq!(
        f.db().driver_activity(&run, epoch, &driver).unwrap(),
        before
    );
    f.call(&driver, "waiting-tool", json!({}));
    let selected = f.db().driver_activity(&run, epoch, &driver).unwrap();
    assert!(selected.cursor > before.cursor);
    assert!(!selected.input_pending);
    let queued = f
        .db()
        .prepare_enqueue(inputs::EnqueueInput {
            key: "boundary-input".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            mode: InputMode::Boundary,
            input: json!("new original input"),
            configuration: None,
        })
        .unwrap()
        .load()
        .unwrap();
    f.db().admit_queued_input(queued).unwrap();
    let pending = f.db().driver_activity(&run, epoch, &driver).unwrap();
    assert!(pending.cursor > selected.cursor);
    assert!(pending.input_pending);
}

#[test]
fn driver_finish_observes_late_input_without_closing_and_commits_original_promotion() {
    let mut f = Fixture::new();
    let run = f.run.clone();
    let driver = selection("a");
    f.select(&driver);
    let epoch = f.db().epoch();
    f.db()
        .commit_execution(
            &run,
            epoch,
            &ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None,
            },
        )
        .unwrap();
    let prepared = f
        .db()
        .prepare_driver_finish(DriverTerminalOutcome::Complete)
        .unwrap()
        .load()
        .unwrap();
    let late = f
        .db()
        .enqueue_input(&inputs::EnqueueInput {
            key: "late-input".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            mode: InputMode::Boundary,
            input: json!("Arrived during finish body preparation"),
            configuration: None,
        })
        .unwrap();
    let before = f.db().run(&run).unwrap();
    assert_eq!(
        f.db()
            .admit_driver_finish(&run, epoch, &driver, prepared)
            .unwrap(),
        DriverFinishReceipt::InputPending
    );
    assert_eq!(f.db().run(&run).unwrap(), before);
    let head = f.db().head("main").unwrap();
    let delivered = f.db().consume_inputs(&run, epoch, head.as_deref()).unwrap();
    assert!(
        !delivered.is_empty(),
        "the same still-live driver can consume the original queued input"
    );
    assert_eq!(
        f.db().queued_input(&late.input_id).unwrap().state,
        InputState::Delivered
    );
    let next = f
        .db()
        .enqueue_input(&inputs::EnqueueInput {
            key: "next-run".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            mode: InputMode::NextRun,
            input: json!("Next original run"),
            configuration: None,
        })
        .unwrap();
    let next_run = f.db().queued_input(&next.input_id).unwrap().run_id;
    assert!(f.db().is_queued_run(&next_run).unwrap());
    assert_eq!(
        f.finish(&driver, DriverTerminalOutcome::Complete),
        DriverFinishReceipt::Committed {
            state: RunState::Completed
        }
    );
    assert!(!f.db().is_queued_run(&next_run).unwrap());
    let terminal = f.db().run(&run).unwrap();
    let head = f.db().head("main").unwrap();
    assert_eq!(
        f.finish(&driver, DriverTerminalOutcome::Complete),
        DriverFinishReceipt::Committed {
            state: RunState::Completed
        }
    );
    assert_eq!(f.db().run(&run).unwrap(), terminal);
    assert_eq!(
        f.db().head("main").unwrap(),
        head,
        "response loss must not promote or append twice"
    );
    f.db()
        .record_driver_callback_failure(&run, epoch, &driver, "callback_transport_closed")
        .unwrap();
    assert_eq!(f.db().run(&run).unwrap(), terminal);
    let diagnostic: String = f
        .db()
        .db
        .query_row(
            "SELECT data FROM events WHERE subject=?1 AND kind='driver.callback_failed'",
            [&run],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&diagnostic).unwrap(),
        json!({"code":"callback_transport_closed"})
    );
    assert!(
        f.db()
            .record_driver_callback_failure(&run, epoch, &selection("other"), "wrong_owner")
            .is_err()
    );
    assert!(
        f.db()
            .record_driver_callback_failure(&run, epoch + 1, &driver, "wrong_epoch")
            .is_err()
    );
}

#[test]
fn driver_finish_waits_for_real_prepared_and_dispatched_models_then_preserves_failure() {
    let mut f = Fixture::new();
    let run = f.run.clone();
    let driver = selection("a");
    f.select(&driver);
    let epoch = f.db().epoch();
    f.db()
        .commit_execution(
            &run,
            epoch,
            &ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None,
            },
        )
        .unwrap();
    assert!(
        f.db()
            .record_driver_callback_failure(&run, epoch, &driver, "premature")
            .is_err()
    );
    let request_id = format!("driver:model:{}:{run}:original", run.len());
    let snapshot = RequestSnapshot {
        view: RequestView {
            request_id: request_id.clone(),
            run_id: run.clone(),
            origin: RequestOrigin::Driver {
                driver_id: driver.owner_key(),
                operation_id: request_id.clone(),
                input_identity: "original-input".into(),
            },
            binding: f.binding.clone(),
            history: vec![],
        },
        serialized: json!({"model":"fixture"}).into(),
    };
    f.db()
        .commit_execution(
            &run,
            epoch,
            &ExecutionRecord::RequestPrepared {
                snapshot: Arc::new(snapshot),
            },
        )
        .unwrap();
    let failure = DriverTerminalOutcome::Fail {
        error: ExecutionError::new("driver_failed", "Original algorithm failed"),
    };
    assert_eq!(
        f.finish(&driver, failure.clone()),
        DriverFinishReceipt::WorkPending
    );
    f.db()
        .commit_execution(
            &run,
            epoch,
            &ExecutionRecord::ModelDispatched {
                request_id: request_id.clone(),
            },
        )
        .unwrap();
    assert_eq!(
        f.finish(&driver, failure.clone()),
        DriverFinishReceipt::WorkPending
    );
    f.db()
        .commit_execution(
            &run,
            epoch,
            &ExecutionRecord::ModelFinished {
                request_id,
                outcome: ModelOutcome::Completed,
                finish_reason: Some(FinishReason::Stop),
                items: vec![],
                interrupted_deltas: vec![],
                usage: UsageReceipt::default(),
                failure: None,
            },
        )
        .unwrap();
    assert_eq!(
        f.finish(&driver, failure),
        DriverFinishReceipt::Committed {
            state: RunState::Failed
        }
    );
    let terminal = f.db().run(&run).unwrap();
    let original_failure: String = f
        .db()
        .db
        .query_row(
            "SELECT data FROM events WHERE subject=?1 AND kind='run.failed'",
            [&run],
            |row| row.get(0),
        )
        .unwrap();
    f.db()
        .record_driver_callback_failure(&run, epoch, &driver, "callback_result_mismatch")
        .unwrap();
    assert_eq!(
        f.finish(&driver, DriverTerminalOutcome::Complete),
        DriverFinishReceipt::Committed {
            state: RunState::Failed
        }
    );
    assert_eq!(f.db().run(&run).unwrap(), terminal);
    let failures: Vec<String> = f
        .db()
        .db
        .prepare("SELECT data FROM events WHERE subject=?1 AND kind='run.failed'")
        .unwrap()
        .query_map([&run], |row| row.get(0))
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap();
    assert_eq!(failures, vec![original_failure]);
}
