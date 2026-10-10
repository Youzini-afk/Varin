//! User answers and executor teardown wait on their own worker, never on the Agent actor.
use super::*;

pub(super) struct ControlCommands {
    pub runtime: Arc<RunSupervisor>,
    pub resources: crate::tools::KernelResourceClient,
    pub models: Arc<crate::run_models::RunModels>,
    pub tools: Arc<crate::run_tools::RunTools>,
}
impl ControlCommands {
    /// Record intent in the actor's FIFO before an OS terminal fact can arrive. Only teardown
    /// and body work are deferred; dispatch cancellation remains tied to the durable command.
    pub fn admit_cancellation(&self, method: &str, params: &Value) -> Result<(), KernelError> {
        match method {
            "runtime.child.wait.cancel" => {
                let p: ChildWaitParams = serde_json::from_value(params.clone())?;
                self.runtime
                    .catalog()
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                    .request_cancel_child_wait(&p.wait_id)
                    .map_err(domain)?;
            }
            "runtime.run.cancel" => {
                let p: RunParams = serde_json::from_value(params.clone())?;
                self.runtime
                    .cancel(&p.run_id)
                    .map_err(|e| KernelError::Operation(e.to_string()))?;
            }
            "runtime.operation.cancel" => {
                let p: OperationParams = serde_json::from_value(params.clone())?;
                self.runtime
                    .cancel_operation(&p.operation_id)
                    .map_err(|e| KernelError::Operation(e.to_string()))?;
            }
            "runtime.child.cancel" => {
                let p: OperationParams = serde_json::from_value(params.clone())?;
                let child = self
                    .runtime
                    .catalog()
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                    .cancel_child(&p.operation_id)
                    .map_err(domain)?;
                if let Some(receipt) = child.receipt {
                    self.runtime
                        .cancel(&receipt.run_id)
                        .map_err(|e| KernelError::Operation(e.to_string()))?;
                }
            }
            _ => (),
        }
        Ok(())
    }
    fn finish_question(
        &self,
        operation: &str,
        answer: Option<String>,
        cancelled: &AtomicBool,
    ) -> Result<varin_runtime::OperationMetadata, KernelError> {
        let answering = answer.is_some();
        self.runtime
            .quiesce_question(operation)
            .map_err(|e| KernelError::Operation(e.to_string()))?;
        if answering && cancelled.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let owner = self.runtime.catalog();
        let preparation = owner
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .prepare_question_answer(operation, answer)
            .map_err(domain)?;
        let prepared = preparation.load().map_err(domain)?;
        let mut catalog = owner
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
        if answering && cancelled.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        catalog.admit_question_answer(prepared).map_err(domain)
    }
    pub fn execute(
        &self,
        method: &str,
        params: Value,
        cancelled: &AtomicBool,
    ) -> Result<Value, KernelError> {
        let runtime = &self.runtime;
        match method {
            "runtime.question.answer" => {
                let p: QuestionAnswerParams = serde_json::from_value(params)?;
                let operation = self.finish_question(&p.operation_id, Some(p.answer), cancelled)?;
                let owner = runtime.catalog();
                let read = owner.lock().map_err(|_| KernelError::Storage("catalog owner failed".into()))?.capture_operation_read(operation);
                Ok(serde_json::to_value(read.load().map_err(domain)?)?)
            }
            "runtime.run.cancel" => {
                let p: RunParams = serde_json::from_value(params)?;
                let waiting = runtime
                    .catalog()
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                    .run(&p.run_id)
                    .map_err(domain)?
                    .waiting_on;
                if waiting
                    .as_deref()
                    .is_some_and(|id| id.starts_with("child-wait:"))
                {
                    runtime
                        .quiesce_child_waits()
                        .map_err(|e| KernelError::Operation(e.to_string()))?;
                }
                if waiting
                    .as_deref()
                    .is_some_and(|id| id.starts_with("process-wait:"))
                {
                    runtime
                        .quiesce_process_waits()
                        .map_err(|e| KernelError::Operation(e.to_string()))?;
                }
                if let Some(operation) = waiting
                    .as_deref()
                    .and_then(|id| id.strip_prefix("question:"))
                {
                    runtime
                        .quiesce_question(operation)
                        .map_err(|e| KernelError::Operation(e.to_string()))?;
                }
                let run = runtime
                    .cancel(&p.run_id)
                    .map_err(|e| KernelError::Operation(e.to_string()))?;
                if run.state.terminal() {
                    self.models.release(&run.id);
                    self.tools.release(&run.id);
                }
                Ok(run_cancellation_receipt(&run))
            }
            "runtime.operation.cancel" => {
                let p: OperationParams = serde_json::from_value(params)?;
                let executor = runtime
                    .catalog()
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                    .operation(&p.operation_id)
                    .map_err(domain)?
                    .executor;
                if executor.as_deref() == Some("wait_process") {
                    runtime
                        .quiesce_process_waits()
                        .map_err(|e| KernelError::Operation(e.to_string()))?;
                    let operation = runtime
                        .catalog()
                        .lock()
                        .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                        .cancel_process_wait(&p.operation_id)
                        .map_err(domain)?;
                    return Ok(operation_cancellation_receipt(&operation));
                }
                if executor.as_deref() == Some("ask_user") {
                    return Ok(operation_cancellation_receipt(&self.finish_question(
                        &p.operation_id,
                        None,
                        cancelled,
                    )?));
                }
                let operation = runtime
                    .cancel_operation(&p.operation_id)
                    .map_err(|e| KernelError::Operation(e.to_string()))?;
                if operation.cancel_requested
                    && operation.executor.as_deref() == Some("process_spawn")
                {
                    let known = self.resources.cancel_known_process(&operation.id)?;
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
                        self.resources
                            .cancel_process(&operation.id, &operation.run_id)?;
                    }
                }
                Ok(operation_cancellation_receipt(&operation))
            }
            "runtime.child.cancel" => {
                let p: OperationParams = serde_json::from_value(params)?;
                let child = runtime
                    .catalog()
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                    .child_task(&p.operation_id)
                    .map_err(domain)?;
                runtime
                    .catalog()
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                    .cancel_child(&p.operation_id)
                    .map_err(domain)?;
                if let Some(receipt) = child.receipt {
                    runtime
                        .cancel(&receipt.run_id)
                        .map_err(|e| KernelError::Operation(e.to_string()))?;
                }
                varin_runtime::catalog::child_delivery::reconcile_reports(&runtime.catalog())
                    .map_err(domain)?;
                let owner = runtime.catalog();
                let catalog = owner
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
                let child = catalog.child_task(&p.operation_id).map_err(domain)?;
                let read = catalog.capture_child_read(child);
                drop(catalog);
                Ok(serde_json::to_value(read.load().map_err(domain)?)?)
            }
            "runtime.child.reconcile" | "runtime.child.wait.cancel" => {
                runtime
                    .quiesce_child_waits()
                    .map_err(|error| KernelError::Operation(error.to_string()))?;
                let resumed =
                    varin_runtime::catalog::child_delivery::deliver_waits(&runtime.catalog())
                        .map_err(domain)?;
                if method == "runtime.child.reconcile" {
                    return Ok(serde_json::to_value(resumed)?);
                }
                let p: ChildWaitParams = serde_json::from_value(params)?;
                let wait = runtime
                    .catalog()
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                    .inspect_child_wait(&p.wait_id)
                    .map_err(domain)?;
                Ok(serde_json::to_value(wait)?)
            }
            "runtime.process.wait.reconcile" => {
                runtime
                    .quiesce_process_waits()
                    .map_err(|e| KernelError::Operation(e.to_string()))?;
                Ok(serde_json::to_value(varin_runtime::catalog::process_delivery::deliver_waits(&runtime.catalog()).map_err(domain)?)?)
            }
            _ => Err(KernelError::Protocol(
                "unknown worker control command".into(),
            )),
        }
    }
}
