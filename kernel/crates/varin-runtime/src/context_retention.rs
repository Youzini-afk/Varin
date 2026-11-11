//! Model-selected originals, with local text estimates and original message relationships.
use crate::{RuntimeError, token_count::TokenCounter, execution::*};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RetainedContext {
    pub items: Value,
    pub estimated_tokens: u64,
    pub budget_tokens: Option<u64>,
}

/// Portable conversation background. Runtime authority and opaque continuation stay
/// with the original request; completed semantic exchanges can cross model bindings.
pub(crate) fn conversation_background(history: &[std::sync::Arc<ConversationItem>]) -> ConversationHistory {
    history.iter().filter(|item| {
        !item.provenance.is_system()
            && !matches!(item.provenance, Provenance::GoalInstruction { .. })
            && !matches!(&item.provenance, Provenance::ExternalData { source } if source == "current-teammates")
            && !matches!(item.content, Content::ProviderOnly)
    }).map(|item| {
        let mut item = item.as_ref().clone();
        item.opaque = None;
        item.resource_activation = None;
        std::sync::Arc::new(item)
    }).collect()
}

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct Selection {
    pub summary: String,
    #[serde(default)]
    pub retain: Vec<String>,
}

impl Selection {
    pub(crate) fn parse(text: &str) -> Result<Self, RuntimeError> {
        let text = text.trim();
        let json = text
            .strip_prefix("```json")
            .or_else(|| text.strip_prefix("```"))
            .and_then(|body| body.trim_end().strip_suffix("```"))
            .unwrap_or(text)
            .trim();
        // A textual summary expresses a selection containing no original blocks. This also
        // serves text-producing compaction extensions through the same publication path.
        let result: Self = if json.starts_with('{') {
            serde_json::from_str(json)?
        } else {
            Self {
                summary: text.into(),
                retain: Vec::new(),
            }
        };
        if result.summary.trim().is_empty() {
            return Err(RuntimeError::Invalid("context summary is empty".into()));
        }
        Ok(result)
    }
}

