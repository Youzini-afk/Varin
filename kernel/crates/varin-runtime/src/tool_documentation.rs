//! Read-only views of original tool contracts. Views never become executable schemas.
use crate::execution::{ExecutionError, ToolSchema};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ToolDisclosure {
    pub summary: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub operations: Vec<ToolDocumentationOperation>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ToolDocumentationOperation {
    pub name: String,
    pub description: String,
    /// Explicit branches in the original schema, never inferred from third-party field names.
    pub paths: Vec<String>,
}

pub fn declaration(tool: &ToolSchema) -> Option<&ToolDisclosure> {
    tool.metadata.as_ref()?.disclosure.as_ref()
}
pub fn namespace(tool: &ToolSchema) -> Option<&str> {
    declaration(tool)
        .and_then(|d| d.namespace.as_deref())
        .or_else(|| crate::tool_disclosure::namespace(&tool.name))
}
pub fn summary(tool: &ToolSchema) -> &str {
    declaration(tool).map_or_else(
        || builtin_summary(&tool.name).unwrap_or(&tool.description),
        |d| &d.summary,
    )
}
fn builtin_summary(name: &str) -> Option<&'static str> {
    Some(match name {
        "file_read" => "Read files, complete code units, lines or bytes from the selected source.",
        "file_list" => "List and filter paths in one or more source directories.",
        "file_search" => "Search file contents and return located matches.",
        "file_write" => "Create or replace a file with revision checks.",
        "file_edit" => "Apply edits to an existing file revision.",
        "process_spawn" => "Execute a program or shell command; retain its process and output.",
        "script_run" => "Run JavaScript in a retained script session, including nested tool calls.",
        "script_open" => "Open a persistent JavaScript execution session.",
        "dispatch" => "Delegate a task using an available Agent preset or the current model.",
        "document_read" => {
            "Read document text, structure and page images from paths or retained materials."
        }
        "render_ui" => "Create interactive HTML content and retained views.",
        "resource_read" => "Read retained resources and their available representations.",
        "webfetch" => "Fetch and read web pages and retained page snapshots.",
        "websearch" => "Search the web for sources.",
        "code_retrieval" => "Start a background source exploration task.",
        _ => return None,
    })
}

/// Terms describe objects/operations, never a task-to-tool recipe. Match multiple terms by rank.
const TERMS: &[&[&str]] = &[
    &["截图", "截屏", "屏幕", "screenshot", "screen", "capture"],
    &["文件", "目录", "file", "files", "directory", "path"],
    &["读取", "阅读", "查看", "read", "observe", "inspect"],
    &["搜索", "检索", "查找", "search", "find", "query"],
    &["编辑", "修改", "写入", "edit", "write", "replace"],
    &[
        "终端", "进程", "命令", "程序", "terminal", "process", "shell", "command",
    ],
    &["脚本", "执行", "script", "execute", "javascript"],
    &["浏览器", "网页", "browser", "page", "web"],
    &[
        "办公",
        "文档",
        "表格",
        "演示",
        "office",
        "document",
        "worksheet",
        "slide",
    ],
    &["桌面", "应用", "desktop", "application"],
    &[
        "协作",
        "子任务",
        "代理",
        "agent",
        "delegation",
        "collaboration",
    ],
    &["记忆", "memory"],
    &["计划", "todo", "plan"],
    &["恢复", "recovery", "restore"],
    &["科研", "论文", "research", "scholarly"],
    &["设置", "配置", "settings", "configuration"],
    &["图像", "图片", "image"],
];
fn normalize(text: &str) -> String {
    text.chars()
        .flat_map(char::to_lowercase)
        .map(|c| {
            let c = if ('\u{ff01}'..='\u{ff5e}').contains(&c) {
                char::from_u32(c as u32 - 0xfee0).unwrap()
            } else {
                c
            };
            if c.is_alphanumeric() { c } else { ' ' }
        })
        .collect::<String>()
}
fn tokens(text: &str) -> Vec<String> {
    normalize(text)
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}
pub fn search_score(query: &str, name: &str, description: &str, aliases: &[String]) -> usize {
    let query = normalize(query);
    let name = normalize(name);
    if query.trim() == name.trim() {
        return 10_000;
    }
    let text = normalize(description);
    let aliases = normalize(&aliases.join(" "));
    let mut terms = tokens(&query);
    for family in TERMS {
        if family.iter().any(|term| query.contains(term)) {
            terms.extend(family.iter().map(|term| (*term).into()));
        }
    }
    terms.sort();
    terms.dedup();
    terms
        .iter()
        .filter(|term| !term.is_empty())
        .map(|term| {
            if name == *term {
                150
            } else if name.contains(term) {
                80
            } else if aliases.contains(term) {
                50
            } else if text.contains(term) {
                10
            } else {
                0
            }
        })
        .sum()
}
pub fn schema_terms(schema: &Value) -> String {
    fn collect(schema: &Value, terms: &mut Vec<String>) {
        match schema {
            Value::Object(fields) => {
                for (key, value) in fields {
                    if matches!(key.as_str(), "properties" | "$defs" | "definitions") {
                        if let Some(properties) = value.as_object() {
                            terms.extend(properties.keys().cloned());
                        }
                    }
                    if matches!(key.as_str(), "const" | "title" | "description") {
                        if let Some(text) = value.as_str() {
                            terms.push(text.into());
                        }
                    }
                    if key == "enum" {
                        if let Some(values) = value.as_array() {
                            terms.extend(
                                values.iter().filter_map(Value::as_str).map(str::to_string),
                            );
                        }
                    }
                    collect(value, terms);
                }
            }
            Value::Array(items) => {
                for item in items {
                    collect(item, terms)
                }
            }
            _ => {}
        }
    }
    let mut terms = Vec::new();
    collect(schema, &mut terms);
    terms.join(" ")
}

