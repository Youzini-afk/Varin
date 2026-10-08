//! The locked SDK's `mistral-conversations` family uses /v1/chat/completions.
//! This is not an implementation of Mistral's separate stateful Conversations API.
use super::*;
use serde_json::json;
use std::collections::BTreeMap;
pub const FAMILY: &str = "mistral-conversations";
pub struct MistralProvider {
    inner: chat::ChatProvider,
    pub prompt_mode: Option<String>,
    pub prompt_cache_key: Option<String>,
}
impl MistralProvider {
    pub fn new(connection: Connection) -> Self {
        Self {
            inner: chat::ChatProvider::mistral(connection),
            prompt_mode: None,
            prompt_cache_key: None,
        }
    }
    pub fn set_max_output_tokens(&mut self, max: u64) {
        self.inner.max_output_tokens = Some(max);
    }
    pub fn set_reasoning_effort(&mut self, effort: Option<String>) {
        self.inner.reasoning_effort = effort;
    }
}
/// Stable non-secret wire ID allocation. Collisions are resolved by the request-wide map below.
pub(super) fn derive_id(value: &str, attempt: u64) -> String {
    if attempt == 0 && value.len() == 9 && value.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return value.into();
    }
    let mut hash = 14695981039346656037u64;
    for byte in value.bytes().chain(attempt.to_le_bytes()) {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(1099511628211);
    }
    let alphabet = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut output = [b'0'; 9];
    for byte in output.iter_mut().rev() {
        *byte = alphabet[(hash % 62) as usize];
        hash /= 62;
    }
    String::from_utf8(output.to_vec()).expect("ASCII alphabet")
}
#[derive(Default)]
struct Ids {
    forward: BTreeMap<String, String>,
    reverse: BTreeMap<String, String>,
}
impl Ids {
    fn map(&mut self, id: &str) -> String {
        if let Some(value) = self.forward.get(id) {
            return value.clone();
        }
        let mut attempt = 0;
        loop {
            let candidate = derive_id(id, attempt);
            if self.reverse.get(&candidate).is_none_or(|owner| owner == id) {
                self.forward.insert(id.into(), candidate.clone());
                self.reverse.insert(candidate.clone(), id.into());
                return candidate;
            }
            attempt += 1;
        }
    }
}
impl ModelProvider for MistralProvider {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        let mut body = self.inner.serialize(view)?;
        body.as_object_mut().expect("compiled object").remove("n");
        if let Some(mode) = &self.prompt_mode {
            body["prompt_mode"] = json!(mode);
        }
        if let Some(key) = &self.prompt_cache_key {
            body["prompt_cache_key"] = json!(key);
        }
        let mut ids = Ids::default();
        let mut names = BTreeMap::new();
        for item in &view.history {
            if let Content::ToolCall { call } = &item.content {
                names.insert(call.call_id.clone(), call.name.clone());
            }
        }
        for message in body["messages"].as_array_mut().expect("compiled messages") {
            if message["role"] == "assistant" {
                message["prefix"] = json!(false);
            }
            if message["role"] == "tool" {
                let id = message["tool_call_id"]
                    .as_str()
                    .ok_or_else(|| {
                        ExecutionError::new(
                            "invalid_history_pairing",
                            "Mistral tool result lacks call identity",
                        )
                    })?
                    .to_owned();
                message["name"] = json!(names.get(&id).ok_or_else(|| ExecutionError::new(
                    "invalid_history_pairing",
                    "Mistral tool result lacks call name"
                ))?);
                message["tool_call_id"] = json!(ids.map(&id));
            }
            if let Some(calls) = message["tool_calls"].as_array_mut() {
                for call in calls {
                    let id = call["id"]
                        .as_str()
                        .ok_or_else(|| {
                            ExecutionError::new(
                                "invalid_history_pairing",
                                "Mistral tool call lacks identity",
                            )
                        })?
                        .to_owned();
                    call["id"] = json!(ids.map(&id));
                }
            }
            if let Some(parts) = message["content"].as_array_mut() {
                for part in parts {
                    if part["type"] == "image_url" && part["image_url"].is_object() {
                        part["image_url"] = part["image_url"]["url"].clone();
                    }
                }
            }
        }
        Ok(body)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        self.inner.generate(request, cancel, emit)
    }
}
