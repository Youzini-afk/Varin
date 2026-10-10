//! Real Catalog and ContentStore boundaries for delegated Host capabilities. Host transports
//! and permission decisions remain the original owners; these tests do not emulate their success.
#[path = "fixtures/content_collection.rs"]
mod content_collection;
#[path = "fixtures/child_dispatch.rs"]
mod fixture;
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use fixture::Fixture;
use input_admission::InputAdmission;
use serde_json::json;
use varin_runtime::catalog::{collaboration::ChildTask, dispatch::ChildModelBinding, launches::*};
use varin_runtime::execution::*;
use varin_runtime::*;

fn mcp() -> HostToolBinding {
    let tool = |name: &str| ToolSchema {
        name: name.into(),
        version: "declaration-1".into(),
        description: format!("Original {name}"),
        schema: json!({"type":"object"}),
        output_schema: None,
        metadata: None,
    };
    HostToolBinding {
        reference: "parent-mcp-owner".into(),
        generation: 3,
        tools: ["first", "second", "mcp_call", "mcp_discover"]
            .into_iter()
            .map(tool)
            .collect(),
        resources: [
            ("first".into(), "parent-server-A".into()),
            ("second".into(), "parent-server-B".into()),
            ("server:A".into(), "parent-server-A".into()),
            ("server:B".into(), "parent-server-B".into()),
        ]
        .into(),
        provenance: McpProvenance {
            execution_scope: McpExecutionScope::Workspace,
            configuration: McpConfiguration {
                agent_dir: "/fixture/agent".into(),
                config_cwd: "/fixture/source".into(),
                project_trusted: true,
            },
            servers: [
                (
                    "A".into(),
                    McpServerSelection {
                        definition_version: "definition-A".into(),
                        resource_key: "parent-server-A".into(),
                    },
                ),
                (
                    "B".into(),
                    McpServerSelection {
                        definition_version: "definition-B".into(),
                        resource_key: "parent-server-B".into(),
                    },
                ),
            ]
            .into(),
        },
    }
}
fn prepare(f: &mut Fixture, child: &ChildTask) -> ChildTask {
    let mut source = child.source.pin().unwrap().source.clone();
    source.branch_id = Some(format!("child-source:{}", child.operation_id));
    source.revision = Some(0);
    if matches!(
        child.code_result,
        varin_runtime::catalog::collaboration::ChildCodeResult::Pending
    ) {
        source.mode = SourceMode::Materialized;
    }
    let proposal = varin_runtime::catalog::context::ContextProposal {
        key: format!("context:{}", child.operation_id),
        branch_id: child.child_branch_id.clone(),
        through_id: None,
        expected_revision: 0,
        summary: String::new(),
        effective_system_prompt: "Selected child".into(),
        instruction_sources: vec!["fixture:child".into()],
        memory_checkpoint: None,
    };
    let basis = serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,
        "configurationDigest":"fixture:child","memorySnapshot":{"revision":0,"memories":[]},
        "sessionId":child.child_thread_id,"projectId":child.project_id,
        "originalSections":[{"name":"preamble","content":"Selected child"}],"instructionSources":["fixture:child"]})).unwrap();
    f.db.prepare_child(&child.operation_id, source, proposal, basis)
        .unwrap()
}
fn derived(original: &HostToolBinding) -> HostToolBinding {
    let mut binding = original.clone();
    binding.reference = "child-own-mcp-owner".into();
    binding.generation = 8;
    for resource in binding.resources.values_mut() {
        *resource = resource.replace("parent", "child");
    }
    for server in binding.provenance.servers.values_mut() {
        server.resource_key = server.resource_key.replace("parent", "child");
    }
    binding
}

