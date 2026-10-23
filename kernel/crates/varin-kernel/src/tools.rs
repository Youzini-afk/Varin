//! Selected tools reuse the existing Storage owner through typed in-process messages.
//! No second catalog, file writer, process manager, or management-authority fallback exists here.
use crate::error::{error_code, KernelError};
use crate::model::Grant;
use crate::storage::file_mutations::{FileEditArgs, FileWriteArgs, TextMutation};
use crate::storage::Storage;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::{mpsc, Arc};
use varin_runtime::execution::{
    Access, CancellationToken, CompletionKind, ExecutionError, FrozenToolContext, PreparedToolCall,
    ResourceClaim, ResourceIntent, ToolCall, ToolCompletion, ToolContract, ToolExecutionContext,
    ToolExecutor, ToolOrigin, ToolPreparation, ToolSchema,
};
use varin_runtime::{Effect, Lifetime, Outcome};

#[path = "tools_discovery.rs"]
mod discovery;
#[path = "tools_reconciliation.rs"]
mod reconciliation;
#[path = "tools_retrieval.rs"]
mod retrieval;
#[path = "tools_read.rs"]
mod read;
use discovery::FileQueryArgs;
use retrieval::RetrievalQueryArgs;
use crate::storage::recovery_points::{RecoveryPointsArgs, FileRestoreArgs};

