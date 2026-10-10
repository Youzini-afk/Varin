//! Atomic bridge from the executor to its sole durable authority.
use super::result_content::{ToolCompletionMetadata, ToolReceiptMetadata};
use super::tool_content::{ToolCallMetadata, ToolIntent};
use super::*;
use crate::execution::*;
use std::sync::Mutex;

impl Persistence for Mutex<Catalog> {
    fn resume_tool(
        &self,
        context: &ToolExecutionContext,
        epoch: u64,
    ) -> std::result::Result<ToolResume, ExecutionError> {
        let (completion, content, _publication) = {
            let mut catalog = self.lock().map_err(catalog_lock_error)?;
            fence(&catalog.run(&context.run_id).map_err(policy_error)?, epoch)
                .map_err(policy_error)?;
            let Some(mut operation) =
                optional_record::<Operation>(&catalog.db, "operations", &context.operation_id)
                    .map_err(policy_error)?
            else {
                return Ok(ToolResume::New);
            };
            let intent = ToolIntent::from_operation(&operation).map_err(policy_error)?;
            if operation.run_id != context.run_id
                || intent.origin() != &context.origin
                || operation.id != context.origin.operation_id(&intent.call().call_id)
            {
                return Err(ExecutionError::new(
                    "tool_origin_changed",
                    "invocation origin differs from canonical owner",
                ));
            }
            if operation.call_completion.is_none() {
                if operation.phase == OperationPhase::Terminal
                    && operation.outcome == Some(Outcome::Indeterminate)
                {
                    if let Some(receipt) = operation.external_receipt.clone().filter(|receipt| {
                        receipt.outcome != Outcome::Indeterminate
                            && receipt.effect != Effect::Unknown
                    }) {
                        apply_external_terminal(&mut operation, &receipt);
                    }
                }
                if operation.phase == OperationPhase::Accepted && operation.effect == Effect::None {
                    return Ok(ToolResume::Admitted {
                        cancel_requested: operation.cancel_requested,
                    });
                }
                if operation.phase != OperationPhase::Terminal
                    || operation.outcome == Some(Outcome::Indeterminate)
                    || operation.effect == Effect::Unknown
                {
                    return Err(ExecutionError::new(
                        "tool_reconciliation_required",
                        "original executor must settle this dispatched invocation; it will not replay",
                    ));
                }
                let outcome = operation.outcome.ok_or_else(|| {
                    ExecutionError::new(
                        "tool_receipt_missing",
                        "terminal invocation outcome missing",
                    )
                })?;
                let reference = operation
                    .result
                    .as_ref()
                    .ok_or_else(|| {
                        ExecutionError::new(
                            "tool_receipt_missing",
                            "terminal invocation result missing",
                        )
                    })?
                    .reference()
                    .map_err(policy_error)?
                    .clone();
                operation.call_completion = Some(ToolCompletionMetadata::Result {
                    outcome,
                    effect: operation.effect,
                    content_ref: reference,
                });
                operation.revision += 1;
                let tx = catalog
                    .db
                    .transaction()
                    .map_err(|error| policy_error(error.into()))?;
                put(&tx, "operations", &operation.id, &operation).map_err(policy_error)?;
                event(
                    &tx,
                    &operation.id,
                    operation.revision,
                    "operation.settled",
                    serde_json::to_value(&operation).map_err(|error| policy_error(error.into()))?,
                )
                .map_err(policy_error)?;
                tx.commit().map_err(|error| policy_error(error.into()))?;
            }
            (
                operation
                    .call_completion
                    .expect("canonical call completion"),
                catalog.content.clone(),
                catalog.content.begin_publication(),
            )
        };
        Ok(ToolResume::Completed(
            super::result_content::ToolCompletionRead {
                completion,
                content,
                _publication,
            },
        ))
    }

    fn confirms_no_effect(
        &self,
        context: &ToolExecutionContext,
        epoch: u64,
        completion: &ToolCompletion,
    ) -> std::result::Result<bool, ExecutionError> {
        let ToolCompletion::Result {
            outcome,
            effect: Effect::None,
            content,
        } = completion
        else {
            return Ok(false);
        };
        let content_identity =
            crate::content::ContentStore::reference(content).map_err(policy_error)?;
        let catalog = self
            .lock()
            .map_err(|_| ExecutionError::new("catalog_poisoned", "catalog owner failed"))?;
        let run = catalog.run(&context.run_id).map_err(policy_error)?;
        fence(&run, epoch).map_err(policy_error)?;
        let operation = catalog
            .operation(&context.operation_id)
            .map_err(policy_error)?;
        let admitted: ToolIntent = serde_json::from_value(operation.intent.clone())
            .map_err(|error| ExecutionError::new("external_receipt", error.to_string()))?;

        Ok(catalog.epoch() == epoch
            && operation.epoch == epoch
            && operation.run_id == run.id
            && admitted.origin() == &context.origin
            && operation.id == context.operation_id
            && operation.executor.as_deref() == Some(admitted.call().name.as_str())
            && confirmed_no_effect_receipt(&operation, *outcome, &content_identity))
    }

    fn task_family(&self, run: &str, epoch: u64) -> std::result::Result<String, ExecutionError> {
        self.lock()
            .map_err(|_| ExecutionError::new("catalog_poisoned", "catalog owner failed"))?
            .task_family(run, epoch)
            .map_err(policy_error)
    }

