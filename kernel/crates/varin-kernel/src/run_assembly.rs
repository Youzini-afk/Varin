//! Cold model/tool assembly belongs to a supervised Run, never the Agent command actor.
use crate::agent_runtime::{bind_policy_model, domain, live_extension_binding, live_mcp_binding};
use crate::error::KernelError;
use crate::protocol::PROTOCOL_VERSION;
use crate::protocol_generated::{LaunchSelectParams, RunStartParams};
use serde_json::{json, Value};
use std::{sync::Arc, thread};
use varin_runtime::{
    model_session,
    supervisor::{RunHandle, RunStart, RunSupervisor},
};

#[derive(Clone)]
pub(crate) struct RunAssembly {
    pub runtime: Arc<RunSupervisor>,
    pub resources: crate::tools::KernelResourceClient,
    pub credentials: crate::credential_bridge::CredentialBridge,
    pub language: crate::language::LanguageBridge,
    pub retrieval: crate::retrieval::RetrievalBridge,
    pub memory: crate::host_query::OwnerChannel,
    pub context: crate::host_query::OwnerChannel,
    pub resource: crate::host_query::OwnerChannel,
    pub plan: crate::plan_bridge::PlanBridge,
    pub policy: crate::policy::PolicyBridge,
    pub models: Arc<crate::run_models::RunModels>,
    pub tools: Arc<crate::run_tools::RunTools>,
    pub responses: crate::transport::Sender,
    pub epoch: String,
}
pub(crate) enum PreparedLaunch {
    Selection(Value),
    Start(RunStart),
}
pub(crate) struct RunPreparation {
    pub params: RunStartParams,
    tools: Option<crate::tools::ToolBinding>,
}
impl RunPreparation {
    pub fn new(mut params: RunStartParams, run: &varin_runtime::Run) -> Result<Self, KernelError> {
        let tools = params
            .tool_binding
            .take()
            .map(serde_json::from_value::<crate::tools::ToolBinding>)
            .transpose()?;
        if tools
            .as_ref()
            .is_some_and(|binding| binding.run_id != run.id || binding.thread_id != run.thread_id)
        {
            return Err(KernelError::Authorization(
                "tool binding does not belong to the admitted Run".into(),
            ));
        }
        Ok(Self { params, tools })
    }
}
impl RunAssembly {
    pub fn prepare(
        &self,
        preparation: RunPreparation,
        selected: Option<LaunchSelectParams>,
        cancelled: impl Fn() -> bool,
    ) -> Result<PreparedLaunch, KernelError> {
        let check_cancelled = || {
            if cancelled() {
                Err(KernelError::Cancelled)
            } else {
                Ok(())
            }
        };
        check_cancelled()?;
        let p = preparation.params;
        let tool_binding = preparation.tools;
        let runtime = &self.runtime;
        let resources = &self.resources;
        let credential_bridge = &self.credentials;
        let language_bridge = &self.language;
        let retrieval_bridge = &self.retrieval;
        let memory_bridge = &self.memory;
        let plan_bridge = &self.plan;
        let policy_bridge = &self.policy;
        let run = {
            let catalog = runtime.catalog();
            let catalog = catalog
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            catalog.run(&p.run_id).map_err(domain)?
        };
        let saved_schema_generation = runtime
            .catalog()
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .launch_metadata(&p.run_id)
            .map_err(domain)?
            .map(|launch| launch.selection.tool_schema_generation);
        let plan_eligible = {
            let owner = runtime.catalog();
            let catalog = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            crate::plan::eligible(&catalog, &run.id)
                .map_err(|error| KernelError::Authorization(error.to_string()))?
        };
        let summary_parts = runtime
            .catalog()
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .context_job_parts(&run.id)
            .map_err(domain)?;
        let is_context_job = summary_parts.is_some();
        let is_child = runtime
            .catalog()
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .require_child_launch(&run.id)
            .map_err(domain)?
            .is_some();
        if is_child
            && (p.mcp_binding.is_some()
                || p.extension_bindings.is_some()
                || p.policy_binding.is_some())
        {
            return Err(KernelError::Authorization(
                "read-only child cannot expand its admitted capabilities".into(),
            ));
        }
        if is_context_job
            && (selected.is_some()
                || tool_binding.is_some()
                || p.mcp_binding.is_some()
                || p.extension_bindings.is_some()
                || p.policy_binding.is_some())
        {
            return Err(KernelError::Protocol(
                "context jobs use their fixed tool-free launch".into(),
            ));
        }
        let configuration = serde_json::from_value(run.configuration.clone())?;
        check_cancelled()?;
        let mut selected_credential_scope = None;
        let mut start = if let Some(scope) = p.credential_scope {
            let scope = varin_runtime::providers::auth::CredentialScope {
                reference: scope.reference,
                authority: scope.authority,
                account: scope.account,
                generation: scope.generation.try_into().map_err(|_| {
                    KernelError::Protocol("credential generation must be nonnegative".into())
                })?,
            };
            selected_credential_scope = Some(scope.clone());
            let active_model = runtime
                .catalog()
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .model_selections(&p.run_id)
                .map_err(domain)?
                .active;
            let resolver = match active_model {
                Some(active) => credential_bridge.resolver_for_binding(
                    &p.run_id,
                    &active.binding_id,
                    scope.clone(),
                ),
                None => credential_bridge.resolver(&p.run_id, scope.clone()),
            }
            .map_err(|_| {
                KernelError::Authorization("private Host credential owner unavailable".into())
            })?;
            model_session::bind_with_credentials(configuration, resolver, scope)
        } else {
            model_session::bind(configuration)
        }
        .map_err(|e| KernelError::Operation(e.to_string()))?;
        check_cancelled()?;
        if let Some(parts) = summary_parts {
            start = varin_runtime::context_job::configure_compaction_start(start, parts);
        }
        let policy_launch = runtime
            .catalog()
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .launch_metadata(&p.run_id)
            .map_err(domain)?;
        let policy_generation = policy_launch.as_ref().map_or(0, |l| l.policy_generation);
        let policy_target = policy_launch
            .as_ref()
            .map(|l| l.policy_target.clone())
            .unwrap_or(varin_runtime::catalog::policy_switch::PolicyTarget::Default);
        if let Some(binding) = p.policy_binding {
            if binding.generation < 0
                || binding.generation as u64 != policy_generation
                || policy_target
                    != (varin_runtime::catalog::policy_switch::PolicyTarget::Extension {
                        artifact: binding.artifact.clone(),
                    })
            {
                return Err(KernelError::Authorization(
                    "policy rebind differs from committed artifact or generation".into(),
                ));
            }
            start.policy = policy_bridge
                .policy(
                    p.run_id.clone(),
                    binding.reference,
                    policy_generation,
                    binding.artifact,
                )
                .map_err(|e| KernelError::Authorization(e.to_string()))?;
        } else if matches!(
            policy_target,
            varin_runtime::catalog::policy_switch::PolicyTarget::Extension { .. }
        ) {
            return Err(KernelError::Authorization(
                "committed policy artifact requires its exact live binding".into(),
            ));
        }
        if !is_context_job && !is_child {
            start.policy = policy_bridge
                .install(
                    &p.run_id,
                    policy_generation,
                    policy_target,
                    start.policy,
                    Vec::new(),
                    std::collections::BTreeMap::new(),
                )
                .map_err(|e| KernelError::Operation(e.to_string()))?;
        }
        if !is_context_job {
            // Context ownership is independent of the selected tool profile.
            // Read-only children synchronize their own admitted notes without gaining memory tools.
            start =
                crate::memory::configure_context(start, runtime.catalog(), memory_bridge.clone());
        }
        if !is_context_job && !is_child {
            start = crate::questions::configure(start, runtime.catalog());
            start = crate::collaboration::configure(start, runtime.catalog());
            start = crate::process_wait::configure(start, runtime.catalog());
        }
        if let Some(selected) = selected {
            let kinds: std::collections::BTreeSet<crate::tools::ToolKind> = selected
                .enabled_tools
                .into_iter()
                .map(|kind| serde_json::from_value(Value::String(kind)))
                .collect::<std::result::Result<_, _>>()?;
            start.binding.tools = crate::tools::KernelToolExecutor::selected_schemas(&kinds);
            start.binding.tools.push(crate::agent_resources::schema());
            if !is_child {
                start.binding.tools = crate::questions::schemas(start.binding.tools);
                start.binding.tools.push(crate::agent_goals::schema());
                start.binding.tools = crate::collaboration::schemas(
                    start.binding.tools,
                    selected.source.0.as_ref().is_some_and(|source| {
                        source.mode == varin_runtime::SourceMode::FixedBranch
                    }),
                );
                start.binding.tools = crate::process_wait::schemas(start.binding.tools);
                start.binding.tools.push(crate::memory::schema(true));
                if plan_eligible {
                    start.binding.tools.push(crate::plan::schema());
                }
            }
            start
                .binding
                .tools
                .sort_by(|left, right| left.name.cmp(&right.name));
            start.binding.tool_schema_generation =
                saved_schema_generation.unwrap_or(start.binding.configuration_generation);
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
            if source.is_none() {
                start.binding.tool_schema_generation = 0;
            }
            let mut selection = varin_runtime::catalog::launches::LaunchSelection::from_binding(
                &start.binding,
                start.policy.identity(),
                source,
            );
            selection.credential_scope = selected_credential_scope;
            check_cancelled()?;
            let preparation = runtime
                .catalog()
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .prepare_launch_selection(selection);
            let prepared = preparation.load().map_err(domain)?;
            let read = runtime
                .catalog()
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .admit_launch(&p.run_id, prepared, false)
                .map_err(domain)?;
            let intent = read.load().map_err(domain)?;
            return Ok(PreparedLaunch::Selection(serde_json::to_value(intent)?));
        }
        let mut launch_source = None;
        let mut declarations = Vec::new();
        let mut collaboration_source = None;
        if let Some(binding) = tool_binding {
            launch_source = Some(binding.source_selection()?);
            let retrieval_project_id = runtime
                .catalog()
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .run_project_id(&p.run_id)
                .map_err(domain)?;
            let collaboration_binding = binding.clone();
            let tools = crate::tools::KernelToolExecutor::new(binding, resources.clone())
                .map_err(|e| KernelError::Authorization(e.to_string()))?
                .with_language(language_bridge.clone())
                .with_retrieval(retrieval_bridge.clone(), retrieval_project_id);
            start.binding.tool_schema_generation =
                saved_schema_generation.unwrap_or(start.binding.configuration_generation);
            declarations.extend(tools.declarations(!is_child));
            collaboration_source = Some(collaboration_binding);
        }
        if !is_context_job {
            declarations.push(crate::agent_resources::declaration(runtime.catalog(),self.resource.clone()));
        }
        if !is_context_job && !is_child {
            declarations.push(crate::questions::declaration(runtime.catalog()));
            declarations.push(crate::questions::status_declaration(runtime.catalog()));
            declarations.push(crate::agent_goals::declaration(runtime.catalog()));
            declarations.extend(crate::collaboration::declarations(
                runtime.catalog(),
                collaboration_source.clone(),
                resources.clone(),
            ));
            if let Some(source) = collaboration_source {
                declarations.extend(crate::process_wait::declarations(
                    runtime.catalog(),
                    source,
                    resources.clone(),
                ));
            }
            declarations.push(crate::memory::declaration(
                runtime.catalog(),
                memory_bridge.clone(),
                true,
            ));
        }
        if plan_eligible {
            declarations.push(crate::plan::declaration(
                runtime.catalog(),
                plan_bridge.clone(),
            ));
        }
        let mcp_live = p.mcp_binding.map(live_mcp_binding).transpose()?;
        let mcp_binding = mcp_live.as_ref().map(|live| live.binding.clone());
        let extensions = p
            .extension_bindings
            .unwrap_or_default()
            .into_iter()
            .map(live_extension_binding)
            .collect::<Result<Vec<_>, _>>()?;
        let extension_bindings = extensions.iter().map(|live| live.binding.clone()).collect();
        if let Some(generation) = saved_schema_generation {
            start.binding.tool_schema_generation = generation;
        }
        let directory = self
            .tools
            .prepare_scope(&p.run_id, declarations, mcp_live, extensions)
            .map_err(|error| KernelError::Protocol(error.to_string()))?;
        start.binding.tools = directory.schemas().to_vec();
        let policy_read = runtime
            .catalog()
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .capture_launch(&p.run_id)
            .map_err(domain)?;
        let policy_models = policy_read
            .map(|read| read.load_policy_models())
            .transpose()
            .map_err(domain)?
            .unwrap_or_default();
        if is_context_job && !policy_models.is_empty() {
            return Err(KernelError::Protocol(
                "context jobs cannot acquire planning capabilities".into(),
            ));
        }
        if !is_context_job && !is_child {
            let mut models = std::collections::BTreeMap::new();
            for capability in &policy_models {
                if capability.status != varin_runtime::execution::PolicyModelStatus::Available {
                    continue;
                }
                let bound = bind_policy_model(&p.run_id, capability, &credential_bridge)?;
                if capability.binding.as_ref() != Some(&bound.binding) {
                    return Err(KernelError::Authorization(
                        "planning model differs from its admitted binding".into(),
                    ));
                }
                if models
                    .insert(
                        capability.capability_id.clone(),
                        varin_runtime::execution::BoundPolicyModel {
                            capability: capability.clone(),
                            provider: bound.provider,
                        },
                    )
                    .is_some()
                {
                    return Err(KernelError::Protocol(
                        "duplicate planning capability identity".into(),
                    ));
                }
            }
            policy_bridge
                .install_models(&p.run_id, policy_generation, policy_models.clone(), models)
                .map_err(|e| KernelError::Operation(e.to_string()))?;
            start.provider = policy_bridge
                .wrap_models(&p.run_id, start.provider)
                .map_err(|e| KernelError::Operation(e.to_string()))?;
        }
        {
            let mut selection = varin_runtime::catalog::launches::LaunchSelection::from_binding(
                &start.binding,
                start.policy.identity(),
                launch_source,
            );
            selection.mcp_binding = mcp_binding;
            selection.extension_bindings = extension_bindings;
            selection.credential_scope = selected_credential_scope;
            selection.policy_models = policy_models;
            check_cancelled()?;
            let preparation = runtime
                .catalog()
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .prepare_launch_selection(selection);
            let prepared = preparation.load().map_err(domain)?;
            runtime
                .catalog()
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .admit_launch(&p.run_id, prepared, true)
                .map_err(domain)?;
        }
        check_cancelled()?;
        start.tools = if !is_context_job && !is_child {
            self.tools
                .install(&p.run_id, start.binding.tool_schema_generation, directory)
                .map_err(|error| KernelError::Operation(error.to_string()))?
        } else {
            directory.into_static()
        };
        if !is_context_job {
            start.provider = self.models.wrap(start.provider);
            start.context_preparation = Arc::new(crate::context::CapacityPreparation::new(
                start.context_preparation,
                runtime.catalog(),
                self.context.clone(),
            ));
        }
        let (progress, updates) = varin_runtime::execution::ProgressSink::channel(64);
        start.progress = progress;
        let responses = self.responses.clone();
        let epoch = self.epoch.clone();
        let stream_id = uuid::Uuid::new_v4().to_string();
        thread::spawn(move || {
            for update in updates {
                let event = json!({"v":PROTOCOL_VERSION,"kind":"runtime-event","kernelEpoch":epoch,
                    "stream":"progress","runId":update.run_id,"streamId":stream_id,"sequence":update.sequence,"event":update.event});
                let _ = responses.try_send(event);
            }
        });
        Ok(PreparedLaunch::Start(start))
    }
    pub fn observe_completion(&self, handle: RunHandle) {
        let responses = self.responses.clone();
        let epoch = self.epoch.clone();
        let run_id = handle.run_id.clone();
        let catalog = self.runtime.catalog();
        let models = self.models.clone();
        let tools = self.tools.clone();
        let policy = self.policy.clone();
        thread::spawn(move || {
            let _ = handle.wait();
            let terminal = catalog
                .lock()
                .ok()
                .and_then(|catalog| catalog.run(&run_id).ok())
                .is_some_and(|run| run.state.terminal());
            if terminal {
                models.release(&run_id);
                tools.release(&run_id);
                policy.release(&run_id);
                let _ = responses.send(
                    json!({"v":1,"kind":"host-tool-owner-release","kernelEpoch":epoch,"runId":run_id}),
                );
            }
        });
    }
}
