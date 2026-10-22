//! A stable model interface over the original executable directory. Disclosure is conversation
//! data; it never adds declarations to the provider's tools or grants execution authority.
use crate::execution::{ExecutionError, ToolSchema};
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
        (DESCRIBE, format!("查询工具的用途、参数和版本。可按分组或工具名称查询；省略参数时列出可用分组。查询只返回文档，不会新增模型函数：未在本次 tools 中声明的工具必须经 tool_invoke 调用，不能直接把目标名称用作函数名。按返回的 invocation 填写调用参数。分组索引：{index}。"),
         json!({"type":"object","additionalProperties":false,"properties":{"namespace":{"type":"string","minLength":1},"name":{"type":"string","minLength":1}}})),
        (INVOKE, "调用当前可用目录中的工具。未在本次 tools 中单独声明的目标必须使用本入口，不能直接调用目标名称。先用 tool_describe 获取 reference（名称和版本），再把符合目标 schema 的对象填入 arguments。本入口不启用未选中的工具，也不绕过权限。".into(),
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

/// Included in every provider declaration list; deferred tools require the registered gateway.
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
            | "recovery_points"
            | "file_restore"
            | "file_edit"
            | "code_retrieval"
            | "process_spawn"
            | "process_read"
            | "process_write"
            | "process_inspect"
            | "process_resize"
            | "process_stop"
            | "wait_process"
            | "script_open"
            | "script_run"
            | "script_close"
            | "dispatch"
            | "child_status"
            | "child_cancel"
            | "child_report"
            | "wait_child"
            | "threads"
            | "read_thread"
            | "send"
            | "agent_rename"
            | "submit_code"
            | "update"
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
            | "render_ui"
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
        .filter(|tool| is_declared(tool))
        .cloned()
        .collect::<Vec<_>>();
    visible.sort_by(|a, b| a.name.cmp(&b.name));
    Some(visible)
}

pub fn is_declared(tool: &ToolSchema) -> bool {
    is_always_declared(&tool.name)
        || tool.metadata.as_ref().is_some_and(|metadata| metadata.always_declared)
}

/// The same admission rule is used by protocol decoders and the executor, including brokered adapters.
pub fn model_tool<'a>(tools: &'a [ToolSchema], name: &str) -> Result<&'a ToolSchema, ExecutionError> {
    let tool = tools.iter().find(|tool| tool.name == name).ok_or_else(|| call_error(
        "unknown_tool_schema", name, "This tool is not available to the current request. Use tool_describe to inspect the available directory; tool_invoke cannot enable an unavailable tool."))?;
    if enabled(tools) && !is_declared(tool) {
        return Err(call_error("tool_not_declared", name,
            "This tool was not registered in the model request. Read its reference with tool_describe and call tool_invoke with reference and arguments; do not call the target name directly. No tool was executed."));
    }
    Ok(tool)
}

pub fn call_error(code: &str, name: &str, message: &str) -> ExecutionError {
    let mut error = ExecutionError::new(code, message);
    error.tool_name = diagnostic_tool_name(name);
    error
}

/// Diagnostics may name an identifier, but never copy arguments or arbitrary provider response text.
pub fn diagnostic_tool_name(name: &str) -> Option<String> {
    (!name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || "_-.:/".contains(c)))
        .then(|| name.to_owned())
}

pub fn deferred_namespace(tool: &ToolSchema) -> Option<&'static str> {
    if is_declared(tool) { None } else { namespace(&tool.name) }
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
