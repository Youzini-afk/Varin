//! Immutable action bodies are prepared outside Catalog. Control records contain only ownership.
use super::*;
use crate::execution::*;
use serde::Deserialize;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum PolicyActionMetadata {
    PolicyReadGraphV1 {
        action_id: String,
        boundary: PolicyBoundary,
        identity: PolicyIdentity,
        body_ref: Value,
        node_count: usize,
    },
    PolicyModelJobV1 {
        action_id: String,
        boundary: PolicyBoundary,
        identity: PolicyIdentity,
        body_ref: Value,
    },
}
impl PolicyActionMetadata {
    pub fn identity(&self) -> &PolicyIdentity {
        match self {
            Self::PolicyReadGraphV1 { identity, .. } | Self::PolicyModelJobV1 { identity, .. } => {
                identity
            }
        }
    }
    pub fn action_id(&self) -> &str {
        match self {
            Self::PolicyReadGraphV1 { action_id, .. }
            | Self::PolicyModelJobV1 { action_id, .. } => action_id,
        }
    }
    pub fn body_ref(&self) -> &Value {
        match self {
            Self::PolicyReadGraphV1 { body_ref, .. } | Self::PolicyModelJobV1 { body_ref, .. } => {
                body_ref
            }
        }
    }
    pub fn boundary(&self) -> &PolicyBoundary {
        match self {
            Self::PolicyReadGraphV1 { boundary, .. } | Self::PolicyModelJobV1 { boundary, .. } => {
                boundary
            }
        }
    }
    pub fn graph_nodes(&self) -> Option<usize> {
        match self {
            Self::PolicyReadGraphV1 { node_count, .. } => Some(*node_count),
            _ => None,
        }
    }
    pub fn from_operation(op: &Operation) -> Result<Option<Self>> {
        let kind = op.intent.get("kind").and_then(Value::as_str).unwrap_or("");
        if !kind.starts_with("policy_read_graph") && !kind.starts_with("policy_model_job") {
            return Ok(None);
        }
        let metadata: Self = serde_json::from_value(op.intent.clone())?;
        let executor = if metadata.graph_nodes().is_some() {
            "policy-read-graph.v1"
        } else {
            "policy-model.v1"
        };
        if op.id != metadata.action_id()
            || op.lifetime != Lifetime::Run
            || op.effect != Effect::None
            || op.executor.as_deref() != Some(executor)
            || metadata.graph_nodes() == Some(0)
        {
            return Err(RuntimeError::Invalid(
                "policy action owner is malformed".into(),
            ));
        }
        Ok(Some(metadata))
    }
    pub fn load_graph(
        &self,
        content: &crate::content::ContentStore,
        run_id: &str,
    ) -> Result<PolicyGraphIntent> {
        let body: PolicyGraphBody = serde_json::from_value(content.load(self.body_ref())?)?;
        if &body.action_id != self.action_id()
            || &body.boundary != self.boundary()
            || &body.identity != self.identity()
            || self.graph_nodes() != Some(body.nodes.len())
        {
            return Err(RuntimeError::Invalid(
                "policy graph body differs from its owner".into(),
            ));
        }
        let tools = Arc::new(body.tools);
        Ok(PolicyGraphIntent::PolicyReadGraphV1 {
            action_id: body.action_id.clone(),
            boundary: body.boundary,
            identity: body.identity,
            state: body.state,
            nodes: body
                .nodes
                .into_iter()
                .map(|node| PolicyAdmittedNode {
                    context: FrozenToolContext {
                        run_id: run_id.into(),
                        origin: ToolOrigin::PolicyAction {
                            action_id: body.action_id.clone(),
                            node_id: node.node.id.clone(),
                        },
                        tools: tools.clone(),
                        tool_schema_generation: node.tool_schema_generation,
                        source: node.source,
                    },
                    node: node.node,
                    contract: node.contract,
                })
                .collect(),
        })
    }
    pub fn load_model(&self, content: &crate::content::ContentStore) -> Result<PolicyModelIntent> {
        let intent: PolicyModelIntent = serde_json::from_value(content.load(self.body_ref())?)?;
        let PolicyModelIntent::PolicyModelJobV1 { boundary, .. } = &intent;
        if self.graph_nodes().is_some()
            || intent.action_id() != self.action_id()
            || boundary != self.boundary()
            || intent.checkpoint().0 != self.identity()
        {
            return Err(RuntimeError::Invalid(
                "policy model body differs from its owner".into(),
            ));
        }
        Ok(intent)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PolicyGraphBody {
    pub action_id: String,
    pub boundary: PolicyBoundary,
    pub identity: PolicyIdentity,
    pub state: Value,
    pub tools: Vec<ToolSchema>,
    pub nodes: Vec<PolicyGraphNodeBody>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PolicyGraphNodeBody {
    pub node: PolicyReadNode,
    pub tool_schema_generation: u64,
    pub source: Option<super::launches::SourceSelection>,
    pub contract: ToolContract,
}
impl PolicyGraphBody {
    pub fn prepare(intent: &PolicyGraphIntent) -> Result<(Self, String)> {
        let PolicyGraphIntent::PolicyReadGraphV1 {
            action_id,
            boundary,
            identity,
            state,
            nodes,
        } = intent;
        validate_policy_nodes(
            &nodes
                .iter()
                .map(|node| node.node.clone())
                .collect::<Vec<_>>(),
        )
        .map_err(|error| RuntimeError::Invalid(error.to_string()))?;
        let first = &nodes[0].context;
        for node in nodes {
            if node.context.run_id != first.run_id
                || node.context.tools != first.tools
                || node.context.origin
                    != (ToolOrigin::PolicyAction {
                        action_id: action_id.clone(),
                        node_id: node.node.id.clone(),
                    })
                || !node.contract.read_only
                || node.contract.completion != CompletionKind::Result
                || node.contract.name != node.node.call.name
                || node.contract.schema_version != node.node.call.schema_version
                || node
                    .contract
                    .resources
                    .iter()
                    .any(|resource| resource.access != Access::Read)
                || !first.tools.iter().any(|schema| {
                    schema.name == node.node.call.name
                        && schema.version == node.node.call.schema_version
                })
            {
                return Err(RuntimeError::Invalid(
                    "policy graph node contract is malformed".into(),
                ));
            }
        }
        Ok((
            Self {
                action_id: action_id.clone(),
                boundary: boundary.clone(),
                identity: identity.clone(),
                state: state.clone(),
                tools: first.tools.as_ref().clone(),
                nodes: nodes
                    .iter()
                    .map(|node| PolicyGraphNodeBody {
                        node: node.node.clone(),
                        tool_schema_generation: node.context.tool_schema_generation,
                        source: node.context.source.clone(),
                        contract: node.contract.clone(),
                    })
                    .collect(),
            },
            first.run_id.clone(),
        ))
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PolicyGraphProgress {
    pub settled: usize,
    pub failed: usize,
    pub cancelled: usize,
}
impl PolicyGraphProgress {
    pub fn read(op: &Operation, metadata: &PolicyActionMetadata) -> Result<Self> {
        let progress: Self =
            serde_json::from_value(op.result.clone().ok_or_else(|| {
                RuntimeError::Invalid("policy graph progress is missing".into())
            })?)?;
        if progress.failed + progress.cancelled > progress.settled
            || progress.settled > metadata.graph_nodes().unwrap_or(0)
            || (op.phase == OperationPhase::Terminal)
                != (Some(progress.settled) == metadata.graph_nodes())
        {
            return Err(RuntimeError::Invalid(
                "policy graph terminal progress mismatch".into(),
            ));
        }
        Ok(progress)
    }
}
