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

#[cfg(test)]
#[path = "child_policy_review.rs"]
mod child_policy_review;
#[cfg(test)]
#[path = "run_assembly_review.rs"]
mod tests;
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
        let is_bot = runtime.catalog().lock().map_err(|_| KernelError::Storage("catalog owner failed".into()))?.bot_for_thread(&run.thread_id).map_err(domain)?.is_some();
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
        let summary_read = {
            let owner = runtime.catalog();
            let catalog = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            if catalog.is_context_job(&run.id).map_err(domain)? {
                Some(catalog.capture_context_job(&run.id).map_err(domain)?)
            } else {
                None
            }
        };
        // Recipe hydration is outside Catalog ownership and protected by its original lease.
        let summary_plan = summary_read
            .map(|read| read.load_execution())
            .transpose()
            .map_err(domain)?;
        let is_context_job = summary_plan.is_some();
        let text_compaction = summary_plan.as_ref().is_some_and(|execution| {
            matches!(
                execution.plan,
                varin_runtime::context_job::ContextCompactionPlan::Text { .. }
            )
        });
        let is_child = runtime
            .catalog()
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .require_child_launch(&run.id)
            .map_err(domain)?
            .is_some();
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
        check_cancelled()?;
        let mut selected_credential_scope = None;
        let mut start = if text_compaction {
            let read = runtime.catalog().lock().map_err(|_|KernelError::Storage("catalog owner failed".into()))?.capture_launch(&run.id).map_err(domain)?.ok_or_else(||KernelError::Protocol("text summary launch is missing".into()))?;
            let launch = read.load().map_err(domain)?;
            selected_credential_scope = launch.selection.credential_scope.clone();
            if p.credential_scope.is_some() { return Err(KernelError::Protocol("text compaction uses its original credential identity without credential rebinding".into())); }
            Ok(varin_runtime::context_job::text_compaction_start(&launch.selection))
        } else {
            let configuration = serde_json::from_value(run.configuration.clone())?;
            if let Some(scope) = p.credential_scope {
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
        }
        .map_err(|e| KernelError::Operation(e.to_string()))?;
        check_cancelled()?;
        if let Some(plan) = summary_plan {
            start = varin_runtime::context_job::configure_compaction_start(start, plan);
        }
        let policy_launch = runtime
            .catalog()
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .capture_launch(&p.run_id)
            .map_err(domain)?;
        let policy_generation = policy_launch
            .as_ref()
            .map_or(0, |l| l.metadata.policy_generation);
        let policy_target = policy_launch
            .as_ref()
            .map(|l| l.load_policy_target())
            .transpose()
            .map_err(domain)?
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
        if !is_context_job {
            // Policy ownership is per Run, including accepted children. Delegated tool/source
            // authority remains independently frozen by the child directory below.
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
            // Children synchronize their own notes even when no memory tool was selected.
            start =
                crate::memory::configure_context(start, runtime.catalog(), memory_bridge.clone());
        }
        if !is_context_job {
            start = crate::questions::configure(start, runtime.catalog());
            start = crate::observations::configure(start, runtime.catalog());
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
                start.binding.tools =
                    crate::run_tools::builtin_schemas(&kinds, plan_eligible, true, is_bot);
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
                        resource_owner: source.resource_owner,
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
            selection.child_dispatch = selected.child_dispatch;
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
            let tools = crate::tools::KernelToolExecutor::new(binding, resources.clone().with_journal_catalog(runtime.catalog()))
                .map_err(|e| KernelError::Authorization(e.to_string()))?
                .with_language(language_bridge.clone())
                .with_retrieval(
                    retrieval_bridge.clone(),
                    retrieval_project_id,
                    runtime
                        .catalog()
                        .lock()
                        .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                        .nested_tools(),
                );
            start.binding.tool_schema_generation =
                saved_schema_generation.unwrap_or(start.binding.configuration_generation);
            declarations.extend(tools.declarations(true));
            collaboration_source = Some(collaboration_binding);
        }
        if !is_context_job {
            declarations.push(crate::agent_resources::declaration(
                runtime.catalog(),
                self.resource.clone(),
            ));
        }
        if !is_context_job {
            declarations.push(crate::questions::declaration(runtime.catalog()));
            declarations.extend(crate::capability_tools::declarations(runtime.catalog()));
            declarations.extend(crate::family_tools::declarations(runtime.catalog()));
            declarations.push(crate::message_tools::declaration(runtime.catalog()));
            declarations.push(crate::followup_tools::declaration(
                runtime.catalog(),
                collaboration_source.clone(),
                Some(resources.clone()),
            ));
            declarations.push(crate::questions::status_declaration(runtime.catalog()));
            if !is_child {
                declarations.push(crate::agent_goals::declaration(runtime.catalog()));
            }
            declarations.extend(crate::collaboration::declarations(
                runtime.catalog(),
                collaboration_source.clone(),
                resources.clone(),
                self.tools.bridge(),
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
                is_bot,
            ));
        }
        if plan_eligible {
            declarations.push(crate::plan::declaration(
                runtime.catalog(),
                plan_bridge.clone(),
            ));
        }
        let saved_launch = runtime
            .catalog()
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .capture_launch(&p.run_id)
            .map_err(domain)?;
        let saved_launch = saved_launch
            .map(|read| read.load())
            .transpose()
            .map_err(domain)?;
        if is_child {
            let admitted = &saved_launch
                .as_ref()
                .ok_or_else(|| KernelError::Authorization("Child launch missing".into()))?
                .selection
                .tools;
            declarations.retain(|declaration| admitted.contains(&declaration.schema));
        }
        let mcp_live = p.mcp_binding.map(live_mcp_binding).transpose()?;
        let mcp_binding = mcp_live.as_ref().map(|live| live.binding.clone());
        let extensions = p
            .extension_bindings
            .unwrap_or_default()
            .into_iter()
            .map(live_extension_binding)
            .collect::<Result<Vec<_>, _>>()?;
        let extension_bindings: Vec<_> =
            extensions.iter().map(|live| live.binding.clone()).collect();
        if is_child {
            let admitted = &saved_launch
                .as_ref()
                .expect("child launch checked")
                .selection;
            if admitted.mcp_binding != mcp_binding
                || admitted.extension_bindings != extension_bindings
            {
                return Err(KernelError::Authorization(
                    "Child Host owner differs from its admitted binding".into(),
                ));
            }
        }
        if let Some(generation) = saved_schema_generation {
            start.binding.tool_schema_generation = generation;
        }
        let directory = self
            .tools
            .prepare_scope(&p.run_id, declarations, mcp_live, extensions)
            .map_err(|error| KernelError::Protocol(error.to_string()))?;
        if is_child {
            let mut admitted = saved_launch
                .as_ref()
                .expect("child launch checked")
                .selection
                .tools
                .clone();
            admitted.sort_by(|left, right| left.name.cmp(&right.name));
            if directory.schemas() != admitted {
                return Err(KernelError::Authorization(
                    "Child capability rebind does not match admitted declarations".into(),
                ));
            }
        }
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
        if !is_context_job {
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
            selection.child_dispatch = saved_launch
                .as_ref()
                .and_then(|launch| launch.selection.child_dispatch.clone());
            selection.agent = saved_launch.as_ref().and_then(|launch| launch.selection.agent.clone());
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
            directory
                .into_static()
                .map_err(|error| KernelError::Operation(error.to_string()))?
        };
        if !is_context_job {
            start.provider = self.models.wrap(start.provider);
            start.context_preparation = Arc::new(crate::child_capabilities::BindingPreparation {
                inner: start.context_preparation,
                catalog: runtime.catalog(),
            });
            start.context_preparation = Arc::new(crate::context::CapacityPreparation::new(
                start.context_preparation,
                runtime.catalog(),
                self.context.clone(),
            ));
        }
        let (progress, updates) = varin_runtime::execution::ProgressSink::channel();
        start.progress = progress;
        let responses = self.responses.clone();
        let epoch = self.epoch.clone();
        let stream_id = uuid::Uuid::new_v4().to_string();
        let thread_id = run.thread_id.clone();
        let branch_id = run.branch_id.clone();
        thread::spawn(move || {
            let mut sequence = 0u64;
            for batch in updates { for update in batch {
                sequence += 1;
                let event = json!({"v":PROTOCOL_VERSION,"kind":"runtime-event","kernelEpoch":epoch,
                    "stream":"progress","runId":update.run_id,"threadId":thread_id,"branchId":branch_id,
                    "requestId":update.request_id,"streamId":stream_id,"sequence":sequence,
                    "event":{"kind":"batch","events":update.events}});
                if responses.send_progress(event).is_err() { return; }
            } }
        });
        Ok(PreparedLaunch::Start(start))
    }
    pub fn observe_completion(&self, handle: RunHandle) {
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
            }
        });
    }
}
