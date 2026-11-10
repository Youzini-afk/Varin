//! One ordered model projection of the original immutable user input. Navigation sources
//! stay in its ContentStore payload; only selected content and readable labels leave here.
use crate::{
    catalog::RuntimeError,
    execution::Content,
    output::{OutputBody, OutputPart, ResolvedMedia},
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
type Result<T> = std::result::Result<T, RuntimeError>;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reference {
    #[serde(rename = "ref")]
    id: String,
    title: String,
    number: Option<u64>,
    label: Option<String>,
    text: Option<String>,
    image_reference: Option<u64>,
    attachment: Option<crate::catalog::attachments::AttachmentSelection>,
    attachment_ref: Option<String>,
    source: Value,
}
#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Occurrence {
    Content {
        #[serde(rename = "ref")]
        id: String,
        start: usize,
        end: usize,
    },
    Image {
        reference: u64,
        start: usize,
        end: usize,
    },
}
impl Occurrence {
    fn range(&self) -> (usize, usize) {
        match self {
            Self::Content { start, end, .. } | Self::Image { start, end, .. } => (*start, *end),
        }
    }
}
fn invalid(message: &str) -> RuntimeError {
    RuntimeError::Invalid(message.into())
}
fn references(input: &Value) -> Result<Vec<Reference>> {
    input
        .get("contentReferences")
        .map(|value| serde_json::from_value(value.clone()).map_err(Into::into))
        .unwrap_or_else(|| Ok(Vec::new()))
}
fn occurrences(input: &Value) -> Result<Vec<Occurrence>> {
    input
        .get("contentReferenceOccurrences")
        .map(|value| serde_json::from_value(value.clone()).map_err(Into::into))
        .unwrap_or_else(|| Ok(Vec::new()))
}
fn original(input: &Value) -> Result<&str> {
    input
        .get("userText")
        .or_else(|| input.get("text"))
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("quoted input requires original user text"))
}
fn marker(number: u64) -> String {
    format!("[引用点{number}]")
}
fn image_marker(number: u64) -> String {
    format!("[图片{number}]")
}
fn image_numbers(input: &Value, previous: Option<&Value>) -> Result<Vec<u64>> {
    let owner = if input.get("attachments").is_some() {
        input
    } else {
        previous.unwrap_or(input)
    };
    let mut numbers = crate::output::image_references(owner)?.unwrap_or_default();
    if let Some(bindings) = input
        .get("attachmentImageReferences")
        .or_else(|| previous.and_then(|value| value.get("attachmentImageReferences")))
    {
        let bindings: std::collections::BTreeMap<String, u64> =
            serde_json::from_value(bindings.clone())?;
        numbers.extend(bindings.into_values());
    }
    Ok(numbers)
}