/// Keep every root/sibling constraint. Only author-selected oneOf/anyOf arrays are narrowed.
pub fn operation_schema(
    schema: &Value,
    operation: &ToolDocumentationOperation,
) -> Result<Value, ExecutionError> {
    // Recursive references and addresses inside a narrowed array must keep their original
    // document locations. Return that complete contract rather than a misleading projection.
    if !references_stable(schema, operation) {
        return Ok(schema.clone());
    }
    let mut view = schema.clone();
    // Deeper selections are applied first so original array offsets stay valid.
    let mut selections = std::collections::BTreeMap::<String, Vec<usize>>::new();
    for path in &operation.paths {
        let (parent, index) = path
            .rsplit_once('/')
            .ok_or_else(|| invalid("operation path is not a branch"))?;
        if !parent.ends_with("/oneOf") && !parent.ends_with("/anyOf") {
            return Err(invalid("operation path must select oneOf/anyOf"));
        }
        selections.entry(parent.into()).or_default().push(
            index
                .parse()
                .map_err(|_| invalid("operation branch index is invalid"))?,
        );
    }
    let mut selections = selections.into_iter().collect::<Vec<_>>();
    selections.sort_by_key(|(path, _)| std::cmp::Reverse(path.len()));
    for (parent, indices) in selections {
        let branches = view
            .pointer_mut(&parent)
            .and_then(Value::as_array_mut)
            .ok_or_else(|| invalid("operation branch is missing"))?;
        if indices.iter().any(|index| *index >= branches.len()) {
            return Err(invalid("operation branch is missing"));
        }
        let selected = branches
            .iter()
            .enumerate()
            .filter(|(index, _)| indices.contains(index))
            .map(|(_, value)| value.clone())
            .collect::<Vec<_>>();
        let excluded = branches
            .iter()
            .enumerate()
            .filter(|(index, value)| {
                !indices.contains(index)
                    && selected.iter().any(|selected| !disjoint(selected, value))
            })
            .map(|(_, value)| value.clone())
            .collect::<Vec<_>>();
        *branches = selected;
        if parent.ends_with("/oneOf") && !excluded.is_empty() {
            let object = view
                .pointer_mut(parent.strip_suffix("/oneOf").unwrap())
                .and_then(Value::as_object_mut)
                .ok_or_else(|| invalid("operation parent is missing"))?;
            object
                .entry("allOf")
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .ok_or_else(|| invalid("invalid allOf"))?
                .push(json!({"not":{"anyOf":excluded}}));
        }
    }
    Ok(view)
}
fn references_stable(schema: &Value, operation: &ToolDocumentationOperation) -> bool {
    fn has_reference(value: &Value) -> bool {
        match value {
            Value::Object(fields) => {
                fields.contains_key("$ref") || fields.values().any(has_reference)
            }
            Value::Array(items) => items.iter().any(has_reference),
            _ => false,
        }
    }
    let definition_focus = has_reference(schema)
        && operation
            .paths
            .iter()
            .any(|path| path.starts_with("/$defs/") || path.starts_with("/definitions/"));
    // Inverting/conditional/evaluation contexts cannot be reduced by selecting a child.
    // Keep their complete original contract available through the same reader.
    if operation.paths.iter().any(|path| {
        path.split('/')
            .any(|part| matches!(part, "not" | "if" | "then" | "else" | "contains"))
    }) {
        return false;
    }
    fn complex_context(value: &Value, definition_focus: bool) -> bool {
        match value {
            Value::Object(fields) => {
                fields.keys().any(|key| {
                    matches!(key.as_str(), "unevaluatedProperties" | "unevaluatedItems")
                        || definition_focus && matches!(key.as_str(), "not" | "if" | "maxContains")
                }) || fields
                    .values()
                    .any(|value| complex_context(value, definition_focus))
            }
            Value::Array(values) => values
                .iter()
                .any(|value| complex_context(value, definition_focus)),
            _ => false,
        }
    }
    if complex_context(schema, definition_focus) {
        return false;
    }
    fn stable_choices(
        value: &Value,
        path: &str,
        operation: &ToolDocumentationOperation,
        definition_focus: bool,
    ) -> bool {
        match value {
            Value::Object(fields) => fields.iter().all(|(key, value)| {
                let path = format!("{path}/{}", escape(key));
                if key == "oneOf" {
                    let nested = operation.paths.iter().any(|selected| {
                        selected
                            .strip_prefix(&format!("{path}/"))
                            .is_some_and(|suffix| suffix.contains('/'))
                    });
                    if (nested || definition_focus)
                        && value.as_array().is_some_and(|branches| {
                            branches
                                .iter()
                                .enumerate()
                                .any(|(i, a)| branches[i + 1..].iter().any(|b| !disjoint(a, b)))
                        })
                    {
                        return false;
                    }
                }
                stable_choices(value, &path, operation, definition_focus)
            }),
            Value::Array(values) => values.iter().enumerate().all(|(i, value)| {
                stable_choices(value, &format!("{path}/{i}"), operation, definition_focus)
            }),
            _ => true,
        }
    }
    if !stable_choices(schema, "", operation, definition_focus) {
        return false;
    }
    fn walk(
        root: &Value,
        value: &Value,
        path: &str,
        operation: &ToolDocumentationOperation,
        active: &mut Vec<String>,
        complete: &mut std::collections::HashSet<String>,
    ) -> bool {
        match value {
            Value::Object(fields) => {
                if !path.is_empty() && fields.contains_key("$id")
                    || fields.keys().any(|key| {
                        matches!(key.as_str(), "$anchor" | "$dynamicAnchor" | "$dynamicRef")
                    })
                {
                    return false;
                }
                if fields
                    .get("$ref")
                    .and_then(Value::as_str)
                    .is_some_and(|reference| reference != "#" && !reference.starts_with("#/"))
                {
                    return false;
                }
                if let Some(reference) = fields
                    .get("$ref")
                    .and_then(Value::as_str)
                    .and_then(|reference| reference.strip_prefix('#'))
                {
                    if operation
                        .paths
                        .iter()
                        .filter_map(|path| path.rsplit_once('/'))
                        .any(|(parent, _)| reference.starts_with(&format!("{parent}/")))
                    {
                        return false;
                    }
                    if active.iter().any(|path| path == reference) {
                        return false;
                    }
                    if !complete.contains(reference) {
                        if let Some(target) = root.pointer(reference) {
                            active.push(reference.into());
                            if !walk(root, target, reference, operation, active, complete) {
                                return false;
                            }
                            active.pop();
                            complete.insert(reference.into());
                        }
                    }
                }
                fields.iter().all(|(key, value)| {
                    walk(
                        root,
                        value,
                        &format!("{path}/{}", escape(key)),
                        operation,
                        active,
                        complete,
                    )
                })
            }
            Value::Array(values) => values.iter().enumerate().all(|(i, value)| {
                walk(
                    root,
                    value,
                    &format!("{path}/{i}"),
                    operation,
                    active,
                    complete,
                )
            }),
            _ => true,
        }
    }
    walk(
        schema,
        schema,
        "",
        operation,
        &mut Vec::new(),
        &mut std::collections::HashSet::new(),
    )
}
/// Prove common object branches disjoint; otherwise preserve original oneOf exclusions verbatim.
fn disjoint(a: &Value, b: &Value) -> bool {
    if a["type"] != "object" || b["type"] != "object" {
        return false;
    }
    fn required(value: &Value) -> Vec<&str> {
        value["required"]
            .as_array()
            .map(|values| values.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default()
    }
    let ar = required(a);
    let br = required(b);
    for (left, right, required) in [(a, b, &ar), (b, a, &br)] {
        if right["additionalProperties"] == false
            && right.get("patternProperties").is_none()
            && required
                .iter()
                .any(|name| right["properties"].get(*name).is_none())
        {
            return true;
        }
        for name in required
            .iter()
            .filter(|name| br.contains(name) && ar.contains(name))
        {
            let values = |value: &Value| {
                value
                    .get("const")
                    .map(|v| vec![v.clone()])
                    .or_else(|| value["enum"].as_array().cloned())
            };
            if let (Some(a), Some(b)) = (
                values(&left["properties"][*name]),
                values(&right["properties"][*name]),
            ) {
                if a.iter().all(|value| !b.contains(value)) {
                    return true;
                }
            }
        }
    }
    false
}
fn invalid(message: &str) -> ExecutionError {
    ExecutionError::new("tool_disclosure", message)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Continuation {
    pub directory: String,
    pub selection: Value,
    pub offset: usize,
}
impl Continuation {
    pub fn decode(cursor: &str) -> Result<Self, ExecutionError> {
        serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(cursor)
                .map_err(|_| invalid("invalid discovery cursor"))?,
        )
        .map_err(|_| invalid("invalid discovery cursor"))
    }
    pub fn encode(&self) -> String {
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(self).expect("discovery cursor JSON"))
    }
}
pub fn identity(value: &impl Serialize) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(value).expect("directory JSON"),
    ))
}
pub fn bytes(value: &Value) -> usize {
    serde_json::to_vec(value).expect("discovery JSON").len()
}

