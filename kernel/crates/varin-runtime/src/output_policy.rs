//! Typed policy bodies reuse ContentStore. Opaque private state is never inspected for media.
use super::*;
use crate::catalog::RuntimeError;
use crate::execution::*;
type R<T> = Result<T, RuntimeError>;
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum StoredPolicyAction {
    Deliver {
        output: OutputBody<StoredIncomingMedia>,
    },
    Control {
        action: PolicyAction,
    },
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PolicyResultFormat {
    OutputBody,
    ModelEvidence,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum StoredPolicyEvent {
    Event {
        event: PolicyEvent,
    },
    ToolsCompleted {
        results: Vec<ToolResult<StoredMedia>>,
    },
    ResultChunk {
        reference: PolicyEvidenceRef,
        index: usize,
        format: PolicyResultFormat,
    },
}
impl crate::content::ContentStore {
    pub(crate) fn save_policy_action(&self, action: &PolicyAction) -> R<Value> {
        let mut dependencies = Vec::new();
        let saved = match action {
            PolicyAction::Deliver { output } => StoredPolicyAction::Deliver {
                output: output.clone().map_media(|media| {
                    let bytes = media_bytes(&media.media_type, &media.data_base64)?;
                    let content_ref: ContentRef = serde_json::from_value(self.save_bytes(&bytes)?)?;
                    dependencies.push(content_ref.content_object.clone());
                    Ok::<_, RuntimeError>(StoredIncomingMedia {
                        media_type: media.media_type,
                        content_ref,
                    })
                })?,
            },
            action => StoredPolicyAction::Control {
                action: action.clone(),
            },
        };
        self.save_with_dependencies(&serde_json::to_value(saved)?, dependencies)
    }
    pub(crate) fn load_policy_action(&self, reference: &Value) -> R<PolicyAction> {
        Ok(
            match serde_json::from_value::<StoredPolicyAction>(self.load(reference)?)? {
                StoredPolicyAction::Deliver { output } => PolicyAction::Deliver {
                    output: output.map_media(|media| {
                        let bytes =
                            self.load_bytes(&serde_json::to_value(media.content_ref)?, &|| false)?;
                        Ok::<_, RuntimeError>(IncomingMedia {
                            media_type: media.media_type,
                            data_base64: STANDARD.encode(bytes),
                        })
                    })?,
                },
                StoredPolicyAction::Control { action } => {
                    if matches!(action, PolicyAction::Deliver { .. }) {
                        return Err(invalid("delivery requires its typed stored body"));
                    }
                    action
                }
            },
        )
    }
    pub(crate) fn save_policy_control(&self, intent: &PolicyControlIntent) -> R<Value> {
        let action = self.save_policy_action(&intent.action)?;
        let stored = PolicyControlIntent {
            action_id: intent.action_id.clone(),
            boundary: intent.boundary.clone(),
            identity: intent.identity.clone(),
            state: intent.state.clone(),
            expected_head: intent.expected_head.clone(),
            action: action.clone(),
        };
        self.save_with_dependencies(
            &serde_json::to_value(stored)?,
            vec![serde_json::from_value::<ContentRef>(action)?.content_object],
        )
    }
    pub(crate) fn load_policy_control(&self, reference: &Value) -> R<PolicyControlIntent> {
        let stored: PolicyControlIntent<Value> = serde_json::from_value(self.load(reference)?)?;
        Ok(PolicyControlIntent {
            action_id: stored.action_id,
            boundary: stored.boundary,
            identity: stored.identity,
            state: stored.state,
            expected_head: stored.expected_head,
            action: self.load_policy_action(&stored.action)?,
        })
    }
    pub(crate) fn policy_result_chunk(
        &self,
        reference: &Value,
        index: usize,
        format: PolicyResultFormat,
        cancelled: &dyn Fn() -> bool,
    ) -> R<crate::content::ContentChunk> {
        let value = match format {
            PolicyResultFormat::OutputBody => {
                serde_json::to_value(self.load_output_cancellable(reference, cancelled)?)?
            }
            PolicyResultFormat::ModelEvidence => self.load_cancellable(reference, cancelled)?,
        };
        Self::projected_chunk(reference, &serde_json::to_vec(&value)?, index, cancelled)
    }
    pub(crate) fn save_policy_event(&self, event: &PolicyEvent) -> R<Value> {
        let mut dependencies = Vec::new();
        let saved = match event {
            PolicyEvent::ToolsCompleted { results } => StoredPolicyEvent::ToolsCompleted {
                results: results
                    .iter()
                    .cloned()
                    .map(|result| {
                        Ok(ToolResult {
                            request_id: result.request_id,
                            call_id: result.call_id,
                            completion: result.completion.map_media(|media| {
                                let stored = self.store_media(media)?;
                                dependencies.push(stored.content_ref.content_object.clone());
                                Ok::<_, RuntimeError>(stored)
                            })?,
                        })
                    })
                    .collect::<R<Vec<_>>>()?,
            },
            PolicyEvent::ResultChunk {
                reference,
                index,
                format,
                ..
            } => {
                dependencies.push(reference.content_ref.clone());
                StoredPolicyEvent::ResultChunk {
                    reference: reference.clone(),
                    index: *index,
                    format: *format,
                }
            }
            event => StoredPolicyEvent::Event {
                event: event.clone(),
            },
        };
        self.save_with_dependencies(&serde_json::to_value(saved)?, dependencies)
    }
    pub(crate) fn load_policy_event(&self, reference: &Value) -> R<PolicyEvent> {
        Ok(
            match serde_json::from_value::<StoredPolicyEvent>(self.load(reference)?)? {
                StoredPolicyEvent::ToolsCompleted { results } => PolicyEvent::ToolsCompleted {
                    results: results
                        .into_iter()
                        .map(|result| {
                            Ok(ToolResult {
                                request_id: result.request_id,
                                call_id: result.call_id,
                                completion: result
                                    .completion
                                    .map_media(|media| self.resolve_media(media))?,
                            })
                        })
                        .collect::<R<Vec<_>>>()?,
                },
                StoredPolicyEvent::ResultChunk {
                    reference,
                    index,
                    format,
                } => {
                    let chunk = self.policy_result_chunk(
                        &serde_json::json!({"content_object":reference.content_ref}),
                        index,
                        format,
                        &|| false,
                    )?;
                    PolicyEvent::ResultChunk {
                        reference,
                        index,
                        format,
                        total_chunks: chunk.chunk_count,
                        total_bytes: chunk.total_bytes,
                        bytes: chunk.bytes,
                    }
                }
                StoredPolicyEvent::Event { event } => {
                    if matches!(
                        event,
                        PolicyEvent::ToolsCompleted { .. } | PolicyEvent::ResultChunk { .. }
                    ) {
                        return Err(invalid(
                            "policy continuation requires its typed stored body",
                        ));
                    }
                    event
                }
            },
        )
    }
}
