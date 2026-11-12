//! Progressive organization commands over the same Catalog used by the application.
//! Stable object identities and immutable observation recipes are separate: names may
//! change, while a delayed mutation still checks exactly the version the model read.
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use varin_runtime::catalog::{
    model_references::ReferenceKind,
    organization::*,
    threads::{ThreadDelete, ThreadUpdate},
};
use varin_runtime::execution::*;
use varin_runtime::{Catalog, Effect, Lifetime, Outcome};

fn error(value: impl ToString) -> ExecutionError {
    ExecutionError::new("organization", value.to_string())
}
/// A page obtains names once from the existing Host owners, without making a
/// profile/configuration copy in Catalog. Missing owners are explicit presentation
/// states; they do not erase a valid conversation or grant another capability.
pub(crate) fn labels(
    catalog: &Arc<Mutex<Catalog>>,
    bridge: Option<&crate::host_query::OwnerChannel>,
    context: &ToolExecutionContext,
    call: &ToolCall,
    bots: Vec<String>,
    projects: Vec<String>,
    cancel: &CancellationToken,
) -> Value {
    let fallback = json!({"bots":bots.iter().map(|id|json!({"id":id,"name":null,"status":"unavailable"})).collect::<Vec<_>>(),
        "projects":projects.iter().map(|id|json!({"id":id,"name":null,"status":"unavailable"})).collect::<Vec<_>>()});
    if bots.is_empty() && projects.is_empty() {
        return fallback;
    }
    let result = (|| -> Result<Value, ExecutionError> {
        let bridge = bridge.ok_or_else(|| error("Name owner unavailable"))?;
        let capture = catalog
            .lock()
            .map_err(error)?
            .capture_tool_invocation(context, &call.call_id)
            .map_err(error)?;
        let invocation = capture.load().map_err(error)?;
        let checkpoint = invocation.frozen.resource_checkpoint_id;
        let result=bridge.query(json!({"runId":context.run_id,"origin":context.origin,"callId":call.call_id,"resourceCheckpointId":checkpoint,
            "request":{"kind":"organization","operationId":context.operation_id,"action":"labels","input":{"botIds":bots,"projectIds":projects}}}),cancel)?;
        if result["status"] != "ready" {
            return Err(error("Name owner unavailable"));
        }
        Ok(result["result"].clone())
    })();
    result.unwrap_or(fallback)
}
pub(crate) fn label(labels: &Value, domain: &str, id: &str) -> Value {
    labels[domain]
        .as_array()
        .and_then(|values| values.iter().find(|v| v["id"] == id))
        .cloned()
        .unwrap_or_else(|| json!({"id":id,"name":null,"status":"unavailable"}))
}
pub(crate) fn apply_labels(value: &mut Value, labels: &Value) {
    for key in ["sourceBot", "directBot"] {
        if let Some(id) = value[key].as_str().map(str::to_owned) {
            value[key] = label(labels, "bots", &id);
        }
    }
    if let Some(project) = value["projectId"].as_str().map(str::to_owned) {
        let named = label(labels, "projects", &project);
        value["name"] = named["name"].clone();
        value["availability"] = named["status"].clone();
    }
    if let Some(path) = value["path"].as_array_mut() {
        for node in path {
            apply_labels(node, labels);
        }
    }
}
const ACTIONS: &[&str] = &[
    "describe",
    "list",
    "create_group",
    "update_group",
    "move",
    "dissolve",
    "create_conversation",
    "create_bot_conversation",
    "rename",
    "pin",
    "archive",
    "restore",
    "delete",
];
pub(crate) fn schema() -> ToolSchema {
    ToolSchema {name:"organization".into(),version:"1".into(),requirements:None,output_schema:None,metadata:None,
        description:"发现并整理与用户共享的会话分类。list 浏览分组、项目和会话，describe 返回指定操作的输入合同。使用返回的稳定对象引用，变更携带 observation 引用以保护读到的版本；无需用户ID、内部ID或revision。分类不改变执行来源，归档不停止执行，解散分组提升成员而不删除历史。".into(),
        schema:json!({"type":"object","properties":{"action":{"type":"string","enum":ACTIONS},"input":{"type":"object"}},"required":["action"],"additionalProperties":false})}
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    action: String,
    #[serde(default)]
    input: Value,
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    operation: Option<String>,
    reference: Option<String>,
    observation: Option<String>,
    #[serde(default)]
    observations: Vec<String>,
    container: Option<String>,
    #[serde(default)]
    root_only: Option<bool>,
    #[serde(default)]
    recursive: bool,
    query: Option<String>,
    archived: Option<String>,
    bot_id: Option<String>,
    limit: Option<u64>,
    cursor: Option<String>,
    name: Option<String>,
    #[serde(default, deserialize_with = "nullable_text")]
    icon: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable_text")]
    color: Option<Option<String>>,
    before: Option<String>,
    #[serde(default)]
    targets: Vec<String>,
    pinned: Option<bool>,
}
fn nullable_text<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}
fn parse(call: &ToolCall) -> Result<(Arguments, Input), ExecutionError> {
    let args: Arguments = serde_json::from_value(call.arguments.clone()).map_err(error)?;
    if !ACTIONS.contains(&args.action.as_str()) {
        return Err(error("Unknown organization action"));
    }
    if let Some(input) = args.input.as_object() {
        if args.action == "list" && input.contains_key("cursor") && input.len() != 1 {
            return Err(error(
                "Use the returned cursor alone to continue its original query",
            ));
        }
        let description = action_schema(&args.action)?;
        for key in input.keys() {
            if description["properties"].get(key).is_none() {
                return Err(error(format!("{key} is not an input to {}", args.action)));
            }
        }
    }
    let input = if args.input.is_null() {
        Input::default()
    } else {
        serde_json::from_value(args.input.clone()).map_err(error)?
    };
    Ok((args, input))
}
fn action_schema(action: &str) -> Result<Value, ExecutionError> {
    let text = json!({"type":"string","minLength":1});
    let mut properties = serde_json::Map::new();
    let mut required = Vec::new();
    let fields: &[&str] = match action {
        "describe" => &["operation"],
        "list" => &[
            "container",
            "rootOnly",
            "recursive",
            "query",
            "archived",
            "botId",
            "limit",
            "cursor",
        ],
        "create_group" => &[
            "observation",
            "container",
            "name",
            "icon",
            "color",
            "before",
        ],
        "update_group" => &["observation", "reference", "name", "icon", "color"],
        "move" => &["observation", "targets", "container", "before"],
        "dissolve" => &["observation", "reference"],
        "create_conversation" => &["observation", "container"],
        "create_bot_conversation" => &["observation", "botId", "container"],
        "rename" => &["observation", "reference", "name"],
        "pin" => &["observation", "reference", "pinned"],
        "archive" | "restore" | "delete" => &["observation", "reference"],
        _ => return Err(error("Unknown organization operation")),
    };
    if !matches!(action, "describe" | "list") {
        properties.insert("observations".into(),json!({"type":"array","minItems":1,"items":text,"description":"Combine original observations from separate pages or branches; conflicting versions of an actually used object or parent require rereading."}));
    }
    for field in fields {
        properties.insert((*field).into(),match *field {
        "rootOnly"|"recursive"|"pinned"=>json!({"type":"boolean"}),
        "targets"=>json!({"type":"array","minItems":1,"items":text}),
        "limit"=>json!({"type":"integer","minimum":1}),
        "archived"=>json!({"type":"string","enum":["exclude","include","only"]}),
        "icon"|"color"=>json!({"type":["string","null"],"description":"null 恢复主题默认"}),
        "container"=>json!({"type":["string","null"],"description":"稳定容器引用；省略或null为根下，不改变已有会话的执行来源"}),
        _=>text.clone(),
    });
    }

    if matches!(
        action,
        "update_group" | "dissolve" | "rename" | "pin" | "archive" | "restore" | "delete"
    ) {
        required.push("reference");
    }
    if matches!(action, "create_group" | "rename") {
        required.push("name");
    }
    if action == "move" {
        required.push("targets");
    }
    if action == "pin" {
        required.push("pinned");
    }
    if action == "create_bot_conversation" {
        required.push("botId");
    }
    Ok(
        json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),
    )
}
pub(crate) fn declaration(
    catalog: Arc<Mutex<Catalog>>,
    bridge: crate::host_query::OwnerChannel,
) -> varin_runtime::composition::tools::ToolDeclaration {
    varin_runtime::composition::tools::ToolDeclaration::new(
        schema(),
        Arc::new(Tools { catalog, bridge }),
    )
}
struct Tools {
    catalog: Arc<Mutex<Catalog>>,
    bridge: crate::host_query::OwnerChannel,
}
fn reference(
    db: &Catalog,
    principal: Option<&str>,
    value: &str,
) -> Result<OrganizationObject, ExecutionError> {
    if value.starts_with("container:") {
        let selected = db
            .resolve_model_reference(ReferenceKind::Container, value)
            .map_err(error)?;
        if selected.owner
            != format!(
                "organization:{}",
                serde_json::to_string(&principal).map_err(error)?
            )
        {
            return Err(error("Container belongs to another organization"));
        }
        return Ok(OrganizationObject::Container {
            id: selected.target["containerId"]
                .as_str()
                .ok_or_else(|| error("Container reference has no identity"))?
                .into(),
        });
    }
    if let Some(id) = db.resolve_external_agent(value).map_err(error)? {
        return Ok(OrganizationObject::External { id });
    }
    let identity = db.agent_identity(value).map_err(error)?;
    Ok(OrganizationObject::Native {
        id: identity["threadId"]
            .as_str()
            .ok_or_else(|| error("Conversation identity unavailable"))?
            .into(),
    })
}
fn container_ref(
    db: &Catalog,
    principal: Option<&str>,
    id: &str,
    holder: &str,
) -> Result<String, ExecutionError> {
    db.register_model_reference(
        ReferenceKind::Container,
        &format!(
            "organization:{}",
            serde_json::to_string(&principal).map_err(error)?
        ),
        &json!({"containerId":id}),
        holder,
    )
    .map_err(error)
}
fn agent_ref(db: &Catalog, reference: &ConversationRef) -> Result<String, ExecutionError> {
    match reference {
        ConversationRef::Native { id } => Ok(db.agent_identity(id).map_err(error)?["agentId"]
            .as_str()
            .ok_or_else(|| error("Agent identity missing"))?
            .into()),
        ConversationRef::External { id } => db.external_agent_reference(id).map_err(error),
    }
}
fn conversation(object: &OrganizationObject) -> Result<ConversationRef, ExecutionError> {
    match object {
        OrganizationObject::Native { id } => Ok(ConversationRef::Native { id: id.clone() }),
        OrganizationObject::External { id } => Ok(ConversationRef::External { id: id.clone() }),
        _ => Err(error("This operation requires a conversation")),
    }
}
fn observed(
    snapshots: &[OrganizationSnapshot],
    object: &OrganizationObject,
) -> Result<(u64, Option<String>), ExecutionError> {
    let mut selected = None;
    for snapshot in snapshots {
        let candidate = match object {
            OrganizationObject::Container { id } => snapshot
                .containers
                .iter()
                .find(|c| c.id == *id)
                .map(|c| (c.revision, c.parent_id.clone())),
            _ => {
                let r = conversation(object)?;
                snapshot
                    .conversations
                    .iter()
                    .find(|c| c.conversation == r)
                    .map(|c| (c.position.revision, c.position.container_id.clone()))
            }
        };
        if let Some(candidate) = candidate {
            if selected.as_ref().is_some_and(|prior| prior != &candidate) {
                return Err(error(
                    "Conflicting observations of this object; reread its directory",
                ));
            }
            selected = Some(candidate);
        }
    }
    selected.ok_or_else(|| {
        error("Object was not in these observations; read the relevant directory first")
    })
}
fn parents(
    snapshots: &[OrganizationSnapshot],
    ids: Vec<Option<String>>,
) -> Result<Vec<ParentVersion>, ExecutionError> {
    ids.into_iter()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .map(|id| {
            let mut selected = None;
            for snapshot in snapshots {
                let revision = match &id {
                    None => Some(snapshot.root_revision),
                    Some(id) => snapshot
                        .containers
                        .iter()
                        .find(|c| c.id == *id)
                        .map(|c| c.children_revision),
                };
                if let Some(revision) = revision {
                    if selected.is_some_and(|prior| prior != revision) {
                        return Err(error(
                            "Conflicting observations of an affected parent; reread its directory",
                        ));
                    }
                    selected = Some(revision);
                }
            }
            Ok(ParentVersion {
                container_id: id,
                children_revision: selected
                    .ok_or_else(|| error("Affected parent was not in these observations"))?,
            })
        })
        .collect()
}
fn metadata_entry<'a>(
    snapshots: &'a [OrganizationSnapshot],
    target: &ConversationRef,
) -> Result<&'a ConversationEntry, ExecutionError> {
    let mut selected: Option<&ConversationEntry> = None;
    for snapshot in snapshots {
        if let Some(entry) = snapshot
            .conversations
            .iter()
            .find(|e| &e.conversation == target)
        {
            if selected.is_some_and(|prior| prior.revision != entry.revision) {
                return Err(error(
                    "Conflicting observations of conversation metadata; reread it",
                ));
            }
            selected = Some(entry);
        }
    }
    selected.ok_or_else(|| error("Conversation is not in these observations"))
}

