//! Resume committed exchanges without sending their saved transport requests again.
//! Capture references under Catalog ownership, hydrate on the Run worker, then publish conditionally.
use super::*;
use crate::execution::*;
use std::collections::{BTreeMap, BTreeSet};

pub struct ExecutionRecovery {
    pub event: PolicyEvent,
    pub pending: Option<(RequestSnapshot, Vec<ToolCall>)>,
    pub receipts: BTreeMap<String, ToolResult>,
    pub decision: Option<PolicyDecision>,
}

pub(super) struct ExecutionPreparation {
    run: Run,
    binding: RequestBinding,
    policy: PolicyIdentity,
    policy_state: Value,
    completed_model_steps: u64,
    database: std::path::PathBuf,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl ExecutionPreparation {
    fn hydrate_history(
        &self,
        cancel: Option<&CancellationToken>,
    ) -> Result<Option<Vec<HistoryItem>>> {
        // History rows are immutable after publication. Traverse the captured ancestry through a
        // separate read-only connection, so long history cannot occupy the Catalog control lock.
        let mut database = Connection::open_with_flags(
            &self.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let snapshot = database.transaction()?;
        let mut cursor = self.binding.history_range.leaf_id.clone();
        let mut metadata = Vec::new();
        let mut visited = BTreeSet::new();
        while let Some(key) = cursor {
            if cancel.is_some_and(CancellationToken::is_cancelled) {
                return Ok(None);
            }
            if !visited.insert(key.clone()) {
                return Err(RuntimeError::Invalid(
                    "history ancestry contains a cycle".into(),
                ));
            }
            let (thread_id, parent, raw): (String, Option<String>, String) = snapshot.query_row(
                "SELECT thread_id,parent,body FROM history WHERE id=?1",
                [&key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            let item: HistoryItem = serde_json::from_str(&raw)?;
            if item.id != key
                || item.thread_id != thread_id
                || item.parent != parent
                || thread_id != self.run.thread_id
            {
                return Err(RuntimeError::Invalid(
                    "history metadata does not match its row".into(),
                ));
            }
            cursor = parent;
            metadata.push(item);
        }
        drop(snapshot);
        metadata.reverse();
        if self
            .binding
            .history_range
            .ancestor_id
            .as_ref()
            .is_some_and(|id| !metadata.iter().any(|item| &item.id == id))
        {
            return Err(RuntimeError::Conflict(
                "request ancestor is not on the active branch".into(),
            ));
        }
        let mut history = Vec::with_capacity(metadata.len());
        for item in metadata {
            if cancel.is_some_and(CancellationToken::is_cancelled) {
                return Ok(None);
            }
            let mut item = item;
            let loaded = self
                .content
                .load_history_payload_cancellable(&item.content, &|| {
                    cancel.is_some_and(CancellationToken::is_cancelled)
                });
            let (body, provider) = match loaded {
                Err(RuntimeError::DispatchCancelled) => return Ok(None),
                other => other?,
            };
            item.content = body;
            item.provider = provider;
            history.push(item);
        }
        Ok(Some(history))
    }
    fn input(&self, history: Vec<HistoryItem>) -> Result<ExecutionInput> {
        let database = Connection::open_with_flags(
            &self.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let saved: Option<(String, String)> = database
            .query_row(
                "SELECT identity,state_ref FROM policy_checkpoints WHERE run_id=?1",
                [&self.run.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let policy_state = if let Some((identity, state)) = saved {
            if serde_json::from_str::<PolicyIdentity>(&identity)? != self.policy {
                return Err(RuntimeError::Conflict(
                    "policy checkpoint belongs to another implementation version".into(),
                ));
            }
            self.content.load(&serde_json::from_str(&state)?)?
        } else {
            self.policy_state.clone()
        };
        let mut items = Vec::new();
        for item in history {
            items.extend(super::execution_persistence::history_input_items(
                &item.id,
                item.source,
                &item.content,
            )?);
        }
        Ok(ExecutionInput {
            run_id: self.run.id.clone(),
            owner_generation: self.run.epoch,
            binding: self.binding.clone(),
            history: items,
            policy_state,
            completed_model_steps: self.completed_model_steps,
        })
    }
    pub(super) fn load(self) -> Result<ExecutionInput> {
        let history = self
            .hydrate_history(None)?
            .expect("uncancelled history read");
        self.input(history)
    }
}

struct ModelRecoveryPreparation {
    active_model: Option<super::models::RunModelSelection>,
    active_tool_composition: Option<Value>,
    step: ModelStep,
    output: Value,
    calls: Vec<ToolCall>,
    receipts: BTreeMap<String, ToolResult>,
    committed: usize,
    decision: Option<PolicyDecision>,
}
enum RecoveryKind {
    None,
    Policy,
    Checkpoint(super::policy_checkpoint::PolicyCheckpointMetadata),
    Undispatched {
        step: ModelStep,
        checkpoint: Option<super::policy_checkpoint::PolicyCheckpointMetadata>,
    },
    Model {
        step: ModelStep,
        policy: PolicyIdentity,
    },
}
pub(crate) struct RecoveryPreparation {
    execution: ExecutionPreparation,
    cursor: u64,
    kind: RecoveryKind,
    cancellation_requires_recovery: bool,
    goal: Option<goals::FrozenGoal>,
    launch: Option<super::launch_content::LaunchMetadata>,
}
pub(crate) struct PreparedRecovery {
    preparation: RecoveryPreparation,
    input: ExecutionInput,
    recovery: Option<ExecutionRecovery>,
}
pub(crate) struct PreparedLaunch {
    pub input: ExecutionInput,
    pub recovery: Option<ExecutionRecovery>,
    pub cancel_requested: bool,
}
#[derive(Clone)]
pub(crate) struct PreparationIdentity {
    run: Run,
    head: Option<String>,
    cursor: u64,
    goal: Option<goals::FrozenGoal>,
    launch: Option<super::launch_content::LaunchMetadata>,
}

/// Cancellation restores already-owned pairing only. It never assembles a new RunStart or
/// acquires current provider, tool or Source permissions for the interrupted execution.
pub(crate) struct CancellationRecoveryPreparation {
    identity: PreparationIdentity,
    step: ModelStep,
    policy: PolicyIdentity,
    database: std::path::PathBuf,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
    bodies: super::execution_persistence::ExecutionBodyPreparation,
}
pub(crate) struct PreparedCancellationRecovery {
    recovered: PreparedRecovery,
    record: ExecutionRecord,
    bodies: super::execution_persistence::PreparedExecutionBodies,
}
impl CancellationRecoveryPreparation {
    pub(crate) fn identity(&self) -> &PreparationIdentity {
        &self.identity
    }
    pub(crate) fn load(self) -> Result<PreparedCancellationRecovery> {
        let snapshot = self.content.load_snapshot(&self.step.request)?;
        let mut binding = snapshot.view.binding;
        binding.history_range.leaf_id = self.identity.head.clone();
        let preparation = RecoveryPreparation {
            execution: ExecutionPreparation {
                run: self.identity.run,
                binding,
                policy: self.policy.clone(),
                policy_state: Value::Null,
                completed_model_steps: 0,
                database: self.database,
                content: self.content,
                _publication: self.publication,
            },
            cursor: self.identity.cursor,
            kind: RecoveryKind::Model { step: self.step, policy: self.policy },
            cancellation_requires_recovery: true,
            goal: self.identity.goal,
            launch: self.identity.launch,
        };
        // The normal recovery reader validates the saved model output, exact ancestry and
        // canonical receipts. No policy decision or executor is invoked by this reader.
        let recovered = preparation.load(&CancellationToken::default())?
            .ok_or_else(|| RuntimeError::Invalid("cancelled exchange read was abandoned".into()))?;
        let recovery = recovered.recovery.as_ref()
            .ok_or_else(|| RuntimeError::Conflict("cancelled exchange boundary changed".into()))?;
        let (snapshot, calls) = recovery.pending.as_ref()
            .ok_or_else(|| RuntimeError::Conflict("cancelled exchange is already paired".into()))?;
        let record = ExecutionRecord::ToolBatchCommitted {
            request_id: snapshot.view.request_id.clone(),
            results: calls.iter().map(|call| recovery.receipts.get(&call.call_id).cloned()
                .unwrap_or_else(|| ToolResult {
                    request_id: snapshot.view.request_id.clone(),
                    call_id: call.call_id.clone(),
                    completion: ToolCompletion::cancelled(),
                })).collect(),
        };
        let bodies = self.bodies.write(&record)?;
        Ok(PreparedCancellationRecovery { recovered, record, bodies })
    }
}

fn reconciled_terminal_stop(op: &Operation) -> bool {
    op.phase == OperationPhase::Terminal
        && op.external_receipt.as_ref().is_some_and(|receipt| {
            receipt.executor_stopped
                && op.outcome == Some(receipt.outcome)
                && op.effect == receipt.effect
                && op.result.as_ref() == Some(&OperationResultMetadata::Content {
                    reference: receipt.result_ref.clone(),
                })
        })
}

impl RecoveryPreparation {
    pub(crate) fn identity(&self) -> PreparationIdentity {
        PreparationIdentity {
            run: self.execution.run.clone(),
            head: self.execution.binding.history_range.leaf_id.clone(),
            cursor: self.cursor,
            goal: self.goal.clone(),
            launch: self.launch.clone(),
        }
    }
    pub(crate) fn cancel_requested(&self) -> bool {
        self.execution.run.cancel_requested
    }
    /// Cancellation can abandon a pure history read. An outstanding exchange must still be
    /// restored so the engine can close its calls using their original receipts and identities.
    pub(crate) fn load(self, cancel: &CancellationToken) -> Result<Option<PreparedRecovery>> {
        let cancellation = (!self.cancellation_requires_recovery).then_some(cancel);
        let Some(history) = self.execution.hydrate_history(cancellation)? else {
            return Ok(None);
        };
        let allowed_tools = self.launch.as_ref()
            .and_then(|launch| launch.selection.agent.as_ref())
            .and_then(|agent| agent.tools.as_deref());
        let request_tools = crate::tool_disclosure::request_tools(
            &self.execution.binding.tools, self.goal.is_some(), allowed_tools);
        let recovery = match &self.kind {
            RecoveryKind::None | RecoveryKind::Policy => None,
            RecoveryKind::Undispatched { step, checkpoint } => {
                let snapshot: RequestSnapshot =
                    self.execution.content.load_snapshot(&step.request)?;
                let frozen = &snapshot.view.binding;
                if snapshot.view.request_id != step.id
                    || snapshot.view.run_id != self.execution.run.id
                    || frozen.history_range.branch_id != self.execution.run.branch_id
                    || !matches!(&snapshot.view.origin, RequestOrigin::Conversation { history_range, .. }
                        if history_range == &frozen.history_range)
                    || frozen
                        .history_range
                        .leaf_id
                        .as_ref()
                        .is_some_and(|anchor| !history.iter().any(|item| &item.id == anchor))
                {
                    return Err(RuntimeError::Conflict(
                        "undispatched request ownership changed".into(),
                    ));
                }
                // Only an open candidate requires its original generation. Once positively
                // closed, explicit selections may activate through their normal boundary.
                let binding = &self.execution.binding;
                if let Some(launch) = &self.launch {
                    let selected = &launch.selection;
                    let tools: Vec<ToolSchema> =
                        serde_json::from_value(self.execution.content.load(&selected.tools_ref)?)?;
                    let credential = selected
                        .credential_scope
                        .as_ref()
                        .map(|scope| scope.reference.clone())
                        .or_else(|| {
                            self.execution
                                .run
                                .configuration
                                .get("credentialEnvironment")
                                .and_then(Value::as_str)
                                .map(|variable| format!("environment:{variable}"))
                        });
                    if selected.connection_identity != binding.connection_identity
                        || selected.provider_family != binding.provider_family
                        || selected.model != binding.model
                        || selected.configuration_generation != binding.configuration_generation
                        || selected.tool_schema_generation != binding.tool_schema_generation
                        || selected.policy != self.execution.policy
                        || credential != binding.credential_ref
                        || tools != binding.tools
                    {
                        return Err(RuntimeError::Conflict(
                            "recovery binding differs from the admitted launch".into(),
                        ));
                    }
                }
                if step.state == ModelStepState::Prepared
                    && (frozen.connection_identity != binding.connection_identity
                        || frozen.provider_family != binding.provider_family
                        || frozen.model != binding.model
                        || frozen.credential_ref != binding.credential_ref
                        || frozen.configuration_generation != binding.configuration_generation
                        || frozen.tool_schema_generation != binding.tool_schema_generation
                        || frozen.tools != request_tools
                        || frozen.history_range.leaf_id != binding.history_range.leaf_id)
                {
                    return Err(RuntimeError::Conflict(
                        "undispatched request differs from its frozen launch".into(),
                    ));
                }
                let database = Connection::open_with_flags(
                    &self.execution.database,
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                        | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
                )?;
                let (event, decision) = if let Some(checkpoint) = checkpoint {
                    let mut event: PolicyEvent = self.execution.content.load_policy_event(
                        checkpoint.continuation.as_ref().ok_or_else(|| {
                            RuntimeError::Invalid("undispatched policy continuation missing".into())
                        })?,
                    )?;
                    let inputs =
                        checkpoint.invalidating_inputs(&database, &self.execution.run.id)?;
                    if !inputs.is_empty()
                        && !matches!(
                            event,
                            PolicyEvent::Delivered { .. } | PolicyEvent::Resumed { .. }
                        )
                    {
                        event = PolicyEvent::InputDelivered { input_ids: inputs };
                    }
                    let decision = if checkpoint.pending(&database, &self.execution.run.id)?
                        && frozen.goal == self.goal
                    {
                        let action = self.execution.content.load_policy_action(
                            checkpoint.action.as_ref().ok_or_else(|| {
                                RuntimeError::Invalid("undispatched policy action missing".into())
                            })?,
                        )?;
                        if !matches!(
                            action,
                            PolicyAction::RequestModel
                                | PolicyAction::RequestModelWithEvidence { .. }
                        ) {
                            return Err(RuntimeError::Conflict(
                                "undispatched checkpoint is not a model proposal".into(),
                            ));
                        }
                        Some(PolicyDecision {
                            state: self.execution.content.load(
                                checkpoint.pending_state.as_ref().ok_or_else(|| {
                                    RuntimeError::Invalid(
                                        "undispatched policy state missing".into(),
                                    )
                                })?,
                            )?,
                            action,
                        })
                    } else {
                        None
                    };
                    (event, decision)
                } else {
                    (PolicyEvent::Started, None)
                };
                Some(ExecutionRecovery {
                    event,
                    pending: None,
                    receipts: BTreeMap::new(),
                    decision,
                })
            }
            RecoveryKind::Checkpoint(checkpoint) => {
                let database = Connection::open_with_flags(
                    &self.execution.database,
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                        | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
                )?;
                let mut event: PolicyEvent = self.execution.content.load_policy_event(
                    checkpoint.continuation.as_ref().ok_or_else(|| {
                        RuntimeError::Invalid("policy continuation missing".into())
                    })?,
                )?;
                let input_ids =
                    checkpoint.invalidating_inputs(&database, &self.execution.run.id)?;
                if !input_ids.is_empty()
                    && !matches!(
                        event,
                        PolicyEvent::Delivered { .. } | PolicyEvent::Resumed { .. }
                    )
                {
                    event = PolicyEvent::InputDelivered { input_ids };
                }
                let decision = if checkpoint.pending(&database, &self.execution.run.id)? {
                    Some(PolicyDecision {
                        state: self.execution.content.load(
                            checkpoint.pending_state.as_ref().ok_or_else(|| {
                                RuntimeError::Invalid("pending decision state missing".into())
                            })?,
                        )?,
                        action: self.execution.content.load_policy_action(
                            checkpoint.action.as_ref().ok_or_else(|| {
                                RuntimeError::Invalid("pending decision missing".into())
                            })?,
                        )?,
                    })
                } else {
                    None
                };
                Some(ExecutionRecovery {
                    event,
                    pending: None,
                    receipts: BTreeMap::new(),
                    decision,
                })
            }
            RecoveryKind::Model { step, policy } => {
                let mut database = Connection::open_with_flags(
                    &self.execution.database,
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                        | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
                )?;
                let snapshot_read = database.transaction()?;
                let model = Catalog::read_model_recovery(
                    &snapshot_read,
                    &self.execution.content,
                    &self.execution.run.id,
                    step.clone(),
                    policy,
                )?;
                drop(snapshot_read);
                let snapshot: RequestSnapshot =
                    self.execution.content.load_snapshot(&model.step.request)?;
                let binding = &self.execution.binding;
                let model_changed = snapshot.view.binding.connection_identity
                    != binding.connection_identity
                    || snapshot.view.binding.provider_family != binding.provider_family
                    || snapshot.view.binding.model != binding.model
                    || snapshot.view.binding.configuration_generation
                        != binding.configuration_generation;
                let activated_model = model
                    .active_model
                    .as_ref()
                    .map(|active| {
                        Ok::<_, RuntimeError>(
                            serde_json::to_value(&active.configuration)?
                                == self.execution.run.configuration
                                && active.configuration.provider_family == binding.provider_family
                                && active.configuration.model == binding.model
                                && active.configuration.configuration_generation
                                    == binding.configuration_generation
                                && binding.connection_identity
                                    == if let Some(scope) = &active.credential_scope {
                                        crate::model_session::connection_identity_with_scope(
                                            &active.configuration,
                                            scope,
                                        )
                                    } else {
                                        crate::model_session::connection_identity(
                                            &active.configuration,
                                        )
                                    }
                                    .map_err(|error| RuntimeError::Invalid(error.to_string()))?,
                        )
                    })
                    .transpose()?
                    .unwrap_or(false);
                let tools_changed = snapshot.view.binding.tools != request_tools
                    || snapshot.view.binding.tool_schema_generation
                        != binding.tool_schema_generation;
                let activated_tools = match &model.active_tool_composition {
                    Some(reference) => {
                        let selected: super::tools::ToolComposition =
                            serde_json::from_value(self.execution.content.load(reference)?)?;
                        selected.generation == binding.tool_schema_generation
                            && selected.tools == binding.tools
                    }
                    None => false,
                };
                if (tools_changed && (model.committed != model.calls.len() || !activated_tools))
                    || (model_changed && (model.committed != model.calls.len() || !activated_model))
                {
                    return Err(RuntimeError::Conflict(
                        "completed exchange belongs to another frozen launch binding".into(),
                    ));
                }
                let output = self.execution.content.load(&model.output)?;
                if output.get("status").and_then(Value::as_str) != Some("committed") {
                    return Err(RuntimeError::Conflict(
                        "rejected model output cannot be resumed".into(),
                    ));
                }
                let record: ExecutionRecord =
                    serde_json::from_value(output.get("record").cloned().ok_or_else(|| {
                        RuntimeError::Invalid("model output record missing".into())
                    })?)?;
                let ExecutionRecord::ModelFinished {
                    request_id,
                    outcome: ModelOutcome::Completed,
                    finish_reason: Some(reason),
                    items,
                    ..
                } = record
                else {
                    return Err(RuntimeError::Conflict(
                        "model output is not complete".into(),
                    ));
                };
                if request_id != model.step.id {
                    return Err(RuntimeError::Conflict(
                        "model output receipt belongs to another request".into(),
                    ));
                }
                let expected_calls: Vec<_> = items
                    .iter()
                    .filter_map(|item| match &item.content {
                        Content::ToolCall { call } => Some(call.clone()),
                        _ => None,
                    })
                    .collect();
                if model.calls != expected_calls {
                    return Err(RuntimeError::Conflict(
                        "committed tool call identities differ from model output".into(),
                    ));
                }
                let model_head = committed_model_history_head(
                    &self.execution.run,
                    &snapshot,
                    &items,
                    &history,
                    &request_id,
                )?;
                let expected_head =
                    if !model.calls.is_empty() && model.committed == model.calls.len() {
                        Some(format!(
                            "{}:result:{}",
                            request_id,
                            model.calls.last().unwrap().call_id
                        ))
                    } else {
                        model_head
                    };
                if self.execution.binding.history_range.leaf_id != expected_head {
                    // Later input established another causal boundary. Resume from that history,
                    // never reuse an older policy completion decision.
                    if model.committed != model.calls.len() {
                        return Err(RuntimeError::Conflict(
                            "execution needs explicit model/tool recovery".into(),
                        ));
                    }
                    None
                } else {
                    let event = if !model.calls.is_empty() && model.committed == model.calls.len() {
                        PolicyEvent::ToolsCompleted {
                            results: model
                                .calls
                                .iter()
                                .map(|call| {
                                    model.receipts.get(&call.call_id).cloned().ok_or_else(|| {
                                        RuntimeError::Invalid(
                                            "committed tool receipt missing".into(),
                                        )
                                    })
                                })
                                .collect::<Result<_>>()?,
                        }
                    } else {
                        PolicyEvent::ModelCompleted {
                            reason,
                            tool_calls: model.calls.len(),
                        }
                    };
                    Some(ExecutionRecovery {
                        event,
                        pending: (model.committed == 0 && !model.calls.is_empty())
                            .then(|| (snapshot, model.calls.clone())),
                        receipts: model.receipts.clone(),
                        decision: model.decision.clone(),
                    })
                }
            }
        };
        let input = self.execution.input(history)?;
        Ok(Some(PreparedRecovery {
            preparation: self,
            input,
            recovery,
        }))
    }
}

/// Validate the exact consecutive assistant rows after the frozen anchor. Later tool results or
/// input are not candidate model output, and no content is read while Catalog is owned.
fn committed_model_history_head(
    run: &Run,
    snapshot: &RequestSnapshot,
    items: &[ProviderItem],
    history: &[HistoryItem],
    request_id: &str,
) -> Result<Option<String>> {
    if snapshot.view.request_id != request_id
        || snapshot.view.run_id != run.id
        || snapshot.view.binding.history_range.branch_id != run.branch_id
        || !matches!(&snapshot.view.origin, RequestOrigin::Conversation { history_range, .. } if history_range == &snapshot.view.binding.history_range)
    {
        return Err(RuntimeError::Conflict(
            "committed model request ownership changed".into(),
        ));
    }
    let anchor = &snapshot.view.binding.history_range.leaf_id;
    let start = match anchor {
        Some(key) => {
            history
                .iter()
                .position(|item| &item.id == key)
                .ok_or_else(|| {
                    RuntimeError::Conflict("committed model anchor is not on its branch".into())
                })?
                + 1
        }
        None => 0,
    };
    let rows = history
        .get(start..)
        .and_then(|suffix| suffix.get(..items.len()))
        .ok_or_else(|| RuntimeError::Conflict("committed model history count changed".into()))?;
    let mut head = anchor.clone();
    for (stored, expected) in rows.iter().zip(items) {
        if stored.thread_id != run.thread_id
            || stored.parent != head
            || stored.source != HistorySource::Assistant
        {
            return Err(RuntimeError::Conflict(
                "committed model history boundary changed".into(),
            ));
        }
        let item: ConversationItem = serde_json::from_value(stored.content.clone())?;
        let original = expected.opaque.as_ref().map(|opaque| ProviderOriginal {
            connection_identity: opaque.connection_identity.clone(),
            adapter: opaque.family.clone(),
            version: opaque.adapter_version.clone(),
            item: opaque.value.clone(),
        });
        if item.id != stored.id
            || item.provenance != Provenance::Assistant
            || item.content != expected.content
            || item.opaque != expected.opaque
            || stored.provider != original
        {
            return Err(RuntimeError::Conflict(
                "committed model history content changed".into(),
            ));
        }
        head = Some(stored.id.clone());
    }
    Ok(head)
}

impl Catalog {
    /// Actual execution placement, independent of the client's current navigation selection.
    pub fn model_request_context(&self, run_id: &str) -> Result<ModelRequestContext> {
        let value: Value = record(&self.db, "runs", run_id)?;
        if value["kind"] == super::model_text::KIND || value["kind"] == super::knowledge_inference::KIND {
            let run: super::utility_run::UtilityRun = serde_json::from_value(value)?;
            return Ok(ModelRequestContext { session_id: run.id, workspace_id: None });
        }
        let run: Run = serde_json::from_value(value)?;
        let workspace_id = self
            .launch_metadata(run_id)?
            .and_then(|launch| launch.selection.source)
            .map(|source| source.workspace_id);
        Ok(ModelRequestContext {
            session_id: run.branch_id,
            workspace_id,
        })
    }
    pub(crate) fn cancelled_recovery_runs(&self) -> Result<Vec<String>> {
        let mut statement = self.db.prepare(
            "SELECT id FROM runs WHERE json_extract(body,'$.cancel_requested')=1
             AND json_extract(body,'$.state') NOT IN ('completed','failed','cancelled')",
        )?;
        let runs = statement.query_map([], |row| row.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(runs)
    }

    /// Called only after the Supervisor has reserved this Run against another worker.
    /// Metadata readiness avoids rehydrating blocked external work on unrelated events.
    pub(crate) fn capture_cancelled_recovery(
        &mut self,
        run_id: &str,
    ) -> Result<Option<CancellationRecoveryPreparation>> {
        let run = self.run(run_id)?;
        if !run.cancel_requested || run.state.terminal() {
            return Ok(None);
        }
        if self.cancel_preparing_execution(run_id, self.epoch)?.is_some() {
            return Ok(None);
        }
        let run = self.run(run_id)?;
        if !matches!(run.state, RunState::Accepted | RunState::Preparing | RunState::Runnable | RunState::Waiting)
            || super::policy_body::has_pending_action(&self.db, run_id)?
        {
            return Ok(None);
        }
        let request: Option<String> = self.db.query_row(
            "SELECT m.id FROM model_steps m JOIN tool_calls c ON c.request_id=m.id
             WHERE m.run_id=?1 AND c.committed=0 ORDER BY m.rowid LIMIT 1",
            [run_id], |row| row.get(0),
        ).optional()?;
        let Some(request) = request else { return Ok(None) };
        let step: ModelStep = record(&self.db, "model_steps", &request)?;
        if step.state != ModelStepState::Completed || step.superseded_by_input.is_some() {
            return Ok(None);
        }
        let mut statement = self.db.prepare(
            "SELECT call_id,receipt FROM tool_calls WHERE request_id=?1 AND committed=0",
        )?;
        for row in statement.query_map([&request], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)))? {
            let (call, receipt) = row?;
            let key = format!("{request}:tool:{call}");
            if let Some(op) = optional_record::<Operation>(&self.db, "operations", &key)? {
                if !op.handed_off
                    && (op.effect == Effect::Unknown || op.outcome == Some(Outcome::Indeterminate))
                    && !reconciled_terminal_stop(&op)
                {
                    // Caller completion can be durable before physical stop. Only the original
                    // executor's stop fact, never a receipt/empty occupancy alone, releases this
                    // cancelled foreground exchange for recovery.
                    let owner = serde_json::to_value(&op.execution_owner)?;
                    let stopped: bool = self.db.query_row(
                        "SELECT EXISTS(SELECT 1 FROM events WHERE subject=?1 AND kind='operation.invocation_executor_stopped' AND json_extract(data,'$.operationEpoch')=?2 AND json_extract(data,'$.executionOwner.kind') IS ?3 AND json_extract(data,'$.executionOwner.identity') IS ?4 AND json_extract(data,'$.executionOwner.epoch') IS ?5)",
                        params![op.id, sql_number(op.epoch)?, owner["kind"].as_str(), owner["identity"].as_str(), owner["epoch"].as_str()],
                        |row| row.get(0),
                    )?;
                    if !stopped { return Ok(None); }
                }
                if receipt.is_some() || op.call_completion.is_some()
                    || (op.phase == OperationPhase::Accepted && op.effect == Effect::None)
                {
                    continue;
                }
                if op.phase != OperationPhase::Terminal
                    || ((op.effect == Effect::Unknown || op.outcome == Some(Outcome::Indeterminate))
                        && !reconciled_terminal_stop(&op))
                {
                    return Ok(None);
                }
            }
        }
        drop(statement);
        let launch = self.launch_metadata(run_id)?;
        let policy = super::policy_checkpoint::metadata(&self.db, run_id)?
            .map(|checkpoint| checkpoint.identity)
            .or_else(|| launch.as_ref().map(|launch| launch.selection.policy.clone()))
            .unwrap_or_else(|| DefaultAgentPolicy.identity());
        let identity = PreparationIdentity {
            head: self.head(&run.branch_id)?,
            cursor: self.preparation_cursor(&run)?,
            goal: self.goal_binding(run_id)?,
            launch,
            run,
        };
        // Check the same active branch/Run owner before starting unlocked work, too. A lost
        // owner is a control error, not a body failure to retry on every completion wake.
        if !self.preparation_is_current(&identity)? { return Ok(None); }
        Ok(Some(CancellationRecoveryPreparation {
            identity,
            step,
            policy,
            database: self.db.path().ok_or_else(|| RuntimeError::Invalid("Catalog has no persistent database".into()))?.into(),
            content: self.content.clone(),
            publication: self.content.begin_publication(),
            bodies: self.prepare_execution_bodies(&ExecutionRecord::ToolBatchCommitted {
                request_id: request, results: vec![],
            })?,
        }))
    }

    pub(crate) fn publish_cancelled_recovery(
        &mut self,
        prepared: PreparedCancellationRecovery,
    ) -> Result<bool> {
        let identity = prepared.recovered.preparation.identity();
        if self.run(&identity.run.id)?.state.terminal() { return Ok(true); }
        if !self.preparation_is_current(&identity)? { return Ok(false); }
        if !identity.run.cancel_requested {
            return Err(RuntimeError::Conflict("cancellation recovery lost its intent".into()));
        }
        let RecoveryKind::Model { mut step, .. } = prepared.recovered.preparation.kind else {
            return Err(RuntimeError::Invalid("cancellation recovery is not a model exchange".into()));
        };
        // Adopt only the completed exchange's pairing owner. No dispatch becomes eligible.
        // A crash before the ordinary batch commit leaves it unpaired and safely retryable.
        step.epoch = self.epoch;
        put(&self.db, "model_steps", &step.id, &step)?;
        self.commit_prepared_execution(&identity.run.id, self.epoch, &prepared.record, prepared.bodies)?;
        self.cancel_preparing_execution(&identity.run.id, self.epoch)?;
        Ok(true)
    }

    pub(super) fn capture_execution_preparation(
        &self,
        run_id: &str,
        mut binding: RequestBinding,
        policy: PolicyIdentity,
        initial_policy_state: Value,
        completed_tools: bool,
        recovering_wait: bool,
        allow_cancelled: bool,
        prepared_request: Option<&str>,
    ) -> Result<ExecutionPreparation> {
        let run = self.run(run_id)?;
        if run.epoch != self.epoch
            || (!allow_cancelled && run.cancel_requested)
            || !(matches!(run.state, RunState::Accepted | RunState::Runnable)
                || (recovering_wait && run.state == RunState::Waiting))
        {
            return Err(RuntimeError::Conflict(
                "run is not admitted for execution".into(),
            ));
        }
        let active: Option<String> = self.db.query_row(
            "SELECT active_run FROM branches WHERE id=?1",
            [&run.branch_id],
            |row| row.get(0),
        )?;
        if active.as_deref() != Some(run_id)
            || self.branch_thread_id(&run.branch_id)? != run.thread_id
        {
            return Err(RuntimeError::Conflict("branch owner changed".into()));
        }
        let unresolved: bool = self.db.query_row("SELECT EXISTS(SELECT 1 FROM model_steps WHERE run_id=?1 AND state NOT IN ('completed','not_dispatched') AND json_extract(body,'$.superseded_by_input') IS NULL AND (?2 IS NULL OR id!=?2 OR state!='prepared'))", params![run_id,prepared_request], |r| r.get(0))?;
        let unpaired: bool = self.db.query_row("SELECT EXISTS(SELECT 1 FROM tool_calls c JOIN model_steps m ON m.id=c.request_id WHERE m.run_id=?1 AND c.committed=0)", [run_id], |r| r.get(0))?;
        if unresolved || (unpaired && !completed_tools) {
            return Err(RuntimeError::Conflict(
                "execution needs explicit model/tool recovery".into(),
            ));
        }
        let completed_model_steps = self.db.query_row(
            "SELECT count(*) FROM model_steps WHERE run_id=?1",
            [run_id],
            |row| read_number(row, 0),
        )?;
        binding.history_range.branch_id = run.branch_id.clone();
        binding.history_range.leaf_id = self.head(&run.branch_id)?;
        binding.request_context = Some(self.model_request_context(run_id)?);
        let database = self
            .db
            .path()
            .ok_or_else(|| RuntimeError::Invalid("Catalog has no persistent database".into()))?
            .into();
        Ok(ExecutionPreparation {
            run,
            binding,
            policy,
            policy_state: initial_policy_state,
            completed_model_steps,
            database,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }

    /// Tracks only this Run and its durable conditions. Unrelated Runs cannot invalidate its read.
    fn preparation_cursor(&self, run: &Run) -> Result<u64> {
        Ok(self.db.query_row("SELECT coalesce(max(cursor),0) FROM events WHERE (subject=?1 AND kind IN ('execution.committed','execution.interrupted','run.execution_recovered','policy.activated')) OR subject IN (SELECT id FROM operations WHERE run_id=?1) OR subject IN (SELECT id FROM waits WHERE run_id=?1)",
            [&run.id], |row| read_number(row, 0))?)
    }

    fn recovery_wait(&self, run: &Run) -> Result<()> {
        if run.state != RunState::Waiting {
            return Ok(());
        }
        let key = run
            .waiting_on
            .as_deref()
            .ok_or_else(|| RuntimeError::Conflict("Run has no recovery condition".into()))?;
        let wait: Wait = record(&self.db, "waits", key)?;
        if wait.run_id != run.id
            || !matches!(
                wait.kind.as_str(),
                "recovery.reconciled" | "execution.reconciled"
            )
        {
            return Err(RuntimeError::Conflict(
                "Run is waiting on another durable condition".into(),
            ));
        }
        Ok(())
    }

    pub(crate) fn capture_recovered_execution(
        &self,
        run_id: &str,
        binding: RequestBinding,
        policy: PolicyIdentity,
        initial_policy_state: Value,
        allow_cancelled: bool,
    ) -> Result<RecoveryPreparation> {
        let run = self.run(run_id)?;
        fence(&run, self.epoch)?;
        if run.cancel_requested && !allow_cancelled {
            return Err(RuntimeError::Conflict(
                "Run cancellation is closing recovery admission".into(),
            ));
        }
        // The policy reader captures references only. Its potentially large request and original
        // output are restored by the engine's policy Persistence call after releasing Catalog.
        let policy_identity = self
            .prepare_policy_action_read(run_id, self.epoch)?
            .map(|read| read.identity().clone());
        let checkpoint = super::policy_checkpoint::metadata(&self.db, run_id)?;
        let unresolved: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM model_steps WHERE run_id=?1 AND state NOT IN ('completed','not_dispatched')
                 AND json_extract(body,'$.superseded_by_input') IS NULL)
             OR EXISTS(SELECT 1 FROM tool_calls c JOIN model_steps m ON m.id=c.request_id
                 WHERE m.run_id=?1 AND c.committed=0)",
            [run_id],
            |row| row.get(0),
        )?;
        let checkpoint_boundary = if let Some(saved) = &checkpoint {
            let consumed: u64 = self.db.query_row(
                "SELECT coalesce(max(cursor),0) FROM events WHERE subject=?1 AND kind='execution.committed'
                 AND json_extract(data,'$.kind')='policy_decision_consumed'",
                [run_id], |row| read_number(row, 0),
            )?;
            let work: u64 = self.db.query_row(
                "SELECT coalesce(max(cursor),0) FROM events WHERE (subject=?1 AND kind='execution.committed'
                 AND json_extract(data,'$.kind') IN ('request_prepared','model_finished','tool_batch_committed'))
                 OR subject IN (SELECT id FROM operations WHERE run_id=?1 AND json_extract(body,'$.intent.kind')
                     IN ('policy_tool_graph_v1','policy_model_job_v1','policy_deliver_v1','policy_pause_v1'))",
                [run_id], |row| read_number(row, 0),
            )?;
            // Parking consumes a Wait checkpoint in StateChanged, without a separate
            // PolicyDecisionConsumed record. Its saved event remains the continuation when
            // that same durable condition wakes the Run (including a question's user history).
            let parked_wait = if !saved.decision_pending {
                if let Some(wait_id) = &saved.wait_id {
                    let wait: Wait = record(&self.db, "waits", wait_id)?;
                    if wait.run_id != run_id {
                        return Err(RuntimeError::Invalid(
                            "policy wait owner differs from its checkpoint".into(),
                        ));
                    }
                    self.db.query_row(
                        "SELECT coalesce(max(cursor),0) > ?2
                         FROM events WHERE subject=?1 AND kind='execution.committed'
                            AND json_extract(data,'$.kind')='policy_checkpoint'",
                        params![run_id, sql_number(work)?],
                        |row| row.get::<_, bool>(0),
                    )?
                } else {
                    false
                }
            } else {
                false
            };
            saved.continuation.is_some()
                && !unresolved
                && !super::policy_body::has_pending_action(&self.db, run_id)?
                && (saved.kind == super::policy_checkpoint::PolicyCheckpointKind::Activation
                    || saved.decision_pending
                    || parked_wait
                    || consumed > work)
        } else {
            false
        };
        let latest: Option<ModelStep> = self
            .db
            .query_row(
                "SELECT id,state,body FROM model_steps WHERE run_id=?1 ORDER BY rowid DESC LIMIT 1",
                [run_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
            .map(|(id, state, raw)| {
                let step: ModelStep = serde_json::from_str(&raw)?;
                if step.id != id
                    || step.run_id != run_id
                    || encode(&step.state)?.trim_matches('"') != state
                {
                    return Err(RuntimeError::Invalid(
                        "model step metadata differs from its row".into(),
                    ));
                }
                Ok(step)
            })
            .transpose()?;
        let proposal_precedes_request: bool = self.db.query_row(
            "SELECT (SELECT coalesce(max(cursor),0) FROM events WHERE subject=?1 AND kind='execution.committed'
                AND json_extract(data,'$.kind')='policy_checkpoint') <=
                (SELECT coalesce(max(cursor),0) FROM events WHERE subject=?1 AND kind='execution.committed'
                AND json_extract(data,'$.kind')='request_prepared')",
            [run_id], |row| row.get(0),
        )?;
        let undispatched = latest.filter(|step| {
            (step.state == ModelStepState::Prepared
                || (step.state == ModelStepState::NotDispatched
                    && proposal_precedes_request
                    && checkpoint.as_ref().is_none_or(|saved| {
                        saved.kind == super::policy_checkpoint::PolicyCheckpointKind::Decision
                    })))
                && step.superseded_by_input.is_none()
        });
        let kind = if let Some(step) = undispatched {
            if step.run_id != run.id
                || (step.state == ModelStepState::Prepared && step.epoch != self.epoch)
            {
                return Err(RuntimeError::Conflict(
                    "undispatched request owner changed".into(),
                ));
            }
            if let Some(saved) = &checkpoint {
                if saved.identity != policy
                    || saved.kind != super::policy_checkpoint::PolicyCheckpointKind::Decision
                {
                    return Err(RuntimeError::Conflict(
                        "undispatched policy checkpoint changed".into(),
                    ));
                }
            }
            self.recovery_wait(&run)?;
            RecoveryKind::Undispatched { step, checkpoint }
        } else if checkpoint_boundary {
            let saved = checkpoint.expect("captured checkpoint boundary");
            if saved.identity != policy {
                return Err(RuntimeError::Conflict(
                    "policy checkpoint belongs to another implementation version".into(),
                ));
            }
            self.recovery_wait(&run)?;
            RecoveryKind::Checkpoint(saved)
        } else if let Some(identity) = policy_identity {
            if identity != policy {
                return Err(RuntimeError::Conflict(
                    "policy recovery version changed".into(),
                ));
            }
            self.recovery_wait(&run)?;
            RecoveryKind::Policy
        } else {
            let latest: Option<String> = self
                .db
                .query_row(
                    "SELECT id FROM model_steps WHERE run_id=?1 ORDER BY rowid DESC LIMIT 1",
                    [run_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(request_id) = latest {
                let step: ModelStep = record(&self.db, "model_steps", &request_id)?;
                if step.id != request_id || step.run_id != run_id {
                    return Err(RuntimeError::Conflict(
                        "model step ownership changed".into(),
                    ));
                }
                if step.state == ModelStepState::Completed
                    && step.superseded_by_input.is_none()
                    && matches!(
                        run.state,
                        RunState::Waiting | RunState::Runnable | RunState::Accepted
                    )
                {
                    self.recovery_wait(&run)?;
                    RecoveryKind::Model {
                        step,
                        policy: policy.clone(),
                    }
                } else {
                    RecoveryKind::None
                }
            } else {
                RecoveryKind::None
            }
        };
        let completed_tools = matches!(kind, RecoveryKind::Model { .. });
        let recovering_wait = !matches!(kind, RecoveryKind::None);
        let execution = self.capture_execution_preparation(
            run_id,
            binding,
            policy,
            initial_policy_state,
            completed_tools,
            recovering_wait,
            allow_cancelled,
            match &kind {
                RecoveryKind::Undispatched { step, .. }
                    if step.state == ModelStepState::Prepared =>
                {
                    Some(step.id.as_str())
                }
                _ => None,
            },
        )?;
        let cancellation_requires_recovery: bool = self.db.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE run_id=?1 AND json_extract(body,'$.phase')!='terminal' AND json_extract(body,'$.handed_off')=0) OR EXISTS(SELECT 1 FROM tool_calls c JOIN model_steps m ON m.id=c.request_id WHERE m.run_id=?1 AND c.committed=0)", [run_id], |row| row.get(0))?;
        Ok(RecoveryPreparation {
            cursor: self.preparation_cursor(&run)?,
            execution,
            kind,
            cancellation_requires_recovery,
            goal: self.goal_binding(run_id)?,
            launch: self.launch_metadata(run_id)?,
        })
    }

    fn read_model_recovery(
        database: &Connection,
        content: &crate::content::ContentStore,
        run_id: &str,
        step: ModelStep,
        policy: &PolicyIdentity,
    ) -> Result<ModelRecoveryPreparation> {
        let request_id = &step.id;
        let output: Option<String> = database
            .query_row(
                "SELECT body FROM model_outputs WHERE request_id=?1",
                [request_id],
                |row| row.get(0),
            )
            .optional()?;
        let output = serde_json::from_str(&output.ok_or_else(|| {
            RuntimeError::Invalid("completed model has no durable output".into())
        })?)?;
        let mut calls = Vec::new();
        let mut receipts = BTreeMap::new();
        let mut committed = 0;
        let mut statement = database.prepare(
            "SELECT body,receipt,committed FROM tool_calls WHERE request_id=?1 ORDER BY rowid",
        )?;
        for row in statement.query_map([request_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })? {
            let (body, receipt, done) = row?;
            let call = serde_json::from_str::<super::tool_content::ToolCallMetadata>(&body)?
                .load(content)?;
            if let Some(receipt) = receipt {
                receipts.insert(
                    call.call_id.clone(),
                    serde_json::from_str::<super::result_content::ToolReceiptMetadata>(&receipt)?
                        .load(content)?,
                );
            }
            if done != 0 {
                committed += 1;
            }
            calls.push(call);
        }
        if committed != 0 && committed != calls.len() {
            return Err(RuntimeError::Invalid(
                "tool history has a partial batch commit".into(),
            ));
        }
        let unpaired_other: bool = database.query_row("SELECT EXISTS(SELECT 1 FROM tool_calls c JOIN model_steps m ON m.id=c.request_id WHERE m.run_id=?1 AND c.request_id!=?2 AND c.committed=0)", params![run_id, request_id], |r| r.get(0))?;
        if unpaired_other {
            return Err(RuntimeError::Conflict(
                "an earlier tool exchange remains unresolved".into(),
            ));
        }
        for call in &calls {
            if receipts.contains_key(&call.call_id) {
                continue;
            }
            let key = format!("{}:tool:{}", request_id, call.call_id);
            if let Some(op) = optional_record::<Operation>(database, "operations", &key)? {
                let intent = super::tool_content::ToolIntent::from_operation(&op)?;
                if intent.origin()
                    != &(ToolOrigin::ModelStep {
                        request_id: request_id.clone(),
                    })
                    || op.run_id != run_id
                {
                    return Err(RuntimeError::Conflict(
                        "model invocation origin changed".into(),
                    ));
                }
                if let Some(completion) = op.call_completion.clone() {
                    receipts.insert(
                        call.call_id.clone(),
                        ToolResult {
                            request_id: request_id.clone(),
                            call_id: call.call_id.clone(),
                            completion: completion.load(content)?,
                        },
                    );
                    continue;
                }
                if op.cancel_requested
                    && op.phase == OperationPhase::Accepted
                    && op.effect == Effect::None
                {
                    receipts.insert(
                        call.call_id.clone(),
                        ToolResult {
                            request_id: request_id.clone(),
                            call_id: call.call_id.clone(),
                            completion: ToolCompletion::Result {
                                outcome: Outcome::Cancelled,
                                effect: Effect::None,
                                content: json!({"error":"cancelled_before_dispatch"}).into(),
                            },
                        },
                    );
                    continue;
                }
                // A stopped original executor can truthfully leave its business effect unknown.
                // That durable receipt closes the call without making it replayable or successful.
                // Recovery's synthetic Unknown alone is insufficient, as is empty occupancy.
                if ((op.effect == Effect::Unknown
                    || op.outcome == Some(Outcome::Indeterminate))
                    && !reconciled_terminal_stop(&op))
                    || (op.phase != OperationPhase::Terminal && op.effect != Effect::None)
                {
                    return Err(RuntimeError::Conflict(
                        "tool effect requires executor reconciliation before recovery".into(),
                    ));
                }
                if op.phase == OperationPhase::Terminal {
                    receipts.insert(
                        call.call_id.clone(),
                        ToolResult {
                            request_id: request_id.clone(),
                            call_id: call.call_id.clone(),
                            completion: ToolCompletion::Result {
                                outcome: op.outcome.ok_or_else(|| {
                                    RuntimeError::Invalid(
                                        "terminal operation has no outcome".into(),
                                    )
                                })?,
                                effect: op.effect,
                                content: content.load_output(
                                    op.result
                                        .as_ref()
                                        .ok_or_else(|| {
                                            RuntimeError::Invalid(
                                                "terminal tool operation has no result".into(),
                                            )
                                        })?
                                        .reference()?,
                                )?,
                            },
                        },
                    );
                }
            }
        }
        let saved = super::policy_checkpoint::metadata(database, run_id)?;
        if saved
            .as_ref()
            .is_some_and(|saved| saved.identity != *policy)
        {
            return Err(RuntimeError::Conflict(
                "policy recovery version changed".into(),
            ));
        }
        let decision = if let Some(saved) = saved {
            if saved.pending(database, run_id)? {
                Some(PolicyDecision {
                    state: content.load(saved.pending_state.as_ref().ok_or_else(|| {
                        RuntimeError::Invalid("pending decision state missing".into())
                    })?)?,
                    action: content.load_policy_action(saved.action.as_ref().ok_or_else(
                        || RuntimeError::Invalid("pending policy decision missing".into()),
                    )?)?,
                })
            } else {
                None
            }
        } else {
            None
        };
        Ok(ModelRecoveryPreparation {
            active_tool_composition: database.query_row("SELECT json_extract(data,'$.composition') FROM events WHERE subject=?1 AND kind='run.tools_activated' ORDER BY cursor DESC LIMIT 1",
                [run_id],|row|row.get::<_,String>(0)).optional()?.map(|value|serde_json::from_str(&value)).transpose()?,
            active_model: {
                let id: Option<String> = database.query_row("SELECT id FROM model_selections WHERE run_id=?1 AND active=1",[run_id],|row|row.get(0)).optional()?;
                id.map(|id|record(database,"model_selections",&id)).transpose()?
            },
            step,
            output,
            calls,
            receipts,
            committed,
            decision,
        })
    }

    /// A changed preparation boundary asks the worker to capture again. Never publish a stale
    /// recovery epoch, wait cancellation, tool receipt or policy decision over newer facts.
    pub(crate) fn preparation_is_current(&self, identity: &PreparationIdentity) -> Result<bool> {
        let captured = &identity.run;
        let run = self.run(&captured.id)?;
        fence(&run, self.epoch)?;
        if run.epoch != captured.epoch
            || run.branch_id != captured.branch_id
            || run.thread_id != captured.thread_id
        {
            return Err(RuntimeError::Conflict(
                "recovery execution owner changed".into(),
            ));
        }
        let active: Option<String> = self.db.query_row(
            "SELECT active_run FROM branches WHERE id=?1",
            [&run.branch_id],
            |row| row.get(0),
        )?;
        if active.as_deref() != Some(&run.id)
            || self.branch_thread_id(&run.branch_id)? != run.thread_id
        {
            return Err(RuntimeError::Conflict(
                "branch execution owner changed".into(),
            ));
        }
        Ok(run == *captured
            && self.head(&run.branch_id)? == identity.head
            && self.preparation_cursor(&run)? == identity.cursor
            && self.goal_binding(&run.id)? == identity.goal
            && self.launch_metadata(&run.id)? == identity.launch)
    }

    pub(crate) fn publish_recovered_execution(
        &mut self,
        prepared: PreparedRecovery,
    ) -> Result<Option<PreparedLaunch>> {
        let PreparedRecovery {
            preparation,
            input,
            recovery,
        } = prepared;
        if !self.preparation_is_current(&preparation.identity())? {
            return Ok(None);
        }
        let mut run = preparation.execution.run.clone();
        if matches!(preparation.kind, RecoveryKind::Policy) || recovery.is_some() {
            let tx = self.db.transaction()?;
            if let Some(key) = run.waiting_on.take() {
                let mut wait: Wait = record(&tx, "waits", &key)?;
                wait.cancelled = true;
                put(&tx, "waits", &key, &wait)?;
            }
            run.state = RunState::Runnable;
            run.revision += 1;
            put(&tx, "runs", &run.id, &run)?;
            if let RecoveryKind::Undispatched { step, .. } = &preparation.kind {
                let current: ModelStep = record(&tx, "model_steps", &step.id)?;
                if current != *step {
                    return Ok(None);
                }
                if step.state == ModelStepState::Prepared {
                    super::execution_persistence::close_prepared_request(
                        &tx,
                        &run,
                        &step.id,
                        NonDispatchReason::Recovery,
                    )?;
                }
            }
            if let RecoveryKind::Model { mut step, .. } = preparation.kind {
                step.epoch = self.epoch;
                put(&tx, "model_steps", &step.id, &step)?;
                event(
                    &tx,
                    &run.id,
                    run.revision,
                    "run.execution_recovered",
                    json!({"request_id":step.id}),
                )?;
            }
            tx.commit()?;
        } else if run.state == RunState::Waiting {
            return Err(RuntimeError::Conflict(
                "run is not admitted for execution".into(),
            ));
        }
        Ok(Some(PreparedLaunch {
            input,
            recovery,
            cancel_requested: run.cancel_requested,
        }))
    }

    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn prepare_recovered_execution(
        &mut self,
        run_id: &str,
        binding: RequestBinding,
        policy: PolicyIdentity,
        initial_policy_state: Value,
    ) -> Result<(ExecutionInput, Option<ExecutionRecovery>)> {
        let _synchronous = self.content.begin_synchronous()?;
        let preparation =
            self.capture_recovered_execution(run_id, binding, policy, initial_policy_state, false)?;
        let prepared = preparation
            .load(&CancellationToken::default())?
            .expect("uncancelled recovery read");
        let launch = self
            .publish_recovered_execution(prepared)?
            .expect("exclusive Catalog preparation");
        Ok((launch.input, launch.recovery))
    }

    /// A preparation that has no unresolved foreground work can settle cancellation without
    /// reading its historical bodies. Otherwise its original exchange must be restored and closed.
    pub(crate) fn cancel_preparing_execution(
        &mut self,
        run_id: &str,
        epoch: u64,
    ) -> Result<Option<Run>> {
        let run = self.run(run_id)?;
        if run.epoch != epoch {
            return Err(RuntimeError::Conflict(
                "preparing worker belongs to an old epoch".into(),
            ));
        }
        if run.state.terminal() {
            return Ok(Some(run));
        }
        if matches!(self.run_stop_reason(run_id, epoch)?, super::bot::RunStopReason::BotSuspension(_)) {
            return self.park_bot_run(run_id, epoch).map(Some);
        }
        let run = self.request_cancel_run(run_id)?;
        {
            let tx = self.db.transaction()?;
            // A conversation has one prepared exchange, but a summary DAG can own several
            // independent prepared nodes. Close every proven-undispatched request before
            // testing the cancellation barrier; no worker may resume this cancelled Run.
            let prepared = {
                let mut statement = tx.prepare(
                    "SELECT id FROM model_steps WHERE run_id=?1 AND state='prepared'",
                )?;
                let rows = statement.query_map([run_id], |row| row.get::<_, String>(0))?;
                rows.collect::<std::result::Result<Vec<_>, _>>()?
            };
            for request in prepared {
                super::execution_persistence::close_prepared_request(
                    &tx,
                    &run,
                    &request,
                    NonDispatchReason::Cancelled,
                )?;
            }
            tx.commit()?;
        }
        let unresolved: bool = self.db.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE run_id=?1 AND json_extract(body,'$.phase')!='terminal' AND json_extract(body,'$.handed_off')=0) OR EXISTS(SELECT 1 FROM model_steps WHERE run_id=?1 AND state IN ('prepared','dispatched')) OR EXISTS(SELECT 1 FROM tool_calls c JOIN model_steps m ON m.id=c.request_id WHERE m.run_id=?1 AND c.committed=0)", [run_id], |row| row.get(0))?;
        if unresolved {
            return Ok(None);
        }
        self.transition_run(run_id, epoch, run.revision, RunState::Cancelled)
            .map(Some)
    }
}
