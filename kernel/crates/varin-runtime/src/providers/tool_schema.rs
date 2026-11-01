//! Model-facing parameter schemas. Execution continues to validate the original declaration.
use super::*;
use serde_json::{Map, json};
use std::collections::BTreeSet;

/// OpenAI function parameters require a plain object at the root, even with
/// strict=false. Project root alternatives into their field union; execution
/// continues to check the original schema, including cross-field constraints.
pub(super) fn openai_parameters(tool: &ToolSchema) -> Result<Value, ExecutionError> {
    let mut schema = parameters(tool)?;
    let (properties, required) = object_shape(&schema, &schema, &mut BTreeSet::new());
    let root = schema.as_object_mut().expect("schema object");
    for key in ["oneOf", "anyOf", "allOf", "enum", "const", "not", "$ref"] {
        root.remove(key);
    }
    root.insert("properties".into(), Value::Object(properties));
    if !required.is_empty() {
        root.insert("required".into(), json!(required));
    }
    // A field may refer into a removed root alternative. Retain the original
    // schema only when needed and rebase those references, without duplicating
    // every ordinary tool schema or changing defaults/examples that contain $ref.
    let mut definition = "__varin_original_parameters".to_owned();
    while root
        .get("$defs")
        .and_then(Value::as_object)
        .is_some_and(|defs| defs.contains_key(&definition))
    {
        definition.push('_');
    }
    if rebase_refs(&mut schema, &definition, false) {
        let mut original = parameters(tool)?;
        rebase_refs(&mut original, &definition, true);
        let defs = schema
            .as_object_mut()
            .expect("schema object")
            .entry("$defs")
            .or_insert_with(|| json!({}));
        defs.as_object_mut()
            .ok_or_else(|| invalid(tool))?
            .insert(definition, original);
    }
    Ok(schema)
}

fn rebase_refs(schema: &mut Value, definition: &str, all_local: bool) -> bool {
    let Some(node) = schema.as_object_mut() else {
        return false;
    };
    let mut changed = false;
    if let Some(reference) = node
        .get_mut("$ref")
        .and_then(|value| value.as_str().map(str::to_owned))
    {
        if let Some(pointer) = reference.strip_prefix('#') {
            let root_key = pointer
                .strip_prefix('/')
                .unwrap_or(pointer)
                .split('/')
                .next()
                .unwrap_or("");
            if (pointer.is_empty() || pointer.starts_with('/'))
                && (all_local
                    || matches!(
                        root_key,
                        "" | "oneOf" | "anyOf" | "allOf" | "enum" | "const" | "not" | "$ref"
                    ))
            {
                node.insert(
                    "$ref".into(),
                    json!(format!("#/$defs/{definition}{pointer}")),
                );
                changed = true;
            }
        }
    }
    visit_schemas(node, &mut |child| {
        changed |= rebase_refs(child, definition, all_local);
    });
    changed
}

type ObjectShape = (Map<String, Value>, BTreeSet<String>);
fn merge_properties(target: &mut Map<String, Value>, properties: Map<String, Value>) {
    for (name, schema) in properties {
        match target.get_mut(&name) {
            Some(previous) if *previous != schema => {
                *previous = json!({"anyOf":[previous.clone(), schema]});
            }
            Some(_) => {}
            None => {
                target.insert(name, schema);
            }
        }
    }
}

fn object_shape(schema: &Value, document: &Value, refs: &mut BTreeSet<String>) -> ObjectShape {
    let mut properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut required: BTreeSet<String> = schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        if let Some(pointer) = reference.strip_prefix('#') {
            if refs.insert(reference.into()) {
                if let Some(target) = document.pointer(pointer) {
                    let (fields, needs) = object_shape(target, document, refs);
                    merge_properties(&mut properties, fields);
                    required.extend(needs);
                }
                refs.remove(reference);
            }
        }
    }
    for key in ["allOf", "anyOf", "oneOf"] {
        if let Some(branches) = schema.get(key).and_then(Value::as_array) {
            let mut common: Option<BTreeSet<String>> = None;
            for branch in branches {
                let (fields, needs) = object_shape(branch, document, refs);
                merge_properties(&mut properties, fields);
                if key == "allOf" {
                    required.extend(needs);
                } else {
                    common = Some(match common {
                        None => needs,
                        Some(previous) => previous.intersection(&needs).cloned().collect(),
                    });
                }
            }
            if let Some(common) = common {
                required.extend(common);
            }
        }
    }
    // Object-valued const/enum roots also describe fields, rather than a tool
    // with no arguments. normalize() has already converted const to enum.
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        for value in values.iter().filter_map(Value::as_object) {
            merge_properties(
                &mut properties,
                value
                    .iter()
                    .map(|(name, value)| {
                        (
                            name.clone(),
                            json!({"type":value_type(value), "enum":[value]}),
                        )
                    })
                    .collect(),
            );
        }
    }
    (properties, required)
}

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
    visit_schemas(node, &mut normalize);
}

fn visit_schemas(node: &mut Map<String, Value>, visit: &mut dyn FnMut(&mut Value)) {
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
                visit(child);
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
                    visit(child);
                }
            } else {
                visit(child);
            }
        }
    }
}
