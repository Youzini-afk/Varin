//! Native text tools adapt the existing leased, conditional file.apply journal.
//! Read versions are scoped digests of the existing FileState receipt, not a
//! second document authority. No model argument supplies a root, grant or owner.
use super::file_resources::FileState;
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeFileWriteArgs {
    pub path: String,
    pub read_version: String,
    pub content: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeTextEdit {
    pub old_text: String,
    pub new_text: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeFileEditArgs {
    pub path: String,
    pub read_version: String,
    pub edits: Vec<NativeTextEdit>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub(crate) enum NativeTextMutation {
    Write(NativeFileWriteArgs),
    Edit(NativeFileEditArgs),
}
impl NativeTextMutation {
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
pub(super) fn read_version(
    grant: &Grant,
    root_id: &str,
    path: &str,
    state: &FileState,
) -> Result<String, KernelError> {
    hash_json(&json!([
        "native-file-state-v1",
        grant.grant_id,
        root_id,
        path,
        state
    ]))
}
fn edit_original(text: &str, edits: &[NativeTextEdit]) -> Result<String, KernelError> {
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
fn edit_preserving_line_endings(
    text: &str,
    edits: &[NativeTextEdit],
) -> Result<String, KernelError> {
    match edit_original(text, edits) {
        Ok(value) => Ok(value),
        Err(original_error) => {
            let normalize = |value: &str| value.replace("\r\n", "\n").replace('\r', "\n");
            let normalized_edits = edits
                .iter()
                .map(|edit| NativeTextEdit {
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
    pub(crate) fn native_file_mutate(
        &mut self,
        workspace_id: &str,
        root_id: &str,
        operation_id: &str,
        mutation: &NativeTextMutation,
        grant: &Grant,
        execute: bool,
        dispatched: &mut bool,
    ) -> Result<Value, KernelError> {
        let resource = self.resolve_file_resource(root_id, mutation.path(), grant, false)?;
        self.assert_file_lease(
            grant,
            root_id,
            &[FileLeaseResource {
                path: resource.path.clone(),
                subtree: false,
            }],
            None,
        )?;
        self.check_cancelled()?;
        if mutation.read_version().is_empty() {
            return Err(KernelError::Operation("readVersion is required".into()));
        }
        if !execute {
            return Ok(Value::Null);
        }
        let request_hash = hash_json(&json!([
            "native-text-mutation-v1",
            grant.grant_id,
            workspace_id,
            root_id,
            operation_id,
            mutation
        ]))?;
        let prior = self.operation_get(&json!({"operationId":operation_id}))?;
        if !prior.is_null() {
            if prior["kind"] != "file.apply" {
                return Err(KernelError::Operation(
                    "native mutation operation identity is already in use".into(),
                ));
            }
            let receipt = &prior["result"];
            let stored = receipt["__nativeRequestHash"]
                .as_str()
                .or_else(|| receipt["intent"]["__nativeRequestHash"].as_str());
            if stored != Some(request_hash.as_str()) {
                return Err(KernelError::Operation(
                    "native mutation operation identity was reused with different arguments".into(),
                ));
            }
            if prior["state"] == "committed" {
                return self.native_mutation_receipt(
                    receipt.clone(),
                    grant,
                    root_id,
                    &resource.path,
                );
            }
            // Existing file.apply intents retain the exact expected/target states
            // and object owner. Reuse them, never calculate an edit a second time.
            if prior["state"] == "started" {
                let intent = receipt["intent"].clone();
                *dispatched = true;
                let result = self.file_apply(&intent, grant)?;
                return self.native_mutation_receipt(result, grant, root_id, &resource.path);
            }
            return Err(KernelError::Operation(
                "native mutation journal state cannot be replayed".into(),
            ));
        }
        let lease_id = format!("native-write:{}", Uuid::new_v4());
        let lease = self.file_lease_acquire(
            &json!({"workspaceId":workspace_id,"rootId":root_id,"leaseId":lease_id,
            "resources":[{"path":resource.path,"scope":"exact"}]}),
            grant,
        )?;
        if lease["status"] != "acquired" {
            return Err(KernelError::Operation("file resource is busy".into()));
        }
        let result = (|| {
            let (expected, _) = self.capture_file_state(
                &resource,
                false,
                "observe",
                workspace_id,
                &grant.grant_id,
            )?;
            let current_version = read_version(grant, root_id, &resource.path, &expected)?;
            if current_version != mutation.read_version() {
                return Ok(
                    json!({"path":resource.path,"status":"conflict","readVersion":current_version}),
                );
            }
            let mode = match &expected {
                FileState::Missing => None,
                FileState::RegularFile { mode, .. } => *mode,
                _ => {
                    return Err(KernelError::Operation(
                        "text mutation requires a regular file or a missing write target".into(),
                    ))
                }
            };
            let previous_text = if matches!(expected, FileState::RegularFile { .. }) {
                let observed = self.native_file_read(
                    &json!({"rootId":root_id,"path":resource.path,"offset":0,"leaseId":lease_id}),
                    grant,
                    true,
                )?;
                if observed["readVersion"].as_str() != Some(current_version.as_str()) {
                    return Ok(json!({"path":resource.path,"status":"conflict"}));
                }
                let text = observed["content"]["text"].as_str().ok_or_else(|| {
                    KernelError::Operation("text mutation requires UTF-8 content".into())
                })?;
                if text.contains('\0') {
                    return Err(KernelError::Operation(
                        "text mutation cannot overwrite binary content".into(),
                    ));
                }
                Some(text.to_string())
            } else {
                None
            };
            let content = match mutation {
                NativeTextMutation::Write(args) => {
                    if previous_text
                        .as_ref()
                        .is_some_and(|text| text.starts_with('\u{feff}'))
                        && !args.content.starts_with('\u{feff}')
                    {
                        format!("\u{feff}{}", args.content)
                    } else {
                        args.content.clone()
                    }
                }
                NativeTextMutation::Edit(args) => {
                    let text = previous_text.as_deref().ok_or_else(|| {
                        KernelError::Operation("cannot edit a missing file".into())
                    })?;
                    edit_preserving_line_endings(text, &args.edits)?
                }
            };
            if content.contains('\0') {
                return Err(KernelError::Operation(
                    "text mutation content must not contain NUL bytes".into(),
                ));
            }
            self.check_cancelled()?;
            let stream_id = format!("native-text-{}", Uuid::new_v4());
            let upload = json!({"workspaceId":workspace_id,"operationId":format!("native-text-content:{operation_id}"),"streamId":stream_id,"byteLength":content.len()});
            self.begin_blob_stream(&upload, &grant.grant_id)?;
            let stored = (|| {
                for (sequence, bytes) in content.as_bytes().chunks(65536).enumerate() {
                    self.stream_blob_bytes(&stream_id, sequence as u64, bytes, &grant.grant_id)?;
                }
                self.finish_blob_stream(&upload, &grant.grant_id)
            })();
            let stored = match stored {
                Ok(value) => value,
                Err(error) => {
                    let _ = self.abort_blob_stream(&upload, &grant.grant_id);
                    return Err(error);
                }
            };
            let owner = stored["ownerId"].as_str().ok_or_else(|| {
                KernelError::Storage("native content upload omitted owner".into())
            })?;
            let target = FileState::RegularFile {
                object_hash: stored["hash"]
                    .as_str()
                    .ok_or_else(|| {
                        KernelError::Storage("native content upload omitted hash".into())
                    })?
                    .into(),
                byte_length: content.len() as u64,
                mode,
            };
            let params = json!({"workspaceId":workspace_id,"operationId":operation_id,"rootId":root_id,"path":resource.path,
                "leaseId":lease_id,"targetJson":serde_json::to_string(&target)?,"expectedJson":serde_json::to_string(&expected)?,
                "ownerId":owner,"__nativeRequestHash":request_hash,"__nativeGrantId":grant.grant_id,"__nativeEpoch":grant.kernel_epoch});
            if let Err(error) = self.check_cancelled() {
                let _ = self.release_object_owner(
                    &json!({"ownerId":owner}),
                    Some(workspace_id),
                    &grant.grant_id,
                );
                return Err(error);
            }
            *dispatched = true;
            let applied = self.file_apply(&params, grant);
            if applied.is_err()
                && self
                    .operation_get(&json!({"operationId":operation_id}))?
                    .is_null()
            {
                let _ = self.release_object_owner(
                    &json!({"ownerId":owner}),
                    Some(workspace_id),
                    &grant.grant_id,
                );
            }
            self.native_mutation_receipt(applied?, grant, root_id, &resource.path)
        })();
        let released = self.file_lease_release(
            &json!({"workspaceId":workspace_id,"rootId":root_id,"leaseId":lease_id}),
            grant,
        );
        match (result, released) {
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Ok(value), Ok(_)) => Ok(value),
        }
    }
    fn native_mutation_receipt(
        &self,
        mut receipt: Value,
        grant: &Grant,
        root_id: &str,
        path: &str,
    ) -> Result<Value, KernelError> {
        if let Some(state) = receipt["stateJson"].as_str() {
            let state: FileState = serde_json::from_str(state)?;
            receipt["readVersion"] = json!(read_version(grant, root_id, path, &state)?);
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
