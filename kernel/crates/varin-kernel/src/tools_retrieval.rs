//! Internal retrieval uses the ordinary native Agent engine and its original Operation.
use super::*;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
fn valid_path(path: &str) -> bool {
    normalized_path(path, false).is_ok() && !path.split('/').any(str::is_empty)
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RetrievalQueryArgs {
    question: String,
    pub paths: Option<Vec<String>>,
    limit: Option<u64>,
}
impl RetrievalQueryArgs {
    pub(super) fn source_descriptor(paths: Option<Vec<String>>) -> Self {
        Self {
            question: String::new(),
            paths,
            limit: None,
        }
    }
    pub(super) fn parse(value: &Value) -> Result<Self, ExecutionError> {
        let args: Self = serde_json::from_value(value.clone()).map_err(|_| {
            ExecutionError::new("invalid_tool_arguments", "Invalid code retrieval arguments")
        })?;
        if args.question.trim().is_empty()
            || args.question.contains('\0')
            || args
                .limit
                .is_some_and(|limit| limit == 0 || limit > MAX_SAFE_INTEGER)
            || args
                .paths
                .as_ref()
                .is_some_and(|paths| paths.is_empty() || paths.iter().any(|path| !valid_path(path)))
        {
            return Err(ExecutionError::new(
                "invalid_tool_arguments",
                "Code retrieval requires a question, normalized relative paths, and a positive safe-integer limit",
            ));
        }
        Ok(args)
    }
}

pub(super) fn schema() -> Value {
    json!({"type":"object","additionalProperties":false,"required":["question"],"properties":{
        "question":{"type":"string","minLength":1,"description":"A focused code investigation question. Existing clues can be included naturally; no plan or keywords are required."},
        "paths":{"type":"array","minItems":1,"items":{"type":"string","minLength":1},"description":"Optional normalized relative files or directories within this Run's authorized scope."},
        "limit":{"type":"integer","minimum":1,"maximum":MAX_SAFE_INTEGER,"description":"Optional result preview preference; never limits investigation or retained history."}
    }})
}

impl KernelToolExecutor {
    pub(super) fn admit_retrieval(
        &self,
        context: &ToolExecutionContext,
        args: &RetrievalQueryArgs,
        cancel: &CancellationToken,
    ) -> Result<Value, ExecutionError> {
        self.resources
            .call(
                &self.binding,
                context,
                ResourceOperation::RetrievalQuery(args.clone()),
                true,
                cancel,
            )
            .map_err(|failure| {
                ExecutionError::new(error_code(&failure.error), failure.error.to_string())
            })
    }
    pub(super) fn execute_retrieval(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        args: &RetrievalQueryArgs,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        self.run_retrieval(context, call, args, cancel).unwrap_or_else(|failure| {
            // Once admitted, a lost observation cannot prove that subordinate work stopped.
            let admitted=self.retrieval_owner.as_ref().is_some_and(|owner|owner.runtime.catalog().lock()
                .map(|db|db.child_task(&context.operation_id).is_ok()).unwrap_or(true));
            ToolCompletion::Result {
                outcome:if admitted {Outcome::Indeterminate}else{Outcome::Failed}, effect:if admitted {Effect::Unknown}else{Effect::None},
                content:json!({"status":if admitted {"unknown"}else{"failed"},"error":failure.code,"message":failure.message}).into(),
            }
        })
    }
    fn run_retrieval(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        args: &RetrievalQueryArgs,
        cancel: &CancellationToken,
    ) -> Result<ToolCompletion, ExecutionError> {
        self.admit_retrieval(context, args, cancel)?;
        let owner = self.retrieval_owner.as_ref().ok_or_else(|| {
            ExecutionError::new(
                "retrieval_owner_unavailable",
                "Native retrieval execution owner is unavailable",
            )
        })?;
        let catalog = owner.runtime.catalog();
        let lock = || {
            catalog
                .lock()
                .map_err(|_| ExecutionError::new("catalog_unavailable", "Catalog unavailable"))
        };
        let failure = |cause: varin_runtime::RuntimeError| {
            ExecutionError::new("retrieval_execution", cause.to_string())
        };
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        // Register before admission/inspection to close the completion-before-wait race.
        let _events = lock()?.subscribe_events(send.clone());
        let _cancel = cancel.wake_on_cancel(send);
        crate::collaboration::admit_internal_retrieval(
            catalog.clone(),
            self.binding.clone(),
            self.resources.clone(),
            owner.tools.bridge(),
            context,
            call,
            &self.contract(call, &ResourceOperation::RetrievalQuery(args.clone())),
            cancel,
        )?;
        let mut cancellation_sent = false;
        loop {
            if (cancel.is_cancelled()
                || lock()?
                    .retrieval_delivery_requested(&context.operation_id)
                    .map_err(failure)?)
                && !cancellation_sent
            {
                owner
                    .admit_tree_cancel(
                        varin_runtime::catalog::dispatch::TreeCancelTarget::Child {
                            operation_id: context.operation_id.clone(),
                        },
                        Some(&self.binding.thread_id),
                    )
                    .map_err(|error| {
                        ExecutionError::new("retrieval_cancel_failed", error.to_string())
                    })?;
                cancellation_sent = true;
            }
            let read = {
                let db = lock()?;
                let op = db.operation(&context.operation_id).map_err(failure)?;
                op.external_receipt
                    .as_ref()
                    .filter(|receipt| receipt.executor_stopped)
                    .map(|_| db.capture_operation_read(op.clone()))
            };
            if let Some(read) = read {
                let (_, receipt) = read.load_with_external_receipt().map_err(failure)?;
                let receipt = receipt.ok_or_else(|| {
                    ExecutionError::new(
                        "retrieval_receipt_missing",
                        "Original retrieval receipt is unavailable",
                    )
                })?;
                return Ok(ToolCompletion::Result {
                    outcome: receipt.outcome,
                    effect: receipt.effect,
                    content: receipt.result,
                });
            }
            receive.recv().map_err(|_| {
                ExecutionError::new("retrieval_owner_closed", "Retrieval event owner closed")
            })?;
        }
    }
}
