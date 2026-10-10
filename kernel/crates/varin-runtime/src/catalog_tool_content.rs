//! Frozen tool arguments are immutable content; control transitions use their identities.
use super::*;
use crate::execution::{AdmittedTool, ToolCall, ToolContract};
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ToolCallMetadata {
    pub call_id: String,
    pub name: String,
    pub schema_version: String,
    pub arguments_ref: Value,
}
impl ToolCallMetadata {
    pub(crate) fn write(content: &crate::content::ContentStore, call: &ToolCall) -> Result<Self> {
        Ok(Self {
            call_id: call.call_id.clone(),
            name: call.name.clone(),
            schema_version: call.schema_version.clone(),
            arguments_ref: content.save(&call.arguments)?,
        })
    }
    pub(crate) fn load(self, content: &crate::content::ContentStore) -> Result<ToolCall> {
        Ok(ToolCall {
            call_id: self.call_id,
            name: self.name,
            schema_version: self.schema_version,
            arguments: content.load(&self.arguments_ref)?,
        })
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ToolIntent {
    Tool {
        call: ToolCallMetadata,
        contract: ToolContract,
    },
}
impl ToolIntent {
    pub fn fingerprint(call: &ToolCall, contract: &ToolContract) -> Result<Self> {
        Ok(Self::Tool {
            call: ToolCallMetadata {
                call_id: call.call_id.clone(),
                name: call.name.clone(),
                schema_version: call.schema_version.clone(),
                arguments_ref: crate::content::ContentStore::reference(&call.arguments)?,
            },
            contract: contract.clone(),
        })
    }
    pub fn call(&self) -> &ToolCallMetadata {
        let Self::Tool { call, .. } = self;
        call
    }
    pub fn contract(&self) -> &ToolContract {
        let Self::Tool { contract, .. } = self;
        contract
    }
    pub fn from_operation(operation: &Operation) -> Result<Self> {
        Ok(serde_json::from_value(operation.intent.clone())?)
    }
    pub(crate) fn write(
        content: &crate::content::ContentStore,
        tool: &AdmittedTool,
    ) -> Result<Self> {
        Ok(Self::Tool {
            call: ToolCallMetadata::write(content, &tool.call)?,
            contract: tool.contract.clone(),
        })
    }
    pub(crate) fn load(self, content: &crate::content::ContentStore) -> Result<AdmittedTool> {
        let Self::Tool { call, contract } = self;
        Ok(AdmittedTool {
            call: call.load(content)?,
            contract,
        })
    }
}
pub struct ToolIntentPreparation {
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedToolIntent {
    intent: ToolIntent,
    _publication: crate::content::ContentPublication,
}
impl ToolIntentPreparation {
    pub fn load(self, tool: &AdmittedTool) -> Result<PreparedToolIntent> {
        Ok(PreparedToolIntent {
            intent: ToolIntent::write(&self.content, tool)?,
            _publication: self.publication,
        })
    }
}
pub struct OperationRead {
    operation: Operation,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct ModelStepRead {
    pub metadata: ModelStep,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl ModelStepRead {
    pub fn load_request(self) -> Result<Value> {
        self.content.load(&self.metadata.request)
    }
    pub fn load(self) -> Result<ModelStep> {
        let mut step = self.metadata;
        step.request = self.content.load(&step.request)?;
        self.content.hydrate_originals(&mut step.original)?;
        Ok(step)
    }
}
impl OperationRead {
    pub fn load(mut self) -> Result<Operation> {
        if self.operation.intent.get("kind").and_then(Value::as_str) == Some("tool") {
            let intent = ToolIntent::from_operation(&self.operation)?.load(&self.content)?;
            self.operation.intent = serde_json::to_value(intent)?;
        }
        if let Some(permission) = self
            .operation
            .result
            .as_mut()
            .and_then(|result| result.get_mut("permission"))
        {
            let call = self.content.load(&permission["call_ref"])?;
            let scope = self.content.load(&permission["scope_ref"])?;
            let record = permission
                .as_object_mut()
                .ok_or_else(|| RuntimeError::Invalid("permission record is malformed".into()))?;
            record.remove("call_ref");
            record.remove("scope_ref");
            record.insert("call".into(), call);
            record.insert("scope".into(), scope);
        }
        Ok(self.operation)
    }
}
impl Catalog {
    pub fn model_step_metadata(&self, id: &str) -> Result<ModelStep> {
        record(&self.db, "model_steps", id)
    }
    pub fn capture_model_step_read(&self, id: &str) -> Result<ModelStepRead> {
        Ok(ModelStepRead {
            metadata: self.model_step_metadata(id)?,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn capture_operation_read(&self, operation: Operation) -> OperationRead {
        OperationRead {
            operation,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        }
    }
    pub fn prepare_tool_intent(&self) -> ToolIntentPreparation {
        ToolIntentPreparation {
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        }
    }
    pub fn admit_tool_operation(
        &mut self,
        key: &str,
        run_id: &str,
        epoch: u64,
        tool: &AdmittedTool,
    ) -> Result<Operation> {
        let prepared = self.prepare_tool_intent().load(tool)?;
        self.admit_tool_operation_prepared(key, run_id, epoch, prepared)
    }
    pub fn admit_tool_operation_prepared(
        &mut self,
        key: &str,
        run_id: &str,
        epoch: u64,
        prepared: PreparedToolIntent,
    ) -> Result<Operation> {
        self.admit_operation_metadata(
            key,
            run_id,
            epoch,
            prepared.intent.contract().lifetime,
            serde_json::to_value(&prepared.intent)?,
        )
    }
}
