//! Read-only access to the original frozen conversation and its current task records.
use crate::catalog::family::{
    FamilyListQuery, FamilyReadQuery, ItemRequest, OutputRequest, ReadRequest,
};
use crate::execution::*;
use crate::{Catalog, Effect, Lifetime, Outcome};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

fn error(value: impl ToString) -> ExecutionError {
    ExecutionError::new("summary_read", value.to_string())
}
pub fn schema() -> ToolSchema {
    ToolSchema{requirements:None,name:"summary_read".into(),version:"1".into(),description:"读取摘要固定来源的原始材料。history 默认读取近期历史，query.kind 可选 recent/range/search；output/item 按 itemId 分页读取原始输出或条目；tasks 查询协作任务目录；records 读取当前跟进、目标与相关排程。历史返回 anchor 和 cursor，当前记录带观察时间。".into(),output_schema:None,metadata:None,schema:json!({"type":"object","properties":{
        "kind":{"type":"string","enum":["history","output","item","tasks","records"]},
        "query":{"type":"object","properties":{
            "kind":{"type":"string","enum":["recent","range","search"]},
            "direction":{"type":"string","enum":["older","newer"],"description":"range/search 的读取方向"},
            "afterId":{"type":"string"},"beforeId":{"type":"string"},"text":{"type":"string","description":"history search 的检索文本"},
            "limit":{"type":"integer","minimum":1},"maxItemBytes":{"type":"integer","minimum":1},"scanLimit":{"type":"integer","minimum":1},
            "scope":{"type":"string","enum":["current","history","all"],"description":"tasks 的任务范围，默认 all"},
            "query":{"type":"string","description":"tasks 的名称、短码或 Thread ID"},"filePath":{"type":"string","description":"tasks 的成果文件路径"},
            "parentThreadId":{"type":"string"},"parentBranchId":{"type":"string"},"workspaceId":{"type":"string"},
            "updatedAfterMs":{"type":"integer"},"updatedBeforeMs":{"type":"integer"}
        },"additionalProperties":false},
        "itemId":{"type":"string"},"pointer":{"type":"string","description":"output 中的 JSON Pointer，默认完整输出"},
        "anchor":{"type":"string"},"cursor":{"type":"string"},"offset":{"type":"integer","minimum":0},"maxBytes":{"type":"integer","minimum":1}
    },"required":["kind"],"additionalProperties":false})}
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Arguments {
    kind: String,
    query: Option<Value>,
    item_id: Option<String>,
    pointer: Option<String>,
    anchor: Option<String>,
    cursor: Option<String>,
    offset: Option<usize>,
    max_bytes: Option<usize>,
}
pub struct SummaryTools {
    owner: Arc<Mutex<Catalog>>,
}
impl SummaryTools {
    pub fn new(owner: Arc<Mutex<Catalog>>) -> Self {
        Self { owner }
    }
}
impl ToolExecutor for SummaryTools {
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
        _: &ToolCall,
        _: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        if cancel.is_cancelled() {
            return Err(error("query cancelled"));
        }
        let owner = self.owner.lock().map_err(error)?;
        owner.capture_context_job(&context.run_id).map_err(error)?;
        Ok(())
    }
    fn prepare(
        &self,
        call: &ToolCall,
        request: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        if cancel.is_cancelled() {
            return Err(error("query cancelled"));
        }
        let _: Arguments = serde_json::from_value(call.arguments.clone()).map_err(error)?;
        if call.name != schema().name
            || call.schema_version != schema().version
            || !request.tools.contains(&schema())
        {
            return Err(error("summary query was not selected"));
        }
        Ok(ToolContract {
            name: call.name.clone(),
            schema_version: call.schema_version.clone(),
            read_only: true,
            completion: CompletionKind::Result,
            lifetime: Lifetime::Run,
            resources: Vec::new(),
        })
    }
    fn execute(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        _: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        let result = (|| -> Result<Value, ExecutionError> {
            let args: Arguments = serde_json::from_value(call.arguments.clone()).map_err(error)?;
            let job = {
                let owner = self.owner.lock().map_err(error)?;
                let run = owner.run(&context.run_id).map_err(error)?;
                if run.cancel_requested {
                    return Err(error("query cancelled"));
                }
                owner.capture_context_job(&run.id).map_err(error)?
            };
            let (branch, head) = job.read_scope().map_err(error)?;
            let (read, thread) = {
                let owner = self.owner.lock().map_err(error)?;
                owner.summary_family_read(&branch, head).map_err(error)?
            };
            let cancelled = || cancel.is_cancelled();
            match args.kind.as_str() {
                "history" => serde_json::to_value(
                    read.read(
                        ReadRequest {
                            run_id: None,
                            anchor: args.anchor,
                            cursor: args.cursor,
                            query: args
                                .query
                                .map(serde_json::from_value)
                                .transpose()
                                .map_err(error)?
                                .unwrap_or(FamilyReadQuery::Recent {
                                    limit: None,
                                    max_item_bytes: None,
                                }),
                        },
                        &cancelled,
                    )
                    .map_err(error)?,
                )
                .map_err(error),
                "output" => read
                    .output(
                        OutputRequest {
                            run_id: None,
                            anchor: args.anchor,
                            item_id: args.item_id.ok_or_else(|| error("itemId required"))?,
                            pointer: args.pointer.unwrap_or_default(),
                            offset: args.offset,
                            max_bytes: args.max_bytes,
                        },
                        &cancelled,
                    )
                    .map_err(error),
                "item" => serde_json::to_value(
                    read.item(
                        ItemRequest {
                            run_id: None,
                            anchor: args.anchor,
                            item_id: args.item_id.ok_or_else(|| error("itemId required"))?,
                            offset: args.offset,
                            max_bytes: args.max_bytes,
                        },
                        &cancelled,
                    )
                    .map_err(error)?,
                )
                .map_err(error),
                "tasks" => {
                    let query: FamilyListQuery = args
                        .query
                        .map(serde_json::from_value)
                        .transpose()
                        .map_err(error)?
                        .unwrap_or_default();
                    serde_json::to_value(
                        read.list_page(
                            false,
                            FamilyListQuery {
                                scope: query.scope.clone().or(Some("all".into())),
                                cursor: args.cursor,
                                limit: query.limit.or(Some(20)),
                                ..query
                            },
                            &cancelled,
                        )
                        .map_err(error)?,
                    )
                    .map_err(error)
                }
                "records" => {
                    let (followups, goals, calendar) = {
                        let owner = self.owner.lock().map_err(error)?;
                        let goals = owner.capture_goals(&thread).map_err(error)?;
                        let followups = owner.followups(&thread).map_err(error)?;
                        let project = owner.summary_project(&context.run_id).map_err(error)?;
                        let calendar = project
                            .map(|project| owner.calendar_project(&project))
                            .transpose()
                            .map_err(error)?;
                        (followups, goals, calendar)
                    };
                    let goals = goals
                        .into_iter()
                        .map(|goal| goal.load())
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(error)?;
                    Ok(
                        json!({"observedAtMs":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(error)?.as_millis(),"threadId":thread,"followups":followups,"goals":goals,"calendar":calendar}),
                    )
                }
                _ => Err(error("unknown summary query")),
            }
        })();
        match result {
            Ok(value) => ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                effect: Effect::None,
                content: value.into(),
            },
            Err(problem) => ToolCompletion::Result {
                outcome: if cancel.is_cancelled() {
                    Outcome::Cancelled
                } else {
                    Outcome::Failed
                },
                effect: Effect::None,
                content: json!({"error":problem.code,"message":problem.message}).into(),
            },
        }
    }
}
