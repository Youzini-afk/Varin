//! A stable model interface over the original executable directory. Disclosure is conversation
//! data; it never adds declarations to the provider's tools or grants execution authority.
use crate::execution::ToolSchema;
use serde_json::json;

pub const DESCRIBE: &str = "tool_describe";
pub const INVOKE: &str = "tool_invoke";
pub const GROUPS: &[(&str, &str)] = &[
    ("documents", "PDF reading and retained material collections"),
    (
        "research",
        "Scholarly search and configured candidate judgments",
    ),
    (
        "interface",
        "Interactive HTML in chat",
    ),
    (
        "desktop",
        "Desktop observation, input and control assignments",
    ),
    ("browser", "Live browser tabs, pages and input"),
    ("office", "Live Office documents and spreadsheets"),
    (
        "environment",
        "Desktop setup, software installation and service forwarding",
    ),
    ("settings", "Read and change application settings"),
    (
        "development",
        "Inspect Varin contracts and develop extensions",
    ),
    ("extensions", "Other installed extension capabilities"),
];

pub fn schemas() -> Vec<ToolSchema> {
    definitions().to_vec()
}

fn definitions() -> &'static [ToolSchema] {
    static DEFINITIONS: std::sync::OnceLock<Vec<ToolSchema>> = std::sync::OnceLock::new();
    DEFINITIONS.get_or_init(build_schemas)
}

fn build_schemas() -> Vec<ToolSchema> {
    let index = GROUPS
        .iter()
        .map(|(id, purpose)| format!("{id}: {purpose}"))
        .collect::<Vec<_>>()
        .join("; ");
    [
        (DESCRIBE, format!("查询工具的用途、参数和版本。可按分组或工具名称查询；省略参数时列出可用分组。可用分组：{index}。"),
         json!({"type":"object","additionalProperties":false,"properties":{"namespace":{"type":"string","minLength":1},"name":{"type":"string","minLength":1}}})),
        (INVOKE, "通过已声明的入口调用工具，适用于目标工具未单独声明的情况。reference 填工具名称和版本，arguments 填目标工具的参数。".into(),
         json!({"type":"object","additionalProperties":false,"required":["reference","arguments"],"properties":{
             "reference":{"type":"object","additionalProperties":false,"required":["name","version"],"properties":{"name":{"type":"string","minLength":1},"version":{"type":"string","minLength":1}}},
             "arguments":{"type":"object"}}})),
    ].into_iter().map(|(name, description, schema)| ToolSchema {
        name: name.into(), version: "1".into(), description, schema,
        requirements: None, output_schema: None, metadata: None,
    }).collect()
}

pub fn is_gateway(tool: &ToolSchema) -> bool {
    // Saved request descriptions can predate a wording change. Recognition follows the
    // callable contract while serialization preserves the original frozen description.
    definitions().iter().any(|owned| owned.name == tool.name
        && owned.version == tool.version && owned.schema == tool.schema
        && owned.requirements == tool.requirements && owned.metadata == tool.metadata
        && owned.output_schema == tool.output_schema)
}

pub fn enabled(tools: &[ToolSchema]) -> bool {
    definitions().iter().all(|owned| tools.iter().any(|tool| tool.name == owned.name && is_gateway(tool)))
}

/// Included in every provider declaration list; deferred tools remain directly callable.
pub fn is_always_declared(name: &str) -> bool {
    // The MCP owner already selects direct tools and its discovery/call entrypoints.
    // Deferred server tools stay behind mcp_call and are absent from this directory.
    name.starts_with("mcp_") || matches!(
        name,
        DESCRIBE
            | INVOKE
            | "file_read"
            | "file_list"
            | "file_search"
            | "file_write"
            | "file_edit"
            | "code_retrieval"
            | "language_definition"
            | "language_references"
            | "language_diagnostics"
            | "language_hover"
            | "language_symbols"
            | "language_document_symbols"
            | "language_call_hierarchy"
            | "process_spawn"
            | "process_read"
            | "process_write"
            | "process_inspect"
            | "process_resize"
            | "wait_process"
            | "script_open"
            | "script_run"
            | "script_close"
            | "dispatch"
            | "child_status"
            | "child_report"
            | "wait_child"
            | "threads"
            | "read_thread"
            | "send"
            | "ask_user"
            | "question_status"
            | "todo"
            | "memory"
            | "goal_report"
            | "follow_up"
            | "websearch"
            | "webfetch"
            | "image_generate"
            | "image_edit"
            | "resource_read"
    )
}

/// None preserves tool-free auxiliary jobs and callers without the native disclosure interface.
pub fn model_tools(tools: &[ToolSchema]) -> Option<Vec<ToolSchema>> {
    if !enabled(tools) {
        return None;
    }
    let mut visible = tools
        .iter()
        .filter(|tool| is_always_declared(&tool.name))
        .cloned()
        .collect::<Vec<_>>();
    visible.sort_by(|a, b| a.name.cmp(&b.name));
    Some(visible)
}

/// The executable request cut of a frozen launch. Keep this distinct from the
/// smaller provider interface, and use the same cut when validating persistence.
pub fn request_tools(tools: &[ToolSchema], has_goal: bool, allowed: Option<&[String]>) -> Vec<ToolSchema> {
    if !enabled(tools) { return tools.to_vec(); }
    tools.iter()
        .filter(|tool| tool.name != "goal_report" || has_goal)
        .filter(|tool| is_gateway(tool) || allowed.is_none_or(|names| names.contains(&tool.name)))
        .cloned().collect()
}

/// This is an explicit API classification, not keyword matching of user requests.
pub fn namespace(name: &str) -> Option<&'static str> {
    if is_always_declared(name) { return None; }
    Some(match name {
        "document_read" | "materials" => "documents",
        "research_search" | "research_decide" => "research",
        "render_ui" => "interface",
        "computer_browser" | "computer_browser_read" => "browser",
        "computer_office" | "computer_office_read" => "office",
        "computer_prepare"
        | "computer_install"
        | "computer_desktop_lifecycle"
        | "environment_forward"
        | "environment_forwards"
        | "environment_forward_get"
        | "environment_forward_close"
        | "environment_forward_wait" => "environment",
        "computer_request"
        | "computer_access"
        | "computer_grant"
        | "computer_deny"
        | "computer_wait"
        | "computer_list"
        | "computer_artifact"
        | "computer_apps"
        | "computer_control"
        | "computer_observe"
        | "computer_act"
        | "computer_open"
        | "computer_put"
        | "computer_evidence"
        | "computer_environment"
        | "computer_cancel"
        | "computer_release" => "desktop",
        "settings_search" | "settings_read" | "settings_update" | "settings_action" => "settings",
        "runtime_contract" | "extension_package" => "development",
        _ => "extensions",
    })
}
