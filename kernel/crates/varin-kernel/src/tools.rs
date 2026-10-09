//! Selected tools reuse the existing Storage owner through typed in-process messages.
//! No second catalog, file writer, process manager, or management-authority fallback exists here.
use crate::error::{error_code, KernelError};
use crate::model::Grant;
use crate::storage::file_mutations::{
    FileEditArgs, FileWriteArgs, TextMutation,
};
use crate::storage::Storage;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::{mpsc, Arc};
use varin_runtime::execution::{
    Access, CancellationToken, CompletionKind, ExecutionError, FrozenToolContext, ToolOrigin, ResourceClaim,
    ResourceIntent, ToolCall, ToolCompletion, ToolContract, ToolExecutionContext, ToolExecutor, ToolPreparation, ToolSchema,
};
use varin_runtime::{Effect, Lifetime, Outcome};

#[path = "tools_discovery.rs"]
mod discovery;
#[path = "tools_reconciliation.rs"]
mod reconciliation;
#[path = "tools_language.rs"]
mod language;
#[path = "tools_retrieval.rs"]
mod retrieval;
use retrieval::RetrievalQueryArgs;
use language::LanguageQueryArgs;
use discovery::FileQueryArgs;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ToolKind {
    FileRead,
    FileList,
    FileSearch,
    FileWrite,
    FileEdit,
    ProcessInspect,
    ProcessRead,
    ProcessSpawn,
    LanguageDefinition,
    LanguageReferences,
    LanguageDiagnostics,
    CodeRetrieval,
}
impl ToolKind {
    fn name(self) -> &'static str {
        match self {
            Self::FileRead => "file_read",
            Self::FileList => "file_list",
            Self::FileSearch => "file_search",
            Self::FileWrite => "file_write",
            Self::FileEdit => "file_edit",
            Self::ProcessInspect => "process_inspect",
            Self::ProcessRead => "process_read",
            Self::ProcessSpawn => "process_spawn",
            Self::LanguageDefinition => "language_definition",
            Self::LanguageReferences => "language_references",
            Self::LanguageDiagnostics => "language_diagnostics",
            Self::CodeRetrieval => "code_retrieval",
        }
    }
    fn from_name(name: &str) -> Option<Self> {
        [
            Self::FileRead,
            Self::FileList,
            Self::FileSearch,
            Self::FileWrite,
            Self::FileEdit,
            Self::ProcessInspect,
            Self::ProcessRead,
            Self::ProcessSpawn,
            Self::LanguageDefinition, Self::LanguageReferences, Self::LanguageDiagnostics,
            Self::CodeRetrieval,
        ]
        .into_iter()
        .find(|kind| kind.name() == name)
    }
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FixedFileSource {
    pub branch_id: String,
    pub revision: i64,
}
pub(crate) use varin_runtime::SourceMode;
fn default_source_mode() -> SourceMode { SourceMode::FixedBranch }
/// Supplied by the trusted Host after resolving its environment/source view, never by model args.
/// A binding is not itself a grant: the Storage owner revalidates the persisted grant on every call.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ToolBinding {
    pub grant_id: String,
    pub run_id: String,
    pub thread_id: String,
    pub workspace_id: String,
    pub execution_workspace_id: String,
    pub root_id: Option<String>,
    pub file_source: Option<FixedFileSource>,
    #[serde(default = "default_source_mode")]
    pub source_mode: SourceMode,
    pub materialized_source: Option<FixedFileSource>,
    pub live_root: Option<varin_runtime::catalog::launches::LiveRoot>,
    /// Source lineage only; resource admission always uses the registered root.
    pub environment_run_id: Option<String>,
    pub enabled_tools: BTreeSet<ToolKind>,
}
impl ToolBinding {
    fn physical_source(&self) -> Value {
        let mut source = json!({"mode":self.source_mode,"rootId":self.root_id});
        if let Some(root) = &self.live_root { source["liveRoot"] = json!(root); }
        if let Some(base) = &self.materialized_source { source["base"] = json!(base); }
        source
    }
    pub(crate) fn source_selection(&self) -> Result<varin_runtime::catalog::launches::SourceSelection, KernelError> {
        let fixed = self.file_source.as_ref().or(self.materialized_source.as_ref());
        let source = varin_runtime::catalog::launches::SourceSelection {
            environment_run_id: self.environment_run_id.clone(), mode: self.source_mode,
            live_root: self.live_root.clone(), workspace_id: self.workspace_id.clone(),
            execution_workspace_id: self.execution_workspace_id.clone(),
            branch_id: fixed.map(|source| source.branch_id.clone()),
            revision: fixed.map(|source| u64::try_from(source.revision)).transpose()
                .map_err(|_| KernelError::Protocol("source revision must be nonnegative".into()))?,
        };
        source.validate().map_err(|error| KernelError::Protocol(error.to_string()))?;
        Ok(source)
    }
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileReadArgs {
    path: String,
    #[serde(default)]
    offset: u64,
    length: Option<u64>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessInspectArgs {
    process_id: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessReadArgs {
    process_id: String,
    cursor: u64,
    max_bytes: Option<u64>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct EnvironmentEntry {
    name: String,
    value: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessSpawnArgs {
    cwd: String,
    command: String,
    args: Vec<String>,
    #[serde(default)]
    env: Vec<EnvironmentEntry>,
    mode: String,
    cols: Option<u16>,
    rows: Option<u16>,
    windows_raw_arguments: Option<String>,
}
#[derive(Debug, Clone)]
enum ResourceOperation {
    CollaborationPin { release: bool, pin_id: String },
    FileRead(FileReadArgs),
    FileQuery(FileQueryArgs),
    LanguageQuery(LanguageQueryArgs),
    RetrievalQuery(RetrievalQueryArgs),
    ObserveCompute { reply: mpsc::Sender<crate::compute::ComputeWatch> },
    ComputeControl {
        method: &'static str,
        cursor: u64,
    },
    FileMutation(TextMutation),
    ReconcileMutation {
        mutation: TextMutation,
        executor: String,
    },
    ProcessObservation { process_id: String, read: Option<(u64, Option<u64>)> },
    ProcessInspect(ProcessInspectArgs),
    ProcessRead(ProcessReadArgs),
    ProcessSpawn(ProcessSpawnArgs),
}
impl ResourceOperation {
    fn parse(kind: ToolKind, args: &Value) -> Result<Self, ExecutionError> {
        if args
            .as_object()
            .is_some_and(|object| object.values().any(Value::is_null))
        {
            return Err(ExecutionError::new(
                "invalid_tool_arguments",
                "optional fields must be omitted rather than null",
            ));
        }
        let parsed = match kind {
            ToolKind::CodeRetrieval => return RetrievalQueryArgs::parse(args).map(Self::RetrievalQuery),
            ToolKind::LanguageDefinition | ToolKind::LanguageReferences | ToolKind::LanguageDiagnostics => {
                return LanguageQueryArgs::parse(kind, args).map(Self::LanguageQuery);
            }
            ToolKind::FileList | ToolKind::FileSearch => {
                serde_json::from_value::<FileQueryArgs>(args.clone()).map(|mut args| {
                    args.search = kind == ToolKind::FileSearch;
                    Self::FileQuery(args)
                })
            }
            ToolKind::FileRead => serde_json::from_value(args.clone()).map(Self::FileRead),
            ToolKind::FileWrite => {
                serde_json::from_value::<FileWriteArgs>(args.clone())
                    .map(|args| Self::FileMutation(TextMutation::Write(args)))
            }
            ToolKind::FileEdit => serde_json::from_value::<FileEditArgs>(args.clone())
                .map(|args| Self::FileMutation(TextMutation::Edit(args))),
            ToolKind::ProcessInspect => {
                serde_json::from_value(args.clone()).map(Self::ProcessInspect)
            }
            ToolKind::ProcessRead => {
                serde_json::from_value(args.clone()).map(Self::ProcessRead)
            }
            ToolKind::ProcessSpawn => {
                serde_json::from_value(args.clone()).map(Self::ProcessSpawn)
            }
        }
        .map_err(|error| ExecutionError::new("invalid_tool_arguments", error.to_string()))?;
        match &parsed {
            Self::FileQuery(args) => args.validate()?,
            Self::FileRead(args) => {
                normalized_path(&args.path, false)?;
            }
            Self::FileMutation(mutation) => {
                normalized_path(mutation.path(), false)?;
                if mutation.read_version().is_empty() {
                    return Err(ExecutionError::new(
                        "invalid_tool_arguments",
                        "readVersion is required",
                    ));
                }
            }
            Self::ProcessSpawn(args) => {
                normalized_path(&args.cwd, true)?;
                if !matches!(args.mode.as_str(), "pipe" | "pty")
                    || args.command.is_empty()
                    || args.command.contains('\0')
                    || args.cols.is_some_and(|value| !(1..=1000).contains(&value))
                    || args.rows.is_some_and(|value| !(1..=500).contains(&value))
                {
                    return Err(ExecutionError::new(
                        "invalid_tool_arguments",
                        "invalid process mode or command",
                    ));
                }
            }
            Self::ProcessInspect(args) if args.process_id.is_empty() => {
                return Err(ExecutionError::new(
                    "invalid_tool_arguments",
                    "processId is empty",
                ))
            }
            Self::ProcessRead(args) if args.process_id.is_empty() || args.max_bytes == Some(0) => {
                return Err(ExecutionError::new(
                    "invalid_tool_arguments",
                    "invalid process output identity or range",
                ))
            }
            _ => {}
        }
        Ok(parsed)
    }
    fn params(
        &self,
        binding: &ToolBinding,
        context: &ToolExecutionContext,
    ) -> (&'static str, Value) {
        match self {
            Self::ProcessObservation { process_id, read } => {
                let mut params=json!({"workspaceId":binding.workspace_id,"processId":process_id});
                if let Some((cursor,limit))=read { params["cursor"]=json!(cursor); if let Some(limit)=limit { params["maxBytes"]=json!(limit); } }
                (if read.is_some() { "process.read" } else { "process.inspect" },params)
            }
            Self::CollaborationPin { release, pin_id } => {
                let source = binding.file_source.as_ref().expect("fixed collaboration binding");
                if *release { ("branch.unpin", json!({"operationId":format!("child-unpin:{}",context.operation_id),"branchId":source.branch_id,"pinId":pin_id})) }
                else { ("branch.pin", json!({"operationId":format!("child-pin:{}",context.operation_id),"branchId":source.branch_id,"revision":source.revision,"pinId":pin_id})) }
            }
            Self::RetrievalQuery(args) => {
                // Revalidate the bound read grant and explicit scopes without inventing a root
                // path or dispatching compute. Body reads receive separate per-file admission.
                let mut params = json!({"workspaceId":binding.workspace_id});
                if let Some(paths) = &args.paths { params["paths"] = json!(paths); }
                ("storage.health", params)
            }
            Self::LanguageQuery(args) => ("file.read", json!({"workspaceId":binding.workspace_id,"rootId":binding.root_id,"path":args.path})),
            Self::FileQuery(args) => ("compute.start", args.params(binding, context)),
            Self::ObserveCompute { .. } => ("compute.read", json!({
                "workspaceId": binding.workspace_id, "jobId": context.operation_id, "cursor": 0
            })),
            Self::ComputeControl { method, cursor } => {
                let mut params =
                    json!({"workspaceId":binding.workspace_id,"jobId":context.operation_id});
                if *method == "compute.read" {
                    params["cursor"] = json!(cursor);
                    params["maxBytes"] = json!(65536);
                }
                (method, params)
            }
            Self::ReconcileMutation { mutation, .. } => (
                "file.operation.reconcile",
                json!({"workspaceId":binding.workspace_id,"rootId":binding.root_id,
                    "path":mutation.path(),"operationId":context.operation_id}),
            ),
            Self::FileMutation(mutation) => (
                "file.apply",
                json!({"workspaceId":binding.workspace_id,"rootId":binding.root_id,
                "path":mutation.path(),"operationId":context.operation_id}),
            ),
            Self::FileRead(args) if binding.source_mode != SourceMode::FixedBranch => {
                let mut params = json!({"workspaceId":binding.workspace_id,"rootId":binding.root_id,
                    "path":args.path,"offset":args.offset});
                if let Some(length) = args.length {
                    params["length"] = json!(length);
                }
                ("file.read", params)
            }
            Self::FileRead(args) => {
                let source = binding.file_source.as_ref().expect("binding validated");
                (
                    "branch.read",
                    json!({"branchId":source.branch_id,"revision":source.revision,"paths":[args.path]}),
                )
            }
            Self::ProcessInspect(args) => (
                "process.inspect",
                json!({"workspaceId":binding.workspace_id,"processId":args.process_id}),
            ),
            Self::ProcessRead(args) => {
                let mut params = json!({"workspaceId":binding.workspace_id,"processId":args.process_id,"cursor":args.cursor});
                if let Some(limit) = args.max_bytes {
                    params["maxBytes"] = json!(limit);
                }
                ("process.read", params)
            }
            Self::ProcessSpawn(args) => {
                let mut params = json!({"workspaceId":binding.workspace_id,"rootId":binding.root_id,
                    "processId":context.operation_id,"__runId":context.run_id,"cwd":args.cwd,"command":args.command,"args":args.args,
                    "env":args.env,"mode":args.mode});
                if let Some(cols) = args.cols {
                    params["cols"] = json!(cols);
                }
                if let Some(rows) = args.rows {
                    params["rows"] = json!(rows);
                }
                if let Some(raw) = &args.windows_raw_arguments {
                    params["windowsRawArguments"] = json!(raw);
                }
                ("process.spawn", params)
            }
        }
    }
}
fn normalized_path(path: &str, root: bool) -> Result<(), ExecutionError> {
    if (path.is_empty() && !root)
        || path.contains('\\')
        || path.contains('\0')
        || path.split('/').any(|part| part == "." || part == "..")
        || path.starts_with('/')
        || path.contains(':')
    {
        return Err(ExecutionError::new(
            "invalid_tool_arguments",
            "path must be a normalized relative resource path",
        ));
    }
    Ok(())
}

pub(crate) struct ResourceFailure {
    pub error: KernelError,
    pub dispatched: bool,
}
pub(crate) struct ResourceReply {
    sender: Option<mpsc::Sender<Result<Value, ResourceFailure>>>,
    wake: Option<mpsc::SyncSender<()>>,
}
impl ResourceReply {
    pub(crate) fn send(mut self, value: Result<Value, ResourceFailure>)
        -> Result<(), mpsc::SendError<Result<Value, ResourceFailure>>> {
        self.sender.take().expect("resource reply sender").send(value)
    }
}
impl Drop for ResourceReply {
    fn drop(&mut self) {
        // Close before notifying, including when the owner exits without a reply.
        self.sender.take();
        if let Some(wake) = &self.wake { let _ = wake.try_send(()); }
    }
}
pub(crate) struct ResourceCall {
    pub admission_key: Option<String>,
    pub binding: ToolBinding,
    pub context: ToolExecutionContext,
    operation: ResourceOperation,
    authorize_only: bool,
    expected_resource_key: Option<String>,
    pub cancellation: CancellationToken,
    pub reply: ResourceReply,
}
type AdmissionControl = dyn Fn(&ToolBinding, &CancellationToken)
    -> Result<varin_runtime::execution_capacity::AdmissionControlGuard, ExecutionError> + Send + Sync;
/// The Kernel actor injects this sender. Sending does not create another resource authority.
#[derive(Clone)]
pub(crate) struct KernelResourceClient {
    send: Arc<dyn Fn(ResourceCall) -> Result<(), KernelError> + Send + Sync>,
    replay: Arc<dyn Fn(Vec<String>) -> Result<(), KernelError> + Send + Sync>,
    controls: crate::process::ProcessControlRegistry,
    admission_control: Option<Arc<AdmissionControl>>,
}
impl KernelResourceClient {
    pub(crate) fn new(
        send: impl Fn(ResourceCall) -> Result<(), KernelError> + Send + Sync + 'static,
        replay: impl Fn(Vec<String>) -> Result<(), KernelError> + Send + Sync + 'static,
        controls: crate::process::ProcessControlRegistry,
    ) -> Self {
        Self {
            send: Arc::new(send),
            replay: Arc::new(replay),
            controls, admission_control: None,
        }
    }
    pub(crate) fn with_admission_control(mut self, watch: impl Fn(&ToolBinding, &CancellationToken)
        -> Result<varin_runtime::execution_capacity::AdmissionControlGuard, ExecutionError> + Send + Sync + 'static) -> Self {
        self.admission_control = Some(Arc::new(watch));
        self
    }
    /// Caller has checked the real Catalog process Operation and immutable launch source.
    pub(crate) fn observe_process(&self, binding: &ToolBinding, context: &ToolExecutionContext,
        process_id: &str, read: Option<(u64, Option<u64>)>, authorize_only: bool,
        cancel: &CancellationToken) -> Result<Value, ExecutionError> {
        self.call(binding, context, ResourceOperation::ProcessObservation { process_id:process_id.into(),read },
            authorize_only,cancel).map_err(|failure|ExecutionError::new(error_code(&failure.error),failure.error.to_string()))
    }
    pub(crate) fn authorize_process_observation(&self, binding: &ToolBinding, context: &ToolExecutionContext,
        process_id: &str, cancel: &CancellationToken) -> Result<(), ExecutionError> {
        self.observe_process(binding,context,process_id,None,true,cancel).map(|_|())
    }
    pub(crate) fn collaboration_pin(&self, binding: &ToolBinding, context: &ToolExecutionContext,
        release: bool, authorize_only: bool, cancel: &CancellationToken) -> Result<Value, ExecutionError> {
        if binding.source_mode != SourceMode::FixedBranch || binding.file_source.is_none() {
            return Err(ExecutionError::new("collaboration_source", "dispatch requires an admitted fixed source"));
        }
        self.call(binding, context, ResourceOperation::CollaborationPin {
            release, pin_id: format!("child-pin:{}", context.operation_id),
        }, authorize_only, cancel).map_err(|failure| ExecutionError::new("collaboration_source", failure.error.to_string()))
    }
    pub(crate) fn replay_process_terminals(
        &self,
        process_ids: Vec<String>,
    ) -> Result<(), KernelError> {
        (self.replay)(process_ids)
    }
    pub(crate) fn cancel_known_process(&self, operation_id: &str) -> Result<bool, KernelError> {
        self.controls.cancel_known_process(operation_id)
    }
    pub(crate) fn cancel_process(
        &self,
        operation_id: &str,
        run_id: &str,
    ) -> Result<bool, KernelError> {
        self.controls.cancel_process(operation_id, run_id)
    }
    fn call(
        &self,
        binding: &ToolBinding,
        context: &ToolExecutionContext,
        operation: ResourceOperation,
        authorize_only: bool,
        cancellation: &CancellationToken,
    ) -> Result<Value, ResourceFailure> {
        self.call_checked(binding, context, operation, authorize_only, None, cancellation)
    }
    fn call_checked(
        &self, binding: &ToolBinding, context: &ToolExecutionContext,
        operation: ResourceOperation, authorize_only: bool, expected_resource_key: Option<String>,
        cancellation: &CancellationToken,
    ) -> Result<Value, ResourceFailure> {
        if cancellation.is_cancelled() {
            return Err(ResourceFailure {
                error: KernelError::Cancelled,
                dispatched: false,
            });
        }
        let (reply, result) = mpsc::channel();
        let wake = authorize_only.then(|| mpsc::sync_channel(1));
        let _cancel_wait = wake.as_ref().map(|(sender, _)| cancellation.wake_on_cancel(sender.clone()));
        (self.send)(ResourceCall {
            admission_key: None,
            binding: binding.clone(),
            context: context.clone(),
            operation,
            authorize_only,
            expected_resource_key,
            cancellation: cancellation.clone(),
            reply: ResourceReply { sender: Some(reply), wake: wake.as_ref().map(|(sender, _)| sender.clone()) },
        })
        .map_err(|error| ResourceFailure {
            error,
            dispatched: false,
        })?;
        if let Some((_, changed)) = wake {
            loop {
                if cancellation.is_cancelled() {
                    return Err(ResourceFailure { error: KernelError::Cancelled, dispatched: false });
                }
                match result.try_recv() {
                    Ok(receipt) => return receipt,
                    Err(mpsc::TryRecvError::Disconnected) => return Err(ResourceFailure {
                        error: KernelError::Storage("resource owner disconnected before receipt".into()), dispatched: false,
                    }),
                    Err(mpsc::TryRecvError::Empty) => {},
                }
                if changed.recv().is_err() {
                    return Err(ResourceFailure { error: KernelError::Storage("resource observation closed".into()), dispatched: false });
                }
            }
        }
        // Once admitted, cancellation is observed by the executing resource owner. Do not drop
        // ownership on a local timeout/abort while the process/file operation may still execute.
        result.recv().map_err(|_| ResourceFailure {
            error: KernelError::Storage("resource owner disconnected before receipt".into()),
            dispatched: !authorize_only,
        })?
    }
}

pub(crate) struct KernelToolExecutor {
    binding: ToolBinding,
    schemas: Vec<ToolSchema>,
    resources: KernelResourceClient,
    language: Option<crate::language::LanguageBridge>,
    retrieval: Option<crate::retrieval::RetrievalBridge>,
    retrieval_project_id: Option<String>,
}
impl KernelToolExecutor {
    pub(crate) fn new(
        binding: ToolBinding,
        resources: KernelResourceClient,
    ) -> Result<Self, ExecutionError> {
        if [
            &binding.grant_id,
            &binding.run_id,
            &binding.thread_id,
            &binding.workspace_id,
            &binding.execution_workspace_id,
        ]
        .iter()
        .any(|id| id.trim().is_empty())
        {
            return Err(ExecutionError::new(
                "invalid_tool_binding",
                "tool binding identities must be nonempty",
            ));
        }
        if binding.enabled_tools.iter().any(|kind| {
            matches!(
                kind,
                ToolKind::FileRead | ToolKind::FileList | ToolKind::FileSearch
            )
        }) && binding.source_mode == SourceMode::FixedBranch
            && !binding
                .file_source
                .as_ref()
                .is_some_and(|source| !source.branch_id.is_empty() && source.revision >= 0)
        {
            return Err(ExecutionError::new(
                "invalid_tool_binding",
                "file reads and discovery require a fixed branch revision",
            ));
        }
        if binding.source_mode == SourceMode::FixedBranch
            && binding
                .enabled_tools
                .iter()
                .any(|kind| matches!(kind, ToolKind::FileWrite | ToolKind::FileEdit | ToolKind::ProcessSpawn))
        {
            return Err(ExecutionError::new(
                "invalid_tool_binding",
                "file mutation and process spawning require an explicit physical source",
            ));
        }
        if binding.source_mode != SourceMode::FixedBranch
            && (binding.file_source.is_some()
                || binding.root_id.as_deref().is_none_or(str::is_empty))
        {
            return Err(ExecutionError::new(
                "invalid_tool_binding",
                "physical source requires a registered root and no fixed branch source",
            ));
        }
        if binding.materialized_source.as_ref().is_some_and(|source| {
            binding.source_mode != SourceMode::Materialized
                || source.branch_id.is_empty()
                || source.revision < 0
        }) {
            return Err(ExecutionError::new(
                "invalid_tool_binding",
                "invalid materialization provenance",
            ));
        }
        if (binding.source_mode == SourceMode::LiveRoot) != binding.live_root.is_some()
            || binding.live_root.as_ref().is_some_and(|root| root.host_id.is_empty()
                || root.canonical_root.is_empty() || Some(root.root_id.as_str()) != binding.root_id.as_deref())
            || (binding.source_mode == SourceMode::LiveRoot && binding.environment_run_id.is_some()) {
            return Err(ExecutionError::new("invalid_tool_binding", "live source requires its exact registered environment identity"));
        }
        if binding
            .enabled_tools
            .contains(&ToolKind::ProcessSpawn)
            && binding.root_id.as_deref().is_none_or(str::is_empty)
        {
            return Err(ExecutionError::new(
                "invalid_tool_binding",
                "process spawn requires a registered root",
            ));
        }
        if binding.source_mode != SourceMode::LiveRoot && binding.enabled_tools.iter().any(|kind| matches!(kind, ToolKind::LanguageDefinition | ToolKind::LanguageReferences | ToolKind::LanguageDiagnostics)) {
            return Err(ExecutionError::new("language_source_unavailable", "Language tools require live_root; fixed dependency closure is not available"));
        }
        if binding.source_mode != SourceMode::LiveRoot && binding.enabled_tools.contains(&ToolKind::CodeRetrieval) {
            return Err(ExecutionError::new("retrieval_source_unavailable", "Code retrieval requires live_root; fixed-source retrieval is not available"));
        }
        let schemas = Self::selected_schemas(&binding.enabled_tools);
        Ok(Self { binding, schemas, resources, language: None, retrieval: None, retrieval_project_id: None })
    }
    pub(crate) fn with_retrieval(mut self, bridge: crate::retrieval::RetrievalBridge, project_id: Option<String>) -> Self { self.retrieval = Some(bridge); self.retrieval_project_id = project_id; self }
    pub(crate) fn with_language(mut self, bridge: crate::language::LanguageBridge) -> Self { self.language = Some(bridge); self }
    pub(crate) fn schemas(&self) -> Vec<ToolSchema> {
        self.schemas.clone()
    }
    pub(crate) fn selected_schemas(enabled_tools: &BTreeSet<ToolKind>) -> Vec<ToolSchema> {
        enabled_tools
            .iter()
            .map(|kind| ToolSchema {
                name: kind.name().into(),
                version: "1".into(),
                schema: tool_schema(*kind),
            })
            .collect()
    }
    fn operation(
        &self,
        context: Option<&ToolExecutionContext>,
        call: &ToolCall,
    ) -> Result<ResourceOperation, ExecutionError> {
        if context.is_some_and(|context| {
            context.run_id != self.binding.run_id || context.operation_id.is_empty()
        }) {
            return Err(ExecutionError::new(
                "unauthorized",
                "tool execution identity does not match bound Run",
            ));
        }
        if call.schema_version != "1" {
            return Err(ExecutionError::new(
                "stale_tool_schema",
                "tool schema version is not bound",
            ));
        }
        let kind = ToolKind::from_name(&call.name)
            .filter(|kind| self.binding.enabled_tools.contains(kind))
            .ok_or_else(|| {
                ExecutionError::new("tool_not_bound", "tool is not selected in this Run")
            })?;
        ResourceOperation::parse(kind, &call.arguments)
    }
    fn contract(&self, call: &ToolCall, operation: &ResourceOperation) -> ToolContract {
        let job = matches!(operation, ResourceOperation::ProcessSpawn(_));
        let read_only = !matches!(operation, ResourceOperation::FileMutation(_) | ResourceOperation::ProcessSpawn(_));
        let key = |value: Value| value.to_string();
        let (resource, access) = match operation {
            ResourceOperation::CollaborationPin { .. } | ResourceOperation::ReconcileMutation { .. } | ResourceOperation::ComputeControl { .. } | ResourceOperation::ObserveCompute { .. } =>
                unreachable!("private receipt queries have no model contract"),
            // Discovery snapshots have their own short Storage coordination and consume fixed bytes.
            // Their long search/scan wait must not hold a directory-wide write barrier.
            ResourceOperation::RetrievalQuery(_) => (key(json!(["retrieval-view", self.binding.execution_workspace_id, self.binding.root_id])), Access::Read),
            ResourceOperation::LanguageQuery(_) => (key(json!(["language-view", self.binding.execution_workspace_id, self.binding.root_id])), Access::Read),
            ResourceOperation::FileQuery(_) => (key(json!(["discovery", self.binding.execution_workspace_id, self.binding.root_id, self.binding.file_source])), Access::Read),
            ResourceOperation::FileMutation(mutation) => (key(json!(["unresolved-file", mutation.path()])), Access::Write),
            ResourceOperation::FileRead(args) if self.binding.source_mode != SourceMode::FixedBranch =>
                (key(json!(["unresolved-file", args.path])), Access::Read),
            ResourceOperation::FileRead(args) => {
                let source = self.binding.file_source.as_ref().expect("validated source");
                (key(json!(["fixed-file", self.binding.workspace_id, source.branch_id, source.revision, args.path])), Access::Read)
            }
            ResourceOperation::ProcessObservation { .. } => unreachable!("observation is admitted by the Catalog wrapper"),
            ResourceOperation::ProcessInspect(args) => (key(json!(["process-output", self.binding.execution_workspace_id, args.process_id])), Access::Read),
            ResourceOperation::ProcessRead(args) => (key(json!(["process-output", self.binding.execution_workspace_id, args.process_id])), Access::Read),
            // Arbitrary programs have unknown write sets. Record shared writer activity, never
            // pretend that an environment-wide mutex isolates their filesystem side effects.
            ResourceOperation::ProcessSpawn(_) => (key(json!(["environment-writer-activity", self.binding.execution_workspace_id, self.binding.root_id])), Access::Read),
        };
        ToolContract {
            name: call.name.clone(), schema_version: "1".into(), read_only,
            completion: if job { CompletionKind::Job } else { CompletionKind::Result },
            lifetime: if job { Lifetime::Thread } else { Lifetime::Run },
            resources: vec![ResourceClaim { key: resource, access }],
        }
    }
    pub(crate) fn process_observation_contract(&self, context:&ToolExecutionContext, call:&ToolCall) -> Result<ToolContract,ExecutionError> {
        let operation=self.operation(Some(context),call)?;
        if !matches!(operation,ResourceOperation::ProcessInspect(_)|ResourceOperation::ProcessRead(_)) {
            return Err(ExecutionError::new("process_observation","not a read-only process observation"));
        }
        Ok(self.contract(call,&operation))
    }
    fn physical_file(&self, operation: &ResourceOperation) -> bool {
        matches!(operation, ResourceOperation::FileMutation(_))
            || (matches!(operation, ResourceOperation::FileRead(_)) && self.binding.source_mode != SourceMode::FixedBranch)
    }
    fn planned_contract(&self, context: &ToolExecutionContext, call: &ToolCall, operation: &ResourceOperation, cancel: &CancellationToken) -> Result<ToolContract, ExecutionError> {
        let mut contract = self.contract(call, operation);
        if self.physical_file(operation) {
            let plan = self.resources.call(&self.binding, context, operation.clone(), true, cancel)
                .map_err(|failure| ExecutionError::new(error_code(&failure.error), failure.error.to_string()))?;
            contract.resources[0].key = plan.get("resourceKey").and_then(Value::as_str)
                .ok_or_else(|| ExecutionError::new("invalid_resource_plan", "file owner omitted its canonical resource identity"))?.into();
        }
        Ok(contract)
    }
    fn frozen_operation(&self, call: &ToolCall, request: &FrozenToolContext) -> Result<ResourceOperation, ExecutionError> {
        if request.run_id != self.binding.run_id {
            return Err(ExecutionError::new("unauthorized", "request Run does not match tool binding"));
        }
        let operation = self.operation(None, call)?;
        let expected = self.schemas.iter().find(|schema| schema.name == call.name).expect("selected tool");
        if !request.tools.iter().any(|schema| schema == expected) {
            return Err(ExecutionError::new("stale_tool_schema", "tool does not match the frozen request schema"));
        }
        Ok(operation)
    }

}
impl ToolExecutor for KernelToolExecutor {
    fn plan(&self, call: &ToolCall, request: &FrozenToolContext, _: &CancellationToken)
        -> Result<ToolPreparation, ExecutionError> {
        let operation = self.frozen_operation(call, request)?;
        if self.physical_file(&operation) {
            // Storage canonicalizes parents, junctions and root aliases. Until it resolves the
            // target, only the canonical physical-file namespace is known. A workspace/root ID
            // would incorrectly separate two aliases of the same file. Static resource owners
            // (process output, language, discovery, fixed views) can still bypass this intent.
            let access = if matches!(operation, ResourceOperation::FileMutation(_)) { Access::Write } else { Access::Read };
            Ok(ToolPreparation::Resolve {
                resources: vec![ResourceIntent::Prefix { key_prefix: "[\"file\",".into(), access }],
                class: varin_runtime::execution_capacity::ExecutionClass::Unmetered,
            })
        } else { Ok(ToolPreparation::Ready(self.contract(call, &operation))) }
    }
    fn watch_admission(&self, _: &ToolExecutionContext, _: &ToolCall, _: &ToolContract, cancel: &CancellationToken)
        -> Result<Option<varin_runtime::execution_capacity::AdmissionControlGuard>, ExecutionError> {
        self.resources.admission_control.as_ref().map(|watch| watch(&self.binding, cancel)).transpose()
    }
    fn execution_class(&self, call: &ToolCall, _: &ToolContract) -> varin_runtime::execution_capacity::ExecutionClass {
        use varin_runtime::execution_capacity::ExecutionClass;
        match ToolKind::from_name(&call.name).filter(|kind| self.binding.enabled_tools.contains(kind)) {
            Some(ToolKind::FileSearch) => ExecutionClass::LocalCompute,
            // Directory lists, plain reads and control stay independent. Host composite retrieval
            // and language waits have their own stages/owners and do not take a local CPU permit.
            _ => ExecutionClass::Unmetered,
        }
    }

    fn supports_policy_read(&self, context: &FrozenToolContext, call: &ToolCall, contract: &ToolContract) -> bool {
        // Eligibility is this trusted adapter's promise, never extension/MCP metadata.
        let Some(source) = &context.source else { return false; };
        let Some(bound) = &self.binding.file_source else { return false; };
        context.run_id == self.binding.run_id
            && self.binding.source_mode == SourceMode::FixedBranch
            && source.mode == SourceMode::FixedBranch
            && source.live_root.is_none()
            && source.workspace_id == self.binding.workspace_id
            && source.execution_workspace_id == self.binding.execution_workspace_id
            && source.environment_run_id == self.binding.environment_run_id
            && source.branch_id.as_deref() == Some(bound.branch_id.as_str())
            && source.revision == u64::try_from(bound.revision).ok()
            && matches!(self.operation(None, call), Ok(ResourceOperation::FileRead(_) | ResourceOperation::FileQuery(_)))
            && contract.read_only && contract.completion == CompletionKind::Result
    }
    fn prepare(
        &self,
        call: &ToolCall,
        request: &FrozenToolContext,
        _cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        let operation = self.frozen_operation(call, request)?;
        self.planned_contract(&ToolExecutionContext {
            run_id: self.binding.run_id.clone(), origin: request.origin.clone(),
            operation_id: match &request.origin {
                ToolOrigin::ModelStep { request_id } => format!("{request_id}:tool:{}", call.call_id),
                ToolOrigin::PolicyAction { action_id, node_id } => format!("{action_id}:node:{node_id}"),
            },
        }, call, &operation, _cancel)
    }
    fn authorize(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        let operation = self.operation(Some(context), call)?;
        if let ResourceOperation::RetrievalQuery(args) = &operation {
            if &self.contract(call, &operation) != contract { return Err(ExecutionError::new("stale_tool_contract", "retrieval contract changed")); }
            return self.admit_retrieval(context, args, cancel);
        }
        if let ResourceOperation::LanguageQuery(args) = &operation {
            if &self.contract(call, &operation) != contract { return Err(ExecutionError::new("stale_tool_contract", "language contract changed")); }
            return self.admit_language_path(context, &args.path, cancel).map(|_| ());
        }
        if &self.planned_contract(context, call, &operation, cancel)? != contract {
            return Err(ExecutionError::new(
                "stale_tool_contract",
                "tool contract changed",
            ));
        }
        if self.physical_file(&operation) { return Ok(()); }
        self.resources
            .call(&self.binding, context, operation, true, cancel)
            .map(|_| ())
            .map_err(|failure| {
                ExecutionError::new(error_code(&failure.error), failure.error.to_string())
            })
    }
    fn execute(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        let operation = match self.operation(Some(context), call) {
            Ok(value) => value,
            Err(error) => {
                return ToolCompletion::NotDispatched {
                    reason: error.to_string(),
                }
            }
        };
        let mut expected = self.contract(call, &operation);
        if self.physical_file(&operation) { expected.resources = contract.resources.clone(); }
        if &expected != contract {
            return ToolCompletion::NotDispatched {
                reason: "tool contract changed".into(),
            };
        }
        if let ResourceOperation::RetrievalQuery(args) = &operation { return self.execute_retrieval(context, call, args, cancel); }
        if let ResourceOperation::LanguageQuery(args) = &operation { return self.execute_language(context, args, cancel); }
        let spawn = matches!(operation, ResourceOperation::ProcessSpawn(_));
        let mutation = matches!(operation, ResourceOperation::FileMutation(_));
        let result = if let ResourceOperation::FileQuery(args) = &operation {
            self.resources.query(&self.binding, context, args, cancel)
        } else {
            let expected_key = if self.physical_file(&operation) {
                contract.resources.first().map(|claim| claim.key.clone())
            } else { None };
            self.resources.call_checked(&self.binding, context, operation, false, expected_key, cancel)
        };
        match result {
            Ok(result) if spawn => {
                let phase = result.get("status").and_then(Value::as_str);
                if result.get("processId").and_then(Value::as_str)
                    != Some(context.operation_id.as_str())
                    || phase.is_none()
                    || matches!(phase, Some("unknown" | "failed"))
                {
                    ToolCompletion::Result {
                        outcome: Outcome::Indeterminate,
                        effect: Effect::Unknown,
                        content: result,
                    }
                } else {
                    ToolCompletion::JobAccepted {
                        operation_id: context.operation_id.clone(),
                        phase: phase.expect("checked process receipt").into(),
                        effect: Effect::Dispatched,
                        lifetime: Lifetime::Thread,
                    }
                }
            }
            // The conditional resource owner proved the target was untouched.
            // Use the explicit no-dispatch receipt; generic mutating Result(None)
            // is deliberately normalized to unknown by the runtime.
            Ok(result) if mutation && result["status"] == "conflict" => {
                ToolCompletion::NotDispatched {
                    reason: format!("File version conflict; no file was changed. Read the current file before retrying. {result}"),
                }
            }
            Ok(result) if mutation => ToolCompletion::Result {
                outcome: if result["status"] == "applied" {
                    Outcome::Succeeded
                } else {
                    Outcome::Failed
                },
                effect: if result["status"] == "applied" {
                    Effect::Confirmed
                } else {
                    Effect::None
                },
                content: result,
            },
            Ok(result) => ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                effect: Effect::None,
                content: result,
            },
            Err(failure) if !failure.dispatched => ToolCompletion::NotDispatched {
                reason: failure.error.to_string(),
            },
            Err(failure) => ToolCompletion::Result {
                outcome: if spawn || mutation {
                    Outcome::Indeterminate
                } else {
                    Outcome::Failed
                },
                effect: if spawn || mutation {
                    Effect::Unknown
                } else {
                    Effect::None
                },
                content: json!({"error":error_code(&failure.error),"message":failure.error.to_string()}),
            },
        }
    }
}

fn tool_schema(kind: ToolKind) -> Value {
    let (properties, required) = match kind {
        ToolKind::CodeRetrieval => return retrieval::schema(),
        ToolKind::LanguageDefinition | ToolKind::LanguageReferences | ToolKind::LanguageDiagnostics => return language::schema(kind),
        ToolKind::FileList | ToolKind::FileSearch => {
            return discovery::schema(kind == ToolKind::FileSearch)
        }
        ToolKind::FileWrite => (
            json!({"path":{"type":"string"},"readVersion":{"type":"string","minLength":1},"content":{"type":"string"}}),
            vec!["path", "readVersion", "content"],
        ),
        ToolKind::FileEdit => (
            json!({"path":{"type":"string"},"readVersion":{"type":"string","minLength":1},"edits":{"type":"array","minItems":1,"items":{"type":"object","additionalProperties":false,"properties":{"oldText":{"type":"string","minLength":1},"newText":{"type":"string"}},"required":["oldText","newText"]}}}),
            vec!["path", "readVersion", "edits"],
        ),
        ToolKind::FileRead => (
            json!({"path":{"type":"string"},"offset":{"type":"integer","minimum":0},"length":{"type":"integer","minimum":0}}),
            vec!["path"],
        ),
        ToolKind::ProcessInspect => {
            (json!({"processId":{"type":"string"}}), vec!["processId"])
        }
        ToolKind::ProcessRead => (
            json!({"processId":{"type":"string"},"cursor":{"type":"integer","minimum":0},"maxBytes":{"type":"integer","minimum":1}}),
            vec!["processId", "cursor"],
        ),
        ToolKind::ProcessSpawn => (
            json!({"cwd":{"type":"string"},"command":{"type":"string"},"args":{"type":"array","items":{"type":"string"}},
            "env":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"name":{"type":"string"},"value":{"type":"string"}},"required":["name","value"]}},
            "mode":{"type":"string","enum":["pipe","pty"]},"cols":{"type":"integer","minimum":1,"maximum":1000},"rows":{"type":"integer","minimum":1,"maximum":500},"windowsRawArguments":{"type":"string"}}),
            vec!["cwd", "command", "args", "mode"],
        ),
    };
    json!({"type":"object","additionalProperties":false,"properties":properties,"required":required})
}

fn validate_binding(
    grant: &Grant,
    binding: &ToolBinding,
    context: &ToolExecutionContext,
) -> Result<(), KernelError> {
    if context.run_id != binding.run_id
        || grant.run_id.as_deref() != Some(binding.run_id.as_str())
        || grant.thread_id.as_deref() != Some(binding.thread_id.as_str())
        || grant.owning_workspace.as_deref() != Some(binding.workspace_id.as_str())
        || grant
            .execution_workspace
            .as_deref()
            .or(grant.owning_workspace.as_deref())
            != Some(binding.execution_workspace_id.as_str())
    {
        return Err(KernelError::Authorization(
            "tool permit does not match actual run/thread/environment".into(),
        ));
    }
    Ok(())
}
/// Called only on the sole Storage actor. Host/epoch values come from its handshake, not the model.
/// Existing domain APIs accept validated Values; no JSON serialization or protocol loopback occurs.
pub(crate) fn serve_resource(
    storage: &mut Storage,
    epoch: &str,
    host_id: &str,
    host_generation: &str,
    request: &ResourceCall,
) -> Result<Value, ResourceFailure> {
    let mut dispatched = false;
    let result = (|| -> Result<Value, KernelError> {
        if request.cancellation.is_cancelled() {
            return Err(KernelError::Cancelled);
        }
        let (method, params) = request.operation.params(&request.binding, &request.context);
        let (grant, authorized) = storage.authorize(
            Some(&request.binding.grant_id),
            epoch,
            host_id,
            host_generation,
            method,
            &params,
        )?;
        validate_binding(&grant, &request.binding, &request.context)?;
        if matches!(request.operation, ResourceOperation::CollaborationPin { release: false, .. })
            && (!grant.path_scopes.iter().any(String::is_empty)
                || !(grant.capabilities.contains("storage.read") || grant.capabilities.contains("storage.admin"))) {
            return Err(KernelError::Authorization("fixed-root child handoff requires the parent's whole-root read authority".into()));
        }
        if let Some(root) = &request.binding.live_root {
            storage.validate_live_root(root, &grant, host_id)?;
        }
        let file_path = match &request.operation {
            ResourceOperation::FileMutation(mutation) => Some(mutation.path()),
            ResourceOperation::FileRead(args) if request.binding.source_mode != SourceMode::FixedBranch => Some(args.path.as_str()),
            _ => None,
        };
        if let Some(path) = file_path {
            let key = storage.file_resource_key(request.binding.root_id.as_deref().expect("validated physical root"), path, &grant)?;
            if request.authorize_only { return Ok(json!({"resourceKey":key})); }
            if request.expected_resource_key.as_deref() != Some(key.as_str()) {
                return Err(KernelError::Authorization("canonical file resource changed after admission".into()));
            }
        }
        if let ResourceOperation::ReconcileMutation { mutation, executor } = &request.operation {
            let root_id =
                request.binding.root_id.as_deref().ok_or_else(|| {
                    KernelError::Authorization("physical root missing".into())
                })?;
            storage.set_cancellation(request.cancellation.shared_flag());
            let result = storage.reconcile_text_mutation(
                &request.binding.workspace_id,
                root_id,
                &request.context.operation_id,
                mutation,
                &grant,
                executor,
            );
            storage.clear_cancellation();
            return result.and_then(|receipt| serde_json::to_value(receipt).map_err(Into::into));
        }
        if let ResourceOperation::FileMutation(mutation) = &request.operation {
            storage.set_cancellation(request.cancellation.shared_flag());
            let result = storage.file_mutate(
                &request.binding.workspace_id,
                request
                    .binding
                    .root_id
                    .as_deref()
                    .expect("validated physical root"),
                &request.context.operation_id,
                mutation,
                &grant,
                !request.authorize_only,
                &mut dispatched,
            );
            storage.clear_cancellation();
            return result;
        }
        if method == "file.read" {
            storage.set_cancellation(request.cancellation.shared_flag());
            let result = storage.file_read(&authorized, &grant, !request.authorize_only);
            storage.clear_cancellation();
            dispatched = !request.authorize_only;
            return result.map(|mut result| {
                if !request.authorize_only { result["source"] = request.binding.physical_source(); }
                result
            });
        }
        if matches!(&request.operation, ResourceOperation::ProcessObservation { .. }) {
            return storage.observe_run_process(method, &authorized, &grant, request.binding.root_id.as_deref(), request.authorize_only);
        }
        if request.authorize_only {
            return Ok(Value::Null);
        }
        if let ResourceOperation::ObserveCompute { reply } = &request.operation {
            let watch = storage.watch_compute(&request.context.operation_id, &request.binding.workspace_id, &grant)?;
            reply.send(watch).map_err(|_| KernelError::Storage("compute observer disconnected".into()))?;
            return Ok(Value::Null);
        }
        storage.set_cancellation(request.cancellation.shared_flag());
        dispatched = true;
        let result = storage.dispatch(method, &authorized, Some(&request.binding.grant_id), &grant);
        storage.clear_cancellation();
        let result = result?;
        if let ResourceOperation::FileRead(args) = &request.operation {
            let source = request
                .binding
                .file_source
                .as_ref()
                .expect("validated source");
            let entries = result
                .get("entries")
                .and_then(Value::as_array)
                .ok_or_else(|| KernelError::Storage("branch read omitted entries".into()))?;
            let state = entries.first().and_then(|entry| entry.get("state"));
            let Some(state) = state else {
                return Ok(json!({"path":args.path,"source":source,"missing":true}));
            };
            if state.get("kind").and_then(Value::as_str) != Some("regular-file") {
                return Ok(json!({"path":args.path,"source":source,"state":state,"missing":false}));
            }
            let hash = state
                .get("objectHash")
                .and_then(Value::as_str)
                .ok_or_else(|| KernelError::Storage("file state omitted object identity".into()))?;
            let mut params = json!({"hash":hash,"branchId":source.branch_id,"revision":source.revision,"path":args.path,"offset":args.offset});
            if let Some(length) = args.length {
                params["length"] = json!(length);
            }
            let (grant, authorized) = storage.authorize(
                Some(&request.binding.grant_id),
                epoch,
                host_id,
                host_generation,
                "storage.getBlob",
                &params,
            )?;
            validate_binding(&grant, &request.binding, &request.context)?;
            if request.cancellation.is_cancelled() {
                return Err(KernelError::Cancelled);
            }
            let mut content = storage.dispatch(
                "storage.getBlob",
                &authorized,
                Some(&request.binding.grant_id),
                &grant,
            )?;
            let encoded = content
                .get("bytesBase64")
                .and_then(Value::as_str)
                .ok_or_else(|| KernelError::Storage("content read omitted bytes".into()))?;
            let bytes = BASE64.decode(encoded).map_err(|_| {
                KernelError::Storage("content read returned malformed bytes".into())
            })?;
            if let Ok(text) = String::from_utf8(bytes) {
                let object = content.as_object_mut().expect("content result object");
                object.remove("bytesBase64");
                object.insert("text".into(), Value::String(text));
            }
            return Ok(json!({"path":args.path,"source":source,"missing":false,"content":content}));
        }
        Ok(result)
    })();
    result.map_err(|error| ResourceFailure { error, dispatched })
}

#[cfg(test)]
#[path = "collaboration_boundary_review.rs"]
mod collaboration_boundary_review;
