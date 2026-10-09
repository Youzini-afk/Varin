//! Native agent control is independent of the file/process Storage execution queue.
//! Only the authenticated parent Host may use this management channel. It is not a tool grant.
use crate::error::{response_error, KernelError};
use crate::protocol::{
    reject_unknown_fields, response_ok, validate_method_params, PROTOCOL_VERSION,
};
use crate::protocol_generated::*;
use base64::Engine as _;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::thread::{self, JoinHandle};
use varin_runtime::{model_session, supervisor::RunSupervisor, Catalog, SubmitInput};

#[derive(Clone, Default)]
pub(crate) struct NativeControl(Arc<Mutex<Option<NativeOwner>>>);
struct NativeOwner {
    runtime: Arc<RunSupervisor>,
    resources: crate::native_tools::NativeResourceClient,
}
impl NativeControl {
    pub(crate) fn cancel_admitted(&self, request: &Value, current_epoch: Option<&str>) {
        let method = request.get("method").and_then(Value::as_str);
        if !matches!(
            method,
            Some("runtime.run.cancel" | "runtime.operation.cancel")
        ) || request.get("v").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
            || request.get("kind").and_then(Value::as_str) != Some("request")
            || request.get("epoch").and_then(Value::as_str) != current_epoch
            || current_epoch.is_none()
            || request.get("grantId").is_some()
            || reject_unknown_fields(
                request,
                &["v", "kind", "id", "method", "params", "epoch"],
                "runtime cancellation",
            )
            .is_err()
        {
            return;
        }
        let Some(params) = request.get("params") else {
            return;
        };
        if let Ok(control) = self.0.lock() {
            if let Some(owner) = control.as_ref() {
                let runtime = &owner.runtime;
                if method == Some("runtime.run.cancel") {
                    if let Ok(params) = serde_json::from_value::<NativeRunParams>(params.clone()) {
                        runtime.cancel_control(&params.run_id);
                    }
                } else if let Ok(params) =
                    serde_json::from_value::<NativeOperationParams>(params.clone())
                {
                    runtime.cancel_operation_control(&params.operation_id);
                    let _ = owner.resources.cancel_known_process(&params.operation_id);
                }
            }
        }
    }
}

