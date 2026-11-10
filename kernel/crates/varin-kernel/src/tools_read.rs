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
    parsed

}
fn project_range(observation:Value,_args:&FileReadArgs)->Value {
    // Each distinct requested page is projected by the native byte reader.
    // Identical requests still share their exact observation within a batch.
    observation
}

pub(super) fn schema() -> Value {
    let properties = json!({"encoding":{"type":"string","description":"Optional explicit file interpretation. Auto defaults to BOM, strict UTF-8, then GBK compatibility. Pass returned content.format as sourceFormat on mutations."},"raw":{"type":"boolean","description":"Return exact original bytes instead of decoded text."},"path":{"type":"string","minLength":1},
        "offset":{"type":"integer","minimum":0,"description":"Byte offset; continue with content.nextOffset and verify readVersion."},
        "length":{"type":"integer","minimum":0,"default":65536,"description":"Byte page size. Explicit pages are delivered without a second preview truncation."},
        "startLine":{"type":"integer","minimum":1,"description":"First line, 1-based. Use instead of offset/length."},
        "endLine":{"type":"integer","minimum":1,"description":"Last line, inclusive; requires startLine."},
        "unit":{"type":"object","additionalProperties":false,"anyOf":[{"required":["line"]},{"required":["symbol"]}],
            "description":"Read a complete syntax unit, for example {path: 'file.ts', unit: {symbol: 'functionName'}} or unit: {line: 24}. symbol belongs inside unit and is an exact declaration name, not a filename. Multiple matches return candidates; add unit.line to disambiguate. offset/length page within the selected unit; continue with nextRead. Uncovered lines return source context and nearby units; incomplete/unavailable structure returns plain context with its reason.",
            "properties":{"line":{"type":"integer","minimum":1},"symbol":{"type":"string","minLength":1},"revision":{"type":"string","description":"Retain the returned revision when continuing a unit."}}}});
    let single = json!({"type":"object","additionalProperties":false,"properties":properties,"required":["path"]});
    let mut properties = properties;
    properties["files"] = json!({"type":"array","minItems":1,"items":single,"description":"Read multiple files or ranges. Results retain input order, versions and individual errors."});
    let path_reads = json!({"type":"object","additionalProperties":false,"properties":properties,
        "oneOf":[{"required":["path"],"not":{"required":["files"]}},{"required":["files"],"not":{"anyOf":[{"required":["path"]},{"required":["offset"]},{"required":["length"]},{"required":["startLine"]},{"required":["endLine"]},{"required":["unit"]}]}}]});
    json!({"type":"object","oneOf":[path_reads,{"type":"object","additionalProperties":false,
        "properties":{"ref":{"type":"string","minLength":1},"offset":{"type":"integer","minimum":0},"length":{"type":"integer","minimum":0,"default":65536}},"required":["ref"]}]})
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
                    ExecutionError::from(failure.error)
                })?;
            let bridge = self.language.as_ref().ok_or_else(|| {
                ExecutionError::new("structure_unavailable", "Structure service is unavailable")
            })?;
            bridge.query(json!({"runId":self.binding.run_id,"threadId":self.binding.thread_id,"grantId":self.binding.grant_id,
                "source":admitted["source"],"physicalRoot":admitted["physicalRoot"],"textEncoding":admitted["textEncoding"],"encoding":args.encoding,"method":"structure","path":args.path}),cancel)
        })();
        let outline = match outline {
            Ok(value) => value,
            Err(error) => json!({"status":"unavailable","error":error}),
        };
        if cancel.is_cancelled() || outline["status"] == "cancelled" {
            return ToolCompletion::Result {
                outcome: Outcome::Cancelled,
                effect: Effect::None,
                content: json!({"status":"cancelled"}).into(),
            };
        }
        let mut read = args.clone();
        read.unit = None;
        if outline["status"] == "stale" {
            return ToolCompletion::Result { outcome: Outcome::Failed, effect: Effect::None,
                content: json!({"status":"stale","error":ExecutionError::new("structure_revision_changed", outline["message"].as_str().unwrap_or("The source changed; repeat the unit selection before continuing"))}).into() };
        }
        if outline["status"] != "ready" {
            return self.unit_plain_read(context, call, args, contract, cancel, outline);
        }
        if unit
            .revision
            .as_deref()
            .is_some_and(|revision| outline["revision"] != revision)
        {
            return ToolCompletion::Result {outcome:Outcome::Failed,effect:Effect::None,
                content:json!({"status":"stale","error":ExecutionError::new("structure_revision_changed", "The source changed; repeat the unit selection before continuing")}).into()};
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
            if let Some(first) = candidates.first() {
                let span = first["range"]["endByte"].as_u64().unwrap_or(u64::MAX)
                    .saturating_sub(first["range"]["startByte"].as_u64().unwrap_or(0));
                candidates.retain(|item| item["range"]["endByte"].as_u64().unwrap_or(u64::MAX)
                    .saturating_sub(item["range"]["startByte"].as_u64().unwrap_or(0)) == span);
            }
        }
        if candidates.is_empty() {
            let items = outline["items"].as_array().map(Vec::as_slice).unwrap_or_default();
            // Nearest preceding/following units help recover an uncovered line
            // without dumping the full file outline or guessing another symbol.
            let nearby = if let Some(line) = unit.line {
                let before = items.iter().filter(|item| item["range"]["endLine"].as_u64().is_some_and(|end| end < line))
                    .max_by_key(|item| item["range"]["endLine"].as_u64());
                let after = items.iter().filter(|item| item["range"]["startLine"].as_u64().is_some_and(|start| start > line))
                    .min_by_key(|item| item["range"]["startLine"].as_u64());
                before.into_iter().chain(after).map(|item| json!({"name":item["name"],"kind":item["kind"],
                    "startLine":item["range"]["startLine"],"endLine":item["range"]["endLine"],
                    "read":{"path":args.path,"unit":{"line":item["range"]["startLine"]}}})).collect::<Vec<_>>()
            } else { Vec::new() };
            return self.unit_plain_read(context, call, args, contract, cancel,
                json!({"status":"not_found","message":if unit.symbol.is_some() {
                    "No declaration matches this exact unit.symbol and optional unit.line. Search for the declaration name, or choose a nearby unit. Showing plain source context."
                } else { "This line is outside the extracted syntax units (for example, a blank line or standalone comment). Choose a nearby unit or read this source range directly. Showing plain source context." },
                    "revision":outline["revision"],"nearbyUnits":nearby}));
        }
        if candidates.len() != 1 {
            return ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                effect: Effect::None,
                content: json!({"status":"ambiguous",
                "path":args.path,"revision":outline["revision"],"candidates":candidates,
                "message":"Select a candidate using its line, or request an ordinary file range"})
                .into(),
            };
        }
        let selected = &candidates[0];
        if selected["syntaxComplete"] == false {
            return self.unit_plain_read(context, call, args, contract, cancel,
                json!({"status":"incomplete","message":"Syntax errors leave the selected declaration incomplete; showing source context","revision":outline["revision"]}));
        }
        let (Some(start), Some(end)) = (
            selected["range"]["sourceStartByte"].as_u64().or_else(||selected["range"]["startByte"].as_u64()),
            selected["range"]["sourceEndByte"].as_u64().or_else(||selected["range"]["endByte"].as_u64()),
        ) else {
            return ToolCompletion::NotDispatched {
                reason: "Structure result omitted exact source bytes".into(),
                error: None,
            };
        };
        if end < start || args.offset > end - start {
            return ToolCompletion::NotDispatched {
                reason: "Unit offset is outside the selected source range".into(),
                error: None,
            };
        }
        if read.encoding.is_none(){read.encoding=outline["format"]["encoding"].as_str().map(str::to_owned);}
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
            let source_hash=outline["sourceObjectHash"].as_str().map(str::to_owned).unwrap_or_else(||format!("sha256-{}",outline["rawContentHash"].as_str().or_else(||outline["contentHash"].as_str()).unwrap_or_default()));
            if content.data["content"]["hash"] != source_hash
            {
                return ToolCompletion::Result{outcome:Outcome::Failed,effect:Effect::None,content:json!({"status":"stale","error":ExecutionError::new("structure_source_changed", "The file changed between structure analysis and reading; select the unit again")}).into()};
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
                content.data["nextRead"] = json!({"path":args.path,"unit":selected_unit,"offset":next-start,"length":args.length.filter(|length|*length>0).unwrap_or(65536)});
            }
        }
        completion
    }
    fn unit_plain_read(
        &self, context: &ToolExecutionContext, call: &ToolCall, args: &FileReadArgs,
        contract: &ToolContract, cancel: &CancellationToken, mut reason: Value,
    ) -> ToolCompletion {
        let unit = args.unit.as_ref().expect("unit fallback");
        // A unit-relative continuation must never silently become a file-relative page.
        if unit.revision.is_some() || args.offset != 0 {
            return ToolCompletion::Result { outcome: Outcome::Failed, effect: Effect::None,
                content: json!({"status":"unavailable","error":ExecutionError::new("structure_continuation_unavailable",
                    "The selected unit cannot be continued; repeat selection or use a plain file range"), "structure":reason}).into() };
        }
        let mut read = args.clone();
        read.unit = None;
        if let Some(line) = unit.line {
            // A useful default context window, not an input or continuation limit.
            // Explicit ordinary ranges and nextRead remain available for the rest.
            read.start_line = Some(line.saturating_sub(20).max(1));
            read.end_line = Some(line.saturating_add(60));
            read.offset = 0;
            read.length = None;
        }
        let mut completion = self.execute_operation(context, call, ResourceOperation::FileRead(read), contract, cancel);
        if let ToolCompletion::Result { outcome: Outcome::Succeeded, content, .. } = &mut completion {
            reason["fallback"] = json!("plain_read");
            content.data["structure"] = reason;
            content.data["requestedUnit"] = json!(unit);
            content.data["unitComplete"] = json!(false);
            if content.data["content"]["eof"] == false {
                if let Some(offset) = content.data["content"]["nextOffset"].as_u64() {
                    content.data["nextRead"] = json!({"path":args.path,"offset":offset,"length":args.length.unwrap_or(65536)});
                }
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
                        if !value["status"].is_string() {
                            value["status"] = json!(if outcome != Outcome::Succeeded {"failed"} else if value["missing"] == true {"missing"} else {"ready"});
                        }
                        if outcome == Outcome::Succeeded && merged { observations.insert(key,value.clone()); }
                        Ok(if selected.is_some() && merged {project_range(value,&original)}else{value})
                    },
                    ToolCompletion::NotDispatched { reason, error } => Err(error.unwrap_or_else(||ExecutionError::new("read_not_dispatched",reason))),
                    _ => Err(ExecutionError::new("invalid_read_result","File read returned a job instead of its content")),
                }
            })().unwrap_or_else(|error|json!({"status":if error.code=="cancelled" {"cancelled"} else {"failed"},"error":error}));
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