/// Page whole entries and reserve the exact envelope/cursor bytes. No independent count quota.
pub fn page(
    mut envelope: Value,
    key: &str,
    entries: &[Value],
    directory: &str,
    selection: &Value,
    offset: usize,
    budget: Option<usize>,
    gateway: &str,
) -> Value {
    if offset > entries.len() {
        return json!({"status":"cursor_out_of_range","message":"Repeat the original discovery query."});
    }
    envelope["directory"] = directory.into();
    envelope["total"] = entries.len().into();
    envelope[key] = json!([]);
    for (index, entry) in entries.iter().enumerate().skip(offset) {
        envelope[key].as_array_mut().unwrap().push(entry.clone());
        set_next(
            &mut envelope,
            directory,
            selection,
            index + 1,
            entries.len(),
            gateway,
        );
        let required_bytes = bytes(&envelope);
        if budget.is_some_and(|budget| required_bytes > budget) {
            envelope[key].as_array_mut().unwrap().pop();
            set_next(
                &mut envelope,
                directory,
                selection,
                index,
                entries.len(),
                gateway,
            );
            if index == offset {
                return json!({"status":"budget_too_small","requiredBytes":required_bytes,
                    "message":"The next complete discovery entry exceeds the current visible output budget. Read a narrower name, operation or schema path."});
            }
            break;
        }
    }
    envelope
}
pub fn entry_budget(
    envelope: &Value,
    key: &str,
    directory: &str,
    selection: &Value,
    total: usize,
    budget: Option<usize>,
    gateway: &str,
) -> Option<usize> {
    budget.map(|budget| {
        let mut value = envelope.clone();
        value["directory"] = directory.into();
        value["total"] = total.into();
        value[key] = json!([]);
        set_next(
            &mut value,
            directory,
            selection,
            total.saturating_sub(1),
            total,
            gateway,
        );
        budget.saturating_sub(bytes(&value))
    })
}
fn set_next(
    value: &mut Value,
    directory: &str,
    selection: &Value,
    offset: usize,
    total: usize,
    gateway: &str,
) {
    if offset < total {
        let cursor = Continuation {
            directory: directory.into(),
            selection: selection.clone(),
            offset,
        }
        .encode();
        value["next"] = json!({"tool":gateway,"arguments":{"cursor":cursor}});
    } else {
        value.as_object_mut().unwrap().remove("next");
    }
}

