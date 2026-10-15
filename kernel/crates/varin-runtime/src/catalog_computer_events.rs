//! Trusted desktop facts use the original ingress queue. The desktop owner retains its outbox
//! until this Catalog acknowledges acceptance; it remains the sole physical control authority.
use super::*;
use crate::execution::{Content, ConversationItem, Provenance};
use computer_requests::ComputerExecution;
use serde::Deserialize;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComputerEventKind {
    Takeover,
    Cancel,
    Handback,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerEventFact {
    pub id: String,
    pub kind: ComputerEventKind,
    pub desktop_id: String,
    pub execution: ComputerExecution,
    pub at: String,
    pub release_confirmed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerEventCommand {
    pub fact: ComputerEventFact,
    pub label: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerEventCancellation {
    pub id: String,
    pub execution: ComputerExecution,
    pub desktop_id: String,
    pub pending_event_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerEventReceipt {
    pub event_id: String,
    pub input_ids: Vec<String>,
    pub cursor: u64,
}

pub struct ComputerEventPreparation {
    command: ComputerEventCommand,
    root_thread: String,
    root_branch: String,
    epoch: u64,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedComputerEvent {
    fact: ComputerEventFact,
    root_thread: String,
    root_branch: String,
    epoch: u64,
    history: Value,
    _publication: crate::content::ContentPublication,
}
fn event_key(fact: &ComputerEventFact) -> String {
    format!(
        "computer-control:{}:{}",
        encode(&fact.kind).expect("enum").trim_matches('"'),
        fact.id
    )
}
fn actor_input(fact: &ComputerEventFact) -> String {
    format!("{}:actor", event_key(fact))
}
fn root_input(fact: &ComputerEventFact) -> String {
    format!("{}:root", event_key(fact))
}
fn cancellation_key(id: &str) -> String {
    format!("computer-control:handback:{id}:actor")
}
impl ComputerEventPreparation {
    pub fn load(self) -> Result<PreparedComputerEvent> {
        let command = self.command;
        let fact = command.fact;
        let detail = match fact.kind {
            ComputerEventKind::Takeover if fact.release_confirmed => {
                "The human took control. Automatic input is paused until control is returned."
            }
            ComputerEventKind::Takeover => {
                "The human took control. Automatic input is paused and original input release is unconfirmed."
            }
            ComputerEventKind::Handback => {
                "The human returned control. Observe the current desktop and obtain a current binding before acting; old observations and queued actions cannot resume."
            }
            ComputerEventKind::Cancel if fact.release_confirmed => {
                "The human cancelled this computer work. The original managed input was released. Already dispatched actions may have left partial effects. Computer Use permissions are unchanged."
            }
            ComputerEventKind::Cancel => {
                "The human cancelled this computer work. Original input release is unconfirmed. Computer Use permissions are unchanged; resolve the original cleanup before taking control."
            }
        };
        let item: ConversationItem = ConversationItem {
            id: event_key(&fact),
            resource_activation: None,
            provenance: Provenance::EnvironmentFact {
                event_id: event_key(&fact),
            },
            content: Content::Text {
                text: format!(
                    "Desktop control fact for {} ({}) at {}. Original Thread {} / Run {}. {}",
                    command.label,
                    fact.desktop_id,
                    fact.at,
                    fact.execution.thread_id,
                    fact.execution.run_id,
                    detail
                ),
            },
            opaque: None,
        };
        let history = self
            .content
            .save_history(&serde_json::to_value(item)?, &None)?;
        Ok(PreparedComputerEvent {
            fact,
            root_thread: self.root_thread,
            root_branch: self.root_branch,
            epoch: self.epoch,
            history,
            _publication: self.publication,
        })
    }
}
fn validate_execution(db: &Connection, execution: &ComputerExecution) -> Result<Run> {
    let run: Run = record(db, "runs", &execution.run_id)?;
    if run.thread_id != execution.thread_id || run.branch_id != execution.branch_id {
        return Err(RuntimeError::Conflict(
            "Computer fact execution identity changed".into(),
        ));
    }
    Ok(run)
}
fn revoked(db: &Connection, fact: &ComputerEventFact) -> Result<bool> {
    let prior: Option<String> = db
        .query_row(
            "SELECT data FROM events WHERE subject=?1 AND kind='computer.handback_cancelled'",
            [actor_input(fact)],
            |r| r.get(0),
        )
        .optional()?;
    let Some(prior) = prior else { return Ok(false) };
    if serde_json::from_str::<Value>(&prior)?
        != json!({"execution":fact.execution,"desktopId":fact.desktop_id})
    {
        return Err(RuntimeError::Conflict(
            "Computer handback cancellation identity changed".into(),
        ));
    }
    Ok(true)
}
fn source_stopped(db: &Connection, fact: &ComputerEventFact) -> Result<bool> {
    let run = validate_execution(db, &fact.execution)?;
    let tree: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM events WHERE subject=?1 AND kind='run.tree_stop_requested')",
        [&run.id],
        |r| r.get(0),
    )?;
    let ended_goal = goals::for_run(db, &run.id)?.is_some_and(|goal| goal.ended());
    Ok(run.cancel_requested
        || run.state == RunState::Cancelled
        || tree
        || ended_goal
        || revoked(db, fact)?)
}
pub(super) fn ingress_hold(
    db: &Connection,
    row: &inputs::QueuedInputMetadata,
) -> Result<Option<String>> {
    let inputs::InputOrigin::ComputerEvent { fact, .. } = &row.origin else {
        return Ok(None);
    };
    Ok(
        (row.activation == inputs::InputActivation::Activating && source_stopped(db, fact)?)
            .then(|| "computer_handback_cancelled".into()),
    )
}
fn eligible(db: &Connection, fact: &ComputerEventFact) -> Result<bool> {
    if fact.kind != ComputerEventKind::Handback || source_stopped(db, fact)? {
        return Ok(false);
    }
    let active: Option<String> = db.query_row(
        "SELECT active_run FROM branches WHERE id=?1",
        [&fact.execution.branch_id],
        |r| r.get(0),
    )?;
    if let Some(active) = active {
        return Ok(active == fact.execution.run_id);
    }
    let latest = activation::latest_run(db, &fact.execution.branch_id)?;
    let pending: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM delegated_executions e JOIN child_tasks c ON c.id=e.child_operation_id WHERE c.child_thread_id=?1 AND json_extract(c.body,'$.child_branch_id')=?2 AND e.run_id IS NULL AND json_extract(e.body,'$.report') IS NULL AND json_extract(e.body,'$.cancel_requested')=0)", params![fact.execution.thread_id,fact.execution.branch_id], |r| r.get(0))?;
    Ok(latest.as_ref().map(|run| run.id.as_str()) == Some(&fact.execution.run_id) && !pending)
}
impl Catalog {
    pub fn prepare_computer_event(
        &self,
        command: ComputerEventCommand,
    ) -> Result<ComputerEventPreparation> {
        if command.fact.id.trim().is_empty()
            || command.fact.desktop_id.trim().is_empty()
            || command.fact.at.trim().is_empty()
            || command.label.trim().is_empty()
        {
            return Err(RuntimeError::Invalid(
                "Computer fact requires its original identity, desktop, time and label".into(),
            ));
        }
        if command.fact.kind == ComputerEventKind::Handback && !command.fact.release_confirmed {
            return Err(RuntimeError::Invalid(
                "Handback requires the original owner to confirm input release".into(),
            ));
        }
        let scope = self.computer_scope(
            &command.fact.execution.thread_id,
            &command.fact.execution.branch_id,
            Some(&command.fact.execution.run_id),
            None,
        )?;
        Ok(ComputerEventPreparation {
            command,
            root_thread: scope.root_thread_id,
            root_branch: scope.root_branch_id,
            epoch: self.epoch,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    pub fn admit_computer_event(
        &mut self,
        prepared: PreparedComputerEvent,
    ) -> Result<ComputerEventReceipt> {
        if prepared.epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "Computer input owner changed".into(),
            ));
        }
        let fact = prepared.fact;
        let input_id = actor_input(&fact);
        let mut input_ids = vec![input_id.clone()];
        if prepared.root_thread != fact.execution.thread_id
            || prepared.root_branch != fact.execution.branch_id
        {
            input_ids.push(root_input(&fact));
        }
        let tx = self.db.transaction()?;
        if let Some(old) =
            optional_record::<inputs::QueuedInputMetadata>(&tx, "input_queue", &input_id)?
        {
            let old_history: String = tx.query_row(
                "SELECT body FROM input_history_content WHERE input_id=?1",
                [&input_id],
                |r| r.get(0),
            )?;
            if !matches!(&old.origin, inputs::InputOrigin::ComputerEvent { fact: old_fact, .. } if old_fact == &fact)
                || serde_json::from_str::<Value>(&old_history)? != prepared.history
            {
                return Err(RuntimeError::Conflict(
                    "Computer event identity changed".into(),
                ));
            }
            return Ok(ComputerEventReceipt {
                event_id: event_key(&fact),
                input_ids,
                cursor: old.cursor,
            });
        }
        validate_execution(&tx, &fact.execution)?;
        let activation = if eligible(&tx, &fact)? {
            activation::accept_target(&tx, &fact.execution.thread_id, &fact.execution.branch_id)?
        } else {
            activation::IngressActivationFact::Passive
        };
        let cursor = event(
            &tx,
            &input_id,
            1,
            "computer.control_received",
            serde_json::to_value(&fact)?,
        )?;
        ingress::insert_occurrence(
            &tx,
            input_id,
            fact.execution.thread_id.clone(),
            fact.execution.branch_id.clone(),
            cursor,
            inputs::InputOrigin::ComputerEvent {
                fact: fact.clone(),
                activation,
            },
            &prepared.history,
        )?;
        if input_ids.len() == 2 {
            ingress::insert_occurrence(
                &tx,
                root_input(&fact),
                prepared.root_thread,
                prepared.root_branch,
                cursor,
                inputs::InputOrigin::ComputerEvent {
                    fact: fact.clone(),
                    activation: activation::IngressActivationFact::Passive,
                },
                &prepared.history,
            )?;
        }
        tx.commit()?;
        Ok(ComputerEventReceipt {
            event_id: event_key(&fact),
            input_ids,
            cursor,
        })
    }
    /// Cancel only handbacks captured by this Computer Stop. Future work in the same Run is allowed.
    /// Exact tombstones also cover an original desktop outbox transfer still preparing its body.
    pub fn cancel_computer_events(&mut self, command: ComputerEventCancellation) -> Result<()> {
        let tx = self.db.transaction()?;
        validate_execution(&tx, &command.execution)?;
        let command_key = format!("computer-stop:{}", command.id);
        let command_identity = serde_json::to_value(&command)?;
        let prior: Option<String> = tx.query_row("SELECT data FROM events WHERE subject=?1 AND kind='computer.handback_stop_received'", [&command_key], |r| r.get(0)).optional()?;
        if let Some(prior) = prior {
            if serde_json::from_str::<Value>(&prior)? != command_identity {
                return Err(RuntimeError::Conflict(
                    "Computer Stop identity changed".into(),
                ));
            }
            return Ok(());
        }
        let mut ids = command
            .pending_event_ids
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>();
        let rows = {
            let mut q = tx.prepare("SELECT body FROM input_queue WHERE branch_id=?1 AND origin='computer_event' AND state='queued'")?;
            let rows = q.query_map([&command.execution.branch_id], |r| r.get::<_, String>(0))?;
            rows.map(|r| Ok(serde_json::from_str::<inputs::QueuedInputMetadata>(&r?)?))
                .collect::<Result<Vec<_>>>()?
        };
        for row in &rows {
            if let inputs::InputOrigin::ComputerEvent { fact, .. } = &row.origin {
                if fact.kind == ComputerEventKind::Handback
                    && fact.execution == command.execution
                    && fact.desktop_id == command.desktop_id
                {
                    ids.insert(fact.id.clone());
                }
            }
        }
        for id in ids {
            let key = cancellation_key(&id);
            let identity = json!({"execution":command.execution,"desktopId":command.desktop_id});
            let prior: Option<String> = tx.query_row("SELECT data FROM events WHERE subject=?1 AND kind='computer.handback_cancelled'", [&key], |r| r.get(0)).optional()?;
            if let Some(prior) = prior {
                if serde_json::from_str::<Value>(&prior)? != identity {
                    return Err(RuntimeError::Conflict(
                        "Computer handback cancellation identity changed".into(),
                    ));
                }
            } else {
                event(&tx, &key, 1, "computer.handback_cancelled", identity)?;
            }
            if let Some(mut row) =
                optional_record::<inputs::QueuedInputMetadata>(&tx, "input_queue", &key)?
            {
                if !matches!(&row.origin, inputs::InputOrigin::ComputerEvent { fact, .. } if fact.execution == command.execution && fact.desktop_id == command.desktop_id)
                {
                    return Err(RuntimeError::Conflict(
                        "Computer handback cancellation target changed".into(),
                    ));
                }
                activation::cancel_row(&tx, &mut row)?;
            }
        }
        event(
            &tx,
            &command_key,
            1,
            "computer.handback_stop_received",
            command_identity,
        )?;
        tx.commit()?;
        Ok(())
    }
}