pub(crate) enum Command {
    AdvanceRuns,
    Stop,
    ProcessTerminal(crate::process::ProcessTerminal),
    ProcessReplayFailed(String),
    Initialize {
        root: PathBuf,
        epoch: String,
    },
    Request {
        value: Value,
        cancellation: Arc<AtomicBool>,
    },
}
fn domain(error: varin_runtime::RuntimeError) -> KernelError {
    match error {
        varin_runtime::RuntimeError::Conflict(message) => {
            KernelError::Operation(format!("conflict: {message}"))
        }
        varin_runtime::RuntimeError::NotFound(message) => {
            KernelError::Operation(format!("not found: {message}"))
        }
        varin_runtime::RuntimeError::Invalid(message) => KernelError::Protocol(message),
        other => KernelError::Storage(other.to_string()),
    }
}
/// Transient progress is lossy; a protocol-sized guard must run before the shared writer.
pub(crate) fn progress_frame_fits(event: &Value, frame_limit: usize) -> bool {
    serde_json::to_vec(event).is_ok_and(|bytes| bytes.len() <= frame_limit)
}
pub(crate) fn spawn(
    commands: mpsc::Receiver<Command>,
    self_sender: mpsc::Sender<Command>,
    control: NativeControl,
    resources: crate::native_tools::NativeResourceClient,
    credential_bridge: crate::credential_bridge::CredentialBridge,
    mcp_bridge: crate::native_mcp::McpBridge,
    language_bridge: crate::native_language::LanguageBridge,
    memory_bridge: crate::native_memory_bridge::MemoryBridge,
    retrieval_bridge: crate::native_retrieval::RetrievalBridge,
    policy_bridge: crate::native_policy::PolicyBridge,
    responses: mpsc::SyncSender<Value>,
    finished: impl Fn(&str) + Send + Sync + 'static,
) -> JoinHandle<()> {
    let finished: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(finished);
    let (content_tasks, content_jobs) = mpsc::channel::<Box<dyn FnOnce() + Send>>();
    thread::spawn(move || {
        for job in content_jobs {
            job();
        }
    });

    thread::spawn(move || {
        let mut identity: Option<(PathBuf, String)> = None;
        let mut runtime: Option<Arc<RunSupervisor>> = None;
        for command in commands {
            match command {
                Command::AdvanceRuns => {
                    if let Some(runtime) = runtime.as_ref() {
                        if let Err(error) = runtime.advance_pending() {
                            let catalog = runtime.catalog();
                            if let Ok(mut catalog) = catalog.lock() {
                                let _ = catalog
                                    .record_recovery_failure("queued-runs", &error.to_string());
                            };
                        }
                    }
                }
                Command::Stop => break,
                Command::ProcessTerminal(fact) => {
                    if let Some(runtime) = runtime.as_ref() {
                        let result = apply_process_terminal(runtime, &fact);
                        if let Err(error) = result {
                            let catalog = runtime.catalog();
                            if let Ok(mut catalog) = catalog.lock() {
                                let _ = catalog
                                    .record_recovery_failure(&fact.process_id, &error.to_string());
                            };
                        }
                    }
                }
                Command::ProcessReplayFailed(reason) => {
                    if let Some(runtime) = runtime.as_ref() {
                        let catalog = runtime.catalog();
                        if let Ok(mut catalog) = catalog.lock() {
                            let _ = catalog.record_recovery_failure("process-replay", &reason);
                        };
                    }
                }
                Command::Initialize { root, epoch } => {
                    identity = Some((root.join("agent-runtime"), epoch));
                }
                Command::Request {
                    value,
                    cancellation,
                } => {
                    let id = value
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let mut deferred = false;
                    let result = (|| {
                        if cancellation.load(Ordering::Acquire) {
                            return Err(KernelError::Cancelled);
                        }
                        reject_unknown_fields(
                            &value,
                            &["v", "kind", "id", "method", "params", "epoch", "grantId"],
                            "native runtime request",
                        )?;
                        if value.get("v").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
                            || value.get("kind").and_then(Value::as_str) != Some("request")
                            || id.is_empty()
                        {
                            return Err(KernelError::Protocol("invalid runtime envelope".into()));
                        }
                        let (root, epoch) = identity.as_ref().ok_or_else(|| {
                            KernelError::Authorization("kernel handshake required".into())
                        })?;
                        if value.get("epoch").and_then(Value::as_str) != Some(epoch.as_str())
                            || value.get("grantId").is_some()
                        {
                            return Err(KernelError::Authorization(
                                "native runtime commands require current Host management authority"
                                    .into(),
                            ));
                        }
                        let method = value
                            .get("method")
                            .and_then(Value::as_str)
                            .ok_or_else(|| KernelError::Protocol("method required".into()))?;
                        let params = value.get("params").cloned().unwrap_or_else(|| json!({}));
                        validate_method_params(method, &params)?;
                        if runtime.is_none() {
                            let capacity = varin_runtime::execution_capacity::configured_compute_capacity()
                                .map_err(KernelError::Protocol)?;
                            let catalog = Catalog::open(root).map_err(domain)?;
                            catalog.resource_admission().set_compute_capacity(capacity);
                            let owner = Arc::new(RunSupervisor::new(catalog));
                            let (notify, notifications) = mpsc::sync_channel(1);
                            owner
                                .catalog()
                                .lock()
                                .map_err(|_| {
                                    KernelError::Storage("native catalog owner failed".into())
                                })?
                                .set_event_notifier(notify.clone())
                                .map_err(domain)?;
                            let observed = Arc::downgrade(&owner);
                            let event_responses = responses.clone();
                            let event_epoch = epoch.clone();
                            thread::spawn(move || {
                                while notifications.recv().is_ok() {
                                    let Some(owner) = observed.upgrade() else {
                                        break;
                                    };
                                    let cursor = owner
                                        .catalog()
                                        .lock()
                                        .ok()
                                        .and_then(|catalog| catalog.event_cursor().ok());
                                    if let Some(cursor) = cursor {
                                        if event_responses.send(json!({"v":PROTOCOL_VERSION,"kind":"runtime-event","kernelEpoch":event_epoch,"stream":"durable","cursor":cursor})).is_err() { break; }
                                    }
                                }
                            });
                            let _ = notify.try_send(());
                            let (wake, wakes) = mpsc::channel();
                            owner
                                .set_wake_sender(wake)
                                .map_err(|e| KernelError::Operation(e.to_string()))?;
                            let sender = self_sender.clone();
                            thread::spawn(move || {
                                while wakes.recv().is_ok() {
                                    if sender.send(Command::AdvanceRuns).is_err() {
                                        break;
                                    }
                                }
                            });
                            *control.0.lock().map_err(|_| {
                                KernelError::Storage("native control owner failed".into())
                            })? = Some(NativeOwner {
                                runtime: owner.clone(),
                                resources: resources.clone(),
                            });
                            runtime = Some(owner.clone());
                            let pending = {
                                let catalog = owner.catalog();
                                let catalog = catalog.lock().map_err(|_| {
                                    KernelError::Storage("native catalog owner failed".into())
                                })?;
                                catalog
                                    .pending_external_operations("native_process_spawn")
                                    .map_err(domain)?
                            };
                            if let Err(error) = resources.replay_process_terminals(pending) {
                                let catalog = owner.catalog();
                                if let Ok(mut catalog) = catalog.lock() {
                                    let _ = catalog.record_recovery_failure(
                                        "process-replay",
                                        &error.to_string(),
                                    );
                                };
                            }
                        }
                        let runtime = runtime.as_ref().expect("opened runtime");
                        runtime
                            .reap()
                            .map_err(|e| KernelError::Operation(e.to_string()))?;
                        if matches!(method, "runtime.child.reconcile" | "runtime.child.wait.cancel") {
                            runtime.quiesce_child_waits().map_err(|e| KernelError::Operation(e.to_string()))?;
                        }
                        if method == "runtime.child.cancel" {
                            let p: NativeOperationParams = serde_json::from_value(params.clone())?;
                            let child = runtime.catalog().lock().map_err(|_| KernelError::Storage("native catalog owner failed".into()))?.child_task(&p.operation_id).map_err(domain)?;
                            runtime.catalog().lock().map_err(|_| KernelError::Storage("native catalog owner failed".into()))?.cancel_child(&p.operation_id).map_err(domain)?;
                            if let Some(receipt) = child.receipt { runtime.cancel(&receipt.run_id).map_err(|e| KernelError::Operation(e.to_string()))?; }
                            let catalog=runtime.catalog();let mut catalog=catalog.lock().map_err(|_| KernelError::Storage("native catalog owner failed".into()))?;
                            catalog.reconcile_child_reports().map_err(domain)?;
                            return Ok(serde_json::to_value(catalog.child_task(&p.operation_id).map_err(domain)?)?);
                        }
                        if method == "runtime.input.enqueue" {
                            let p: NativeInputEnqueueParams = serde_json::from_value(params)?;
                            if runtime.catalog().lock().map_err(|_| KernelError::Storage("native catalog owner failed".into()))?.child_task_for_thread(&p.thread_id).map_err(domain)?.is_some() {
                                return Err(KernelError::Protocol("read-only delegated Threads accept only their admitted child task".into()));
                            }
                            if let Some(configuration) = p.configuration.as_ref() {
                                validate_configuration(configuration)?;
                            }
                            let receipt = {
                                let catalog = runtime.catalog();
                                let mut catalog = catalog.lock().map_err(|_| {
                                    KernelError::Storage("native catalog owner failed".into())
                                })?;
                                catalog
                                    .enqueue_input(&varin_runtime::catalog::inputs::EnqueueInput {
                                        key: p.key,
                                        thread_id: p.thread_id,
                                        branch_id: p.branch_id,
                                        mode: p.mode,
                                        input: p.input,
                                        configuration: p.configuration,
                                    })
                                    .map_err(domain)?
                            };
                            if receipt.mode == varin_runtime::InputMode::Interrupt {
                                runtime.interrupt_generation(&receipt.run_id);
                            }
                            return Ok(serde_json::to_value(receipt)?);
                        }
                        if method == "runtime.input.cancel" {
                            let p: NativeInputCancelParams = serde_json::from_value(params)?;
                            let revision = u64::try_from(p.expected_revision).map_err(|_| {
                                KernelError::Protocol("input revision must be nonnegative".into())
                            })?;
                            let input = {
                                let catalog = runtime.catalog();
                                let mut catalog = catalog.lock().map_err(|_| {
                                    KernelError::Storage("native catalog owner failed".into())
                                })?;
                                catalog
                                    .cancel_queued_input(&p.input_id, revision)
                                    .map_err(domain)?
                            };
                            runtime
                                .advance_pending()
                                .map_err(|e| KernelError::Operation(e.to_string()))?;
                            return Ok(serde_json::to_value(input)?);
                        }
                        if method == "runtime.launch.policy.prepare" {
                            let p: NativePolicyPrepareParams = serde_json::from_value(params)?;
                            let identity = crate::native_collaboration::policy_identity(crate::native_questions::policy_identity(varin_runtime::execution::PolicyIdentity { name: p.identity.name, version: p.identity.version }));
                            let mut models: Vec<varin_runtime::execution::policy_model::PolicyModelCapability> =
                                p.policy_models.map(serde_json::from_value).transpose()?.unwrap_or_default();
                            // The Host selects registered models; only the kernel constructs their
                            // executable binding. Preparation performs no credential/network I/O.
                            for capability in &mut models {
                                if capability.binding.is_some() {
                                    return Err(KernelError::Protocol("policy model binding is constructed by the native owner".into()));
                                }
                                if capability.status == varin_runtime::execution::policy_model::PolicyModelStatus::Available {
                                    capability.binding = Some(bind_policy_model(&p.run_id, capability, &credential_bridge)?.binding);
                                }
                            }
                            let result = runtime.catalog().lock().map_err(|_| KernelError::Storage("native catalog owner failed".into()))?
                                .prepare_policy_launch_with_models(&p.run_id, identity, models).map_err(domain)?;
                            return Ok(serde_json::to_value(result)?);
                        }
                        if method == "runtime.launch.mcp.prepare" {
                            let p: NativeMcpPrepareParams = serde_json::from_value(params)?;
                            let binding = native_mcp_binding(p.binding)?;
                            let result = runtime.catalog().lock().map_err(|_| KernelError::Storage("native catalog owner failed".into()))?
                                .prepare_mcp_launch(&p.run_id, binding).map_err(domain)?;
                            return Ok(serde_json::to_value(result)?);
                        }
                        if matches!(method, "runtime.run.start" | "runtime.launch.select") {
                            let selected: Option<NativeLaunchSelectParams> =
                                if method == "runtime.launch.select" {
                                    Some(serde_json::from_value(params.clone())?)
                                } else {
                                    None
                                };
                            let p: NativeRunStartParams = if let Some(selected) = &selected {
                                NativeRunStartParams {
                                    run_id: selected.run_id.clone(),
                                    credential_scope: selected.credential_scope.clone(),
                                    tool_binding: None,
                                    mcp_binding: None,
                                    policy_binding: None,
                                }
                            } else {
                                serde_json::from_value(params)?
                            };
                            let run = {
                                let catalog = runtime.catalog();
                                let catalog = catalog.lock().map_err(|_| {
                                    KernelError::Storage("native catalog owner failed".into())
                                })?;
                                catalog.run(&p.run_id).map_err(domain)?
                            };
                            let is_context_job = run.configuration.get("context_job").is_some();
                            let is_child = runtime.catalog().lock().map_err(|_| KernelError::Storage("native catalog owner failed".into()))?
                                .require_child_launch(&run.id).map_err(domain)?.is_some();
                            if is_child && (p.mcp_binding.is_some() || p.policy_binding.is_some()) { return Err(KernelError::Authorization("read-only child cannot expand its admitted capabilities".into())); }
                            if is_context_job && (selected.is_some() || p.tool_binding.is_some() || p.mcp_binding.is_some() || p.policy_binding.is_some()) {
                                return Err(KernelError::Protocol(
                                    "context jobs use their fixed tool-free launch".into(),
                                ));
                            }
                            let mut configuration = run.configuration.clone();
                            if is_context_job {
                                configuration
                                    .as_object_mut()
                                    .ok_or_else(|| {
                                        KernelError::Protocol(
                                            "model configuration must be an object".into(),
                                        )
                                    })?
                                    .remove("context_job");
                            }
                            let configuration = serde_json::from_value(configuration)?;
                            let mut selected_credential_scope = None;
                            let mut start = if let Some(scope) = p.credential_scope {
                                let scope = varin_runtime::providers::auth::CredentialScope {
                                    reference: scope.reference,
                                    authority: scope.authority,
                                    account: scope.account,
                                    generation: scope.generation.try_into().map_err(|_| {
                                        KernelError::Protocol(
                                            "credential generation must be nonnegative".into(),
                                        )
                                    })?,
                                };
                                selected_credential_scope = Some(scope.clone());
                                let resolver = credential_bridge
                                    .resolver(&p.run_id, scope.clone())
                                    .map_err(|_| {
                                        KernelError::Authorization(
                                            "private Host credential owner unavailable".into(),
                                        )
                                    })?;
                                model_session::bind_with_credentials(configuration, resolver, scope)
                            } else {
                                model_session::bind(configuration)
                            }
                            .map_err(|e| KernelError::Operation(e.to_string()))?;
                            if is_context_job {
                                start =
                                    varin_runtime::context_job::configure_compaction_start(start);
                            }
                            if let Some(binding) = p.policy_binding {
                                start.policy = policy_bridge.policy(p.run_id.clone(), binding.reference,
                                    varin_runtime::execution::PolicyIdentity { name: binding.identity.name, version: binding.identity.version })
                                    .map_err(|error| KernelError::Authorization(error.to_string()))?;
                            }
                            if !is_context_job {
                                // Context ownership is independent of the selected tool profile.
                                // Read-only children synchronize their own admitted notes without gaining memory tools.
                                start = crate::native_memory::configure_context(start, runtime.catalog(), memory_bridge.clone());
                            }
                            if !is_context_job && !is_child {
                                start = crate::native_questions::configure(start, runtime.catalog());
                                start = crate::native_collaboration::configure(start, runtime.catalog());
                            }
                            if let Some(selected) = selected {
                                let kinds: std::collections::BTreeSet<
                                    crate::native_tools::NativeToolKind,
                                > = selected
                                    .enabled_tools
                                    .into_iter()
                                    .map(|kind| serde_json::from_value(Value::String(kind)))
                                    .collect::<std::result::Result<_, _>>()?;
                                start.binding.tools =
                                    crate::native_tools::NativeToolExecutor::selected_schemas(
                                        &kinds,
                                    );
                                if !is_child {
                                    start.binding.tools.push(crate::native_questions::schema());
                                    start.binding.tools = crate::native_collaboration::schemas(start.binding.tools, selected.source.0.as_ref().is_some_and(|source| source.mode == varin_runtime::SourceMode::FixedBranch));
                                    start.binding.tools.push(crate::native_memory::schema(true));
                                }
                                start.binding.tool_schema_generation =
                                    start.binding.configuration_generation;
                                let source = selected
                                    .source
                                    .0
                                    .map(|source| {
                                        Ok::<_, KernelError>(
                                            varin_runtime::catalog::launches::SourceSelection {
                                                environment_run_id: source.environment_run_id,
                                                mode: source.mode,
                                                live_root: source.live_root.and_then(|root| root.0).map(|root|
                                                    varin_runtime::catalog::launches::LiveRoot {
                                                        host_id: root.host_id, canonical_root: root.canonical_root, root_id: root.root_id,
                                                    }),
                                                workspace_id: source.workspace_id,
                                                execution_workspace_id: source
                                                    .execution_workspace_id,
                                                branch_id: source.branch_id.0,
                                                revision: source
                                                    .revision
                                                    .0
                                                    .map(u64::try_from)
                                                    .transpose()
                                                    .map_err(|_| {
                                                        KernelError::Protocol(
                                                            "source revision must be nonnegative"
                                                                .into(),
                                                        )
                                                    })?,
                                            },
                                        )
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
                                let mut selection =
                                    varin_runtime::catalog::launches::LaunchSelection::from_binding(
                                        &start.binding,
                                        start.policy.identity(),
                                        source,
                                    );
                                selection.credential_scope = selected_credential_scope;
                                let intent = runtime
                                    .catalog()
                                    .lock()
                                    .map_err(|_| {
                                        KernelError::Storage("native catalog owner failed".into())
                                    })?
                                    .select_launch(&p.run_id, selection)
                                    .map_err(domain)?;
                                return Ok(serde_json::to_value(intent)?);
                            }
                            let mut launch_source = None;
                            if let Some(binding) = p.tool_binding {
                                let binding: crate::native_tools::NativeToolBinding =
                                    serde_json::from_value(binding)?;
                                if binding.run_id != p.run_id || binding.thread_id != run.thread_id
                                {
                                    return Err(KernelError::Authorization(
                                        "tool binding does not belong to the admitted Run".into(),
                                    ));
                                }
                                launch_source = Some(binding.source_selection()?);
                                let retrieval_project_id = runtime.catalog().lock()
                                    .map_err(|_| KernelError::Storage("native catalog owner failed".into()))?
                                    .run_project_id(&p.run_id).map_err(domain)?;
                                let collaboration_binding = binding.clone();
                                let tools = crate::native_tools::NativeToolExecutor::new(
                                    binding,
                                    resources.clone(),
                                )
                                .map_err(|e| KernelError::Authorization(e.to_string()))?
                                .with_language(language_bridge.clone())
                                .with_retrieval(retrieval_bridge.clone(), retrieval_project_id);
                                start.binding.tools = tools.schemas();
                                start.binding.tool_schema_generation =
                                    start.binding.configuration_generation;
                                start.tools = Arc::new(tools);
                                // The source executor replaced the initial built-ins; keep the existing policy wrapper.
                                if !is_child {
                                    start.tools = crate::native_questions::wrap_tools(start.tools, runtime.catalog());
                                    start.binding.tools.push(crate::native_questions::schema());
                                    start.binding.tools = crate::native_collaboration::schemas(start.binding.tools, collaboration_binding.source_mode == varin_runtime::SourceMode::FixedBranch);
                                    start.tools = crate::native_collaboration::wrap_tools(start.tools, runtime.catalog(), Some(collaboration_binding), resources.clone());
                                }
                            }
                            if launch_source.is_none() && !is_context_job && !is_child {
                                start.binding.tools = crate::native_collaboration::schemas(start.binding.tools, false);
                                start.tools = crate::native_collaboration::wrap_tools(start.tools, runtime.catalog(), None, resources.clone());
                            }
                            if !is_context_job && !is_child {
                                start = crate::native_memory::configure(start, runtime.catalog(), memory_bridge.clone(), true);
                            }
                            let mcp_binding = p.mcp_binding.map(native_mcp_binding).transpose()?;
                            if let Some(binding) = &mcp_binding {
                                binding.validate().map_err(domain)?;
                                if binding.tools.iter().any(|tool| start.binding.tools.iter().any(|existing| existing.name == tool.name)) {
                                    return Err(KernelError::Protocol("MCP tool collides with another selected capability".into()));
                                }
                                start.binding.tools.extend(binding.tools.iter().cloned());
                                start.tools = mcp_bridge.wrap(p.run_id.clone(), binding.clone(), start.tools)
                                    .map_err(|error| KernelError::Authorization(error.to_string()))?;
                            }
                            let policy_models = runtime.catalog().lock()
                                .map_err(|_| KernelError::Storage("native catalog owner failed".into()))?
                                .launch_intent(&p.run_id).map_err(domain)?
                                .map(|launch| launch.selection.policy_models).unwrap_or_default();
                            if is_context_job && !policy_models.is_empty() {
                                return Err(KernelError::Protocol("context jobs cannot acquire planning capabilities".into()));
                            }
                            if !policy_models.is_empty() {
                                use varin_runtime::execution::policy_model::{BoundPolicyModel, PolicyModelStatus, WithPolicyModels};
                                let mut models = std::collections::BTreeMap::new();
                                for capability in &policy_models {
                                    if capability.status != PolicyModelStatus::Available { continue; }
                                    let bound = bind_policy_model(&p.run_id, capability, &credential_bridge)?;
                                    if capability.binding.as_ref() != Some(&bound.binding) {
                                        return Err(KernelError::Authorization("planning model differs from its admitted binding".into()));
                                    }
                                    if models.insert(capability.capability_id.clone(), BoundPolicyModel {
                                        capability: capability.clone(), provider: bound.provider,
                                    }).is_some() {
                                        return Err(KernelError::Protocol("duplicate planning capability identity".into()));
                                    }
                                }
                                start.provider = Arc::new(WithPolicyModels {
                                    primary: start.provider, capabilities: policy_models.clone(), models,
                                });
                            }
                            {
                                let mut selection =
                                    varin_runtime::catalog::launches::LaunchSelection::from_binding(
                                        &start.binding,
                                        start.policy.identity(),
                                        launch_source,
                                    );
                                selection.mcp_binding = mcp_binding;
                                selection.credential_scope = selected_credential_scope;
                                selection.policy_models = policy_models;
                                runtime
                                    .catalog()
                                    .lock()
                                    .map_err(|_| {
                                        KernelError::Storage("native catalog owner failed".into())
                                    })?
                                    .bind_launch(&p.run_id, selection)
                                    .map_err(domain)?;
                            }
                            let (progress, updates) =
                                varin_runtime::execution::ProgressSink::channel(64);
                            start.progress = progress;
                            let progress_responses = responses.clone();
                            let progress_epoch = epoch.clone();
                            let progress_stream_id = uuid::Uuid::new_v4().to_string();
                            thread::spawn(move || {
                                for update in updates {
                                    let event = json!({"v":PROTOCOL_VERSION,"kind":"runtime-event","kernelEpoch":progress_epoch,"stream":"progress","runId":update.run_id,"streamId":progress_stream_id,"sequence":update.sequence,"event":update.event});
                                    // Progress is already lossy; never let a large tool projection kill
                                    // the shared writer. Durable history retains its chunked read path.
                                    if progress_frame_fits(&event, crate::protocol::MAX_FRAME_BYTES) {
                                        let _ = progress_responses.try_send(event);
                                    }
                                }
                            });
                            let handle = runtime
                                .start(&p.run_id, start)
                                .map_err(|e| KernelError::Operation(e.to_string()))?;
                            let receipt = json!({"runId":handle.run_id,"epoch":handle.epoch});
                            let completion_responses = responses.clone();
                            let completion_epoch = epoch.clone();
                            let completion_run = handle.run_id.clone();
                            let completion_catalog = runtime.catalog();
                            thread::spawn(move || {
                                let _ = handle.wait();
                                let terminal = completion_catalog.lock().ok().and_then(|catalog| catalog.run(&completion_run).ok())
                                    .is_some_and(|run| run.state.terminal());
                                if terminal {
                                    let _ = completion_responses.send(json!({"v":1,"kind":"agent-policy-release","kernelEpoch":completion_epoch,"runId":completion_run}));
                                    let _ = completion_responses.send(json!({"v":1,"kind":"mcp-owner-release",
                                        "kernelEpoch":completion_epoch,"runId":completion_run}));
                                }
                            });
                            return Ok(receipt);
                        }
                        if method == "runtime.history.body" {
                            let p: NativeHistoryBodyParams = serde_json::from_value(params)?;
                            let chunk_index = usize::try_from(p.chunk_index).map_err(|_| {
                                KernelError::Protocol(
                                    "content chunk index must be nonnegative".into(),
                                )
                            })?;
                            let read = runtime
                                .catalog()
                                .lock()
                                .map_err(|_| {
                                    KernelError::Storage("native catalog owner failed".into())
                                })?
                                .history_body_reader(&p.item_id)
                                .map_err(domain)?;
                            let response_id = id.clone();
                            let response_sender = responses.clone();
                            let done = finished.clone();
                            let cancelled = cancellation.clone();
                            content_tasks.send(Box::new(move || {
                                let result=(||->Result<Value,KernelError>{
                                    if cancelled.load(Ordering::Acquire){return Err(KernelError::Cancelled);}
                                    let chunk=read.chunk(chunk_index).map_err(domain)?;
                                    Ok(json!({"itemId":p.item_id,"contentRef":chunk.content_ref,"chunkIndex":chunk.chunk_index,"chunkCount":chunk.chunk_count,"totalBytes":chunk.total_bytes,"bytesBase64":base64::engine::general_purpose::STANDARD.encode(chunk.bytes)}))
                                })();
                                let response=match result {Ok(value)=>response_ok(&response_id,value),Err(error)=>response_error(&response_id,&error)};
                                done(&response_id);let _=response_sender.send(response);
                            })).map_err(|_|KernelError::Storage("native content reader unavailable".into()))?;
                            deferred = true;
                            return Ok(Value::Null);
                        }
                        if method == "runtime.memory.reconcile" {
                            let p: NativeRunParams = serde_json::from_value(params)?;
                            crate::native_memory::reconcile(runtime.clone(), memory_bridge.clone(), p.run_id, id.clone(), responses.clone(), finished.clone())?;
                            deferred = true;
                            return Ok(Value::Null);
                        }
                        if method == "runtime.run.reconcile" {
                            let p: NativeRunReconcileParams = serde_json::from_value(params)?;
                            let binding: crate::native_tools::NativeToolBinding =
                                serde_json::from_value(p.tool_binding)?;
                            let operations = {
                                let catalog = runtime.catalog();
                                let catalog = catalog.lock().map_err(|_| {
                                    KernelError::Storage("native catalog owner failed".into())
                                })?;
                                let run = catalog.run(&p.run_id).map_err(domain)?;
                                if binding.run_id != run.id || binding.thread_id != run.thread_id {
                                    return Err(KernelError::Authorization(
                                        "reconciliation binding belongs to another Run".into(),
                                    ));
                                }
                                let launch = catalog.launch_intent(&run.id).map_err(domain)?
                                    .ok_or_else(|| KernelError::Authorization("reconciliation requires a durable source selection".into()))?;
                                if launch.selection.source.as_ref() != Some(&binding.source_selection()?) {
                                    return Err(KernelError::Authorization("reconciliation cannot change the durable source selection".into()));
                                }
                                catalog
                                    .pending_run_operations(&run.id)
                                    .map_err(domain)?
                                    .into_iter()
                                    .filter(|operation| {
                                        matches!(
                                            operation.executor.as_deref(),
                                            Some("native_file_write" | "native_file_edit")
                                        )
                                    })
                                    .collect::<Vec<_>>()
                            };
                            if operations.is_empty() {
                                return Ok(json!({"reconciled":[],"unresolved":[]}));
                            }
                            crate::native_reconcile::reconcile(
                                runtime.clone(),
                                resources.clone(),
                                binding,
                                operations,
                                id.clone(),
                                responses.clone(),
                                finished.clone(),
                            )?;
                            deferred = true;
                            return Ok(Value::Null);
                        }
                        if method == "runtime.launch.fail" {
                            let p: NativeLaunchFailedParams = serde_json::from_value(params)?;
                            if runtime
                                .status()
                                .map_err(|e| KernelError::Operation(e.to_string()))?
                                .iter()
                                .any(|worker| worker.run_id == p.run_id && !worker.finished)
                            {
                                return Err(KernelError::Operation(
                                    "Run already has a live worker".into(),
                                ));
                            }
                            return Ok(serde_json::to_value(
                                runtime
                                    .catalog()
                                    .lock()
                                    .map_err(|_| {
                                        KernelError::Storage("native catalog owner failed".into())
                                    })?
                                    .fail_launch(&p.run_id, &p.code)
                                    .map_err(domain)?,
                            )?);
                        }
                        if matches!(method, "runtime.permission.open" | "runtime.permission.consume") {
                            let p: NativePermissionOpenParams = serde_json::from_value(params)?;
                            let catalog = runtime.catalog();
                            let mut db = catalog.lock().map_err(|_| KernelError::Storage("native catalog owner failed".into()))?;
                            let result = if method == "runtime.permission.open" {
                                db.open_permission(&p.operation_id, &p.permission_id, p.call, p.scope)
                            } else {
                                db.consume_permission(&p.operation_id, &p.permission_id, p.call, p.scope)
                            }.map_err(domain)?;
                            return Ok(serde_json::to_value(result)?);
                        }
                        if method == "runtime.permission.decide" {
                            let p: NativePermissionDecideParams = serde_json::from_value(params)?;
                            let result = runtime.catalog().lock().map_err(|_| KernelError::Storage("native catalog owner failed".into()))?
                                .decide_permission(&p.operation_id, &p.permission_id, &p.decision).map_err(domain)?;
                            return Ok(serde_json::to_value(result)?);
                        }
                        if method == "runtime.question.answer" {
                            let p: NativeQuestionAnswerParams = serde_json::from_value(params)?;
                            runtime.quiesce_question(&p.operation_id).map_err(|e| KernelError::Operation(e.to_string()))?;
                            let result = runtime.catalog().lock().map_err(|_| KernelError::Storage("native catalog owner failed".into()))?
                                .answer_question(&p.operation_id, &p.answer).map_err(domain)?;
                            return Ok(serde_json::to_value(result)?);
                        }
                        if method == "runtime.run.cancel" {
                            let p: NativeRunParams = serde_json::from_value(params)?;
                            let waiting = runtime.catalog().lock().map_err(|_| KernelError::Storage("native catalog owner failed".into()))?
                                .run(&p.run_id).map_err(domain)?.waiting_on;
                            if waiting.as_deref().is_some_and(|id|id.starts_with("child-wait:")) {runtime.quiesce_child_waits().map_err(|e|KernelError::Operation(e.to_string()))?;}
                            if let Some(operation_id) = waiting.as_deref().and_then(|id| id.strip_prefix("question:")) {
                                runtime.quiesce_question(operation_id).map_err(|e| KernelError::Operation(e.to_string()))?;
                            }
                            return Ok(serde_json::to_value(
                                runtime
                                    .cancel(&p.run_id)
                                    .map_err(|e| KernelError::Operation(e.to_string()))?,
                            )?);
                        }
                        if method == "runtime.operation.cancel" {
                            let p: NativeOperationParams = serde_json::from_value(params)?;
                            if runtime.catalog().lock().map_err(|_| KernelError::Storage("native catalog owner failed".into()))?
                                .operation(&p.operation_id).map_err(domain)?.executor.as_deref() == Some("native_ask_user") {
                                runtime.quiesce_question(&p.operation_id).map_err(|e| KernelError::Operation(e.to_string()))?;
                                let operation = runtime.catalog().lock().map_err(|_| KernelError::Storage("native catalog owner failed".into()))?
                                    .cancel_question(&p.operation_id).map_err(domain)?;
                                return Ok(serde_json::to_value(operation)?);
                            }
                            let operation = runtime
                                .cancel_operation(&p.operation_id)
                                .map_err(|e| KernelError::Operation(e.to_string()))?;
                            if operation.cancel_requested
                                && operation.executor.as_deref() == Some("native_process_spawn")
                            {
                                let known = resources.cancel_known_process(&operation.id)?;
                                if !known
                                    && matches!(
                                        operation.phase,
                                        varin_runtime::OperationPhase::Running
                                            | varin_runtime::OperationPhase::Settling
                                    )
                                    && matches!(
                                        operation.effect,
                                        varin_runtime::Effect::Dispatched
                                            | varin_runtime::Effect::Partial
                                            | varin_runtime::Effect::Unknown
                                    )
                                {
                                    resources.cancel_process(&operation.id, &operation.run_id)?;
                                }
                            }
                            return Ok(serde_json::to_value(operation)?);
                        }
                        let catalog = runtime.catalog();
                        let mut catalog = catalog.lock().map_err(|_| {
                            KernelError::Storage("native catalog owner failed".into())
                        })?;
                        dispatch(&mut catalog, method, params)
                    })();
                    if deferred {
                        continue;
                    }
                    let response = match result {
                        Ok(result) => response_ok(&id, result),
                        Err(error) => response_error(&id, &error),
                    };
                    finished(&id);
                    if responses.send(response).is_err() {
                        break;
                    }
                }
            }
        }
        if let Some(runtime) = runtime {
            let _ = runtime.shutdown();
        }
        if let Ok(mut control) = control.0.lock() {
            *control = None;
        }
    })
}
fn native_mcp_binding(binding: NativeMcpBinding) -> Result<crate::native_mcp::McpBinding, KernelError> {
    Ok(crate::native_mcp::McpBinding {
        reference: binding.reference,
        generation: u64::try_from(binding.generation).map_err(|_| KernelError::Protocol("MCP generation must be nonnegative".into()))?,
        resources: binding.resources,
        tools: binding.tools.into_iter().map(|tool| varin_runtime::execution::ToolSchema {
            name: tool.name, version: tool.version, schema: tool.schema,
        }).collect(),
    })
}
fn dispatch(catalog: &mut Catalog, method: &str, params: Value) -> Result<Value, KernelError> {
    if method == "runtime.branch.fork" {
        let p: NativeBranchForkParams = serde_json::from_value(params)?;
        catalog
            .fork_branch(&p.source_branch_id, &p.branch_id, p.head_id.0.as_deref())
            .map_err(domain)?;
        let thread_id = catalog.branch_thread_id(&p.branch_id).map_err(domain)?;
        return Ok(json!({"threadId":thread_id,"branchId":p.branch_id}));
    }
    if method == "runtime.context_job.list" {
        let p: NativeHistoryParams = serde_json::from_value(params)?;
        return Ok(serde_json::to_value(
            catalog.context_jobs(&p.branch_id).map_err(domain)?,
        )?);
    }
    if method == "runtime.context.refresh" {
        let p: NativeContextRefreshParams = serde_json::from_value(params)?;
        let basis = p.context.personalization.ok_or_else(|| KernelError::Protocol("personalization basis is required".into()))?;
        return Ok(serde_json::to_value(catalog.refresh_personalization(
            &p.branch_id,
            u64::try_from(p.expected_revision).map_err(|_| KernelError::Protocol("context revision must be nonnegative".into()))?,
            p.context.effective_system_prompt, p.context.instruction_sources, p.context.memory_checkpoint.0,
            native_personalization_basis(basis)?,
        ).map_err(domain)?)?);
    }
    if method == "runtime.context.inspect" {
        let p: NativeHistoryParams = serde_json::from_value(params)?;
        catalog.head(&p.branch_id).map_err(domain)?;
        return Ok(serde_json::to_value(
            catalog.active_context(&p.branch_id).map_err(domain)?,
        )?);
    }
    if method == "runtime.context_job.inspect" || method == "runtime.context_job.publish" {
        let p: NativeRunParams = serde_json::from_value(params)?;
        return if method == "runtime.context_job.publish" {
            Ok(serde_json::to_value(
                catalog.publish_context_job(&p.run_id).map_err(domain)?,
            )?)
        } else {
            Ok(serde_json::to_value(
                catalog.context_job(&p.run_id).map_err(domain)?,
            )?)
        };
    }
    if method == "runtime.context_job.create" {
        let p: NativeContextJobCreateParams = serde_json::from_value(params)?;
        let configuration: varin_runtime::ModelSessionConfiguration =
            serde_json::from_value(p.configuration.clone())?;
        let scope = p
            .credential_scope
            .map(|scope| {
                Ok::<_, KernelError>(varin_runtime::providers::auth::CredentialScope {
                    reference: scope.reference,
                    authority: scope.authority,
                    account: scope.account,
                    generation: u64::try_from(scope.generation).map_err(|_| {
                        KernelError::Protocol("credential generation must be nonnegative".into())
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
        let launch = varin_runtime::catalog::launches::LaunchSelection {
            policy_models: Vec::new(),
            mcp_binding: None,
            credential_scope: scope,
            connection_identity: identity,
            provider_family: configuration.provider_family,
            model: configuration.model,
            configuration_generation: configuration.configuration_generation,
            tool_schema_generation: 0,
            tools: Vec::new(),
            policy: varin_runtime::context_job::policy_identity(),
            source: None,
        };
        let request = varin_runtime::catalog::context_jobs::ContextJobRequest {
            personalization: p.personalization.map(native_personalization_basis).transpose()?,
            key: p.key,
            branch_id: p.branch_id,
            through_id: p.through_id,
            expected_revision: u64::try_from(p.expected_revision).map_err(|_| {
                KernelError::Protocol("context revision must be nonnegative".into())
            })?,
            effective_system_prompt: p.effective_system_prompt,
            instruction_sources: p.instruction_sources,
            memory_checkpoint: p.memory_checkpoint.0,
        };
        return Ok(serde_json::to_value(
            catalog
                .create_context_job(request, launch, p.configuration)
                .map_err(domain)?,
        )?);
    }
    if method == "runtime.history.page" {
        let p: NativeHistoryPageParams = serde_json::from_value(params)?;
        let limit = u32::try_from(p.limit)
            .map_err(|_| KernelError::Protocol("history page limit out of range".into()))?;
        return Ok(serde_json::to_value(
            catalog
                .history_page(
                    &p.branch_id,
                    p.head_id.as_deref(),
                    p.before_id.as_deref(),
                    limit,
                )
                .map_err(domain)?,
        )?);
    }
    if method == "runtime.thread.operations.active" {
        let p: NativeThreadParams = serde_json::from_value(params)?;
        return Ok(serde_json::to_value(
            catalog
                .active_thread_operations(&p.thread_id)
                .map_err(domain)?,
        )?);
    }
    if method == "runtime.thread.inspect" {
        let p: NativeThreadParams = serde_json::from_value(params)?;
        return catalog.inspect_thread(&p.thread_id).map_err(domain);
    }
    if method == "runtime.thread.list" {
        return Ok(serde_json::to_value(
            catalog.list_threads().map_err(domain)?,
        )?);
    }
    if method == "runtime.launch.inspect" {
        let p: NativeRunParams = serde_json::from_value(params)?;
        return Ok(serde_json::to_value(
            catalog.launch_intent(&p.run_id).map_err(domain)?,
        )?);
    }
    if method == "runtime.launch.list" {
        return Ok(serde_json::to_value(
            catalog.pending_launches().map_err(domain)?,
        )?);
    }

    match method {
        "runtime.child.report.read" => {let p:NativeChildReportReadParams=serde_json::from_value(params)?;
            let offset=usize::try_from(p.offset.unwrap_or(0)).map_err(|_|KernelError::Protocol("invalid offset".into()))?;
            let max=usize::try_from(p.max_bytes.unwrap_or(65536)).map_err(|_|KernelError::Protocol("invalid maxBytes".into()))?;
            Ok(serde_json::to_value(catalog.read_child_report(&p.operation_id,&p.item_id,offset,max).map_err(domain)?)?)},
        "runtime.child.sources.pending" => Ok(serde_json::to_value(catalog.unaccepted_child_sources().map_err(domain)?)?),
        "runtime.child.sources.release" => {let p:NativeOperationParams=serde_json::from_value(params)?;catalog.mark_unaccepted_child_source_released(&p.operation_id).map_err(domain)?;Ok(json!({}))},
        "runtime.child.list" => Ok(serde_json::to_value(catalog.child_tasks().map_err(domain)?)?),
        "runtime.child.for_thread" => { let p: NativeThreadParams = serde_json::from_value(params)?; Ok(serde_json::to_value(catalog.child_task_for_thread(&p.thread_id).map_err(domain)?)?) },
        "runtime.child.inspect" | "runtime.child.cancel" | "runtime.child.release" => {
            let p: NativeOperationParams = serde_json::from_value(params)?;
            let child = match method { "runtime.child.cancel" => catalog.cancel_child(&p.operation_id), "runtime.child.release" => catalog.mark_child_resources_released(&p.operation_id), _ => catalog.child_task(&p.operation_id) }.map_err(domain)?;
            Ok(serde_json::to_value(child)?)
        }
        "runtime.child.fail" => {
            let p: NativeChildFailParams = serde_json::from_value(params)?;
            if !["preparation_failed","source_unavailable","credentials_unavailable","binding_changed"].contains(&p.code.as_str()) {return Err(KernelError::Protocol("unknown child preparation failure".into()));}
            Ok(serde_json::to_value(catalog.fail_child_preparation(&p.operation_id,&p.code).map_err(domain)?)?)
        }
        "runtime.child.prepare" => {
            let p: NativeChildPrepareParams = serde_json::from_value(params)?;
            let child=catalog.child_task(&p.operation_id).map_err(domain)?;
            let source=varin_runtime::catalog::launches::SourceSelection {environment_run_id:p.source.environment_run_id,mode:p.source.mode,
                live_root:p.source.live_root.and_then(|root|root.0).map(|root|varin_runtime::catalog::launches::LiveRoot{host_id:root.host_id,canonical_root:root.canonical_root,root_id:root.root_id}),
                workspace_id:p.source.workspace_id,execution_workspace_id:p.source.execution_workspace_id,branch_id:p.source.branch_id.0,
                revision:p.source.revision.0.map(u64::try_from).transpose().map_err(|_|KernelError::Protocol("source revision must be nonnegative".into()))?};
            let basis=native_personalization_basis(p.context.personalization.ok_or_else(||KernelError::Protocol("child context requires admitted scope".into()))?)?;
            let proposal=varin_runtime::catalog::context::ContextProposal {key:format!("initial-child-context:{}",p.operation_id),branch_id:child.child_branch_id,
                through_id:None,expected_revision:0,summary:String::new(),effective_system_prompt:p.context.effective_system_prompt,
                instruction_sources:p.context.instruction_sources,memory_checkpoint:p.context.memory_checkpoint.0};
            Ok(serde_json::to_value(catalog.prepare_child(&p.operation_id,source,proposal,basis).map_err(domain)?)?)
        }
        "runtime.child.reconcile" => Ok(serde_json::to_value(catalog.deliver_child_waits().map_err(domain)?)?),
        "runtime.child.wait.cancel" => {let p:NativeChildWaitParams=serde_json::from_value(params)?;Ok(serde_json::to_value(catalog.cancel_child_wait(&p.wait_id).map_err(domain)?)?)},
        "runtime.status" => Ok(json!({"epoch":catalog.epoch(),"eventCursor":catalog.event_cursor().map_err(domain)?,"admission":catalog.resource_admission().summary()})),
        "runtime.admission.inspect" => {
            let p: NativeAdmissionInspectParams = serde_json::from_value(params)?;
            let epoch = u64::try_from(p.owner_generation).map_err(|_| KernelError::Protocol("ownerGeneration must be nonnegative".into()))?;
            let origin = match (p.request_id, p.action_id, p.node_id) {
                (Some(request_id), None, None) => varin_runtime::execution::ToolOrigin::ModelStep { request_id },
                (None, Some(action_id), Some(node_id)) => varin_runtime::execution::ToolOrigin::PolicyAction { action_id, node_id },
                _ => return Err(KernelError::Protocol("specify a model request or a policy action and node".into())),
            };
            let result = catalog.inspect_admission(&p.run_id, epoch, &origin, &p.call_id).map_err(domain)?;
            if serde_json::to_vec(&result)?.len() > crate::protocol::MAX_FRAME_BYTES / 2 {
                return Err(KernelError::Protocol("admission identity exceeds the protocol response budget".into()));
            }
            Ok(result)
        }
        "runtime.thread.create" => {
            let p: NativeThreadCreateParams = serde_json::from_value(params)?;
            if p.thread_id.trim().is_empty() || p.branch_id.trim().is_empty() {
                return Err(KernelError::Protocol(
                    "thread and branch identities cannot be empty".into(),
                ));
            }
            catalog
                .create_thread(&p.thread_id, &p.branch_id)
                .map_err(domain)?;
            Ok(json!({"threadId":p.thread_id,"branchId":p.branch_id}))
        }
        "runtime.input.submit" => {
            let p: NativeInputSubmitParams = serde_json::from_value(params)?;
            if catalog.child_task_for_thread(&p.thread_id).map_err(domain)?.is_some() {
                return Err(KernelError::Protocol("read-only delegated Threads accept only their admitted child task".into()));
            }
            validate_configuration(&p.configuration)?;
            if p.key.trim().is_empty() {
                return Err(KernelError::Protocol(
                    "input idempotency key cannot be empty".into(),
                ));
            }
            let inherit_source = p.launch.as_ref().and_then(|launch| launch.inherit_source).unwrap_or(false);
            let launch = p
                .launch
                .map(|selected| {
                    let configuration: varin_runtime::ModelSessionConfiguration =
                        serde_json::from_value(p.configuration.clone())?;
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
                    let kinds: std::collections::BTreeSet<crate::native_tools::NativeToolKind> =
                        selected
                            .enabled_tools
                            .into_iter()
                            .map(|kind| serde_json::from_value(Value::String(kind)))
                            .collect::<std::result::Result<_, _>>()?;
                    let source = selected
                        .source
                        .0
                        .map(|source| {
                            Ok::<_, KernelError>(
                                varin_runtime::catalog::launches::SourceSelection {
                                    environment_run_id: source.environment_run_id,
                                    mode: source.mode,
                                    live_root: source.live_root.and_then(|root| root.0).map(|root|
                                        varin_runtime::catalog::launches::LiveRoot {
                                            host_id: root.host_id, canonical_root: root.canonical_root, root_id: root.root_id,
                                        }),
                                    workspace_id: source.workspace_id,
                                    execution_workspace_id: source.execution_workspace_id,
                                    branch_id: source.branch_id.0,
                                    revision: source
                                        .revision
                                        .0
                                        .map(u64::try_from)
                                        .transpose()
                                        .map_err(|_| {
                                            KernelError::Protocol(
                                                "source revision must be nonnegative".into(),
                                            )
                                        })?,
                                },
                            )
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
                            let mut tools = crate::native_collaboration::schemas(
                                crate::native_questions::schemas(crate::native_tools::NativeToolExecutor::selected_schemas(&kinds)),
                                source.as_ref().is_some_and(|source| source.mode == varin_runtime::SourceMode::FixedBranch));
                            tools.push(crate::native_memory::schema(true));
                            tools
                        },
                        policy: crate::native_collaboration::default_policy_identity(),
                        source,
                    })
                })
                .transpose()?;
            let command = SubmitInput { key:p.key, thread_id:p.thread_id, branch_id:p.branch_id,
                expected_head:p.expected_head.0, input:p.input, configuration:p.configuration };
            let personalization = p.initial_context.as_ref().and_then(|context| context.personalization.clone())
                .map(native_personalization_basis).transpose()?;
            let initial = p.initial_context.map(|context| varin_runtime::catalog::context::ContextProposal {
                key: format!("initial-context:{}", command.branch_id), branch_id: command.branch_id.clone(),
                through_id: None, expected_revision: 0, summary: String::new(),
                effective_system_prompt: context.effective_system_prompt,
                instruction_sources: context.instruction_sources,
                memory_checkpoint: context.memory_checkpoint.0,
            });
            let receipt = catalog.submit_with_context_snapshot(&command, launch, inherit_source, initial, personalization).map_err(domain)?;
            Ok(serde_json::to_value(receipt)?)
        }
        "runtime.run.inspect" | "runtime.run.cancel" => {
            let p: NativeRunParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                if method.ends_with("cancel") {
                    catalog.request_cancel_run(&p.run_id)
                } else {
                    catalog.run(&p.run_id)
                }
                .map_err(domain)?,
            )?)
        }
        "runtime.operation.inspect" | "runtime.operation.cancel" => {
            let p: NativeOperationParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                if method.ends_with("cancel") {
                    catalog.request_cancel_operation(&p.operation_id)
                } else {
                    catalog.operation(&p.operation_id)
                }
                .map_err(domain)?,
            )?)
        }
        "runtime.input.edit" => {
            let p: NativeInputEditParams = serde_json::from_value(params)?;
            let revision = u64::try_from(p.expected_revision)
                .map_err(|_| KernelError::Protocol("input revision must be nonnegative".into()))?;
            Ok(serde_json::to_value(
                catalog
                    .edit_queued_input(&p.input_id, revision, p.content)
                    .map_err(domain)?,
            )?)
        }
        "runtime.input.inspect" => {
            let p: NativeInputHandleParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog.queued_input(&p.input_id).map_err(domain)?,
            )?)
        }
        "runtime.input.list" => {
            let p: NativeHistoryParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog.queued_inputs(&p.branch_id).map_err(domain)?,
            )?)
        }
        "runtime.history.read" => {
            let p: NativeHistoryParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog.history(&p.branch_id).map_err(domain)?,
            )?)
        }
        "runtime.observer.read" => {
            let p: NativeObserverReadParams = serde_json::from_value(params)?;
            let limit = u32::try_from(p.limit)
                .map_err(|_| KernelError::Protocol("observer event limit out of range".into()))?;
            let through_cursor = u64::try_from(p.through_cursor)
                .map_err(|_| KernelError::Protocol("observer through cursor must be nonnegative".into()))?;
            Ok(serde_json::to_value(catalog.observer_run_activity(&p.observer_id, &p.thread_id, through_cursor, limit).map_err(domain)?)?)
        }
        "runtime.observer.delivery" => {
            let p: NativeObserverDeliveryParams = serde_json::from_value(params)?;
            let cursor = u64::try_from(p.cursor)
                .map_err(|_| KernelError::Protocol("observer cursor must be nonnegative".into()))?;
            catalog.acknowledge_run_activity(&p.observer_id, &p.thread_id, cursor, p.state).map_err(domain)?;
            Ok(json!({}))
        }
        "runtime.events.read" => {
            let p: NativeEventsParams = serde_json::from_value(params)?;
            let cursor = u64::try_from(p.cursor)
                .map_err(|_| KernelError::Protocol("event cursor must be nonnegative".into()))?;
            let limit = u32::try_from(p.limit)
                .map_err(|_| KernelError::Protocol("event limit out of range".into()))?;
            Ok(serde_json::to_value(
                catalog.events_after(cursor, limit).map_err(domain)?,
            )?)
        }
        _ => Err(KernelError::Protocol(
            "unknown native runtime method".into(),
        )),
    }
}

