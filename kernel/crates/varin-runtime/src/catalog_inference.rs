//! Provider requests belonging to an already admitted tool. The original Operation and Goal
//! own every dispatch and receipt; Host transport and credentials remain private Host owners.
use super::*;
use crate::execution::{UsageMeasurement, UsageReceipt};
use crate::providers::auth::CredentialScope;
use serde::Deserialize;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InferenceRequestKind {
    Preparation,
    ModelCompute,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InferenceBinding {
    pub request_kind: InferenceRequestKind,
    pub purpose: String,
    pub provider_id: String,
    pub model_id: String,
    pub api: String,
    pub endpoint: String,
    pub configuration_id: String,
    pub credential_scope: CredentialScope,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InferenceAdmitParams {
    pub parent_operation_id: String,
    pub execution_owner: ExecutorOwner,
    pub ordinal: u64,
    pub binding: InferenceBinding,
    pub request: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InferenceOwnerParams {
    pub operation_id: String,
    pub execution_owner: ExecutorOwner,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InferenceUsage {
    pub measurement: UsageMeasurement,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}
impl InferenceUsage {
    fn receipt(&self) -> UsageReceipt {
        UsageReceipt {
            measurement: self.measurement,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            ..UsageReceipt::default()
        }
    }
    fn refines(&self, previous: &Self) -> bool {
        (previous.measurement == UsageMeasurement::Missing
            || self.measurement == previous.measurement)
            && previous
                .input_tokens
                .is_none_or(|n| self.input_tokens == Some(n))
            && previous
                .output_tokens
                .is_none_or(|n| self.output_tokens == Some(n))
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InferenceReceipt {
    /// True means entry into the actual transport, not proof the remote service executed.
    /// False is original-owner proof of no transport entry; recovery cannot infer either.
    pub request_started: Option<bool>,
    pub provider_completed: bool,
    pub local_executor_stopped: bool,
    pub usage: InferenceUsage,
    pub http_status: Option<u16>,
    pub problem: Option<InferenceProblem>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InferenceProblem {
    Cancelled,
    TransportFailed,
    HttpRejected,
    InvalidResponse,
    OwnerInterrupted,
    ReceiptPending,
    NotDispatched,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InferenceReceiptPendingParams {
    pub operation_id: String,
    pub execution_owner: ExecutorOwner,
    pub request_started: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InferenceSettleParams {
    pub operation_id: String,
    pub execution_owner: ExecutorOwner,
    pub receipt: InferenceReceipt,
    pub response: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Intent {
    kind: String,
    parent_operation_id: String,
    ordinal: u64,
    binding: InferenceBinding,
    request_ref: Value,
    goal: Option<goals::FrozenGoal>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    dispatched: bool,
    accounted: bool,
    recovered: bool,
    receipt_pending: bool,
    receipt: Option<InferenceReceipt>,
    response_ref: Option<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceStatus {
    pub operation_id: String,
    pub request_kind: InferenceRequestKind,
    pub phase: OperationPhase,
    pub outcome: Option<Outcome>,
    pub live: bool,
    pub cancel_requested: bool,
    pub dispatched: bool,
    pub recovered: bool,
    pub receipt_pending: bool,
    pub receipt: Option<InferenceReceipt>,
}
pub struct InferencePreparation {
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct InferenceBody {
    reference: Value,
    _preparation: InferencePreparation,
}
impl InferencePreparation {
    pub fn write(self, body: &Value) -> Result<InferenceBody> {
        Ok(InferenceBody {
            reference: self.content.save(body)?,
            _preparation: self,
        })
    }
}
fn conflict() -> RuntimeError {
    RuntimeError::Conflict("inference_identity_changed".into())
}
pub(crate) fn is_inference(op: &Operation) -> bool {
    op.intent["kind"] == "decision_request_v1"
}
fn intent(op: &Operation) -> Result<Intent> {
    if !is_inference(op) {
        return Err(conflict());
    }
    Ok(serde_json::from_value(op.intent.clone())?)
}
fn state(op: &Operation) -> Result<State> {
    Ok(serde_json::from_value(
        op.result.as_ref().ok_or_else(conflict)?.control()?.clone(),
    )?)
}
fn owned(op: &Operation, owner: &ExecutorOwner) -> Result<()> {
    if op.execution_owner.as_ref() != Some(owner)
        || !matches!(owner, ExecutorOwner::External { .. })
    {
        return Err(conflict());
    }
    Ok(())
}
fn parent_live(db: &Connection, op: &Operation, i: &Intent, epoch: u64) -> Result<()> {
    let parent: Operation = record(db, "operations", &i.parent_operation_id)?;
    let run: Run = record(db, "runs", &op.run_id)?;
    if op.epoch != epoch
        || parent.run_id != op.run_id
        || parent.execution_owner != op.execution_owner
        || parent.phase != OperationPhase::Running
        || parent.cancel_requested
        || run.cancel_requested
        || run.state.terminal()
        || op.cancel_requested
    {
        return Err(RuntimeError::DispatchCancelled);
    }
    let tool = tool_content::ToolIntent::from_operation(&parent)?;
    let context = crate::execution::ToolExecutionContext {
        run_id: run.id,
        operation_id: parent.id,
        origin: tool.origin().clone(),
    };
    if !goals::tool_allowed(db, &context)? {
        return Err(RuntimeError::GoalChanged);
    }
    if goals::origin_goal(db, tool.origin())? != i.goal {
        return Err(RuntimeError::GoalChanged);
    }
    Ok(())
}
fn publish(tx: &Transaction<'_>, op: &mut Operation, s: &State, event_kind: &str) -> Result<()> {
    op.result = Some(OperationResultMetadata::Control {
        value: serde_json::to_value(s)?,
    });
    op.revision += 1;
    put(tx, "operations", &op.id, op)?;
    event(
        tx,
        &op.id,
        op.revision,
        event_kind,
        json!({"runId":op.run_id,"responseRef":s.response_ref}),
    )?;
    Ok(())
}
impl Catalog {
    pub fn prepare_inference_content(&self) -> InferencePreparation {
        InferencePreparation {
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        }
    }
    pub fn admit_inference(
        &mut self,
        p: &InferenceAdmitParams,
        body: InferenceBody,
    ) -> Result<InferenceStatus> {
        if p.ordinal == 0 || p.binding.purpose.is_empty() || p.binding.configuration_id.is_empty() {
            return Err(conflict());
        }
        let id = format!("inference:{}:{}", p.parent_operation_id, p.ordinal);
        if let Some(op) = optional_record::<Operation>(&self.db, "operations", &id)? {
            owned(&op, &p.execution_owner)?;
            let i = intent(&op)?;
            if i.binding != p.binding || i.request_ref != body.reference {
                return Err(conflict());
            }
            return self.inference_status(&id, &p.execution_owner);
        }
        let parent = self.operation(&p.parent_operation_id)?;
        owned(&parent, &p.execution_owner)?;
        let tool = tool_content::ToolIntent::from_operation(&parent)?;
        let goal = goals::origin_goal(&self.db, tool.origin())?;
        let i = Intent {
            kind: "decision_request_v1".into(),
            parent_operation_id: parent.id.clone(),
            ordinal: p.ordinal,
            binding: p.binding.clone(),
            request_ref: body.reference.clone(),
            goal,
        };
        let op = Operation {
            id: id.clone(),
            run_id: parent.run_id,
            epoch: self.epoch,
            revision: 1,
            phase: OperationPhase::Accepted,
            outcome: None,
            effect: Effect::None,
            cancel_requested: false,
            lifetime: Lifetime::Run,
            handed_off: false,
            executor: Some("inference.decision.v1".into()),
            execution_owner: Some(p.execution_owner.clone()),
            waiting_on: None,
            intent: serde_json::to_value(&i)?,
            result: Some(OperationResultMetadata::Control {
                value: serde_json::to_value(State::default())?,
            }),
            host_job: None,
            mcp_resource_subscription: None,
            managed_process: None,
            external_receipt: None,
            call_completion: None,
        };
        let tx = self.db.transaction()?;
        parent_live(&tx, &op, &i, self.epoch)?;
        tx.execute(
            "INSERT INTO operations(id,run_id,body) VALUES(?1,?2,?3)",
            params![id, op.run_id, encode(&op)?],
        )?;
        event(
            &tx,
            &id,
            1,
            "inference.admitted",
            json!({"runId":op.run_id,"parentOperationId":i.parent_operation_id}),
        )?;
        tx.commit()?;
        self.inference_status(&id, &p.execution_owner)
    }
    pub fn inference_status(&self, id: &str, owner: &ExecutorOwner) -> Result<InferenceStatus> {
        let op = self.operation(id)?;
        owned(&op, owner)?;
        let i = intent(&op)?;
        let s = state(&op)?;
        let live = if op.phase == OperationPhase::Terminal {
            false
        } else {
            match parent_live(&self.db, &op, &i, self.epoch) {
                Ok(()) => true,
                Err(RuntimeError::DispatchCancelled | RuntimeError::GoalChanged) => false,
                Err(error) => return Err(error),
            }
        };
        Ok(InferenceStatus {
            operation_id: id.into(),
            request_kind: i.binding.request_kind,
            phase: op.phase,
            outcome: op.outcome,
            live,
            cancel_requested: op.cancel_requested,
            dispatched: s.dispatched,
            recovered: s.recovered,
            receipt_pending: s.receipt_pending,
            receipt: s.receipt,
        })
    }
    pub fn dispatch_inference(&mut self, p: &InferenceOwnerParams) -> Result<InferenceStatus> {
        let mut op = self.operation(&p.operation_id)?;
        owned(&op, &p.execution_owner)?;
        let i = intent(&op)?;
        let mut s = state(&op)?;
        if s.dispatched || s.recovered || op.phase == OperationPhase::Terminal {
            return Err(conflict());
        }
        let tx = self.db.transaction()?;
        parent_live(&tx, &op, &i, self.epoch)?;
        goals::check_dispatch(&tx, &op.run_id, i.goal.as_ref())?;
        if i.binding.request_kind == InferenceRequestKind::ModelCompute {
            if let Some(goal) = &i.goal {
                goals::dispatched(&tx, goal)?;
            }
        }
        s.dispatched = true;
        op.phase = OperationPhase::Running;
        op.effect = Effect::Dispatched;
        publish(&tx, &mut op, &s, "inference.dispatched")?;
        tx.commit()?;
        self.inference_status(&p.operation_id, &p.execution_owner)
    }
    /// Metadata-only loss barrier after the original transport has drained. This records
    /// unknown usage before the parent callback can release another paid boundary.
    pub fn inference_receipt_pending(
        &mut self,
        p: &InferenceReceiptPendingParams,
    ) -> Result<InferenceStatus> {
        let mut op = self.operation(&p.operation_id)?;
        owned(&op, &p.execution_owner)?;
        let i = intent(&op)?;
        let mut s = state(&op)?;
        if s.receipt
            .as_ref()
            .and_then(|receipt| receipt.request_started)
            .is_some_and(|started| started != p.request_started)
        {
            return Err(conflict());
        }
        if (s.receipt.is_some() && !s.recovered) || s.receipt_pending {
            return self.inference_status(&p.operation_id, &p.execution_owner);
        }
        if !s.dispatched && p.request_started {
            return Err(conflict());
        }
        let tx = self.db.transaction()?;
        if s.dispatched && i.binding.request_kind == InferenceRequestKind::ModelCompute {
            if !s.accounted {
                if p.request_started {
                    goals::measured(&tx, i.goal.as_ref(), &UsageReceipt::default())?;
                } else {
                    goals::not_dispatched(&tx, i.goal.as_ref())?;
                }
                s.accounted = true;
            } else if !p.request_started
                && s.receipt
                    .as_ref()
                    .is_some_and(|receipt| receipt.request_started != Some(false))
            {
                goals::refine_measurement(
                    &tx,
                    i.goal.as_ref(),
                    &s.receipt.as_ref().ok_or_else(conflict)?.usage.receipt(),
                    None,
                )?;
            }
        }
        s.receipt_pending = true;
        s.receipt = Some(InferenceReceipt {
            request_started: Some(p.request_started),
            provider_completed: false,
            local_executor_stopped: true,
            usage: InferenceUsage::default(),
            http_status: None,
            problem: Some(InferenceProblem::ReceiptPending),
        });
        op.phase = OperationPhase::Terminal;
        op.outcome = Some(if p.request_started {
            Outcome::Indeterminate
        } else if op.cancel_requested {
            Outcome::Cancelled
        } else {
            Outcome::Failed
        });
        op.effect = if p.request_started {
            Effect::Unknown
        } else {
            Effect::None
        };
        publish(&tx, &mut op, &s, "inference.receipt_pending")?;
        tx.commit()?;
        self.inference_status(&p.operation_id, &p.execution_owner)
    }
    pub fn settle_inference(
        &mut self,
        p: &InferenceSettleParams,
        body: InferenceBody,
    ) -> Result<InferenceStatus> {
        let mut op = self.operation(&p.operation_id)?;
        owned(&op, &p.execution_owner)?;
        let i = intent(&op)?;
        let mut s = state(&op)?;
        if s.response_ref.as_ref() == Some(&body.reference)
            && s.receipt.as_ref() == Some(&p.receipt)
        {
            return self.inference_status(&p.operation_id, &p.execution_owner);
        }
        if !p.receipt.local_executor_stopped
            || p.receipt.request_started.is_none()
            || (p.receipt.provider_completed && p.receipt.request_started != Some(true))
            || (p.receipt.request_started == Some(false)
                && p.receipt.usage != InferenceUsage::default())
            || (!s.dispatched && p.receipt.request_started != Some(false))
            || (i.binding.request_kind == InferenceRequestKind::Preparation
                && p.receipt.usage != InferenceUsage::default())
        {
            return Err(conflict());
        }
        if let Some(previous) = &s.receipt {
            if (!s.recovered && !s.receipt_pending)
                || previous.provider_completed
                || previous
                    .request_started
                    .is_some_and(|started| Some(started) != p.receipt.request_started)
                || !p.receipt.usage.refines(&previous.usage)
            {
                return Err(conflict());
            }
        }
        let tx = self.db.transaction()?;
        if s.dispatched && i.binding.request_kind == InferenceRequestKind::ModelCompute {
            if s.accounted {
                if s.receipt.as_ref().ok_or_else(conflict)?.request_started != Some(false) {
                    goals::refine_measurement(
                        &tx,
                        i.goal.as_ref(),
                        &s.receipt.as_ref().ok_or_else(conflict)?.usage.receipt(),
                        (p.receipt.request_started != Some(false))
                            .then(|| p.receipt.usage.receipt())
                            .as_ref(),
                    )?;
                }
            } else {
                if p.receipt.request_started == Some(false) {
                    goals::not_dispatched(&tx, i.goal.as_ref())?;
                } else {
                    goals::measured(&tx, i.goal.as_ref(), &p.receipt.usage.receipt())?;
                }
                s.accounted = true;
            }
        }
        s.receipt = Some(p.receipt.clone());
        s.response_ref = Some(body.reference);
        s.recovered = false;
        s.receipt_pending = false;
        op.phase = OperationPhase::Terminal;
        op.outcome = Some(
            if !s.dispatched || p.receipt.request_started == Some(false) {
                if op.cancel_requested {
                    Outcome::Cancelled
                } else {
                    Outcome::Failed
                }
            } else if !p.receipt.provider_completed {
                Outcome::Indeterminate
            } else if op.cancel_requested {
                Outcome::Cancelled
            } else if p.receipt.problem.is_some() {
                Outcome::Failed
            } else {
                Outcome::Succeeded
            },
        );
        op.effect = if !s.dispatched || p.receipt.request_started == Some(false) {
            Effect::None
        } else if p.receipt.provider_completed {
            Effect::Confirmed
        } else {
            Effect::Unknown
        };
        publish(&tx, &mut op, &s, "inference.settled")?;
        tx.commit()?;
        self.inference_status(&p.operation_id, &p.execution_owner)
    }
}
pub(crate) fn recover(tx: &Transaction<'_>, op: &mut Operation) -> Result<bool> {
    if !is_inference(op) {
        return Ok(false);
    }
    if op.phase == OperationPhase::Terminal {
        return Ok(true);
    }
    let i = intent(op)?;
    let mut s = state(op)?;
    let receipt = s.receipt.get_or_insert(InferenceReceipt {
        request_started: None,
        provider_completed: false,
        local_executor_stopped: false,
        usage: InferenceUsage::default(),
        http_status: None,
        problem: Some(InferenceProblem::OwnerInterrupted),
    });
    if s.dispatched && !s.accounted && i.binding.request_kind == InferenceRequestKind::ModelCompute
    {
        goals::measured(tx, i.goal.as_ref(), &receipt.usage.receipt())?;
        s.accounted = true;
    }
    s.recovered = true;
    op.phase = OperationPhase::Terminal;
    op.outcome = Some(if s.dispatched {
        Outcome::Indeterminate
    } else {
        Outcome::Cancelled
    });
    op.effect = if s.dispatched {
        Effect::Unknown
    } else {
        Effect::None
    };
    publish(tx, op, &s, "inference.recovered")?;
    Ok(true)
}
pub(super) fn cancel_children(
    tx: &Transaction<'_>,
    parent: Option<&str>,
    run: Option<&str>,
) -> Result<()> {
    let mut query = tx.prepare("SELECT body FROM operations WHERE json_extract(body,'$.intent.kind')='decision_request_v1' AND ((?1 IS NOT NULL AND json_extract(body,'$.intent.parentOperationId')=?1) OR (?2 IS NOT NULL AND run_id=?2))")?;
    let operations = query
        .query_map(params![parent, run], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(query);
    for raw in operations {
        let mut op: Operation = serde_json::from_str(&raw)?;
        if op.phase != OperationPhase::Terminal && !op.cancel_requested {
            op.cancel_requested = true;
            let s = state(&op)?;
            publish(tx, &mut op, &s, "operation.cancel_requested")?;
        }
    }
    Ok(())
}
pub(crate) fn hydrate_operation(
    op: &mut Operation,
    content: &crate::content::ContentStore,
) -> Result<()> {
    if !is_inference(op) {
        return Ok(());
    }
    let i = intent(op)?;
    let s = state(op)?;
    op.intent
        .as_object_mut()
        .ok_or_else(conflict)?
        .insert("request".into(), content.load(&i.request_ref)?);
    op.intent.as_object_mut().unwrap().remove("requestRef");
    if let Some(reference) = s.response_ref {
        if let Some(OperationResultMetadata::Control { value }) = &mut op.result {
            value
                .as_object_mut()
                .ok_or_else(conflict)?
                .insert("response".into(), content.load(&reference)?);
        }
    }
    Ok(())
}