pub(crate) struct Originals {
    pub history: ConversationHistory,
    groups: Vec<Vec<usize>>,
    group_of: BTreeMap<String, usize>,
    costs: Vec<(u64, usize, usize)>,
    counter: TokenCounter,
}
impl Originals {
    pub(crate) fn new(history: ConversationHistory, counter: TokenCounter) -> Self {
        Self::build(history, counter, &BTreeMap::new(), false)
    }
    pub(crate) fn with_history_origins(history: ConversationHistory, counter: TokenCounter, origins: &BTreeMap<String, String>) -> Self {
        Self::build(history, counter, origins, true)
    }
    fn build(history: ConversationHistory, counter: TokenCounter, origins: &BTreeMap<String, String>, readable: bool) -> Self {
        fn root(parents: &mut [usize], index: usize) -> usize {
            if parents[index] != index {
                parents[index] = root(parents, parents[index]);
            }
            parents[index]
        }
        let mut parents: Vec<_> = (0..history.len()).collect();
        let mut related = BTreeMap::new();
        let mut calls = BTreeMap::new();
        for (index, item) in history.iter().enumerate() {
            let mut keys = Vec::new();
            // A quoted user part has an evidence role, but still belongs to its one
            // original user message for retention. The frozen owner mapping supplies it.
            keys.extend(origins.get(&item.id).map(|id| format!("history:{id}")));
            match &item.content {
                Content::ToolCall { call } => {
                    calls.insert(call.call_id.clone(), index);
                }
                Content::ToolResult { result } => {
                    if let Some(previous) = calls.remove(&result.call_id) {
                        parents[index] = root(&mut parents, previous);
                    }
                }
                _ => (),
            }
            if let Provenance::UserInstruction { input_id } = &item.provenance {
                keys.push(format!("input:{input_id}"));
            }
            let request = match &item.content {
                Content::ToolResult { result } => Some(result.request_id.as_str()),
                _ if matches!(item.provenance, Provenance::Assistant) => item
                    .id
                    .strip_prefix("model-item:")
                    .and_then(|id| id.split_once(':'))
                    .and_then(|(length, rest)| {
                        length
                            .parse::<usize>()
                            .ok()
                            .and_then(|length| rest.get(..length))
                    }),
                _ => None,
            };
            // Provider continuation items, parallel calls and their results form one exchange.
            keys.extend(request.map(|request| format!("request:{request}")));
            for key in keys {
                if let Some(previous) = related.insert(key, index) {
                    let leader = root(&mut parents, previous);
                    let current = root(&mut parents, index);
                    parents[current] = leader;
                }
            }
        }
        let mut groups: Vec<Vec<usize>> = Vec::new();
        let mut leaders = BTreeMap::new();
        let mut group_of = BTreeMap::new();
        for (index, item) in history.iter().enumerate() {
            let leader = root(&mut parents, index);
            let group = *leaders.entry(leader).or_insert_with(|| {
                groups.push(Vec::new());
                groups.len() - 1
            });
            groups[group].push(index);
            group_of.insert(item.id.clone(), group);
        }
        let costs = groups
            .iter()
            .map(|items| {
                items
                    .iter()
                    .fold((0u64, 0, 0), |(tokens, media, provider), index| {
                        let item = &history[*index];
                        (
                            tokens.saturating_add(if readable { counter.model_item(item) } else { counter.item(item) }),
                            media + item.content.media().len(),
                            provider + usize::from(matches!(item.content, Content::ProviderOnly)),
                        )
                    })
            })
            .collect();
        Self {
            history,
            groups,
            group_of,
            costs,
            counter,
        }
    }
    fn group(&self, id: &str) -> Option<usize> {
        self.group_of.get(id).copied().or_else(|| {
            id.strip_prefix('r')
                .and_then(|id| id.parse::<usize>().ok())
                .and_then(|id| id.checked_sub(1))
                .filter(|index| *index < self.groups.len())
        })
    }
    fn retention(&self, id: &str) -> Option<crate::context_job::ContextCompactionRetention> {
        let group = self.group_of.get(id)?;
        let (tokens, media, provider) = self.costs[*group];
        Some(crate::context_job::ContextCompactionRetention {
            retain_id: format!("r{}", group + 1), estimated_tokens: tokens,
            unmeasured_media: media, unmeasured_provider_items: provider,
        })
    }
    pub(crate) fn annotation(&self, id: &str) -> Option<Value> {
        self.retention(id).map(|retention| serde_json::to_value(retention).expect("retention cost"))
    }
    pub(crate) fn select(&self, ids: &[String]) -> Result<ConversationHistory, RuntimeError> {
        let groups = ids
            .iter()
            .map(|id| {
                self.group(id).ok_or_else(|| {
                    RuntimeError::Invalid(format!("unknown original reference: {id}"))
                })
            })
            .collect::<Result<BTreeSet<_>, _>>()?;
        let selected: BTreeSet<_> = groups
            .into_iter()
            .flat_map(|group| self.groups[group].iter().copied())
            .collect();
        Ok(selected
            .into_iter()
            .map(|index| self.history[index].clone())
            .collect())
    }
    /// Preserve only sources actually cited in the new summary, using descriptors
    /// from the original typed material. Text cannot invent an attachment or owner.
    pub(crate) fn select_with_sources(&self, ids: &[String], summary: &str) -> Result<ConversationHistory, RuntimeError> {
        fn files(item: &ConversationItem) -> Vec<crate::catalog::attachments::Attachment> {
            let output = match &item.content {
                Content::Output { output } => Some(output),
                Content::ToolResult { result } => match &result.completion {
                    ToolCompletion::Result { content, .. } => Some(content),
                    ToolCompletion::JobAccepted { content, .. } => content.as_ref(),
                    _ => None,
                },
                _ => None,
            };
            output.map(|output| output.parts.iter().filter_map(|part| match part {
                crate::output::OutputPart::Attachment { attachment } => Some(attachment.clone()), _ => None,
            }).collect()).unwrap_or_default()
        }
        let mut selected = self.select(ids)?;
        let known: Vec<_> = self.history.iter().flat_map(|item| files(item)).collect();
        let retained: BTreeSet<_> = selected.iter().flat_map(|item| files(item)).map(|file| file.reference).collect();
        for attachment in crate::catalog::attachments::cited_materials(&[summary.to_owned()], &known) {
            if retained.contains(&attachment.reference) { continue; }
            selected.push(std::sync::Arc::new(ConversationItem {
                id: format!("retained-source:{}", attachment.reference),
                provenance: Provenance::ExternalData { source: "retained-source-citation".into() },
                resource_activation: None, opaque: None,
                content: Content::Output { output: crate::output::OutputBody {
                    model_data: None,
                    data: Value::Null, parts: vec![crate::output::OutputPart::Attachment { attachment }],
                } },
            }));
        }
        Ok(selected)
    }
    pub(crate) fn carry(&self, text: &str) -> Result<String, RuntimeError> {
        let selection = Selection::parse(text)?;
        let items = self.select(&selection.retain)?;
        let groups: BTreeSet<_> = items.iter().map(|item| self.group_of[&item.id]).collect();
        let tokens: u64 = groups.iter().map(|group| self.costs[*group].0).sum();
        let retained: Vec<_> = groups
            .into_iter()
            .map(|group| {
                let mut annotation = self
                    .annotation(&self.history[self.groups[group][0]].id)
                    .expect("original group");
                annotation["itemIds"] = json!(
                    self.groups[group]
                        .iter()
                        .map(|index| &self.history[*index].id)
                        .collect::<Vec<_>>()
                );
                annotation
            })
            .collect();
        Ok(
            json!({"previousResult":selection,"retainedOriginals":retained,
            "estimatedTokens":self.counter.count(&selection.summary)
                + tokens})
            .to_string(),
        )
    }
    /// Later batches consume the previous summary as prose, while group selection and
    /// costs remain derived from the fixed originals. Legacy recipes keep `carry` above.
    pub(crate) fn carry_readable(&self, text: &str) -> Result<String, RuntimeError> {
        let selection = Selection::parse(text)?;
        let items = self.select(&selection.retain)?;
        let groups: BTreeSet<_> = items.iter().map(|item| self.group_of[&item.id]).collect();
        let mut tokens = self.counter.count(&selection.summary);
        let mut retained = Vec::new();
        for group in groups {
            let retention = self.retention(&self.history[self.groups[group][0]].id).expect("original group");
            tokens = tokens.saturating_add(retention.estimated_tokens);
            retained.push(retention_text(&retention));
        }
        Ok(format!("Previous batch summary:\n{}\n\nRetained originals:\n{}\nEstimated continuation text cost: {tokens} tokens.",
            selection.summary, if retained.is_empty() { "None".into() } else { retained.join("\n") }))
    }
    pub(crate) fn annotate(&self, sources: &mut [crate::context_job::ContextCompactionSource]) {
        for source in sources {
            let Some(material) = &mut source.material else { continue; };
            material.retention = self.retention(&material.original_item_id);
            if let Some(retention) = &material.retention {
                material.heading = format!("{} · {}", material.heading, retention_text(retention));
                if let Some(id) = &material.history_item_id {
                    material.heading.push_str(&format!("\nRead original: summary_read itemId={id}"));
                }
            } else {
                // The only material outside Originals in a newly prepared source cut is
                // its preceding summary. Its text is not a selectable original record.
                material.heading = "Existing summary".into();
            }
        }
    }

}

