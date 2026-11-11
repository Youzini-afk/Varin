//! Progressive organization commands over the same Catalog used by the application.
//! Stable object identities and immutable observation recipes are separate: names may
//! change, while a delayed mutation still checks exactly the version the model read.
use serde::Deserialize;
use serde_json::{json, Value};
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
    container: Option<String>,
    #[serde(default)]
    root_only: bool,
    #[serde(default)]
    recursive: bool,
    query: Option<String>,
    archived: Option<String>,
    bot_id: Option<String>,
    limit: Option<u64>,
    cursor: Option<String>,
    name: Option<String>,
    #[serde(default,deserialize_with="nullable_text")]
    icon: Option<Option<String>>,
    #[serde(default,deserialize_with="nullable_text")]
    color: Option<Option<String>>,
    before: Option<String>,
    #[serde(default)]
    targets: Vec<String>,
    pinned: Option<bool>,
}
fn nullable_text<'de,D:serde::Deserializer<'de>>(deserializer:D)->Result<Option<Option<String>>,D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}
fn parse(call: &ToolCall) -> Result<(Arguments, Input), ExecutionError> {
    let args: Arguments = serde_json::from_value(call.arguments.clone()).map_err(error)?;
    if !ACTIONS.contains(&args.action.as_str()) {
        return Err(error("Unknown organization action"));
    }
    if let Some(input) = args.input.as_object() {
        if args.action=="list" && input.contains_key("cursor") && input.len()!=1 {return Err(error("Use the returned cursor alone to continue its original query"));}
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
    if !matches!(action, "describe" | "list") {
        required.push("observation");
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
fn container_ref(db:&Catalog,principal:Option<&str>,id:&str,holder:&str)->Result<String,ExecutionError> {
    db.register_model_reference(ReferenceKind::Container,&format!("organization:{}",serde_json::to_string(&principal).map_err(error)?),&json!({"containerId":id}),holder).map_err(error)
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
fn observed<'a>(
    snapshot: &'a OrganizationSnapshot,
    object: &OrganizationObject,
) -> Result<(u64, Option<String>), ExecutionError> {
    match object {
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
    }
    .ok_or_else(|| error("Object was not in this observation; read the relevant directory first"))
}
fn parents(
    snapshot: &OrganizationSnapshot,
    ids: Vec<Option<String>>,
) -> Result<Vec<ParentVersion>, ExecutionError> {
    let ids = ids.into_iter().collect::<std::collections::BTreeSet<_>>();
    ids.into_iter()
        .map(|id| {
            let revision = match &id {
                None => snapshot.root_revision,
                Some(id) => {
                    snapshot
                        .containers
                        .iter()
                        .find(|c| c.id == *id)
                        .ok_or_else(|| error("Destination was not in this observation"))?
                        .children_revision
                }
            };
            Ok(ParentVersion {
                container_id: id,
                children_revision: revision,
            })
        })
        .collect()
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
            return Err(error("Principal-wide organization belongs to a direct Bot conversation, not a delegated Agent"));
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
        let checkpoint = invocation.frozen.resource_checkpoint_id.ok_or_else(|| {
            error("Organization Host operation has no frozen resource checkpoint")
        })?;
        let reply=self.bridge.query_draining(json!({"runId":context.run_id,"origin":context.origin,"callId":call.call_id,
            "resourceCheckpointId":checkpoint,"request":{"kind":"organization","operationId":context.operation_id,"action":action,"input":input}}),cancel).map_err(|mut failure|{failure.details=Some(json!({"effect":"unknown","reason":"Host response was not received; reconcile the original operation before retrying"}));failure})?;
        if reply["status"] != "ready" {
            return Err(error(
                reply
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("Organization Host operation failed"),
            ));
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
    ) -> Result<Value, ExecutionError> {
        let mut query = OrganizationQuery {
            container_id: input
                .container
                .as_deref()
                .map(|v| {
                    db.resolve_organization_container(principal, v)
                        .map(|c| c.id)
                })
                .transpose()
                .map_err(error)?,
            root_only: input.root_only,
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
        let mut snapshot = db.organization_snapshot(principal,query.clone()).map_err(error)?;
        // The owner retains a shared tree; a focused model read need not publish
        // unrelated sibling branches. Keep matching nodes and necessary ancestors.
        let mut visible=std::collections::BTreeSet::new();
        for entry in &snapshot.conversations {visible.extend(entry.path.iter().cloned());}
        if query.bot_id.is_none() {
            for container in &snapshot.containers {
                let mut ancestors=Vec::new();let mut parent=container.parent_id.as_ref();
                while let Some(id)=parent {ancestors.push(id.clone());parent=snapshot.containers.iter().find(|c|c.id==*id).and_then(|c|c.parent_id.as_ref());}
                let in_scope=if let Some(id)=&query.container_id {container.id==*id || container.parent_id.as_ref()==Some(id) || (query.recursive && ancestors.contains(id))}
                    else {!query.root_only || query.recursive || container.parent_id.is_none()};
                let matches=query.query.as_ref().is_none_or(|q|container.name.as_ref().is_some_and(|name|name.to_lowercase().contains(&q.to_lowercase())));
                if in_scope && matches {visible.insert(container.id.clone());visible.extend(ancestors);}
            }
        }
        snapshot.containers.retain(|c|visible.contains(&c.id));
        let observation = db
            .register_model_reference(
                ReferenceKind::Read,
                "organization_observation",
                &json!({"principal":principal,"snapshot":snapshot}),
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
        if let Some(cursor) = snapshot.next_cursor {
            query.cursor = Some(cursor);
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
        let invocation=self.authorize_call(context, call, cancel)?;
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
        db.validate_tool_invocation(&invocation,true).map_err(error)?;
        if cancel.is_cancelled(){return Err(error("Organization command cancelled before commit"));}
        let run = db.run(&context.run_id).map_err(error)?;
        let principal = run.principal_id.as_deref();
        if args.action == "list" {
            return self.list(&db, context, principal, input);
        }
        let observation = input
            .observation
            .as_deref()
            .ok_or_else(|| error("Use the observation reference returned with the directory"))?;
        let saved = db
            .resolve_model_reference(ReferenceKind::Read, observation)
            .map_err(error)?;
        if saved.owner != "organization_observation"
            || saved.target["principal"] != json!(principal)
        {
            return Err(error("Organization observation belongs to another owner"));
        }
        let snapshot: OrganizationSnapshot =
            serde_json::from_value(saved.target["snapshot"].clone()).map_err(error)?;
        let parent=input.container.as_deref().map(|value| {
            let object=reference(&db,principal,value)?;
            observed(&snapshot,&object)?;
            match object {OrganizationObject::Container{id}=>Ok(id),_=>Err(error("Destination must be a container"))}
        }).transpose()?;
        let before = input
            .before
            .as_deref()
            .map(|value| reference(&db, principal, value))
            .transpose()?;
        let key = format!("organization-tool:{}", context.operation_id);
        if args.action == "create_bot_conversation" {
            let input = json!({"botId":input.bot_id.ok_or_else(||error("Select a Bot identity"))?,"key":key,"organization":{"containerId":parent}});
            drop(db);
            let result = self.host(context, call, "create_bot_conversation", input, cancel)?;
            let thread = result
                .pointer("/identity/threadId")
                .or_else(|| result.get("threadId"))
                .and_then(Value::as_str)
                .ok_or_else(|| error("Bot owner returned no conversation identity"))?;
            let db = self.catalog.lock().map_err(error)?;
            return Ok(
                json!({"created":agent_ref(&db,&ConversationRef::Native{id:thread.into()})?,"bot":result.get("botId")}),
            );
        }
        if args.action == "create_conversation" {
            let id = format!("conversation:{}", context.operation_id);
            let branch = format!("branch:{}", context.operation_id);
            db.create_thread_with_placement(
                &id,
                &branch,
                principal,
                Some(Placement {
                    container_id: parent,
                }),
            )
            .map_err(error)?;
            let identity = db.agent_identity(&id).map_err(error)?;
            return Ok(json!({"created":identity["agentId"],"empty":true}));
        }
        let operation = match args.action.as_str() {
            "create_group" => OrganizationOperation::Create {
                id: format!("group:{}", context.operation_id),
                kind: ContainerKind::Group,
                parents: parents(&snapshot, vec![parent.clone()])?,
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
                    let (expected_revision, expected_parent_id) = observed(&snapshot, &object)?;
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
                    parents: parents(&snapshot, affected)?,
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
                let (revision, parent) = observed(&snapshot, &object)?;
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
                                parents: parents(&snapshot, vec![Some(id), parent])?,
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
                        let entry = snapshot
                            .conversations
                            .iter()
                            .find(|e| e.conversation == target)
                            .ok_or_else(|| error("Conversation is not in this observation"))?;
                        if let ConversationRef::External { id } = target {
                            db.organization_conversation(
                                principal,
                                &ConversationRef::External { id: id.clone() },
                            )
                            .map_err(error)?;
                            let original_ref = db.external_agent_reference(&id).map_err(error)?;
                            let mut request = json!({"conversationId":id,"expectedRevision":entry.revision,"key":key});
                            match action {
                                "delete" => request["delete"] = json!(true),
                                "rename" => {
                                    request["title"] = json!(input
                                        .name
                                        .ok_or_else(|| error("Conversation name required"))?)
                                }
                                "pin" => {
                                    request["pinned"] = json!(input
                                        .pinned
                                        .ok_or_else(|| error("pinned required"))?)
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
                        if db.thread_principal(&id).map_err(error)?.as_deref() != principal {
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
        let receipt = db
            .organization_command(principal, OrganizationCommand { key, operation })
            .map_err(error)?;
        let mut changed = Vec::new();
        // Only report this operation, not an unsolicited copy of the whole directory.
        if args.action == "create_group" {
            let id = format!("group:{}", context.operation_id);
            changed.push(json!({"ref":container_ref(&db,principal,&id,&context.run_id)?}));
        }
        for p in receipt.positions {
            changed.push(json!({"ref":agent_ref(&db,&p.conversation)?,"container":p.container_id.as_deref().map(|id|container_ref(&db,principal,id,&context.run_id)).transpose()?}));
        }
        Ok(
            json!({"action":args.action,"changed":changed,"removedContainers":receipt.removed.len()}),
        )
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
        self.authorize_call(context, call, cancel).map(|_|())
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
