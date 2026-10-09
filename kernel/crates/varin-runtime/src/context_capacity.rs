//! Local request estimates. They are never reported as provider measurements.
use crate::execution::{Content, RequestView};
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
            .filter(|item| matches!(item.content, Content::Attachment { .. }))
            .count() as u64,
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
        Content::Attachment { .. } | Content::ProviderOnly => 0,
        content => {
            size(&serde_json::to_value(content).expect("semantic content serializes")).div_ceil(4)
        }
    }
}