/// Runs before preparation/skill activation. All ranges address the original draft, never
/// the longer readable quote expansion or appended Host context. Locators grant no authority.
pub(crate) fn validate(input: &Value, previous: Option<&Value>) -> Result<()> {
    validate_inner(input, previous, true)
}
pub(crate) fn validate_intent(input: &Value) -> Result<()> {
    validate_inner(input, None, false)
}
fn validate_inner(input: &Value, previous: Option<&Value>, prepared: bool) -> Result<()> {
    if input.get("contentReferences").is_none()
        && input.get("contentReferenceOccurrences").is_none()
    {
        return Ok(());
    }
    let references = references(input)?;
    let mut occurrences = occurrences(input)?;
    let original = original(input)?;
    let units: Vec<_> = original.encode_utf16().collect();
    let images: HashSet<_> = image_numbers(input, previous)?.into_iter().collect();
    let files = crate::catalog::attachments::input_attachments(
        if input.get("fileAttachments").is_some() {
            input
        } else {
            previous.unwrap_or(input)
        },
    )?;
    let file_ids: HashSet<_> = files
        .iter()
        .map(|attachment| attachment.reference.as_str())
        .collect();
    let mut ids = HashMap::new();
    let mut numbers = HashSet::new();
    for (index, reference) in references.iter().enumerate() {
        let number = reference.number.unwrap_or(index as u64 + 1);
        if reference.id.trim().is_empty()
            || reference.title.trim().is_empty()
            || number == 0
            || ids.insert(reference.id.as_str(), number).is_some()
            || ((reference.image_reference.is_none()
                || reference.text.as_ref().is_some_and(|text| !text.is_empty()))
                && !numbers.insert(number))
        {
            return Err(invalid(
                "quote objects require unique identities and positive message-local numbers",
            ));
        }
        let kind = reference.source.get("kind").and_then(Value::as_str);
        if !matches!(
            kind,
            Some("ui" | "object" | "chat" | "document" | "file" | "tool")
        ) || !reference.source.is_object()
        {
            return Err(invalid(
                "quote source must identify its original content kind",
            ));
        }
        if let Some(attachment) = &reference.attachment {
            attachment.validate()?;
        }
        if prepared
            && reference
                .image_reference
                .is_some_and(|number| !images.contains(&number))
        {
            return Err(invalid(
                "quoted image is not bound to this input's retained media",
            ));
        }
        if prepared
            && reference
                .attachment_ref
                .as_ref()
                .is_some_and(|id| !file_ids.contains(id.as_str()))
        {
            return Err(invalid(
                "quoted file is not bound to this input's prepared attachment",
            ));
        }
        if prepared && reference.attachment.is_some() && reference.attachment_ref.is_none() {
            return Err(invalid("quoted file requires original-owner preparation"));
        }
        if reference.text.is_none()
            && reference.image_reference.is_none()
            && reference.attachment_ref.is_none()
            && reference.attachment.is_none()
        {
            return Err(invalid(
                "quote requires fixed readable content or an original attachment",
            ));
        }
    }
    occurrences.sort_by_key(Occurrence::range);
    let mut end = 0;
    let mut ranges = Vec::new();
    for occurrence in occurrences {
        let (start, next) = occurrence.range();
        if start < end || start >= next || next > units.len() {
            return Err(invalid(
                "quote occurrences have overlapping or invalid original-text ranges",
            ));
        }
        // Validate both edges, including a leading low/trailing high surrogate outside the range.
        String::from_utf16(&units[start..next])
            .map_err(|_| invalid("quote occurrence splits a UTF-16 character"))?;
        if String::from_utf16(&units[..start]).is_err()
            || String::from_utf16(&units[next..]).is_err()
        {
            return Err(invalid("quote occurrence splits a UTF-16 character"));
        }
        // The explicit relation binds this range. Display labels are localized and
        // may change; recognizing their spelling would confuse presentation with
        // identity. Unbound marker-shaped text remains ordinary user text.
        let valid = match occurrence {
            Occurrence::Content { id, .. } => ids.contains_key(id.as_str()),
            Occurrence::Image { reference, .. } => {
                reference > 0 && (!prepared || images.contains(&reference))
            }
        };
        if !valid {
            return Err(invalid(
                "quote occurrence does not identify its bound object",
            ));
        }
        ranges.push((start, next));
        end = next;
    }
    for field in ["skills", "references"] {
        if let Some(entries) = input.get(field).and_then(Value::as_array) {
            for entry in entries {
                if let Some((start, end)) = entry
                    .get("start")
                    .and_then(Value::as_u64)
                    .zip(entry.get("end").and_then(Value::as_u64))
                {
                    if ranges.iter().any(|(quote_start, quote_end)| {
                        start < *quote_end as u64 && end > *quote_start as u64
                    }) {
                        return Err(invalid(
                            "quote occurrence overlaps another original-text selection",
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

/// The boolean identifies selected material rather than new user instructions. Provider
/// adapters encode these already ordered parts and never interpret source metadata.
pub(crate) fn project(input: &Value) -> Result<Option<Vec<(Content, bool)>>> {
    if input.get("contentReferences").is_none()
        && input.get("contentReferenceOccurrences").is_none()
    {
        return Ok(None);
    }
    let references = references(input)?;
    let mut occurrences = occurrences(input)?;
    occurrences.sort_by_key(Occurrence::range);
    let text = original(input)?;
    let units: Vec<_> = text.encode_utf16().collect();
    let media: Vec<ResolvedMedia> = input
        .get("attachments")
        .map(|value| serde_json::from_value(value.clone()))
        .transpose()?
        .unwrap_or_default();
    let numbers = crate::output::image_references(input)?.unwrap_or_default();
    let file_numbers: std::collections::BTreeMap<String, u64> = input
        .get("attachmentImageReferences")
        .map(|value| serde_json::from_value(value.clone()))
        .transpose()?
        .unwrap_or_default();
    let files = crate::catalog::attachments::input_attachments(input)?;
    let mut projection = Projection {
        references: &references,
        media: &media,
        numbers: &numbers,
        files: &files,
        file_numbers: &file_numbers,
        parts: vec![],
        seen_quotes: HashSet::new(),
        seen_images: HashSet::new(),
        seen_files: HashSet::new(),
    };
    let mut offset = 0;
    for occurrence in occurrences {
        let (start, end) = occurrence.range();
        projection.text(
            String::from_utf16(&units[offset..start])
                .map_err(|_| invalid("invalid quote text edge"))?,
            false,
        );
        match occurrence {
            Occurrence::Content { id, .. } => {
                let index = references
                    .iter()
                    .position(|reference| reference.id == id)
                    .ok_or_else(|| invalid("quote object missing"))?;
                projection.quote(index)?;
            }
            Occurrence::Image { reference, .. } => projection.image(reference)?,
        }
        offset = end;
    }
    projection.text(
        String::from_utf16(&units[offset..]).map_err(|_| invalid("invalid quote text edge"))?,
        false,
    );
    // Explicitly retained attachments without occurrences follow the user's original body.
    for index in 0..references.len() {
        if !projection.seen_quotes.contains(&index) {
            projection.quote(index)?;
        }
    }
    for number in &numbers {
        if !projection.seen_images.contains(number) {
            projection.image(*number)?;
        }
    }
    // Legacy unnumbered images keep their actual owner and are appended once.
    if numbers.is_empty() {
        for media in &media {
            projection.parts.push((
                Content::Media {
                    media: media.clone(),
                },
                false,
            ));
        }
    }
    for number in file_numbers.values() {
        if !projection.seen_images.contains(number) {
            projection.image(*number)?;
        }
    }
    for attachment in &files {
        projection.file(attachment);
    }
    // Object/skill parsing already used original text. Preserve legitimate Host-added context.
    if let Some(expanded) = input.get("text").and_then(Value::as_str) {
        if let Some(suffix) = expanded.strip_prefix(text) {
            projection.text(suffix.into(), false);
        }
    }
    if projection.parts.is_empty() {
        projection.text(String::new(), false);
    }
    Ok(Some(projection.parts))
}
struct Projection<'a> {
    references: &'a [Reference],
    media: &'a [ResolvedMedia],
    numbers: &'a [u64],
    files: &'a [crate::catalog::attachments::Attachment],
    file_numbers: &'a std::collections::BTreeMap<String, u64>,
    parts: Vec<(Content, bool)>,
    seen_quotes: HashSet<usize>,
    seen_images: HashSet<u64>,
    seen_files: HashSet<String>,
}
impl Projection<'_> {
    fn text(&mut self, text: String, material: bool) {
        if !text.is_empty() {
            self.parts.push((Content::Text { text }, material));
        }
    }
    fn file(&mut self, attachment: &crate::catalog::attachments::Attachment) {
        if self.seen_files.insert(attachment.reference.clone()) {
            self.parts.push((
                Content::Output {
                    output: OutputBody {
                        data: Value::Null,
                        model_data: None,
                        parts: vec![OutputPart::Attachment {
                            attachment: attachment.clone(),
                        }],
                    },
                },
                false,
            ));
        }
    }
    fn image(&mut self, number: u64) -> Result<()> {
        self.text(image_marker(number), false);
        if self.seen_images.insert(number) {
            if let Some(index) = self.numbers.iter().position(|value| *value == number) {
                let media = self
                    .media
                    .get(index)
                    .ok_or_else(|| invalid("quoted image media missing"))?;
                self.parts.push((
                    Content::Media {
                        media: media.clone(),
                    },
                    false,
                ));
            } else {
                let attachment = self
                    .files
                    .iter()
                    .find(|file| self.file_numbers.get(&file.reference) == Some(&number))
                    .ok_or_else(|| {
                        invalid(
                            "quoted image has neither visual media nor an original readable file",
                        )
                    })?;
                self.text(
                    "Image supplied as a readable attachment, not direct visual input.".into(),
                    false,
                );
                self.file(attachment);
            }
            for (index, reference) in self.references.iter().enumerate() {
                if reference.image_reference == Some(number)
                    && reference.text.as_ref().is_none_or(String::is_empty)
                {
                    self.seen_quotes.insert(index);
                }
            }
        }
        Ok(())
    }
    fn quote(&mut self, index: usize) -> Result<()> {
        let reference = &self.references[index];
        let number = reference.number.unwrap_or(index as u64 + 1);
        if !self.seen_quotes.insert(index) {
            self.text(
                if reference.text.as_ref().is_none_or(String::is_empty) {
                    reference
                        .image_reference
                        .map(image_marker)
                        .unwrap_or_else(|| marker(number))
                } else {
                    marker(number)
                },
                false,
            );
            return Ok(());
        }
        if reference.text.as_ref().is_none_or(String::is_empty) {
            if let Some(image) = reference.image_reference {
                self.image(image)?;
                // The file remains independently retained and is emitted by the common
                // attachment pass. It does not turn a pure image into an empty text quote.
                return Ok(());
            }
        }
        let label = reference.label.as_deref().unwrap_or_else(|| {
            match reference.source.get("kind").and_then(Value::as_str) {
                Some("chat") => match reference.source.get("role").and_then(Value::as_str) {
                    Some("user") => "用户消息",
                    Some("tool") => "工具结果",
                    _ => "Varin",
                },
                Some("tool") => "工具结果",
                Some("file" | "document") => "文件",
                _ => "交互内容",
            }
        });
        let mut quoted = format!("\n[引用点{number} · {label}]\n");
        if let Some(text) = &reference.text {
            quoted.push_str(
                &text
                    .split('\n')
                    .map(|line| format!("> {line}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
            quoted.push('\n');
        }
        let user_quote = reference.source.get("kind").and_then(Value::as_str) == Some("chat")
            && reference.source.get("role").and_then(Value::as_str) == Some("user");
        self.text(quoted, !user_quote);
        if let Some(image) = reference.image_reference {
            self.image(image)?;
        }
        if let Some(id) = &reference.attachment_ref {
            let attachment = self
                .files
                .iter()
                .find(|attachment| &attachment.reference == id)
                .ok_or_else(|| invalid("quoted file missing"))?;
            self.file(attachment);
        }
        Ok(())
    }
}
