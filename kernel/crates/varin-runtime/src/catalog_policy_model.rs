//! Atomic policy/model admission and durable dispatch knowledge in the existing Operation owner.
use super::*;
use crate::execution::*;

pub(crate) fn model_intent(op: &Operation) -> Result<Option<PolicyModelIntent>> {
    let kind = op.intent.get("kind").and_then(Value::as_str).unwrap_or("");
    if !kind.starts_with("policy_model_job") {
        return Ok(None);
    }
    if kind != "policy_model_job_v1" {
        return Err(RuntimeError::Invalid(
            "unsupported policy model format; data preserved".into(),
        ));
    }
    let intent: PolicyModelIntent = serde_json::from_value(op.intent.clone())?;
    if op.id != intent.action_id()
        || op.lifetime != Lifetime::Run
        || op.effect != Effect::None
        || op.executor.as_deref() != Some("policy-model.v1")
    {
        return Err(RuntimeError::Invalid("policy model owner malformed".into()));
    }
    Ok(Some(intent))
}
pub(crate) fn model_result(op: &Operation) -> Result<PolicyModelResult> {
    let result: PolicyModelResult = serde_json::from_value(
        op.result
            .clone()
            .ok_or_else(|| RuntimeError::Invalid("policy model result missing".into()))?,
    )?;
    if (op.phase == OperationPhase::Terminal) != result.receipt.is_some()
        || result
            .receipt
            .as_ref()
            .and_then(|r| r.output.as_ref())
            .is_some_and(|r| r.action_id != op.id || r.node_id != "output")
    {
        return Err(RuntimeError::Invalid(
            "policy model receipt owner malformed".into(),
        ));
    }
    Ok(result)
}

/// Captured under Catalog ownership; body reads do not retain the metadata mutex.
pub(crate) struct PolicyModelRead {
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
    pub(crate) intent: PolicyModelIntent,
    pub(crate) result: PolicyModelResult,
    pub(crate) decision: Option<PolicyDecision>,
    pub(crate) cancel_requested: bool,
}
impl PolicyModelRead {
    pub(crate) fn load(self) -> Result<PolicyModelState> {
        let snapshot = serde_json::from_value(self.content.load(&self.result.request_ref)?)?;
        let output = self.result.original_ref.as_ref()
            .map(|reference| self.content.load(reference).and_then(|value| Ok(serde_json::from_value(value)?)))
            .transpose()?.unwrap_or_default();
        Ok(PolicyModelState {
            intent: self.intent, result: self.result, snapshot, output,
            decision: self.decision, cancel_requested: self.cancel_requested,
        })
    }
}