    fn policy_model_job(
        &self,
        run: &str,
        epoch: u64,
    ) -> std::result::Result<Option<PolicyModelState>, ExecutionError> {
        let read = self
            .lock()
            .map_err(catalog_lock_error)?
            .prepare_policy_model_read(run, epoch)
            .map_err(policy_error)?;
        read.map(super::policy_model::PolicyModelRead::load)
            .transpose()
            .map_err(policy_error)
    }
    fn admit_policy_model(
        &self,
        run: &str,
        epoch: u64,
        intent: &PolicyModelIntent,
        snapshot: &RequestSnapshot,
    ) -> std::result::Result<PolicyModelState, ExecutionError> {
        let (content, _publication) = {
            let catalog = self.lock().map_err(catalog_lock_error)?;
            fence(&catalog.run(run).map_err(policy_error)?, epoch).map_err(policy_error)?;
            (catalog.content.clone(), catalog.content.begin_publication())
        };
        let deliveries =
            super::memory::PreparedMemoryDeliveries::prepare(snapshot).map_err(policy_error)?;
        let references =
            super::policy_model::PolicyModelAdmissionReferences::write(&content, intent, snapshot)
                .map_err(policy_error)?;
        let read = self
            .lock()
            .map_err(catalog_lock_error)?
            .admit_policy_model_reference(run, epoch, intent, snapshot, references, deliveries)
            .map_err(policy_error)?;
        read.load().map_err(policy_error)
    }
    fn dispatch_policy_model(
        &self,
        run: &str,
        epoch: u64,
        action: &str,
    ) -> std::result::Result<(), ExecutionError> {
        let (content, _publication, reference) = policy_model_body(self, run, epoch, action)?;
        let snapshot = serde_json::from_value(content.load(&reference).map_err(policy_error)?)
            .map_err(|error| policy_error(error.into()))?;
        let deliveries =
            super::memory::PreparedMemoryDeliveries::prepare(&snapshot).map_err(policy_error)?;
        self.lock()
            .map_err(catalog_lock_error)?
            .dispatch_policy_model_prepared(run, epoch, action, &reference, &snapshot, deliveries)
            .map_err(policy_error)
    }
    fn record_policy_model(
        &self,
        run: &str,
        epoch: u64,
        action: &str,
        output: &PolicyModelOutput,
        receipt: Option<&PolicyModelReceipt>,
    ) -> std::result::Result<(), ExecutionError> {
        let (content, _publication, reference) = policy_model_body(self, run, epoch, action)?;
        let snapshot = serde_json::from_value(content.load(&reference).map_err(policy_error)?)
            .map_err(|error| policy_error(error.into()))?;
        let deliveries = receipt
            .filter(|receipt| receipt.usable)
            .map(|_| super::memory::PreparedMemoryDeliveries::prepare(&snapshot))
            .transpose()
            .map_err(policy_error)?;
        let output_refs =
            super::policy_model::PolicyModelOutputReferences::write(&content, output, receipt)
                .map_err(policy_error)?;
        self.lock()
            .map_err(catalog_lock_error)?
            .record_policy_model_prepared(
                run,
                epoch,
                action,
                output,
                receipt,
                &reference,
                deliveries,
                output_refs,
            )
            .map_err(policy_error)
    }
    fn policy_action(
        &self,
        run: &str,
        epoch: u64,
    ) -> std::result::Result<Option<PolicyActionState>, ExecutionError> {
        let read = self
            .lock()
            .map_err(|_| ExecutionError::new("catalog_poisoned", "catalog owner failed"))?
            .prepare_policy_action_read(run, epoch)
            .map_err(policy_error)?;
        read.map(|read| read.load().map_err(policy_error))
            .transpose()
    }
    fn commit_policy_control(
        &self,
        run: &str,
        epoch: u64,
        intent: &PolicyControlIntent,
    ) -> std::result::Result<PolicyControlReceipt, ExecutionError> {
        let preparation = self
            .lock()
            .map_err(|_| ExecutionError::new("catalog_poisoned", "catalog owner failed"))?
            .prepare_policy_control();
        let prepared = preparation.load(intent).map_err(policy_error)?;
        self.lock()
            .map_err(|_| ExecutionError::new("catalog_poisoned", "catalog owner failed"))?
            .commit_policy_control(run, epoch, prepared)
            .map_err(policy_error)
    }
    fn policy_boundary(
        &self,
        run: &str,
        epoch: u64,
    ) -> std::result::Result<PolicyBoundary, ExecutionError> {
        self.lock()
            .map_err(|_| ExecutionError::new("catalog_poisoned", "catalog owner failed"))?
            .policy_boundary(run, epoch)
            .map_err(policy_error)
    }
    fn policy_graph(
        &self,
        run: &str,
        epoch: u64,
    ) -> std::result::Result<Option<PolicyGraphState>, ExecutionError> {
        let read = self
            .lock()
            .map_err(catalog_lock_error)?
            .prepare_policy_graph_read(run, epoch)
            .map_err(policy_error)?;
        read.map(|read| read.load())
            .transpose()
            .map_err(policy_error)
    }
    fn admit_policy_graph(
        &self,
        run: &str,
        epoch: u64,
        intent: &PolicyGraphIntent,
    ) -> std::result::Result<PolicyGraphState, ExecutionError> {
        let preparation = self
            .lock()
            .map_err(catalog_lock_error)?
            .prepare_policy_graph_schemas();
        let schemas = preparation.load(intent).map_err(policy_error)?;
        let read = self
            .lock()
            .map_err(catalog_lock_error)?
            .admit_policy_graph_prepared(run, epoch, schemas)
            .map_err(policy_error)?;
        read.load().map_err(policy_error)
    }
    fn settle_policy_node(
        &self,
        run: &str,
        epoch: u64,
        action: &str,
        node: &str,
        completion: &ToolCompletion,
    ) -> std::result::Result<PolicyNodeReceipt, ExecutionError> {
        let (content, _publication) = {
            let catalog = self.lock().map_err(catalog_lock_error)?;
            fence(&catalog.run(run).map_err(policy_error)?, epoch).map_err(policy_error)?;
            (catalog.content.clone(), catalog.content.begin_publication())
        };
        let metadata = ToolCompletionMetadata::write(&content, completion).map_err(policy_error)?;
        self.lock()
            .map_err(catalog_lock_error)?
            .settle_policy_node_reference(run, epoch, action, node, completion, metadata)
            .map_err(policy_error)
    }

    fn policy_evidence(
        &self,
        run: &str,
        epoch: u64,
        reference: &PolicyEvidenceRef,
    ) -> std::result::Result<PolicyEvidence, ExecutionError> {
        let (content, owned, model, origin, thread, _publication) = {
            let catalog = self.lock().map_err(catalog_lock_error)?;
            let current = catalog.run(run).map_err(policy_error)?;
            fence(&current, epoch).map_err(policy_error)?;
            let owned = catalog
                .owned_policy_reference(run, reference)
                .map_err(policy_error)?;
            let origin = super::memory::owned_policy_receipt(
                &catalog.db,
                run,
                reference,
                &current.thread_id,
            )
            .map_err(policy_error)?
            .map(|(_, origin)| origin);
            (
                catalog.content.clone(),
                owned,
                catalog
                    .is_policy_model_reference(reference)
                    .map_err(policy_error)?,
                origin,
                current.thread_id,
                catalog.content.begin_publication(),
            )
        };
        let value = content.load(&owned).map_err(policy_error)?;
        let memory_facts = super::memory::carried_policy_facts(&value, origin.as_deref(), &thread)
            .map_err(policy_error)?;
        let item = if model {
            policy_model_evidence_item(reference, value)
        } else {
            policy_evidence_item(reference, value)
        };
        Ok(PolicyEvidence { item, memory_facts })
    }
    fn policy_chunk(
        &self,
        run: &str,
        epoch: u64,
        reference: &PolicyEvidenceRef,
        index: usize,
    ) -> std::result::Result<crate::content::ContentChunk, ExecutionError> {
        let (content, owned) = {
            let catalog = self
                .lock()
                .map_err(|_| ExecutionError::new("catalog_poisoned", "catalog owner failed"))?;
            fence(&catalog.run(run).map_err(policy_error)?, epoch).map_err(policy_error)?;
            (
                catalog.content.clone(),
                catalog
                    .owned_policy_reference(run, reference)
                    .map_err(policy_error)?,
            )
        };
        content.load_chunk(&owned, index).map_err(policy_error)
    }
    fn tool_source(
        &self,
        run: &str,
    ) -> std::result::Result<Option<super::launches::SourceSelection>, ExecutionError> {
        Ok(self
            .lock()
            .map_err(|_| ExecutionError::new("catalog_poisoned", "catalog owner failed"))?
            .launch_metadata(run)
            .map_err(policy_error)?
            .and_then(|launch| launch.selection.source))
    }

    fn resource_admission(&self) -> std::sync::Arc<crate::resource_admission::ResourceAdmission> {
        self.lock()
            .unwrap_or_else(|p| p.into_inner())
            .resource_admission
            .clone()
    }

    fn compile_context(
        &self,
        run_id: &str,
        epoch: u64,
        expected_head: Option<&str>,
    ) -> std::result::Result<Option<ContextProjection>, ExecutionError> {
        let read = {
            self.lock()
                .map_err(|_| ExecutionError::new("catalog_poisoned", "catalog owner failed"))?
                .prepare_context_read(run_id, epoch, expected_head)
                .map_err(|error| ExecutionError::new("context_compile", error.to_string()))?
        };
        read.map(|read| read.load())
            .transpose()
            .map_err(|error| ExecutionError::new("context_content", error.to_string()))
    }

