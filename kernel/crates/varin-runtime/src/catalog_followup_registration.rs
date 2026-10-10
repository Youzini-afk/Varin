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
    At { at_ms: u64 },
    ProcessStopped { operation_id: String },
}
impl FollowupRegistrationSource {
    fn source(&self) -> FollowupSource {
        match self {
            Self::At { at_ms } => FollowupSource::At { at_ms: *at_ms },
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
    At {
        at_ms: u64,
    },
    ProcessStopped {
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
    fn trigger(&self) -> FollowupTrigger {
        match self {
            Self::At { at_ms } => FollowupTrigger::At { at_ms: *at_ms },
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
                FollowupSource::At { .. } => None,
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
        for source in sources {
            match source {
                FollowupSource::At { at_ms } if at_ms > observations::MAX_DEADLINE_MS => {
                    return Err(RuntimeError::Invalid(
                        "follow-up instant exceeds the native wall-clock timer representation"
                            .into(),
                    ));
                }
                FollowupSource::ProcessStopped { operation_id }
                    if operation_id.trim().is_empty() =>
                {
                    return Err(RuntimeError::Invalid(
                        "original process operationId is required".into(),
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
        trigger: FollowupRegistrationTrigger,
        instruction: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        wait: Option<FollowupWaitOptions>,
    },
    List,
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
            trigger,
            instruction,
            wait,
        } = self
        {
            Some(FollowupRegistration {
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
    invocation: Option<(ToolInvocationRead, ToolCall, ToolSchema)>,
    operation: Option<Operation>,
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
    _publication: crate::content::ContentPublication,
}
pub struct FollowupRegistrationAdmission {
    pub followup: Followup,
    pub accepted: bool,
    pub completion: Option<ToolCompletion>,
}
fn key(id: &str) -> String {
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
        let existing: Option<String> = self
            .db
            .query_row("SELECT intent FROM commands WHERE id=?1", [key(&id)], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(FollowupRegistrationPreparation {
            id,
            run: self.run(run)?,
            input,
            actor,
            epoch: self.epoch,
            existing: existing.map(|s| serde_json::from_str(&s)).transpose()?,
            invocation,
            operation,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    pub fn authorize_followup_registration(&self, p: &PreparedFollowupRegistration) -> Result<()> {
        if p.epoch != self.epoch || self.continuation_stopping.load(Ordering::Acquire) {
            return Err(RuntimeError::Conflict(
                "follow-up owner changed or stopped".into(),
            ));
        }
        if let Some(i) = &p.invocation {
            self.validate_tool_invocation(i, true)?;
        }
        for operation_id in p.input.trigger.process_operation_ids() {
            require_process(&self.db, &p.run, &operation_id)?;
        }
        Ok(())
    }
    pub fn admit_followup_registration(
        &mut self,
        p: PreparedFollowupRegistration,
    ) -> Result<FollowupRegistrationAdmission> {
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
            return Ok(FollowupRegistrationAdmission {
                followup: self.followup(&p.id)?,
                accepted: false,
                completion: p.completion.map(|v| v.0),
            });
        }
        self.authorize_followup_registration(&p)?;
        let tx = self.db.transaction()?;
        let run: Run = record(&tx, "runs", &p.run.id)?;
        for operation_id in p.input.trigger.process_operation_ids() {
            require_process(&tx, &run, &operation_id)?;
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
        d.instruction_ref = Some(p.instruction);
        if p.input.wait.is_some() {
            d.observation_operation_id = p.operation.as_ref().map(|o| o.id.clone());
        }
        insert(&tx, &d)?;
        observe(&tx, &mut d, observations::wall_time_ms()?)?;
        if let Some(mut op) = p.operation {
            let completion = &p.completion.as_ref().expect("prepared completion").1;
            if p.input.wait.is_some() {
                observation::register(&tx, &mut op, &d)?;
            }
            finish_tool(&tx, &mut op, completion, p.input.wait.is_some())?;
        }
        tx.execute(
            "INSERT INTO commands(id,intent,receipt) VALUES(?1,?2,?3)",
            params![
                key(&d.id),
                encode(&p.intent)?,
                encode(&json!({"followup_id":d.id}))?
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
    pub fn load(self) -> Result<PreparedFollowupRegistration> {
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
        let instruction = self.content.save(&json!(self.input.instruction))?;
        let completion=invocation.as_ref().map(|_|->Result<_>{
            let completion=if self.input.wait.is_some(){ToolCompletion::JobAccepted{operation_id:self.operation.as_ref().expect("operation").id.clone(),phase:"awaiting_followup".into(),effect:Effect::Confirmed,lifetime:Lifetime::Thread}}else{ToolCompletion::Result{outcome:Outcome::Succeeded,effect:Effect::Confirmed,content:json!({"accepted":true,"followupId":self.id,"threadId":self.run.thread_id,"branchId":self.run.branch_id,"trigger":self.input.trigger})}};
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
        if current != c.definition {
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
            content: json!({"accepted":true,"followupId":self.id,"control":self.action}),
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
