//! Executable summarization over a frozen sequence of source excerpts.
//! Normal Runs/ModelSteps own request dispatch and original output durability.
use crate::execution::*;
use crate::supervisor::RunStart;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ContextBudgetStrategy {
    Builtin {
        name: String,
        version: String,
    },
    Extension {
        provider_key: String,
        extension_id: String,
        extension_version: String,
        artifact_integrity: String,
        service_version: u64,
        configuration_identity: String,
        name: String,
        version: String,
    },
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ContextCompactionMode {
    Manual,
    Background,
    Blocking,
}
/// Immutable recipe owned by the original ContextJob, never a live extension authorization.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextSummaryRecipe {
    pub strategy: ContextBudgetStrategy,
    pub mode: ContextCompactionMode,
    #[serde(deserialize_with = "required_text")]
    pub configuration_identity: Option<String>,
    #[serde(deserialize_with = "required_text")]
    pub additional_instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation_budget_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_instructions: Option<String>,
    /// Original manual caller selection, before applying the configured context Agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_model: Option<Value>,
}
fn required_text<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}
impl ContextSummaryRecipe {
    pub fn manual() -> Self {
        Self {
            strategy: ContextBudgetStrategy::Builtin {
                name: "manual".into(),
                version: "1".into(),
            },
            mode: ContextCompactionMode::Manual,
            configuration_identity: None,
            additional_instructions: None,
            continuation_budget_tokens: None,
            agent_instructions: None,
            requested_model: None,
        }
    }
    pub fn automatic(configuration_identity: String, mode: ContextCompactionMode) -> Self {
        Self {
            strategy: ContextBudgetStrategy::Builtin {
                name: "capacity".into(),
                version: "1".into(),
            },
            mode,
            configuration_identity: Some(configuration_identity),
            additional_instructions: None,
            continuation_budget_tokens: None,
            agent_instructions: None,
            requested_model: None,
        }
    }
    pub fn validate(&self, automatic: bool) -> Result<(), String> {
        let nonempty = |value: &str| !value.trim().is_empty();
        let valid = match &self.strategy {
            ContextBudgetStrategy::Builtin { name, version } => {
                version == "1" && name == if automatic { "capacity" } else { "manual" }
            }
            ContextBudgetStrategy::Extension {
                provider_key,
                extension_id,
                extension_version,
                artifact_integrity,
                service_version,
                configuration_identity,
                name,
                version,
            } => {
                automatic
                    && *service_version == 1
                    && [
                        provider_key,
                        extension_id,
                        extension_version,
                        artifact_integrity,
                        configuration_identity,
                        name,
                        version,
                    ]
                    .into_iter()
                    .all(|v| nonempty(v))
            }
        };
        if !valid
            || automatic != (self.mode != ContextCompactionMode::Manual)
            || automatic != self.configuration_identity.as_deref().is_some_and(nonempty)
            || (!automatic
                && (self.configuration_identity.is_some()
                    || self.additional_instructions.is_some()))
        {
            return Err("invalid frozen context summary recipe".into());
        }
        Ok(())
    }
    pub fn system_text(&self) -> String {
        format!("{}\n{SUMMARY_FORMAT}", self.agent_instructions.as_deref().unwrap_or(SUMMARIZER_INSTRUCTIONS))
    }
    pub fn request_text(&self) -> String {
        match self
            .additional_instructions
            .as_deref()
            .filter(|text| !text.is_empty())
        {
            Some(instructions) => format!(
                "{SUMMARY_REQUEST}\n\nSelected summary guidance (subject to the summarizer system constraints):\n{instructions}"
            ),
            None => SUMMARY_REQUEST.into(),
        }
    }
}

