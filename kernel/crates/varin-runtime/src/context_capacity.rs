//! Local request estimates. They are never reported as provider measurements.
use crate::execution::{
    Content, RequestOrigin, RequestSnapshot, RequestView, UsageMeasurement, UsageReceipt,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextPolicy {
    pub configuration_identity: String,
    pub enabled: bool,
    pub reserve_tokens: u64,
    pub keep_recent_tokens: u64,
    pub background_preparation: bool,
    pub preparation_waterline: f64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputEstimate {
    pub estimated_tokens: u64,
    pub unmeasured_media: u64,
    pub unmeasured_provider_items: u64,
    pub method: &'static str,
}

/// The selected serializer declares its actual transcript layout and usage interpretation.
/// This is a derived, worker-local capability, not another usage record or provider registry.
#[derive(Clone, Copy)]
pub struct RequestBudgetProtocol {
    pub transcript: &'static [&'static str],
    /// Some serializers append same-role blocks to the final message instead of adding a message.
    pub coalesced_content: Option<&'static str>,
    pub complete_input_tokens: fn(&UsageReceipt) -> Option<u64>,
}

impl RequestBudgetProtocol {
    fn serialized_prefix(self, previous: &Value, current: &Value) -> bool {
        fn along(previous: &Value, current: &Value, path: &[&str], content: Option<&str>) -> bool {
            if let Some((key, rest)) = path.split_first() {
                let (Some(left), Some(right)) = (previous.as_object(), current.as_object()) else {
                    return false;
                };
                return left.len() == right.len()
                    && left.iter().all(|(field, value)| {
                        right.get(field).is_some_and(|next| {
                            if field == key {
                                along(value, next, rest, content)
                            } else {
                                value == next
                            }
                        })
                    })
                    && left.contains_key(*key);
            }
            let (Some(left), Some(right)) = (previous.as_array(), current.as_array()) else {
                return false;
            };
            left.len() <= right.len()
                && left
                    .iter()
                    .zip(right)
                    .enumerate()
                    .all(|(index, (value, next))| {
                        value == next
                            || (index + 1 == left.len()
                                && content.is_some_and(|field| {
                                    // Only the serializer's declared final block array may grow. Role, opaque
                                    // fields and every existing block remain exact; no semantic fields are erased.
                                    along(value, next, &[field], None)
                                }))
                    })
        }
        along(previous, current, self.transcript, self.coalesced_content)
    }
}

/// Apply one latest successful observation. A mismatch never searches for an older match.
pub fn calibrated_estimate(
    view: &RequestView,
    serialized: &Value,
    previous: &RequestSnapshot,
    usage: &UsageReceipt,
    protocol: RequestBudgetProtocol,
) -> InputEstimate {
    let mut estimate = estimate_request(view, serialized);
    let old = &previous.view;
    let a = &old.binding;
    let b = &view.binding;
    if usage.measurement != UsageMeasurement::Actual
        || !matches!(
            (&old.origin, &view.origin),
            (
                RequestOrigin::Conversation { .. },
                RequestOrigin::Conversation { .. }
            )
        )
        || a.history_range.branch_id != b.history_range.branch_id
        || a.history_range.ancestor_id != b.history_range.ancestor_id
        || a.connection_identity != b.connection_identity
        || a.provider_family != b.provider_family
        || a.model != b.model
        || a.credential_ref != b.credential_ref
        || a.configuration_generation != b.configuration_generation
        || a.tool_schema_generation != b.tool_schema_generation
        || a.tools != b.tools
        || a.instruction_sources != b.instruction_sources
        || a.memory_checkpoint != b.memory_checkpoint
        || a.resource_checkpoint_id != b.resource_checkpoint_id
        || a.child_dispatch != b.child_dispatch
        || a.goal != b.goal
        || !view.history.starts_with(&old.history)
        || !protocol.serialized_prefix(&previous.serialized, serialized)
    {
        return estimate;
    }
    if let Some(input) = (protocol.complete_input_tokens)(usage) {
        let old_estimate = estimate_request(old, &previous.serialized).estimated_tokens;
        // Keep signed deltas until the final clamp. Saturating input+current first would lose
        // precision near u64::MAX; an actual zero is a valid measurement.
        estimate.estimated_tokens = (i128::from(input) + i128::from(estimate.estimated_tokens)
            - i128::from(old_estimate))
        .clamp(0, i128::from(u64::MAX)) as u64;
        estimate.method = "actual-input-calibrated; utf8-bytes/4 delta; media unmeasured";
    }
    estimate
}
fn media(object: &serde_json::Map<String, Value>) -> bool {
    matches!(
        object.get("type").and_then(Value::as_str),
        Some("input_image" | "image_url" | "image" | "input_file")
    ) || object.contains_key("inlineData")
        || object.contains_key("inline_data")
        || object.contains_key("image") && object.len() == 1
}
fn size(value: &Value) -> u64 {
    match value {
        Value::Null => 4,
        Value::Bool(value) => {
            if *value {
                4
            } else {
                5
            }
        }
        Value::Number(value) => value.to_string().len() as u64,
        Value::String(value) => {
            if value.starts_with("data:image/") {
                0
            } else {
                value.len() as u64 + 2
            }
        }
        Value::Array(values) => values.iter().fold(2u64, |bytes, value| {
            bytes.saturating_add(size(value)).saturating_add(1)
        }),
        Value::Object(values) if media(values) => 0,
        Value::Object(values) => values
            .iter()
            .filter(|(key, _)| {
                !(matches!(
                    values.get("type").and_then(Value::as_str),
                    Some("reasoning" | "thinking")
                ) && matches!(key.as_str(), "encrypted_content" | "signature"))
                    && !(values.contains_key("text") && key.as_str() == "thoughtSignature")
            })
            .fold(2u64, |bytes, (key, value)| {
                bytes
                    .saturating_add(key.len() as u64 + 4)
                    .saturating_add(size(value))
            }),
    }
}
pub fn estimate_request(view: &RequestView, serialized: &Value) -> InputEstimate {
    InputEstimate {
        estimated_tokens: size(serialized).div_ceil(4),
        unmeasured_media: view
            .history
            .iter()
            .map(|item| item.content.media().len() as u64)
            .sum(),
        unmeasured_provider_items: view
            .history
            .iter()
            .filter(|item| matches!(item.content, Content::ProviderOnly))
            .count() as u64,
        method: "utf8-bytes/4; media excluded",
    }
}
pub fn estimate_item(item: &crate::execution::ConversationItem) -> u64 {
    // Only complete semantic content participates. Opaque provider signatures and base64
    // transport bytes are not ordinary text tokens and cannot be assigned an invented cost.
    match &item.content {
        Content::Text { text } | Content::ReasoningSummary { text } => {
            (text.len() as u64).div_ceil(4)
        }
        Content::Media { .. } | Content::ProviderOnly => 0,
        _ => {
            let projected = item
                .clone()
                .map_media(|media| {
                    Ok::<_, std::convert::Infallible>(crate::output::ResolvedMedia {
                        data_base64: String::new(),
                        ..media
                    })
                })
                .unwrap();
            (serde_json::to_vec(&projected.content)
                .expect("semantic content serializes")
                .len() as u64)
                .div_ceil(4)
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetCandidate {
    pub through_id: String,
    pub prefix_estimated_tokens: u64,
    pub retained_estimated_tokens: u64,
    #[serde(skip)]
    pub end_index: usize,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BudgetDecision {
    Continue,
    Compact {
        #[serde(rename = "throughId")]
        through_id: String,
        mode: crate::context_job::ContextCompactionMode,
        #[serde(
            rename = "summaryInstructions",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        summary_instructions: Option<String>,
    },
}
/// Candidates derive only from this actual request. The original admission subsequently proves
/// immutable ancestry and validates all source tool pairs again before freezing any excerpts.
pub fn budget_candidates(view: &RequestView) -> Vec<BudgetCandidate> {
    let total = view
        .history
        .iter()
        .map(estimate_item)
        .fold(0u64, u64::saturating_add);
    let mut prefix = 0u64;
    let mut pending = std::collections::BTreeSet::new();
    let mut candidates = Vec::new();
    for (index, item) in view.history.iter().enumerate() {
        prefix = prefix.saturating_add(estimate_item(item));
        match &item.content {
            crate::execution::Content::ToolCall { call } => {
                pending.insert(call.call_id.clone());
            }
            crate::execution::Content::ToolResult { result } => {
                pending.remove(&result.call_id);
            }
            _ => (),
        }
        if !pending.is_empty() {
            continue;
        }
        let through = match &item.provenance {
            crate::execution::Provenance::UserInstruction { input_id } => {
                if view.history.get(index + 1).is_some_and(|next| matches!(&next.provenance,
                    crate::execution::Provenance::UserInstruction { input_id: next } if next == input_id)) { continue; }
                input_id.clone()
            }
            crate::execution::Provenance::Assistant
            | crate::execution::Provenance::ToolData { .. } => item.id.clone(),
            _ => continue,
        };
        candidates.push(BudgetCandidate {
            through_id: through,
            prefix_estimated_tokens: prefix,
            retained_estimated_tokens: total.saturating_sub(prefix),
            end_index: index + 1,
        });
    }
    candidates
}
pub fn native_mode(
    policy: &ContextPolicy,
    capacity: u64,
    estimate: &InputEstimate,
) -> Option<crate::context_job::ContextCompactionMode> {
    use crate::context_job::ContextCompactionMode;
    let input_budget = capacity.saturating_sub(policy.reserve_tokens);
    if !policy.enabled || input_budget == 0 {
        return None;
    }
    if estimate.estimated_tokens > input_budget {
        return Some(ContextCompactionMode::Blocking);
    }
    (policy.background_preparation
        && estimate.estimated_tokens as f64 > input_budget as f64 * policy.preparation_waterline)
        .then_some(ContextCompactionMode::Background)
}
pub fn native_candidate<'a>(
    view: &RequestView,
    candidates: &'a [BudgetCandidate],
    policy: &ContextPolicy,
    capacity: u64,
    max_output_tokens: Option<u64>,
    estimate: &InputEstimate,
) -> Option<&'a BudgetCandidate> {
    let history_tokens = view
        .history
        .iter()
        .map(estimate_item)
        .fold(0u64, u64::saturating_add);
    let fixed = estimate.estimated_tokens.saturating_sub(history_tokens);
    let recent = policy.keep_recent_tokens.min(
        capacity
            .saturating_sub(policy.reserve_tokens)
            .saturating_sub(fixed)
            .saturating_sub(max_output_tokens.unwrap_or(policy.reserve_tokens)),
    );
    let mut retained = 0u64;
    let mut end = view.history.len();
    while end > 0 && retained < recent {
        let next = estimate_item(&view.history[end - 1]);
        if retained > 0 && next > recent.saturating_sub(retained) {
            break;
        }
        end -= 1;
        retained = retained.saturating_add(next);
    }
    candidates
        .iter()
        .rev()
        .find(|candidate| candidate.end_index <= end)
}
