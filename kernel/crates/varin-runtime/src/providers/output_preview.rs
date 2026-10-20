//! Compact the display of immutable output while retaining JSON structure and original readers.
use super::*;
use serde_json::{Map, json};

/// Count serialized JSON bytes without allocating a second copy of large text/logs.
fn json_bytes(value: &Value) -> usize {
    match value {
        Value::Null => 4,
        Value::Bool(value) => {
            if *value {
                4
            } else {
                5
            }
        }
        Value::Number(value) => value.to_string().len(),
        Value::String(value) => string_bytes(value),
        Value::Array(values) => {
            2 + values.len().saturating_sub(1) + values.iter().map(json_bytes).sum::<usize>()
        }
        Value::Object(values) => {
            2 + values.len().saturating_sub(1)
                + values
                    .iter()
                    .map(|(key, value)| string_bytes(key) + 1 + json_bytes(value))
                    .sum::<usize>()
        }
    }
}
fn string_bytes(text: &str) -> usize {
    2 + text_bytes(text, true)
}
fn text_bytes(text: &str, escaped: bool) -> usize {
    if !escaped {
        return text.len();
    }
    text.bytes()
        .map(|byte| match byte {
            b'"' | b'\\' | b'\n' | b'\r' | b'\t' | 8 | 12 => 2,
            0..=31 => 6,
            _ => 1,
        })
        .sum::<usize>()
}

/// Small fields keep their allowance; the remaining body budget is shared by large fields.
fn allowances(sizes: &[usize], budget: usize) -> Vec<usize> {
    let mut order = (0..sizes.len()).collect::<Vec<_>>();
    order.sort_by_key(|index| sizes[*index]);
    let mut result = vec![0; sizes.len()];
    let mut remaining = budget;
    for (rank, index) in order.into_iter().enumerate() {
        let share = remaining / (sizes.len() - rank);
        result[index] = sizes[index].min(share);
        remaining -= result[index];
    }
    result
}

struct TextPreview {
    text: String,
    head: usize,
    tail: usize,
}
fn preview(text: &str, budget: usize, escaped: bool) -> TextPreview {
    const GAP: &str = "\n… [output truncated] …\n";
    let mut remaining = budget.saturating_sub(text_bytes(GAP, escaped)) / 2;
    let mut head = 0;
    for (index, ch) in text.char_indices() {
        let end = index + ch.len_utf8();
        let bytes = text_bytes(&text[index..end], escaped);
        if bytes > remaining {
            break;
        }
        remaining -= bytes;
        head = end;
    }
    // Prefer whole lines. A single long line still has a useful UTF-8 preview.
    if let Some(newline) = text[..head].rfind('\n') {
        head = newline + 1;
    }
    remaining =
        budget.saturating_sub(text_bytes(GAP, escaped) + text_bytes(&text[..head], escaped));
    let mut tail = text.len();
    for (index, ch) in text.char_indices().rev() {
        let bytes = text_bytes(&text[index..index + ch.len_utf8()], escaped);
        if bytes > remaining {
            break;
        }
        remaining -= bytes;
        tail = index;
    }
    if tail > 0 && text.as_bytes()[tail - 1] != b'\n' {
        if let Some(newline) = text[tail..].find('\n') {
            tail += newline + 1;
        }
    }
    TextPreview {
        text: format!("{}{GAP}{}", &text[..head], &text[tail..]),
        head,
        tail,
    }
}

