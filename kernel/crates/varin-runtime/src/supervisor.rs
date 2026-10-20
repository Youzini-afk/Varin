//! Worker ownership and direct cancellation for admitted Runs.
use crate::execution::*;
use crate::{Catalog, Run, RunState, RuntimeError};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
};
type Result<T> = std::result::Result<T, ExecutionError>;
fn error(error: impl ToString) -> ExecutionError {
    ExecutionError::new("supervisor", error.to_string())
}
#[derive(Clone)]
pub struct RunStart {
    pub context_preparation: Arc<dyn ContextPreparation>,
    pub binding: RequestBinding,
    pub policy_state: Value,
    pub provider: Arc<dyn ModelProvider>,
    pub tools: Arc<dyn ToolExecutor>,
    pub policy: Arc<dyn AgentPolicy>,
    pub progress: ProgressSink,
}
pub struct RunHandle {
    pub run_id: String,
    pub epoch: u64,
    completion: mpsc::Receiver<Result<ExecutionReport>>,
}
impl RunHandle {
    pub fn wait(self) -> Result<ExecutionReport> {
        self.completion.recv().map_err(error)?
    }
    pub fn try_result(&self) -> Result<Option<Result<ExecutionReport>>> {
        match self.completion.try_recv() {
            Ok(result) => Ok(Some(result)),
            Err(mpsc::TryRecvError::Empty) => Ok(None),
            Err(error) => Err(supervisor_error(error)),
        }
    }
}
fn supervisor_error(value: impl ToString) -> ExecutionError {
    error(value)
}
struct PendingLaunch {
    epoch: u64,
    cancel: CancellationToken,
    start: Box<dyn FnOnce(&CancellationToken) -> Result<RunStart> + Send>,
    policy_state: Value,
    completion: mpsc::Sender<Result<ExecutionReport>>,
}
struct Worker {
    parent_run_id: Option<String>,
    cancel: CancellationToken,
    join: Option<JoinHandle<()>>,
    pending: Option<PendingLaunch>,
    // Cancellation-only workers publish this after all body/owner work. Their completion wake
    // may then join the final bookkeeping even before JoinHandle::is_finished becomes visible.
    cancellation_done: Option<Arc<AtomicBool>>,
}
struct OperationWorker {
    run_id: String,
    parent_operation_id: String,
    cancel: CancellationToken,
    join: Option<JoinHandle<()>>,
}
struct RunDrain {
    serial: Mutex<()>,
    active: AtomicBool,
}
fn same_reservation(left: &CancellationToken, right: &CancellationToken) -> bool {
    Arc::ptr_eq(&left.shared_flag(), &right.shared_flag())
}
#[derive(Debug, Clone)]
pub struct WorkerStatus {
    pub run_id: String,
    pub cancellation_requested: bool,
    pub finished: bool,
    pub queued: bool,
}
pub struct RunSupervisor {
    stopping: AtomicBool,
    catalog: Arc<Mutex<Catalog>>,
    workers: Mutex<HashMap<String, Worker>>,
    operation_workers: Mutex<HashMap<String, OperationWorker>>,
    quiescence: Mutex<HashMap<String, Arc<RunDrain>>>,
    failures: Arc<Mutex<HashMap<String, ExecutionError>>>,
    cancellation_failures: Arc<Mutex<HashMap<String, crate::catalog::recovery::PreparationIdentity>>>,
    wake: Arc<Mutex<Option<mpsc::Sender<()>>>>,
}
impl RunSupervisor {
    pub fn new(catalog: Catalog) -> Self {
        Self {
            stopping: AtomicBool::new(false),
            catalog: Arc::new(Mutex::new(catalog)),
            workers: Mutex::new(HashMap::new()),
            operation_workers: Mutex::new(HashMap::new()),
            quiescence: Mutex::new(HashMap::new()),
            failures: Arc::new(Mutex::new(HashMap::new())),
            cancellation_failures: Arc::new(Mutex::new(HashMap::new())),
            wake: Arc::new(Mutex::new(None)),
        }
    }
    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::Acquire)
    }
    pub fn catalog(&self) -> Arc<Mutex<Catalog>> {
        self.catalog.clone()
    }
    /// A typed, nonblocking actor notification. It does not invoke extension callbacks.
    pub fn set_wake_sender(&self, sender: mpsc::Sender<()>) -> Result<()> {
        *self.wake.lock().map_err(error)? = Some(sender);
        Ok(())
    }
    pub fn start(&self, run_id: &str, start: RunStart) -> Result<RunHandle> {
        let policy_state = start.policy_state.clone();
        self.admit_start(run_id, Box::new(move |_| Ok(start)), policy_state)
    }
    /// Reserve the Run before cold assembly. The factory executes on its supervised worker,
    /// after queued admission is promoted, with the same cancellation owner as execution.
    pub fn prepare_start(
        &self,
        run_id: &str,
        prepare: impl FnOnce(&CancellationToken) -> Result<RunStart> + Send + 'static,
    ) -> Result<RunHandle> {
        self.admit_start(run_id, Box::new(prepare), Value::Null)
    }
    fn admit_start(
        &self,
        run_id: &str,
        start: Box<dyn FnOnce(&CancellationToken) -> Result<RunStart> + Send>,
        policy_state: Value,
    ) -> Result<RunHandle> {
        self.reap()?;
        let cancel = CancellationToken::default();
        {
            let quiescence = self.quiescence.lock().map_err(error)?;
            if quiescence
                .get(run_id)
                .is_some_and(|drain| drain.active.load(Ordering::Acquire))
            {
                return Err(ExecutionError::new(
                    "run_already_owned",
                    "the previous Run worker is still relinquishing ownership",
                ));
            }
            let mut workers = self.workers.lock().map_err(error)?;
            if self.stopping.load(Ordering::Acquire) {
                return Err(ExecutionError::new(
                    "supervisor_stopped",
                    "runtime supervisor is shutting down",
                ));
            }
            if workers.contains_key(run_id) {
                return Err(ExecutionError::new(
                    "run_already_owned",
                    "a worker already owns this Run",
                ));
            }
            workers.insert(
                run_id.into(),
                Worker {
                    parent_run_id: None,
                    cancel: cancel.clone(),
                    join: None,
                    pending: None,
                    cancellation_done: None,
                },
            );
        }
        let admission = (|| {
            let catalog = self.catalog.lock().map_err(error)?;
            let run = catalog.run(run_id).map_err(error)?;
            if !catalog.run_startable(run_id).map_err(error)? {
                return Err(ExecutionError::new(
                    "run_not_runnable",
                    "Run is not eligible for worker admission",
                ));
            }
            Ok((
                run.epoch,
                catalog.is_queued_run(run_id).map_err(error)?,
                catalog.context_job_parent(run_id).map_err(error)?,
            ))
        })();
        let (epoch, queued, parent) = match admission {
            Ok(value) => value,
            Err(error) => {
                self.remove_reservation(run_id, &cancel)?;
                return Err(error);
            }
        };
        if let Some(parent) = parent {
            let relation = (|| -> Result<()> {
                {
                    let mut workers = self.workers.lock().map_err(error)?;
                    if workers
                        .get(&parent)
                        .is_some_and(|worker| worker.cancel.is_cancelled())
                    {
                        cancel.cancel();
                    }
                    let worker = workers
                        .get_mut(run_id)
                        .filter(|worker| same_reservation(&worker.cancel, &cancel))
                        .ok_or_else(|| {
                            ExecutionError::new("supervisor_stopped", "worker reservation is gone")
                        })?;
                    worker.parent_run_id = Some(parent.clone());
                }
                let parent = self
                    .catalog
                    .lock()
                    .map_err(error)?
                    .run(&parent)
                    .map_err(error)?;
                if parent.cancel_requested || parent.state == RunState::Cancelled {
                    cancel.cancel();
                }
                Ok(())
            })();
            if let Err(failure) = relation {
                self.remove_reservation(run_id, &cancel)?;
                return Err(failure);
            }
        }
        let (completion, receiver) = mpsc::channel();
        let pending = PendingLaunch {
            epoch,
            cancel: cancel.clone(),
            start,
            policy_state,
            completion,
        };
        if queued {
            let mut workers = self.workers.lock().map_err(error)?;
            let worker = workers
                .get_mut(run_id)
                .filter(|worker| same_reservation(&worker.cancel, &cancel))
                .ok_or_else(|| {
                    ExecutionError::new("supervisor_stopped", "queued admission was cancelled")
                })?;
            worker.pending = Some(pending);
            // Promotion/cancellation can commit between admission and installing this launch.
            // Recheck on an actual notification after its reservation becomes visible.
            drop(workers);
            if let Some(sender) = self.wake.lock().map_err(error)?.as_ref() {
                let _ = sender.send(());
            }
        } else if let Err(error) = self.launch_ready(run_id, pending) {
            self.remove_reservation(run_id, &cancel)?;
            return Err(error);
        }
        Ok(RunHandle {
            run_id: run_id.into(),
            epoch,
            completion: receiver,
        })
    }
    fn remove_reservation(
        &self,
        run_id: &str,
        cancel: &CancellationToken,
    ) -> Result<Option<Worker>> {
        let mut workers = self.workers.lock().map_err(error)?;
        Ok(
            if workers
                .get(run_id)
                .is_some_and(|worker| same_reservation(&worker.cancel, cancel))
            {
                workers.remove(run_id)
            } else {
                None
            },
        )
    }
    fn launch_ready(&self, run_id: &str, pending: PendingLaunch) -> Result<()> {
        // Keep only this short reservation/spawn publication under the control registry. In
        // particular shutdown cannot remove the reservation before its JoinHandle is published.
        let mut workers = self.workers.lock().map_err(error)?;
        let worker = workers
            .get_mut(run_id)
            .filter(|worker| same_reservation(&worker.cancel, &pending.cancel))
            .ok_or_else(|| {
                ExecutionError::new("supervisor_stopped", "worker reservation is gone")
            })?;
        let cancel = worker.cancel.clone();
        let epoch = pending.epoch;
        let failures = self.failures.clone();
        let catalog = self.catalog.clone();
        let identity = run_id.to_string();
        let wake = self.wake.clone();
        let join = thread::Builder::new()
            .name(format!("run-{run_id}"))
            .spawn(move || {
                let mut assembly_complete = false;
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    if cancel.is_cancelled() {
                        if let Some(run) = catalog
                            .lock()
                            .map_err(error)?
                            .cancel_preparing_execution(&identity, epoch)
                            .map_err(error)?
                        {
                            return Ok(ExecutionReport {
                                state: run.state,
                                history: vec![],
                                policy_state: pending.policy_state,
                                model_steps: 0,
                                waiting_on: run.waiting_on,
                                failure: None,
                            });
                        }
                    }
                    {
                        let mut owner = catalog.lock().map_err(error)?;
                        let run = owner.run(&identity).map_err(error)?;
                        if !run.cancel_requested && run.state == RunState::Accepted {
                            owner
                                .transition_run(&identity, epoch, run.revision, RunState::Preparing)
                                .map_err(error)?;
                        }
                    }
                    let start = match (pending.start)(&cancel) {
                        Ok(start) => start,
                        Err(failure) if cancel.is_cancelled() => {
                            if let Some(run) = catalog
                                .lock()
                                .map_err(error)?
                                .cancel_preparing_execution(&identity, epoch)
                                .map_err(error)?
                            {
                                return Ok(ExecutionReport {
                                    state: run.state,
                                    history: vec![],
                                    policy_state: pending.policy_state,
                                    model_steps: 0,
                                    waiting_on: run.waiting_on,
                                    failure: None,
                                });
                            }
                            return Err(failure);
                        }
                        Err(failure) => return Err(failure),
                    };
                    assembly_complete = true;
                    {
                        let mut owner = catalog.lock().map_err(error)?;
                        let run = owner.run(&identity).map_err(error)?;
                        if !run.cancel_requested && run.state == RunState::Preparing {
                            owner
                                .transition_run(&identity, epoch, run.revision, RunState::Runnable)
                                .map_err(error)?;
                        }
                    }
                    let summary = catalog.lock().map_err(error)?.is_context_job(&identity).map_err(error)?;
                    if summary {
                        return crate::context_execution::run(catalog.clone(), &identity, start, cancel.clone());
                    }
                    let binding = start.binding;
                    let policy_state = start.policy_state;
                    let engine = ExecutionEngine {
                        persistence: catalog.clone(),
                        context_preparation: start.context_preparation,
                        provider: start.provider,
                        tools: start.tools,
                        policy: start.policy,
                        progress: start.progress,
                    };
                    loop {
                        if cancel.is_cancelled() {
                            let settled = catalog
                                .lock()
                                .map_err(error)?
                                .cancel_preparing_execution(&identity, epoch)
                                .map_err(error)?;
                            if let Some(run) = settled {
                                return Ok(ExecutionReport {
                                    state: run.state,
                                    history: vec![],
                                    policy_state,
                                    model_steps: 0,
                                    waiting_on: run.waiting_on,
                                    failure: None,
                                });
                            }
                        }
                        let preparation = catalog
                            .lock()
                            .map_err(error)?
                            .capture_recovered_execution(
                                &identity,
                                binding.clone(),
                                engine.policy.identity(),
                                policy_state.clone(),
                                true,
                            )
                            .map_err(error)?;
                        if preparation.cancel_requested() && !cancel.is_cancelled() {
                            cancel.cancel();
                            continue;
                        }
                        let boundary = preparation.identity();
                        let cancelled_before_read = cancel.is_cancelled();
                        // Immutable content reads, hashing and decoding belong to this Run.
                        let prepared = match preparation.load(&cancel) {
                            Ok(Some(prepared)) => prepared,
                            Ok(None) => continue,
                            Err(_) if !cancelled_before_read && cancel.is_cancelled() => continue,
                            Err(failure) => {
                                if !catalog
                                    .lock()
                                    .map_err(error)?
                                    .preparation_is_current(&boundary)
                                    .map_err(error)?
                                {
                                    continue;
                                }
                                return Err(error(failure));
                            }
                        };
                        let launch = catalog
                            .lock()
                            .map_err(error)?
                            .publish_recovered_execution(prepared)
                            .map_err(error)?;
                        let Some(launch) = launch else { continue };
                        if launch.cancel_requested {
                            cancel.cancel();
                        }
                        return engine.run_recovered(launch.input, cancel.clone(), launch.recovery);
                    }
                }))
                .unwrap_or_else(|_| {
                    Err(ExecutionError::new(
                        "worker_panicked",
                        "worker stopped without a completion receipt",
                    ))
                });
                if let Err(error) = &result {
                    if let Ok(mut failures) = failures.lock() {
                        failures.insert(identity.clone(), error.clone());
                    }
                    if let Ok(mut catalog) = catalog.lock() {
                        let commit = (|| -> std::result::Result<(), RuntimeError> {
                            let run = catalog.run(&identity)?;
                            if matches!(catalog.run_stop_reason(&identity, epoch)?, crate::catalog::bot::RunStopReason::BotSuspension(_)) {
                                // Dispatch fences can win before the physical token. Preserve the
                                // original checkpoint rather than failing launch preparation.
                                if catalog.park_bot_run(&identity, epoch).is_ok() { return Ok(()); }
                                return catalog.pause_failed_execution(&identity, epoch, &error.code, &error.message);
                            }
                            let preparation = !assembly_complete
                                && !run.cancel_requested
                                && matches!(
                                    run.state,
                                    RunState::Accepted
                                        | RunState::Preparing
                                        | RunState::Runnable
                                        | RunState::Waiting
                                )
                                && run
                                    .waiting_on
                                    .as_deref()
                                    .is_none_or(|id| id == format!("preparation:{}", identity))
                                && catalog.launch_metadata(&identity)?.is_some();
                            if preparation {
                                let detail = format!("Preparing agent execution: {} ({})", error.message, error.code);
                                catalog.fail_launch_metadata(&identity, "preparation_failed", Some(&detail))?;
                                Ok(())
                            } else {
                                catalog.pause_failed_execution(
                                    &identity,
                                    epoch,
                                    &error.code,
                                    &error.message,
                                )
                            }
                        })();
                        if let Err(commit) = commit {
                            if let Ok(mut failures) = failures.lock() {
                                failures.insert(
                                    identity.clone(),
                                    ExecutionError::new(
                                        "recovery_commit_failed",
                                        format!(
                                            "{}; recovery status could not commit: {commit}",
                                            error.message
                                        ),
                                    ),
                                );
                            }
                        }
                    }
                }
                let _ = pending.completion.send(result);
                if let Ok(wake) = wake.lock() {
                    if let Some(sender) = wake.as_ref() {
                        let _ = sender.send(());
                    }
                };
            })
            .map_err(error)?;
        worker.join = Some(join);
        Ok(())
    }
    /// Called on actual completion/input notifications, never a timer or empty polling loop.
    pub fn advance_pending(&self) -> Result<()> {
        self.reap()?;
        let pending: Vec<String> = self
            .workers
            .lock()
            .map_err(error)?
            .iter()
            .filter(|(_, worker)| worker.pending.is_some())
            .map(|(id, _)| id.clone())
            .collect();
        for id in pending {
            let (queued, run) = {
                let catalog = self.catalog.lock().map_err(error)?;
                (
                    catalog.is_queued_run(&id).map_err(error)?,
                    catalog.run(&id).map_err(error)?,
                )
            };
            if queued && !run.cancel_requested && !run.state.terminal() {
                continue;
            }
            let launch = self
                .workers
                .lock()
                .map_err(error)?
                .get_mut(&id)
                .and_then(|worker| worker.pending.take());
            let Some(launch) = launch else {
                continue;
            };
            if run.cancel_requested || run.state.terminal() {
                let run = if run.state.terminal() {
                    run
                } else {
                    self.cancel(&id)?
                };
                self.remove_reservation(&id, &launch.cancel)?;
                let _ = launch.completion.send(Ok(ExecutionReport {
                    state: run.state,
                    history: vec![],
                    policy_state: launch.policy_state,
                    model_steps: 0,
                    waiting_on: run.waiting_on,
                    failure: None,
                }));
            } else {
                let reply = launch.completion.clone();
                let cancel = launch.cancel.clone();
                let policy_state = launch.policy_state.clone();
                if let Err(failure) = self.launch_ready(&id, launch) {
                    // Cancellation can remove a still-unspawned reservation after promotion.
                    // Its completion is the durable cancellation, not a preparation failure.
                    if cancel.is_cancelled() {
                        if let Some(run) = self
                            .catalog
                            .lock()
                            .map_err(error)?
                            .cancel_preparing_execution(&id, run.epoch)
                            .map_err(error)?
                        {
                            let _ = reply.send(Ok(ExecutionReport {
                                state: run.state,
                                history: vec![],
                                policy_state,
                                model_steps: 0,
                                waiting_on: run.waiting_on,
                                failure: None,
                            }));
                            continue;
                        }
                    }
                    let _ = reply.send(Err(failure.clone()));
                    self.failures
                        .lock()
                        .map_err(error)?
                        .insert(id.clone(), failure.clone());
                    self.catalog
                        .lock()
                        .map_err(error)?
                        .pause_failed_execution(&id, run.epoch, &failure.code, &failure.message)
                        .map_err(error)?;
                    self.remove_reservation(&id, &cancel)?;
                }
            }
        }
        self.reconcile_cancelled_executions()
    }
    pub fn interrupt_generation(&self, run_id: &str) -> bool {
        self.workers
            .lock()
            .map(|workers| {
                workers
                    .get(run_id)
                    .is_some_and(|worker| worker.cancel.cancel_children_with_prefix("model:"))
            })
            .unwrap_or(false)
    }
    pub fn cancel_control(&self, run_id: &str) -> bool {
        if let Ok(workers) = self.operation_workers.lock() { for worker in workers.values().filter(|w|w.run_id==run_id) { worker.cancel.cancel(); } }
        if let Ok(workers) = self.workers.lock() {
            let tokens: Vec<_> = workers
                .iter()
                .filter(|(id, worker)| {
                    id.as_str() == run_id || worker.parent_run_id.as_deref() == Some(run_id)
                })
                .map(|(_, worker)| worker.cancel.clone())
                .collect();
            drop(workers);
            let found = !tokens.is_empty();
            for token in tokens {
                token.cancel();
            }
            return found;
        }
        false
    }
    pub fn cancel_operation_control(&self, operation_id: &str) -> bool {
        let mut found = false;
        if let Ok(workers) = self.operation_workers.lock() { for (id,worker) in workers.iter() { if id==operation_id || worker.parent_operation_id==operation_id { worker.cancel.cancel(); found=true; } } }
        self.workers
            .lock()
            .map(|workers| {
                workers
                    .values()
                    .fold(found, |found,worker| worker.cancel.cancel_child(operation_id) || found)
            })
            .unwrap_or(false)
    }
    /// The question wait was durably committed, so its worker has no further execution work.
    /// Join its final teardown before an answer can make the same Run runnable again.
    pub fn reconcile_goal_waits(&self) -> Result<()> {
        let runs = self
            .catalog
            .lock()
            .map_err(error)?
            .goal_waiting_runs()
            .map_err(error)?;
        for run in runs {
            self.quiesce_run(&run, |r| {
                r.state == RunState::Waiting
                    && r.waiting_on
                        .as_deref()
                        .is_some_and(|w| w.starts_with("goal-wait:"))
            })?;
            self.catalog
                .lock()
                .map_err(error)?
                .release_goal_wait(&run)
                .map_err(error)?;
        }
        Ok(())
    }
    pub fn reconcile_observations(&self) -> Result<Vec<String>> {
        self.catalog
            .lock()
            .map_err(error)?
            .reconcile_waits()
            .map_err(error)?;
        // Child reports and fixed file results remain in their original producer/receipt owner.
        // An unreadable report is retained as an error, not a gate for unrelated observations.
        let mut failure = crate::catalog::child_delivery::reconcile_reports(&self.catalog)
            .err()
            .map(error);
        let progress = (|| {
            self.catalog
                .lock()
                .map_err(error)?
                .interrupt_request_observations()
                .map_err(error)?;
            self.quiesce_observations()?;
            loop {
                let before = self
                    .catalog
                    .lock()
                    .map_err(error)?
                    .observation_positions()
                    .map_err(error)?;
                self.catalog
                    .lock()
                    .map_err(error)?
                    .select_ready_observations()
                    .map_err(error)?;
                // Evaluate every original consumer even when another content owner failed. Each
                // consumer still validates its own Run/Wait and publication boundary before writing.
                for result in [
                    crate::catalog::child_delivery::deliver_waits(&self.catalog),
                    crate::catalog::process_delivery::deliver_waits(&self.catalog),
                    crate::catalog::messages::reply_wait::deliver_waits(&self.catalog),
                    crate::catalog::followups::observation::deliver_waits(&self.catalog),
                    crate::catalog::computer_wait::deliver_waits(&self.catalog),
                ] {
                    if let Err(cause) = result {
                        failure.get_or_insert_with(|| error(cause));
                    }
                }
                let after = self
                    .catalog
                    .lock()
                    .map_err(error)?
                    .observation_positions()
                    .map_err(error)?;
                if before == after || after.is_empty() {
                    break;
                }
            }
            self.catalog
                .lock()
                .map_err(error)?
                .pending_observation_continuations()
                .map_err(error)
        })();
        if let Some(failure) = failure {
            return Err(failure);
        }
        progress
    }
    pub fn reconcile_message_requests(&self) -> Result<()> {
        let cancellation = self.reconcile_cancelled_executions();
        let observations = self.reconcile_observations();
        // Legal request activation is a separate ingress owner. Its original guards decide
        // eligibility; a failed, unrelated observation cannot suppress this event-driven pass.
        let activation = crate::catalog::activation::reconcile(&self.catalog).map_err(error);
        observations?;
        activation?;
        cancellation?;
        Ok(())
    }

    /// A committed cancellation may outlive its original worker. Restore only original
    /// receipt/history pairing on the existing event-driven continuation pass, without launch.
    pub fn reconcile_cancelled_executions(&self) -> Result<()> {
        self.reap()?;
        let runs = self.catalog.lock().map_err(error)?
            .cancelled_recovery_runs().map_err(error)?;
        let mut failure = None;
        for run in runs {
            if let Err(error) = self.start_cancelled_recovery(&run) {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }

    fn start_cancelled_recovery(&self, run_id: &str) -> Result<()> {
        let cancel = CancellationToken::default();
        cancel.cancel();
        let done = Arc::new(AtomicBool::new(false));
        {
            let quiescence = self.quiescence.lock().map_err(error)?;
            if quiescence.get(run_id).is_some_and(|drain| drain.active.load(Ordering::Acquire)) {
                return Ok(());
            }
            let mut workers = self.workers.lock().map_err(error)?;
            if self.stopping.load(Ordering::Acquire) || workers.contains_key(run_id) {
                return Ok(());
            }
            workers.insert(run_id.into(), Worker {
                parent_run_id: None, cancel: cancel.clone(), join: None, pending: None,
                cancellation_done: Some(done.clone()),
            });
        }
        let preparation = (|| {
            let mut owner = self.catalog.lock().map_err(error)?;
            let failed = self.cancellation_failures.lock().map_err(error)?.get(run_id).cloned();
            if failed.as_ref().is_some_and(|boundary| owner.preparation_is_current(boundary).unwrap_or(false)) {
                return Ok(None);
            }
            owner.capture_cancelled_recovery(run_id).map_err(error)
        })();
        let preparation = match preparation {
            Ok(Some(preparation)) => preparation,
            result => {
                self.remove_reservation(run_id, &cancel)?;
                return result.map(|_| ());
            }
        };
        let catalog = self.catalog.clone();
        let failures = self.failures.clone();
        let cancellation_failures = self.cancellation_failures.clone();
        let wake = self.wake.clone();
        let identity = run_id.to_owned();
        let mut workers = self.workers.lock().map_err(error)?;
        let Some(worker) = workers.get_mut(run_id)
            .filter(|worker| same_reservation(&worker.cancel, &cancel)) else { return Ok(()) };
        let join = thread::Builder::new().name(format!("cancel-recovery-{run_id}"))
            .spawn(move || {
                let mut last_boundary = preparation.identity().clone();
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<()> {
                    let mut preparation = preparation;
                    loop {
                        let boundary = preparation.identity().clone();
                        last_boundary = boundary.clone();
                        // Original immutable bodies and serialization remain outside Catalog.
                        let loaded = preparation.load();
                        let mut owner = catalog.lock().map_err(error)?;
                        if owner.run(&identity).map_err(error)?.state.terminal() { return Ok(()); }
                        match loaded {
                            Ok(prepared) => {
                                if owner.publish_cancelled_recovery(prepared).map_err(error)? {
                                    return Ok(());
                                }
                            }
                            Err(failure) => {
                                if owner.preparation_is_current(&boundary).map_err(error)? {
                                    return Err(error(failure));
                                }
                            }
                        }
                        let Some(next) = owner.capture_cancelled_recovery(&identity).map_err(error)? else {
                            return Ok(());
                        };
                        preparation = next;
                    }
                })).unwrap_or_else(|_| Err(ExecutionError::new(
                    "cancel_recovery_panicked", "Cancelled exchange recovery stopped before publication",
                )));
                if let Ok(mut blocked) = cancellation_failures.lock() {
                    if result.is_err() { blocked.insert(identity.clone(), last_boundary); }
                    else { blocked.remove(&identity); }
                }
                // An observed failure must already be reapable: a user's explicit retry can
                // then clear that boundary even if this thread has not returned yet.
                done.store(true, Ordering::Release);
                if let Ok(mut failures) = failures.lock() {
                    if let Err(failure) = result { failures.insert(identity.clone(), failure); }
                    else { failures.remove(&identity); }
                }
                // Wake after publishing the completion fence. A receipt arriving while this
                // worker unwinds cannot be lost; unchanged failed boundaries do not self-retry.
                if let Ok(wake) = wake.lock() {
                    if let Some(sender) = wake.as_ref() { let _ = sender.send(()); }
                }
            }).map_err(error);
        match join {
            Ok(join) => { worker.join = Some(join); Ok(()) }
            Err(failure) => { workers.remove(run_id); Err(failure) }
        }
    }
    pub fn resume_policy_pause(
        &self,
        run_id: &str,
        wait_id: &str,
    ) -> Result<crate::catalog::policy_control::PolicyResumeReceipt> {
        if let Some(receipt) = self
            .catalog
            .lock()
            .map_err(error)?
            .policy_resume_receipt(run_id, wait_id)
            .map_err(error)?
        {
            return Ok(receipt);
        }
        self.quiesce_run(run_id, |run| {
            run.state == RunState::Waiting && run.waiting_on.as_deref() == Some(wait_id)
        })?;
        let mut catalog = self.catalog.lock().map_err(error)?;
        let epoch = catalog.epoch();
        catalog
            .resume_policy_pause(run_id, wait_id, epoch)
            .map_err(error)
    }
    /// Read-only overlay for launch consumers; the catalog still owns durable eligibility.
    pub fn start_available(&self, run_id: &str) -> Result<bool> {
        let quiescence = self.quiescence.lock().map_err(error)?;
        if quiescence
            .get(run_id)
            .is_some_and(|drain| drain.active.load(Ordering::Acquire))
        {
            return Ok(false);
        }
        let workers = self.workers.lock().map_err(error)?;
        Ok(workers
            .get(run_id)
            .is_none_or(|worker| worker.join.as_ref().is_some_and(JoinHandle::is_finished)))
    }
    pub fn quiesce_question(&self, operation_id: &str) -> Result<()> {
        let run_id = {
            let catalog = self.catalog.lock().map_err(error)?;
            let operation = catalog.operation(operation_id).map_err(error)?;
            let run = catalog.run(&operation.run_id).map_err(error)?;
            if run.state != RunState::Waiting
                || run.waiting_on != operation.waiting_on
                || operation.executor.as_deref() != Some("ask_user")
            {
                return Ok(());
            }
            run.id
        };
        self.quiesce_run(&run_id, |run| {
            run.state == RunState::Waiting
                && run.waiting_on.as_deref() == Some(&format!("question:{operation_id}"))
        })
    }
    pub fn quiesce_context_job(&self, job_id: &str) -> Result<()> {
        let parent = self
            .catalog
            .lock()
            .map_err(error)?
            .context_job_waiter(job_id)
            .map_err(error)?;
        let Some(parent) = parent else {
            return Ok(());
        };
        let wait_id = format!("context-wait:{parent}:{job_id}");
        self.quiesce_run(&parent, |run| {
            run.state == RunState::Waiting && run.waiting_on.as_deref() == Some(&wait_id)
        })
    }
    /// Each waiter shares its Run's teardown. No Catalog or global worker lock crosses join.
    /// Joins the terminal Run worker. Storage file leases must also be drained separately.
    pub fn suspend_bot_scope(&self, suspension: crate::catalog::bot::BotSuspension) -> Result<crate::catalog::bot::BotScopeCapture> {
        let capture = self.catalog.lock().map_err(error)?.suspend_bot_scope(suspension).map_err(error)?;
        for run in &capture.run_ids { self.cancel_control(run); }
        Ok(capture)
    }
    /// Must run off the control actor. Joining actual Rust owners is separate from
    /// original Host/Computer receipts; no acknowledgement is promoted to a stop fact.
    pub fn drain_bot_scope(&self, capture: &crate::catalog::bot::BotScopeCapture) -> Result<crate::catalog::bot::BotKernelScopeStatus> {
        if self.catalog.lock().map_err(error)?.epoch() != capture.kernel_epoch { return Err(error("Scope drain belongs to another kernel epoch")); }
        for run in &capture.run_ids { self.cancel_control(run); }
        for run in &capture.run_ids {
            self.quiesce_run_workers(run, |_| true, true)?;
            let mut catalog = self.catalog.lock().map_err(error)?;
            let original = catalog.run(run).map_err(error)?;
            if !original.state.terminal() && matches!(catalog.run_stop_reason(run, original.epoch).map_err(error)?, crate::catalog::bot::RunStopReason::BotSuspension(_)) {
                catalog.park_bot_run(run, original.epoch).map_err(error)?;
            }
        }
        self.bot_scope_status_for_runs(&capture.suspension, &capture.run_ids)
    }
    pub fn bot_scope_status(&self, suspension: &crate::catalog::bot::BotSuspension) -> Result<crate::catalog::bot::BotKernelScopeStatus> {
        let runs = self.catalog.lock().map_err(error)?.bot_scope_run_ids(&suspension.bot_id).map_err(error)?;
        self.bot_scope_status_for_runs(suspension, &runs)
    }
    fn bot_scope_status_for_runs(&self, suspension: &crate::catalog::bot::BotSuspension, runs: &[String]) -> Result<crate::catalog::bot::BotKernelScopeStatus> {
        let catalog = self.catalog.lock().map_err(error)?;
        let source_profile_revision = catalog.bot_scope_source_revision(suspension).map_err(error)?;
        let mut unproven_operation_stop_ids = Vec::new();
        let mut unknown_effect_operation_ids = Vec::new();
        let mut unresolved_model_request_ids = Vec::new();
        for run in runs {
            let (stops, effects, models) = catalog.bot_run_barriers(run).map_err(error)?;
            unproven_operation_stop_ids.extend(stops);
            unknown_effect_operation_ids.extend(effects);
            unresolved_model_request_ids.extend(models);
        }
        let kernel_epoch = catalog.epoch();
        drop(catalog);
        let current_kernel_workers_drained = !self.workers.lock().map_err(error)?.keys().any(|id|runs.contains(id))
            && !self.operation_workers.lock().map_err(error)?.values().any(|worker|runs.contains(&worker.run_id))
            && !self.quiescence.lock().map_err(error)?.iter().any(|(id,drain)|runs.contains(id)&&drain.active.load(Ordering::Acquire));
        Ok(crate::catalog::bot::BotKernelScopeStatus { suspension:suspension.clone(), kernel_epoch, source_profile_revision, current_kernel_workers_drained, unproven_operation_stop_ids, unknown_effect_operation_ids, unresolved_model_request_ids })
    }
    pub fn resume_bot_scope(&self, suspension: &crate::catalog::bot::BotSuspension) -> Result<crate::catalog::bot::BotScopeResume> {
        let runs = {
            let catalog = self.catalog.lock().map_err(error)?;
            catalog.check_bot_scope_gate(suspension, Some(true)).map_err(error)?;
            catalog.bot_held_run_ids(suspension).map_err(error)?
        };
        let draining = self.workers.lock().map_err(error)?.keys().any(|id|runs.contains(id))
            || self.operation_workers.lock().map_err(error)?.values().any(|worker|runs.contains(&worker.run_id))
            || self.quiescence.lock().map_err(error)?.iter().any(|(id,drain)|runs.contains(id)&&drain.active.load(Ordering::Acquire));
        if draining { return Err(error("Original held kernel workers are still draining")); }
        self.catalog.lock().map_err(error)?.resume_bot_scope(suspension).map_err(error)
    }

    pub fn quiesce_terminal(&self, run_id: &str) -> Result<()> {
        self.quiesce_run(run_id, |run| {
            matches!(
                run.state,
                RunState::Completed | RunState::Failed | RunState::Cancelled
            )
        })
    }
    fn quiesce_run(&self, run_id: &str, waiting: impl Fn(&Run) -> bool) -> Result<()> {
        self.quiesce_run_workers(run_id, waiting, false)
    }
    fn quiesce_run_workers(&self, run_id: &str, waiting: impl Fn(&Run) -> bool, operations: bool) -> Result<()> {
        let serial = self
            .quiescence
            .lock()
            .map_err(error)?
            .entry(run_id.into())
            .or_insert_with(|| {
                Arc::new(RunDrain {
                    serial: Mutex::new(()),
                    active: AtomicBool::new(true),
                })
            })
            .clone();
        let guard = serial.serial.lock().map_err(error)?;
        let result = (|| {
            if !waiting(
                &self
                    .catalog
                    .lock()
                    .map_err(error)?
                    .run(run_id)
                    .map_err(error)?,
            ) {
                return Ok(());
            }
            serial.active.store(true, Ordering::Release);
            let worker = self.workers.lock().map_err(error)?.remove(run_id);
            if let Some(mut worker) = worker {
                if let Some(join) = worker.join.take() {
                    join.join().map_err(|_| error("Run wait teardown failed"))?;
                }
                if let Some(pending) = worker.pending.take().filter(|_| operations) {
                    let run = self.catalog.lock().map_err(error)?.park_bot_run(run_id, pending.epoch).map_err(error)?;
                    let _ = pending.completion.send(Ok(ExecutionReport { state:run.state, history:vec![], policy_state:pending.policy_state, model_steps:0, waiting_on:run.waiting_on, failure:None }));
                }
            }
            if operations {
                let joins = {
                    let mut workers = self.operation_workers.lock().map_err(error)?;
                    let ids: Vec<_> = workers.iter().filter(|(_,worker)|worker.run_id==run_id).map(|(id,_)|id.clone()).collect();
                    ids.into_iter().filter_map(|id|workers.remove(&id).and_then(|worker|worker.join)).collect::<Vec<_>>()
                };
                for join in joins { join.join().map_err(|_| error("Operation suspension teardown failed"))?; }
            }
            Ok(())
        })();
        // Other callers may still be leaving this rendezvous; only the real worker blocks start.
        serial.active.store(false, Ordering::Release);
        drop(guard);
        let mut entries = self.quiescence.lock().map_err(error)?;
        if Arc::strong_count(&serial) == 2 {
            entries.remove(run_id);
        }
        result
    }
    fn quiesce_waits(&self, prefix: &str) -> Result<()> {
        let mut ids: std::collections::BTreeSet<String> = self
            .workers
            .lock()
            .map_err(error)?
            .keys()
            .cloned()
            .collect();
        ids.extend(self.quiescence.lock().map_err(error)?.keys().cloned());
        for id in ids {
            let waiting = |run: &Run| {
                run.state == RunState::Waiting
                    && run
                        .waiting_on
                        .as_deref()
                        .is_some_and(|key| key.starts_with(prefix))
            };
            if waiting(
                &self
                    .catalog
                    .lock()
                    .map_err(error)?
                    .run(&id)
                    .map_err(error)?,
            ) {
                self.quiesce_run(&id, waiting)?;
            }
        }
        Ok(())
    }
    /// A persisted child Wait has relinquished the history writer. Join only final teardown,
    /// never a running model/tool, before its durable report makes that same Run runnable.
    pub fn quiesce_observations(&self) -> Result<()> {
        self.quiesce_child_waits()?;
        self.quiesce_waits(crate::catalog::host_jobs::WAIT_PREFIX)?;
        self.quiesce_waits(crate::catalog::computer_wait::PREFIX)?;
        self.quiesce_process_waits()?;
        self.quiesce_waits("reply-wait:")
    }
    pub fn quiesce_child_waits(&self) -> Result<()> {
        self.quiesce_waits("child-wait:")
    }
    pub fn quiesce_process_waits(&self) -> Result<()> {
        self.quiesce_waits("process-wait:")
    }
    pub fn cancel_operation(&self, operation_id: &str) -> Result<crate::OperationMetadata> {
        {
            let mut catalog = self.catalog.lock().map_err(error)?;
            let op = catalog.operation(operation_id).map_err(error)?;
            if op
                .waiting_on
                .as_deref()
                .is_some_and(crate::catalog::observations::is_observation_id)
            {
                return catalog.cancel_observation(operation_id).map_err(error);
            }
        }
        self.cancel_operation_control(operation_id);
        self.catalog
            .lock()
            .map_err(error)?
            .request_cancel_operation(operation_id)
            .map_err(error)
    }
    pub fn cancel(&self, run_id: &str) -> Result<Run> {
        self.cancel_control(run_id);
        self.reap()?;
        let (no_execution, launch) = {
            let mut workers = self.workers.lock().map_err(error)?;
            let no_execution = workers
                .get(run_id)
                .is_none_or(|worker| worker.join.is_none());
            let launch = if no_execution {
                let worker = workers.entry(run_id.into()).or_insert_with(|| Worker {
                    parent_run_id: None,
                    cancel: CancellationToken::default(),
                    join: None,
                    pending: None,
                    cancellation_done: None,
                });
                worker.cancel.cancel();
                worker.pending.take()
            } else {
                None
            };
            (no_execution, launch)
        };
        // The cancelled reservation fences concurrent start without holding the control registry
        // while the durable catalog is busy. Other Runs' emergency cancellation stays independent.
        let result = (|| {
            let mut catalog = self.catalog.lock().map_err(error)?;
            let mut run = catalog.request_cancel_run(run_id).map_err(error)?;
            if !run.state.terminal() {
                // Pure preparation has no outstanding effect to await. Fence its late worker
                // now; dispatched requests and unclosed tool exchanges still require receipts.
                if let Some(settled) = catalog
                    .cancel_preparing_execution(run_id, run.epoch)
                    .map_err(error)?
                {
                    run = settled;
                }
            }
            Ok(run)
        })();
        if no_execution {
            self.workers.lock().map_err(error)?.remove(run_id);
        }
        if let Some(launch) = launch {
            let report = result
                .as_ref()
                .map(|run| ExecutionReport {
                    state: run.state,
                    history: vec![],
                    policy_state: launch.policy_state,
                    model_steps: 0,
                    waiting_on: run.waiting_on.clone(),
                    failure: None,
                })
                .map_err(Clone::clone);
            let _ = launch.completion.send(report);
        }
        if let Ok(wake) = self.wake.lock() {
            if let Some(sender) = wake.as_ref() {
                let _ = sender.send(());
            }
        };
        if no_execution && result.as_ref().is_ok_and(|run| !run.state.terminal()) {
            self.cancellation_failures.lock().map_err(error)?.remove(run_id);
            self.start_cancelled_recovery(run_id)?;
        }
        result
    }
    pub fn execution_failure(&self, run_id: &str) -> Result<Option<ExecutionError>> {
        Ok(self.failures.lock().map_err(error)?.get(run_id).cloned())
    }
    pub fn status(&self) -> Result<Vec<WorkerStatus>> {
        Ok(self
            .workers
            .lock()
            .map_err(error)?
            .iter()
            .map(|(id, worker)| WorkerStatus {
                run_id: id.clone(),
                cancellation_requested: worker.cancel.is_cancelled(),
                finished: worker.join.as_ref().is_some_and(JoinHandle::is_finished),
                queued: worker.pending.is_some(),
            })
            .collect())
    }
    /// Independent, Catalog-owned operation execution. Direct control remains in this supervisor.
    pub fn start_operation(
        self: &Arc<Self>,
        operation_id: &str,
        parent_operation_id: &str,
        run_id: &str,
        execute: impl FnOnce(&CancellationToken) -> Result<()> + Send + 'static,
    ) -> Result<()> {
        let operation = self.catalog.lock().map_err(error)?.operation(operation_id).map_err(error)?;
        if operation.run_id != run_id { return Err(error("Operation worker Run identity changed")); }
        let kernel_owner = operation.execution_owner == Some(crate::ExecutorOwner::Kernel);
        let operation_epoch = operation.epoch;
        let token = CancellationToken::default();
        let mut workers = self.operation_workers.lock().map_err(error)?;
        if self.stopping.load(Ordering::Acquire) {
            return Err(error("runtime is stopping"));
        }
        if workers.contains_key(operation_id) {
            return Ok(());
        }
        let token_worker = token.clone();
        let owner = self.clone();
        let id = operation_id.to_owned();
        let join = thread::Builder::new()
            .name("model-operation".into())
            .spawn(move || {
                let result = execute(&token_worker);
                if kernel_owner {
                    let stopped = owner.catalog.lock().map_err(error).and_then(|mut catalog|catalog.record_kernel_operation_worker_stopped(&id, operation_epoch).map_err(error));
                    if let Err(failure) = stopped { if let Ok(mut errors) = owner.failures.lock() { errors.insert(id.clone(), failure); } }
                }
                if let Err(failure) = result {
                    if let Ok(mut errors) = owner.failures.lock() {
                        errors.insert(id, failure);
                    }
                }
                if let Ok(wake) = owner.wake.lock() {
                    if let Some(wake) = wake.as_ref() {
                        let _ = wake.send(());
                    }
                }
            })
            .map_err(error)?;
        workers.insert(
            operation_id.into(),
            OperationWorker {
                run_id: run_id.into(),
                parent_operation_id: parent_operation_id.into(),
                cancel: token,
                join: Some(join),
            },
        );
        Ok(())
    }
    /// Durable Goal/source/interaction fences signal live operations without waiting for body I/O.
    pub fn reconcile_operation_controls(&self) -> Result<()> {
        let entries: Vec<_> = self.operation_workers.lock().map_err(error)?
            .iter().map(|(id, worker)| (id.clone(), worker.cancel.clone())).collect();
        let catalog = self.catalog.lock().map_err(error)?;
        for (id, token) in entries {
            let live = catalog.operation(&id).ok().is_some_and(|op| {
                if op.executor.as_deref() == Some("inference.model.v1") { catalog.inference_generation_live(&id).unwrap_or(false) }
                else { catalog.sampling_generation_live(&id).unwrap_or(false) }
            });
            if !live {
                token.cancel();
            }
        }
        Ok(())
    }
    pub fn reap(&self) -> Result<()> {
        self.reconcile_operation_controls()?;
        let completed_operations = {
            let mut workers = self.operation_workers.lock().map_err(error)?;
            let ids: Vec<_> = workers.iter()
                .filter(|(_, worker)| worker.join.as_ref().is_some_and(JoinHandle::is_finished))
                .map(|(id, _)| id.clone()).collect();
            ids.into_iter()
                .filter_map(|id| workers.remove(&id).and_then(|worker| worker.join))
                .collect::<Vec<_>>()
        };
        for join in completed_operations {
            join.join().map_err(|_| error("operation worker panicked"))?;
        }
        let completed = {
            let mut workers = self.workers.lock().map_err(error)?;
            let ids: Vec<_> = workers
                .iter()
                .filter(|(_, worker)| worker.join.as_ref().is_some_and(JoinHandle::is_finished)
                    || worker.cancellation_done.as_ref().is_some_and(|done| done.load(Ordering::Acquire)))
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| workers.remove(&id).and_then(|worker| worker.join))
                .collect::<Vec<_>>()
        };
        for join in completed {
            join.join()
                .map_err(|_| ExecutionError::new("worker_panicked", "worker panicked"))?;
        }
        Ok(())
    }
    pub fn shutdown(&self) -> Result<()> {
        self.stopping.store(true, Ordering::Release);
        let operations = {
            let mut workers = self.operation_workers.lock().map_err(error)?;
            for worker in workers.values() {
                worker.cancel.cancel();
            }
            std::mem::take(&mut *workers)
        };
        for (_, worker) in operations {
            if let Some(join) = worker.join {
                join.join().map_err(|_| error("operation worker panicked"))?;
            }
        }
        {
            let catalog = self.catalog.lock().map_err(error)?;
            catalog.stop_followup_admission();
            catalog.cancel_content_collection();
        }
        let workers = {
            let mut workers = self.workers.lock().map_err(error)?;
            for worker in workers.values() {
                worker.cancel.cancel();
            }
            std::mem::take(&mut *workers)
        };
        for (_, worker) in workers {
            if let Some(join) = worker.join {
                join.join()
                    .map_err(|_| ExecutionError::new("worker_panicked", "worker panicked"))?;
            }
        }
        Ok(())
    }
}
impl From<RuntimeError> for ExecutionError {
    fn from(value: RuntimeError) -> Self {
        error(value)
    }
}

#[cfg(test)]
#[path = "supervisor_wait_tests.rs"]
mod wait_tests;
