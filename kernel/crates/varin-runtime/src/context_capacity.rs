//! Local request estimates. They are never reported as provider measurements.
use crate::execution::{
    Content, RequestBody, RequestOrigin, RequestSnapshot, RequestView, UsageMeasurement, UsageReceipt,
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
    pub explicit_keep_recent_tokens: Option<u64>,
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
    fn serialized_prefix(self, previous: &RequestBody, current: &RequestBody) -> bool {
        previous.transcript_prefix(current, self.transcript, self.coalesced_content)
    }
}

/// Apply one latest successful observation. A mismatch never searches for an older match.
pub fn calibrated_estimate(
    view: &RequestView,
    serialized: &RequestBody,
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
pub(crate) fn size(value: &Value) -> u64 {
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
pub fn estimate_request(view: &RequestView, serialized: &RequestBody) -> InputEstimate {
    InputEstimate {
        estimated_tokens: serialized.estimated_bytes().div_ceil(4),
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
        .map(|item| estimate_item(item))
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
/// Recent same-configuration observations. Missing duration/rate stays missing, not zero.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparationTiming {
    pub duration_ms: Option<f64>,
    pub tokens_per_ms: Option<f64>,
    pub pending_tokens: u64,
}
impl PreparationTiming {
    pub fn expected_growth(&self) -> Option<u64> {
        let (duration, rate) = (self.duration_ms?, self.tokens_per_ms?);
        (duration.is_finite() && duration > 0.0 && rate.is_finite() && rate >= 0.0)
            .then(|| (duration * rate).ceil() as u64)
    }
    pub fn waterline(&self, base: f64, input_budget: u64) -> f64 {
        let Some(growth) = self.expected_growth() else {
            return base;
        };
        if input_budget == 0 {
            return base;
        }
        // The known delta is already in the current estimate; it advances preparation only.
        // Expected future growth is also reserved when planning the fixed retained tail.
        (base - 2.0 * growth.saturating_add(self.pending_tokens) as f64 / input_budget as f64)
            .max(base / 2.0)
    }
}
pub fn native_mode(
    policy: &ContextPolicy,
    capacity: u64,
    estimate: &InputEstimate,
    timing: &PreparationTiming,
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
        && estimate.estimated_tokens as f64
            > input_budget as f64 * timing.waterline(policy.preparation_waterline, input_budget))
    .then_some(ContextCompactionMode::Background)
}
pub fn native_candidate<'a>(
    view: &RequestView,
    candidates: &'a [BudgetCandidate],
    policy: &ContextPolicy,
    capacity: u64,
    max_output_tokens: Option<u64>,
    estimate: &InputEstimate,
    timing: &PreparationTiming,
) -> Option<&'a BudgetCandidate> {
    let history_tokens = view
        .history
        .iter()
        .map(|item| estimate_item(item))
        .fold(0u64, u64::saturating_add);
    let original_start = view
        .history
        .iter()
        .position(|item| {
            matches!(
                item.provenance,
                crate::execution::Provenance::UserInstruction { .. }
                    | crate::execution::Provenance::Assistant
                    | crate::execution::Provenance::ToolData { .. }
            )
        })
        .unwrap_or(view.history.len());
    let prefix = view.history[..original_start].iter().filter(|item| !matches!(&item.provenance,
        crate::execution::Provenance::ExternalData { source } if source.starts_with("conversation-summary:")))
        .map(|item| estimate_item(item)).fold(0u64, u64::saturating_add);
    let fixed = estimate
        .estimated_tokens
        .saturating_sub(history_tokens)
        .saturating_add(prefix);
    let input_budget = capacity.saturating_sub(policy.reserve_tokens);
    let summary_output = max_output_tokens.unwrap_or(policy.reserve_tokens);
    let available = input_budget
        .saturating_sub(fixed)
        .saturating_sub(summary_output);
    let recent = policy
        .explicit_keep_recent_tokens
        .unwrap_or_else(|| {
            // P + planned S1 + B + future N, not B alone. Current known N is already in history.
            input_budget
                .saturating_mul(3)
                .saturating_div(5)
                .saturating_sub(fixed)
                .saturating_sub(summary_output)
                .saturating_sub(timing.expected_growth().unwrap_or(0))
                .max(1)
        })
        .min(available);
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

#[cfg(test)]
mod preparation_tests {
    use super::*;
    use crate::context_job::ContextCompactionMode;
    use serde_json::json;
    fn policy() -> ContextPolicy {
        ContextPolicy {
            configuration_identity: "settings".into(),
            enabled: true,
            reserve_tokens: 200,
            keep_recent_tokens: 20000,
            explicit_keep_recent_tokens: None,
            background_preparation: true,
            preparation_waterline: 0.75,
        }
    }
    fn estimate(tokens: u64) -> InputEstimate {
        InputEstimate {
            estimated_tokens: tokens,
            unmeasured_media: 0,
            unmeasured_provider_items: 0,
            method: "fixture",
        }
    }
    #[test]
    fn observed_duration_and_growth_advance_preparation_but_never_submission() {
        let mut policy = policy();
        let missing = PreparationTiming {
            duration_ms: None,
            tokens_per_ms: Some(2.0),
            pending_tokens: 500,
        };
        assert_eq!(native_mode(&policy, 2000, &estimate(1000), &missing), None);
        let measured = PreparationTiming {
            duration_ms: Some(200.0),
            tokens_per_ms: Some(2.0),
            pending_tokens: 100,
        };
        assert_eq!(
            native_mode(&policy, 2000, &estimate(1000), &measured),
            Some(ContextCompactionMode::Background)
        );
        assert_eq!(
            native_mode(&policy, 2000, &estimate(1800), &measured),
            Some(ContextCompactionMode::Background)
        );
        assert_eq!(
            native_mode(&policy, 2000, &estimate(1801), &measured),
            Some(ContextCompactionMode::Blocking)
        );
        policy.background_preparation = false;
        assert_eq!(native_mode(&policy, 2000, &estimate(1800), &measured), None);
        assert_eq!(
            native_mode(&policy, 2000, &estimate(1801), &measured),
            Some(ContextCompactionMode::Blocking)
        );
    }
    #[test]
    fn default_retention_targets_total_input_and_reserves_projected_growth() {
        let mut policy = policy();
        let mut view: RequestView = serde_json::from_value(json!({"request_id":"request","run_id":"run",
            "origin":{"kind":"conversation","step":1,"history_range":{"branch_id":"branch","ancestor_id":null,"leaf_id":null}},
            "binding":{"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"fixture","provider_family":"fixture","model":"fixture",
                "credential_ref":null,"configuration_generation":1,"tool_schema_generation":0,"tools":[],"instruction_sources":[],"memory_checkpoint":null,
                "attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":"branch","ancestor_id":null,"leaf_id":null}},"history":[]})).unwrap();
        view.history.push(crate::execution::ConversationItem {
            id: "system".into(),
            resource_activation: None,
            provenance: crate::execution::Provenance::SystemInstruction {
                source: "fixture".into(),
            },
            content: Content::Text {
                text: "S".repeat(800),
            },
            opaque: None,
        }.into());
        for n in 0..10 {
            let id = format!("user-{n}");
            view.history.push(crate::execution::ConversationItem {
                id: id.clone(),
                resource_activation: None,
                provenance: crate::execution::Provenance::UserInstruction { input_id: id },
                content: Content::Text {
                    text: "T".repeat(400),
                },
                opaque: None,
            }.into());
        }
        let candidates = budget_candidates(&view);
        let cold = PreparationTiming::default();
        let candidate = native_candidate(
            &view,
            &candidates,
            &policy,
            2000,
            Some(100),
            &estimate(1200),
            &cold,
        )
        .unwrap();
        assert_eq!(candidate.retained_estimated_tokens, 700); // P=200, S1 reserve=100, B=700, total=1000 <= 1080.
        let warm = PreparationTiming {
            duration_ms: Some(200.0),
            tokens_per_ms: Some(1.0),
            pending_tokens: 0,
        };
        assert_eq!(
            native_candidate(
                &view,
                &candidates,
                &policy,
                2000,
                Some(100),
                &estimate(1200),
                &warm
            )
            .unwrap()
            .retained_estimated_tokens,
            500
        );
        policy.explicit_keep_recent_tokens = Some(300);
        assert_eq!(
            native_candidate(
                &view,
                &candidates,
                &policy,
                2000,
                Some(100),
                &estimate(1200),
                &warm
            )
            .unwrap()
            .retained_estimated_tokens,
            300
        );
        assert_eq!(
            view.history.len(),
            11,
            "Planning cannot truncate source or unsummarized tail"
        );
    }
}
