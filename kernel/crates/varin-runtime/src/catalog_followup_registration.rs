//! Registration and ordinary tool receipts commit together. Bodies and frozen invocation
//! validation are prepared on the worker, outside the Catalog owner.
use super::super::tool_content::{ToolIntent, ToolInvocationRead, ToolInvocationSnapshot};
use super::*;
use crate::execution::{
    CompletionKind, ToolCall, ToolCompletion, ToolExecutionContext, ToolSchema,
};
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FollowupRegistrationSource {
    Metric {
        machine_id: String,
        metric: MetricKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        gpu_uuid: Option<String>,
        predicate: MetricPredicate,
        threshold: serde_json::Number,
    },

    LogLiteral {
        operation_id: String,
        stream: LogStream,
        literal: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_offset: Option<u64>,
    },
    LogEnd {
        operation_id: String,
        stream: LogStream,
    },

    At {
        at_ms: u64,
    },
    ProcessStopped {
        operation_id: String,
    },
    JobStopped {
        operation_id: String,
    },
    Artifact {
        operation_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        artifact_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    Collection {
        operation_id: String,
    },
    File {
        path: String,
        condition: FileCondition,
    },
}
impl FollowupRegistrationSource {
    fn source(&self) -> FollowupSource {
        match self {
            Self::Metric {
                machine_id,
                metric,
                gpu_uuid,
                predicate,
                threshold,
            } => FollowupSource::Metric {
                machine_id: machine_id.clone(),
                metric: *metric,
                gpu_uuid: gpu_uuid.clone(),
                predicate: *predicate,
                threshold: threshold.clone(),
            },

            Self::LogLiteral {
                operation_id,
                stream,
                literal,
                from_offset,
            } => FollowupSource::LogLiteral {
                operation_id: operation_id.clone(),
                stream: *stream,
                from_offset: from_offset.unwrap_or(0),
                literal_bytes: literal.len() as u64,
            },
            Self::LogEnd {
                operation_id,
                stream,
            } => FollowupSource::LogEnd {
                operation_id: operation_id.clone(),
                stream: *stream,
            },
            Self::Artifact {
                operation_id,
                artifact_id,
                name,
            } => FollowupSource::Artifact {
                operation_id: operation_id.clone(),
                artifact_id: artifact_id.clone(),
                name: name.clone(),
            },
            Self::Collection { operation_id } => FollowupSource::Collection {
                operation_id: operation_id.clone(),
            },
            Self::JobStopped { operation_id } => FollowupSource::JobStopped {
                operation_id: operation_id.clone(),
            },
            Self::At { at_ms } => FollowupSource::At { at_ms: *at_ms },
            Self::File { path, condition } => FollowupSource::File {
                path: path.clone(),
                condition: *condition,
            },
            Self::ProcessStopped { operation_id } => FollowupSource::ProcessStopped {
                operation_id: operation_id.clone(),
            },
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FollowupRegistrationTrigger {
    Metric {
        machine_id: String,
        metric: MetricKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        gpu_uuid: Option<String>,
        predicate: MetricPredicate,
        threshold: serde_json::Number,
    },

    LogLiteral {
        operation_id: String,
        stream: LogStream,
        literal: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_offset: Option<u64>,
    },
    LogEnd {
        operation_id: String,
        stream: LogStream,
    },

    Artifact {
        operation_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        artifact_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    Collection {
        operation_id: String,
    },
    File {
        path: String,
        condition: FileCondition,
    },
    At {
        at_ms: u64,
    },
    ProcessStopped {
        operation_id: String,
    },
    JobStopped {
        operation_id: String,
    },
    Any {
        sources: Vec<FollowupRegistrationSource>,
    },
    All {
        sources: Vec<FollowupRegistrationSource>,
    },
}
impl FollowupRegistrationTrigger {
    fn normalize_paths(&mut self) -> Result<()> {
        match self {
            Self::File { path, .. } => *path = normalized_file_path(path)?,
            Self::Any { sources } | Self::All { sources } => {
                for source in sources {
                    if let FollowupRegistrationSource::File { path, .. } = source {
                        *path = normalized_file_path(path)?;
                    }
                }
            }
            _ => (),
        }
        Ok(())
    }
    fn trigger(&self) -> FollowupTrigger {
        match self {
            Self::Metric {
                machine_id,
                metric,
                gpu_uuid,
                predicate,
                threshold,
            } => FollowupTrigger::Metric {
                machine_id: machine_id.clone(),
                metric: *metric,
                gpu_uuid: gpu_uuid.clone(),
                predicate: *predicate,
                threshold: threshold.clone(),
            },

            Self::LogLiteral {
                operation_id,
                stream,
                literal,
                from_offset,
            } => FollowupTrigger::LogLiteral {
                operation_id: operation_id.clone(),
                stream: *stream,
                from_offset: from_offset.unwrap_or(0),
                literal_bytes: literal.len() as u64,
            },
            Self::LogEnd {
                operation_id,
                stream,
            } => FollowupTrigger::LogEnd {
                operation_id: operation_id.clone(),
                stream: *stream,
            },
            Self::Artifact {
                operation_id,
                artifact_id,
                name,
            } => FollowupTrigger::Artifact {
                operation_id: operation_id.clone(),
                artifact_id: artifact_id.clone(),
                name: name.clone(),
            },
            Self::Collection { operation_id } => FollowupTrigger::Collection {
                operation_id: operation_id.clone(),
            },
            Self::JobStopped { operation_id } => FollowupTrigger::JobStopped {
                operation_id: operation_id.clone(),
            },
            Self::At { at_ms } => FollowupTrigger::At { at_ms: *at_ms },
            Self::File { path, condition } => FollowupTrigger::File {
                path: path.clone(),
                condition: *condition,
            },
            Self::ProcessStopped { operation_id } => FollowupTrigger::ProcessStopped {
                operation_id: operation_id.clone(),
            },
            Self::Any { sources } => FollowupTrigger::Any {
                sources: sources
                    .iter()
                    .map(FollowupRegistrationSource::source)
                    .collect(),
            },
            Self::All { sources } => FollowupTrigger::All {
                sources: sources
                    .iter()
                    .map(FollowupRegistrationSource::source)
                    .collect(),
            },
        }
    }
    pub fn process_operation_ids(&self) -> Vec<String> {
        self.trigger()
            .sources()
            .into_iter()
            .filter_map(|source| match source {
                FollowupSource::ProcessStopped { operation_id } => Some(operation_id),
                FollowupSource::At { .. }
                | FollowupSource::Metric { .. }
                | FollowupSource::File { .. }
                | FollowupSource::JobStopped { .. }
                | FollowupSource::Artifact { .. }
                | FollowupSource::Collection { .. }
                | FollowupSource::LogLiteral { .. }
                | FollowupSource::LogEnd { .. } => None,
            })
            .collect()
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FollowupWaitOptions {}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FollowupRegistration {
    #[serde(default)]
    pub repeat: FollowupRepeat,
    pub trigger: FollowupRegistrationTrigger,
    pub instruction: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait: Option<FollowupWaitOptions>,
}
impl FollowupRegistration {
    pub fn validate(&self) -> Result<()> {
        if self.instruction.trim().is_empty() {
            return Err(RuntimeError::Invalid(
                "follow-up instruction is required".into(),
            ));
        }
        let sources = self.trigger.trigger().sources();
        if sources.is_empty() {
            return Err(RuntimeError::Invalid(
                "follow-up sources cannot be empty".into(),
            ));
        }
        if self.repeat == FollowupRepeat::Each {
            let repeatable = sources.iter().filter(|source| source.repeatable()).count();
            let valid = match self.trigger {
                FollowupRegistrationTrigger::Any { .. } => repeatable > 0,
                _ => repeatable == sources.len(),
            };
            if !valid {
                return Err(RuntimeError::Invalid(
                    "each requires repeatable metric crossings, log matches, artifact, collection or changed-file facts; every All leaf must emit new edges"
                        .into(),
                ));
            }
        }
        for source in sources {
            match source {
                FollowupSource::Metric {
                    machine_id,
                    metric,
                    gpu_uuid,
                    threshold,
                    ..
                } => {
                    metrics::validate_source(&machine_id, metric, gpu_uuid.as_deref(), &threshold)?
                }
                FollowupSource::LogLiteral {
                    operation_id,
                    literal_bytes,
                    from_offset,
                    ..
                } => {
                    artifacts::validate_source(&operation_id, None, None)?;
                    if from_offset > 9_007_199_254_740_991 {
                        return Err(RuntimeError::Invalid(
                            "Log byte offset exceeds the exact JSON integer representation".into(),
                        ));
                    }
                    if literal_bytes == 0 {
                        return Err(RuntimeError::Invalid(
                            "log_literal requires a nonempty UTF-8 literal".into(),
                        ));
                    }
                }
                FollowupSource::LogEnd { operation_id, .. } => {
                    artifacts::validate_source(&operation_id, None, None)?
                }
                FollowupSource::Artifact {
                    operation_id,
                    artifact_id,
                    name,
                } => artifacts::validate_source(
                    &operation_id,
                    artifact_id.as_deref(),
                    name.as_deref(),
                )?,
                FollowupSource::Collection { operation_id } => {
                    artifacts::validate_source(&operation_id, None, None)?
                }
                FollowupSource::File { path, .. } => validate_file_path(&path)?,
                FollowupSource::At { at_ms } if at_ms > observations::MAX_DEADLINE_MS => {
                    return Err(RuntimeError::Invalid(
                        "follow-up instant exceeds the native wall-clock timer representation"
                            .into(),
                    ));
                }
                FollowupSource::ProcessStopped { operation_id }
                | FollowupSource::JobStopped { operation_id }
                    if operation_id.trim().is_empty() =>
                {
                    return Err(RuntimeError::Invalid(
                        "original accepted operationId is required".into(),
                    ));
                }
                _ => (),
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FollowupToolInput {
    Register {
        #[serde(default)]
        repeat: FollowupRepeat,
        trigger: FollowupRegistrationTrigger,
        instruction: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        wait: Option<FollowupWaitOptions>,
    },
    List,
    Jobs,
    Occurrence {
        followup_id: String,
        occurrence_id: String,
    },
    Occurrences {
        followup_id: String,
        after: Option<u64>,
    },
    Get {
        followup_id: String,
    },
    Control {
        followup_id: String,
        expected_revision: u64,
        control: FollowupControlAction,
    },
}
impl FollowupToolInput {
    pub fn registration(&self) -> Option<FollowupRegistration> {
        if let Self::Register {
            repeat,
            trigger,
            instruction,
            wait,
        } = self
        {
            Some(FollowupRegistration {
                repeat: *repeat,
                trigger: trigger.clone(),
                instruction: instruction.clone(),
                wait: wait.clone(),
            })
        } else {
            None
        }
    }
}
pub struct FollowupRegistrationPreparation {
    id: String,
    run: Run,
    input: FollowupRegistration,
    actor: FollowupActor,
    epoch: u64,
    existing: Option<Value>,
    accepted: bool,
    pending_files: Vec<FileObservationRequest>,
    invocation: Option<(ToolInvocationRead, ToolCall, ToolSchema)>,
    operation: Option<Operation>,
    source: Option<launches::SourceSelection>,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedFollowupRegistration {
    id: String,
    run: Run,
    input: FollowupRegistration,
    actor: FollowupActor,
    epoch: u64,
    intent: Value,
    instruction: Value,
    invocation: Option<ToolInvocationSnapshot>,
    operation: Option<Operation>,
    completion: Option<(ToolCompletion, result_content::ToolCompletionMetadata)>,
    source: Option<launches::SourceSelection>,
    files: Vec<PreparedFileObservation>,
    file_authority: Option<FileObservationAuthority>,
    registration_scope: Option<FileObservationRegistrationScope>,
    already_accepted: bool,
    _publication: crate::content::ContentPublication,
}
pub struct FollowupRegistrationAdmission {
    pub followup: Followup,
    pub accepted: bool,
    pub completion: Option<ToolCompletion>,
}
pub(super) fn key(id: &str) -> String {
    format!("followup-register:{id}")
}
impl Catalog {
    pub fn prepare_followup_registration(
        &self,
        key: &str,
        run_id: &str,
        input: FollowupRegistration,
    ) -> Result<FollowupRegistrationPreparation> {
        if key.trim().is_empty() {
            return Err(RuntimeError::Invalid("follow-up key is required".into()));
        }
        if input.wait.is_some() {
            return Err(RuntimeError::Invalid(
                "User registration cannot invent a tool observation".into(),
            ));
        }
        self.capture_followup_registration(
            key.to_owned(),
            run_id,
            input,
            FollowupActor::User,
            None,
            None,
        )
    }
    pub fn prepare_tool_followup_registration(
        &self,
        context: &ToolExecutionContext,
        call: ToolCall,
        schema: ToolSchema,
        input: FollowupRegistration,
    ) -> Result<FollowupRegistrationPreparation> {
        self.capture_followup_registration(
            format!("followup:tool:{}", context.operation_id),
            &context.run_id,
            input,
            FollowupActor::Agent {
                run_id: context.run_id.clone(),
                operation_id: context.operation_id.clone(),
                origin: context.origin.clone(),
            },
            Some((
                self.capture_tool_invocation(context, &call.call_id)?,
                call,
                schema,
            )),
            Some(self.operation(&context.operation_id)?),
        )
    }
    fn capture_followup_registration(
        &self,
        id: String,
        run: &str,
        input: FollowupRegistration,
        actor: FollowupActor,
        invocation: Option<(ToolInvocationRead, ToolCall, ToolSchema)>,
        operation: Option<Operation>,
    ) -> Result<FollowupRegistrationPreparation> {
        registration_cancel::require_registration_open(&self.db, &id, &actor)?;
        let existing: Option<String> = self
            .db
            .query_row("SELECT intent FROM commands WHERE id=?1", [key(&id)], |r| {
                r.get(0)
            })
            .optional()?;
        let accepted = optional_record::<Definition>(&self.db, "followups", &id)?.is_some();
        let pending_files = self.pending_file_registration(&id)?;
        Ok(FollowupRegistrationPreparation {
            accepted,
            pending_files,
            id,
            run: self.run(run)?,
            input,
            actor,
            epoch: self.epoch,
            existing: existing.map(|s| serde_json::from_str(&s)).transpose()?,
            invocation,
            operation,
            source: optional_record::<launch_content::LaunchMetadata>(
                &self.db,
                "run_launches",
                run,
            )?
            .and_then(|l| l.selection.source),
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    pub fn authorize_followup_registration(&self, p: &PreparedFollowupRegistration) -> Result<()> {
        registration_cancel::require_registration_open(&self.db, &p.id, &p.actor)?;
        if p.epoch != self.epoch || self.continuation_stopping.load(Ordering::Acquire) {
            return Err(RuntimeError::Conflict(
                "follow-up owner changed or stopped".into(),
            ));
        }
        if let Some(i) = &p.invocation {
            self.validate_tool_invocation(i, true)?;
        }
        let source =
            optional_record::<launch_content::LaunchMetadata>(&self.db, "run_launches", &p.run.id)?
                .and_then(|l| l.selection.source);
        if source != p.source {
            return Err(RuntimeError::Conflict(
                "file observation source changed during registration".into(),
            ));
        }
        for source in p.input.trigger.trigger().sources() {
            match source {
                FollowupSource::Metric { .. } => {
                    metrics::scope(&self.db, &p.run, p.source.as_ref())?;
                }
                FollowupSource::ProcessStopped { operation_id } => {
                    require_process(&self.db, &p.run, &operation_id)?
                }
                FollowupSource::Artifact { operation_id, .. }
                | FollowupSource::Collection { operation_id }
                | FollowupSource::LogLiteral { operation_id, .. }
                | FollowupSource::LogEnd { operation_id, .. } => {
                    artifacts::require_target(&self.db, &p.run, &operation_id)?;
                }
                FollowupSource::JobStopped { operation_id } => {
                    self.require_host_job_observation(&p.run.id, &operation_id)?;
                }
                _ => (),
            }
        }
        Ok(())
    }
    pub fn admit_followup_registration(
        &mut self,
        p: PreparedFollowupRegistration,
    ) -> Result<FollowupRegistrationAdmission> {
        registration_cancel::require_registration_open(&self.db, &p.id, &p.actor)?;
        if p.epoch != self.epoch || self.continuation_stopping.load(Ordering::Acquire) {
            return Err(RuntimeError::Conflict(
                "follow-up owner changed or stopped".into(),
            ));
        }
        let previous: Option<String> = self
            .db
            .query_row(
                "SELECT intent FROM commands WHERE id=?1",
                [key(&p.id)],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(previous) = previous {
            if serde_json::from_str::<Value>(&previous)? != p.intent {
                return Err(RuntimeError::Conflict(
                    "follow-up key has different original intent".into(),
                ));
            }
            if optional_record::<Definition>(&self.db, "followups", &p.id)?.is_some() {
                return Ok(FollowupRegistrationAdmission {
                    followup: self.followup(&p.id)?,
                    accepted: false,
                    completion: p.completion.map(|v| v.0),
                });
            }
        }
        self.authorize_followup_registration(&p)?;
        let tx = self.db.transaction()?;
        let run: Run = record(&tx, "runs", &p.run.id)?;
        for source in p.input.trigger.trigger().sources() {
            match source {
                FollowupSource::Metric { .. } => {
                    metrics::scope(&tx, &run, p.source.as_ref())?;
                }
                FollowupSource::ProcessStopped { operation_id } => {
                    require_process(&tx, &run, &operation_id)?
                }
                FollowupSource::Artifact { operation_id, .. }
                | FollowupSource::Collection { operation_id }
                | FollowupSource::LogLiteral { operation_id, .. }
                | FollowupSource::LogEnd { operation_id, .. } => {
                    artifacts::require_target(&tx, &run, &operation_id)?;
                }
                FollowupSource::JobStopped { operation_id } => {
                    host_jobs::require_observation(&tx, &run, &operation_id)?;
                }
                _ => (),
            }
        }
        if let (Some(op), Some(i)) = (&p.operation, &p.invocation) {
            require_invocation(&tx, self.epoch, op, i, p.input.wait.is_some())?;
        }
        let goal = goals::for_run(&tx, &run.id)?.filter(|g| !g.ended());
        let mut d = definition_for_run(
            &tx,
            &p.id,
            &run,
            p.input.trigger.trigger(),
            p.actor,
            goal.map(|g| g.id),
            observations::wall_time_ms()?,
        )?;
        d.repeat = p.input.repeat;
        d.instruction_ref = Some(p.instruction);
        if p.input.wait.is_some() {
            d.observation_operation_id = p.operation.as_ref().map(|o| o.id.clone());
        }
        files::bind_registration(&mut d, &p.files)?;
        insert(&tx, &d)?;
        files::observe_registration(&tx, &mut d, &p.files)?;
        observe(&tx, &mut d, observations::wall_time_ms()?)?;
        if let Some(mut op) = p.operation {
            let completion = &p.completion.as_ref().expect("prepared completion").1;
            if p.input.wait.is_some() {
                observation::register(&tx, &mut op, &d)?;
            }
            finish_tool(&tx, &mut op, completion, p.input.wait.is_some())?;
        }
        tx.execute(
            "INSERT INTO commands(id,intent,receipt) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET receipt=excluded.receipt",
            params![
                key(&d.id),
                encode(&p.intent)?,
                encode(&json!({"followup_id":d.id,"run_id":d.source_run_id}))?
            ],
        )?;
        let result = project(&tx, d)?;
        tx.commit()?;
        Ok(FollowupRegistrationAdmission {
            followup: result,
            accepted: true,
            completion: p.completion.map(|v| v.0),
        })
    }
}
fn validate_invocation(
    read: ToolInvocationRead,
    call: ToolCall,
    schema: ToolSchema,
    operation: &Operation,
    content: &crate::content::ContentStore,
) -> Result<ToolInvocationSnapshot> {
    let snapshot = read.load()?;
    let actual = ToolIntent::from_operation(operation)?;
    if snapshot.call != call
        || call.name != TOOL
        || call.schema_version != schema.version
        || schema.name != TOOL
        || !snapshot.tools.contains(&schema)
        || actual.origin() != &snapshot.context.origin
        || actual.call().clone().load(content)? != call
    {
        return Err(RuntimeError::Conflict(
            "follow_up does not match its original frozen invocation".into(),
        ));
    }
    Ok(snapshot)
}
impl FollowupRegistrationPreparation {
    pub fn load(mut self) -> Result<PreparedFollowupRegistration> {
        self.input.validate()?;
        let intent = self
            .content
            .save(&json!({"run_id":self.run.id,"actor":self.actor,"registration":self.input}))?;
        if self.existing.as_ref().is_some_and(|old| old != &intent) {
            return Err(RuntimeError::Conflict(
                "follow-up key has different original intent".into(),
            ));
        }
        let invocation = self
            .invocation
            .map(|(r, c, s)| {
                let parsed: FollowupToolInput = serde_json::from_value(c.arguments.clone())?;
                if parsed.registration().as_ref() != Some(&self.input) {
                    return Err(RuntimeError::Conflict(
                        "follow-up registration changed original arguments".into(),
                    ));
                }
                validate_invocation(
                    r,
                    c,
                    s,
                    self.operation.as_ref().expect("tool operation"),
                    &self.content,
                )
            })
            .transpose()?;
        self.input.trigger.normalize_paths()?;
        let instruction = self.content.save(&json!(self.input.instruction))?;
        let completion=invocation.as_ref().map(|_|->Result<_>{
            let completion=if self.input.wait.is_some(){ToolCompletion::JobAccepted{operation_id:self.operation.as_ref().expect("operation").id.clone(),phase:"awaiting_followup".into(),effect:Effect::Confirmed,lifetime:Lifetime::Thread, content: None,}}else{ToolCompletion::Result{outcome:Outcome::Succeeded,effect:Effect::Confirmed,content:json!({"accepted":true,"followupId":self.id,"threadId":self.run.thread_id,"branchId":self.run.branch_id,"trigger":self.input.trigger.trigger()}).into()}};
            let metadata=result_content::ToolCompletionMetadata::write(&self.content,&completion)?;Ok((completion,metadata))
        }).transpose()?;
        Ok(PreparedFollowupRegistration {
            id: self.id,
            run: self.run,
            input: self.input,
            actor: self.actor,
            epoch: self.epoch,
            intent,
            instruction,
            invocation,
            operation: self.operation,
            completion,
            source: self.source,
            files: Vec::new(),
            file_authority: self
                .pending_files
                .first()
                .and_then(|r| r.resource_authority.clone()),
            registration_scope: self
                .pending_files
                .first()
                .and_then(|r| r.registration_scope.clone()),
            already_accepted: self.accepted,
            _publication: self.publication,
        })
    }
}
fn require_invocation(
    tx: &Transaction<'_>,
    epoch: u64,
    captured: &Operation,
    i: &ToolInvocationSnapshot,
    waiting: bool,
) -> Result<()> {
    let op: Operation = record(tx, "operations", &captured.id)?;
    let run: Run = record(tx, "runs", &op.run_id)?;
    fence(&run, epoch)?;
    let intent = ToolIntent::from_operation(&op)?;
    if op != *captured
        || op.epoch != epoch
        || op.phase != OperationPhase::Running
        || op.cancel_requested
        || run.cancel_requested
        || op.execution_owner != Some(ExecutorOwner::Kernel)
        || op.executor.as_deref() != Some(TOOL)
        || op.run_id != i.context.run_id
        || intent.origin() != &i.context.origin
        || intent.call().name != TOOL
        || intent.contract().name != TOOL
        || intent.contract().schema_version != intent.call().schema_version
        || intent.contract().read_only
        || intent.contract().lifetime
            != if waiting {
                Lifetime::Thread
            } else {
                Lifetime::Run
            }
        || intent.contract().completion
            != if waiting {
                CompletionKind::Job
            } else {
                CompletionKind::Result
            }
        || !goals::tool_allowed(tx, &i.context)?
    {
        return Err(RuntimeError::Conflict(
            "follow_up is not its original live dispatched Operation".into(),
        ));
    }
    Ok(())
}
fn finish_tool(
    tx: &Transaction<'_>,
    op: &mut Operation,
    completion: &result_content::ToolCompletionMetadata,
    waiting: bool,
) -> Result<()> {
    if !waiting {
        let result_content::ToolCompletionMetadata::Result { content_ref, .. } = completion else {
            return Err(RuntimeError::Invalid(
                "follow-up completion kind changed".into(),
            ));
        };
        op.phase = OperationPhase::Terminal;
        op.outcome = Some(Outcome::Succeeded);
        op.result = Some(OperationResultMetadata::Content {
            reference: content_ref.clone(),
        });
    }
    op.effect = Effect::Confirmed;
    op.call_completion = Some(completion.clone());
    op.revision += 1;
    put(tx, "operations", &op.id, op)?;
    tx.execute(
        "DELETE FROM resource_occupancy WHERE operation_id=?1",
        [&op.id],
    )?;
    let intent = ToolIntent::from_operation(op)?;
    if let ToolOrigin::ModelStep { request_id } = intent.origin() {
        let paired = result_content::ToolReceiptMetadata {
            request_id: request_id.clone(),
            call_id: intent.call().call_id.clone(),
            completion: completion.clone(),
        };
        tx.execute(
            "UPDATE tool_calls SET receipt=?3 WHERE request_id=?1 AND call_id=?2",
            params![request_id, intent.call().call_id, encode(&paired)?],
        )?;
    }
    event(
        tx,
        &op.id,
        op.revision,
        if waiting {
            "followup.wait_registered"
        } else {
            "operation.settled"
        },
        serde_json::to_value(&*op)?,
    )?;
    Ok(())
}
pub struct FollowupToolRead {
    invocation: ToolInvocationRead,
    call: ToolCall,
    schema: ToolSchema,
    thread: String,
    branch: String,
}
pub struct PreparedFollowupToolRead {
    invocation: ToolInvocationSnapshot,
    thread: String,
    branch: String,
}
impl FollowupToolRead {
    pub fn load(self) -> Result<PreparedFollowupToolRead> {
        let i = self.invocation.load()?;
        if i.call != self.call
            || self.call.name != TOOL
            || self.call.schema_version != self.schema.version
            || !i.tools.contains(&self.schema)
        {
            return Err(RuntimeError::Conflict(
                "follow-up read was not selected by this invocation".into(),
            ));
        }
        Ok(PreparedFollowupToolRead {
            invocation: i,
            thread: self.thread,
            branch: self.branch,
        })
    }
}
impl Catalog {
    pub fn capture_tool_followups(
        &self,
        c: &ToolExecutionContext,
        call: ToolCall,
        schema: ToolSchema,
    ) -> Result<FollowupToolRead> {
        let run = self.run(&c.run_id)?;
        Ok(FollowupToolRead {
            invocation: self.capture_tool_invocation(c, &call.call_id)?,
            call,
            schema,
            thread: run.thread_id,
            branch: run.branch_id,
        })
    }
    pub fn get_tool_followup(&self, p: PreparedFollowupToolRead, id: &str) -> Result<FollowupRead> {
        self.validate_tool_invocation(&p.invocation, true)?;
        let value = self.capture_followup(id)?;
        if value.followup.thread_id != p.thread || value.followup.branch_id != p.branch {
            return Err(RuntimeError::Conflict(
                "follow-up belongs to another Thread or branch".into(),
            ));
        }
        Ok(value)
    }
    pub fn authorize_followup_read(&self, p: PreparedFollowupToolRead) -> Result<()> {
        self.validate_tool_invocation(&p.invocation, true)
    }
    pub fn list_tool_followup_jobs(
        &self,
        p: PreparedFollowupToolRead,
    ) -> Result<Vec<host_jobs::HostJobSource>> {
        self.validate_tool_invocation(&p.invocation, true)?;
        self.host_job_sources(&p.invocation.context.run_id)
    }
    pub fn get_tool_followup_occurrence(
        &self,
        p: PreparedFollowupToolRead,
        id: &str,
        occurrence_id: &str,
    ) -> Result<FollowupOccurrenceRead> {
        self.validate_tool_invocation(&p.invocation, true)?;
        let d: Definition = record(&self.db, "followups", id)?;
        if d.thread_id != p.thread || d.branch_id != p.branch {
            return Err(RuntimeError::Conflict(
                "follow-up belongs to another Thread or branch".into(),
            ));
        }
        self.capture_followup_occurrence(id, occurrence_id)
    }
    pub fn list_tool_followup_occurrences(
        &self,
        p: PreparedFollowupToolRead,
        id: &str,
        after: Option<u64>,
    ) -> Result<FollowupOccurrencesResult> {
        self.validate_tool_invocation(&p.invocation, true)?;
        let d: Definition = record(&self.db, "followups", id)?;
        if d.thread_id != p.thread || d.branch_id != p.branch {
            return Err(RuntimeError::Conflict(
                "follow-up belongs to another Thread or branch".into(),
            ));
        }
        self.followup_occurrences(id, after)
    }
    pub fn list_tool_followups(&self, p: PreparedFollowupToolRead) -> Result<Vec<Followup>> {
        self.validate_tool_invocation(&p.invocation, true)?;
        Ok(self
            .followups(&p.thread)?
            .into_iter()
            .filter(|v| v.branch_id == p.branch)
            .collect())
    }
}
pub struct FollowupControlPreparation {
    id: String,
    revision: u64,
    action: FollowupControlAction,
    definition: Definition,
    operation: Operation,
    invocation: (ToolInvocationRead, ToolCall, ToolSchema),
    epoch: u64,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
struct FollowupControlCapture {
    id: String,
    revision: u64,
    action: FollowupControlAction,
    definition: Definition,
    operation: Operation,
    epoch: u64,
    publication: crate::content::ContentPublication,
}
pub struct PreparedFollowupControl {
    capture: FollowupControlCapture,
    invocation: ToolInvocationSnapshot,
    completion: ToolCompletion,
    metadata: result_content::ToolCompletionMetadata,
}
impl Catalog {
    pub fn prepare_tool_followup_control(
        &self,
        c: &ToolExecutionContext,
        call: ToolCall,
        schema: ToolSchema,
        id: &str,
        revision: u64,
        action: FollowupControlAction,
    ) -> Result<FollowupControlPreparation> {
        let run = self.run(&c.run_id)?;
        let d: Definition = record(&self.db, "followups", id)?;
        if d.thread_id != run.thread_id || d.branch_id != run.branch_id {
            return Err(RuntimeError::Conflict(
                "follow-up control belongs to another Thread or branch".into(),
            ));
        }
        Ok(FollowupControlPreparation {
            id: id.into(),
            revision,
            action,
            definition: d,
            operation: self.operation(&c.operation_id)?,
            invocation: (
                self.capture_tool_invocation(c, &call.call_id)?,
                call,
                schema,
            ),
            epoch: self.epoch,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    pub fn authorize_followup_control(&self, p: &PreparedFollowupControl) -> Result<()> {
        if p.capture.epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "follow-up control owner changed".into(),
            ));
        }
        self.validate_tool_invocation(&p.invocation, true)
    }
    pub fn admit_followup_control(&mut self, p: PreparedFollowupControl) -> Result<ToolCompletion> {
        self.authorize_followup_control(&p)?;
        let c = p.capture;
        let _publication = c.publication;
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", &c.operation.id)?;
        if op.call_completion.as_ref() == Some(&p.metadata) {
            return Ok(p.completion);
        }
        require_invocation(&tx, self.epoch, &c.operation, &p.invocation, false)?;
        let current: Definition = record(&tx, "followups", &c.id)?;
        if !same_authorization(&current, &c.definition) {
            return Err(RuntimeError::Conflict(
                "follow-up changed during control preparation".into(),
            ));
        }
        control_tx(&tx, &c.id, c.revision, c.action)?;
        finish_tool(&tx, &mut op, &p.metadata, false)?;
        tx.commit()?;
        Ok(p.completion)
    }
}
impl FollowupControlPreparation {
    pub fn load(self) -> Result<PreparedFollowupControl> {
        let (read, call, schema) = self.invocation;
        let parsed: FollowupToolInput = serde_json::from_value(call.arguments.clone())?;
        if parsed
            != (FollowupToolInput::Control {
                followup_id: self.id.clone(),
                expected_revision: self.revision,
                control: self.action,
            })
        {
            return Err(RuntimeError::Conflict(
                "follow-up control changed original arguments".into(),
            ));
        }
        let invocation = validate_invocation(
            read,
            call.clone(),
            schema.clone(),
            &self.operation,
            &self.content,
        )?;
        let completion = ToolCompletion::Result {
            outcome: Outcome::Succeeded,
            effect: Effect::Confirmed,
            content: json!({"accepted":true,"followupId":self.id,"control":self.action}).into(),
        };
        let metadata = result_content::ToolCompletionMetadata::write(&self.content, &completion)?;
        // The invocation read has been consumed; retain only the actual short captured owner.
        let capture = FollowupControlCapture {
            id: self.id,
            revision: self.revision,
            action: self.action,
            definition: self.definition,
            operation: self.operation,
            epoch: self.epoch,
            publication: self.publication,
        };
        Ok(PreparedFollowupControl {
            capture,
            invocation,
            completion,
            metadata,
        })
    }
}

impl PreparedFollowupRegistration {
    pub fn preparation_view(&self) -> Result<Value> {
        let scope = self.registration_scope.as_ref().ok_or_else(|| {
            RuntimeError::Invalid("original file registration scope missing".into())
        })?;
        let mut source = self
            .source
            .clone()
            .ok_or_else(|| RuntimeError::Invalid("original source missing".into()))?;
        if source.mode == crate::SourceMode::Materialized && source.environment_run_id.is_none() {
            source.environment_run_id = Some(self.run.id.clone());
        }
        Ok(json!({"followup":null,"authority":self.file_authority,
            "scope":{"kind":"source_read","threadId":self.run.thread_id,"branchId":scope.branch_id,"key":scope.key},"source":source}))
    }
    pub fn already_accepted(&self) -> bool {
        self.already_accepted
    }
    pub fn file_requests(&self) -> Result<Vec<FileObservationRequest>> {
        self.input
            .trigger
            .trigger()
            .sources()
            .into_iter()
            .enumerate()
            .filter_map(|(source_index, source)| {
                let FollowupSource::File { path, condition } = source else {
                    return None;
                };
                Some(
                    self.source
                        .clone()
                        .ok_or_else(|| {
                            RuntimeError::Invalid(
                                "file condition requires an admitted source".into(),
                            )
                        })
                        .map(|source| FileObservationRequest {
                            resource_authority: self.file_authority.clone(),
                            registration_scope: self.registration_scope.clone(),
                            followup_id: self.id.clone(),
                            source_index,
                            source_run_id: self.run.id.clone(),
                            thread_id: self.run.thread_id.clone(),
                            actor: self.actor.clone(),
                            source,
                            path,
                            condition,
                            intent_ref: self.intent.clone(),
                        }),
                )
            })
            .collect()
    }
    pub fn bind_file_observations(
        &mut self,
        observations: Vec<PreparedFileObservation>,
    ) -> Result<()> {
        let requests = self.file_requests()?;
        if requests.len() != observations.len()
            || requests.iter().zip(&observations).any(|(r, o)| {
                r.source_index != o.source_index
                    || r.receipt_id() != o.receipt_id
                    || r.resource_authority != o.resource_authority
                    || (!r.source.resource_owner.is_local() && r.resource_authority.is_none())
            })
        {
            return Err(RuntimeError::Conflict(
                "file observation preparation changed source binding".into(),
            ));
        }
        self.files = observations;
        Ok(())
    }
}

impl Catalog {
    /// The original command owns the pre-bind handoff and later exact receipt.
    /// Only its intent reference and bounded resource addresses enter this transaction.
    pub fn stage_file_registration(
        &mut self,
        p: &mut PreparedFollowupRegistration,
        coordinator: Option<&str>,
        authority: Option<FileObservationAuthority>,
    ) -> Result<Option<Followup>> {
        self.authorize_followup_registration(p)?;
        if p.source
            .as_ref()
            .is_none_or(|s| s.resource_owner.is_local())
        {
            return Err(RuntimeError::Invalid(
                "managed file registration requires its original source".into(),
            ));
        }
        if let Some(d) = optional_record::<Definition>(&self.db, "followups", &p.id)? {
            p.already_accepted = true;
            return project(&self.db, d).map(Some);
        }
        let existing = self.pending_file_registration(&p.id)?;
        p.file_authority = existing
            .first()
            .and_then(|r| r.resource_authority.clone())
            .or(p.file_authority.clone())
            .or(authority);
        p.registration_scope = existing
            .first()
            .and_then(|r| r.registration_scope.clone())
            .or(p.registration_scope.clone());
        if p.actor == FollowupActor::User && p.registration_scope.is_none() {
            let coordinator = coordinator
                .filter(|s| !s.is_empty())
                .ok_or_else(|| RuntimeError::Invalid("original coordinator missing".into()))?;
            p.registration_scope = Some(FileObservationRegistrationScope {
                coordinator_host_id: coordinator.into(),
                branch_id: p.run.branch_id.clone(),
                key: format!("file-followup:{}", p.id),
            });
        }
        if let Some(a) = &p.file_authority {
            if a.coordinator_host_id.is_empty()
                || a.authority_id.is_empty()
                || a.resource_epoch.is_empty()
                || p.registration_scope
                    .as_ref()
                    .is_some_and(|s| s.coordinator_host_id != a.coordinator_host_id)
            {
                return Err(RuntimeError::Invalid(
                    "original file authority is incomplete".into(),
                ));
            }
        } else if p.registration_scope.is_none() {
            return Err(RuntimeError::Invalid(
                "original file admission missing".into(),
            ));
        }
        let requests = p.file_requests()?;
        if requests.is_empty() {
            return Err(RuntimeError::Invalid(
                "file registration has no file source".into(),
            ));
        }
        if !existing.is_empty() {
            let mut previous = existing.clone();
            for r in &mut previous {
                r.resource_authority = p.file_authority.clone();
            }
            if previous != requests {
                return Err(RuntimeError::Conflict(
                    "original file registration changed".into(),
                ));
            }
        }
        let tx = self.db.transaction()?;
        let original: Option<String> = tx
            .query_row(
                "SELECT intent FROM commands WHERE id=?1",
                [key(&p.id)],
                |r| r.get(0),
            )
            .optional()?;
        if original
            .as_ref()
            .map(|s| serde_json::from_str::<Value>(s))
            .transpose()?
            .is_some_and(|intent| intent != p.intent)
        {
            return Err(RuntimeError::Conflict(
                "original registration intent changed".into(),
            ));
        }
        tx.execute("INSERT INTO commands(id,intent,receipt) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET receipt=excluded.receipt",params![key(&p.id),encode(&p.intent)?,encode(&json!({"followup_id":p.id,"run_id":p.run.id,"file_requests":requests}))?])?;
        if existing.is_empty() {
            event(
                &tx,
                &p.id,
                1,
                "followup.registration_pending",
                json!({"source_run_id":p.run.id,"thread_id":p.run.thread_id,"branch_id":p.run.branch_id}),
            )?;
        }
        tx.commit()?;
        Ok(None)
    }
    pub fn pending_file_registration(&self, id: &str) -> Result<Vec<FileObservationRequest>> {
        let raw: Option<String> = self
            .db
            .query_row("SELECT receipt FROM commands WHERE id=?1", [key(id)], |r| {
                r.get(0)
            })
            .optional()?;
        let Some(raw) = raw else {
            return Ok(Vec::new());
        };
        let value: Value = serde_json::from_str(&raw)?;
        value
            .get("file_requests")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map(|v| v.unwrap_or_default())
            .map_err(Into::into)
    }
    pub fn pending_file_registration_page(
        &self,
        after: Option<&str>,
    ) -> Result<(Vec<FileObservationRequest>, Option<String>)> {
        let after = after
            .map(str::parse::<i64>)
            .transpose()
            .map_err(|_| RuntimeError::Invalid("invalid file registration cursor".into()))?
            .unwrap_or(0);
        if after < 0 {
            return Err(RuntimeError::Invalid(
                "invalid file registration cursor".into(),
            ));
        }
        let mut q=self.db.prepare("SELECT rowid,receipt FROM commands WHERE rowid>?1 AND json_array_length(receipt,'$.file_requests')>0 ORDER BY rowid LIMIT 65")?;
        let rows = q
            .query_map([after], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let next = (rows.len() > 64).then(|| rows[63].0.to_string());
        let mut requests = Vec::new();
        for (_, raw) in rows.into_iter().take(64) {
            let value: Value = serde_json::from_str(&raw)?;
            requests.extend(serde_json::from_value::<Vec<FileObservationRequest>>(
                value["file_requests"].clone(),
            )?);
        }
        Ok((requests, next))
    }
    pub fn confirm_pending_file_released(&mut self, r: &FileObservationRequest) -> Result<()> {
        let mut requests = self.pending_file_registration(&r.followup_id)?;
        requests.retain(|v| v != r);
        self.db.execute("UPDATE commands SET receipt=?2 WHERE id=?1 AND json_type(receipt,'$.file_requests')='array'",params![key(&r.followup_id),encode(&json!({"followup_id":r.followup_id,"run_id":r.source_run_id,"file_requests":requests}))?])?;
        Ok(())
    }
}
