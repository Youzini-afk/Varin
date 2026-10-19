//! One immutable output body for every invocation origin. JSON is data; presentation is explicit.
use crate::execution::{Provenance, ToolExecutionContext};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct OutputBody<M = ResolvedMedia> {
    pub data: Value,
    pub parts: Vec<OutputPart<M>>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OutputPart<M = ResolvedMedia> {
    Text { text: String },
    Media { media: M },
}
impl<M> From<Value> for OutputBody<M> {
    fn from(data: Value) -> Self {
        Self {
            data,
            parts: Vec::new(),
        }
    }
}
impl<M> OutputBody<M> {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            data: Value::Null,
            parts: vec![OutputPart::Text { text: text.into() }],
        }
    }
    pub fn map_media<N, E>(
        self,
        mut map: impl FnMut(M) -> Result<N, E>,
    ) -> Result<OutputBody<N>, E> {
        Ok(OutputBody {
            data: self.data,
            parts: self
                .parts
                .into_iter()
                .map(|part| {
                    Ok(match part {
                        OutputPart::Text { text } => OutputPart::Text { text },
                        OutputPart::Media { media } => OutputPart::Media { media: map(media)? },
                    })
                })
                .collect::<Result<_, E>>()?,
        })
    }
}

/// Accepted byte sources use original identities; a live nested read need not have an Operation row.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OutputSource {
    Conversation { provenance: Provenance },
    Tool { context: ToolExecutionContext },
    Operation { operation_id: String },
}
/// Producer boundary. It cannot carry a storage reference or author its own provenance.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct IncomingMedia {
    pub media_type: String,
    pub data_base64: String,
}
/// Immutable content identity, never a permission to read it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(deny_unknown_fields)]
pub struct ContentRef {
    pub content_object: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StoredMedia {
    pub media_type: String,
    pub source: OutputSource,
    pub content_ref: ContentRef,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ResolvedMedia {
    pub media_type: String,
    pub source: OutputSource,
    pub data_base64: String,
}
fn invalid(message: &str) -> crate::catalog::RuntimeError {
    crate::catalog::RuntimeError::Invalid(message.into())
}
pub(crate) fn media_bytes(
    media_type: &str,
    data: &str,
) -> Result<Vec<u8>, crate::catalog::RuntimeError> {
    let Some((top, subtype)) = media_type.split_once('/') else {
        return Err(invalid("media MIME type is required"));
    };
    let token = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&b))
    };
    if !token(top) || !token(subtype) {
        return Err(invalid("media MIME type is malformed"));
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| invalid("media data is not canonical base64"))?;
    if bytes.is_empty() || STANDARD.encode(&bytes) != data {
        return Err(invalid("media data is empty or not canonical base64"));
    }
    Ok(bytes)
}
impl IncomingMedia {
    pub fn admit(
        self,
        source: OutputSource,
    ) -> Result<ResolvedMedia, crate::catalog::RuntimeError> {
        media_bytes(&self.media_type, &self.data_base64)?;
        Ok(ResolvedMedia {
            media_type: self.media_type,
            source,
            data_base64: self.data_base64,
        })
    }
}
impl crate::content::ContentStore {
    pub(crate) fn store_media(
        &self,
        media: ResolvedMedia,
    ) -> Result<StoredMedia, crate::catalog::RuntimeError> {
        let bytes = media_bytes(&media.media_type, &media.data_base64)?;
        let reference = self.save_bytes(&bytes)?;
        Ok(StoredMedia {
            media_type: media.media_type,
            source: media.source,
            content_ref: serde_json::from_value(reference)?,
        })
    }
    pub(crate) fn resolve_media(
        &self,
        media: StoredMedia,
    ) -> Result<ResolvedMedia, crate::catalog::RuntimeError> {
        self.resolve_media_cancellable(media, &|| false)
    }
    pub(crate) fn resolve_media_cancellable(
        &self,
        media: StoredMedia,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<ResolvedMedia, crate::catalog::RuntimeError> {
        let bytes = self.load_bytes(&serde_json::to_value(&media.content_ref)?, cancelled)?;
        Ok(ResolvedMedia {
            media_type: media.media_type,
            source: media.source,
            data_base64: STANDARD.encode(bytes),
        })
    }
    pub(crate) fn save_output(
        &self,
        output: &OutputBody,
    ) -> Result<Value, crate::catalog::RuntimeError> {
        let stored = output.clone().map_media(|media| self.store_media(media))?;
        let dependencies = stored
            .parts
            .iter()
            .filter_map(|part| match part {
                OutputPart::Media { media } => Some(media.content_ref.content_object.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        self.save_with_dependencies(&serde_json::to_value(stored)?, dependencies)
    }
    pub(crate) fn load_stored_output(
        &self,
        reference: &Value,
    ) -> Result<OutputBody<StoredMedia>, crate::catalog::RuntimeError> {
        Ok(serde_json::from_value(self.load(reference)?)?)
    }
    pub(crate) fn load_output(
        &self,
        reference: &Value,
    ) -> Result<OutputBody, crate::catalog::RuntimeError> {
        self.load_output_cancellable(reference, &|| false)
    }
    pub(crate) fn load_output_cancellable(
        &self,
        reference: &Value,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<OutputBody, crate::catalog::RuntimeError> {
        let stored: OutputBody<StoredMedia> =
            serde_json::from_value(self.load_cancellable(reference, cancelled)?)?;
        stored.map_media(|media| self.resolve_media_cancellable(media, cancelled))
    }
}

impl<M> crate::execution::ToolCompletion<M> {
    pub fn map_media<N, E>(
        self,
        mut map: impl FnMut(M) -> Result<N, E>,
    ) -> Result<crate::execution::ToolCompletion<N>, E> {
        use crate::execution::ToolCompletion as C;
        Ok(match self {
            C::NotDispatched { reason } => C::NotDispatched { reason },
            C::Result {
                outcome,
                effect,
                content,
            } => C::Result {
                outcome,
                effect,
                content: content.map_media(&mut map)?,
            },
            C::JobAccepted {
                operation_id,
                phase,
                effect,
                lifetime,
                content,
            } => C::JobAccepted {
                operation_id,
                phase,
                effect,
                lifetime,
                content: content.map(|body| body.map_media(&mut map)).transpose()?,
            },
        })
    }
}
impl<M> crate::execution::ConversationItem<M> {
    pub fn map_media<N, E>(
        self,
        mut map: impl FnMut(M) -> Result<N, E>,
    ) -> Result<crate::execution::ConversationItem<N>, E> {
        use crate::execution::{Content as C, ConversationItem, ToolResult};
        let content = match self.content {
            C::Text { text } => C::Text { text },
            C::ReasoningSummary { text } => C::ReasoningSummary { text },
            C::Media { media } => C::Media { media: map(media)? },
            C::Output { output } => C::Output {
                output: output.map_media(&mut map)?,
            },
            C::ToolCall { call } => C::ToolCall { call },
            C::ProviderOnly => C::ProviderOnly,
            C::ToolResult { result } => C::ToolResult {
                result: ToolResult {
                    request_id: result.request_id,
                    call_id: result.call_id,
                    completion: result.completion.map_media(&mut map)?,
                },
            },
        };
        Ok(ConversationItem {
            resource_activation: self.resource_activation,
            id: self.id,
            provenance: self.provenance,
            content,
            opaque: self.opaque,
        })
    }
}
impl<M: Clone, S> crate::execution::RequestSnapshot<M, S> {
    pub fn map_media<N, E>(
        self,
        mut map: impl FnMut(M) -> Result<N, E>,
    ) -> Result<crate::execution::RequestSnapshot<N, S>, E> {
        use crate::execution::{RequestSnapshot, RequestView};
        let view = self.view;
        Ok(RequestSnapshot {
            serialized: self.serialized,
            view: RequestView {
                request_id: view.request_id,
                run_id: view.run_id,
                origin: view.origin,
                binding: view.binding,
                history: view
                    .history
                    .into_iter()
                    .map(|item| std::sync::Arc::unwrap_or_clone(item).map_media(&mut map).map(std::sync::Arc::new))
                    .collect::<Result<_, E>>()?,
            },
        })
    }
}
#[path = "output_snapshot.rs"]
mod snapshot_storage;

impl crate::content::ContentStore {
    pub(crate) fn save_snapshot(
        &self,
        snapshot: &crate::execution::RequestSnapshot,
    ) -> Result<Value, crate::catalog::RuntimeError> {
        snapshot_storage::save(self, snapshot)
    }
    pub(crate) fn load_snapshot(
        &self,
        reference: &Value,
    ) -> Result<crate::execution::RequestSnapshot, crate::catalog::RuntimeError> {
        self.load_snapshot_cancellable(reference, &|| false)
    }
    pub(crate) fn load_snapshot_cancellable(
        &self,
        reference: &Value,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<crate::execution::RequestSnapshot, crate::catalog::RuntimeError> {
        let snapshot: crate::execution::RequestSnapshot<StoredMedia> =
            serde_json::from_slice(&self.load_bytes(reference, cancelled)?)?;
        snapshot.map_media(|media| self.resolve_media_cancellable(media, cancelled))
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OperationResult<M = StoredMedia> {
    Control { value: Value },
    Output { output: OutputBody<M> },
}
impl<M> OperationResult<M> {
    pub fn control(&self) -> Result<&Value, crate::catalog::RuntimeError> {
        match self {
            Self::Control { value } => Ok(value),
            _ => Err(invalid(
                "operation has an output body, not domain control state",
            )),
        }
    }
    pub fn output(&self) -> Result<&OutputBody<M>, crate::catalog::RuntimeError> {
        match self {
            Self::Output { output } => Ok(output),
            _ => Err(invalid(
                "operation has domain control state, not an output body",
            )),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OutputMediaHolder {
    History {
        #[serde(rename = "itemId")]
        item_id: String,
    },
    Input {
        #[serde(rename = "inputId")]
        input_id: String,
        #[serde(rename = "expectedRevision")]
        expected_revision: u64,
    },
    Operation {
        #[serde(rename = "operationId")]
        operation_id: String,
        output: OperationOutputSelection,
    },
    Event {
        cursor: u64,
        output: OperationOutputSelection,
    },
    ChildReport {
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "executionId")]
        execution_id: Option<String>,
        #[serde(rename = "itemId")]
        item_id: String,
    },
    PolicyEvidence {
        reference: crate::execution::PolicyEvidenceRef,
    },
    Family {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "branchId")]
        branch_id: String,
        #[serde(rename = "runId")]
        run_id: Option<String>,
        anchor: String,
        #[serde(rename = "itemId")]
        item_id: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationOutputSelection {
    McpTaskResult,
    Completion,
    Result,
    ExternalReceipt,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaReadParams {
    pub thread_id: String,
    pub branch_id: String,
    pub holder: OutputMediaHolder,
    pub part_index: usize,
    pub chunk_index: usize,
    pub expected_content_ref: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaReadChunk {
    pub media: StoredMedia,
    pub part_index: usize,
    pub chunk_index: usize,
    pub chunk_count: usize,
    pub total_bytes: u64,
    pub bytes_base64: String,
}

impl<M> crate::execution::Content<M> {
    pub fn media(&self) -> Vec<&M> {
        use crate::execution::{Content, ToolCompletion};
        let output = match self {
            Content::Media { media } => return vec![media],
            Content::Output { output } => Some(output),
            Content::ToolResult { result } => match &result.completion {
                ToolCompletion::Result { content, .. } => Some(content),
                ToolCompletion::JobAccepted { content, .. } => content.as_ref(),
                _ => None,
            },
            _ => None,
        };
        output
            .into_iter()
            .flat_map(|output| {
                output.parts.iter().filter_map(|part| match part {
                    OutputPart::Media { media } => Some(media),
                    _ => None,
                })
            })
            .collect()
    }
}
impl crate::content::ContentStore {
    pub(crate) fn output_reference(
        output: &OutputBody,
    ) -> Result<Value, crate::catalog::RuntimeError> {
        let mut dependencies = Vec::new();
        let stored = output.clone().map_media(|media| {
            let bytes = media_bytes(&media.media_type, &media.data_base64)?;
            let content_ref: ContentRef =
                serde_json::from_value(Self::payload_reference(&bytes, Vec::new())?)?;
            dependencies.push(content_ref.content_object.clone());
            Ok::<_, crate::catalog::RuntimeError>(StoredMedia {
                media_type: media.media_type,
                source: media.source,
                content_ref,
            })
        })?;
        // Use the same Value serialization as save_output/save_with_dependencies.
        // Serializing the typed struct directly gives object keys a different order.
        Self::payload_reference(
            &serde_json::to_vec(&serde_json::to_value(stored)?)?,
            dependencies,
        )
    }
}

/// Admission validates only the explicitly typed user attachment field.
pub(crate) fn admit_user_input(
    input_id: &str,
    input: &Value,
) -> Result<Value, crate::catalog::RuntimeError> {
    let mut value = input.clone();
    if let Some(attachments) = value.get_mut("attachments") {
        let media: Vec<IncomingMedia> = serde_json::from_value(attachments.take())?;
        let source = OutputSource::Conversation {
            provenance: Provenance::UserInstruction {
                input_id: input_id.into(),
            },
        };
        *attachments = serde_json::to_value(
            media
                .into_iter()
                .map(|media| media.admit(source.clone()))
                .collect::<Result<Vec<_>, _>>()?,
        )?;
    }
    Ok(value)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct StoredIncomingMedia {
    pub media_type: String,
    pub content_ref: ContentRef,
}
pub(crate) fn incoming_input_dependencies(
    input: &Value,
) -> Result<Vec<String>, crate::catalog::RuntimeError> {
    let Some(attachments) = input.get("attachments") else {
        return Ok(Vec::new());
    };
    let media: Vec<StoredIncomingMedia> = serde_json::from_value(attachments.clone())?;
    Ok(media
        .into_iter()
        .map(|media| media.content_ref.content_object)
        .collect())
}
pub(crate) fn user_input_dependencies(
    input: &Value,
) -> Result<Vec<String>, crate::catalog::RuntimeError> {
    let Some(attachments) = input.get("attachments") else {
        return Ok(Vec::new());
    };
    let media: Vec<StoredMedia> = serde_json::from_value(attachments.clone())?;
    Ok(media
        .into_iter()
        .map(|media| media.content_ref.content_object)
        .collect())
}
impl crate::content::ContentStore {
    pub(crate) fn normalized_user_input(
        input_id: &str,
        input: &Value,
    ) -> Result<Value, crate::catalog::RuntimeError> {
        let mut value = admit_user_input(input_id, input)?;
        // The first admitted clock observation is retained with history. A retry's
        // new observation or changed time-display preference is not a new user intent.
        if let Some(object) = value.as_object_mut() { object.remove("sentTime"); }
        if let Some(attachments) = value.get_mut("attachments") {
            let media: Vec<ResolvedMedia> = serde_json::from_value(attachments.take())?;
            *attachments = serde_json::to_value(
                media
                    .into_iter()
                    .map(|media| {
                        let bytes = media_bytes(&media.media_type, &media.data_base64)?;
                        Ok::<_, crate::catalog::RuntimeError>(StoredIncomingMedia {
                            media_type: media.media_type,
                            content_ref: serde_json::from_value(Self::payload_reference(
                                &bytes,
                                Vec::new(),
                            )?)?,
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            )?;
        }
        Ok(value)
    }
    pub(crate) fn store_user_input(
        &self,
        input_id: &str,
        input: &Value,
    ) -> Result<Value, crate::catalog::RuntimeError> {
        let mut value = admit_user_input(input_id, input)?;
        if let Some(attachments) = value.get_mut("attachments") {
            let media: Vec<ResolvedMedia> = serde_json::from_value(attachments.take())?;
            *attachments = serde_json::to_value(
                media
                    .into_iter()
                    .map(|media| self.store_media(media))
                    .collect::<Result<Vec<_>, _>>()?,
            )?;
        }
        Ok(value)
    }
    pub(crate) fn save_stored_user_history(
        &self,
        input: &Value,
    ) -> Result<Value, crate::catalog::RuntimeError> {
        self.save_with_dependencies(
            &serde_json::json!({"format":"user_input","content":input,"provider":null}),
            user_input_dependencies(input)?,
        )
    }
}

#[path = "output_policy.rs"]
mod policy;
pub use policy::PolicyResultFormat;

impl crate::content::ContentStore {
    pub(crate) fn save_items(
        &self,
        items: &[std::sync::Arc<crate::execution::ConversationItem>],
    ) -> Result<Value, crate::catalog::RuntimeError> {
        let mut dependencies = Vec::new();
        let stored = items
            .iter()
            .cloned()
            .map(|item| {
                std::sync::Arc::unwrap_or_clone(item).map_media(|media| {
                    let stored = self.store_media(media)?;
                    dependencies.push(stored.content_ref.content_object.clone());
                    Ok::<_, crate::catalog::RuntimeError>(stored)
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.save_with_dependencies(&serde_json::to_value(stored)?, dependencies)
    }
    pub(crate) fn load_items(
        &self,
        reference: &Value,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<crate::execution::ConversationHistory, crate::catalog::RuntimeError> {
        let stored: Vec<crate::execution::ConversationItem<StoredMedia>> =
            serde_json::from_value(self.load_cancellable(reference, cancelled)?)?;
        stored
            .into_iter()
            .map(|item| item.map_media(|media| self.resolve_media_cancellable(media, cancelled)).map(std::sync::Arc::new))
            .collect()
    }
}