pub(crate) struct PolicyModelOutputReferences {
    original: Value,
    evidence: Option<Value>,
}
impl PolicyModelOutputReferences {
    pub(crate) fn write(
        content: &crate::content::ContentStore,
        output: &PolicyModelOutput,
        receipt: Option<&PolicyModelReceipt>,
    ) -> Result<Self> {
        let original = content.save(&serde_json::to_value(output)?)?;
        let evidence = if receipt.is_some_and(|receipt| receipt.usable) {
            let text = output.items.iter().filter_map(|item| match &item.content {
                Content::Text { text } => Some(text.as_str()), _ => None,
            }).collect::<Vec<_>>().join("\n");
            Some(content.save(&json!({"kind":"model_derived_evidence","text":text}))?)
        } else { None };
        Ok(Self { original, evidence })
    }
}
impl Catalog {
    pub fn policy_model_job(&self, run_id: &str, epoch: u64) -> Result<Option<PolicyModelState>> {
        self.prepare_policy_model_read(run_id, epoch)?.map(PolicyModelRead::load).transpose()
    }
    pub(crate) fn prepare_policy_model_read(&self, run_id: &str, epoch: u64) -> Result<Option<PolicyModelRead>> {
        fence(&self.run(run_id)?, epoch)?;
        // The latest action across both domains owns the decision boundary.
        let key:Option<String>=self.db.query_row("SELECT id FROM operations WHERE run_id=?1 AND json_extract(body,'$.intent.kind') IN ('policy_read_graph_v1','policy_model_job_v1') ORDER BY rowid DESC LIMIT 1",[run_id],|r|r.get(0)).optional()?;
        let Some(key) = key else { return Ok(None) };
        let op: Operation = record(&self.db, "operations", &key)?;
        let Some(intent) = model_intent(&op)? else {
            return Ok(None);
        };
        let result = model_result(&op)?;
        let admitted:u64=self.db.query_row("SELECT coalesce(max(cursor),0) FROM events WHERE subject=?1 AND kind='policy.model_admitted'",[&key],|r|read_number(r,0))?;
        let consumed:u64=self.db.query_row("SELECT coalesce(max(cursor),0) FROM events WHERE subject=?1 AND (kind='input.delivered' OR (kind='execution.committed' AND json_extract(data,'$.kind')='request_prepared'))",[run_id],|r|read_number(r,0))?;
        if result.receipt.is_some() && consumed > admitted {
            return Ok(None);
        }
        let saved: (String, String) = self.db.query_row(
            "SELECT state,action FROM policy_checkpoints WHERE run_id=?1",
            [run_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let action: PolicyAction = serde_json::from_str(&saved.1)?;
        let mut decision = if result.receipt.is_some()
            && !matches!(action, PolicyAction::RequestModelJob { .. })
        {
            Some(PolicyDecision {
                state: serde_json::from_str(&saved.0)?,
                action,
            })
        } else {
            None
        };
        if let Some(PolicyDecision {
            action: PolicyAction::Wait { wait_id },
            ..
        }) = &decision
        {
            let wait: Wait = record(&self.db, "waits", wait_id)?;
            if wait.trigger_cursor.is_some() || wait.cancelled {
                decision = None;
            }
        }
        Ok(Some(PolicyModelRead {
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
            intent,
            result,
            decision,
            cancel_requested: op.cancel_requested,
        }))
    }
    pub fn admit_policy_model(
        &mut self,
        run_id: &str,
        epoch: u64,
        intent: &PolicyModelIntent,
        snapshot: &RequestSnapshot,
    ) -> Result<PolicyModelState> {
        let _publication = self.content.begin_publication();
        let reference = self.content.save(&serde_json::to_value(snapshot)?)?;
        self.admit_policy_model_reference(run_id, epoch, intent, snapshot, reference)?.load()
    }
    pub(crate) fn admit_policy_model_reference(
        &mut self,
        run_id: &str,
        epoch: u64,
        intent: &PolicyModelIntent,
        snapshot: &RequestSnapshot,
        reference: Value,
    ) -> Result<PolicyModelRead> {
        let PolicyModelIntent::PolicyModelJobV1 {
            action_id,
            boundary,
            identity,
            state,
            capability,
            instructions,
            evidence,
        } = intent;
        let run = self.run(run_id)?;
        fence(&run, epoch)?;
        if let Some(op) = optional_record::<Operation>(&self.db, "operations", action_id)? {
            if model_intent(&op)?.as_ref() != Some(intent) || op.run_id != run_id {
                return Err(RuntimeError::Conflict(
                    "policy boundary intent changed".into(),
                ));
            }
            let result = model_result(&op)?;
            if result.request_ref != reference {
                return Err(RuntimeError::Conflict(
                    "frozen planning request changed".into(),
                ));
            }
            return self
                .prepare_policy_model_read(run_id, epoch)?
                .ok_or_else(|| RuntimeError::Conflict("planning action superseded".into()));
        }
        if run.cancel_requested
            || boundary != &self.policy_boundary(run_id, epoch)?
            || action_id != &format!("{run_id}:policy:{}", boundary.id)
            || snapshot.view.run_id != run_id
            || snapshot.view.request_id != *action_id
            || snapshot.view.binding.history_range.branch_id != run.branch_id
            || snapshot.view.binding.history_range.leaf_id != self.head(&run.branch_id)?
            || !snapshot.view.binding.tools.is_empty()
        {
            return Err(RuntimeError::Conflict("planning boundary changed".into()));
        }
        let mut expected = capability
            .binding
            .clone()
            .ok_or_else(|| RuntimeError::Invalid("planning binding missing".into()))?;
        expected.history_range = snapshot.view.binding.history_range.clone();
        expected.instruction_sources = instructions.clone();
        expected.memory_checkpoint = snapshot.view.binding.memory_checkpoint.clone();
        if expected != snapshot.view.binding
            || capability.status != PolicyModelStatus::Available
            || capability.purpose != "planning"
            || capability.supported_operation != "tool_free_text"
            || instructions.is_empty()
        {
            return Err(RuntimeError::Conflict(
                "planning request differs from frozen capability".into(),
            ));
        }
        if snapshot.view.origin
            != (RequestOrigin::PolicyModelJob {
                action_id: action_id.clone(),
                purpose: capability.purpose.clone(),
                boundary_id: boundary.id.clone(),
            })
        {
            return Err(RuntimeError::Invalid("planning origin mismatch".into()));
        }
        if let Some(launch) = self.launch_intent(run_id)? {
            if launch.selection.policy != *identity
                || !launch.selection.policy_models.contains(capability)
            {
                return Err(RuntimeError::Conflict(
                    "planning capability differs from pinned launch".into(),
                ));
            }
        }
        for reference in evidence {
            self.owned_policy_reference(run_id, reference)?;
        }
        // The caller retains publication ownership until this reference is committed.
        let result = PolicyModelResult {
            dispatch: PolicyModelDispatch::Prepared,
            request_ref: reference,
            original_ref: None,
            receipt: None,
        };
        let op = Operation {
            id: action_id.clone(),
            run_id: run_id.into(),
            epoch,
            revision: 1,
            phase: OperationPhase::Accepted,
            outcome: None,
            effect: Effect::None,
            cancel_requested: false,
            lifetime: Lifetime::Run,
            handed_off: false,
            executor: Some("policy-model.v1".into()),
            waiting_on: None,
            intent: serde_json::to_value(intent)?,
            result: Some(serde_json::to_value(&result)?),
            external_receipt: None,
        };
        let tx = self.db.transaction()?;
        if super::inputs::has_boundary_inputs(&tx, run_id)? {
            return Err(RuntimeError::InputPending);
        }
        let unresolved:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM model_steps WHERE run_id=?1 AND state!='completed' AND json_extract(body,'$.superseded_by_input') IS NULL) OR EXISTS(SELECT 1 FROM tool_calls c JOIN model_steps m ON m.id=c.request_id WHERE m.run_id=?1 AND c.committed=0) OR EXISTS(SELECT 1 FROM operations WHERE run_id=?1 AND json_extract(body,'$.intent.kind') IN ('policy_read_graph_v1','policy_model_job_v1') AND json_extract(body,'$.phase')!='terminal')",[run_id],|r|r.get(0))?;
        if unresolved {
            return Err(RuntimeError::Conflict(
                "planning cannot bypass unsettled work".into(),
            ));
        }
        let saved: Option<String> = tx
            .query_row(
                "SELECT identity FROM policy_checkpoints WHERE run_id=?1",
                [run_id],
                |r| r.get(0),
            )
            .optional()?;
        if saved
            .map(|s| serde_json::from_str::<PolicyIdentity>(&s))
            .transpose()?
            .is_some_and(|i| i != *identity)
        {
            return Err(RuntimeError::Conflict("policy identity changed".into()));
        }
        let action = PolicyAction::RequestModelJob {
            capability_id: capability.capability_id.clone(),
            instructions: instructions.clone(),
            evidence: evidence.clone(),
        };
        tx.execute("INSERT INTO policy_checkpoints(run_id,identity,state,action) VALUES(?1,?2,?3,?4) ON CONFLICT(run_id) DO UPDATE SET identity=excluded.identity,state=excluded.state,action=excluded.action",params![run_id,encode(identity)?,encode(state)?,encode(&action)?])?;
        tx.execute(
            "INSERT INTO operations(id,run_id,body) VALUES(?1,?2,?3)",
            params![action_id, run_id, encode(&op)?],
        )?;
        super::memory::record_deliveries(&tx, snapshot, &run.thread_id, DeliveryState::Selected)?;
        event(
            &tx,
            action_id,
            1,
            "policy.model_admitted",
            json!({"run_id":run_id}),
        )?;
        tx.commit()?;
        self.prepare_policy_model_read(run_id, epoch)?
            .ok_or_else(|| RuntimeError::Invalid("admitted model missing".into()))
    }
    pub fn dispatch_policy_model(&mut self, run_id: &str, epoch: u64, action: &str) -> Result<()> {
        let _publication = self.content.begin_publication();
        let reference = self.policy_model_request_reference(run_id, epoch, action)?;
        let snapshot = serde_json::from_value(self.content.load(&reference)?)?;
        self.dispatch_policy_model_prepared(run_id, epoch, action, &reference, &snapshot)
    }
    pub(crate) fn policy_model_request_reference(&self, run_id: &str, epoch: u64, action: &str) -> Result<Value> {
        fence(&self.run(run_id)?, epoch)?;
        let op: Operation = record(&self.db, "operations", action)?;
        if model_intent(&op)?.is_none() || op.run_id != run_id || op.epoch != epoch {
            return Err(RuntimeError::Conflict("planning owner changed".into()));
        }
        Ok(model_result(&op)?.request_ref)
    }
    pub(crate) fn dispatch_policy_model_prepared(
        &mut self, run_id: &str, epoch: u64, action: &str,
        request_ref: &Value, snapshot: &RequestSnapshot,
    ) -> Result<()> {
        let run = self.run(run_id)?;
        fence(&run, epoch)?;
        let mut op: Operation = record(&self.db, "operations", action)?;
        if model_intent(&op)?.is_none() || op.run_id != run_id || op.epoch != epoch {
            return Err(RuntimeError::Conflict("planning owner changed".into()));
        }
        let mut result = model_result(&op)?;
        if result.dispatch != PolicyModelDispatch::Prepared
            || run.cancel_requested
            || op.cancel_requested
        {
            return Err(RuntimeError::Conflict(
                "planning dispatch no longer allowed".into(),
            ));
        }
        if &result.request_ref != request_ref {
            return Err(RuntimeError::Conflict("frozen planning request changed".into()));
        }
        result.dispatch = PolicyModelDispatch::Dispatched;
        op.result = Some(serde_json::to_value(result)?);
        op.phase = OperationPhase::Running;
        op.revision += 1;
        let tx = self.db.transaction()?;
        if super::inputs::has_boundary_inputs(&tx, run_id)? {
            return Err(RuntimeError::InputPending);
        }
        put(&tx, "operations", action, &op)?;
        super::memory::record_deliveries(&tx, snapshot, &run.thread_id, DeliveryState::Sent)?;
        event(
            &tx,
            action,
            op.revision,
            "policy.model_dispatched",
            Value::Null,
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn record_policy_model(
        &mut self,
        run_id: &str,
        epoch: u64,
        action: &str,
        output: &PolicyModelOutput,
        receipt: Option<&PolicyModelReceipt>,
    ) -> Result<()> {
        let _publication = self.content.begin_publication();
        let reference = self.policy_model_request_reference(run_id, epoch, action)?;
        let snapshot = serde_json::from_value(self.content.load(&reference)?)?;
        let output_refs = PolicyModelOutputReferences::write(&self.content, output, receipt)?;
        self.record_policy_model_prepared(run_id, epoch, action, output, receipt, &reference, &snapshot, output_refs)
    }
    pub(crate) fn record_policy_model_prepared(
        &mut self, run_id: &str, epoch: u64, action: &str, output: &PolicyModelOutput,
        receipt: Option<&PolicyModelReceipt>, request_ref: &Value, snapshot: &RequestSnapshot,
        output_refs: PolicyModelOutputReferences,
    ) -> Result<()> {
        let run = self.run(run_id)?;
        fence(&run, epoch)?;
        let mut op: Operation = record(&self.db, "operations", action)?;
        if model_intent(&op)?.is_none() || op.run_id != run_id || op.epoch != epoch {
            return Err(RuntimeError::Conflict("planning owner changed".into()));
        }
        let mut result = model_result(&op)?;
        if result.receipt.is_some() {
            return Err(RuntimeError::Conflict("planning already settled".into()));
        }
        if &result.request_ref != request_ref {
            return Err(RuntimeError::Conflict("frozen planning request changed".into()));
        }
        result.original_ref = Some(output_refs.original);
        if let Some(receipt) = receipt {
            if receipt.usage != output.usage
                || (result.dispatch == PolicyModelDispatch::Prepared
                    && (receipt.usable || receipt.dispatch != PolicyModelDispatch::Prepared))
                || (result.dispatch == PolicyModelDispatch::Dispatched
                    && receipt.dispatch == PolicyModelDispatch::Prepared)
            {
                return Err(RuntimeError::Conflict(
                    "planning receipt contradicts dispatch or observed usage".into(),
                ));
            }
            let mut receipt = receipt.clone();
            if receipt.usable {
                if receipt.outcome != Outcome::Succeeded
                    || receipt.finish_reason != Some(FinishReason::Stop)
                    || output.items.iter().any(|i| {
                        matches!(
                            i.content,
                            Content::ToolCall { .. } | Content::ToolResult { .. }
                        )
                    })
                {
                    return Err(RuntimeError::Invalid("unusable planning result".into()));
                }
                let reference = output_refs.evidence.ok_or_else(|| RuntimeError::Invalid("planning evidence reference missing".into()))?;
                receipt.output = Some(PolicyEvidenceRef {
                    action_id: action.into(),
                    node_id: "output".into(),
                    content_ref: reference["content_object"]
                        .as_str()
                        .ok_or_else(|| RuntimeError::Invalid("content reference missing".into()))?
                        .into(),
                });
            } else {
                receipt.output = None;
            }
            result.dispatch = receipt.dispatch.clone();
            op.outcome = Some(receipt.outcome);
            result.receipt = Some(receipt);
            op.phase = OperationPhase::Terminal;
        }
        op.result = Some(serde_json::to_value(result)?);
        op.revision += 1;
        let tx = self.db.transaction()?;
        put(&tx, "operations", action, &op)?;
        if receipt.is_some_and(|receipt| receipt.usable) { super::memory::record_deliveries(&tx, snapshot, &run.thread_id, DeliveryState::Committed)?; }
        event(
            &tx,
            action,
            op.revision,
            if receipt.is_some() {
                "policy.model_settled"
            } else {
                "policy.model_output"
            },
            Value::Null,
        )?;
        tx.commit()?;
        Ok(())
    }
}
