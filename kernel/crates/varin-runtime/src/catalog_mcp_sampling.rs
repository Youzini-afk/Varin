//! Sampling generation facts live in the existing Operation ledger, under the original interaction.
use super::*;
use crate::execution::RequestSnapshot;
use crate::mcp_sampling::*;
use crate::providers::auth::CredentialScope;
use crate::types::ModelSessionConfiguration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationIntent {
    pub kind: String,
    pub interaction_id: String,
    pub parent_operation_id: String,
    pub reviewed_ref: Value,
    pub configuration_ref: Value,
    pub credential_scope: Option<CredentialScope>,
    pub goal: Option<goals::FrozenGoal>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationState {
    pub dispatch: String,
    pub model: Option<SamplingModel>,
    pub usage: SamplingUsage,
    pub problem: Option<String>,
    pub snapshot_ref: Option<Value>,
    pub output_ref: Option<Value>,
}
pub fn is_generation(op: &Operation) -> bool {
    op.intent["kind"] == "mcp_sampling_generation_v1"
}
pub fn intent(op: &Operation) -> Result<GenerationIntent> {
    if !is_generation(op) {
        return Err(conflict());
    }
    Ok(serde_json::from_value(op.intent.clone())?)
}
pub fn state(op: &Operation) -> Result<GenerationState> {
    Ok(serde_json::from_value(
        op.result.as_ref().ok_or_else(conflict)?.control()?.clone(),
    )?)
}
pub fn projection(op: &Operation) -> Result<McpSamplingGeneration> {
    let s = state(op)?;
    Ok(McpSamplingGeneration {
        operation_id: op.id.clone(),
        phase: op.phase,
        outcome: op.outcome,
        cancel_requested: op.cancel_requested,
        dispatch: s.dispatch,
        model: s.model,
        usage: s.usage,
        problem: s.problem,
    })
}
pub(super) fn bodies(
    content: &crate::content::ContentStore,
    op: &Operation,
) -> Result<McpSamplingBodies> {
    let i = intent(op)?;
    let s = state(op)?;
    let output = s.output_ref.as_ref().map(|r| content.load(r)).transpose()?;
    Ok(McpSamplingBodies {
        edited_request: Some(content.load(&i.reviewed_ref)?),
        output: output
            .as_ref()
            .and_then(|o| o.get("response"))
            .filter(|v| !v.is_null())
            .cloned(),
        provider_output: output
            .as_ref()
            .and_then(|o| o.get("providerOutput"))
            .cloned(),
        receipt: output
            .as_ref()
            .and_then(|o| o.get("receipt"))
            .filter(|v| !v.is_null())
            .cloned(),
        snapshot: s
            .snapshot_ref
            .as_ref()
            .map(|r| content.load(r))
            .transpose()?,
    })
}
pub struct SamplingPreparation {
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct SamplingAdmission {
    reviewed_ref: Value,
    configuration_ref: Value,
    _preparation: SamplingPreparation,
}
pub struct SamplingBody {
    reference: Value,
    _preparation: SamplingPreparation,
}
impl SamplingPreparation {
    pub fn admission(
        self,
        request: Value,
        configuration: &ModelSessionConfiguration,
    ) -> Result<SamplingAdmission> {
        Ok(SamplingAdmission {
            reviewed_ref: self.content.save(&request)?,
            configuration_ref: self.content.save(&serde_json::to_value(configuration)?)?,
            _preparation: self,
        })
    }
    pub fn snapshot(self, snapshot: &RequestSnapshot) -> Result<SamplingBody> {
        Ok(SamplingBody {
            reference: self.content.save_snapshot(snapshot)?,
            _preparation: self,
        })
    }
    pub fn output(
        self,
        output: &SamplingOutput,
        receipt: Option<&SamplingReceipt>,
        response: Option<&Value>,
    ) -> Result<SamplingBody> {
        Ok(SamplingBody {
            reference: self
                .content
                .save(&json!({"providerOutput":output,"receipt":receipt,"response":response}))?,
            _preparation: self,
        })
    }
}
pub struct SamplingRead {
    pub operation: Operation,
    original_ref: Value,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct SamplingWork {
    pub original_request: Value,
    pub output: SamplingOutput,
    pub operation: Operation,
    pub intent: GenerationIntent,
    pub request: Value,
    pub configuration: ModelSessionConfiguration,
}
impl SamplingRead {
    pub fn load(self) -> Result<SamplingWork> {
        let i = intent(&self.operation)?;
        let output = state(&self.operation)?
            .output_ref
            .as_ref()
            .map(|reference| {
                self.content
                    .load(reference)
                    .and_then(|value| Ok(serde_json::from_value(value["providerOutput"].clone())?))
            })
            .transpose()?
            .unwrap_or_default();
        Ok(SamplingWork {
            output,
            original_request: self.content.load(&self.original_ref)?["request"].clone(),
            request: self.content.load(&i.reviewed_ref)?,
            configuration: serde_json::from_value(self.content.load(&i.configuration_ref)?)?,
            intent: i,
            operation: self.operation,
        })
    }
}
fn publish_operation(
    tx: &Transaction<'_>,
    op: &mut Operation,
    s: GenerationState,
    kind: &str,
) -> Result<()> {
    op.result = Some(OperationResultMetadata::Control {
        value: serde_json::to_value(s)?,
    });
    op.revision += 1;
    put(tx, "operations", &op.id, op)?;
    event(tx, &op.id, op.revision, kind, json!({"runId":op.run_id}))?;
    Ok(())
}
fn original_generation(
    db: &Connection,
    operation: &str,
    epoch: u64,
) -> Result<(Operation, Metadata, GenerationState)> {
    let op: Operation = record(db, "operations", operation)?;
    let i = intent(&op)?;
    let m: Metadata = record(db, "mcp_interactions", &i.interaction_id)?;
    if op.epoch != epoch
        || m.record
            .sampling
            .as_ref()
            .and_then(|s| s.generation_operation_id.as_deref())
            != Some(operation)
        || m.record.binding.operation_id != i.parent_operation_id
    {
        return Err(conflict());
    }
    let s = state(&op)?;
    Ok((op, m, s))
}
impl Catalog {
    pub fn prepare_sampling_content(&self) -> SamplingPreparation {
        SamplingPreparation {
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        }
    }
    pub fn admit_mcp_sampling(
        &mut self,
        operation_id: &str,
        id: &str,
        revision: u64,
        admission: SamplingAdmission,
        scope: Option<CredentialScope>,
    ) -> Result<McpInteractionRecord> {
        let mut m: Metadata = record(&self.db, "mcp_interactions", id)?;
        if m.record.binding.operation_id != operation_id || m.record.mode != Mode::Sampling {
            return Err(conflict());
        }
        original_live(&self.db, &m, self.epoch)?;
        let generation_id = format!("{id}:generation:{revision}");
        let sampling = m.record.sampling.as_ref().ok_or_else(conflict)?;
        if let Some(previous) = &sampling.generation_operation_id {
            let op = self.operation(previous)?;
            let old = intent(&op)?;
            if op.id == generation_id
                && old.reviewed_ref == admission.reviewed_ref
                && old.configuration_ref == admission.configuration_ref
                && old.credential_scope == scope
            {
                return Ok(m.record);
            }
            if state(&op)?.dispatch != "not_started" || op.phase != OperationPhase::Terminal {
                return Err(conflict());
            }
        }
        if sampling.review != "request"
            || m.record.revision != revision
            || m.record.choice.is_some()
        {
            return Err(conflict());
        }
        // The request being approved belongs to this original inbound request. Content validation
        // and provider preparation run outside this short transaction on the operation worker.
        let task = matches!(
            m.record.binding.source,
            McpInteractionSource::ServerRequest {
                relation: McpInteractionRelation::Task { .. },
                ..
            }
        );
        let parent: Operation = record(&self.db, "operations", operation_id)?;
        let original = tool_content::ToolIntent::from_operation(&parent)?;
        let goal = goals::origin_goal(&self.db, original.origin())?;
        let i = GenerationIntent {
            kind: "mcp_sampling_generation_v1".into(),
            interaction_id: id.into(),
            parent_operation_id: operation_id.into(),
            reviewed_ref: admission.reviewed_ref,
            configuration_ref: admission.configuration_ref,
            credential_scope: scope,
            goal,
        };
        let s = GenerationState {
            dispatch: "not_started".into(),
            model: None,
            usage: SamplingUsage::default(),
            problem: None,
            snapshot_ref: None,
            output_ref: None,
        };
        let op = Operation {
            host_job: None,
            mcp_resource_subscription: None,
            managed_process: None,
            external_receipt: None,
            call_completion: None,
            id: generation_id.clone(),
            run_id: m.record.run_id.clone(),
            epoch: self.epoch,
            revision: 1,
            phase: OperationPhase::Accepted,
            outcome: None,
            effect: Effect::None,
            cancel_requested: false,
            lifetime: if task {
                Lifetime::Thread
            } else {
                Lifetime::Run
            },
            handed_off: task,
            executor: Some("mcp-sampling.v1".into()),
            execution_owner: Some(ExecutorOwner::Kernel),
            waiting_on: None,
            intent: serde_json::to_value(i)?,
            result: Some(OperationResultMetadata::Control {
                value: serde_json::to_value(s)?,
            }),
        };
        m.record.sampling.as_mut().unwrap().generation_operation_id = Some(generation_id.clone());
        m.record.problem = None;
        let tx = self.db.transaction()?;
        tx.execute(
            "INSERT INTO operations(id,run_id,body) VALUES(?1,?2,?3)",
            params![generation_id, op.run_id, encode(&op)?],
        )?;
        event(
            &tx,
            &generation_id,
            1,
            "mcp.sampling.accepted",
            json!({"interactionId":id,"parentOperationId":operation_id}),
        )?;
        publish(&tx, &mut m, "mcp.sampling.request_reviewed")?;
        tx.commit()?;
        Ok(m.record)
    }
    pub fn capture_sampling_generation(&self, id: &str) -> Result<SamplingRead> {
        let op = self.operation(id)?;
        intent(&op)?;
        let m: Metadata = record(&self.db, "mcp_interactions", &intent(&op)?.interaction_id)?;
        Ok(SamplingRead {
            original_ref: m.request_ref,
            operation: op,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn sampling_generation_live(&self, id: &str) -> Result<bool> {
        let (op, m, _) = original_generation(&self.db, id, self.epoch)?;
        Ok(op.phase != OperationPhase::Terminal
            && !op.cancel_requested
            && original_live(&self.db, &m, self.epoch).is_ok())
    }
    pub fn prepare_mcp_sampling(
        &mut self,
        id: &str,
        model: SamplingModel,
        body: SamplingBody,
    ) -> Result<()> {
        let (mut op, mut m, mut s) = original_generation(&self.db, id, self.epoch)?;
        original_live(&self.db, &m, self.epoch)?;
        if op.cancel_requested
            || s.dispatch != "not_started"
            || op.phase == OperationPhase::Terminal
        {
            return Err(conflict());
        }
        s.snapshot_ref = Some(body.reference);
        s.model = Some(model);
        op.phase = OperationPhase::Preparing;
        let tx = self.db.transaction()?;
        publish_operation(&tx, &mut op, s, "mcp.sampling.prepared")?;
        publish(&tx, &mut m, "mcp.sampling.prepared")?;
        tx.commit()?;
        Ok(())
    }
    pub fn dispatch_mcp_sampling(&mut self, id: &str) -> Result<()> {
        let (mut op, mut m, mut s) = original_generation(&self.db, id, self.epoch)?;
        original_live(&self.db, &m, self.epoch)?;
        if op.cancel_requested
            || s.dispatch != "not_started"
            || s.snapshot_ref.is_none()
            || op.phase != OperationPhase::Preparing
        {
            return Err(conflict());
        }
        op.phase = OperationPhase::Running;
        op.effect = Effect::Dispatched;
        s.dispatch = "started".into();
        let goal = intent(&op)?.goal;
        let tx = self.db.transaction()?;
        let goal = goals::check_dispatch(&tx, &op.run_id, goal.as_ref())?;
        if let Some(goal) = &goal {
            goals::dispatched(&tx, goal)?;
        }
        publish_operation(&tx, &mut op, s, "mcp.sampling.dispatched")?;
        publish(&tx, &mut m, "mcp.sampling.dispatched")?;
        tx.commit()?;
        Ok(())
    }
    pub fn checkpoint_mcp_sampling(
        &mut self,
        id: &str,
        body: SamplingBody,
        usage: &crate::execution::UsageReceipt,
    ) -> Result<()> {
        let (mut op, mut m, mut s) = original_generation(&self.db, id, self.epoch)?;
        if s.dispatch != "started" || op.phase != OperationPhase::Running {
            return Err(conflict());
        }
        s.output_ref = Some(body.reference);
        s.usage = SamplingUsage::from(usage);
        let tx = self.db.transaction()?;
        publish_operation(&tx, &mut op, s, "mcp.sampling.progress")?;
        publish(&tx, &mut m, "mcp.sampling.progress")?;
        tx.commit()?;
        Ok(())
    }
    pub fn settle_mcp_sampling(
        &mut self,
        id: &str,
        body: SamplingBody,
        receipt: &SamplingReceipt,
    ) -> Result<()> {
        let (mut op, mut m, mut s) = original_generation(&self.db, id, self.epoch)?;
        if op.phase == OperationPhase::Terminal {
            if s.output_ref.as_ref() == Some(&body.reference) {
                return Ok(());
            }
            return Err(conflict());
        }
        let cancelled = op.cancel_requested || original_live(&self.db, &m, self.epoch).is_err();
        s.output_ref = Some(body.reference);
        s.usage = SamplingUsage::from(&receipt.usage);
        s.problem = receipt.failure.as_ref().map(|f| f.code.clone());
        let dispatched = s.dispatch != "not_started";
        s.dispatch = if !dispatched {
            "not_started"
        } else if receipt.provider_completed {
            "completed"
        } else {
            "interrupted"
        }
        .into();
        op.phase = OperationPhase::Terminal;
        op.outcome = Some(if !dispatched {
            if cancelled {
                Outcome::Cancelled
            } else {
                Outcome::Failed
            }
        } else if !receipt.provider_completed {
            Outcome::Indeterminate
        } else if cancelled {
            Outcome::Cancelled
        } else if receipt.usable {
            Outcome::Succeeded
        } else {
            Outcome::Failed
        });
        op.effect = if !dispatched {
            Effect::None
        } else if receipt.provider_completed {
            Effect::Confirmed
        } else {
            Effect::Unknown
        };
        m.record.problem = s.problem.clone();
        m.record.sampling.as_mut().unwrap().review = if !dispatched && !cancelled {
            "request"
        } else if receipt.usable && !cancelled {
            "output"
        } else {
            "closed"
        }
        .into();
        let goal = intent(&op)?.goal;
        let tx = self.db.transaction()?;
        if dispatched {
            goals::measured(&tx, goal.as_ref(), &receipt.usage)?;
        }
        if receipt.local_executor_stopped { super::execution_persistence::record_kernel_executor_stopped(&tx, &op, self.epoch)?; }
        publish_operation(&tx, &mut op, s, "mcp.sampling.settled")?;
        publish(&tx, &mut m, "mcp.sampling.generated")?;
        tx.commit()?;
        Ok(())
    }
    pub fn review_mcp_sampling(
        &mut self,
        operation_id: &str,
        id: &str,
        revision: u64,
        action: &str,
        output: bool,
    ) -> Result<McpInteractionRecord> {
        let mut m: Metadata = record(&self.db, "mcp_interactions", id)?;
        if m.record.binding.operation_id != operation_id || m.record.mode != Mode::Sampling {
            return Err(conflict());
        }
        let choice = match action {
            "accept" if output => Choice::Accept,
            "decline" => Choice::Decline,
            "cancel" => Choice::Cancel,
            _ => return Err(conflict()),
        };
        if m.record.choice == Some(choice) {
            return Ok(m.record);
        }
        original_live(&self.db, &m, self.epoch)?;
        if m.record.revision != revision || m.record.choice.is_some() {
            return Err(conflict());
        }
        let sampling = m.record.sampling.as_ref().ok_or_else(conflict)?;
        if output && sampling.review != "output" || !output && sampling.review != "request" {
            return Err(conflict());
        }
        if output && choice == Choice::Accept {
            let op = self.operation(
                sampling
                    .generation_operation_id
                    .as_deref()
                    .ok_or_else(conflict)?,
            )?;
            if op.phase != OperationPhase::Terminal
                || op.outcome != Some(Outcome::Succeeded)
                || state(&op)?.dispatch != "completed"
            {
                return Err(conflict());
            }
        }
        m.record.choice = Some(choice);
        m.record.sampling.as_mut().unwrap().review = "closed".into();
        let tx = self.db.transaction()?;
        if choice != Choice::Accept {
            cancel_generation(&tx, &m)?;
        }
        publish(&tx, &mut m, "mcp.sampling.output_reviewed")?;
        tx.commit()?;
        Ok(m.record)
    }
}
pub(super) fn cancel_generation(tx: &Transaction<'_>, m: &Metadata) -> Result<()> {
    if let Some(id) = m
        .record
        .sampling
        .as_ref()
        .and_then(|s| s.generation_operation_id.as_ref())
    {
        let mut op: Operation = record(tx, "operations", id)?;
        if op.phase != OperationPhase::Terminal && !op.cancel_requested {
            op.cancel_requested = true;
            op.revision += 1;
            put(tx, "operations", id, &op)?;
            event(
                tx,
                id,
                op.revision,
                "operation.cancel_requested",
                Value::Null,
            )?;
        }
    }
    Ok(())
}
pub(crate) fn recover(tx: &Transaction<'_>, op: &mut Operation) -> Result<bool> {
    if !is_generation(op) {
        return Ok(false);
    }
    if op.phase == OperationPhase::Terminal {
        return Ok(true);
    }
    let mut s = state(op)?;
    let dispatched = s.dispatch != "not_started";
    if dispatched {
        let goal = intent(op)?.goal;
        goals::measured(
            tx,
            goal.as_ref(),
            &crate::execution::UsageReceipt::from(&s.usage),
        )?;
        s.dispatch = "interrupted".into();
    }
    s.problem = Some("mcp_sampling_connection_lost".into());
    op.phase = OperationPhase::Terminal;
    op.outcome = Some(if dispatched {
        Outcome::Indeterminate
    } else {
        Outcome::Cancelled
    });
    op.effect = if dispatched {
        Effect::Unknown
    } else {
        Effect::None
    };
    publish_operation(tx, op, s, "mcp.sampling.recovered")?;
    Ok(true)
}

pub(crate) fn hydrate_operation(
    op: &mut Operation,
    content: &crate::content::ContentStore,
) -> Result<()> {
    if !is_generation(op) {
        return Ok(());
    }
    let i = intent(op)?;
    let bodies = bodies(content, op)?;
    let intent = op.intent.as_object_mut().ok_or_else(conflict)?;
    intent.remove("reviewed_ref");
    intent.remove("configuration_ref");
    intent.insert(
        "request".into(),
        bodies.edited_request.unwrap_or(Value::Null),
    );
    intent.insert("configuration".into(), content.load(&i.configuration_ref)?);
    if let Some(OperationResultMetadata::Control { value }) = &mut op.result {
        let state = value.as_object_mut().ok_or_else(conflict)?;
        state.remove("snapshot_ref");
        state.remove("output_ref");
        state.insert("snapshot".into(), bodies.snapshot.unwrap_or(Value::Null));
        state.insert(
            "providerOutput".into(),
            bodies.provider_output.unwrap_or(Value::Null),
        );
        state.insert("receipt".into(), bodies.receipt.unwrap_or(Value::Null));
        state.insert("output".into(), bodies.output.unwrap_or(Value::Null));
    }
    Ok(())
}
