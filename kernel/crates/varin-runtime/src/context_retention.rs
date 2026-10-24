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
                            tokens.saturating_add(counter.item(item)),
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
    pub(crate) fn annotation(&self, id: &str) -> Option<Value> {
        let group = self.group_of.get(id)?;
        let (tokens, media, provider) = self.costs[*group];
        Some(json!({"retainId":format!("r{}", group + 1),
            "estimatedTokens":tokens,"unmeasuredMedia":media,"unmeasuredProviderItems":provider}))
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
    pub(crate) fn annotate(&self, sources: &mut [crate::context_job::ContextCompactionSource]) {
        for source in sources {
            let Provenance::ExternalData { source: label } = &source.item.provenance else {
                continue;
            };
            let Some(id) = label.strip_prefix("history:") else {
                continue;
            };
            // Quotation splits multimodal items into parts. Each part retains the same original.
            let mut original = id;
            let annotation = loop {
                if let Some(annotation) = self.annotation(original) {
                    break Some(annotation);
                }
                match original.rsplit_once(":part:") {
                    Some((parent, _)) => original = parent,
                    None => break None,
                }
            };
            if let Content::Text { text } = &mut source.item.content {
                let material = serde_json::from_str::<Value>(text)
                    .unwrap_or_else(|_| Value::String(text.clone()));
                let cost = annotation.unwrap_or_else(|| {
                    json!({"retainId":null,
                    "estimatedTokens":material["content"]["text"].as_str()
                        .map(|text| self.counter.count(text)),"kind":"existing_summary"})
                });
                *text = json!({"retention":cost,"material":material}).to_string();
            }
        }
    }
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
}