/// Private source admission for the IDE service. Never a model tool or schema.
#[derive(Debug, Clone)]
pub(crate) struct LanguageSourceArgs {
    path: String,
    derived_view: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ToolKind {
    FileRead,
    FileList,
    FileSearch,
    FileWrite,
    FileEdit,
    RecoveryPoints,
    FileRestore,
    ProcessInspect,
    ProcessRead,
    ProcessSpawn,
    ProcessWrite,
    ProcessResize,
    CodeRetrieval,
}
impl ToolKind {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::FileRead => "file_read",
            Self::FileList => "file_list",
            Self::FileSearch => "file_search",
            Self::FileWrite => "file_write",
            Self::FileEdit => "file_edit",
            Self::RecoveryPoints => "recovery_points",
            Self::FileRestore => "file_restore",
            Self::ProcessInspect => "process_inspect",
            Self::ProcessRead => "process_read",
            Self::ProcessSpawn => "process_spawn",
            Self::ProcessWrite => "process_write",
            Self::ProcessResize => "process_resize",
            Self::CodeRetrieval => "code_retrieval",
        }
    }
    pub(crate) fn requirements(self) -> varin_runtime::execution::ToolRequirements {
        use varin_runtime::execution::{ToolRequirements, ToolSourceRequirement::*};
        let source = match self {
            Self::FileRead | Self::FileList | Self::FileSearch | Self::CodeRetrieval
                | Self::ProcessSpawn | Self::ProcessInspect | Self::ProcessRead | Self::ProcessWrite | Self::ProcessResize => Source,
            _ => Physical,
        };
        ToolRequirements {
            source,
            process: matches!(
                self,
                Self::ProcessInspect
                    | Self::ProcessRead
                    | Self::ProcessSpawn
                    | Self::ProcessWrite
                    | Self::ProcessResize
            ),
        }
    }
    fn description(self) -> &'static str {
        match self {
            Self::FileRead => {
                "Read a bounded UTF-8 range from the admitted source and return its read version."
            }
            Self::FileList => "List paths in the admitted source with bounded pagination.",
            Self::FileSearch => "Search text in the admitted source and return bounded matches.",
            Self::FileWrite => {
                "Create a new file or replace an existing file using its read version."
            }
            Self::FileEdit => {
                "Apply exact text edits against a file read version in the admitted writable workspace."
            }
            Self::RecoveryPoints => "Find file recovery points by conversation round, or inspect a point and its affected paths.",
            Self::FileRestore => "Restore recorded files to a recovery point or undo a restore. Use current:before for the start of this round; paths selects files. Returns per-file results and keeps the conversation active.",
            Self::ProcessInspect => {
                "Inspect a retained process owned by the admitted execution environment."
            }
            Self::ProcessRead => {
                "Read bounded output from a retained process in the admitted execution environment."
            }
            Self::ProcessSpawn => {
                "Start a process in the admitted execution environment and return its durable operation handle."
            }
            Self::ProcessWrite => {
                "Write UTF-8 input to the original process and report actual written-byte evidence. Pipe EOF is explicit; a PTY accepts control characters rather than a universal EOF operation."
            }
            Self::ProcessResize => {
                "Resize the original PTY and wait for its actual size-change receipt."
            }
            Self::CodeRetrieval => {
                "Retrieve source excerpts relevant to the question, following useful code relationships to provide the context needed for further work. Results include source locations and any gaps that affect their use."
            }
        }
    }
    pub(crate) fn all() -> impl Iterator<Item = Self> {
        [
            Self::FileRead,
            Self::FileList,
            Self::FileSearch,
            Self::FileWrite,
            Self::FileEdit,
            Self::RecoveryPoints,
            Self::FileRestore,
            Self::ProcessInspect,
            Self::ProcessRead,
            Self::ProcessSpawn,
            Self::ProcessWrite,
            Self::ProcessResize,
            Self::CodeRetrieval,
        ]
        .into_iter()
    }
    fn from_name(name: &str) -> Option<Self> {
        Self::all().find(|kind| kind.name() == name)
    }
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FixedFileSource {
    pub branch_id: String,
    pub revision: i64,
}
pub(crate) use varin_runtime::SourceMode;
fn default_source_mode() -> SourceMode {
    SourceMode::FixedBranch
}
pub(crate) fn source_capabilities(
    p: crate::source_resources::SourceCapabilitiesParams,
) -> Result<Value, KernelError> {
    let requested = p
        .enabled_tools
        .as_ref()
        .map(|names| names.iter().cloned().collect::<BTreeSet<_>>());
    if let Some(requested) = &requested {
        let unknown = requested.iter().filter(|name| ToolKind::from_name(name).is_none()).cloned().collect::<Vec<_>>();
        if !unknown.is_empty() {
            return Err(KernelError::Protocol(format!("Tools are not registered for Agent sources: {}. Refresh the available tools and update the explicit selection.", unknown.join(", "))));
        }
    }
    let client = p
        .client_capabilities
        .as_ref()
        .map(|caps| caps.iter().map(String::as_str).collect::<BTreeSet<_>>());
    let mut tools = BTreeSet::new();
    let mut client_capabilities = BTreeSet::new();
    let mut unavailable = Vec::new();
    for kind in ToolKind::all() {
        if requested
            .as_ref()
            .is_some_and(|names| !names.contains(kind.name()))
        {
            continue;
        }
        let mut caps = vec!["filesystem:read"];
        if matches!(kind, ToolKind::FileWrite | ToolKind::FileEdit | ToolKind::FileRestore) {
            caps.push("filesystem:write");
        }
        if kind == ToolKind::FileRestore { caps.push("filesystem:delete"); }
        if kind.requirements().process {
            caps.extend(["terminal:use", "process:control"]);
        }
        let missing = !kind.requirements().accepts_mode(p.mode)
            || client
                .as_ref()
                .is_some_and(|set| caps.iter().any(|cap| !set.contains(cap)));
        if missing {
            unavailable.push(json!({"name":kind.name(),"code":"source_capability_unavailable"}));
        } else {
            tools.insert(kind);
            client_capabilities.extend(caps);
        }
    }
    if let Some(requested) = requested {
        if requested.len() != tools.len() {
            return Err(KernelError::Authorization(
                "An explicitly selected source capability is unavailable".into(),
            ));
        }
    }
    let mut grant_capabilities = vec!["storage.read"];
    // Registering/capturing a physical source is an internal resource-owner write,
    // independent of whether model/client file mutation is available.
    if p.mode != SourceMode::FixedBranch || tools.iter().any(|kind|kind.requirements().process) {
        grant_capabilities.push("storage.write");
    }
    if tools.iter().any(|kind| kind.requirements().process) {
        grant_capabilities.push("process");
    }
    Ok(
        json!({"tools":KernelToolExecutor::selected_schemas(&tools),"grantCapabilities":grant_capabilities,"clientCapabilities":client_capabilities,"unavailable":unavailable}),
    )
}
/// Supplied by the trusted Host after resolving its environment/source view, never by model args.
/// A binding is not itself a grant: the Storage owner revalidates the persisted grant on every call.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ToolBinding {
    pub resource_owner: varin_runtime::catalog::launches::SourceResourceOwner,
    pub remote_authority: Option<RemoteResourceAuthority>,
    #[serde(skip)]
    pub target_authority: Option<crate::source_resources::SourceAuthorityAddress>,
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
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteResourceAuthority {
    pub authority_id: String,
    pub resource_epoch: String,
    pub execution_owner: varin_runtime::ExecutorOwner,
}
impl ToolBinding {
    fn physical_source(&self) -> Value {
        let mut source = json!({"mode":self.source_mode,"rootId":self.root_id});
        if let Some(root) = &self.live_root {
            source["liveRoot"] = json!(root);
        }
        if let Some(base) = &self.materialized_source {
            source["base"] = json!(base);
        }
        source
    }
    pub(crate) fn source_selection(
        &self,
    ) -> Result<varin_runtime::catalog::launches::SourceSelection, KernelError> {
        let fixed = self
            .file_source
            .as_ref()
            .or(self.materialized_source.as_ref());
        let source = varin_runtime::catalog::launches::SourceSelection {
            resource_owner: self.resource_owner.clone(),
            environment_run_id: self.environment_run_id.clone(),
            mode: self.source_mode,
            live_root: self.live_root.clone(),
            workspace_id: self.workspace_id.clone(),
            execution_workspace_id: self.execution_workspace_id.clone(),
            branch_id: fixed.map(|source| source.branch_id.clone()),
            revision: fixed
                .map(|source| u64::try_from(source.revision))
                .transpose()
                .map_err(|_| KernelError::Protocol("source revision must be nonnegative".into()))?,
        };
        source
            .validate()
            .map_err(|error| KernelError::Protocol(error.to_string()))?;
        Ok(source)
    }
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileReadArgs {
    path: String,
    #[serde(default)]
    offset: u64,
    length: Option<u64>,
    start_line: Option<u64>,
    end_line: Option<u64>,
    unit: Option<read::UnitReadArgs>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProcessWriteArgs {
    pub process_id: String,
    pub text: String,
    #[serde(default)]
    pub eof: bool,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProcessResizeArgs {
    pub process_id: String,
    pub cols: u16,
    pub rows: u16,
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
    #[serde(default)]
    mode: crate::process::text::Mode,
    encoding: Option<String>,
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
    #[serde(default)]
    cwd: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: Vec<EnvironmentEntry>,
    #[serde(default = "default_process_mode")]
    mode: String,
    cols: Option<u16>,
    rows: Option<u16>,
    windows_raw_arguments: Option<String>,
    #[serde(default)]
    wait_ms: u64,
    max_output_bytes: Option<u64>,
    output_encoding: Option<String>,
}
fn default_process_mode() -> String { "pipe".into() }
#[derive(Debug, Clone)]
enum ResourceOperation {
    ChildSourceHandoff {
        delegation: varin_runtime::catalog::dispatch::ChildSourceDelegation,
    },
    ChildStorageReceipt {
        operation_id: String,
        kind: String,
    },
    ChildRootIdle,
    CollaborationPin {
        release: bool,
        pin_id: String,
    },
    FileRead(FileReadArgs),
    FileReadBatch(Vec<Value>),
    FileQuery(FileQueryArgs),
    LanguageSource(LanguageSourceArgs),
    RetrievalQuery(RetrievalQueryArgs),
    ObserveCompute {
        job_id: String,
        reply: mpsc::Sender<crate::compute::ComputeWatch>,
    },
    ComputeControl {
        job_id: String,
        kernel_epoch: Option<String>,
        method: &'static str,
        cursor: u64,
    },
    FileMutation(TextMutation),
    RecoveryPoints(RecoveryPointsArgs),
    FileRestore(FileRestoreArgs),
    ReconcileFileRestore(FileRestoreArgs),
    ReconcileMutation {
        mutation: TextMutation,
        executor: String,
    },
    ProcessObservation {
        source_run_id: String,
        lineage: Option<varin_runtime::catalog::process_wait::ProcessResultLineage>,
        process_id: String,
        read: Option<(u64, Option<u64>)>,
    },
    ProcessInspect(ProcessInspectArgs),
    ProcessRead(ProcessReadArgs),
    ProcessSpawn(ProcessSpawnArgs),
    ProcessWrite(ProcessWriteArgs),
    ProcessResize(ProcessResizeArgs),
}
impl ResourceOperation {
    /// These compose original source reads with Host-owned services/history.
    /// Remote resource Hosts have no coordinator Catalog or language bridge.
    fn coordinator_owned(&self) -> bool {
        matches!(self, Self::LanguageSource(_) | Self::RetrievalQuery(_) | Self::FileReadBatch(_))
            || matches!(self, Self::FileRead(args) if args.unit.is_some())
    }
    fn parse(kind: ToolKind, args: &Value) -> Result<Self, ExecutionError> {
        let explicit_offset = args.get("offset").is_some();
        if args
            .as_object()
            .is_some_and(|object| object.values().any(Value::is_null))
        {
            return Err(ExecutionError::new(
                "invalid_tool_arguments",
                "optional fields must be omitted rather than null",
            ));
        }
        let mut parsed = match kind {
            ToolKind::CodeRetrieval => {
                return RetrievalQueryArgs::parse(args).map(Self::RetrievalQuery);
            }
            ToolKind::FileList | ToolKind::FileSearch => {
                serde_json::from_value::<FileQueryArgs>(args.clone()).map(|mut args| {
                    args.search = kind == ToolKind::FileSearch;
                    Self::FileQuery(args)
                })
            }
            ToolKind::RecoveryPoints => serde_json::from_value(args.clone()).map(Self::RecoveryPoints),
            ToolKind::FileRestore => serde_json::from_value(args.clone()).map(Self::FileRestore),
            ToolKind::FileRead if args.get("files").is_some() => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Batch { files: Vec<Value> }
                let batch: Batch = serde_json::from_value(args.clone()).map_err(|e|ExecutionError::new("invalid_tool_arguments",e.to_string()))?;
                if batch.files.is_empty() { return Err(ExecutionError::new("invalid_tool_arguments","files must contain at least one read")); }
                return Ok(Self::FileReadBatch(batch.files));
            }
            ToolKind::FileRead => serde_json::from_value(args.clone()).map(Self::FileRead),
            ToolKind::FileWrite => serde_json::from_value::<FileWriteArgs>(args.clone())
                .map(|args| Self::FileMutation(TextMutation::Write(args))),
            ToolKind::FileEdit => serde_json::from_value::<FileEditArgs>(args.clone())
                .map(|args| Self::FileMutation(TextMutation::Edit(args))),
            ToolKind::ProcessInspect => {
                serde_json::from_value(args.clone()).map(Self::ProcessInspect)
            }
            ToolKind::ProcessRead => serde_json::from_value(args.clone()).map(Self::ProcessRead),
            ToolKind::ProcessWrite => serde_json::from_value(args.clone()).map(Self::ProcessWrite),
            ToolKind::ProcessResize => {
                serde_json::from_value(args.clone()).map(Self::ProcessResize)
            }
            ToolKind::ProcessSpawn => {
                let mut arguments = args.clone();
                if let Some(script) = arguments.get("shellCommand").cloned() {
                    if script.as_str().is_none_or(|text| text.trim().is_empty() || text.contains('\0'))
                        || ["command","args","windowsRawArguments"].iter().any(|key|arguments.get(key).is_some()) {
                        return Err(ExecutionError::new("invalid_tool_arguments","Use shellCommand alone, or command with an argument array"));
                    }
                    arguments.as_object_mut().expect("object with shellCommand").remove("shellCommand");
                    #[cfg(windows)] {
                        arguments["command"] = json!("powershell.exe");
                        arguments["args"] = json!(["-NoLogo","-NoProfile","-NonInteractive","-Command",script]);
                    }
                    #[cfg(not(windows))] {
                        arguments["command"] = json!("/bin/sh");
                        arguments["args"] = json!(["-c",script]);
                    }
                }
                if arguments.get("env").is_none() {
                    let environment = std::env::vars_os()
                        .map(|(name, value)| {
                            Ok(EnvironmentEntry {
                                name: name.into_string().map_err(|_| {
                                    ExecutionError::new(
                                        "environment_encoding",
                                        "process environment name is not UTF-8",
                                    )
                                })?,
                                value: value.into_string().map_err(|_| {
                                    ExecutionError::new(
                                        "environment_encoding",
                                        "process environment value is not UTF-8",
                                    )
                                })?,
                            })
                        })
                        .collect::<Result<Vec<_>, ExecutionError>>()?;
                    arguments["env"] = json!(environment);
                }
                serde_json::from_value::<ProcessSpawnArgs>(arguments).map(|mut args| {
                    args.cwd = std::path::Path::new(&args.cwd.replace('\\', "/"))
                        .components().filter(|part| !matches!(part, std::path::Component::CurDir))
                        .collect::<std::path::PathBuf>().to_string_lossy().replace('\\', "/");
                    Self::ProcessSpawn(args)
                })
            }
        }
        .map_err(|error| ExecutionError::new("invalid_tool_arguments", error.to_string()))?;
        match &mut parsed {
            Self::FileQuery(args) => args.validate()?,
            Self::FileRead(args) => {
                if let Some(unit)=&args.unit {
                    unit.validate()?;
                    if args.start_line.is_some() || args.end_line.is_some() { return Err(ExecutionError::new("invalid_tool_arguments","Use unit selection without startLine/endLine; offset is relative to the selected unit")); }
                }
                normalize_separators(&mut args.path);
                normalized_path(&args.path, false)?;
                // Agent-facing default page only. Internal source/mutation reads retain
                // their explicit full-read semantics; callers can request a larger range.
                if args.length.is_none() && args.start_line.is_none() && args.end_line.is_none() {
                    args.length = Some(65536);
                }
                if args.start_line.is_some() || args.end_line.is_some() {
                    if explicit_offset || args.length.is_some()
                        || args.start_line.is_none_or(|line| line == 0)
                        || args.end_line.is_some_and(|line| line < args.start_line.unwrap_or(1)) {
                        return Err(ExecutionError::new("invalid_tool_arguments", "Use positive, inclusive startLine/endLine without offset or length"));
                    }
                }
            }
            Self::FileMutation(mutation) => {
                normalize_separators(match mutation {
                    TextMutation::Write(args) => &mut args.path,
                    TextMutation::Edit(args) => &mut args.path,
                });
                normalized_path(mutation.path(), false)?;
                if mutation.read_version().is_empty() && (matches!(mutation, TextMutation::Edit(_))
                    || matches!(mutation, TextMutation::Write(args) if args.mode == Some(crate::storage::file_mutations::FileWriteMode::Replace))) {
                    return Err(ExecutionError::new(
                        "invalid_tool_arguments",
                        "readVersion is required",
                    ));
                }
            }
            Self::ProcessSpawn(args) => {
                crate::process::text::validate_encoding(args.output_encoding.as_deref()).map_err(|message| ExecutionError::new("invalid_tool_arguments",message))?;
                if args.wait_ms > 9_007_199_254_740_991 || args.max_output_bytes.is_some_and(|value|value==0 || value > crate::process::CHUNK_BYTES as u64) {
                    return Err(ExecutionError::new("invalid_tool_arguments","waitMs must be a nonnegative safe integer and maxOutputBytes must fit one process output page"));
                }
                normalized_path(&args.cwd, true)?;
                if !matches!(args.mode.as_str(), "pipe" | "pty")
                    || args.command.is_empty()
                    || args.command.contains('\0')
                    || args.cols.is_some_and(|value| value == 0)
                    || args.rows.is_some_and(|value| value == 0)
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
                ));
            }
            Self::ProcessRead(args) => {
                crate::process::text::validate_encoding(args.encoding.as_deref()).map_err(|message| ExecutionError::new("invalid_tool_arguments",message))?;
                if args.process_id.is_empty() || args.max_bytes == Some(0) {
                    return Err(ExecutionError::new("invalid_tool_arguments", "invalid process output identity or range"));
                }
            }
            Self::ProcessWrite(args) if args.process_id.is_empty() => {
                return Err(ExecutionError::new(
                    "invalid_tool_arguments",
                    "processId required",
                ));
            }
            Self::ProcessResize(args)
                if args.process_id.is_empty() || args.cols == 0 || args.rows == 0 =>
            {
                return Err(ExecutionError::new(
                    "invalid_tool_arguments",
                    "invalid PTY dimensions or process identity",
                ));
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
            Self::ChildSourceHandoff { .. }
            | Self::ChildStorageReceipt { .. }
            | Self::ChildRootIdle => (
                "storage.health",
                json!({"workspaceId":binding.workspace_id}),
            ),
            Self::ProcessObservation {
                process_id, read, ..
            } => {
                let mut params = json!({"workspaceId":binding.workspace_id,"processId":process_id});
                if let Some((cursor, limit)) = read {
                    params["cursor"] = json!(cursor);
                    if let Some(limit) = limit {
                        params["maxBytes"] = json!(limit);
                    }
                }
                (
                    if read.is_some() {
                        "process.read"
                    } else {
                        "process.inspect"
                    },
                    params,
                )
            }
            Self::CollaborationPin { release, pin_id } => {
                let source = binding
                    .file_source
                    .as_ref()
                    .expect("fixed collaboration binding");
                if *release {
                    (
                        "branch.unpin",
                        json!({"operationId":format!("child-unpin:{}",context.operation_id),"branchId":source.branch_id,"pinId":pin_id}),
                    )
                } else {
                    (
                        "branch.pin",
                        json!({"operationId":format!("child-pin:{}",context.operation_id),"branchId":source.branch_id,"revision":source.revision,"pinId":pin_id}),
                    )
                }
            }
            Self::RetrievalQuery(args) => {
                // Revalidate the bound read grant and explicit scopes without inventing a root
                // path or dispatching compute. Body reads receive separate per-file admission.
                let mut params = json!({"workspaceId":binding.workspace_id});
                if let Some(paths) = &args.paths {
                    params["paths"] = json!(paths);
                }
                ("storage.health", params)
            }
            Self::LanguageSource(args) => {
                if let Some(source) = &binding.file_source {
                    (
                        "branch.read",
                        json!({"branchId":source.branch_id,"revision":source.revision,"paths":[args.path],"includeEntries":false}),
                    )
                } else {
                    (
                        "file.read",
                        json!({"workspaceId":binding.workspace_id,"rootId":binding.root_id,"path":args.path}),
                    )
                }
            }
            Self::FileReadBatch(_) => unreachable!("batch reads are expanded by the tool owner"),
            Self::FileQuery(args) => ("compute.start", args.params(binding, context)),
            Self::ObserveCompute { job_id, .. } => (
                "compute.read",
                json!({
                    "workspaceId": binding.workspace_id, "jobId": job_id, "cursor": 0
                }),
            ),
            Self::ComputeControl { job_id, kernel_epoch, method, cursor } => {
                let mut params =
                    json!({"workspaceId":binding.workspace_id,"jobId":job_id});
                if *method == "compute.read" {
                    if let Some(epoch)=kernel_epoch {params["kernelEpoch"]=json!(epoch);}
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
            Self::RecoveryPoints(args) => ("recovery.points", json!({"workspaceId":binding.workspace_id,"rootId":binding.root_id,"threadId":binding.thread_id,"arguments":args})),
            Self::FileRestore(args) => ("recovery.files.restore", json!({"workspaceId":binding.workspace_id,"rootId":binding.root_id,"threadId":binding.thread_id,"operationId":context.operation_id,"arguments":args})),
            Self::ReconcileFileRestore(args) => ("recovery.files.restore", json!({"workspaceId":binding.workspace_id,"rootId":binding.root_id,"threadId":binding.thread_id,"operationId":context.operation_id,"arguments":args})),
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
                if let Some(line) = args.start_line { params["startLine"] = json!(line); }
                if let Some(line) = args.end_line { params["endLine"] = json!(line); }
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
                json!({"workspaceId":binding.workspace_id,"processId":args.process_id,"rootId":binding.root_id}),
            ),
            Self::ProcessRead(args) => {
                let mut params = json!({"workspaceId":binding.workspace_id,"processId":args.process_id,"rootId":binding.root_id,"cursor":args.cursor});
                if let Some(limit) = args.max_bytes {
                    params["maxBytes"] = json!(limit);
                }
                ("process.read", params)
            }
            Self::ProcessWrite(_) | Self::ProcessResize(_) => {
                unreachable!("interactive processes require their Catalog endpoint")
            }
            Self::ProcessSpawn(args) => {
                let mut params = json!({"workspaceId":binding.workspace_id,"rootId":binding.root_id,
                    "processId":context.operation_id,"cwd":args.cwd,"command":args.command,"args":args.args,
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
fn normalize_separators(path: &mut String) {
    if path.contains('\\') { *path = path.replace('\\', "/"); }
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
    pub(crate) fn send(
        mut self,
        value: Result<Value, ResourceFailure>,
    ) -> Result<(), mpsc::SendError<Result<Value, ResourceFailure>>> {
        self.sender
            .take()
            .expect("resource reply sender")
            .send(value)
    }
}
impl Drop for ResourceReply {
    fn drop(&mut self) {
        // Close before notifying, including when the owner exits without a reply.
        self.sender.take();
        if let Some(wake) = &self.wake {
            let _ = wake.try_send(());
        }
    }
}
pub(crate) struct ResourceCall {
    pub admission_key: Option<String>,
    pub binding: ToolBinding,
    pub context: ToolExecutionContext,
    journal: Option<varin_runtime::catalog::journal::JournalAnchor>,
    operation: ResourceOperation,
    authorize_only: bool,
    expected_resource_key: Option<String>,
    pub cancellation: CancellationToken,
    pub reply: ResourceReply,
}
impl ResourceCall {
    fn with_execution_binding(&self,binding:ToolBinding)->Self {
        Self {binding,context:self.context.clone(),journal:self.journal.clone(),operation:self.operation.clone(),
            authorize_only:self.authorize_only,expected_resource_key:self.expected_resource_key.clone(),
            cancellation:self.cancellation.clone(),admission_key:self.admission_key.clone(),
            reply:ResourceReply{sender:None,wake:None}}
    }
}
fn fixed_read_key(binding:&ToolBinding,path:&str)->String {
    json!(["file",binding.resource_owner,"fixed",binding.execution_workspace_id,binding.file_source,path]).to_string()
}
pub(crate) fn finish_resource_execution_view(storage:&mut Storage,epoch:&str,host:&str,generation:&str,
    request:&ResourceCall,result:Value)->Result<(),KernelError> {
    if let Some(authority)=&request.binding.target_authority { storage.validate_source_resource(authority,&request.binding,epoch,true)?; }
    let (grant,_)=storage.authorize(Some(&request.binding.grant_id),epoch,host,generation,"storage.health",&json!({"workspaceId":request.binding.workspace_id}))?;
    validate_binding(&grant,&request.binding,&request.context)?;
    Storage::require_execution_view_owner(&request.binding,&grant)?;
    let params=Storage::execution_view_params(&request.binding)?;
    storage.finish_materialized_view(&params,&grant,result)?;
    Ok(())
}
#[cfg(test)]
pub(crate) fn fixed_read_fixture(
    binding: ToolBinding,
    path: &str,
    cancellation: CancellationToken,
    lines: bool,
) -> (ResourceCall, mpsc::Receiver<Result<Value, ResourceFailure>>) {
    let (sender, receiver) = mpsc::channel();
    (
        ResourceCall {
            admission_key: Some("fixture-read-admission".into()),
            journal: None,
            context: ToolExecutionContext {
                run_id: binding.run_id.clone(),
                operation_id: "fixture-read".into(),
                origin: ToolOrigin::ModelStep {
                    request_id: "fixture-model".into(),
                },
            },
            binding,
            operation: ResourceOperation::FileRead(FileReadArgs {
                path: path.into(),
                offset: if lines { 0 } else { 1 },
                length: if lines { None } else { Some(3) },
                start_line: lines.then_some(2),
                end_line: lines.then_some(2),
                unit:None,
            }),
            authorize_only: false,
            expected_resource_key: None,
            cancellation,
            reply: ResourceReply {
                sender: Some(sender),
                wake: None,
            },
        },
        receiver,
    )
}
type AdmissionControl = dyn Fn(
        &ToolBinding,
        &CancellationToken,
    ) -> Result<varin_runtime::execution_capacity::AdmissionControlGuard, ExecutionError>
    + Send
    + Sync;
/// Constructed only after Catalog validated the original native Integration Tool invocation.
pub(crate) struct IntegrationReceiptRead {
    pub source: varin_runtime::catalog::launches::SourceSelection,
    pub run_id: String,
    pub thread_id: String,
    pub operation_id: String,
    pub reply: mpsc::Sender<Result<Value, KernelError>>,
}
/// The Kernel actor injects this sender. Sending does not create another resource authority.
#[derive(Clone)]
pub(crate) struct KernelResourceClient {
    pub(crate) file_observations: Option<crate::file_observation::Client>,
    pub(crate) interactions: Option<crate::storage::process_interactions::Client>,
    integration_receipts:
        Option<Arc<dyn Fn(IntegrationReceiptRead) -> Result<(), KernelError> + Send + Sync>>,
    send: Arc<dyn Fn(ResourceCall) -> Result<(), KernelError> + Send + Sync>,
    replay: Arc<dyn Fn(Vec<String>) -> Result<(), KernelError> + Send + Sync>,
    controls: crate::process::ProcessControlRegistry,
    admission_control: Option<Arc<AdmissionControl>>,
    journal_catalog: Option<Arc<std::sync::Mutex<varin_runtime::Catalog>>>,
    environment_stops: Arc<std::sync::Mutex<BTreeSet<String>>>,
    source_bridge: Option<crate::host_query::OwnerChannel>,
    source_journal: Option<varin_runtime::catalog::journal::JournalAnchor>,
}
impl KernelResourceClient {
    pub(crate) fn new(
        send: impl Fn(ResourceCall) -> Result<(), KernelError> + Send + Sync + 'static,
        replay: impl Fn(Vec<String>) -> Result<(), KernelError> + Send + Sync + 'static,
        controls: crate::process::ProcessControlRegistry,
    ) -> Self {
        Self {
            file_observations: None,
            send: Arc::new(send),
            interactions: None,
            integration_receipts: None,
            replay: Arc::new(replay),
            controls,
            admission_control: None,
            journal_catalog: None,
            environment_stops: Default::default(),
            source_bridge: None,
            source_journal: None,
        }
    }
    pub(crate) fn with_source_bridge(mut self, bridge: crate::host_query::OwnerChannel) -> Self {
        self.source_bridge = Some(bridge);
        self
    }
    pub(crate) fn with_source_journal(
        mut self,
        journal: Option<varin_runtime::catalog::journal::JournalAnchor>,
    ) -> Self {
        self.source_journal = journal;
        self
    }
    pub(crate) fn source_query(
        &self,
        query: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, ExecutionError> {
        let result = self
            .source_bridge
            .as_ref()
            .ok_or_else(|| {
                ExecutionError::new("source_unavailable", "Managed source bridge is unavailable")
            })?
            .query_draining(query, cancel)?;
        if result["ok"] != true {
            return Err(ExecutionError::new(
                "source_unavailable",
                result["message"]
                    .as_str()
                    .unwrap_or("Managed source request failed"),
            ));
        }
        Ok(result["value"].clone())
    }
    pub(crate) fn with_journal_catalog(
        mut self,
        catalog: Arc<std::sync::Mutex<varin_runtime::Catalog>>,
    ) -> Self {
        self.journal_catalog = Some(catalog);
        self
    }
    pub(crate) fn with_file_observations(
        mut self,
        client: crate::file_observation::Client,
    ) -> Self {
        self.file_observations = Some(client);
        self
    }
    pub(crate) fn with_process_interactions(
        mut self,
        client: crate::storage::process_interactions::Client,
    ) -> Self {
        self.interactions = Some(client);
        self
    }
    pub(crate) fn with_admission_control(
        mut self,
        watch: impl Fn(
                &ToolBinding,
                &CancellationToken,
            )
                -> Result<varin_runtime::execution_capacity::AdmissionControlGuard, ExecutionError>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        self.admission_control = Some(Arc::new(watch));
        self
    }
    /// Caller has checked the real Catalog process Operation and immutable launch source.
    pub(crate) fn observe_process(
        &self,
        binding: &ToolBinding,
        context: &ToolExecutionContext,
        process_id: &str,
        source_run_id: &str,
        lineage: Option<varin_runtime::catalog::process_wait::ProcessResultLineage>,
        read: Option<(u64, Option<u64>)>,
        authorize_only: bool,
        cancel: &CancellationToken,
    ) -> Result<Value, ExecutionError> {
        self.call(
            binding,
            context,
            ResourceOperation::ProcessObservation {
                source_run_id: source_run_id.into(),
                lineage,
                process_id: process_id.into(),
                read,
            },
            authorize_only,
            cancel,
        )
        .map_err(|failure| {
            ExecutionError::new(error_code(&failure.error), failure.error.to_string())
        })
    }
    pub(crate) fn with_integration_receipts(
        mut self,
        send: impl Fn(IntegrationReceiptRead) -> Result<(), KernelError> + Send + Sync + 'static,
    ) -> Self {
        self.integration_receipts = Some(Arc::new(send));
        self
    }
    pub(crate) fn integration_receipt(
        &self,
        source: varin_runtime::catalog::launches::SourceSelection,
        run_id: String,
        thread_id: String,
        operation_id: String,
    ) -> Result<Value, KernelError> {
        if !source.resource_owner.is_local() {
            return self.source_query(json!({"kind":"integration_receipt","source":source,"runId":run_id,"threadId":thread_id,"operationId":operation_id}),&CancellationToken::default()).map_err(|error|KernelError::Operation(error.to_string()));
        }
        let (reply, receive) = mpsc::channel();
        self.integration_receipts.as_ref().ok_or_else(|| {
            KernelError::Storage("Integration journal reader is unavailable".into())
        })?(IntegrationReceiptRead {
            source,
            run_id,
            thread_id,
            operation_id,
            reply,
        })?;
        receive
            .recv()
            .map_err(|_| KernelError::Storage("Integration journal owner stopped".into()))?
    }
    pub(crate) fn child_source_handoff(
        &self,
        binding: &ToolBinding,
        context: &ToolExecutionContext,
        delegation: &varin_runtime::catalog::dispatch::ChildSourceDelegation,
        authorize_only: bool,
        cancel: &CancellationToken,
    ) -> Result<Value, ExecutionError> {
        self.call(
            binding,
            context,
            ResourceOperation::ChildSourceHandoff {
                delegation: delegation.clone(),
            },
            authorize_only,
            cancel,
        )
        .map_err(|failure| ExecutionError::new("collaboration_source", failure.error.to_string()))
    }
    pub(crate) fn child_storage_receipt(
        &self,
        binding: &ToolBinding,
        context: &ToolExecutionContext,
        operation_id: &str,
        kind: &str,
        cancel: &CancellationToken,
    ) -> Result<Value, ExecutionError> {
        self.call(
            binding,
            context,
            ResourceOperation::ChildStorageReceipt {
                operation_id: operation_id.into(),
                kind: kind.into(),
            },
            false,
            cancel,
        )
        .map_err(|failure| ExecutionError::new("collaboration_result", failure.error.to_string()))
    }
    pub(crate) fn require_child_root_idle(
        &self,
        binding: &ToolBinding,
        context: &ToolExecutionContext,
        cancel: &CancellationToken,
    ) -> Result<Value, ExecutionError> {
        self.call(
            binding,
            context,
            ResourceOperation::ChildRootIdle,
            false,
            cancel,
        )
        .map_err(|failure| ExecutionError::new("collaboration_writer", failure.error.to_string()))
    }
    pub(crate) fn collaboration_pin(
        &self,
        binding: &ToolBinding,
        context: &ToolExecutionContext,
        release: bool,
        authorize_only: bool,
        cancel: &CancellationToken,
    ) -> Result<Value, ExecutionError> {
        if binding.source_mode != SourceMode::FixedBranch || binding.file_source.is_none() {
            return Err(ExecutionError::new(
                "collaboration_source",
                "dispatch requires an admitted fixed source",
            ));
        }
        self.call(
            binding,
            context,
            ResourceOperation::CollaborationPin {
                release,
                pin_id: format!("child-pin:{}", context.operation_id),
            },
            authorize_only,
            cancel,
        )
        .map_err(|failure| ExecutionError::new("collaboration_source", failure.error.to_string()))
    }
    pub(crate) fn remote_operation_receipt(
        &self,
        id: &str,
        phase: &str,
    ) -> Result<Option<Value>, KernelError> {
        let Some(catalog) = &self.journal_catalog else {
            return Ok(None);
        };
        let read = {
            let db = catalog
                .lock()
                .map_err(|_| KernelError::Storage("Catalog unavailable".into()))?;
            let operation = db
                .operation(id)
                .map_err(|e| KernelError::Operation(e.to_string()))?;
            let Some(source) = db
                .launch_metadata(&operation.run_id)
                .map_err(|e| KernelError::Operation(e.to_string()))?
                .and_then(|l| l.selection.source)
            else {
                return Ok(None);
            };
            if source.resource_owner.is_local() {
                return Ok(None);
            }
            let run = db
                .run(&operation.run_id)
                .map_err(|e| KernelError::Operation(e.to_string()))?;
            (
                db.capture_operation_read(operation),
                source,
                run.thread_id,
                run.cancel_requested,
            )
        };
        let operation = read
            .0
            .load()
            .map_err(|e| KernelError::Operation(e.to_string()))?;
        if operation.managed_process.as_ref().is_some_and(|process| process.is_environment()) {
            if !matches!(phase, "observe" | "cancel") {
                return Err(KernelError::Authorization("Script environment release requires its original callback drain".into()));
            }
            // The evaluator lives at B, while A's extension invocation remains the
            // executor. Never reinterpret A's executor identity as a B Source lease.
            let receipt = self.source_query(json!({"kind":"script_control","source":read.1,
                "runId":operation.run_id,"threadId":read.2,"processId":id,"stop":phase == "cancel"}),
                &CancellationToken::default()).map_err(|e| KernelError::Operation(e.to_string()))?;
            if receipt["processId"] != id || receipt["runId"] != operation.run_id
                || receipt["threadId"] != read.2 || receipt["source"] != serde_json::to_value(&read.1)? {
                return Err(KernelError::Authorization("Original script receipt identity changed".into()));
            }
            return Ok(Some(receipt));
        }
        let Some(varin_runtime::ExecutorOwner::External { identity, epoch }) =
            &operation.execution_owner
        else {
            return Err(KernelError::Authorization(
                "Managed source process lost original executor".into(),
            ));
        };
        let prefix = format!(
            "source:{}:",
            read.1.resource_owner.host_id().unwrap_or_default()
        );
        let authority_id = identity.strip_prefix(&prefix).ok_or_else(|| {
            KernelError::Authorization("Managed process executor differs from source Host".into())
        })?;
        let watch_process = operation.executor.as_deref() == Some("process_spawn");
        let phase = if watch_process && (operation.cancel_requested || read.3) {
            "cancel"
        } else {
            phase
        };
        let invocation: varin_runtime::execution::ToolInvocation =
            serde_json::from_value(operation.intent)?;
        let fixed = read
            .1
            .branch_id
            .as_ref()
            .zip(read.1.revision)
            .map(|(branch, revision)| FixedFileSource {
                branch_id: branch.clone(),
                revision: revision as i64,
            });
        let binding = ToolBinding {
            resource_owner: read.1.resource_owner.clone(),
            remote_authority: Some(RemoteResourceAuthority {
                authority_id: authority_id.into(),
                resource_epoch: epoch.clone(),
                execution_owner: operation.execution_owner.clone().unwrap(),
            }),
            target_authority: None,
            grant_id: authority_id.into(),
            run_id: operation.run_id.clone(),
            thread_id: read.2,
            workspace_id: read.1.workspace_id,
            execution_workspace_id: read.1.execution_workspace_id,
            root_id: read.1.live_root.as_ref().map(|r| r.root_id.clone()),
            file_source: if read.1.mode == SourceMode::FixedBranch {
                fixed.clone()
            } else {
                None
            },
            source_mode: read.1.mode,
            materialized_source: if read.1.mode == SourceMode::Materialized {
                fixed
            } else {
                None
            },
            live_root: read.1.live_root,
            environment_run_id: read.1.environment_run_id,
            enabled_tools: BTreeSet::new(),
        };
        let context = ToolExecutionContext {
            run_id: operation.run_id,
            operation_id: id.into(),
            origin: invocation.origin,
        };
        let receipt=self.source_query(json!({"kind":"control","phase":phase,"binding":binding,"context":context,"watchProcess":watch_process}),&CancellationToken::default()).map_err(|e|KernelError::Operation(e.to_string()))?;
        if receipt["operationId"] != id
            || receipt["resourceEpoch"] != *epoch
            || receipt["executionOwner"]
                != serde_json::to_value(
                    &binding.remote_authority.as_ref().unwrap().execution_owner,
                )?
        {
            return Err(KernelError::Authorization(
                "Original managed receipt identity changed".into(),
            ));
        }
        Ok(Some(receipt))
    }
    /// Original staged-package delivery proves compilation has stopped. Only the
    /// saved Source/Operation is released; no package code or stage call is replayed.
    pub(crate) fn release_delivered_package_source(&self, id: &str) -> Result<(), KernelError> {
        let Some(catalog) = &self.journal_catalog else {
            return Ok(());
        };
        let original = {
            let db = catalog.lock().map_err(|_| KernelError::Storage("Catalog owner unavailable".into()))?;
            let operation = db.operation(id).map_err(|e| KernelError::Operation(e.to_string()))?;
            if operation.executor.as_deref() != Some("extension_package")
                || !db.external_delivery_persisted(id).map_err(|e| KernelError::Operation(e.to_string()))?
            {
                return Ok(());
            }
            let Some(source) = db.launch_metadata(&operation.run_id)
                .map_err(|e| KernelError::Operation(e.to_string()))?
                .and_then(|launch| launch.selection.source) else { return Ok(()); };
            if source.resource_owner.is_local() { return Ok(()); }
            let run = db.run(&operation.run_id).map_err(|e| KernelError::Operation(e.to_string()))?;
            (db.capture_operation_read(operation), source, run.thread_id)
        };
        // Hydration and all remote work stay outside the Catalog lock.
        let operation = original.0.load().map_err(|e| KernelError::Operation(e.to_string()))?;
        let invocation: varin_runtime::execution::ToolInvocation = serde_json::from_value(operation.intent)?;
        if invocation.call.name != "extension_package" || invocation.call.arguments["action"] != "stage" {
            return Ok(());
        }
        let receipt = self.source_query(json!({"kind":"package_cleanup", "operationId":id,
            "runId":operation.run_id, "threadId":original.2, "source":original.1}), &CancellationToken::default())
            .map_err(|e| KernelError::Operation(e.to_string()))?;
        if receipt["operationId"] != id || receipt["released"] != true {
            return Err(KernelError::Authorization("Original package cleanup receipt changed".into()));
        }
        Ok(())
    }
    pub(crate) fn schedule_package_source_release(&self, id: String) {
        let resources = self.clone();
        let _ = std::thread::Builder::new().name("package-source-delivery".into()).spawn(move || {
            if let Err(error) = resources.release_delivered_package_source(&id) {
                eprintln!("Original package source cleanup remains pending: {error}");
            }
        });
    }
    /// Drop only B's original schedule body after A durably owns its known, stopped
    /// result. The original invocation remains the sole dispatch/cleanup identity.
    pub(crate) fn release_delivered_schedule_receipt(&self, id: &str) -> Result<(), KernelError> {
        let Some(catalog) = &self.journal_catalog else { return Ok(()); };
        let original = {
            let db = catalog.lock().map_err(|_| KernelError::Storage("Catalog owner unavailable".into()))?;
            let operation = db.operation(id).map_err(|e| KernelError::Operation(e.to_string()))?;
            if operation.executor.as_deref() != Some("scheduled_task")
                || !db.external_delivery_persisted(id).map_err(|e| KernelError::Operation(e.to_string()))? {
                return Ok(());
            }
            let Some(source) = db.launch_metadata(&operation.run_id).map_err(|e| KernelError::Operation(e.to_string()))?
                .and_then(|launch| launch.selection.source) else { return Ok(()); };
            if source.resource_owner.is_local() { return Ok(()); }
            let run = db.run(&operation.run_id).map_err(|e| KernelError::Operation(e.to_string()))?;
            (db.capture_operation_read(operation), source, run.thread_id)
        };
        let operation = original.0.load().map_err(|e| KernelError::Operation(e.to_string()))?;
        crate::schedule_reconciliation::invocation(&operation)?;
        let receipt = self.source_query(json!({"kind":"schedule_receipt","phase":"release","operationId":id,
            "runId":operation.run_id,"threadId":original.2,"source":original.1}), &CancellationToken::default())
            .map_err(|e| KernelError::Operation(e.to_string()))?;
        if receipt["operationId"] != id || receipt["released"] != true {
            return Err(KernelError::Authorization("Original schedule cleanup receipt changed".into()));
        }
        Ok(())
    }
    pub(crate) fn schedule_project_receipt_release(&self, id: String) {
        let resources = self.clone();
        let _ = std::thread::Builder::new().name("schedule-receipt-delivery".into()).spawn(move || {
            if let Err(error) = resources.release_delivered_schedule_receipt(&id) {
                eprintln!("Original schedule receipt cleanup remains pending: {error}");
            }
        });
    }
    pub(crate) fn release_delivered_read_receipt(&self, id: &str) -> Result<(), KernelError> {
        let Some(catalog) = &self.journal_catalog else {
            return Ok(());
        };
        {
            let db = catalog
                .lock()
                .map_err(|_| KernelError::Storage("Catalog owner unavailable".into()))?;
            if !crate::reconcile::is_managed_read(
                &db.operation(id)
                    .map_err(|e| KernelError::Operation(e.to_string()))?,
            ) || !db
                .external_delivery_persisted(id)
                .map_err(|e| KernelError::Operation(e.to_string()))?
            {
                return Ok(());
            }
        }
        if let Some(receipt) = self.remote_operation_receipt(id, "release")? {
            if receipt["released"] != true {
                return Err(KernelError::Operation(
                    "Original read receipt is not ready for release".into(),
                ));
            }
        }
        Ok(())
    }
    pub(crate) fn schedule_read_receipt_release(&self, id: String) {
        let resources = self.clone();
        let _ = std::thread::Builder::new()
            .name("source-read-delivery".into())
            .spawn(move || {
                if let Err(error) = resources.release_delivered_read_receipt(&id) {
                    eprintln!("Original source read delivery cleanup remains pending: {error}");
                }
            });
    }
    pub(crate) fn replay_source_delivery_releases(&self) -> Result<(), KernelError> {
        let Some(catalog) = &self.journal_catalog else {
            return Ok(());
        };
        let delivered = catalog
            .lock()
            .map_err(|_| KernelError::Storage("Catalog owner unavailable".into()))?
            .delivered_external_operations()
            .map_err(|e| KernelError::Operation(e.to_string()))?;
        let resources = self.clone();
        std::thread::Builder::new()
            .name("source-delivery-replay".into())
            .spawn(move || {
                for operation in delivered {
                    if operation.executor.as_deref() == Some("extension_package") {
                        if let Err(error) = resources.release_delivered_package_source(&operation.id) {
                            eprintln!("Original package source cleanup remains pending: {error}");
                        }
                    } else if operation.executor.as_deref() == Some("scheduled_task") {
                        if let Err(error) = resources.release_delivered_schedule_receipt(&operation.id) {
                            eprintln!("Original schedule receipt cleanup remains pending: {error}");
                        }
                    } else if crate::reconcile::is_managed_read(&operation) {
                        if let Err(error) = resources.release_delivered_read_receipt(&operation.id)
                        {
                            eprintln!(
                                "Original source read delivery cleanup remains pending: {error}"
                            );
                        }
                    }
                }
            })
            .map_err(|e| KernelError::Operation(e.to_string()))?;
        Ok(())
    }
    pub(crate) fn replay_process_terminals(
        &self,
        process_ids: Vec<String>,
    ) -> Result<(), KernelError> {
        let mut local = Vec::new();
        for id in process_ids {
            match self.remote_operation_receipt(&id, "observe") {
                Ok(Some(_)) => (),
                Ok(None) => local.push(id),
                Err(error) => {
                    eprintln!("Original managed process remains unresolved: {error}");
                }
            }
        }
        (self.replay)(local)
    }
    /// Notification delivery must not await a target Host. Deduplicate only live
    /// stop attempts; original pending Operations remain Catalog's recovery facts.
    pub(crate) fn request_environment_stop(&self, operation_id: String, run_id: String) -> Result<(), KernelError> {
        if !self.environment_stops.lock().map_err(|_| KernelError::Storage("Environment stop owner failed".into()))?.insert(operation_id.clone()) {
            return Ok(());
        }
        let resources = self.clone();
        let id = operation_id.clone();
        if let Err(error) = std::thread::Builder::new().name("script-stop".into()).spawn(move || {
            let _ = resources.cancel_known_process(&id).and_then(|known| {
                if known { Ok(true) } else { resources.cancel_process(&id, &run_id) }
            });
            // Transport failure is not a terminal receipt. A later original owner
            // wake can retry after this attempt, without blocking unrelated Runs.
            if let Ok(mut active) = resources.environment_stops.lock() { active.remove(&id); }
        }) {
            if let Ok(mut active) = self.environment_stops.lock() { active.remove(&operation_id); }
            return Err(error.into());
        }
        Ok(())
    }
    pub(crate) fn cancel_known_process(&self, operation_id: &str) -> Result<bool, KernelError> {
        self.controls.cancel_known_process(operation_id)
    }
    pub(crate) fn cancel_process(
        &self,
        operation_id: &str,
        run_id: &str,
    ) -> Result<bool, KernelError> {
        if let Some(receipt) = self.remote_operation_receipt(operation_id, "cancel")? {
            return Ok(receipt["accepted"] == true);
        }
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
        self.call_checked(
            binding,
            context,
            operation,
            authorize_only,
            None,
            None,
            cancellation,
        )
    }
    fn call_checked(
        &self,
        binding: &ToolBinding,
        context: &ToolExecutionContext,
        operation: ResourceOperation,
        authorize_only: bool,
        expected_resource_key: Option<String>,
        invocation_call_id: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<Value, ResourceFailure> {
        if cancellation.is_cancelled() {
            return Err(ResourceFailure {
                error: KernelError::Cancelled,
                dispatched: false,
            });
        }
        if binding.remote_authority.is_some() {
            let action = operation.source_action().map_err(|error| ResourceFailure {
                error,
                dispatched: false,
            })?;
            return self.source_query(json!({"kind":"resource","binding":binding,"context":context,"action":action,"authorizeOnly":authorize_only}),cancellation)
                .map_err(|error|ResourceFailure{error:KernelError::Operation(error.to_string()),dispatched:!authorize_only});
        }
        let (reply, result) = mpsc::channel();
        let wake = authorize_only.then(|| mpsc::sync_channel(1));
        let _cancel_wait = wake
            .as_ref()
            .map(|(sender, _)| cancellation.wake_on_cancel(sender.clone()));
        let journal = if !authorize_only
            && matches!(
                operation,
                ResourceOperation::FileMutation(_) | ResourceOperation::FileRestore(_) | ResourceOperation::RecoveryPoints(_) | ResourceOperation::ProcessSpawn(_)
            ) {
            self.source_journal
                .clone()
                .map(|value| Ok(Some(value)))
                .unwrap_or_else(|| {
                    self.journal_catalog
                        .as_ref()
                        .map(|catalog| {
                            let owner = catalog
                                .lock()
                                .map_err(|_| {
                                    KernelError::Storage("journal owner unavailable".into())
                                })?;
                            let read = match invocation_call_id {
                                Some(call_id) => owner.capture_invocation_journal(context, call_id),
                                None => owner.capture_journal_anchor(context),
                            }
                                .map_err(|error| KernelError::Operation(error.to_string()))?;
                            drop(owner);
                            read.load()
                                .map_err(|error| KernelError::Operation(error.to_string()))
                        })
                        .transpose()
                })
                .map_err(|error| ResourceFailure {
                    error,
                    dispatched: false,
                })?
        } else {
            None
        };
        (self.send)(ResourceCall {
            journal,
            admission_key: None,
            binding: binding.clone(),
            context: context.clone(),
            operation,
            authorize_only,
            expected_resource_key,
            cancellation: cancellation.clone(),
            reply: ResourceReply {
                sender: Some(reply),
                wake: wake.as_ref().map(|(sender, _)| sender.clone()),
            },
        })
        .map_err(|error| ResourceFailure {
            error,
            dispatched: false,
        })?;
        if let Some((_, changed)) = wake {
            loop {
                if cancellation.is_cancelled() {
                    return Err(ResourceFailure {
                        error: KernelError::Cancelled,
                        dispatched: false,
                    });
                }
                match result.try_recv() {
                    Ok(receipt) => return receipt,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        return Err(ResourceFailure {
                            error: KernelError::Storage(
                                "resource owner disconnected before receipt".into(),
                            ),
                            dispatched: false,
                        });
                    }
                    Err(mpsc::TryRecvError::Empty) => {}
                }
                if changed.recv().is_err() {
                    return Err(ResourceFailure {
                        error: KernelError::Storage("resource observation closed".into()),
                        dispatched: false,
                    });
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
    retrieval_owner: Option<Arc<crate::agent_runtime::control_commands::ControlCommands>>,
    search_scope: Option<Vec<String>>,

}
impl KernelToolExecutor {
    pub(crate) fn validate_source_binding(binding: &ToolBinding) -> Result<(), KernelError> {
        binding.source_selection()?;
        if [&binding.grant_id, &binding.run_id, &binding.thread_id]
            .iter()
            .any(|id| id.is_empty())
        {
            return Err(KernelError::Authorization(
                "Source tool scope is incomplete".into(),
            ));
        }
        Ok(())
    }
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
                ToolKind::FileRead
                    | ToolKind::FileList
                    | ToolKind::FileSearch
                    | ToolKind::CodeRetrieval
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
            && binding.enabled_tools.iter().any(|kind| {
                matches!(
                    kind,
                    ToolKind::FileWrite
                        | ToolKind::FileEdit
                        | ToolKind::FileRestore
                        | ToolKind::RecoveryPoints
                )
            })
        {
            return Err(ExecutionError::new(
                "invalid_tool_binding",
                "file mutation requires an explicit physical source",
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
            || binding.live_root.as_ref().is_some_and(|root| {
                root.host_id.is_empty()
                    || root.canonical_root.is_empty()
                    || Some(root.root_id.as_str()) != binding.root_id.as_deref()
            })
            || (binding.source_mode == SourceMode::LiveRoot && binding.environment_run_id.is_some())
        {
            return Err(ExecutionError::new(
                "invalid_tool_binding",
                "live source requires its exact registered environment identity",
            ));
        }
        if binding.enabled_tools.contains(&ToolKind::ProcessSpawn)
            && binding.source_mode != SourceMode::FixedBranch
            && binding.root_id.as_deref().is_none_or(str::is_empty)
        {
            return Err(ExecutionError::new(
                "invalid_tool_binding",
                "process spawn requires a registered root",
            ));
        }
        let schemas = Self::selected_schemas(&binding.enabled_tools);
        Ok(Self {
            binding,
            schemas,
            resources,
            language: None,
            retrieval_owner: None,
            search_scope: None,
        })
    }
    pub(crate) fn with_internal_retrieval(mut self, owner: Arc<crate::agent_runtime::control_commands::ControlCommands>) -> Self {
        self.retrieval_owner = Some(owner);
        self
    }
    pub(crate) fn with_search_scope(mut self,paths:Option<Vec<String>>)->Self {self.search_scope=paths;self}
    fn require_search_path(&self,path:&str)->Result<(),ExecutionError> {
        if self.search_scope.as_ref().is_some_and(|scopes| !scopes.iter().any(|scope|path==scope || path.strip_prefix(scope).is_some_and(|tail|tail.starts_with('/')))) {
            return Err(ExecutionError::new("retrieval_scope","Path is outside this retrieval invocation's requested paths"));
        }
        Ok(())
    }
    pub(crate) fn with_language(mut self, bridge: crate::language::LanguageBridge) -> Self {
        self.language = Some(bridge);
        self
    }
    pub(crate) fn declarations(
        self,
        managed_process_observation: bool,
    ) -> Vec<varin_runtime::composition::tools::ToolDeclaration> {
        let endpoint = Arc::new(self);
        endpoint
            .schemas
            .iter()
            .filter(|schema| {
                !managed_process_observation
                    || !matches!(
                        schema.name.as_str(),
                        "process_inspect" | "process_read" | "process_write" | "process_resize"
                    )
            })
            .cloned()
            .map(|schema| {
                varin_runtime::composition::tools::ToolDeclaration::new(schema, endpoint.clone())
            })
            .collect()
    }
    pub(crate) fn selected_builtin_schemas(
        enabled: &BTreeSet<ToolKind>,
    ) -> Vec<crate::run_tools::BuiltinSchema> {
        use varin_runtime::catalog::dispatch::ChildPresetDefault::{Retrieval, Worker};
        Self::selected_schemas(enabled)
            .into_iter()
            .zip(enabled)
            .map(|(schema, kind)| match kind {
                ToolKind::FileRead
                | ToolKind::FileList
                | ToolKind::FileSearch
                | ToolKind::CodeRetrieval => crate::run_tools::BuiltinSchema::child(
                    schema,
                    kind.requirements().source.into(),
                    &[Worker, Retrieval],
                ),
                ToolKind::FileWrite
                | ToolKind::FileEdit
                | ToolKind::RecoveryPoints
                | ToolKind::FileRestore => crate::run_tools::BuiltinSchema::child(
                    schema,
                    kind.requirements().source.into(),
                    &[Worker],
                ),
                ToolKind::ProcessSpawn
                | ToolKind::ProcessInspect
                | ToolKind::ProcessRead
                | ToolKind::ProcessWrite
                | ToolKind::ProcessResize => crate::run_tools::BuiltinSchema::child(
                    schema,
                    kind.requirements().source.into(),
                    &[Worker, Retrieval],
                ),
            })
            .collect()
    }
    pub(crate) fn selected_schemas(enabled_tools: &BTreeSet<ToolKind>) -> Vec<ToolSchema> {
        enabled_tools
            .iter()
            .map(|kind| ToolSchema {
                requirements: Some(kind.requirements()),
                description: kind.description().into(),
                output_schema: None,
                metadata: None,
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
        let mut operation = ResourceOperation::parse(kind, &call.arguments)?;
        if let ResourceOperation::FileQuery(args) = &mut operation {
            if let Some(scope)=&self.search_scope {args.restrict_paths(scope)?;}
            args.validate_source(&self.binding)?;
        }
        if let ResourceOperation::FileRead(args)=&operation {self.require_search_path(&args.path)?;}
        Ok(operation)
    }
    fn contract(&self, call: &ToolCall, operation: &ResourceOperation) -> ToolContract {
        if let ResourceOperation::FileReadBatch(files) = operation {
            return ToolContract { name: call.name.clone(),schema_version:call.schema_version.clone(),read_only:true,
                completion:CompletionKind::Result,lifetime:Lifetime::Run,resources:files.iter().filter_map(|value|
                    ResourceOperation::parse(ToolKind::FileRead,value).ok().filter(|op|matches!(op,ResourceOperation::FileRead(_))))
                    .flat_map(|op|self.contract(call,&op).resources).collect() };
        }
        let job = matches!(operation, ResourceOperation::ProcessSpawn(_) | ResourceOperation::RetrievalQuery(_));
        let read_only = !matches!(
            operation,
            ResourceOperation::FileMutation(_)
                | ResourceOperation::RetrievalQuery(_)
                | ResourceOperation::FileRestore(_)
                | ResourceOperation::ProcessSpawn(_)
                | ResourceOperation::ProcessWrite(_)
                | ResourceOperation::ProcessResize(_)
        );
        let key = |mut value: Value| {
            if let Some(parts) = value.as_array_mut() {
                parts.insert(1, json!(self.binding.resource_owner));
            }
            value.to_string()
        };
        let (resource, access) = match operation {
            ResourceOperation::FileReadBatch(_) | ResourceOperation::CollaborationPin { .. }
            | ResourceOperation::ChildSourceHandoff { .. }
            | ResourceOperation::ChildStorageReceipt { .. }
            | ResourceOperation::ChildRootIdle
            | ResourceOperation::ReconcileMutation { .. }
            | ResourceOperation::ReconcileFileRestore(_)
            | ResourceOperation::ComputeControl { .. }
            | ResourceOperation::ObserveCompute { .. } => {
                unreachable!("private receipt queries have no model contract")
            }
            // Discovery snapshots have their own short Storage coordination and consume fixed bytes.
            // Their long search/scan wait must not hold a directory-wide write barrier.
            ResourceOperation::RetrievalQuery(_) => (
                key(json!([
                    "retrieval-view",
                    self.binding.execution_workspace_id,
                    self.binding.root_id,
                    self.binding.file_source
                ])),
                Access::Read,
            ),
            ResourceOperation::LanguageSource(_) => (
                key(json!([
                    "language-view",
                    self.binding.execution_workspace_id,
                    self.binding.root_id
                ])),
                Access::Read,
            ),
            ResourceOperation::FileQuery(_) => (
                key(json!([
                    "discovery",
                    self.binding.execution_workspace_id,
                    self.binding.root_id,
                    self.binding.file_source
                ])),
                Access::Read,
            ),
            ResourceOperation::RecoveryPoints(_) | ResourceOperation::FileRestore(_) => (
                key(json!(["recovery-files", self.binding.execution_workspace_id, self.binding.root_id])),
                if read_only { Access::Read } else { Access::Write },
            ),
            ResourceOperation::FileMutation(mutation) => (
                key(json!(["unresolved-file", mutation.path()])),
                Access::Write,
            ),
            ResourceOperation::FileRead(args)
                if self.binding.source_mode != SourceMode::FixedBranch =>
            {
                (key(json!(["unresolved-file", args.path])), Access::Read)
            }
            ResourceOperation::FileRead(args) => {
                let source = self.binding.file_source.as_ref().expect("validated source");
                (
                    key(json!([
                        "fixed-file",
                        self.binding.workspace_id,
                        source.branch_id,
                        source.revision,
                        args.path
                    ])),
                    Access::Read,
                )
            }
            ResourceOperation::ProcessObservation { .. } => {
                unreachable!("observation is admitted by the Catalog wrapper")
            }
            ResourceOperation::ProcessWrite(args) => (
                key(json!([
                    "process-input",
                    self.binding.execution_workspace_id,
                    args.process_id
                ])),
                Access::Write,
            ),
            ResourceOperation::ProcessResize(args) => (
                key(json!([
                    "process-size",
                    self.binding.execution_workspace_id,
                    args.process_id
                ])),
                Access::Write,
            ),
            ResourceOperation::ProcessInspect(args) => (
                key(json!([
                    "process-output",
                    self.binding.execution_workspace_id,
                    args.process_id
                ])),
                Access::Read,
            ),
            ResourceOperation::ProcessRead(args) => (
                key(json!([
                    "process-output",
                    self.binding.execution_workspace_id,
                    args.process_id
                ])),
                Access::Read,
            ),
            // Arbitrary programs have unknown write sets. Record shared writer activity, never
            // pretend that an environment-wide mutex isolates their filesystem side effects.
            ResourceOperation::ProcessSpawn(_) => (
                key(json!([
                    "environment-writer-activity",
                    self.binding.execution_workspace_id,
                    self.binding.root_id
                ])),
                Access::Read,
            ),
        };
        ToolContract {
            name: call.name.clone(),
            schema_version: "1".into(),
            read_only,
            completion: if job {
                CompletionKind::Job
            } else {
                CompletionKind::Result
            },
            lifetime: if job { Lifetime::Thread } else { Lifetime::Run },
            resources: vec![ResourceClaim {
                key: resource,
                access,
            }],
        }
    }
    pub(crate) fn process_observation_contract(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
    ) -> Result<ToolContract, ExecutionError> {
        let operation = self.operation(Some(context), call)?;
        if !matches!(
            operation,
            ResourceOperation::ProcessInspect(_)
                | ResourceOperation::ProcessRead(_)
                | ResourceOperation::ProcessWrite(_)
                | ResourceOperation::ProcessResize(_)
        ) {
            return Err(ExecutionError::new(
                "process_observation",
                "not a read-only process observation",
            ));
        }
        Ok(self.contract(call, &operation))
    }
    fn physical_file(&self, operation: &ResourceOperation) -> bool {
        matches!(operation, ResourceOperation::FileMutation(_) | ResourceOperation::FileRead(_) | ResourceOperation::FileReadBatch(_))
    }
    fn planned_contract(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        operation: &ResourceOperation,
        cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        if self.binding.remote_authority.is_some()
            && !operation.coordinator_owned()
        {
            return self
                .remote_tool("authorize", context, call, cancel)
                .and_then(|value| {
                    serde_json::from_value(value)
                        .map_err(|e| ExecutionError::new("source_contract", e.to_string()))
                });
        }
        let mut contract = self.contract(call, operation);
        if let ResourceOperation::FileReadBatch(files) = operation {
            contract.resources.clear();
            for value in files {
                let Ok(op @ ResourceOperation::FileRead(_)) = ResourceOperation::parse(ToolKind::FileRead,value) else { continue };
                if let Ok(plan) = self.planned_contract(context,call,&op,cancel) {
                    for claim in plan.resources { if !contract.resources.contains(&claim) {contract.resources.push(claim);} }
                }
            }
            return Ok(contract);
        }
        if self.physical_file(operation) {
            let plan = self
                .resources
                .call(&self.binding, context, operation.clone(), true, cancel)
                .map_err(|failure| {
                    ExecutionError::new(error_code(&failure.error), failure.error.to_string())
                })?;
            contract.resources[0].key = plan
                .get("resourceKey")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ExecutionError::new(
                        "invalid_resource_plan",
                        "file owner omitted its canonical resource identity",
                    )
                })?
                .into();
        }
        Ok(contract)
    }
    fn frozen_operation(
        &self,
        call: &ToolCall,
        request: &FrozenToolContext,
    ) -> Result<ResourceOperation, ExecutionError> {
        if request.run_id != self.binding.run_id {
            return Err(ExecutionError::new(
                "unauthorized",
                "request Run does not match tool binding",
            ));
        }
        let operation = self.operation(None, call)?;
        let expected = self
            .schemas
            .iter()
            .find(|schema| schema.name == call.name)
            .expect("selected tool");
        if !request.tools.iter().any(|schema| schema == expected) {
            return Err(ExecutionError::new(
                "stale_tool_schema",
                "tool does not match the frozen request schema",
            ));
        }
        Ok(operation)
    }
}
impl ToolExecutor for KernelToolExecutor {
    fn executor_owner(&self) -> varin_runtime::ExecutorOwner {
        self.binding
            .remote_authority
            .as_ref()
            .map(|a| a.execution_owner.clone())
            .unwrap_or(varin_runtime::ExecutorOwner::Kernel)
    }
    fn bind_call(
        self: Arc<Self>,
        call: &ToolCall,
        request: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<Box<dyn PreparedToolCall>, ExecutionError> {
        let operation = self.frozen_operation(call, request)?;
        Ok(Box::new(KernelCall {
            executor: self,
            call: call.clone(),
            request: request.clone(),
            operation,
        }))
    }
    fn plan(
        &self,
        call: &ToolCall,
        request: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        let operation = self.frozen_operation(call, request)?;
        Ok(self.plan_operation(call, &operation))
    }
    fn watch_admission(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<Option<varin_runtime::execution_capacity::AdmissionControlGuard>, ExecutionError>
    {
        self.resources
            .admission_control
            .as_ref()
            .map(|watch| watch(&self.binding, cancel))
            .transpose()
    }
    fn execution_class(
        &self,
        call: &ToolCall,
        _: &ToolContract,
    ) -> varin_runtime::execution_capacity::ExecutionClass {
        use varin_runtime::execution_capacity::ExecutionClass;
        if call.name == "file_search" {
            ExecutionClass::LocalCompute
        } else {
            ExecutionClass::Unmetered
        }
    }
    fn supports_policy_read(
        &self,
        context: &FrozenToolContext,
        call: &ToolCall,
        contract: &ToolContract,
    ) -> bool {
        self.operation(None, call)
            .is_ok_and(|operation| self.policy_read(context, &operation, contract))
    }
    fn prepare(
        &self,
        call: &ToolCall,
        request: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        let operation = self.frozen_operation(call, request)?;
        self.planned_contract(
            &execution_context(&self.binding.run_id, call, &request.origin),
            call,
            &operation,
            cancel,
        )
    }
    fn authorize(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        let operation = self.operation(Some(context), call)?;
        self.authorize_operation(context, call, &operation, contract, cancel)
    }
    fn execute(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        match self.operation(Some(context), call) {
            Ok(operation) => self.execute_operation(context, call, operation, contract, cancel),
            Err(error) => ToolCompletion::NotDispatched {
                reason: error.to_string(),
            },
        }
    }
}
impl KernelToolExecutor {
    pub(crate) fn remote_tool(
        &self,
        phase: &str,
        context: &ToolExecutionContext,
        call: &ToolCall,
        cancel: &CancellationToken,
    ) -> Result<Value, ExecutionError> {
        let journal = if phase == "execute"
            && matches!(
                call.name.as_str(),
                "file_write" | "file_edit" | "file_restore" | "recovery_points" | "process_spawn"
            ) {
            self.resources
                .journal_catalog
                .as_ref()
                .map(|catalog| {
                    catalog
                        .lock()
                        .map_err(|_| {
                            ExecutionError::new("source_journal", "Journal owner unavailable")
                        })?
                        .capture_invocation_journal(context, &call.call_id)
                        .and_then(|r| r.load())
                        .map_err(|e| ExecutionError::new("source_journal", e.to_string()))
                })
                .transpose()?
        } else {
            None
        };
        self.resources.source_query(json!({"kind":"tool","phase":phase,"binding":self.binding,"context":context,"call":call,"journal":journal}),cancel)
    }
    fn plan_operation(&self, call: &ToolCall, operation: &ResourceOperation) -> ToolPreparation {
        if self.physical_file(&operation) {
            // Storage canonicalizes parents, junctions and root aliases. Until it resolves the
            // target, only the canonical physical-file namespace is known. A workspace/root ID
            // would incorrectly separate two aliases of the same file. Static resource owners
            // (process output, language, discovery, fixed views) can still bypass this intent.
            let access = if matches!(operation, ResourceOperation::FileMutation(_)) {
                Access::Write
            } else {
                Access::Read
            };
            ToolPreparation::Resolve {
                resources: vec![ResourceIntent::Prefix {
                    key_prefix: "[\"file\",".into(),
                    access,
                }],
                class: varin_runtime::execution_capacity::ExecutionClass::Unmetered,
            }
        } else {
            ToolPreparation::Ready(self.contract(call, operation))
        }
    }

    fn policy_read(
        &self,
        context: &FrozenToolContext,
        operation: &ResourceOperation,
        contract: &ToolContract,
    ) -> bool {
        if self.binding.remote_authority.is_some() {
            return false;
        }
        // Eligibility is this trusted adapter's promise, never extension/MCP metadata.
        let Some(source) = &context.source else {
            return false;
        };
        let Some(bound) = &self.binding.file_source else {
            return false;
        };
        context.run_id == self.binding.run_id
            && self.binding.source_mode == SourceMode::FixedBranch
            && !self.binding.enabled_tools.contains(&ToolKind::ProcessSpawn)
            && source.mode == SourceMode::FixedBranch
            && source.live_root.is_none()
            && source.workspace_id == self.binding.workspace_id
            && source.execution_workspace_id == self.binding.execution_workspace_id
            && source.environment_run_id == self.binding.environment_run_id
            && source.branch_id.as_deref() == Some(bound.branch_id.as_str())
            && source.revision == u64::try_from(bound.revision).ok()
            && matches!(
                operation,
                ResourceOperation::FileRead(_)
                    | ResourceOperation::FileQuery(_)
                    | ResourceOperation::RetrievalQuery(_)
                    | ResourceOperation::LanguageSource(_)
            )
            && contract.read_only
            && contract.completion == CompletionKind::Result
    }
    fn authorize_operation(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        operation: &ResourceOperation,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        if let ResourceOperation::FileRead(args)=operation {self.require_search_path(&args.path)?;}
        if context.run_id != self.binding.run_id || context.operation_id.is_empty() {
            return Err(ExecutionError::new(
                "unauthorized",
                "tool execution identity does not match bound Run",
            ));
        }
        if matches!(operation,ResourceOperation::FileReadBatch(_)) {
            if &self.planned_contract(context,call,operation,cancel)? != contract {
                return Err(ExecutionError::new("read_scope_changed","Batch read resource scope changed; retry the original request"));
            }
            return Ok(());
        }
        if self.binding.remote_authority.is_some()
            && !operation.coordinator_owned()
        {
            return if &self.planned_contract(context, call, operation, cancel)? == contract {
                Ok(())
            } else {
                Err(ExecutionError::new(
                    "source_contract",
                    "Managed resource contract changed",
                ))
            };
        }
        if let ResourceOperation::RetrievalQuery(args) = &operation {
            if &self.contract(call, &operation) != contract {
                return Err(ExecutionError::new(
                    "stale_tool_contract",
                    "retrieval contract changed",
                ));
            }
            return self.admit_retrieval(context, args, cancel).map(|_| ());
        }
        if &self.planned_contract(context, call, &operation, cancel)? != contract {
            return Err(ExecutionError::new(
                "stale_tool_contract",
                "tool contract changed",
            ));
        }
        if self.physical_file(&operation) {
            return Ok(());
        }
        self.resources
            .call(&self.binding, context, operation.clone(), true, cancel)
            .map(|_| ())
            .map_err(|failure| {
                ExecutionError::new(error_code(&failure.error), failure.error.to_string())
            })
    }
    fn execute_operation(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        operation: ResourceOperation,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        if let ResourceOperation::FileReadBatch(files) = &operation {
            return self.execute_read_batch(context,call,files,contract,cancel);
        }
        let mut expected = self.contract(call, &operation);
        if self.physical_file(&operation) {
            expected.resources = contract.resources.clone();
        }
        if &expected != contract {
            return ToolCompletion::NotDispatched {
                reason: "tool contract changed".into(),
            };
        }
        if let ResourceOperation::RetrievalQuery(args) = &operation {
            return self.execute_retrieval(context, call, args, cancel);
        }
        if let ResourceOperation::FileRead(args)=&operation {
            if args.unit.is_some() {return self.execute_unit_read(context,call,args,contract,cancel);}
        }
        if matches!(
            operation,
            ResourceOperation::ProcessWrite(_) | ResourceOperation::ProcessResize(_)
        ) {
            return ToolCompletion::NotDispatched {
                reason: "process interaction requires Catalog ownership validation".into(),
            };
        }
        let spawn_args = if let ResourceOperation::ProcessSpawn(args) = &operation { Some(args.clone()) } else { None };
        let output_options = if let ResourceOperation::ProcessRead(args) = &operation { Some((args.mode.clone(),args.encoding.clone())) } else { None };
        let spawn = spawn_args.is_some();
        let read = matches!(operation, ResourceOperation::FileRead(_));
        let mutation = matches!(operation, ResourceOperation::FileMutation(_));
        let restore = matches!(operation, ResourceOperation::FileRestore(_));
        let result = if let ResourceOperation::FileQuery(args) = &operation {
            self.resources.query(&self.binding, context, args, cancel)
        } else {
            let expected_key = if self.physical_file(&operation) {
                contract.resources.first().map(|claim| claim.key.clone())
            } else {
                None
            };
            self.resources.call_checked(
                &self.binding,
                context,
                operation,
                false,
                expected_key,
                Some(&call.call_id),
                cancel,
            )
        };
        match result {
            Ok(mut result) if spawn => {
                if let Some(args) = &spawn_args {
                    if result["processId"].as_str() == Some(&context.operation_id) && !matches!(result["status"].as_str(),Some("unknown"|"failed")) {
                        let (sender, receiver) = mpsc::sync_channel(1);
                        let _cancel = cancel.wake_on_cancel(sender.clone());
                        let observation = self.resources.controls.observe_end(&context.operation_id,&context.run_id,sender);
                        if args.wait_ms > 0 && observation.as_ref().is_ok_and(Option::is_some) {
                            let _ = receiver.recv_timeout(std::time::Duration::from_millis(args.wait_ms));
                        }
                        match self.resources.observe_process(&self.binding,context,&context.operation_id,&context.run_id,None,
                            Some((0,args.max_output_bytes)),false,&CancellationToken::default()) {
                            Ok(mut output) => {
                                crate::process::text::project(&mut output, &crate::process::text::Mode::Text, args.output_encoding.as_deref());
                                if let Some(current) = output["process"].as_object() {
                                    result.as_object_mut().expect("process record").extend(current.clone());
                                }
                                result["observation"] = output;
                            },
                            Err(error) => { result["observationError"] = json!({"code":error.code,"message":error.message}); },
                        }
                        result["command"] = json!(args.command);
                        result["args"] = json!(args.args);
                    }
                }
                let phase = result.get("status").and_then(Value::as_str);
                if result.get("processId").and_then(Value::as_str)
                    != Some(context.operation_id.as_str())
                    || phase.is_none()
                    || matches!(phase, Some("unknown" | "failed"))
                {
                    ToolCompletion::Result {
                        outcome: Outcome::Indeterminate,
                        effect: Effect::Unknown,
                        content: result.into(),
                    }
                } else {
                    ToolCompletion::JobAccepted {
                        operation_id: context.operation_id.clone(),
                        phase: phase.expect("checked process receipt").into(),
                        effect: Effect::Dispatched,
                        lifetime: Lifetime::Thread,
                        content: Some(result.into()),
                    }
                }
            }
            Ok(mut result) if read && result["state"]["kind"] == "directory" => {
                result["error"] = json!("not_a_file");
                result["message"] = json!("The path is a directory; use file_list to read its entries.");
                ToolCompletion::Result { outcome: Outcome::Failed, effect: Effect::None, content: result.into() }
            }
            // The conditional resource owner proved the target was untouched.
            // Use the explicit no-dispatch receipt; generic mutating Result(None)
            // is deliberately normalized to unknown by the runtime.
            Ok(result) if mutation && result["status"] == "conflict" => {
                ToolCompletion::NotDispatched {
                    reason: "File version conflict; read the current file to obtain its readVersion before retrying.".into(),
                }
            }
            Ok(result) if restore && result["status"] == "failed" => ToolCompletion::NotDispatched { reason: result.to_string() },
            Ok(result) if restore => ToolCompletion::Result {
                outcome: if result["status"] == "pending" { Outcome::Indeterminate } else if result["status"] == "applied" { Outcome::Succeeded } else { Outcome::Failed },
                effect: if result["status"] == "pending" { Effect::Unknown } else if result["appliedPaths"].as_array().is_some_and(|v| !v.is_empty()) {
                    if result["status"] == "applied" { Effect::Confirmed } else { Effect::Partial }
                } else { Effect::Confirmed },
                content: result.into(),
            },
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
                content: result.into(),
            },
            Ok(mut result) => { if let Some((mode,encoding)) = output_options { crate::process::text::project(&mut result, &mode, encoding.as_deref()); } ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                effect: Effect::None,
                content: result.into(),
            } },
            Err(failure) if !failure.dispatched => ToolCompletion::NotDispatched {
                reason: failure.error.to_string(),
            },
            Err(failure) => ToolCompletion::Result {
                outcome: if spawn || mutation || restore {
                    Outcome::Indeterminate
                } else if matches!(&failure.error, KernelError::Cancelled) {
                    Outcome::Cancelled
                } else {
                    Outcome::Failed
                },
                effect: if spawn || mutation || restore {
                    Effect::Unknown
                } else {
                    Effect::None
                },
                content:
                    json!({"error":error_code(&failure.error),"message":failure.error.to_string()})
                        .into(),
            },
        }
    }
}

struct KernelCall {
    executor: Arc<KernelToolExecutor>,
    call: ToolCall,
    request: FrozenToolContext,
    operation: ResourceOperation,
}
fn execution_context(run_id: &str, call: &ToolCall, origin: &ToolOrigin) -> ToolExecutionContext {
    ToolExecutionContext {
        run_id: run_id.into(),
        origin: origin.clone(),
        operation_id: origin.operation_id(&call.call_id),
    }
}
impl PreparedToolCall for KernelCall {
    fn receipt_persisted(&self, context: &ToolExecutionContext) {
        if self.executor.binding.remote_authority.is_some()
            && !self.operation.coordinator_owned()
            && managed_read_receipt_tool(&self.call.name)
        {
            self.executor
                .resources
                .schedule_read_receipt_release(context.operation_id.clone());
        }
    }

    fn executor_owner(&self) -> varin_runtime::ExecutorOwner {
        if self.operation.coordinator_owned() {
            varin_runtime::ExecutorOwner::Kernel
        } else {
            self.executor
                .binding
                .remote_authority
                .as_ref()
                .map(|a| a.execution_owner.clone())
                .unwrap_or(varin_runtime::ExecutorOwner::Kernel)
        }
    }
    fn managed_process(
        &self,
    ) -> Option<varin_runtime::catalog::managed_process::ManagedProcessKind> {
        matches!(self.operation, ResourceOperation::ProcessSpawn(_))
            .then_some(varin_runtime::catalog::managed_process::ManagedProcessKind::ProcessJob)
    }
    fn plan(&self, _: &CancellationToken) -> Result<ToolPreparation, ExecutionError> {
        Ok(self.executor.plan_operation(&self.call, &self.operation))
    }
    fn prepare(&self, cancel: &CancellationToken) -> Result<ToolContract, ExecutionError> {
        self.executor.planned_contract(
            &execution_context(&self.request.run_id, &self.call, &self.request.origin),
            &self.call,
            &self.operation,
            cancel,
        )
    }
    fn execution_class(
        &self,
        contract: &ToolContract,
    ) -> varin_runtime::execution_capacity::ExecutionClass {
        self.executor.execution_class(&self.call, contract)
    }
    fn watch_admission(
        &self,
        context: &ToolExecutionContext,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<Option<varin_runtime::execution_capacity::AdmissionControlGuard>, ExecutionError>
    {
        self.executor
            .watch_admission(context, &self.call, contract, cancel)
    }
    fn supports_policy_read(&self, contract: &ToolContract) -> bool {
        self.executor
            .policy_read(&self.request, &self.operation, contract)
    }
    fn authorize(
        &self,
        context: &ToolExecutionContext,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        if matches!(self.operation,ResourceOperation::RetrievalQuery(_))
            && self.request.source.as_ref()!=Some(&self.executor.binding.source_selection().map_err(|error|ExecutionError::new("source_changed",error.to_string()))?) {
            return Err(ExecutionError::new("source_changed","Retrieval source differs from the original frozen request"));
        }
        self.executor
            .authorize_operation(context, &self.call, &self.operation, contract, cancel)
    }
    fn execute(
        &self,
        context: &ToolExecutionContext,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> varin_runtime::execution::ToolExecutionReceipt {
        if self.executor.binding.remote_authority.is_some()
            && !self.operation.coordinator_owned()
        {
            return self
                .executor
                .remote_tool("execute", context, &self.call, cancel)
                .and_then(|value| {
                    serde_json::from_value(value["result"].clone())
                        .map_err(|e| ExecutionError::new("source_receipt", e.to_string()))
                })
                .unwrap_or_else(|error| varin_runtime::execution::ToolExecutionReceipt {
                    completion: ToolCompletion::Result {
                        outcome: Outcome::Indeterminate,
                        effect: if contract.read_only {
                            Effect::None
                        } else {
                            Effect::Unknown
                        },
                        content: json!({"error":"source_unavailable","message":error.to_string()})
                            .into(),
                    },
                    executor_stopped: false,
                });
        }
        let mut receipt=varin_runtime::execution::ToolExecutionReceipt::local(
            self.executor.execute_operation(
                context,
                &self.call,
                self.operation.clone(),
                contract,
                cancel,
            ),
            contract,
        );
        if matches!(self.operation,ResourceOperation::RetrievalQuery(_)) {
            if let Some(owner)=&self.executor.retrieval_owner {
                if let Ok(catalog)=owner.runtime.catalog().lock() {
                    if let Ok(operation)=catalog.operation(&context.operation_id) {
                        receipt.executor_stopped|=operation.external_receipt.as_ref().is_some_and(|receipt|receipt.executor_stopped);
                    }
                }
            }
        }
        receipt
    }
}

fn tool_schema(kind: ToolKind) -> Value {
    let (properties, required) = match kind {
        ToolKind::CodeRetrieval => return retrieval::schema(),
        ToolKind::FileList | ToolKind::FileSearch => {
            return discovery::schema(kind == ToolKind::FileSearch);
        }
        ToolKind::RecoveryPoints => (
            json!({"point":{"type":"string"},"operation":{"type":"string","description":"Inspect an original file restore operation."},"paths":{"type":"array","items":{"type":"string"}},"cursor":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1}}), vec![],
        ),
        ToolKind::FileRestore => (
            json!({"point":{"type":"string","description":"Recovery point reference, or current:before."},"undo":{"type":"string","description":"Operation ID of the restore to undo."},"paths":{"type":"array","items":{"type":"string"}},"overwritePaths":{"type":"array","items":{"type":"string"},"description":"Restore these files even if their current content differs from the recorded changes."}}), vec![],
        ),
        ToolKind::FileWrite => (
            json!({"path":{"type":"string"},"readVersion":{"type":"string","minLength":1,"description":"Observed file-state version, including a missing state. Writes require that state to be unchanged. Omit for creation only; existing files require their readVersion."},"content":{"type":"string"},
                "mode":{"type":"string","enum":["create","replace"],"description":"create requires an absent target; replace requires an existing file and readVersion. Omit to write against the observed state (or create when no version is supplied)."}}),
            vec!["path", "content"],
        ),
        ToolKind::FileEdit => (
            json!({"path":{"type":"string"},"readVersion":{"type":"string","minLength":1},"edits":{"type":"array","minItems":1,"items":{"type":"object","additionalProperties":false,"properties":{"oldText":{"type":"string","minLength":1},"newText":{"type":"string"}},"required":["oldText","newText"]}}}),
            vec!["path", "readVersion", "edits"],
        ),
        ToolKind::FileRead => return read::schema(),
        ToolKind::ProcessInspect => (json!({"processId":{"type":"string"}}), vec!["processId"]),
        ToolKind::ProcessRead => (
            json!({"processId":{"type":"string"},"cursor":{"type":"integer","minimum":0},"maxBytes":{"type":"integer","minimum":1},
                "mode":{"type":"string","enum":["text","raw"],"default":"text","description":"text decodes readable output and removes ANSI controls; raw returns exact base64 bytes. Byte cursors always refer to the original output."},
                "encoding":{"type":"string","description":"Text encoding override, such as utf-8, gbk, shift_jis or utf-16le. Auto uses BOM/UTF-8, then the actual Windows source Host's codepage hint."}}),
            vec!["processId", "cursor"],
        ),
        ToolKind::ProcessWrite => (
            json!({"processId":{"type":"string","minLength":1},"text":{"type":"string"},"eof":{"type":"boolean"}}),
            vec!["processId", "text"],
        ),
        ToolKind::ProcessResize => (
            json!({"processId":{"type":"string","minLength":1},"cols":{"type":"integer","minimum":1,"maximum":65535},"rows":{"type":"integer","minimum":1,"maximum":65535}}),
            vec!["processId", "cols", "rows"],
        ),
        ToolKind::ProcessSpawn => (
            json!({"cwd":{"type":"string","default":"","description":"Directory relative to the selected source root. Empty string or . selects the root."},"command":{"type":"string","minLength":1},"args":{"type":"array","items":{"type":"string"}},
            "shellCommand":{"type":"string","minLength":1,"description":"Shell text for pipelines, redirection or multiline commands. Runs in the actual execution Host's shell: PowerShell on Windows, /bin/sh on Unix. Mutually exclusive with command/args."},
            "waitMs":{"type":"integer","minimum":0,"maximum":9007199254740991u64,"default":0,"description":"Observe the original process until exit or this interval. Zero returns immediately. Never a kill timeout."},
            "maxOutputBytes":{"type":"integer","minimum":1,"maximum":crate::process::CHUNK_BYTES,"description":"Initial output page. Continue with process_read at observation.nextCursor."},
            "outputEncoding":{"type":"string","description":"Encoding override for the initial text output, for example gbk or utf-16le; omitted uses automatic decoding."},
            "env":{"type":"array","description":"Complete process environment. Omit to inherit this execution environment; an empty array starts with no environment variables.","items":{"type":"object","additionalProperties":false,"properties":{"name":{"type":"string"},"value":{"type":"string"}},"required":["name","value"]}},
            "mode":{"type":"string","enum":["pipe","pty"]},"cols":{"type":"integer","minimum":1,"maximum":65535},"rows":{"type":"integer","minimum":1,"maximum":65535},"windowsRawArguments":{"type":"string"}}),
            vec![],
        ),
    };
    let mut schema = json!({"type":"object","additionalProperties":false,"properties":properties,"required":required});
    if kind == ToolKind::ProcessSpawn {
        schema["oneOf"] = json!([{"required":["command"],"not":{"required":["shellCommand"]}},
            {"required":["shellCommand"],"not":{"anyOf":[{"required":["command"]},{"required":["args"]},{"required":["windowsRawArguments"]}]}}]);
    }
    schema
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
pub(crate) enum ResourceWork {
    Ready(Value),
    BlobRead(crate::storage::blob_reads::BlobReadTask),
    ExecutionView(crate::storage::materialization::Task),
}
/// Fixed file bodies use the same immutable reader as wire getBlob. Other domains
/// retain their original owner and execution path.
pub(crate) fn prepare_resource(
    storage: &mut Storage,
    epoch: &str,
    host_id: &str,
    host_generation: &str,
    request: &ResourceCall,
) -> Result<ResourceWork, ResourceFailure> {
    if let Some(authority) = &request.binding.target_authority {
        storage
            .validate_source_resource(
                authority,
                &request.binding,
                epoch,
                !matches!(
                    request.operation,
                    ResourceOperation::ComputeControl { .. }
                        | ResourceOperation::ObserveCompute { .. }
                ),
            )
            .map_err(|error| ResourceFailure {
                error,
                dispatched: false,
            })?;
    } else if !request.binding.resource_owner.is_local() {
        return Err(ResourceFailure {
            error: KernelError::Authorization(
                "Managed source requires its admitted target authority".into(),
            ),
            dispatched: false,
        });
    }
    let effective;
    let request = if request.binding.source_mode == SourceMode::FixedBranch && matches!(request.operation,
        ResourceOperation::FileRead(_) | ResourceOperation::FileQuery(_) | ResourceOperation::ProcessSpawn(_)
        | ResourceOperation::ProcessInspect(_) | ResourceOperation::ProcessRead(_) | ResourceOperation::ProcessObservation {..}) {
        let (grant,_) = storage.authorize(Some(&request.binding.grant_id),epoch,host_id,host_generation,"storage.health",
            &json!({"workspaceId":request.binding.workspace_id})).map_err(|error|ResourceFailure{error,dispatched:false})?;
        validate_binding(&grant,&request.binding,&request.context).map_err(|error|ResourceFailure{error,dispatched:false})?;
        let mut binding = storage.execution_tool_binding(&request.binding,&grant).map_err(|error|ResourceFailure{error,dispatched:false})?;
        if binding.is_none() && matches!(request.operation,ResourceOperation::ProcessSpawn(_)) {
            Storage::require_execution_view_owner(&request.binding,&grant).map_err(|error|ResourceFailure{error,dispatched:false})?;
            if request.authorize_only { return Ok(ResourceWork::Ready(Value::Null)); }
            let params = Storage::execution_view_params(&request.binding).map_err(|error|ResourceFailure{error,dispatched:false})?;
            match storage.prepare_materialized_view(&params,&grant,request.cancellation.shared_flag()).map_err(|error|ResourceFailure{error,dispatched:false})? {
                crate::storage::materialization::Admission::Work(task)=>return Ok(ResourceWork::ExecutionView(task)),
                crate::storage::materialization::Admission::Complete(_)=>{},
            }
            binding = storage.execution_tool_binding(&request.binding,&grant).map_err(|error|ResourceFailure{error,dispatched:false})?;
        }
        if let Some(binding)=binding {
            effective=request.with_execution_binding(binding); &effective
        } else {request}
    } else {request};
    let ResourceOperation::FileRead(args) = &request.operation else {
        return serve_resource_immediate(storage, epoch, host_id, host_generation, request)
            .map(ResourceWork::Ready);
    };
    if request.authorize_only {
        if request.binding.source_mode == SourceMode::FixedBranch {
            let (method,params)=request.operation.params(&request.binding,&request.context);
            let (grant,_)=storage.authorize(Some(&request.binding.grant_id),epoch,host_id,host_generation,method,&params)
                .map_err(|error|ResourceFailure{error,dispatched:false})?;
            validate_binding(&grant,&request.binding,&request.context).map_err(|error|ResourceFailure{error,dispatched:false})?;
            return Ok(ResourceWork::Ready(json!({"resourceKey":fixed_read_key(&request.binding,&args.path)})));
        }
        return serve_resource_immediate(storage, epoch, host_id, host_generation, request)
            .map(ResourceWork::Ready);
    }
    let mut dispatched = false;
    let result = (|| -> Result<ResourceWork, KernelError> {
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
        dispatched = true;
        if request.binding.source_mode != SourceMode::FixedBranch {
            if let Some(root) = &request.binding.live_root { storage.validate_live_root(root, &grant, host_id)?; }
            let key = storage.file_resource_key(request.binding.root_id.as_deref().expect("physical root"), &args.path, &grant)?;
            if request.expected_resource_key.as_deref() != Some(key.as_str()) {
                return Err(KernelError::Authorization("canonical file resource changed after admission".into()));
            }
            return match storage.prepare_file_read(&authorized, &grant, request.cancellation.shared_flag())? {
                Some(task) => Ok(ResourceWork::BlobRead(crate::storage::blob_reads::BlobReadTask::File(task))),
                None => storage.file_read(&authorized, &grant, true).map(|mut value| {
                    value["source"] = request.binding.physical_source(); ResourceWork::Ready(value)
                }),
            };
        }
        if request.expected_resource_key.as_deref().is_some_and(|key|key!=fixed_read_key(&request.binding,&args.path)) {
            return Err(KernelError::Authorization("Fixed file source changed after admission".into()));
        }
        let state =
            storage.dispatch(method, &authorized, Some(&request.binding.grant_id), &grant)?;
        let source = request
            .binding
            .file_source
            .as_ref()
            .expect("validated fixed source");
        let entries = state
            .get("entries")
            .and_then(Value::as_array)
            .ok_or_else(|| KernelError::Storage("branch read omitted entries".into()))?;
        let Some(state) = entries.first().and_then(|entry| entry.get("state")) else {
            return Ok(ResourceWork::Ready(
                json!({"path":args.path,"source":source,"missing":true}),
            ));
        };
        if state.get("kind").and_then(Value::as_str) != Some("regular-file") {
            return Ok(ResourceWork::Ready(
                json!({"path":args.path,"source":source,"state":state,"missing":false}),
            ));
        }
        let hash = state
            .get("objectHash")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Storage("file state omitted object identity".into()))?;
        let mut params = json!({"hash":hash,"branchId":source.branch_id,"revision":source.revision,"path":args.path,"offset":args.offset});
        if let Some(length) = args.length {
            params["length"] = json!(length);
        }
        if let Some(line) = args.start_line { params["startLine"] = json!(line); }
        if let Some(line) = args.end_line { params["endLine"] = json!(line); }
        let (grant, authorized) = storage.authorize(
            Some(&request.binding.grant_id),
            epoch,
            host_id,
            host_generation,
            "storage.getBlob",
            &params,
        )?;
        validate_binding(&grant, &request.binding, &request.context)?;
        let task =
            storage.prepare_blob_read(&authorized, &grant, request.cancellation.shared_flag())?;
        Ok(ResourceWork::BlobRead(task.with_file_output(
            args.path.clone(),
            serde_json::to_value(source)?,
        )))
    })();
    result.map_err(|error| ResourceFailure { error, dispatched })
}
pub(crate) fn finish_resource_blob_read(
    storage: &mut Storage,
    epoch: &str,
    host_id: &str,
    host_generation: &str,
    request: &ResourceCall,
    task: &crate::storage::blob_reads::BlobReadTask,
    result: Result<crate::storage::blob_reads::PreparedBlobRead, KernelError>,
) -> Result<Value, ResourceFailure> {
    (|| {
        let (grant, _) = storage.authorize(
            Some(&request.binding.grant_id),
            epoch,
            host_id,
            host_generation,
            task.method(),
            task.params(),
        )?;
        validate_binding(&grant, &request.binding, &request.context)?;
        let effective = storage.execution_tool_binding(&request.binding, &grant)?;
        let binding = effective.as_ref().unwrap_or(&request.binding);
        if task.method() == "file.read" {
            if let Some(root) = &binding.live_root { storage.validate_live_root(root, &grant, host_id)?; }
            if let ResourceOperation::FileRead(args) = &request.operation {
                let key = storage.file_resource_key(binding.root_id.as_deref().ok_or_else(||KernelError::Authorization("Execution view disappeared during read".into()))?, &args.path, &grant)?;
                if request.expected_resource_key.as_deref() != Some(key.as_str()) {
                    return Err(KernelError::Authorization("canonical file resource changed during read".into()));
                }
            }
        }
        storage.finish_blob_read(task, result, &grant).map(|mut value| {
            if task.method() == "file.read" { value["source"] = binding.physical_source(); }
            value
        })
    })()
    .map_err(|error| ResourceFailure {
        error,
        dispatched: true,
    })
}
/// Unit owner fixtures may synchronously drive the same stages. Production never
/// performs body I/O here: Kernel retains the original reply through worker completion.
#[cfg(test)]
pub(crate) fn serve_execution_view_fixture(storage:&mut Storage,epoch:&str,host:&str,generation:&str,request:&ResourceCall,task:crate::storage::materialization::Task)->Result<Value,ResourceFailure> {
    let result=task.run(|control|storage.control_materialization(&task.operation_id,&task.job_id,control,false));
    storage.finish_materialization(&task.operation_id,&task.job_id);
    result.and_then(|value|finish_resource_execution_view(storage,epoch,host,generation,request,value))
        .map_err(|error|ResourceFailure{error,dispatched:false})?;
    serve_resource(storage,epoch,host,generation,request)
}
#[cfg(test)]
pub(crate) fn serve_resource(
    storage: &mut Storage,
    epoch: &str,
    host_id: &str,
    host_generation: &str,
    request: &ResourceCall,
) -> Result<Value, ResourceFailure> {
    match prepare_resource(storage, epoch, host_id, host_generation, request)? {
        ResourceWork::Ready(value) => Ok(value),
        ResourceWork::ExecutionView(task) => serve_execution_view_fixture(storage,epoch,host_id,host_generation,request,task),
        ResourceWork::BlobRead(task) => {
            let result = task.run();
            finish_resource_blob_read(
                storage,
                epoch,
                host_id,
                host_generation,
                request,
                &task,
                result,
            )
        }
    }
}

/// Called only on the sole Storage actor. Host/epoch values come from its handshake, not the model.
/// Existing domain APIs accept validated Values; no JSON serialization or protocol loopback occurs.
fn serve_resource_immediate(
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
        match &request.operation {
            ResourceOperation::ProcessObservation {
                process_id,
                lineage,
                ..
            } => storage.validate_source_process_access(
                &request.binding,
                process_id,
                epoch,
                lineage.as_ref(),
            )?,
            ResourceOperation::ProcessInspect(args) => storage.validate_source_process_access(
                &request.binding,
                &args.process_id,
                epoch,
                None,
            )?,
            ResourceOperation::ProcessRead(args) => storage.validate_source_process_access(
                &request.binding,
                &args.process_id,
                epoch,
                None,
            )?,
            _ => (),
        }
        // A language backend can read all project dependencies/configuration in its cwd.
        // The original Run grant must admit that input even when a Host service grant
        // owns the derived materialization or language process.
        if matches!(request.operation, ResourceOperation::LanguageSource(_))
            && !grant.path_scopes.iter().any(String::is_empty)
        {
            let project = if request.binding.source_mode == SourceMode::FixedBranch {
                "fixed project"
            } else {
                "source project"
            };
            return Err(KernelError::Authorization(format!(
                "The selected language backend reads the entire {project}; the current grant only allows selected paths. Use a whole-project read grant or file_read for path-scoped access."
            )));
        }
        if matches!(
            request.operation,
            ResourceOperation::CollaborationPin { release: false, .. }
        ) && (!grant.path_scopes.iter().any(String::is_empty)
            || !(grant.capabilities.contains("storage.read")
                || grant.capabilities.contains("storage.admin")))
        {
            return Err(KernelError::Authorization(
                "fixed-root child handoff requires the parent's whole-root read authority".into(),
            ));
        }
        if let Some(root) = &request.binding.live_root {
            storage.validate_live_root(root, &grant, host_id)?;
        }
        match &request.operation {
            ResourceOperation::ChildSourceHandoff { delegation } => {
                return storage.child_source_handoff(
                    &request.binding,
                    &request.context,
                    delegation,
                    &grant,
                    host_id,
                    request.authorize_only,
                );
            }
            ResourceOperation::ChildStorageReceipt { operation_id, kind } => {
                return storage.child_storage_receipt(&request.binding, operation_id, kind, &grant);
            }
            ResourceOperation::ChildRootIdle => {
                return storage.require_child_root_idle(&request.binding, &grant);
            }
            _ => (),
        }
        if let Some(root) = &request.binding.live_root {
            storage.validate_live_root(root, &grant, host_id)?;
        }
        let file_path = match &request.operation {
            ResourceOperation::FileMutation(mutation) => Some(mutation.path()),
            ResourceOperation::FileRead(args)
                if request.binding.source_mode != SourceMode::FixedBranch =>
            {
                Some(args.path.as_str())
            }
            _ => None,
        };
        if let Some(path) = file_path {
            let key = storage.file_resource_key(
                request
                    .binding
                    .root_id
                    .as_deref()
                    .expect("validated physical root"),
                path,
                &grant,
            )?;
            if request.authorize_only {
                return Ok(json!({"resourceKey":key}));
            }
            if request.expected_resource_key.as_deref() != Some(key.as_str()) {
                return Err(KernelError::Authorization(
                    "canonical file resource changed after admission".into(),
                ));
            }
        }
        if let ResourceOperation::ReconcileMutation { mutation, executor } = &request.operation {
            let root_id = request
                .binding
                .root_id
                .as_deref()
                .ok_or_else(|| KernelError::Authorization("physical root missing".into()))?;
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
        if let ResourceOperation::RecoveryPoints(args) = &request.operation {
            if request.authorize_only { return Ok(Value::Null); }
            return storage.file_recovery_points(&request.binding.workspace_id,
                request.binding.root_id.as_deref().expect("physical source"), &request.binding.thread_id,
                args, request.journal.as_ref(), &grant);
        }
        if let ResourceOperation::ReconcileFileRestore(args) = &request.operation {
            return storage.file_restore_receipt(&request.binding.workspace_id,
                request.binding.root_id.as_deref().expect("physical source"), &request.binding.thread_id,
                &request.context.operation_id, args, &grant).and_then(|receipt|serde_json::to_value(receipt).map_err(Into::into));
        }
        if let ResourceOperation::FileRestore(args) = &request.operation {
            if request.authorize_only { return Ok(Value::Null); }
            storage.set_cancellation(request.cancellation.shared_flag());
            let result = storage.restore_recorded_files(&request.binding.workspace_id,
                request.binding.root_id.as_deref().expect("physical source"), &request.binding.thread_id,
                &request.context.operation_id, args, request.journal.as_ref(), request.binding.source_mode, &grant, &mut dispatched);
            storage.clear_cancellation();
            return result;
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
                request.journal.as_ref(),
                request.binding.source_mode,
                !request.authorize_only,
                &mut dispatched,
            );
            storage.clear_cancellation();
            return result;
        }
        if matches!(
            request.operation,
            ResourceOperation::RetrievalQuery(_) | ResourceOperation::LanguageSource(_)
        ) {
            if matches!(request.operation, ResourceOperation::LanguageSource(_))
                && request.binding.source_mode != SourceMode::FixedBranch
            {
                // Keep the original file scope/lease admission without returning its
                // authorize-only null before the source descriptor is assembled.
                storage.set_cancellation(request.cancellation.shared_flag());
                let admission = storage.file_read(&authorized, &grant, false);
                storage.clear_cancellation();
                admission?;
            }
            let source = request.binding.source_selection()?;
            if source.mode == SourceMode::FixedBranch {
                // Metadata validates the exact original revision, without scanning its tree.
                let (source_grant, params) = storage.authorize(
                    Some(&request.binding.grant_id),
                    epoch,
                    host_id,
                    host_generation,
                    "branch.read",
                    &json!({"branchId":source.branch_id,
                        "revision":source.revision,"includeEntries":false}),
                )?;
                validate_binding(&source_grant, &request.binding, &request.context)?;
                storage.dispatch(
                    "branch.read",
                    &params,
                    Some(&request.binding.grant_id),
                    &source_grant,
                )?;
            }
            if let ResourceOperation::LanguageSource(args) = &request.operation {
                if let Some(expected) = &args.derived_view {
                    let view = storage.check_materialized_view(
                        &json!({"workspaceId":source.workspace_id,"viewId":expected["viewId"]}),
                        &grant,
                    )?;
                    let branch=storage.dispatch("branch.read",&json!({"branchId":source.branch_id,"revision":source.revision,"includeEntries":false}),Some(&grant.grant_id),&grant)?;
                    if source.mode != SourceMode::FixedBranch
                        || view != *expected
                        || view["branchId"] != json!(source.branch_id)
                        || view["revision"] != json!(source.revision)
                        || view["sourceRoot"] != branch["root"]
                    {
                        return Err(KernelError::Authorization(
                            "Language derived view differs from its immutable source".into(),
                        ));
                    }
                }
            }
            let physical = storage.source_physical_root(&request.binding, &grant, host_id)?;
            return Ok(json!({"source":source,"physicalRoot":physical}));
        }
        if method == "file.read" {
            storage.set_cancellation(request.cancellation.shared_flag());
            let result = storage.file_read(&authorized, &grant, !request.authorize_only);
            storage.clear_cancellation();
            dispatched = !request.authorize_only;
            return result.map(|mut result| {
                if !request.authorize_only {
                    result["source"] = request.binding.physical_source();
                }
                result
            });
        }
        if let ResourceOperation::ProcessObservation {
            source_run_id,
            lineage,
            ..
        } = &request.operation
        {
            if lineage.as_ref().is_some_and(|proof| {
                proof.target()
                    != &request
                        .binding
                        .source_selection()
                        .expect("validated binding")
            }) {
                return Err(KernelError::Authorization(
                    "delegated process source changed".into(),
                ));
            }
            return storage.observe_run_process(
                method,
                &authorized,
                &grant,
                request.binding.root_id.as_deref(),
                source_run_id,
                lineage.as_ref(),
                request.authorize_only,
            );
        }

        if request.authorize_only {
            return Ok(Value::Null);
        }
        if let ResourceOperation::ObserveCompute { job_id, reply } = &request.operation {
            let watch = storage.watch_compute(
                job_id,
                &request.binding.workspace_id,
                &grant,
            )?;
            reply
                .send(watch)
                .map_err(|_| KernelError::Storage("compute observer disconnected".into()))?;
            return Ok(Value::Null);
        }
        storage.set_cancellation(request.cancellation.shared_flag());
        dispatched = true;
        let result = storage.dispatch(method, &authorized, Some(&request.binding.grant_id), &grant);
        storage.clear_cancellation();
        if result.is_err() && method == "process.spawn"
            && storage.process_spawn_not_dispatched(&request.context.operation_id).unwrap_or(false)
        {
            dispatched = false;
        }
        let result = result?;
        Ok(result)
    })();
    result.map_err(|error| ResourceFailure { error, dispatched })
}

#[cfg(test)]
#[path = "collaboration_boundary_review.rs"]
mod collaboration_boundary_review;

#[cfg(test)]
#[path = "tools_retrieval_review.rs"]
mod retrieval_source_adapter_review;

#[cfg(test)]
#[path = "tools_reliability_review.rs"]
pub(crate) mod reliability_review;

/// Runs only on the actual resource Host. The original coordinator owns Catalog intent;
/// this adapter invokes the existing typed Storage/compute/process owners directly.
pub(crate) fn managed_read_receipt_tool(name: &str) -> bool {
    matches!(
        serde_json::from_value::<ToolKind>(json!(name)),
        Ok(ToolKind::FileRead
            | ToolKind::RecoveryPoints
            | ToolKind::FileList
            | ToolKind::FileSearch
            | ToolKind::ProcessRead
            | ToolKind::ProcessInspect)
    )
}
pub(crate) fn execute_source_tool(
    resources: KernelResourceClient,
    record: crate::source_resources::AuthorityRecord,
    input: crate::source_resources::SourceResourceCallParams,
    authorize_only: bool,
    cancel: CancellationToken,
) -> Result<Value, KernelError> {
    let mut binding = record
        .result
        .tool_binding
        .clone()
        .ok_or_else(|| KernelError::Authorization("Tool source has no Run binding".into()))?;
    let address = crate::source_resources::address(&input);
    binding.target_authority = Some(address);
    let call = ToolCall {
        call_id: input.call.call_id,
        name: input.call.name,
        schema_version: input.call.schema_version,
        arguments: input.call.arguments,
    };
    let context = ToolExecutionContext {
        run_id: input.call.run_id,
        operation_id: input.call.operation_id,
        origin: input.call.origin,
    };
    if context.run_id != binding.run_id
        || context.operation_id != context.origin.operation_id(&call.call_id)
    {
        return Err(KernelError::Authorization(
            "Source invocation differs from its original Run/Operation".into(),
        ));
    }
    if input.journal.as_ref().is_some_and(|j| {
        j.run_id != binding.run_id
            || j.thread_id != binding.thread_id
            || j.epoch != record.result.scope.epoch()
    }) {
        return Err(KernelError::Authorization(
            "Source journal differs from its admitted coordinator scope".into(),
        ));
    }
    let resources = resources.with_source_journal(input.journal);
    let executor = KernelToolExecutor::new(binding.clone(), resources.clone())
        .map_err(|e| KernelError::Authorization(e.to_string()))?;
    let operation = executor
        .operation(Some(&context), &call)
        .map_err(|e| KernelError::Authorization(e.to_string()))?;
    let contract = executor
        .planned_contract(&context, &call, &operation, &cancel)
        .map_err(|e| KernelError::Authorization(e.to_string()))?;
    let _grant_watch = executor
        .watch_admission(&context, &call, &contract, &cancel)
        .map_err(|e| KernelError::Authorization(e.to_string()))?;
    if authorize_only {
        if matches!(
            operation,
            ResourceOperation::ProcessWrite(_) | ResourceOperation::ProcessResize(_)
        ) {
            let id = match &operation {
                ResourceOperation::ProcessWrite(args) => args.process_id.clone(),
                ResourceOperation::ProcessResize(args) => args.process_id.clone(),
                _ => unreachable!(),
            };
            resources
                .interactions
                .as_ref()
                .ok_or_else(|| KernelError::Storage("Process owner unavailable".into()))?
                .access(binding.clone(), id)?;
        } else {
            executor
                .authorize_operation(&context, &call, &operation, &contract, &cancel)
                .map_err(|e| KernelError::Authorization(e.to_string()))?;
        }
        return Ok(serde_json::to_value(contract)?);
    }
    let receipt = if matches!(
        operation,
        ResourceOperation::ProcessWrite(_) | ResourceOperation::ProcessResize(_)
    ) {
        let (id, action) = match operation {
            ResourceOperation::ProcessWrite(args) => (
                args.process_id,
                crate::process::interaction::Input::Write {
                    bytes: args.text.into_bytes().into(),
                    eof: args.eof,
                },
            ),
            ResourceOperation::ProcessResize(args) => (
                args.process_id,
                crate::process::interaction::Input::Resize {
                    cols: args.cols,
                    rows: args.rows,
                },
            ),
            _ => unreachable!(),
        };
        let client = resources.interactions.as_ref().ok_or_else(|| {
            KernelError::Storage("Original process interaction owner unavailable".into())
        })?;
        let value = client
            .invoke(
                crate::storage::process_interactions::Context {
                    grant_id: binding.grant_id.clone(),
                    epoch: None,
                    binding: Some(binding.clone()),
                },
                crate::storage::process_interactions::Address {
                    workspace_id: binding.workspace_id.clone(),
                    process_id: id,
                    operation_id: context.operation_id.clone(),
                    root_id: binding.root_id.clone(),
                },
                || Ok(action),
                Some(crate::storage::process_interactions::Native {
                    resource_owner: binding.resource_owner.clone(),
                    context: context.clone(),
                    executor: call.name.clone(),
                }),
                cancel.clone(),
            )
            .map_err(|e| e.error)?;
        let stopped = value.identity().state != crate::process::interaction::State::Unknown;
        varin_runtime::execution::ToolExecutionReceipt {
            completion: ToolCompletion::Result {
                outcome: value.outcome(),
                effect: value.effect(),
                content: serde_json::to_value(value)?.into(),
            },
            executor_stopped: stopped,
        }
    } else {
        let completion = executor.execute_operation(&context, &call, operation, &contract, &cancel);
        varin_runtime::execution::ToolExecutionReceipt::local(completion, &contract)
    };
    Ok(
        json!({"operationId":context.operation_id,"resourceEpoch":record.result.resource_epoch,"executionOwner":record.result.execution_owner,
        "accepted":!matches!(receipt.completion,ToolCompletion::NotDispatched{..}),"executorStopped":receipt.executor_stopped,"result":receipt}),
    )
}
impl ResourceOperation {
    fn source_action(&self) -> Result<crate::source_resources::SourceResourceAction, KernelError> {
        use crate::source_resources::SourceResourceAction as A;
        Ok(match self {
            Self::FileRead(args) => A::Read {
                path: args.path.clone(),
                offset: args.offset,
                length: args.length,
                start_line: args.start_line,
                end_line: args.end_line,
            },
            Self::LanguageSource(args) => A::LanguageSource {
                path: args.path.clone(),
                derived_view: args.derived_view.clone(),
            },
            Self::RetrievalQuery(args) => A::RetrievalSource {
                paths: args.paths.clone(),
            },
            Self::ChildSourceHandoff { delegation } => A::ChildSourceHandoff {
                delegation: delegation.clone(),
            },
            Self::ChildStorageReceipt { operation_id, kind } => A::ChildStorageReceipt {
                operation_id: operation_id.clone(),
                receipt_kind: kind.clone(),
            },
            Self::ChildRootIdle => A::ChildRootIdle,
            Self::CollaborationPin { release, pin_id } => A::CollaborationPin {
                release: *release,
                pin_id: pin_id.clone(),
            },
            Self::ProcessObservation {
                source_run_id,
                lineage,
                process_id,
                read,
            } => A::ProcessObservation {
                source_run_id: source_run_id.clone(),
                lineage: lineage.clone(),
                process_id: process_id.clone(),
                read: *read,
            },
            Self::ReconcileMutation { mutation, executor } => A::ReconcileMutation {
                mutation: mutation.clone(),
                executor: executor.clone(),
            },
            _ => {
                return Err(KernelError::Authorization(
                    "Resource requires its closed managed Tool entry".into(),
                ));
            }
        })
    }
    fn from_source_action(action: crate::source_resources::SourceResourceAction) -> Self {
        use crate::source_resources::SourceResourceAction as A;
        match action {
            A::Read {
                path,
                offset,
                length,
                start_line,
                end_line,
            } => Self::FileRead(FileReadArgs {
                path,
                offset,
                length,
                start_line,
                end_line,
                unit:None,
            }),
            A::LanguageSource { path, derived_view } => {
                Self::LanguageSource(LanguageSourceArgs { path, derived_view })
            }
            A::RetrievalSource { paths } => {
                Self::RetrievalQuery(RetrievalQueryArgs::source_descriptor(paths))
            }
            A::ChildSourceHandoff { delegation } => Self::ChildSourceHandoff { delegation },
            A::ChildStorageReceipt {
                operation_id,
                receipt_kind,
            } => Self::ChildStorageReceipt {
                operation_id,
                kind: receipt_kind,
            },
            A::ChildRootIdle => Self::ChildRootIdle,
            A::CollaborationPin { release, pin_id } => Self::CollaborationPin { release, pin_id },
            A::ProcessObservation {
                source_run_id,
                lineage,
                process_id,
                read,
            } => Self::ProcessObservation {
                source_run_id,
                lineage,
                process_id,
                read,
            },
            A::ReconcileMutation { mutation, executor } => {
                Self::ReconcileMutation { mutation, executor }
            }
        }
    }
}
pub(crate) fn execute_source_resource(
    resources: KernelResourceClient,
    record: crate::source_resources::AuthorityRecord,
    address: crate::source_resources::SourceAuthorityAddress,
    context: ToolExecutionContext,
    action: crate::source_resources::SourceResourceAction,
    authorize_only: bool,
    cancel: CancellationToken,
) -> Result<Value, KernelError> {
    let mut binding = record.result.tool_binding.ok_or_else(|| {
        KernelError::Authorization("Resource requires its original Run binding".into())
    })?;
    if context.run_id != binding.run_id {
        return Err(KernelError::Authorization(
            "Resource belongs to another Run".into(),
        ));
    }
    binding.target_authority = Some(address);
    let _grant_watch = resources
        .admission_control
        .as_ref()
        .map(|watch| watch(&binding, &cancel))
        .transpose()
        .map_err(|e| KernelError::Authorization(e.to_string()))?;
    resources
        .call(
            &binding,
            &context,
            ResourceOperation::from_source_action(action),
            authorize_only,
            &cancel,
        )
        .map_err(|f| f.error)
}
