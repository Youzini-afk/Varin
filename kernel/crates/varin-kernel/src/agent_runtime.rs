//! Agent control is independent of the file/process Storage execution queue.
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

#[path = "agent_policy.rs"]
mod policy_commands;

#[path = "agent_inputs.rs"]
mod input_commands;

#[path = "agent_children.rs"]
mod child_commands;
#[path = "agent_controls.rs"]
mod control_commands;
#[path = "agent_operations.rs"]
mod operation_commands;

fn run_cancellation_receipt(run: &varin_runtime::Run) -> Value {
    json!({"id":run.id,"thread_id":run.thread_id,"branch_id":run.branch_id,"state":run.state,
        "revision":run.revision,"epoch":run.epoch,"cancel_requested":run.cancel_requested,"waiting_on":run.waiting_on})
}
fn operation_cancellation_receipt<E, R, C>(op: &varin_runtime::Operation<E, R, C>) -> Value {
    json!({"id":op.id,"run_id":op.run_id,"epoch":op.epoch,"revision":op.revision,"phase":op.phase,"outcome":op.outcome,
        "effect":op.effect,"cancel_requested":op.cancel_requested,"lifetime":op.lifetime,"handed_off":op.handed_off,
        "executor":op.executor,"execution_owner":op.execution_owner,"waiting_on":op.waiting_on})
}

#[derive(Clone, Default)]
pub(crate) struct AgentControl {
    owner: Arc<Mutex<Option<AgentOwner>>>,
    admission: Arc<varin_runtime::resource_admission::ResourceAdmission>,
}
struct AgentOwner {
    runtime: Arc<RunSupervisor>,
    resources: crate::tools::KernelResourceClient,
}
impl AgentControl {
    pub(crate) fn child_handoff(&self,params:&Value)->Result<varin_runtime::catalog::collaboration::ChildSourceHandoff,KernelError> {
        let p:KernelSourceHandoffClaimParams=serde_json::from_value(params.clone())?;
        let id=p.handoff_operation_id.strip_prefix("child-source-handoff:").ok_or_else(||KernelError::Authorization("invalid child handoff identity".into()))?;
        let owner=self.owner.lock().map_err(|_|KernelError::Storage("Agent owner failed".into()))?;
        let runtime=&owner.as_ref().ok_or_else(||KernelError::Storage("Agent is not ready".into()))?.runtime;
        let catalog=runtime.catalog();let catalog=catalog.lock().map_err(|_|KernelError::Storage("Catalog owner failed".into()))?;
        let child=catalog.child_task(id).map_err(domain)?;
        if child.resources_released {return Err(KernelError::Authorization("child source handoff was already released".into()));}
        if child.child_thread_id!=p.child_thread_id || child.child_branch_id!=p.child_branch_id
            || child.source.handoff().operation_id!=p.handoff_operation_id {
            return Err(KernelError::Authorization("source claim does not identify an accepted child".into()));
        }
        Ok(child.source.handoff().clone())
    }