impl Tools {
    fn authorize_call(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        cancel: &CancellationToken,
    ) -> Result<varin_runtime::catalog::tool_content::ToolInvocationSnapshot, ExecutionError> {
        if cancel.is_cancelled() {
            return Err(error("Organization command cancelled"));
        }
        let capture = self
            .catalog
            .lock()
            .map_err(error)?
            .capture_tool_invocation(context, &call.call_id)
            .map_err(error)?;
        let invocation = capture.load().map_err(error)?;
        if invocation.call != *call || !invocation.tools.contains(&schema()) {
            return Err(error(
                "Organization is not selected in this original invocation",
            ));
        }
        let db = self.catalog.lock().map_err(error)?;
        db.validate_tool_invocation(&invocation, true)
            .map_err(error)?;
        let run = db.run(&context.run_id).map_err(error)?;
        let entry = db
            .organization_conversation(
                run.principal_id.as_deref(),
                &ConversationRef::Native { id: run.thread_id },
            )
            .map_err(error)?;
        if entry.origin.direct_bot_id.is_none() {
            return Err(error(
                "Principal-wide organization belongs to a direct Bot conversation, not a delegated Agent",
            ));
        }
        Ok(invocation)
    }
    fn host(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        action: &str,
        input: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, ExecutionError> {
        let capture = self
            .catalog
            .lock()
            .map_err(error)?
            .capture_tool_invocation(context, &call.call_id)
            .map_err(error)?;
        let invocation = capture.load().map_err(error)?;
        let checkpoint = invocation.frozen.resource_checkpoint_id;
        let reply=self.bridge.query_draining(json!({"runId":context.run_id,"origin":context.origin,"callId":call.call_id,
            "resourceCheckpointId":checkpoint,"request":{"kind":"organization","operationId":context.operation_id,"action":action,"input":input}}),cancel).map_err(|mut failure|{failure.details=Some(json!({"effect":"unknown","reason":"Host response was not received; reconcile the original operation before retrying"}));failure})?;
        if reply["status"] != "ready" {
            return Err(error(reply.get("reason").and_then(Value::as_str).unwrap_or("Organization Host operation failed"))
                .with_details(json!({"status":reply["status"],"effect":if matches!(reply["status"].as_str(),Some("unavailable"|"cancelled")|None){"unknown"}else{"none"}})));
        }
        if action == "external_metadata" && reply["result"]["status"] != "succeeded" {
            return Err(ExecutionError::new(reply["result"]["code"].as_str().unwrap_or("organization_metadata"),
                reply["result"]["message"].as_str().unwrap_or("External conversation owner did not complete this operation"))
                .with_details(json!({"status":reply["result"]["status"],"effect":if reply["result"]["status"]=="unknown" {"unknown"}else{"none"}})));
        }
        Ok(reply["result"].clone())
    }
    fn list(
        &self,
        db: &Catalog,
        context: &ToolExecutionContext,
        principal: Option<&str>,
        input: Input,
        project_names: Option<std::collections::BTreeMap<String, String>>,
    ) -> Result<Value, ExecutionError> {
        let mut query = OrganizationQuery {
            kind: None,
            sort: None,
            exclude_bot_conversations: None,
            conversation_tree: None,
            container_id: input
                .container
                .as_deref()
                .map(|v| {
                    db.resolve_organization_container(principal, v)
                        .map(|c| c.id)
                })
                .transpose()
                .map_err(error)?,
            root_only: input
                .root_only
                .unwrap_or(input.query.is_none() && !input.recursive),
            page_nodes: true,
            project_names: None,
            recursive: input.recursive,
            query: input.query,
            bot_id: input.bot_id,
            archived: input.archived,
            limit: input.limit.or(Some(30)),
            cursor: None,
        };
        if let Some(cursor) = input.cursor {
            let saved = db
                .resolve_model_reference(ReferenceKind::Read, &cursor)
                .map_err(error)?;
            if saved.owner != "organization_page" || saved.target["principal"] != json!(principal) {
                return Err(error("Directory continuation belongs to another owner"));
            }
            query = serde_json::from_value(saved.target["query"].clone()).map_err(error)?;
        }
        if query.query.as_ref().is_some_and(|q| !q.trim().is_empty()) {
            query.project_names = project_names;
        }
        let mut snapshot = db
            .organization_snapshot(principal, query.clone())
            .map_err(error)?;
        if !query.page_nodes {
            // The owner retains a shared tree; a focused model read need not publish
            // unrelated sibling branches. Keep matching nodes and necessary ancestors.
            let mut visible = std::collections::BTreeSet::new();
            for entry in &snapshot.conversations {
                visible.extend(entry.path.iter().cloned());
            }
            if query.bot_id.is_none() {
                for container in &snapshot.containers {
                    let mut ancestors = Vec::new();
                    let mut parent = container.parent_id.as_ref();
                    while let Some(id) = parent {
                        ancestors.push(id.clone());
                        parent = snapshot
                            .containers
                            .iter()
                            .find(|c| c.id == *id)
                            .and_then(|c| c.parent_id.as_ref());
                    }
                    let in_scope = if let Some(id) = &query.container_id {
                        container.id == *id
                            || container.parent_id.as_ref() == Some(id)
                            || (query.recursive && ancestors.contains(id))
                    } else {
                        !query.root_only || query.recursive || container.parent_id.is_none()
                    };
                    let matches = query.query.as_ref().is_none_or(|q| {
                        container
                            .name
                            .as_ref()
                            .is_some_and(|name| name.to_lowercase().contains(&q.to_lowercase()))
                    });
                    if in_scope && matches {
                        visible.insert(container.id.clone());
                        visible.extend(ancestors);
                    }
                }
            }
            snapshot.containers.retain(|c| visible.contains(&c.id));
        }
        let observation = db
            .register_model_reference(
                ReferenceKind::Read,
                "organization_observation",
                &json!({"principal":principal,"snapshot":snapshot,"runId":context.run_id}),
                &context.run_id,
            )
            .map_err(error)?;
        let mut containers = Vec::new();
        for c in &snapshot.containers {
            containers.push(json!({"ref":db.organization_container_reference(principal,&c.id,&context.run_id).map_err(error)?,"kind":c.kind,"name":c.name,
                "icon":c.icon,"color":c.color,"projectId":c.project_id,"parent":c.parent_id.as_deref().map(|id|db.organization_container_reference(principal,id,&context.run_id)).transpose().map_err(error)?}));
        }
        let mut conversations = Vec::new();
        for entry in &snapshot.conversations {
            let identity = agent_ref(db, &entry.conversation)?;
            conversations.push(json!({"ref":identity,"name":entry.title,"archived":entry.archived,"pinned":entry.pinned,
                "container":entry.position.container_id.as_deref().map(|id|db.organization_container_reference(principal,id,&context.run_id)).transpose().map_err(error)?,
                "sourceBot":entry.origin.bot_id,"directBot":entry.origin.direct_bot_id}));
        }
        let mut result = json!({"observation":observation,"containers":containers,"conversations":conversations});
        if let Some(items) = &snapshot.items {
            let ordered = items
                .iter()
                .map(|item| match item {
                    OrganizationObject::Container { id } => db
                        .organization_container_reference(principal, id, &context.run_id)
                        .map(|reference| json!({"kind":"container","ref":reference}))
                        .map_err(error),
                    OrganizationObject::Native { id } => {
                        agent_ref(db, &ConversationRef::Native { id: id.clone() })
                            .map(|reference| json!({"kind":"native","ref":reference}))
                    }
                    OrganizationObject::External { id } => {
                        agent_ref(db, &ConversationRef::External { id: id.clone() })
                            .map(|reference| json!({"kind":"external","ref":reference}))
                    }
                })
                .collect::<Result<Vec<_>, ExecutionError>>()?;
            result["items"] = json!(ordered);
        }
        if let Some(cursor) = snapshot.next_cursor {
            query.cursor = Some(cursor);
            query.project_names = None; // The owner continuation retains only its normalized scope names.
            let reference = db
                .register_model_reference(
                    ReferenceKind::Read,
                    "organization_page",
                    &json!({"principal":principal,"query":query}),
                    &context.run_id,
                )
                .map_err(error)?;
            result["nextRead"] = json!({"tool":"organization","arguments":{"action":"list","input":{"cursor":reference}}});
        }
        Ok(result)
    }
    fn run(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        cancel: &CancellationToken,
    ) -> Result<Value, ExecutionError> {
        let invocation = self.authorize_call(context, call, cancel)?;
        let (args, input) = parse(call)?;
        if args.action == "describe" {
            return match input.operation {
                Some(action) => Ok(json!({"action":action,"inputSchema":action_schema(&action)?})),
                None => Ok(
                    json!({"operations":ACTIONS,"usage":"describe with input.operation returns that operation's input schema"}),
                ),
            };
        }
        let mut db = self.catalog.lock().map_err(error)?;
        db.validate_tool_invocation(&invocation, true)
            .map_err(error)?;
        if cancel.is_cancelled() {
            return Err(error("Organization command cancelled before commit"));
        }
        let run = db.run(&context.run_id).map_err(error)?;
        let principal = run.principal_id.as_deref();
        if args.action == "list" {
            let searching = if let Some(cursor) = &input.cursor {
                let saved = db
                    .resolve_model_reference(ReferenceKind::Read, cursor)
                    .map_err(error)?;
                if saved.owner != "organization_page"
                    || saved.target["principal"] != json!(principal)
                {
                    return Err(error("Directory continuation belongs to another owner"));
                }
                saved.target["query"]["query"]
                    .as_str()
                    .is_some_and(|q| !q.trim().is_empty())
            } else {
                input.query.as_ref().is_some_and(|q| !q.trim().is_empty())
            };
            let project_ids = if searching {
                db.organization_project_ids(principal).map_err(error)?
            } else {
                Vec::new()
            };
            drop(db);
            let search_names = if searching {
                let value = self.host(
                    context,
                    call,
                    "labels",
                    json!({"botIds":[],"projectIds":project_ids}),
                    cancel,
                )?;
                let names = value["projects"]
                    .as_array()
                    .ok_or_else(|| error("Project names unavailable for search"))?;
                for id in &project_ids {
                    let named = names
                        .iter()
                        .find(|v| v["id"].as_str() == Some(id.as_str()))
                        .ok_or_else(|| error("Project names unavailable for search"))?;
                    if named["status"] != "available" && named["status"] != "missing" {
                        return Err(error("Project names unavailable for search"));
                    }
                }
                Some(value)
            } else {
                None
            };
            let project_names = search_names.as_ref().map(|v| {
                v["projects"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|p| {
                        Some((p["id"].as_str()?.to_owned(), p["name"].as_str()?.to_owned()))
                    })
                    .collect()
            });
            let db = self.catalog.lock().map_err(error)?;
            db.validate_tool_invocation(&invocation, true)
                .map_err(error)?;
            let mut page = self.list(&db, context, principal, input, project_names)?;
            let mut bots = std::collections::BTreeSet::new();
            let mut projects = std::collections::BTreeSet::new();
            for item in page["conversations"].as_array().into_iter().flatten() {
                for key in ["sourceBot", "directBot"] {
                    if let Some(id) = item[key].as_str() {
                        bots.insert(id.to_owned());
                    }
                }
            }
            for item in page["containers"].as_array().into_iter().flatten() {
                if let Some(id) = item["projectId"].as_str() {
                    projects.insert(id.to_owned());
                }
            }
            drop(db);
            let mut names = labels(
                &self.catalog,
                Some(&self.bridge),
                context,
                call,
                bots.into_iter().collect(),
                if search_names.is_some() {
                    Vec::new()
                } else {
                    projects.into_iter().collect()
                },
                cancel,
            );
            if let Some(search_names) = search_names {
                names["projects"] = search_names["projects"].clone();
            }
            for key in ["containers", "conversations"] {
                if let Some(items) = page[key].as_array_mut() {
                    for item in items {
                        apply_labels(item, &names);
                    }
                }
            }
            self.authorize_call(context, call, cancel)?;
            return Ok(page);
        }
        let refs = input
            .observation
            .iter()
            .chain(input.observations.iter())
            .collect::<Vec<_>>();
        if refs.is_empty() {
            return Err(error(
                "Use observation or observations returned with the directory",
            ));
        }
        let observations = refs
            .into_iter()
            .map(|reference| {
                db.organization_observation(principal, reference, &context.run_id)
                    .map_err(error)
            })
            .collect::<Result<Vec<_>, _>>()?;
        // Merge descriptive metadata only. CAS values are selected separately from
        // all original observations for each actually used object/parent below.
        let mut snapshot = observations[0].clone();
        for other in observations.iter().skip(1) {
            for c in &other.containers {
                if !snapshot.containers.iter().any(|old| old.id == c.id) {
                    snapshot.containers.push(c.clone());
                }
            }
        }
        let parent = input
            .container
            .as_deref()
            .map(|value| {
                let object = reference(&db, principal, value)?;
                observed(&observations, &object)?;
                match object {
                    OrganizationObject::Container { id } => Ok(id),
                    _ => Err(error("Destination must be a container")),
                }
            })
            .transpose()?;
        let before = input
            .before
            .as_deref()
            .map(|value| reference(&db, principal, value))
            .transpose()?;
        if let Some(anchor) = &before {
            let (_, anchor_parent) = observed(&observations, anchor)?;
            if anchor_parent != parent {
                return Err(error("Anchor was not observed in the destination parent"));
            }
        }
        let key = format!("organization-tool:{}", context.operation_id);
        if args.action == "create_bot_conversation" {
            let input = json!({"botId":input.bot_id.ok_or_else(||error("Select a Bot identity"))?,"key":key,"organization":{"containerId":parent}});
            drop(db);
            let result = self.host(context, call, "create_bot_conversation", input, cancel)?;
            let thread = result
                .pointer("/identity/threadId")
                .or_else(|| result.get("threadId"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    error("Bot owner returned no conversation identity")
                        .with_details(json!({"effect":"unknown"}))
                })?;
            let db = self.catalog.lock().map_err(error)?;
            return Ok(
                json!({"created":agent_ref(&db,&ConversationRef::Native{id:thread.into()})?,"bot":result.get("botId")}),
            );
        }
        if args.action == "create_conversation" {
            let request = json!({"key":key,"organization":{"containerId":parent}});
            drop(db);
            let result = self.host(context, call, "create_conversation", request, cancel)?;
            let thread = result["threadId"].as_str().ok_or_else(|| {
                error("Conversation owner returned no identity")
                    .with_details(json!({"effect":"unknown"}))
            })?;
            let db = self.catalog.lock().map_err(error)?;
            return Ok(
                json!({"created":agent_ref(&db,&ConversationRef::Native{id:thread.into()})?,"empty":true}),
            );
        }
        let operation = match args.action.as_str() {
            "create_group" => OrganizationOperation::Create {
                id: format!("group:{}", context.operation_id),
                kind: ContainerKind::Group,
                parents: parents(&observations, vec![parent.clone()])?,
                parent_id: parent,
                name: Some(input.name.ok_or_else(|| error("Group name required"))?),
                icon: input.icon.flatten(),
                color: input.color.flatten(),
                project_id: None,
                before,
            },
            "move" => {
                if input.targets.is_empty() {
                    return Err(error("Select at least one stable target reference"));
                }
                let mut items = Vec::new();
                let mut affected = vec![parent.clone()];
                for target in input.targets {
                    let object = reference(&db, principal, &target)?;
                    let (expected_revision, expected_parent_id) = observed(&observations, &object)?;
                    affected.push(expected_parent_id.clone());
                    items.push(MoveItem {
                        object,
                        expected_revision,
                        expected_parent_id,
                    });
                }
                OrganizationOperation::Move {
                    items,
                    parent_id: parent,
                    before,
                    parents: parents(&observations, affected)?,
                }
            }
            action => {
                let object = reference(
                    &db,
                    principal,
                    input
                        .reference
                        .as_deref()
                        .ok_or_else(|| error("Target reference required"))?,
                )?;
                let (revision, parent) =
                    if matches!(action, "rename" | "pin" | "archive" | "restore" | "delete") {
                        (0, None)
                    } else {
                        observed(&observations, &object)?
                    };
                match action {
                    "update_group" | "dissolve" => {
                        let OrganizationObject::Container { id } = object else {
                            return Err(error("Select a group container"));
                        };
                        let c = snapshot
                            .containers
                            .iter()
                            .find(|c| c.id == id)
                            .expect("observed container");
                        if c.kind != ContainerKind::Group {
                            return Err(error(
                                "Project settings and removal belong to the project owner",
                            ));
                        }
                        if action == "dissolve" {
                            OrganizationOperation::Dissolve {
                                id: id.clone(),
                                expected_revision: revision,
                                parents: parents(&observations, vec![Some(id), parent])?,
                            }
                        } else {
                            OrganizationOperation::Update {
                                id,
                                expected_revision: revision,
                                name: input.name,
                                icon: input.icon,
                                color: input.color,
                            }
                        }
                    }
                    "rename" | "pin" | "archive" | "restore" | "delete" => {
                        let target = conversation(&object)?;
                        let entry = metadata_entry(&observations, &target)?;
                        if let ConversationRef::External { id } = target {
                            // The original observation already binds the caller and target.
                            // The Host metadata owner checks tombstone ownership before its
                            // receipt lookup. A public-directory availability check here would
                            // reject retrying a deletion that committed before ToolSettled.
                            let original_ref = db.external_agent_reference(&id).map_err(error)?;
                            let mut request = json!({"conversationId":id,"expectedRevision":entry.revision,"key":key});
                            match action {
                                "delete" => request["delete"] = json!(true),
                                "rename" => {
                                    request["title"] = json!(
                                        input
                                            .name
                                            .ok_or_else(|| error("Conversation name required"))?
                                    )
                                }
                                "pin" => {
                                    request["pinned"] =
                                        json!(input.pinned.ok_or_else(|| error("pinned required"))?)
                                }
                                "archive" => request["archived"] = json!(true),
                                "restore" => request["archived"] = json!(false),
                                _ => unreachable!(),
                            }
                            drop(db);
                            let result =
                                self.host(context, call, "external_metadata", request, cancel)?;
                            return Ok(json!({"action":action,"ref":original_ref,"result":result}));
                        }
                        let ConversationRef::Native { id } = target else {
                            unreachable!()
                        };
                        // Resolve current principal/public scope before invoking the original metadata owner.
                        let owner = db.thread_principal(&id).map_err(error)?;
                        if owner.as_deref() != principal && !(owner.is_none() && db.thread_has_host_authority(&run.thread_id).map_err(error)?) {
                            return Err(error("Conversation belongs to another principal"));
                        }
                        let result = if action == "delete" {
                            db.delete_thread(&ThreadDelete {
                                thread_id: id,
                                key,
                                expected_revision: entry.revision,
                            })
                        } else {
                            db.update_thread(&ThreadUpdate {
                                thread_id: id,
                                key,
                                expected_revision: entry.revision,
                                title: if action == "rename" {
                                    Some(
                                        input
                                            .name
                                            .ok_or_else(|| error("Conversation name required"))?,
                                    )
                                } else {
                                    None
                                },
                                pinned: if action == "pin" {
                                    Some(input.pinned.ok_or_else(|| error("pinned required"))?)
                                } else {
                                    None
                                },
                                archived: match action {
                                    "archive" => Some(true),
                                    "restore" => Some(false),
                                    _ => None,
                                },
                                title_mode: None,
                            })
                        }
                        .map_err(error)?;
                        return Ok(
                            json!({"action":action,"ref":result["agent_code"],"name":result["title"],"archived":result["archived"],"pinned":result["pinned"],"deleted":action=="delete"}),
                        );
                    }
                    _ => return Err(error("Unknown organization operation")),
                }
            }
        };
        let changed_containers = match &operation {
            OrganizationOperation::Create { id, .. } | OrganizationOperation::Update { id, .. } => {
                vec![id.clone()]
            }
            OrganizationOperation::Move { items, .. } => items
                .iter()
                .filter_map(|item| {
                    if let OrganizationObject::Container { id } = &item.object {
                        Some(id.clone())
                    } else {
                        None
                    }
                })
                .collect(),
            OrganizationOperation::Dissolve { .. } | OrganizationOperation::Restore { .. } => {
                Vec::new()
            }
        };
        let receipt = db
            .organization_command(principal, OrganizationCommand { key, operation })
            .map_err(error)?;
        let mut changed = Vec::new();
        // Only report the selected objects, preserving the original receipt on retry.
        for id in changed_containers {
            let container = receipt
                .containers
                .iter()
                .find(|c| c.id == id)
                .ok_or_else(|| error("Organization receipt is missing its changed container"))?;
            changed.push(json!({"ref":container_ref(&db,principal,&id,&context.run_id)?,"name":container.name,"kind":container.kind,
                "parent":container.parent_id.as_deref().map(|id|container_ref(&db,principal,id,&context.run_id)).transpose()?,"icon":container.icon,"color":container.color}));
        }
        for p in receipt.positions {
            changed.push(json!({"ref":agent_ref(&db,&p.conversation)?,"container":p.container_id.as_deref().map(|id|container_ref(&db,principal,id,&context.run_id)).transpose()?}));
        }
        let removed = receipt
            .removed
            .iter()
            .map(|id| container_ref(&db, principal, id, &context.run_id))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!({"action":args.action,"changed":changed,"removedContainers":removed}))
    }
}
impl ToolExecutor for Tools {
    fn plan(
        &self,
        call: &ToolCall,
        request: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(call, request, cancel)
            .map(ToolPreparation::Ready)
    }
    fn prepare(
        &self,
        call: &ToolCall,
        request: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        let (args, _) = parse(call)?;
        if cancel.is_cancelled()
            || call.name != "organization"
            || call.schema_version != "1"
            || !request.tools.contains(&schema())
        {
            return Err(error("Organization capability is not selected"));
        }
        Ok(ToolContract {
            name: call.name.clone(),
            schema_version: call.schema_version.clone(),
            read_only: matches!(args.action.as_str(), "describe" | "list"),
            completion: CompletionKind::Result,
            lifetime: Lifetime::Run,
            resources: Vec::new(),
        })
    }
    fn authorize(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        _: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        self.authorize_call(context, call, cancel).map(|_| ())
    }
    fn execute(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        match self.run(context, call, cancel) {
            Ok(value) => ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                effect: if contract.read_only {
                    Effect::None
                } else {
                    Effect::Confirmed
                },
                content: value.into(),
            },
            Err(failure) => ToolCompletion::Result {
                outcome: if cancel.is_cancelled() {
                    Outcome::Cancelled
                } else {
                    Outcome::Failed
                },
                effect: if failure
                    .details
                    .as_ref()
                    .is_some_and(|d| d["effect"] == "unknown")
                {
                    Effect::Unknown
                } else {
                    Effect::None
                },
                content: json!({"error":failure}).into(),
            },
        }
    }
}

