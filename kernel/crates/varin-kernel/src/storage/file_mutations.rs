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
    pub source_format: Option<crate::text::Format>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_format: Option<crate::text::TargetFormat>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_format: Option<crate::text::Format>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_format: Option<crate::text::TargetFormat>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub(crate) enum TextMutation {
    Write(FileWriteArgs),
    Edit(FileEditArgs),
}
impl TextMutation {
    pub(crate) fn source_format(&self)->Option<&crate::text::Format>{match self{Self::Write(a)=>a.source_format.as_ref(),Self::Edit(a)=>a.source_format.as_ref()}}
    pub(crate) fn target_format(&self)->Option<&crate::text::TargetFormat>{match self{Self::Write(a)=>a.target_format.as_ref(),Self::Edit(a)=>a.target_format.as_ref()}}
    pub(crate) fn raw_read_version(&self)->&str{read_basis(self.read_version()).0}
    pub(crate) fn read_encoding(&self)->Option<&str>{read_basis(self.read_version()).1}
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
/// Versioned interpretation envelope around the unchanged raw-state CAS digest.
/// Old raw receipts stay valid; only this exact prefix has text-basis semantics.
pub(crate) fn text_read_version(raw:&str,encoding:&str)->String{format!("text-v1:{encoding}:{raw}")}
pub(crate) fn read_basis(version:&str)->(&str,Option<&str>){
    if let Some(body)=version.strip_prefix("text-v1:"){if let Some((encoding,raw))=body.split_once(':'){if !raw.is_empty()&&crate::text::codec(encoding).is_ok(){return(raw,Some(encoding));}}}
    (version,None)
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
/// Exact matches keep their original byte provenance. LF-only model edits may
/// fall back to the normalized baseline without rewriting untouched EOLs.
pub(super) fn located_edits(text:&str,edits:&[TextEdit])->Result<(String,Vec<crate::text::Edit>,bool),KernelError>{
    let normalize=|s:&str|s.replace("\r\n","\n").replace('\r',"\n");
    let eol=text.char_indices().find(|(_,c)|*c=='\r'||*c=='\n').map(|(i,c)|if c=='\r'&&text[i..].starts_with("\r\n"){"\r\n"}else if c=='\r'{"\r"}else{"\n"}).unwrap_or("\n");
    let exact=edits.iter().map(|e|TextEdit{old_text:e.old_text.clone(),new_text:normalize(&e.new_text).replace('\n',eol)}).collect::<Vec<_>>();
    let (baseline,edits,result,normalized)=match edit_original(text,&exact){
        Ok(result)=>(text.to_owned(),exact,result,false),
        Err(original)=>{let baseline=normalize(text);let edits=edits.iter().map(|e|TextEdit{old_text:normalize(&e.old_text),new_text:normalize(&e.new_text)}).collect::<Vec<_>>();let result=edit_original(&baseline,&edits).map_err(|_|original)?;(baseline,edits,result,true)}
    };
    let ranges=edits.iter().map(|edit|{let start=baseline.find(&edit.old_text).expect("validated exact edit");crate::text::Edit{start:baseline[..start].encode_utf16().count(),end:baseline[..start+edit.old_text.len()].encode_utf16().count(),text:edit.new_text.clone()}}).collect();
    Ok((result,ranges,normalized))
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
            object.remove("__textReceipt");
            object.remove("__textBranchId");
            object.remove("__textBranchPath");
        }
        if let Some(format)=receipt.get("__textFormat").cloned(){if let (Some(raw),Some(encoding))=(receipt["readVersion"].as_str(),format["encoding"].as_str()){receipt["readVersion"]=json!(text_read_version(raw,encoding));}receipt["format"]=format;receipt.as_object_mut().unwrap().remove("__textFormat");}
        receipt.as_object_mut().unwrap().remove("__textSourceFormat");
        if let Some(conversion)=receipt.as_object_mut().unwrap().remove("__textConversion"){receipt["textConversion"]=conversion;}
        receipt.as_object_mut().unwrap().retain(|key,_|!key.starts_with("__"));
        receipt["path"] = json!(path);
        Ok(receipt)
    }
}
