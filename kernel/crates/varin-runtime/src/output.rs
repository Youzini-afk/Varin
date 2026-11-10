//! One immutable output body for every invocation origin. JSON is data; presentation is explicit.
use crate::execution::{Provenance, ToolExecutionContext};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct OutputBody<M = ResolvedMedia> {
    pub data: Value,
    /// Stable owner-authored projection; raw data remains the original receipt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_data: Option<Value>,
    pub parts: Vec<OutputPart<M>>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OutputPart<M = ResolvedMedia> {
    Attachment { attachment: crate::catalog::attachments::Attachment },
    Text { text: String },
    Media { media: M },
}
impl<M> From<Value> for OutputBody<M> {
    fn from(data: Value) -> Self {
        Self {
            model_data: None,
            data,
            parts: Vec::new(),
        }
    }
}
impl<M> OutputBody<M> {
    pub fn model_data(&self) -> &Value { self.model_data.as_ref().unwrap_or(&self.data) }

    pub fn text(text: impl Into<String>) -> Self {
        Self {
            model_data: None,
            data: Value::Null,
            parts: vec![OutputPart::Text { text: text.into() }],
        }
    }
    pub fn map_media<N, E>(
        self,
        mut map: impl FnMut(M) -> Result<N, E>,
    ) -> Result<OutputBody<N>, E> {
        Ok(OutputBody {
            model_data: self.model_data,
            data: self.data,
            parts: self
                .parts
                .into_iter()
                .map(|part| {
                    Ok(match part {
                        OutputPart::Text { text } => OutputPart::Text { text },
                        OutputPart::Attachment { attachment } => OutputPart::Attachment { attachment },
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
        self.save_output_with_dependencies(output, Vec::new())
    }
    /// Additional byte references are admitted by the owning typed producer, never output JSON.
    pub(crate) fn save_output_with_dependencies(
        &self,
        output: &OutputBody,
        mut dependencies: Vec<String>,
    ) -> Result<Value, crate::catalog::RuntimeError> {
        let stored = output.clone().map_media(|media| self.store_media(media))?;
        dependencies.extend(stored
            .parts
            .iter()
            .filter_map(|part| match part {
                OutputPart::Media { media } => Some(media.content_ref.content_object.clone()),
                _ => None,
            })
            .collect::<Vec<_>>());
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
            C::NotDispatched { reason, error } => C::NotDispatched { reason, error },
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

/// Image references belong to this input, independent of media storage and tool output.
pub(crate) fn image_references(input: &Value) -> Result<Option<Vec<u64>>, crate::catalog::RuntimeError> {
    let Some(value) = input.get("imageReferences") else { return Ok(None); };
    let references: Vec<u64> = serde_json::from_value(value.clone())?;
    let attachments = input.get("attachments").and_then(Value::as_array);
    let mut seen = std::collections::HashSet::new();
    if attachments.is_none_or(|items| items.len() != references.len())
        || references.iter().any(|number| *number == 0 || !seen.insert(*number)) {
        return Err(crate::catalog::RuntimeError::Invalid("image references must uniquely identify each attachment".into()));
    }
    Ok(Some(references))
}

/// These locators are input metadata only. The Host resolves visibility and sources;
/// neither a Thread ID nor a path here authorizes a resource read or delegation.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase", deny_unknown_fields)]
enum InputObjectReference {
    Thread { thread_id: String, branch_id: String, start: usize, end: usize },
    Directory { path: String, start: usize, end: usize },
}

/// Durable User intent for a message whose current object locators are prepared by the Host.
/// Keep material selectors here rather than rebuilding an accepted message from current readers.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InputReferenceIntent {
    text: String,
    #[serde(default)]
    materials: Vec<InputReferenceMaterial>,
    #[serde(default)]
    attachment_selections: Vec<crate::catalog::attachments::AttachmentSelection>,
    #[serde(default)]
    original_image_count: Option<usize>,
    #[serde(default)]
    attachment_image_references: std::collections::BTreeMap<String, u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InputReferenceMaterial {
    snapshot_id: String,
}

/// A Host-added marker identifies the original visible prefix before appended context.
/// It cannot supply an alternative hidden command or replace the submitted text.
pub(crate) fn validate_user_metadata(input: &Value) -> Result<(), crate::catalog::RuntimeError> {
    validate_user_metadata_with_retained_media(input, None)
}

// Only the native queued-input edit owner may supply its previously accepted content.
// This changes count validation, never accepts stored media references as fresh input.
pub(crate) fn validate_user_metadata_with_retained_media(input: &Value, previous: Option<&Value>) -> Result<(), crate::catalog::RuntimeError> { validate_user_metadata_inner(input, previous, true) }
fn validate_user_metadata_inner(input: &Value, previous: Option<&Value>, prepared: bool) -> Result<(), crate::catalog::RuntimeError> {
    if prepared { crate::input_quotes::validate(input, previous)?; } else { crate::input_quotes::validate_intent(input)?; }
    if let Some(value) = input.get("attachmentImageReferences").filter(|_| prepared) {
        let references: std::collections::BTreeMap<String, u64> = serde_json::from_value(value.clone())?;
        let files = crate::catalog::attachments::input_attachments(input)?;
        let mut seen = std::collections::HashSet::new();
        if references.iter().any(|(id, number)| *number == 0 || !files.iter().any(|file| &file.reference == id && file.mime_type.starts_with("image/")) || !seen.insert(number)) {
            return Err(crate::catalog::RuntimeError::Invalid("attachment image bindings require the original file and media owners".into()));
        }
    }
    if let Some(value) = input.get("userText") {
        let valid = value.as_str().zip(input.get("text").and_then(Value::as_str))
            .is_some_and(|(original, text)| text.starts_with(original));
        if !valid {
            return Err(crate::catalog::RuntimeError::Invalid("original user text must be an exact prefix of input text".into()));
        }
    }
    if let Some(value) = input.get("referenceIntent") {
        let intent: InputReferenceIntent = serde_json::from_value(value.clone())?;
        let original = input.get("userText").or_else(|| input.get("text")).and_then(Value::as_str);
        for selection in &intent.attachment_selections { selection.validate()?; }
        let image_count = input.get("attachments").or_else(|| previous.and_then(|value| value.get("attachments")))
            .and_then(Value::as_array).map_or(0, Vec::len);
        if original != Some(intent.text.as_str())
            || !["references", "contentReferences", "contentReferenceOccurrences"].iter().any(|key| input.get(*key).and_then(Value::as_array).is_some_and(|references| !references.is_empty()))
            || intent.materials.iter().any(|material| material.snapshot_id.trim().is_empty())
            || intent.attachment_image_references.iter().any(|(id, number)| id.trim().is_empty() || *number == 0)
            || intent.attachment_selections.is_empty() != intent.original_image_count.is_none()
            || intent.original_image_count.is_some_and(|count| count > image_count) {
            return Err(crate::catalog::RuntimeError::Invalid("reference intent must identify original text, references and material selectors".into()));
        }
    }
    if let Some(value) = input.get("references") {
        let references: Vec<InputObjectReference> = serde_json::from_value(value.clone())?;
        if !references.is_empty() {
            let text = input.get("userText").or_else(|| input.get("text")).and_then(Value::as_str)
                .ok_or_else(|| crate::catalog::RuntimeError::Invalid("object references require original user text".into()))?;
            let text: Vec<u16> = text.encode_utf16().collect();
            let mut ranges = Vec::new();
            for reference in references {
                let (valid, start, end) = match reference {
                    InputObjectReference::Thread { thread_id, branch_id, start, end } => (!thread_id.trim().is_empty() && !branch_id.trim().is_empty(), start, end),
                    InputObjectReference::Directory { path, start, end } => (!path.trim().is_empty(), start, end),
                };
                if !valid || start >= end || end > text.len() || String::from_utf16(&text[start..end]).is_err() {
                    return Err(crate::catalog::RuntimeError::Invalid("object reference has an invalid identity or text range".into()));
                }
                ranges.push((start, end));
            }
            ranges.sort_unstable();
            if ranges.windows(2).any(|pair| pair[0].1 > pair[1].0) {
                return Err(crate::catalog::RuntimeError::Invalid("object reference text ranges overlap".into()));
            }
        }
    }
    Ok(())
}

/// Admission validates explicitly typed user metadata and attachments.
pub(crate) fn admit_user_input(
    input_id: &str,
    input: &Value,
) -> Result<Value, crate::catalog::RuntimeError> {
    admit_user_input_with_retained_media(input_id, input, None)
}

pub(crate) fn admit_user_input_with_retained_media(
    input_id: &str,
    input: &Value,
    previous: Option<&Value>,
) -> Result<Value, crate::catalog::RuntimeError> {
    validate_user_metadata_with_retained_media(input, previous)?;
    admit_input_media(input_id, input)
}
fn admit_input_media(input_id: &str, input: &Value) -> Result<Value, crate::catalog::RuntimeError> {
    image_references(input)?;
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
        // Identity comparison precedes resource preparation. It validates raw selectors and
        // original ranges, but never treats absent prepared descriptors as accepted media.
        validate_user_metadata_inner(input, None, false)?;
        let mut value = admit_input_media(input_id, input)?;
        // The first admitted clock observation is retained with history. A retry's
        // new observation or changed time-display preference is not a new user intent.
        if let Some(object) = value.as_object_mut() {
            object.remove("sentTime");
            // Marked object-reference input has an explicit raw intent. Current locator text
            // and material descriptions must not rewrite an already accepted retry.
            if let Some(text) = object.get("referenceIntent").and_then(|intent| intent.get("text")).cloned() {
                object.insert("text".into(), text);
                if let Some(references) = object.get_mut("contentReferences").and_then(Value::as_array_mut) {
                    for reference in references { if let Some(reference) = reference.as_object_mut() { reference.remove("attachmentRef"); } }
                }
                if let Some(count) = object.get("referenceIntent").and_then(|intent| intent.get("originalImageCount")).and_then(Value::as_u64) {
                    // File descriptors and their automatically rendered vision media are frozen
                    // material, not a second identity for the same original attachment selectors.
                    object.remove("fileAttachments");
                    object.remove("attachmentImageReferences");
                    if count == 0 { object.remove("attachments"); object.remove("imageReferences"); }
                    else {
                        if let Some(images) = object.get_mut("attachments").and_then(Value::as_array_mut) { images.truncate(count as usize); }
                        if let Some(references) = object.get_mut("imageReferences").and_then(Value::as_array_mut) { references.truncate(count as usize); }
                    }
                }
            }
            // Unmarked inputs retain their actual submitted text for historical compatibility.
            // The original-prefix marker itself is derived presentation metadata.
            object.remove("userText");
        }
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
        self.store_admitted_user_input(admit_user_input(input_id, input)?)
    }
    pub(crate) fn store_edited_user_input(
        &self,
        input_id: &str,
        input: &Value,
        previous: &Value,
    ) -> Result<Value, crate::catalog::RuntimeError> {
        self.store_admitted_user_input(admit_user_input_with_retained_media(input_id, input, Some(previous))?)
    }
    fn store_admitted_user_input(&self, mut value: Value) -> Result<Value, crate::catalog::RuntimeError> {
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
        let payload = serde_json::json!({"format":"user_input","content":input,"provider":null});
        self.index_history_text(self.save_with_dependencies(&payload, user_input_dependencies(input)?)?, &payload)
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

#[cfg(test)]
mod reference_attachment_intent_tests {

    #[test]
    fn raw_reference_retry_retains_selected_files_and_only_original_images() {
        let raw = serde_json::json!({
            "text": "Read @task", "references": [{"kind":"thread","threadId":"other","branchId":"branch","start":5,"end":10}],
            "referenceIntent": {"text":"Read @task","attachmentSelections":[{"ref":"attachment:original"}],"originalImageCount":1},
            "attachments": [{"media_type":"image/png","data_base64":"dXNlcg=="}], "imageReferences":[3]
        });
        let mut prepared = raw.clone();
        prepared["text"] = serde_json::json!("Read @task\nFrozen context");
        prepared["userText"] = serde_json::json!("Read @task");
        prepared["fileAttachments"] = serde_json::json!([{"ref":"attachment:frozen","filename":"image.png","mimeType":"image/png","byteLength":4}]);
        prepared["attachments"].as_array_mut().unwrap().push(serde_json::json!({"media_type":"image/png","data_base64":"ZmlsZQ=="}));
        prepared["imageReferences"] = serde_json::json!([3,4]);
        let normalized = crate::content::ContentStore::normalized_user_input("input", &raw).unwrap();
        assert_eq!(normalized, crate::content::ContentStore::normalized_user_input("input", &prepared).unwrap());
        let mut changed = raw.clone();
        changed["referenceIntent"]["attachmentSelections"][0]["ref"] = serde_json::json!("attachment:other");
        assert_ne!(normalized, crate::content::ContentStore::normalized_user_input("input", &changed).unwrap());
        changed["referenceIntent"]["originalImageCount"] = serde_json::json!(2);
        assert!(crate::content::ContentStore::normalized_user_input("input", &changed).is_err());
        changed["referenceIntent"]["originalImageCount"] = serde_json::json!(0);
        changed.as_object_mut().unwrap().remove("attachments");
        changed.as_object_mut().unwrap().remove("imageReferences");
        assert!(crate::content::ContentStore::normalized_user_input("input", &changed).is_ok());
    }
}
