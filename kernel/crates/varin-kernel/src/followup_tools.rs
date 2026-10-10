//! A single ordinary follow-up tool. The actual frozen invocation supplies every owner.
use serde_json::json;
use std::sync::{Arc, Mutex};
use varin_runtime::catalog::followups::{self, FollowupToolInput};
use varin_runtime::execution::*;
use varin_runtime::{Catalog, Effect, Lifetime, Outcome};
fn error(e: impl ToString) -> ExecutionError {
    ExecutionError::new("follow_up", e.to_string())
}
pub(crate) fn schema() -> ToolSchema {
    let text = json!({"type":"string","minLength":1});
    let leaf = json!({"oneOf":[{"type":"object","properties":{"kind":{"const":"file"},"path":text,"condition":{"enum":["exists","changed","ready"]}},"required":["kind","path","condition"],"additionalProperties":false},{"type":"object","properties":{"kind":{"const":"at"},"atMs":{"type":"integer","minimum":0,"maximum":varin_runtime::catalog::observations::MAX_DEADLINE_MS}},"required":["kind","atMs"],"additionalProperties":false},{"type":"object","properties":{"kind":{"const":"process_stopped"},"operationId":text},"required":["kind","operationId"],"additionalProperties":false}]});
    let trigger = json!({"oneOf":[leaf,{"type":"object","properties":{"kind":{"type":"string","enum":["any","all"]},"sources":{"type":"array","minItems":1,"items":leaf}},"required":["kind","sources"],"additionalProperties":false}]});
    ToolSchema{name:followups::TOOL.into(),version:"3".into(),description:"Register or manage an explicit one-shot continuation of this Thread and branch. Use an absolute Unix time in milliseconds (at), or the original process_spawn operationId (process_stopped). Use file with a normalized relative path and exists, changed, or ready in the original selected source. Exists includes files, directories and symlinks. Changed observes targeted invalidations or actual state differences, with gaps across resets; immutable fixed sources cannot change. Ready proves a stable regular file and idle managed writers, not semantic completion or all OS writers. Flat any/all combine a nonempty list of those sources. Any is one racing one-shot intent: the first observed satisfying snapshot produces one occurrence, and later stop facts do not produce another. Register separate explicit intents for an independent time check and eventual completion. All waits for every source, retaining earlier facts across restart. instruction preserves what to do when the condition occurs. Registration alone returns promptly and does not stop current work. Optional wait:{} separately parks this Run until the trigger or observation cancellation; cancelling observation keeps the registered intent. Active work receives one original occurrence at a legal input boundary; idle work gets a real new Run, including a delegated child execution. Explicit pauses, questions, Goal limits and current permissions still apply. list returns lifecycle metadata; get reads the retained instruction; control requires the current revision. This tool does not authorize recurring monitoring.".into(),output_schema:None,metadata:None,schema:json!({"oneOf":[{"type":"object","properties":{"action":{"const":"register"},"trigger":trigger,"instruction":text,"wait":{"type":"object","additionalProperties":false}},"required":["action","trigger","instruction"],"additionalProperties":false},{"type":"object","properties":{"action":{"const":"list"}},"required":["action"],"additionalProperties":false},{"type":"object","properties":{"action":{"const":"get"},"followupId":text},"required":["action","followupId"],"additionalProperties":false},{"type":"object","properties":{"action":{"const":"control"},"followupId":text,"expectedRevision":{"type":"integer","minimum":1},"control":{"type":"string","enum":["pause","resume","cancel"]}},"required":["action","followupId","expectedRevision","control"],"additionalProperties":false}]})}
}
fn input(call: &ToolCall) -> Result<FollowupToolInput, ExecutionError> {
    let input: FollowupToolInput = serde_json::from_value(call.arguments.clone()).map_err(error)?;
    if let Some(v) = input.registration() {
        v.validate().map_err(error)?;
    }
    Ok(input)
}
pub(crate) fn declaration(
    catalog: Arc<Mutex<Catalog>>,
    binding: Option<crate::tools::ToolBinding>,
    resources: Option<crate::tools::KernelResourceClient>,
) -> varin_runtime::composition::tools::ToolDeclaration {
    varin_runtime::composition::tools::ToolDeclaration::new(
        schema(),
        Arc::new(FollowupTools {
            catalog,
            binding,
            resources,
        }),
    )
}
struct FollowupTools {
    catalog: Arc<Mutex<Catalog>>,
    binding: Option<crate::tools::ToolBinding>,
    resources: Option<crate::tools::KernelResourceClient>,
}
impl ToolExecutor for FollowupTools {
    fn plan(
        &self,
        call: &ToolCall,
        frozen: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(call, frozen, cancel)
            .map(ToolPreparation::Ready)
    }
    fn prepare(
        &self,
        call: &ToolCall,
        frozen: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        if cancel.is_cancelled() {
            return Err(error("follow-up cancelled"));
        }
        let selected = schema();
        if call.name != selected.name
            || call.schema_version != selected.version
            || !frozen.tools.contains(&selected)
        {
            return Err(error(
                "follow_up was not selected in the original invocation",
            ));
        }
        let input = input(call)?;
        let waiting = input.registration().is_some_and(|v| v.wait.is_some());
        let read_only = matches!(
            input,
            FollowupToolInput::List | FollowupToolInput::Get { .. }
        );
        Ok(ToolContract {
            name: call.name.clone(),
            schema_version: call.schema_version.clone(),
            read_only,
            completion: if waiting {
                CompletionKind::Job
            } else {
                CompletionKind::Result
            },
            lifetime: if waiting {
                Lifetime::Thread
            } else {
                Lifetime::Run
            },
            resources: vec![],
        })
    }
    fn authorize(
        &self,
        c: &ToolExecutionContext,
        call: &ToolCall,
        _: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        if cancel.is_cancelled() {
            return Err(error("follow-up cancelled"));
        }
        match input(call)? {
            value @ FollowupToolInput::Register { .. } => {
                let p = self
                    .catalog
                    .lock()
                    .map_err(error)?
                    .prepare_tool_followup_registration(
                        c,
                        call.clone(),
                        schema(),
                        value.registration().expect("register"),
                    )
                    .map_err(error)?;
                let p = p.load().map_err(error)?;
                self.catalog
                    .lock()
                    .map_err(error)?
                    .authorize_followup_registration(&p)
                    .map_err(error)
            }
            FollowupToolInput::Control {
                followup_id,
                expected_revision,
                control,
            } => {
                let p = self
                    .catalog
                    .lock()
                    .map_err(error)?
                    .prepare_tool_followup_control(
                        c,
                        call.clone(),
                        schema(),
                        &followup_id,
                        expected_revision,
                        control,
                    )
                    .map_err(error)?;
                let p = p.load().map_err(error)?;
                self.catalog
                    .lock()
                    .map_err(error)?
                    .authorize_followup_control(&p)
                    .map_err(error)
            }
            _ => {
                let p = self
                    .catalog
                    .lock()
                    .map_err(error)?
                    .capture_tool_followups(c, call.clone(), schema())
                    .map_err(error)?;
                let p = p.load().map_err(error)?;
                self.catalog
                    .lock()
                    .map_err(error)?
                    .list_tool_followups(p)
                    .map_err(error)?;
                Ok(())
            }
        }
    }
    fn execute(
        &self,
        c: &ToolExecutionContext,
        call: &ToolCall,
        _: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        let result = (|| -> Result<ToolCompletion, ExecutionError> {
            match input(call)? {
                value @ FollowupToolInput::Register { .. } => {
                    let p = self
                        .catalog
                        .lock()
                        .map_err(error)?
                        .prepare_tool_followup_registration(
                            c,
                            call.clone(),
                            schema(),
                            value.registration().expect("register"),
                        )
                        .map_err(error)?;
                    let mut p = p.load().map_err(error)?;
                    self.catalog
                        .lock()
                        .map_err(error)?
                        .authorize_followup_registration(&p)
                        .map_err(error)?;
                    let _file_guard =
                        if !p.already_accepted() && !p.file_requests().map_err(error)?.is_empty() {
                            let binding = self.binding.as_ref().ok_or_else(|| {
                                error("file follow-up requires the original source binding")
                            })?;
                            let files = self
                                .resources
                                .as_ref()
                                .and_then(|r| r.file_observations.as_ref())
                                .ok_or_else(|| error("file observation owner unavailable"))?;
                            Some(
                                files
                                    .prepare_registration(
                                        &self.catalog,
                                        &mut p,
                                        &binding.grant_id,
                                        Some(binding),
                                        cancel,
                                    )
                                    .map_err(error)?,
                            )
                        } else {
                            None
                        };
                    if cancel.is_cancelled() {
                        return Err(error("registration cancelled before acceptance"));
                    }
                    let admitted = {
                        let mut owner = self.catalog.lock().map_err(error)?;
                        owner.admit_followup_registration(p).map_err(error)?
                    };
                    admitted
                        .completion
                        .ok_or_else(|| error("registration completion missing"))
                }
                FollowupToolInput::Control {
                    followup_id,
                    expected_revision,
                    control,
                } => {
                    let p = self
                        .catalog
                        .lock()
                        .map_err(error)?
                        .prepare_tool_followup_control(
                            c,
                            call.clone(),
                            schema(),
                            &followup_id,
                            expected_revision,
                            control,
                        )
                        .map_err(error)?;
                    let p = p.load().map_err(error)?;
                    if cancel.is_cancelled() {
                        return Err(error("control cancelled before acceptance"));
                    }
                    self.catalog
                        .lock()
                        .map_err(error)?
                        .admit_followup_control(p)
                        .map_err(error)
                }
                value => {
                    let p = self
                        .catalog
                        .lock()
                        .map_err(error)?
                        .capture_tool_followups(c, call.clone(), schema())
                        .map_err(error)?;
                    let p = p.load().map_err(error)?;
                    let value = match value {
                        FollowupToolInput::Get { followup_id } => {
                            let read = self
                                .catalog
                                .lock()
                                .map_err(error)?
                                .get_tool_followup(p, &followup_id)
                                .map_err(error)?;
                            serde_json::to_value(read.load().map_err(error)?).map_err(error)?
                        }
                        _ => serde_json::to_value(
                            self.catalog
                                .lock()
                                .map_err(error)?
                                .list_tool_followups(p)
                                .map_err(error)?,
                        )
                        .map_err(error)?,
                    };
                    if cancel.is_cancelled() {
                        return Err(error("follow-up read cancelled"));
                    }
                    Ok(ToolCompletion::Result {
                        outcome: Outcome::Succeeded,
                        effect: Effect::None,
                        content: value,
                    })
                }
            }
        })();
        result.unwrap_or_else(|e| ToolCompletion::NotDispatched { reason: e.message })
    }
}