    fn consume_inputs(
        &self,
        run_id: &str,
        epoch: u64,
        expected_head: Option<&str>,
    ) -> std::result::Result<Vec<ConversationItem>, ExecutionError> {
        loop {
            let preparation = self
                .lock()
                .map_err(|_| ExecutionError::new("catalog_poisoned", "catalog owner failed"))?
                .prepare_input_delivery(run_id, epoch, expected_head)
                .map_err(|e| ExecutionError::new("catalog_input", e.to_string()))?;
            let prepared = preparation
                .load()
                .map_err(|e| ExecutionError::new("catalog_input_content", e.to_string()))?;
            let result = self
                .lock()
                .map_err(|_| ExecutionError::new("catalog_poisoned", "catalog owner failed"))?
                .admit_input_delivery(prepared)
                .map_err(|e| ExecutionError::new("catalog_input", e.to_string()))?;
            if let Some(items) = result {
                return Ok(items);
            }
            // Only an actual edit/cancel of a captured input asks for another body read.
        }
    }
    fn commit(
        &self,
        run_id: &str,
        epoch: u64,
        record: &ExecutionRecord,
    ) -> std::result::Result<(), ExecutionError> {
        let preparation = self
            .lock()
            .map_err(|_| ExecutionError::new("catalog_poisoned", "catalog owner failed"))?
            .prepare_execution_bodies(record);
        // Hashing, body serialization and durable object I/O belong to the executing worker.
        // The publication lease keeps these objects alive until their metadata commits.
        let prepared = preparation.and_then(|preparation| preparation.write(record));
        let result = prepared.and_then(|prepared| {
            self.lock()
                .map_err(|_| RuntimeError::Invalid("catalog owner failed".into()))?
                .commit_prepared_execution(run_id, epoch, record, prepared)
        });
        match result {
            Ok(()) => Ok(()),
            Err(RuntimeError::DispatchCancelled) => Err(ExecutionError::new(
                "dispatch_cancelled",
                "tool dispatch cancelled before executor entry",
            )),
            Err(RuntimeError::InputPending) => Err(ExecutionError::new(
                "input_pending",
                "new user input is waiting at this boundary",
            )),
            Err(error) => {
                if matches!(record, ExecutionRecord::ModelFinished { .. }) {
                    let retain = (|| {
                        let (content, _publication) = {
                            let catalog = self.lock().map_err(|_| {
                                RuntimeError::Invalid("catalog owner failed".into())
                            })?;
                            (catalog.content.clone(), catalog.content.begin_publication())
                        };
                        let ExecutionRecord::ModelFinished { items, .. } = record else {
                            unreachable!()
                        };
                        let originals = content.save_originals(&provider_originals(items))?;
                        let output = content.save(&json!({"status":"rejected","record":record}))?;
                        self.lock()
                            .map_err(|_| RuntimeError::Invalid("catalog owner failed".into()))?
                            .retain_rejected_model_output(run_id, epoch, record, originals, output)
                    })();
                    if let Err(retain) = retain {
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
fn policy_error(error: RuntimeError) -> ExecutionError {
    ExecutionError::new(
        if matches!(error, RuntimeError::InputPending) {
            "input_pending"
        } else {
            "policy_graph"
        },
        error.to_string(),
    )
}
fn catalog_lock_error<T>(_: std::sync::PoisonError<T>) -> ExecutionError {
    ExecutionError::new("catalog_poisoned", "catalog owner failed")
}
fn policy_model_body(
    catalog: &Mutex<Catalog>,
    run: &str,
    epoch: u64,
    action: &str,
) -> std::result::Result<
    (
        crate::content::ContentStore,
        crate::content::ContentPublication,
        Value,
    ),
    ExecutionError,
> {
    let catalog = catalog.lock().map_err(catalog_lock_error)?;
    let reference = catalog
        .policy_model_request_reference(run, epoch, action)
        .map_err(policy_error)?;
    Ok((
        catalog.content.clone(),
        catalog.content.begin_publication(),
        reference,
    ))
}
fn append_item(
    tx: &Transaction<'_>,
    run: &Run,
    id: &str,
    source: HistorySource,
    body_reference: &Value,
) -> Result<()> {
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
    let stored = HistoryItem {
        id: id.into(),
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
    items
        .iter()
        .filter_map(|item| {
            item.opaque.as_ref().map(|o| ProviderOriginal {
                connection_identity: o.connection_identity.clone(),
                adapter: o.family.clone(),
                version: o.adapter_version.clone(),
                item: o.value.clone(),
            })
        })
        .collect()
}
fn history_items(record: &ExecutionRecord) -> Vec<ConversationItem> {
    match record {
        ExecutionRecord::ModelFinished {
            request_id,
            outcome: ModelOutcome::Completed,
            items,
            ..
        } => items
            .iter()
            .map(|item| model_history_item(request_id, item))
            .collect(),
        ExecutionRecord::ToolBatchCommitted {
            request_id,
            results,
        } => results
            .iter()
            .map(|result| ConversationItem {
                id: format!("{}:result:{}", request_id, result.call_id),
                provenance: Provenance::ToolData {
                    call_id: result.call_id.clone(),
                },
                content: Content::ToolResult {
                    result: result.clone(),
                },
                opaque: None,
            })
            .collect(),
        _ => Vec::new(),
    }
}
fn operation_id(request: &str, call: &str) -> String {
    format!("{request}:tool:{call}")
}

struct ExecutionBodyPreparation {
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
    frozen_request: Option<Value>,
}
struct PreparedExecutionBodies {
    _publication: crate::content::ContentPublication,
    request: Option<Value>,
    tools_ref: Option<Value>,
    policy_checkpoint: Option<super::policy_checkpoint::PolicyCheckpointReferences>,
    policy_continuation: Option<Value>,
    calls: std::collections::HashMap<String, ToolCallMetadata>,
    admitted: std::collections::HashMap<String, ToolIntent>,
    frozen_history_range: Option<HistoryRange>,
    memory_deliveries: Option<super::memory::PreparedMemoryDeliveries>,
    history: std::collections::HashMap<String, Value>,
    originals: Option<Vec<ProviderOriginal>>,
    output: Option<Value>,
    receipts: std::collections::HashMap<String, ToolReceiptMetadata>,
    completion: Option<ToolCompletionMetadata>,
    results: std::collections::HashMap<String, OperationResultMetadata>,
}
impl ExecutionBodyPreparation {
    fn write(self, record: &ExecutionRecord) -> Result<PreparedExecutionBodies> {
        let request = match record {
            ExecutionRecord::RequestPrepared { snapshot } => {
                Some(self.content.save(&serde_json::to_value(snapshot)?)?)
            }
            _ => None,
        };
        let tools_ref = match record {
            ExecutionRecord::RequestPrepared { snapshot } => Some(
                self.content
                    .save(&serde_json::to_value(&snapshot.view.binding.tools)?)?,
            ),
            _ => None,
        };
        let policy_checkpoint = match record {
            ExecutionRecord::PolicyCheckpoint {
                state,
                previous_state,
                action,
                event,
                ..
            } => Some(
                super::policy_checkpoint::PolicyCheckpointReferences::write(
                    &self.content,
                    state,
                    action,
                )?
                .with_previous_state(&self.content, previous_state)?
                .with_continuation(&self.content, event)?,
            ),
            _ => None,
        };
        let policy_continuation = if let ExecutionRecord::PolicyDecisionConsumed { event } = record
        {
            Some(self.content.save(&serde_json::to_value(event)?)?)
        } else {
            None
        };
        let mut calls = std::collections::HashMap::new();
        let mut admitted = std::collections::HashMap::new();
        match record {
            ExecutionRecord::ModelFinished { items, .. } => {
                for item in items {
                    if let Content::ToolCall { call } = &item.content {
                        calls.insert(
                            call.call_id.clone(),
                            ToolCallMetadata::write(&self.content, call)?,
                        );
                    }
                }
            }
            ExecutionRecord::ToolAdmitted { context, tool } => {
                let intent = ToolIntent::write(&self.content, &context.origin, tool)?;
                calls.insert(tool.call.call_id.clone(), intent.call().clone());
                admitted.insert(tool.call.call_id.clone(), intent);
            }
            _ => (),
        }
        let snapshot: Option<RequestSnapshot> = self
            .frozen_request
            .as_ref()
            .map(|reference| {
                self.content
                    .load(reference)
                    .and_then(|value| Ok(serde_json::from_value(value)?))
            })
            .transpose()?;
        let frozen_history_range = snapshot
            .as_ref()
            .map(|snapshot| snapshot.view.binding.history_range.clone());
        let memory_deliveries = match record {
            ExecutionRecord::RequestPrepared { snapshot } => {
                Some(super::memory::PreparedMemoryDeliveries::prepare(snapshot)?)
            }
            ExecutionRecord::ModelDispatched { .. }
            | ExecutionRecord::ModelFinished {
                outcome: ModelOutcome::Completed,
                ..
            } => Some(super::memory::PreparedMemoryDeliveries::prepare(
                snapshot.as_ref().ok_or_else(|| {
                    RuntimeError::Invalid("memory delivery request missing".into())
                })?,
            )?),
            _ => None,
        };
        let mut history = std::collections::HashMap::new();
        for item in history_items(record) {
            let provider = item.opaque.as_ref().map(|o| ProviderOriginal {
                connection_identity: o.connection_identity.clone(),
                adapter: o.family.clone(),
                version: o.adapter_version.clone(),
                item: o.value.clone(),
            });
            history.insert(
                item.id.clone(),
                self.content
                    .save_history(&serde_json::to_value(&item)?, &provider)?,
            );
        }
        let (originals, output) = if let ExecutionRecord::ModelFinished { items, .. } = record {
            (
                Some(self.content.save_originals(&provider_originals(items))?),
                Some(
                    self.content
                        .save(&json!({"status":"committed","record":record}))?,
                ),
            )
        } else {
            (None, None)
        };
        let mut receipts = std::collections::HashMap::new();
        let mut results = std::collections::HashMap::new();
        let tool_results: &[ToolResult] = match record {
            ExecutionRecord::ToolBatchCommitted { results, .. } => results,
            _ => &[],
        };
        for result in tool_results {
            let receipt = ToolReceiptMetadata::write(&self.content, result)?;
            let body = match &result.completion {
                ToolCompletion::Result { .. } => match &receipt.completion {
                    ToolCompletionMetadata::Result { content_ref, .. } => {
                        OperationResultMetadata::Content {
                            reference: content_ref.clone(),
                        }
                    }
                    _ => unreachable!(),
                },
                ToolCompletion::NotDispatched { reason } => OperationResultMetadata::Content {
                    reference: self.content.save(&json!({"not_dispatched":reason}))?,
                },
                ToolCompletion::JobAccepted {
                    operation_id,
                    phase,
                    ..
                } => OperationResultMetadata::Control {
                    value: json!({"operation_id":operation_id,"phase":phase}),
                },
            };
            results.insert(result.call_id.clone(), body);
            receipts.insert(result.call_id.clone(), receipt);
        }
        let completion = if let ExecutionRecord::ToolSettled { completion, .. } = record {
            let receipt = ToolCompletionMetadata::write(&self.content, completion)?;
            let body = match completion {
                ToolCompletion::Result { .. } => match &receipt {
                    ToolCompletionMetadata::Result { content_ref, .. } => {
                        OperationResultMetadata::Content {
                            reference: content_ref.clone(),
                        }
                    }
                    _ => unreachable!(),
                },
                ToolCompletion::NotDispatched { reason } => OperationResultMetadata::Content {
                    reference: self.content.save(&json!({"not_dispatched":reason}))?,
                },
                ToolCompletion::JobAccepted {
                    operation_id,
                    phase,
                    ..
                } => OperationResultMetadata::Control {
                    value: json!({"operation_id":operation_id,"phase":phase}),
                },
            };
            results.insert("invocation".into(), body);
            Some(receipt)
        } else {
            None
        };
        Ok(PreparedExecutionBodies {
            _publication: self.publication,
            request,
            tools_ref,
            policy_checkpoint,
            policy_continuation,
            calls,
            admitted,
            frozen_history_range,
            memory_deliveries,
            history,
            originals,
            output,
            receipts,
            results,
            completion,
        })
    }
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
    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn commit_execution(
        &mut self,
        run_id: &str,
        epoch: u64,
        record: &ExecutionRecord,
    ) -> Result<()> {
        let _synchronous = self.content.begin_synchronous()?;
        let prepared = self.prepare_execution_bodies(record)?.write(record)?;
        self.commit_prepared_execution(run_id, epoch, record, prepared)
    }
    fn prepare_execution_bodies(
        &self,
        record: &ExecutionRecord,
    ) -> Result<ExecutionBodyPreparation> {
        let frozen_request = match record {
            ExecutionRecord::ModelFinished { request_id, .. }
            | ExecutionRecord::ModelDispatched { request_id } => {
                Some(super::record::<ModelStep>(&self.db, "model_steps", request_id)?.request)
            }
            _ => None,
        };
        Ok(ExecutionBodyPreparation {
            content: self.content.clone(),
            publication: self.content.begin_publication(),
            frozen_request,
        })
    }
    fn commit_prepared_execution(
        &mut self,
        run_id: &str,
        epoch: u64,
        record: &ExecutionRecord,
        prepared: PreparedExecutionBodies,
    ) -> Result<()> {
        let PreparedExecutionBodies {
            _publication,
            request: prepared_request,
            tools_ref,
            policy_checkpoint,
            policy_continuation,
            calls: prepared_calls,
            admitted: prepared_admitted,
            frozen_history_range,
            memory_deliveries,
            history: prepared_history,
            originals: prepared_originals,
            output: prepared_output,
            receipts: prepared_receipts,
            results: prepared_results,
            completion: prepared_completion,
        } = prepared;
        // A receipt retry confirms the original completion. Keep exact request/owner fencing,
        // reject altered output, and never rewrite history or resubmit a provider request.
        if let ExecutionRecord::ModelFinished {
            request_id,
            outcome,
            ..
        } = record
        {
            let previous: Option<String> = self
                .db
                .query_row(
                    "SELECT body FROM model_outputs WHERE request_id=?1",
                    [request_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(previous) = previous {
                let run = self.run(run_id)?;
                let step: ModelStep = super::record(&self.db, "model_steps", request_id)?;
                let expected_state = match outcome {
                    ModelOutcome::Completed => ModelStepState::Completed,
                    ModelOutcome::Interrupted => ModelStepState::Interrupted,
                    ModelOutcome::Failed => ModelStepState::Failed,
                    ModelOutcome::Cancelled => ModelStepState::Cancelled,
                };
                if run.epoch == epoch
                    && step.id == *request_id
                    && step.run_id == run_id
                    && step.epoch == epoch
                    && step.state == expected_state
                    && Some(serde_json::from_str::<Value>(&previous)?) == prepared_output
                {
                    return Ok(());
                }
                return Err(RuntimeError::Conflict(
                    "model completion receipt changed or belongs to another execution".into(),
                ));
            }
        }
        // Bodies are already durable. Only ownership, revisions and reference publication remain.
        let tx = self.db.transaction()?;
        let mut run: Run = record_value(&tx, run_id)?;
        fence(&run, epoch)?;
        let referenced_request = match record {
            ExecutionRecord::ModelDispatched { request_id }
            | ExecutionRecord::ModelFinished { request_id, .. }
            | ExecutionRecord::ToolBatchCommitted { request_id, .. } => Some(request_id.as_str()),
            ExecutionRecord::ToolAdmitted { context, .. }
            | ExecutionRecord::ToolDispatched { context, .. }
            | ExecutionRecord::ToolSettled { context, .. } => match &context.origin {
                ToolOrigin::ModelStep { request_id } => Some(request_id.as_str()),
                ToolOrigin::PolicyAction { .. } => None,
            },
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
            ExecutionRecord::RequestPrepared { snapshot } => super::memory::record_deliveries(
                &tx,
                memory_deliveries.ok_or_else(|| {
                    RuntimeError::Invalid("prepared memory delivery missing".into())
                })?,
                &run,
                &snapshot.view.request_id,
                DeliveryState::Selected,
            )?,
            ExecutionRecord::ModelDispatched { request_id } => super::memory::record_deliveries(
                &tx,
                memory_deliveries.ok_or_else(|| {
                    RuntimeError::Invalid("prepared memory delivery missing".into())
                })?,
                &run,
                request_id,
                DeliveryState::Sent,
            )?,
            ExecutionRecord::ModelFinished {
                request_id,
                outcome: ModelOutcome::Completed,
                ..
            } => super::memory::record_deliveries(
                &tx,
                memory_deliveries.ok_or_else(|| {
                    RuntimeError::Invalid("prepared memory delivery missing".into())
                })?,
                &run,
                request_id,
                DeliveryState::Committed,
            )?,
            _ => (),
        }
        match record {
            ExecutionRecord::StateChanged { .. }
            | ExecutionRecord::ContextPreparationFailed { .. } => {
                let (state, waiting_on) = match record {
                    ExecutionRecord::StateChanged { state, waiting_on } => (state, waiting_on),
                    ExecutionRecord::ContextPreparationFailed { .. } => (&RunState::Failed, &None),
                    _ => unreachable!(),
                };
                if *state != run.state && !run.state.permits(*state) {
                    return Err(RuntimeError::Invalid(
                        "illegal executor run transition".into(),
                    ));
                }
                if run.state == RunState::Waiting
                    && *state == RunState::Runnable
                    && !super::policy_control::run_startable(&tx, &run)?
                {
                    return Err(RuntimeError::Conflict(
                        "Run is waiting on another durable condition".into(),
                    ));
                }
                if *state == RunState::Waiting {
                    if let Some(key) = waiting_on {
                        let wait: Wait = super::record(&tx, "waits", key)?;
                        if wait.run_id != run.id
                            || (wait.cancelled
                                && !super::collaboration::pending_cancelled_observation(
                                    &tx, &run, &wait,
                                )?)
                        {
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
                    super::policy_switch::close_run_candidate(&tx, run_id, run.revision + 1)?;
                    if matches!(state, RunState::Cancelled | RunState::Failed) {
                        super::questions::cancel_run_questions(&tx, run_id)?;
                        super::policy_control::cancel_run_pause(&tx, &run)?;
                    }
                    if matches!(state, RunState::Completed | RunState::Failed)
                        && super::inputs::has_boundary_inputs(&tx, run_id)?
                    {
                        return Err(RuntimeError::InputPending);
                    }

                    let unsettled: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM operations WHERE run_id=?1 AND json_extract(body,'$.phase')!='terminal' AND json_extract(body,'$.handed_off')=0)",
                        [run_id], |row| row.get(0),
                    )?;
                    if unsettled {
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
                if matches!(record, ExecutionRecord::StateChanged { .. })
                    && matches!(
                        state,
                        RunState::Waiting | RunState::Completed | RunState::Failed
                    )
                {
                    super::policy_checkpoint::consume(&tx, run_id)?;
                }
                run.state = *state;
                run.waiting_on = waiting_on.clone();
                run.revision += 1;
                put(&tx, "runs", run_id, &run)?;
            }
            ExecutionRecord::RequestPrepared { snapshot } => {
                if let Some(launch) = optional_record::<super::launch_content::LaunchMetadata>(
                    &tx,
                    "run_launches",
                    run_id,
                )? {
                    if launch.selection.tool_schema_generation
                        != snapshot.view.binding.tool_schema_generation
                        || Some(&launch.selection.tools_ref) != tools_ref.as_ref()
                    {
                        return Err(RuntimeError::Conflict(
                            "request differs from the activated tool composition".into(),
                        ));
                    }
                }
                let graph_pending = super::policy_body::has_pending_action(&tx, run_id)?;
                if graph_pending {
                    return Err(RuntimeError::Conflict("policy action is unsettled".into()));
                }
                if super::inputs::has_boundary_inputs(&tx, run_id)? {
                    return Err(RuntimeError::InputPending);
                }

                if !matches!(&snapshot.view.origin, RequestOrigin::Conversation{history_range,..} if history_range == &snapshot.view.binding.history_range)
                {
                    return Err(RuntimeError::Invalid(
                        "conversation request origin mismatch".into(),
                    ));
                }
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
                if let Some(parent_id) = super::context_jobs::context_job_parent(&tx, run_id)? {
                    let parent: Run = super::record(&tx, "runs", &parent_id)?;
                    if parent.cancel_requested || parent.state == RunState::Cancelled {
                        return Err(RuntimeError::Conflict(
                            "context job owner was cancelled".into(),
                        ));
                    }
                }
                let interrupt:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM input_queue WHERE run_id=?1 AND state='queued' AND mode='interrupt')",[run_id],|row|row.get(0))?;
                if interrupt {
                    return Err(RuntimeError::InputPending);
                }

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
                let history_range = frozen_history_range.as_ref().ok_or_else(|| {
                    RuntimeError::Invalid("frozen request history range missing".into())
                })?;
                let head: Option<String> = tx.query_row(
                    "SELECT head FROM branches WHERE id=?1",
                    [&run.branch_id],
                    |r| r.get(0),
                )?;
                if *outcome == ModelOutcome::Completed && head != history_range.leaf_id {
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
                step.original = prepared_originals.ok_or_else(|| {
                    RuntimeError::Invalid("prepared model originals missing".into())
                })?;
                step.usage = Some(serde_json::to_value(usage)?);
                put(&tx, "model_steps", request_id, &step)?;
                tx.execute(
                    "UPDATE model_steps SET state=?2 WHERE id=?1",
                    params![request_id, encode(&step.state)?.trim_matches('"')],
                )?;
                // Completion, original output, semantic history and unresolved call identities commit together.
                if *outcome == ModelOutcome::Completed {
                    for item in items {
                        let history_id = model_history_id(request_id, &item.id);
                        append_item(
                            &tx,
                            &run,
                            &history_id,
                            HistorySource::Assistant,
                            prepared_history.get(&history_id).ok_or_else(|| {
                                RuntimeError::Invalid("prepared history body missing".into())
                            })?,
                        )?;
                        if let Content::ToolCall { call } = &item.content {
                            tx.execute(
                                "INSERT INTO tool_calls(request_id,call_id,body) VALUES(?1,?2,?3)",
                                params![
                                    request_id,
                                    call.call_id,
                                    encode(prepared_calls.get(&call.call_id).ok_or_else(
                                        || RuntimeError::Invalid(
                                            "prepared call identity missing".into()
                                        )
                                    )?)?
                                ],
                            )?;
                        }
                    }
                }
                tx.execute(
                    "INSERT INTO model_outputs(request_id,body) VALUES(?1,?2)",
                    params![
                        request_id,
                        encode(&prepared_output.ok_or_else(|| RuntimeError::Invalid(
                            "prepared model output missing".into()
                        ))?)?
                    ],
                )?;
            }
            ExecutionRecord::ToolAdmitted { context, tool } => {
                if context.run_id != run_id
                    || context.operation_id != context.origin.operation_id(&tool.call.call_id)
                {
                    return Err(RuntimeError::Conflict(
                        "tool invocation owner changed".into(),
                    ));
                }
                let intent = prepared_admitted
                    .get(&tool.call.call_id)
                    .ok_or_else(|| RuntimeError::Invalid("prepared tool intent missing".into()))?;
                let expected = match &context.origin {
                    ToolOrigin::ModelStep { request_id } => tx.query_row(
                        "SELECT body FROM tool_calls WHERE request_id=?1 AND call_id=?2",
                        params![request_id, tool.call.call_id],
                        |row| row.get::<_, String>(0),
                    )?,
                    ToolOrigin::PolicyAction { action_id, node_id } => {
                        let graph: Operation = super::record(&tx, "operations", action_id)?;
                        if graph.run_id != run_id
                            || graph.epoch != epoch
                            || graph.phase == OperationPhase::Terminal
                            || super::policy::graph_metadata(&graph)?.is_none()
                            || node_id != &tool.call.call_id
                        {
                            return Err(RuntimeError::Conflict(
                                "policy invocation no longer admitted".into(),
                            ));
                        }
                        tx.query_row("SELECT call FROM policy_graph_nodes WHERE action_id=?1 AND node_id=?2 AND receipt IS NULL",params![action_id,node_id],|row|row.get::<_,String>(0))?
                    }
                };
                if serde_json::from_str::<ToolCallMetadata>(&expected)? != *intent.call()
                    || tool.contract.name != tool.call.name
                    || tool.contract.schema_version != tool.call.schema_version
                {
                    return Err(RuntimeError::Conflict(
                        "tool call changed since admission".into(),
                    ));
                }
                let key = &context.operation_id;
                if let Some(mut previous) = optional_record::<Operation>(&tx, "operations", key)? {
                    if previous.run_id != run_id
                        || previous.phase != OperationPhase::Accepted
                        || previous.effect != Effect::None
                        || previous.intent != serde_json::to_value(intent)?
                        || previous.call_completion.is_some()
                    {
                        return Err(RuntimeError::Conflict(
                            "tool admission cannot replace an existing effect or contract".into(),
                        ));
                    }
                    previous.epoch = epoch;
                    put(&tx, "operations", key, &previous)?;
                } else {
                    let op = Operation {
                        external_receipt: None,
                        call_completion: None,
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
                        execution_owner: None,
                        waiting_on: None,
                        intent: serde_json::to_value(intent)?,
                        result: None,
                    };
                    tx.execute(
                        "INSERT INTO operations(id,run_id,body) VALUES(?1,?2,?3)",
                        params![key, run_id, encode(&op)?],
                    )?;
                }
            }
            ExecutionRecord::ToolDispatched {
                context,
                executor_owner,
            } => {
                let key = context.operation_id.clone();
                let mut op: Operation = super::record(&tx, "operations", &key)?;
                if op.run_id != run_id || op.epoch != epoch || op.phase != OperationPhase::Accepted
                {
                    return Err(RuntimeError::Conflict("tool no longer admitted".into()));
                }
                if op.cancel_requested || run.cancel_requested {
                    return Err(RuntimeError::DispatchCancelled);
                }
                let tool: ToolIntent = serde_json::from_value(op.intent.clone())?;
                if context.run_id != run_id
                    || tool.origin() != &context.origin
                    || key != context.origin.operation_id(&tool.call().call_id)
                {
                    return Err(RuntimeError::Conflict(
                        "tool dispatch origin changed".into(),
                    ));
                }
                if let ToolOrigin::PolicyAction { action_id, .. } = &context.origin {
                    let graph: Operation = super::record(&tx, "operations", action_id)?;
                    if graph.epoch != epoch {
                        return Err(RuntimeError::Conflict(
                            "policy graph generation changed".into(),
                        ));
                    }
                    if graph.cancel_requested {
                        return Err(RuntimeError::DispatchCancelled);
                    }
                }
                op.phase = OperationPhase::Running;
                op.effect = if tool.contract().read_only {
                    Effect::None
                } else {
                    Effect::Dispatched
                };
                op.revision += 1;
                if !executor_owner.validate() {
                    return Err(RuntimeError::Invalid(
                        "tool executor owner is invalid".into(),
                    ));
                }
                op.executor = Some(tool.call().name.clone());
                op.execution_owner = Some(executor_owner.clone());
                tx.execute(
                    "INSERT INTO resource_occupancy(operation_id,claims) VALUES(?1,?2)",
                    params![key, encode(&tool.contract().resources)?],
                )?;
                put(&tx, "operations", &key, &op)?;
            }
            ExecutionRecord::ToolSettled {
                context,
                completion,
                executor_stopped,
            } => {
                let key = context.operation_id.clone();
                let mut op: Operation = super::record(&tx, "operations", &key)?;
                let invocation = ToolIntent::from_operation(&op)?;
                if op.run_id != run_id
                    || op.epoch != epoch
                    || context.run_id != run_id
                    || invocation.origin() != &context.origin
                {
                    return Err(RuntimeError::Conflict("tool completion is stale".into()));
                }
                let prepared_result = prepared_results
                    .get("invocation")
                    .ok_or_else(|| RuntimeError::Invalid("prepared tool result missing".into()))?;
                let receipt = prepared_completion.as_ref().ok_or_else(|| {
                    RuntimeError::Invalid("prepared tool completion missing".into())
                })?;
                if let Some(previous) = &op.call_completion {
                    if previous != receipt {
                        return Err(RuntimeError::Conflict(
                            "original invocation completion changed".into(),
                        ));
                    }
                    tx.commit()?;
                    self.release_stopped_resource_owner(&key)?;
                    return Ok(());
                }
                // Settle the permission rendezvous even when cancellation prevented a decision.
                if let Some(wait_id) = op
                    .waiting_on
                    .clone()
                    .filter(|id| id.starts_with("permission:"))
                {
                    let mut wait: Wait = super::record(&tx, "waits", &wait_id)?;
                    if wait.trigger_cursor.is_none() {
                        wait.cancelled = true;
                    }
                    put(&tx, "waits", &wait_id, &wait)?;
                    op.waiting_on = None;
                }
                match completion {
                    ToolCompletion::NotDispatched { reason } => {
                        op.phase = OperationPhase::Terminal;
                        op.outcome = Some(if reason == "cancelled" {
                            Outcome::Cancelled
                        } else {
                            Outcome::Failed
                        });
                        op.effect = Effect::None;
                        op.result = Some(prepared_result.clone());
                    }
                    ToolCompletion::Result {
                        outcome,
                        effect,
                        content: _,
                    } => {
                        // Dispatched work may prove a genuine no-effect terminal result (for
                        // example an owner's CAS conflict). Only the already authenticated
                        // executor receipt can supply that evidence; tool JSON alone cannot.
                        let confirmed_no_effect = confirmed_no_effect_receipt(
                            &op,
                            *outcome,
                            prepared_result.reference()?,
                        );
                        if (*effect == Effect::None
                            && op.effect != Effect::None
                            && !confirmed_no_effect)
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
                        op.result = Some(prepared_result.clone());
                        if *effect == Effect::Unknown && *outcome != Outcome::Indeterminate {
                            return Err(RuntimeError::Invalid(
                                "unknown effects require reconciliation".into(),
                            ));
                        }
                    }
                    ToolCompletion::JobAccepted {
                        operation_id,
                        phase: _,
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
                        op.result = Some(prepared_result.clone());
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
                // Caller completion and physical execution are independent. A cancelled Host
                // waiter can return an unknown Result while its original broker/remote call lives.
                if *executor_stopped {
                    tx.execute(
                        "DELETE FROM resource_occupancy WHERE operation_id=?1",
                        [&key],
                    )?;
                }
                op.call_completion = Some(receipt.clone());
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
                if let ToolOrigin::ModelStep { request_id } = &context.origin {
                    let paired = ToolReceiptMetadata {
                        request_id: request_id.clone(),
                        call_id: invocation.call().call_id.clone(),
                        completion: receipt.clone(),
                    };
                    tx.execute(
                        "UPDATE tool_calls SET receipt=?3 WHERE request_id=?1 AND call_id=?2",
                        params![request_id, invocation.call().call_id, encode(&paired)?],
                    )?;
                }
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
                    let receipt = prepared_receipts.get(&result.call_id).ok_or_else(|| {
                        RuntimeError::Invalid("prepared tool receipt missing".into())
                    })?;
                    let prepared_result =
                        prepared_results.get(&result.call_id).ok_or_else(|| {
                            RuntimeError::Invalid("prepared tool result missing".into())
                        })?;
                    let serialized_result = encode(receipt)?;
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
                    let key = operation_id(request_id, &result.call_id);
                    if let Some(mut op) = optional_record::<Operation>(&tx, "operations", &key)? {
                        if op
                            .call_completion
                            .as_ref()
                            .is_some_and(|completion| completion != &receipt.completion)
                        {
                            return Err(RuntimeError::Conflict(
                                "model pairing must consume canonical invocation completion".into(),
                            ));
                        }
                        if op.call_completion.is_none() && op.phase == OperationPhase::Terminal {
                            if !matches!(&receipt.completion,ToolCompletionMetadata::Result{outcome,effect,content_ref} if Some(*outcome)==op.outcome && *effect==op.effect && op.result.as_ref()==Some(&OperationResultMetadata::Content{reference:content_ref.clone()}))
                            {
                                return Err(RuntimeError::Conflict(
                                    "recovered completion differs from executor terminal".into(),
                                ));
                            }
                            op.call_completion = Some(receipt.completion.clone());
                            put(&tx, "operations", &key, &op)?;
                        }
                        if op.phase == OperationPhase::Accepted && op.effect == Effect::None {
                            let closure = match &result.completion {
                                ToolCompletion::NotDispatched { .. } => Some(Outcome::Failed),
                                ToolCompletion::Result {
                                    outcome: outcome @ (Outcome::Cancelled | Outcome::Failed),
                                    effect: Effect::None,
                                    ..
                                } => Some(*outcome),
                                _ => None,
                            };
                            if let Some(outcome) = closure {
                                op.call_completion = Some(receipt.completion.clone());
                                op.phase = OperationPhase::Terminal;
                                op.outcome = Some(outcome);
                                op.result = Some(prepared_result.clone());
                                op.revision += 1;
                                put(&tx, "operations", &key, &op)?;
                                event(
                                    &tx,
                                    &key,
                                    op.revision,
                                    "operation.settled",
                                    serde_json::to_value(&op)?,
                                )?;
                            }
                        }
                    }
                    tx.execute("UPDATE tool_calls SET receipt=?3,committed=1 WHERE request_id=?1 AND call_id=?2",params![request_id,result.call_id,serialized_result])?;
                    append_item(
                        &tx,
                        &run,
                        &format!("{}:result:{}", request_id, result.call_id),
                        HistorySource::Tool,
                        prepared_history
                            .get(&format!("{}:result:{}", request_id, result.call_id))
                            .ok_or_else(|| {
                                RuntimeError::Invalid("prepared tool history body missing".into())
                            })?,
                    )?;
                }
            }
            ExecutionRecord::PolicyDecisionConsumed { .. } => {
                let continuation = policy_continuation.as_ref().ok_or_else(|| {
                    RuntimeError::Invalid("prepared policy continuation missing".into())
                })?;
                super::policy_checkpoint::consume(&tx, run_id)?;
                tx.execute(
                    "UPDATE policy_checkpoints SET continuation_ref=?2 WHERE run_id=?1",
                    params![run_id, encode(continuation)?],
                )?;
            }
            ExecutionRecord::PolicyCheckpoint {
                identity, action, ..
            } => {
                let saved: Option<String> = tx
                    .query_row(
                        "SELECT identity FROM policy_checkpoints WHERE run_id=?1",
                        [run_id],
                        |r| r.get(0),
                    )
                    .optional()?;
                if saved
                    .map(|raw| serde_json::from_str::<PolicyIdentity>(&raw))
                    .transpose()?
                    .is_some_and(|saved| saved != *identity)
                {
                    return Err(RuntimeError::Conflict("policy identity changed".into()));
                }
                if matches!(
                    action,
                    PolicyAction::ToolGraph { .. }
                        | PolicyAction::RequestModelJob { .. }
                        | PolicyAction::Deliver { .. }
                        | PolicyAction::Pause { .. }
                ) {
                    return Err(RuntimeError::Invalid(
                        "policy action checkpoint requires atomic action admission".into(),
                    ));
                }
                if let PolicyAction::Wait { wait_id } = action {
                    let wait: Wait = super::record(&tx, "waits", wait_id)?;
                    if wait.run_id != run_id
                        || (wait.cancelled
                            && !super::collaboration::pending_cancelled_observation(
                                &tx, &run, &wait,
                            )?)
                    {
                        return Err(RuntimeError::Conflict("policy wait unavailable".into()));
                    }
                }
                policy_checkpoint
                    .as_ref()
                    .ok_or_else(|| {
                        RuntimeError::Invalid("prepared policy checkpoint is missing".into())
                    })?
                    .publish_pending(&tx, run_id, identity)?;
            }
        }
        if matches!(
            record,
            ExecutionRecord::RequestPrepared { .. } | ExecutionRecord::ToolBatchCommitted { .. }
        ) {
            super::policy_checkpoint::consume(&tx, run_id)?;
        }
        if let ExecutionRecord::ContextPreparationFailed { failure } = record {
            event(
                &tx,
                run_id,
                run.revision,
                "context.preparation_failed",
                json!({"code": failure.code, "message": failure.message}),
            )?;
        }
        event(
            &tx,
            run_id,
            run.revision,
            "execution.committed",
            json!({"kind":match record {
                ExecutionRecord::StateChanged { .. } => "state_changed",
                ExecutionRecord::ContextPreparationFailed { .. } => "context_preparation_failed",
                ExecutionRecord::RequestPrepared { .. } => "request_prepared",
                ExecutionRecord::ModelDispatched { .. } => "model_dispatched",
                ExecutionRecord::ModelFinished { .. } => "model_finished",
                ExecutionRecord::ToolAdmitted { .. } => "tool_admitted",
                ExecutionRecord::ToolDispatched { .. } => "tool_dispatched",
                ExecutionRecord::ToolSettled { .. } => "tool_settled",
                ExecutionRecord::ToolBatchCommitted { .. } => "tool_batch_committed",
                ExecutionRecord::PolicyCheckpoint { .. } => "policy_checkpoint",
                ExecutionRecord::PolicyDecisionConsumed { .. } => "policy_decision_consumed",
            }}),
        )?;
        tx.commit()?;
        if let ExecutionRecord::ToolSettled { context, .. } = record {
            self.release_stopped_resource_owner(&context.operation_id)?;
        }
        if matches!(
            record,
            ExecutionRecord::ToolSettled { .. } | ExecutionRecord::ToolBatchCommitted { .. }
        ) {
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
    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn prepare_execution(
        &self,
        run_id: &str,
        binding: RequestBinding,
        policy: PolicyIdentity,
        initial_policy_state: Value,
    ) -> Result<ExecutionInput> {
        let _synchronous = self.content.begin_synchronous()?;
        self.capture_execution_preparation(
            run_id,
            binding,
            policy,
            initial_policy_state,
            false,
            false,
            false,
        )?
        .load()
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
        if run.state == RunState::Waiting && !super::policy_control::run_startable(&tx, &run)? {
            return Ok(());
        }
        let active: Option<String> = tx.query_row(
            "SELECT active_run FROM branches WHERE id=?1",
            [&run.branch_id],
            |row| row.get(0),
        )?;
        if active.as_deref() != Some(run_id) {
            return Err(RuntimeError::Conflict(
                "failed worker no longer owns its branch".into(),
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
        originals: Vec<ProviderOriginal>,
        output: Value,
    ) -> Result<()> {
        let ExecutionRecord::ModelFinished {
            request_id, usage, ..
        } = record
        else {
            return Ok(());
        };
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
    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn model_output(&self, request_id: &str) -> Result<Option<Value>> {
        let _synchronous = self.content.begin_synchronous()?;
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT body FROM model_outputs WHERE request_id=?1",
                [request_id],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|raw| self.content.load(&serde_json::from_str(&raw)?))
            .transpose()
    }
}

fn confirmed_no_effect_receipt(operation: &Operation, outcome: Outcome, content: &Value) -> bool {
    operation.external_receipt.as_ref().is_some_and(|receipt| {
        receipt.identity == operation.id
            && operation.executor.as_deref() == Some(receipt.executor.as_str())
            && receipt.outcome == outcome
            && receipt.effect == Effect::None
            && receipt.result_ref == *content
    })
}

pub(super) fn apply_external_terminal(op: &mut Operation, receipt: &ExternalReceiptMetadata) {
    op.phase = OperationPhase::Terminal;
    op.outcome = Some(receipt.outcome);
    op.effect = receipt.effect;
    op.result = Some(OperationResultMetadata::Content {
        reference: receipt.result_ref.clone(),
    });
}
impl Catalog {
    /// Only a trusted execution-end receipt consumer may call this. It is not exposed as a
    /// model/tool/Host wire command. Receipt identity belongs to the actual resource authority.
    /// The private Host bridge authenticates its original registered owner before reaching
    /// this entry. A new binding with the same tool name cannot settle the old execution.
    pub fn record_external_tool_receipt_prepared(
        &mut self,
        operation_id: &str,
        owner: &ExecutorOwner,
        prepared: super::result_content::PreparedExternalReceipt,
        executor_stopped: bool,
    ) -> Result<Operation> {
        let operation = self.operation(operation_id)?;
        ToolIntent::from_operation(&operation)?;
        if !matches!(owner, ExecutorOwner::External { .. })
            || operation.execution_owner.as_ref() != Some(owner)
        {
            return Err(RuntimeError::Conflict(
                "external receipt execution owner changed".into(),
            ));
        }
        self.record_external_receipt_prepared(operation_id, prepared, executor_stopped)
    }

    pub fn record_external_receipt_prepared(
        &mut self,
        operation_id: &str,
        prepared: super::result_content::PreparedExternalReceipt,
        executor_stopped: bool,
    ) -> Result<Operation> {
        let receipt = prepared.receipt;
        let tx = self.db.transaction()?;
        let mut op: Operation = super::record(&tx, "operations", operation_id)?;
        if super::policy_body::PolicyActionMetadata::from_operation(&op)?.is_some() {
            return Err(RuntimeError::Invalid(
                "policy actions cannot accept external executor receipts".into(),
            ));
        }
        if receipt.identity != op.id
            || op.executor.as_deref() != Some(receipt.executor.as_str())
            || receipt.epoch.is_empty()
            || matches!(&op.execution_owner, Some(ExecutorOwner::External { epoch, .. }) if epoch != &receipt.epoch)
        {
            return Err(RuntimeError::Conflict(
                "external receipt does not identify this admitted operation".into(),
            ));
        }
        if receipt.effect == Effect::Unknown && receipt.outcome != Outcome::Indeterminate {
            return Err(RuntimeError::Invalid(
                "unknown external effect requires indeterminate outcome".into(),
            ));
        }
        let settle = op.handed_off
            || (op.phase == OperationPhase::Terminal && op.outcome == Some(Outcome::Indeterminate));
        if let Some(previous) = &op.external_receipt {
            if previous == &receipt {
                // The receipt can precede ToolSettled/handoff and survive a crash. Recovery's
                // uncertain Operation is not proof that this already-known fact was applied.
                let applied = op.phase == OperationPhase::Terminal
                    && op.outcome == Some(receipt.outcome)
                    && op.effect == receipt.effect
                    && op.result.as_ref()
                        == Some(&OperationResultMetadata::Content {
                            reference: receipt.result_ref.clone(),
                        });
                if settle && !applied {
                    apply_external_terminal(&mut op, &receipt);
                    op.revision += 1;
                    put(&tx, "operations", operation_id, &op)?;
                    event(
                        &tx,
                        operation_id,
                        op.revision,
                        "operation.settled",
                        serde_json::to_value(&op)?,
                    )?;
                }
                // Stop evidence may arrive after an identical uncertain business receipt.
                if executor_stopped {
                    tx.execute(
                        "DELETE FROM resource_occupancy WHERE operation_id=?1",
                        [operation_id],
                    )?;
                }
                tx.commit()?;
                self.release_stopped_resource_owner(operation_id)?;
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
        if op.phase == OperationPhase::Terminal
            && op.outcome != Some(Outcome::Indeterminate)
            && (op.outcome != Some(receipt.outcome)
                || op.effect != receipt.effect
                || op.result.as_ref()
                    != Some(&OperationResultMetadata::Content {
                        reference: receipt.result_ref.clone(),
                    }))
        {
            return Err(RuntimeError::Conflict(
                "job is already settled with another receipt".into(),
            ));
        }
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
        if executor_stopped {
            tx.execute(
                "DELETE FROM resource_occupancy WHERE operation_id=?1",
                [operation_id],
            )?;
        }
        tx.commit()?;
        self.release_stopped_resource_owner(operation_id)?;
        self.reconcile_waits()?;
        Ok(op)
    }

    /// Called only after the child supervisor joined and Storage proved the exact private
    /// root has no live writer leases. Unknown business effects remain unknown.
    pub fn confirm_child_file_writers_stopped(&mut self, child_operation_id:&str)->Result<()> {
        let child=self.child_task(child_operation_id)?;
        let run=child.receipt.as_ref().ok_or_else(||RuntimeError::Conflict("child Run missing".into()))?;
        if !self.run(&run.run_id)?.state.terminal(){return Err(RuntimeError::Conflict("child Run is not terminal".into()));}
        let operations=self.pending_run_operations(&run.run_id)?.into_iter()
            .filter(|operation|matches!(operation.executor.as_deref(),Some("file_write"|"file_edit"))).collect::<Vec<_>>();
        let tx=self.db.transaction()?;
        let mut released=0;
        for operation in &operations {released+=tx.execute("DELETE FROM resource_occupancy WHERE operation_id=?1",[&operation.id])?;}
        if released>0{event(&tx,child_operation_id,child.revision,"child.writers_stopped",Value::Null)?;}
        tx.commit()?;
        for operation in &operations {self.release_stopped_resource_owner(&operation.id)?;}
        Ok(())
    }
    fn release_stopped_resource_owner(&self, owner: &str) -> Result<()> {
        let occupied: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM resource_occupancy WHERE operation_id=?1)",
            [owner],
            |r| r.get(0),
        )?;
        if !occupied {
            self.resource_admission.release(owner);
        }
        Ok(())
    }
}

impl Catalog {
    /// Resource recovery queries only the jobs whose facts are still unresolved.
    pub fn pending_run_operations(&self, run_id: &str) -> Result<Vec<Operation>> {
        let mut statement=self.db.prepare("SELECT body FROM operations WHERE run_id=?1 AND (json_extract(body,'$.phase')!='terminal' OR json_extract(body,'$.outcome')='indeterminate') ORDER BY id")?;
        let rows = statement.query_map([run_id], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
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
