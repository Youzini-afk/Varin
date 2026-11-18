//! Per-call workspace routing. The Catalog stores location observations, never permits.
//! Resolve the target in the physical preparation lane and delegate to the native resource executor.
#[cfg(test)]
use crate::tools::ToolKind;
use crate::tools::{KernelResourceClient, KernelToolExecutor, ToolBinding};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, OnceLock};
use varin_runtime::{
    catalog::{
        launches::{SourceResourceOwner, SourceSelection},
        model_references::ReferenceKind,
    },
    composition::tools::ToolDeclaration,
    execution::*,
    execution_capacity::{AdmissionControlGuard, ExecutionClass},
    Catalog, Effect, ExecutorOwner, Lifetime, Outcome, SourceMode,
};

fn denied(reason: impl ToString) -> ExecutionError {
    ExecutionError::new("work_location_unavailable", reason.to_string())
}
pub(crate) fn alternate_tool(name: &str) -> bool {
    grant_capabilities(name).is_some()
}
pub(crate) fn grant_capabilities(name: &str) -> Option<&'static [&'static str]> {
    match name {
        "file_read" | "file_list" | "file_search" => Some(&["storage.read"]),
        "file_write" | "file_edit" => Some(&["storage.read", "storage.write"]),
        "process_spawn" => Some(&["storage.read", "storage.write", "process"]),
        _ => None,
    }
}
fn routed_schema(mut original: ToolSchema) -> ToolSchema {
    if original.name == "file_read" {
        return read_schema(original);
    }
    original.version = "3".into();
    let property = json!({"type":"string","description":"A work_locations reference. Omit for the request's default location or the original source of a file/read reference."});
    if original.schema.get("properties").is_some() {
        original.schema["properties"]["location"] = property;
    } else {
        original.schema["oneOf"][0]["properties"]["location"] = property;
    }
    original
}
fn conflict(reason: &str) -> ExecutionError {
    ExecutionError::new("work_location_conflict", reason)
}

pub(crate) fn eligible(source: Option<&SourceSelection>) -> bool {
    source.is_some_and(|s| {
        s.mode == SourceMode::LiveRoot
            && s.environment_run_id.is_none()
            && s.native_scope.is_none()
            && s.live_root.is_some()
    })
}
pub(crate) const NAME: &str = "work_locations";
const SWITCH: &str = "work_location_switch";
const TRANSFER: &str = "work_location_transfer";
pub(crate) fn is_control(name: &str) -> bool {
    matches!(name, NAME | SWITCH | TRANSFER)
}

