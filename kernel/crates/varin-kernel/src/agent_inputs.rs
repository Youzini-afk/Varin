//! Host ingress bodies are staged and hydrated on request workers, outside Agent/Catalog ownership.
use super::*;

fn submit_input(
    catalog: Arc<Mutex<Catalog>>,
    params: Value,
    cancelled: Arc<AtomicBool>,
    order: Option<varin_runtime::resource_admission::ResourceReservation>,
) -> Result<Value, KernelError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    let p: InputSubmitParams = serde_json::from_value(params)?;
    validate_configuration(&p.configuration)?;
    if p.key.trim().is_empty() {
        return Err(KernelError::Protocol(
            "input idempotency key cannot be empty".into(),
        ));
    }
    let initial_personalization = p
        .initial_context
        .as_ref()
        .and_then(|context| context.personalization.clone())
        .map(personalization_basis)
        .transpose()?;
    let configuration = p.configuration;
    let command = SubmitInput {
        key: p.key,
        thread_id: p.thread_id,
        branch_id: p.branch_id,
        expected_head: p.expected_head.0,
        input: p.input,
        configuration: configuration.clone(),
    };
    let initial =
        p.initial_context
            .map(|context| varin_runtime::catalog::context::ContextProposal {
                key: format!("initial-context:{}", command.branch_id),
                branch_id: command.branch_id.clone(),
                through_id: None,
                expected_revision: 0,
                summary: String::new(),
                effective_system_prompt: context.effective_system_prompt,
                instruction_sources: context.instruction_sources,
                memory_checkpoint: context.memory_checkpoint.0,
            });
    let preparation = catalog
        .lock()
        .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
        .prepare_submission(command, initial, initial_personalization)
        .map_err(domain)?;
    let plan_eligible = preparation.scope().is_some_and(|scope| {
        scope.mode == "agent"
            && scope.thread_role == "main"
            && scope.session_id == preparation.thread_id()
    });
    let inherit_source = p
        .launch
        .as_ref()
        .and_then(|launch| launch.inherit_source)
        .unwrap_or(false);
    let launch = p
        .launch
        .map(|selected| {
            let configuration: varin_runtime::ModelSessionConfiguration =
                serde_json::from_value(configuration.clone())?;
            let scope = selected
                .credential_scope
                .map(|scope| {
                    Ok::<_, KernelError>(varin_runtime::providers::auth::CredentialScope {
                        reference: scope.reference,
                        authority: scope.authority,
                        account: scope.account,
                        generation: u64::try_from(scope.generation).map_err(|_| {
                            KernelError::Protocol(
                                "credential generation must be nonnegative".into(),
                            )
                        })?,
                    })
                })
                .transpose()?;
            let identity = if let Some(scope) = scope.as_ref() {
                model_session::connection_identity_with_scope(&configuration, scope)
            } else {
                model_session::connection_identity(&configuration)
            }
            .map_err(|error| KernelError::Protocol(error.to_string()))?;
            let kinds: std::collections::BTreeSet<crate::tools::ToolKind> = selected
                .enabled_tools
                .into_iter()
                .map(|kind| serde_json::from_value(Value::String(kind)))
                .collect::<std::result::Result<_, _>>()?;
            let source = selected
                .source
                .0
                .map(|source| {
                    Ok::<_, KernelError>(varin_runtime::catalog::launches::SourceSelection {
                        environment_run_id: source.environment_run_id,
                        mode: source.mode,
                        live_root: source.live_root.and_then(|root| root.0).map(|root| {
                            varin_runtime::catalog::launches::LiveRoot {
                                host_id: root.host_id,
                                canonical_root: root.canonical_root,
                                root_id: root.root_id,
                            }
                        }),
                        workspace_id: source.workspace_id,
                        execution_workspace_id: source.execution_workspace_id,
                        branch_id: source.branch_id.0,
                        revision: source.revision.0.map(u64::try_from).transpose().map_err(
                            |_| KernelError::Protocol("source revision must be nonnegative".into()),
                        )?,
                    })
                })
                .transpose()?;
            if source.is_none() && !kinds.is_empty() {
                return Err(KernelError::Protocol(
                    "selected tools require a source owner".into(),
                ));
            }
            Ok::<_, KernelError>(varin_runtime::catalog::launches::LaunchSelection {
                policy_models: Vec::new(),
                mcp_binding: None,
                credential_scope: scope,
                connection_identity: identity,
                provider_family: configuration.provider_family,
                model: configuration.model,
                configuration_generation: configuration.configuration_generation,
                tool_schema_generation: if source.is_some() {
                    configuration.configuration_generation
                } else {
                    0
                },
                tools: {
                    let mut tools = crate::collaboration::schemas(
                        crate::questions::schemas(
                            crate::tools::KernelToolExecutor::selected_schemas(&kinds),
                        ),
                        source.as_ref().is_some_and(|source| {
                            source.mode == varin_runtime::SourceMode::FixedBranch
                        }),
                    );
                    tools = crate::process_wait::schemas(tools);
                    tools.push(crate::memory::schema(true));
                    if plan_eligible {
                        tools.push(crate::plan::schema());
                    }
                    tools.sort_by(|left, right| left.name.cmp(&right.name));
                    tools
                },
                policy: crate::process_wait::default_policy_identity(),
                source,
            })
        })
        .transpose()?;
    let prepared = preparation.load(launch, inherit_source).map_err(domain)?;
    if cancelled.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    let _order = await_input_order(order)?;
    let receipt = {
        let mut owner = catalog
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
        if cancelled.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        owner.admit_submission(prepared).map_err(domain)?
    };
    Ok(serde_json::to_value(receipt)?)
}