struct Projection<'a> {
    item_id: &'a str,
    can_read: bool,
    page_bytes: usize,
    omitted: Vec<Value>,
    snippet_limit: Option<usize>,
}
impl Projection<'_> {
    fn omitted(&mut self, pointer: &str, mut detail: Value, offset: usize) {
        detail["pointer"] = pointer.into();
        if self.can_read {
            detail["read"] = json!({"tool":"read_thread","arguments":{"query":{
                "kind":"output","itemId":self.item_id,"pointer":pointer,"offset":offset,"maxBytes":self.page_bytes
            }}});
        }
        self.omitted.push(detail);
    }
    fn text(&mut self, text: &str, budget: usize, pointer: &str, escaped: bool) -> String {
        if text_bytes(text, escaped) <= budget {
            return text.into();
        }
        let shown = preview(text, budget, escaped);
        self.omitted(
            pointer,
            json!({"totalBytes":text.len(),"headBytes":shown.head,"tailOffset":shown.tail}),
            shown.head,
        );
        shown.text
    }
    fn value(&mut self, value: &Value, size: usize, budget: usize, pointer: &str) -> Value {
        let limit = pointer.ends_with("/snippets").then_some(self.snippet_limit).flatten();
        if size <= budget && limit.is_none() && !(self.snippet_limit.is_some() && value.is_object()) {
            return value.clone();
        }
        match value {
            Value::Object(fields) => {
                let overhead = 2
                    + fields.len().saturating_sub(1)
                    + fields
                        .keys()
                        .map(|key| string_bytes(key) + 1)
                        .sum::<usize>();
                let sizes = fields.values().map(json_bytes).collect::<Vec<_>>();
                let budgets = allowances(&sizes, budget.saturating_sub(overhead));
                let result: Map<_, _> = fields
                    .iter()
                    .enumerate()
                    .map(|(i, (key, value))| {
                        let path =
                            format!("{pointer}/{}", key.replace('~', "~0").replace('/', "~1"));
                        (key.clone(), self.value(value, sizes[i], budgets[i], &path))
                    })
                    .collect();
                Value::Object(result)
            }
            Value::Array(records) => {
                let mut used: usize = 2;
                let mut shown = Vec::new();
                for record in records {
                    if limit.is_some_and(|limit| shown.len() >= limit) { break; }
                    let next = json_bytes(record) + usize::from(!shown.is_empty());
                    if used.saturating_add(next) > budget {
                        break;
                    }
                    shown.push(record.clone());
                    used += next;
                }
                // A preview never displays only half of a required evidence group.
                // The omitted array pointer reads the same intact stored records.
                if pointer.ends_with("/snippets") {
                    loop {
                        let omitted_groups: std::collections::BTreeSet<_> = records[shown.len()..].iter()
                            .flat_map(|row| row["requiredGroups"].as_array().into_iter().flatten().filter_map(Value::as_str)).collect();
                        let cut = shown.iter().position(|row| row["requiredGroups"].as_array().is_some_and(|groups|
                            groups.iter().filter_map(Value::as_str).any(|group| omitted_groups.contains(group))));
                        if let Some(cut) = cut { shown.truncate(cut); } else { break; }
                    }
                }
                let count = shown.len();
                if count < records.len() {
                    self.omitted(
                        pointer,
                        json!({"totalItems":records.len(),"shownItems":count}),
                        count,
                    );
                }
                Value::Array(shown)
            }
            Value::String(text) => {
                Value::String(self.text(text, budget.saturating_sub(2), pointer, true))
            }
            // Status flags, counts and other scalar metadata remain exact, even with a tiny budget.
            _ => value.clone(),
        }
    }
}

pub(super) fn bounded_output(
    output: &OutputBody,
    budget: usize,
    item_id: &str,
    can_read: bool,
    snippet_limit: Option<usize>,
) -> Option<OutputBody> {
    let mut sizes = vec![if output.data.is_null() {
        0
    } else {
        json_bytes(&output.data)
    }];
    sizes.extend(output.parts.iter().map(|part| match part {
        OutputPart::Text { text } => text.len(),
        OutputPart::Media { .. } => 0,
    }));
    let original_bytes = sizes.iter().sum::<usize>();
    if original_bytes <= budget && snippet_limit.is_none() {
        return None;
    }
    let budgets = allowances(&sizes, budget);
    let mut projection = Projection {
        item_id,
        can_read,
        page_bytes: budget.max(1),
        omitted: Vec::new(),
        snippet_limit,
    };
    let data = projection.value(&output.data, sizes[0], budgets[0], "/data");
    let mut parts = output
        .parts
        .iter()
        .enumerate()
        .map(|(i, part)| match part {
            OutputPart::Text { text } => OutputPart::Text {
                text: projection.text(text, budgets[i + 1], &format!("/parts/{i}/text"), false),
            },
            OutputPart::Media { .. } => part.clone(),
        })
        .collect::<Vec<_>>();
    if projection.omitted.is_empty() {
        return None;
    }
    // Presentation metadata lives beside the output, never replaces its status/cursor/data fields.
    // The budget governs body preview; this small continuation envelope is additional.
    parts.push(OutputPart::Text { text: json!({"outputPreview":{
        "truncated":true,"originalBytes":original_bytes,"historyItemId":item_id,"omitted":projection.omitted
    }}).to_string() });
    Some(OutputBody { data, parts })
}

pub(super) fn retrieval_preview_limit(call: &ToolCall) -> Option<usize> {
    let (name, args) = if call.name == crate::tool_disclosure::INVOKE {
        (call.arguments["reference"]["name"].as_str().unwrap_or(""), &call.arguments["arguments"])
    } else { (call.name.as_str(), &call.arguments) };
    (name == "code_retrieval").then(|| args["limit"].as_u64()
        .and_then(|value| usize::try_from(value).ok())).flatten()
}

/// Reads with an explicit body range already define what the model asked to see.
/// Resolve the original tool call, including the generic invocation wrapper, rather than
/// treating arbitrary fields in an untrusted tool result as an instruction to bypass projection.
pub(super) fn is_explicit_read(call: &ToolCall) -> bool {
    let (name, args) = if call.name == crate::tool_disclosure::INVOKE {
        (
            call.arguments["reference"]["name"].as_str().unwrap_or(""),
            &call.arguments["arguments"],
        )
    } else {
        (call.name.as_str(), &call.arguments)
    };
    match name {
        "read_thread" => matches!(
            args["query"]["kind"].as_str(),
            Some("item" | "output" | "media")
        ),
        "file_read" => args.get("length").is_some_and(Value::is_u64),
        "process_read" => true,
        _ => false,
    }
}
