//! Bot work associations use the original Catalog, independently of execution status.
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use varin_runtime::catalog::bot_work::{BotMatter, MatterUpdate};
use varin_runtime::execution::*;
use varin_runtime::{Catalog, Effect, Lifetime, Outcome};
fn error(value: impl ToString) -> ExecutionError {
    ExecutionError::new("bot_work", value.to_string())
}
pub(crate) fn schema() -> ToolSchema {
    ToolSchema { requirements:None, name:"matters".into(), version:"2".into(), output_schema:None, metadata:None,
        description:"Find, read or maintain matters you are following. A matter connects a free description to original work; its description does not change task status. projects lists registered project IDs for dispatch projectId. list returns brief paged references; get opens one. set uses its exact revision (0 for new), and preserves original conversations. You can associate your own tasks; access to ordinary conversations comes from an explicit user following link. Use threads/read_thread/send for actual work.".into(),
        schema:json!({"type":"object","properties":{"action":{"type":"string","enum":["list","get","set","projects"]},"id":{"type":"string"},"query":{"type":"string"},"cursor":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1},"expectedRevision":{"type":"integer","minimum":0},"matter":{"type":"object","properties":{"id":{"type":"string"},"revision":{"type":"integer","minimum":0},"title":{"type":"string"},"description":{"type":"string"},"archived":{"type":"boolean"},"threads":{"type":"array","items":{"type":"object","properties":{"threadId":{"type":"string"},"branchId":{"type":"string"},"send":{"type":"boolean"},"memory":{"type":"boolean"}},"required":["threadId","branchId"],"additionalProperties":false}}},"required":["id","title","description","archived","threads","revision"],"additionalProperties":false}},"required":["action"],"additionalProperties":false}) }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Arguments {
    action: String,
    id: Option<String>,
    query: Option<String>,
    cursor: Option<usize>,
    limit: Option<usize>,
    expected_revision: Option<u64>,
    matter: Option<BotMatter>,
}
pub(crate) fn declaration(
    catalog: Arc<Mutex<Catalog>>,
) -> varin_runtime::composition::tools::ToolDeclaration {
    varin_runtime::composition::tools::ToolDeclaration::new(schema(), Arc::new(Tools { catalog }))
}
struct Tools {
    catalog: Arc<Mutex<Catalog>>,
}
impl ToolExecutor for Tools {
    fn plan(
        &self,
        call: &ToolCall,
        request: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(call, request, cancel)
            .map(ToolPreparation::Ready)
    }
    fn authorize(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        _: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        if cancel.is_cancelled() {
            return Err(error("matter command cancelled"));
        }
        let read = self
            .catalog
            .lock()
            .map_err(error)?
            .capture_tool_invocation(context, &call.call_id)
            .map_err(error)?;
        let snapshot = read.load().map_err(error)?;
        if snapshot.call != *call || !snapshot.tools.contains(&schema()) {
            return Err(error("matter invocation changed"));
        }
        self.catalog
            .lock()
            .map_err(error)?
            .validate_tool_invocation(&snapshot, true)
            .map_err(error)
    }
    fn prepare(
        &self,
        call: &ToolCall,
        request: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        let selected = schema();
        if cancel.is_cancelled() {
            return Err(error("matter command cancelled"));
        }
        if call.name != selected.name
            || call.schema_version != selected.version
            || !request.tools.contains(&selected)
        {
            return Err(error("matters was not selected in this request"));
        }
        let args: Arguments = serde_json::from_value(call.arguments.clone()).map_err(error)?;
        if !matches!(args.action.as_str(), "list" | "get" | "set" | "projects") {
            return Err(error("unknown matter action"));
        }
        Ok(ToolContract {
            name: call.name.clone(),
            schema_version: call.schema_version.clone(),
            completion: CompletionKind::Result,
            lifetime: Lifetime::Run,
            read_only: args.action != "set",
            resources: vec![],
        })
    }
    fn execute(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        _contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        let result = (|| -> Result<(Value, bool), ExecutionError> {
            if cancel.is_cancelled() {
                return Err(error("matter command cancelled"));
            }
            let args: Arguments = serde_json::from_value(call.arguments.clone()).map_err(error)?;
            if args.action == "projects" {
                let read = self
                    .catalog
                    .lock()
                    .map_err(error)?
                    .capture_child_dispatch_invocation(context)
                    .map_err(error)?;
                let catalog = read.load().map_err(error)?.catalog;
                let projects = catalog
                    .projects
                    .into_iter()
                    .filter(|project| {
                        args.query.as_ref().is_none_or(|query| {
                            format!("{} {} {}", project.id, project.name, project.path)
                                .to_lowercase()
                                .contains(&query.to_lowercase())
                        })
                    })
                    .collect::<Vec<_>>();
                let start = args.cursor.unwrap_or(0);
                let limit = args.limit.unwrap_or(20);
                if start > projects.len() || limit == 0 {
                    return Err(error("invalid project page"));
                }
                let end = start.saturating_add(limit).min(projects.len());
                return Ok((
                    json!({"projects":projects[start..end],"nextCursor":if end<projects.len(){Some(end)}else{None}}),
                    false,
                ));
            }
            let mut owner = self.catalog.lock().map_err(error)?;
            let run = owner.run(&context.run_id).map_err(error)?;
            let bot = owner
                .bot_for_thread(&run.thread_id)
                .map_err(error)?
                .ok_or_else(|| error("matters requires a Bot identity"))?;
            match args.action.as_str() {
                "set" => {
                    let matter = args.matter.ok_or_else(|| error("set requires matter"))?;
                    let updated = owner
                        .update_bot_matter(
                            MatterUpdate {
                                bot_id: bot,
                                key: context.operation_id.clone(),
                                expected_revision: args
                                    .expected_revision
                                    .ok_or_else(|| error("set requires expectedRevision"))?,
                                matter,
                            },
                            Some(context),
                        )
                        .map_err(error)?;
                    Ok((serde_json::to_value(updated).map_err(error)?, true))
                }
                "get" => Ok((
                    serde_json::to_value(
                        owner
                            .bot_matters(&bot)
                            .map_err(error)?
                            .into_iter()
                            .find(|row| Some(&row.id) == args.id.as_ref())
                            .ok_or_else(|| error("matter not found"))?,
                    )
                    .map_err(error)?,
                    false,
                )),
                _ => {
                    let rows = owner
                        .bot_matters(&bot)
                        .map_err(error)?
                        .into_iter()
                        .filter(|row| {
                            !row.archived
                                && args.query.as_ref().is_none_or(|query| {
                                    format!("{} {}", row.title, row.description)
                                        .to_lowercase()
                                        .contains(&query.to_lowercase())
                                })
                        })
                        .collect::<Vec<_>>();
                    let start = args.cursor.unwrap_or(0);
                    let limit = args.limit.unwrap_or(20);
                    if start > rows.len() || limit == 0 {
                        return Err(error("invalid matter page"));
                    }
                    let end = start.saturating_add(limit).min(rows.len());
                    Ok((
                        json!({"matters":rows[start..end].iter().map(|row|json!({"id":row.id,"title":row.title,"revision":row.revision,"threads":row.threads})).collect::<Vec<_>>(),"nextCursor":if end<rows.len(){Some(end)}else{None}}),
                        false,
                    ))
                }
            }
        })();
        match result {
            Ok((data, changed)) => ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                effect: if changed {
                    Effect::Confirmed
                } else {
                    Effect::None
                },
                content: varin_runtime::output::OutputBody::from(data),
            },
            Err(failure) => ToolCompletion::Result {
                outcome: Outcome::Failed,
                effect: Effect::None,
                content: varin_runtime::output::OutputBody::from(json!({"error":failure})),
            },
        }
    }
}