fn await_input_order(
    order: Option<varin_runtime::resource_admission::ResourceReservation>,
) -> Result<Option<varin_runtime::resource_admission::ResourceLease>, KernelError> {
    order
        .map(|order| {
            order
                .acquire()
                .map_err(|error| KernelError::Operation(error.to_string()))
        })
        .transpose()
        .map(Option::flatten)
}

pub(super) fn execute(
    runtime: Arc<RunSupervisor>,
    method: &str,
    params: Value,
    cancelled: Arc<AtomicBool>,
    order: Option<varin_runtime::resource_admission::ResourceReservation>,
) -> Result<Value, KernelError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    let catalog = runtime.catalog();
    match method {
        "runtime.input.submit" => submit_input(catalog, params, cancelled, order),
        "runtime.child.prepare" => prepare_child_input(catalog, params, cancelled),
        "runtime.input.enqueue" => {
            let p: InputEnqueueParams = serde_json::from_value(params)?;
            if let Some(configuration) = &p.configuration {
                validate_configuration(configuration)?;
            }
            let preparation = catalog
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .prepare_enqueue(varin_runtime::catalog::inputs::EnqueueInput {
                    key: p.key,
                    thread_id: p.thread_id,
                    branch_id: p.branch_id,
                    mode: p.mode,
                    input: p.input,
                    configuration: p.configuration,
                });
            let prepared = preparation.load().map_err(domain)?;
            if cancelled.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            let _order = await_input_order(order)?;
            let receipt = {
                let mut owner = catalog
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
                if cancelled.load(Ordering::Acquire) {
                    return Err(KernelError::Cancelled);
                }
                owner.admit_queued_input(prepared).map_err(domain)?
            };
            if receipt.mode == varin_runtime::InputMode::Interrupt {
                runtime.interrupt_generation(&receipt.run_id);
            }
            Ok(serde_json::to_value(receipt)?)
        }
        "runtime.input.edit" => {
            let p: InputEditParams = serde_json::from_value(params)?;
            let revision = u64::try_from(p.expected_revision)
                .map_err(|_| KernelError::Protocol("input revision must be nonnegative".into()))?;
            let preparation = catalog
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .prepare_input_edit(&p.input_id, revision, p.content)
                .map_err(domain)?;
            let prepared = preparation.load().map_err(domain)?;
            if cancelled.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            let _order = await_input_order(order)?;
            let read = {
                let mut owner = catalog
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
                if cancelled.load(Ordering::Acquire) {
                    return Err(KernelError::Cancelled);
                }
                owner.admit_input_edit(prepared).map_err(domain)?
            };
            Ok(serde_json::to_value(read.load().map_err(domain)?)?)
        }
        "runtime.input.cancel" => {
            let p: InputCancelParams = serde_json::from_value(params)?;
            let revision = u64::try_from(p.expected_revision)
                .map_err(|_| KernelError::Protocol("input revision must be nonnegative".into()))?;
            let read = {
                let mut owner = catalog
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
                if cancelled.load(Ordering::Acquire) {
                    return Err(KernelError::Cancelled);
                }
                owner.cancel_input(&p.input_id, revision).map_err(domain)?
            };
            runtime
                .advance_pending()
                .map_err(|error| KernelError::Operation(error.to_string()))?;
            Ok(serde_json::to_value(read.load().map_err(domain)?)?)
        }
        "runtime.input.inspect" => {
            let p: InputHandleParams = serde_json::from_value(params)?;
            let read = catalog
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .capture_queued_input(&p.input_id)
                .map_err(domain)?;
            Ok(serde_json::to_value(read.load().map_err(domain)?)?)
        }
        "runtime.input.list" => {
            let p: HistoryParams = serde_json::from_value(params)?;
            let reads = catalog
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .capture_queued_inputs(&p.branch_id)
                .map_err(domain)?;
            let inputs = reads
                .into_iter()
                .map(|read| read.load().map_err(domain))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(serde_json::to_value(inputs)?)
        }
        _ => Err(KernelError::Protocol("unknown input command".into())),
    }
}

