//! Request activation belongs to the ingress row. Run, Wait and delegated execution remain
//! the owners of actual work; projections below never copy their lifecycle into a message.
use super::inputs::{InputOrigin, QueuedInputMetadata};
use super::messages::MessageIdentity;
use super::*;
use serde::Deserialize;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum IngressActivationFact {
    Passive,
    Pending {
        execution_id: Option<String>,
    },
    Bound {
        run_id: String,
        execution_id: Option<String>,
    },
    Cancelled {
        run_id: Option<String>,
        execution_id: Option<String>,
    },
    Failed {
        execution_id: Option<String>,
        code: String,
    },
}
impl IngressActivationFact {
    pub(in crate::catalog) fn run_id(&self) -> Option<&str> {
        match self {
            Self::Bound { run_id, .. } => Some(run_id),
            Self::Cancelled { run_id, .. } => run_id.as_deref(),
            _ => None,
        }
    }
    pub(in crate::catalog) fn execution_id(&self) -> Option<&str> {
        match self {
            Self::Pending { execution_id }
            | Self::Bound { execution_id, .. }
            | Self::Cancelled { execution_id, .. }
            | Self::Failed { execution_id, .. } => execution_id.as_deref(),
            _ => None,
        }
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageActivationHold {
    ManualPause,
    Question,
    GoalBlocked,
    DependencyWait,
    Preparing,
    SourceUnsettled,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MessageActivation {
    Passive,
    Pending {
        execution_id: Option<String>,
        hold_reason: Option<MessageActivationHold>,
    },
    Bound {
        run_id: String,
        execution_id: Option<String>,
        hold_reason: Option<MessageActivationHold>,
    },
    Cancelled {
        run_id: Option<String>,
        execution_id: Option<String>,
    },
    Failed {
        execution_id: Option<String>,
        code: String,
    },
}
pub(in crate::catalog) fn fact(row: &QueuedInputMetadata) -> Result<&IngressActivationFact> {
    match &row.origin {
        InputOrigin::Message { activation, .. } | InputOrigin::Followup { activation, .. } => {
            Ok(activation)
        }
        _ => Err(RuntimeError::Invalid(
            "ingress activation requires a typed activating input".into(),
        )),
    }
}
pub(in crate::catalog) fn set_fact(row: &mut QueuedInputMetadata, next: IngressActivationFact) {
    if let InputOrigin::Message { activation, .. } | InputOrigin::Followup { activation, .. } =
        &mut row.origin
    {
        *activation = next;
    }
}
fn execution_for_run(db: &Connection, run: &str) -> Result<Option<String>> {
    Ok(db
        .query_row(
            "SELECT id FROM delegated_executions WHERE run_id=?1",
            [run],
            |r| r.get(0),
        )
        .optional()?)
}
fn goal_hold(db: &Connection, run: &Run) -> Result<bool> {
    let goal = goals::for_run(db, &run.id)?
        .filter(|g| !g.ended())
        .or(goals::active_for_branch(db, &run.branch_id)?);
    let Some(goal) = goal else { return Ok(false) };
    let usage: goals::GoalUsage = record(db, "goal_usage", &goal.id)?;
    Ok(goal.control == goals::GoalControl::Paused
        || (goal.blocked.is_some() && !followups::dependency_check_for_run(db, &run.id, &goal)?)
        || goals::budget_limited(&goal, &usage)
        || goals::usage_unknown(&goal, &usage))
}
fn row_goal_hold(db: &Connection, row: &QueuedInputMetadata, run: &Run) -> Result<bool> {
    if !goal_hold(db, run)? {
        return Ok(false);
    }
    if matches!(row.origin, InputOrigin::Followup { .. })
        && followups::pending_dependency_check(db, row)?
    {
        return Ok(false);
    }
    Ok(true)
}
pub(in crate::catalog) fn run_hold(
    db: &Connection,
    run: &Run,
) -> Result<Option<MessageActivationHold>> {
    if goal_hold(db, run)? {
        return Ok(Some(MessageActivationHold::GoalBlocked));
    }
    if run.state == RunState::Waiting {
        let id = run
            .waiting_on
            .as_deref()
            .ok_or_else(|| RuntimeError::Invalid("waiting Run has no Wait".into()))?;
        let wait: Wait = record(db, "waits", id)?;
        if wait.run_id != run.id {
            return Err(RuntimeError::Invalid("request Wait owner changed".into()));
        }
        return Ok(Some(if id.starts_with("policy-pause:") {
            MessageActivationHold::ManualPause
        } else if id.starts_with("question:") {
            MessageActivationHold::Question
        } else if super::observations::is_observation_id(id) {
            MessageActivationHold::DependencyWait
        } else {
            MessageActivationHold::Preparing
        }));
    }
    Ok(
        matches!(run.state, RunState::Accepted | RunState::Preparing)
            .then_some(MessageActivationHold::Preparing),
    )
}
fn latest_run(db: &Connection, branch: &str) -> Result<Option<Run>> {
    let raw: Option<String> = db
        .query_row(
            "SELECT body FROM runs WHERE branch_id=?1 ORDER BY rowid DESC LIMIT 1",
            [branch],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
        .transpose()
}
fn pending_execution(db: &Connection, thread: &str, branch: &str) -> Result<Option<String>> {
    Ok(db.query_row("SELECT e.id FROM delegated_executions e JOIN child_tasks c ON c.id=e.child_operation_id WHERE c.child_thread_id=?1 AND json_extract(c.body,'$.child_branch_id')=?2 AND e.run_id IS NULL AND json_extract(e.body,'$.report') IS NULL AND json_extract(e.body,'$.cancel_requested')=0 ORDER BY e.rowid LIMIT 1",params![thread,branch],|r|r.get(0)).optional()?)
}
pub(in crate::catalog) fn accept(
    db: &Connection,
    identity: &MessageIdentity,
) -> Result<IngressActivationFact> {
    if identity.kind == MessageKind::Inform {
        return Ok(IngressActivationFact::Passive);
    }
    accept_target(db, &identity.target_thread_id, &identity.target_branch_id)
}
pub(in crate::catalog) fn accept_target(
    db: &Connection,
    thread: &str,
    branch: &str,
) -> Result<IngressActivationFact> {
    let active: Option<String> = db.query_row(
        "SELECT active_run FROM branches WHERE id=?1",
        [branch],
        |r| r.get(0),
    )?;
    if let Some(run_id) = active {
        let run: Run = record(db, "runs", &run_id)?;
        if !run.cancel_requested && !run.state.terminal() {
            return Ok(IngressActivationFact::Bound {
                execution_id: execution_for_run(db, &run_id)?,
                run_id,
            });
        }
    }
    Ok(IngressActivationFact::Pending {
        execution_id: pending_execution(db, thread, branch)?,
    })
}
pub(in crate::catalog) fn project(
    db: &Connection,
    row: &QueuedInputMetadata,
) -> Result<MessageActivation> {
    Ok(match fact(row)? {
        IngressActivationFact::Passive => MessageActivation::Passive,
        IngressActivationFact::Cancelled {
            run_id,
            execution_id,
        } => MessageActivation::Cancelled {
            run_id: run_id.clone(),
            execution_id: execution_id.clone(),
        },
        IngressActivationFact::Failed { execution_id, code } => MessageActivation::Failed {
            execution_id: execution_id.clone(),
            code: code.clone(),
        },
        IngressActivationFact::Pending { execution_id } => {
            let mut hold = Some(MessageActivationHold::Preparing);
            if let Some(id) = execution_id {
                let execution = delegated::execution(db, id)?;
                if execution.cancel_requested {
                    return Ok(MessageActivation::Cancelled {
                        run_id: execution.receipt.map(|r| r.run_id),
                        execution_id: Some(id.clone()),
                    });
                }
                if execution.report.is_some() {
                    return Ok(MessageActivation::Failed {
                        execution_id: Some(id.clone()),
                        code: "preparation_failed".into(),
                    });
                }
            } else if let Some(run) = latest_run(db, &row.branch_id)? {
                if goal_hold(db, &run)? {
                    hold = Some(MessageActivationHold::GoalBlocked)
                } else if let Some(id) = execution_for_run(db, &run.id)? {
                    let previous = delegated::execution(db, &id)?;
                    if previous.report.is_none() || !previous.code_result.settled() {
                        hold = Some(MessageActivationHold::SourceUnsettled)
                    }
                }
            }
            MessageActivation::Pending {
                execution_id: execution_id.clone(),
                hold_reason: hold,
            }
        }
        IngressActivationFact::Bound {
            run_id,
            execution_id,
        } => {
            let run: Run = record(db, "runs", run_id)?;
            MessageActivation::Bound {
                run_id: run_id.clone(),
                execution_id: execution_id.clone(),
                hold_reason: if row.state == InputState::Delivered || run.state.terminal() {
                    None
                } else {
                    run_hold(db, &run)?
                },
            }
        }
    })
}
pub(in crate::catalog) fn write_changed(
    tx: &Transaction<'_>,
    row: &mut QueuedInputMetadata,
    next: IngressActivationFact,
) -> Result<()> {
    if fact(row)? == &next {
        return Ok(());
    }
    set_fact(row, next);
    row.revision += 1;
    inputs::write_input(tx, row)?;
    event(
        tx,
        &row.id,
        row.revision,
        if matches!(row.origin, InputOrigin::Followup { .. }) {
            "followup.activation_changed"
        } else {
            "message.activation_changed"
        },
        json!({"input_id":row.id}),
    )?;
    Ok(())
}
/// The branch's real admission wins once. Pending requests cannot miss an intervening User Run.
pub(in crate::catalog) fn bind_pending(tx: &Transaction<'_>, run: &Run) -> Result<()> {
    if run.cancel_requested || run.state.terminal() {
        return Ok(());
    }
    let execution_id = execution_for_run(tx, &run.id)?;
    let rows = {
        let mut q=tx.prepare("SELECT body FROM input_queue WHERE branch_id=?1 AND origin IN ('message','followup') AND state='queued' AND json_extract(body,'$.origin.activation.state')='pending' ORDER BY cursor")?;
        let rows = q.query_map([&run.branch_id], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?))
            .collect::<Result<Vec<QueuedInputMetadata>>>()?
    };
    for mut row in rows {
        let pending = fact(&row)?.execution_id();
        if pending.is_some() && pending != execution_id.as_deref() {
            continue;
        }
        if followups::ingress_hold(tx, &row, Some(run))?.is_some() {
            continue;
        }
        followups::refresh_ingress_goal(tx, &mut row)?;
        row.run_id = Some(run.id.clone());
        write_changed(
            tx,
            &mut row,
            IngressActivationFact::Bound {
                run_id: run.id.clone(),
                execution_id: execution_id.clone(),
            },
        )?;
    }
    Ok(())
}
pub(in crate::catalog) fn bind_execution(
    tx: &Transaction<'_>,
    branch: &str,
    execution_id: &str,
) -> Result<()> {
    let rows = {
        let mut q=tx.prepare("SELECT body FROM input_queue WHERE branch_id=?1 AND origin IN ('message','followup') AND state='queued' AND json_extract(body,'$.origin.activation.state')='pending' AND json_extract(body,'$.origin.activation.execution_id') IS NULL ORDER BY cursor")?;
        let rows = q.query_map([branch], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?))
            .collect::<Result<Vec<QueuedInputMetadata>>>()?
    };
    for mut row in rows {
        if followups::ingress_hold(tx, &row, None)?.is_some() {
            continue;
        }
        write_changed(
            tx,
            &mut row,
            IngressActivationFact::Pending {
                execution_id: Some(execution_id.into()),
            },
        )?;
    }
    Ok(())
}
pub(in crate::catalog) fn cancel_row(
    tx: &Transaction<'_>,
    row: &mut QueuedInputMetadata,
) -> Result<()> {
    if row.state != InputState::Queued {
        return Ok(());
    }
    let current = fact(row)?.clone();
    if matches!(
        current,
        IngressActivationFact::Passive
            | IngressActivationFact::Cancelled { .. }
            | IngressActivationFact::Failed { .. }
    ) {
        return Ok(());
    }
    row.state = InputState::Cancelled;
    write_changed(
        tx,
        row,
        IngressActivationFact::Cancelled {
            run_id: current.run_id().map(str::to_owned),
            execution_id: current.execution_id().map(str::to_owned),
        },
    )
}
pub(in crate::catalog) fn cancel_run(tx: &Transaction<'_>, run: &str) -> Result<()> {
    let rows = {
        let mut q=tx.prepare("SELECT body FROM input_queue WHERE run_id=?1 AND origin IN ('message','followup') AND state='queued' AND activation='activating'")?;
        let rows = q.query_map([run], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?))
            .collect::<Result<Vec<QueuedInputMetadata>>>()?
    };
    for mut row in rows {
        cancel_row(tx, &mut row)?;
    }
    Ok(())
}
pub(in crate::catalog) fn cancel_thread(tx: &Transaction<'_>, thread: &str) -> Result<()> {
    let rows = {
        let mut q=tx.prepare("SELECT q.body FROM input_queue q JOIN branches b ON b.id=q.branch_id WHERE b.thread_id=?1 AND q.origin IN ('message','followup') AND q.state='queued' AND q.activation='activating'")?;
        let rows = q.query_map([thread], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?))
            .collect::<Result<Vec<QueuedInputMetadata>>>()?
    };
    for mut row in rows {
        cancel_row(tx, &mut row)?;
    }
    Ok(())
}
/// The original message history is the first new-Run input; it is never converted to User text.
pub(in crate::catalog) fn delivered_submission(
    tx: &Transaction<'_>,
    input: &QueuedInputMetadata,
    run: &Run,
    cursor: u64,
) -> Result<()> {
    let mut row: QueuedInputMetadata = record(tx, "input_queue", &input.id)?;
    if row != *input || row.state != InputState::Queued {
        return Err(RuntimeError::Conflict(
            "message activation changed before Run admission".into(),
        ));
    }
    let execution_id = execution_for_run(tx, &run.id)?;
    match fact(&row)? {
        IngressActivationFact::Pending {
            execution_id: pending,
        } if pending.is_none() || pending == &execution_id => (),
        _ => {
            return Err(RuntimeError::Conflict(
                "message already bound to another admission".into(),
            ))
        }
    }
    row.run_id = Some(run.id.clone());
    row.state = InputState::Delivered;
    row.delivered_cursor = Some(cursor);
    write_changed(
        tx,
        &mut row,
        IngressActivationFact::Bound {
            run_id: run.id.clone(),
            execution_id,
        },
    )?;
    followups::delivered(tx, &row)?;
    event(
        tx,
        &run.id,
        run.revision,
        "input.delivered",
        json!({"input_id":row.id,"mode":row.mode}),
    )?;
    Ok(())
}

