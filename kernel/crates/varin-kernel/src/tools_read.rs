//! Batch reads preserve each requested observation and its individual failure.
use super::*;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UnitReadArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    symbol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    revision: Option<String>,
}
impl UnitReadArgs {
    pub(super) fn validate(&self) -> Result<(), ExecutionError> {
        if self.line == Some(0)
            || self.symbol.as_ref().is_some_and(|s| s.trim().is_empty())
            || (self.line.is_none() && self.symbol.is_none())
        {
            return Err(ExecutionError::new(
                "invalid_tool_arguments",
                "unit requires a positive line or an exact symbol name",
            ));
        }
        Ok(())
    }
}

/// Merge only overlapping observations, retaining the caller's original pages.
/// The framed read limit is an existing transport boundary, not a batch quota.
fn batch_ranges(files: &[Value]) -> Vec<Option<FileReadArgs>> {
    let parsed = files
        .iter()
        .map(
            |value| match ResourceOperation::parse(ToolKind::FileRead, value) {
                Ok(ResourceOperation::FileRead(args)) if args.unit.is_none() => Some(args),
                _ => None,
            },
        )
        .collect::<Vec<_>>();
    let mut grouped = parsed.clone();
    for (index, args) in parsed
        .iter()
        .enumerate()
        .filter_map(|(i, args)| args.as_ref().map(|a| (i, a)))
    {
        let mut merged = args.clone();
        loop {
            let before = (
                merged.offset,
                merged.length,
                merged.start_line,
                merged.end_line,
            );
            for other in parsed.iter().flatten().filter(|other| {
                other.path == args.path && other.start_line.is_some() == args.start_line.is_some()
            }) {
                if let (Some(first), Some(next)) = (merged.start_line, other.start_line) {
                    let last = merged.end_line.unwrap_or(u64::MAX);
                    let next_last = other.end_line.unwrap_or(u64::MAX);
                    if next <= last && first <= next_last {
                        merged.start_line = Some(first.min(next));
                        merged.end_line = if last == u64::MAX || next_last == u64::MAX {
                            None
                        } else {
                            Some(last.max(next_last))
                        };
                    }
                } else {
                    let last = merged.offset.saturating_add(merged.length.unwrap_or(65536));
                    let next_last = other.offset.saturating_add(other.length.unwrap_or(65536));
                    let start = merged.offset.min(other.offset);
                    let end = last.max(next_last);
                    if other.offset <= last
                        && merged.offset <= next_last
                        && end - start <= crate::protocol::MAX_BLOB_RESPONSE_BYTES as u64
                    {
                        merged.offset = start;
                        merged.length = Some(end - start);
                    }
                }
            }
            if before
                == (
                    merged.offset,
                    merged.length,
                    merged.start_line,
                    merged.end_line,
                )
            {
                break;
            }
        }
        grouped[index] = Some(merged);
    }
    grouped
}
fn project_range(mut observation: Value, args: &FileReadArgs) -> Value {
    let content = &observation["content"];
    let total = content["byteLength"].as_u64().unwrap_or(0);
    let base = content["offset"].as_u64().unwrap_or(0);
    let bytes = if let Some(text) = content["text"].as_str() {
        text.as_bytes().to_vec()
    } else if let Some(encoded) = content["bytesBase64"].as_str() {
        match BASE64.decode(encoded) {
            Ok(bytes) => bytes,
            Err(_) => return observation,
        }
    } else {
        return observation;
    };
    let mut value = content.clone();
    let (start, end) = if let Some(first) = args.start_line {
        let base_line = content["startLine"].as_u64().unwrap_or(first);
        let mut offset = 0usize;
        let mut start = None;
        let mut end = 0;
        let mut last = None;
        for (index, line) in bytes.split_inclusive(|b| *b == b'\n').enumerate() {
            let number = base_line + index as u64;
            if number >= first && number <= args.end_line.unwrap_or(u64::MAX) {
                start.get_or_insert(offset);
                end = offset + line.len();
                last = Some(number);
            }
            offset += line.len();
        }
        let start = start.unwrap_or(bytes.len());
        let end = if last.is_some() { end } else { bytes.len() };
        value["startLine"] = json!(first);
        value["endLine"] = json!(last);
        value["nextLine"] = json!(if base + (end as u64) < total {
            last.map(|line| line + 1)
        } else {
            None
        });
        (start, end)
    } else {
        let mut start = args.offset.saturating_sub(base).min(bytes.len() as u64) as usize;
        let mut end = args
            .offset
            .saturating_add(args.length.unwrap_or(65536))
            .saturating_sub(base)
            .min(bytes.len() as u64) as usize;
        if start != end && content["text"].is_string() {
            while start > 0 && bytes.get(start).is_some_and(|byte| byte & 0xc0 == 0x80) {
                start -= 1;
            }
            while end < bytes.len() && bytes[end] & 0xc0 == 0x80 {
                end += 1;
            }
        }
        (start, end)
    };
    value["offset"] = json!(base + start as u64);
    value["nextOffset"] = json!(base + end as u64);
    value["eof"] = json!(base + end as u64 >= total);
    if content["text"].is_string() {
        value["text"] = json!(std::str::from_utf8(&bytes[start..end]).expect("aligned text page"));
    } else {
        value["bytesBase64"] = json!(BASE64.encode(&bytes[start..end]));
    }
    observation["content"] = value;
    observation
}

