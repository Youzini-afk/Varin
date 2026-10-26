//! Read-only attribution of the frozen provider request. Never derives a prompt from current settings.
use crate::{RuntimeError, token_count::{self, TokenCounter, TokenizerBinding}};
use serde::{Serialize, Deserialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelContextComposition {
    pub checkpoint_id: Option<String>,
    pub summary_id: Option<String>,
    pub total_tokens: u64,
    pub categories: BTreeMap<String, u64>,
    pub parts: BTreeMap<String, BTreeMap<String, u64>>,
    pub method: String,
    pub unmeasured_media: u64,
    pub unmeasured_provider_items: u64,
}
struct Reader<'a> {
    counter: TokenCounter,
    mcp: BTreeSet<String>,
    calls: BTreeMap<String, &'static str>,
    summaries: Vec<String>,
    result: ModelContextComposition,
    cancelled: &'a dyn Fn() -> bool,
}
fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> { value.get(key).and_then(Value::as_str) }
impl Reader<'_> {
    fn add(&mut self, category: &str, part: &str, amount: u64) {
        *self.result.categories.entry(category.into()).or_default() += amount;
        *self.result.parts.entry(category.into()).or_default().entry(part.into()).or_default() += amount;
        self.result.total_tokens += amount;
    }
    fn tool_category(&self, value: &Value) -> &'static str {
        for key in ["tool_call_id", "tool_use_id", "call_id", "id", "toolUseId"] {
            if let Some(category) = text(value, key).and_then(|id| self.calls.get(id)) { return category; }
        }
        let name = text(value, "name").or_else(|| value.pointer("/function/name").and_then(Value::as_str))
            .or_else(|| value.pointer("/toolSpec/name").and_then(Value::as_str));
        if name.is_some_and(|name| self.mcp.contains(name)) { "mcp" } else { "tools" }
    }
    fn leaf(&mut self, value: &Value, category: &str, part: &str) {
        // Summary text can share a provider text block with an envelope. Attribute exact
        // retained substrings rather than guessing from role, wording or message length.
        if let Value::String(value) = value {
            if !value.starts_with("data:image/") {
                if let Some(summary) = self.summaries.iter().find(|summary| !summary.is_empty() && value.contains(summary.as_str())).cloned() {
                    let offset = value.find(&summary).unwrap();
                    self.add(category, part, self.counter.count(&value[..offset]));
                    self.add("summary", "messages", self.counter.count(&summary));
                    self.add(category, part, self.counter.count(&value[offset + summary.len()..]));
                    return;
                }
            }
        }
        self.add(category, part, self.counter.json(value));
    }
    fn definitions(&mut self, value: &Value) -> Result<(), RuntimeError> {
        match value {
            Value::Array(values) => {
                self.add("other", "envelope", self.counter.count("[]"));
                for value in values { self.definitions(value)?; self.add("other", "envelope", self.counter.count(",")); }
            }
            Value::Object(object) if object.contains_key("functionDeclarations") || object.contains_key("function_declarations") || object.contains_key("tools") => {
                self.add("other", "envelope", self.counter.count("{}"));
                for (key, value) in object {
                    self.add("other", "envelope", self.counter.field(key));
                    if matches!(key.as_str(), "functionDeclarations" | "function_declarations" | "tools") { self.definitions(value)?; }
                    else { self.leaf(value, "other", "envelope"); }
                }
            }
            _ => { self.add(self.tool_category(value), "definitions", self.counter.json(value)); }
        }
        Ok(())
    }
    fn node(&mut self, value: &Value, inherited: &str, message: bool) -> Result<(), RuntimeError> {
        if (self.cancelled)() { return Err(RuntimeError::DispatchCancelled); }
        match value {
            Value::Array(values) => {
                self.add("other", "envelope", self.counter.count("[]"));
                for value in values { self.node(value, inherited, message)?; self.add("other", "envelope", self.counter.count(",")); }
            }
            Value::Object(object) if token_count::media(object) => {},
            Value::Object(object) => {
                let kind = text(value, "type").unwrap_or("");
                let role = if message { text(value, "role").unwrap_or("") } else { "" };
                let category = match role { "system" | "developer" => "system", "user" => "user", "assistant" | "model" => "assistant", _ => inherited };
                let result = matches!(kind, "function_call_output" | "tool_result") || matches!(role, "tool" | "function");
                if result || matches!(kind, "function_call" | "tool_use") {
                    self.add(self.tool_category(value), if result { "results" } else { "calls" }, self.counter.json(value));
                    return Ok(());
                }
                self.add("other", "envelope", self.counter.count("{}"));
                for (key, child) in object {
                    if token_count::opaque(object, key) { continue; }
                    self.add("other", "envelope", self.counter.field(key));
                    match key.as_str() {
                        "tool_calls" => {
                            if let Some(calls) = child.as_array() {
                                self.add("other", "envelope", self.counter.count("[]"));
                                for call in calls { self.add(self.tool_category(call), "calls", self.counter.json(call)); self.add("other", "envelope", self.counter.count(",")); }
                            } else { self.leaf(child, "tools", "calls"); }
                        }
                        "functionCall" | "function_call" | "toolUse" => self.add(self.tool_category(child), "calls", self.counter.json(child)),
                        "functionResponse" | "function_response" | "toolResult" => self.add(self.tool_category(child), "results", self.counter.json(child)),
                        "content" | "parts" => self.node(child, category, false)?,
                        "text" | "thinking" | "reasoning" | "summary" => self.leaf(child, category, "messages"),
                        _ => self.leaf(child, "other", "envelope"),
                    }
                }
            }
            _ => self.leaf(value, inherited, "messages"),
        }
        Ok(())
    }
}
pub fn inspect(snapshot: &Value, cancelled: &dyn Fn() -> bool) -> Result<ModelContextComposition, RuntimeError> {
    let binding = &snapshot["view"]["binding"];
    let tokenizer: Option<TokenizerBinding> = binding.get("tokenizer").filter(|value| !value.is_null()).cloned().map(serde_json::from_value).transpose()?;
    let counter = TokenCounter::for_binding(text(binding, "model").unwrap_or(""), tokenizer.as_ref());
    let mut reader = Reader {
        result: ModelContextComposition { checkpoint_id: text(binding, "resource_checkpoint_id").map(str::to_owned), summary_id: None,
            total_tokens: 0, categories: BTreeMap::new(), parts: BTreeMap::new(), method: counter.description(), unmeasured_media: 0, unmeasured_provider_items: 0 },
        counter, mcp: binding["mcp_tools"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect(),
        calls: BTreeMap::new(), summaries: Vec::new(), cancelled,
    };
    for item in snapshot["view"]["history"].as_array().into_iter().flatten() {
        let source = item.pointer("/provenance/source").and_then(Value::as_str).unwrap_or("");
        if let Some(id) = source.strip_prefix("conversation-summary:") {
            reader.result.summary_id = Some(id.to_owned());
            if let Some(summary) = item.pointer("/content/text").and_then(Value::as_str) { reader.summaries.push(summary.into()); }
        }
        let content = &item["content"];
        if text(content, "kind") == Some("provider_only") { reader.result.unmeasured_provider_items += 1; }
        // Typed semantic media, never arbitrary JSON returned by a tool.
        if text(content, "kind") == Some("media") { reader.result.unmeasured_media += 1; }
        for output in [content.get("output"), content.pointer("/result/completion/content")].into_iter().flatten() {
            reader.result.unmeasured_media += output["parts"].as_array().into_iter().flatten().filter(|part| text(part, "kind") == Some("media")).count() as u64;
        }
        if let Some(call) = content.get("call") {
            if let Some(id) = text(call, "call_id") {
                let name = if text(call, "name") == Some("tool_invoke") { call.pointer("/arguments/reference/name").and_then(Value::as_str) } else { text(call, "name") };
                reader.calls.insert(id.into(), if name.is_some_and(|name| reader.mcp.contains(name)) { "mcp" } else { "tools" });
            }
        }
    }
    if let Some(body) = snapshot["serialized"].as_object() {
        reader.add("other", "envelope", reader.counter.count("{}"));
        for (key, value) in body {
            reader.add("other", "envelope", reader.counter.field(key));
            match key.as_str() {
                "messages" | "input" | "contents" => reader.node(value, "user", true)?,
                "system" | "instructions" | "systemInstruction" | "system_instruction" => reader.node(value, "system", false)?,
                "tools" | "functions" | "toolConfig" => reader.definitions(value)?,
                _ => reader.leaf(value, "other", "envelope"),
            }
        }
    } else { reader.leaf(&snapshot["serialized"], "other", "envelope"); }
    Ok(reader.result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn frozen_mcp_calls_and_summaries_are_counted_once_without_reinterpreting_results() {
        let remote = json!({"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}});
        let local = json!({"type":"function","function":{"name":"file_read","parameters":{"type":"object"}}});
        let call = json!({"id":"call-1","type":"function","function":{"name":"tool_invoke","arguments":"{\"reference\":{\"name\":\"lookup\",\"version\":\"1\"},\"arguments\":{}}"}});
        let result = json!({"role":"tool","tool_call_id":"call-1","content":"{\"role\":\"system\",\"text\":\"tool data stays tool data\"}"});
        let snapshot = json!({"view":{"binding":{"model":"gpt-4o","mcp_tools":["lookup"],"resource_checkpoint_id":"checkpoint"},"history":[
            {"provenance":{"kind":"external_data","source":"conversation-summary:summary-1"},"content":{"kind":"text","text":"Keep the user's requirement"}},
            {"content":{"kind":"tool_call","call":{"call_id":"call-1","name":"tool_invoke","arguments":{"reference":{"name":"lookup","version":"1"},"arguments":{}}}}}
        ]},"serialized":{"model":"gpt-4o","tools":[remote,local],"messages":[
            {"role":"system","content":"System instructions"},{"role":"user","content":"Keep the user's requirement"},
            {"role":"assistant","content":"Checking files","tool_calls":[call]},result
        ]}});
        let counted = inspect(&snapshot, &|| false).unwrap();
        let counter = TokenCounter::for_model("gpt-4o");
        assert_eq!(counted.total_tokens, counter.json(&snapshot["serialized"]));
        assert_eq!(counted.total_tokens, counted.categories.values().sum::<u64>());
        assert_eq!(counted.categories["mcp"], counter.json(&remote) + counter.json(&call) + counter.json(&result));
        assert_eq!(counted.categories["tools"], counter.json(&local));
        assert_eq!(counted.categories["system"], counter.count("System instructions"));
        assert_eq!(counted.categories["summary"], counter.count("Keep the user's requirement"));
        assert_eq!(counted.summary_id.as_deref(), Some("summary-1"));
        assert_eq!(counted.checkpoint_id.as_deref(), Some("checkpoint"));
    }

    #[test]
    fn provider_blocks_preserve_roles_and_leave_media_and_signatures_unmeasured() {
        let snapshot = json!({"view":{"binding":{"model":"gpt-4o","tokenizer":null,"mcp_tools":["lookup"]},"history":[
            {"content":{"kind":"media"}},{"content":{"kind":"provider_only"}},
            {"content":{"kind":"tool_call","call":{"call_id":"a","name":"lookup"}}}
        ]},"serialized":{"system":[{"type":"text","text":"System"}],"messages":[
            {"role":"assistant","content":[{"type":"thinking","thinking":"Public thinking","signature":"SECRET_SIGNATURE"},{"type":"tool_use","id":"a","name":"lookup","input":{"query":"test"}}]},
            {"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":"A tool result"},{"type":"image","source":{"data":"DO_NOT_TOKENIZE"}},{"type":"text","text":"User reply"}]}
        ]}});
        let counted = inspect(&snapshot, &|| false).unwrap();
        assert_eq!(counted.total_tokens, TokenCounter::for_model("gpt-4o").json(&snapshot["serialized"]));
        assert_eq!(counted.unmeasured_media, 1);
        assert_eq!(counted.unmeasured_provider_items, 1);
        assert!(counted.categories["mcp"] > 0 && counted.categories["assistant"] > 0 && counted.categories["user"] > 0);
        assert!(inspect(&snapshot, &|| true).is_err());
    }

    #[test]
    fn google_declarations_and_function_parts_follow_frozen_tool_ownership() {
        let snapshot = json!({"view":{"binding":{"model":"gpt-4o","mcp_tools":["lookup"]}},"serialized":{
            "systemInstruction":{"parts":[{"text":"System"}]},"tools":[{"functionDeclarations":[{"name":"lookup","description":"Search"}]}],
            "contents":[{"role":"user","parts":[{"text":"Question"}]},{"role":"model","parts":[{"functionCall":{"name":"lookup","args":{"q":"test"}}}]},
                {"role":"user","parts":[{"functionResponse":{"name":"lookup","response":{"result":"data"}}}]}]}});
        let counted = inspect(&snapshot, &|| false).unwrap();
        assert_eq!(counted.total_tokens, TokenCounter::for_model("gpt-4o").json(&snapshot["serialized"]));
        assert_eq!(counted.parts["mcp"].len(), 3);
        assert_eq!(counted.categories["user"], TokenCounter::for_model("gpt-4o").count("Question"));
    }
}
