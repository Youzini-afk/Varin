//! Atomic bridge from the native executor to its sole durable authority.
use super::*;
use crate::execution::*;
use std::sync::Mutex;

impl Persistence for Mutex<Catalog> {
    fn consume_inputs(
        &self,
        run_id: &str,
        epoch: u64,
        expected_head: Option<&str>,
    ) -> std::result::Result<Vec<ConversationItem>, ExecutionError> {
        self.lock()
            .map_err(|_| ExecutionError::new("catalog_poisoned", "catalog owner failed"))?
            .consume_inputs(run_id, epoch, expected_head)
            .map_err(|e| ExecutionError::new("catalog_input", e.to_string()))
    }

    fn commit(
        &self,
        run_id: &str,
        epoch: u64,
        record: &ExecutionRecord,
    ) -> std::result::Result<(), ExecutionError> {
        let mut catalog = self
            .lock()
            .map_err(|_| ExecutionError::new("catalog_poisoned", "catalog owner failed"))?;
        match catalog.commit_execution(run_id, epoch, record) {
            Ok(()) => Ok(()),
            Err(RuntimeError::InputPending) => Err(ExecutionError::new(
                "input_pending",
                "new user input is waiting at this boundary",
            )),
            Err(error) => {
                if matches!(record, ExecutionRecord::ModelFinished { .. }) {
                    if let Err(retain) = catalog.retain_rejected_model_output(run_id, epoch, record)
                    {
                        return Err(ExecutionError::new(
                            "catalog_commit",
                            format!("{error}; generated output could not be retained: {retain}"),
                        ));
                    }
                }
                Err(ExecutionError::new("catalog_commit", error.to_string()))
            }
        }
    }
}
fn append_item(tx: &Transaction<'_>, run: &Run, item: &ConversationItem, body_reference: &Value) -> Result<()> {
    let (head, active): (Option<String>, Option<String>) = tx.query_row(
        "SELECT head,active_run FROM branches WHERE id=?1",
        [&run.branch_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if active.as_deref() != Some(&run.id) {
        return Err(RuntimeError::Conflict(
            "branch execution owner changed".into(),
        ));
    }
    let source = match item.provenance {
        Provenance::Assistant => HistorySource::Assistant,
        Provenance::ToolData { .. } => HistorySource::Tool,
        Provenance::UserInstruction { .. } | Provenance::SystemInstruction { .. } => {
            HistorySource::User
        }
        Provenance::AgentMessage { .. } => HistorySource::Agent,
        _ => HistorySource::Environment,
    };
    let stored = HistoryItem {
        id: item.id.clone(),
        thread_id: run.thread_id.clone(),
        parent: head,
        source,
        content: body_reference.clone(),
        provider: None,
    };
    tx.execute(
        "INSERT INTO history(id,thread_id,parent,body) VALUES(?1,?2,?3,?4)",
        params![stored.id, stored.thread_id, stored.parent, encode(&stored)?],
    )?;
    tx.execute(
        "UPDATE branches SET head=?2 WHERE id=?1",
        params![run.branch_id, stored.id],
    )?;
    Ok(())
}
fn provider_originals(items: &[ProviderItem]) -> Vec<ProviderOriginal> {
    items.iter().filter_map(|item| item.opaque.as_ref().map(|o| ProviderOriginal {
        connection_identity: o.connection_identity.clone(),
        adapter: o.family.clone(), version: o.adapter_version.clone(), item: o.value.clone(),
    })).collect()
}
fn history_items(record: &ExecutionRecord) -> Vec<ConversationItem> {
    match record {
        ExecutionRecord::ModelFinished { outcome: ModelOutcome::Completed, items, .. } => items.iter().map(|item| ConversationItem {
            id: item.id.clone(), provenance: Provenance::Assistant, content: item.content.clone(), opaque: item.opaque.clone(),
        }).collect(),
        ExecutionRecord::ToolBatchCommitted { request_id, results } => results.iter().map(|result| ConversationItem {
            id: format!("{}:result:{}", request_id, result.call_id),
            provenance: Provenance::ToolData { call_id: result.call_id.clone() },
            content: Content::ToolResult { result: result.clone() }, opaque: None,
        }).collect(),
        _ => Vec::new(),
    }
}
fn operation_id(request: &str, call: &str) -> String {
    format!("{request}:tool:{call}")
}
impl Catalog {
    pub fn execution_history(&self, branch: &str) -> Result<Vec<ConversationItem>> {
        let mut result = Vec::new();
        for item in self.history(branch)? {
            if item.source == HistorySource::User {
                result.extend(user_input_items(&item.id, &item.content)?);
            } else {
                result.push(serde_json::from_value(item.content)?);
            }
        }
        Ok(result)
    }
    pub fn commit_execution(
        &mut self,
        run_id: &str,
        epoch: u64,
        record: &ExecutionRecord,
    ) -> Result<()> {
        // Body durability precedes the metadata transaction; rollback leaves a safe orphan.
        let prepared_request = match record {
            ExecutionRecord::RequestPrepared { snapshot } => {
                Some(self.content.save(&serde_json::to_value(snapshot)?)?)
            }
            _ => None,
        };
        let frozen_snapshot = if let ExecutionRecord::ModelFinished { request_id, .. } = record {
            let step: ModelStep = super::record(&self.db, "model_steps", request_id)?;
            Some(serde_json::from_value::<RequestSnapshot>(
                self.content.load(&step.request)?,
            )?)
        } else {
            None
        };
        let mut prepared_history = std::collections::HashMap::new();
        for item in history_items(record) {
            let provider = item.opaque.as_ref().map(|o| ProviderOriginal {
                connection_identity: o.connection_identity.clone(), adapter: o.family.clone(),
                version: o.adapter_version.clone(), item: o.value.clone(),
            });
            prepared_history.insert(item.id.clone(), self.content.save_history(&serde_json::to_value(&item)?, &provider)?);
        }
        let (prepared_originals, prepared_output) = if let ExecutionRecord::ModelFinished { items, .. } = record {
            (Some(self.content.save_originals(&provider_originals(items))?),
             Some(self.content.save(&json!({"status":"committed","record":record}))?))
        } else { (None, None) };
        let tx = self.db.transaction()?;
        let mut run: Run = record_value(&tx, run_id)?;
        fence(&run, epoch)?;
        let referenced_request = match record {
            ExecutionRecord::ModelDispatched { request_id }
            | ExecutionRecord::ModelFinished { request_id, .. }
            | ExecutionRecord::ToolsAdmitted { request_id, .. }
            | ExecutionRecord::ToolDispatched { request_id, .. }
            | ExecutionRecord::ToolBatchCommitted { request_id, .. } => Some(request_id.as_str()),
            ExecutionRecord::ToolSettled { result } => Some(result.request_id.as_str()),
            _ => None,
        };
        if let Some(request_id) = referenced_request {
            let step: ModelStep = super::record(&tx, "model_steps", request_id)?;
            if step.run_id != run_id || step.epoch != epoch {
                return Err(RuntimeError::Conflict(
                    "model exchange belongs to another execution".into(),
                ));
            }
        }
        match record {
            ExecutionRecord::StateChanged { state, waiting_on } => {
                if *state != run.state && !run.state.permits(*state) {
                    return Err(RuntimeError::Invalid(
                        "illegal executor run transition".into(),
                    ));
                }
                if *state == RunState::Waiting {
                    if let Some(key) = waiting_on {
                        let wait: Wait = super::record(&tx, "waits", key)?;
                        if wait.run_id != run.id || wait.cancelled {
                            return Err(RuntimeError::Conflict(
                                "wait ownership or status changed".into(),
                            ));
                        }
                    } else {
                        return Err(RuntimeError::Invalid(
                            "waiting requires a durable condition".into(),
                        ));
                    }
                }
                if state.terminal() {
                    if matches!(state, RunState::Completed | RunState::Failed)
                        && super::inputs::has_boundary_inputs(&tx, run_id)?
                    {
                        return Err(RuntimeError::InputPending);
                    }

                    let ops: Vec<Operation> = read_all(&tx, "operations")?;
                    if ops.iter().any(|op| {
                        op.run_id == run.id
                            && op.phase != OperationPhase::Terminal
                            && !op.handed_off
                    }) {
                        return Err(RuntimeError::Invalid(
                            "foreground operation is unsettled".into(),
                        ));
                    }
                    let active:i64=tx.query_row("SELECT count(*) FROM model_steps WHERE run_id=?1 AND state IN ('prepared','dispatched')",[run_id],|r|r.get(0))?;
                    if active > 0 {
                        return Err(RuntimeError::Invalid("model exchange is unsettled".into()));
                    }
                    let unpaired:i64=tx.query_row("SELECT count(*) FROM tool_calls c JOIN model_steps m ON m.id=c.request_id WHERE m.run_id=?1 AND c.committed=0",[run_id],|r|r.get(0))?;
                    if unpaired > 0 {
                        return Err(RuntimeError::Invalid("tool exchange is unsettled".into()));
                    }
                    tx.execute(
                        "UPDATE branches SET active_run=NULL WHERE active_run=?1",
                        [run_id],
                    )?;
                    if *state == RunState::Cancelled {
                        super::inputs::cancel_current(&tx, run_id)?;
                    }
                    super::inputs::promote_next(&tx, &run.branch_id)?;
                }
                run.state = *state;
                run.waiting_on = waiting_on.clone();
                run.revision += 1;
                put(&tx, "runs", run_id, &run)?;
            }
            ExecutionRecord::RequestPrepared { snapshot } => {
                if super::inputs::has_boundary_inputs(&tx,run_id)?{return Err(RuntimeError::InputPending);}

                if run.cancel_requested
                    || snapshot.view.run_id != run_id
                    || snapshot.view.binding.history_range.branch_id != run.branch_id
                {
                    return Err(RuntimeError::Conflict(
                        "request run or branch changed".into(),
                    ));
                }
                let head: Option<String> = tx.query_row(
                    "SELECT head FROM branches WHERE id=?1",
                    [&run.branch_id],
                    |r| r.get(0),
                )?;
                if head != snapshot.view.binding.history_range.leaf_id {
                    return Err(RuntimeError::Conflict(
                        "request history head changed".into(),
                    ));
                }
                let step = ModelStep {
                    superseded_by_input: None,
                    id: snapshot.view.request_id.clone(),
                    run_id: run_id.into(),
                    epoch,
                    state: ModelStepState::Prepared,
                    request: prepared_request.ok_or_else(|| {
                        RuntimeError::Invalid("prepared request content missing".into())
                    })?,
                    original: vec![],
                    usage: None,
                };
                tx.execute(
                    "INSERT INTO model_steps(id,run_id,state,body) VALUES(?1,?2,'prepared',?3)",
                    params![step.id, run_id, encode(&step)?],
                )?;
            }
            ExecutionRecord::ModelDispatched { request_id } => {
                let interrupt:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM input_queue WHERE run_id=?1 AND state='queued' AND mode='interrupt')",[run_id],|row|row.get(0))?;
                if interrupt{return Err(RuntimeError::InputPending);}

                let mut step: ModelStep = super::record(&tx, "model_steps", request_id)?;
                if step.run_id != run_id
                    || step.epoch != epoch
                    || step.state != ModelStepState::Prepared
                    || run.cancel_requested
                {
                    return Err(RuntimeError::Conflict("model cannot dispatch".into()));
                }
                step.state = ModelStepState::Dispatched;
                put(&tx, "model_steps", request_id, &step)?;
                tx.execute(
                    "UPDATE model_steps SET state='dispatched' WHERE id=?1",
                    [request_id],
                )?;
            }
            ExecutionRecord::ModelFinished {
                request_id,
                outcome,
                items,
                usage,
                ..
            } => {
                let mut step: ModelStep = super::record(&tx, "model_steps", request_id)?;
                if step.run_id != run_id
                    || step.epoch != epoch
                    || !matches!(
                        step.state,
                        ModelStepState::Prepared | ModelStepState::Dispatched
                    )
                {
                    return Err(RuntimeError::Conflict(
                        "model completion owner changed".into(),
                    ));
                }
                let snapshot = frozen_snapshot.as_ref().ok_or_else(|| {
                    RuntimeError::Invalid("frozen request content missing".into())
                })?;
                let head: Option<String> = tx.query_row(
                    "SELECT head FROM branches WHERE id=?1",
                    [&run.branch_id],
                    |r| r.get(0),
                )?;
                if *outcome == ModelOutcome::Completed
                    && head != snapshot.view.binding.history_range.leaf_id
                {
                    return Err(RuntimeError::Conflict(
                        "model output history head changed".into(),
                    ));
                }
                step.state = match outcome {
                    ModelOutcome::Completed => ModelStepState::Completed,
                    ModelOutcome::Interrupted => ModelStepState::Interrupted,
                    ModelOutcome::Failed => ModelStepState::Failed,
                    ModelOutcome::Cancelled => ModelStepState::Cancelled,
                };
                step.original = prepared_originals.ok_or_else(|| RuntimeError::Invalid("prepared model originals missing".into()))?;
                step.usage = Some(serde_json::to_value(usage)?);
                put(&tx, "model_steps", request_id, &step)?;
                tx.execute(
                    "UPDATE model_steps SET state=?2 WHERE id=?1",
                    params![request_id, encode(&step.state)?.trim_matches('"')],
                )?;
                // Completion, original output, semantic history and unresolved call identities commit together.
                if *outcome == ModelOutcome::Completed {
                    for item in items {
                        append_item(
                            &tx,
                            &run,
                            &ConversationItem {
                                id: item.id.clone(),
                                provenance: Provenance::Assistant,
                                content: item.content.clone(),
                                opaque: item.opaque.clone(),
                            },
                            prepared_history.get(&item.id).ok_or_else(|| RuntimeError::Invalid("prepared history body missing".into()))?,
                        )?;
                        if let Content::ToolCall { call } = &item.content {
                            tx.execute(
                                "INSERT INTO tool_calls(request_id,call_id,body) VALUES(?1,?2,?3)",
                                params![request_id, call.call_id, encode(call)?],
                            )?;
                        }
                    }
                }
                tx.execute(
                    "INSERT INTO model_outputs(request_id,body) VALUES(?1,?2)",
                    params![
                        request_id,
                        encode(&prepared_output.ok_or_else(|| RuntimeError::Invalid("prepared model output missing".into()))?)?
                    ],
                )?;
            }
            ExecutionRecord::ToolsAdmitted { request_id, tools } => {
                for tool in tools {
                    let expected: String = tx.query_row(
                        "SELECT body FROM tool_calls WHERE request_id=?1 AND call_id=?2",
                        params![request_id, tool.call.call_id],
                        |r| r.get(0),
                    )?;
                    if expected != encode(&tool.call)? {
                        return Err(RuntimeError::Conflict(
                            "tool call changed since model output".into(),
                        ));
                    }
                    if !tool.contract.read_only || tool.contract.completion == CompletionKind::Job {
                        let key = operation_id(request_id, &tool.call.call_id);
                        if let Some(mut previous) = optional_record::<Operation>(&tx, "operations", &key)? {
                            if previous.run_id != run_id || previous.phase != OperationPhase::Accepted || previous.effect != Effect::None || previous.intent != serde_json::to_value(tool)? {
                                return Err(RuntimeError::Conflict("tool admission cannot replace an existing effect or contract".into()));
                            }
                            previous.epoch=epoch;
                            put(&tx,"operations",&key,&previous)?;
                            continue;
                        }
                        let op = Operation {
                            external_receipt: None,
                            id: key.clone(),
                            run_id: run_id.into(),
                            epoch,
                            revision: 1,
                            phase: OperationPhase::Accepted,
                            outcome: None,
                            effect: Effect::None,
                            cancel_requested: false,
                            lifetime: tool.contract.lifetime,
                            handed_off: false,
                            executor: None,
                            waiting_on: None,
                            intent: serde_json::to_value(tool)?,
                            result: None,
                        };
                        tx.execute(
                            "INSERT INTO operations(id,run_id,body) VALUES(?1,?2,?3)",
                            params![key, run_id, encode(&op)?],
                        )?;
                    }
                }
            }
            ExecutionRecord::ToolDispatched {
                request_id,
                call_id,
            } => {
                let key = operation_id(request_id, call_id);
                let mut op: Operation = super::record(&tx, "operations", &key)?;
                if op.run_id != run_id
                    || op.epoch != epoch
                    || op.phase != OperationPhase::Accepted
                    || op.cancel_requested
                    || run.cancel_requested
                {
                    return Err(RuntimeError::Conflict("tool no longer admitted".into()));
                }
                let tool: AdmittedTool = serde_json::from_value(op.intent.clone())?;
                op.phase = OperationPhase::Running;
                op.effect = if tool.contract.read_only {
                    Effect::None
                } else {
                    Effect::Dispatched
                };
                op.revision += 1;
                op.executor = Some(tool.call.name);
                put(&tx, "operations", &key, &op)?;
            }
            ExecutionRecord::ToolSettled { result } => {
                let key = operation_id(&result.request_id, &result.call_id);
                let mut op: Operation = super::record(&tx, "operations", &key)?;
                if op.run_id != run_id || op.epoch != epoch || op.phase == OperationPhase::Terminal
                {
                    return Err(RuntimeError::Conflict("tool completion is stale".into()));
                }
                match &result.completion {
                    ToolCompletion::NotDispatched { reason } => {
                        op.phase = OperationPhase::Terminal;
                        op.outcome = Some(Outcome::Failed);
                        op.effect = Effect::None;
                        op.effect = Effect::None;
                        op.result = Some(json!({"not_dispatched":reason}));
                    }
                    ToolCompletion::Result {
                        outcome,
                        effect,
                        content,
                    } => {
                        if (*effect == Effect::None && op.effect != Effect::None)
                            || (*outcome == Outcome::Succeeded
                                && op.phase != OperationPhase::Running)
                        {
                            return Err(RuntimeError::Invalid(
                                "tool receipt lacks dispatch/no-send evidence".into(),
                            ));
                        }
                        op.phase = OperationPhase::Terminal;
                        op.outcome = Some(*outcome);
                        op.effect = *effect;
                        op.result = Some(content.clone());
                        if *effect == Effect::Unknown && *outcome != Outcome::Indeterminate {
                            return Err(RuntimeError::Invalid(
                                "unknown effects require reconciliation".into(),
                            ));
                        }
                    }
                    ToolCompletion::JobAccepted {
                        operation_id,
                        phase,
                        effect,
                        lifetime,
                    } => {
                        if !matches!(lifetime, Lifetime::Thread | Lifetime::Environment)
                            || *lifetime != op.lifetime
                            || operation_id.is_empty()
                        {
                            return Err(RuntimeError::Invalid("invalid background handoff".into()));
                        }
                        op.handed_off = true;
                        op.effect = *effect;
                        op.result = Some(json!({"operation_id":operation_id,"phase":phase}));
                    }
                }
                if op.handed_off
                    || (op.phase == OperationPhase::Terminal
                        && op.outcome == Some(Outcome::Indeterminate))
                {
                    if let Some(receipt) = op.external_receipt.clone() {
                        apply_external_terminal(&mut op, &receipt);
                    }
                }
                op.revision += 1;
                put(&tx, "operations", &key, &op)?;
                if op.phase == OperationPhase::Terminal {
                    event(
                        &tx,
                        &key,
                        op.revision,
                        "operation.settled",
                        serde_json::to_value(&op)?,
                    )?;
                }
                tx.execute(
                    "UPDATE tool_calls SET receipt=?3 WHERE request_id=?1 AND call_id=?2",
                    params![result.request_id, result.call_id, encode(result)?],
                )?;
            }
            ExecutionRecord::ToolBatchCommitted {
                request_id,
                results,
            } => {
                let expected: i64 = tx.query_row(
                    "SELECT count(*) FROM tool_calls WHERE request_id=?1",
                    [request_id],
                    |r| r.get(0),
                )?;
                let mut ids = std::collections::BTreeSet::new();
                if expected != results.len() as i64 {
                    return Err(RuntimeError::Invalid("tool batch is incomplete".into()));
                }
                for result in results {
                    if result.request_id != *request_id || !ids.insert(&result.call_id) {
                        return Err(RuntimeError::Invalid(
                            "tool result identity duplicated".into(),
                        ));
                    }
                    let serialized_result = encode(result)?;
                    let previous: Option<String> = tx.query_row(
                        "SELECT receipt FROM tool_calls WHERE request_id=?1 AND call_id=?2",
                        params![request_id, result.call_id],
                        |r| r.get(0),
                    )?;
                    if previous
                        .as_ref()
                        .is_some_and(|old| old != &serialized_result)
                    {
                        return Err(RuntimeError::Conflict("tool receipt changed".into()));
                    }
                    let key=operation_id(request_id,&result.call_id);
                    if let Some(mut op)=optional_record::<Operation>(&tx,"operations",&key)? {
                        if op.phase==OperationPhase::Accepted && op.effect==Effect::None {
                            let closure=match &result.completion {
                                ToolCompletion::NotDispatched{reason} => Some((Outcome::Failed,json!({"not_dispatched":reason}))),
                                ToolCompletion::Result{outcome: outcome @ (Outcome::Cancelled|Outcome::Failed),effect:Effect::None,content} => Some((*outcome,content.clone())),
                                _=>None,
                            };
                            if let Some((outcome,content))=closure {op.phase=OperationPhase::Terminal;op.outcome=Some(outcome);op.result=Some(content);op.revision+=1;put(&tx,"operations",&key,&op)?;event(&tx,&key,op.revision,"operation.settled",serde_json::to_value(&op)?)?;}
                        }
                    }
                    tx.execute("UPDATE tool_calls SET receipt=?3,committed=1 WHERE request_id=?1 AND call_id=?2",params![request_id,result.call_id,encode(result)?])?;
                    append_item(
                        &tx,
                        &run,
                        &ConversationItem {
                            id: format!("{}:result:{}", request_id, result.call_id),
                            provenance: Provenance::ToolData {
                                call_id: result.call_id.clone(),
                            },
                            content: Content::ToolResult {
                                result: result.clone(),
                            },
                            opaque: None,
                        },
                        prepared_history.get(&format!("{}:result:{}", request_id, result.call_id)).ok_or_else(|| RuntimeError::Invalid("prepared tool history body missing".into()))?,
                    )?;
                }
            }
            ExecutionRecord::PolicyCheckpoint {
                identity,
                state,
                action,
            } => {
                if let PolicyAction::Wait { wait_id } = action {
                    let wait: Wait = super::record(&tx, "waits", wait_id)?;
                    if wait.run_id != run_id || wait.cancelled {
                        return Err(RuntimeError::Conflict("policy wait unavailable".into()));
                    }
                }
                tx.execute("INSERT INTO policy_checkpoints(run_id,identity,state,action) VALUES(?1,?2,?3,?4) ON CONFLICT(run_id) DO UPDATE SET identity=excluded.identity,state=excluded.state,action=excluded.action",params![run_id,encode(identity)?,encode(state)?,encode(action)?])?;
            }
        }
        event(
            &tx,
            run_id,
            run.revision,
            "execution.committed",
            json!({"kind":serde_json::to_value(record)?.get("kind")}),
        )?;
        tx.commit()?;
        if matches!(record, ExecutionRecord::ToolSettled { .. } | ExecutionRecord::ToolBatchCommitted { .. }) {
            self.reconcile_waits()?;
        }
        Ok(())
    }
}
fn record_value(tx: &Transaction<'_>, id: &str) -> Result<Run> {
    super::record(tx, "runs", id)
}

impl Catalog {
    /// Freezes admission from durable state. Recovery never restarts a paid/ambiguous exchange.
    pub fn prepare_execution(
        &self,
        run_id: &str,
        binding: RequestBinding,
        policy: PolicyIdentity,
        initial_policy_state: Value,
    ) -> Result<ExecutionInput> {
        self.prepare_execution_inner(run_id, binding, policy, initial_policy_state, false)
    }
    pub(super) fn prepare_execution_with_completed_tools(&self, run_id: &str, binding: RequestBinding, policy: PolicyIdentity, initial_policy_state: Value) -> Result<ExecutionInput> {
        self.prepare_execution_inner(run_id, binding, policy, initial_policy_state, true)
    }
    fn prepare_execution_inner(&self, run_id: &str, mut binding: RequestBinding, policy: PolicyIdentity, initial_policy_state: Value, completed_tools: bool) -> Result<ExecutionInput> {
        let run = self.run(run_id)?;
        if run.epoch != self.epoch
            || run.cancel_requested
            || !matches!(run.state, RunState::Accepted | RunState::Runnable)
        {
            return Err(RuntimeError::Conflict(
                "run is not admitted for execution".into(),
            ));
        }
        let active: Option<String> = self.db.query_row(
            "SELECT active_run FROM branches WHERE id=?1",
            [&run.branch_id],
            |r| r.get(0),
        )?;
        if active.as_deref() != Some(run_id) {
            return Err(RuntimeError::Conflict("branch owner changed".into()));
        }
        let unresolved: i64 = self.db.query_row(
            "SELECT count(*) FROM model_steps WHERE run_id=?1 AND state!='completed' AND json_extract(body,'$.superseded_by_input') IS NULL",
            [run_id],
            |r| r.get(0),
        )?;
        let unpaired:i64=self.db.query_row("SELECT count(*) FROM tool_calls c JOIN model_steps m ON m.id=c.request_id WHERE m.run_id=?1 AND c.committed=0",[run_id],|r|r.get(0))?;
        if unresolved != 0 || (unpaired != 0 && !completed_tools) {
            return Err(RuntimeError::Conflict(
                "execution needs explicit model/tool recovery".into(),
            ));
        }
        let completed_model_steps: u64 = self.db.query_row(
            "SELECT count(*) FROM model_steps WHERE run_id=?1",
            [run_id],
            |r| read_number(r, 0),
        )?;
        let saved: Option<(String, String)> = self
            .db
            .query_row(
                "SELECT identity,state FROM policy_checkpoints WHERE run_id=?1",
                [run_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let policy_state = if let Some((identity, state)) = saved {
            if serde_json::from_str::<PolicyIdentity>(&identity)? != policy {
                return Err(RuntimeError::Conflict(
                    "policy checkpoint belongs to another implementation version".into(),
                ));
            }
            serde_json::from_str(&state)?
        } else {
            initial_policy_state
        };
        binding.history_range.branch_id = run.branch_id.clone();
        binding.history_range.leaf_id = self.head(&run.branch_id)?;
        let history = self.execution_history(&run.branch_id)?;
        if binding
            .history_range
            .ancestor_id
            .as_ref()
            .is_some_and(|id| !history.iter().any(|item| &item.id == id))
        {
            return Err(RuntimeError::Conflict(
                "request ancestor is not on the active branch".into(),
            ));
        }
        Ok(ExecutionInput {
            run_id: run_id.into(),
            owner_generation: run.epoch,
            binding,
            history,
            policy_state,
            completed_model_steps,
        })
    }
}

/// A user record may project several typed parts; the final projected part retains the
/// original entry identity so frozen branch ranges still address the durable history head.
/// No attachment bytes are loaded or downgraded to text here.
pub(super) fn user_input_items(id: &str, input: &Value) -> Result<Vec<ConversationItem>> {
    let mut parts = Vec::new();
    if let Some(text) = input.as_str() {
        parts.push(Content::Text { text: text.into() });
    } else {
        let object = input.as_object().ok_or_else(|| {
            RuntimeError::Invalid(
                "user input must be text or a typed text/attachments object".into(),
            )
        })?;
        if object
            .keys()
            .any(|key| key != "text" && key != "attachments")
        {
            return Err(RuntimeError::Invalid(
                "unsupported user input field; content was not accepted".into(),
            ));
        }
        if let Some(text) = object.get("text") {
            parts.push(Content::Text {
                text: text
                    .as_str()
                    .ok_or_else(|| {
                        RuntimeError::Invalid("user input text must be a string".into())
                    })?
                    .into(),
            });
        }
        if let Some(attachments) = object.get("attachments") {
            for attachment in attachments
                .as_array()
                .ok_or_else(|| RuntimeError::Invalid("attachments must be an array".into()))?
            {
                #[derive(serde::Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Attachment {
                    media_type: String,
                    content_ref: String,
                    source: Option<String>,
                }
                let attachment: Attachment = serde_json::from_value(attachment.clone())?;
                if attachment.media_type.trim().is_empty()
                    || attachment.content_ref.trim().is_empty()
                {
                    return Err(RuntimeError::Invalid(
                        "attachment type and content reference are required".into(),
                    ));
                }
                parts.push(Content::Attachment {
                    media_type: attachment.media_type,
                    content_ref: attachment.content_ref,
                    source: attachment
                        .source
                        .unwrap_or_else(|| format!("user-input:{id}")),
                });
            }
        }
    }
    if parts.is_empty() {
        return Err(RuntimeError::Invalid("user input has no content".into()));
    }
    let last = parts.len() - 1;
    Ok(parts
        .into_iter()
        .enumerate()
        .map(|(index, content)| ConversationItem {
            id: if index == last {
                id.into()
            } else {
                format!("{id}:part:{index}")
            },
            provenance: Provenance::UserInstruction {
                input_id: id.into(),
            },
            content,
            opaque: None,
        })
        .collect())
}

impl Catalog {
    /// A worker ending without a committed terminal Run is an explicit recovery boundary.
    /// This records the lost execution, not a claim that external effects were undone.
    pub fn pause_failed_execution(
        &mut self,
        run_id: &str,
        epoch: u64,
        code: &str,
        message: &str,
    ) -> Result<()> {
        let tx = self.db.transaction()?;
        let mut run: Run = super::record(&tx, "runs", run_id)?;
        if run.state.terminal() {
            return Ok(());
        }
        if run.epoch != epoch {
            return Err(RuntimeError::Conflict(
                "failed worker belongs to an old epoch".into(),
            ));
        }
        let key = format!("execution-recovery:{run_id}:{epoch}");
        let after_cursor: u64 =
            tx.query_row("SELECT coalesce(max(cursor),0) FROM events", [], |r| {
                read_number(r, 0)
            })?;
        let wait = Wait {
            id: key.clone(),
            run_id: run_id.into(),
            subject: run_id.into(),
            kind: "execution.reconciled".into(),
            after_cursor,
            trigger_cursor: None,
            cancelled: false,
        };
        tx.execute(
            "INSERT INTO waits(id,run_id,body) VALUES(?1,?2,?3) ON CONFLICT(id) DO NOTHING",
            params![key, run_id, encode(&wait)?],
        )?;
        run.state = RunState::Waiting;
        run.waiting_on = Some(key);
        run.revision += 1;
        put(&tx, "runs", run_id, &run)?;
        let steps: Vec<ModelStep> = {
            let mut stmt=tx.prepare("SELECT body FROM model_steps WHERE run_id=?1 AND state IN ('prepared','dispatched')")?;
            let rows = stmt.query_map([run_id], |r| r.get::<_, String>(0))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(serde_json::from_str(&row?)?);
            }
            out
        };
        for mut step in steps {
            step.state = if step.state == ModelStepState::Dispatched {
                ModelStepState::Interrupted
            } else {
                ModelStepState::Cancelled
            };
            put(&tx, "model_steps", &step.id, &step)?;
            tx.execute(
                "UPDATE model_steps SET state=?2 WHERE id=?1",
                params![step.id, encode(&step.state)?.trim_matches('"')],
            )?;
        }
        event(
            &tx,
            run_id,
            run.revision,
            "execution.interrupted",
            json!({"code":code,"message":message,"waiting_on":run.waiting_on}),
        )?;
        tx.commit()?;
        Ok(())
    }
}

impl Catalog {
    fn retain_rejected_model_output(
        &mut self,
        run_id: &str,
        epoch: u64,
        record: &ExecutionRecord,
    ) -> Result<()> {
        let ExecutionRecord::ModelFinished {
            request_id,
            items,
            usage,
            ..
        } = record
        else {
            return Ok(());
        };
        let originals = self.content.save_originals(&provider_originals(items))?;
        let output = self.content.save(&json!({"status":"rejected","record":record}))?;
        let tx = self.db.transaction()?;
        let Some(mut step) = optional_record::<ModelStep>(&tx, "model_steps", request_id)? else {
            return Ok(());
        };
        if step.run_id != run_id
            || step.epoch != epoch
            || !matches!(
                step.state,
                ModelStepState::Prepared | ModelStepState::Dispatched
            )
        {
            return Ok(());
        }
        step.original = originals;
        step.usage = Some(serde_json::to_value(usage)?);
        put(&tx, "model_steps", request_id, &step)?;
        tx.execute("INSERT INTO model_outputs(request_id,body) VALUES(?1,?2) ON CONFLICT(request_id) DO NOTHING",params![request_id,encode(&output)?])?;
        event(
            &tx,
            request_id,
            0,
            "model.output_rejected",
            json!({"run_id":run_id}),
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn model_output(&self, request_id: &str) -> Result<Option<Value>> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT body FROM model_outputs WHERE request_id=?1",
                [request_id],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|raw| self.content.load(&serde_json::from_str(&raw)?)).transpose()
    }
}

pub(super) fn apply_external_terminal(op: &mut Operation, receipt: &ExternalReceipt) {
    op.phase = OperationPhase::Terminal;
    op.outcome = Some(receipt.outcome);
    op.effect = receipt.effect;
    op.result = Some(receipt.result.clone());
}
impl Catalog {
    /// Only a trusted execution-end receipt consumer may call this. It is not exposed as a
    /// model/tool/Host wire command. Receipt identity belongs to the actual resource authority.
    pub fn record_external_receipt(
        &mut self,
        operation_id: &str,
        receipt: ExternalReceipt,
    ) -> Result<Operation> {
        let tx = self.db.transaction()?;
        let mut op: Operation = super::record(&tx, "operations", operation_id)?;
        if receipt.identity != op.id
            || op.executor.as_deref() != Some(receipt.executor.as_str())
            || receipt.epoch.is_empty()
            || !matches!(op.lifetime, Lifetime::Thread | Lifetime::Environment)
        {
            return Err(RuntimeError::Conflict(
                "external receipt does not identify this admitted job".into(),
            ));
        }
        if receipt.effect == Effect::Unknown && receipt.outcome != Outcome::Indeterminate {
            return Err(RuntimeError::Invalid(
                "unknown external effect requires indeterminate outcome".into(),
            ));
        }
        if let Some(previous) = &op.external_receipt {
            if previous == &receipt {
                drop(tx);
                self.reconcile_waits()?;
                return Ok(op);
            }
            if previous.outcome != Outcome::Indeterminate
                || previous.effect != Effect::Unknown
                || previous.epoch != receipt.epoch
                || receipt.effect == Effect::Unknown
            {
                return Err(RuntimeError::Conflict(
                    "external terminal receipt changed".into(),
                ));
            }
        }
        if op.phase == OperationPhase::Terminal && op.outcome != Some(Outcome::Indeterminate) {
            return Err(RuntimeError::Conflict(
                "job is already settled with another receipt".into(),
            ));
        }
        let settle = op.handed_off
            || (op.phase == OperationPhase::Terminal && op.outcome == Some(Outcome::Indeterminate));
        op.external_receipt = Some(receipt.clone());
        op.revision += 1;
        if settle {
            apply_external_terminal(&mut op, &receipt);
        }
        put(&tx, "operations", operation_id, &op)?;
        event(
            &tx,
            operation_id,
            op.revision,
            if settle {
                "operation.settled"
            } else {
                "operation.external_receipt"
            },
            serde_json::to_value(&op)?,
        )?;
        tx.commit()?;
        self.reconcile_waits()?;
        Ok(op)
    }
}

impl Catalog {
    /// Resource recovery queries only the native jobs whose facts are still unresolved.
    pub fn pending_external_operations(&self, executor: &str) -> Result<Vec<String>> {
        let mut statement=self.db.prepare("SELECT id FROM operations WHERE json_extract(body,'$.executor')=?1 AND (json_extract(body,'$.phase')!='terminal' OR json_extract(body,'$.outcome')='indeterminate') ORDER BY id")?;
        let rows = statement.query_map([executor], |row| row.get(0))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }
    pub fn record_recovery_failure(&mut self, source: &str, reason: &str) -> Result<()> {
        let tx = self.db.transaction()?;
        event(
            &tx,
            source,
            0,
            "recovery.unavailable",
            json!({"reason":reason}),
        )?;
        tx.commit()?;
        Ok(())
    }
}