pub(super) fn schema() -> Value {
    let properties = json!({"path":{"type":"string","minLength":1},
        "offset":{"type":"integer","minimum":0,"description":"Byte offset; continue with content.nextOffset and verify readVersion."},
        "length":{"type":"integer","minimum":0,"default":65536,"description":"Byte page size. Explicit pages are delivered without a second preview truncation."},
        "startLine":{"type":"integer","minimum":1,"description":"First line, 1-based. Use instead of offset/length."},
        "endLine":{"type":"integer","minimum":1,"description":"Last line, inclusive; requires startLine."},
        "unit":{"type":"object","additionalProperties":false,"anyOf":[{"required":["line"]},{"required":["symbol"]}],
            "description":"Read an enclosing Tree-sitter code unit without starting a language server. Exact symbol names may return candidates; add line to disambiguate. offset/length page within the selected unit; continue with nextRead.",
            "properties":{"line":{"type":"integer","minimum":1},"symbol":{"type":"string","minLength":1},"revision":{"type":"string","description":"Retain the returned revision when continuing a unit."}}}});
    let single = json!({"type":"object","additionalProperties":false,"properties":properties,"required":["path"]});
    let mut properties = properties;
    properties["files"] = json!({"type":"array","minItems":1,"items":single,"description":"Read multiple files or ranges. Results retain input order, versions and individual errors."});
    json!({"type":"object","additionalProperties":false,"properties":properties,
        "oneOf":[{"required":["path"],"not":{"required":["files"]}},{"required":["files"],"not":{"anyOf":[{"required":["path"]},{"required":["offset"]},{"required":["length"]},{"required":["startLine"]},{"required":["endLine"]},{"required":["unit"]}]}}]})
}

