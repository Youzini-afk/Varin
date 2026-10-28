//! Read capability documentation as tool output; execute through the existing nested lifecycle.
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use varin_runtime::{
    Catalog, Effect, Lifetime, Outcome, execution::*, nested_tools::NestedToolInput,
    tool_disclosure as disclosure,
};

#[derive(Clone, Deserialize, serde::Serialize, Default)]
#[serde(deny_unknown_fields)]
struct Describe {
    #[serde(skip_serializing_if = "Option::is_none")]
    namespace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    names: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
}
#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Reference {
    name: String,
    version: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Invoke {
    reference: Reference,
    arguments: Value,
}
enum Request {
    Describe(Describe),
    Invoke(Invoke),
}
fn error(value: impl ToString) -> ExecutionError {
    ExecutionError::new("tool_disclosure", value.to_string())
}

pub(crate) fn definitions() -> Vec<crate::run_tools::BuiltinSchema> {
    use varin_runtime::catalog::dispatch::{
        ChildPresetDefault::{Retrieval, Worker},
        ChildSourceRequirement::None,
    };
    disclosure::schemas()
        .into_iter()
        .map(|schema| crate::run_tools::BuiltinSchema::child(schema, None, &[Worker, Retrieval]))
        .collect()
}
pub(crate) fn declarations(
    catalog: Arc<Mutex<Catalog>>,
) -> Vec<varin_runtime::composition::tools::ToolDeclaration> {
    let owner = Arc::new(Capabilities {
        catalog,
        index: Mutex::new(None),
    });
    disclosure::schemas()
        .into_iter()
        .map(|schema| {
            varin_runtime::composition::tools::ToolDeclaration::new(schema, owner.clone())
        })
        .collect()
}
struct Capabilities {
    catalog: Arc<Mutex<Catalog>>,
    // Derived data for the last frozen directory; replacement releases the old projection.
    index: Mutex<Option<Arc<DocumentationIndex>>>,
}
struct DocumentationIndex {
    tools: Arc<Vec<ToolSchema>>,
    identity: String,
    search: Vec<(usize, String, Vec<String>)>,
    operation_views: Mutex<std::collections::HashMap<(String, String), Value>>,
}
impl Capabilities {
    fn index(&self, frozen: &FrozenToolContext) -> Result<Arc<DocumentationIndex>, ExecutionError> {
        let mut held = self.index.lock().map_err(error)?;
        if let Some(index) = held.as_ref().filter(|index| index.tools == frozen.tools) {
            return Ok(index.clone());
        }
        let index = Arc::new(DocumentationIndex {
            operation_views: Mutex::new(std::collections::HashMap::new()),
            identity: varin_runtime::tool_documentation::identity(&frozen.tools),
            search: frozen
                .tools
                .iter()
                .enumerate()
                .map(|(i, tool)| {
                    let declaration = varin_runtime::tool_documentation::declaration(tool);
                    let group = varin_runtime::tool_documentation::namespace(tool).unwrap_or("");
                    (
                        i,
                        format!(
                            "{} {group} {} {}",
                            tool.description,
                            varin_runtime::tool_documentation::schema_terms(&tool.schema),
                            declaration
                                .map(|d| d
                                    .operations
                                    .iter()
                                    .map(|op| format!("{} {}", op.name, op.description))
                                    .collect::<Vec<_>>()
                                    .join(" "))
                                .unwrap_or_default()
                        ),
                        declaration.map(|d| d.aliases.clone()).unwrap_or_default(),
                    )
                })
                .collect(),
            tools: frozen.tools.clone(),
        });
        *held = Some(index.clone());
        Ok(index)
    }
}
struct Call {
    owner: Arc<Capabilities>,
    frozen: FrozenToolContext,
    name: String,
    request: Request,
}
fn parse(call: &ToolCall, frozen: &FrozenToolContext) -> Result<Request, ExecutionError> {
    if !frozen.tools.iter().any(|schema| {
        schema.name == call.name
            && schema.version == call.schema_version
            && disclosure::is_gateway(schema)
    }) {
        return Err(error("disclosure interface is not bound"));
    }
    match call.name.as_str() {
        disclosure::DESCRIBE => {
            let args: Describe = serde_json::from_value(call.arguments.clone()).map_err(error)?;
            if args.cursor.is_some() {
                if call
                    .arguments
                    .as_object()
                    .is_none_or(|fields| fields.len() != 1)
                {
                    return Err(error("Use cursor alone to continue the original query."));
                }
                varin_runtime::tool_documentation::Continuation::decode(
                    args.cursor.as_deref().unwrap(),
                )?;
                return Ok(Request::Describe(args));
            }
            if (args.name.is_some() || args.names.is_some())
                && (args.namespace.is_some() || args.query.is_some())
                || args.name.is_some() && args.names.is_some()
                || args.name.as_ref().is_some_and(|v| v.trim().is_empty())
                || args.names.as_ref().is_some_and(|names| {
                    names.is_empty() || names.iter().any(|name| name.trim().is_empty())
                })
                || args.query.as_ref().is_some_and(|v| v.trim().is_empty())
                || args
                    .detail
                    .as_deref()
                    .is_some_and(|value| !matches!(value, "summary" | "full"))
                || (args.operation.is_some() || args.path.is_some()) && args.name.is_none()
                || args
                    .path
                    .as_deref()
                    .is_some_and(|path| !path.is_empty() && !path.starts_with('/'))
                || args.operation.as_ref().is_some_and(|v| v.trim().is_empty())
            {
                return Err(error(
                    "Choose name, names, or a namespace/query filter. detail is summary or full.",
                ));
            }
            Ok(Request::Describe(args))
        }
        disclosure::INVOKE => {
            let args: Invoke = serde_json::from_value(call.arguments.clone()).map_err(error)?;
            if !args.arguments.is_object() {
                return Err(error(
                    "tool_invoke.arguments must be an object matching the target parameters returned by tool_describe",
                ));
            }
            let target = frozen.tools.iter().find(|tool| tool.name == args.reference.name)
                .ok_or_else(|| error(format!("Tool {:?} is not available to this request. Use tool_describe to check the selected capabilities; tool_invoke does not enable unavailable tools.", args.reference.name)))?;
            if disclosure::is_gateway(target) {
                return Err(error(
                    "Call the registered tool_describe or tool_invoke function directly; a gateway cannot invoke another gateway.",
                ));
            }
            if target.version != args.reference.version {
                return Err(error(format!(
                    "The reference for tool {:?} does not match this request's version. Call tool_describe with this name and use the returned reference unchanged.",
                    target.name
                )));
            }
            Ok(Request::Invoke(args))
        }
        _ => Err(error("unknown disclosure operation")),
    }
}
fn contract(name: &str) -> ToolContract {
    // The gateway only delivers a receipt. Actual effects and independent Jobs belong to
    // the nested target Operation, which runs its own authorization and resource admission.
    ToolContract {
        name: name.into(),
        schema_version: "1".into(),
        read_only: true,
        completion: CompletionKind::Result,
        lifetime: Lifetime::Call,
        resources: vec![],
    }
}
impl ToolExecutor for Capabilities {
    fn bind_call(
        self: Arc<Self>,
        call: &ToolCall,
        frozen: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<Box<dyn PreparedToolCall>, ExecutionError> {
        Ok(Box::new(Call {
            request: parse(call, frozen)?,
            owner: self,
            frozen: frozen.clone(),
            name: call.name.clone(),
        }))
    }
    fn plan(
        &self,
        call: &ToolCall,
        frozen: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(call, frozen, cancel)
            .map(ToolPreparation::Ready)
    }
    fn prepare(
        &self,
        call: &ToolCall,
        frozen: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        parse(call, frozen)?;
        Ok(contract(&call.name))
    }
    fn authorize(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        Err(error("bound disclosure invocation required"))
    }
    fn execute(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        ToolCompletion::NotDispatched {
            reason: "bound disclosure invocation required".into(),
            error: None,
        }
    }
}
impl Call {
    fn describe(&self, supplied: &Describe) -> Result<Value, ExecutionError> {
        use varin_runtime::tool_documentation as docs;
        let index = self.owner.index(&self.frozen)?;
        let directory = docs::identity(&(
            &index.identity,
            &self.frozen.direct_tools,
            &self.frozen.child_dispatch,
        ));
        let (args, offset) = if let Some(cursor) = &supplied.cursor {
            let continuation = docs::Continuation::decode(cursor)?;
            if continuation.directory != directory {
                return Ok(
                    json!({"status":"directory_changed","message":"The frozen tool directory changed. Repeat the original query.","query":continuation.selection}),
                );
            }
            (
                serde_json::from_value::<Describe>(continuation.selection).map_err(error)?,
                continuation.offset,
            )
        } else {
            (supplied.clone(), 0)
        };
        let selection = serde_json::to_value(&args).map_err(error)?;
        let budget = self.frozen.tool_output_visible_bytes;
        let tools = index
            .tools
            .iter()
            .filter(|tool| !disclosure::is_gateway(tool))
            .collect::<Vec<_>>();
        let read = |key: &str, entries: Vec<Value>, envelope: Value| {
            docs::page(
                envelope,
                key,
                &entries,
                &directory,
                &selection,
                offset,
                budget,
                disclosure::DESCRIBE,
            )
        };
        if let Some(name) = &args.name {
            let Some(tool) = tools.iter().find(|tool| tool.name == *name) else {
                return Ok(
                    json!({"status":"unavailable","name":name,"message":"This tool is not in the current frozen directory."}),
                );
            };
            let mut entry = self.detail(tool, &args)?;
            if let Some(path) = &args.path {
                let value = entry
                    .pointer(path)
                    .ok_or_else(|| error("contract path does not exist"))?
                    .clone();
                let fragment = json!({"name":name,"view":"fragment","path":path,"value":value});
                if offset == 0 && budget.is_none_or(|budget| docs::bytes(&fragment) <= budget) {
                    return Ok(fragment);
                }
                entry = docs::structure(
                    &entry,
                    path,
                    name,
                    disclosure::DESCRIBE,
                    &json!({"name":name,"detail":"full","operation":args.operation}),
                )?;
                if let Some(nodes) = entry["nodes"].as_array().cloned() {
                    entry.as_object_mut().unwrap().remove("nodes");
                    return Ok(read("nodes", nodes, entry));
                }
                return Ok(
                    self.text_fragment(name, path, &value, offset, budget, &directory, &selection)
                );
            }
            if offset > 0 || budget.is_some_and(|budget| docs::bytes(&entry) > budget) {
                if let Some(operations) = entry["operations"].as_array().cloned() {
                    return Ok(read(
                        "operations",
                        operations,
                        json!({"name":name,"view":"operations","description":docs::summary(tool),"reference":entry["reference"],"full":entry["full"]}),
                    ));
                }
            }
            self.fit_detail(&mut entry, tool, budget);
            return Ok(entry);
        }
        let selected = if let Some(names) = &args.names {
            let mut seen = std::collections::HashSet::new();
            names
                .iter()
                .filter(|name| seen.insert(*name))
                .map(|name| match tools.iter().find(|tool| tool.name == *name) {
                    Some(tool) => {
                        let entry = self.detail(
                            tool,
                            &Describe {
                                name: Some(name.clone()),
                                detail: args.detail.clone(),
                                ..Default::default()
                            },
                        )?;
                        Ok(entry)
                    }
                    None => Ok(json!({"status":"unavailable","name":name})),
                })
                .collect::<Result<Vec<_>, ExecutionError>>()?
        } else if args.namespace.is_some() || args.query.is_some() {
            if args.namespace.is_none() && args.detail.as_deref() != Some("summary") {
                if let Some(tool) = tools.iter().find(|tool| {
                    args.query
                        .as_ref()
                        .is_some_and(|q| tool.name.eq_ignore_ascii_case(q.trim()))
                }) {
                    let mut entry = self.detail(
                        tool,
                        &Describe {
                            name: Some(tool.name.clone()),
                            detail: args.detail.clone(),
                            ..Default::default()
                        },
                    )?;
                    self.fit_detail(&mut entry, tool, budget);
                    entry["match"] = "exact_name".into();
                    return Ok(entry);
                }
            }
            let mut matches = index
                .search
                .iter()
                .filter_map(|(i, text, aliases)| {
                    let tool = &index.tools[*i];
                    if disclosure::is_gateway(tool)
                        || args
                            .namespace
                            .as_deref()
                            .is_some_and(|group| docs::namespace(tool) != Some(group))
                    {
                        return None;
                    }
                    let score = args.query.as_ref().map_or(1, |query| {
                        docs::search_score(query, &tool.name, text, aliases)
                    });
                    (score > 0).then_some((score, tool))
                })
                .collect::<Vec<_>>();
            matches.sort_by(|(sa, a), (sb, b)| sb.cmp(sa).then_with(|| a.name.cmp(&b.name)));
            matches
                .into_iter()
                .map(|(_, tool)| {
                    let entry = if args.detail.as_deref() == Some("full") {
                        self.detail(
                            tool,
                            &Describe {
                                name: Some(tool.name.clone()),
                                detail: Some("full".into()),
                                ..Default::default()
                            },
                        )?
                    } else {
                        self.summary(tool)
                    };
                    Ok(entry)
                })
                .collect::<Result<Vec<_>, ExecutionError>>()?
        } else {
            let mut groups = std::collections::BTreeMap::<String, Vec<&ToolSchema>>::new();
            for tool in tools {
                if let Some(group) = docs::namespace(tool) {
                    groups.entry(group.into()).or_default().push(tool);
                }
            }
            let entries=groups.into_iter().map(|(id,members)|json!({"namespace":id,
                "description":disclosure::GROUPS.iter().find(|(group,_)|*group==id).map_or(id.as_str(),|(_,description)|*description),
                "toolCount":members.len(),"directToolCount":members.iter().filter(|tool|disclosure::is_declared_for(tool,self.frozen.direct_tools.as_deref())).count()})).collect();
            let mut envelope = json!({"scope":"current_frozen_directory"});
            if self
                .frozen
                .tools
                .iter()
                .any(|tool| tool.name == "mcp_discover")
            {
                envelope["mcp"] = json!({"tool":"mcp_discover","scope":"Configured services and already discovered tools; undiscovered server contents are not searched here."});
            }
            return Ok(read("groups", entries, envelope));
        };
        let envelope = json!({"scope":"current_frozen_directory","namespace":args.namespace,"query":args.query,
            "status":if selected.is_empty(){"no_matches"}else{"available"},"matchScope":"Matches in this directory; browse groups or change the query to explore other capabilities."});
        let mut selected = selected;
        let allowance = docs::entry_budget(
            &envelope,
            "tools",
            &directory,
            &selection,
            selected.len(),
            budget,
            disclosure::DESCRIBE,
        );
        for entry in &mut selected {
            if let Some(tool) = entry["name"]
                .as_str()
                .and_then(|name| index.tools.iter().find(|tool| tool.name == name))
            {
                self.fit_detail(entry, tool, allowance);
            }
        }
        Ok(read("tools", selected, envelope))
    }
    fn summary(&self, tool: &ToolSchema) -> Value {
        use varin_runtime::tool_documentation as docs;
        json!({"name":tool.name,"description":docs::summary(tool),"namespace":docs::namespace(tool),
            "reference":{"name":tool.name,"version":tool.version},"requirements":tool.requirements,
            "directlyCallable":disclosure::is_declared_for(tool,self.frozen.direct_tools.as_deref()),
            "describe":{"tool":disclosure::DESCRIBE,"arguments":{"name":tool.name}}})
    }
    fn detail(&self, tool: &ToolSchema, args: &Describe) -> Result<Value, ExecutionError> {
        use varin_runtime::tool_documentation as docs;
        let mut value = self.summary(tool);
        if args.detail.as_deref() == Some("summary") {
            return Ok(value);
        }
        value["status"] = "available".into();
        value["description"] = tool.description.clone().into();
        value["invocation"] = if disclosure::is_declared_for(
            tool,
            self.frozen.direct_tools.as_deref(),
        ) {
            json!({"tool":tool.name})
        } else {
            json!({"tool":disclosure::INVOKE,"arguments":{"reference":{"name":tool.name,"version":tool.version},"arguments":{}}})
        };
        value["related"] = json!(
            disclosure::related(&tool.name)
                .iter()
                .filter(|name| **name != tool.name
                    && self.frozen.tools.iter().any(|tool| tool.name == **name))
                .collect::<Vec<_>>()
        );
        if let Some(metadata) = &tool.metadata {
            value["completion"] = json!(metadata.completion);
            if let Some(lifetime) = metadata.lifetime {
                value["lifetime"] = json!(lifetime);
            }
            if let Some(examples) = &metadata.examples {
                value["examples"] = json!(examples);
            }
        }
        let operations = docs::declaration(tool)
            .map(|d| d.operations.as_slice())
            .unwrap_or(&[]);
        if let Some(operation) = &args.operation {
            let Some(selected) = operations.iter().find(|entry| entry.name == *operation) else {
                return Err(error(
                    "Unknown operation. Read this tool's operation directory.",
                ));
            };
            value["operation"] = operation.clone().into();
            let index = self.owner.index(&self.frozen)?;
            let mut views = index.operation_views.lock().map_err(error)?;
            let key = (tool.name.clone(), operation.clone());
            if !views.contains_key(&key) {
                views.insert(key.clone(), docs::operation_schema(&tool.schema, selected)?);
            }
            value["parameters"] = views[&key].clone();
            value["view"] = if value["parameters"] == tool.schema {
                "complete"
            } else {
                "complete_operation"
            }
            .into();
        } else if !operations.is_empty()
            && args.detail.as_deref() != Some("full")
            && args.path.is_none()
        {
            value["view"] = "operations".into();
            value["operations"]=json!(operations.iter().map(|op|json!({"name":op.name,"description":op.description,
                "read":{"tool":disclosure::DESCRIBE,"arguments":{"name":tool.name,"operation":op.name}}})).collect::<Vec<_>>());
            value["full"] =
                json!({"tool":disclosure::DESCRIBE,"arguments":{"name":tool.name,"detail":"full"}});
        } else {
            value["parameters"] = tool.schema.clone();
            value["view"] = "complete".into();
        }
        if value.get("parameters").is_some() {
            if let Some(output) = &tool.output_schema {
                value["outputSchema"] = output.clone();
            }
        }
        if tool.name == "dispatch" {
            value["dispatch"] = self.dispatch()?;
        }
        Ok(value)
    }
    fn fit_detail(&self, value: &mut Value, tool: &ToolSchema, budget: Option<usize>) {
        use varin_runtime::tool_documentation as docs;
        if budget.is_none_or(|budget| docs::bytes(value) <= budget) {
            return;
        }
        let operation = value.get("operation").cloned();
        *value = self.summary(tool);
        value["view"] = "overview".into();
        value["message"] =
            "Read a named operation or an exact contract path for the complete contract.".into();
        value["contract"] = json!({"tool":disclosure::DESCRIBE,"arguments":{"name":tool.name,"detail":"full","operation":operation,"path":""}});
        if budget.is_some_and(|budget| docs::bytes(value) > budget) {
            value.as_object_mut().unwrap().remove("description");
            value["descriptionRead"] = json!({"tool":disclosure::DESCRIBE,"arguments":{"name":tool.name,"detail":"full","path":"/description"}});
        }
    }
    fn text_fragment(
        &self,
        name: &str,
        path: &str,
        value: &Value,
        offset: usize,
        budget: Option<usize>,
        directory: &str,
        selection: &Value,
    ) -> Value {
        use varin_runtime::tool_documentation as docs;
        // Exact JSON text, with UTF-8 boundaries and discovery continuation, not a truncated schema.
        let text = serde_json::to_string(value).expect("contract JSON");
        if !text.is_char_boundary(offset) || offset > text.len() {
            return json!({"status":"cursor_out_of_range"});
        }
        let boundaries = std::iter::once(offset)
            .chain(
                text[offset..]
                    .char_indices()
                    .map(|(i, c)| offset + i + c.len_utf8()),
            )
            .collect::<Vec<_>>();
        let fragment = |end: usize| {
            let mut value = json!({"name":name,"view":"json_text_fragment","path":path,"offset":offset,"text":text[offset..end]});
            if end < text.len() {
                value["next"] = json!({"tool":disclosure::DESCRIBE,"arguments":{"cursor":docs::Continuation {directory:directory.into(),selection:selection.clone(),offset:end}.encode()}});
            }
            value
        };
        let (mut lo, mut hi) = (0, boundaries.len() - 1);
        while lo < hi {
            let mid = (lo + hi + 1) / 2;
            if budget.is_none_or(|budget| docs::bytes(&fragment(boundaries[mid])) <= budget) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        if lo == 0 {
            return json!({"status":"budget_too_small","message":"The contract fragment and its continuation exceed the visible output budget."});
        }
        fragment(boundaries[lo])
    }
    fn dispatch(&self) -> Result<Value, ExecutionError> {
        let Some(reference) = &self.frozen.child_dispatch else {
            return Ok(json!({"status":"unavailable"}));
        };
        let read = self
            .owner
            .catalog
            .lock()
            .map_err(error)?
            .capture_child_dispatch(reference);
        Ok(crate::child_capabilities::discovery(
            &read.load().map_err(error)?,
        ))
    }
    fn run(&self, context: &ToolExecutionContext) -> Result<ToolCompletion, ExecutionError> {
        match &self.request {
            Request::Describe(args) => Ok(ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                effect: Effect::None,
                content: self.describe(args)?.into(),
            }),
            Request::Invoke(args) => {
                let nested = self.owner.catalog.lock().map_err(error)?.nested_tools();
                let receipt = nested.invoke(
                    &context.operation_id,
                    &varin_runtime::ExecutorOwner::Kernel,
                    NestedToolInput {
                        call_id: "target".into(),
                        name: args.reference.name.clone(),
                        arguments: args.arguments.clone(),
                    },
                )?;
                let failure = receipt.completion.error();
                let (outcome, completion, output) = match receipt.completion {
                    ToolCompletion::Result {
                        outcome,
                        effect,
                        content,
                    } => (
                        outcome,
                        json!({"kind":"result","outcome":outcome,"effect":effect}),
                        content,
                    ),
                    ToolCompletion::JobAccepted {
                        operation_id,
                        phase,
                        effect,
                        lifetime,
                        content,
                    } => (
                        Outcome::Succeeded,
                        json!({"kind":"job_accepted","operationId":operation_id,"phase":phase,"effect":effect,"lifetime":lifetime}),
                        content.unwrap_or_else(|| Value::Null.into()),
                    ),
                    ToolCompletion::NotDispatched { reason, .. } => (
                        if reason == "cancelled" {
                            Outcome::Cancelled
                        } else {
                            Outcome::Failed
                        },
                        json!({"kind":"not_dispatched","reason":reason}),
                        Value::Null.into(),
                    ),
                };
                let mut data = json!({"reference":args.reference,"operationId":receipt.operation_id,"completion":completion,"result":output.data});
                if let Some(error) = failure {
                    data["error"] = json!(error);
                }
                Ok(ToolCompletion::Result {
                    outcome,
                    effect: Effect::None,
                    content: varin_runtime::output::OutputBody {
                        data,
                        parts: output.parts,
                    },
                })
            }
        }
    }
}
impl PreparedToolCall for Call {
    fn requires_operation(&self) -> bool {
        matches!(self.request, Request::Invoke(_))
    }
    fn plan(&self, _: &CancellationToken) -> Result<ToolPreparation, ExecutionError> {
        Ok(ToolPreparation::Ready(contract(&self.name)))
    }
    fn prepare(&self, _: &CancellationToken) -> Result<ToolContract, ExecutionError> {
        Ok(contract(&self.name))
    }
    fn execution_class(
        &self,
        _: &ToolContract,
    ) -> varin_runtime::execution_capacity::ExecutionClass {
        varin_runtime::execution_capacity::ExecutionClass::Unmetered
    }
    fn watch_admission(
        &self,
        _: &ToolExecutionContext,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<Option<varin_runtime::execution_capacity::AdmissionControlGuard>, ExecutionError>
    {
        Ok(None)
    }
    fn supports_policy_read(&self, _: &ToolContract) -> bool {
        matches!(self.request, Request::Describe(_))
    }
    fn authorize(
        &self,
        context: &ToolExecutionContext,
        actual: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        if cancel.is_cancelled()
            || context.run_id != self.frozen.run_id
            || context.origin != self.frozen.origin
            || actual != &contract(&self.name)
        {
            return Err(error("disclosure invocation changed or cancelled"));
        }
        Ok(())
    }
    fn execute(
        &self,
        context: &ToolExecutionContext,
        actual: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolExecutionReceipt {
        let result = self
            .authorize(context, actual, cancel)
            .and_then(|_| self.run(context));
        ToolExecutionReceipt::local(
            result.unwrap_or_else(|err| ToolCompletion::Result {
                outcome: Outcome::Failed,
                effect: Effect::None,
                content: json!({"error":err}).into(),
            }),
            actual,
        )
    }
}

#[cfg(test)]
#[path = "capability_tools_review.rs"]
mod tests;