    pub(crate) fn reserve_input(
        &self,
        meta: &Value,
        current_epoch: Option<&str>,
        cancel: &varin_runtime::execution::CancellationToken,
    ) -> Result<Option<varin_runtime::resource_admission::ResourceReservation>, KernelError> {
        if meta["v"] != PROTOCOL_VERSION
            || meta["kind"] != "request"
            || current_epoch.is_none()
            || meta["epoch"].as_str() != current_epoch
            || meta.get("grantId").is_some()
        {
            return Ok(None);
        }
        let Some(key) = crate::transport::input_order_key(meta) else {
            return Ok(None);
        };
        let id = meta["id"]
            .as_str()
            .ok_or_else(|| KernelError::Protocol("input request identity required".into()))?;
        let claim = varin_runtime::execution::ResourceClaim {
            key: key.into(),
            access: varin_runtime::execution::Access::Write,
        };
        let mut reservation = self
            .admission
            .reserve_unmetered(
                &format!("input-request:{id}"),
                vec![varin_runtime::execution::ResourceIntent::Exact(
                    claim.clone(),
                )],
                cancel,
            )
            .map_err(|error| KernelError::Operation(error.to_string()))?;
        reservation
            .resolve(&[claim])
            .map_err(|error| KernelError::Operation(error.to_string()))?;
        Ok(Some(reservation))
    }
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
        if let Ok(control) = self.owner.lock() {
            if let Some(owner) = control.as_ref() {
                let runtime = &owner.runtime;
                if method == Some("runtime.run.cancel") {
                    if let Ok(params) = serde_json::from_value::<RunParams>(params.clone()) {
                        runtime.cancel_control(&params.run_id);
                    }
                } else if let Ok(params) = serde_json::from_value::<OperationParams>(params.clone())
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
    ToolReceipt(crate::host_tools::LateReceipt),
    ProcessReplayFailed(String),
    Initialize {
        root: PathBuf,
        epoch: String,
    },
    RuntimeOpened {
        identity: (PathBuf, String),
        result: Result<Catalog, KernelError>,
    },
    Request {
        value: Value,
        cancellation: Arc<AtomicBool>,
        input_order: Option<varin_runtime::resource_admission::ResourceReservation>,
    },
}
pub(crate) fn domain(error: varin_runtime::RuntimeError) -> KernelError {
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
    control: AgentControl,
    resources: crate::tools::KernelResourceClient,
    credential_bridge: crate::credential_bridge::CredentialBridge,
    mcp_bridge: crate::host_tools::ToolBridge,
    language_bridge: crate::language::LanguageBridge,
    memory_bridge: crate::host_query::OwnerChannel,
    context_bridge: crate::host_query::OwnerChannel,
    plan_bridge: crate::plan_bridge::PlanBridge,
    retrieval_bridge: crate::retrieval::RetrievalBridge,
    policy_bridge: crate::policy::PolicyBridge,
    responses: crate::transport::Sender,
    finished: impl Fn(&str) + Send + Sync + 'static,
) -> JoinHandle<()> {
    let finished: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(finished);
    let (content_tasks, content_jobs) = mpsc::channel::<Box<dyn FnOnce() + Send>>();
    let content_jobs = Arc::new(Mutex::new(content_jobs));
    // The protocol admits this many ordinary requests. Independent content reads get their
    // own execution slot; the receiver lock is released before any file I/O or decoding.
    for _ in 0..KERNEL_REQUEST_WINDOW {
        let jobs = content_jobs.clone();
        thread::spawn(move || loop {
            let job = {
                jobs.lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .recv()
            };
            let Ok(job) = job else {
                break;
            };
            job();
        });
    }

    thread::spawn(move || {
        let mut identity: Option<(PathBuf, String)> = None;
        let mut runtime: Option<Arc<RunSupervisor>> = None;
        let mut run_models: Option<Arc<crate::run_models::RunModels>> = None;
        let mut run_tools: Option<Arc<crate::run_tools::RunTools>> = None;
        let mut opening = false;
        let mut initialization_failure: Option<String> = None;
        let mut waiting = std::collections::VecDeque::new();
        loop {
            let command = if !opening && !waiting.is_empty() {
                waiting.pop_front().expect("pending request")
            } else {
                let Ok(command) = commands.recv() else {
                    break;
                };
                command
            };
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
                Command::Stop => {
                    if let Some(runtime) = runtime.as_ref() {
                        if let Ok(catalog) = runtime.catalog().lock() {
                            catalog.cancel_content_collection();
                        }
                    }
                    break;
                },
                Command::ToolReceipt(receipt) => {
                    if opening {
                        waiting.push_back(Command::ToolReceipt(receipt));
                        continue;
                    }
                    if receipt.v != 1
                        || receipt.kind != "host-tool-receipt"
                        || receipt.id.is_empty()
                        || identity
                            .as_ref()
                            .is_none_or(|(_, epoch)| epoch != &receipt.kernel_epoch)
                    {
                        continue;
                    }
                    let Some(runtime) = runtime.as_ref() else {
                        continue;
                    };
                    let catalog = runtime.catalog();
                    let responses = responses.clone();
                    let _=content_tasks.send(Box::new(move||{
                        let id=receipt.id.clone();let epoch=receipt.kernel_epoch.clone();
                        let result=receipt.apply(&catalog);
                        // Only a committed receipt or a definitive identity/shape rejection ends retries.
                        let accepted=match result {
                            Ok(())=>true,
                            Err(KernelError::Authorization(_)|KernelError::Protocol(_)|KernelError::Operation(_))=>false,
                            Err(_)=>return,
                        };
                        let _=responses.send(json!({"v":1,"kind":"host-tool-receipt-ack","id":id,"kernelEpoch":epoch,"accepted":accepted}));
                    }));
                }
                Command::ProcessTerminal(fact) => {
                    if opening {
                        waiting.push_back(Command::ProcessTerminal(fact));
                        continue;
                    }
                    if let Some(runtime) = runtime.as_ref() {
                        let runtime = runtime.clone();
                        thread::spawn(move || {
                            if let Err(error) = apply_process_terminal(&runtime, &fact) {
                                if let Ok(mut catalog) = runtime.catalog().lock() {
                                    let _ = catalog.record_recovery_failure(
                                        &fact.process_id,
                                        &error.to_string(),
                                    );
                                }
                            }
                        });
                    }
                }
                Command::ProcessReplayFailed(reason) => {
                    if opening {
                        waiting.push_back(Command::ProcessReplayFailed(reason));
                        continue;
                    }
                    if let Some(runtime) = runtime.as_ref() {
                        let catalog = runtime.catalog();
                        if let Ok(mut catalog) = catalog.lock() {
                            let _ = catalog.record_recovery_failure("process-replay", &reason);
                        };
                    }
                }
                Command::Initialize { root, epoch } => {
                    let selected = (root.join("agent-runtime"), epoch);
                    if identity.as_ref() == Some(&selected) {
                        continue;
                    }
                    if let Some(runtime) = runtime.as_ref() {
                        if let Ok(catalog) = runtime.catalog().lock() {
                            catalog.cancel_content_collection();
                        }
                    }
                    identity = Some(selected.clone());
                    opening = true;
                    initialization_failure = None;
                    let sender = self_sender.clone();
                    let admission = control.admission.clone();
                    thread::spawn(move || {
                        // Opening, durable recovery, content parsing and occupancy restoration belong
                        // to this initialization worker, never the shared Agent command actor.
                        let result = (|| {
                            let capacity =
                                varin_runtime::execution_capacity::configured_compute_capacity()
                                    .map_err(KernelError::Protocol)?;
                            let catalog =
                                Catalog::open_with_resource_admission(&selected.0, admission)
                                    .map_err(domain)?;
                            catalog.resource_admission().set_compute_capacity(capacity);
                            Ok(catalog)
                        })();
                        let _ = sender.send(Command::RuntimeOpened {
                            identity: selected,
                            result,
                        });
                    });
                }
                Command::RuntimeOpened {
                    identity: selected,
                    result,
                } => {
                    if identity.as_ref() != Some(&selected) {
                        continue;
                    }
                    opening = false;
                    let epoch = &selected.1;
                    let result: Result<(), KernelError> = (|| {
                        let catalog = result?;
                        let owner = Arc::new(RunSupervisor::new(catalog));
                        let (notify, notifications) = mpsc::sync_channel(1);
                        owner
                            .catalog()
                            .lock()
                            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
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
                        *control
                            .owner
                            .lock()
                            .map_err(|_| KernelError::Storage("control owner failed".into()))? =
                            Some(AgentOwner {
                                runtime: owner.clone(),
                                resources: resources.clone(),
                            });
                        policy_bridge.set_catalog(owner.catalog());
                        runtime = Some(owner.clone());
                        run_models = Some(crate::run_models::RunModels::new(
                            owner.catalog(),
                            credential_bridge.clone(),
                        ));
                        run_tools = Some(crate::run_tools::RunTools::new(
                            owner.catalog(),
                            mcp_bridge.clone(),
                        ));
                        let pending = {
                            let catalog = owner.catalog();
                            let catalog = catalog
                                .lock()
                                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
                            catalog
                                .pending_external_operations("process_spawn")
                                .map_err(domain)?
                        };
                        if let Err(error) = resources.replay_process_terminals(pending) {
                            let catalog = owner.catalog();
                            if let Ok(mut catalog) = catalog.lock() {
                                let _ = catalog
                                    .record_recovery_failure("process-replay", &error.to_string());
                            };
                        }

                        Ok(())
                    })();
                    if let Err(error) = result {
                        initialization_failure = Some(error.to_string());
                    }
                }
                Command::Request {
                    mut value,
                    cancellation,
                    input_order,
                } => {
                    let id = value
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if opening {
                        // Cancellation flags remain owned by the protocol reader while this request
                        // waits for its concrete runtime initialization dependency.
                        waiting.push_back(Command::Request {
                            value,
                            cancellation,
                            input_order,
                        });
                        continue;
                    }
                    let mut deferred = false;
                    let result = (|| {
                        if cancellation.load(Ordering::Acquire) {
                            return Err(KernelError::Cancelled);
                        }
                        reject_unknown_fields(
                            &value,
                            &["v", "kind", "id", "method", "params", "epoch", "grantId"],
                            "runtime request",
                        )?;
                        if value.get("v").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
                            || value.get("kind").and_then(Value::as_str) != Some("request")
                            || id.is_empty()
                        {
                            return Err(KernelError::Protocol("invalid runtime envelope".into()));
                        }
                        let (_root, epoch) = identity.as_ref().ok_or_else(|| {
                            KernelError::Authorization("kernel handshake required".into())
                        })?;
                        if value.get("epoch").and_then(Value::as_str) != Some(epoch.as_str())
                            || value.get("grantId").is_some()
                        {
                            return Err(KernelError::Authorization(
                                "runtime commands require current Host management authority".into(),
                            ));
                        }
                        let selected_method = value
                            .get("method")
                            .and_then(Value::as_str)
                            .ok_or_else(|| KernelError::Protocol("method required".into()))?
                            .to_owned();
                        let method = selected_method.as_str();
                        let params = value
                            .get_mut("params")
                            .map(Value::take)
                            .unwrap_or_else(|| json!({}));
                        // Typed body contracts are consumed once on their independent worker.
                        // Generated validation would otherwise clone all input/attachment content here.
                        if !matches!(
                            method,
                            "runtime.thread.create"
                                | "runtime.input.submit"
                                | "runtime.input.enqueue"
                                | "runtime.input.edit"
                                | "runtime.child.prepare"
                                | "runtime.child.source.ready"
                                | "runtime.tools.ready"
                                | "runtime.launch.mcp.prepare"
                                | "runtime.launch.policy.prepare"
                                | "runtime.policy.ready"
                                | "runtime.question.answer"
                                | "runtime.permission.open"
                                | "runtime.permission.consume"
                        ) {
                            validate_method_params(method, &params)?;
                        }
                        if let Some(failure) = &initialization_failure {
                            return Err(KernelError::Storage(format!(
                                "runtime initialization failed: {failure}"
                            )));
                        }
                        let runtime = runtime.as_ref().ok_or_else(|| {
                            KernelError::Storage("runtime initialization has not completed".into())
                        })?;
                        runtime
                            .reap()
                            .map_err(|e| KernelError::Operation(e.to_string()))?;
                        if method == "runtime.content.collect" {
                            // This admission is metadata-only. Maintenance never enters Storage or
                            // the ordinary history/receipt content queue, and does not own a Run.
                            let collection = runtime.catalog().lock()
                                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                                .prepare_content_collection(cancellation.clone());
                            match collection {
                                varin_runtime::content::ContentCollectionAdmission::Deferred(report) => {
                                    return Ok(serde_json::to_value(report)?);
                                }
                                varin_runtime::content::ContentCollectionAdmission::Ready(collection) => {
                                    let response_id = id.clone();
                                    let response_sender = responses.clone();
                                    let done = finished.clone();
                                    thread::Builder::new().name("runtime-content-maintenance".into())
                                        .spawn(move || {
                                            // Collection owns the original runtime.owner file until
                                            // the last unlink/fsync finishes, including after Stop.
                                            let report = collection.run();
                                            let response = match serde_json::to_value(report) {
                                                Ok(value) => response_ok(&response_id, value),
                                                Err(error) => response_error(&response_id, &error.into()),
                                            };
                                            done(&response_id);
                                            let _ = response_sender.send(response);
                                        })?;
                                    deferred = true;
                                    return Ok(Value::Null);
                                }
                            }
                        }
                        if matches!(
                            method,
                            "runtime.policy.select"
                                | "runtime.policy.inspect"
                                | "runtime.policy.cancel"
                                | "runtime.policy.fail"
                        ) {
                            return policy_commands::execute(
                                runtime,
                                &policy_bridge,
                                &credential_bridge,
                                method,
                                params,
                                &cancellation,
                            );
                        }
                        if matches!(
                            method,
                            "runtime.policy.ready" | "runtime.launch.policy.prepare"
                        ) {
                            let runtime = runtime.clone();
                            let bridge = policy_bridge.clone();
                            let credentials = credential_bridge.clone();
                            let method = method.to_owned();
                            let response_id = id.clone();
                            let response_sender = responses.clone();
                            let done = finished.clone();
                            let cancelled = cancellation.clone();
                            thread::spawn(move || {
                                let result = policy_commands::execute(
                                    &runtime,
                                    &bridge,
                                    &credentials,
                                    &method,
                                    params,
                                    &cancelled,
                                );
                                let response = match result {
                                    Ok(v) => response_ok(&response_id, v),
                                    Err(e) => response_error(&response_id, &e),
                                };
                                done(&response_id);
                                let _ = response_sender.send(response);
                            });
                            deferred = true;
                            return Ok(Value::Null);
                        }
                        if matches!(
                            method,
                            "runtime.question.answer"
                                | "runtime.run.resume"
                                | "runtime.run.cancel"
                                | "runtime.operation.cancel"
                                | "runtime.child.cancel"
                                | "runtime.child.reconcile"
                                | "runtime.child.wait.cancel"
                                | "runtime.process.wait.reconcile"
                        ) {
                            let commands = control_commands::ControlCommands {
                                runtime: runtime.clone(),
                                resources: resources.clone(),
                                models: run_models
                                    .as_ref()
                                    .expect("initialized runtime models")
                                    .clone(),
                                tools: run_tools
                                    .as_ref()
                                    .expect("initialized runtime tools")
                                    .clone(),
                            };
                            commands.admit_cancellation(method, &params)?;
                            let method = method.to_owned();
                            let response_id = id.clone();
                            let response_sender = responses.clone();
                            let done = finished.clone();
                            let cancelled = cancellation.clone();
                            thread::spawn(move || {
                                let result = commands.execute(&method, params, &cancelled);
                                let response = match result {
                                    Ok(value) => response_ok(&response_id, value),
                                    Err(error) => response_error(&response_id, &error),
                                };
                                done(&response_id);
                                let _ = response_sender.send(response);
                            });
                            deferred = true;
                            return Ok(Value::Null);
                        }
                        if matches!(
                            method,
                            "runtime.events.read"
                                | "runtime.operation.inspect"
                                | "runtime.thread.operations.active"
                                | "runtime.permission.open"
                                | "runtime.permission.consume"
                                | "runtime.permission.decide"
                        ) {
                            let runtime = runtime.clone();
                            let method = method.to_owned();
                            let response_id = id.clone();
                            let response_sender = responses.clone();
                            let done = finished.clone();
                            let cancelled = cancellation.clone();
                            thread::spawn(move || {
                                let result = operation_commands::execute(
                                    runtime, &method, params, &cancelled,
                                );
                                let response = match result {
                                    Ok(value) => response_ok(&response_id, value),
                                    Err(error) => response_error(&response_id, &error),
                                };
                                done(&response_id);
                                let _ = response_sender.send(response);
                            });
                            deferred = true;
                            return Ok(Value::Null);
                        }
                        if matches!(
                            method,
                            "runtime.child.list"
                                | "runtime.child.for_thread"
                                | "runtime.child.inspect"
                                | "runtime.child.release"
                                | "runtime.child.fail"
                                | "runtime.child.report.read"
                                | "runtime.child.source.ready"
                                | "runtime.child.settle"
                                | "runtime.child.result.candidate"
                                | "runtime.child.result.published"
                                | "runtime.host_tool.reconcile"
                        ) {
                            let runtime = runtime.clone();
                            let resources = resources.clone();
                            let method = method.to_owned();
                            let response_id = id.clone();
                            let response_sender = responses.clone();
                            let done = finished.clone();
                            let cancelled = cancellation.clone();
                            thread::spawn(move || {
                                let result =
                                    child_commands::execute(runtime, resources, &method, params, &cancelled);
                                let response = match result {
                                    Ok(value) => response_ok(&response_id, value),
                                    Err(error) => response_error(&response_id, &error),
                                };
                                done(&response_id);
                                let _ = response_sender.send(response);
                            });
                            deferred = true;
                            return Ok(Value::Null);
                        }
                        if matches!(
                            method,
                            "runtime.thread.create"
                                | "runtime.input.submit"
                                | "runtime.input.enqueue"
                                | "runtime.input.edit"
                                | "runtime.input.cancel"
                                | "runtime.input.inspect"
                                | "runtime.input.list"
                                | "runtime.child.prepare"
                        ) {
                            let order = input_order;
                            let runtime = runtime.clone();
                            let method = method.to_owned();
                            let response_id = id.clone();
                            let response_sender = responses.clone();
                            let done = finished.clone();
                            let cancelled = cancellation.clone();
                            thread::spawn(move || {
                                let result = input_commands::execute(
                                    runtime, &method, params, cancelled, order,
                                );
                                let response = match result {
                                    Ok(value) => response_ok(&response_id, value),
                                    Err(error) => response_error(&response_id, &error),
                                };
                                done(&response_id);
                                let _ = response_sender.send(response);
                            });
                            deferred = true;
                            return Ok(Value::Null);
                        }
                        if method == "runtime.branch.fork" {
                            let order = input_order;
                            if let Some(capture) = params.get("planCapture") {
                                if !capture.is_object()
                                    || ["headId", "inheritedRef", "capturedRef"]
                                        .iter()
                                        .any(|field| capture.get(*field).is_none())
                                {
                                    return Err(KernelError::Protocol("planCapture requires the complete immutable capture, including explicit null references".into()));
                                }
                            }
                            let p: BranchForkParams = serde_json::from_value(params)?;
                            let capture = p.plan_capture.map(|value| {
                                varin_runtime::catalog::plan::PlanForkCapture {
                                    source_thread_id: value.source_thread_id,
                                    source_branch_id: value.source_branch_id,
                                    target_branch_id: value.target_branch_id,
                                    head_id: value.head_id.0,
                                    inherited_ref: value.inherited_ref.0,
                                    captured_ref: value.captured_ref.0,
                                }
                            });
                            let catalog = runtime.catalog();
                            let preparation = catalog
                                .lock()
                                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                                .prepare_branch_fork(
                                    &p.source_branch_id,
                                    &p.branch_id,
                                    p.head_id.0.as_deref(),
                                    capture,
                                )
                                .map_err(domain)?;
                            let response_id = id.clone();
                            let response_sender = responses.clone();
                            let done = finished.clone();
                            let cancelled = cancellation.clone();
                            thread::spawn(move || {
                                let result = (|| -> Result<Value, KernelError> {
                                    if cancelled.load(Ordering::Acquire) {
                                        return Err(KernelError::Cancelled);
                                    }
                                    let prepared = preparation.load().map_err(domain)?;
                                    let _order = input_commands::await_input_order(order)?;
                                    let receipt = {
                                        let mut owner = catalog.lock().map_err(|_| {
                                            KernelError::Storage("catalog owner failed".into())
                                        })?;
                                        if cancelled.load(Ordering::Acquire) {
                                            return Err(KernelError::Cancelled);
                                        }
                                        owner.admit_branch_fork(prepared).map_err(domain)?
                                    };
                                    Ok(serde_json::to_value(receipt)?)
                                })();
                                let response = match result {
                                    Ok(value) => response_ok(&response_id, value),
                                    Err(error) => response_error(&response_id, &error),
                                };
                                done(&response_id);
                                let _ = response_sender.send(response);
                            });
                            deferred = true;
                            return Ok(Value::Null);
                        }
                        if method == "runtime.model.inspect" {
                            let p: RunParams = serde_json::from_value(params)?;
                            return Ok(serde_json::to_value(
                                run_models
                                    .as_ref()
                                    .expect("initialized runtime models")
                                    .inspect(&p.run_id)?,
                            )?);
                        }
                        if method == "runtime.tools.select" {
                            let p: ToolSelectParams = serde_json::from_value(params)?;
                            run_tools
                                .as_ref()
                                .expect("initialized runtime tools")
                                .desire(&p.run_id, &p.selection_id)
                                .map_err(|error| KernelError::Operation(error.to_string()))?;
                            return Ok(json!({}));
                        }
                        if method == "runtime.tools.ready" {
                            let tools = run_tools
                                .as_ref()
                                .expect("initialized runtime tools")
                                .clone();
                            let response_id = id.clone();
                            let response_sender = responses.clone();
                            let done = finished.clone();
                            let cancelled = cancellation.clone();
                            thread::spawn(move || {
                                let result = (|| -> Result<Value, KernelError> {
                                    if cancelled.load(Ordering::Acquire) {
                                        return Err(KernelError::Cancelled);
                                    }
                                    let p: ToolReadyParams = serde_json::from_value(params)?;
                                    let binding = p.binding.map(live_mcp_binding).transpose()?;
                                    let extensions = p
                                        .extension_bindings
                                        .unwrap_or_default()
                                        .into_iter()
                                        .map(live_extension_binding)
                                        .collect::<Result<Vec<_>, _>>()?;
                                    let ready = tools
                                        .ready(
                                            &p.run_id,
                                            &p.selection_id,
                                            binding,
                                            extensions,
                                            || cancelled.load(Ordering::Acquire),
                                        )
                                        .map_err(|error| {
                                            KernelError::Operation(error.to_string())
                                        })?;
                                    Ok(json!({"ready":ready}))
                                })();
                                let response = match result {
                                    Ok(value) => response_ok(&response_id, value),
                                    Err(error) => response_error(&response_id, &error),
                                };
                                done(&response_id);
                                let _ = response_sender.send(response);
                            });
                            deferred = true;
                            return Ok(Value::Null);
                        }
                        if method == "runtime.model.select" {
                            let p: ModelSelectParams = serde_json::from_value(params)?;
                            let configuration = serde_json::from_value(p.configuration)?;
                            let scope = p
                                .credential_scope
                                .map(|scope| {
                                    Ok::<_, KernelError>(
                                        varin_runtime::providers::auth::CredentialScope {
                                            reference: scope.reference,
                                            authority: scope.authority,
                                            account: scope.account,
                                            generation: scope.generation.try_into().map_err(
                                                |_| {
                                                    KernelError::Protocol(
                                                        "credential generation must be nonnegative"
                                                            .into(),
                                                    )
                                                },
                                            )?,
                                        },
                                    )
                                })
                                .transpose()?;
                            let selection = runtime
                                .catalog()
                                .lock()
                                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                                .select_model(&p.run_id, &p.key, configuration, scope)
                                .map_err(domain)?;
                            run_models
                                .as_ref()
                                .expect("initialized runtime models")
                                .prepare(selection.clone())
                                .map_err(|error| KernelError::Operation(error.to_string()))?;
                            return Ok(serde_json::to_value(selection)?);
                        }
                        if matches!(
                            method,
                            "runtime.launch.extensions.prepare"
                                | "runtime.launch.mcp.prepare"
                                | "runtime.launch.inspect"
                                | "runtime.launch.list"
                                | "runtime.launch.fail"
                        ) {
                            let runtime = runtime.clone();
                            let method = method.to_owned();
                            let response_id = id.clone();
                            let response_sender = responses.clone();
                            let done = finished.clone();
                            let cancelled = cancellation.clone();
                            thread::spawn(move || {
                                let result = (|| -> Result<Value, KernelError> {
                                    if cancelled.load(Ordering::Acquire) {
                                        return Err(KernelError::Cancelled);
                                    }
                                    let owner = runtime.catalog();
                                    if method == "runtime.launch.list" {
                                        let reads = owner
                                            .lock()
                                            .map_err(|_| {
                                                KernelError::Storage("catalog owner failed".into())
                                            })?
                                            .capture_pending_launches()
                                            .map_err(domain)?;
                                        let mut launches = reads
                                            .into_iter()
                                            .map(|read| read.load())
                                            .collect::<std::result::Result<Vec<_>, _>>()
                                            .map_err(domain)?;
                                        for launch in &mut launches {
                                            launch.startable &=
                                                runtime.start_available(&launch.run_id).map_err(
                                                    |e| KernelError::Operation(e.to_string()),
                                                )?;
                                        }
                                        return Ok(serde_json::to_value(launches)?);
                                    }
                                    if method == "runtime.launch.inspect" {
                                        let p: RunParams = serde_json::from_value(params)?;
                                        let read = owner
                                            .lock()
                                            .map_err(|_| {
                                                KernelError::Storage("catalog owner failed".into())
                                            })?
                                            .capture_launch(&p.run_id)
                                            .map_err(domain)?;
                                        let mut launch = read
                                            .map(|read| read.load())
                                            .transpose()
                                            .map_err(domain)?;
                                        if let Some(launch) = &mut launch {
                                            launch.startable &=
                                                runtime.start_available(&launch.run_id).map_err(
                                                    |e| KernelError::Operation(e.to_string()),
                                                )?;
                                        }
                                        return Ok(serde_json::to_value(launch)?);
                                    }
                                    let read = if method == "runtime.launch.mcp.prepare" {
                                        let p: McpPrepareParams = serde_json::from_value(params)?;
                                        let binding = mcp_binding(p.binding)?;
                                        let preparation = owner
                                            .lock()
                                            .map_err(|_| {
                                                KernelError::Storage("catalog owner failed".into())
                                            })?
                                            .prepare_mcp_change(&p.run_id, binding)
                                            .map_err(domain)?;
                                        let prepared = preparation.load().map_err(domain)?;
                                        let mut catalog = owner.lock().map_err(|_| {
                                            KernelError::Storage("catalog owner failed".into())
                                        })?;
                                        if cancelled.load(Ordering::Acquire) {
                                            return Err(KernelError::Cancelled);
                                        }
                                        catalog.admit_launch_change(prepared).map_err(domain)?
                                    } else if method == "runtime.launch.extensions.prepare" {
                                        let p: ExtensionPrepareParams =
                                            serde_json::from_value(params)?;
                                        let bindings = p
                                            .bindings
                                            .into_iter()
                                            .map(extension_binding)
                                            .collect::<Result<Vec<_>, _>>()?;
                                        let preparation = owner
                                            .lock()
                                            .map_err(|_| {
                                                KernelError::Storage("catalog owner failed".into())
                                            })?
                                            .prepare_extensions_change(&p.run_id, bindings)
                                            .map_err(domain)?;
                                        let prepared = preparation.load().map_err(domain)?;
                                        let mut catalog = owner.lock().map_err(|_| {
                                            KernelError::Storage("catalog owner failed".into())
                                        })?;
                                        if cancelled.load(Ordering::Acquire) {
                                            return Err(KernelError::Cancelled);
                                        }
                                        catalog.admit_launch_change(prepared).map_err(domain)?
                                    } else {
                                        let p: LaunchFailedParams = serde_json::from_value(params)?;
                                        if runtime
                                            .status()
                                            .map_err(|e| KernelError::Operation(e.to_string()))?
                                            .iter()
                                            .any(|worker| {
                                                worker.run_id == p.run_id && !worker.finished
                                            })
                                        {
                                            return Err(KernelError::Operation(
                                                "Run already has a live worker".into(),
                                            ));
                                        }
                                        let mut catalog = owner.lock().map_err(|_| {
                                            KernelError::Storage("catalog owner failed".into())
                                        })?;
                                        if cancelled.load(Ordering::Acquire) {
                                            return Err(KernelError::Cancelled);
                                        }
                                        catalog
                                            .fail_launch_metadata(&p.run_id, &p.code)
                                            .map_err(domain)?;
                                        catalog
                                            .capture_launch(&p.run_id)
                                            .map_err(domain)?
                                            .ok_or_else(|| {
                                                KernelError::Storage(
                                                    "launch missing after failure".into(),
                                                )
                                            })?
                                    };
                                    Ok(serde_json::to_value(read.load().map_err(domain)?)?)
                                })();
                                let response = match result {
                                    Ok(value) => response_ok(&response_id, value),
                                    Err(error) => response_error(&response_id, &error),
                                };
                                done(&response_id);
                                let _ = response_sender.send(response);
                            });
                            deferred = true;
                            return Ok(Value::Null);
                        }
                        if matches!(method, "runtime.run.start" | "runtime.launch.select") {
                            let selected: Option<LaunchSelectParams> =
                                if method == "runtime.launch.select" {
                                    Some(serde_json::from_value(params.clone())?)
                                } else {
                                    None
                                };
                            let p: RunStartParams = if let Some(selected) = &selected {
                                RunStartParams {
                                    run_id: selected.run_id.clone(),
                                    credential_scope: selected.credential_scope.clone(),
                                    tool_binding: None,
                                    mcp_binding: None,
                                    extension_bindings: None,
                                    policy_binding: None,
                                }
                            } else {
                                serde_json::from_value(params)?
                            };
                            let run = runtime
                                .catalog()
                                .lock()
                                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                                .run(&p.run_id)
                                .map_err(domain)?;
                            let preparation = crate::run_assembly::RunPreparation::new(p, &run)?;
                            let assembly = crate::run_assembly::RunAssembly {
                                runtime: runtime.clone(),
                                resources: resources.clone(),
                                credentials: credential_bridge.clone(),
                                language: language_bridge.clone(),
                                retrieval: retrieval_bridge.clone(),
                                memory: memory_bridge.clone(),
                                context: context_bridge.clone(),
                                plan: plan_bridge.clone(),
                                policy: policy_bridge.clone(),
                                models: run_models
                                    .as_ref()
                                    .expect("initialized runtime models")
                                    .clone(),
                                tools: run_tools
                                    .as_ref()
                                    .expect("initialized runtime tools")
                                    .clone(),
                                responses: responses.clone(),
                                epoch: epoch.clone(),
                            };
                            if selected.is_some() {
                                let response_id = id.clone();
                                let response_sender = responses.clone();
                                let done = finished.clone();
                                let cancelled = cancellation.clone();
                                thread::spawn(move || {
                                    let result = assembly
                                        .prepare(preparation, selected, || {
                                            cancelled.load(Ordering::Acquire)
                                        })
                                        .and_then(|prepared| match prepared {
                                            crate::run_assembly::PreparedLaunch::Selection(
                                                intent,
                                            ) => Ok(intent),
                                            crate::run_assembly::PreparedLaunch::Start(_) => {
                                                Err(KernelError::Protocol(
                                                    "selection unexpectedly prepared execution"
                                                        .into(),
                                                ))
                                            }
                                        });
                                    let response = match result {
                                        Ok(value) => response_ok(&response_id, value),
                                        Err(error) => response_error(&response_id, &error),
                                    };
                                    done(&response_id);
                                    let _ = response_sender.send(response);
                                });
                                deferred = true;
                                return Ok(Value::Null);
                            }
                            let prepare = assembly.clone();
                            let handle = runtime
                                .prepare_start(&run.id, move |cancel| {
                                    prepare
                                        .prepare(preparation, None, || cancel.is_cancelled())
                                        .map_err(|error| {
                                            varin_runtime::execution::ExecutionError::new(
                                                "preparation_failed",
                                                error.to_string(),
                                            )
                                        })
                                        .and_then(|prepared| match prepared {
                                            crate::run_assembly::PreparedLaunch::Start(start) => {
                                                Ok(start)
                                            }
                                            crate::run_assembly::PreparedLaunch::Selection(_) => {
                                                Err(varin_runtime::execution::ExecutionError::new(
                                                    "preparation_failed",
                                                    "execution unexpectedly prepared selection",
                                                ))
                                            }
                                        })
                                })
                                .map_err(|error| KernelError::Operation(error.to_string()))?;
                            let receipt = json!({"runId":handle.run_id,"epoch":handle.epoch});
                            assembly.observe_completion(handle);
                            return Ok(receipt);
                        }
                        if method == "runtime.context.refresh"
                            || method == "runtime.context.inspect"
                        {
                            let catalog = runtime.catalog();
                            let refresh = if method == "runtime.context.refresh" {
                                let p: ContextRefreshParams =
                                    serde_json::from_value(params.clone())?;
                                let basis = personalization_basis(
                                    p.context.personalization.ok_or_else(|| {
                                        KernelError::Protocol(
                                            "personalization basis is required".into(),
                                        )
                                    })?,
                                )?;
                                Some(
                                    catalog
                                        .lock()
                                        .map_err(|_| {
                                            KernelError::Storage("catalog owner failed".into())
                                        })?
                                        .prepare_personalization_refresh(
                                            &p.branch_id,
                                            u64::try_from(p.expected_revision).map_err(|_| {
                                                KernelError::Protocol(
                                                    "context revision must be nonnegative".into(),
                                                )
                                            })?,
                                            p.context.effective_system_prompt,
                                            p.context.instruction_sources,
                                            p.context.memory_checkpoint.0,
                                            basis,
                                        )
                                        .map_err(domain)?,
                                )
                            } else {
                                None
                            };
                            let read = if refresh.is_none() {
                                let p: HistoryParams = serde_json::from_value(params)?;
                                let owner = catalog.lock().map_err(|_| {
                                    KernelError::Storage("catalog owner failed".into())
                                })?;
                                owner.head(&p.branch_id).map_err(domain)?;
                                owner
                                    .capture_active_checkpoint(&p.branch_id)
                                    .map_err(domain)?
                            } else {
                                None
                            };
                            let response_id = id.clone();
                            let response_sender = responses.clone();
                            let done = finished.clone();
                            let cancelled = cancellation.clone();
                            thread::spawn(move || {
                                let result = (|| -> Result<Value, KernelError> {
                                    if cancelled.load(Ordering::Acquire) {
                                        return Err(KernelError::Cancelled);
                                    }
                                    if let Some(refresh) = refresh {
                                        let prepared = refresh.load().map_err(domain)?;
                                        if cancelled.load(Ordering::Acquire) {
                                            return Err(KernelError::Cancelled);
                                        }
                                        let checkpoint = catalog
                                            .lock()
                                            .map_err(|_| {
                                                KernelError::Storage("catalog owner failed".into())
                                            })?
                                            .publish_personalization_refresh(prepared)
                                            .map_err(domain)?;
                                        Ok(serde_json::to_value(checkpoint)?)
                                    } else {
                                        Ok(serde_json::to_value(
                                            read.map(|read| read.load())
                                                .transpose()
                                                .map_err(domain)?,
                                        )?)
                                    }
                                })();
                                let response = match result {
                                    Ok(value) => response_ok(&response_id, value),
                                    Err(error) => response_error(&response_id, &error),
                                };
                                done(&response_id);
                                let _ = response_sender.send(response);
                            });
                            deferred = true;
                            return Ok(Value::Null);
                        }
                        if method == "runtime.context_job.resume" {
                            let p: RunParams = serde_json::from_value(params)?;
                            let runtime = runtime.clone();
                            let response_id = id.clone();
                            let response_sender = responses.clone();
                            let done = finished.clone();
                            thread::spawn(move || {
                                let result = (|| -> Result<Value, KernelError> {
                                    runtime.quiesce_context_job(&p.run_id).map_err(|error| {
                                        KernelError::Operation(error.to_string())
                                    })?;
                                    let resumed = runtime
                                        .catalog()
                                        .lock()
                                        .map_err(|_| {
                                            KernelError::Storage("catalog owner failed".into())
                                        })?
                                        .resume_context_job_wait(&p.run_id)
                                        .map_err(domain)?;
                                    Ok(serde_json::to_value(resumed)?)
                                })();
                                let response = match result {
                                    Ok(value) => response_ok(&response_id, value),
                                    Err(error) => response_error(&response_id, &error),
                                };
                                done(&response_id);
                                let _ = response_sender.send(response);
                            });
                            deferred = true;
                            return Ok(Value::Null);
                        }
                        if method == "runtime.context_job.list"
                            || method == "runtime.context_job.inspect"
                        {
                            let owner = runtime.catalog();
                            let list = method == "runtime.context_job.list";
                            let reads = if list {
                                let p: HistoryParams = serde_json::from_value(params)?;
                                owner
                                    .lock()
                                    .map_err(|_| {
                                        KernelError::Storage("catalog owner failed".into())
                                    })?
                                    .capture_context_jobs(&p.branch_id)
                                    .map_err(domain)?
                            } else {
                                let p: RunParams = serde_json::from_value(params)?;
                                vec![owner
                                    .lock()
                                    .map_err(|_| {
                                        KernelError::Storage("catalog owner failed".into())
                                    })?
                                    .capture_context_job(&p.run_id)
                                    .map_err(domain)?]
                            };
                            let response_id = id.clone();
                            let response_sender = responses.clone();
                            let done = finished.clone();
                            let cancelled = cancellation.clone();
                            thread::spawn(move || {
                                let result = (|| -> Result<Value, KernelError> {
                                    if cancelled.load(Ordering::Acquire) {
                                        return Err(KernelError::Cancelled);
                                    }
                                    let mut jobs = reads
                                        .into_iter()
                                        .map(|read| read.load().map_err(domain))
                                        .collect::<Result<Vec<_>, _>>()?;
                                    Ok(if list {
                                        serde_json::to_value(jobs)?
                                    } else {
                                        serde_json::to_value(jobs.remove(0))?
                                    })
                                })();
                                let response = match result {
                                    Ok(value) => response_ok(&response_id, value),
                                    Err(error) => response_error(&response_id, &error),
                                };
                                done(&response_id);
                                let _ = response_sender.send(response);
                            });
                            deferred = true;
                            return Ok(Value::Null);
                        }
                        if method == "runtime.context_job.create"
                            || method == "runtime.context_job.publish"
                        {
                            let catalog = runtime.catalog();
                            let create = if method == "runtime.context_job.create" {
                                let p: ContextJobCreateParams =
                                    serde_json::from_value(params.clone())?;
                                Some(prepare_context_job(
                                    &*catalog.lock().map_err(|_| {
                                        KernelError::Storage("catalog owner failed".into())
                                    })?,
                                    p,
                                )?)
                            } else {
                                None
                            };
                            let publish = if create.is_none() {
                                let p: RunParams = serde_json::from_value(params)?;
                                Some(
                                    catalog
                                        .lock()
                                        .map_err(|_| {
                                            KernelError::Storage("catalog owner failed".into())
                                        })?
                                        .prepare_context_job_publication(&p.run_id)
                                        .map_err(domain)?,
                                )
                            } else {
                                None
                            };
                            let response_id = id.clone();
                            let response_sender = responses.clone();
                            let done = finished.clone();
                            let cancelled = cancellation.clone();
                            thread::spawn(move || {
                                let result = (|| -> Result<Value, KernelError> {
                                    if cancelled.load(Ordering::Acquire) {
                                        return Err(KernelError::Cancelled);
                                    }
                                    if let Some(create) = create {
                                        let prepared = create.load().map_err(domain)?;
                                        if cancelled.load(Ordering::Acquire) {
                                            return Err(KernelError::Cancelled);
                                        }
                                        let result = catalog
                                            .lock()
                                            .map_err(|_| {
                                                KernelError::Storage("catalog owner failed".into())
                                            })?
                                            .admit_prepared_context_job(prepared)
                                            .map_err(domain)?;
                                        Ok(serde_json::to_value(result)?)
                                    } else {
                                        let prepared = publish
                                            .expect("publication captured")
                                            .load()
                                            .map_err(domain)?;
                                        if cancelled.load(Ordering::Acquire) {
                                            return Err(KernelError::Cancelled);
                                        }
                                        let result = catalog
                                            .lock()
                                            .map_err(|_| {
                                                KernelError::Storage("catalog owner failed".into())
                                            })?
                                            .publish_prepared_context_job(prepared)
                                            .map_err(domain)?;
                                        Ok(serde_json::to_value(result)?)
                                    }
                                })();
                                let response = match result {
                                    Ok(value) => response_ok(&response_id, value),
                                    Err(error) => response_error(&response_id, &error),
                                };
                                done(&response_id);
                                let _ = response_sender.send(response);
                            });
                            deferred = true;
                            return Ok(Value::Null);
                        }
                        if method == "runtime.history.body" {
                            let p: HistoryBodyParams = serde_json::from_value(params)?;
                            let chunk_index = usize::try_from(p.chunk_index).map_err(|_| {
                                KernelError::Protocol(
                                    "content chunk index must be nonnegative".into(),
                                )
                            })?;
                            let read = runtime
                                .catalog()
                                .lock()
                                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
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
                            })).map_err(|_|KernelError::Storage("content reader unavailable".into()))?;
                            deferred = true;
                            return Ok(Value::Null);
                        }
                        if method == "runtime.plan.reconcile" {
                            let p: RunParams = serde_json::from_value(params)?;
                            crate::plan::reconcile(
                                runtime.clone(),
                                plan_bridge.clone(),
                                p.run_id,
                                id.clone(),
                                responses.clone(),
                                finished.clone(),
                            )?;
                            deferred = true;
                            return Ok(Value::Null);
                        }
                        if method == "runtime.memory.reconcile" {
                            let p: RunParams = serde_json::from_value(params)?;
                            crate::memory::reconcile(
                                runtime.clone(),
                                memory_bridge.clone(),
                                p.run_id,
                                id.clone(),
                                responses.clone(),
                                finished.clone(),
                            )?;
                            deferred = true;
                            return Ok(Value::Null);
                        }
                        if method == "runtime.run.reconcile" {
                            let p: RunReconcileParams = serde_json::from_value(params)?;
                            let binding: crate::tools::ToolBinding =
                                serde_json::from_value(p.tool_binding)?;
                            let operations = {
                                let catalog = runtime.catalog();
                                let catalog = catalog.lock().map_err(|_| {
                                    KernelError::Storage("catalog owner failed".into())
                                })?;
                                let run = catalog.run(&p.run_id).map_err(domain)?;
                                if binding.run_id != run.id || binding.thread_id != run.thread_id {
                                    return Err(KernelError::Authorization(
                                        "reconciliation binding belongs to another Run".into(),
                                    ));
                                }
                                let launch = catalog
                                    .launch_metadata(&run.id)
                                    .map_err(domain)?
                                    .ok_or_else(|| {
                                        KernelError::Authorization(
                                            "reconciliation requires a durable source selection"
                                                .into(),
                                        )
                                    })?;
                                if launch.selection.source.as_ref()
                                    != Some(&binding.source_selection()?)
                                {
                                    return Err(KernelError::Authorization(
                                        "reconciliation cannot change the durable source selection"
                                            .into(),
                                    ));
                                }
                                catalog
                                    .pending_run_operations(&run.id)
                                    .map_err(domain)?
                                    .into_iter()
                                    .filter(|operation| {
                                        matches!(
                                            operation.executor.as_deref(),
                                            Some("file_write" | "file_edit" | "integrate_child")
                                        )
                                    })
                                    .collect::<Vec<_>>()
                            };
                            if operations.is_empty() {
                                return Ok(json!({"reconciled":[],"unresolved":[]}));
                            }
                            crate::reconcile::reconcile(
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
                        let catalog = runtime.catalog();
                        let mut catalog = catalog
                            .lock()
                            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
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
        if let Ok(mut control) = control.owner.lock() {
            *control = None;
        }
    })
}
pub(crate) fn tool_schema(tool: LaunchTool) -> varin_runtime::execution::ToolSchema {
    varin_runtime::execution::ToolSchema {
        name: tool.name,
        version: tool.version,
        description: tool.description,
        schema: tool.schema,
        output_schema: (!tool.output_schema.is_null()).then_some(tool.output_schema),
        metadata: tool.metadata.0,
    }
}
pub(crate) fn extension_binding(
    binding: ExtensionToolBinding,
) -> Result<varin_runtime::catalog::launches::ExtensionToolBinding, KernelError> {
    let result = varin_runtime::catalog::launches::ExtensionToolBinding {
        provider_key: binding.provider_key,
        extension_id: binding.extension_id,
        extension_version: binding.extension_version,
        service_id: binding.service_id,
        service_version: binding
            .service_version
            .try_into()
            .map_err(|_| KernelError::Protocol("negative service version".into()))?,
        artifact_integrity: binding.artifact_integrity,
        declaration_hash: binding.declaration_hash,
        configuration_identity: binding.configuration_identity.0,
        tool: tool_schema(binding.tool),
    };
    result.validate().map_err(domain)?;
    Ok(result)
}
pub(crate) fn live_extension_binding(
    live: LiveExtensionToolBinding,
) -> Result<crate::host_tools::LiveExtensionBinding, KernelError> {
    Ok(crate::host_tools::LiveExtensionBinding {
        owner_id: live.owner_id,
        generation: live
            .generation
            .try_into()
            .map_err(|_| KernelError::Protocol("negative service generation".into()))?,
        binding: extension_binding(live.binding)?,
    })
}
fn mcp_binding(binding: McpBinding) -> Result<crate::host_tools::McpBinding, KernelError> {
    Ok(crate::host_tools::McpBinding {
        reference: binding.reference,
        generation: u64::try_from(binding.generation)
            .map_err(|_| KernelError::Protocol("MCP generation must be nonnegative".into()))?,
        resources: binding.resources,
        tools: binding
            .tools
            .into_iter()
            .map(|tool| varin_runtime::execution::ToolSchema {
                description: tool.description,
                output_schema: (!tool.output_schema.is_null()).then_some(tool.output_schema),
                metadata: tool.metadata.0,
                name: tool.name,
                version: tool.version,
                schema: tool.schema,
            })
            .collect(),
    })
}
pub(crate) fn live_mcp_binding(
    live: LiveMcpBinding,
) -> Result<crate::host_tools::LiveMcpBinding, KernelError> {
    if live.owner_id.is_empty() {
        return Err(KernelError::Authorization(
            "MCP live owner is required".into(),
        ));
    }
    Ok(crate::host_tools::LiveMcpBinding {
        owner_id: live.owner_id,
        binding: mcp_binding(live.binding)?,
    })
}
fn dispatch(catalog: &mut Catalog, method: &str, params: Value) -> Result<Value, KernelError> {
    if method == "runtime.plan.contains" {
        if ["headId", "candidateHeadId"]
            .iter()
            .any(|field| params.get(*field).is_none())
        {
            return Err(KernelError::Protocol(
                "plan visibility requires explicit selected and candidate heads, including null"
                    .into(),
            ));
        }
        let p: PlanContainsParams = serde_json::from_value(params)?;
        return catalog
            .plan_contains(
                &p.branch_id,
                p.head_id.0.as_deref(),
                p.candidate_head_id.0.as_deref(),
                p.cursor.as_deref(),
            )
            .map_err(domain);
    }
    if method == "runtime.plan.view" {
        if params.get("headId").is_none() {
            return Err(KernelError::Protocol(
                "plan view requires an explicit headId, including null".into(),
            ));
        }
        let p: PlanViewParams = serde_json::from_value(params)?;
        let head = if p.current {
            catalog.head(&p.branch_id).map_err(domain)?
        } else {
            p.head_id.0
        };
        return Ok(serde_json::to_value(
            catalog
                .plan_view(&p.branch_id, head.as_deref())
                .map_err(domain)?,
        )?);
    }
    if method == "runtime.history.page" {
        let p: HistoryPageParams = serde_json::from_value(params)?;
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
    if method == "runtime.thread.inspect" {
        let p: ThreadParams = serde_json::from_value(params)?;
        return catalog.inspect_thread(&p.thread_id).map_err(domain);
    }
    if method == "runtime.thread.list" {
        return Ok(serde_json::to_value(
            catalog.list_threads().map_err(domain)?,
        )?);
    }

    match method {
        "runtime.child.sources.pending" => Ok(serde_json::to_value(
            catalog.unaccepted_child_sources().map_err(domain)?,
        )?),
        "runtime.child.sources.release" => {
            let p: OperationParams = serde_json::from_value(params)?;
            catalog
                .mark_unaccepted_child_source_released(&p.operation_id)
                .map_err(domain)?;
            Ok(json!({}))
        }
        "runtime.status" => Ok(
            json!({"epoch":catalog.epoch(),"eventCursor":catalog.event_cursor().map_err(domain)?,"admission":catalog.resource_admission().summary()}),
        ),
        "runtime.admission.inspect" => {
            let p: AdmissionInspectParams = serde_json::from_value(params)?;
            let epoch = u64::try_from(p.owner_generation)
                .map_err(|_| KernelError::Protocol("ownerGeneration must be nonnegative".into()))?;
            let origin = match (p.request_id, p.action_id, p.node_id) {
                (Some(request_id), None, None) => {
                    varin_runtime::execution::ToolOrigin::ModelStep { request_id }
                }
                (None, Some(action_id), Some(node_id)) => {
                    varin_runtime::execution::ToolOrigin::PolicyAction { action_id, node_id }
                }
                _ => {
                    return Err(KernelError::Protocol(
                        "specify a model request or a policy action and node".into(),
                    ))
                }
            };
            let result = catalog
                .inspect_admission(&p.run_id, epoch, &origin, &p.call_id)
                .map_err(domain)?;
            if serde_json::to_vec(&result)?.len() > crate::protocol::MAX_FRAME_BYTES / 2 {
                return Err(KernelError::Protocol(
                    "admission identity exceeds the protocol response budget".into(),
                ));
            }
            Ok(result)
        }
        "runtime.run.scope" => {
            let p: RunParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog.run_context_scope(&p.run_id).map_err(domain)?,
            )?)
        }
        "runtime.run.inspect" | "runtime.run.cancel" => {
            let p: RunParams = serde_json::from_value(params)?;
            if method.ends_with("cancel") {
                Ok(run_cancellation_receipt(
                    &catalog.request_cancel_run(&p.run_id).map_err(domain)?,
                ))
            } else {
                Ok(serde_json::to_value(
                    catalog.run(&p.run_id).map_err(domain)?,
                )?)
            }
        }
        "runtime.observer.read" => {
            let p: ObserverReadParams = serde_json::from_value(params)?;
            let limit = u32::try_from(p.limit)
                .map_err(|_| KernelError::Protocol("observer event limit out of range".into()))?;
            let through_cursor = u64::try_from(p.through_cursor).map_err(|_| {
                KernelError::Protocol("observer through cursor must be nonnegative".into())
            })?;
            Ok(serde_json::to_value(
                catalog
                    .observer_run_activity(&p.observer_id, &p.thread_id, through_cursor, limit)
                    .map_err(domain)?,
            )?)
        }
        "runtime.observer.delivery" => {
            let p: ObserverDeliveryParams = serde_json::from_value(params)?;
            let cursor = u64::try_from(p.cursor)
                .map_err(|_| KernelError::Protocol("observer cursor must be nonnegative".into()))?;
            catalog
                .acknowledge_run_activity(&p.observer_id, &p.thread_id, cursor, p.state)
                .map_err(domain)?;
            Ok(json!({}))
        }
        _ => Err(KernelError::Protocol("unknown runtime method".into())),
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
    let operation = match catalog
        .lock()
        .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
        .operation(&fact.process_id)
    {
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
    varin_runtime::catalog::result_content::record_external_receipt(
        &catalog,
        &fact.process_id,
        ExternalReceipt {
            executor: "process_spawn".into(),
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

pub(crate) fn bind_policy_model(
    run_id: &str,
    capability: &varin_runtime::execution::policy_model::PolicyModelCapability,
    credentials: &crate::credential_bridge::CredentialBridge,
) -> Result<model_session::BoundModel, KernelError> {
    use varin_runtime::execution::policy_model::PolicyModelStatus;
    if capability.status != PolicyModelStatus::Available
        || capability.capability_id.trim().is_empty()
        || capability.purpose != "planning"
        || capability.supported_operation != "tool_free_text"
        || capability
            .configuration_identity
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
    {
        return Err(KernelError::Protocol(
            "invalid available planning capability".into(),
        ));
    }
    let binding_id = capability
        .binding_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            KernelError::Protocol("planning capability requires its own credential binding".into())
        })?;
    let configuration = capability.configuration.clone().ok_or_else(|| {
        KernelError::Protocol("planning capability requires a frozen model configuration".into())
    })?;
    let scope = capability.credential_scope.clone().ok_or_else(|| {
        KernelError::Authorization(
            "planning capability requires its selected Host credential owner".into(),
        )
    })?;
    let resolver = credentials
        .resolver_for_binding(run_id, binding_id, scope.clone())
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

fn personalization_basis(
    value: ContextPersonalization,
) -> Result<varin_runtime::catalog::personalization::PersonalizationBasis, KernelError> {
    Ok(
        varin_runtime::catalog::personalization::PersonalizationBasis {
            configuration_digest: value.configuration_digest,
            memory_snapshot: varin_runtime::catalog::memory::MemorySnapshot {
                revision: value.memory_snapshot.revision.try_into().map_err(|_| {
                    KernelError::Protocol("memory revision must be nonnegative".into())
                })?,
                memories: value.memory_snapshot.memories,
            },
            mode: value.mode,
            thread_role: value.thread_role,
            revision: u64::try_from(value.revision).map_err(|_| {
                KernelError::Protocol("personalization revision must be nonnegative".into())
            })?,
            context_composition: value
                .context_composition
                .map(|composition| {
                    use varin_runtime::composition::context::{
                        ContextComposition, ContextFragment, FragmentKind,
                    };
                    Ok::<_, KernelError>(ContextComposition {
                        provider_id: composition.provider_id,
                        content_version: composition.content_version,
                        scope_id: composition.scope_id,
                        selection_revision: composition.selection_revision.try_into().map_err(
                            |_| {
                                KernelError::Protocol(
                                    "context selection revision must be nonnegative".into(),
                                )
                            },
                        )?,
                        sections: composition
                            .sections
                            .into_iter()
                            .map(|section| {
                                Ok::<_, KernelError>(ContextFragment {
                                    name: section.name,
                                    content: section.content,
                                    kind: match section.kind.as_str() {
                                        "instruction" => FragmentKind::Instruction,
                                        "data" => FragmentKind::Data,
                                        _ => {
                                            return Err(KernelError::Protocol(
                                                "invalid context fragment kind".into(),
                                            ))
                                        }
                                    },
                                })
                            })
                            .collect::<Result<_, _>>()?,
                    })
                })
                .transpose()?,
            session_id: value.session_id,
            project_id: value.project_id.0,
            original_sections: value
                .original_sections
                .into_iter()
                .map(
                    |section| varin_runtime::catalog::personalization::SystemSection {
                        name: section.name,
                        content: section.content,
                    },
                )
                .collect(),
            instruction_sources: value.instruction_sources,
        },
    )
}

fn prepare_context_job(
    catalog: &Catalog,
    p: ContextJobCreateParams,
) -> Result<varin_runtime::catalog::context_jobs::ContextJobPreparation, KernelError> {
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
        extension_bindings: Vec::new(),
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
        owner_run_id: p.owner_run_id,
        personalization: p.personalization.map(personalization_basis).transpose()?,
        key: p.key,
        branch_id: p.branch_id,
        through_id: p.through_id,
        expected_revision: u64::try_from(p.expected_revision)
            .map_err(|_| KernelError::Protocol("context revision must be nonnegative".into()))?,
        effective_system_prompt: p.effective_system_prompt,
        instruction_sources: p.instruction_sources,
        memory_checkpoint: p.memory_checkpoint.0,
    };
    catalog
        .prepare_context_job(request, launch, p.configuration)
        .map_err(domain)
}
#[cfg(test)]
mod run_scope_review {
    use super::*;
    use varin_runtime::catalog::{
        context::ContextProposal, memory::MemorySnapshot, personalization::PersonalizationBasis,
    };

    #[test]
    fn query_reads_only_the_admitted_checkpoint_scope_and_never_inherits_later_branch_context() {
        let root = std::env::temp_dir().join(format!("varin-run-scope-{}", uuid::Uuid::new_v4()));
        let mut catalog = Catalog::open(&root).unwrap();
        catalog.create_thread("thread", "main").unwrap();
        let command = |key: &str, expected_head| varin_runtime::SubmitInput {
            key: key.into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            expected_head,
            input: json!("fixture"),
            configuration: json!({}),
        };
        let preparation = catalog
            .prepare_submission(command("unscoped", None), None, None)
            .unwrap();
        let old = catalog
            .admit_submission(preparation.load(None, false).unwrap())
            .unwrap();
        let query = |catalog: &mut Catalog, run: &str| {
            let params = json!({"runId":run});
            crate::protocol::validate_method_params("runtime.run.scope", &params).unwrap();
            dispatch(catalog, "runtime.run.scope", params)
        };
        assert_eq!(query(&mut catalog, &old.run_id).unwrap(), Value::Null);
        let run = catalog.run(&old.run_id).unwrap();
        catalog
            .transition_run(
                &run.id,
                run.epoch,
                run.revision,
                varin_runtime::RunState::Cancelled,
            )
            .unwrap();
        let basis = PersonalizationBasis {
            mode: "agent".into(),
            thread_role: "main".into(),
            revision: 1,
            configuration_digest: "fixture".into(),
            memory_snapshot: MemorySnapshot {
                revision: 1,
                memories: vec![],
            },
            context_composition: None,
            session_id: "thread".into(),
            project_id: Some("project-A".into()),
            original_sections: vec![],
            instruction_sources: vec![],
        };
        let proposal = ContextProposal {
            key: "project-context".into(),
            branch_id: "main".into(),
            through_id: None,
            expected_revision: 0,
            summary: String::new(),
            effective_system_prompt: "prompt body".into(),
            instruction_sources: vec![],
            memory_checkpoint: None,
        };
        let preparation = catalog
            .prepare_submission(
                command("scoped", Some(old.input_id)),
                Some(proposal),
                Some(basis),
            )
            .unwrap();
        let scoped = catalog
            .admit_submission(preparation.load(None, false).unwrap())
            .unwrap();
        assert_eq!(
            catalog
                .active_context("main")
                .unwrap()
                .unwrap()
                .personalization
                .unwrap()
                .project_id
                .as_deref(),
            Some("project-A")
        );
        // Corrupt only this fixture's body pointer: this control query must never hydrate it.
        let sql = rusqlite::Connection::open(root.join("conversation.sqlite")).unwrap();
        sql.execute(
            "UPDATE context_checkpoints SET body='invalid-body-reference'",
            [],
        )
        .unwrap();
        assert_eq!(query(&mut catalog, &old.run_id).unwrap(), Value::Null);
        assert_eq!(
            query(&mut catalog, &scoped.run_id).unwrap(),
            json!({"mode":"agent","threadRole":"main","sessionId":"thread","projectId":"project-A"})
        );
        assert!(query(&mut catalog, "missing-run").is_err());
        drop(sql);
        drop(catalog);
        std::fs::remove_dir_all(root).unwrap();
    }
}
