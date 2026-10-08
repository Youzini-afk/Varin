//! Worker ownership and direct cancellation for admitted native Runs.
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
    start: RunStart,
    completion: mpsc::Sender<Result<ExecutionReport>>,
}
struct Worker {
    cancel: CancellationToken,
    join: Option<JoinHandle<()>>,
    pending: Option<PendingLaunch>,
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
    failures: Arc<Mutex<HashMap<String, ExecutionError>>>,
    wake: Arc<Mutex<Option<mpsc::Sender<()>>>>,
}
impl RunSupervisor {
    pub fn new(catalog: Catalog) -> Self {
        Self {
            stopping: AtomicBool::new(false),
            catalog: Arc::new(Mutex::new(catalog)),
            workers: Mutex::new(HashMap::new()),
            failures: Arc::new(Mutex::new(HashMap::new())),
            wake: Arc::new(Mutex::new(None)),
        }
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
        self.reap()?;
        let cancel = CancellationToken::default();
        {
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
                    cancel,
                    join: None,
                    pending: None,
                },
            );
        }
        let admission = (|| {
            let catalog = self.catalog.lock().map_err(error)?;
            let run = catalog.run(run_id).map_err(error)?;
            if run.cancel_requested || run.state.terminal() {
                return Err(ExecutionError::new(
                    "run_not_runnable",
                    "Run is cancelled or terminal",
                ));
            }
            Ok((run.epoch, catalog.is_queued_run(run_id).map_err(error)?))
        })();
        let (epoch, queued) = match admission {
            Ok(value) => value,
            Err(error) => {
                self.workers
                    .lock()
                    .map_err(supervisor_error)?
                    .remove(run_id);
                return Err(error);
            }
        };
        let (completion, receiver) = mpsc::channel();
        let pending = PendingLaunch { start, completion };
        if queued {
            let mut workers = self.workers.lock().map_err(error)?;
            let worker = workers.get_mut(run_id).ok_or_else(|| {
                ExecutionError::new("supervisor_stopped", "queued admission was cancelled")
            })?;
            worker.pending = Some(pending);
        } else if let Err(error) = self.launch_ready(run_id, pending) {
            self.workers
                .lock()
                .map_err(supervisor_error)?
                .remove(run_id);
            return Err(error);
        }
        Ok(RunHandle {
            run_id: run_id.into(),
            epoch,
            completion: receiver,
        })
    }
    fn launch_ready(&self, run_id: &str, pending: PendingLaunch) -> Result<()> {
        let cancel = {
            let workers = self.workers.lock().map_err(error)?;
            workers
                .get(run_id)
                .map(|worker| worker.cancel.clone())
                .ok_or_else(|| {
                    ExecutionError::new("supervisor_stopped", "worker reservation is gone")
                })?
        };
        let (input, recovery) = self
            .catalog
            .lock()
            .map_err(error)?
            .prepare_recovered_execution(
                run_id,
                pending.start.binding,
                pending.start.policy.identity(),
                pending.start.policy_state,
            )
            .map_err(error)?;
        let epoch = input.owner_generation;
        let engine = ExecutionEngine {
            persistence: self.catalog.clone(),
            provider: pending.start.provider,
            tools: pending.start.tools,
            policy: pending.start.policy,
            progress: pending.start.progress,
        };
        let failures = self.failures.clone();
        let catalog = self.catalog.clone();
        let identity = run_id.to_string();
        let wake = self.wake.clone();
        let join = thread::Builder::new()
            .name(format!("native-run-{run_id}"))
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    engine.run_recovered(input, cancel, recovery)
                }))
                .unwrap_or_else(|_| {
                    Err(ExecutionError::new(
                        "worker_panicked",
                        "native worker stopped without a completion receipt",
                    ))
                });
                if let Err(error) = &result {
                    if let Ok(mut failures) = failures.lock() {
                        failures.insert(identity.clone(), error.clone());
                    }
                    if let Ok(mut catalog) = catalog.lock() {
                        if let Err(commit) = catalog.pause_failed_execution(
                            &identity,
                            epoch,
                            &error.code,
                            &error.message,
                        ) {
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
        let mut workers = self.workers.lock().map_err(error)?;
        if let Some(worker) = workers.get_mut(run_id) {
            worker.join = Some(join);
        } else {
            drop(workers);
            let _ = join.join();
            return Err(ExecutionError::new(
                "supervisor_stopped",
                "worker admission was cancelled by shutdown",
            ));
        }
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
                self.workers.lock().map_err(error)?.remove(&id);
                let _ = launch.completion.send(Ok(ExecutionReport {
                    state: run.state,
                    history: vec![],
                    policy_state: launch.start.policy_state,
                    model_steps: 0,
                    waiting_on: run.waiting_on,
                    failure: None,
                }));
            } else {
                let reply = launch.completion.clone();
                if let Err(failure) = self.launch_ready(&id, launch) {
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
                    self.workers.lock().map_err(error)?.remove(&id);
                }
            }
        }
        Ok(())
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
        if let Ok(workers) = self.workers.lock() {
            if let Some(worker) = workers.get(run_id) {
                worker.cancel.cancel();
                return true;
            }
        }
        false
    }
    pub fn cancel_operation_control(&self, operation_id: &str) -> bool {
        self.workers
            .lock()
            .map(|workers| {
                workers
                    .values()
                    .any(|worker| worker.cancel.cancel_child(operation_id))
            })
            .unwrap_or(false)
    }
    pub fn cancel_operation(&self, operation_id: &str) -> Result<crate::Operation> {
        self.cancel_operation_control(operation_id);
        self.catalog
            .lock()
            .map_err(error)?
            .request_cancel_operation(operation_id)
            .map_err(error)
    }
    pub fn cancel(&self, run_id: &str) -> Result<Run> {
        self.cancel_control(run_id);
        let (no_execution, launch) = {
            let mut workers = self.workers.lock().map_err(error)?;
            let no_execution = workers
                .get(run_id)
                .is_none_or(|worker| worker.pending.is_some());
            let launch = if no_execution {
                let worker = workers.entry(run_id.into()).or_insert_with(|| Worker {
                    cancel: CancellationToken::default(),
                    join: None,
                    pending: None,
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
            if no_execution && !run.state.terminal() {
                run = catalog
                    .transition_run(run_id, run.epoch, run.revision, RunState::Cancelled)
                    .map_err(error)?;
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
                    policy_state: launch.start.policy_state,
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
    pub fn reap(&self) -> Result<()> {
        let completed = {
            let mut workers = self.workers.lock().map_err(error)?;
            let ids: Vec<_> = workers
                .iter()
                .filter(|(_, worker)| worker.join.as_ref().is_some_and(JoinHandle::is_finished))
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| workers.remove(&id).and_then(|worker| worker.join))
                .collect::<Vec<_>>()
        };
        for join in completed {
            join.join()
                .map_err(|_| ExecutionError::new("worker_panicked", "native worker panicked"))?;
        }
        Ok(())
    }
    pub fn shutdown(&self) -> Result<()> {
        self.stopping.store(true, Ordering::Release);
        let workers = {
            let mut workers = self.workers.lock().map_err(error)?;
            for worker in workers.values() {
                worker.cancel.cancel();
            }
            std::mem::take(&mut *workers)
        };
        for (_, worker) in workers {
            if let Some(join) = worker.join {
                join.join().map_err(|_| {
                    ExecutionError::new("worker_panicked", "native worker panicked")
                })?;
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
