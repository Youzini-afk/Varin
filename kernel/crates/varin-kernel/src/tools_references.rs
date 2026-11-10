//! Bidirectional native file/process reference adaptation. Original ToolCall and
//! raw result data stay untouched; only typed resource fields are interpreted.
use super::*;
use crate::resource_references::{self as refs, FileTarget, ProcessTarget, ReadTarget};
use varin_runtime::catalog::model_references::ReferenceKind;

impl KernelToolExecutor {
    pub(super) fn resolve_resource_arguments(&self, kind: ToolKind, input: &Value) -> Result<Value, ExecutionError> {
        let mut args = input.clone();
        if let Some(reference) = args.get("ref").and_then(Value::as_str).filter(|r|r.starts_with("read:")) {
            if args.as_object().is_none_or(|o| o.len() != 1) {
                return Err(ExecutionError::new("invalid_tool_arguments", "Use the continuation ref alone; it already fixes the original query and position."));
            }
            let catalog = self.resources.reference_catalog.as_ref().ok_or_else(||ExecutionError::new("resource_reference", "The reference Catalog is unavailable"))?.lock().map_err(|_|ExecutionError::new("resource_reference", "The reference Catalog is unavailable"))?;
            let selected: ReadTarget = refs::resolve(&catalog, ReferenceKind::Read, reference)?;
            if selected.tool != kind.name() { return Err(ExecutionError::new("reference_kind", format!("This continuation belongs to {}; use its returned nextRead tool.", selected.tool))); }
            if let Some(source) = &selected.source { refs::require_source(source, &self.binding.source_selection().map_err(ExecutionError::from)?)?; }
            args = selected.arguments;
        }
        if kind == ToolKind::FileRead {
            if let Some(files) = args.get_mut("files").and_then(Value::as_array_mut) {
                for file in files { *file = self.resolve_resource_arguments(kind, file)?; }
            }
        }
        if matches!(kind, ToolKind::FileRead | ToolKind::FileWrite | ToolKind::FileEdit) {
            if let Some(reference) = args.get("ref").and_then(Value::as_str).map(str::to_owned) {
                let catalog = self.resources.reference_catalog.as_ref().ok_or_else(||ExecutionError::new("resource_reference", "The reference Catalog is unavailable"))?.lock().map_err(|_|ExecutionError::new("resource_reference", "The reference Catalog is unavailable"))?;
                let target: FileTarget = refs::resolve(&catalog, ReferenceKind::File, &reference)?;
                match target {
                    FileTarget::Attachment {..} => return Err(ExecutionError::new("immutable_attachment", "Read the delivered file with file_read, or select a writable path for a new output.")),
                    FileTarget::Observation {source,path,read_version,format} => {
                        refs::require_source(&source, &self.binding.source_selection().map_err(ExecutionError::from)?)?;
                        let fields = args.as_object_mut().expect("typed ref object");
                        fields.remove("ref");
                        for (field,value) in [("path",json!(path)),("readVersion",json!(read_version))] {
                            if fields.get(field).is_some_and(|supplied| supplied != &value) { return Err(ExecutionError::new("reference_conflict", format!("{field} differs from the selected file observation. Read the intended path to choose a new observation."))); }
                            if field == "path" || kind != ToolKind::FileRead { fields.insert(field.into(),value); }
                        }
                        if kind == ToolKind::FileRead {
                            fields.remove("readVersion");
                            fields.insert("expectedReadVersion".into(),json!(read_version));
                            if let Some(format) = format {
                                let encoding = json!(format.encoding);
                                if fields.get("encoding").is_some_and(|v|v!=&encoding) { return Err(ExecutionError::new("reference_conflict", "A file ref keeps its original text interpretation. Read the path to choose another encoding.")); }
                                fields.insert("encoding".into(),encoding);
                            }
                        } else if let Some(format) = format {
                            let format = serde_json::to_value(format).map_err(|e|ExecutionError::new("resource_reference",e.to_string()))?;
                            if fields.get("sourceFormat").is_some_and(|v|v!=&format) { return Err(ExecutionError::new("reference_conflict", "sourceFormat differs from the selected file observation. Use targetFormat for an intentional conversion.")); }
                            fields.insert("sourceFormat".into(),format);
                        }
                    }
                }
            }
        }
        if matches!(kind, ToolKind::ProcessInspect | ToolKind::ProcessRead | ToolKind::ProcessWrite | ToolKind::ProcessResize) {
            if let Some(reference) = args["processId"].as_str().filter(|r| r.starts_with("proc:") || r.starts_with("env:")) {
                let catalog = self.resources.reference_catalog.as_ref().ok_or_else(||ExecutionError::new("resource_reference", "The reference Catalog is unavailable"))?.lock().map_err(|_|ExecutionError::new("resource_reference", "The reference Catalog is unavailable"))?;
                args["processId"] = json!(refs::process(&catalog,reference)?);
            }
        }
        Ok(args)
    }
    pub(super) fn project_resource_completion(&self, context: &ToolExecutionContext, call: &ToolCall, operation: &ResourceOperation, completion: &mut ToolCompletion) -> Result<(),ExecutionError> {
        // Frozen native v1 declarations still require explicit versions/cursors and
        // do not declare the new mutation/continuation refs. Keep their original
        // result contract, selected by the untouched call rather than today's schema.
        if call.schema_version == "1" { return Ok(()); }
        let Some(catalog) = &self.resources.reference_catalog else { return Ok(()); };
        if let ResourceOperation::FileReadBatch(files) = operation {
            if let ToolCompletion::Result {content,..} = completion {
                let mut projection = content.data.clone();
                for (index, request) in files.iter().enumerate() {
                    let Ok(operation @ ResourceOperation::FileRead(_)) = ResourceOperation::parse(ToolKind::FileRead, request) else {continue};
                    let Some(entry) = projection["files"].as_array_mut().and_then(|entries|entries.get_mut(index)) else {continue};
                    if entry["result"]["status"] != "ready" && entry["result"]["status"] != "missing" {continue;}
                    let mut result = ToolCompletion::Result {outcome:Outcome::Succeeded,effect:Effect::None,content:entry["result"].clone().into()};
                    self.project_resource_completion(context,call,&operation,&mut result)?;
                    if let ToolCompletion::Result {content,..} = result {entry["result"] = content.model_data().clone();}
                    entry.as_object_mut().unwrap().remove("request");
                }
                content.model_data = Some(projection);
            }
            return Ok(());
        }
        let output = match completion {
            ToolCompletion::Result {outcome:Outcome::Succeeded,content,..} | ToolCompletion::JobAccepted {content:Some(content),..} => content,
            _ => return Ok(()),
        };
        let query_arguments = if matches!(operation, ResourceOperation::FileQuery(_)) { Some(self.resolve_resource_arguments(ToolKind::from_name(&call.name).expect("file query"), &call.arguments)?) } else { None };
        let mut catalog = catalog.lock().map_err(|_|ExecutionError::new("resource_reference", "The reference Catalog is unavailable"))?;
        let source = self.binding.source_selection().map_err(ExecutionError::from)?;
        let owner = refs::owner(&source);
        let mut projected = output.data.clone();
        match operation {
            ResourceOperation::FileRead(args) => {
                let Some(version) = output.data["readVersion"].as_str() else { return Ok(()); };
                let format = output.data["content"].get("format").cloned().map(serde_json::from_value).transpose().map_err(|e|ExecutionError::new("resource_reference",e.to_string()))?;
                let target = FileTarget::Observation { source:source.clone(),path:args.path.clone(),read_version:version.into(),format };
                let reference = refs::register(&mut catalog,ReferenceKind::File,&owner,&target,&context.run_id)?;
                projected["ref"] = json!(reference);
                if let Some(object) = projected.as_object_mut() { object.remove("source"); object.remove("readVersion"); }
                if let Some(content) = projected.get_mut("content").and_then(Value::as_object_mut) { content.remove("hash"); }
                let next = output.data.get("nextRead").cloned().or_else(|| {
                    let next = output.data["content"]["nextOffset"].as_u64()?;
                    let end = output.data["content"]["totalBytes"].as_u64().or_else(||output.data["content"]["byteLength"].as_u64());
                    if output.data["content"]["eof"] == true || end.is_some_and(|end|next>=end) || next <= args.offset { return None; }
                    Some(json!({"ref":reference,"offset":next,"length":args.length.unwrap_or(65536)}))
                });
                if let Some(mut arguments) = next {
                    // Unit continuations carry the original unit revision and exact page.
                    if arguments.get("path").is_some() { arguments.as_object_mut().unwrap().remove("path"); arguments["ref"]=json!(reference); }
                    projected["nextRead"] = refs::continuation(&mut catalog,&owner,call.name.as_str(),Some(source),arguments,&context.run_id)?;
                }
            }
            ResourceOperation::FileMutation(mutation) => {
                if let Some(version)=output.data["readVersion"].as_str() {
                    let format=output.data.get("format").cloned().map(serde_json::from_value).transpose().map_err(|e|ExecutionError::new("resource_reference",e.to_string()))?;
                    let target=FileTarget::Observation {source,path:mutation.path().into(),read_version:version.into(),format};
                    projected["ref"]=json!(refs::register(&mut catalog,ReferenceKind::File,&owner,&target,&context.run_id)?);
                    if let Some(fields)=projected.as_object_mut() {for field in ["readVersion","operationId"] {fields.remove(field);} }
                }
            }
            ResourceOperation::FileQuery(_) => {
                if let Some(cursor) = output.data["nextCursor"].as_str() {
                    let mut arguments = query_arguments.expect("file query arguments");
                    arguments["cursor"] = json!(cursor);
                    projected["nextRead"] = refs::continuation(&mut catalog,&owner,&call.name,Some(source),arguments,&context.run_id)?;
                    projected.as_object_mut().unwrap().remove("nextCursor");
                }
            }
            ResourceOperation::ProcessSpawn(_) => {
                if output.data["processId"] == context.operation_id {
                    let reference = refs::register(&mut catalog,ReferenceKind::Process,&owner,&ProcessTarget{operation_id:context.operation_id.clone()},&context.run_id)?;
                    projected["processId"] = json!(reference);
                    projected["operationRef"] = json!(reference);
                    for field in ["operationId","runId","threadId","workspaceId","rootId","source","executionOwner"] { projected.as_object_mut().unwrap().remove(field); }
                    if let Some(observation) = projected.get_mut("observation") {
                        project_process_page(&mut catalog,&owner,&reference,observation,&context.run_id)?;
                    }
                }
            }
            _ => return Ok(()),
        }
        output.model_data = Some(projected);
        Ok(())
    }
}
pub(crate) fn project_process_page(catalog: &mut varin_runtime::Catalog, owner: &str, reference: &str, page: &mut Value, holder: &str) -> Result<(),ExecutionError> {
    if let Some(object) = page.as_object_mut() { for field in ["runId","threadId","operationId","source"] {object.remove(field);} }
    if let Some(process) = page.get_mut("process").and_then(Value::as_object_mut) { process.insert("processId".into(),json!(reference)); for field in ["runId","threadId","operationId","source","workspaceId","rootId"] {process.remove(field);} }
    page["processId"] = json!(reference);
    if let Some(cursor) = page["nextCursor"].as_u64() {
        page["nextRead"] = refs::continuation(catalog,owner,"process_read",None,json!({"processId":reference,"cursor":cursor}),holder)?;
    }
    Ok(())
}
