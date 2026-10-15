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
/// Allocate IDs in original wire order, before consulting the derived message cache.
pub(super) struct MessageEncoding<'a> {
    ids: Ids,
    names: BTreeMap<&'a str, &'a str>,
}
#[derive(serde::Serialize)]
pub(super) struct MappedMessage {
    result: Option<(String, String)>,
    calls: Vec<String>,
}
impl<'a> MessageEncoding<'a> {
    pub(super) fn new(view: &'a RequestView) -> Self {
        let names = view
            .history
            .iter()
            .filter_map(|item| match &item.content {
                Content::ToolCall { call } => Some((call.call_id.as_str(), call.name.as_str())),
                _ => None,
            })
            .collect();
        Self {
            ids: Ids::default(),
            names,
        }
    }
    pub(super) fn prepare(
        &mut self,
        items: &[ProjectedHistoryItem<'_>],
        media: bool,
    ) -> Result<MappedMessage, ExecutionError> {
        let mut mapped = MappedMessage {
            result: None,
            calls: Vec::new(),
        };
        if media {
            return Ok(mapped);
        }
        let first = items.first().expect("Chat message source");
        let result = if let Some(original) = first.opaque {
            if original.value["role"] == "tool" {
                Some(original.value["tool_call_id"].as_str().ok_or_else(|| {
                    ExecutionError::new(
                        "invalid_history_pairing",
                        "Mistral tool result lacks call identity",
                    )
                })?)
            } else {
                None
            }
        } else if let Content::ToolResult { result } = &first.item.content {
            Some(result.call_id.as_str())
        } else {
            None
        };
        if let Some(id) = result {
            let name = self.names.get(id).ok_or_else(|| {
                ExecutionError::new(
                    "invalid_history_pairing",
                    "Mistral tool result lacks call name",
                )
            })?;
            mapped.result = Some((self.ids.map(id), (*name).into()));
        }
        for projected in items {
            if let Some(original) = projected.opaque {
                if let Some(calls) = original.value["tool_calls"].as_array() {
                    for call in calls {
                        let id = call["id"].as_str().ok_or_else(|| {
                            ExecutionError::new(
                                "invalid_history_pairing",
                                "Mistral tool call lacks identity",
                            )
                        })?;
                        mapped.calls.push(self.ids.map(id));
                    }
                }
            } else if let Content::ToolCall { call } = &projected.item.content {
                mapped.calls.push(self.ids.map(&call.call_id));
            }
        }
        Ok(mapped)
    }
}
impl MappedMessage {
    pub(super) fn apply(self, message: &mut Value) {
        if message["role"] == "assistant" {
            message["prefix"] = json!(false);
        }
        if let Some((id, name)) = self.result {
            message["tool_call_id"] = Value::String(id);
            message["name"] = Value::String(name);
        }
        if let Some(calls) = message["tool_calls"].as_array_mut() {
            for (call, id) in calls.iter_mut().zip(self.calls) {
                call["id"] = Value::String(id);
            }
        }
        if let Some(parts) = message["content"].as_array_mut() {
            for part in parts {
                if part["type"] == "image_url" && part["image_url"].is_object() {
                    part["image_url"] = part["image_url"]["url"].take();
                }
            }
        }
    }
}
impl ModelProvider for MistralProvider {
    fn request_budget_protocol(&self) -> Option<crate::context_capacity::RequestBudgetProtocol> {
        self.inner.request_budget_protocol()
    }

    fn serialize(
        &self,
        view: &RequestView,
        reuse: Option<&mut RequestCompileReuse>,
    ) -> Result<RequestBody, ExecutionError> {
        let mut body = self.inner.compile_body(view, reuse)?;
        body.remove("n");
        if let Some(mode) = &self.prompt_mode {
            body.insert("prompt_mode", json!(mode));
        }
        if let Some(key) = &self.prompt_cache_key {
            body.insert("prompt_cache_key", json!(key));
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