fn prepare_child_input(
    catalog: Arc<Mutex<Catalog>>,
    params: Value,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, KernelError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    let p: ChildPrepareParams = serde_json::from_value(params)?;
    let child = catalog
        .lock()
        .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
        .child_task(&p.operation_id)
        .map_err(domain)?;
    let source = varin_runtime::catalog::launches::SourceSelection {
        environment_run_id: p.source.environment_run_id,
        mode: p.source.mode,
        live_root: p.source.live_root.and_then(|root| root.0).map(|root| {
            varin_runtime::catalog::launches::LiveRoot {
                host_id: root.host_id,
                canonical_root: root.canonical_root,
                root_id: root.root_id,
            }
        }),
        workspace_id: p.source.workspace_id,
        execution_workspace_id: p.source.execution_workspace_id,
        branch_id: p.source.branch_id.0,
        revision: p
            .source
            .revision
            .0
            .map(u64::try_from)
            .transpose()
            .map_err(|_| KernelError::Protocol("source revision must be nonnegative".into()))?,
    };
    let basis =
        personalization_basis(p.context.personalization.ok_or_else(|| {
            KernelError::Protocol("child context requires admitted scope".into())
        })?)?;
    let proposal = varin_runtime::catalog::context::ContextProposal {
        key: format!("initial-child-context:{}", p.operation_id),
        branch_id: child.child_branch_id,
        through_id: None,
        expected_revision: 0,
        summary: String::new(),
        effective_system_prompt: p.context.effective_system_prompt,
        instruction_sources: p.context.instruction_sources,
        memory_checkpoint: p.context.memory_checkpoint.0,
    };
    let preparation = catalog
        .lock()
        .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
        .capture_child_preparation(&p.operation_id, source, proposal, basis)
        .map_err(domain)?;
    let prepared = preparation.load().map_err(domain)?;
    let result = {
        let mut owner = catalog
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
        if cancelled.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        owner.admit_child(prepared).map_err(domain)?
    };
    Ok(serde_json::to_value(result)?)
}
