//! Model-facing projections only. Catalog/Storage snapshots and native recovery
//! receipts retain their exact platform metadata.
use serde_json::{json, Value};

pub fn project_tool_file_state(state: &mut Value) {
    if let Some(fields) = state.as_object_mut() { fields.remove("native"); }
}

pub fn project_tool_evidence(evidence: &mut Value) {
    match evidence["kind"].as_str() {
        Some("file") => project_tool_file_state(&mut evidence["state"]),
        Some("any" | "all") => {
            if let Some(sources) = evidence["sources"].as_array_mut() {
                for source in sources { project_tool_evidence(&mut source["evidence"]); }
            }
        }
        _ => (),
    }
}

fn occurrence(value: &mut Value) {
    if let Some(evidence) = value.get_mut("evidence") { project_tool_evidence(evidence); }
}

fn followup(value: &mut Value) {
    if let Some(sources) = value.get_mut("sources").and_then(Value::as_array_mut) {
        for source in sources {
            if let Some(file) = source.get_mut("file").filter(|file| file.is_object()) {
                let before = &file["baseline"];
                let after = &file["current"];
                if before.is_object() && after.is_object() {
                    let changes: Vec<_> = [
                        ("kind", before["kind"] != after["kind"]),
                        ("content", before["objectHash"] != after["objectHash"] || before["symlinkTarget"] != after["symlinkTarget"]),
                        ("permissions", before["mode"] != after["mode"] || before["native"]["security"] != after["native"]["security"]
                            || before["native"]["uid"] != after["native"]["uid"] || before["native"]["gid"] != after["native"]["gid"]),
                        ("metadata", before["native"] != after["native"]),
                    ].into_iter().filter_map(|(label, changed)| changed.then_some(label)).collect();
                    file["changes"] = json!(changes);
                }
                for key in ["baseline", "current"] {
                    if let Some(state) = file.get_mut(key) { project_tool_file_state(state); }
                }
            }
            if let Some(evidence) = source.get_mut("observed").and_then(|v| v.get_mut("evidence")) {
                project_tool_evidence(evidence);
            }
        }
    }
    if let Some(item) = value.get_mut("occurrence") { occurrence(item); }
}

/// Known follow_up response shapes; never traverse arbitrary tool/document data.
pub fn project_tool_followups(value: &mut Value) {
    if let Some(items) = value.as_array_mut() {
        for item in items { followup(item); }
    } else {
        if let Some(item) = value.get_mut("followup") { followup(item); }
        if let Some(item) = value.get_mut("occurrence") { occurrence(item); }
        if let Some(items) = value.get_mut("occurrences").and_then(Value::as_array_mut) {
            for item in items { occurrence(item); }
        }
    }
}

/// The continuation needs the triggering fact, not the proof/receipt used to accept it.
/// Only Varin's closed evidence shapes are projected; nested business payloads stay intact.
pub(super) fn continuation_evidence(evidence: &super::TriggerEvidence) -> super::Result<Value> {
    fn project(value: &Value) -> Value {
        let kind = value["kind"].as_str().unwrap_or_default();
        let keys: &[&str] = match kind {
            "plugin_events" => return Value::Null, // The event material supplies this once.
            "metric" => &["fact"],
            "file" => &["condition", "path", "state", "gap", "observed_at_ms"],
            "at" => &["at_ms", "observed_at_ms"],
            "log_literal" => &["stream", "start_offset", "end_offset", "published_bytes"],
            "log_end" => &["stream", "published_bytes"],
            "artifact" => &["fact", "gap"],
            "collection" => &["outcome", "counts", "gap"],
            "process_stopped" | "job_stopped" | "run_completed" | "goal_requested" => &[],
            "any" | "all" => {
                let sources = value["sources"].as_array().into_iter().flatten().map(|source| {
                    json!({"source_index":source["source_index"],"evidence":project(&source["evidence"])})
                }).collect::<Vec<_>>();
                return json!({"kind":kind,"sources":sources});
            }
            _ => return value.clone(),
        };
        let mut result = json!({"kind":kind});
        for key in keys { if let Some(value) = value.get(*key) { result[*key] = value.clone(); } }
        if kind == "file" { project_tool_file_state(&mut result["state"]); }
        if matches!(kind, "log_literal" | "log_end" | "artifact" | "collection") {
            result["operationId"] = value["binding"]["operationId"].clone();
        }
        result
    }
    Ok(project(&serde_json::to_value(evidence)?))
}

pub(super) fn capture_continuation_references(
    catalog: &super::Catalog, evidence: &super::TriggerEvidence, holder: &str,
    references: &mut std::collections::BTreeMap<String, String>,
) -> super::Result<()> {
    use super::TriggerEvidence as E;
    let binding = match evidence {
        E::LogLiteral { binding, .. } | E::LogEnd { binding, .. }
        | E::Artifact { binding, .. } | E::Collection { binding, .. } | E::JobStopped { binding, .. } => Some(binding),
        E::Any { sources } | E::All { sources } => {
            for source in sources {
                let leaf: E = serde_json::from_value(serde_json::to_value(&source.evidence)?)?;
                capture_continuation_references(catalog, &leaf, holder, references)?;
            }
            None
        }
        _ => None,
    };
    if let Some(binding) = binding {
        references.insert(binding.operation_id.clone(), catalog.operation_model_reference(&binding.operation_id, holder)?);
    }
    Ok(())
}

pub(super) fn reference_continuation_evidence(evidence: &mut Value, references: &std::collections::BTreeMap<String, String>) {
    match evidence["kind"].as_str() {
        Some("any" | "all") => {
            if let Some(sources) = evidence["sources"].as_array_mut() {
                for source in sources { reference_continuation_evidence(&mut source["evidence"], references); }
            }
        }
        Some("log_literal" | "log_end" | "artifact" | "collection") => {
            if let Some(reference) = evidence["operationId"].as_str().and_then(|id| references.get(id)) {
                evidence["operationId"] = json!(reference);
            }
        }
        _ => (),
    }
}
