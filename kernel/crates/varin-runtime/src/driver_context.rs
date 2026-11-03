//! Actual Run-owned primitives. No policy actions, fabricated tool parents, or parallel writer.
use super::*;
use crate::catalog::driver::DriverWorkKind;
use crate::{ModelStepState, RunState};
use serde::de::DeserializeOwned;

struct Admission<'a>(&'a DriverContext);
impl Drop for Admission<'_> {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
        state.active -= 1;
        if state.active == 0 {
            self.0.drained.notify_all();
        }
    }
}
fn unavailable(message: &str) -> ExecutionError {
    ExecutionError::new("driver_work_unavailable", message)
}
fn reference(kind: &str, run: &str, id: &str) -> String {
    format!("driver:{kind}:{}:{run}:{id}", run.len())
}
fn digest(value: &impl Serialize) -> Result<String, ExecutionError> {
    use sha2::{Digest, Sha256};
    Ok(hex::encode(Sha256::digest(
        serde_json::to_vec(value).map_err(error)?,
    )))
}
impl DriverContext {
    pub fn selection(&self) -> DriverSelection {
        self.start.driver.selection()
    }
    fn admit(&self) -> Result<Admission<'_>, ExecutionError> {
        let mut state = self.state.lock().map_err(error)?;
        if !state.accepting || self.cancel.is_cancelled() {
            return Err(unavailable(
                "original driver invocation is closed or cancelled",
            ));
        }
        state.active += 1;
        Ok(Admission(self))
    }
    fn input(&self) -> Result<ExecutionInput, ExecutionError> {
        self.state
            .lock()
            .map_err(error)?
            .input
            .clone()
            .ok_or_else(|| unavailable("driver input has not been admitted"))
    }
    /// A returned algorithm Promise is not proof that its accepted work stopped. Closing
    /// admission and joining every actual primitive happens before the Run can settle.
    pub fn close_admission(&self) {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .accepting = false;
        self.observation_stop.cancel();
    }
    pub fn close_and_drain(&self) {
        self.close_admission();
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.accepting = false;
        while state.active != 0 {
            state = self.drained.wait(state).unwrap_or_else(|p| p.into_inner());
        }
    }
    pub fn prepare_custom(&self) -> Result<DriverRunInput, ExecutionError> {
        let selection = self.selection();
        let read = {
            let mut catalog = self.catalog.lock().map_err(error)?;
            catalog
                .bind_run_driver(&self.run_id, self.epoch, &selection)
                .map_err(error)?;
            catalog
                .capture_driver_execution(&self.run_id, self.epoch, &selection)
                .map_err(error)?
        };
        let expected = read.metadata.clone();
        let resumed = expected.started_epoch.is_some();
        let checkpoint = read.load_checkpoint().map_err(error)?;
        if resumed
            && !matches!(&selection, DriverSelection::Extension { artifact } if artifact.recovery == DriverRecovery::Checkpoint && checkpoint.is_some())
        {
            return Err(ExecutionError::new(
                "driver_resume_unsupported",
                "The original driver has no compatible committed checkpoint; original work will not be replayed.",
            ));
        }
        self.start
            .context_preparation
            .prepare(&self.run_id, self.epoch, &self.cancel)?;
        let mut binding = self.start.binding.clone();
        let binding_context = self.start.context_preparation.prepare_binding(
            &self.run_id,
            self.epoch,
            &mut binding,
            &self.cancel,
        )?;
        let read = self
            .catalog
            .lock()
            .map_err(error)?
            .capture_driver_input(&self.run_id, self.epoch, binding)
            .map_err(error)?;
        let mut input = read.load().map_err(error)?;
        if let Some(projected) = self.catalog.compile_context(
            &self.run_id,
            self.epoch,
            input.binding.history_range.leaf_id.as_deref(),
            None,
        )? {
            input.history = projected.history;
            input.binding.instruction_sources = projected.instruction_sources;
            input.binding.memory_checkpoint = projected.memory_checkpoint;
            input.binding.resource_checkpoint_id = projected.resource_checkpoint_id;
        }
        input.history.extend(binding_context);
        let (goal, agent) = {
            let catalog = self.catalog.lock().map_err(error)?;
            (
                catalog.goal_binding(&self.run_id).map_err(error)?,
                catalog
                    .launch_metadata(&self.run_id)
                    .map_err(error)?
                    .and_then(|launch| launch.selection.agent),
            )
        };
        input.binding.goal = goal;
        input.binding.tools = crate::tool_disclosure::request_tools(
            &input.binding.tools,
            input.binding.goal.is_some(),
            agent.as_ref().and_then(|agent| agent.tools.as_deref()),
        );
        input.binding.direct_tools = crate::tool_disclosure::direct_tools(
            &input.binding.tools,
            agent
                .as_ref()
                .map(|agent| agent.work_focus.as_str())
                .unwrap_or("general"),
        );
        input.binding.resource_activations =
            crate::catalog::resources::retained_activations(&input.history);
        let ids = self
            .catalog
            .lock()
            .map_err(error)?
            .driver_work_ids(&self.run_id, self.epoch, &selection)
            .map_err(error)?;
        let mut receipts = Vec::new();
        for work in ids {
            let kind = match work.kind {
                DriverWorkKind::Model => "model",
                DriverWorkKind::Tool => "tool",
                DriverWorkKind::Delivery => "delivery",
            };
            let id = work
                .id
                .strip_prefix(&reference(kind, &self.run_id, ""))
                .ok_or_else(|| unavailable("original driver work reference is malformed"))?
                .to_string();
            if let Some(receipt) = self.read_receipt(&DriverReceiptInput {
                id,
                kind: work.kind,
            })? {
                receipts.push(receipt);
            }
        }
        let mut models = vec![DriverModelAvailability {
            capability_id: "primary".into(),
            status: PolicyModelStatus::Available,
        }];
        models.extend(
            self.start
                .provider
                .policy_model_capabilities()
                .into_iter()
                .map(|m| DriverModelAvailability {
                    capability_id: m.capability_id,
                    status: m.status,
                }),
        );
        let result = DriverRunInput {
            run_id: self.run_id.clone(),
            epoch: self.epoch,
            mode: if resumed { "resume" } else { "start" }.into(),
            history: input.history.clone(),
            tools: input.binding.tools.clone(),
            models,
            checkpoint,
            receipts,
        };
        let mut state = self.state.lock().map_err(error)?;
        if self.cancel.is_cancelled() {
            return Err(unavailable("driver preparation was cancelled"));
        }
        self.catalog.commit(
            &self.run_id,
            self.epoch,
            &ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None,
            },
        )?;
        self.catalog
            .lock()
            .map_err(error)?
            .admit_driver_execution(&self.run_id, self.epoch, &selection, &expected)
            .map_err(error)?;
        state.input = Some(input);
        state.accepting = true;
        Ok(result)
    }
    fn once<T: Serialize + DeserializeOwned>(
        &self,
        kind: &str,
        id: &str,
        input: Value,
        operation: impl FnOnce() -> Result<T, ExecutionError>,
    ) -> Result<T, ExecutionError> {
        let _admission = self.admit()?;
        if id.is_empty() {
            return Err(ExecutionError::new(
                "driver_operation_id_required",
                "driver work requires a stable nonempty identity",
            ));
        }
        let key = reference(kind, &self.run_id, id);
        let (call, first) = {
            let mut state = self.state.lock().map_err(error)?;
            if let Some(call) = state.calls.get(&key) {
                if call.input != input {
                    return Err(ExecutionError::new(
                        "driver_operation_conflict",
                        "stable driver work identity was reused with different input",
                    ));
                }
                (call.clone(), false)
            } else {
                let call = Arc::new(PrimitiveCall {
                    input,
                    cancel: self.cancel.child(&key),
                    result: Mutex::new(None),
                    ready: Condvar::new(),
                });
                state.calls.insert(key, call.clone());
                (call, true)
            }
        };
        if first {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation))
                .unwrap_or_else(|_| {
                    Err(ExecutionError::new(
                        "driver_primitive_panicked",
                        "original primitive stopped without a completion receipt",
                    ))
                })
                .and_then(|value| serde_json::to_value(value).map_err(error));
            *call.result.lock().unwrap_or_else(|p| p.into_inner()) = Some(result);
            call.ready.notify_all();
        }
        let mut result = call.result.lock().map_err(error)?;
        while result.is_none() {
            result = call.ready.wait(result).map_err(error)?;
        }
        serde_json::from_value(result.as_ref().expect("settled original call").clone()?)
            .map_err(error)
    }
    pub fn model(&self, request: DriverModelInput) -> Result<DriverModelReceipt, ExecutionError> {
        self.once(
            "model",
            &request.id,
            serde_json::to_value(&request).map_err(error)?,
            || self.execute_model(&request),
        )
    }
    fn execute_model(
        &self,
        request: &DriverModelInput,
    ) -> Result<DriverModelReceipt, ExecutionError> {
        let request_id = reference("model", &self.run_id, &request.id);
        let input_identity = digest(request)?;
        let saved = self
            .catalog
            .lock()
            .map_err(error)?
            .capture_driver_model_receipt(&self.run_id, self.epoch, &self.selection(), &request_id);
        match saved {
            Ok(saved) => {
                let saved = saved.load().map_err(error)?;
                if !matches!(&saved.snapshot.view.origin, RequestOrigin::Driver { input_identity: original, .. } if original == &input_identity)
                {
                    return Err(ExecutionError::new(
                        "driver_operation_conflict",
                        "model identity was reused with different input",
                    ));
                }
                return model_receipt(&request.id, &saved).ok_or_else(|| unavailable("original model work has no completed receipt; inspect it instead of redispatching"));
            }
            Err(RuntimeError::NotFound(_)) => (),
            Err(cause) => return Err(error(cause)),
        }
        let input = self.input()?;
        let cancel = self.cancel.child(&request_id);
        self.cancel
            .alias_child(&format!("model:driver:{request_id}"), &cancel);
        let (mut binding, provider) = if let Some(capability) = request
            .capability_id
            .as_ref()
            .filter(|id| id.as_str() != "primary")
        {
            let selected = self
                .start
                .provider
                .policy_model_capability(capability)
                .ok_or_else(|| unavailable("original model capability is unavailable"))?;
            if selected.capability.status != PolicyModelStatus::Available
                || !request.tools.is_empty()
            {
                return Err(unavailable(
                    "this model capability is unavailable or supports tool-free text only",
                ));
            }
            (
                selected
                    .capability
                    .binding
                    .ok_or_else(|| unavailable("model capability has no original binding"))?,
                selected.provider,
            )
        } else if let Some(selected) =
            self.start
                .provider
                .select_for_request(&self.run_id, self.epoch, &cancel)?
        {
            (selected.binding, selected.provider)
        } else {
            (input.binding.clone(), self.start.provider.clone())
        };
        // Algorithm context is free; actual capabilities, source and authorization are not.
        binding.history_range = input.binding.history_range.clone();
        binding.request_context = input.binding.request_context.clone();
        binding.child_dispatch = input.binding.child_dispatch.clone();
        binding.tool_schema_generation = input.binding.tool_schema_generation;
        binding.execution_environment = input.binding.execution_environment.clone();
        binding.goal = input.binding.goal.clone();
        binding.resource_checkpoint_id = input.binding.resource_checkpoint_id.clone();
        binding.resource_activations =
            crate::catalog::resources::retained_activations(&request.history);
        if binding
            .resource_activations
            .iter()
            .any(|activation| !input.binding.resource_activations.contains(activation))
        {
            return Err(unavailable(
                "context claims an unadmitted resource activation",
            ));
        }
        binding.tools = request
            .tools
            .iter()
            .map(|name| {
                input
                    .binding
                    .tools
                    .iter()
                    .find(|tool| &tool.name == name)
                    .cloned()
                    .ok_or_else(|| {
                        unavailable("model tool is absent from the original Run directory")
                    })
            })
            .collect::<Result<_, _>>()?;
        if request
            .tools
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != request.tools.len()
        {
            return Err(unavailable("model tool subset contains duplicate names"));
        }
        binding.direct_tools = Some(request.tools.clone());
        // These are actual driver-authored prompt instructions, not the original
        // instruction-source identifiers (which the provider does not render).
        let source = format!("driver:{}", self.selection().owner_key());
        binding.instruction_sources = input.binding.instruction_sources.clone();
        if !request.instructions.is_empty() {
            binding.instruction_sources.push(source.clone());
        }
        let mut history: ConversationHistory = request
            .instructions
            .iter()
            .enumerate()
            .map(|(index, text)| {
                Arc::new(ConversationItem {
                    id: format!("{request_id}:instruction:{index}"),
                    provenance: Provenance::SystemInstruction {
                        source: source.clone(),
                    },
                    content: Content::Text { text: text.clone() },
                    opaque: None,
                    resource_activation: None,
                })
            })
            .collect();
        history.extend(request.history.iter().cloned());
        validate_history_pairs(&history)?;
        let view = RequestView {
            run_id: self.run_id.clone(),
            request_id: request_id.clone(),
            origin: RequestOrigin::Driver {
                driver_id: self.selection().owner_key(),
                operation_id: request_id.clone(),
                input_identity,
            },
            binding,
            history,
        };
        let serialized = provider.serialize_cancellable(&view, None, &cancel)?;
        let snapshot = Arc::new(RequestSnapshot { view, serialized });
        self.catalog.commit(
            &self.run_id,
            self.epoch,
            &ExecutionRecord::RequestPrepared {
                snapshot: snapshot.clone(),
            },
        )?;
        if cancel.is_cancelled() {
            self.catalog.commit(
                &self.run_id,
                self.epoch,
                &ExecutionRecord::RequestNotDispatched {
                    request_id,
                    reason: NonDispatchReason::Cancelled,
                },
            )?;
            return Err(unavailable("model was cancelled before dispatch"));
        }
        if let Err(cause) = self.catalog.commit(
            &self.run_id,
            self.epoch,
            &ExecutionRecord::ModelDispatched {
                request_id: request_id.clone(),
            },
        ) {
            self.catalog.commit(
                &self.run_id,
                self.epoch,
                &ExecutionRecord::RequestNotDispatched {
                    request_id,
                    reason: NonDispatchReason::WorkerStopped,
                },
            )?;
            return Err(cause);
        }
        let (items, deltas, usage, result) = generate_model(
            self.catalog.as_ref(),
            provider.as_ref(),
            // Internal branch drafts are original model evidence, not public chat output.
            // Explicit deliver alone publishes assistant content; activity/usage remain native.
            &ProgressSink::default(),
            &self.run_id,
            self.epoch,
            &snapshot,
            &cancel,
            None,
        );
        let result = result.and_then(|reason| {
            validate_model_items(&items, &snapshot)
                .map(|_| reason)
                .map_err(ModelFailure::from)
        });
        let (outcome, finish_reason, failure) = match result {
            Ok(reason) if !cancel.is_cancelled() => (ModelOutcome::Completed, Some(reason), None),
            Ok(_) => (ModelOutcome::Cancelled, None, None),
            Err(failure) => (
                if cancel.is_cancelled() {
                    ModelOutcome::Cancelled
                } else {
                    ModelOutcome::Failed
                },
                None,
                Some(failure),
            ),
        };
        self.catalog.commit(
            &self.run_id,
            self.epoch,
            &ExecutionRecord::ModelFinished {
                request_id: request_id.clone(),
                outcome,
                finish_reason,
                items: items.clone(),
                interrupted_deltas: deltas,
                usage: usage.clone(),
                failure: failure.clone(),
            },
        )?;
        Ok(DriverModelReceipt {
            id: request.id.clone(),
            request_id,
            outcome,
            items,
            usage,
            finish_reason,
            failure,
        })
    }
    pub fn tool(&self, request: DriverToolInput) -> Result<DriverToolReceipt, ExecutionError> {
        self.once(
            "tool",
            &request.id,
            serde_json::to_value(&request).map_err(error)?,
            || self.execute_tool(&request),
        )
    }
    fn execute_tool(&self, request: &DriverToolInput) -> Result<DriverToolReceipt, ExecutionError> {
        let operation_id = reference("tool", &self.run_id, &request.id);
        let original = self
            .catalog
            .lock()
            .map_err(error)?
            .capture_driver_call(&operation_id);
        match original {
            Ok(original) => {
                let original = original.load().map_err(error)?;
                if original.call.name != request.name
                    || original.call.arguments != request.arguments
                {
                    return Err(ExecutionError::new(
                        "driver_operation_conflict",
                        "tool identity was reused with different input",
                    ));
                }
                if let Some(DriverReceipt::Tool {
                    receipt: Some(receipt),
                    ..
                }) = self.read_receipt(&DriverReceiptInput {
                    id: request.id.clone(),
                    kind: DriverWorkKind::Tool,
                })? {
                    return Ok(receipt);
                }
                return Err(unavailable(
                    "original tool work has no completed receipt; inspect it instead of redispatching",
                ));
            }
            Err(RuntimeError::NotFound(_)) => (),
            Err(cause) => return Err(error(cause)),
        }
        let input = self.input()?;
        let schema = input
            .binding
            .tools
            .iter()
            .find(|tool| tool.name == request.name)
            .ok_or_else(|| unavailable("tool is absent from the original Run directory"))?;
        let call = Arc::new(ToolCall {
            call_id: request.id.clone(),
            name: request.name.clone(),
            schema_version: schema.version.clone(),
            arguments: request.arguments.clone(),
        });
        let source = self
            .catalog
            .lock()
            .map_err(error)?
            .launch_metadata(&self.run_id)
            .map_err(error)?
            .and_then(|launch| launch.selection.source);
        let frozen = Arc::new(FrozenToolContext {
            run_id: self.run_id.clone(),
            origin: ToolOrigin::Driver {
                invocation_id: operation_id.clone(),
            },
            tools: Arc::new(input.binding.tools.clone()),
            tool_schema_generation: input.binding.tool_schema_generation,
            source,
            tool_output_visible_bytes: input.binding.tool_output_visible_bytes,
            execution_environment: input.binding.execution_environment.clone(),
            direct_tools: input.binding.direct_tools.clone(),
            child_dispatch: input.binding.child_dispatch.clone(),
            resource_activations: input.binding.resource_activations.clone(),
            resource_checkpoint_id: input.binding.resource_checkpoint_id.clone(),
        });
        let preparation = self
            .catalog
            .lock()
            .map_err(error)?
            .prepare_driver_call(&self.run_id)
            .map_err(error)?;
        let prepared = preparation
            .call(&call, &frozen, &input.binding.history_range, &input.history)
            .map_err(error)?;
        let original = self
            .catalog
            .lock()
            .map_err(error)?
            .admit_driver_call(&self.run_id, self.epoch, &self.selection(), prepared)
            .map_err(error)?;
        let selected = self
            .start
            .tools
            .freeze(&input.binding.tools)?
            .unwrap_or_else(|| self.start.tools.clone());
        let scope = crate::nested_tools::NestedExecutionScope {
            frozen: frozen.clone(),
            directory: Arc::new(move |call, frozen, cancel| {
                selected.clone().bind_call(call, frozen, cancel)
            }),
            run_cancel: self.cancel.clone(),
        };
        let receipt = crate::execution::invocation::InvocationRunner {
            persistence: self.catalog.clone(),
            run_id: self.run_id.clone(),
            epoch: self.epoch,
        }
        .execute_call(
            ToolExecutionContext {
                run_id: self.run_id.clone(),
                origin: frozen.origin.clone(),
                operation_id: operation_id.clone(),
            },
            call,
            &scope,
            &self.cancel,
            true,
        )?;
        if matches!(receipt.completion, ToolCompletion::NotDispatched { .. }) {
            let needs_receipt = match self.catalog.lock().map_err(error)?.operation(&operation_id) {
                Ok(_) => false,
                Err(RuntimeError::NotFound(_)) => true,
                Err(cause) => return Err(error(cause)),
            };
            if needs_receipt {
                let prepare = self.catalog.lock().map_err(error)?.prepare_driver_content();
                let prepared = prepare
                    .pre_dispatch_completion(
                        &original,
                        &receipt.completion,
                        receipt.executor_stopped,
                    )
                    .map_err(error)?;
                self.catalog
                    .lock()
                    .map_err(error)?
                    .commit_driver_pre_dispatch_completion(
                        &self.run_id,
                        self.epoch,
                        &self.selection(),
                        prepared,
                    )
                    .map_err(error)?;
            }
        }
        Ok(DriverToolReceipt {
            id: request.id.clone(),
            operation_id,
            completion: receipt.completion,
            executor_stopped: receipt.executor_stopped,
        })
    }
    /// Consume only the original Inbox and recompile the original context. The driver
    /// chooses when to call this and how to schedule/replan; no default-loop action runs.
    pub fn context(&self, _: DriverContextInput) -> Result<DriverContextReceipt, ExecutionError> {
        let _admission = self.admit()?;
        let _serial = self.context_refresh.lock().map_err(error)?;
        let mut input = self.input()?;
        let read = self
            .catalog
            .lock()
            .map_err(error)?
            .capture_driver_input(&self.run_id, self.epoch, input.binding.clone())
            .map_err(error)?;
        let current = read.load().map_err(error)?;
        let batch = self.catalog.consume_inputs(
            &self.run_id,
            self.epoch,
            current.binding.history_range.leaf_id.as_deref(),
        )?;
        self.start
            .context_preparation
            .prepare(&self.run_id, self.epoch, &self.cancel)?;
        let binding_context = self.start.context_preparation.prepare_binding(
            &self.run_id,
            self.epoch,
            &mut input.binding,
            &self.cancel,
        )?;
        let read = self
            .catalog
            .lock()
            .map_err(error)?
            .capture_driver_input(&self.run_id, self.epoch, input.binding)
            .map_err(error)?;
        input = read.load().map_err(error)?;
        if let Some(projected) = self.catalog.compile_context(
            &self.run_id,
            self.epoch,
            input.binding.history_range.leaf_id.as_deref(),
            None,
        )? {
            input.history = projected.history;
            input.binding.instruction_sources = projected.instruction_sources;
            input.binding.memory_checkpoint = projected.memory_checkpoint;
            input.binding.resource_checkpoint_id = projected.resource_checkpoint_id;
        }
        input.history.extend(binding_context);
        input.binding.resource_activations =
            crate::catalog::resources::retained_activations(&input.history);
        let (goal, agent) = {
            let owner = self.catalog.lock().map_err(error)?;
            (
                owner.goal_binding(&self.run_id).map_err(error)?,
                owner
                    .launch_metadata(&self.run_id)
                    .map_err(error)?
                    .and_then(|launch| launch.selection.agent),
            )
        };
        input.binding.goal = goal;
        input.binding.tools = crate::tool_disclosure::request_tools(
            &self.start.binding.tools,
            input.binding.goal.is_some(),
            agent.as_ref().and_then(|agent| agent.tools.as_deref()),
        );
        input.binding.direct_tools = crate::tool_disclosure::direct_tools(
            &input.binding.tools,
            agent
                .as_ref()
                .map(|agent| agent.work_focus.as_str())
                .unwrap_or("general"),
        );
        let result = DriverContextReceipt {
            history: input.history.clone(),
            tools: input.binding.tools.clone(),
            input_ids: batch.input_ids,
            activating: batch.activating,
        };
        self.state.lock().map_err(error)?.input = Some(input);
        Ok(result)
    }
    /// Notifications are hints from the original Catalog event owner. Subscribe before
    /// reading the committed scoped cursor, and re-read after each coalesced wake.
    pub fn wait(&self, request: DriverWaitInput) -> Result<DriverWaitReceipt, ExecutionError> {
        let _admission = self.admit()?;
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let _subscription = self
            .catalog
            .lock()
            .map_err(error)?
            .subscribe_events(send.clone());
        let _cancel = self.cancel.wake_on_cancel(send.clone());
        let _closing = self.observation_stop.wake_on_cancel(send);
        loop {
            if self.cancel.is_cancelled() || self.observation_stop.is_cancelled() {
                return Err(unavailable(
                    "original driver observation was closed or cancelled",
                ));
            }
            let activity = self
                .catalog
                .lock()
                .map_err(error)?
                .driver_activity(&self.run_id, self.epoch, &self.selection())
                .map_err(error)?;
            let mut receipts = Vec::with_capacity(request.work.len());
            for work in &request.work {
                receipts.push(self.read_receipt(work)?.ok_or_else(|| {
                    unavailable("observation target was not admitted by this original Run driver")
                })?);
            }
            if request.after.is_none_or(|after| activity.cursor > after) {
                return Ok(DriverWaitReceipt {
                    cursor: activity.cursor,
                    input_pending: activity.input_pending,
                    receipts,
                });
            }
            receive.recv().map_err(error)?;
        }
    }
    /// Cancellation is directed only to original work in this invocation. Persist the
    /// tool intent before signalling its executor; neither step fabricates stop evidence.
    pub fn cancel_work(
        &self,
        request: DriverCancelInput,
    ) -> Result<DriverCancelReceipt, ExecutionError> {
        let _admission = self.admit()?;
        let (kind, work_kind) = match request.kind {
            DriverCancelKind::Model => ("model", DriverWorkKind::Model),
            DriverCancelKind::Tool => ("tool", DriverWorkKind::Tool),
        };
        let key = reference(kind, &self.run_id, &request.id);
        let call = self.state.lock().map_err(error)?.calls.get(&key).cloned();
        let receipt_input = DriverReceiptInput {
            id: request.id,
            kind: work_kind,
        };
        let receipt = self.read_receipt(&receipt_input)?;
        if call.is_none() && receipt.is_none() {
            return Ok(DriverCancelReceipt {
                requested: false,
                receipt: None,
            });
        }
        let mut requested = false;
        if let Some(DriverReceipt::Tool { phase: Some(_), .. }) = &receipt {
            let operation = self
                .catalog
                .lock()
                .map_err(error)?
                .request_cancel_operation(&key)
                .map_err(error)?;
            requested = operation.cancel_requested;
        }
        if let Some(call) = call {
            if call.result.lock().map_err(error)?.is_none() {
                call.cancel.cancel();
                requested = true;
            }
        }
        Ok(DriverCancelReceipt {
            requested,
            receipt: self.read_receipt(&receipt_input)?,
        })
    }
    pub fn checkpoint(
        &self,
        request: DriverCheckpointInput,
    ) -> Result<DriverCheckpoint, ExecutionError> {
        let _admission = self.admit()?;
        let prepare = self.catalog.lock().map_err(error)?.prepare_driver_content();
        let prepared = prepare
            .checkpoint(&request.schema, &request.state, &request.operations)
            .map_err(error)?;
        let result = self
            .catalog
            .lock()
            .map_err(error)?
            .commit_driver_checkpoint(
                &self.run_id,
                self.epoch,
                &self.selection(),
                request.expected_revision,
                prepared,
            )
            .map_err(error)?;
        Ok(DriverCheckpoint {
            revision: result.revision,
            schema: result.schema,
            state: request.state,
            operations: request.operations,
        })
    }
    pub fn deliver(
        &self,
        request: DriverDeliveryInput,
    ) -> Result<DriverDeliveryReceipt, ExecutionError> {
        let _admission = self.admit()?;
        let prepare = self.catalog.lock().map_err(error)?.prepare_driver_content();
        let prepared = prepare
            .delivery(&self.run_id, &request.id, &request.text, &self.selection())
            .map_err(error)?;
        let history_id = self
            .catalog
            .lock()
            .map_err(error)?
            .commit_driver_delivery(&self.run_id, self.epoch, &self.selection(), prepared)
            .map_err(error)?;
        Ok(DriverDeliveryReceipt {
            id: request.id,
            history_id,
        })
    }
    pub fn receipt(
        &self,
        request: DriverReceiptInput,
    ) -> Result<Option<DriverReceipt>, ExecutionError> {
        let _admission = self.admit()?;
        self.read_receipt(&request)
    }
    fn read_receipt(
        &self,
        request: &DriverReceiptInput,
    ) -> Result<Option<DriverReceipt>, ExecutionError> {
        let selection = self.selection();
        match request.kind {
            DriverWorkKind::Model => {
                let request_id = reference("model", &self.run_id, &request.id);
                let read = self
                    .catalog
                    .lock()
                    .map_err(error)?
                    .capture_driver_model_receipt(
                        &self.run_id,
                        self.epoch,
                        &selection,
                        &request_id,
                    );
                let saved = match read {
                    Ok(read) => read.load().map_err(error)?,
                    Err(RuntimeError::NotFound(_)) => return Ok(None),
                    Err(cause) => return Err(error(cause)),
                };
                let receipt = model_receipt(&request.id, &saved);
                Ok(Some(DriverReceipt::Model {
                    id: request.id.clone(),
                    request_id,
                    state: saved.step.state,
                    receipt,
                }))
            }
            DriverWorkKind::Tool => {
                let operation_id = reference("tool", &self.run_id, &request.id);
                let (phase, read, stopped) = {
                    let owner = self.catalog.lock().map_err(error)?;
                    match owner.capture_driver_call(&operation_id) {
                        Ok(_) => (),
                        Err(RuntimeError::NotFound(_)) => return Ok(None),
                        Err(cause) => return Err(error(cause)),
                    }
                    let operation = match owner.operation(&operation_id) {
                        Ok(op) => Some(op),
                        Err(RuntimeError::NotFound(_)) => None,
                        Err(cause) => return Err(error(cause)),
                    };
                    let read = if operation
                        .as_ref()
                        .is_some_and(|op| op.call_completion.is_some())
                    {
                        Some(
                            owner
                                .capture_call_completion(&operation_id)
                                .map_err(error)?,
                        )
                    } else if operation.is_none() {
                        owner
                            .capture_driver_pre_dispatch_completion(
                                &self.run_id,
                                self.epoch,
                                &selection,
                                &operation_id,
                            )
                            .map_err(error)?
                    } else {
                        None
                    };
                    let stopped = if operation.is_some() {
                        owner.driver_tool_stopped(&operation_id).map_err(error)?
                    } else {
                        read.is_some()
                    };
                    (operation.map(|op| op.phase), read, stopped)
                };
                let receipt = read
                    .map(|read| {
                        read.load().map(|completion| DriverToolReceipt {
                            id: request.id.clone(),
                            operation_id: operation_id.clone(),
                            completion,
                            executor_stopped: stopped,
                        })
                    })
                    .transpose()
                    .map_err(error)?;
                Ok(Some(DriverReceipt::Tool {
                    id: request.id.clone(),
                    operation_id,
                    phase,
                    receipt,
                }))
            }
            DriverWorkKind::Delivery => {
                let history_id = reference("delivery", &self.run_id, &request.id);
                let exists = self
                    .catalog
                    .lock()
                    .map_err(error)?
                    .driver_work_ids(&self.run_id, self.epoch, &selection)
                    .map_err(error)?
                    .iter()
                    .any(|work| work.kind == DriverWorkKind::Delivery && work.id == history_id);
                Ok(exists.then(|| DriverReceipt::Delivery {
                    id: request.id.clone(),
                    history_id,
                }))
            }
        }
    }
    pub fn finish_custom(
        &self,
        result: Result<DriverRunOutcome, ExecutionError>,
    ) -> Result<ExecutionReport, ExecutionError> {
        self.close_and_drain();
        let result = match result {
            Err(_) | Ok(DriverRunOutcome::Pause { .. }) if self.cancel.is_cancelled() => {
                DriverRunOutcome::Complete
            }
            other => other?,
        };
        let binding = self.input()?.binding;
        let suspended = matches!(
            self.catalog.stop_reason(&self.run_id, self.epoch)?,
            crate::catalog::bot::RunStopReason::BotSuspension(_)
        );
        let (state, failure, waiting_on) = if suspended {
            let parked = self.catalog.park_suspension(&self.run_id, self.epoch)?;
            (parked.state, None, parked.waiting_on)
        } else if let DriverRunOutcome::Pause { reason } = &result {
            let mut catalog = self.catalog.lock().map_err(error)?;
            catalog
                .pause_failed_execution(&self.run_id, self.epoch, "driver_paused", reason)
                .map_err(error)?;
            let run = catalog.run(&self.run_id).map_err(error)?;
            (run.state, None, run.waiting_on)
        } else {
            let failure = if let DriverRunOutcome::Fail { error } = result {
                Some(error)
            } else {
                None
            };
            let state = if self.cancel.is_cancelled() {
                RunState::Cancelled
            } else if failure.is_some() {
                RunState::Failed
            } else {
                RunState::Completed
            };
            {
                let owner = self.catalog.lock().map_err(error)?;
                if state == RunState::Completed
                    && owner
                        .pending_question_wait(&self.run_id)
                        .map_err(error)?
                        .is_some()
                {
                    return Err(unavailable("an original question is still awaiting a user answer; observe or explicitly cancel it before completing"));
                }
                let pending = owner.pending_run_operations(&self.run_id).map_err(error)?;
                if pending.iter().any(|op| !op.handed_off) {
                    return Err(unavailable(
                        "original execution still has unsettled work; driver completion does not prove executor stop",
                    ));
                }
                // A terminal effect receipt is not proof that its executor has stopped.
                // Thread/Environment jobs may continue only after the original owner handed off.
                for work in owner
                    .driver_work_ids(&self.run_id, self.epoch, &self.selection())
                    .map_err(error)?
                {
                    if work.kind != DriverWorkKind::Tool {
                        continue;
                    }
                    match owner.operation(&work.id) {
                        Ok(op)
                            if !op.handed_off
                                && !owner.driver_tool_stopped(&work.id).map_err(error)? =>
                        {
                            return Err(unavailable(
                                "original tool executor has not proved stop; its resources remain owned",
                            ));
                        }
                        Ok(_) | Err(RuntimeError::NotFound(_)) => (),
                        Err(cause) => return Err(error(cause)),
                    }
                }
            }
            self.catalog.commit(
                &self.run_id,
                self.epoch,
                &if state == RunState::Failed {
                    ExecutionRecord::ExecutionFailed {
                        failure: failure.clone().expect("failed driver outcome"),
                    }
                } else {
                    ExecutionRecord::StateChanged {
                        state,
                        waiting_on: None,
                    }
                },
            )?;
            (state, failure, None)
        };
        let read = self
            .catalog
            .lock()
            .map_err(error)?
            .capture_driver_report(&self.run_id, self.epoch, &self.selection(), binding)
            .map_err(error)?;
        let input = read.load().map_err(error)?;
        Ok(ExecutionReport {
            state,
            history: input.history,
            policy_state: Value::Null,
            model_steps: input.completed_model_steps,
            waiting_on,
            failure,
        })
    }
}
fn model_receipt(
    id: &str,
    saved: &crate::catalog::driver::DriverModelRecord,
) -> Option<DriverModelReceipt> {
    if saved.output_status != Some(crate::catalog::driver::DriverModelOutputStatus::Committed) {
        return None;
    }
    let ExecutionRecord::ModelFinished {
        request_id,
        outcome,
        items,
        usage,
        finish_reason,
        failure,
        ..
    } = saved.output.as_ref()?
    else {
        return None;
    };
    if saved.step.state == ModelStepState::Interrupted && *outcome == ModelOutcome::Completed {
        return None;
    }
    Some(DriverModelReceipt {
        id: id.into(),
        request_id: request_id.clone(),
        outcome: *outcome,
        items: items.clone(),
        usage: usage.clone(),
        finish_reason: *finish_reason,
        failure: failure.clone(),
    })
}
