//! Directed messages use the original ingress queue, command receipts and content publication.
//! A passive message has no receiver Run until a real closed boundary delivers it.
use super::inputs::{InputActivation, InputOrigin, QueuedInputMetadata};
use super::tool_content::{ToolIntent, ToolInvocationRead, ToolInvocationSnapshot};
use super::*;
use crate::execution::{
    Content, ConversationItem, Provenance, ToolCall, ToolCompletion, ToolExecutionContext,
    ToolOrigin, ToolSchema,
};
use serde::Deserialize;

pub const SEND_TOOL: &str = "send";
#[path = "catalog_reply_wait.rs"]
pub mod reply_wait;
pub use reply_wait::ReplyWaitView;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageWaitOptions { pub timeout_ms: Option<u64> }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MessageActor {
    User,
    Agent {
        run_id: String,
        operation_id: String,
        origin: ToolOrigin,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait: Option<MessageWaitOptions>,
    pub target_thread_id: Option<String>,
    pub target_branch_id: Option<String>,
    pub reply_to: Option<String>,
    pub kind: MessageKind,
    pub text: String,
}
impl MessageInput {
    pub fn validate(&self) -> Result<()> {
        if let Some(duration)=self.wait.as_ref().and_then(|w|w.timeout_ms) { super::observations::deadline_after(super::observations::wall_time_ms()?, duration)?; }
        if self.text.trim().is_empty() {
            return Err(RuntimeError::Invalid("message text is required".into()));
        }
        if self.reply_to.as_deref().is_some_and(str::is_empty) {
            return Err(RuntimeError::Invalid(
                "replyTo must identify an original message".into(),
            ));
        }
        if self.reply_to.is_none()
            && (self.target_thread_id.as_deref().is_none_or(str::is_empty)
                || self.target_branch_id.as_deref().is_none_or(str::is_empty))
        {
            return Err(RuntimeError::Invalid(
                "a message requires its target Thread and branch, or replyTo".into(),
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageIdentity {
    pub message_id: String,
    pub sender_thread_id: String,
    pub sender_branch_id: String,
    pub target_thread_id: String,
    pub target_branch_id: String,
    pub actor: MessageActor,
    pub kind: MessageKind,
    pub reply_to: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageReceipt {
    #[serde(flatten)]
    pub identity: MessageIdentity,
    pub accepted_cursor: u64,
    pub accepted_at_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageSummary {
    #[serde(flatten)]
    pub receipt: MessageReceipt,
    pub state: InputState,
    pub delivered_run_id: Option<String>,
    pub delivered_cursor: Option<u64>,
    pub activation: MessageActivation,
    pub reply_wait: Option<ReplyWaitView>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageView {
    #[serde(flatten)]
    pub summary: MessageSummary,
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageDirection {
    Incoming,
    Outgoing,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub messages: Vec<MessageSummary>,
    pub next_cursor: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MessageIntent {
    sender_thread_id: String,
    sender_branch_id: String,
    actor: MessageActor,
    input: MessageInput,
}

pub struct MessagePreparation {
    key: String,
    identity: MessageIdentity,
    input: MessageInput,
    epoch: u64,
    existing: Option<(Value, MessageReceipt)>,
    invocation: Option<(ToolInvocationRead, ToolCall, ToolSchema)>,
    operation: Option<Operation>,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedMessage {
    wait: Option<MessageWaitOptions>,
    key: String,
    identity: MessageIdentity,
    epoch: u64,
    intent: Value,
    history: Value,
    invocation: Option<ToolInvocationSnapshot>,
    operation: Option<Operation>,
    completion: Option<(
        ToolCompletion,
        super::result_content::ToolCompletionMetadata,
    )>,
    _publication: crate::content::ContentPublication,
}
pub struct MessageAdmission {
    pub receipt: MessageReceipt,
    pub accepted: bool,
    pub completion: Option<ToolCompletion>,
}
fn command_key(key: &str) -> String {
    format!("message:user:{key}")
}
fn branch_owner(db: &Connection, thread: &str, branch: &str) -> Result<()> {
    let actual: Option<String> = db
        .query_row(
            "SELECT thread_id FROM branches WHERE id=?1",
            [branch],
            |r| r.get(0),
        )
        .optional()?;
    if actual.as_deref() != Some(thread) {
        return Err(RuntimeError::Conflict(
            "message branch does not belong to the specified Thread".into(),
        ));
    }
    super::context_jobs::require_regular_branch(db, branch)
}
fn message_identity(input: &QueuedInputMetadata) -> Result<&MessageIdentity> {
    match &input.origin {
        InputOrigin::Message { identity, .. } => Ok(identity),
        _ => Err(RuntimeError::NotFound("message".into())),
    }
}
fn route(
    db: &Connection,
    sender: &str,
    branch: &str,
    input: &MessageInput,
) -> Result<(String, String)> {
    branch_owner(db, sender, branch)?;
    let (target, target_branch) = if let Some(reply) = &input.reply_to {
        let original: QueuedInputMetadata = record(db, "input_queue", reply)?;
        let original = message_identity(&original)?;
        if original.target_thread_id != sender || original.target_branch_id != branch {
            return Err(RuntimeError::Conflict(
                "replyTo was not received by this exact Thread and branch".into(),
            ));
        }
        if input
            .target_thread_id
            .as_ref()
            .is_some_and(|v| v != &original.sender_thread_id)
            || input
                .target_branch_id
                .as_ref()
                .is_some_and(|v| v != &original.sender_branch_id)
        {
            return Err(RuntimeError::Conflict(
                "reply target differs from the original sender".into(),
            ));
        }
        (
            original.sender_thread_id.clone(),
            original.sender_branch_id.clone(),
        )
    } else {
        (
            input
                .target_thread_id
                .clone()
                .ok_or_else(|| RuntimeError::Invalid("target Thread required".into()))?,
            input
                .target_branch_id
                .clone()
                .ok_or_else(|| RuntimeError::Invalid("target branch required".into()))?,
        )
    };
    if sender == target {
        return Err(RuntimeError::Invalid(
            "messages must target another task-family member".into(),
        ));
    }
    branch_owner(db, &target, &target_branch)?;
    if super::scheduling::thread_family(db, sender)?
        != super::scheduling::thread_family(db, &target)?
    {
        return Err(RuntimeError::Conflict(
            "message target is outside the sender's task family".into(),
        ));
    }
    Ok((target, target_branch))
}
impl Catalog {
    pub fn prepare_user_message(
        &self,
        key: String,
        sender: String,
        branch: String,
        input: MessageInput,
    ) -> Result<MessagePreparation> {
        if input.wait.is_some() { return Err(RuntimeError::Invalid("User messages have no execution observation owner".into())); }
        if key.trim().is_empty() {
            return Err(RuntimeError::Invalid(
                "message idempotency key is required".into(),
            ));
        }
        self.prepare_message(
            command_key(&key),
            sender,
            branch,
            MessageActor::User,
            input,
            None,
            None,
        )
    }
    pub fn prepare_tool_message(
        &self,
        context: &ToolExecutionContext,
        call: ToolCall,
        schema: ToolSchema,
        input: MessageInput,
    ) -> Result<MessagePreparation> {
        let run = self.run(&context.run_id)?;
        let invocation = self.capture_tool_invocation(context, &call.call_id)?;
        let operation = self.operation(&context.operation_id)?;
        self.prepare_message(
            format!("message:tool:{}", context.operation_id),
            run.thread_id,
            run.branch_id,
            MessageActor::Agent {
                run_id: context.run_id.clone(),
                operation_id: context.operation_id.clone(),
                origin: context.origin.clone(),
            },
            input,
            Some((invocation, call, schema)),
            Some(operation),
        )
    }
    fn prepare_message(
        &self,
        key: String,
        sender: String,
        branch: String,
        actor: MessageActor,
        input: MessageInput,
        invocation: Option<(ToolInvocationRead, ToolCall, ToolSchema)>,
        operation: Option<Operation>,
    ) -> Result<MessagePreparation> {
        let previous: Option<(String, String)> = self
            .db
            .query_row(
                "SELECT intent,receipt FROM commands WHERE id=?1",
                [&key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let existing: Option<(Value, MessageReceipt)> = previous
            .map(|(intent, receipt)| -> Result<_> {
                Ok((
                    serde_json::from_str(&intent)?,
                    serde_json::from_str(&receipt)?,
                ))
            })
            .transpose()?;
        let identity = if let Some((_, receipt)) = &existing {
            receipt.identity.clone()
        } else {
            let (target_thread_id, target_branch_id) = route(&self.db, &sender, &branch, &input)?;
            MessageIdentity {
                message_id: match &actor {
                    MessageActor::Agent { operation_id, .. } => format!("message:{operation_id}"),
                    MessageActor::User => id(),
                },
                sender_thread_id: sender.clone(),
                sender_branch_id: branch.clone(),
                target_thread_id,
                target_branch_id,
                actor: actor.clone(),
                kind: input.kind,
                reply_to: input.reply_to.clone(),
            }
        };
        if identity.sender_thread_id != sender
            || identity.sender_branch_id != branch
            || identity.actor != actor
        {
            return Err(RuntimeError::Conflict(
                "message command belongs to another sender".into(),
            ));
        }
        Ok(MessagePreparation {
            key,
            identity,
            input,
            epoch: self.epoch,
            existing,
            invocation,
            operation,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    pub fn authorize_message(&self, prepared: &PreparedMessage) -> Result<()> {
        if prepared.epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "message preparation owner changed".into(),
            ));
        }
        if let Some(invocation) = &prepared.invocation {
            self.validate_tool_invocation(invocation, true)?;
        }
        Ok(())
    }
    pub fn admit_message(&mut self, prepared: PreparedMessage) -> Result<MessageAdmission> {
        if prepared.epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "message preparation belongs to a previous owner".into(),
            ));
        }
        let previous: Option<(String, String)> = self
            .db
            .query_row(
                "SELECT intent,receipt FROM commands WHERE id=?1",
                [&prepared.key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((intent, receipt)) = previous {
            if serde_json::from_str::<Value>(&intent)? != prepared.intent {
                return Err(RuntimeError::Conflict(
                    "message key has different original intent".into(),
                ));
            }
            return Ok(MessageAdmission {
                receipt: serde_json::from_str(&receipt)?,
                accepted: false,
                completion: prepared.completion.map(|v| v.0),
            });
        }
        if let Some(invocation) = &prepared.invocation {
            self.validate_tool_invocation(invocation, true)?;
        }
        let tx = self.db.transaction()?;
        let identity = &prepared.identity;
        // Recheck the actual family and original reverse route after body preparation.
        let routing = MessageInput {
            wait: None,
            target_thread_id: Some(identity.target_thread_id.clone()),
            target_branch_id: Some(identity.target_branch_id.clone()),
            reply_to: identity.reply_to.clone(),
            kind: identity.kind,
            text: String::new(),
        };
        route(
            &tx,
            &identity.sender_thread_id,
            &identity.sender_branch_id,
            &routing,
        )?;
        if let Some(captured) = &prepared.operation {
            let current: Operation = record(&tx, "operations", &captured.id)?;
            let invocation = prepared.invocation.as_ref().expect("tool invocation");
            let run: Run = record(&tx, "runs", &current.run_id)?;
            fence(&run, self.epoch)?;
            let intent = ToolIntent::from_operation(&current)?;
            if current != *captured
                || current.epoch != self.epoch
                || current.phase != OperationPhase::Running
                || current.cancel_requested
                || run.cancel_requested
                || current.execution_owner != Some(ExecutorOwner::Kernel)
                || current.executor.as_deref() != Some(SEND_TOOL)
                || current.run_id != invocation.context.run_id
                || intent.origin() != &invocation.context.origin
                || intent.call().name != SEND_TOOL
                || intent.contract().name != SEND_TOOL
                || intent.contract().schema_version != intent.call().schema_version
                || intent.contract().lifetime != if prepared.wait.is_some() { Lifetime::Thread } else { Lifetime::Run }
                || intent.contract().read_only
                || intent.contract().completion != if prepared.wait.is_some() { crate::execution::CompletionKind::Job } else { crate::execution::CompletionKind::Result }
                || !super::goals::tool_allowed(&tx, &invocation.context)?
            {
                return Err(RuntimeError::Conflict(
                    "send is not its original live dispatched Operation".into(),
                ));
            }
        }
        let accepted_at_ms = super::observations::wall_time_ms()?;
        let deadline_at_ms = prepared.wait.as_ref().and_then(|w|w.timeout_ms)
            .map(|timeout|super::observations::deadline_after(accepted_at_ms, timeout)).transpose()?;
        let mut accepted = serde_json::to_value(identity)?;
        accepted["acceptedAtMs"] = json!(accepted_at_ms);
        let cursor = event(
            &tx,
            &identity.message_id,
            1,
            "message.accepted",
            accepted,
        )?;
        let receipt = MessageReceipt {
            identity: identity.clone(),
            accepted_cursor: cursor,
            accepted_at_ms,
        };
        let activation = activation::accept(&tx, identity)?;
        let input = QueuedInputMetadata {
            id: identity.message_id.clone(),
            thread_id: identity.target_thread_id.clone(),
            branch_id: identity.target_branch_id.clone(),
            run_id: activation.run_id().map(str::to_owned),
            mode: InputMode::Boundary,
            state: InputState::Queued,
            revision: 1,
            cursor,
            origin: InputOrigin::Message {
                identity: identity.clone(),
                command_key: prepared.key.clone(),
                activation,
            },
            activation: if identity.kind == MessageKind::Request { InputActivation::Activating } else { InputActivation::Passive },
            delivered_cursor: None,
        };
        tx.execute("INSERT INTO input_queue(id,branch_id,run_id,mode,state,cursor,origin,activation,sender_thread_id,sender_branch_id,body) VALUES(?1,?2,?7,'boundary','queued',?3,'message',?8,?4,?5,?6)", params![input.id,input.branch_id,sql_number(cursor)?,identity.sender_thread_id,identity.sender_branch_id,encode(&input)?,input.run_id,encode(&input.activation)?.trim_matches('"')])?;
        tx.execute(
            "INSERT INTO input_history_content(input_id,body) VALUES(?1,?2)",
            params![input.id, encode(&prepared.history)?],
        )?;
        tx.execute(
            "INSERT INTO commands(id,intent,receipt) VALUES(?1,?2,?3)",
            params![prepared.key, encode(&prepared.intent)?, encode(&receipt)?],
        )?;
        if let Some(mut operation) = prepared.operation {
            let completion = prepared
                .completion
                .as_ref()
                .expect("prepared completion")
                .1
                .clone();
            if prepared.wait.is_some() {
                reply_wait::register(&tx, &mut operation, identity, cursor, deadline_at_ms, accepted_at_ms)?;
            } else {
                let reference = match &completion {
                    super::result_content::ToolCompletionMetadata::Result { content_ref, .. } => content_ref.clone(),
                    _ => return Err(RuntimeError::Invalid("send completion kind changed".into())),
                };
                operation.phase = OperationPhase::Terminal;
                operation.outcome = Some(Outcome::Succeeded);
                operation.result = Some(OperationResultMetadata::Content { reference });
            }
            operation.effect = Effect::Confirmed;
            operation.call_completion = Some(completion.clone());
            operation.revision += 1;
            put(&tx, "operations", &operation.id, &operation)?;
            tx.execute(
                "DELETE FROM resource_occupancy WHERE operation_id=?1",
                [&operation.id],
            )?;
            let intent = ToolIntent::from_operation(&operation)?;
            if let ToolOrigin::ModelStep { request_id } = intent.origin() {
                let paired = super::result_content::ToolReceiptMetadata {
                    request_id: request_id.clone(),
                    call_id: intent.call().call_id.clone(),
                    completion,
                };
                tx.execute(
                    "UPDATE tool_calls SET receipt=?3 WHERE request_id=?1 AND call_id=?2",
                    params![request_id, intent.call().call_id, encode(&paired)?],
                )?;
            }
            event(
                &tx,
                &operation.id,
                operation.revision,
                if prepared.wait.is_some() { "message.wait_registered" } else { "operation.settled" },
                serde_json::to_value(&operation)?,
            )?;
        }
        reply_wait::accepted_reply(&tx, identity, accepted_at_ms)?;
        tx.commit()?;
        Ok(MessageAdmission {
            receipt,
            accepted: true,
            completion: prepared.completion.map(|v| v.0),
        })
    }
}
impl MessagePreparation {
    pub fn load(self) -> Result<PreparedMessage> {
        self.input.validate()?;
        let intent = MessageIntent {
            sender_thread_id: self.identity.sender_thread_id.clone(),
            sender_branch_id: self.identity.sender_branch_id.clone(),
            actor: self.identity.actor.clone(),
            input: self.input.clone(),
        };
        let intent = self.content.save(&serde_json::to_value(intent)?)?;
        if self
            .existing
            .as_ref()
            .is_some_and(|(original, _)| original != &intent)
        {
            return Err(RuntimeError::Conflict(
                "message key has different original intent".into(),
            ));
        }
        let invocation = self
            .invocation
            .map(|(read, call, schema)| -> Result<_> {
                let snapshot = read.load()?;
                if serde_json::from_value::<MessageInput>(call.arguments.clone())? != self.input
                    || snapshot.call != call
                    || call.name != SEND_TOOL
                    || call.schema_version != schema.version
                    || schema.name != SEND_TOOL
                    || !snapshot.tools.contains(&schema)
                {
                    return Err(RuntimeError::Conflict(
                        "send does not match its original frozen call and selected capability"
                            .into(),
                    ));
                }
                let operation = self.operation.as_ref().expect("captured send operation");
                let actual = ToolIntent::from_operation(operation)?;
                if actual.origin() != &snapshot.context.origin
                    || actual.call().clone().load(&self.content)? != call
                {
                    return Err(RuntimeError::Conflict(
                        "send Operation differs from its original call".into(),
                    ));
                }
                Ok(snapshot)
            })
            .transpose()?;
        let envelope = format!("Task message {}\nSender: {} / {}\nTarget: {} / {}\nActor: {}\nKind: {}\nReply to: {}\n\n{}",
            self.identity.message_id, self.identity.sender_thread_id, self.identity.sender_branch_id, self.identity.target_thread_id, self.identity.target_branch_id,
            serde_json::to_string(&self.identity.actor)?, if self.identity.kind == MessageKind::Request {"request"} else {"inform"}, self.identity.reply_to.as_deref().unwrap_or("none"), self.input.text);
        let body = match &self.identity.actor {
            MessageActor::User => json!(envelope),
            MessageActor::Agent { .. } => serde_json::to_value(ConversationItem {
                resource_activation: None,
                id: self.identity.message_id.clone(),
                provenance: Provenance::AgentMessage {
                    thread_id: self.identity.sender_thread_id.clone(),
                },
                content: Content::Text { text: envelope },
                opaque: None,
            })?,
        };
        let history = self.content.save_history(&body, &None)?;
        let completion = if invocation.is_some() {
            // The stable acceptance handle is staged before commit. acceptedCursor belongs to
            // the message view; the tool receipt does not invent a transaction's future cursor.
            let completion = if self.input.wait.is_some() {
                ToolCompletion::JobAccepted {
                    operation_id: self.operation.as_ref().expect("send Operation").id.clone(),
                    phase: "awaiting_reply".into(), effect: Effect::Confirmed, lifetime: Lifetime::Thread,
                }
            } else { ToolCompletion::Result {
                outcome: Outcome::Succeeded, effect: Effect::Confirmed,
                content: json!({"accepted":true,"message":self.identity}),
            }};
            let metadata =
                super::result_content::ToolCompletionMetadata::write(&self.content, &completion)?;
            Some((completion, metadata))
        } else {
            None
        };
        Ok(PreparedMessage {
            wait: self.input.wait,
            key: self.key,
            identity: self.identity,
            epoch: self.epoch,
            intent,
            history,
            invocation,
            operation: self.operation,
            completion,
            _publication: self.publication,
        })
    }
}
fn summary(db: &Connection, row: QueuedInputMetadata) -> Result<MessageSummary> {
    let activation = activation::project(db, &row)?;
    let identity = message_identity(&row)?.clone();
    let InputOrigin::Message { command_key, .. } = &row.origin else { unreachable!() };
    let receipt: String = db.query_row("SELECT receipt FROM commands WHERE id=?1", [command_key], |r|r.get(0))?;
    let receipt: MessageReceipt = serde_json::from_str(&receipt)?;
    if receipt.identity != identity || receipt.accepted_cursor != row.cursor { return Err(RuntimeError::Invalid("message receipt identity changed".into())); }
    let reply_wait = reply_wait::project(db, &identity)?;
    Ok(MessageSummary {
        receipt, reply_wait,
        state: row.state,
        delivered_run_id: (row.state == InputState::Delivered).then_some(row.run_id).flatten(),
        activation,
        delivered_cursor: row.delivered_cursor,
    })
}
pub struct MessageRead {
    database: std::path::PathBuf,
    epoch: u64,
    summary: MessageSummary,
    intent: Value,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl MessageRead {
    pub fn load(self) -> Result<MessageView> {
        let original: MessageIntent = serde_json::from_value(self.content.load(&self.intent)?)?;
        super::history_views::current_history_owner(&self.database, self.epoch)?;
        Ok(MessageView {
            summary: self.summary,
            text: original.input.text,
        })
    }
}
pub struct MessageListRead {
    database: std::path::PathBuf,
    epoch: u64,
    key: [u8; 32],
    thread: String,
    branch: String,
    direction: MessageDirection,
    cursor: Option<String>,
    limit: usize,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MessageCursor {
    kind: String,
    epoch: u64,
    thread: String,
    branch: String,
    direction: MessageDirection,
    maximum: u64,
    after: u64,
    limit: usize,
}
impl Catalog {
    pub fn capture_message(&self, thread: &str, branch: &str, id: &str) -> Result<MessageRead> {
        branch_owner(&self.db, thread, branch)?;
        let row: QueuedInputMetadata = record(&self.db, "input_queue", id)?;
        let identity = message_identity(&row)?;
        if !(identity.sender_thread_id == thread && identity.sender_branch_id == branch
            || identity.target_thread_id == thread && identity.target_branch_id == branch)
        {
            return Err(RuntimeError::Conflict(
                "message is not owned by this Thread and branch".into(),
            ));
        }
        let InputOrigin::Message { command_key, .. } = &row.origin else {
            unreachable!()
        };
        let intent: String = self.db.query_row(
            "SELECT intent FROM commands WHERE id=?1",
            [command_key],
            |r| r.get(0),
        )?;
        Ok(MessageRead {
            database: self
                .db
                .path()
                .ok_or_else(|| RuntimeError::Invalid("Catalog has no database".into()))?
                .into(),
            epoch: self.epoch,
            summary: summary(&self.db, row)?,
            intent: serde_json::from_str(&intent)?,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn capture_message_list(
        &self,
        thread: String,
        branch: String,
        direction: MessageDirection,
        cursor: Option<String>,
        limit: Option<usize>,
    ) -> Result<MessageListRead> {
        branch_owner(&self.db, &thread, &branch)?;
        let limit = limit.unwrap_or(20);
        if limit == 0 || i64::try_from(limit).is_err() {
            return Err(RuntimeError::Invalid(
                "message page size must be a positive database integer".into(),
            ));
        }
        Ok(MessageListRead {
            database: self
                .db
                .path()
                .ok_or_else(|| RuntimeError::Invalid("Catalog has no database".into()))?
                .into(),
            epoch: self.epoch,
            key: self.plan_cursor_key,
            thread,
            branch,
            direction,
            cursor,
            limit,
        })
    }
}
impl MessageListRead {
    pub fn load(self, cancel: &dyn Fn() -> bool) -> Result<MessagePage> {
        use base64::Engine;
        let check = || {
            if cancel() {
                Err(RuntimeError::DispatchCancelled)
            } else {
                Ok(())
            }
        };
        check()?;
        let db = super::history_views::current_history_owner(&self.database, self.epoch)?;
        db.execute_batch("BEGIN")?;
        branch_owner(&db, &self.thread, &self.branch)?;
        let (maximum, after) = if let Some(token) = &self.cursor {
            let (body, signature) = token
                .split_once('.')
                .ok_or_else(|| RuntimeError::Invalid("invalid message cursor".into()))?;
            let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(body)
                .map_err(|_| RuntimeError::Invalid("invalid message cursor".into()))?;
            let signature = hex::decode(signature)
                .map_err(|_| RuntimeError::Invalid("invalid message cursor".into()))?;
            let expected = super::plan::mac(&self.key, &bytes);
            if signature.len() != expected.len()
                || signature
                    .iter()
                    .zip(expected)
                    .fold(0u8, |v, (a, b)| v | (a ^ b))
                    != 0
            {
                return Err(RuntimeError::Conflict(
                    "message cursor signature changed".into(),
                ));
            }
            let cursor: MessageCursor = serde_json::from_slice(&bytes)?;
            if cursor.kind != "messages"
                || cursor.epoch != self.epoch
                || cursor.thread != self.thread
                || cursor.branch != self.branch
                || cursor.direction != self.direction
                || cursor.limit != self.limit
            {
                return Err(RuntimeError::Conflict(
                    "message cursor belongs to another query".into(),
                ));
            }
            (cursor.maximum, cursor.after)
        } else {
            (
                db.query_row(
                    "SELECT coalesce(max(cursor),0) FROM input_queue WHERE origin='message'",
                    [],
                    |r| read_number(r, 0),
                )?,
                0,
            )
        };
        let predicate = match self.direction {
            MessageDirection::Incoming => "branch_id=?1",
            MessageDirection::Outgoing => "sender_branch_id=?1 AND sender_thread_id=?5",
        };
        let sql=format!("SELECT body FROM input_queue WHERE origin='message' AND {predicate} AND cursor>?2 AND cursor<=?3 ORDER BY cursor LIMIT ?4");
        let mut statement = db.prepare(&sql)?;
        let mut rows = if self.direction == MessageDirection::Incoming {
            statement.query(params![
                self.branch,
                sql_number(after)?,
                sql_number(maximum)?,
                self.limit as i64
            ])?
        } else {
            statement.query(params![
                self.branch,
                sql_number(after)?,
                sql_number(maximum)?,
                self.limit as i64,
                self.thread
            ])?
        };
        let mut messages = Vec::new();
        while let Some(row) = rows.next()? {
            check()?;
            messages.push(summary(&db, serde_json::from_str(&row.get::<_, String>(0)?)?)?);
        }
        drop(rows);
        drop(statement);
        let last = messages
            .last()
            .map(|v| v.receipt.accepted_cursor)
            .unwrap_or(after);
        let has_more: bool = if messages.len() == self.limit {
            match self.direction {
                MessageDirection::Incoming => db.query_row("SELECT EXISTS(SELECT 1 FROM input_queue WHERE origin='message' AND branch_id=?1 AND cursor>?2 AND cursor<=?3)", params![self.branch,sql_number(last)?,sql_number(maximum)?],|r|r.get(0))?,
                MessageDirection::Outgoing => db.query_row("SELECT EXISTS(SELECT 1 FROM input_queue WHERE origin='message' AND sender_branch_id=?1 AND cursor>?2 AND cursor<=?3 AND sender_thread_id=?4)", params![self.branch,sql_number(last)?,sql_number(maximum)?,self.thread],|r|r.get(0))?,
            }
        } else {
            false
        };
        let next_cursor = if has_more {
            let cursor = MessageCursor {
                kind: "messages".into(),
                epoch: self.epoch,
                thread: self.thread,
                branch: self.branch,
                direction: self.direction,
                maximum,
                after: last,
                limit: self.limit,
            };
            let bytes = serde_json::to_vec(&cursor)?;
            Some(format!(
                "{}.{}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes),
                hex::encode(super::plan::mac(&self.key, &bytes))
            ))
        } else {
            None
        };
        super::history_views::current_history_owner(&self.database, self.epoch)?;
        check()?;
        Ok(MessagePage {
            messages,
            next_cursor,
        })
    }
}

#[path = "catalog_message_activation.rs"]
pub mod activation;
pub use activation::{MessageActivation, MessageActivationFact, MessageActivationHold};