pub(in crate::catalog) fn validate_pending(
    db: &Connection,
    row: &QueuedInputMetadata,
) -> Result<()> {
    let current: QueuedInputMetadata = record(db, "input_queue", &row.id)?;
    if &current != row
        || current.state != InputState::Queued
        || !matches!(
            fact(&current)?,
            IngressActivationFact::Pending { execution_id: None }
        )
    {
        return Err(RuntimeError::RequestActivationStale);
    }
    Ok(())
}
pub struct RootCapture {
    row: QueuedInputMetadata,
    run: Run,
    launch: launch_content::LaunchMetadata,
    head: Option<String>,
    checkpoint: Option<context::CheckpointRead>,
    epoch: u64,
    history: Value,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub enum RequestActivationPreparation {
    Root(RootCapture),
    Child {
        row: QueuedInputMetadata,
        preparation: delegated::ChildContinuationPreparation,
    },
}
pub enum PreparedRequestActivation {
    Root {
        row: QueuedInputMetadata,
        previous: Run,
        launch: launch_content::LaunchMetadata,
        submission: submissions::PreparedSubmission,
    },
    Child {
        row: QueuedInputMetadata,
        prepared: delegated::PreparedChildContinuation,
    },
}
impl RequestActivationPreparation {
    pub fn input_id(&self) -> &str {
        match self {
            Self::Root(v) => &v.row.id,
            Self::Child { row, .. } => &row.id,
        }
    }
    pub fn revision(&self) -> u64 {
        match self {
            Self::Root(v) => v.row.revision,
            Self::Child { row, .. } => row.revision,
        }
    }
    pub fn load(self) -> Result<PreparedRequestActivation> {
        match self {
            Self::Child { row, preparation } => Ok(PreparedRequestActivation::Child {
                row,
                prepared: preparation.load()?,
            }),
            Self::Root(capture) => {
                let RootCapture {
                    row,
                    run,
                    launch,
                    head,
                    checkpoint,
                    epoch,
                    history,
                    content,
                    publication,
                } = capture;
                content.load_history_payload(&history)?;
                let checkpoint_id = checkpoint.as_ref().map(|c| c.id.clone());
                let context = checkpoint.map(context::CheckpointRead::load).transpose()?;
                let mut selection = launch.selection.clone();
                selection.rebase_policy_models(&content)?;
                if let Some(source) = selection.source.as_mut() {
                    if source.mode == SourceMode::Materialized
                        && source.environment_run_id.is_none()
                    {
                        source.environment_run_id = Some(run.id.clone());
                    }
                }
                if let Some(resources) = context.as_ref().and_then(|c| c.resources.as_ref()) {
                    if followups::normalized_source(resources.source.clone(), &run.id)
                        != followups::normalized_source(selection.source.clone(), &run.id)
                    {
                        return Err(RuntimeError::Conflict(
                            "request context no longer describes the retained source".into(),
                        ));
                    }
                }
                let intent=content.save(&json!({"input_id":row.id,"previous_run_id":run.id,"previous_run_revision":run.revision,"launch_revision":launch.revision}))?;
                let submission = submissions::PreparedSubmission {
                    run_id: id(),
                    identity: submissions::SubmissionIdentity {
                        key: format!("ingress-run:{}", row.id),
                        thread_id: row.thread_id.clone(),
                        branch_id: row.branch_id.clone(),
                        expected_head: head,
                        configuration: run.configuration.clone(),
                    },
                    epoch,
                    intent,
                    history: history.clone(),
                    launch: Some(selection),
                    inherit_source: false,
                    initial: None,
                    origin: submissions::SubmissionOrigin::Ingress {
                        input: row.clone(),
                        execution_id: None,
                        checkpoint: checkpoint_id,
                        history,
                    },
                    _publication: publication,
                };
                Ok(PreparedRequestActivation::Root {
                    row,
                    previous: run,
                    launch,
                    submission,
                })
            }
        }
    }
}
#[derive(Debug, PartialEq, Eq)]
pub enum RequestActivationAdmission {
    Bound(String),
    Delegated(String),
    Held,
    Stale,
}
impl Catalog {
    /// Small queue/owner capture only. Payload hydration and launch rebasing happen on the worker.
    pub fn capture_request_activations(&mut self) -> Result<Vec<RequestActivationPreparation>> {
        let (candidates, failure) = self.capture_activation_batch()?;
        if let Some(error) = failure {
            Err(error)
        } else {
            Ok(candidates)
        }
    }
    fn capture_activation_batch(
        &mut self,
    ) -> Result<(Vec<RequestActivationPreparation>, Option<RuntimeError>)> {
        if self
            .continuation_stopping
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Ok((Vec::new(), None));
        }
        let rows = {
            let mut q=self.db.prepare("SELECT body FROM input_queue WHERE origin IN ('message','followup') AND state='queued' AND activation='activating' ORDER BY cursor")?;
            let rows = q.query_map([], |r| r.get::<_, String>(0))?;
            rows.map(|r| Ok(serde_json::from_str(&r?)?))
                .collect::<Result<Vec<QueuedInputMetadata>>>()?
        };
        let mut candidates = Vec::new();
        let mut branches = std::collections::BTreeSet::new();
        let mut failure = None;
        for mut row in rows {
            let id = row.id.clone();
            let revision = row.revision;
            let branch = row.branch_id.clone();
            let result = (|| -> Result<()> {
                if let IngressActivationFact::Bound { run_id, .. } = fact(&row)?.clone() {
                    let run = self.run(&run_id)?;
                    let tx = self.db.transaction()?;
                    if run.cancel_requested || run.state == RunState::Cancelled {
                        cancel_run(&tx, &run_id)?;
                    } else if run.state.terminal()
                        && matches!(row.origin, InputOrigin::Followup { .. })
                    {
                        row.run_id = None;
                        write_changed(
                            &tx,
                            &mut row,
                            IngressActivationFact::Pending { execution_id: None },
                        )?;
                    } else if matches!(row.origin, InputOrigin::Followup { .. }) {
                        let old = row.clone();
                        followups::refresh_ingress_goal(&tx, &mut row)?;
                        if row != old {
                            row.revision += 1;
                            inputs::write_input(&tx, &row)?;
                            event(
                                &tx,
                                &row.id,
                                row.revision,
                                "followup.goal_bound",
                                json!({"input_id":row.id}),
                            )?;
                        }
                    }
                    tx.commit()?;
                    if !matches!(
                        fact(&row)?,
                        IngressActivationFact::Pending { execution_id: None }
                    ) {
                        return Ok(());
                    }
                }
                if !matches!(
                    fact(&row)?,
                    IngressActivationFact::Pending { execution_id: None }
                ) {
                    return Ok(());
                }
                let active: Option<String> = self.db.query_row(
                    "SELECT active_run FROM branches WHERE id=?1",
                    [&row.branch_id],
                    |r| r.get(0),
                )?;
                if let Some(id) = active {
                    let run = self.run(&id)?;
                    let tx = self.db.transaction()?;
                    bind_pending(&tx, &run)?;
                    tx.commit()?;
                    return Ok(());
                }
                if let Some(id) = pending_execution(&self.db, &row.thread_id, &row.branch_id)? {
                    let tx = self.db.transaction()?;
                    bind_execution(&tx, &row.branch_id, &id)?;
                    tx.commit()?;
                    return Ok(());
                }
                let Some(run) = latest_run(&self.db, &row.branch_id)? else {
                    self.fail_request_activation(&row.id, row.revision, "launch_unavailable")?;
                    return Ok(());
                };
                if followups::ingress_hold(&self.db, &row, Some(&run))?.is_some() {
                    return Ok(());
                }
                if !run.state.terminal() || row_goal_hold(&self.db, &row, &run)? {
                    return Ok(());
                }
                if !branches.insert(row.branch_id.clone()) {
                    return Ok(());
                }
                if matches!(row.origin, InputOrigin::Followup { .. }) {
                    let tx = self.db.transaction()?;
                    let old = row.clone();
                    followups::refresh_ingress_goal(&tx, &mut row)?;
                    if row != old {
                        row.revision += 1;
                        inputs::write_input(&tx, &row)?;
                        event(
                            &tx,
                            &row.id,
                            row.revision,
                            "followup.goal_bound",
                            json!({"input_id":row.id}),
                        )?;
                    }
                    tx.commit()?;
                }
                let child = self.child_task_for_thread(&row.thread_id)?;
                if let Some(child) = child {
                    if child.child_branch_id != row.branch_id {
                        self.fail_request_activation(
                            &row.id,
                            row.revision,
                            "execution_branch_unavailable",
                        )?;
                        return Ok(());
                    }
                    let Some(previous) = self.delegated_execution_for_run(&run.id)? else {
                        self.fail_request_activation(&row.id, row.revision, "source_unavailable")?;
                        return Ok(());
                    };
                    if previous.report.is_none() || !previous.code_result.settled() {
                        return Ok(());
                    }
                    let preparation = match self.capture_ingress_continuation(
                        row.clone(),
                        run,
                        child.operation_id,
                    ) {
                        Ok(value) => value,
                        Err(error) => {
                            self.fail_request_activation(
                                &row.id,
                                row.revision,
                                "activation_preparation_failed",
                            )?;
                            return Err(error);
                        }
                    };
                    candidates.push(RequestActivationPreparation::Child { row, preparation });
                } else {
                    let Some(launch) = self.launch_metadata(&run.id)? else {
                        self.fail_request_activation(&row.id, row.revision, "launch_unavailable")?;
                        return Ok(());
                    };
                    let history: String = self.db.query_row(
                        "SELECT body FROM input_history_content WHERE input_id=?1",
                        [&row.id],
                        |r| r.get(0),
                    )?;
                    candidates.push(RequestActivationPreparation::Root(RootCapture {
                        head: self.head(&row.branch_id)?,
                        checkpoint: self.capture_active_checkpoint(&row.branch_id)?,
                        row,
                        run,
                        launch,
                        epoch: self.epoch,
                        history: serde_json::from_str(&history)?,
                        content: self.content.clone(),
                        publication: self.content.begin_publication(),
                    }));
                }
                Ok(())
            })();
            if let Err(error) = result {
                branches.remove(&branch);
                failure.get_or_insert(error);
                if let Err(error) =
                    self.fail_request_activation(&id, revision, "activation_preparation_failed")
                {
                    failure.get_or_insert(error);
                }
            }
        }
        Ok((candidates, failure))
    }
    pub fn fail_request_activation(&mut self, id: &str, revision: u64, code: &str) -> Result<()> {
        if self
            .continuation_stopping
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Ok(());
        }
        let tx = self.db.transaction()?;
        let mut row: QueuedInputMetadata = record(&tx, "input_queue", id)?;
        if row.revision == revision
            && row.state == InputState::Queued
            && matches!(
                fact(&row)?,
                IngressActivationFact::Pending { execution_id: None }
            )
        {
            write_changed(
                &tx,
                &mut row,
                IngressActivationFact::Failed {
                    execution_id: None,
                    code: code.into(),
                },
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn admit_request_activation(
        &mut self,
        prepared: PreparedRequestActivation,
    ) -> Result<RequestActivationAdmission> {
        if self
            .continuation_stopping
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Ok(RequestActivationAdmission::Stale);
        }
        match prepared {
            PreparedRequestActivation::Child { row, prepared } => {
                match validate_pending(&self.db, &row) {
                    Ok(()) => (),
                    Err(RuntimeError::RequestActivationStale) => {
                        return Ok(RequestActivationAdmission::Stale)
                    }
                    Err(e) => return Err(e),
                }
                if let Some(run) = latest_run(&self.db, &row.branch_id)? {
                    if row_goal_hold(&self.db, &row, &run)? {
                        return Ok(RequestActivationAdmission::Held);
                    }
                }
                match self.accept_child_continuation(prepared) {
                    Ok(execution) => Ok(RequestActivationAdmission::Delegated(
                        execution.execution_id,
                    )),
                    Err(RuntimeError::RequestActivationHeld) => {
                        Ok(RequestActivationAdmission::Held)
                    }
                    Err(RuntimeError::RequestActivationStale) => {
                        Ok(RequestActivationAdmission::Stale)
                    }
                    Err(e) => Err(e),
                }
            }
            PreparedRequestActivation::Root {
                row,
                previous,
                launch,
                submission,
            } => {
                if self.epoch != submission.epoch {
                    return Err(RuntimeError::Conflict("request owner changed".into()));
                }
                match validate_pending(&self.db, &row) {
                    Ok(()) => (),
                    Err(RuntimeError::RequestActivationStale) => {
                        return Ok(RequestActivationAdmission::Stale)
                    }
                    Err(e) => return Err(e),
                }
                let actual = self.run(&previous.id)?;
                let current = self
                    .launch_metadata(&previous.id)?
                    .ok_or_else(|| RuntimeError::NotFound("original request launch".into()))?;
                let active: Option<String> = self.db.query_row(
                    "SELECT active_run FROM branches WHERE id=?1",
                    [&row.branch_id],
                    |r| r.get(0),
                )?;
                if actual != previous
                    || current.selection != launch.selection
                    || current.policy_target != launch.policy_target
                    || current.revision != launch.revision
                    || self.head(&row.branch_id)? != submission.identity.expected_head
                    || active.is_some()
                    || latest_run(&self.db, &row.branch_id)?
                        .as_ref()
                        .map(|r| &r.id)
                        != Some(&previous.id)
                {
                    return Ok(RequestActivationAdmission::Stale);
                }
                let submissions::SubmissionOrigin::Ingress { checkpoint, .. } = &submission.origin
                else {
                    unreachable!()
                };
                if self
                    .capture_active_checkpoint(&row.branch_id)?
                    .map(|c| c.id)
                    != *checkpoint
                {
                    return Ok(RequestActivationAdmission::Stale);
                }
                if followups::ingress_hold(&self.db, &row, Some(&actual))?.is_some()
                    || row_goal_hold(&self.db, &row, &actual)?
                {
                    return Ok(RequestActivationAdmission::Held);
                }
                let tx = self.db.transaction()?;
                let receipt = Self::submit_admission_tx(&tx, self.epoch, &submission, None)?;
                let mut current: launch_content::LaunchMetadata =
                    record(&tx, "run_launches", &receipt.run_id)?;
                current.policy_target = launch.policy_target;
                put(&tx, "run_launches", &receipt.run_id, &current)?;
                event(
                    &tx,
                    &row.id,
                    row.revision + 1,
                    "ingress.run_ready",
                    json!({"input_id":row.id,"run_id":receipt.run_id}),
                )?;
                tx.commit()?;
                Ok(RequestActivationAdmission::Bound(receipt.run_id))
            }
        }
    }
    /// A real current-boundary input ends observations, not their targets. Questions, policy
    /// pause and Goal control remain independent owners. NextRun input never interrupts this Run.
    pub fn interrupt_request_observations(&mut self) -> Result<bool> {
        let runs = {
            let mut q=self.db.prepare("SELECT DISTINCT run_id FROM input_queue WHERE activation='activating' AND mode!='next_run' AND state='queued' AND run_id IS NOT NULL")?;
            let rows = q.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        if !runs.is_empty() {
            self.reconcile_waits()?;
        }
        let mut changed = false;
        for id in runs {
            let run = self.run(&id)?;
            if run.cancel_requested
                || run.state.terminal()
                || goal_hold(&self.db, &run)?
                || self.pending_question_wait(&id)?.is_some()
                || (run.state == RunState::Waiting
                    && !run
                        .waiting_on
                        .as_deref()
                        .is_some_and(super::observations::is_observation_id))
            {
                continue;
            }
            for op in super::observations::operations(&self.db, Some(&id))? {
                let wait: Wait = record(
                    &self.db,
                    "waits",
                    op.waiting_on.as_deref().expect("observation"),
                )?;
                if wait.cancelled || wait.trigger_cursor.is_some() {
                    continue;
                }
                self.cancel_observation(&op.id)?;
                changed = true;
            }
        }
        Ok(changed)
    }
}
/// One event-driven pass; a raced candidate is recaptured before returning. Held work emits
/// no repeat event and waits for its actual dependency, control, source or execution owner.
pub fn reconcile(catalog: &Mutex<Catalog>) -> Result<Vec<String>> {
    let lock = || {
        catalog
            .lock()
            .map_err(|_| RuntimeError::Invalid("catalog owner failed".into()))
    };
    let mut runs = Vec::new();
    let mut failure = None;
    loop {
        let candidates = match lock()?.capture_activation_batch() {
            Ok((v, error)) => {
                if let Some(error) = error {
                    failure.get_or_insert(error);
                }
                v
            }
            Err(error) => {
                failure.get_or_insert(error);
                Vec::new()
            }
        };
        let mut stale = false;
        for candidate in candidates {
            let id = candidate.input_id().to_owned();
            let revision = candidate.revision();
            let prepared = match candidate.load() {
                Ok(p) => p,
                Err(error) => {
                    stale = true;
                    failure.get_or_insert(error);
                    if let Err(error) = lock()?.fail_request_activation(
                        &id,
                        revision,
                        "activation_preparation_failed",
                    ) {
                        failure.get_or_insert(error);
                    }
                    continue;
                }
            };
            let result = lock()?.admit_request_activation(prepared);
            match result {
                Ok(RequestActivationAdmission::Bound(run)) => runs.push(run),
                Ok(RequestActivationAdmission::Delegated(_) | RequestActivationAdmission::Held) => {
                    ()
                }
                Ok(RequestActivationAdmission::Stale) => stale = true,
                Err(error) => {
                    stale = true;
                    failure.get_or_insert(error);
                    if let Err(error) = lock()?.fail_request_activation(
                        &id,
                        revision,
                        "activation_preparation_failed",
                    ) {
                        failure.get_or_insert(error);
                    }
                }
            }
        }
        if !stale {
            return if let Some(error) = failure {
                Err(error)
            } else {
                Ok(runs)
            };
        }
    }
}
