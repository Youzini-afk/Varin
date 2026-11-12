//! Read-only Catalog work bypasses the command actor and its writer mutex.
use super::*;
use base64::Engine as _;
use std::sync::RwLock;
use varin_runtime::catalog::context_observations::{
    ContextObservationImportPosition, ContextObservationImportSources, ContextObservationRead,
    ContextObservationReceiptLookup, ContextObservationSnapshot, ContextObservationSources,
};
use varin_runtime::catalog::knowledge_inference::KnowledgeInferenceReadParams;
use varin_runtime::catalog::model_text::ModelTextReadParams;

impl From<varin_runtime::RuntimeError> for KernelError {
    fn from(error: varin_runtime::RuntimeError) -> Self {
        domain(error)
    }
}

type ReadJob = (Value, Arc<AtomicBool>, Option<std::time::Instant>);
#[derive(Clone)]
pub(super) struct ReadPool {
    epoch: String,
    jobs: mpsc::Sender<ReadJob>,
}
pub(super) type SharedReaders = Arc<RwLock<Option<ReadPool>>>;

impl ReadPool {
    pub(super) fn start(
        catalog: &Catalog,
        runtime: Arc<RunSupervisor>,
        epoch: String,
        responses: crate::transport::Sender,
        finished: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Result<Self, KernelError> {
        let size = match std::env::var("VARIN_CATALOG_READERS") {
            Ok(value) => value
                .parse::<usize>()
                .ok()
                .filter(|value| *value > 0)
                .ok_or_else(|| {
                    KernelError::Protocol("VARIN_CATALOG_READERS must be a positive integer".into())
                })?,
            Err(std::env::VarError::NotPresent) => 4,
            Err(error) => return Err(KernelError::Protocol(error.to_string())),
        };
        let mut readers = Vec::with_capacity(size);
        for _ in 0..size {
            readers.push(catalog.read_view().map_err(domain)?);
        }
        let (jobs, receiver) = mpsc::channel::<ReadJob>();
        let receiver = Arc::new(Mutex::new(receiver));
        for (index, mut catalog) in readers.into_iter().enumerate() {
            let receiver = receiver.clone();
            let responses = responses.clone();
            let finished = finished.clone();
            let runtime = Arc::downgrade(&runtime);
            thread::Builder::new()
                .name(format!("catalog-read-{index}"))
                .spawn(move || {
                    loop {
                        let received = receiver
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .recv();
                        let Ok((mut value, cancelled, enqueued)) = received else {
                            break;
                        };
                        let id = value["id"].as_str().unwrap_or_default().to_owned();
                        let method = value["method"].as_str().unwrap_or_default().to_owned();
                        let params = value
                            .get_mut("params")
                            .map(Value::take)
                            .unwrap_or_else(|| json!({}));
                        let started = super::runtime_perf_start();
                        let queue_micros = enqueued.map(|time| time.elapsed().as_micros());
                        let result = (|| {
                            if cancelled.load(Ordering::Acquire) {
                                return Err(KernelError::Cancelled);
                            }
                            let value = catalog.read_snapshot(|catalog| {
                                dispatch_read(catalog, &runtime, &method, params, &cancelled)
                            })?;
                            if cancelled.load(Ordering::Acquire) {
                                return Err(KernelError::Cancelled);
                            }
                            Ok(value)
                        })();
                        super::runtime_perf_record("read", &method, started, queue_micros, Some(0));
                        let response = match result {
                            Ok(value) => response_ok(&id, value),
                            Err(error) => response_error(&id, &error),
                        };
                        finished(&id);
                        let _ = responses.send(response);
                    }
                })?;
        }
        Ok(Self { epoch, jobs })
    }
}

impl AgentControl {
    /// Returns false during initialization so the actor's existing dependency queue remains
    /// authoritative. An accepted request is taken exactly once, including on cancellation.
    pub(crate) fn read_request(
        &self,
        value: &mut Value,
        cancellation: Arc<AtomicBool>,
    ) -> Result<bool, KernelError> {
        let method = value
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !KERNEL_READ_METHODS.contains(&method) {
            return Ok(false);
        }
        let pool = self
            .readers
            .read()
            .map_err(|_| KernelError::Storage("Catalog readers unavailable".into()))?
            .clone();
        let Some(pool) = pool else {
            return Ok(false);
        };
        reject_unknown_fields(
            value,
            &["v", "kind", "id", "method", "params", "epoch", "grantId"],
            "runtime request",
        )?;
        if value.get("v").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
            || value.get("kind").and_then(Value::as_str) != Some("request")
            || value
                .get("id")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
        {
            return Err(KernelError::Protocol("invalid runtime envelope".into()));
        }
        if value.get("epoch").and_then(Value::as_str) != Some(&pool.epoch)
            || value.get("grantId").is_some()
        {
            return Err(KernelError::Authorization(
                "runtime commands require current Host management authority".into(),
            ));
        }
        pool.jobs
            .send((value.take(), cancellation, super::runtime_perf_start()))
            .map_err(|_| KernelError::Storage("Catalog reader pool stopped".into()))?;
        Ok(true)
    }
}

fn live_runtime(
    runtime: &std::sync::Weak<RunSupervisor>,
) -> Result<Arc<RunSupervisor>, KernelError> {
    runtime
        .upgrade()
        .ok_or_else(|| KernelError::Storage("Catalog owner stopped".into()))
}

fn dispatch_read(
    catalog: &mut Catalog,
    runtime: &std::sync::Weak<RunSupervisor>,
    method: &str,
    params: Value,
    cancelled: &Arc<AtomicBool>,
) -> Result<Value, KernelError> {
    let cancel = || cancelled.load(Ordering::Acquire);
    match method {
        "runtime.thread.view" => {
            let p: ThreadViewParams = serde_json::from_value(params)?;
            let limit = u32::try_from(p.history_limit)
                .map_err(|_| KernelError::Protocol("historyLimit must be positive".into()))?;
            let mut view = catalog
                .thread_view_cancellable(
                    &p.thread_id,
                    &p.branch_id,
                    limit,
                    p.after_head_id.as_deref(),
                    &cancel,
                )
                .map_err(domain)?;
            if let Some(launch) = view.get_mut("launch").filter(|value| !value.is_null()) {
                if let Some(run_id) = launch["run_id"].as_str() {
                    let available = live_runtime(runtime)?
                        .start_available(run_id)
                        .map_err(|e| KernelError::Operation(e.to_string()))?;
                    launch["startable"] =
                        json!(launch["startable"].as_bool().unwrap_or(false) && available);
                }
            }
            Ok(view)
        }
        "runtime.thread.inspectMany" => {
            let p: ThreadInspectManyParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog.inspect_threads(&p.thread_ids).map_err(domain)?,
            )?)
        }
        "runtime.ownership.resolve" => {
            let p: OwnershipResolveParams = serde_json::from_value(params)?;
            catalog
                .resolve_ownership(
                    &p.threads.unwrap_or_default(),
                    &p.runs.unwrap_or_default(),
                    &p.operations.unwrap_or_default(),
                    &p.inputs.unwrap_or_default(),
                )
                .map_err(domain)
        }
        "runtime.context.inspection" => {
            let p: ContextInspectionParams = serde_json::from_value(params)?;
            if catalog.branch_thread_id(&p.branch_id).map_err(domain)? != p.thread_id {
                return Err(KernelError::Authorization(
                    "Branch does not belong to the selected thread".into(),
                ));
            }
            catalog
                .context_inspection(&p.branch_id, p.head_id.0.as_deref())
                .map_err(domain)
        }
        "runtime.events.read" => {
            let p: EventsParams = serde_json::from_value(params)?;
            let cursor = u64::try_from(p.cursor)
                .map_err(|_| KernelError::Protocol("event cursor must be nonnegative".into()))?;
            let limit = u32::try_from(p.limit)
                .map_err(|_| KernelError::Protocol("event limit out of range".into()))?;
            let read = match p.principal_id {
                Some(principal) => {
                    catalog.capture_events_read_for_principal(cursor, limit, principal.as_deref())
                }
                None => catalog.capture_events_read(cursor, limit),
            }
            .map_err(domain)?;
            Ok(serde_json::to_value(read.load().map_err(domain)?)?)
        }
        "runtime.operation.inspect" => {
            let p: OperationInspectParams = serde_json::from_value(params)?;
            let op = match catalog.operation(&p.operation_id) {
                Ok(op) => op,
                Err(varin_runtime::RuntimeError::NotFound(_)) if p.allow_missing == Some(true) => {
                    return Ok(Value::Null);
                }
                Err(error) => return Err(domain(error)),
            };
            Ok(serde_json::to_value(
                catalog.capture_operation_read(op).load().map_err(domain)?,
            )?)
        }
        "runtime.operation.calls" => {
            let p: OperationParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog.nested_tool_calls(&p.operation_id).map_err(domain)?,
            )?)
        }
        "runtime.model.presentations" => {
            let p: varin_runtime::catalog::usage::ModelPresentationParams =
                serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .capture_model_presentations(&p.request_ids, p.include_context.unwrap_or(false))
                    .map_err(domain)?
                    .load(&cancel)
                    .map_err(domain)?,
            )?)
        }
        "runtime.thread.operations.active" => {
            let p: ThreadOperationsParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .active_thread_operations(&p.thread_id, p.branch_id.as_deref())
                    .map_err(domain)?
                    .into_iter()
                    .map(|op| catalog.capture_operation_read(op).load())
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(domain)?,
            )?)
        }
        "runtime.thread.usage" => {
            let p = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .capture_thread_usage(&p)
                    .map_err(domain)?
                    .load(&cancel)
                    .map_err(domain)?,
            )?)
        }
        "runtime.usage.summary" => {
            let p = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .capture_usage_summary(&p)
                    .map_err(domain)?
                    .load(&cancel)
                    .map_err(domain)?,
            )?)
        }
        "runtime.thread.attention.read" => {
            let p: PrincipalQuery = serde_json::from_value(params)?;
            let mut snapshot = catalog
                .capture_attention_read()
                .load_cancellable(cancelled.clone())
                .map_err(domain)?;
            if let Some(principal) = p.principal_id {
                catalog
                    .filter_attention_principal(&mut snapshot, principal.as_deref())
                    .map_err(domain)?;
            }
            Ok(serde_json::to_value(snapshot)?)
        }
        "runtime.input.list" => {
            let p: HistoryParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .capture_queued_inputs(&p.branch_id)
                    .map_err(domain)?
                    .into_iter()
                    .map(|read| read.load())
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(domain)?,
            )?)
        }
        "runtime.input.inspect" => {
            let p: InputHandleParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .capture_queued_input(&p.input_id)
                    .map_err(domain)?
                    .load()
                    .map_err(domain)?,
            )?)
        }
        "runtime.context.inspect" => {
            let p: ContextInspectParams = serde_json::from_value(params)?;
            catalog.head(&p.branch_id).map_err(domain)?;
            let read = match p.checkpoint_id {
                Some(id) => catalog.capture_context_checkpoint(&p.branch_id, &id),
                None => catalog.capture_active_checkpoint(&p.branch_id),
            }
            .map_err(domain)?;
            Ok(serde_json::to_value(
                read.map(|read| read.load()).transpose().map_err(domain)?,
            )?)
        }
        "runtime.context_job.list" => {
            let p: HistoryParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .capture_context_jobs(&p.branch_id)
                    .map_err(domain)?
                    .into_iter()
                    .map(|read| read.load())
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(domain)?,
            )?)
        }
        "runtime.context_job.inspect" => {
            let p: RunParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .capture_context_job(&p.run_id)
                    .map_err(domain)?
                    .load()
                    .map_err(domain)?,
            )?)
        }
        "runtime.model.inspect" => {
            let p: RunParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog.model_selections(&p.run_id).map_err(domain)?,
            )?)
        }
        "runtime.policy.inspect" => {
            let p: RunParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .policy_selections(&p.run_id)
                    .map_err(domain)?
                    .load()
                    .map_err(domain)?,
            )?)
        }
        "runtime.followup.list" => {
            let p: ThreadParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog.followups(&p.thread_id).map_err(domain)?,
            )?)
        }
        "runtime.goal.list" => {
            let p: ThreadParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .capture_goals(&p.thread_id)
                    .map_err(domain)?
                    .into_iter()
                    .map(|read| read.load())
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(domain)?,
            )?)
        }
        "runtime.launch.inspect" => {
            let p: RunParams = serde_json::from_value(params)?;
            let mut launch = catalog
                .capture_launch(&p.run_id)
                .map_err(domain)?
                .map(|read| read.load())
                .transpose()
                .map_err(domain)?;
            if let Some(launch) = &mut launch {
                launch.startable &= live_runtime(runtime)?
                    .start_available(&p.run_id)
                    .map_err(|e| KernelError::Operation(e.to_string()))?;
            }
            Ok(serde_json::to_value(launch)?)
        }
        "runtime.launch.list" => {
            let _: KernelEmptyParams = serde_json::from_value(params)?;
            let mut launches = catalog
                .capture_pending_launches()
                .map_err(domain)?
                .into_iter()
                .map(|read| read.load())
                .collect::<Result<Vec<_>, _>>()
                .map_err(domain)?;
            for launch in &mut launches {
                launch.startable &= live_runtime(runtime)?
                    .start_available(&launch.run_id)
                    .map_err(|e| KernelError::Operation(e.to_string()))?;
            }
            Ok(serde_json::to_value(launches)?)
        }
        "runtime.history.page" => {
            let p: HistoryPageParams = serde_json::from_value(params)?;
            let limit = u32::try_from(p.limit)
                .map_err(|_| KernelError::Protocol("history page limit out of range".into()))?;
            Ok(serde_json::to_value(
                catalog
                    .capture_history_page(&p.branch_id)
                    .map_err(domain)?
                    .load_since(
                        p.head_id.as_deref(),
                        p.before_id.as_deref(),
                        p.after_id.as_deref(),
                        limit,
                        &cancel,
                    )
                    .map_err(domain)?,
            )?)
        }
        "runtime.history.body" => {
            let p: HistoryBodyParams = serde_json::from_value(params)?;
            let index = usize::try_from(p.chunk_index).map_err(|_| {
                KernelError::Protocol("content chunk index must be nonnegative".into())
            })?;
            let chunk = catalog
                .history_body_reader(&p.item_id)
                .map_err(domain)?
                .chunk(index)
                .map_err(domain)?;
            Ok(
                json!({"itemId":p.item_id,"contentRef":chunk.content_ref,"chunkIndex":chunk.chunk_index,"chunkCount":chunk.chunk_count,"totalBytes":chunk.total_bytes,"bytesBase64":base64::engine::general_purpose::STANDARD.encode(chunk.bytes)}),
            )
        }
        "runtime.thread.tree" => {
            let p: ConversationTreeParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .capture_conversation_tree(&p.thread_id, &p.branch_id)
                    .map_err(domain)?
                    .load(&cancel)
                    .map_err(domain)?,
            )?)
        }
        "runtime.output.media.read" => {
            let p = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .capture_media_read(&p)
                    .map_err(domain)?
                    .chunk(&cancel)
                    .map_err(domain)?,
            )?)
        }
        "runtime.bot.history.read" => {
            let p: BotHistoryReadParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .capture_bot_history_scoped(
                        &p.bot_id,
                        &p.thread_id,
                        &p.branch_id,
                        &p.head_id,
                        &p.item_id,
                        p.principal_id.map(|v| v.0),
                    )
                    .map_err(domain)?
                    .load(&cancel)
                    .map_err(domain)?,
            )?)
        }
        "runtime.bot.activity.read" => {
            let p: BotActivityParams = serde_json::from_value(params)?;
            let limit =
                p.limit.map(usize::try_from).transpose().map_err(|_| {
                    KernelError::Protocol("activity page size must be positive".into())
                })?;
            let before = p.before.map(u64::try_from).transpose().map_err(|_| {
                KernelError::Protocol("activity cursor must be non-negative".into())
            })?;
            Ok(serde_json::to_value(
                catalog
                    .capture_bot_activity_scoped(
                        &p.bot_id,
                        before,
                        limit,
                        p.principal_id.map(|v| v.0),
                    )
                    .map_err(domain)?
                    .load(&cancel)
                    .map_err(domain)?,
            )?)
        }
        "runtime.family.list"
        | "runtime.family.runs"
        | "runtime.family.read"
        | "runtime.family.item" => FamilyCommand::capture(catalog, method, params)?.load(&cancel),
        "runtime.calendar.projects" => {
            let _: KernelEmptyParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog.calendar_projects().map_err(domain)?,
            )?)
        }
        "runtime.calendar.list" => {
            let p: CalendarProjectParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog.calendar_project(&p.project_id).map_err(domain)?,
            )?)
        }
        "runtime.calendar.occurrences" => {
            let p: CalendarDefinitionParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .calendar_occurrences(&p.definition_id)
                    .map_err(domain)?,
            )?)
        }
        "runtime.calendar.pending" => {
            let _: KernelEmptyParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog.calendar_pending().map_err(domain)?,
            )?)
        }
        "runtime.context.observations.sources" => {
            let p: ContextObservationSources = serde_json::from_value(params)?;
            let sources = catalog.context_observation_sources(&p).map_err(domain)?;
            Ok(serde_json::to_value(sources)?)
        }
        "runtime.context.observations.importSources" => {
            let _: ContextObservationImportSources = serde_json::from_value(params)?;
            let sources = catalog
                .context_observation_import_sources()
                .map_err(domain)?;
            Ok(serde_json::to_value(sources)?)
        }
        "runtime.context.observations.receipt" => {
            let p: ContextObservationReceiptLookup = serde_json::from_value(params)?;
            let receipts = catalog.context_observation_receipts(&p).map_err(domain)?;
            Ok(serde_json::to_value(receipts)?)
        }
        "runtime.context.observations.snapshot" => {
            let p: ContextObservationSnapshot = serde_json::from_value(params)?;
            Ok(json!({"cursor":catalog.context_observation_snapshot(&p).map_err(domain)?}))
        }
        "runtime.context.observations.importPosition" => {
            let p: ContextObservationImportPosition = serde_json::from_value(params)?;
            Ok(
                json!({"throughId":catalog.context_observation_import_position(&p).map_err(domain)?}),
            )
        }
        "runtime.context.observations.read" => {
            let p: ContextObservationRead = serde_json::from_value(params)?;
            let read = catalog
                .prepare_context_observation_original(p)
                .map_err(domain)?;
            Ok(serde_json::to_value(
                read.load(&|| cancel()).map_err(domain)?,
            )?)
        }
        "runtime.knowledge_inference.read" => {
            let p: KnowledgeInferenceReadParams = serde_json::from_value(params)?;
            let read = catalog.capture_knowledge_inference(&p.operation_id);
            match read {
                Ok(read) => Ok(serde_json::to_value(read.load().map_err(domain)?)?),
                Err(varin_runtime::RuntimeError::NotFound(_)) if p.allow_missing => Ok(Value::Null),
                Err(error) => Err(domain(error)),
            }
        }
        "runtime.knowledge_inference.status" => {
            let p: KnowledgeInferenceReadParams = serde_json::from_value(params)?;
            match catalog.knowledge_inference_status(&p.operation_id) {
                Ok(status) => Ok(serde_json::to_value(status)?),
                Err(varin_runtime::RuntimeError::NotFound(_)) if p.allow_missing => Ok(Value::Null),
                Err(error) => Err(domain(error)),
            }
        }
        "runtime.model_text.read" => {
            let p: ModelTextReadParams = serde_json::from_value(params)?;
            let read = catalog.capture_model_text(&p.request_id);
            match read {
                Ok(read) => Ok(serde_json::to_value(read.load().map_err(domain)?)?),
                Err(varin_runtime::RuntimeError::NotFound(_)) if p.allow_missing => Ok(Value::Null),
                Err(error) => Err(domain(error)),
            }
        }
        "runtime.model_text.status" => {
            let p: ModelTextReadParams = serde_json::from_value(params)?;
            match catalog.model_text_status(&p.request_id) {
                Ok(status) => Ok(serde_json::to_value(status)?),
                Err(varin_runtime::RuntimeError::NotFound(_)) if p.allow_missing => Ok(Value::Null),
                Err(error) => Err(domain(error)),
            }
        }
        "runtime.memory_work.read" => {
            let p: MemoryWorkReadParams = serde_json::from_value(params)?;
            let read = catalog.capture_memory_work(&p.work_id).map_err(domain)?;
            Ok(serde_json::to_value(read.load().map_err(domain)?)?)
        }
        "runtime.memory_work.status" => {
            let p: MemoryWorkReadParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog.memory_work_status(&p.work_id).map_err(domain)?,
            )?)
        }
        "runtime.memory_work.list" => {
            let p: MemoryWorkListParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog.memory_work_ids(&p.scope_id).map_err(domain)?,
            )?)
        }
        "runtime.computer.scope" => {
            let p: ComputerScopeParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .computer_scope(
                        &p.thread_id,
                        &p.branch_id,
                        p.run_id.as_deref(),
                        p.operation_id.as_deref(),
                    )
                    .map_err(domain)?,
            )?)
        }
        "runtime.model_reference.agent_source" => {
            let p: ModelAgentSourceParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .agent_source(&p.run_id, &p.identity)
                    .map_err(domain)?,
            )?)
        }
        "runtime.model_reference.resolve" => {
            let p: ModelReferenceResolveParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .resolve_model_reference(p.kind, &p.reference)
                    .map_err(domain)?,
            )?)
        }
        "runtime.operation.status" => {
            let p: OperationParams = serde_json::from_value(params)?;
            Ok(operation_cancellation_receipt(
                &catalog.operation(&p.operation_id).map_err(domain)?,
            ))
        }
        "runtime.tokenizers.references" => {
            let _: KernelEmptyParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .capture_tokenizer_references()
                    .load()
                    .map_err(domain)?,
            )?)
        }
        "runtime.context_job.definition" => {
            let _: KernelEmptyParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                varin_runtime::context_job::agent_definition(),
            )?)
        }
        "runtime.child.capabilities" => {
            let _: KernelEmptyParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                crate::child_capabilities::descriptors(),
            )?)
        }
        "runtime.tools.catalog" => {
            let _: KernelEmptyParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(crate::run_tools::builtin_schemas(
                &crate::tools::ToolKind::all().collect(),
                true,
                true,
                false,
            ))?)
        }
        "runtime.source.tools" => {
            let p: SourceToolsParams = serde_json::from_value(params)?;
            Ok(json!(
                crate::tools::KernelToolExecutor::selected_schemas(
                    &crate::tools::ToolKind::all().collect()
                )
                .into_iter()
                .filter(|schema| schema
                    .requirements
                    .as_ref()
                    .is_none_or(|required| required.accepts_mode(p.mode)))
                .map(|schema| schema.name)
                .collect::<Vec<_>>()
            ))
        }
        "runtime.tools.inspect" => {
            let p: NestedToolInspectParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .nested_tools()
                    .inspect(&p.parent_operation_id, &p.executor_owner, p.name.as_deref())
                    .map_err(|error| {
                        KernelError::Operation(format!("{}: {}", error.code, error.message))
                    })?,
            )?)
        }
        "runtime.child.model.read" => {
            let p: ChildExecutionParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .find_delegation_model(&p.execution_id)
                    .map_err(domain)?
                    .map(|read| read.load())
                    .transpose()
                    .map_err(domain)?,
            )?)
        }
        "runtime.child.dependencies.pending" => {
            let _: KernelEmptyParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .capture_unaccepted_child_dependencies()
                    .map_err(domain)?
                    .load()
                    .map_err(domain)?,
            )?)
        }
        "runtime.child.execution.list" => {
            let p: ChildExecutionListParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .delegated_executions(p.child_operation_id.as_deref())
                    .map_err(domain)?
                    .into_iter()
                    .map(|execution| catalog.capture_delegated_execution(execution)?.load())
                    .collect::<Result<Vec<_>, varin_runtime::RuntimeError>>()
                    .map_err(domain)?,
            )?)
        }
        "runtime.child.execution.for_run" => {
            let p: RunParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .delegated_execution_for_run(&p.run_id)
                    .map_err(domain)?
                    .map(|execution| catalog.capture_delegated_execution(execution)?.load())
                    .transpose()
                    .map_err(domain)?,
            )?)
        }
        "runtime.child.execution.inspect" => {
            let p: ChildExecutionParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .capture_delegated_execution(
                        catalog
                            .delegated_execution(&p.execution_id)
                            .map_err(domain)?,
                    )
                    .map_err(domain)?
                    .load()
                    .map_err(domain)?,
            )?)
        }
        "runtime.child.execution.report.read" => {
            let p: ChildExecutionReportReadParams = serde_json::from_value(params)?;
            let offset = usize::try_from(p.offset.unwrap_or(0))
                .map_err(|_| KernelError::Protocol("invalid offset".into()))?;
            let max = usize::try_from(p.max_bytes.unwrap_or(65536))
                .map_err(|_| KernelError::Protocol("invalid maxBytes".into()))?;
            Ok(serde_json::to_value(
                catalog
                    .capture_delegated_report(&p.execution_id, &p.item_id, offset, max)
                    .map_err(domain)?
                    .load_cancellable(&cancel)
                    .map_err(domain)?,
            )?)
        }
        "runtime.child.report.read" => {
            let p: ChildReportReadParams = serde_json::from_value(params)?;
            let offset = usize::try_from(p.offset.unwrap_or(0))
                .map_err(|_| KernelError::Protocol("invalid offset".into()))?;
            let max = usize::try_from(p.max_bytes.unwrap_or(65536))
                .map_err(|_| KernelError::Protocol("invalid maxBytes".into()))?;
            Ok(serde_json::to_value(
                catalog
                    .capture_child_report(&p.operation_id, &p.item_id, offset, max)
                    .map_err(domain)?
                    .load_cancellable(&cancel)
                    .map_err(domain)?,
            )?)
        }
        "runtime.child.list" => {
            let _: KernelEmptyParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .child_tasks()
                    .map_err(domain)?
                    .into_iter()
                    .map(|child| catalog.capture_child_read(child).load())
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(domain)?,
            )?)
        }
        "runtime.child.for_thread" => {
            let p: ThreadParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .child_task_for_thread(&p.thread_id)
                    .map_err(domain)?
                    .map(|child| catalog.capture_child_read(child).load())
                    .transpose()
                    .map_err(domain)?,
            )?)
        }
        "runtime.child.inspect" => {
            let p: OperationParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog
                    .capture_child_read(catalog.child_task(&p.operation_id).map_err(domain)?)
                    .load()
                    .map_err(domain)?,
            )?)
        }
        _ => dispatch(catalog, method, params),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(id: &str, method: &str, params: Value) -> Value {
        json!({"v":PROTOCOL_VERSION,"kind":"request","id":id,"epoch":"host-epoch","method":method,"params":params})
    }
    #[test]
    fn read_pool_answers_while_writer_is_held_and_decodes_the_boundary_once() {
        let root = std::env::temp_dir().join(format!("varin-read-pool-{}", uuid::Uuid::new_v4()));
        let mut catalog = Catalog::open(&root).unwrap();
        catalog.create_thread("thread", "branch").unwrap();
        let runtime = Arc::new(RunSupervisor::new(catalog));
        let (send, received) = mpsc::sync_channel(8);
        let pool = ReadPool::start(
            &*runtime.catalog().lock().unwrap(),
            runtime.clone(),
            "host-epoch".into(),
            send.into(),
            Arc::new(|_| {}),
        )
        .unwrap();
        let control = AgentControl::default();
        *control.readers.write().unwrap() = Some(pool);
        let writer = runtime.catalog();
        let held_writer = writer.lock().unwrap();
        let mut value = request(
            "summary",
            "runtime.thread.inspect",
            json!({"threadId":"thread"}),
        );
        assert!(
            control
                .read_request(&mut value, Arc::new(AtomicBool::new(false)))
                .unwrap()
        );
        assert!(value.is_null());
        let response = received
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        assert_eq!(response["result"]["thread_id"], "thread");
        let mut invalid = request("unknown", "runtime.status", json!({"unexpected":true}));
        assert!(
            control
                .read_request(&mut invalid, Arc::new(AtomicBool::new(false)))
                .unwrap()
        );
        assert!(
            !received
                .recv_timeout(std::time::Duration::from_secs(3))
                .unwrap()["error"]
                .is_null()
        );
        let mut cancelled = request(
            "cancelled",
            "runtime.thread.inspect",
            json!({"threadId":"thread"}),
        );
        assert!(
            control
                .read_request(&mut cancelled, Arc::new(AtomicBool::new(true)))
                .unwrap()
        );
        assert!(
            !received
                .recv_timeout(std::time::Duration::from_secs(3))
                .unwrap()["error"]
                .is_null()
        );
        drop(held_writer);
        drop(writer);
        *control.readers.write().unwrap() = None;
        drop(control);
        drop(runtime);
        // Reader workers release their channels asynchronously; they own no writer lease.
        let reopened = Catalog::open(&root).unwrap();
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn single_serde_decoder_requires_explicit_nullable_heads_and_rejects_unknown_fields() {
        assert!(
            serde_json::from_value::<ContextInspectionParams>(
                json!({"threadId":"thread","branchId":"branch"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<ContextInspectionParams>(
                json!({"threadId":"thread","branchId":"branch","headId":null})
            )
            .is_ok()
        );
        assert!(
            serde_json::from_value::<ThreadViewParams>(
                json!({"threadId":"thread","branchId":"branch","historyLimit":20,"unknown":true})
            )
            .is_err()
        );
    }
}