fn apply_process_terminal(
    runtime: &RunSupervisor,
    fact: &crate::process::ProcessTerminal,
) -> Result<(), KernelError> {
    use varin_runtime::{Effect, ExternalReceipt, Outcome, RuntimeError};
    if fact.receipt.get("processId").and_then(Value::as_str) != Some(fact.process_id.as_str())
        || fact.receipt.get("kernelEpoch").and_then(Value::as_str)
            != Some(fact.kernel_epoch.as_str())
    {
        return Err(KernelError::Authorization(
            "process terminal identity mismatch".into(),
        ));
    }
    let catalog = runtime.catalog();
    let mut catalog = catalog
        .lock()
        .map_err(|_| KernelError::Storage("native catalog owner failed".into()))?;
    let operation = match catalog.operation(&fact.process_id) {
        Ok(op) => op,
        Err(RuntimeError::NotFound(_)) => return Ok(()),
        Err(error) => return Err(domain(error)),
    };
    let confirmed = fact.receipt.get("treeConfirmed").and_then(Value::as_bool) == Some(true);
    let status = fact.receipt.get("status").and_then(Value::as_str);
    let code = fact.receipt.get("exitCode").and_then(Value::as_i64);
    let outcome = if !confirmed {
        Outcome::Indeterminate
    } else if status == Some("exited") && code == Some(0) {
        Outcome::Succeeded
    } else if operation.cancel_requested
        && fact.receipt.get("stopApplied").and_then(Value::as_bool) == Some(true)
    {
        Outcome::Cancelled
    } else if status == Some("failed") {
        Outcome::Failed
    } else if status == Some("exited")
        && (code.is_some() || fact.receipt.get("signal").is_some_and(|v| !v.is_null()))
    {
        Outcome::Failed
    } else {
        Outcome::Indeterminate
    };
    catalog
        .record_external_receipt_with_stop(
            &fact.process_id,
            ExternalReceipt {
                executor: "native_process_spawn".into(),
                identity: fact.process_id.clone(),
                epoch: fact.kernel_epoch.clone(),
                outcome,
                effect: if !confirmed {
                    Effect::Unknown
                } else if fact.receipt.get("spawned").and_then(Value::as_bool) == Some(false) {
                    Effect::None
                } else {
                    Effect::Confirmed
                },
                result: fact.receipt.clone(),
            },
            confirmed,
        )
        .map_err(domain)?;
    Ok(())
}

