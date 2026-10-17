//! Model-facing parameter schemas. Execution continues to validate the original declaration.
use super::*;
use serde_json::{json, Map};

pub(super) fn parameters(tool: &ToolSchema) -> Result<Value, ExecutionError> {
    let mut schema = match &tool.schema {
        Value::Object(_) => tool.schema.clone(),
        Value::Bool(true) => json!({}),
        _ => return Err(invalid(tool)),
    };
    normalize(&mut schema);
    let root = schema.as_object_mut().expect("schema object");
    match root.get("type") {
        None => {}
        Some(Value::String(kind)) if kind == "object" => {}
        Some(Value::Array(kinds)) if kinds.iter().any(|kind| kind == "object") => {}
        _ => return Err(invalid(tool)),
    }
    // Function arguments are objects in these protocols. A valid object union or local $ref
    // need not spell that out in JSON Schema; do not discard its alternatives or definitions.
    root.insert("type".into(), json!("object"));
    root.entry("properties").or_insert_with(|| json!({}));
    Ok(schema)
}

fn invalid(tool: &ToolSchema) -> ExecutionError {
    ExecutionError::new(
        "invalid_tool_schema",
        format!(
            "tool {} requires an object parameter schema for this model protocol",
            tool.name
        ),
    )
}

fn value_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn normalize(schema: &mut Value) {
    let Some(node) = schema.as_object_mut() else {
        return;
    };
    // const and a singleton enum describe the same values. Supplying their exact types also
    // makes discriminator fields usable by protocols that expect a typed parameter schema.
    if let Some(value) = node.remove("const") {
        match node.get_mut("enum").and_then(Value::as_array_mut) {
            Some(values) => values.retain(|candidate| candidate == &value),
            None => {
                node.insert("enum".into(), json!([value]));
            }
        }
    }
    if !node.contains_key("type") {
        if let Some(values) = node.get("enum").and_then(Value::as_array) {
            let mut types = Vec::new();
            for value in values {
                let kind = value_type(value);
                if !types.contains(&kind) {
                    types.push(kind);
                }
            }
            if !types.is_empty() {
                node.insert(
                    "type".into(),
                    if types.len() == 1 {
                        json!(types[0])
                    } else {
                        json!(types)
                    },
                );
            }
        }
    }
    visit_schemas(node);
}

fn visit_schemas(node: &mut Map<String, Value>) {
    // Visit schema positions only: defaults, examples and user properties named "const" or
    // "type" are ordinary data. Unknown keywords and all original constraints remain intact.
    for key in [
        "properties",
        "patternProperties",
        "$defs",
        "definitions",
        "dependentSchemas",
    ] {
        if let Some(children) = node.get_mut(key).and_then(Value::as_object_mut) {
            for child in children.values_mut() {
                normalize(child);
            }
        }
    }
    for key in [
        "items",
        "prefixItems",
        "contains",
        "additionalProperties",
        "unevaluatedProperties",
        "unevaluatedItems",
        "propertyNames",
        "allOf",
        "anyOf",
        "oneOf",
        "not",
        "if",
        "then",
        "else",
    ] {
        if let Some(child) = node.get_mut(key) {
            if let Some(children) = child.as_array_mut() {
                for child in children {
                    normalize(child);
                }
            } else {
                normalize(child);
            }
        }
    }
}
