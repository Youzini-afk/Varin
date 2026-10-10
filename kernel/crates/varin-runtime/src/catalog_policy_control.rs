//! Independent delivery and explicit pause use the same policy Operation and immutable history.
use super::policy_body::PolicyActionMetadata;
use super::*;
use crate::execution::*;
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PolicyResumeReceipt {
    pub run_id: String,
    pub action_id: String,
    pub wait_id: String,
    pub cursor: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PolicyPauseInfo {
    pub action_id: String,
    pub wait_id: String,
    pub reason: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ControlResult {
    Delivered {
        item_id: String,
    },
    Pause {
        wait_id: String,
        resume: Option<PolicyResumeReceipt>,
    },
}
fn result(op: &Operation) -> Result<ControlResult> {
    serde_json::from_value(
        op.result
            .as_ref()
            .ok_or_else(|| RuntimeError::Invalid("policy control receipt missing".into()))?
            .control()?
            .clone(),
    )
    .map_err(Into::into)
}
fn control_receipt(action_id: String, item: Option<ConversationItem>) -> PolicyControlReceipt {
    match item {
        Some(item) => PolicyControlReceipt::Delivered { action_id, item },
        None => PolicyControlReceipt::Paused {
            wait_id: pause_wait_id(&action_id),
            action_id,
        },
    }
}
fn pause_wait_id(action: &str) -> String {
    format!("policy-pause:{action}")
}
fn load_intent(
    content: &crate::content::ContentStore,
    metadata: &PolicyActionMetadata,
) -> Result<PolicyControlIntent> {
    let intent: PolicyControlIntent = serde_json::from_value(content.load(metadata.body_ref())?)?;
    if intent.action_id != metadata.action_id()
        || &intent.boundary != metadata.boundary()
        || &intent.identity != metadata.identity()
        || !matches!(
            (&intent.action, metadata),
            (
                PolicyAction::Deliver { .. },
                PolicyActionMetadata::PolicyDeliverV1 { .. }
            ) | (
                PolicyAction::Pause { .. },
                PolicyActionMetadata::PolicyPauseV1 { .. }
            )
        )
    {
        return Err(RuntimeError::Invalid(
            "policy control body differs from its owner".into(),
        ));
    }
    Ok(intent)
}
fn active_owner(db: &Connection, run: &Run) -> Result<()> {
    let (thread, active): (String, Option<String>) = db.query_row(
        "SELECT thread_id,active_run FROM branches WHERE id=?1",
        [&run.branch_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if thread != run.thread_id || active.as_deref() != Some(&run.id) {
        return Err(RuntimeError::Conflict(
            "policy action branch owner changed".into(),
        ));
    }
    Ok(())
}

pub struct PolicyControlPreparation {
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedPolicyControl {
    metadata: PolicyActionMetadata,
    action_id: String,
    boundary: PolicyBoundary,
    identity: PolicyIdentity,
    expected_head: Option<String>,
    checkpoint: super::policy_checkpoint::PolicyCheckpointReferences,
    item: Option<(ConversationItem, Value)>,
    _publication: crate::content::ContentPublication,
}
impl PolicyControlPreparation {
    pub fn load(self, intent: &PolicyControlIntent) -> Result<PreparedPolicyControl> {
        let body_ref = self.content.save(&serde_json::to_value(intent)?)?;
        let (metadata, item) = match &intent.action {
            PolicyAction::Deliver { text } => {
                let item = ConversationItem {
                    resource_activation: None,
                    id: format!("{}:output", intent.action_id),
                    provenance: Provenance::PolicyOutput {
                        action_id: intent.action_id.clone(),
                        identity: intent.identity.clone(),
                    },
                    content: Content::Text { text: text.clone() },
                    opaque: None,
                };
                let reference = self
                    .content
                    .save_history(&serde_json::to_value(&item)?, &None)?;
                (
                    PolicyActionMetadata::PolicyDeliverV1 {
                        action_id: intent.action_id.clone(),
                        boundary: intent.boundary.clone(),
                        identity: intent.identity.clone(),
                        body_ref,
                    },
                    Some((item, reference)),
                )
            }
            PolicyAction::Pause { .. } => (
                PolicyActionMetadata::PolicyPauseV1 {
                    action_id: intent.action_id.clone(),
                    boundary: intent.boundary.clone(),
                    identity: intent.identity.clone(),
                    body_ref,
                },
                None,
            ),
            _ => {
                return Err(RuntimeError::Invalid(
                    "control action requires delivery or pause".into(),
                ))
            }
        };
        Ok(PreparedPolicyControl {
            metadata,
            action_id: intent.action_id.clone(),
            boundary: intent.boundary.clone(),
            identity: intent.identity.clone(),
            expected_head: intent.expected_head.clone(),
            checkpoint: super::policy_checkpoint::PolicyCheckpointReferences::write(
                &self.content,
                &intent.state,
                &intent.action,
            )?,
            item,
            _publication: self.publication,
        })
    }
}

pub(crate) enum PolicyActionRead {
    Graph(super::policy::PolicyGraphRead),
    Model(super::policy_model::PolicyModelRead),
    Control(PolicyControlRead),
}
impl PolicyActionRead {
    pub fn identity(&self) -> &PolicyIdentity {
        match self {
            Self::Graph(read) => read.metadata.identity(),
            Self::Model(read) => read.metadata.identity(),
            Self::Control(read) => read.metadata.identity(),
        }
    }
    pub fn load(self) -> Result<PolicyActionState> {
        Ok(match self {
            Self::Graph(read) => PolicyActionState::Graph(read.load()?),
            Self::Model(read) => PolicyActionState::Model(read.load()?),
            Self::Control(read) => PolicyActionState::Control(read.load()?),
        })
    }
}
pub(crate) struct PolicyControlRead {
    metadata: PolicyActionMetadata,
    op: Operation,
    content: crate::content::ContentStore,
    checkpoint: Option<super::policy_checkpoint::PolicyCheckpointRead>,
    checkpoint_current: bool,
    _publication: crate::content::ContentPublication,
}
impl PolicyControlRead {
    fn load(self) -> Result<PolicyControlState> {
        let intent = load_intent(&self.content, &self.metadata)?;
        let event = match result(&self.op)? {
            ControlResult::Delivered { item_id }
                if self.op.phase == OperationPhase::Terminal
                    && self.op.outcome == Some(Outcome::Succeeded) =>
            {
                PolicyEvent::Delivered {
                    action_id: self.op.id,
                    item_id,
                }
            }
            ControlResult::Pause {
                wait_id,
                resume: Some(receipt),
            } if self.op.phase == OperationPhase::Terminal
                && self.op.outcome == Some(Outcome::Succeeded)
                && receipt.run_id == self.op.run_id
                && receipt.action_id == self.op.id
                && receipt.wait_id == wait_id =>
            {
                PolicyEvent::Resumed {
                    action_id: self.op.id,
                    wait_id,
                }
            }
            _ => {
                return Err(RuntimeError::Conflict(
                    "policy pause has not been explicitly resumed".into(),
                ))
            }
        };
        let mut state = intent.state;
        let mut decision = None;
        if let Some(checkpoint) = self.checkpoint {
            let (saved_state, pending) = checkpoint.load_pending_with_state()?;
            if pending.is_none() {
                state = saved_state;
            } else if self.checkpoint_current {
                decision = pending;
            }
        }
        Ok(PolicyControlState {
            event,
            decision,
            state,
        })
    }
}
pub(crate) struct PolicyPauseRead {
    metadata: PolicyActionMetadata,
    wait_id: String,
}
impl PolicyPauseRead {
    pub(crate) fn load(self, content: &crate::content::ContentStore) -> Result<PolicyPauseInfo> {
        let intent = load_intent(content, &self.metadata)?;
        let PolicyAction::Pause { reason } = intent.action else {
            return Err(RuntimeError::Invalid(
                "pause body has another action".into(),
            ));
        };
        Ok(PolicyPauseInfo {
            action_id: intent.action_id,
            wait_id: self.wait_id,
            reason,
        })
    }
}

impl Catalog {
    pub(crate) fn prepare_policy_action_read(
        &self,
        run_id: &str,
        epoch: u64,
    ) -> Result<Option<PolicyActionRead>> {
        fence(&self.run(run_id)?, epoch)?;
        let Some((op, metadata)) = super::policy_body::latest_action(&self.db, run_id, false)?
        else {
            return Ok(None);
        };
        if super::policy_switch::action_precedes_activation(&self.db, run_id, &op.id)? {
            return Ok(None);
        }
        if op.phase == OperationPhase::Terminal {
            // ReadResult consumes the completion event without opening a model exchange. Its
            // durable ResultChunk continuation must not be replaced by the earlier action.
            let consumed: u64 = self.db.query_row("SELECT coalesce(max(cursor),0) FROM events WHERE subject=?1 AND kind='execution.committed' AND json_extract(data,'$.kind')='policy_decision_consumed'", [run_id], |row| read_number(row, 0))?;
            let completed: u64 = self.db.query_row(
                "SELECT coalesce(max(cursor),0) FROM events WHERE subject=?1",
                [&op.id],
                |row| read_number(row, 0),
            )?;
            if consumed > completed {
                return Ok(None);
            }
        }
        if metadata.graph_nodes().is_some() {
            return Ok(self
                .capture_graph_action(op, metadata)?
                .map(PolicyActionRead::Graph));
        }
        if metadata.is_model() {
            return Ok(self
                .capture_model_action(op, metadata)?
                .map(PolicyActionRead::Model));
        }
        let admitted: u64 = self.db.query_row("SELECT coalesce(max(cursor),0) FROM events WHERE subject=?1 AND kind IN ('policy.delivered','policy.paused')", [&op.id], |row| read_number(row, 0))?;
        let consumed: u64 = self.db.query_row("SELECT coalesce(max(cursor),0) FROM events WHERE subject=?1 AND kind='execution.committed' AND json_extract(data,'$.kind')='request_prepared'", [run_id], |row| read_number(row, 0))?;
        if op.phase == OperationPhase::Terminal && consumed > admitted {
            return Ok(None);
        }
        let checkpoint_cursor: u64 = self.db.query_row("SELECT coalesce(max(cursor),0) FROM events WHERE subject=?1 AND kind='execution.committed' AND json_extract(data,'$.kind')='policy_checkpoint'", [run_id], |row| read_number(row, 0))?;
        let input_cursor: u64 = self.db.query_row("SELECT coalesce(max(cursor),0) FROM events WHERE subject=?1 AND kind='input.delivered'", [run_id], |row| read_number(row, 0))?;
        let checkpoint = if checkpoint_cursor > admitted {
            self.capture_policy_checkpoint(run_id)?
        } else {
            None
        };
        if checkpoint
            .as_ref()
            .is_some_and(|saved| &saved.identity != metadata.identity())
        {
            return Err(RuntimeError::Conflict(
                "policy checkpoint identity changed".into(),
            ));
        }
        Ok(Some(PolicyActionRead::Control(PolicyControlRead {
            metadata,
            op,
            content: self.content.clone(),
            checkpoint,
            checkpoint_current: checkpoint_cursor > input_cursor,
            _publication: self.content.begin_publication(),
        })))
    }
    pub fn prepare_policy_control(&self) -> PolicyControlPreparation {
        PolicyControlPreparation {
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        }
    }
    pub fn commit_policy_control(
        &mut self,
        run_id: &str,
        epoch: u64,
        prepared: PreparedPolicyControl,
    ) -> Result<PolicyControlReceipt> {
        let PreparedPolicyControl {
            metadata,
            action_id,
            boundary,
            identity,
            expected_head,
            checkpoint,
            mut item,
            _publication,
        } = prepared;
        let run = self.run(run_id)?;
        fence(&run, epoch)?;
        if let Some(previous) = optional_record::<Operation>(&self.db, "operations", &action_id)? {
            if previous.run_id != run_id
                || PolicyActionMetadata::from_operation(&previous)?.as_ref() != Some(&metadata)
            {
                return Err(RuntimeError::Conflict(
                    "policy boundary intent changed".into(),
                ));
            }
            return Ok(control_receipt(
                action_id,
                item.take().map(|(item, _)| item),
            ));
        }
        if run.cancel_requested
            || run.state == RunState::Waiting
            || boundary != self.policy_boundary(run_id, epoch)?
            || action_id != format!("{run_id}:policy:{}", boundary.id)
            || self.head(&run.branch_id)? != expected_head
        {
            return Err(RuntimeError::Conflict(
                "policy action boundary changed".into(),
            ));
        }
        if self
            .launch_metadata(run_id)?
            .is_some_and(|launch| launch.selection.policy != identity)
        {
            return Err(RuntimeError::Conflict(
                "policy action differs from pinned launch".into(),
            ));
        }
        let tx = self.db.transaction()?;
        active_owner(&tx, &run)?;
        if super::inputs::has_boundary_inputs(&tx, run_id)? {
            return Err(RuntimeError::InputPending);
        }
        let unsettled: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM tool_calls c JOIN model_steps m ON m.id=c.request_id WHERE m.run_id=?1 AND c.committed=0) OR EXISTS(SELECT 1 FROM model_steps WHERE run_id=?1 AND state NOT IN ('completed','not_dispatched') AND json_extract(body,'$.superseded_by_input') IS NULL)", [run_id], |row| row.get(0))?;
        if unsettled || super::policy_body::has_pending_action(&tx, run_id)? {
            return Err(RuntimeError::Conflict(
                "policy action cannot bypass unsettled work".into(),
            ));
        }
        let saved: Option<String> = tx
            .query_row(
                "SELECT identity FROM policy_checkpoints WHERE run_id=?1",
                [run_id],
                |row| row.get(0),
            )
            .optional()?;
        if saved
            .map(|saved| serde_json::from_str::<PolicyIdentity>(&saved))
            .transpose()?
            .is_some_and(|saved| saved != identity)
        {
            return Err(RuntimeError::Conflict("policy identity changed".into()));
        }
        checkpoint.publish(&tx, run_id, &identity)?;
        let mut op = Operation {
            id: action_id.clone(),
            run_id: run_id.into(),
            epoch,
            revision: 1,
            phase: OperationPhase::Terminal,
            outcome: Some(Outcome::Succeeded),
            effect: Effect::None,
            cancel_requested: false,
            lifetime: Lifetime::Run,
            handed_off: false,
            executor: Some(metadata.executor().into()),
            execution_owner: None,
            waiting_on: None,
            intent: serde_json::to_value(&metadata)?,
            result: None,
            external_receipt: None,
            call_completion: None,
        };
        let control = if let Some((item, reference)) = &item {
            let history = HistoryItem {
                run_id: run.id.clone(),
                id: item.id.clone(),
                thread_id: run.thread_id.clone(),
                parent: expected_head,
                source: HistorySource::Assistant,
                content: reference.clone(),
                provider: None,
            };
            tx.execute(
                "INSERT INTO history(id,thread_id,parent,body,run_id) VALUES(?1,?2,?3,?4,?5)",
                params![
                    history.id,
                    history.thread_id,
                    history.parent,
                    encode(&history)?,
                    run.id
                ],
            )?;
            tx.execute(
                "UPDATE branches SET head=?2 WHERE id=?1",
                params![run.branch_id, history.id],
            )?;
            event(
                &tx,
                &op.id,
                1,
                "policy.delivered",
                json!({"run_id":run_id,"action_id":op.id,"item_id":item.id}),
            )?;
            ControlResult::Delivered {
                item_id: item.id.clone(),
            }
        } else {
            let wait_id = pause_wait_id(&op.id);
            let after_cursor: u64 =
                tx.query_row("SELECT coalesce(max(cursor),0) FROM events", [], |row| {
                    read_number(row, 0)
                })?;
            let wait = Wait {
                id: wait_id.clone(),
                run_id: run_id.into(),
                subject: op.id.clone(),
                kind: "policy.resumed".into(),
                after_cursor,
                deadline_at_ms: None,
                trigger_cursor: None,
                cancelled: false,
            };
            tx.execute(
                "INSERT INTO waits(id,run_id,body) VALUES(?1,?2,?3)",
                params![wait.id, run_id, encode(&wait)?],
            )?;
            op.phase = OperationPhase::Waiting;
            op.outcome = None;
            op.waiting_on = Some(wait_id.clone());
            let mut run = run;
            run.state = RunState::Waiting;
            run.waiting_on = Some(wait_id.clone());
            run.revision += 1;
            put(&tx, "runs", run_id, &run)?;
            event(
                &tx,
                &wait_id,
                1,
                "wait.registered",
                serde_json::to_value(&wait)?,
            )?;
            event(
                &tx,
                &op.id,
                1,
                "policy.paused",
                json!({"run_id":run_id,"action_id":op.id,"wait_id":wait_id}),
            )?;
            event(
                &tx,
                run_id,
                run.revision,
                "run.changed",
                serde_json::to_value(&run)?,
            )?;
            ControlResult::Pause {
                wait_id,
                resume: None,
            }
        };
        op.result = Some(OperationResultMetadata::Control {
            value: serde_json::to_value(control)?,
        });
        tx.execute(
            "INSERT INTO operations(id,run_id,body) VALUES(?1,?2,?3)",
            params![op.id, run_id, encode(&op)?],
        )?;
        tx.commit()?;
        Ok(control_receipt(
            action_id,
            item.take().map(|(item, _)| item),
        ))
    }

    /// An old successful command is answered before examining or quiescing a newer continuation.
    pub fn policy_resume_receipt(
        &self,
        run_id: &str,
        wait_id: &str,
    ) -> Result<Option<PolicyResumeReceipt>> {
        resume_receipt(&self.db, run_id, wait_id)
    }
    pub fn resume_policy_pause(
        &mut self,
        run_id: &str,
        wait_id: &str,
        epoch: u64,
    ) -> Result<PolicyResumeReceipt> {
        let tx = self.db.transaction()?;
        if let Some(receipt) = resume_receipt(&tx, run_id, wait_id)? {
            return Ok(receipt);
        }
        let mut run: Run = record(&tx, "runs", run_id)?;
        fence(&run, epoch)?;
        active_owner(&tx, &run)?;
        let mut wait: Wait = record(&tx, "waits", wait_id)?;
        let mut op: Operation = record(&tx, "operations", &wait.subject)?;
        if op.epoch != epoch {
            return Err(RuntimeError::Conflict(
                "pause belongs to another owner epoch".into(),
            ));
        }
        let cursor = event(
            &tx,
            &op.id,
            op.revision + 1,
            "policy.resumed",
            json!({"run_id":run_id,"action_id":op.id,"wait_id":wait_id}),
        )?;
        let receipt = PolicyResumeReceipt {
            run_id: run_id.into(),
            action_id: op.id.clone(),
            wait_id: wait_id.into(),
            cursor,
        };
        op.phase = OperationPhase::Terminal;
        op.outcome = Some(Outcome::Succeeded);
        op.waiting_on = None;
        op.revision += 1;
        op.result = Some(OperationResultMetadata::Control {
            value: serde_json::to_value(ControlResult::Pause {
                wait_id: wait_id.into(),
                resume: Some(receipt.clone()),
            })?,
        });
        put(&tx, "operations", &op.id, &op)?;
        wait.trigger_cursor = Some(cursor);
        put(&tx, "waits", wait_id, &wait)?;
        Self::enqueue_resume(&tx, &wait, cursor)?;
        tx.execute(
            "UPDATE resumptions SET claimed=?2,acknowledged=1 WHERE wait_id=?1",
            params![wait_id, sql_number(epoch)?],
        )?;
        event(&tx, wait_id, 2, "wait.triggered", json!({"cursor":cursor}))?;
        run.state = RunState::Runnable;
        run.waiting_on = None;
        run.revision += 1;
        put(&tx, "runs", run_id, &run)?;
        if let Some(mut launch) =
            optional_record::<super::launch_content::LaunchMetadata>(&tx, "run_launches", run_id)?
        {
            launch.bound_epoch = None;
            launch.requires_rebind = true;
            launch.revision += 1;
            put(&tx, "run_launches", run_id, &launch)?;
        }
        event(
            &tx,
            run_id,
            run.revision,
            "run.resumed",
            json!({"wait_id":wait_id,"action_id":op.id}),
        )?;
        tx.commit()?;
        Ok(receipt)
    }
    /// Catalog eligibility is shared by supervisor admission and the read-only launch view.
    pub fn run_startable(&self, run_id: &str) -> Result<bool> {
        run_startable(&self.db, &self.run(run_id)?)
    }
    pub(crate) fn capture_policy_pause(&self, run_id: &str) -> Result<Option<PolicyPauseRead>> {
        let run = self.run(run_id)?;
        let Some(wait_id) = run.waiting_on.filter(|_| run.state == RunState::Waiting) else {
            return Ok(None);
        };
        let wait: Wait = record(&self.db, "waits", &wait_id)?;
        if wait.kind != "policy.resumed" {
            return Ok(None);
        }
        let op: Operation = record(&self.db, "operations", &wait.subject)?;
        let metadata = pause_owner(&op, &wait, run_id)?;
        Ok(Some(PolicyPauseRead { metadata, wait_id }))
    }
}
fn pause_owner(op: &Operation, wait: &Wait, run_id: &str) -> Result<PolicyActionMetadata> {
    let metadata = PolicyActionMetadata::from_operation(op)?
        .filter(|metadata| matches!(metadata, PolicyActionMetadata::PolicyPauseV1 { .. }))
        .ok_or_else(|| RuntimeError::Invalid("wait is not a policy pause".into()))?;
    if op.run_id != run_id
        || wait.run_id != run_id
        || wait.subject != op.id
        || wait.kind != "policy.resumed"
        || wait.id != pause_wait_id(&op.id)
    {
        return Err(RuntimeError::Conflict(
            "pause wait ownership changed".into(),
        ));
    }
    Ok(metadata)
}
fn resume_receipt(
    db: &Connection,
    run_id: &str,
    wait_id: &str,
) -> Result<Option<PolicyResumeReceipt>> {
    let wait: Wait = record(db, "waits", wait_id)?;
    let op: Operation = record(db, "operations", &wait.subject)?;
    pause_owner(&op, &wait, run_id)?;
    let ControlResult::Pause {
        wait_id: saved,
        resume,
    } = result(&op)?
    else {
        return Err(RuntimeError::Invalid(
            "pause result has another action".into(),
        ));
    };
    if saved != wait_id {
        return Err(RuntimeError::Invalid("pause result wait changed".into()));
    }
    if let Some(receipt) = resume {
        if receipt.run_id != run_id
            || receipt.wait_id != wait_id
            || receipt.action_id != op.id
            || wait.trigger_cursor != Some(receipt.cursor)
            || op.phase != OperationPhase::Terminal
            || op.outcome != Some(Outcome::Succeeded)
        {
            return Err(RuntimeError::Invalid("pause resume receipt changed".into()));
        }
        return Ok(Some(receipt));
    }
    let run: Run = record(db, "runs", run_id)?;
    if run.cancel_requested
        || run.state != RunState::Waiting
        || run.waiting_on.as_deref() != Some(wait_id)
        || wait.cancelled
        || wait.trigger_cursor.is_some()
        || op.cancel_requested
        || op.phase != OperationPhase::Waiting
        || op.waiting_on.as_deref() != Some(wait_id)
    {
        return Err(RuntimeError::Conflict(
            "Run is not waiting on this policy pause".into(),
        ));
    }
    active_owner(db, &run)?;
    Ok(None)
}
pub(crate) fn run_startable(db: &Connection, run: &Run) -> Result<bool> {
    if run.cancel_requested || run.state.terminal() {
        return Ok(false);
    }
    match run.state {
        RunState::Accepted | RunState::Preparing | RunState::Runnable => Ok(true),
        RunState::Waiting => {
            let wait: Wait = record(
                db,
                "waits",
                run.waiting_on.as_deref().ok_or_else(|| {
                    RuntimeError::Invalid("waiting Run lacks its condition".into())
                })?,
            )?;
            Ok(wait.run_id == run.id
                && !wait.cancelled
                && matches!(
                    wait.kind.as_str(),
                    "launch.prepared" | "recovery.reconciled" | "execution.reconciled"
                ))
        }
        _ => Ok(false),
    }
}
pub(crate) fn cancel_run_pause(tx: &Transaction<'_>, run: &Run) -> Result<()> {
    let Some(wait_id) = &run.waiting_on else {
        return Ok(());
    };
    let mut wait: Wait = record(tx, "waits", wait_id)?;
    if wait.kind != "policy.resumed" {
        return Ok(());
    }
    let mut op: Operation = record(tx, "operations", &wait.subject)?;
    pause_owner(&op, &wait, &run.id)?;
    if op.phase != OperationPhase::Terminal {
        op.phase = OperationPhase::Terminal;
        op.outcome = Some(Outcome::Cancelled);
        op.cancel_requested = true;
        op.revision += 1;
        put(tx, "operations", &op.id, &op)?;
        wait.cancelled = true;
        put(tx, "waits", wait_id, &wait)?;
        event(
            tx,
            &op.id,
            op.revision,
            "policy.pause_cancelled",
            json!({"run_id":run.id,"wait_id":wait_id}),
        )?;
    }
    Ok(())
}
