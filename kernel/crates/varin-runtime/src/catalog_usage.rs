//! Read-only usage over original branch execution records. No derived billing ledger.
use super::*;
use crate::execution::{RequestOrigin, UsageMeasurement, UsageReceipt};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadUsageParams { pub thread_id: String, pub branch_id: String }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageTokenCount { pub known: Option<String>, pub missing: u64 }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadUsageRow {
    pub kind: String, pub provider_id: Option<String>, pub provider_family: Option<String>, pub model_id: String,
    pub measurement: UsageMeasurement, pub requests: u64, pub pending_requests: u64,
    pub input_tokens: UsageTokenCount, pub output_tokens: UsageTokenCount,
    pub cached_input_tokens: UsageTokenCount, pub cache_write_tokens: UsageTokenCount, pub reasoning_tokens: UsageTokenCount,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadUsage {
    pub thread_id: String, pub branch_id: String, pub through_cursor: u64,
    pub not_dispatched_requests: u64, pub rows: Vec<ThreadUsageRow>,
}
#[derive(Deserialize)]
struct SnapshotMetadata { view: ViewMetadata }
#[derive(Deserialize)]
struct ViewMetadata { origin: RequestOrigin, binding: BindingMetadata }
#[derive(Deserialize)]
struct BindingMetadata { provider_family: String, model: String }

pub struct ThreadUsageRead {
    selection: ThreadUsageParams, cursor: u64, steps: Vec<ModelStep>, operations: Vec<Operation>,
    content: crate::content::ContentStore, _publication: crate::content::ContentPublication,
}
impl Catalog {
    /// Freeze metadata under Catalog ownership. Request-body reads happen after releasing it.
    /// A branch owns its executed work, including context work and hidden/rewound history.
    /// Child Threads and standalone utility Runs never enter this exact branch query.
    pub fn capture_thread_usage(&self, selection: &ThreadUsageParams) -> Result<ThreadUsageRead> {
        if self.branch_thread_id(&selection.branch_id)? != selection.thread_id {
            return Err(RuntimeError::Invalid("usage branch belongs to another thread".into()));
        }
        let read = |table: &str, filter: &str| -> Result<Vec<String>> {
            let mut statement = self.db.prepare(&format!("SELECT x.body FROM {table} x JOIN runs r ON r.id=x.run_id JOIN branches b ON b.id=r.branch_id WHERE b.thread_id=?1 AND b.id=?2 {filter} ORDER BY x.rowid"))?;
            let rows = statement.query_map(params![selection.thread_id, selection.branch_id], |row| row.get(0))?;
            Ok(rows.collect::<std::result::Result<_, _>>()?)
        };
        let steps = read("model_steps", "")?.into_iter().map(|body| serde_json::from_str(&body)).collect::<std::result::Result<_, _>>()?;
        let operations = read("operations", "AND json_extract(x.body,'$.intent.kind') IN ('inference_request_v1','policy_model_job_v1','mcp_sampling_generation_v1')")?
            .into_iter().map(|body| serde_json::from_str(&body)).collect::<std::result::Result<_, _>>()?;
        Ok(ThreadUsageRead { selection: selection.clone(), cursor: self.event_cursor()?, steps, operations,
            content: self.content.clone(), _publication: self.content.begin_publication() })
    }
}
#[derive(Default)]
struct Counter { known: Option<u128>, missing: u64 }
impl Counter {
    fn add(&mut self, value: Option<u64>) -> Result<()> {
        if let Some(value) = value {
            self.known = Some(self.known.unwrap_or(0).checked_add(u128::from(value))
                .ok_or_else(|| RuntimeError::Invalid("usage counter overflow".into()))?);
        } else { self.missing += 1; }
        Ok(())
    }
    fn finish(self) -> UsageTokenCount { UsageTokenCount { known: self.known.map(|value| value.to_string()), missing: self.missing } }
}
struct Aggregate {
    kind: String, provider_id: Option<String>, provider_family: Option<String>, model_id: String,
    measurement: UsageMeasurement, requests: u64, pending: u64, tokens: [Counter; 5],
}
impl Aggregate {
    fn finish(self) -> ThreadUsageRow {
        let [input, output, cached, write, reasoning] = self.tokens;
        ThreadUsageRow { kind: self.kind, provider_id: self.provider_id, provider_family: self.provider_family, model_id: self.model_id,
            measurement: self.measurement, requests: self.requests, pending_requests: self.pending,
            input_tokens: input.finish(), output_tokens: output.finish(), cached_input_tokens: cached.finish(), cache_write_tokens: write.finish(), reasoning_tokens: reasoning.finish() }
    }
}
fn add(rows: &mut BTreeMap<String, Aggregate>, kind: &str, provider_id: Option<String>, provider_family: Option<String>, model_id: String,
    usage: UsageReceipt, pending: bool) -> Result<()> {
    if model_id.is_empty() { return Err(RuntimeError::Invalid("original usage model is missing".into())); }
    let key = serde_json::to_string(&(kind, &provider_id, &provider_family, &model_id, usage.measurement))?;
    let row = rows.entry(key).or_insert_with(|| Aggregate { kind: kind.into(), provider_id, provider_family, model_id,
        measurement: usage.measurement, requests: 0, pending: 0, tokens: Default::default() });
    row.requests += 1; row.pending += u64::from(pending);
    for (counter, value) in row.tokens.iter_mut().zip([usage.input_tokens, usage.output_tokens, usage.cached_input_tokens, usage.cache_write_tokens, usage.reasoning_tokens]) { counter.add(value)?; }
    Ok(())
}
impl ThreadUsageRead {
    pub fn load(self, cancelled: &dyn Fn() -> bool) -> Result<ThreadUsage> {
        let check = || if cancelled() { Err(RuntimeError::DispatchCancelled) } else { Ok(()) };
        let snapshot = |reference: &Value| -> Result<SnapshotMetadata> {
            // Deserialize attribution only: media, prompt text and wire payload stay private.
            Ok(serde_json::from_slice(&self.content.load_bytes(reference, cancelled)?)?)
        };
        let mut rows = BTreeMap::new(); let mut not_dispatched = 0;
        for step in &self.steps {
            check()?;
            let metadata = snapshot(&step.request)?;
            let kind = match metadata.view.origin {
                RequestOrigin::Conversation { compaction: Some(_), .. } => "context",
                RequestOrigin::Conversation { .. } => "conversation",
                // Auxiliary, sampling and policy requests retain their own original Operation receipt.
                // Never count a mirrored ModelStep as a second paid request.
                _ => continue,
            };
            if matches!(step.state, ModelStepState::Prepared | ModelStepState::NotDispatched) { not_dispatched += 1; continue; }
            let usage = step.usage.clone().map(serde_json::from_value).transpose()?.unwrap_or_default();
            add(&mut rows, kind, None, Some(metadata.view.binding.provider_family), metadata.view.binding.model,
                usage, step.state == ModelStepState::Dispatched)?;
        }
        for op in &self.operations {
            check()?;
            match op.intent["kind"].as_str() {
                Some("inference_request_v1") => {
                    let binding: inference::InferenceBinding = serde_json::from_value(op.intent["binding"].clone())?;
                    if binding.request_kind != inference::InferenceRequestKind::ModelCompute { continue; }
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct State { dispatched: bool, receipt: Option<inference::InferenceReceipt>, checkpoint_usage: inference::InferenceUsage }
                    let state: State = serde_json::from_value(op.result.as_ref().ok_or_else(|| RuntimeError::Invalid("inference state missing".into()))?.control()?.clone())?;
                    if !state.dispatched || state.receipt.as_ref().is_some_and(|receipt| receipt.request_started == Some(false)) { not_dispatched += 1; continue; }
                    let usage = state.receipt.map(|receipt| receipt.usage).unwrap_or(state.checkpoint_usage);
                    add(&mut rows, "auxiliary", Some(binding.provider_id), None, binding.model_id, UsageReceipt {
                        measurement: usage.measurement, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
                        cached_input_tokens: usage.cached_input_tokens, cache_write_tokens: usage.cache_write_tokens,
                        reasoning_tokens: usage.reasoning_tokens, pricing_version: usage.pricing_version, raw: None,
                    }, op.phase != OperationPhase::Terminal)?;
                }
                Some("policy_model_job_v1") => {
                    let state = policy_model::model_result(op)?;
                    if state.dispatch == crate::execution::PolicyModelDispatch::Prepared { not_dispatched += 1; continue; }
                    let metadata = snapshot(&state.request_ref)?;
                    let pending = state.receipt.is_none(); let usage = state.receipt.map(|receipt| receipt.usage).unwrap_or_default();
                    add(&mut rows, "planning", None, Some(metadata.view.binding.provider_family), metadata.view.binding.model, usage, pending)?;
                }
                Some("mcp_sampling_generation_v1") => {
                    let state = mcp_interactions::sampling::projection(op)?;
                    if state.dispatch == "not_started" { not_dispatched += 1; continue; }
                    let model = state.model.ok_or_else(|| RuntimeError::Invalid("sampling model attribution missing".into()))?;
                    add(&mut rows, "mcp_sampling", model.provider_id, Some(model.provider_family), model.model,
                        UsageReceipt::from(&state.usage), op.phase != OperationPhase::Terminal)?;
                }
                _ => unreachable!("capture selects usage owners only"),
            }
        }
        check()?;
        Ok(ThreadUsage { thread_id: self.selection.thread_id, branch_id: self.selection.branch_id, through_cursor: self.cursor,
            not_dispatched_requests: not_dispatched, rows: rows.into_values().map(Aggregate::finish).collect() })
    }
}
