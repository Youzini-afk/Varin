//! The selected retrieval pipeline belongs to the Host. Rust admits the actual Run grant,
//! releases it while the pipeline runs, and verifies every returned span against current bytes.
use super::*;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const STAGE_KINDS: [&str; 4] = ["keyword", "structure", "semantic", "model"];
const STATUSES: [&str; 8] = [
    "ready",
    "empty",
    "partial",
    "unavailable",
    "unsupported",
    "failed",
    "cancelled",
    "stale",
];
fn invalid() -> ExecutionError {
    ExecutionError::new(
        "retrieval_result_invalid",
        "Retrieval owner returned an invalid result",
    )
}
fn valid_path(path: &str) -> bool {
    normalized_path(path, false).is_ok() && !path.split('/').any(str::is_empty)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RetrievalQueryArgs {
    question: String,
    pub paths: Option<Vec<String>>,
    limit: Option<u64>,
}
impl RetrievalQueryArgs {
    pub(super) fn source_descriptor(paths:Option<Vec<String>>)->Self{Self{question:String::new(),paths,limit:None}}
    pub(super) fn parse(value: &Value) -> Result<Self, ExecutionError> {
        let args: Self = serde_json::from_value(value.clone()).map_err(|_| {
            ExecutionError::new("invalid_tool_arguments", "Invalid code retrieval arguments")
        })?;
        if args.question.trim().is_empty()
            || args.question.contains('\0')
            || args
                .limit
                .is_some_and(|limit| limit == 0 || limit > MAX_SAFE_INTEGER)
            || args
                .paths
                .as_ref()
                .is_some_and(|paths| paths.is_empty() || paths.iter().any(|path| !valid_path(path)))
        {
            return Err(ExecutionError::new(
                "invalid_tool_arguments",
                "Code retrieval requires a question, normalized relative paths, and a positive safe-integer limit",
            ));
        }
        Ok(args)
    }
    fn contains(&self, path: &str) -> bool {
        self.paths.as_ref().is_none_or(|paths| {
            paths
                .iter()
                .any(|root| path == root || path.starts_with(&format!("{root}/")))
        })
    }
}
pub(super) fn schema() -> Value {
    json!({"type":"object","additionalProperties":false,"required":["question"],"properties":{
        "question":{"type":"string","minLength":1,"description":"Question about code in the selected source view."},
        "paths":{"type":"array","minItems":1,"items":{"type":"string","minLength":1},"description":"Optional normalized relative files or directories within this Run's authorized scope."},
        "limit":{"type":"integer","minimum":1,"maximum":MAX_SAFE_INTEGER,"description":"Maximum number of verified source snippets."}
    }})
}

// Typed projection intentionally discards all unrecognized fields at every level. In particular,
// provider payloads, credentials, prompts, and Host-supplied snippet bodies never enter history.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanStage {
    kind: String,
    provider_id: String,
    configuration_id: String,
    status: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Plan {
    id: String,
    configuration_generation: u64,
    stages: Vec<PlanStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    selection: Option<Selection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    semantic: Option<SemanticIdentity>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Selection {
    provider_id: String,
    provider_key: String,
    artifact_id: String,
    configuration_id: String,
    selection_revision: u64,
}
impl Selection {
    fn valid(&self) -> bool {
        self.selection_revision <= MAX_SAFE_INTEGER
            && [
                &self.provider_id,
                &self.provider_key,
                &self.artifact_id,
                &self.configuration_id,
            ]
            .iter()
            .all(|value| !value.trim().is_empty())
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SemanticCredentialIdentity {
    reference: String,
    authority: String,
    account: String,
    generation: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SemanticIdentity {
    binding_state: String,
    provider_id: Option<String>,
    model_id: Option<String>,
    configuration_id: Option<String>,
    space_id: Option<String>,
    recipe_id: Option<String>,
    published_revision: Option<String>,
    process_epoch: Option<String>,
    coverage: String,
    lifecycle: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential: Option<SemanticCredentialIdentity>,
}
impl SemanticIdentity {
    fn valid(&self) -> bool {
        matches!(
            self.binding_state.as_str(),
            "ready" | "unconfigured" | "disabled" | "invalid" | "unavailable"
        ) && matches!(self.coverage.as_str(), "empty" | "partial" | "complete")
            && matches!(
                self.lifecycle.as_str(),
                "idle" | "building" | "rebuilding" | "ready"
            )
            && (self.binding_state != "ready"
                || [&self.provider_id, &self.model_id, &self.configuration_id]
                    .iter()
                    .all(|value| value.is_some()))
            && [
                &self.provider_id,
                &self.model_id,
                &self.configuration_id,
                &self.space_id,
                &self.recipe_id,
                &self.published_revision,
                &self.process_epoch,
            ]
            .iter()
            .all(|value| value.as_ref().is_none_or(|value| !value.trim().is_empty()))
            && self.credential.as_ref().is_none_or(|credential| {
                credential.generation <= MAX_SAFE_INTEGER
                    && [
                        &credential.reference,
                        &credential.authority,
                        &credential.account,
                    ]
                    .iter()
                    .all(|value| !value.trim().is_empty())
            })
    }
}
#[derive(Deserialize, Serialize)]
struct Stage {
    kind: String,
    status: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Omissions {
    out_of_scope: u64,
    stale: u64,
    unavailable: u64,
}
impl Omissions {
    fn any(&self) -> bool {
        self.out_of_scope != 0 || self.stale != 0 || self.unavailable != 0
    }
    fn valid(&self) -> bool {
        [self.out_of_scope, self.stale, self.unavailable]
            .iter()
            .all(|count| *count <= MAX_SAFE_INTEGER)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snippet {
    path: String,
    revision: String,
    start_line: u64,
    end_line: u64,
    #[serde(default)]
    required: bool,
    #[serde(default)]
    required_groups: Vec<String>,
    #[serde(rename = "content")]
    _untrusted_content: String,
}
#[derive(Deserialize)]
struct Reply {
    status: String,
    #[serde(rename = "sourceFailure")]
    source_failure: Option<varin_runtime::catalog::launches::SourceFailureCode>,
    plan: Option<Plan>,
    source: Option<varin_runtime::catalog::launches::SourceSelection>,
    #[serde(rename = "physicalRoot")]
    physical_root: Option<varin_runtime::catalog::launches::LiveRoot>,
    snippets: Vec<Snippet>,
    omissions: Omissions,
    stages: Vec<Stage>,
}
fn required_components(items: &[Snippet]) -> Vec<Vec<usize>> {
    let mut pending: std::collections::BTreeSet<_> = (0..items.len()).collect();
    let mut result = Vec::new();
    while let Some(first) = pending.pop_first() {
        let mut group = vec![first];
        let mut ids: std::collections::BTreeSet<_> = items[first].required_groups.iter().collect();
        loop {
            let joined: Vec<_> = pending
                .iter()
                .copied()
                .filter(|index| {
                    items[*index]
                        .required_groups
                        .iter()
                        .any(|id| ids.contains(id))
                })
                .collect();
            if joined.is_empty() {
                break;
            }
            for index in joined {
                pending.remove(&index);
                ids.extend(items[index].required_groups.iter());
                group.push(index);
            }
        }
        result.push(group);
    }
    result
}
fn exact_stages<'a>(kinds: impl Iterator<Item = &'a str>) -> bool {
    let kinds: Vec<_> = kinds.collect();
    kinds.len() == STAGE_KINDS.len()
        && STAGE_KINDS
            .iter()
            .all(|kind| kinds.iter().filter(|value| *value == kind).count() == 1)
}
fn counter(count: &mut u64) {
    *count = count.saturating_add(1).min(MAX_SAFE_INTEGER);
}
enum Span {
    Content(String),
    Invalid,
    OverBudget,
}
fn span(text: &str, start: u64, end: u64, budget: usize) -> Span {
    if start == 0 || end < start || end > MAX_SAFE_INTEGER {
        return Span::Invalid;
    }
    let Ok(start) = usize::try_from(start - 1) else {
        return Span::Invalid;
    };
    let Some(count) = usize::try_from(end)
        .ok()
        .and_then(|end| end.checked_sub(start))
    else {
        return Span::Invalid;
    };
    let mut length = 0usize;
    let mut seen = 0usize;
    for row in text.split('\n').skip(start).take(count) {
        seen += 1;
        length = length
            .saturating_add(row.len())
            .saturating_add(usize::from(seen > 1));
        if length > budget {
            return Span::OverBudget;
        }
    }
    if seen != count {
        return Span::Invalid;
    }
    Span::Content(
        text.split('\n')
            .skip(start)
            .take(count)
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

impl KernelToolExecutor {
    pub(super) fn admit_retrieval(
        &self,
        context: &ToolExecutionContext,
        args: &RetrievalQueryArgs,
        cancel: &CancellationToken,
    ) -> Result<Value, ExecutionError> {
        self.resources
            .call(
                &self.binding,
                context,
                ResourceOperation::RetrievalQuery(args.clone()),
                true,
                cancel,
            )
            .map_err(|failure| {
                ExecutionError::new(
                    error_code(&failure.error),
                    "Code retrieval grant is unavailable",
                )
            })
    }
    pub(super) fn execute_retrieval(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        args: &RetrievalQueryArgs,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        match self.retrieval_query(context, call, args, cancel) {
            Ok(content) => ToolCompletion::Result {
                outcome: match content["status"].as_str() {
                    Some("cancelled") => Outcome::Cancelled,
                    Some("unavailable" | "unsupported" | "failed" | "stale") => Outcome::Failed,
                    _ => Outcome::Succeeded,
                },
                effect: Effect::None,
                content: content.into(),
            },
            Err(error) => ToolCompletion::Result {
                outcome: if cancel.is_cancelled() {
                    Outcome::Cancelled
                } else {
                    Outcome::Failed
                },
                effect: Effect::None,
                content: json!({"status":if cancel.is_cancelled() {"cancelled"} else {"unavailable"},
                    "error":error.code,"message":"Code retrieval could not provide a verified result"}).into(),
            },
        }
    }
    fn retrieval_query(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        args: &RetrievalQueryArgs,
        cancel: &CancellationToken,
    ) -> Result<Value, ExecutionError> {
        let admitted = self.admit_retrieval(context, args, cancel)?;
        let bridge = self.retrieval.as_ref().ok_or_else(|| {
            ExecutionError::new(
                "retrieval_owner_unavailable",
                "Retrieval owner is not connected",
            )
        })?;
        let invocations = self.retrieval_invocations.as_ref().ok_or_else(|| {
            ExecutionError::new(
                "retrieval_owner_unavailable",
                "Retrieval invocation owner is unavailable",
            )
        })?;
        let inference = invocations.delegate_inference(context)?;
        // These identities already belong to the committed model exchange or policy graph.
        // Recovery reuses them; the private bridge's random request ID is transport-only.
        let invocation = match &context.origin {
            ToolOrigin::NestedCall {
                parent_operation_id,
            } => {
                json!({"kind":"nested_call", "parentOperationId":parent_operation_id, "toolCallId":call.call_id})
            }
            ToolOrigin::ModelStep { request_id } => {
                json!({"kind":"model_step", "requestId":request_id,
                "toolCallId":call.call_id})
            }
            ToolOrigin::PolicyAction { action_id, node_id } => {
                json!({"kind":"policy_action", "actionId":action_id,
                "nodeId":node_id, "toolCallId":call.call_id})
            }
        };
        let mut query = json!({"invocation":invocation,"inferenceOwner":inference.owner(),"runId":self.binding.run_id,"threadId":self.binding.thread_id,
            "source":admitted["source"],"physicalRoot":admitted["physicalRoot"],"grantId":self.binding.grant_id,"projectId":self.retrieval_project_id,"question":args.question});
        if let Some(paths) = &args.paths {
            query["paths"] = json!(paths);
        }
        if let Some(limit) = args.limit {
            query["limit"] = json!(limit);
        }
        let presentation = self.retrieval_branch_id.as_ref().map(|branch| {
            let operation = match &context.origin {
                ToolOrigin::NestedCall { parent_operation_id } => parent_operation_id,
                _ => &context.operation_id,
            };
            let request = match &context.origin {
                ToolOrigin::ModelStep { request_id } => request_id,
                _ => operation,
            };
            json!({"runId":context.run_id,"threadId":self.binding.thread_id,"branchId":branch,"requestId":request,
                "event":{"kind":"tool_progress","operationId":operation,"toolName":"code_retrieval"}})
        });
        let raw = bridge.query(query, cancel, presentation);
        // Close admission before returning a cancelled observer; child receipts remain independent.
        drop(inference);
        let raw = raw?;
        let mut reply: Reply = serde_json::from_value(raw).map_err(|_| invalid())?;
        if !STATUSES.contains(&reply.status.as_str()) || !reply.omissions.valid() {
            return Err(invalid());
        }
        // Catalog retains independently owned inference receipts even when the original
        // query is cancelled or its source can no longer be delivered.
        if self.admit_retrieval(context, args, cancel).is_err() {
            reply.status = if cancel.is_cancelled() {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            reply.snippets.clear();
        }
        let content_status = matches!(reply.status.as_str(), "ready" | "empty" | "partial");
        if reply.source_failure.is_some() && (content_status || !reply.snippets.is_empty()) {
            return Err(invalid());
        }
        if reply.plan.is_some() != reply.source.is_some()
            || (content_status && reply.plan.is_none())
        {
            return Err(invalid());
        }
        if let (Some(plan), Some(source)) = (&reply.plan, &reply.source) {
            if plan.id.trim().is_empty()
                || plan.configuration_generation == 0
                || plan.configuration_generation > MAX_SAFE_INTEGER
                || plan
                    .selection
                    .as_ref()
                    .is_some_and(|selection| !selection.valid())
                || plan
                    .semantic
                    .as_ref()
                    .is_some_and(|semantic| !semantic.valid())
                || !exact_stages(plan.stages.iter().map(|stage| stage.kind.as_str()))
                || plan.stages.iter().any(|stage| {
                    stage.provider_id.trim().is_empty()
                        || stage.configuration_id.trim().is_empty()
                        || !matches!(
                            stage.status.as_str(),
                            "ready" | "disabled" | "unavailable" | "unsupported"
                        )
                        || (stage.kind == "keyword" && stage.status != "ready")
                })
                || serde_json::to_value(source).map_err(|_| invalid())? != admitted["source"]
                || serde_json::to_value(&reply.physical_root).map_err(|_| invalid())?
                    != admitted["physicalRoot"]
                || !exact_stages(reply.stages.iter().map(|stage| stage.kind.as_str()))
            {
                return Err(invalid());
            }
        } else if !reply.stages.is_empty() {
            return Err(invalid());
        }
        if reply.stages.iter().any(|stage| {
            !STAGE_KINDS.contains(&stage.kind.as_str())
                || (!STATUSES.contains(&stage.status.as_str()) && stage.status != "disabled")
        }) {
            return Err(invalid());
        }
        let source_message = reply.source_failure.map(|code| code.message()).or_else(|| (self.binding.source_mode != SourceMode::LiveRoot
            && reply.plan.as_ref().is_some_and(|plan| plan.stages.iter().any(|stage|
                stage.kind == "semantic" && stage.status == "unsupported")))
            .then_some("Semantic retrieval is unsupported for this source view. Use keyword and source-local syntax evidence, or select a live source for the configured semantic index."));
        // Reconstructed spans can be much larger than untrusted Host content. Bound the
        // complete projection by the existing wire-derived content budget, reserving 64
        // bytes for three growing safe-integer counters and the final status spelling.
        let metadata_size = serde_json::to_vec(&json!({"status":&reply.status,"snippets":[],
            "source":&reply.source,"physicalRoot":&reply.physical_root,"message":source_message,"error":reply.source_failure.map(|code| code.as_str()),"omissions":&reply.omissions}))
        .map_err(|_| invalid())?
        .len();
        let mut output_budget = crate::protocol::MAX_BLOB_RESPONSE_BYTES
            .checked_sub(metadata_size.saturating_add(64))
            .ok_or_else(invalid)?;
        let mut snippets = Vec::new();
        if matches!(reply.status.as_str(), "ready" | "partial") {
            // Cache only the current file: many tiny spans must not retain every full body.
            let mut observation: Option<(String, language::Observation)> = None;
            for component in required_components(&reply.snippets) {
                let required = component.iter().any(|i| {
                    reply.snippets[*i].required || !reply.snippets[*i].required_groups.is_empty()
                });
                let original_len = snippets.len();
                let original_budget = output_budget;
                let mut rejected = false;
                for index in component {
                    let item = &reply.snippets[index];
                    if item.required_groups.iter().any(|id| id.trim().is_empty()) {
                        return Err(invalid());
                    }
                    if cancel.is_cancelled() {
                        reply.status = "cancelled".into();
                        snippets.clear();
                        break;
                    }
                    if !valid_path(&item.path) || !args.contains(&item.path) {
                        counter(&mut reply.omissions.out_of_scope);
                        rejected = true;
                        continue;
                    }
                    if args
                        .limit
                        .is_some_and(|limit| snippets.len() as u64 >= limit)
                    {
                        rejected = true;
                        continue;
                    }
                    if observation
                        .as_ref()
                        .is_none_or(|(path, _)| path != &item.path)
                    {
                        match self.observe_source_path(context, &item.path, cancel) {
                            Ok(observed) => {
                                observation = Some((item.path.clone(), observed));
                            }
                            Err(error) => {
                                if cancel.is_cancelled() {
                                    reply.status = "cancelled".into();
                                    snippets.clear();
                                    break;
                                }
                                if error.code == "unauthorized" {
                                    counter(&mut reply.omissions.out_of_scope);
                                } else {
                                    counter(&mut reply.omissions.unavailable);
                                }
                                rejected = true;
                                continue;
                            }
                        }
                    }
                    let observed = &observation.as_ref().expect("observed current path").1;
                    if item.revision != observed.revision {
                        counter(&mut reply.omissions.stale);
                        rejected = true;
                        continue;
                    }
                    let content = match span(
                        &observed.text,
                        item.start_line,
                        item.end_line,
                        output_budget,
                    ) {
                        Span::Content(content) => content,
                        Span::Invalid => {
                            counter(&mut reply.omissions.stale);
                            rejected = true;
                            continue;
                        }
                        Span::OverBudget => {
                            counter(&mut reply.omissions.unavailable);
                            rejected = true;
                            continue;
                        }
                    };
                    let snippet = json!({"path":item.path,"revision":observed.revision,
                    "startLine":item.start_line,"endLine":item.end_line,"content":content});
                    let encoded_length = serde_json::to_vec(&snippet)
                        .map_err(|_| invalid())?
                        .len()
                        .saturating_add(1);
                    if encoded_length > output_budget {
                        counter(&mut reply.omissions.unavailable);
                        rejected = true;
                        continue;
                    }
                    output_budget -= encoded_length;
                    snippets.push(snippet);
                }
                if required && rejected {
                    snippets.truncate(original_len);
                    output_budget = original_budget;
                    counter(&mut reply.omissions.unavailable);
                }
                if cancel.is_cancelled() {
                    snippets.clear();
                    break;
                }
            }
        }
        // A failed selected stage cannot masquerade as clean zero hits, even if its owner
        // forgot the corresponding omission counter. Disabled stages are ordinary absence.
        if content_status && matches!(reply.status.as_str(), "ready" | "empty" | "partial") {
            if reply.stages.iter().any(|stage| stage.status == "stale")
                && reply.omissions.stale == 0
            {
                reply.omissions.stale = 1;
            }
            if reply.stages.iter().any(|stage| {
                matches!(
                    stage.status.as_str(),
                    "unavailable" | "unsupported" | "failed" | "cancelled" | "partial"
                )
            }) && !reply.omissions.any()
            {
                reply.omissions.unavailable = 1;
            }
            if reply.omissions.any() {
                reply.status = "partial".into();
            } else if reply.status == "ready" && snippets.is_empty() {
                reply.status = "empty".into();
            }
        }
        // Revalidate the grant once more after observing every selected source. No permission
        // lease, Storage lock, or broad filesystem claim spans the Host pipeline wait.
        if self.admit_retrieval(context, args, cancel).is_err() {
            reply.status = if cancel.is_cancelled() {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            snippets.clear();
        }
        // The model needs verified evidence and coverage. Composition and inference bookkeeping
        // remain with the bound pipeline and inference ledger, outside conversation tool content.
        let mut result =
            json!({"status":reply.status,"snippets":snippets,"omissions":reply.omissions});
        if let Some(message) = source_message {
            result["message"] = json!(message);
        }
        if let Some(code) = reply.source_failure {
            result["error"] = json!(code.as_str());
        }
        if let Some(source) = reply.source {
            result["source"] = json!(source);
            result["physicalRoot"] = json!(reply.physical_root);
        }
        Ok(result)
    }
}
