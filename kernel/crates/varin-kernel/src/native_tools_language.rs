//! Native language tools release file admission before waiting for the shared Host language view.
use super::*;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct LanguageQueryArgs {
    pub path: String,
    line: Option<u32>,
    character: Option<u32>,
    #[serde(skip)]
    method: String,
}
impl LanguageQueryArgs {
    pub fn parse(kind: NativeToolKind, value: &Value) -> Result<Self, ExecutionError> {
        let mut args: Self = serde_json::from_value(value.clone()).map_err(|error| ExecutionError::new("invalid_tool_arguments", error.to_string()))?;
        normalized_path(&args.path, false)?;
        args.method = match kind { NativeToolKind::LanguageDefinition => "definition", NativeToolKind::LanguageReferences => "references", _ => "diagnostics" }.into();
        if (args.method == "diagnostics" && (args.line.is_some() || args.character.is_some()))
            || (args.method != "diagnostics" && (args.line.is_none() || args.character.is_none())) {
            return Err(ExecutionError::new("invalid_tool_arguments", "Navigation requires zero-based UTF-16 line and character; diagnostics accepts only path"));
        }
        Ok(args)
    }
}
pub(super) fn schema(kind: NativeToolKind) -> Value {
    let navigation = kind != NativeToolKind::LanguageDiagnostics;
    let mut properties = json!({"path":{"type":"string","description":"Normalized path relative to the selected live workspace."}});
    if navigation {
        for key in ["line", "character"] { properties[key] = json!({"type":"integer","minimum":0,"maximum":4294967295u64,"description":"Zero-based UTF-16 position."}); }
    }
    json!({"type":"object","additionalProperties":false,"properties":properties,
        "required":if navigation { vec!["path","line","character"] } else { vec!["path"] }})
}
#[derive(Clone)]
pub(super) struct Observation { pub(super) revision: String, pub(super) text: String }
fn observation(value: Value) -> Result<Observation, ExecutionError> {
    let bytes = if let Some(text) = value["content"]["text"].as_str() { text.as_bytes().to_vec() }
        else if let Some(encoded) = value["content"]["bytesBase64"].as_str() {
            BASE64.decode(encoded).map_err(|_| ExecutionError::new("language_source_unavailable", "Invalid source bytes"))?
        } else { return Err(ExecutionError::new("language_source_unavailable", "Language target is not a regular readable file")); };
    let revision = format!("d1_{}", URL_SAFE_NO_PAD.encode(Sha256::digest(&bytes)));
    // Match the current Documents encoding contract: UTF-8 (optional BOM), no binary NUL.
    // UTF-16 is reported unavailable rather than inventing another language text decoder.
    let payload = bytes.strip_prefix(&[0xef,0xbb,0xbf]).unwrap_or(&bytes);
    if payload.iter().take(4096).any(|byte| *byte == 0) {
        return Err(ExecutionError::new("language_source_unavailable", "Language target is binary"));
    }
    let text = std::str::from_utf8(payload).map_err(|_| ExecutionError::new("language_source_unavailable", "Unsupported source encoding"))?.to_owned();
    Ok(Observation { revision, text })
}
fn position(value: &Value, text: &str) -> Option<(u64,u64)> {
    let line = value["line"].as_u64()?;
    let character = value["character"].as_u64()?;
    let row = text.split('\n').nth(usize::try_from(line).ok()?)?;
    let row = row.strip_suffix('\r').unwrap_or(row);
    (character <= row.encode_utf16().count() as u64).then_some((line,character))
}
fn valid_range(value: &Value, text: &str) -> bool {
    match (position(&value["start"], text),position(&value["end"], text)) { (Some(a),Some(b)) => a <= b, _ => false }
}
fn bump(result: &mut Value, key: &str) {
    let count = result["omissions"][key].as_u64().unwrap_or(0);
    result["omissions"][key] = json!(count + 1);
}
impl NativeToolExecutor {
    pub(super) fn admit_language_path(&self, context: &ToolExecutionContext, path: &str, cancel: &CancellationToken) -> Result<String, ExecutionError> {
        normalized_path(path, false)?;
        let operation = ResourceOperation::FileRead(FileReadArgs { path: path.into(), offset: 0, length: None });
        let value = self.resources.call(&self.binding, context, operation, true, cancel)
            .map_err(|failure| ExecutionError::new(error_code(&failure.error), failure.error.to_string()))?;
        value["resourceKey"].as_str().map(str::to_owned).ok_or_else(|| ExecutionError::new("language_resource_invalid", "Missing canonical resource identity"))
    }
    pub(super) fn observe_language_path(&self, context: &ToolExecutionContext, path: &str, cancel: &CancellationToken) -> Result<Observation, ExecutionError> {
        let key = self.admit_language_path(context, path, cancel)?;
        let value = self.resources.call_checked(&self.binding, context,
            ResourceOperation::FileRead(FileReadArgs { path: path.into(), offset: 0, length: None }), false, Some(key), cancel)
            .map_err(|failure| ExecutionError::new(error_code(&failure.error), failure.error.to_string()))?;
        observation(value)
    }
    pub(super) fn execute_language(&self, context: &ToolExecutionContext, args: &LanguageQueryArgs, cancel: &CancellationToken) -> ToolCompletion {
        let result = self.language_query(context, args, cancel);
        match result {
            Ok(content) => ToolCompletion::Result { outcome: Outcome::Succeeded, effect: Effect::None, content },
            Err(error) => ToolCompletion::Result { outcome: if cancel.is_cancelled() { Outcome::Cancelled } else { Outcome::Failed }, effect: Effect::None,
                content: json!({"status":if cancel.is_cancelled() {"cancelled"} else {"unavailable"},"error":error.code,"message":error.message}) },
        }
    }
    fn language_query(&self, context: &ToolExecutionContext, args: &LanguageQueryArgs, cancel: &CancellationToken) -> Result<Value, ExecutionError> {
        self.admit_language_path(context, &args.path, cancel)?;
        let bridge = self.language.as_ref().ok_or_else(|| ExecutionError::new("language_owner_unavailable", "Language owner is not connected"))?;
        let mut query = json!({"runId":self.binding.run_id,"threadId":self.binding.thread_id,
            "workspaceId":self.binding.workspace_id,"executionWorkspaceId":self.binding.execution_workspace_id,
            "liveRoot":self.binding.live_root,"method":args.method,"path":args.path});
        if let Some(line) = args.line { query["line"] = json!(line); }
        if let Some(character) = args.character { query["character"] = json!(character); }
        let raw = bridge.query(query, cancel)?;
        let mut result = json!({"status":raw["status"],"items":raw["items"],"omissions":raw["omissions"]});
        let unversioned = args.method == "diagnostics" && raw["status"] == "pending" && raw["diagnosticVerification"] == "unversioned";
        if unversioned { result["diagnosticVerification"] = json!("unversioned"); }
        if let Some(message) = raw["message"].as_str() { result["message"] = json!(message); }
        if let Some(source) = raw["source"].as_object() {
            result["source"] = Value::Object(source.iter().filter(|(key,_)| ["mode","workspaceId","executionWorkspaceId","liveRoot","resourceId","revision","view","documentVersion","generation","providerId","dependencies"].contains(&key.as_str())).map(|(key,value)|(key.clone(),value.clone())).collect());
        }
        if !matches!(result["status"].as_str(), Some("ready" | "partial" | "pending" | "unsupported" | "unavailable" | "stale" | "cancelled"))
            || !result["items"].is_array() || !result["omissions"].is_object()
            || ["outOfScope", "unmappable", "stale", "unavailable"].iter().any(|key| result["omissions"][key].as_u64().is_none()) {
            return Err(ExecutionError::new("language_result_invalid", "Language owner returned an invalid result"));
        }
        // Only the four counter fields are part of the language result contract.
        result["omissions"] = json!({"outOfScope":result["omissions"]["outOfScope"],
            "unmappable":result["omissions"]["unmappable"],"stale":result["omissions"]["stale"],
            "unavailable":result["omissions"]["unavailable"]});
        // Recheck actual source and authority after the service wait. No read lease spans LSP.
        let source = self.observe_language_path(context, &args.path, cancel)?;
        if result.get("source").is_some() || unversioned || matches!(result["status"].as_str(), Some("ready" | "partial")) {
            let provenance = &result["source"];
            if provenance["revision"].as_str().is_none_or(str::is_empty)
                || provenance["mode"] != "live_root" || provenance["dependencies"] != "live"
                || provenance["workspaceId"].as_str() != Some(&self.binding.workspace_id)
                || provenance["executionWorkspaceId"].as_str() != Some(&self.binding.execution_workspace_id)
                || provenance["resourceId"].as_str() != Some(&args.path)
                || provenance["liveRoot"] != json!(self.binding.live_root)
                || provenance["view"] != "agent" || provenance["documentVersion"].as_u64().is_none()
                || provenance["generation"].as_u64().is_none()
                || provenance.get("providerId").is_some_and(|value| !value.is_string()) {
                return Err(ExecutionError::new("language_result_invalid", "Language result omitted or changed its bound source provenance"));
            }
        }
        if let Some(revision) = result["source"]["revision"].as_str() {
            if revision != source.revision {
                result["status"] = json!("stale"); result["items"] = json!([]);
                result["message"] = json!("The queried source changed while the language server was answering");
                return Ok(result);
            }
        }
        if !unversioned && !matches!(result["status"].as_str(), Some("ready" | "partial")) { result["items"] = json!([]); return Ok(result); }
        let items = result.get_mut("items").and_then(Value::as_array_mut).map(std::mem::take)
            .ok_or_else(|| ExecutionError::new("language_result_invalid", "Language result omitted its items"))?;
        let mut observations = BTreeMap::from([(args.path.clone(), source.clone())]);
        let mut admitted = Vec::new();
        for mut item in items {
            if !item.is_object() { bump(&mut result, "unmappable"); continue; }
            if cancel.is_cancelled() { return Err(ExecutionError::new("language_cancelled", "Language query cancelled")); }
            let Some(path) = item["resource"]["resourceId"].as_str().map(str::to_owned) else { bump(&mut result,"unmappable"); continue; };
            if item["resource"]["workspaceId"].as_str() != Some(&self.binding.workspace_id) || normalized_path(&path,false).is_err() { bump(&mut result,"outOfScope"); continue; }
            let observed = match observations.get(&path) {
                Some(observed) => observed.clone(),
                None => match self.observe_language_path(context, &path, cancel) {
                    Ok(observed) => { observations.insert(path.clone(), observed.clone()); observed },
                    Err(error) => { if cancel.is_cancelled() { return Err(error); } bump(&mut result, if error.code == "unauthorized" { "outOfScope" } else { "unavailable" }); continue; }
                },
            };
            let ranges: Vec<_> = ["range","targetRange","targetSelectionRange"].into_iter().filter_map(|key| item.get(key)).collect();
            if ranges.is_empty() || ranges.iter().any(|range| !valid_range(range,&observed.text))
                || item.get("originSelectionRange").is_some_and(|range| !valid_range(range,&source.text)) {
                bump(&mut result,"stale"); continue;
            }
            let allowed = ["resource","range","targetRange","targetSelectionRange","originSelectionRange","severity","message","code","source","tags","providerId","generation","documentVersion"];
            item.as_object_mut().expect("checked item object").retain(|key,_| allowed.contains(&key.as_str()));
            item["resource"] = json!({"workspaceId":self.binding.workspace_id,"resourceId":path});
            item["observedRevision"] = json!(observed.revision);
            // An LSP cross-file Location carries no target document version. An observation
            // made after its response is not proof of which bytes produced its range.
            item["rangeRevision"] = if path == args.path && !unversioned { json!(source.revision) } else { Value::Null };
            admitted.push(item);
        }
        result["items"] = json!(admitted);
        if !unversioned && result["omissions"].as_object().is_some_and(|counts| counts.values().any(|count| count.as_u64().unwrap_or(0)>0)) { result["status"] = json!("partial"); }
        Ok(result)
    }
}