#[test]
fn model_and_policy_dispatch_admit_exact_host_selections_before_any_child_owner_preparation() {
    for policy in [false, true] {
        let mut f =
            Fixture::new_host_child(policy, Some(mcp()), vec!["first".into(), "helper".into()]);
        let original =
            f.db.capture_child_dispatch_invocation(&f.context)
                .unwrap()
                .load()
                .unwrap();
        let resolved = original.resolve(&f.input).unwrap();
        assert_eq!(resolved.extension_bindings, f.launch.extension_bindings);
        assert_eq!(resolved.mcp_binding, f.launch.mcp_binding);
        let selected = resolved.mcp_binding.as_ref().unwrap();
        assert_eq!(
            selected
                .provenance
                .servers
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            vec!["A"]
        );
        assert!(!selected.resources.contains_key("second"));
        assert!(!selected.resources.contains_key("server:B"));
        let gateway = mcp().delegate(&["mcp_call".into()]).unwrap();
        assert_eq!(gateway.provenance.servers.len(), 2);
        assert_eq!(gateway.tools.len(), 1);
        gateway.validate().unwrap();
        let mut wrong = f.launch.clone();
        wrong.extension_bindings[0].artifact_integrity = "latest-artifact".into();
        assert!(f
            .db
            .accept_child(&f.context, f.input.clone(), f.pin.clone(), wrong)
            .is_err());
        let child = f.accept();
        assert!(child.receipt.is_none());
        assert_eq!(child.state, "preparing");
        assert_eq!(f.accept(), child);
        assert_eq!(f.db.child_tasks().unwrap().len(), 1);
        let view = f.db.capture_child_read(child).load().unwrap();
        assert_eq!(view.launch.extension_bindings, f.launch.extension_bindings);
        assert_eq!(view.launch.mcp_binding, f.launch.mcp_binding);
        if policy {
            let sql = rusqlite::Connection::open(f.root.join("conversation.sqlite")).unwrap();
            assert_eq!(
                sql.query_row("SELECT count(*) FROM model_steps", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        let root = f.root.clone();
        drop(original);
        drop(f);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn host_tool_with_native_process_name_does_not_gain_a_native_process_source_grant() {
    let mut binding = mcp();
    binding
        .tools
        .iter_mut()
        .find(|tool| tool.name == "first")
        .unwrap()
        .name = "process_spawn".into();
    let resource = binding.resources.remove("first").unwrap();
    binding.resources.insert("process_spawn".into(), resource);
    let mut f = Fixture::new_host_child(false, Some(binding), vec!["process_spawn".into()]);
    let selected =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap();
    let resolved = selected.resolve(&f.input).unwrap();
    assert!(!resolved.source_delegation().process);
    assert_eq!(resolved.profile.tools, vec!["process_spawn"]);
    let mut normal = f.input.clone();
    normal.tools = None;
    assert!(selected
        .resolve(&normal)
        .unwrap()
        .profile
        .tools
        .contains(&"process_spawn".into()));
    f.accept();
    let root = f.root.clone();
    drop(selected);
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn child_derives_mcp_once_preserving_original_definitions_then_reopens_only_its_committed_binding()
{
    let mut f = Fixture::new_host_child(false, Some(mcp()), vec!["first".into(), "helper".into()]);
    let child = f.accept();
    let child = prepare(&mut f, &child);
    let run = child.receipt.as_ref().unwrap().run_id.clone();
    let original = f.launch.mcp_binding.clone().unwrap();
    let binding = derived(&original);
    for changed in [
        "definition",
        "configuration",
        "execution-scope",
        "schema",
        "resource",
    ] {
        let mut wrong = binding.clone();
        match changed {
            "definition" => {
                wrong
                    .provenance
                    .servers
                    .get_mut("A")
                    .unwrap()
                    .definition_version = "latest".into()
            }
            "configuration" => wrong.provenance.configuration.config_cwd = "/other/source".into(),
            "execution-scope" => wrong.provenance.execution_scope = McpExecutionScope::Global,
            "schema" => wrong.tools[0].description.push_str(" changed"),
            _ => {
                wrong.resources.insert("first".into(), "unrelated".into());
            }
        }
        assert!(
            f.db.prepare_mcp_launch(&run, wrong).is_err(),
            "{changed} must remain frozen"
        );
    }
    let committed = f.db.prepare_mcp_launch(&run, binding.clone()).unwrap();
    assert_eq!(committed.selection.mcp_binding, Some(binding.clone()));
    assert_eq!(
        f.db.child_task(&child.operation_id)
            .unwrap()
            .launch
            .mcp_binding_ref,
        child.launch.mcp_binding_ref
    );
    let mut another = binding.clone();
    another.reference = "another-child-owner".into();
    assert!(f.db.prepare_mcp_launch(&run, another).is_err());
    let mut extensions = f.launch.extension_bindings.clone();
    extensions[0].configuration_identity = Some("updated-config".into());
    assert!(f
        .db
        .prepare_extensions_change(&run, extensions)
        .unwrap()
        .load()
        .is_err());
    let root = f.root.clone();
    drop(f.db);
    f.db = Catalog::open(&root).unwrap();
    assert_eq!(
        f.db.prepare_mcp_launch(&run, binding.clone())
            .unwrap()
            .selection
            .mcp_binding,
        Some(binding.clone())
    );
    assert!(f.db.prepare_mcp_launch(&run, original).is_err());
    content_collection::collect(|| f.db.prepare_content_collection(Default::default())).unwrap();
    assert_eq!(
        f.db.launch_intent(&run)
            .unwrap()
            .unwrap()
            .selection
            .mcp_binding,
        Some(binding)
    );
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn child_without_host_selection_cannot_append_capabilities_and_cancellation_fences_derivation() {
    let mut f = Fixture::new();
    let child = f.accept();
    let child = prepare(&mut f, &child);
    let run = child.receipt.as_ref().unwrap().run_id.clone();
    assert!(f.db.prepare_mcp_launch(&run, mcp()).is_err());
    let donor = Fixture::new_parent_extension();
    let bindings = donor
        .db
        .launch_intent(&donor.context.run_id)
        .unwrap()
        .unwrap()
        .selection
        .extension_bindings;
    assert!(f
        .db
        .prepare_extensions_change(&run, bindings)
        .unwrap()
        .load()
        .is_err());
    let donor_root = donor.root.clone();
    drop(donor);
    std::fs::remove_dir_all(donor_root).unwrap();
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();

    let mut f = Fixture::new_host_child(false, Some(mcp()), vec!["first".into()]);
    let child = f.accept();
    let child = prepare(&mut f, &child);
    let run = child.receipt.as_ref().unwrap().run_id.clone();
    let candidate =
        f.db.prepare_mcp_change(&run, derived(f.launch.mcp_binding.as_ref().unwrap()))
            .unwrap()
            .load()
            .unwrap();
    f.db.cancel_child(&child.operation_id).unwrap();
    assert!(f.db.admit_launch_change(candidate).is_err());
    assert_eq!(
        f.db.launch_intent(&run)
            .unwrap()
            .unwrap()
            .selection
            .mcp_binding,
        f.launch.mcp_binding
    );
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn original_host_refs_survive_new_composition_collection_and_reopen_without_freezing_mixed_generations(
) {
    let mut f = Fixture::new_parent_extension();
    f.accept();
    f.settle_exchange();
    let run = f.context.run_id.clone();
    let launch = f.db.launch_intent(&run).unwrap().unwrap().selection;
    f.db.bind_launch(&run, launch.clone()).unwrap();
    let model = ChildModelBinding {
        configuration: serde_json::from_value(f.db.run(&run).unwrap().configuration).unwrap(),
        credential_scope: launch.credential_scope.clone(),
    };
    assert!(f
        .db
        .prepare_child_dispatch_binding(
            &run,
            model.clone(),
            launch.tool_schema_generation + 1,
            launch.tools.clone()
        )
        .is_err());
    let old =
        f.db.prepare_child_dispatch_binding(
            &run,
            model,
            launch.tool_schema_generation,
            launch.tools.clone(),
        )
        .unwrap()
        .load()
        .unwrap();
    let mut extension = launch.extension_bindings[0].clone();
    extension.artifact_integrity = "replacement-artifact".into();
    extension.declaration_hash = "replacement-declaration".into();
    extension.tool.version = extension.declaration_hash.clone();
    extension.tool.description = "Replacement declaration".into();
    let update =
        f.db.capture_tool_update(&run, f.db.epoch())
            .unwrap()
            .load_base()
            .unwrap();
    let mut tools = update.base().to_vec();
    tools.push(extension.tool.clone());
    let update = update.load(tools, None, vec![extension]).unwrap();
    f.db.activate_tool_update(&update).unwrap();
    assert!(f.db.bind_child_dispatch(&run, old).is_err());
    drop(update);
    content_collection::collect(|| f.db.prepare_content_collection(Default::default())).unwrap();
    let root = f.root.clone();
    drop(f.db);
    f.db = Catalog::open(&root).unwrap();
    let frozen =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap();
    assert_eq!(frozen.extension_bindings, launch.extension_bindings);
    assert_eq!(
        frozen.frozen.tool_schema_generation,
        launch.tool_schema_generation
    );
    assert_eq!(
        f.db.launch_intent(&run)
            .unwrap()
            .unwrap()
            .selection
            .tool_schema_generation,
        launch.tool_schema_generation + 1
    );
    drop(frozen);
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn child_result_waits_for_original_workspace_and_service_callbacks_but_not_global_mcp() {
    use varin_runtime::catalog::collaboration::{ChildCodeResult, ChildWorkingResultRef};
    for scope in [McpExecutionScope::Workspace, McpExecutionScope::Global] {
        let mut parent_mcp = mcp();
        parent_mcp.provenance.execution_scope = scope.clone();
        let selected = if scope == McpExecutionScope::Global {
            // Native-looking names do not change the actual external execution scope.
            parent_mcp.tools[0].name = "process_spawn".into();
            let resource = parent_mcp.resources.remove("first").unwrap();
            parent_mcp
                .resources
                .insert("process_spawn".into(), resource);
            parent_mcp.tools[1].name = "wait_process".into();
            let resource = parent_mcp.resources.remove("second").unwrap();
            parent_mcp.resources.insert("wait_process".into(), resource);
            "process_spawn"
        } else {
            "first"
        };
        let mut selected_tools = vec![selected.into(), "helper".into()];
        if scope == McpExecutionScope::Global {
            selected_tools.push("wait_process".into());
        }
        let mut f = Fixture::new_host_child_mode(false, true, Some(parent_mcp), selected_tools);
        let child = f.accept();
        f.settle_exchange();
        let child = prepare(&mut f, &child);
        let run = child.receipt.as_ref().unwrap().run_id.clone();
        let own_mcp = derived(f.launch.mcp_binding.as_ref().unwrap());
        f.db.prepare_mcp_launch(&run, own_mcp.clone()).unwrap();
        let launch = f.db.launch_intent(&run).unwrap().unwrap().selection;
        let extension = launch.extension_bindings[0].clone();
        let epoch = f.db.epoch();
        let binding: RequestBinding = serde_json::from_value(json!({
            "child_dispatch":null,"goal":null,"resource_activations":[],"resource_checkpoint_id":null,
            "connection_identity":launch.connection_identity,"provider_family":launch.provider_family,
            "model":launch.model,"credential_ref":null,"configuration_generation":launch.configuration_generation,
            "tool_schema_generation":launch.tool_schema_generation,"tools":launch.tools,
            "instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,
            "history_range":{"branch_id":child.child_branch_id,"ancestor_id":null,"leaf_id":f.db.head(&child.child_branch_id).unwrap()}
        })).unwrap();
        let mut calls = [own_mcp.tools[0].clone(), extension.tool.clone()]
            .map(|schema| ToolCall {
                call_id: schema.name.clone(),
                name: schema.name,
                schema_version: schema.version,
                arguments: json!({}),
            })
            .to_vec();
        if let Some(schema) = own_mcp
            .tools
            .iter()
            .find(|tool| tool.name == "wait_process")
        {
            calls.push(ToolCall {
                call_id: "host-wait-name".into(),
                name: schema.name.clone(),
                schema_version: schema.version.clone(),
                arguments: json!({}),
            });
        }
        let mut cancelled_call = calls[0].clone();
        cancelled_call.call_id = "cancelled-before-dispatch".into();
        calls.push(cancelled_call);
        f.db.commit_execution(
            &run,
            epoch,
            &ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None,
            },
        )
        .unwrap();
        f.db.commit_execution(
            &run,
            epoch,
            &ExecutionRecord::RequestPrepared {
                snapshot: RequestSnapshot {
                    view: RequestView {
                        request_id: "child-host-request".into(),
                        run_id: run.clone(),
                        origin: RequestOrigin::Conversation {
                            step: 1,
                            history_range: binding.history_range.clone(),
                        },
                        binding,
                        history: vec![],
                    },
                    serialized: json!({"fixture":"Host callbacks"}),
                },
            },
        )
        .unwrap();
        f.db.commit_execution(
            &run,
            epoch,
            &ExecutionRecord::ModelDispatched {
                request_id: "child-host-request".into(),
            },
        )
        .unwrap();
        f.db.commit_execution(
            &run,
            epoch,
            &ExecutionRecord::ModelFinished {
                request_id: "child-host-request".into(),
                outcome: ModelOutcome::Completed,
                finish_reason: Some(FinishReason::ToolCalls),
                items: calls
                    .iter()
                    .map(|call| ProviderItem {
                        id: call.call_id.clone(),
                        content: Content::ToolCall { call: call.clone() },
                        opaque: None,
                    })
                    .collect(),
                interrupted_deltas: vec![],
                usage: UsageReceipt::default(),
                failure: None,
            },
        )
        .unwrap();
        let mut contexts = Vec::new();
        let unknown = ToolCompletion::Result {
            outcome: Outcome::Indeterminate,
            effect: Effect::Unknown,
            content: json!({"observer":"returned; callback still running"}),
        };
        for call in &calls {
            let identity = if call.name == extension.tool.name {
                extension.provider_key.clone()
            } else {
                own_mcp.reference.clone()
            };
            let origin = ToolOrigin::ModelStep {
                request_id: "child-host-request".into(),
            };
            let context = ToolExecutionContext {
                run_id: run.clone(),
                operation_id: origin.operation_id(&call.call_id),
                origin,
            };
            f.db.commit_execution(
                &run,
                epoch,
                &ExecutionRecord::ToolAdmitted {
                    context: context.clone(),
                    tool: AdmittedTool {
                        call: call.clone(),
                        contract: ToolContract {
                            name: call.name.clone(),
                            schema_version: call.schema_version.clone(),
                            read_only: false,
                            completion: CompletionKind::Result,
                            lifetime: Lifetime::Run,
                            resources: vec![],
                        },
                    },
                },
            )
            .unwrap();
            if call.call_id == "cancelled-before-dispatch" {
                f.db.commit_execution(
                    &run,
                    epoch,
                    &ExecutionRecord::ToolSettled {
                        context: context.clone(),
                        completion: ToolCompletion::NotDispatched {
                            reason: "cancelled".into(),
                        },
                        executor_stopped: true,
                    },
                )
                .unwrap();
                let operation = f.db.operation(&context.operation_id).unwrap();
                assert!(operation.execution_owner.is_none() && operation.executor.is_none());
                continue;
            }
            f.db.commit_execution(
                &run,
                epoch,
                &ExecutionRecord::ToolDispatched {
                    context: context.clone(),
                    executor_owner: ExecutorOwner::External {
                        identity,
                        epoch: "original-host-callback".into(),
                    },
                },
            )
            .unwrap();
            f.db.commit_execution(
                &run,
                epoch,
                &ExecutionRecord::ToolSettled {
                    context: context.clone(),
                    completion: unknown.clone(),
                    executor_stopped: false,
                },
            )
            .unwrap();
            contexts.push(context);
        }
        f.db.commit_execution(
            &run,
            epoch,
            &ExecutionRecord::ToolBatchCommitted {
                request_id: "child-host-request".into(),
                results: calls
                    .iter()
                    .map(|call| ToolResult {
                        request_id: "child-host-request".into(),
                        call_id: call.call_id.clone(),
                        completion: if call.call_id == "cancelled-before-dispatch" {
                            ToolCompletion::NotDispatched {
                                reason: "cancelled".into(),
                            }
                        } else {
                            unknown.clone()
                        },
                    })
                    .collect(),
            },
        )
        .unwrap();
        if scope == McpExecutionScope::Global {
            let cancel =
                f.db.cancel_tree(varin_runtime::catalog::dispatch::TreeCancelTarget::Child {
                    operation_id: child.operation_id.clone(),
                })
                .unwrap();
            assert!(
                cancel.process_ids.is_empty(),
                "Host process_spawn is not a native stop target"
            );
            assert!(
                f.db.run(&run).unwrap().cancel_requested,
                "external callbacks retain normal Run cancellation"
            );
            assert!(
                f.db.pending_external_operations("process_spawn")
                    .unwrap()
                    .is_empty(),
                "native recovery cannot replay a Host callback"
            );
            assert!(f
                .db
                .require_process_observation(&run, &contexts[0].operation_id)
                .is_err());
            assert!(f.db.cancel_process_wait(&contexts[2].operation_id).is_err());
        }
        f.db.commit_execution(
            &run,
            epoch,
            &ExecutionRecord::StateChanged {
                state: if scope == McpExecutionScope::Global {
                    RunState::Cancelled
                } else {
                    RunState::Completed
                },
                waiting_on: None,
            },
        )
        .unwrap();
        if scope == McpExecutionScope::Global {
            assert_eq!(
                f.db.operation(&contexts[2].operation_id).unwrap().outcome,
                Some(Outcome::Indeterminate),
                "native wait cleanup must preserve the external callback's original receipt"
            );
        }
        let writers =
            f.db.capture_child_writer_bindings(&child.operation_id)
                .unwrap()
                .load()
                .unwrap();
        assert!(
            !f.db.child_writers_stopped(&writers).unwrap(),
            "terminal Run is not callback stop evidence"
        );
        assert!(f
            .db
            .begin_child_settlement_bound(&child.operation_id, &writers)
            .is_err());
        assert_eq!(
            f.db.child_file_effect_bound(&writers).unwrap(),
            Effect::Unknown
        );
        f.db.reconcile_child_reports().unwrap();
        let continuation = varin_runtime::catalog::delegated::ChildContinuationCommand {
            key: "explicit-after-callback".into(), child_operation_id: child.operation_id.clone(),
            previous_run_id: run.clone(), expected_head: f.db.head(&child.child_branch_id).unwrap(),
            input: json!("Continue from the exact fixed result"),
        };
        let pending=f.db.capture_child_continuation(continuation.clone()).unwrap().load().unwrap();
        assert!(f.db.accept_child_continuation(pending).is_err(), "an unstopped source callback still blocks a new source");
        let receipt = |index: usize, effect| ExternalReceipt {
            identity: contexts[index].operation_id.clone(),
            executor: calls[index].name.clone(),
            epoch: "original-host-callback".into(),
            outcome: if effect == Effect::Unknown {
                Outcome::Indeterminate
            } else {
                Outcome::Succeeded
            },
            effect,
            result: json!({"originalCallbackStopped":true}),
        };
        f.db.record_external_receipt_with_stop(
            &contexts[1].operation_id,
            receipt(1, Effect::Confirmed),
            true,
        )
        .unwrap();
        assert_eq!(
            f.db.child_writers_stopped(&writers).unwrap(),
            scope == McpExecutionScope::Global
        );
        assert_eq!(
            f.db.child_file_effect_bound(&writers).unwrap(),
            if scope == McpExecutionScope::Global {
                Effect::Partial
            } else {
                Effect::Unknown
            }
        );
        let root = f.root.clone();
        drop(writers);
        drop(f.db);
        f.db = Catalog::open(&root).unwrap();
        let writers =
            f.db.capture_child_writer_bindings(&child.operation_id)
                .unwrap()
                .load()
                .unwrap();
        assert_eq!(
            f.db.child_writers_stopped(&writers).unwrap(),
            scope == McpExecutionScope::Global,
            "reopen uses the same committed binding and receipt"
        );
        f.db.record_external_receipt_with_stop(
            &contexts[0].operation_id,
            receipt(0, Effect::Unknown),
            true,
        )
        .unwrap();
        assert!(f.db.child_writers_stopped(&writers).unwrap());
        let effect = f.db.child_file_effect_bound(&writers).unwrap();
        assert_eq!(
            effect,
            if scope == McpExecutionScope::Workspace {
                Effect::Unknown
            } else {
                Effect::Partial
            }
        );
        f.db.begin_child_settlement_bound(&child.operation_id, &writers)
            .unwrap();
        let publication_id = format!("child-result:{}", child.operation_id);
        let candidate = KernelWorkingResultCandidate {
            publication_id: publication_id.clone(),
            candidate_operation_id: format!("result-prepare:{publication_id}"),
            workspace_id: "workspace-A".into(),
            branch_id: format!("child-source:{}", child.operation_id),
            root: if scope == McpExecutionScope::Global {
                "fixed-root"
            } else {
                "host-written-root"
            }
            .into(),
            base_root: "fixed-root".into(),
            write_revision: 1,
            pin_id: "candidate-pin".into(),
            base_pin_id: "base-pin".into(),
        };
        f.db.attach_child_candidate_bound(&child.operation_id, candidate.clone(), &writers)
            .unwrap();
        let result = ChildWorkingResultRef {
            publication_id,
            workspace_id: candidate.workspace_id,
            branch_id: candidate.branch_id,
            root: candidate.root,
            base_root: candidate.base_root,
            result_revision: 1,
            record_id: "host-working-result".into(),
        };
        let published =
            f.db.attach_child_result_bound(&child.operation_id, result, effect, &writers)
                .unwrap();
        assert!(
            matches!(published.code_result, ChildCodeResult::Published { effect: actual, .. } if actual == effect)
        );
        let old_receipts=contexts.iter().map(|context|f.db.operation(&context.operation_id).unwrap()).collect::<Vec<_>>();
        let old_result=published.code_result.clone();
        let pending=f.db.capture_child_continuation(continuation).unwrap().load().unwrap();
        let next=f.db.accept_child_continuation(pending).unwrap();
        let ChildCodeResult::Published { result: fixed, .. }=&old_result else{unreachable!()};
        assert_eq!(next.source_basis.as_ref().unwrap().root(),fixed.root);
        assert_eq!(f.db.child_task(&child.operation_id).unwrap().code_result,old_result);
        for (context,old) in contexts.iter().zip(old_receipts){assert_eq!(f.db.operation(&context.operation_id).unwrap(),old);}
        drop(writers);
        drop(f);
        std::fs::remove_dir_all(root).unwrap();
    }
}