impl KernelToolExecutor {
    pub(super) fn execute_unit_read(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        args: &FileReadArgs,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        let unit = args.unit.as_ref().expect("unit read");
        let outline = (|| -> Result<Value, ExecutionError> {
            let admitted = self
                .resources
                .call(
                    &self.binding,
                    context,
                    ResourceOperation::RetrievalQuery(RetrievalQueryArgs::source_descriptor(Some(
                        vec![args.path.clone()],
                    ))),
                    true,
                    cancel,
                )
                .map_err(|failure| {
                    ExecutionError::new(error_code(&failure.error), failure.error.to_string())
                })?;
            let bridge = self.language.as_ref().ok_or_else(|| {
                ExecutionError::new("structure_unavailable", "Structure service is unavailable")
            })?;
            bridge.query(json!({"runId":self.binding.run_id,"threadId":self.binding.thread_id,"grantId":self.binding.grant_id,
                "source":admitted["source"],"physicalRoot":admitted["physicalRoot"],"method":"structure","path":args.path}),cancel)
        })();
        let outline = match outline {
            Ok(value) => value,
            Err(error) => json!({"status":"unavailable","message":error.message}),
        };
        if cancel.is_cancelled() {
            return ToolCompletion::Result {
                outcome: Outcome::Cancelled,
                effect: Effect::None,
                content: json!({"status":"cancelled"}).into(),
            };
        }
        let mut read = args.clone();
        read.unit = None;
        if outline["status"] != "ready" {
            if unit.revision.is_some() {
                return ToolCompletion::Result {outcome:Outcome::Failed,effect:Effect::None,
                content:json!({"status":"unavailable","error":"structure_continuation_unavailable","message":outline["message"]}).into()};
            }
            if let Some(line) = unit.line {
                read.start_line = Some(line);
                read.end_line = Some(line);
                read.length = None;
                read.offset = 0;
            }
            let mut completion = self.execute_operation(
                context,
                call,
                ResourceOperation::FileRead(read),
                contract,
                cancel,
            );
            if let ToolCompletion::Result { content, .. } = &mut completion {
                content.data["structure"] = json!({"status":outline["status"],"message":outline["message"],"fallback":"plain_read"});
            }
            return completion;
        }
        if unit
            .revision
            .as_deref()
            .is_some_and(|revision| outline["revision"] != revision)
        {
            return ToolCompletion::Result {outcome:Outcome::Failed,effect:Effect::None,
                content:json!({"status":"stale","error":"structure_revision_changed","message":"The source changed; repeat the unit selection before continuing"}).into()};
        }
        let mut candidates = outline["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|item| {
                unit.symbol
                    .as_ref()
                    .is_none_or(|name| item["name"] == *name)
                    && unit.line.is_none_or(|line| {
                        item["range"]["startLine"]
                            .as_u64()
                            .is_some_and(|start| start <= line)
                            && item["range"]["endLine"]
                                .as_u64()
                                .is_some_and(|end| line <= end)
                    })
            })
            .cloned()
            .collect::<Vec<_>>();
        if unit.line.is_some() {
            candidates.sort_by_key(|item| {
                item["range"]["endByte"]
                    .as_u64()
                    .unwrap_or(u64::MAX)
                    .saturating_sub(item["range"]["startByte"].as_u64().unwrap_or(0))
            });
            candidates.truncate(1);
        }
        if candidates.len() != 1 {
            return ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                effect: Effect::None,
                content: json!({"status":if candidates.is_empty(){"not_found"}else{"ambiguous"},
                "path":args.path,"revision":outline["revision"],"candidates":candidates,
                "message":"Select a candidate using its line, or request an ordinary file range"})
                .into(),
            };
        }
        let selected = &candidates[0];
        let (Some(start), Some(end)) = (
            selected["range"]["startByte"].as_u64(),
            selected["range"]["endByte"].as_u64(),
        ) else {
            return ToolCompletion::NotDispatched {
                reason: "Structure result omitted exact source bytes".into(),
            };
        };
        if end < start || args.offset > end - start {
            return ToolCompletion::NotDispatched {
                reason: "Unit offset is outside the selected source range".into(),
            };
        }
        read.offset = start + args.offset;
        read.length = Some(args.length.unwrap_or(65536).min(end - read.offset));
        let mut completion = self.execute_operation(
            context,
            call,
            ResourceOperation::FileRead(read),
            contract,
            cancel,
        );
        if let ToolCompletion::Result {
            outcome: Outcome::Succeeded,
            content,
            ..
        } = &mut completion
        {
            if content.data["content"]["hash"]
                != format!(
                    "sha256-{}",
                    outline["contentHash"].as_str().unwrap_or_default()
                )
            {
                return ToolCompletion::Result{outcome:Outcome::Failed,effect:Effect::None,content:json!({"status":"stale","error":"structure_source_changed","message":"The file changed between structure analysis and reading; select the unit again"}).into()};
            }
            let next = content.data["content"]["nextOffset"]
                .as_u64()
                .unwrap_or(end)
                .min(end);
            content.data["unit"] = selected.clone();
            content.data["revision"] = outline["revision"].clone();
            content.data["unitComplete"] = json!(next >= end);
            if next < end {
                let mut selected_unit = unit.clone();
                selected_unit.revision = outline["revision"].as_str().map(str::to_owned);
                content.data["nextRead"] = json!({"path":args.path,"unit":selected_unit,"offset":next-start,"length":args.length.unwrap_or(65536)});
            }
        }
        completion
    }
    pub(super) fn execute_read_batch(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        files: &[Value],
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        let mut results = Vec::new();
        let mut observations = std::collections::BTreeMap::<String, Value>::new();
        let grouped = batch_ranges(files);
        for (index, request) in files.iter().enumerate() {
            let result = (|| -> Result<Value,ExecutionError> {
                if cancel.is_cancelled() { return Err(ExecutionError::new("cancelled","Batch read cancelled before this item")); }
                let op = ResourceOperation::parse(ToolKind::FileRead,request)?;
                if !matches!(op,ResourceOperation::FileRead(_)) { return Err(ExecutionError::new("invalid_tool_arguments","Nested read batches are not supported")); }
                let plan = self.planned_contract(context,call,&op,cancel)?;
                if plan.resources.iter().any(|claim|!contract.resources.contains(claim)) {
                    return Err(ExecutionError::new("read_scope_changed","File identity changed after batch admission; read this item again"));
                }
                self.authorize_operation(context,call,&op,&plan,cancel)?;
                let selected=grouped[index].as_ref();
                let key = serde_json::to_string(&selected.map(serde_json::to_value).transpose().map_err(|e|ExecutionError::new("invalid_tool_arguments",e.to_string()))?.unwrap_or_else(||request.clone()))
                    .map_err(|e|ExecutionError::new("invalid_tool_arguments",e.to_string()))?;
                // Repeated requests share an exact, already-authorized observation only inside
                // this call. No filename/mtime cache survives to a later read.
                let original=match &op{ResourceOperation::FileRead(args)=>args.clone(),_=>unreachable!()};
                if let Some(value) = observations.get(&key) { return Ok(if selected.is_some(){project_range(value.clone(),&original)}else{value.clone()}); }
                let read=selected.map(|args|ResourceOperation::FileRead(args.clone())).unwrap_or(op);
                let mut completion=self.execute_operation(context,call,read,&plan,cancel);
                let mut merged=true;
                if selected.is_some_and(|args|args.start_line.is_some() && (args.start_line!=original.start_line || args.end_line!=original.end_line))
                    && !matches!(completion,ToolCompletion::Result{outcome:Outcome::Succeeded,..}) && !cancel.is_cancelled() {
                    // A union can exceed the response frame although each requested
                    // range fits. Optimization must not change item admissibility.
                    completion=self.execute_operation(context,call,ResourceOperation::FileRead(original.clone()),&plan,cancel);
                    merged=false;
                }
                match completion {
                    ToolCompletion::Result {outcome,content,..} => {
                        let mut value = content.data;
                        value["status"] = json!(if outcome != Outcome::Succeeded {"failed"} else if value["missing"] == true {"missing"} else {"ready"});
                        if outcome == Outcome::Succeeded && merged { observations.insert(key,value.clone()); }
                        Ok(if selected.is_some() && merged {project_range(value,&original)}else{value})
                    },
                    ToolCompletion::NotDispatched {reason} => Err(ExecutionError::new("read_not_dispatched",reason)),
                    _ => Err(ExecutionError::new("invalid_read_result","File read returned a job instead of its content")),
                }
            })().unwrap_or_else(|error|json!({"status":if error.code=="cancelled" {"cancelled"} else {"failed"},"error":error.code,"message":error.message}));
            results.push(json!({"index":index,"request":request,"result":result}));
        }
        let good = results
            .iter()
            .filter(|entry| entry["result"]["status"] == "ready")
            .count();
        let status = if good == results.len() {
            "ready"
        } else if good > 0 {
            "partial"
        } else if cancel.is_cancelled() {
            "cancelled"
        } else {
            "failed"
        };
        ToolCompletion::Result {
            outcome: if cancel.is_cancelled() {
                Outcome::Cancelled
            } else if good > 0 {
                Outcome::Succeeded
            } else {
                Outcome::Failed
            },
            effect: Effect::None,
            content: json!({"status":status,"files":results}).into(),
        }
    }
}