#[cfg(test)]
mod observation_tests {
    use super::*;
    fn group(db: &mut Catalog, id: &str, parent: Option<&str>) {
        let snapshot = db
            .organization_snapshot(None, OrganizationQuery::default())
            .unwrap();
        let version = parent
            .map(|id| {
                snapshot
                    .containers
                    .iter()
                    .find(|c| c.id == id)
                    .unwrap()
                    .children_revision
            })
            .unwrap_or(snapshot.root_revision);
        db.organization_command(
            None,
            OrganizationCommand {
                key: format!("create-{id}"),
                operation: OrganizationOperation::Create {
                    id: id.into(),
                    kind: ContainerKind::Group,
                    parent_id: parent.map(str::to_owned),
                    name: Some(id.into()),
                    icon: None,
                    color: None,
                    project_id: None,
                    parents: vec![ParentVersion {
                        container_id: parent.map(str::to_owned),
                        children_revision: version,
                    }],
                    before: None,
                },
            },
        )
        .unwrap();
    }
    #[test]
    fn separate_page_observations_move_to_observed_anchor_without_global_conflicts() {
        let directory = std::env::temp_dir().join(format!(
            "organization-observations-{}",
            uuid::Uuid::new_v4()
        ));
        let mut db = Catalog::open(&directory).unwrap();
        group(&mut db, "a", None);
        group(&mut db, "b", None);
        group(&mut db, "source", Some("a"));
        group(&mut db, "anchor", Some("b"));
        let source_page = db
            .organization_snapshot(
                None,
                OrganizationQuery {
                    page_nodes: true,
                    container_id: Some("a".into()),
                    limit: Some(1),
                    ..Default::default()
                },
            )
            .unwrap();
        // A change in an unrelated root branch is not a dependency of this move.
        group(&mut db, "unrelated", None);
        let target_page = db
            .organization_snapshot(
                None,
                OrganizationQuery {
                    page_nodes: true,
                    container_id: Some("b".into()),
                    limit: Some(1),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_ne!(source_page.root_revision, target_page.root_revision);
        let observations = vec![source_page.clone(), target_page];
        let source = OrganizationObject::Container {
            id: "source".into(),
        };
        let anchor = OrganizationObject::Container {
            id: "anchor".into(),
        };
        let (expected_revision, expected_parent_id) = observed(&observations, &source).unwrap();
        assert_eq!(
            observed(&observations, &anchor).unwrap().1,
            Some("b".into())
        );
        let versions = parents(
            &observations,
            vec![expected_parent_id.clone(), Some("b".into())],
        )
        .unwrap();
        db.organization_command(
            None,
            OrganizationCommand {
                key: "move-across-pages".into(),
                operation: OrganizationOperation::Move {
                    items: vec![MoveItem {
                        object: source.clone(),
                        expected_revision,
                        expected_parent_id,
                    }],
                    parent_id: Some("b".into()),
                    before: Some(anchor),
                    parents: versions,
                },
            },
        )
        .unwrap();
        let moved = db.resolve_organization_container(None, "source").unwrap();
        assert_eq!(moved.parent_id.as_deref(), Some("b"));
        assert!(
            moved.order
                < db.resolve_organization_container(None, "anchor")
                    .unwrap()
                    .order
        );
        let reread = db
            .organization_snapshot(
                None,
                OrganizationQuery {
                    page_nodes: true,
                    container_id: Some("b".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(observed(&[source_page, reread], &source).is_err());
        drop(db);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn only_actual_parent_dependencies_conflict_across_observations() {
        let snapshot = |version: u64| {
            serde_json::from_value::<OrganizationSnapshot>(json!({"initialized":true,"revision":version,"rootRevision":version,"cursor":version,"containers":[{"id":"unused","kind":"group","parentId":null,"order":0,"revision":version,"childrenRevision":version,"name":"unused"},{"id":"used","kind":"group","parentId":null,"order":1,"revision":1,"childrenRevision":2,"name":"used"}],"conversations":[],"nextCursor":null})).unwrap()
        };
        let reads = vec![snapshot(1), snapshot(2)];
        assert_eq!(
            parents(&reads, vec![Some("used".into())]).unwrap()[0].children_revision,
            2
        );
        assert!(parents(&reads, vec![Some("unused".into())]).is_err());
        assert!(parents(&reads, vec![None]).is_err());
        assert!(
            observed(
                &reads,
                &OrganizationObject::Container {
                    id: "unused".into()
                }
            )
            .is_err()
        );
        assert_eq!(
            observed(&reads, &OrganizationObject::Container { id: "used".into() })
                .unwrap()
                .0,
            1
        );
    }
}

#[cfg(test)]
#[path = "organization_tools_review.rs"]
mod review;
