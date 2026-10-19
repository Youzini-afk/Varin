//! The existing Bot organizer's durable work, not an Agent loop or another Bot authority.
//! Knowledge owns proposals/coverage. These records own execution and immutable batch input.
use super::*;
use serde::Deserialize;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryWorkMode {
    Automatic,
    Selection,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MemoryWorkAction {
    Claim,
    Resume,
    Decision { keep: Vec<u64> },
    Finish,
    Reject,
}
pub const WORK_KIND: &str = "memory_work_v1";
const STAGE_KIND: &str = "memory_work_stage_v1";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryWorkClaim {
    pub source: String,
    pub start: u64,
    pub end: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryWorkAdmit {
    pub key: String,
    pub scope_id: String,
    pub mode: MemoryWorkMode,
    pub execution_owner: ExecutorOwner,
    pub claims: Vec<MemoryWorkClaim>,
    pub retry_of: Option<String>,
    pub recipe: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryWorkReadParams {
    pub work_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryWorkListParams {
    pub scope_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryWorkUpdate {
    pub work_id: String,
    pub execution_owner: ExecutorOwner,
    pub expected_revision: u64,
    pub action: MemoryWorkAction,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Intent {
    kind: String,
    key: String,
    scope_id: String,
    mode: MemoryWorkMode,
    claims: Vec<MemoryWorkClaim>,
    retry_of: Option<String>,
    recipe_ref: Value,
    model_configuration_id: String,
    decision_binding: Value,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    decision: Option<Vec<u64>>,
    consumed: bool,
    consumer_failed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryWorkView {
    pub work_id: String,
    pub scope_id: String,
    pub mode: MemoryWorkMode,
    pub run_id: String,
    pub revision: u64,
    pub execution_owner: ExecutorOwner,
    pub cancelled: bool,
    pub consumed: bool,
    pub consumer_failed: bool,
    pub claims: Vec<MemoryWorkClaim>,
    pub decision: Option<Vec<u64>>,
    pub inference: Vec<Operation>,
    pub recipe: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryWorkStatus {
    pub work_id: String,
    pub scope_id: String,
    pub run_id: String,
    pub consumed: bool,
    pub inference: Vec<inference::InferenceStatus>,
}
pub struct MemoryWorkRead {
    view: MemoryWorkView,
    content: crate::content::ContentStore,
    reference: Value,
    _publication: crate::content::ContentPublication,
}
impl MemoryWorkRead {
    pub fn load(mut self) -> Result<MemoryWorkView> {
        self.view.recipe = self.content.load(&self.reference)?;
        for operation in &mut self.view.inference {
            inference::hydrate_operation(operation, &self.content)?;
        }
        Ok(self.view)
    }
}
fn invalid() -> RuntimeError {
    RuntimeError::Conflict("memory_work_identity_changed".into())
}
fn intent(operation: &Operation) -> Result<Intent> {
    if operation.intent["kind"] != WORK_KIND {
        return Err(invalid());
    }
    Ok(serde_json::from_value(operation.intent.clone())?)
}
fn state(operation: &Operation) -> Result<State> {
    Ok(serde_json::from_value(
        operation
            .result
            .as_ref()
            .ok_or_else(invalid)?
            .control()?
            .clone(),
    )?)
}
fn stage(id: &str, name: &str) -> String {
    format!("{id}:{name}")
}
pub(super) fn is_stage(operation: &Operation) -> bool {
    operation.intent["kind"] == STAGE_KIND
}
pub(super) fn is_work(operation: &Operation) -> bool {
    operation.intent["kind"] == WORK_KIND
}
pub(super) fn stage_live(
    db: &Connection,
    parent: &Operation,
    owner: &ExecutorOwner,
    epoch: u64,
) -> Result<()> {
    if !is_stage(parent)
        || parent.execution_owner.as_ref() != Some(owner)
        || parent.epoch != epoch
        || parent.phase != OperationPhase::Running
        || parent.cancel_requested
    {
        return Err(RuntimeError::DispatchCancelled);
    }
    let id = parent.intent["workId"].as_str().ok_or_else(invalid)?;
    let work: Operation = record(db, "operations", id)?;
    intent(&work)?;
    if work.run_id != parent.run_id
        || work.execution_owner.as_ref() != Some(owner)
        || work.epoch != epoch
        || work.cancel_requested
        || work.phase == OperationPhase::Terminal
    {
        return Err(RuntimeError::DispatchCancelled);
    }
    Ok(())
}
pub(super) fn generation_parent(
    db: &Connection,
    id: &str,
    owner: &ExecutorOwner,
    epoch: u64,
) -> Result<Option<String>> {
    let Some(parent) = optional_record::<Operation>(db, "operations", id)? else {
        return Ok(None);
    };
    if !is_stage(&parent) {
        return Ok(None);
    }
    stage_live(db, &parent, owner, epoch)?;
    if parent.intent["stage"] != "generation" {
        return Err(invalid());
    }
    let work: Operation = record(
        db,
        "operations",
        parent.intent["workId"].as_str().ok_or_else(invalid)?,
    )?;
    if intent(&work)?.mode == MemoryWorkMode::Automatic && state(&work)?.decision.is_none() {
        return Err(invalid());
    }
    Ok(Some(parent.run_id))
}
pub(super) fn validate_inference(
    db: &Connection,
    parent: &Operation,
    binding: &inference::InferenceBinding,
    native: bool,
) -> Result<()> {
    let work: Operation = record(
        db,
        "operations",
        parent.intent["workId"].as_str().ok_or_else(invalid)?,
    )?;
    let frozen = intent(&work)?;
    match parent.intent["stage"].as_str() {
        Some("generation")
            if native
                && binding.purpose == "memory-organizer"
                && binding.configuration_id == frozen.model_configuration_id =>
        {
            Ok(())
        }
        Some("decision")
            if !native
                && binding.purpose == "memory-organization"
                && frozen.decision_binding["configurationId"] == binding.configuration_id
                && frozen.decision_binding["providerId"] == binding.provider_id
                && frozen.decision_binding["modelId"] == binding.model_id =>
        {
            Ok(())
        }
        _ => Err(invalid()),
    }
}
pub(super) fn owns_run(db: &Connection, run: &Run) -> Result<bool> {
    let Some(id) = run.configuration.get("workId").and_then(Value::as_str) else {
        return Ok(false);
    };
    let Some(work) = optional_record::<Operation>(db, "operations", id)? else {
        return Ok(false);
    };
    Ok(is_work(&work) && work.run_id == run.id)
}
pub(super) fn recover(
    _tx: &Transaction<'_>,
    operation: &mut Operation,
    _epoch: u64,
) -> Result<bool> {
    // Preserve the old executable epoch. Only explicit Host claim can reactivate stages.
    Ok(is_work(operation) || is_stage(operation))
}

fn new_operation(
    id: String,
    run: &str,
    epoch: u64,
    owner: &ExecutorOwner,
    intent: Value,
    result: Value,
) -> Operation {
    Operation {
        id,
        run_id: run.into(),
        epoch,
        revision: 1,
        phase: OperationPhase::Running,
        outcome: None,
        effect: Effect::None,
        cancel_requested: false,
        lifetime: Lifetime::Run,
        handed_off: false,
        executor: Some("memory.organizer.v1".into()),
        execution_owner: Some(owner.clone()),
        waiting_on: None,
        intent,
        result: Some(OperationResultMetadata::Control { value: result }),
        host_job: None,
        mcp_resource_subscription: None,
        managed_process: None,
        external_receipt: None,
        call_completion: None,
    }
}
impl Catalog {
    pub fn admit_memory_work(
        &mut self,
        p: &MemoryWorkAdmit,
        body: inference::InferenceBody,
    ) -> Result<String> {
        if p.key.is_empty()
            || !p.scope_id.starts_with("bot:")
            || p.scope_id.len() <= 4
            || !matches!(&p.execution_owner, ExecutorOwner::External { identity, epoch } if identity == "memory.organizer.v1" && !epoch.is_empty())
            || p.claims.is_empty()
            || p.claims
                .iter()
                .any(|claim| claim.source.is_empty() || claim.end <= claim.start)
        {
            return Err(invalid());
        }
        let configuration: crate::types::ModelSessionConfiguration =
            serde_json::from_value(p.recipe["binding"]["configuration"].clone())?;
        let credential_scope: crate::providers::auth::CredentialScope =
            serde_json::from_value(p.recipe["binding"]["credentialScope"].clone())?;
        let model_configuration_id =
            crate::model_session::connection_identity_with_scope(&configuration, &credential_scope)
                .map_err(|e| RuntimeError::Invalid(e.to_string()))?;
        let id = format!("memory-work:{}", p.key);
        let frozen = Intent {
            kind: WORK_KIND.into(),
            key: p.key.clone(),
            scope_id: p.scope_id.clone(),
            mode: p.mode.clone(),
            claims: p.claims.clone(),
            retry_of: p.retry_of.clone(),
            recipe_ref: body.reference.clone(),
            model_configuration_id,
            decision_binding: p.recipe["decisionStatus"]["binding"].clone(),
        };
        if let Some(previous) = optional_record::<Operation>(&self.db, "operations", &id)? {
            if previous.intent != serde_json::to_value(&frozen)? {
                return Err(invalid());
            }
            return Ok(id);
        }
        if !super::bot::permitted(&self.db, &p.scope_id[4..], self.epoch)? { return Err(RuntimeError::BotSuspended); }
        if let Some(previous) = &p.retry_of {
            let old = self.operation(previous)?;
            let old_intent = intent(&old)?;
            if p.mode != MemoryWorkMode::Selection
                || old_intent.mode != MemoryWorkMode::Selection
                || old_intent.scope_id != p.scope_id
                || old_intent.claims != p.claims
                || state(&old)?.consumed
            {
                return Err(invalid());
            }
            let children = self.memory_work_inference(&old.run_id)?;
            if (children.is_empty()
                && !old.cancel_requested
                && !self.run(&old.run_id)?.cancel_requested)
                || children.iter().any(|child| {
                    child.phase != OperationPhase::Terminal
                        || (child.outcome == Some(Outcome::Succeeded)
                            && !state(&old).map(|s| s.consumer_failed).unwrap_or(false))
                        || !(child
                            .result
                            .as_ref()
                            .and_then(|r| r.control().ok())
                            .and_then(|v| v.get("receipt"))
                            .and_then(|r| r.get("localExecutorStopped"))
                            == Some(&Value::Bool(true))
                            || child
                                .result
                                .as_ref()
                                .and_then(|r| r.control().ok())
                                .and_then(|v| v.get("dispatched"))
                                == Some(&Value::Bool(false)))
                })
            {
                return Err(RuntimeError::Conflict(
                    "memory_work_retry_requires_original_stopped_failure".into(),
                ));
            }
        }
        if p.mode == MemoryWorkMode::Automatic {
            for work in self.memory_work_ids(&p.scope_id)? {
                let old = self.operation(&work)?;
                let previous = intent(&old)?;
                if previous.mode == MemoryWorkMode::Automatic
                    && !state(&old)?.consumed
                    && previous.claims.iter().any(|a| {
                        p.claims
                            .iter()
                            .any(|b| a.source == b.source && a.start < b.end && b.start < a.end)
                    })
                {
                    return Err(RuntimeError::Conflict(format!(
                        "memory_work_source_claimed:{work}"
                    )));
                }
            }
        }
        let run_id = format!("{id}:run");
        let thread_id = format!("{id}:thread");
        let branch_id = format!("{id}:branch");
        let run = Run {
            id: run_id.clone(),
            thread_id: thread_id.clone(),
            branch_id: branch_id.clone(),
            state: RunState::Executing,
            revision: 1,
            epoch: self.epoch,
            configuration: json!({"kind":WORK_KIND,"workId":id}),
            cancel_requested: false,
            waiting_on: None,
        };
        let root = new_operation(
            id.clone(),
            &run_id,
            self.epoch,
            &p.execution_owner,
            serde_json::to_value(&frozen)?,
            serde_json::to_value(State::default())?,
        );
        let tx = self.db.transaction()?;
        super::threads::insert(&tx, &thread_id)?;
        tx.execute(
            "INSERT INTO branches(id,thread_id,head,active_run) VALUES(?1,?2,NULL,?3)",
            params![branch_id, thread_id, run_id],
        )?;
        tx.execute(
            "INSERT INTO runs(id,branch_id,body) VALUES(?1,?2,?3)",
            params![run_id, branch_id, encode(&run)?],
        )?;
        for op in std::iter::once(root).chain(["decision", "generation"].into_iter().map(|name| {
            new_operation(
                stage(&id, name),
                &run_id,
                self.epoch,
                &p.execution_owner,
                json!({"kind":STAGE_KIND,"workId":id,"stage":name}),
                Value::Null,
            )
        })) {
            tx.execute(
                "INSERT INTO operations(id,run_id,body) VALUES(?1,?2,?3)",
                params![op.id, run_id, encode(&op)?],
            )?;
        }
        event(
            &tx,
            &id,
            1,
            "memory.work.admitted",
            json!({"runId":run_id,"scopeId":p.scope_id}),
        )?;
        tx.commit()?;
        Ok(id)
    }
    pub fn memory_work_ids(&self, scope: &str) -> Result<Vec<String>> {
        let mut query = self.db.prepare("SELECT id FROM operations WHERE json_extract(body,'$.intent.kind')=?1 AND json_extract(body,'$.intent.scopeId')=?2 AND json_extract(body,'$.result.value.consumed')=0 ORDER BY rowid")?;
        let rows = query
            .query_map(params![WORK_KIND, scope], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }
    fn memory_work_inference(&self, run: &str) -> Result<Vec<Operation>> {
        let mut query = self.db.prepare("SELECT body FROM operations WHERE run_id=?1 AND json_extract(body,'$.intent.kind')='inference_request_v1' ORDER BY rowid")?;
        let rows = query
            .query_map([run], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|s| Ok(serde_json::from_str(&s)?))
            .collect()
    }
    /// Cancellation observes only original control records. Missing content cannot prevent drain.
    pub fn memory_work_status(&self, id: &str) -> Result<MemoryWorkStatus> {
        let work = self.operation(id)?;
        let frozen = intent(&work)?;
        let state = state(&work)?;
        let inference = self
            .memory_work_inference(&work.run_id)?
            .iter()
            .map(|operation| self.inference_observation(operation))
            .collect::<Result<Vec<_>>>()?;
        Ok(MemoryWorkStatus {
            work_id: id.into(),
            scope_id: frozen.scope_id,
            run_id: work.run_id,
            consumed: state.consumed,
            inference,
        })
    }
    pub fn capture_memory_work(&self, id: &str) -> Result<MemoryWorkRead> {
        let work = self.operation(id)?;
        let i = intent(&work)?;
        let s = state(&work)?;
        Ok(MemoryWorkRead {
            view: MemoryWorkView {
                work_id: id.into(),
                scope_id: i.scope_id,
                mode: i.mode,
                run_id: work.run_id.clone(),
                revision: work.revision,
                execution_owner: work.execution_owner.ok_or_else(invalid)?,
                cancelled: work.cancel_requested || self.run(&work.run_id)?.cancel_requested,
                consumed: s.consumed,
                consumer_failed: s.consumer_failed,
                claims: i.claims,
                decision: s.decision,
                inference: self.memory_work_inference(&work.run_id)?,
                recipe: Value::Null,
            },
            reference: i.recipe_ref,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn update_memory_work(&mut self, p: &MemoryWorkUpdate) -> Result<()> {
        let mut work = self.operation(&p.work_id)?;
        let frozen = intent(&work)?;
        let mut s = state(&work)?;
        // A lost ACK or another observer of the same result is not a new paid attempt.
        if work.execution_owner.as_ref() == Some(&p.execution_owner) && work.epoch == self.epoch {
            match &p.action {
                MemoryWorkAction::Finish if s.consumed => return Ok(()),
                MemoryWorkAction::Reject if s.consumer_failed => return Ok(()),
                MemoryWorkAction::Decision { keep } if s.decision.as_ref() == Some(keep) => {
                    return Ok(())
                }
                MemoryWorkAction::Claim => return Ok(()),
                _ => {}
            }
        }
        if work.revision != p.expected_revision {
            return Err(invalid());
        }
        let children = self.memory_work_inference(&work.run_id)?;
        let drained = children.iter().all(|child| {
            child.phase == OperationPhase::Terminal
                && (child
                    .result
                    .as_ref()
                    .and_then(|r| r.control().ok())
                    .and_then(|v| v.get("receipt"))
                    .and_then(|r| r.get("localExecutorStopped"))
                    == Some(&Value::Bool(true))
                    || child
                        .result
                        .as_ref()
                        .and_then(|r| r.control().ok())
                        .and_then(|v| v.get("dispatched"))
                        == Some(&Value::Bool(false)))
        });
        if !matches!(p.action, MemoryWorkAction::Claim)
            && (work.execution_owner.as_ref() != Some(&p.execution_owner)
                || work.epoch != self.epoch)
        {
            return Err(invalid());
        }
        if matches!(p.action, MemoryWorkAction::Claim | MemoryWorkAction::Resume) && !super::bot::thread_permitted(&self.db, &self.run(&work.run_id)?.thread_id, self.epoch)? {
            return Err(RuntimeError::BotSuspended);
        }
        let tx = self.db.transaction()?;
        let event_kind = match &p.action {
            MemoryWorkAction::Claim => "memory.work.claim",
            MemoryWorkAction::Resume => "memory.work.resumed",
            MemoryWorkAction::Decision { .. } => "memory.work.decision",
            MemoryWorkAction::Finish => "memory.work.finish",
            MemoryWorkAction::Reject => "memory.work.rejected",
        };
        match &p.action {
            MemoryWorkAction::Claim => {
                if !drained
                    || s.consumed
                    || !matches!(&p.execution_owner, ExecutorOwner::External { identity, epoch } if identity=="memory.organizer.v1" && !epoch.is_empty())
                {
                    return Err(invalid());
                }
                // Reattaching the consumer never changes a child request or its original owner.
                work.execution_owner = Some(p.execution_owner.clone());
                work.epoch = self.epoch;
                let mut run: Run = record(&tx, "runs", &work.run_id)?;
                if !work.cancel_requested
                    && !run.cancel_requested
                    && work.phase != OperationPhase::Terminal
                {
                    run.state = RunState::Executing;
                    run.waiting_on = None;
                    run.epoch = self.epoch;
                    put(&tx, "runs", &run.id, &run)?;
                }
                for name in ["decision", "generation"] {
                    let key = stage(&work.id, name);
                    let mut op: Operation = record(&tx, "operations", &key)?;
                    op.execution_owner = Some(p.execution_owner.clone());
                    op.epoch = self.epoch;
                    put(&tx, "operations", &key, &op)?;
                }
            }
            MemoryWorkAction::Resume => {
                let mut run: Run = record(&tx, "runs", &work.run_id)?;
                let no_send = children.iter().all(|child| {
                    let value = child.result.as_ref().and_then(|r| r.control().ok());
                    child.effect != Effect::Unknown
                        && (child.intent["parentOperationId"] == stage(&work.id, "decision")
                            || value.and_then(|v| v.get("dispatched")) == Some(&Value::Bool(false))
                            || value
                                .and_then(|v| v.get("receipt"))
                                .and_then(|r| r.get("requestStarted"))
                                == Some(&Value::Bool(false)))
                });
                if frozen.mode != MemoryWorkMode::Automatic
                    || s.consumed
                    || s.consumer_failed
                    || !drained
                    || !no_send
                    || !(run.cancel_requested || work.cancel_requested)
                {
                    return Err(invalid());
                }
                // New Host admission after Wake. Original children, receipts and cancellation events remain immutable.
                run.cancel_requested = false;
                run.state = RunState::Executing;
                run.waiting_on = None;
                run.epoch = self.epoch;
                run.revision += 1;
                put(&tx, "runs", &run.id, &run)?;
                tx.execute(
                    "UPDATE branches SET active_run=?2 WHERE id=?1",
                    params![run.branch_id, run.id],
                )?;
                work.cancel_requested = false;
                work.phase = OperationPhase::Running;
                work.outcome = None;
                for name in ["decision", "generation"] {
                    let key = stage(&work.id, name);
                    let mut op: Operation = record(&tx, "operations", &key)?;
                    op.cancel_requested = false;
                    op.phase = OperationPhase::Running;
                    op.outcome = None;
                    op.epoch = self.epoch;
                    op.execution_owner = Some(p.execution_owner.clone());
                    op.revision += 1;
                    put(&tx, "operations", &key, &op)?;
                }
            }
            MemoryWorkAction::Decision { keep: decision } => {
                if s.decision.as_ref().is_some_and(|old| old != decision)
                    || work.cancel_requested
                    || !drained
                {
                    return Err(invalid());
                }
                s.decision = Some(decision.clone());
            }
            MemoryWorkAction::Reject => {
                if !drained || s.consumed {
                    return Err(invalid());
                }
                s.consumer_failed = true;
                work.phase = OperationPhase::Terminal;
                work.outcome = Some(Outcome::Failed);
                let mut run: Run = record(&tx, "runs", &work.run_id)?;
                run.state = RunState::Failed;
                run.waiting_on = None;
                run.revision += 1;
                put(&tx, "runs", &run.id, &run)?;
                tx.execute(
                    "UPDATE branches SET active_run=NULL WHERE id=?1",
                    [&run.branch_id],
                )?;
                for name in ["decision", "generation"] {
                    let key = stage(&work.id, name);
                    let mut op: Operation = record(&tx, "operations", &key)?;
                    op.phase = OperationPhase::Terminal;
                    op.outcome = Some(Outcome::Failed);
                    put(&tx, "operations", &key, &op)?;
                }
            }
            MemoryWorkAction::Finish => {
                if !drained {
                    return Err(RuntimeError::Conflict(
                        "memory_work_executor_not_drained".into(),
                    ));
                }
                s.consumed = true;
                let mut run: Run = record(&tx, "runs", &work.run_id)?;
                run.state = RunState::Completed;
                run.waiting_on = None;
                run.revision += 1;
                put(&tx, "runs", &run.id, &run)?;
                tx.execute(
                    "UPDATE branches SET active_run=NULL WHERE id=?1",
                    [&run.branch_id],
                )?;
                for name in ["decision", "generation"] {
                    let key = stage(&work.id, name);
                    let mut op: Operation = record(&tx, "operations", &key)?;
                    op.phase = OperationPhase::Terminal;
                    op.outcome = Some(Outcome::Succeeded);
                    put(&tx, "operations", &key, &op)?;
                }
                work.phase = OperationPhase::Terminal;
                work.outcome = Some(Outcome::Succeeded);
            }
        }
        work.result = Some(OperationResultMetadata::Control {
            value: serde_json::to_value(s)?,
        });
        work.revision += 1;
        put(&tx, "operations", &work.id, &work)?;
        event(&tx, &work.id, work.revision, event_kind, Value::Null)?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "catalog_memory_work_tests.rs"]
mod tests;
