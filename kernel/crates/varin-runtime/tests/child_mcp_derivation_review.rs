//! Real Catalog/ContentStore tests for the one-time, proof-bound managed child MCP transition.
//! Native Source receipt production remains the target Storage owner's responsibility.
#[path = "fixtures/child_dispatch.rs"]
mod fixture;
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use fixture::Fixture;
use input_admission::InputAdmission;
use serde_json::json;
use varin_runtime::catalog::{collaboration::*, delegated::*, launches::*};
use varin_runtime::execution::*;
use varin_runtime::*;

fn owner() -> SourceResourceOwner {
    SourceResourceOwner::ManagedHost {
        host_id: "target-host".into(),
        connection_id: "target-connection".into(),
        endpoint_identity: "target-endpoint".into(),
    }
}
fn authority(id: &str) -> McpSourceAuthority {
    McpSourceAuthority {
        coordinator_host_id: "coordinator".into(),
        authority_id: id.into(),
        resource_epoch: "target-epoch".into(),
    }
}
fn tool(name: &str) -> ToolSchema {
    ToolSchema {
        requirements: None,
        name: name.into(),
        version: "schema-1".into(),
        description: format!("Frozen {name}"),
        schema: json!({"type":"object","properties":{"server":{"type":"string"}}}),
        output_schema: None,
        metadata: None,
    }
}
fn original_binding() -> HostToolBinding {
    HostToolBinding {
        reference: "original-composition".into(),
        generation: 7,
        tools: vec![tool("first"), tool("second"), tool("mcp_call")],
        routes: [
            ("first".into(), McpRoute::Direct),
            ("second".into(), McpRoute::Direct),
            (
                "mcp_call".into(),
                McpRoute::ServerArgument {
                    argument: "server".into(),
                },
            ),
        ]
        .into(),
        resources: [
            ("first".into(), "parent-A".into()),
            ("second".into(), "parent-B".into()),
            ("server:A".into(), "parent-A".into()),
            ("server:B".into(), "parent-B".into()),
        ]
        .into(),
        provenance: McpProvenance {
            servers: ["A", "B"]
                .into_iter()
                .map(|name| {
                    (
                        name.into(),
                        McpServerSelection {
                            owner: McpServerOwner {
                                source_authority: Some(authority("parent-A")),
                                resource_owner: owner(),
                                configuration: McpConfiguration {
                                    agent_dir: "/agent".into(),
                                    config_cwd: format!("/original/{name}"),
                                    project_trusted: true,
                                },
                                execution_scope: McpExecutionScope::Workspace,
                            },
                            definition_version: format!("definition-{name}"),
                            resource_key: format!("parent-{name}"),
                        },
                    )
                })
                .collect(),
        },
    }
}
fn fixture(isolated: bool) -> Fixture {
    fixture_with_binding(isolated, original_binding())
}
fn fixture_with_binding(isolated: bool, binding: HostToolBinding) -> Fixture {
    let mut f = Fixture::new_parent_custom(
        7,
        tool("file_read"),
        tool(DISPATCH_TOOL),
        false,
        isolated,
        false,
        move |input, launch| {
            launch.source.as_mut().unwrap().resource_owner = owner();
            input.tools = Some(binding.tools.iter().map(|tool| tool.name.clone()).collect());
            launch.tools.extend(binding.tools.clone());
            launch.mcp_binding = Some(binding);
        },
    );
    let invocation =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap();
    let selected = invocation.resolve(&f.input).unwrap();
    f.launch.tools = invocation
        .frozen
        .allowed_delegation
        .iter()
        .filter(|tool| selected.profile.tools.contains(&tool.name))
        .cloned()
        .collect();
    f.launch.mcp_binding = selected.mcp_binding;
    f.pin.source = f.launch.source.clone().unwrap();
    f
}
fn admit(f: &mut Fixture) -> ChildTask {
    let selected =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap()
            .resolve(&f.input)
            .unwrap();
    let launch =
        f.db.prepare_child_launch(&f.context.run_id, f.launch.clone(), selected)
            .unwrap()
            .load()
            .unwrap();
    let mut handoff = ChildSourceHandoff::fixed(&f.context.operation_id, f.pin.clone());
    handoff.resource_authority = Some(ChildSourceAuthority {
        authority_id: "parent-A".into(),
        resource_epoch: "target-epoch".into(),
    });
    let prepared =
        f.db.prepare_child_admission(&f.context, f.input.clone(), Some(handoff), launch)
            .unwrap()
            .load()
            .unwrap();
    let child = f.db.accept_child_references(prepared).unwrap();
    let mut source = f.pin.source.clone();
    source.branch_id = Some(format!("child-source:{}", child.execution_id));
    source.revision = Some(0);
    if child.code_result == ChildCodeResult::Pending {
        source.mode = SourceMode::Materialized;
    }
    let (proposal, basis) = context(&child, "initial");
    f.db.prepare_child(&child.execution_id, source, proposal, basis)
        .unwrap()
}
fn context(
    child: &ChildTask,
    key: &str,
) -> (
    varin_runtime::catalog::context::ContextProposal,
    varin_runtime::catalog::personalization::PersonalizationBasis,
) {
    (varin_runtime::catalog::context::ContextProposal { key: key.into(), branch_id: child.child_branch_id.clone(), through_id: None,
        expected_revision: 0, summary: String::new(), effective_system_prompt: "Child".into(), instruction_sources: vec![], memory_checkpoint: None },
        serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,"configurationDigest":"child",
            "memorySnapshot":{"revision":0,"memories":[]},"threadId":child.child_thread_id,"projectId":null,
            "originalSections":[{"name":"system","content":"Child"}],"instructionSources":[]})).unwrap())
}
fn cut(original: &HostToolBinding, name: &str) -> HostToolBinding {
    let mut cut = original.clone();
    cut.provenance.servers.retain(|server, _| server == name);
    cut.resources
        .retain(|_, key| key == &original.provenance.servers[name].resource_key);
    cut.tools
        .retain(|tool| tool.name == "mcp_call" || cut.resources.contains_key(&tool.name));
    cut.routes
        .retain(|name, _| cut.tools.iter().any(|tool| &tool.name == name));
    cut
}
fn derivation(f: &Fixture, child: &ChildTask) -> (HostToolBinding, Vec<McpChildDerivationReceipt>) {
    let original =
        f.db.capture_child_read(child.clone())
            .load()
            .unwrap()
            .launch
            .mcp_binding
            .unwrap();
    let mut binding = original.clone();
    binding.reference = format!("child-owner:{}", child.execution_id);
    binding.generation += 1;
    for resource in binding.resources.values_mut() {
        *resource = resource.replace("parent", "child");
    }
    for server in binding.provenance.servers.values_mut() {
        server.resource_key = server.resource_key.replace("parent", "child");
        server.owner.source_authority = Some(authority("actual-child-source"));
    }
    let operation = f.db.operation(&child.operation_id).unwrap();
    let receipts = original
        .provenance
        .servers
        .keys()
        .filter(|name| name.as_str() == "A")
        .map(|name| McpChildDerivationReceipt {
            proof: McpChildDerivationProof {
                execution_id: child.execution_id.clone(),
                child_run_id: child.receipt.as_ref().unwrap().run_id.clone(),
                child_thread_id: child.child_thread_id.clone(),
                source_authority: authority("actual-child-source"),
                source: child.source.selection().unwrap().clone(),
                physical_root: LiveRoot {
                    host_id: "target-host".into(),
                    canonical_root: "/actual/child".into(),
                    root_id: "physical-child".into(),
                },
                pin: child.source.pin().unwrap().clone(),
                handoff: child.source.handoff().unwrap().clone(),
                materialization_operation_id: format!("materialize:{}", child.execution_id),
                materialization_receipt_hash: format!("sha256-{}", "a".repeat(64)),
                origin: McpChildDerivationOrigin::Dispatch {
                    parent_source_authority: original.provenance.servers[name]
                        .owner
                        .source_authority
                        .clone()
                        .unwrap(),
                    binding: SourceMcpChildBinding {
                        operation_id: child.operation_id.clone(),
                        parent_run_id: child.parent_run_id.clone(),
                        execution_owner: operation.execution_owner.clone().unwrap(),
                        execution_epoch: operation.epoch,
                    },
                },
                selection: original.clone(),
            },
            provenance: binding.provenance.clone(),
        })
        .collect();
    (binding, receipts)
}
fn commit(
    f: &mut Fixture,
    run: &str,
    binding: HostToolBinding,
    receipts: Vec<McpChildDerivationReceipt>,
) -> Result<LaunchIntent, varin_runtime::catalog::RuntimeError> {
    let prepared =
        f.db.prepare_mcp_change_with_derivations(run, binding, receipts)?
            .load()?;
    f.db.admit_launch_change(prepared)?.load()
}
fn cleanup(f: Fixture) {
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn managed_child_requires_exact_per_source_proofs_and_commits_only_once() {
    let mut f = fixture(true);
    let child = admit(&mut f);
    let run = child.receipt.as_ref().unwrap().run_id.clone();
    let (binding, receipts) = derivation(&f, &child);
    assert!(!binding.derives_from(f.launch.mcp_binding.as_ref().unwrap()));
    assert!(commit(&mut f, &run, binding.clone(), vec![]).is_err());
    let mut incomplete = receipts.clone();
    incomplete[0].proof.selection = cut(f.launch.mcp_binding.as_ref().unwrap(), "A");
    incomplete[0].provenance.servers.remove("B");
    assert!(commit(&mut f, &run, binding.clone(), incomplete).is_err());
    for mutation in [
        "run",
        "thread",
        "execution",
        "pin",
        "handoff",
        "source",
        "physical-host",
        "materialization",
        "epoch",
        "parent-run",
        "parent-owner",
        "origin",
        "cut",
        "definition",
        "configuration",
        "target-authority",
        "parent-alias",
        "resource-owner",
        "scope",
        "schema",
        "route",
        "resource",
        "duplicate",
    ] {
        let mut next = binding.clone();
        let mut evidence = receipts.clone();
        let proof = &mut evidence[0].proof;
        match mutation {
            "run" => proof.child_run_id = "other-run".into(),
            "thread" => proof.child_thread_id = "other-thread".into(),
            "execution" => proof.execution_id = "other-execution".into(),
            "pin" => proof.pin.pin_id = "other-pin".into(),
            "handoff" => proof.handoff.operation_id = "other-handoff".into(),
            "source" => proof.source.branch_id = Some("parent-branch".into()),
            "physical-host" => proof.physical_root.host_id = "other-host".into(),
            "materialization" => proof.materialization_receipt_hash = "forged".into(),
            "epoch" => {
                if let McpChildDerivationOrigin::Dispatch { binding, .. } = &mut proof.origin {
                    binding.execution_epoch += 1;
                }
            }
            "parent-run" => {
                if let McpChildDerivationOrigin::Dispatch { binding, .. } = &mut proof.origin {
                    binding.parent_run_id = "other-parent".into();
                }
            }
            "parent-owner" => {
                if let McpChildDerivationOrigin::Dispatch { binding, .. } = &mut proof.origin {
                    binding.execution_owner = ExecutorOwner::External {
                        identity: "other".into(),
                        epoch: "other".into(),
                    };
                }
            }
            "origin" => {
                proof.origin = McpChildDerivationOrigin::Continuation {
                    previous_run_id: child.parent_run_id.clone(),
                }
            }
            "cut" => proof.selection = cut(f.launch.mcp_binding.as_ref().unwrap(), "A"),
            "definition" => {
                next.provenance
                    .servers
                    .get_mut("A")
                    .unwrap()
                    .definition_version = "latest".into()
            }
            "configuration" => {
                next.provenance
                    .servers
                    .get_mut("A")
                    .unwrap()
                    .owner
                    .configuration
                    .config_cwd = "/other".into()
            }
            "target-authority" => proof.source_authority = authority("unrelated-source"),
            "parent-alias" => {
                proof.source_authority = authority("parent-A");
                next.provenance
                    .servers
                    .get_mut("A")
                    .unwrap()
                    .owner
                    .source_authority = Some(authority("parent-A"));
                evidence[0]
                    .provenance
                    .servers
                    .get_mut("A")
                    .unwrap()
                    .owner
                    .source_authority = Some(authority("parent-A"));
            }
            "resource-owner" => {
                next.provenance
                    .servers
                    .get_mut("A")
                    .unwrap()
                    .owner
                    .resource_owner = SourceResourceOwner::Local
            }
            "scope" => {
                next.provenance
                    .servers
                    .get_mut("A")
                    .unwrap()
                    .owner
                    .execution_scope = McpExecutionScope::Global
            }
            "schema" => next.tools[0].description.push_str(" changed"),
            "route" => {
                next.routes.insert("first".into(), McpRoute::DirectTask);
            }
            "resource" => {
                next.resources.insert("first".into(), "child-B".into());
            }
            "duplicate" => evidence.push(evidence[0].clone()),
            _ => unreachable!(),
        }
        assert!(commit(&mut f, &run, next, evidence).is_err(), "{mutation}");
    }
    let committed = commit(&mut f, &run, binding.clone(), receipts.clone()).unwrap();
    assert_eq!(committed.selection.mcp_binding, Some(binding.clone()));
    assert_eq!(
        commit(&mut f, &run, binding.clone(), receipts.clone())
            .unwrap()
            .revision,
        committed.revision
    );
    let mut other = binding.clone();
    other.reference = "another-owner".into();
    assert!(commit(&mut f, &run, other, receipts.clone()).is_err());
    let root = f.root.clone();
    drop(f.db);
    f.db = Catalog::open(&root).unwrap();
    assert_eq!(
        commit(&mut f, &run, binding.clone(), receipts)
            .unwrap()
            .selection
            .mcp_binding,
        Some(binding.clone())
    );
    assert_eq!(
        f.db.prepare_mcp_launch(&run, binding).unwrap().revision,
        committed.revision
    );
    cleanup(f);
}

#[test]
fn managed_proofs_do_not_make_fixed_branch_children_executable() {
    let mut f = fixture(false);
    let child = admit(&mut f);
    let run = child.receipt.as_ref().unwrap().run_id.clone();
    let (binding, receipts) = derivation(&f, &child);
    assert_eq!(
        child.source.selection().unwrap().mode,
        SourceMode::FixedBranch
    );
    assert!(commit(&mut f, &run, binding, receipts).is_err());
    cleanup(f);
}

#[test]
fn managed_derivation_rechecks_original_operation_and_execution_at_commit() {
    for original_operation in [false, true] {
        let mut f = fixture(true);
        let child = admit(&mut f);
        let run = child.receipt.as_ref().unwrap().run_id.clone();
        let (binding, receipts) = derivation(&f, &child);
        let prepared =
            f.db.prepare_mcp_change_with_derivations(&run, binding, receipts)
                .unwrap()
                .load()
                .unwrap();
        if original_operation {
            let sql = rusqlite::Connection::open(f.root.join("conversation.sqlite")).unwrap();
            sql.execute("UPDATE operations SET body=json_set(body,'$.epoch',json_extract(body,'$.epoch')+1) WHERE id=?1", [&child.operation_id]).unwrap();
        } else {
            f.db.cancel_child(&child.operation_id).unwrap();
        }
        assert!(f.db.admit_launch_change(prepared).is_err());
        cleanup(f);
    }
}

#[test]
fn continued_child_proves_the_actual_predecessor_basis_and_new_materialized_source() {
    let mut f = fixture(true);
    let initial = admit(&mut f);
    f.settle_exchange();
    let first_run = initial.receipt.as_ref().unwrap().run_id.clone();
    let (first_binding, first_receipts) = derivation(&f, &initial);
    commit(
        &mut f,
        &first_run,
        first_binding.clone(),
        first_receipts.clone(),
    )
    .unwrap();
    for state in [RunState::Runnable, RunState::Completed] {
        f.db.commit_execution(
            &first_run,
            f.db.epoch(),
            &ExecutionRecord::StateChanged {
                state,
                waiting_on: None,
            },
        )
        .unwrap();
    }
    f.db.reconcile_child_reports().unwrap();
    f.db.begin_child_settlement(&initial.execution_id).unwrap();
    let publication = format!("child-result:{}", initial.execution_id);
    let candidate = KernelWorkingResultCandidate {
        publication_id: publication.clone(),
        candidate_operation_id: format!("result-prepare:{publication}"),
        workspace_id: "workspace-A".into(),
        branch_id: format!("child-source:{}", initial.execution_id),
        root: "published-root".into(),
        base_root: initial.source.pin().unwrap().root.clone(),
        write_revision: 1,
        pin_id: "result-pin".into(),
        base_pin_id: "result-base-pin".into(),
    };
    f.db.attach_child_candidate(&initial.execution_id, candidate.clone())
        .unwrap();
    f.db.attach_child_result(
        &initial.execution_id,
        ChildWorkingResultRef {
            publication_id: publication,
            workspace_id: candidate.workspace_id,
            branch_id: candidate.branch_id,
            result_revision: 1,
            root: candidate.root,
            base_root: candidate.base_root,
            record_id: "published-record".into(),
        },
        Effect::Confirmed,
    )
    .unwrap();
    f.db.mark_child_resources_released(&initial.execution_id)
        .unwrap();
    let prepared =
        f.db.capture_child_continuation(ChildContinuationCommand {
            source_agent: None,
            name: None,
            key: "continue-managed".into(),
            child_operation_id: initial.operation_id.clone(),
            previous_run_id: first_run.clone(),
            expected_head: f.db.head(&initial.child_branch_id).unwrap(),
            input: json!("continue"),
        })
        .unwrap()
        .load()
        .unwrap();
    let next = f.db.accept_child_continuation(prepared).unwrap();
    let source_basis = next.source_basis.as_ref().unwrap();
    let mut source = source_basis.source().clone();
    source.mode = SourceMode::Materialized;
    source.branch_id = Some(format!("child-source:{}", next.execution_id));
    source.revision = Some(0);
    let mut pin_source = source.clone();
    pin_source.mode = SourceMode::FixedBranch;
    let pin = ChildSourcePin {
        pin_id: format!("child-source-pin:{}", next.execution_id),
        root: source_basis.root().into(),
        source: pin_source,
    };
    let provenance =
        f.db.capture_delegated_execution(next.clone())
            .unwrap()
            .load()
            .unwrap()
            .source_basis
            .unwrap()["provenance"]
            .clone();
    let prepared =
        f.db.prepare_child_source(
            &next.execution_id,
            pin.clone(),
            source.clone(),
            serde_json::from_value(provenance).unwrap(),
        )
        .unwrap()
        .load()
        .unwrap();
    f.db.attach_child_source(prepared).unwrap();
    let (proposal, basis) = context(&initial, "continued");
    let prepared =
        f.db.capture_child_preparation(&next.execution_id, Some(source.clone()), proposal, basis)
            .unwrap()
            .load()
            .unwrap();
    let child = f.db.admit_child(prepared).unwrap();
    let run = child.receipt.as_ref().unwrap().run_id.clone();
    assert!(child.source.handoff().is_none());
    let mut binding = first_binding.clone();
    binding.reference = "continued-owner".into();
    binding.generation += 1;
    for resource in binding.resources.values_mut() {
        *resource = resource.replace("child", "continued");
    }
    for server in binding.provenance.servers.values_mut() {
        server.resource_key = server.resource_key.replace("child", "continued");
        server.owner.source_authority = Some(authority("actual-continuation-source"));
    }
    let mut proof = first_receipts[0].proof.clone();
    proof.execution_id = next.execution_id.clone();
    proof.child_run_id = run.clone();
    proof.source = source;
    proof.pin = pin;
    proof.selection = first_binding;
    proof.source_authority = authority("actual-continuation-source");
    proof.origin = McpChildDerivationOrigin::Continuation {
        previous_run_id: first_run,
    };
    proof.handoff = ChildSourceHandoff {
        refresh:None,
        source_run_id: None,
        operation_id: format!("child-source-handoff:{}", next.execution_id),
        source: source_basis.source().clone(),
        resource_authority: Some(ChildSourceAuthority {
            authority_id: "actual-child-source".into(),
            resource_epoch: "target-epoch".into(),
        }),
        root: ChildSourceRoot::Fixed {
            pin: ChildSourcePin {
                pin_id: format!("child-pin:{}", next.execution_id),
                root: source_basis.root().into(),
                source: source_basis.source().clone(),
            },
        },
    };
    proof.materialization_operation_id = format!("materialize:{}", next.execution_id);
    let receipt = McpChildDerivationReceipt {
        proof,
        provenance: binding.provenance.clone(),
    };
    for mutation in [
        "previous",
        "handoff-root",
        "handoff-pin",
        "handoff-owner",
        "basis",
        "old-execution",
        "old-receipt",
    ] {
        let mut wrong = receipt.clone();
        match mutation {
            "previous" => {
                wrong.proof.origin = McpChildDerivationOrigin::Continuation {
                    previous_run_id: initial.parent_run_id.clone(),
                }
            }
            "handoff-root" => {
                if let ChildSourceRoot::Fixed { pin } = &mut wrong.proof.handoff.root {
                    pin.root = "other".into();
                }
            }
            "handoff-pin" => {
                if let ChildSourceRoot::Fixed { pin } = &mut wrong.proof.handoff.root {
                    pin.pin_id = "other".into();
                }
            }
            "handoff-owner" => {
                wrong
                    .proof
                    .handoff
                    .resource_authority
                    .as_mut()
                    .unwrap()
                    .authority_id = "parent-A".into()
            }
            "basis" => wrong.proof.handoff.source.revision = Some(99),
            "old-execution" => wrong.proof.execution_id = initial.execution_id.clone(),
            "old-receipt" => wrong = first_receipts[0].clone(),
            _ => unreachable!(),
        }
        assert!(
            commit(&mut f, &run, binding.clone(), vec![wrong]).is_err(),
            "{mutation}"
        );
    }
    assert_eq!(
        commit(&mut f, &run, binding.clone(), vec![receipt])
            .unwrap()
            .selection
            .mcp_binding,
        Some(binding)
    );
    cleanup(f);
}

#[test]
fn a_child_source_cannot_merge_distinct_parent_source_receipts() {
    let mut original = original_binding();
    original
        .provenance
        .servers
        .get_mut("B")
        .unwrap()
        .owner
        .source_authority = Some(authority("parent-B"));
    let mut f = fixture_with_binding(true, original.clone());
    let child = admit(&mut f);
    let run = child.receipt.as_ref().unwrap().run_id.clone();
    let (binding, mut receipts) = derivation(&f, &child);
    assert!(commit(&mut f, &run, binding.clone(), receipts.clone()).is_err());
    receipts[0].proof.selection = cut(&original, "A");
    receipts[0].provenance.servers.remove("B");
    let mut second = receipts[0].clone();
    second.proof.selection = cut(&original, "B");
    if let McpChildDerivationOrigin::Dispatch {
        parent_source_authority,
        ..
    } = &mut second.proof.origin
    {
        *parent_source_authority = authority("parent-B");
    }
    second.provenance.servers = [("B".into(), binding.provenance.servers["B"].clone())].into();
    receipts.push(second);
    assert!(commit(&mut f, &run, binding, receipts).is_err());
    cleanup(f);
}

#[test]
fn managed_proof_preserves_the_local_contribution_owner_in_a_mixed_binding() {
    let mut original = original_binding();
    original.tools.push(tool("local"));
    original.routes.insert("local".into(), McpRoute::Direct);
    original
        .resources
        .insert("local".into(), "local-old".into());
    original
        .resources
        .insert("server:local".into(), "local-old".into());
    let mut local = original.provenance.servers["A"].clone();
    local.owner.resource_owner = SourceResourceOwner::Local;
    local.owner.source_authority = None;
    local.owner.execution_scope = McpExecutionScope::Global;
    local.resource_key = "local-old".into();
    original
        .provenance
        .servers
        .insert("local".into(), local.clone());
    let mut f = fixture_with_binding(true, original.clone());
    let child = admit(&mut f);
    let run = child.receipt.as_ref().unwrap().run_id.clone();
    let (mut binding, mut receipts) = derivation(&f, &child);
    binding
        .provenance
        .servers
        .insert("local".into(), local.clone());
    receipts[0]
        .proof
        .selection
        .provenance
        .servers
        .remove("local");
    receipts[0].proof.selection.resources.remove("local");
    receipts[0].proof.selection.resources.remove("server:local");
    receipts[0]
        .proof
        .selection
        .tools
        .retain(|tool| tool.name != "local");
    receipts[0].proof.selection.routes.remove("local");
    receipts[0].provenance.servers.remove("local");
    let mut wrong = binding.clone();
    wrong
        .provenance
        .servers
        .get_mut("local")
        .unwrap()
        .owner
        .configuration
        .config_cwd = "/latest-local".into();
    assert!(commit(&mut f, &run, wrong, receipts.clone()).is_err());
    binding.resources.insert("local".into(), "local-new".into());
    binding
        .resources
        .insert("server:local".into(), "local-new".into());
    binding
        .provenance
        .servers
        .get_mut("local")
        .unwrap()
        .resource_key = "local-new".into();
    let result = commit(&mut f, &run, binding, receipts).unwrap();
    assert_eq!(
        result.selection.mcp_binding.unwrap().provenance.servers["local"].owner,
        local.owner
    );
    cleanup(f);
}
