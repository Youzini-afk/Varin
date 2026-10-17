//! A stable model interface over the original executable directory. Disclosure is conversation
//! data; it never adds declarations to the provider's tools or grants execution authority.
use crate::execution::ToolSchema;
use serde_json::json;

pub const DESCRIBE: &str = "tool_describe";
pub const INVOKE: &str = "tool_invoke";
pub const GROUPS: &[(&str, &str)] = &[
    ("files", "Read, find and edit workspace files"),
    (
        "code",
        "Code retrieval, symbols, references, types and diagnostics",
    ),
    (
        "execution",
        "Processes, terminal input and persistent JavaScript",
    ),
    (
        "collaboration",
        "Delegate work, read tasks, send messages and wait",
    ),
    (
        "conversation",
        "Questions, plans, memory, goals and follow-ups",
    ),
    ("web", "Web search and page reading"),
    ("documents", "PDF reading and retained material collections"),
    (
        "research",
        "Scholarly search and configured candidate judgments",
    ),
    ("images", "Generate and edit images"),
    (
        "interface",
        "Interactive content and skill/instruction resources",
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
    (
        "mcp",
        "Configured MCP servers, tools, resources, prompts and jobs",
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
        (DESCRIBE, format!("Read available capabilities by exact namespace or tool name. Omit both for the available group index. Returns parameters and version references for tool_invoke. Reuse descriptions in conversation history until unavailable or changed. Capability map: {index}."),
         json!({"type":"object","additionalProperties":false,"properties":{"namespace":{"type":"string","minLength":1},"name":{"type":"string","minLength":1}}})),
        (INVOKE, "Call a capability using the exact reference and arguments from tool_describe. Original validation and permissions apply. Results preserve the actual operation ID and output parts. Independent jobs return their original handle; use the corresponding wait/status capability. Never repeat a call whose effect is unknown.".into(),
         json!({"type":"object","additionalProperties":false,"required":["reference","arguments"],"properties":{
             "reference":{"type":"object","additionalProperties":false,"required":["name","version"],"properties":{"name":{"type":"string","minLength":1},"version":{"type":"string","minLength":1}}},
             "arguments":{"type":"object"}}})),
    ].into_iter().map(|(name, description, schema)| ToolSchema {
        name: name.into(), version: "1".into(), description, schema,
        requirements: None, output_schema: None, metadata: None,
    }).collect()
}

pub fn is_gateway(tool: &ToolSchema) -> bool {
    matches!(tool.name.as_str(), DESCRIBE | INVOKE)
        && definitions().iter().any(|owned| owned == tool)
}

pub fn enabled(tools: &[ToolSchema]) -> bool {
    definitions().iter().all(|owned| tools.contains(owned))
}

pub fn is_direct(name: &str) -> bool {
    matches!(
        name,
        DESCRIBE
            | INVOKE
            | "file_read"
            | "file_list"
            | "file_search"
            | "file_write"
            | "file_edit"
            | "process_spawn"
            | "process_read"
            | "process_write"
            | "process_inspect"
            | "wait_process"
            | "ask_user"
            | "todo"
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
        .filter(|tool| tool.metadata.is_none() && is_direct(&tool.name))
        .cloned()
        .collect::<Vec<_>>();
    visible.sort_by(|a, b| a.name.cmp(&b.name));
    Some(visible)
}

/// This is an explicit API classification, not keyword matching of user requests.
pub fn namespace(name: &str) -> &'static str {
    match name {
        "file_read" | "file_list" | "file_search" | "file_write" | "file_edit" => "files",
        "language_definition"
        | "language_references"
        | "language_diagnostics"
        | "language_hover"
        | "language_symbols"
        | "language_document_symbols"
        | "language_call_hierarchy"
        | "code_retrieval" => "code",
        "process_spawn" | "process_read" | "process_write" | "process_inspect"
        | "process_resize" | "wait_process" | "script_open" | "script_run" | "script_close" => {
            "execution"
        }
        "dispatch" | "child_status" | "child_report" | "wait_child" | "threads" | "read_thread"
        | "send" => "collaboration",
        "ask_user" | "question_status" | "todo" | "memory" | "goal_report" | "follow_up" => {
            "conversation"
        }
        "websearch" | "webfetch" => "web",
        "document_read" | "materials" => "documents",
        "research_search" | "research_decide" => "research",
        "image_generate" | "image_edit" => "images",
        "render_ui" | "resource_read" => "interface",
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
        name if name.starts_with("mcp_") => "mcp",
        _ => "extensions",
    }
}
