//! Context policy and compaction wait on the requesting Run worker, outside shared owners.
use crate::host_query::OwnerChannel;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};
use varin_runtime::{
    context_capacity::{estimate_item, estimate_request, ContextPolicy},
    execution::*,
    Catalog, ModelSessionConfiguration,
};

pub(crate) struct CapacityPreparation {
    inner: Arc<dyn ContextPreparation>,
    catalog: Arc<Mutex<Catalog>>,
    bridge: OwnerChannel,
    policy: Mutex<Option<(String, ContextPolicy)>>,
}
fn failed(error: impl ToString) -> ExecutionError {
    ExecutionError::new("context_capacity", error.to_string())
}
impl CapacityPreparation {
    pub fn new(
        inner: Arc<dyn ContextPreparation>,
        catalog: Arc<Mutex<Catalog>>,
        bridge: OwnerChannel,
    ) -> Self {
        Self {
            inner,
            catalog,
            bridge,
            policy: Mutex::new(None),
        }
    }
    fn policy(
        &self,
        view: &RequestView,
        cancel: &CancellationToken,
    ) -> Result<ContextPolicy, ExecutionError> {
        let key = format!(
            "{}:{}",
            view.binding.connection_identity, view.binding.configuration_generation
        );
        if let Some((identity, policy)) = self.policy.lock().map_err(failed)?.as_ref() {
            if identity == &key {
                return Ok(policy.clone());
            }
        }
        let reply = self
            .bridge
            .query(json!({"action":"policy","runId":view.run_id}), cancel)?;
        if reply["status"] != "ready" {
            return Err(ExecutionError::new(
                reply["code"]
                    .as_str()
                    .unwrap_or("context_policy_unavailable"),
                "Context policy is unavailable",
            ));
        }
        let policy: ContextPolicy =
            serde_json::from_value(reply["policy"].clone()).map_err(failed)?;
        if !(policy.preparation_waterline > 0.0 && policy.preparation_waterline < 1.0) {
            return Err(failed("Invalid context preparation waterline"));
        }
        *self.policy.lock().map_err(failed)? = Some((key, policy.clone()));
        Ok(policy)
    }
}
impl ContextPreparation for CapacityPreparation {
    fn prepare(
        &self,
        run_id: &str,
        epoch: u64,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        self.inner.prepare(run_id, epoch, cancel)
    }
    fn prepare_request(
        &self,
        epoch: u64,
        view: &RequestView,
        serialized: &Value,
        cancel: &CancellationToken,
    ) -> Result<ContextRequestPreparation, ExecutionError> {
        match self
            .inner
            .prepare_request(epoch, view, serialized, cancel)?
        {
            ContextRequestPreparation::Ready => (),
            other => return Ok(other),
        }
        let (configuration, revision) = {
            let catalog = self.catalog.lock().map_err(failed)?;
            let run = catalog.run(&view.run_id).map_err(failed)?;
            if run.epoch != epoch || run.cancel_requested || run.state.terminal() {
                return Err(failed("Context request owner changed"));
            }
            let configuration: ModelSessionConfiguration =
                serde_json::from_value(run.configuration).map_err(failed)?;
            let revision = catalog
                .capture_active_checkpoint(&run.branch_id)
                .map_err(failed)?
                .map_or(0, |checkpoint| checkpoint.revision);
            (configuration, revision)
        };
        let Some(capacity) = configuration.context_window_tokens else {
            return Ok(ContextRequestPreparation::Ready);
        };
        let policy = self.policy(view, cancel)?;
        if !policy.enabled {
            return Ok(ContextRequestPreparation::Ready);
        }
        let estimate = estimate_request(view, serialized);
        let input_budget = capacity.saturating_sub(policy.reserve_tokens);
        // An estimate is a preparation signal, not an extra admission limit. With no reducible
        // source or no usable configured reserve, leave the actual request to its provider.
        if input_budget == 0 {
            return Ok(ContextRequestPreparation::Ready);
        }
        let block = estimate.estimated_tokens > input_budget;
        if !block
            && (!policy.background_preparation
                || estimate.estimated_tokens as f64
                    <= input_budget as f64 * policy.preparation_waterline)
        {
            return Ok(ContextRequestPreparation::Ready);
        }
        let history_tokens = view
            .history
            .iter()
            .map(estimate_item)
            .fold(0u64, u64::saturating_add);
        let fixed = estimate.estimated_tokens.saturating_sub(history_tokens);
        let summary_reserve = configuration
            .max_output_tokens
            .unwrap_or(policy.reserve_tokens);
        let recent = policy.keep_recent_tokens.min(
            input_budget
                .saturating_sub(fixed)
                .saturating_sub(summary_reserve),
        );
        let mut retained = 0u64;
        let mut end = view.history.len();
        while end > 0 && retained < recent {
            let next = estimate_item(&view.history[end - 1]);
            // KeepRecent is a target. One older oversized message need not drag an otherwise
            // small recent suffix back into the prefix we are trying to shorten.
            if retained > 0 && next > recent.saturating_sub(retained) {
                break;
            }
            end -= 1;
            retained = retained.saturating_add(next);
        }
        let mut pending = BTreeSet::new();
        let mut through = None;
        for (index, item) in view.history.iter().enumerate().take(end) {
            match &item.content {
                Content::ToolCall { call } => {
                    pending.insert(call.call_id.clone());
                }
                Content::ToolResult { result } => {
                    pending.remove(&result.call_id);
                }
                _ => {}
            }
            if !pending.is_empty() {
                continue;
            }
            match &item.provenance {
                Provenance::UserInstruction{input_id}=>{
                    if !view.history.get(index+1).is_some_and(|next|matches!(&next.provenance,Provenance::UserInstruction{input_id:next} if next==input_id)) {
                        through=Some(input_id.clone());
                    }
                },
                Provenance::Assistant|Provenance::ToolData{..}=>through=Some(item.id.clone()),
                _=>{},
            }
        }
        let Some(through) = through else {
            return Ok(ContextRequestPreparation::Ready);
        };
        let reply = self.bridge.query(
            json!({"action":"compact","runId":view.run_id,"requestId":view.request_id,
            "throughId":through,"expectedRevision":revision,"block":block}),
            cancel,
        )?;
        if reply["status"] != "ready" {
            if !block {
                return Ok(ContextRequestPreparation::Ready);
            }
            return Err(ExecutionError::new(
                reply["code"]
                    .as_str()
                    .unwrap_or("context_compaction_failed"),
                "Context compaction could not publish a continuation",
            ));
        }
        if reply["published"].as_bool() == Some(true) {
            return Ok(ContextRequestPreparation::Recompile);
        }
        if !block {
            return Ok(ContextRequestPreparation::Ready);
        }
        let job_id = reply["jobRunId"]
            .as_str()
            .ok_or_else(|| failed("Context job admission is missing"))?;
        let wait = self
            .catalog
            .lock()
            .map_err(failed)?
            .register_context_job_wait(&view.run_id, epoch, job_id, revision)
            .map_err(failed)?;
        Ok(match wait {
            Some(wait) => ContextRequestPreparation::Waiting { wait_id: wait.id },
            None => ContextRequestPreparation::Recompile,
        })
    }
}