fn retention_text(retention: &crate::context_job::ContextCompactionRetention) -> String {
    let mut text = format!("Retention group {}\nRetaining the original group: {} text tokens", retention.retain_id, retention.estimated_tokens);
    if retention.unmeasured_media > 0 {
        text.push_str(&format!("; {} media items unmeasured", retention.unmeasured_media));
    }
    if retention.unmeasured_provider_items > 0 {
        text.push_str(&format!("; {} provider-only items unmeasured", retention.unmeasured_provider_items));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn selecting_one_result_keeps_the_complete_provider_exchange_in_order() {
        let mut history: ConversationHistory = Vec::new();
        for id in ["a", "b"] {
            history.push(Arc::new(model_history_item(
                "request",
                &ProviderItem {
                    id: id.into(),
                    opaque: None,
                    content: Content::ToolCall {
                        call: ToolCall {
                            call_id: id.into(),
                            name: "read".into(),
                            schema_version: "1".into(),
                            arguments: json!({}),
                        },
                    },
                },
            )));
        }
        for id in ["a", "b"] {
            history.push(Arc::new(ConversationItem {
                id: format!("result-{id}"),
                resource_activation: None,
                opaque: None,
                provenance: Provenance::ToolData { call_id: id.into() },
                content: Content::ToolResult {
                    result: ToolResult {
                        request_id: "request".into(),
                        call_id: id.into(),
                        completion: ToolCompletion::Result {
                            outcome: crate::Outcome::Succeeded,
                            effect: crate::Effect::None,
                            content: json!({"text":"中文 🎉"}).into(),
                        },
                    },
                },
            }));
        }
        let first_exchange = history.clone();
        history.push(Arc::new(model_history_item(
            "next-request",
            &ProviderItem {
                id: "a".into(),
                opaque: None,
                content: Content::ToolCall {
                    call: ToolCall {
                        call_id: "a".into(),
                        name: "read".into(),
                        schema_version: "1".into(),
                        arguments: json!({}),
                    },
                },
            },
        )));
        history.push(Arc::new(ConversationItem {
            id: "next-result".into(),
            resource_activation: None,
            opaque: None,
            provenance: Provenance::ToolData {
                call_id: "a".into(),
            },
            content: Content::ToolResult {
                result: ToolResult {
                    request_id: "next-request".into(),
                    call_id: "a".into(),
                    completion: ToolCompletion::Result {
                        outcome: crate::Outcome::Succeeded,
                        effect: crate::Effect::None,
                        content: json!("next").into(),
                    },
                },
            },
        }));
        let originals = Originals::new(history, TokenCounter::default());
        let kept = originals.select(&["result-b".into(), "r1".into()]).unwrap();
        assert_eq!(kept, first_exchange);
        assert_eq!(originals.select(&["next-result".into()]).unwrap().len(), 2);
        validate_history_pairs(&kept).unwrap();
        let annotation = originals.annotation("result-a").unwrap();
        let carried: Value = serde_json::from_str(
            &originals
                .carry(&json!({"summary":"done", "retain":["r1", "result-b"]}).to_string())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            carried["estimatedTokens"],
            annotation["estimatedTokens"].as_u64().unwrap() + 1
        );
        assert!(originals.select(&["foreign-item".into()]).is_err());
    }
    #[test]
    fn summary_source_citations_keep_only_acquired_typed_descriptors_for_inheritance() {
        let attachment = crate::catalog::attachments::Attachment { model_ref: None,
            reference: format!("attachment:material_{}", hex::encode("snap-acquired")), filename: "Source".into(),
            mime_type: "text/plain".into(), byte_length: 12,
        };
        let history = vec![Arc::new(ConversationItem {
            id: "original-source".into(), provenance: Provenance::ExternalData { source: "websearch".into() }, resource_activation: None, opaque: None,
            content: Content::Output { output: crate::output::OutputBody { model_data: None, data: Value::Null,
                parts: vec![crate::output::OutputPart::Attachment { attachment: attachment.clone() }] } },
        })];
        let originals = Originals::new(history, TokenCounter::default());
        let kept = originals.select_with_sources(&[], "Finding [source](varin-material://snap-acquired?startLine=1) [unknown](varin-material://snap-unknown)").unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(conversation_background(&kept), kept);
        let repeated = Originals::new(kept.clone(), TokenCounter::default()).select_with_sources(&[], "Still [source](varin-material://snap-acquired)").unwrap();
        assert_eq!(repeated, kept);
        assert!(originals.select_with_sources(&[], "snap-acquired, https://example.com").unwrap().is_empty());
    }

    #[test]
    fn readable_retention_counts_original_provider_view_not_hidden_receipts_or_quotation() {
        fn history(hidden: &str, visible: &str) -> ConversationHistory {
            vec![std::sync::Arc::new(ConversationItem {
                id: "original-result".into(), provenance: Provenance::ExternalData { source: "owner".into() }, resource_activation: None, opaque: None,
                content: Content::Output { output: crate::output::OutputBody {
                    data: json!({"privateReceipt":hidden}), model_data: Some(json!({"answer":visible})),
                    parts: vec![crate::output::OutputPart::Text { text:"Independent original text 中文 🎉".into() }],
                } },
            })]
        }
        let short = history("small", "visible");
        let hidden = history(&"hidden receipt ".repeat(10_000), "visible");
        let visible = history("small", &"visible result 中文 ".repeat(200));
        let counter = TokenCounter::for_model("gpt-4");
        let cost = |history: ConversationHistory| Originals::with_history_origins(history, counter.clone(), &BTreeMap::new())
            .annotation("original-result").unwrap()["estimatedTokens"].as_u64().unwrap();
        assert_eq!(cost(short.clone()), cost(hidden.clone()), "hidden durable receipt size is not model input");
        assert!(cost(visible) > cost(short.clone()), "actual visible business data contributes to original retention");
        let originals = Originals::with_history_origins(hidden.clone(), counter.clone(), &BTreeMap::new());
        let mut sources = crate::context_material::quote_sources("job", hidden.clone()).unwrap();
        originals.annotate(&mut sources);
        let original_cost = sources[0].material.as_ref().unwrap().retention.as_ref().unwrap().estimated_tokens;
        sources[0].material.as_mut().unwrap().heading.push_str(&" expensive auxiliary heading ".repeat(100));
        assert_eq!(original_cost, cost(hidden.clone()), "summary headings do not change the original model cost");
        assert_eq!(originals.select(&["r1".into()]).unwrap(), hidden, "retention keeps the complete raw receipt");
        let old_short = Originals::new(short, counter.clone()).annotation("original-result").unwrap()["estimatedTokens"].as_u64().unwrap();
        let old_large = Originals::new(history(&"hidden receipt ".repeat(10_000), "visible"), counter).annotation("original-result").unwrap()["estimatedTokens"].as_u64().unwrap();
        assert!(old_large > old_short, "already-frozen recipes keep their earlier cost semantics");
    }

}
