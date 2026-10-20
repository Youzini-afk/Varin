//! Language tools release file admission before waiting for the shared Host language view.
use super::*;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CallDirection {
    Incoming,
    Outgoing,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct LanguageQueryArgs {
    pub path: String,
    line: Option<u32>,
    character: Option<u32>,
    query: Option<String>,
    direction: Option<CallDirection>,
    #[serde(skip)]
    method: String,
    #[serde(skip)]
    pub(super) derived_view: Option<Value>,
}
impl LanguageQueryArgs {
    pub(super) fn source_descriptor(path:String,derived_view:Option<Value>)->Self{Self{path,derived_view,line:None,character:None,query:None,direction:None,method:String::new()}}
    pub fn parse(kind: ToolKind, value: &Value) -> Result<Self, ExecutionError> {
        let mut args: Self = serde_json::from_value(value.clone())
            .map_err(|error| ExecutionError::new("invalid_tool_arguments", error.to_string()))?;
        normalized_path(&args.path, false)?;
        args.method = match kind {
            ToolKind::LanguageDefinition => "definition",
            ToolKind::LanguageReferences => "references",
            ToolKind::LanguageDiagnostics => "diagnostics",
            ToolKind::LanguageHover => "hover",
            ToolKind::LanguageSymbols => "workspace_symbols",
            ToolKind::LanguageDocumentSymbols => "document_symbols",
            ToolKind::LanguageCallHierarchy => "call_hierarchy",
            _ => unreachable!("language tool decoder"),
        }
        .into();
        let position = matches!(
            kind,
            ToolKind::LanguageDefinition
                | ToolKind::LanguageReferences
                | ToolKind::LanguageHover
                | ToolKind::LanguageCallHierarchy
        );
        if (position && (args.line.is_none() || args.character.is_none()))
            || (!position && (args.line.is_some() || args.character.is_some()))
            || (kind == ToolKind::LanguageSymbols) != args.query.is_some()
            || (kind == ToolKind::LanguageCallHierarchy) != args.direction.is_some()
        {
            return Err(ExecutionError::new("invalid_tool_arguments",
                "Use the selected language tool schema: navigation requires zero-based UTF-16 line/character, symbols requires query, and call hierarchy requires direction"));
        }
        Ok(args)
    }
}
pub(super) fn schema(kind: ToolKind) -> Value {
    let navigation = matches!(
        kind,
        ToolKind::LanguageDefinition
            | ToolKind::LanguageReferences
            | ToolKind::LanguageHover
            | ToolKind::LanguageCallHierarchy
    );
    let mut properties = json!({"path":{"type":"string","description":"Normalized path relative to the selected source workspace. Select an existing representative source file for workspace symbols."}});
    let mut required = vec!["path"];
    if navigation {
        for key in ["line", "character"] {
            properties[key] = json!({"type":"integer","minimum":0,"maximum":4294967295u64,"description":"Zero-based UTF-16 position."});
            required.push(key);
        }
    }
    if kind == ToolKind::LanguageSymbols {
        properties["query"] = json!({"type":"string","description":"Symbol name or name fragment in this language's workspace."});
        required.push("query");
    }
    if kind == ToolKind::LanguageCallHierarchy {
        properties["direction"] = json!({"type":"string","enum":["incoming","outgoing"]});
        required.push("direction");
    }
    json!({"type":"object","additionalProperties":false,"properties":properties,"required":required})
}

#[derive(Clone)]
pub(super) struct Observation {
    pub(super) revision: String,
    pub(super) text: String,
}
fn observation_bytes(value: &Value) -> Result<Vec<u8>, ExecutionError> {
    let bytes = if let Some(text) = value["content"]["text"].as_str() {
        text.as_bytes().to_vec()
    } else if let Some(encoded) = value["content"]["bytesBase64"].as_str() {
        BASE64.decode(encoded).map_err(|_| {
            ExecutionError::new("language_source_unavailable", "Invalid source bytes")
        })?
    } else {
        return Err(ExecutionError::new(
            "language_source_unavailable",
            "Language target is not a regular readable file",
        ));
    };
    Ok(bytes)
}
fn observation(value: Value) -> Result<Observation, ExecutionError> {
    observe_bytes(observation_bytes(&value)?)
}
fn observe_bytes(bytes: Vec<u8>) -> Result<Observation, ExecutionError> {
    let revision = format!("d1_{}", URL_SAFE_NO_PAD.encode(Sha256::digest(&bytes)));
    // Match the current Documents encoding contract: UTF-8 (optional BOM), no binary NUL.
    // UTF-16 is reported unavailable rather than inventing another language text decoder.
    let payload = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    if payload.iter().take(4096).any(|byte| *byte == 0) {
        return Err(ExecutionError::new(
            "language_source_unavailable",
            "Language target is binary",
        ));
    }
    let text = std::str::from_utf8(payload)
        .map_err(|_| {
            ExecutionError::new("language_source_unavailable", "Unsupported source encoding")
        })?
        .to_owned();
    Ok(Observation { revision, text })
}
fn position(value: &Value, text: &str) -> Option<(u64, u64)> {
    let line = value["line"].as_u64()?;
    let character = value["character"].as_u64()?;
    let row = text.split('\n').nth(usize::try_from(line).ok()?)?;
    let row = row.strip_suffix('\r').unwrap_or(row);
    // LSP Position normalizes an output column beyond EOL to that line's end.
    // Model-supplied query positions retain their separate strict input validation.
    Some((line, character.min(row.encode_utf16().count() as u64)))
}
fn normalized_range(value: &Value, text: &str) -> Option<Value> {
    let original_start = (
        value["start"]["line"].as_u64()?,
        value["start"]["character"].as_u64()?,
    );
    let original_end = (
        value["end"]["line"].as_u64()?,
        value["end"]["character"].as_u64()?,
    );
    if original_start > original_end {
        return None;
    }
    let start = position(&value["start"], text)?;
    let end = position(&value["end"], text)?;
    (start <= end).then(|| {
        json!({"start":{"line":start.0,"character":start.1},
        "end":{"line":end.0,"character":end.1}})
    })
}

fn bump(result: &mut Value, key: &str) {
    let count = result["omissions"][key].as_u64().unwrap_or(0);
    result["omissions"][key] = json!(count + 1);
}
impl KernelToolExecutor {
    pub(super) fn admit_language_path(
        &self,
        context: &ToolExecutionContext,
        path: &str,
        cancel: &CancellationToken,
    ) -> Result<String, ExecutionError> {
        normalized_path(path, false)?;
        let operation = ResourceOperation::FileRead(FileReadArgs {
            path: path.into(),
            offset: 0,
            length: None,
        });
        let value = self
            .resources
            .call(&self.binding, context, operation, true, cancel)
            .map_err(|failure| {
                ExecutionError::new(error_code(&failure.error), failure.error.to_string())
            })?;
        if self.binding.source_mode == SourceMode::FixedBranch {
            return Ok(format!(
                "fixed-language:{}:{}",
                self.binding
                    .file_source
                    .as_ref()
                    .expect("fixed source")
                    .branch_id,
                path
            ));
        }
        value["resourceKey"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| {
                ExecutionError::new(
                    "language_resource_invalid",
                    "Missing canonical resource identity",
                )
            })
    }
    /// Fixed bytes use the existing immutable reader; they have no physical CAS identity.
    pub(super) fn observe_source_path(
        &self,
        context: &ToolExecutionContext,
        path: &str,
        cancel: &CancellationToken,
    ) -> Result<Observation, ExecutionError> {
        if self.binding.source_mode != SourceMode::FixedBranch {
            return self.observe_language_path(context, path, cancel);
        }
        let mut bytes = Vec::new();
        let mut identity: Option<(String, u64)> = None;
        loop {
            let offset = bytes.len() as u64;
            let value = self
                .resources
                .call(
                    &self.binding,
                    context,
                    ResourceOperation::FileRead(FileReadArgs {
                        path: path.into(),
                        offset,
                        length: Some(crate::protocol::MAX_BLOB_RESPONSE_BYTES as u64),
                    }),
                    false,
                    cancel,
                )
                .map_err(|failure| {
                    ExecutionError::new(error_code(&failure.error), failure.error.to_string())
                })?;
            let part = observation_bytes(&value)?;
            let content = &value["content"];
            let invalid = || {
                ExecutionError::new(
                    "language_source_unavailable",
                    "Incomplete fixed source byte continuation",
                )
            };
            let hash = content["hash"].as_str().ok_or_else(invalid)?;
            let total = content["byteLength"].as_u64().ok_or_else(invalid)?;
            let next = offset.checked_add(part.len() as u64).ok_or_else(invalid)?;
            if content["offset"].as_u64() != Some(offset)
                || content["nextOffset"].as_u64() != Some(next)
                || next > total
                || (next == offset && next < total)
                || content["eof"].as_bool() != Some(next == total)
                || identity
                    .as_ref()
                    .is_some_and(|(original_hash, original_total)| {
                        original_hash != hash || *original_total != total
                    })
            {
                return Err(invalid());
            }
            identity = Some((hash.into(), total));
            bytes.extend(part);
            if next == total {
                return observe_bytes(bytes);
            }
        }
    }
    pub(super) fn observe_language_path(
        &self,
        context: &ToolExecutionContext,
        path: &str,
        cancel: &CancellationToken,
    ) -> Result<Observation, ExecutionError> {
        let key = self.admit_language_path(context, path, cancel)?;
        let value = self
            .resources
            .call_checked(
                &self.binding,
                context,
                ResourceOperation::FileRead(FileReadArgs {
                    path: path.into(),
                    offset: 0,
                    length: None,
                }),
                false,
                Some(key),
                None,
                cancel,
            )
            .map_err(|failure| {
                ExecutionError::new(error_code(&failure.error), failure.error.to_string())
            })?;
        observation(value)
    }
    pub(super) fn execute_language(
        &self,
        context: &ToolExecutionContext,
        args: &LanguageQueryArgs,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        let result = self.language_query(context, args, cancel);
        match result {
            Ok(content) => language_completion(content),
            Err(error) => ToolCompletion::Result { outcome: if cancel.is_cancelled() { Outcome::Cancelled } else { Outcome::Failed }, effect: Effect::None,
                content: json!({"status":if cancel.is_cancelled() {"cancelled"} else {"unavailable"},"error":error.code,"message":error.message}).into() },
        }
    }
    fn language_query(
        &self,
        context: &ToolExecutionContext,
        args: &LanguageQueryArgs,
        cancel: &CancellationToken,
    ) -> Result<Value, ExecutionError> {
        self.admit_language_path(context, &args.path, cancel)?;
        let bridge = self.language.as_ref().ok_or_else(|| {
            ExecutionError::new(
                "language_owner_unavailable",
                "Language owner is not connected",
            )
        })?;
        let admitted = self
            .resources
            .call(
                &self.binding,
                context,
                ResourceOperation::LanguageQuery(args.clone()),
                true,
                cancel,
            )
            .map_err(|failure| {
                ExecutionError::new(error_code(&failure.error), failure.error.to_string())
            })?;
        let mut query = json!({"runId":self.binding.run_id,"threadId":self.binding.thread_id,
            "grantId":self.binding.grant_id,"source":admitted["source"],"physicalRoot":admitted["physicalRoot"],
            "method":args.method,"path":args.path});
        if let Some(line) = args.line {
            query["line"] = json!(line);
        }
        if let Some(character) = args.character {
            query["character"] = json!(character);
        }
        if let Some(text) = &args.query {
            query["query"] = json!(text);
        }
        if let Some(direction) = args.direction {
            query["direction"] = json!(direction);
        }
        let raw = bridge.query(query, cancel)?;
        let mut result =
            json!({"status":raw["status"],"items":raw["items"],"omissions":raw["omissions"]});
        let unversioned = args.method == "diagnostics"
            && raw["status"] == "pending"
            && raw["diagnosticVerification"] == "unversioned";
        if unversioned {
            result["diagnosticVerification"] = json!("unversioned");
        }
        if let Some(message) = raw["message"].as_str() {
            result["message"] = json!(message);
        }
        if let Some(source) = raw["source"].as_object() {
            result["source"] = Value::Object(
                source
                    .iter()
                    .filter(|(key, _)| {
                        [
                            "selection",
                            "physicalRoot",
                            "resourceId",
                            "revision",
                            "view",
                            "documentVersion",
                            "generation",
                            "providerId",
                            "dependencies",
                            "derivedView",
                        ]
                        .contains(&key.as_str())
                    })
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
            );
        }
        if !matches!(
            result["status"].as_str(),
            Some(
                "ready"
                    | "partial"
                    | "pending"
                    | "unsupported"
                    | "unavailable"
                    | "stale"
                    | "cancelled"
            )
        ) || !result["items"].is_array()
            || !result["omissions"].is_object()
            || ["outOfScope", "unmappable", "stale", "unavailable"]
                .iter()
                .any(|key| result["omissions"][key].as_u64().is_none())
        {
            return Err(ExecutionError::new(
                "language_result_invalid",
                "Language owner returned an invalid result",
            ));
        }
        // Only the four counter fields are part of the language result contract.
        result["omissions"] = json!({"outOfScope":result["omissions"]["outOfScope"],
            "unmappable":result["omissions"]["unmappable"],"stale":result["omissions"]["stale"],
            "unavailable":result["omissions"]["unavailable"]});
        // Recheck actual source and authority after the service wait. No read lease spans LSP.
        let source = self.observe_source_path(context, &args.path, cancel)?;
        if result.get("source").is_some()
            || unversioned
            || matches!(result["status"].as_str(), Some("ready" | "partial"))
        {
            let provenance = &result["source"];
            if provenance["revision"].as_str().is_none_or(str::is_empty)
                || provenance["selection"] != admitted["source"]
                || provenance["physicalRoot"] != admitted["physicalRoot"]
                || provenance["dependencies"]
                    != json!({"source":if self.binding.source_mode==SourceMode::FixedBranch {"fixed_branch"} else {"live"},"external":"provider_environment"})
                || (self.binding.source_mode == SourceMode::FixedBranch)
                    != provenance.get("derivedView").is_some()
                || provenance["resourceId"].as_str() != Some(&args.path)
                || provenance["view"].as_str().is_none_or(|view| {
                    !view.starts_with("agent:source:") || view.len() == "agent:source:".len()
                })
                || provenance["documentVersion"].as_u64().is_none()
                || provenance["generation"].as_u64().is_none()
                || provenance
                    .get("providerId")
                    .is_some_and(|value| !value.is_string())
            {
                return Err(ExecutionError::new(
                    "language_result_invalid",
                    "Language result omitted or changed its bound source provenance",
                ));
            }
        }
        let mut checked = args.clone();
        checked.derived_view = result["source"].get("derivedView").cloned();
        self.resources
            .call(
                &self.binding,
                context,
                ResourceOperation::LanguageQuery(checked),
                true,
                cancel,
            )
            .map_err(|failure| {
                ExecutionError::new(error_code(&failure.error), failure.error.to_string())
            })?;
        if let Some(revision) = result["source"]["revision"].as_str() {
            if revision != source.revision {
                result["status"] = json!("stale");
                result["items"] = json!([]);
                result["message"] =
                    json!("The queried source changed while the language server was answering");
                return Ok(result);
            }
        }
        if !unversioned && !matches!(result["status"].as_str(), Some("ready" | "partial")) {
            result["items"] = json!([]);
            return Ok(result);
        }
        let items = result
            .get_mut("items")
            .and_then(Value::as_array_mut)
            .map(std::mem::take)
            .ok_or_else(|| {
                ExecutionError::new(
                    "language_result_invalid",
                    "Language result omitted its items",
                )
            })?;
        let mut projection = LanguageProjection {
            executor: self,
            context,
            cancel,
            input_path: &args.path,
            source: &source,
            unversioned,
            observations: BTreeMap::from([(args.path.clone(), source.clone())]),
            result: &mut result,
        };
        let mut admitted = Vec::new();
        if args.method == "hover" && items.len() > 1 {
            return Err(ExecutionError::new(
                "language_result_invalid",
                "Hover returned multiple results",
            ));
        }
        for item in items {
            let projected = match args.method.as_str() {
                "hover" => projection.hover(item)?,
                "document_symbols" | "workspace_symbols" => projection.symbol(item)?,
                "call_hierarchy" => projection.edge(item)?,
                _ => projection.navigation(item)?,
            };
            if let Some(item) = projected {
                admitted.push(item);
            }
        }
        result["items"] = json!(admitted);
        if !unversioned
            && result["omissions"]
                .as_object()
                .is_some_and(|counts| counts.values().any(|count| count.as_u64().unwrap_or(0) > 0))
        {
            result["status"] = json!("partial");
        }
        Ok(result)
    }
}

/// Method-specific projections share only source admission/observation, never an
/// arbitrary JSON walk. Opaque language-server items do not cross this boundary.
struct LanguageProjection<'a> {
    executor: &'a KernelToolExecutor,
    context: &'a ToolExecutionContext,
    cancel: &'a CancellationToken,
    input_path: &'a str,
    source: &'a Observation,
    unversioned: bool,
    observations: BTreeMap<String, Observation>,
    result: &'a mut Value,
}
fn retain_fields(item: &mut Value, fields: &[&str]) {
    if let Some(object) = item.as_object_mut() {
        object.retain(|key, _| fields.contains(&key.as_str()));
    }
}
impl LanguageProjection<'_> {
    fn omit(&mut self, reason: &str) -> Option<Value> {
        bump(self.result, reason);
        None
    }
    fn location(
        &mut self,
        item: &mut Value,
        ranges: &[&str],
        require_range: bool,
    ) -> Result<Option<Observation>, ExecutionError> {
        if self.cancel.is_cancelled() {
            return Err(ExecutionError::new(
                "language_cancelled",
                "Language query cancelled",
            ));
        }
        if !item.is_object() {
            self.omit("unmappable");
            return Ok(None);
        }
        let Some(path) = item["resource"]["resourceId"].as_str().map(str::to_owned) else {
            self.omit("unmappable");
            return Ok(None);
        };
        if item["resource"]["workspaceId"].as_str() != Some(&self.executor.binding.workspace_id)
            || normalized_path(&path, false).is_err()
        {
            self.omit("outOfScope");
            return Ok(None);
        }
        let observed = match self.observations.get(&path) {
            Some(observed) => observed.clone(),
            None => match self
                .executor
                .observe_source_path(self.context, &path, self.cancel)
            {
                Ok(observed) => {
                    self.observations.insert(path.clone(), observed.clone());
                    observed
                }
                Err(error) => {
                    if self.cancel.is_cancelled() {
                        return Err(error);
                    }
                    self.omit(if error.code == "unauthorized" {
                        "outOfScope"
                    } else {
                        "unavailable"
                    });
                    return Ok(None);
                }
            },
        };
        let mut present = 0;
        for key in ranges {
            if let Some(range) = item.get_mut(*key) {
                present += 1;
                let Some(normalized) = normalized_range(range, &observed.text) else {
                    self.omit("stale");
                    return Ok(None);
                };
                *range = normalized;
            }
        }
        if require_range && present == 0 {
            self.omit("stale");
            return Ok(None);
        }
        if let Some(origin) = item.get_mut("originSelectionRange") {
            let Some(normalized) = normalized_range(origin, &self.source.text) else {
                self.omit("stale");
                return Ok(None);
            };
            *origin = normalized;
        }
        item["resource"] =
            json!({"workspaceId":self.executor.binding.workspace_id,"resourceId":path});
        item["observedRevision"] = json!(observed.revision);
        item["rangeRevision"] = if path == self.input_path && !self.unversioned {
            json!(self.source.revision)
        } else {
            Value::Null
        };
        Ok(Some(observed))
    }
    fn navigation(&mut self, mut item: Value) -> Result<Option<Value>, ExecutionError> {
        retain_fields(
            &mut item,
            &[
                "resource",
                "range",
                "targetRange",
                "targetSelectionRange",
                "originSelectionRange",
                "severity",
                "message",
                "code",
                "source",
                "tags",
                "providerId",
                "generation",
                "documentVersion",
            ],
        );
        if self
            .location(
                &mut item,
                &["range", "targetRange", "targetSelectionRange"],
                true,
            )?
            .is_none()
        {
            return Ok(None);
        }
        Ok(Some(item))
    }
    fn hover(&mut self, mut item: Value) -> Result<Option<Value>, ExecutionError> {
        if !item["contents"].as_array().is_some_and(|contents| {
            !contents.is_empty()
                && contents.iter().all(|part| {
                    matches!(part["kind"].as_str(), Some("markdown" | "plaintext"))
                        && part["value"].is_string()
                })
        }) {
            return Ok(self.omit("unmappable"));
        }
        // Hover is text about the bound input, never an authority for links embedded in it.
        if item["resource"]["resourceId"].as_str() != Some(self.input_path) {
            return Ok(self.omit("outOfScope"));
        }
        retain_fields(&mut item, &["resource", "range", "contents"]);
        for part in item["contents"].as_array_mut().expect("validated markup") {
            retain_fields(part, &["kind", "value"]);
        }
        if self.location(&mut item, &["range"], false)?.is_none() {
            return Ok(None);
        }
        Ok(Some(item))
    }
    fn symbol(&mut self, mut item: Value) -> Result<Option<Value>, ExecutionError> {
        if !item["name"].is_string()
            || item["kind"].as_u64().is_none()
            || item.get("range").is_none()
            || item
                .get("children")
                .is_some_and(|children| !children.is_array())
        {
            return Ok(self.omit("unmappable"));
        }
        let children = item
            .as_object_mut()
            .and_then(|object| object.remove("children"));
        retain_fields(
            &mut item,
            &[
                "resource",
                "name",
                "kind",
                "range",
                "selectionRange",
                "detail",
                "containerName",
                "tags",
            ],
        );
        if self
            .location(&mut item, &["range", "selectionRange"], true)?
            .is_none()
        {
            return Ok(None);
        }
        if let Some(Value::Array(children)) = children {
            let mut admitted = Vec::new();
            for child in children {
                if let Some(child) = self.symbol(child)? {
                    admitted.push(child);
                }
            }
            item["children"] = json!(admitted);
        }
        Ok(Some(item))
    }
    fn call_item(
        &mut self,
        mut item: Value,
    ) -> Result<Option<(Value, Observation)>, ExecutionError> {
        if !item["name"].is_string()
            || item["kind"].as_u64().is_none()
            || item.get("range").is_none()
            || item.get("selectionRange").is_none()
        {
            self.omit("unmappable");
            return Ok(None);
        }
        retain_fields(
            &mut item,
            &[
                "resource",
                "name",
                "kind",
                "range",
                "selectionRange",
                "detail",
                "tags",
            ],
        );
        Ok(self
            .location(&mut item, &["range", "selectionRange"], true)?
            .map(|observed| (item, observed)))
    }
    fn edge(&mut self, item: Value) -> Result<Option<Value>, ExecutionError> {
        let Some(ranges) = item["fromRanges"].as_array() else {
            return Ok(self.omit("unmappable"));
        };
        let Some((from, observed)) = self.call_item(item["from"].clone())? else {
            return Ok(None);
        };
        let Some((to, _)) = self.call_item(item["to"].clone())? else {
            return Ok(None);
        };
        let mut admitted = Vec::new();
        for range in ranges {
            if let Some(normalized) = normalized_range(range, &observed.text) {
                admitted.push(normalized);
            } else {
                self.omit("stale");
            }
        }
        // No surviving call-site evidence is not a relation with zero calls.
        if !ranges.is_empty() && admitted.is_empty() {
            return Ok(None);
        }
        Ok(Some(json!({"from":from,"to":to,"fromRanges":admitted})))
    }
}

