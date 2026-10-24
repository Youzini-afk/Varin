//! Internal retrieval uses the ordinary native Agent engine and its original Operation.
use super::*;
fn valid_path(path: &str) -> bool {
    normalized_path(path, false).is_ok() && !path.split('/').any(str::is_empty)
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RetrievalQueryArgs {
    question: String,
    pub paths: Option<Vec<String>>,
}
impl RetrievalQueryArgs {
    pub(super) fn source_descriptor(paths: Option<Vec<String>>) -> Self {
        Self {
            question: String::new(),
            paths,
        }
    }
    pub(super) fn parse(value: &Value) -> Result<Self, ExecutionError> {
        let args: Self = serde_json::from_value(value.clone()).map_err(|_| {
            ExecutionError::new("invalid_tool_arguments", "Invalid code retrieval arguments")
        })?;
        if args.question.trim().is_empty()
            || args.question.contains('\0')
            || args
                .paths
                .as_ref()
                .is_some_and(|paths| paths.is_empty() || paths.iter().any(|path| !valid_path(path)))
        {
            return Err(ExecutionError::new(
                "invalid_tool_arguments",
                "Code retrieval requires a question and optional normalized relative paths",
            ));
        }
        Ok(args)
    }
}

pub(super) fn schema() -> Value {
    json!({"type":"object","additionalProperties":false,"required":["question"],"properties":{
        "question":{"type":"string","minLength":1,"description":"A focused question about the current source files or materials. Existing clues can be included naturally; no plan or keywords are required."},
        "paths":{"type":"array","minItems":1,"items":{"type":"string","minLength":1},"description":"Optional normalized relative files or directories within this Run's authorized scope."}
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
                ExecutionError::from(failure.error)
            })
    }
    /// Selection, model profile and source checks run before dispatch, as for `dispatch`.
    pub(super) fn authorize_retrieval(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        args: &RetrievalQueryArgs,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        self.admit_retrieval(context, args, cancel)?;
        let owner = self.retrieval_owner.as_ref().ok_or_else(|| {
            ExecutionError::new(
                "retrieval_owner_unavailable",
                "Native retrieval execution owner is unavailable",
            )
        })?;
        crate::collaboration::authorize_internal_retrieval(
            owner.runtime.catalog(),
            self.binding.clone(),
            self.resources.clone(),
            owner.tools.bridge(),
            context,
            call,
            cancel,
        )
    }
    pub(super) fn execute_retrieval(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        args: &RetrievalQueryArgs,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        self.run_retrieval(context, call, args, cancel).unwrap_or_else(|failure| {
            match self.retrieval_admission(context) {
                // No Catalog child exists and this call's own preparation references were
                // released: the original executor stopped without model, process or file work.
                Some(false) if failure.details.as_ref().is_none_or(|details| details.get("cleanup").is_none()) => {
                    let content: varin_runtime::output::OutputBody = json!({"status":"failed","error":failure}).into();
                    if let Some(owner) = &self.retrieval_owner {
                        let receipt = varin_runtime::ExternalReceipt {
                            executor: call.name.clone(),
                            identity: context.operation_id.clone(),
                            epoch: "collaboration-v1".into(),
                            outcome: Outcome::Failed,
                            effect: Effect::None,
                            result: content.clone(),
                        };
                        // Without this receipt the generic completion keeps its Unknown guard.
                        let _ = varin_runtime::catalog::result_content::record_external_receipt(
                            &owner.runtime.catalog(), &context.operation_id, receipt, true);
                    }
                    ToolCompletion::Result { outcome: Outcome::Failed, effect: Effect::None, content }
                }
                Some(false) => ToolCompletion::Result {
                    outcome: Outcome::Failed,
                    effect: Effect::None,
                    content: json!({"status":"failed","error":failure}).into(),
                },
                // Once admitted, a lost observation cannot prove that subordinate work stopped.
                _ => ToolCompletion::Result {
                    outcome: Outcome::Indeterminate,
                    effect: Effect::Unknown,
                    content: json!({"status":"unknown","operationId":context.operation_id,"error":failure}).into(),
                },
            }
        })
    }
    /// `Some(true)` when Catalog has the child, `Some(false)` when it proves there is none.
    fn retrieval_admission(&self, context: &ToolExecutionContext) -> Option<bool> {
        let owner = self.retrieval_owner.as_ref()?;
        let catalog = owner.runtime.catalog();
        let db = catalog.lock().ok()?;
        match db.child_task(&context.operation_id) {
            Ok(_) => Some(true),
            Err(varin_runtime::RuntimeError::NotFound(_)) => Some(false),
            Err(_) => None,
        }
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
        crate::collaboration::admit_internal_retrieval(
            owner.runtime.catalog(),
            self.binding.clone(),
            self.resources.clone(),
            owner.tools.bridge(),
            context,
            call,
            &self.contract(call, &ResourceOperation::RetrievalQuery(args.clone())),
            cancel,
        )
    }
}