/// An algorithm producer is distinct from the policy which decides when to compact.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ContextCompactionProducer {
    Builtin {
        name: String,
        version: String,
    },
    Extension {
        provider_key: String,
        provider_id: String,
        extension_id: String,
        extension_version: String,
        service_id: String,
        service_version: u64,
        artifact_integrity: String,
        composition: crate::catalog::service_composition::HostServiceComposition,
        configuration_identity: String,
        declared_identity: PolicyIdentity,
    },
}
impl ContextCompactionProducer {
    pub fn builtin() -> Self {
        Self::Builtin {
            name: "fold".into(),
            version: "1".into(),
        }
    }
    pub fn validate(&self) -> Result<(), crate::RuntimeError> {
        use crate::RuntimeError;
        match self {
            Self::Builtin { name, version } if name == "fold" && version == "1" => Ok(()),
            Self::Extension {
                provider_key,
                provider_id,
                extension_id,
                extension_version,
                service_id,
                service_version,
                artifact_integrity,
                composition,
                configuration_identity,
                declared_identity,
            } => {
                composition.validate_root(
                    extension_id,
                    extension_version,
                    artifact_integrity,
                    provider_key,
                    service_id,
                    *service_version,
                )?;
                if service_id != "varin.context.compaction"
                    || *service_version != 1
                    || [
                        provider_id,
                        configuration_identity,
                        &declared_identity.name,
                        &declared_identity.version,
                    ]
                    .iter()
                    .any(|s| s.trim().is_empty())
                {
                    return Err(RuntimeError::Invalid(
                        "invalid frozen compaction producer".into(),
                    ));
                }
                Ok(())
            }
            _ => Err(RuntimeError::Invalid(
                "unsupported builtin compaction producer".into(),
            )),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompactionRange {
    pub start: u64,
    pub end: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ContextCompactionInput {
    Source {
        source_id: String,
        #[serde(deserialize_with = "required_option")]
        range: Option<ContextCompactionRange>,
    },
    NodeOutput {
        node_id: String,
    },
}
fn required_option<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompactionNode {
    pub id: String,
    #[serde(deserialize_with = "required_text")]
    pub instructions: Option<String>,
    pub inputs: Vec<ContextCompactionInput>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ContextCompactionPlan {
    Text {
        source_cut_hash: String,
        text: String,
    },
    ModelPlan {
        source_cut_hash: String,
        nodes: Vec<ContextCompactionNode>,
        final_node_id: String,
    },
}
impl ContextCompactionPlan {
    pub fn source_cut_hash(&self) -> &str {
        match self {
            Self::Text {
                source_cut_hash, ..
            }
            | Self::ModelPlan {
                source_cut_hash, ..
            } => source_cut_hash,
        }
    }
    pub fn kind(&self) -> &'static str {
        if matches!(self, Self::Text { .. }) {
            "text"
        } else {
            "model_plan"
        }
    }
    pub fn nodes(&self) -> &[ContextCompactionNode] {
        match self {
            Self::ModelPlan { nodes, .. } => nodes,
            _ => &[],
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompactionCandidate {
    pub producer: ContextCompactionProducer,
    pub plan: ContextCompactionPlan,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompactionSource {
    pub source_id: String,
    pub item: ConversationItem,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompactionModelBudget {
    pub context_window_tokens: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub source_budget_tokens: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompactionPreview {
    pub source_cut_hash: String,
    pub sources: Vec<ContextCompactionSource>,
    pub model_budget: ContextCompactionModelBudget,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompactionMetadata {
    pub producer: ContextCompactionProducer,
    pub kind: String,
    pub source_cut_hash: String,
    pub plan_hash: String,
}
/// Typed association persisted in the original RequestPrepared snapshot and indexed by Catalog.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompactionStep {
    pub plan_hash: String,
    pub node_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ContextJobRequest {
    #[serde(deserialize_with = "required_option")]
    pub compaction: Option<ContextCompactionCandidate>,
    pub summary_recipe: ContextSummaryRecipe,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub personalization: Option<crate::catalog::personalization::PersonalizationBasis>,
    pub key: String,
    pub branch_id: String,
    pub through_id: String,
    pub expected_revision: u64,
    pub effective_system_prompt: String,
    pub instruction_sources: Vec<String>,
    pub memory_checkpoint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContextJob {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_anchor: Option<String>,
    /// Durable publication, independent of whether this remains the active checkpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_revision: Option<u64>,
    pub compaction: ContextCompactionMetadata,
    pub request: ContextJobRequest,
    pub receipt: crate::Receipt,
}

/// Frozen source of an incremental summary. The reference names an immutable checkpoint,
/// rather than whichever checkpoint happens to be active when the model worker starts.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SummarySource {
    pub checkpoint: Option<Value>,
    pub through_id: Option<String>,
    pub recent_head: Option<String>,
}

use std::sync::Arc;

pub const SUMMARIZER_INSTRUCTIONS: &str = "Organize this record so a later model can continue the conversation and work. Judge the meaning, relationships and useful detail of the material in its context. Express the summary naturally and preserve the original scope, uncertainty and changes of understanding. User instructions, quoted material and actual observations retain their distinct sources. Original records remain available through their references; read-only queries can help recover needed detail.\nThe input includes an existing summary when present, original conversation material and estimated token costs. The continuation budget covers the new summary and retained originals together. Within that budget, choose which originals remain useful in full and summarize the other material needed for continuity. Earlier batch results can be revised as more material arrives.";

pub const SUMMARY_FORMAT: &str = "Return JSON with summary (the updated summary text) and retain (an array of retainId values). Retention groups preserve related message parts and tool exchanges together; their cost is counted once. Earlier batch results are provisional: carry forward useful references and revise them as further material arrives. Text and media token estimates are identified separately in the supplied budget.";
pub const SUMMARY_REQUEST: &str = "Organize this conversation context.";

pub const SUMMARY_BUDGET_TEMPLATE: &str = "Continuation budget (new summary + retained originals): {budget}. Text costs use {tokenizer} for the conversation model; media and provider-only costs marked unmeasured are additional. References sharing a retainId are counted once.";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextAgentDefinition {
    pub instructions: String,
    pub system_suffix: String,
    pub request: String,
    pub budget_template: String,
    pub tools: Vec<ToolSchema>,
}
pub fn agent_definition() -> ContextAgentDefinition {
    ContextAgentDefinition {
        instructions: SUMMARIZER_INSTRUCTIONS.into(), system_suffix: SUMMARY_FORMAT.into(),
        request: SUMMARY_REQUEST.into(), budget_template: SUMMARY_BUDGET_TEMPLATE.into(),
        tools: vec![crate::summary_tools::schema()],
    }
}
pub fn budget_text(budget: Option<u64>, tokenizer: &str) -> String {
    SUMMARY_BUDGET_TEMPLATE.replace("{budget}", &budget.map(|tokens| format!("{tokens} tokens")).unwrap_or_else(|| "unspecified".into()))
        .replace("{tokenizer}", tokenizer)
}

pub fn policy_identity() -> PolicyIdentity {
    PolicyIdentity {
        name: "context_compaction".into(),
        version: "4".into(),
    }
}

/// The caller supplies an explicitly selected, authenticated model binding. This function never
/// chooses a model, resolves credentials, starts a worker, or makes a provider request.
pub struct ContextCompactionExecution {
    pub plan: ContextCompactionPlan,
    pub model_budget: ContextCompactionModelBudget,
}
pub fn configure_compaction_start(
    mut start: RunStart,
    execution: ContextCompactionExecution,
) -> RunStart {
    let ContextCompactionExecution { plan, model_budget } = execution;
    start.context_preparation = Arc::new(SummaryCapacity(model_budget));
    start.binding.tools = if matches!(plan, ContextCompactionPlan::Text { .. }) {Vec::new()} else {vec![crate::summary_tools::schema()]};
    start.binding.tool_schema_generation = 0;
    start.provider = if matches!(plan, ContextCompactionPlan::Text { .. }) {
        Arc::new(NoModelProvider)
    } else {
        Arc::new(SummaryProvider(start.provider))
    };
    start.policy = Arc::new(SummaryPolicy);
    start.policy_state = Value::Null;
    start
}
/// Check the complete actual serializer output before RequestPrepared. Summary plans cannot
/// recursively launch more compaction or silently drop evidence to repair an oversized node.
struct SummaryCapacity(ContextCompactionModelBudget);
impl ContextPreparation for SummaryCapacity {
    fn prepare(&self, _: &str, _: u64, _: &CancellationToken) -> Result<(), ExecutionError> {
        Ok(())
    }
    fn prepare_request(
        &self,
        _: u64,
        view: &RequestView,
        serialized: &RequestBody,
        _: Option<crate::context_capacity::RequestBudgetProtocol>,
        _: &dyn Fn(
            ContextProjection,
        ) -> Result<crate::context_capacity::InputEstimate, ExecutionError>,
        _: &CancellationToken,
    ) -> Result<ContextRequestPreparation, ExecutionError> {
        if let Some(window) = self.0.context_window_tokens {
            let available = window.saturating_sub(self.0.max_output_tokens.unwrap_or(0));
            let estimate = crate::context_capacity::estimate_request(view, serialized);
            if estimate.estimated_tokens > available {
                return Err(ExecutionError::new(
                    "context_capacity",
                    "complete summary node input exceeds the selected model capacity",
                ));
            }
        }
        Ok(ContextRequestPreparation::Ready)
    }
}
struct SummaryProvider(Arc<dyn ModelProvider>);
impl ModelProvider for SummaryProvider {
    fn retry_policy(&self) -> crate::model_retry::RetryPolicy {
        self.0.retry_policy()
    }
    fn request_budget_protocol(&self) -> Option<crate::context_capacity::RequestBudgetProtocol> {
        self.0.request_budget_protocol()
    }

    fn serialize(&self, view: &RequestView, reuse: Option<&mut RequestCompileReuse>) -> Result<RequestBody, ExecutionError> {
        if view.binding.tools.iter().any(|tool|tool != &crate::summary_tools::schema()) {
            return Err(ExecutionError::new(
                "compaction_tools",
                "summary query declaration differs from its read-only capability",
            ));
        }
        self.0.serialize(view, reuse)
    }
    fn serialize_cancellable(&self, view: &RequestView, reuse: Option<&mut RequestCompileReuse>, cancel: &CancellationToken) -> Result<RequestBody, ExecutionError> {
        if view.binding.tools.iter().any(|tool|tool != &crate::summary_tools::schema()) { return Err(ExecutionError::new("compaction_tools", "summary query declaration differs from its read-only capability")); }
        self.0.serialize_cancellable(view, reuse, cancel)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let mut invalid = false;
        let mut has_text = false;
        let result = self.0.generate(request, cancel, &mut |event| {
            if let ProviderEvent::ItemCompleted { item } = &event {
                match &item.content {
                    Content::ToolCall { call } if call.name != "summary_read" => invalid = true,
                    Content::ToolResult { .. }
                    | Content::Media { .. }
                    | Content::Output { .. } => invalid = true,
                    Content::Text { text } => has_text |= !text.trim().is_empty(),
                    _ => (),
                }
            }
            // Retain complete original items through the existing ModelFinished record even if
            // this candidate is unusable. No tool executes before generation is validated.
            emit(event)
        });
        let reason = result?;
        if invalid || !matches!(reason,FinishReason::ToolCalls | FinishReason::Stop) || reason == FinishReason::Stop && !has_text {
            return Err(ModelFailure {
                tool_name: None,
                code: "invalid_compaction_output".into(),
                message: "summary generation did not produce a read-only query or complete textual answer"
                    .into(),
                retry_after_ms: None,
                provider_request_id: None,
            });
        }
        Ok(reason)
    }
}
struct SummaryPolicy;
impl AgentPolicy for SummaryPolicy {
    fn identity(&self) -> PolicyIdentity { policy_identity() }
    fn decide(&self, _: &PolicyView<'_>, _: &PolicyEvent, _: &Value, _: &CancellationToken) -> Result<PolicyDecision, ExecutionError> {
        Err(ExecutionError::new("context_job_execution_required", "ContextJobs execute their frozen plan through the Run supervisor"))
    }
}
/// Text candidates never bind a model adapter, resolve credentials, serialize, or dispatch.
pub struct NoModelProvider;
impl ModelProvider for NoModelProvider {
    fn serialize(&self, _: &RequestView, _: Option<&mut RequestCompileReuse>) -> Result<RequestBody, ExecutionError> {
        Err(ExecutionError::new(
            "compaction_no_model",
            "text compaction has no model provider",
        ))
    }
    fn generate(
        &self,
        _: &RequestSnapshot,
        _: &CancellationToken,
        _: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        Err(ModelFailure {
            tool_name: None,
            code: "compaction_no_model".into(),
            message: "text compaction has no model provider".into(),
            retry_after_ms: None,
            provider_request_id: None,
        })
    }
}
/// Non-dispatching identity for a description-only text job. No adapter or credential owner runs.
pub fn text_compaction_launch(
    configuration: &Value,
    scope: Option<crate::providers::auth::CredentialScope>,
) -> Result<crate::catalog::launches::LaunchSelection, crate::RuntimeError> {
    let model = configuration
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.trim().is_empty())
        .ok_or_else(|| {
            crate::RuntimeError::Invalid(
                "summary model description requires a model identity".into(),
            )
        })?;
    Ok(crate::catalog::launches::LaunchSelection {
        agent: None,
        child_dispatch: None,
        policy_models: Vec::new(),
        extension_bindings: Vec::new(),
        mcp_binding: None,
        credential_scope: scope,
        connection_identity: crate::context_material::hash(configuration)?,
        provider_family: "context_compaction_text".into(),
        model: model.into(),
        configuration_generation: 0,
        tool_schema_generation: 0,
        tools: Vec::new(),
        policy: policy_identity(),
        source: None,
    })
}
pub fn text_compaction_start(selection: &crate::catalog::launches::LaunchSelection) -> RunStart {
    RunStart {
        context_preparation: Arc::new(NoopContextPreparation),
        binding: RequestBinding { tool_output_visible_bytes: None, mcp_tools: Vec::new(), execution_environment: None, direct_tools: None,
            provider_id: None,
            tokenizer: None,
            request_context: None,
            child_dispatch: None,
            goal: None,
            resource_activations: Vec::new(),
            resource_checkpoint_id: None,
            connection_identity: selection.connection_identity.clone(),
            provider_family: selection.provider_family.clone(),
            model: selection.model.clone(),
            credential_ref: selection
                .credential_scope
                .as_ref()
                .map(|scope| scope.reference.clone()),
            configuration_generation: selection.configuration_generation,
            tool_schema_generation: 0,
            tools: Vec::new(),
            instruction_sources: Vec::new(),
            memory_checkpoint: None,
            attachment_refs: Vec::new(),
            environment_cursor: 0,
            history_range: HistoryRange {
                branch_id: String::new(),
                ancestor_id: None,
                leaf_id: None,
            },
        },
        provider: Arc::new(NoModelProvider),
        tools: Arc::new(NoTools),
        policy: Arc::new(SummaryPolicy),
        policy_state: Value::Null,
        progress: ProgressSink::default(),
    }
}
struct NoTools;
impl ToolExecutor for NoTools {
    fn plan(
        &self,
        call: &crate::execution::ToolCall,
        context: &crate::execution::FrozenToolContext,
        cancel: &crate::execution::CancellationToken,
    ) -> Result<crate::execution::ToolPreparation, crate::execution::ExecutionError> {
        self.prepare(call, context, cancel)
            .map(crate::execution::ToolPreparation::Ready)
    }

    fn prepare(
        &self,
        _: &ToolCall,
        _: &FrozenToolContext,
        _cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        Err(ExecutionError::new(
            "compaction_tools",
            "summary jobs cannot prepare tools",
        ))
    }
    fn authorize(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        Err(ExecutionError::new(
            "compaction_tools",
            "summary jobs cannot authorize tools",
        ))
    }
    fn execute(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        ToolCompletion::NotDispatched {
            reason: "summary jobs have no tool executor".into(),
            error: None,
        }
    }
}
