//! A stable model interface over the original executable directory. Disclosure is conversation
//! data; it never adds declarations to the provider's tools or grants execution authority.
use crate::execution::{ExecutionError, ToolSchema};
use serde_json::json;

pub const DESCRIBE: &str = "tool_describe";
pub const INVOKE: &str = "tool_invoke";
pub const GROUPS: &[(&str, &str)] = &[
    ("files", "File reading, editing and recovery"),
    ("execution", "Processes, terminal interaction and managed scripts"),
    ("collaboration", "Agents, conversation history, code exchange and follow-ups"),
    ("documents", "Web search, page/document reading and retained material collections"),
    ("media", "Image generation, editing and generated visual interfaces"),
    (
        "research",
        "Scholarly search and publication relationships",
    ),
    (
        "desktop",
        "Desktop observation, input and control assignments",
    ),
    ("browser", "Built-in pages and the explicitly assigned Computer browser; observation, input and file transfer"),
    ("office", "DOCX/XLSX/PPTX files, rendering and conversion; connected Office applications"),
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
        (INVOKE, "使用工具的 reference（名称和版本）及符合其参数定义的 arguments 调用当前目录中的能力。reference 可从 tool_describe 取得并在有效时复用。未在本次 tools 中单独声明的工具通过本入口调用；可用范围与原工具权限保持一致。".into(),
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
    model_tools_for(tools, None)
}

/// The exact direct set belongs to the prepared request; the full directory still owns execution.
pub fn model_tools_for(tools: &[ToolSchema], direct: Option<&[String]>) -> Option<Vec<ToolSchema>> {
    if !enabled(tools) {
        return None;
    }
    let mut visible = tools
        .iter()
        .filter(|tool| is_declared_for(tool, direct))
        .cloned()
        .collect::<Vec<_>>();
    visible.sort_by(|a, b| a.name.cmp(&b.name));
    Some(visible)
}

pub fn is_declared(tool: &ToolSchema) -> bool {
    is_always_declared(&tool.name)
        || tool.metadata.as_ref().is_some_and(|metadata| metadata.always_declared)
}

pub fn is_declared_for(tool: &ToolSchema, direct: Option<&[String]>) -> bool {
    direct.map_or_else(|| is_declared(tool), |names| names.contains(&tool.name))
}

/// Only the default presentation changes with focus. Availability is the owning directory's job.
pub fn direct_tools(tools: &[ToolSchema], focus: &str) -> Option<Vec<String>> {
    if !enabled(tools) { return None; }
    let mut names = tools.iter().filter(|tool| {
        let name = tool.name.as_str();
        if name.starts_with("mcp_") || is_gateway(tool)
            || tool.metadata.as_ref().is_some_and(|metadata| metadata.always_declared) { return true; }
        match focus {
            "research" => matches!(name,
                "websearch" | "webfetch" | "document_read" | "materials" | "resource_read" | "research_search"
                | "file_list" | "file_search" | "file_read" | "file_write" | "file_edit" | "code_retrieval"
                | "process_spawn" | "process_read" | "process_write" | "process_inspect" | "process_stop" | "wait_process"
                | "script_open" | "script_run" | "script_close" | "dispatch" | "send" | "threads" | "read_thread"
                | "child_status" | "child_report" | "wait_child" | "child_cancel" | "ask_user" | "question_status"
                | "todo" | "memory" | "render_ui" | "goal_report"),
            "code" => is_always_declared(name),
            _ => (is_always_declared(name) && !matches!(name, "process_resize" | "script_open" | "script_run" | "script_close" | "threads" | "read_thread")
                && !(focus == "office" && matches!(name, "file_restore" | "recovery_points" | "follow_up")))
                || name == "document_read"
                || focus == "office" && (name.starts_with("browser_") || name.starts_with("office_") || matches!(name,
                    "script_open" | "script_run" | "script_close" | "materials"
                    | "computer_list" | "computer_apps" | "computer_observe" | "computer_act" | "computer_control"
                    | "computer_cancel" | "computer_release" | "computer_request" | "computer_access"
                    | "computer_grant" | "computer_deny" | "computer_wait" | "computer_open" | "computer_environment"
                    | "computer_browser" | "computer_browser_read" | "computer_office" | "computer_office_read")),
        }
    }).map(|tool| tool.name.clone()).collect::<Vec<_>>();
    names.sort();
    Some(names)
}

/// Actual interface relationships, used only to make adjacent available tools
/// discoverable. These are not an execution order or additional prerequisites.
pub fn related(name: &str) -> &'static [&'static str] {
    match name {
        "browser_tabs" | "browser_open" | "browser_read" | "browser_act" | "browser_files" =>
            &["browser_tabs", "browser_open", "browser_read", "browser_act", "browser_files", "document_read", "office_read"],
        "office_read" | "office_write" | "office_render" | "office_export" | "office_environment" =>
            &["office_read", "office_write", "office_render", "office_export", "office_environment", "document_read", "file_restore"],
        "computer_browser" | "computer_browser_read" | "computer_office" | "computer_office_read" =>
            &["computer_list", "computer_environment", "computer_control", "computer_request", "computer_access", "computer_observe", "computer_release"],
        "computer_act" | "computer_open" => &["computer_list", "computer_observe", "computer_control", "computer_request", "computer_release"],
        "research_search" => &["websearch", "webfetch", "document_read", "materials"],
        "document_read" | "materials" => &["document_read", "materials", "office_read", "office_render"],
        "dispatch" => &["child_status", "child_report", "wait_child", "child_cancel", "send", "threads", "read_thread", "agent_rename"],
        "process_spawn" | "process_read" | "process_write" => &["process_inspect", "process_read", "process_write", "process_stop", "wait_process"],
        "file_restore" | "recovery_points" => &["file_read", "file_restore", "recovery_points"],
        _ => &[],
    }
}

/// The same admission rule is used by protocol decoders and the executor, including brokered adapters.
pub fn model_tool<'a>(tools: &'a [ToolSchema], name: &str) -> Result<&'a ToolSchema, ExecutionError> {
    model_tool_for(tools, None, name)
}

pub fn model_tool_for<'a>(tools: &'a [ToolSchema], direct: Option<&[String]>, name: &str) -> Result<&'a ToolSchema, ExecutionError> {
    let tool = tools.iter().find(|tool| tool.name == name).ok_or_else(|| call_error(
        "unknown_tool_schema", name, "This tool is not available to the current request. Use tool_describe to inspect the available directory; tool_invoke cannot enable an unavailable tool."))?;
    if enabled(tools) && !is_declared_for(tool, direct) {
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
    if name.starts_with("mcp_") || matches!(name, DESCRIBE | INVOKE) { return None; }
    Some(match name {
        "file_read" | "file_write" | "file_edit" | "file_search" | "file_list" | "file_restore" | "recovery_points" => "files",
        "process_spawn" | "process_read" | "process_write" | "process_inspect" | "process_stop" | "process_resize" | "wait_process"
        | "script_open" | "script_run" | "script_close" => "execution",
        "dispatch" | "child_status" | "child_report" | "child_cancel" | "wait_child" | "threads" | "read_thread"
        | "send" | "agent_rename" | "submit_code" | "update" | "follow_up"
        | "ask_user" | "question_status" | "todo" | "memory" | "goal_report" => "collaboration",
        "websearch" | "webfetch" | "document_read" | "materials" | "resource_read" => "documents",
        "image_generate" | "image_edit" | "render_ui" => "media",
        "code_retrieval" => "files",
        "research_search" => "research",
        name if name.starts_with("browser_") => "browser",
        name if name.starts_with("office_") => "office",
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
