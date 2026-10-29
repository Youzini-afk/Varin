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
