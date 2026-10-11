//! A single ordinary follow-up tool. The actual frozen invocation supplies every owner.
use serde_json::json;
use std::sync::{Arc, Mutex};
use varin_runtime::catalog::followups::{self, FollowupToolInput};
use varin_runtime::execution::*;
use varin_runtime::{Catalog, Effect, Lifetime, Outcome};
fn error(e: impl ToString) -> ExecutionError {
    ExecutionError::new("follow_up", e.to_string())
}
pub(crate) fn builtin_schema() -> crate::run_tools::BuiltinSchema {
    use varin_runtime::catalog::dispatch::{
        ChildPresetDefault::{Retrieval, Worker},
        ChildSourceRequirement::None,
    };
    crate::run_tools::BuiltinSchema::child(schema(), None, &[Worker, Retrieval])
}
pub(crate) fn schema() -> ToolSchema {
    let text = json!({"type":"string","minLength":1});
    let leaf = json!({"oneOf":[
        {"type":"object","description":"A path in this run's source. Fixed revisions cannot change; ready means a stable regular file with no managed writer.",
         "properties":{"kind":{"const":"file"},"path":text,"condition":{"enum":["exists","changed","ready"]}},
         "required":["kind","path","condition"],"additionalProperties":false},
        {"type":"object","properties":{"kind":{"const":"at"},"atMs":{"type":"integer","description":"Absolute Unix time in milliseconds.","minimum":0,"maximum":varin_runtime::catalog::observations::MAX_DEADLINE_MS}},
         "required":["kind","atMs"],"additionalProperties":false},
        {"type":"object","description":"Observe the process_spawn operation's actual stop.",
         "properties":{"kind":{"const":"process_stopped"},"operationId":text},
         "required":["kind","operationId"],"additionalProperties":false},
        {"type":"object","description":"Observe an accepted job from jobs until its executor stops. Artifact collection is separate.",
         "properties":{"kind":{"const":"job_stopped"},"operationId":text},
         "required":["kind","operationId"],"additionalProperties":false},
        {"type":"object","description":"Observe available, failed or expired artifact records from a job. Omit the selector for any artifact. Absence is determined after collection completes.",
         "properties":{"kind":{"const":"artifact"},"operationId":text,"artifactId":text,"name":text},
         "required":["kind","operationId"],"not":{"required":["artifactId","name"]},"additionalProperties":false},
        {"type":"object","description":"Match UTF-8 literal bytes in original published stdout/stderr. Starts at byte zero unless fromOffset is specified. Each includes overlapping matches and retained history; no regex or line matching.",
         "properties":{"kind":{"const":"log_literal"},"operationId":text,"stream":{"enum":["stdout","stderr"]},"literal":{"type":"string","minLength":1},"fromOffset":{"type":"integer","minimum":0,"maximum":9007199254740991u64}},
         "required":["kind","operationId","stream","literal"],"additionalProperties":false},
        {"type":"object","description":"Observe the original stdout/stderr stream once after all published output drains, independently of artifact collection.",
         "properties":{"kind":{"const":"log_end"},"operationId":text,"stream":{"enum":["stdout","stderr"]}},
         "required":["kind","operationId","stream"],"additionalProperties":false},
        {"type":"object","description":"Observe a job's collection result, including failed or empty collections.",
         "properties":{"kind":{"const":"collection"},"operationId":text},
         "required":["kind","operationId"],"additionalProperties":false}
    ]});
    let trigger = json!({"oneOf":[leaf,
        {"type":"object","description":"Any fires when a condition is met; all waits for every condition.",
         "properties":{"kind":{"type":"string","enum":["any","all"]},"sources":{"type":"array","minItems":1,"items":leaf}},
         "required":["kind","sources"],"additionalProperties":false}
    ]});
    ToolSchema {
        name: followups::TOOL.into(),
        version: "7".into(),
        description: "Schedule an instruction to continue this conversation when a condition is met. Registration returns immediately; idle conversations start a new run. Current pauses, unanswered questions and goal limits remain in effect. jobs lists accepted task-family jobs; list shows registrations; get reads an instruction; occurrences pages delivery history; occurrence reads one occurrence's evidence. control pauses, resumes or cancels a registration using its current revision. Pause holds observation and pending delivery; cancel removes future and undelivered work while preserving existing results and observed jobs.".into(),
        output_schema: None,
        metadata: None,
        schema: json!({"oneOf":[
            {"type":"object","properties":{
                "action":{"const":"register"},"trigger":trigger,
                "repeat":{"enum":["once","each"],"description":"Defaults to once. Each repeats on original log matches, observed file changes, artifact revisions or collection results. Any requires at least one repeatable condition; all requires every condition to repeat and pairs their oldest unconsumed facts. Retained log bytes are replayable; unobserved file changes are not reconstructed."},
                "instruction":text,
                "wait":{"type":"object","description":"Also wait for the first occurrence or an exhausted condition. Cancelling this wait keeps the registration.","additionalProperties":false}
             },"required":["action","trigger","instruction"],"additionalProperties":false},
            {"type":"object","properties":{"action":{"enum":["list","jobs"]}},"required":["action"],"additionalProperties":false},
            {"type":"object","properties":{"action":{"const":"get"},"followupId":text},"required":["action","followupId"],"additionalProperties":false},
            {"type":"object","properties":{"action":{"const":"occurrence"},"followupId":text,"occurrenceId":text},"required":["action","followupId","occurrenceId"],"additionalProperties":false},
            {"type":"object","properties":{"action":{"const":"occurrences"},"followupId":text,"after":{"type":"integer","minimum":0}},"required":["action","followupId"],"additionalProperties":false},
            {"type":"object","properties":{"action":{"const":"control"},"followupId":text,"expectedRevision":{"type":"integer","minimum":1},"control":{"enum":["pause","resume","cancel"]}},"required":["action","followupId","expectedRevision","control"],"additionalProperties":false}
        ]}),
    }
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
            FollowupToolInput::List
                | FollowupToolInput::Jobs
                | FollowupToolInput::Get { .. }
                | FollowupToolInput::Occurrences { .. }
                | FollowupToolInput::Occurrence { .. }
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
                    .authorize_followup_read(p)
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
                        FollowupToolInput::Jobs => {
                            let jobs = self
                                .catalog
                                .lock()
                                .map_err(error)?
                                .list_tool_followup_jobs(p)
                                .map_err(error)?;
                            serde_json::to_value(jobs).map_err(error)?
                        }
                        FollowupToolInput::Occurrence {
                            followup_id,
                            occurrence_id,
                        } => {
                            let read = self
                                .catalog
                                .lock()
                                .map_err(error)?
                                .get_tool_followup_occurrence(p, &followup_id, &occurrence_id)
                                .map_err(error)?;
                            serde_json::to_value(read.load().map_err(error)?).map_err(error)?
                        }
                        FollowupToolInput::Occurrences { followup_id, after } => {
                            let page = self
                                .catalog
                                .lock()
                                .map_err(error)?
                                .list_tool_followup_occurrences(p, &followup_id, after)
                                .map_err(error)?;
                            serde_json::to_value(page).map_err(error)?
                        }
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
