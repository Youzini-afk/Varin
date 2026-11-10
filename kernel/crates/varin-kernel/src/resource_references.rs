//! Typed native resource bindings in the original Catalog. Never inspect arbitrary
//! output JSON, command text or user prose for identifiers.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use varin_runtime::{Catalog, catalog::{launches::SourceSelection, model_references::ReferenceKind}, execution::ExecutionError};

fn error(value: impl ToString) -> ExecutionError {
    ExecutionError::new("resource_reference", value.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase", deny_unknown_fields)]
pub(crate) enum FileTarget {
    Observation { source: SourceSelection, path: String, read_version: String, format: Option<crate::text::Format> },
    Attachment { reference: String },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProcessTarget { pub operation_id: String }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadTarget {
    pub tool: String,
    pub source: Option<SourceSelection>,
    pub arguments: Value,
}

pub(crate) fn register<T: Serialize>(catalog: &mut Catalog, kind: ReferenceKind, owner: &str, target: &T, holder: &str) -> Result<String, ExecutionError> {
    catalog.register_model_reference(kind, owner, &serde_json::to_value(target).map_err(error)?, holder).map_err(error)
}
pub(crate) fn resolve<T: serde::de::DeserializeOwned>(catalog: &Catalog, kind: ReferenceKind, reference: &str) -> Result<T, ExecutionError> {
    serde_json::from_value(catalog.resolve_model_reference(kind, reference).map_err(error)?.target).map_err(error)
}
pub(crate) fn owner(source: &SourceSelection) -> String {
    // The index belongs to this Catalog; the original Host/resource owner stays
    // part of both the key and the typed source. No process-local alias table.
    serde_json::to_string(&source.resource_owner).expect("typed source owner")
}
pub(crate) fn require_source(expected: &SourceSelection, actual: &SourceSelection) -> Result<(), ExecutionError> {
    if expected != actual {
        return Err(ExecutionError::new("reference_source_changed", "This reference belongs to a different file source. Use its original source, or read the path in the current source to select a new observation."));
    }
    Ok(())
}
pub(crate) fn process(catalog: &Catalog, reference: &str) -> Result<String, ExecutionError> {
    catalog.resolve_managed_process_reference(reference).map_err(error)
}
pub(crate) fn continuation(catalog: &mut Catalog, owner: &str, tool: &str, source: Option<SourceSelection>, arguments: Value, holder: &str) -> Result<Value, ExecutionError> {
    let reference = register(catalog, ReferenceKind::Read, owner, &ReadTarget {tool:tool.into(),source,arguments}, holder)?;
    Ok(json!({"tool":tool,"arguments":{"ref":reference}}))
}