fn language_completion(content: Value) -> ToolCompletion {
    let outcome = match content["status"].as_str() {
        Some("unavailable" | "unsupported" | "stale") => Outcome::Failed,
        Some("cancelled") => Outcome::Cancelled,
        _ => Outcome::Succeeded,
    };
    ToolCompletion::Result { outcome, effect: Effect::None, content: content.into() }
}

#[cfg(test)]
mod output_range_tests {
    use super::*;

    #[test]
    fn language_failure_preserves_the_query_diagnostic() {
        let content=json!({"status":"unavailable","message":"Language request timed out","items":[]});
        let ToolCompletion::Result {outcome,effect,content:output}=language_completion(content.clone()) else {panic!("query result")};
        assert_eq!(outcome,Outcome::Failed);
        assert_eq!(effect,Effect::None);
        assert_eq!(output.data,content);
        let ToolCompletion::Result {outcome,..}=language_completion(json!({"status":"pending","diagnosticVerification":"unversioned","items":[]})) else {panic!("query result")};
        assert_eq!(outcome,Outcome::Succeeded);
    }

    #[test]
    fn normalizes_lsp_output_columns_on_their_own_utf16_lines_without_accepting_invalid_ranges() {
        let text = "function caller() {\r\n  return '😀';\r\n}\r\n";
        let range = json!({"start":{"line":0,"character":0},"end":{"line":2,"character":2}});
        // The bundled TypeScript server emits this synthetic module EOL column.
        assert_eq!(
            normalized_range(&range, text).unwrap()["end"],
            json!({"line":2,"character":1})
        );
        let utf16 = json!({"start":{"line":1,"character":0},"end":{"line":1,"character":100}});
        assert_eq!(
            normalized_range(&utf16, text).unwrap()["end"]["character"],
            "  return '😀';".encode_utf16().count()
        );
        for invalid in [
            json!({"start":{"line":0,"character":0},"end":{"line":99,"character":0}}),
            json!({"start":{"line":2,"character":2},"end":{"line":2,"character":1}}),
            json!({"start":{"line":0,"character":-1},"end":{"line":0,"character":1}}),
            json!({"start":{"line":0,"character":0.5},"end":{"line":0,"character":1}}),
        ] {
            assert!(normalized_range(&invalid, text).is_none(), "{invalid}");
        }
    }
}