fn bind_policy_model(
    run_id: &str,
    capability: &varin_runtime::execution::policy_model::PolicyModelCapability,
    credentials: &crate::credential_bridge::CredentialBridge,
) -> Result<model_session::BoundModel, KernelError> {
    use varin_runtime::execution::policy_model::PolicyModelStatus;
    if capability.status != PolicyModelStatus::Available
        || capability.capability_id.trim().is_empty()
        || capability.purpose != "planning"
        || capability.supported_operation != "tool_free_text"
        || capability.configuration_identity.as_deref().is_none_or(|value| value.trim().is_empty())
    {
        return Err(KernelError::Protocol("invalid available planning capability".into()));
    }
    let binding_id = capability.binding_id.as_deref().filter(|value| !value.trim().is_empty())
        .ok_or_else(|| KernelError::Protocol("planning capability requires its own credential binding".into()))?;
    let configuration = capability.configuration.clone()
        .ok_or_else(|| KernelError::Protocol("planning capability requires a frozen model configuration".into()))?;
    let scope = capability.credential_scope.clone()
        .ok_or_else(|| KernelError::Authorization("planning capability requires its selected Host credential owner".into()))?;
    let resolver = credentials.resolver_for_binding(run_id, binding_id, scope.clone())
        .map_err(|_| KernelError::Authorization("planning credential owner unavailable".into()))?;
    model_session::bind_provider_with_credentials(configuration, resolver, scope)
        .map_err(|error| KernelError::Operation(error.to_string()))
}