pub(crate) fn schema() -> ToolSchema {
    ToolSchema { name:NAME.into(), version:"1".into(), description:
        "Find work locations by name, device or path. To resolve an unsaved directory, pass a returned device reference and a path on that device. Pass a location to a resource tool for this request or to work_location_switch for the next run.".into(),
        schema:json!({"type":"object","additionalProperties":false,"properties":{"query":{"type":"string"},"device":{"type":"string"},"path":{"type":"string"}},"dependentRequired":{"device":["path"],"path":["device"]}}),
        output_schema:None, requirements:None, metadata:None }
}
pub(crate) fn switch_schema() -> ToolSchema {
    ToolSchema {
        name: SWITCH.into(), version: "1".into(),
        description: "Set the conversation's working location for the next run. Use a location returned by work_locations. To use the other location in this run, pass its location to the resource tool directly.".into(),
        schema: json!({"type":"object","additionalProperties":false,"properties":{"location":{"type":"string"}},"required":["location"]}),
        output_schema: None, requirements: None, metadata: None,
    }
}
fn transfer_schema() -> ToolSchema {
    let end = json!({"type":"object","additionalProperties":false,"properties":{"location":{"type":"string"},"path":{"type":"string"}},"required":["location","path"]});
    ToolSchema {
        name: TRANSFER.into(), version: "1".into(),
        description: "Copy a file or folder between two work locations. Choose both locations and relative paths. With move:true the source is removed only after the destination confirms the original bytes.".into(),
        schema: json!({"type":"object","additionalProperties":false,"properties":{"from":end,"to":end,"move":{"type":"boolean"}},"required":["from","to"]}),
        output_schema: None, requirements: None, metadata: None,
    }
}
fn read_schema(mut original: ToolSchema) -> ToolSchema {
    original.version = "3".into();
    // A location is an invocation-level selector, not a new argument of the target
    // file protocol. One relative path only; the other forms keep their exact v2 semantics.
    let mut explicit = original.schema["oneOf"][0].clone();
    let fields = explicit["properties"].as_object_mut().expect("path reader");
    fields.remove("files");
    fields.remove("unit");
    fields.insert("location".into(),json!({"type":"string","minLength":1,"description":"One saved position returned by work_locations; omit to use the request default."}));
    explicit.as_object_mut().unwrap().remove("oneOf");
    explicit["required"] = json!(["location", "path"]);
    original.schema["oneOf"]
        .as_array_mut()
        .unwrap()
        .push(explicit);
    original
}
/// Only the exact routed declaration contains all of this native reader's ordinary forms.
/// The location branch and its executor belong to the parent Run, never the child.
pub(crate) fn wraps_native(routed: &ToolSchema, native: &ToolSchema) -> bool {
    alternate_tool(&native.name)
        && native.version == "2"
        && routed.name == native.name
        && routed.version == "3"
        && *routed == routed_schema(native.clone())
}
pub(crate) fn add_schemas(tools: &mut Vec<ToolSchema>) {
    if !tools.iter().any(|tool| tool.name == "file_read") {
        return;
    }
    for tool in tools.iter_mut().filter(|tool| alternate_tool(&tool.name)) {
        *tool = routed_schema(tool.clone());
    }
    tools.push(schema());
    tools.push(switch_schema());
    if tools.iter().any(|tool| tool.name == "file_write") {
        tools.push(transfer_schema());
    }
    tools.sort_by(|a, b| a.name.cmp(&b.name));
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Key {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    resource_owner: SourceResourceOwner,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Row {
    name: String,
    device: String,
    path: String,
    key: Option<Key>,
    unavailable: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Directory {
    locations: Vec<Row>,
    #[serde(default)]
    devices: Vec<Device>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Device {
    name: String,
    owner: SourceResourceOwner,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Search {
    query: Option<String>,
    device: Option<String>,
    path: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Switch {
    location: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TransferEnd {
    location: String,
    path: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Transfer {
    from: TransferEnd,
    to: TransferEnd,
    #[serde(default, rename = "move")]
    move_source: bool,
}

struct Owner {
    run_id: String,
    default: SourceSelection,
    catalog: Arc<Mutex<Catalog>>,
    resources: KernelResourceClient,
}
impl Owner {
    fn scope(
        &self,
        ctx: &ToolExecutionContext,
        cancel: &CancellationToken,
    ) -> Result<String, ExecutionError> {
        if ctx.run_id != self.run_id
            || cancel.is_cancelled()
            || !matches!(ctx.origin, ToolOrigin::ModelStep { .. })
        {
            return Err(denied(
                "Location selection requires an active ordinary native model request",
            ));
        }
        let c = self.catalog.lock().map_err(denied)?;
        let run = c.run(&ctx.run_id).map_err(denied)?;
        if run.state.terminal()
            || !c
                .thread_has_host_authority(&run.thread_id)
                .map_err(denied)?
            || c.child_task_for_thread(&run.thread_id)
                .map_err(denied)?
                .is_some()
            || c.is_context_job(&run.id).map_err(denied)?
            || c.launch_metadata(&run.id)
                .map_err(denied)?
                .and_then(|l| l.selection.source)
                .as_ref()
                != Some(&self.default)
        {
            return Err(denied(
                "Location selection is unavailable for this task or source",
            ));
        }
        c.validate_resource_snapshot_owner(&run.id, c.epoch(), &ctx.origin)
            .map_err(denied)?;
        Ok(run.thread_id)
    }
    fn list(
        &self,
        ctx: &ToolExecutionContext,
        call: &ToolCall,
        cancel: &CancellationToken,
    ) -> Result<Value, ExecutionError> {
        let thread = self.scope(ctx, cancel)?;
        let search: Search = serde_json::from_value(call.arguments.clone()).map_err(denied)?;
        let mut query = json!({"kind":"work_locations","runId":ctx.run_id,"threadId":thread,"callId":call.call_id,"origin":ctx.origin});
        if let Some(q) = search.query {
            query["query"] = json!(q);
        }
        match (search.device, search.path) {
            (Some(device), Some(path)) => {
                let catalog = self.catalog.lock().map_err(denied)?;
                let observed = catalog
                    .resolve_model_reference(ReferenceKind::Observation, &device)
                    .map_err(denied)?;
                if observed.owner != device_owner(&ctx.run_id) {
                    return Err(denied("Choose a device returned by work_locations"));
                }
                query["device"] = observed.target;
                query["path"] = json!(path);
            }
            (None, None) => (),
            _ => return Err(denied("A directory lookup needs both a device and a path")),
        }
        let rows: Directory =
            serde_json::from_value(self.resources.source_query(query, cancel)?).map_err(denied)?;
        self.scope(ctx, cancel)?;
        let catalog = self.catalog.lock().map_err(denied)?;
        let mut locations = Vec::new();
        for row in rows.locations {
            let mut view = json!({"name":row.name,"device":row.device,"path":row.path});
            match (row.key, row.unavailable) {
                (Some(key), None)
                    if key.id.as_ref().is_none_or(|id| !id.is_empty())
                        && key.path == row.path
                        && key.resource_owner.validate() =>
                {
                    // Scope the selection even when two Runs discovered exactly the same favourite.
                    let reference = catalog
                        .register_model_reference(
                            ReferenceKind::Observation,
                            &location_owner(&ctx.run_id),
                            &serde_json::to_value(key).map_err(denied)?,
                            &ctx.run_id,
                        )
                        .map_err(denied)?;
                    view["location"] = json!(reference);
                }
                (None, Some(reason)) => view["unavailable"] = json!(reason),
                _ => {
                    return Err(denied(
                        "Location directory returned an incomplete selection",
                    ))
                }
            }
            locations.push(view);
        }
        let devices = rows
            .devices
            .into_iter()
            .map(|device| {
                if !device.owner.validate() {
                    return Err(denied("Invalid resource device"));
                }
                let reference = catalog
                    .register_model_reference(
                        ReferenceKind::Observation,
                        &device_owner(&ctx.run_id),
                        &serde_json::to_value(device.owner).map_err(denied)?,
                        &ctx.run_id,
                    )
                    .map_err(denied)?;
                Ok(json!({"name":device.name,"device":reference}))
            })
            .collect::<Result<Vec<_>, ExecutionError>>()?;
        Ok(json!({"locations":locations,"devices":devices}))
    }
    fn current_key(&self, catalog: &Catalog, location: &str) -> Result<Key, ExecutionError> {
        let read = catalog
            .resolve_model_reference(ReferenceKind::Observation, location)
            .map_err(denied)?;
        if read.owner != location_owner(&self.run_id) {
            return Err(denied("This location is not an observation of this Run"));
        }
        serde_json::from_value(read.target).map_err(denied)
    }
    fn switch(
        &self,
        ctx: &ToolExecutionContext,
        call: &ToolCall,
        cancel: &CancellationToken,
    ) -> Result<Value, ExecutionError> {
        let thread = self.scope(ctx, cancel)?;
        let request: Switch = serde_json::from_value(call.arguments.clone()).map_err(denied)?;
        let (key, revision) = {
            let catalog = self.catalog.lock().map_err(denied)?;
            let run = catalog.run(&ctx.run_id).map_err(denied)?;
            (
                self.current_key(&catalog, &request.location)?,
                catalog
                    .branch_workspace_revision(&run.branch_id)
                    .map_err(denied)?,
            )
        };
        let prepared = self.resources.source_query(json!({
            "kind":"work_location_switch","runId":ctx.run_id,"threadId":thread,"operationId":ctx.operation_id,
            "origin":ctx.origin,"callId":call.call_id,"key":key
        }), cancel)?;
        let source: SourceSelection =
            serde_json::from_value(prepared["source"].clone()).map_err(denied)?;
        if !eligible(Some(&source))
            || source.resource_owner != key.resource_owner
            || key
                .workspace_id
                .as_ref()
                .is_some_and(|ws| ws != &source.workspace_id)
        {
            return Err(conflict("The prepared workspace changed"));
        }
        self.scope(ctx, cancel)?;
        let mut catalog = self.catalog.lock().map_err(denied)?;
        catalog
            .set_next_workspace_from_model(&ctx.run_id, revision, source)
            .map_err(|error| conflict(&error.to_string()))?;
        Ok(
            json!({"status":"selected","applies":"next_run","name":prepared["name"],"device":prepared["device"],"path":prepared["path"]}),
        )
    }
    fn transfer(
        &self,
        ctx: &ToolExecutionContext,
        call: &ToolCall,
        cancel: &CancellationToken,
    ) -> Result<Value, ExecutionError> {
        let thread = self.scope(ctx, cancel)?;
        let input: Transfer = serde_json::from_value(call.arguments.clone()).map_err(denied)?;
        if !relative(&input.from.path) || !relative(&input.to.path) {
            return Err(denied(
                "Choose paths relative to the source and destination locations",
            ));
        }
        let (from, to) = {
            let catalog = self.catalog.lock().map_err(denied)?;
            (
                self.current_key(&catalog, &input.from.location)?,
                self.current_key(&catalog, &input.to.location)?,
            )
        };
        self.resources.source_query(json!({
            "kind":"work_location_transfer","runId":ctx.run_id,"threadId":thread,"operationId":ctx.operation_id,
            "origin":ctx.origin,"callId":call.call_id,"move":input.move_source,
            "from":{"key":from,"path":input.from.path},"to":{"key":to,"path":input.to.path}
        }), cancel)
    }
}
fn location_owner(run: &str) -> String {
    format!("work-location:{run}")
}
fn device_owner(run: &str) -> String {
    format!("work-location-device:{run}")
}

pub(crate) fn route_declarations(
    declarations: &mut Vec<ToolDeclaration>,
    run_id: String,
    default: SourceSelection,
    catalog: Arc<Mutex<Catalog>>,
    resources: KernelResourceClient,
) {
    let owner = Arc::new(Owner {
        run_id,
        default,
        catalog,
        resources,
    });
    let mut routed = Vec::new();
    for declaration in std::mem::take(declarations) {
        if alternate_tool(&declaration.schema.name) {
            let schema = routed_schema(declaration.schema.clone());
            let router = Router {
                schema: schema.clone(),
                native: declaration,
                owner: owner.clone(),
            };
            routed.push(ToolDeclaration::new(schema, Arc::new(router)));
        } else {
            routed.push(declaration);
        }
    }
    routed.push(ToolDeclaration::new(self::schema(), owner.clone()));
    routed.push(ToolDeclaration::new(switch_schema(), owner.clone()));
    if routed.iter().any(|tool| tool.schema.name == "file_write") {
        routed.push(ToolDeclaration::new(transfer_schema(), owner));
    }
    *declarations = routed;
}
impl ToolExecutor for Owner {
    fn plan(
        &self,
        c: &ToolCall,
        f: &FrozenToolContext,
        t: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(c, f, t).map(ToolPreparation::Ready)
    }
    fn prepare(
        &self,
        c: &ToolCall,
        f: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        let expected = match c.name.as_str() {
            NAME => schema(),
            SWITCH => switch_schema(),
            TRANSFER => transfer_schema(),
            _ => return Err(denied("Unknown workspace tool")),
        };
        if c.schema_version != expected.version
            || !f.tools.contains(&expected)
            || f.source.as_ref() != Some(&self.default)
            || !matches!(f.origin, ToolOrigin::ModelStep { .. })
        {
            return Err(denied("Work locations are not selected for this request"));
        }
        match c.name.as_str() {
            SWITCH => {
                serde_json::from_value::<Switch>(c.arguments.clone()).map_err(denied)?;
            }
            TRANSFER => {
                serde_json::from_value::<Transfer>(c.arguments.clone()).map_err(denied)?;
            }
            _ => {
                serde_json::from_value::<Search>(c.arguments.clone()).map_err(denied)?;
            }
        }
        Ok(ToolContract {
            name: c.name.clone(),
            schema_version: c.schema_version.clone(),
            read_only: c.name == NAME,
            completion: CompletionKind::Result,
            lifetime: Lifetime::Run,
            resources: vec![],
        })
    }
    fn authorize(
        &self,
        ctx: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        t: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        self.scope(ctx, t).map(|_| ())
    }
    fn execute(
        &self,
        ctx: &ToolExecutionContext,
        c: &ToolCall,
        _: &ToolContract,
        t: &CancellationToken,
    ) -> ToolCompletion {
        let result = match c.name.as_str() {
            SWITCH => self.switch(ctx, c, t),
            TRANSFER => self.transfer(ctx, c, t),
            _ => self.list(ctx, c, t),
        };
        match result {
            Ok(body) => {
                let success = body["error"].is_null();
                ToolCompletion::Result {
                    outcome: if success {
                        Outcome::Succeeded
                    } else {
                        Outcome::Failed
                    },
                    effect: if c.name == NAME {
                        Effect::None
                    } else if success {
                        Effect::Confirmed
                    } else if body["copied"].as_u64().is_some_and(|count| count > 0) {
                        Effect::Partial
                    } else {
                        Effect::Unknown
                    },
                    content: body.into(),
                }
            }
            Err(e) if c.name == TRANSFER => ToolCompletion::failed(&e, Effect::Unknown),
            Err(e) => ToolCompletion::failed(&e, Effect::None),
        }
    }
}
struct Router {
    schema: ToolSchema,
    native: ToolDeclaration,
    owner: Arc<Owner>,
}
struct Alternate {
    expected: Option<SourceSelection>,
    owner: Arc<Owner>,
    location: Option<String>,
    call: ToolCall,
    frozen: FrozenToolContext,
}
struct Routed {
    default: Option<Box<dyn PreparedToolCall>>,
    alternate: Option<Alternate>,
    prepared: OnceLock<Box<dyn PreparedToolCall>>,
    lease: OnceLock<ReadLease>,
    native_version: String,
}
struct ReadLease {
    resources: KernelResourceClient,
    release: Value,
}
pub(crate) fn observe_original_process(
    resources: &KernelResourceClient,
    caller: &ToolExecutionContext,
    call: &ToolCall,
    thread: &str,
    process: &varin_runtime::OperationMetadata,
    source: &SourceSelection,
    read: Option<crate::process::text::ReadPage>,
    authorize_only: bool,
    cancel: &CancellationToken,
) -> Result<Value, ExecutionError> {
    if !matches!(caller.origin, ToolOrigin::ModelStep { .. }) {
        return Err(denied(
            "Cross-workspace process observation requires the conversation model",
        ));
    }
    let view = format!("process-view:{}", uuid::Uuid::new_v4());
    let result = resources.source_query(
        json!({"kind":"work_location_process_view","runId":caller.run_id,
        "threadId":thread,
        "operationId":view,"processId":process.id,"origin":caller.origin,"callId":call.call_id}),
        cancel,
    )?;
    let binding: ToolBinding = serde_json::from_value(result.clone()).map_err(denied)?;
    let _lease = ReadLease {
        resources: resources.clone(),
        release: json!({
            "kind":"work_location_release","runId":caller.run_id,"threadId":binding.thread_id,"operationId":view,"binding":result
        }),
    };
    if binding.source_selection().map_err(denied)? != *source || binding.run_id != process.run_id {
        return Err(conflict("Original process view changed"));
    }
    let mut original = caller.clone();
    original.run_id.clone_from(&process.run_id);
    resources.observe_process(
        &binding,
        &original,
        &process.id,
        &process.run_id,
        None,
        read,
        authorize_only,
        cancel,
    )
}
impl Drop for ReadLease {
    fn drop(&mut self) {
        let resources = self.resources.clone();
        let query = self.release.take();
        // Retire only this grant; independently retained target receipts can outlive it.
        let _ = std::thread::Builder::new()
            .name("release-location-read".into())
            .spawn(move || {
                let _ = resources.source_query(query, &CancellationToken::default());
            });
    }
}
impl ToolExecutor for Router {
    fn bind_call(
        self: Arc<Self>,
        c: &ToolCall,
        f: &FrozenToolContext,
        t: &CancellationToken,
    ) -> Result<Box<dyn PreparedToolCall>, ExecutionError> {
        if c.name != self.schema.name
            || c.schema_version != self.schema.version
            || !f.tools.contains(&self.schema)
            || f.source.as_ref() != Some(&self.owner.default)
        {
            return Err(denied("Workspace tool differs from its frozen request"));
        }
        let mut call = c.clone();
        let mut frozen = f.clone();
        // Delegate to the exact retained native v2 tool. Targets, including
        // older full Hosts, never receive the coordinator selector or this outer schema version.
        call.schema_version = self.native.schema.version.clone();
        let schemas = Arc::make_mut(&mut frozen.tools);
        *schemas.iter_mut().find(|s| *s == &self.schema).unwrap() = self.native.schema.clone();
        let location = call
            .arguments
            .as_object_mut()
            .and_then(|args| args.remove("location"));
        let original = call.arguments["ref"]
            .as_str()
            .map(|reference| {
                let catalog = self.owner.catalog.lock().map_err(denied)?;
                referenced_source(&catalog, reference, &call)
            })
            .transpose()?
            .flatten();
        let selection = if let Some(explicit) = location {
            let location = explicit
                .as_str()
                .filter(|v| !v.is_empty())
                .ok_or_else(|| denied("Choose a location returned by work_locations"))?;
            if call.name == "file_read" {
                validate_explicit(&call.arguments)?;
            } else if original.is_none() {
                validate_location_path(&call.name, &call.arguments)?;
            }
            Some((Some(location.to_owned()), original))
        } else if original
            .as_ref()
            .is_some_and(|source| source != &self.owner.default && eligible(Some(source)))
        {
            Some((None, original))
        } else {
            None
        };
        let (default, alternate) = if let Some((location, expected)) = selection {
            if !matches!(f.origin, ToolOrigin::ModelStep { .. }) {
                return Err(denied(
                    "Location selection requires an ordinary model request",
                ));
            }
            (
                None,
                Some(Alternate {
                    owner: self.owner.clone(),
                    location,
                    expected,
                    call,
                    frozen,
                }),
            )
        } else {
            (
                Some(
                    self.native
                        .implementation
                        .clone()
                        .bind_call(&call, &frozen, t)?,
                ),
                None,
            )
        };
        Ok(Box::new(Routed {
            default,
            alternate,
            prepared: OnceLock::new(),
            lease: OnceLock::new(),
            native_version: self.native.schema.version.clone(),
        }))
    }
    fn plan(
        &self,
        _: &ToolCall,
        _: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        Err(denied("Bind the file read before planning"))
    }
    fn prepare(
        &self,
        _: &ToolCall,
        _: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        Err(denied("Bind the file read before preparing"))
    }
    fn authorize(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        Err(denied("Bind the file read before authorizing"))
    }
    fn execute(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        ToolCompletion::not_dispatched(denied("Bind the file read before executing"))
    }
}
fn referenced_source(
    catalog: &Catalog,
    reference: &str,
    call: &ToolCall,
) -> Result<Option<SourceSelection>, ExecutionError> {
    use crate::resource_references::{self as refs, FileTarget, ReadTarget};
    if reference.starts_with("file:") {
        let target: FileTarget = refs::resolve(catalog, ReferenceKind::File, reference)?;
        return Ok(match target {
            FileTarget::Observation { source, path, .. }
                if eligible(Some(&source)) && relative(&path) =>
            {
                Some(source)
            }
            _ => None,
        });
    }
    if reference.starts_with("read:") {
        let read: ReadTarget = refs::resolve(catalog, ReferenceKind::Read, reference)?;
        if read.tool != call.name {
            return Err(conflict("A continuation must use its original tool"));
        }
        if call.name == "file_read"
            && read.arguments["ref"]
                .as_str()
                .is_some_and(|r| r.starts_with("file:"))
        {
            if !matches!(refs::resolve::<FileTarget>(catalog, ReferenceKind::File, read.arguments["ref"].as_str().unwrap())?,
                FileTarget::Observation { path, .. } if relative(&path))
            {
                return Ok(None);
            }
        }
        return Ok(read.source);
    }
    Ok(None)
}
pub(crate) fn validate_location_path(tool: &str, arguments: &Value) -> Result<(), ExecutionError> {
    let valid = match tool {
        "file_read" => {
            arguments["path"].as_str().is_some_and(relative)
                && ["ref", "unit", "files"]
                    .iter()
                    .all(|key| arguments.get(*key).is_none())
        }
        "file_list" | "file_search" => arguments.get("paths").is_none_or(|paths| {
            paths
                .as_array()
                .is_some_and(|paths| paths.iter().all(|path| path.as_str().is_some_and(relative)))
        }),
        "file_write" | "file_edit" => arguments["path"].as_str().is_some_and(relative),
        "process_spawn" => arguments.get("cwd").is_none_or(|cwd| {
            cwd.as_str()
                .is_some_and(|path| path.is_empty() || relative(path))
        }),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(denied("Use a path relative to the selected work location"))
    }
}
fn relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\0')
        && !path.starts_with(['/', '\\'])
        && !path.contains(':')
        && !path.split(['/', '\\']).any(|part| part == "..")
}
fn validate_explicit(args: &Value) -> Result<(), ExecutionError> {
    let fields = args
        .as_object()
        .ok_or_else(|| denied("A location read requires a relative path"))?;
    if fields.contains_key("ref") || fields.contains_key("files") {
        return Err(conflict(
            "A location requires one path, not a fixed reference or a file batch",
        ));
    }
    if fields.keys().any(|name| {
        !matches!(
            name.as_str(),
            "path" | "offset" | "length" | "encoding" | "raw" | "startLine" | "endLine"
        )
    }) || !fields
        .get("path")
        .and_then(Value::as_str)
        .is_some_and(relative)
    {
        return Err(denied(
            "A location read accepts a relative path and text or byte ranges only",
        ));
    }
    Ok(())
}

impl Routed {
    fn physical(&self, contract: &ToolContract) -> ToolContract {
        let mut contract = contract.clone();
        contract.schema_version.clone_from(&self.native_version);
        contract
    }
    fn inner(&self) -> Result<&dyn PreparedToolCall, ExecutionError> {
        self.default
            .as_deref()
            .or_else(|| self.prepared.get().map(|v| v.as_ref()))
            .ok_or_else(|| denied("Read location not prepared"))
    }
    fn resolve(&self, a: &Alternate, t: &CancellationToken) -> Result<(), ExecutionError> {
        let ctx = ToolExecutionContext {
            run_id: a.frozen.run_id.clone(),
            origin: a.frozen.origin.clone(),
            operation_id: a.frozen.origin.operation_id(&a.call.call_id),
        };
        let thread = a.owner.scope(&ctx, t)?;
        let key: Key = if let Some(location) = &a.location {
            let catalog = a.owner.catalog.lock().map_err(denied)?;
            a.owner.current_key(&catalog, location)?
        } else {
            let source = a
                .expected
                .as_ref()
                .ok_or_else(|| denied("File reference has no original source"))?;
            let root = source
                .live_root
                .as_ref()
                .ok_or_else(|| denied("File reference has no live root"))?;
            Key {
                id: None,
                resource_owner: source.resource_owner.clone(),
                workspace_id: Some(source.workspace_id.clone()),
                path: root.canonical_root.clone(),
            }
        };
        let query = json!({"kind":"work_location_bind","runId":ctx.run_id,"threadId":thread,"operationId":ctx.operation_id,
            "origin":ctx.origin,"callId":a.call.call_id,"tool":a.call.name,"key":key});
        let result = a.owner.resources.source_query(query, t)?;
        self.lease.set(ReadLease{resources:a.owner.resources.clone(),release:json!({"kind":"work_location_release","runId":ctx.run_id,"threadId":thread,"operationId":ctx.operation_id,"binding":result.clone()})}).map_err(|_|denied("Read was already prepared"))?;
        let binding: ToolBinding = serde_json::from_value(result).map_err(denied)?;
        let source = binding.source_selection().map_err(denied)?;
        if !eligible(Some(&source))
            || binding.run_id != ctx.run_id
            || binding.thread_id != thread
            || binding.resource_owner != key.resource_owner
            || key
                .workspace_id
                .as_ref()
                .is_some_and(|ws| ws != &binding.workspace_id)
            || binding
                .enabled_tools
                .iter()
                .map(|tool| tool.name())
                .collect::<BTreeSet<_>>()
                != [a.call.name.as_str()].into_iter().collect()
            || binding.remote_authority.is_some() == binding.resource_owner.is_local()
        {
            return Err(conflict(
                "Resource owner returned a different location or authority",
            ));
        }
        if a.expected
            .as_ref()
            .is_some_and(|original| original != &source)
        {
            return Err(conflict(
                "The saved location no longer identifies this file reference's original view",
            ));
        }
        a.owner.scope(&ctx, t)?;
        // Target bindings have their own immutable text/OS settings. Do not copy the request
        // default's execution environment into a foreign executor.
        let mut frozen = a.frozen.clone();
        frozen.execution_environment = None;
        let resources = a.owner.resources.clone();
        let resources = if let Some(location) = &a.location {
            resources.with_read_location(location.clone())
        } else {
            resources
        };
        let executor = Arc::new(KernelToolExecutor::new(binding, resources)?);
        self.prepared
            .set(executor.bind_call(&a.call, &frozen, t)?)
            .map_err(|_| denied("Read was already prepared"))
    }
}
fn outer(mut c: ToolContract) -> ToolContract {
    c.schema_version = "3".into();
    c
}
impl PreparedToolCall for Routed {
    fn resource_source(&self) -> Option<&SourceSelection> {
        self.inner().ok()?.resource_source()
    }
    fn requires_operation(&self) -> bool {
        self.resource_source().is_some() || self.inner().is_ok_and(|i| i.requires_operation())
    }
    fn executor_owner(&self) -> ExecutorOwner {
        self.inner()
            .map_or(ExecutorOwner::Kernel, |i| i.executor_owner())
    }
    fn managed_process(
        &self,
    ) -> Option<varin_runtime::catalog::managed_process::ManagedProcessKind> {
        self.inner().ok()?.managed_process()
    }
    fn receipt_persisted(&self, ctx: &ToolExecutionContext) {
        if let Ok(i) = self.inner() {
            i.receipt_persisted(ctx)
        }
    }
    fn plan(&self, t: &CancellationToken) -> Result<ToolPreparation, ExecutionError> {
        if let Some(alternate) = &self.alternate {
            let (prefix, access) = match alternate.call.name.as_str() {
                "file_list" | "file_search" => ("[\"discovery\",", Access::Read),
                "file_write" | "file_edit" => ("[\"file\",", Access::Write),
                "process_spawn" => ("[\"environment-writer-activity\",", Access::Read),
                _ => ("[\"file\",", Access::Read),
            };
            return Ok(ToolPreparation::Resolve {
                resources: vec![ResourceIntent::Prefix {
                    key_prefix: prefix.into(),
                    access,
                }],
                class: ExecutionClass::Unmetered,
            });
        }
        Ok(match self.inner()?.plan(t)? {
            ToolPreparation::Ready(c) => ToolPreparation::Ready(outer(c)),
            p => p,
        })
    }
    fn prepare(&self, t: &CancellationToken) -> Result<ToolContract, ExecutionError> {
        if let Some(a) = &self.alternate {
            if self.prepared.get().is_none() {
                self.resolve(a, t)?;
            }
        }
        self.inner()?.prepare(t).map(outer)
    }
    fn execution_class(&self, c: &ToolContract) -> ExecutionClass {
        self.inner().map_or(ExecutionClass::Unmetered, |inner| {
            inner.execution_class(&self.physical(c))
        })
    }
    fn watch_admission(
        &self,
        ctx: &ToolExecutionContext,
        c: &ToolContract,
        t: &CancellationToken,
    ) -> Result<Option<AdmissionControlGuard>, ExecutionError> {
        self.inner()?.watch_admission(ctx, &self.physical(c), t)
    }
    fn supports_policy_read(&self, c: &ToolContract) -> bool {
        self.alternate.is_none()
            && self
                .inner()
                .is_ok_and(|i| i.supports_policy_read(&self.physical(c)))
    }
    fn authorize(
        &self,
        ctx: &ToolExecutionContext,
        c: &ToolContract,
        t: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        self.inner()?.authorize(ctx, &self.physical(c), t)
    }
    fn execute(
        &self,
        ctx: &ToolExecutionContext,
        c: &ToolContract,
        t: &CancellationToken,
    ) -> ToolExecutionReceipt {
        match self.inner() {
            Ok(i) => i.execute(ctx, &self.physical(c), t),
            Err(e) => ToolExecutionReceipt::local(ToolCompletion::not_dispatched(e), c),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_read_cannot_import_project_tools_or_cross_path_authority() {
        for path in [
            "/tmp/a",
            "C:\\Temp\\a",
            "C:relative",
            "\\share\\file",
            "one/../two",
            "a\\..\\b",
            "file:other",
            "",
        ] {
            assert!(validate_explicit(&json!({"path":path})).is_err(), "{path}");
        }
        for input in [
            json!({"path":"a","unit":{"line":1}}),
            json!({"path":"a","rootId":"other"}),
            json!({"files":[{"path":"a"}]}),
        ] {
            assert!(validate_explicit(&input).is_err());
        }
        assert_eq!(
            validate_explicit(&json!({"ref":"file:42"}))
                .unwrap_err()
                .code,
            "work_location_conflict"
        );
        assert!(
            validate_explicit(&json!({"path":"logs/build.txt","startLine":2,"endLine":4})).is_ok()
        );
    }
    #[test]
    fn retained_file_and_continuation_use_their_original_source_after_reopen() {
        use crate::resource_references::{self as refs, FileTarget};
        let root = std::env::temp_dir().join(format!("work-location-ref-{}", uuid::Uuid::new_v4()));
        let mut catalog = Catalog::open(&root).unwrap();
        let source = |id: &str| {
            serde_json::from_value::<SourceSelection>(json!({"resource_owner":{"kind":"local"},
            "workspace_id":id,"execution_workspace_id":id,"mode":"live_root","branch_id":null,"revision":null,
            "live_root":{"hostId":"owner","canonicalRoot":format!("/{id}"),"rootId":format!("root-{id}")}})).unwrap()
        };
        let b = source("test");
        let target = FileTarget::Observation {
            source: b.clone(),
            path: "same.txt".into(),
            read_version: "pinned".into(),
            format: None,
            location: None,
        };
        let file = refs::register(
            &mut catalog,
            ReferenceKind::File,
            &refs::owner(&b),
            &target,
            "run-a",
        )
        .unwrap();
        let page = refs::continuation(
            &mut catalog,
            &refs::owner(&b),
            "file_read",
            Some(b.clone()),
            json!({"ref":file,"offset":8}),
            "run-a",
        )
        .unwrap();
        drop(catalog);
        let catalog = Catalog::open(&root).unwrap();
        let call = |name: &str, reference: &str| ToolCall {
            name: name.into(),
            call_id: "new-call".into(),
            schema_version: "3".into(),
            arguments: json!({"ref":reference}),
        };
        let expected = Some(b);
        assert_eq!(
            referenced_source(&catalog, &file, &call("file_edit", &file)).unwrap(),
            expected
        );
        let next = page["arguments"]["ref"].as_str().unwrap();
        assert_eq!(
            referenced_source(&catalog, next, &call("file_read", next)).unwrap(),
            expected
        );
        assert_eq!(
            referenced_source(&catalog, next, &call("file_edit", next))
                .unwrap_err()
                .code,
            "work_location_conflict"
        );
        drop(catalog);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn declaration_preserves_v2_while_only_v3_offers_confined_explicit_reads() {
        let physical =
            KernelToolExecutor::selected_schemas(&[ToolKind::FileRead].into_iter().collect())
                .remove(0);
        let routed = read_schema(physical.clone());
        assert_eq!(physical.version, "2");
        assert_eq!(routed.version, "3");
        let variants = routed.schema["oneOf"].as_array().unwrap();
        assert_eq!(&variants[..2], physical.schema["oneOf"].as_array().unwrap());
        assert_eq!(variants[2]["required"], json!(["location", "path"]));
        for name in ["unit", "ref", "files"] {
            assert!(variants[2]["properties"].get(name).is_none());
        }
        assert!(!eligible(None));
    }
}
