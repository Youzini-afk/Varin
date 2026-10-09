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
pub(crate) fn spawn(
    commands: mpsc::Receiver<Command>,
    self_sender: mpsc::Sender<Command>,
    control: NativeControl,
    resources: crate::native_tools::NativeResourceClient,
    credential_bridge: crate::credential_bridge::CredentialBridge,
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
                            let owner =
                                Arc::new(RunSupervisor::new(Catalog::open(root).map_err(domain)?));
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
                        if method == "runtime.input.enqueue" {
                            let p: NativeInputEnqueueParams = serde_json::from_value(params)?;
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
                            if is_context_job && (selected.is_some() || p.tool_binding.is_some()) {
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
                                start.binding.tool_schema_generation =
                                    start.binding.configuration_generation;
                                let source = selected
                                    .source
                                    .0
                                    .map(|source| {
                                        Ok::<_, KernelError>(
                                            varin_runtime::catalog::launches::SourceSelection {
                                                environment_run_id: source.environment_run_id,
                                                materialized: source.materialized,
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
                                launch_source =
                                    Some(varin_runtime::catalog::launches::SourceSelection {
                                        environment_run_id: binding.environment_run_id.clone(),
                                        materialized: binding.source_mode
                                            == crate::native_tools::NativeSourceMode::Materialized,
                                        workspace_id: binding.workspace_id.clone(),
                                        execution_workspace_id: binding
                                            .execution_workspace_id
                                            .clone(),
                                        branch_id: binding
                                            .file_source
                                            .as_ref()
                                            .or(binding.materialized_source.as_ref())
                                            .map(|source| source.branch_id.clone()),
                                        revision: binding
                                            .file_source
                                            .as_ref()
                                            .or(binding.materialized_source.as_ref())
                                            .map(|source| u64::try_from(source.revision))
                                            .transpose()
                                            .map_err(|_| {
                                                KernelError::Protocol(
                                                    "source revision must be nonnegative".into(),
                                                )
                                            })?,
                                    });
                                let tools = crate::native_tools::NativeToolExecutor::new(
                                    binding,
                                    resources.clone(),
                                )
                                .map_err(|e| KernelError::Authorization(e.to_string()))?;
                                start.binding.tools = tools.schemas();
                                start.binding.tool_schema_generation =
                                    start.binding.configuration_generation;
                                start.tools = Arc::new(tools);
                            }
                            {
                                let mut selection =
                                    varin_runtime::catalog::launches::LaunchSelection::from_binding(
                                        &start.binding,
                                        start.policy.identity(),
                                        launch_source,
                                    );
                                selection.credential_scope = selected_credential_scope;
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
                                    let _ = progress_responses.try_send(json!({"v":PROTOCOL_VERSION,"kind":"runtime-event","kernelEpoch":progress_epoch,"stream":"progress","runId":update.run_id,"streamId":progress_stream_id,"sequence":update.sequence,"event":update.event}));
                                }
                            });
                            let handle = runtime
                                .start(&p.run_id, start)
                                .map_err(|e| KernelError::Operation(e.to_string()))?;
                            return Ok(json!({"runId":handle.run_id,"epoch":handle.epoch}));
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
                        if method == "runtime.run.cancel" {
                            let p: NativeRunParams = serde_json::from_value(params)?;
                            return Ok(serde_json::to_value(
                                runtime
                                    .cancel(&p.run_id)
                                    .map_err(|e| KernelError::Operation(e.to_string()))?,
                            )?);
                        }
                        if method == "runtime.operation.cancel" {
                            let p: NativeOperationParams = serde_json::from_value(params)?;
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
        "runtime.status" => Ok(json!({"epoch":catalog.epoch()})),
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
                                    materialized: source.materialized,
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
                        tools: crate::native_tools::NativeToolExecutor::selected_schemas(&kinds),
                        policy: varin_runtime::execution::AgentPolicy::identity(
                            &varin_runtime::execution::DefaultAgentPolicy,
                        ),
                        source,
                    })
                })
                .transpose()?;
            let command = SubmitInput { key:p.key, thread_id:p.thread_id, branch_id:p.branch_id,
                expected_head:p.expected_head.0, input:p.input, configuration:p.configuration };
            let receipt = if inherit_source {
                catalog.submit_with_inherited_source(&command, launch.ok_or_else(|| KernelError::Protocol("source inheritance requires a model launch".into()))?)
            } else {
                catalog.submit_with_launch(&command, launch)
            }.map_err(domain)?;
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
        .record_external_receipt(
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
        )
        .map_err(domain)?;
    Ok(())
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