fn escape(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}
/// An explicit raw contract reader for indivisible third-party schemas. Never claims to be callable.
pub fn structure(
    document: &Value,
    path: &str,
    name: &str,
    gateway: &str,
    base_args: &Value,
) -> Result<Value, ExecutionError> {
    let value = document
        .pointer(path)
        .ok_or_else(|| invalid("contract path does not exist"))?;
    let children = match value {
        Value::Object(fields) => fields
            .iter()
            .map(|(key, value)| (key.clone(), value))
            .collect::<Vec<_>>(),
        Value::Array(values) => values
            .iter()
            .enumerate()
            .map(|(i, value)| (i.to_string(), value))
            .collect(),
        _ => return Ok(json!({"name":name,"view":"fragment","path":path,"value":value})),
    };
    Ok(
        json!({"name":name,"view":"structure","path":path,"nodes":children.into_iter().map(|(key,value)| {
        let mut args = base_args.clone(); args["path"] = format!("{path}/{}",escape(&key)).into();
        json!({"key":key,"type":match value {Value::Object(_)=>"object",Value::Array(_)=>"array",Value::String(_)=>"string",_=>"scalar"},
            "read":{"tool":gateway,"arguments":args}})
    }).collect::<Vec<_>>()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn focused_schema_keeps_shared_constraints_references_and_oneof_exclusivity() {
        let schema = json!({"type":"object","required":["source"],"properties":{"source":{"$ref":"#/$defs/source"}},"$defs":{"source":{"type":"string","minLength":1}},"oneOf":[{"required":["a"]},{"required":["b"]}]});
        let operation = ToolDocumentationOperation {
            name: "a".into(),
            description: "Read branch a".into(),
            paths: vec!["/oneOf/0".into()],
        };
        let view = operation_schema(&schema, &operation).unwrap();
        assert_eq!(view["required"], schema["required"]);
        assert_eq!(view["$defs"], schema["$defs"]);
        assert_eq!(view["properties"], schema["properties"]);
        assert_eq!(view["oneOf"], json!([{"required":["a"]}]));
        assert_eq!(
            view["allOf"],
            json!([{"not":{"anyOf":[{"required":["b"]}]}}])
        );
        let branches = json!({"oneOf":[{"type":"object","properties":{"action":{"const":"a"}},"required":["action"]},{"type":"object","properties":{"action":{"const":"b"}},"required":["action"]}]});
        assert!(
            operation_schema(&branches, &operation)
                .unwrap()
                .get("allOf")
                .is_none()
        );
        let union = ToolDocumentationOperation {
            paths: vec!["/oneOf/0".into(), "/oneOf/1".into()],
            ..operation
        };
        assert_eq!(operation_schema(&branches, &union).unwrap(), branches);
        let recursive = json!({"oneOf":[{"type":"object","properties":{"child":{"$ref":"#"}}},{"type":"null"}]});
        assert_eq!(operation_schema(&recursive, &union).unwrap(), recursive);
        let addressed = json!({"oneOf":[{"type":"object"},{"type":"string"}],"$defs":{"specific":{"$ref":"#/oneOf/1"}}});
        assert_eq!(operation_schema(&addressed, &union).unwrap(), addressed);
        let nested = json!({"oneOf":[{"type":"object","properties":{"value":{"oneOf":[{"type":"string"},{"type":"number"}]}}},{"type":"object"}]});
        let selection = ToolDocumentationOperation {
            name: "nested".into(),
            description: "Read nested choice".into(),
            paths: vec![
                "/oneOf/0".into(),
                "/oneOf/0/properties/value/oneOf/0".into(),
            ],
        };
        assert_eq!(
            operation_schema(&nested, &selection).unwrap(),
            nested,
            "narrowing a child must not turn overlapping parent branches into a newly valid object"
        );
        let negative = json!({"not":{"oneOf":[{"type":"string"},{"type":"number"}]}});
        let selection = ToolDocumentationOperation {
            paths: vec!["/not/oneOf/0".into()],
            ..selection
        };
        assert_eq!(operation_schema(&negative, &selection).unwrap(), negative);
    }
    #[test]
    fn search_uses_names_operations_cross_language_terms_and_unicode_case() {
        assert!(search_score("截图 屏幕", "browser_read", "screenshot of the page", &[]) > 0);
        assert!(
            search_score("OFFICE.WRITE", "office_write", "format files", &[])
                > search_score("office", "office_read", "format files", &[])
        );
        assert!(search_score("不存在的能力", "office_write", "format files", &[]) == 0);
    }
}
