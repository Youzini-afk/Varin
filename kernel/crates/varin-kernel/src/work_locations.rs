//! Per-call routing for ordinary native model reads. The Catalog stores opaque saved-location
//! observations, never permits. Resolve a fresh, read-only binding in the physical preparation
//! lane, then let the existing file executor plan, authorize, dispatch and acknowledge it.
use crate::tools::{KernelResourceClient, KernelToolExecutor, ToolBinding, ToolKind};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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
pub(crate) fn schema() -> ToolSchema {
    ToolSchema { name:"work_locations".into(), version:"1".into(), description:
        "Find saved work locations by name, device or path. Pass a returned location to file_read for one relative path. This does not change the conversation default.".into(),
        schema:json!({"type":"object","additionalProperties":false,"properties":{"query":{"type":"string"}}}),
        output_schema:None, requirements:None, metadata:None }
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
pub(crate) fn add_schemas(tools: &mut Vec<ToolSchema>) {
    let Some(read) = tools.iter_mut().find(|t| t.name == "file_read") else {
        return;
    };
    *read = read_schema(read.clone());
    tools.push(schema());
    tools.sort_by(|a, b| a.name.cmp(&b.name));
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Key {
    id: String,
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
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Search {
    query: Option<String>,
}

struct Owner {
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
        if cancel.is_cancelled() || !matches!(ctx.origin, ToolOrigin::ModelStep { .. }) {
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
        let rows: Directory =
            serde_json::from_value(self.resources.source_query(query, cancel)?).map_err(denied)?;
        self.scope(ctx, cancel)?;
        let catalog = self.catalog.lock().map_err(denied)?;
        let mut locations = Vec::new();
        for row in rows.locations {
            let mut view = json!({"name":row.name,"device":row.device,"path":row.path});
            match (row.key, row.unavailable) {
                (Some(key), None)
                    if !key.id.is_empty()
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
        Ok(json!({"locations":locations}))
    }
}
fn location_owner(run: &str) -> String {
    format!("work-location:{run}")
}

pub(crate) fn declarations(
    reader: ToolDeclaration,
    default: SourceSelection,
    catalog: Arc<Mutex<Catalog>>,
    resources: KernelResourceClient,
) -> [ToolDeclaration; 2] {
    let owner = Arc::new(Owner {
        default,
        catalog,
        resources,
    });
    let schema = read_schema(reader.schema.clone());
    let router = Router {
        schema: schema.clone(),
        reader,
        owner: owner.clone(),
    };
    [
        ToolDeclaration::new(schema, Arc::new(router)),
        ToolDeclaration::new(self::schema(), owner),
    ]
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
        if c.name != "work_locations"
            || c.schema_version != "1"
            || !f.tools.contains(&schema())
            || f.source.as_ref() != Some(&self.default)
            || !matches!(f.origin, ToolOrigin::ModelStep { .. })
        {
            return Err(denied("Work locations are not selected for this request"));
        }
        serde_json::from_value::<Search>(c.arguments.clone()).map_err(denied)?;
        Ok(ToolContract {
            name: c.name.clone(),
            schema_version: c.schema_version.clone(),
            read_only: true,
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
        match self.list(ctx, c, t) {
            Ok(body) => ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                effect: Effect::None,
                content: body.into(),
            },
            Err(e) => ToolCompletion::failed(&e, Effect::None),
        }
    }
}
struct Router {
    schema: ToolSchema,
    reader: ToolDeclaration,
    owner: Arc<Owner>,
}
struct Alternate {
    expected: Option<SourceSelection>,
    owner: Arc<Owner>,
    location: String,
    call: ToolCall,
    frozen: FrozenToolContext,
}
struct Routed {
    default: Option<Box<dyn PreparedToolCall>>,
    alternate: Option<Alternate>,
    prepared: OnceLock<Box<dyn PreparedToolCall>>,
    lease: OnceLock<ReadLease>,
}
struct ReadLease {
    resources: KernelResourceClient,
    release: Value,
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
            return Err(denied("Path read differs from its frozen request"));
        }
        let mut call = c.clone();
        let mut frozen = f.clone();
        // Delegate to the exact retained native v2 path/attachment reader. Targets, including
        // older full Hosts, never receive the coordinator selector or this outer schema version.
        call.schema_version = self.reader.schema.version.clone();
        let schemas = Arc::make_mut(&mut frozen.tools);
        *schemas.iter_mut().find(|s| *s == &self.schema).unwrap() = self.reader.schema.clone();
        let location = call
            .arguments
            .as_object_mut()
            .and_then(|args| args.remove("location"));
        let selection = if let Some(explicit) = location {
            let location = explicit
                .as_str()
                .filter(|v| !v.is_empty())
                .ok_or_else(|| denied("Choose a location returned by work_locations"))?;
            validate_explicit(&call.arguments)?;
            Some((location.to_owned(), None))
        } else if let Some(reference) = call.arguments["ref"]
            .as_str()
            .filter(|r| r.starts_with("file:") || r.starts_with("read:"))
        {
            let c = self.owner.catalog.lock().map_err(denied)?;
            original_location(&c, reference, &call.arguments, &self.owner.default)?
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
                    self.reader
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
/// A file/read reference may select the original view only through an observation issued by
/// this coordinator. Check the saved registration and live authority again before dispatch.
fn original_location(
    c: &Catalog,
    reference: &str,
    args: &Value,
    default: &SourceSelection,
) -> Result<Option<(String, Option<SourceSelection>)>, ExecutionError> {
    use crate::resource_references::{self as refs, FileTarget, ReadTarget};
    let continuation;
    let selected = if reference.starts_with("read:") {
        let read: ReadTarget = refs::resolve(c, ReferenceKind::Read, reference)?;
        if read.tool != "file_read" || read.source.as_ref().is_none_or(|s| s == default) {
            return Ok(None);
        }
        if args.as_object().is_none_or(|o| o.len() != 1) {
            return Err(conflict("A continuation fixes its file and range"));
        }
        continuation = read.arguments;
        &continuation
    } else {
        args
    };
    let Some(file) = selected["ref"].as_str().filter(|r| r.starts_with("file:")) else {
        return Ok(None);
    };
    let FileTarget::Observation {
        source,
        path,
        location: Some(location),
        ..
    } = refs::resolve(c, ReferenceKind::File, file)?
    else {
        return Ok(None);
    };
    if &source == default {
        return Ok(None);
    }
    // The actual executor resolves the reference again against the prepared source and
    // checks its original readVersion. Never allow an extra field to open a different reader.
    let mut validated = selected.clone();
    let fields = validated
        .as_object_mut()
        .ok_or_else(|| denied("Invalid file reference arguments"))?;
    fields.remove("ref");
    if fields.insert("path".into(), json!(path)).is_some() {
        return Err(conflict(
            "A fixed file reference supplies its original path",
        ));
    }
    validate_explicit(&validated)?;
    Ok(Some((location, Some(source))))
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
        let key: Key = {
            let catalog = a.owner.catalog.lock().map_err(denied)?;
            let read = catalog
                .resolve_model_reference(ReferenceKind::Observation, &a.location)
                .map_err(denied)?;
            if read.owner != location_owner(&ctx.run_id) {
                return Err(denied("This location is not an observation of this Run"));
            }
            serde_json::from_value(read.target).map_err(denied)?
        };
        let query = json!({"kind":"work_location_bind","runId":ctx.run_id,"threadId":thread,"operationId":ctx.operation_id,
            "origin":ctx.origin,"callId":a.call.call_id,"tool":"file_read","key":key});
        let result = a.owner.resources.source_query(query, t)?;
        let binding: ToolBinding = serde_json::from_value(result.clone()).map_err(denied)?;
        let source = binding.source_selection().map_err(denied)?;
        if !eligible(Some(&source))
            || binding.run_id != ctx.run_id
            || binding.thread_id != thread
            || binding.resource_owner != key.resource_owner
            || key
                .workspace_id
                .as_ref()
                .is_some_and(|ws| ws != &binding.workspace_id)
            || binding.enabled_tools != [ToolKind::FileRead].into_iter().collect()
            || binding.remote_authority.is_some() == binding.resource_owner.is_local()
        {
            return Err(conflict(
                "Resource owner returned a different location or authority",
            ));
        }
        self.lease.set(ReadLease{resources:a.owner.resources.clone(),release:json!({"kind":"work_location_release","runId":ctx.run_id,"threadId":thread,"operationId":ctx.operation_id,"binding":result})}).map_err(|_|denied("Read was already prepared"))?;
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
        let executor = Arc::new(KernelToolExecutor::new(
            binding,
            a.owner
                .resources
                .clone()
                .with_read_location(a.location.clone()),
        )?);
        self.prepared
            .set(executor.bind_call(&a.call, &frozen, t)?)
            .map_err(|_| denied("Read was already prepared"))
    }
}
fn outer(mut c: ToolContract) -> ToolContract {
    c.schema_version = "3".into();
    c
}
fn physical(c: &ToolContract) -> ToolContract {
    let mut c = c.clone();
    c.schema_version = "2".into();
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
    fn receipt_persisted(&self, ctx: &ToolExecutionContext) {
        if let Ok(i) = self.inner() {
            i.receipt_persisted(ctx)
        }
    }
    fn plan(&self, t: &CancellationToken) -> Result<ToolPreparation, ExecutionError> {
        if self.alternate.is_some() {
            return Ok(ToolPreparation::Resolve {
                resources: vec![ResourceIntent::Prefix {
                    key_prefix: "[\"file\",".into(),
                    access: Access::Read,
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
    fn execution_class(&self, _: &ToolContract) -> ExecutionClass {
        ExecutionClass::Unmetered
    }
    fn watch_admission(
        &self,
        ctx: &ToolExecutionContext,
        c: &ToolContract,
        t: &CancellationToken,
    ) -> Result<Option<AdmissionControlGuard>, ExecutionError> {
        self.inner()?.watch_admission(ctx, &physical(c), t)
    }
    fn supports_policy_read(&self, c: &ToolContract) -> bool {
        self.alternate.is_none()
            && self
                .inner()
                .is_ok_and(|i| i.supports_policy_read(&physical(c)))
    }
    fn authorize(
        &self,
        ctx: &ToolExecutionContext,
        c: &ToolContract,
        t: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        self.inner()?.authorize(ctx, &physical(c), t)
    }
    fn execute(
        &self,
        ctx: &ToolExecutionContext,
        c: &ToolContract,
        t: &CancellationToken,
    ) -> ToolExecutionReceipt {
        match self.inner() {
            Ok(i) => i.execute(ctx, &physical(c), t),
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
    fn retained_file_page_names_original_position_and_rejects_another_range() {
        use crate::resource_references::{self as refs, FileTarget};
        let root = std::env::temp_dir().join(format!("work-location-ref-{}", uuid::Uuid::new_v4()));
        let mut catalog = Catalog::open(&root).unwrap();
        let source = |id: &str| {
            serde_json::from_value::<SourceSelection>(json!({"resource_owner":{"kind":"local"},
            "workspace_id":id,"execution_workspace_id":id,"mode":"live_root","branch_id":null,"revision":null,
            "live_root":{"hostId":"owner","canonicalRoot":format!("/{id}"),"rootId":format!("root-{id}")}})).unwrap()
        };
        let a = source("development");
        let b = source("test");
        let key=catalog.register_model_reference(ReferenceKind::Observation,&location_owner("run-a"),
            &json!({"id":"saved","resourceOwner":{"kind":"local"},"path":"/test","workspaceId":"test"}),"run-a").unwrap();
        let target = FileTarget::Observation {
            source: b.clone(),
            path: "same.txt".into(),
            read_version: "pinned".into(),
            format: None,
            location: Some(key.clone()),
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
        let expected = Some((key, Some(b)));
        assert_eq!(
            original_location(&catalog, &file, &json!({"ref":file}), &a).unwrap(),
            expected
        );
        let next = page["arguments"]["ref"].as_str().unwrap();
        assert_eq!(
            original_location(&catalog, next, &page["arguments"], &a).unwrap(),
            expected
        );
        assert_eq!(
            original_location(&catalog, next, &json!({"ref":next,"offset":0}), &a)
                .unwrap_err()
                .code,
            "work_location_conflict"
        );
        assert!(
            original_location(&catalog, &file, &json!({"ref":file,"unit":{"line":1}}), &a).is_err()
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
