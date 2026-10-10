//! Built-in clarification capability. No filesystem/process grant is created or expanded.
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use varin_runtime::catalog::questions::QUESTION_TOOL;
use varin_runtime::execution::*;
use varin_runtime::supervisor::RunStart;
use varin_runtime::{Catalog, Effect, Lifetime, Outcome};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Question {
    question: String,
    #[serde(default)]
    options: Vec<String>,
}
fn validate(call: &ToolCall) -> Result<(), ExecutionError> {
    let q: Question = serde_json::from_value(call.arguments.clone()).map_err(|_| {
        ExecutionError::new(
            "invalid_question",
            "question and optional string options are required",
        )
    })?;
    if q.question.trim().is_empty() || q.options.iter().any(|v| v.trim().is_empty()) {
        return Err(ExecutionError::new(
            "invalid_question",
            "question and options must be nonempty",
        ));
    }
    Ok(())
}
pub fn schema() -> ToolSchema {
    ToolSchema { description: "Ask the user a clarification and wait for their real answer. Answers do not grant tool permissions.".into(), output_schema: None, metadata: None,
        name: QUESTION_TOOL.into(),
        version: "1".into(),
        schema: json!({"type":"object","properties":{"question":{"type":"string","minLength":1},"options":{"type":"array","items":{"type":"string","minLength":1}}},"required":["question"],"additionalProperties":false}),
    }
}
pub fn configure(mut start: RunStart, catalog: Arc<Mutex<Catalog>>) -> RunStart {
    start.policy = Arc::new(QuestionPolicy {
        inner: start.policy,
        catalog,
    });
    start
}
struct Questions {
    catalog: Arc<Mutex<Catalog>>,
}
fn error(e: impl ToString) -> ExecutionError {
    ExecutionError::new("question", e.to_string())
}
impl ToolExecutor for Questions {
    fn plan(
        &self,
        call: &ToolCall,
        context: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<varin_runtime::execution::ToolPreparation, ExecutionError> {
        self.prepare(call, context, cancel)
            .map(varin_runtime::execution::ToolPreparation::Ready)
    }

    fn prepare(
        &self,
        call: &ToolCall,
        request: &FrozenToolContext,
        _cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        if call.schema_version != "1" || !request.tools.iter().any(|s| s == &schema()) {
            return Err(error("question schema is not bound"));
        }
        validate(call)?;
        Ok(ToolContract {
            name: QUESTION_TOOL.into(),
            schema_version: "1".into(),
            read_only: true,
            completion: CompletionKind::Job,
            lifetime: Lifetime::Thread,
            resources: vec![],
        })
    }
    fn authorize(
        &self,
        c: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        if cancel.is_cancelled() {
            return Err(error("question cancelled"));
        }
        validate(call)
    }
    fn execute(
        &self,
        c: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        let result = self
            .catalog
            .lock()
            .map_err(error)
            .and_then(|mut db| db.open_question(&c.operation_id, &c.run_id).map_err(error));
        match result {
            Ok(_) => ToolCompletion::JobAccepted {
                operation_id: c.operation_id.clone(),
                phase: "awaiting_user".into(),
                effect: Effect::None,
                lifetime: Lifetime::Thread,
            },
            Err(e) => ToolCompletion::Result {
                outcome: Outcome::Failed,
                effect: Effect::None,
                content: json!({"error":e.code}),
            },
        }
    }
}
struct QuestionPolicy {
    inner: Arc<dyn AgentPolicy>,
    catalog: Arc<Mutex<Catalog>>,
}
impl AgentPolicy for QuestionPolicy {
    fn identity(&self) -> PolicyIdentity {
        let inner = self.inner.identity();
        policy_identity(inner)
    }
    fn select_for_decision(
        &self,
        view: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        epoch: u64,
        cancel: &CancellationToken,
    ) -> Result<Option<Value>, ExecutionError> {
        if self
            .catalog
            .lock()
            .map_err(error)?
            .pending_question_wait(view.run_id)
            .map_err(error)?
            .is_some()
        {
            return Ok(None);
        }
        self.inner
            .select_for_decision(view, event, state, epoch, cancel)
    }
    fn decide(
        &self,
        view: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        cancel: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        let decision = self.inner.decide(view, event, state, cancel)?;
        // Clarification never masks a failed/indeterminate execution decision.
        if matches!(decision.action, PolicyAction::Fail { .. }) {
            return Ok(decision);
        }
        if view.pending_tool_calls == 0 {
            let wait = self
                .catalog
                .lock()
                .map_err(error)?
                .pending_question_wait(view.run_id)
                .map_err(error)?;
            if let Some(wait_id) = wait {
                return Ok(PolicyDecision {
                    action: PolicyAction::Wait { wait_id },
                    state: decision.state,
                });
            }
        }
        Ok(decision)
    }
}

pub fn schemas(mut tools: Vec<ToolSchema>) -> Vec<ToolSchema> {
    tools.push(schema());
    tools
}
pub fn default_policy_identity() -> PolicyIdentity {
    PolicyIdentity {
        name: "default+questions".into(),
        version: "1+1".into(),
    }
}
pub fn declaration(
    catalog: Arc<Mutex<Catalog>>,
) -> varin_runtime::composition::tools::ToolDeclaration {
    varin_runtime::composition::tools::ToolDeclaration::new(
        schema(),
        Arc::new(Questions { catalog }),
    )
}

/// Effective launch/checkpoint identity includes the core clarification behavior.
pub(crate) fn policy_identity(inner: PolicyIdentity) -> PolicyIdentity {
    PolicyIdentity {
        name: format!("{}+questions", inner.name),
        version: format!("{}+1", inner.version),
    }
}
