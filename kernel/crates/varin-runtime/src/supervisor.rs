//! Worker ownership and direct cancellation for admitted native Runs.
use crate::execution::*;
use crate::{Catalog, Run, RuntimeError};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{mpsc, Arc, Mutex, atomic::{AtomicBool,Ordering}},
    thread::{self, JoinHandle},
};

type Result<T> = std::result::Result<T, ExecutionError>;
fn error(error: impl ToString) -> ExecutionError {
    ExecutionError::new("supervisor", error.to_string())
}
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
            Ok(r) => Ok(Some(r)),
            Err(mpsc::TryRecvError::Empty) => Ok(None),
            Err(e) => Err(error(e)),
        }
    }
}
struct Worker {
    cancel: CancellationToken,
    join: Option<JoinHandle<()>>,
}
#[derive(Debug, Clone)]
pub struct WorkerStatus {
    pub run_id: String,
    pub cancellation_requested: bool,
    pub finished: bool,
}
pub struct RunSupervisor {
    stopping:AtomicBool,
    catalog: Arc<Mutex<Catalog>>,
    workers: Mutex<HashMap<String, Worker>>,
    failures:Arc<Mutex<HashMap<String,ExecutionError>>>,
}
impl RunSupervisor {
    pub fn new(catalog: Catalog) -> Self {
        Self {
            stopping:AtomicBool::new(false),
            catalog: Arc::new(Mutex::new(catalog)),
            workers: Mutex::new(HashMap::new()),
            failures:Arc::new(Mutex::new(HashMap::new())),
        }
    }
    pub fn catalog(&self) -> Arc<Mutex<Catalog>> {
        self.catalog.clone()
    }
    pub fn start(&self, run_id: &str, start: RunStart) -> Result<RunHandle> {
        self.reap()?;
        let cancel = CancellationToken::default();
        {
            let mut workers = self.workers.lock().map_err(error)?;
            if self.stopping.load(Ordering::Acquire){return Err(ExecutionError::new("supervisor_stopped","runtime supervisor is shutting down"));}
            if workers.contains_key(run_id) {
                return Err(ExecutionError::new(
                    "run_already_owned",
                    "a worker already owns this Run",
                ));
            }
            workers.insert(
                run_id.into(),
                Worker {
                    cancel: cancel.clone(),
                    join: None,
                },
            );
        }
        let input_result = (|| {
            self.catalog
                .lock()
                .map_err(error)?
                .prepare_execution(
                    run_id,
                    start.binding,
                    start.policy.identity(),
                    start.policy_state,
                )
                .map_err(error)
        })();
        let input = match input_result {
            Ok(input) => input,
            Err(e) => {
                self.workers.lock().map_err(error)?.remove(run_id);
                return Err(e);
            }
        };
        let epoch = input.owner_generation;
        let engine = ExecutionEngine {
            persistence: self.catalog.clone(),
            provider: start.provider,
            tools: start.tools,
            policy: start.policy,
            progress: start.progress,
        };
        let (tx, rx) = mpsc::channel();
        let failures=self.failures.clone();
        let failure_catalog=self.catalog.clone();
        let failure_run=run_id.to_string();
        let join = thread::Builder::new()
            .name(format!("native-run-{run_id}"))
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    engine.run(input, cancel)
                }))
                .unwrap_or_else(|_| {
                    Err(ExecutionError::new(
                        "worker_panicked",
                        "native execution worker stopped without a completion receipt",
                    ))
                });
                if let Err(error)=&result {
                    if let Ok(mut failures)=failures.lock(){failures.insert(failure_run.clone(),error.clone());}
                    if let Ok(mut catalog)=failure_catalog.lock(){
                        if let Err(commit)=catalog.pause_failed_execution(&failure_run,epoch,&error.code,&error.message){
                            if let Ok(mut failures)=failures.lock(){failures.insert(failure_run.clone(),ExecutionError::new("recovery_commit_failed",format!("{}; recovery status could not commit: {commit}",error.message)));}
                        }
                    }
                }
                let _ = tx.send(result);
            });
        match join {
            Ok(join) => {
                let mut workers = self.workers.lock().map_err(error)?;
                if let Some(worker) = workers.get_mut(run_id) {
                    worker.join = Some(join);
                } else {
                    drop(workers);
                    // Shutdown cancelled the reserved token while Catalog admission was waiting.
                    // Reap the late-spawned, already-cancelled worker before returning.
                    let _ = join.join();
                    return Err(ExecutionError::new(
                        "supervisor_stopped",
                        "worker admission was cancelled by shutdown",
                    ));
                }
            }
            Err(e) => {
                self.workers.lock().map_err(error)?.remove(run_id);
                return Err(error(e));
            }
        }
        Ok(RunHandle {
            run_id: run_id.into(),
            epoch,
            completion: rx,
        })
    }
    /// Independent of Catalog availability. This confirms the request, never actual effect cleanup.
    pub fn cancel_control(&self, run_id: &str) -> bool {
        if let Ok(workers) = self.workers.lock() {
            if let Some(worker) = workers.get(run_id) {
                worker.cancel.cancel();
                return true;
            }
        }
        false
    }
    pub fn cancel_operation_control(&self,operation_id:&str)->bool {
        self.workers.lock().map(|workers|workers.values().any(|worker|worker.cancel.cancel_child(operation_id))).unwrap_or(false)
    }
    pub fn cancel_operation(&self,operation_id:&str)->Result<crate::Operation> {
        self.cancel_operation_control(operation_id);
        self.catalog.lock().map_err(error)?.request_cancel_operation(operation_id).map_err(error)
    }
    pub fn cancel(&self, run_id: &str) -> Result<Run> {
        self.cancel_control(run_id);
        self.catalog
            .lock()
            .map_err(error)?
            .request_cancel_run(run_id)
            .map_err(error)
    }
    pub fn execution_failure(&self,run_id:&str)->Result<Option<ExecutionError>> {
        Ok(self.failures.lock().map_err(error)?.get(run_id).cloned())
    }
    pub fn status(&self) -> Result<Vec<WorkerStatus>> {
        Ok(self
            .workers
            .lock()
            .map_err(error)?
            .iter()
            .map(|(run_id, w)| WorkerStatus {
                run_id: run_id.clone(),
                cancellation_requested: w.cancel.is_cancelled(),
                finished: w.join.as_ref().is_some_and(JoinHandle::is_finished),
            })
            .collect())
    }
    /// Join only threads already known to have returned. No timer or empty polling loop is used.
    pub fn reap(&self) -> Result<()> {
        let completed = {
            let mut workers = self.workers.lock().map_err(error)?;
            let ids: Vec<_> = workers
                .iter()
                .filter(|(_, w)| w.join.as_ref().is_some_and(JoinHandle::is_finished))
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| workers.remove(&id).and_then(|w| w.join))
                .collect::<Vec<_>>()
        };
        for join in completed {
            join.join()
                .map_err(|_| ExecutionError::new("worker_panicked", "native worker panicked"))?;
        }
        Ok(())
    }
    /// Signals all owned foreground workers before joining any of them. Independent handed-off
    /// operations remain Catalog facts and are not implicitly cancelled by this worker shutdown.
    pub fn shutdown(&self) -> Result<()> {
        self.stopping.store(true,Ordering::Release);
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
