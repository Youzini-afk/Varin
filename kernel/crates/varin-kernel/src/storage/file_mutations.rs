//! Text tools adapt the existing leased, conditional file.apply journal.
//! Read versions are scoped digests of the existing FileState receipt, not a
//! second document authority. No model argument supplies a root, grant or owner.
use super::file_resources::FileState;
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FileWriteMode { Create, Replace }

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileWriteArgs {
    pub path: String,
    #[serde(default)]
    pub read_version: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<FileWriteMode>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextEdit {
    pub old_text: String,
    pub new_text: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileEditArgs {
    pub path: String,
    pub read_version: String,
    pub edits: Vec<TextEdit>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub(crate) enum TextMutation {
    Write(FileWriteArgs),
    Edit(FileEditArgs),
}
impl TextMutation {
    pub(crate) fn path(&self) -> &str {
        match self {
            Self::Write(args) => &args.path,
            Self::Edit(args) => &args.path,
        }
    }
    pub(crate) fn read_version(&self) -> &str {
        match self {
            Self::Write(args) => &args.read_version,
            Self::Edit(args) => &args.read_version,
        }
    }
}
pub(crate) fn read_version(
    root_id: &str,
    path: &str,
    state: &FileState,
) -> Result<String, KernelError> {
    hash_json(&json!([
        "file-state-v2",
        root_id,
        path,
        state
    ]))
}
pub(crate) fn fixed_read_namespace(workspace: &str, source: &crate::tools::FixedFileSource) -> String {
    format!("fixed:{workspace}:{}@{}",source.branch_id,source.revision)
}
fn edit_original(text: &str, edits: &[TextEdit]) -> Result<String, KernelError> {
    if edits.is_empty() {
        return Err(KernelError::Operation(
            "edit requires at least one replacement".into(),
        ));
    }
    let mut matches = Vec::with_capacity(edits.len());
    for edit in edits {
        if edit.old_text.is_empty() {
            return Err(KernelError::Operation(
                "Edit oldText must not be empty".into(),
            ));
        }
        let start = text.find(&edit.old_text).ok_or_else(|| {
            KernelError::Operation("Could not find the exact text to replace".into())
        })?;
        // Advancing one Unicode scalar also detects overlapping matches (aaa/aa),
        // while retaining valid UTF-8 boundaries for non-ASCII text.
        let next = start
            + text[start..]
                .chars()
                .next()
                .expect("nonempty match")
                .len_utf8();
        if text[next..].contains(&edit.old_text) {
            return Err(KernelError::Operation(
                "Edit oldText matched more than once; make the text unique".into(),
            ));
        }
        matches.push((start, start + edit.old_text.len(), edit.new_text.as_str()));
    }
    matches.sort_by_key(|entry| entry.0);
    let mut result = String::new();
    let mut cursor = 0;
    for (start, end, replacement) in matches {
        if start < cursor {
            return Err(KernelError::Operation(
                "Edit matches overlap; combine them into one replacement".into(),
            ));
        }
        result.push_str(&text[cursor..start]);
        result.push_str(replacement);
        cursor = end;
    }
    result.push_str(&text[cursor..]);
    Ok(result)
}
pub(super) fn edit_preserving_line_endings(text: &str, edits: &[TextEdit]) -> Result<String, KernelError> {
    match edit_original(text, edits) {
        Ok(value) => Ok(value),
        Err(original_error) => {
            let normalize = |value: &str| value.replace("\r\n", "\n").replace('\r', "\n");
            let normalized_edits = edits
                .iter()
                .map(|edit| TextEdit {
                    old_text: normalize(&edit.old_text),
                    new_text: normalize(&edit.new_text),
                })
                .collect::<Vec<_>>();
            match edit_original(&normalize(text), &normalized_edits) {
                Ok(value) => {
                    let value = normalize(&value);
                    Ok(if text.contains("\r\n") {
                        value.replace('\n', "\r\n")
                    } else if text.contains('\r') {
                        value.replace('\n', "\r")
                    } else {
                        value
                    })
                }
                Err(_) => Err(original_error),
            }
        }
    }
}
impl Storage {
    #[cfg(test)]
    pub(crate) fn file_mutate(
        &mut self,
        workspace_id: &str,
        root_id: &str,
        operation_id: &str,
        mutation: &TextMutation,
        grant: &Grant,
        journal: Option<&varin_runtime::catalog::journal::JournalAnchor>,
        source_mode: varin_runtime::SourceMode,
        execute: bool,
        dispatched: &mut bool,
        baseline: Option<&crate::tools::FixedFileSource>,
    ) -> Result<Value, KernelError> {
        let task = self.prepare_text_mutation(workspace_id, root_id, operation_id, mutation, grant,
            journal, source_mode, baseline, self.cancellation.clone().unwrap_or_else(||Arc::new(AtomicBool::new(false))))?;
        if !execute { return Ok(Value::Null); }
        task.run_local(self, dispatched)
    }
    pub(super) fn mutation_receipt(
        &self,
        mut receipt: Value,
        root_id: &str,
        path: &str,
    ) -> Result<Value, KernelError> {
        if let Some(state) = receipt["stateJson"].as_str() {
            let state: FileState = serde_json::from_str(state)?;
            receipt["readVersion"] = json!(read_version(root_id, path, &state)?);
            receipt["state"] = serde_json::to_value(state)?;
            receipt.as_object_mut().unwrap().remove("stateJson");
        }
        if let Some(object) = receipt.as_object_mut() {
            object.remove("__nativeRequestHash");
            object.remove("__nativeGrantId");
            object.remove("__nativeEpoch");
        }
        receipt["path"] = json!(path);
        Ok(receipt)
    }
}
