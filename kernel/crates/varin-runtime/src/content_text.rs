//! Sparse indexes into original JSON strings. No duplicate text or media is stored.
//! Auxiliary readers can inspect message kind, then read only selected Unicode ranges.
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TextRange {
    offset: usize,
    chars: usize,
    marks: Vec<(usize, usize)>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TextIndex {
    chars: usize,
    ranges: Vec<TextRange>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    media_types: Vec<String>,
}
const STRIDE: usize = 256;
fn offset(value: &Value, path: &[String]) -> Result<usize> {
    if path.is_empty() {
        return Ok(0);
    }
    match value {
        Value::Object(map) => {
            let mut position = 1;
            for (index, (key, child)) in map.iter().enumerate() {
                if index > 0 {
                    position += 1;
                }
                position += serde_json::to_vec(key)?.len() + 1;
                if key == &path[0] {
                    return Ok(position + offset(child, &path[1..])?);
                }
                position += serde_json::to_vec(child)?.len();
            }
        }
        Value::Array(items) => {
            let index: usize = path[0]
                .parse()
                .map_err(|_| RuntimeError::Invalid("Text index array position invalid".into()))?;
            let mut position = 1;
            for (current, child) in items.iter().enumerate() {
                if current > 0 {
                    position += 1;
                }
                if current == index {
                    return Ok(position + offset(child, &path[1..])?);
                }
                position += serde_json::to_vec(child)?.len();
            }
        }
        _ => (),
    }
    Err(RuntimeError::Invalid("Text index path missing".into()))
}
fn text_paths(payload: &Value) -> Vec<Vec<String>> {
    let content = &payload["content"];
    if content.is_string() {
        return vec![vec!["content".into()]];
    }
    if content["text"].is_string() {
        return vec![vec!["content".into(), "text".into()]];
    }
    let body = &content["content"];
    if body["kind"] == "text" && body["text"].is_string() {
        return vec![vec!["content".into(), "content".into(), "text".into()]];
    }
    if body["kind"] == "output" {
        return body["output"]["parts"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .filter(|(_, part)| part["kind"] == "text" && part["text"].is_string())
            .map(|(index, _)| {
                vec![
                    "content".into(),
                    "content".into(),
                    "output".into(),
                    "parts".into(),
                    index.to_string(),
                    "text".into(),
                ]
            })
            .collect();
    }
    Vec::new()
}
fn media_types(payload: &Value) -> Vec<String> {
    let content = &payload["content"];
    let body = &content["content"];
    let mut media = Vec::new();
    if payload["format"] == "user_input" {
        media.extend(content["attachments"].as_array().into_iter().flatten());
    }
    if body["kind"] == "media" {
        media.push(&body["media"]);
    }
    if body["kind"] == "output" {
        media.extend(
            body["output"]["parts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|part| part["kind"] == "media")
                .map(|part| &part["media"]),
        );
    }
    media
        .into_iter()
        .filter_map(|media| media["media_type"].as_str().map(str::to_owned))
        .collect()
}
impl ContentStore {
    pub(crate) fn index_history_text(
        &self,
        mut reference: Value,
        payload: &Value,
    ) -> Result<Value> {
        if !payload.as_object().is_some_and(|object| {
            object.contains_key("content")
                && object.contains_key("provider")
                && object
                    .keys()
                    .all(|key| matches!(key.as_str(), "format" | "content" | "provider" | "metadata"))
        }) || !matches!(
            payload["format"].as_str(),
            Some("data" | "conversation" | "user_input")
        ) {
            return Err(RuntimeError::Invalid(
                "Invalid original history payload for text indexing".into(),
            ));
        }
        let mut index = TextIndex {
            chars: 0,
            ranges: Vec::new(),
            media_types: media_types(payload),
        };
        for path in text_paths(payload) {
            let mut value = payload;
            for key in &path {
                value = if let Value::Array(array) = value {
                    &array[key.parse::<usize>().unwrap()]
                } else {
                    &value[key]
                };
            }
            let text = value
                .as_str()
                .ok_or_else(|| RuntimeError::Invalid("Text index is not a string".into()))?;
            if text.is_empty() {
                continue;
            }
            let mut marks = vec![(0, 0)];
            let mut bytes = 0;
            let mut chars = 0;
            for ch in text.chars() {
                bytes += serde_json::to_string(&ch.to_string())?.len() - 2;
                chars += 1;
                if chars % STRIDE == 0 {
                    marks.push((chars, bytes));
                }
            }
            if marks.last() != Some(&(chars, bytes)) {
                marks.push((chars, bytes));
            }
            if !index.ranges.is_empty() {
                index.chars += 1;
            }
            index.chars += chars;
            index.ranges.push(TextRange {
                offset: offset(payload, &path)? + 1,
                chars,
                marks,
            });
        }
        reference["history_text"] = serde_json::to_value(index)?;
        let body = &payload["content"]["content"];
        if body["kind"] == "tool_call" {
            if let Some(id) = body["call"]["call_id"].as_str() {
                reference["history_call_id"] = Value::String(id.into());
            }
        }
        Ok(reference)
    }
    fn read_byte_range(&self, reference: &Value, start: usize, end: usize) -> Result<Vec<u8>> {
        let _publication = self.begin_publication();
        let _io = self
            .coordination
            .io
            .read()
            .unwrap_or_else(|e| e.into_inner());
        let reference: Reference = serde_json::from_value(reference.clone())?;
        let manifest: Manifest =
            serde_json::from_slice(&self.read_bytes(&reference.content_object)?)?;
        if manifest.version != 2 || start > end || end as u64 > manifest.bytes {
            return Err(RuntimeError::Invalid(
                "Text range is outside original content".into(),
            ));
        }
        let mut result = Vec::with_capacity(end - start);
        let mut offset = 0;
        for hash in manifest.chunks {
            let size = fs::metadata(object_path(&self.root, &hash)?)?.len() as usize;
            if offset >= end {
                break;
            }
            if offset + size > start {
                let bytes = self.read_bytes(&hash)?;
                result.extend_from_slice(
                    &bytes[start.saturating_sub(offset)..(end - offset).min(bytes.len())],
                );
            }
            offset += size;
        }
        if result.len() != end - start {
            return Err(RuntimeError::Invalid(
                "Original text range is incomplete".into(),
            ));
        }
        Ok(result)
    }
    fn indexed_text_range(
        &self,
        reference: &Value,
        index: &TextIndex,
        start: usize,
        end: usize,
    ) -> Result<String> {
        let mut offset = 0;
        let mut result = String::new();
        for (position, range) in index.ranges.iter().enumerate() {
            if position > 0 {
                if start <= offset && offset < end {
                    result.push('\n');
                }
                offset += 1;
            }
            if offset >= end {
                break;
            }
            if offset + range.chars > start {
                let from = start.saturating_sub(offset);
                let to = (end - offset).min(range.chars);
                let first = range
                    .marks
                    .iter()
                    .rev()
                    .find(|(chars, _)| *chars <= from)
                    .ok_or_else(|| RuntimeError::Invalid("Text index prefix missing".into()))?;
                let last = range
                    .marks
                    .iter()
                    .find(|(chars, _)| *chars >= to)
                    .ok_or_else(|| RuntimeError::Invalid("Text index suffix missing".into()))?;
                let raw =
                    self.read_byte_range(reference, range.offset + first.1, range.offset + last.1)?;
                let mut quoted = Vec::with_capacity(raw.len() + 2);
                quoted.push(b'"');
                quoted.extend(raw);
                quoted.push(b'"');
                let text: String = serde_json::from_slice(&quoted)?;
                result.extend(text.chars().skip(from - first.0).take(to - from));
            }
            offset += range.chars;
        }
        Ok(result)
    }
    pub(crate) fn history_media_types(&self, reference: &Value) -> Result<Vec<String>> {
        let index: TextIndex = serde_json::from_value(
            reference
                .get("history_text")
                .cloned()
                .ok_or_else(|| RuntimeError::Invalid("Original history index missing".into()))?,
        )?;
        Ok(index.media_types)
    }
    /// None means the reference is not indexed. Supported older Catalogs install these
    /// indexes once at upgrade; selection never falls back to unbounded body reads.
    pub(crate) fn history_text_preview(
        &self,
        reference: &Value,
        limit: usize,
    ) -> Result<Option<String>> {
        let Some(value) = reference.get("history_text") else {
            return Ok(None);
        };
        let index: TextIndex = serde_json::from_value(value.clone())?;
        if index.chars <= limit {
            return self
                .indexed_text_range(reference, &index, 0, index.chars)
                .map(Some);
        }
        let marker = "\n[… omitted …]\n";
        let keep = limit.saturating_sub(marker.chars().count());
        let head = keep * 3 / 10;
        let tail = keep - head;
        Ok(Some(format!(
            "{}{}{}",
            self.indexed_text_range(reference, &index, 0, head)?,
            marker,
            self.indexed_text_range(reference, &index, index.chars - tail, index.chars)?
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn indexed_original_unicode_ranges_exclude_provider_reasoning_and_large_tool_data() {
        let root = std::env::temp_dir().join(format!("varin-text-index-{}", uuid::Uuid::new_v4()));
        let store = ContentStore::open(root.clone()).unwrap();
        let text = "中文🧪\\\"\n".repeat(30000);
        let payload = serde_json::json!({"format":"conversation","content":{"content":{"kind":"output","output":{"data":{"private":"private".repeat(100000)},"parts":[{"kind":"text","text":text},{"kind":"media","media":{"content_ref":{"content_object":"not-read"}}},{"kind":"text","text":"last message"}]}}},"provider":{"reasoning":"PRIVATE"}});
        let reference = store
            .index_history_text(store.save(&payload).unwrap(), &payload)
            .unwrap();
        let original = format!("{text}\nlast message");
        // Corrupt a same-size, entirely unselected data chunk. A reader that loads
        // the provider/tool body before filtering would fail its content hash check.
        let manifest: Manifest = serde_json::from_slice(
            &store
                .read_bytes(reference["content_object"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        let unselected = object_path(&store.root, &manifest.chunks[0]).unwrap();
        let size = fs::metadata(&unselected).unwrap().len() as usize;
        fs::write(unselected, vec![b'!'; size]).unwrap();
        assert_eq!(
            store
                .history_text_preview(&reference, 2000)
                .unwrap()
                .unwrap(),
            crate::catalog::delegation_model::preview(&original, 2000)
        );
        let data = serde_json::json!({"format":"conversation","content":{"content":{"kind":"tool_call","call":{"arguments":text}}},"provider":null});
        let reference = store
            .index_history_text(store.save(&data).unwrap(), &data)
            .unwrap();
        assert_eq!(
            store.history_text_preview(&reference, 2000).unwrap(),
            Some(String::new())
        );
        drop(store);
        let _ = fs::remove_dir_all(root);
    }
}
