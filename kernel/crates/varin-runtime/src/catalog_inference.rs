//! Provider requests belonging to an already admitted tool. The original Operation and Goal
//! own every dispatch and receipt; Host transport and credentials remain private Host owners.
use super::*;
use crate::execution::{UsageMeasurement, UsageReceipt};
use crate::providers::auth::CredentialScope;
use serde::Deserialize;
#[path = "catalog_inference_generation.rs"]
pub mod generation;

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
    pub configuration_id: String,
    pub executor: InferenceExecutor,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum InferenceExecutor {
    Http { api: String, endpoint: String, credential_scope: CredentialScope },
    LocalComponent { component_id: String, component_version: String, manifest_digest: String,
        model_revision: String, worker_protocol: u64 },
}
impl InferenceExecutor {
    fn local(&self) -> bool { matches!(self, Self::LocalComponent { .. }) }
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InferenceSessionParams {
    pub parent_operation_id: String,
    pub execution_owner: ExecutorOwner,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InferenceSessionStatus {
    pub has_requests: bool,
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
    pub cached_input_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub pricing_version: Option<String>,
}
impl InferenceUsage {
    fn receipt(&self) -> UsageReceipt {
        UsageReceipt {
            measurement: self.measurement,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cached_input_tokens: self.cached_input_tokens,
            cache_write_tokens: self.cache_write_tokens,
            reasoning_tokens: self.reasoning_tokens,
            pricing_version: self.pricing_version.clone(),
            raw: None,
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
            && previous
                .cached_input_tokens
                .is_none_or(|n| self.cached_input_tokens == Some(n))
            && previous
                .cache_write_tokens
                .is_none_or(|n| self.cache_write_tokens == Some(n))
            && previous
                .reasoning_tokens
                .is_none_or(|n| self.reasoning_tokens == Some(n))
            && previous
                .pricing_version
                .as_ref()
                .is_none_or(|v| self.pricing_version.as_ref() == Some(v))
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
    ExecutorFailed,
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
    pub request_started: Option<bool>,
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
#[serde(tag = "kind", rename_all = "snake_case")]
enum InferenceCaller {
    Operation,
    MemoryWork,
    Query {
        context: crate::execution::ToolExecutionContext,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Intent {
    caller_owner: ExecutorOwner,
    caller: InferenceCaller,
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
    checkpoint_usage: InferenceUsage,
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
    pub(super) reference: Value,
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
    op.intent["kind"] == "inference_request_v1"
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
fn caller_owned(op: &Operation, owner: &ExecutorOwner) -> Result<()> {
    if &intent(op)?.caller_owner != owner || !matches!(owner, ExecutorOwner::External { .. }) {
        return Err(conflict());
    }
    Ok(())
}
fn parent_live(db: &Connection, op: &Operation, i: &Intent, epoch: u64) -> Result<()> {
    let run: Run = record(db, "runs", &op.run_id)?;
    if op.epoch != epoch || run.cancel_requested || run.state.terminal() || op.cancel_requested {
        return Err(RuntimeError::DispatchCancelled);
    }
    let context = match &i.caller {
        InferenceCaller::MemoryWork => {
            let parent: Operation = record(db, "operations", &i.parent_operation_id)?;
            if parent.run_id != op.run_id || i.goal.is_some() { return Err(conflict()); }
            return memory_work::stage_live(db, &parent, &i.caller_owner, epoch);
        }
        InferenceCaller::Operation => {
            let parent: Operation = record(db, "operations", &i.parent_operation_id)?;
            if parent.run_id != op.run_id
                || parent.execution_owner.as_ref() != Some(&i.caller_owner)
                || parent.phase != OperationPhase::Running
                || parent.cancel_requested
            {
                return Err(RuntimeError::DispatchCancelled);
            }
            let tool = tool_content::ToolIntent::from_operation(&parent)?;
            crate::execution::ToolExecutionContext {
                run_id: run.id,
                operation_id: parent.id,
                origin: tool.origin().clone(),
            }
        }
        InferenceCaller::Query { context } => context.clone(),
    };
    if !goals::tool_allowed(db, &context)? {
        return Err(RuntimeError::GoalChanged);
    }
    if goals::origin_goal(db, &context.origin)? != i.goal {
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
        json!({"runId":op.run_id,"responseRef":if event_kind == "inference.settled" { s.response_ref.as_ref() } else { None }}),
    )?;
    Ok(())
}
impl Catalog {
    pub fn inference_session(&self, p: &InferenceSessionParams) -> Result<InferenceSessionStatus> {
        let read = |run_id: &str| -> Result<InferenceSessionStatus> {
            let has_requests = self.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM operations WHERE run_id=?1 AND json_extract(body,'$.intent.kind')='inference_request_v1' AND json_extract(body,'$.intent.parentOperationId')=?2)",
                params![run_id, p.parent_operation_id], |row| row.get(0))?;
            Ok(InferenceSessionStatus { has_requests })
        };
        if let Some(op) =
            optional_record::<Operation>(&self.db, "operations", &p.parent_operation_id)?
        {
            if owned(&op, &p.execution_owner).is_ok() {
                return read(&op.run_id);
            }
        }
        self.nested_tools.with_inference_context(
            &p.parent_operation_id,
            &p.execution_owner,
            |context| read(&context.run_id),
        )
    }
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
        let scopes = self.nested_tools.clone();
        if optional_record::<Operation>(&self.db, "operations", &p.parent_operation_id)?
            .is_some_and(|parent| {
                parent.execution_owner.as_ref() == Some(&p.execution_owner)
                    && matches!(p.execution_owner, ExecutorOwner::External { .. })
            })
        {
            { let parent=self.operation(&p.parent_operation_id)?;
              let caller=if memory_work::is_stage(&parent) { InferenceCaller::MemoryWork } else { InferenceCaller::Operation };
              self.admit_inference_for(p, body, caller, false) }
        } else {
            scopes.with_inference_context(&p.parent_operation_id, &p.execution_owner, |context| {
                self.admit_inference_for(
                    p,
                    body,
                    InferenceCaller::Query {
                        context: context.clone(),
                    },
                    false,
                )
            })
        }
    }
    fn admit_inference_for(
        &mut self,
        p: &InferenceAdmitParams,
        body: InferenceBody,
        caller: InferenceCaller,
        native: bool,
    ) -> Result<InferenceStatus> {
        if p.ordinal == 0 || p.binding.purpose.is_empty() || p.binding.configuration_id.is_empty() {
            return Err(conflict());
        }
        let id = format!("inference:{}:{}", p.parent_operation_id, p.ordinal);
        if let Some(op) = optional_record::<Operation>(&self.db, "operations", &id)? {
            if native {
                generation::kernel_owned(&op, self.epoch)?;
                caller_owned(&op, &p.execution_owner)?;
            } else {
                owned(&op, &p.execution_owner)?;
            }
            let i = intent(&op)?;
            if i.binding != p.binding || i.request_ref != body.reference {
                return Err(conflict());
            }
            return self.inference_status_unfenced(&id, &p.execution_owner);
        }
        let (run_id, goal) = match &caller {
            InferenceCaller::MemoryWork => {
                let parent=self.operation(&p.parent_operation_id)?;
                memory_work::stage_live(&self.db,&parent,&p.execution_owner,self.epoch)?;
                memory_work::validate_inference(&self.db,&parent,&p.binding,native)?;
                (parent.run_id,None)
            }
            InferenceCaller::Operation => {
                let parent = self.operation(&p.parent_operation_id)?;
                owned(&parent, &p.execution_owner)?;
                let tool = tool_content::ToolIntent::from_operation(&parent)?;
                (parent.run_id, goals::origin_goal(&self.db, tool.origin())?)
            }
            InferenceCaller::Query { context } => {
                if context.operation_id != p.parent_operation_id {
                    return Err(conflict());
                }
                (context.run_id.clone(), goals::origin_goal(&self.db, &context.origin)?)
            }
        };
        let i = Intent {
            caller_owner: p.execution_owner.clone(),
            caller,
            kind: "inference_request_v1".into(),
            parent_operation_id: p.parent_operation_id.clone(),
            ordinal: p.ordinal,
            binding: p.binding.clone(),
            request_ref: body.reference.clone(),
            goal,
        };
        let op = Operation {
            id: id.clone(),
            run_id,
            epoch: self.epoch,
            revision: 1,
            phase: OperationPhase::Accepted,
            outcome: None,
            effect: Effect::None,
            cancel_requested: false,
            lifetime: Lifetime::Run,
            // A query's caller may detach immediately. Its authenticated External owner
            // independently retains the actual HTTP request and original receipt. This
            // transfers foreground responsibility, never the Run cancellation scope or
            // permission to dispatch after the query closes.
            handed_off: matches!(i.caller, InferenceCaller::Query { .. }),
            executor: Some(
                if native {
                    "inference.model.v1"
                } else if p.binding.executor.local() {
                    "inference.local.v1"
                } else {
                    "inference.http.v1"
                }
                .into(),
            ),
            execution_owner: Some(if native {
                ExecutorOwner::Kernel
            } else {
                p.execution_owner.clone()
            }),
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
        self.inference_status_unfenced(&id, &p.execution_owner)
    }
    pub(super) fn inference_observation(&self, operation: &Operation) -> Result<InferenceStatus> {
        self.inference_status(&operation.id, &intent(operation)?.caller_owner)
    }
    pub fn inference_status(&self, id: &str, owner: &ExecutorOwner) -> Result<InferenceStatus> {
        let mut status = self.inference_status_unfenced(id, owner)?;
        let op = self.operation(id)?;
        if let InferenceCaller::Query { context } = &intent(&op)?.caller {
            if self
                .nested_tools
                .with_inference_context(&context.operation_id, owner, |_| Ok(()))
                .is_err()
            {
                status.live = false;
            }
        }
        Ok(status)
    }
    fn inference_status_unfenced(
        &self,
        id: &str,
        owner: &ExecutorOwner,
    ) -> Result<InferenceStatus> {
        let op = self.operation(id)?;
        caller_owned(&op, owner)?;
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
        let caller = intent(&self.operation(&p.operation_id)?)?.caller;
        let scopes = self.nested_tools.clone();
        match caller {
            InferenceCaller::Operation | InferenceCaller::MemoryWork => self.dispatch_inference_held(p),
            InferenceCaller::Query { context } => {
                scopes.with_inference_context(&context.operation_id, &p.execution_owner, |_| {
                    self.dispatch_inference_held(p)
                })
            }
        }
    }
    fn dispatch_inference_held(&mut self, p: &InferenceOwnerParams) -> Result<InferenceStatus> {
        self.dispatch_inference_executor(p, false)
    }
    fn dispatch_inference_executor(
        &mut self,
        p: &InferenceOwnerParams,
        native: bool,
    ) -> Result<InferenceStatus> {
        let mut op = self.operation(&p.operation_id)?;
        if native {
            generation::kernel_owned(&op, self.epoch)?;
            caller_owned(&op, &p.execution_owner)?;
        } else {
            owned(&op, &p.execution_owner)?;
        }
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
        self.inference_status_unfenced(&p.operation_id, &p.execution_owner)
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
            .is_some_and(|started| Some(started) != p.request_started)
        {
            return Err(conflict());
        }
        if (s.receipt.is_some() && !s.recovered) || s.receipt_pending {
            return self.inference_status(&p.operation_id, &p.execution_owner);
        }
        if (!s.dispatched && p.request_started != Some(false))
            || (p.request_started.is_none() && !i.binding.executor.local()) {
            return Err(conflict());
        }
        let tx = self.db.transaction()?;
        if s.dispatched && i.binding.request_kind == InferenceRequestKind::ModelCompute {
            if !s.accounted {
                if p.request_started != Some(false) {
                    goals::measured(&tx, i.goal.as_ref(), &UsageReceipt::default())?;
                } else {
                    goals::not_dispatched(&tx, i.goal.as_ref())?;
                }
                s.accounted = true;
            } else if p.request_started == Some(false)
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
            request_started: p.request_started,
            provider_completed: false,
            local_executor_stopped: true,
            usage: InferenceUsage::default(),
            http_status: None,
            problem: Some(InferenceProblem::ReceiptPending),
        });
        op.phase = OperationPhase::Terminal;
        op.outcome = Some(if p.request_started != Some(false) {
            Outcome::Indeterminate
        } else if op.cancel_requested {
            Outcome::Cancelled
        } else {
            Outcome::Failed
        });
        op.effect = if p.request_started != Some(false) {
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
        self.settle_inference_executor(p, body, false)
    }
    fn settle_inference_executor(
        &mut self,
        p: &InferenceSettleParams,
        body: InferenceBody,
        native: bool,
    ) -> Result<InferenceStatus> {
        let mut op = self.operation(&p.operation_id)?;
        if native {
            generation::kernel_owned(&op, self.epoch)?;
            caller_owned(&op, &p.execution_owner)?;
        } else {
            owned(&op, &p.execution_owner)?;
        }
        let i = intent(&op)?;
        let mut s = state(&op)?;
        if s.response_ref.as_ref() == Some(&body.reference)
            && s.receipt.as_ref() == Some(&p.receipt)
        {
            return self.inference_status(&p.operation_id, &p.execution_owner);
        }
        if !p.receipt.local_executor_stopped
            || (!native && !i.binding.executor.local() && p.receipt.request_started.is_none())
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
        usage: s.checkpoint_usage.clone(),
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
    let mut query = tx.prepare("SELECT body FROM operations WHERE json_extract(body,'$.intent.kind')='inference_request_v1' AND ((?1 IS NOT NULL AND json_extract(body,'$.intent.parentOperationId')=?1) OR (?2 IS NOT NULL AND run_id=?2))")?;
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
