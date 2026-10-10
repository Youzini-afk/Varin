//! Built-in clarification capability. No filesystem/process grant is created or expanded.
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use varin_runtime::catalog::questions::{QUESTION_STATUS_TOOL, QUESTION_TOOL};
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
pub fn status_schema() -> ToolSchema {
    ToolSchema {
        name: QUESTION_STATUS_TOOL.into(), version: "1".into(),
        description: "Read an accepted question from this Run. Pending and cancelled states have no answer; answered contains the original user answer and history identity. An answer does not grant permissions.".into(),
        output_schema: None, metadata: None,
        schema: json!({"type":"object","properties":{"operationId":{"type":"string","minLength":1}},"required":["operationId"],"additionalProperties":false}),
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuestionHandle {
    operation_id: String,
}
fn handle(call: &ToolCall) -> Result<String, ExecutionError> {
    let handle: QuestionHandle = serde_json::from_value(call.arguments.clone()).map_err(error)?;
    if handle.operation_id.is_empty() {
        return Err(error("question operationId required"));
    }
    Ok(handle.operation_id)
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
    fn supports_policy_read(
        &self,
        frozen: &FrozenToolContext,
        call: &ToolCall,
        contract: &ToolContract,
    ) -> bool {
        call.name == QUESTION_STATUS_TOOL
            && call.schema_version == "1"
            && frozen.tools.contains(&status_schema())
            && handle(call).is_ok()
            && contract.name == QUESTION_STATUS_TOOL
            && contract.schema_version == "1"
            && contract.read_only
            && contract.completion == CompletionKind::Result
            && contract.lifetime == Lifetime::Run
            && contract.resources.is_empty()
    }
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
        if call.name == QUESTION_STATUS_TOOL {
            if call.schema_version != "1" || !request.tools.contains(&status_schema()) {
                return Err(error("question status schema is not bound"));
            }
            handle(call)?;
            return Ok(ToolContract {
                name: QUESTION_STATUS_TOOL.into(),
                schema_version: "1".into(),
                read_only: true,
                completion: CompletionKind::Result,
                lifetime: Lifetime::Run,
                resources: vec![],
            });
        }
        if call.name != QUESTION_TOOL
            || call.schema_version != "1"
            || !request.tools.iter().any(|s| s == &schema())
        {
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
        if call.name == QUESTION_STATUS_TOOL {
            let id = handle(call)?;
            self.catalog
                .lock()
                .map_err(error)?
                .capture_question_status(&c.run_id, &id)
                .map_err(error)?;
            return Ok(());
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
        if call.name == QUESTION_STATUS_TOOL {
            let result = (|| -> Result<Value, ExecutionError> {
                if cancel.is_cancelled() {
                    return Err(error("question status cancelled"));
                }
                if contract
                    != &(ToolContract {
                        name: QUESTION_STATUS_TOOL.into(),
                        schema_version: "1".into(),
                        read_only: true,
                        completion: CompletionKind::Result,
                        lifetime: Lifetime::Run,
                        resources: vec![],
                    })
                {
                    return Err(error("question status contract changed"));
                }
                let id = handle(call)?;
                let (epoch, invocation, question) = {
                    let db = self.catalog.lock().map_err(error)?;
                    (
                        db.epoch(),
                        db.capture_tool_invocation(c, &call.call_id)
                            .map_err(error)?,
                        db.capture_question_status(&c.run_id, &id).map_err(error)?,
                    )
                };
                let invocation = invocation.load().map_err(error)?;
                if invocation.call != *call || !invocation.tools.contains(&status_schema()) {
                    return Err(error("question status differs from its frozen invocation"));
                }
                let question = question.load().map_err(error)?;
                let db = self.catalog.lock().map_err(error)?;
                if cancel.is_cancelled() || db.epoch() != epoch {
                    return Err(error("question status cancelled or owner changed"));
                }
                db.validate_tool_invocation(&invocation, true)
                    .map_err(error)?;
                db.validate_question_status(&question).map_err(error)?;
                Ok(question.value)
            })();
            return match result {
                Ok(content) => ToolCompletion::Result {
                    outcome: Outcome::Succeeded,
                    effect: Effect::None,
                    content,
                },
                Err(e) => ToolCompletion::NotDispatched { reason: e.message },
            };
        }
        let result = self
            .catalog
            .lock()
            .map_err(error)
            .and_then(|mut db| db.open_question(c).map_err(error));
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
        let wait = if view.pending_tool_calls == 0 {
            self.catalog
                .lock()
                .map_err(error)?
                .pending_question_wait(view.run_id)
                .map_err(error)?
        } else {
            None
        };
        if let Some(wait_id) = &wait {
            if !event.has_execution_failure() {
                return Ok(PolicyDecision {
                    action: PolicyAction::Wait {
                        wait_id: wait_id.clone(),
                    },
                    state: state.clone(),
                });
            }
        }
        let decision = self.inner.decide(view, event, state, cancel)?;
        if matches!(
            decision.action,
            PolicyAction::Fail { .. } | PolicyAction::Wait { .. }
        ) {
            return Ok(decision);
        }
        if let Some(wait_id) = wait {
            // This proposal did not execute. Keep the committed private baseline and let the
            // core checkpoint retain the original event for the resumed, newly informed decision.
            return Ok(PolicyDecision {
                action: PolicyAction::Wait { wait_id },
                state: state.clone(),
            });
        }
        Ok(decision)
    }
}

pub fn schemas(mut tools: Vec<ToolSchema>) -> Vec<ToolSchema> {
    tools.push(schema());
    tools.push(status_schema());
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

pub fn status_declaration(
    catalog: Arc<Mutex<Catalog>>,
) -> varin_runtime::composition::tools::ToolDeclaration {
    varin_runtime::composition::tools::ToolDeclaration::new(
        status_schema(),
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