fn validate_configuration(configuration: &Value) -> Result<(), KernelError> {
    if configuration.get("providerFamily").is_some() {
        let model: varin_runtime::ModelSessionConfiguration =
            serde_json::from_value(configuration.clone())?;
        model_session::connection_identity(&model)
            .map_err(|e| KernelError::Protocol(e.to_string()))?;
    }
    Ok(())
}

fn native_personalization_basis(value: NativeContextPersonalization) -> Result<varin_runtime::catalog::personalization::PersonalizationBasis, KernelError> {
    Ok(varin_runtime::catalog::personalization::PersonalizationBasis {
        configuration_digest: value.configuration_digest,
        memory_snapshot: varin_runtime::catalog::memory::MemorySnapshot { revision: value.memory_snapshot.revision.try_into().map_err(|_| KernelError::Protocol("memory revision must be nonnegative".into()))?, memories: value.memory_snapshot.memories },
        mode: value.mode,
        thread_role: value.thread_role,
        revision: u64::try_from(value.revision).map_err(|_| KernelError::Protocol("personalization revision must be nonnegative".into()))?,
        context_composition: value.context_composition.map(|composition| {
            use varin_runtime::composition::context::{ContextComposition, ContextFragment, FragmentKind};
            Ok::<_, KernelError>(ContextComposition {
                provider_id: composition.provider_id, content_version: composition.content_version,
                scope_id: composition.scope_id,
                selection_revision: composition.selection_revision.try_into().map_err(|_| KernelError::Protocol("context selection revision must be nonnegative".into()))?,
                sections: composition.sections.into_iter().map(|section| Ok::<_, KernelError>(ContextFragment {
                    name: section.name, content: section.content, kind: match section.kind.as_str() {
                        "instruction" => FragmentKind::Instruction, "data" => FragmentKind::Data,
                        _ => return Err(KernelError::Protocol("invalid context fragment kind".into())),
                    },
                })).collect::<Result<_, _>>()?,
            })
        }).transpose()?,
        session_id: value.session_id, project_id: value.project_id.0,
        original_sections: value.original_sections.into_iter().map(|section| varin_runtime::catalog::personalization::SystemSection { name: section.name, content: section.content }).collect(),
        instruction_sources: value.instruction_sources,
    })
}
