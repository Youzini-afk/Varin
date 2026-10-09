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
            return Err(ExecutionError::new("invalid_tool_arguments", "Code retrieval requires a question, normalized relative paths, and a positive safe-integer limit"));
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
        "question":{"type":"string","minLength":1,"description":"Question about code in the selected live workspace."},
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
#[serde(tag = "status", rename_all = "camelCase")]
enum InferenceUsage {
    Unknown,
    Known {
        #[serde(rename = "inputTokens", skip_serializing_if = "Option::is_none")]
        input_tokens: Option<u64>,
        #[serde(rename = "totalTokens", skip_serializing_if = "Option::is_none")]
        total_tokens: Option<u64>,
    },
}
impl InferenceUsage {
    fn valid(&self) -> bool {
        match self {
            Self::Unknown => true,
            Self::Known {
                input_tokens,
                total_tokens,
            } => {
                (input_tokens.is_some() || total_tokens.is_some())
                    && [input_tokens, total_tokens]
                        .iter()
                        .all(|value| value.is_none_or(|value| value <= MAX_SAFE_INTEGER))
            }
        }
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InferenceReceipt {
    batch_id: String,
    purpose: String,
    input_items: u64,
    input_bytes: u64,
    provider_id: String,
    model_id: String,
    configuration_id: String,
    attempts: u64,
    attempts_known: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reused: Option<bool>,
    state: String,
    usage: InferenceUsage,
    #[serde(skip_serializing_if = "Option::is_none")]
    http_status: Option<u16>,
}
impl InferenceReceipt {
    fn valid(&self) -> bool {
        [
            &self.batch_id,
            &self.provider_id,
            &self.model_id,
            &self.configuration_id,
        ]
        .iter()
        .all(|value| !value.trim().is_empty())
            && self.attempts <= MAX_SAFE_INTEGER
            && self.input_items <= MAX_SAFE_INTEGER
            && self.input_bytes <= MAX_SAFE_INTEGER
            && matches!(
                self.purpose.as_str(),
                "index-document-embedding" | "query-embedding"
            )
            && matches!(
                self.state.as_str(),
                "not-started" | "succeeded" | "failed" | "indeterminate" | "delivery-blocked"
            )
            && self.usage.valid()
            && self
                .http_status
                .is_none_or(|status| (100..=599).contains(&status))
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    mode: String,
    workspace_id: String,
    execution_workspace_id: String,
    live_root: varin_runtime::catalog::launches::LiveRoot,
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
    #[serde(rename = "content")]
    _untrusted_content: String,
}
#[derive(Deserialize)]
struct Reply {
    status: String,
    plan: Option<Plan>,
    source: Option<Source>,
    snippets: Vec<Snippet>,
    omissions: Omissions,
    stages: Vec<Stage>,
    #[serde(rename = "inferenceReceipts", default)]
    inference_receipts: Vec<InferenceReceipt>,
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

impl NativeToolExecutor {
    pub(super) fn admit_retrieval(
        &self,
        context: &ToolExecutionContext,
        args: &RetrievalQueryArgs,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        self.resources
            .call(
                &self.binding,
                context,
                ResourceOperation::RetrievalQuery(args.clone()),
                true,
                cancel,
            )
            .map(|_| ())
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
                    Some("failed") => Outcome::Failed,
                    _ => Outcome::Succeeded,
                },
                effect: Effect::None,
                content,
            },
            Err(error) => ToolCompletion::Result {
                outcome: if cancel.is_cancelled() {
                    Outcome::Cancelled
                } else {
                    Outcome::Failed
                },
                effect: Effect::None,
                content: json!({"status":if cancel.is_cancelled() {"cancelled"} else {"unavailable"},
                    "error":error.code,"message":"Code retrieval could not provide a verified result"}),
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
        self.admit_retrieval(context, args, cancel)?;
        let bridge = self.retrieval.as_ref().ok_or_else(|| {
            ExecutionError::new(
                "retrieval_owner_unavailable",
                "Retrieval owner is not connected",
            )
        })?;
        // These identities already belong to the committed model exchange or policy graph.
        // Recovery reuses them; the private bridge's random request ID is transport-only.
        let invocation = match &context.origin {
            ToolOrigin::ModelStep { request_id } => {
                json!({"kind":"model_step", "requestId":request_id,
                "toolCallId":call.call_id})
            }
            ToolOrigin::PolicyAction { action_id, node_id } => {
                json!({"kind":"policy_action", "actionId":action_id,
                "nodeId":node_id, "toolCallId":call.call_id})
            }
        };
        let mut query = json!({"invocation":invocation,"runId":self.binding.run_id,"threadId":self.binding.thread_id,
            "workspaceId":self.binding.workspace_id,"executionWorkspaceId":self.binding.execution_workspace_id,
            "liveRoot":self.binding.live_root,"grantId":self.binding.grant_id,"projectId":self.retrieval_project_id,"question":args.question});
        if let Some(paths) = &args.paths {
            query["paths"] = json!(paths);
        }
        if let Some(limit) = args.limit {
            query["limit"] = json!(limit);
        }
        let raw = bridge.query(query, cancel)?;
        let mut reply: Reply = serde_json::from_value(raw).map_err(|_| invalid())?;
        if !STATUSES.contains(&reply.status.as_str())
            || !reply.omissions.valid()
            || reply
                .inference_receipts
                .iter()
                .any(|receipt| !receipt.valid())
        {
            return Err(invalid());
        }
        // A revoked Run cannot deliver source, but its already-dispatched nonsecret inference
        // receipt is still an execution fact. Preserve it through failed/cancelled settlement.
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
                || source.mode != "live_root"
                || source.workspace_id != self.binding.workspace_id
                || source.execution_workspace_id != self.binding.execution_workspace_id
                || Some(&source.live_root) != self.binding.live_root.as_ref()
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
        // Reconstructed spans can be much larger than untrusted Host content. Bound the
        // complete projection by the existing wire-derived content budget, reserving 64
        // bytes for three growing safe-integer counters and the final status spelling.
        let metadata_size = serde_json::to_vec(&json!({"status":&reply.status,"snippets":[],
            "plan":&reply.plan,"source":&reply.source,"omissions":&reply.omissions,"stages":&reply.stages,
            "inferenceReceipts":&reply.inference_receipts}))
            .map_err(|_| invalid())?.len();
        let mut output_budget = crate::protocol::MAX_BLOB_RESPONSE_BYTES
            .checked_sub(metadata_size.saturating_add(64))
            .ok_or_else(invalid)?;
        let mut snippets = Vec::new();
        if matches!(reply.status.as_str(), "ready" | "partial") {
            // Cache only the current file: many tiny spans must not retain every full body.
            let mut observation: Option<(String, language::Observation)> = None;
            for item in reply.snippets {
                if cancel.is_cancelled() {
                    reply.status = "cancelled".into();
                    snippets.clear();
                    break;
                }
                if !valid_path(&item.path) || !args.contains(&item.path) {
                    counter(&mut reply.omissions.out_of_scope);
                    continue;
                }
                if args
                    .limit
                    .is_some_and(|limit| snippets.len() as u64 >= limit)
                {
                    continue;
                }
                if observation
                    .as_ref()
                    .is_none_or(|(path, _)| path != &item.path)
                {
                    match self.observe_language_path(context, &item.path, cancel) {
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
                            continue;
                        }
                    }
                }
                let observed = &observation.as_ref().expect("observed current path").1;
                if item.revision != observed.revision {
                    counter(&mut reply.omissions.stale);
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
                        continue;
                    }
                    Span::OverBudget => {
                        counter(&mut reply.omissions.unavailable);
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
                    continue;
                }
                output_budget -= encoded_length;
                snippets.push(snippet);
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
        let mut result = json!({"status":reply.status,"snippets":snippets,"omissions":reply.omissions,"stages":reply.stages});
        if !reply.inference_receipts.is_empty() {
            result["inferenceReceipts"] = json!(reply.inference_receipts);
        }
        if let Some(plan) = reply.plan {
            result["plan"] = json!(plan);
        }
        if let Some(source) = reply.source {
            result["source"] = json!(source);
        }
        Ok(result)
    }
}
