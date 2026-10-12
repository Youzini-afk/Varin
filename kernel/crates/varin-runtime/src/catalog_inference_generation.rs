//! Native generations use the original inference ledger. Caller delegation is admission
//! evidence; the Kernel is the executor and only its current epoch may write receipts.
use super::*;
use crate::execution::{ProviderEvent, ProviderItem, RequestSnapshot};
use crate::types::ModelSessionConfiguration;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InferenceGenerateParams {
    pub parent_operation_id: String,
    pub caller_owner: ExecutorOwner,
    pub ordinal: u64,
    pub configuration: ModelSessionConfiguration,
    pub credential_scope: CredentialScope,
    pub purpose: String,
    pub system_prompt: String,
    pub user: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GenerationOutput {
    pub events: Vec<ProviderEvent>,
    pub items: Vec<ProviderItem>,
    pub usage: UsageReceipt,
    #[serde(rename = "finishReason")]
    pub finish_reason: Option<crate::execution::FinishReason>,
}
impl From<&UsageReceipt> for InferenceUsage {
    fn from(value: &UsageReceipt) -> Self {
        Self {
            measurement: value.measurement,
            input_tokens: value.input_tokens,
            output_tokens: value.output_tokens,
            cached_input_tokens: value.cached_input_tokens,
            cache_write_tokens: value.cache_write_tokens,
            reasoning_tokens: value.reasoning_tokens,
            pricing_version: value.pricing_version.clone(),
        }
    }
}
pub(super) fn kernel_owned(op: &Operation, epoch: u64) -> Result<()> {
    if op.execution_owner != Some(ExecutorOwner::Kernel)
        || op.executor.as_deref() != Some("inference.model.v1")
        || op.epoch != epoch
    {
        return Err(conflict());
    }
    Ok(())
}
pub struct GenerationRead {
    pub operation: Operation,
    pub caller_owner: ExecutorOwner,
    pub goal: Option<goals::FrozenGoal>,
    content: crate::content::ContentStore,
    request_ref: Value,
    _publication: crate::content::ContentPublication,
}
impl GenerationRead {
    pub fn load(&self) -> Result<InferenceGenerateParams> {
        Ok(serde_json::from_value(
            self.content.load(&self.request_ref)?,
        )?)
    }
}
impl Catalog {
    pub fn admit_inference_generation(
        &mut self,
        p: &InferenceGenerateParams,
        body: InferenceBody,
    ) -> Result<InferenceStatus> {
        if !matches!(p.purpose.as_str(), "explore" | "memory-organizer") || p.system_prompt.trim().is_empty() || p.user.trim().is_empty() {
            return Err(RuntimeError::Invalid(
                "invalid tool-free inference request".into(),
            ));
        }
        let configuration_id = crate::model_session::connection_identity_with_scope(
            &p.configuration,
            &p.credential_scope,
        )
        .map_err(|e| RuntimeError::Invalid(e.to_string()))?;
        let params = InferenceAdmitParams {
            parent_operation_id: p.parent_operation_id.clone(),
            execution_owner: p.caller_owner.clone(),
            ordinal: p.ordinal,
            binding: InferenceBinding {
                request_kind: InferenceRequestKind::ModelCompute,
                purpose: p.purpose.clone(),
                provider_id: p.configuration.provider_id.clone().ok_or_else(conflict)?,
                model_id: p.configuration.model.clone(),
                configuration_id,
                executor: InferenceExecutor::Http {
                    api: p.configuration.provider_family.clone(), endpoint: p.configuration.endpoint.clone(),
                    credential_scope: p.credential_scope.clone(),
                },
            },
            request: Value::Null,
        };
        if p.purpose == "memory-organizer" {
            memory_work::generation_parent(&self.db, &p.parent_operation_id, &p.caller_owner, self.epoch)?.ok_or_else(conflict)?;
            return self.admit_inference_for(&params,body,InferenceCaller::MemoryWork,true);
        }
        let scopes = self.nested_tools.clone();
        scopes.with_inference_context(&p.parent_operation_id, &p.caller_owner, |context| {
            self.admit_inference_for(
                &params,
                body,
                InferenceCaller::Query {
                    context: context.clone(),
                },
                true,
            )
        })
    }
    pub fn capture_inference_generation(&self, id: &str) -> Result<GenerationRead> {
        let operation = self.operation(id)?;
        kernel_owned(&operation, self.epoch)?;
        let i = intent(&operation)?;
        Ok(GenerationRead {
            operation,
            caller_owner: i.caller_owner,
            goal: i.goal,
            content: self.content.clone(),
            request_ref: i.request_ref,
            _publication: self.content.begin_publication(),
        })
    }
    pub fn inference_generation_live(&self, id: &str) -> Result<bool> {
        let op = self.operation(id)?;
        kernel_owned(&op, self.epoch)?;
        Ok(self.inference_status(id, &intent(&op)?.caller_owner)?.live)
    }
    pub fn prepare_inference_generation(&mut self, id: &str, body: InferenceBody) -> Result<()> {
        let mut op = self.operation(id)?;
        kernel_owned(&op, self.epoch)?;
        let mut s = state(&op)?;
        if s.dispatched || s.recovered || !self.inference_generation_live(id)? {
            return Err(conflict());
        }
        s.response_ref = Some(body.reference);
        op.phase = OperationPhase::Preparing;
        let tx = self.db.transaction()?;
        publish(&tx, &mut op, &s, "inference.prepared")?;
        tx.commit()?;
        Ok(())
    }
    pub fn dispatch_inference_generation(&mut self, id: &str) -> Result<InferenceStatus> {
        let op = self.operation(id)?;
        kernel_owned(&op, self.epoch)?;
        let i = intent(&op)?;
        if matches!(i.caller, InferenceCaller::MemoryWork) {
            return self.dispatch_inference_executor(&InferenceOwnerParams {operation_id:id.into(),execution_owner:i.caller_owner},true);
        }
        let InferenceCaller::Query { context } = i.caller else {
            return Err(conflict());
        };
        let scopes = self.nested_tools.clone();
        scopes.with_inference_context(&context.operation_id, &i.caller_owner, |_| {
            self.dispatch_inference_executor(
                &InferenceOwnerParams {
                    operation_id: id.into(),
                    execution_owner: i.caller_owner.clone(),
                },
                true,
            )
        })
    }
    pub fn checkpoint_inference_generation(
        &mut self,
        id: &str,
        body: InferenceBody,
        output: &GenerationOutput,
    ) -> Result<()> {
        let mut op = self.operation(id)?;
        kernel_owned(&op, self.epoch)?;
        let mut s = state(&op)?;
        if !s.dispatched || s.recovered || op.phase == OperationPhase::Terminal {
            return Err(conflict());
        }
        // Already observed provider evidence remains durable after cancellation intent.
        s.response_ref = Some(body.reference);
        s.checkpoint_usage = InferenceUsage::from(&output.usage);
        let tx = self.db.transaction()?;
        publish(&tx, &mut op, &s, "inference.checkpointed")?;
        tx.commit()?;
        Ok(())
    }
    pub fn settle_inference_generation(
        &mut self,
        id: &str,
        body: InferenceBody,
        receipt: InferenceReceipt,
    ) -> Result<InferenceStatus> {
        let op = self.operation(id)?;
        kernel_owned(&op, self.epoch)?;
        let p = InferenceSettleParams {
            operation_id: id.into(),
            execution_owner: intent(&op)?.caller_owner,
            receipt,
            response: Value::Null,
        };
        self.settle_inference_executor(&p, body, true)
    }
}
/// Request and complete provider evidence remain one ContentStore body, outside Catalog.
pub fn generation_body(
    snapshot: Option<&RequestSnapshot>,
    output: &GenerationOutput,
    receipt: Option<&InferenceReceipt>,
    failure: Option<&crate::execution::ModelFailure>,
    text: Option<&str>,
) -> Value {
    json!({"snapshot": snapshot, "providerOutput": output, "receipt": receipt, "failure": failure, "text": text})
}
