//! Model-facing discovery composes the existing admitted compute worker. The
//! resource actor handles only admission and page reads, never waits for a scan.
use super::*;
use crate::compute::ComputeWatch;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FileQueryArgs {
    #[serde(skip)]
    pub search: bool,
    paths: Option<Vec<String>>,
    globs: Option<Vec<String>>,
    query: Option<String>,
    ignore_case: Option<bool>,
    fixed_strings: Option<bool>,
    recursive: Option<bool>,
    include_hidden: Option<bool>,
    exclude_directories: Option<Vec<String>>,
    respect_gitignore: Option<bool>,
    include_revisions: Option<bool>,
    cursor: Option<String>,
    max_results: Option<i64>,
    max_bytes: Option<usize>,
}
impl FileQueryArgs {
    pub fn validate(&self) -> Result<(), ExecutionError> {
        for path in self.paths.as_deref().unwrap_or_default() {
            normalized_path(path, true)?;
        }
        if let Some(cursor) = &self.cursor {
            normalized_path(cursor, true)?;
            if self.search { return Err(ExecutionError::new("invalid_tool_arguments", "cursor is available for file_list")); }
        }
        if (self.search && self.query.as_deref().is_none_or(str::is_empty))
            || self
                .max_results
                .is_some_and(|n| n < 1 || n > 9_007_199_254_740_991)
            || self
                .max_bytes
                .is_some_and(|n| n == 0 || n > crate::protocol::MAX_FRAME_BYTES / 2)
        {
            return Err(ExecutionError::new("invalid_tool_arguments", "Search requires a nonempty query; result and byte limits must be positive and fit the protocol output budget"));
        }
        Ok(())
    }
    pub fn params(&self, binding: &ToolBinding, context: &ToolExecutionContext) -> Value {
        let mut params = json!({"workspaceId":binding.workspace_id,"jobId":context.operation_id,
            "lane":"foreground","operation":if self.search {"search"} else {"list"},
            "paths":self.paths.clone().unwrap_or_else(|| vec![String::new()]),
            "maxResults":self.max_results.unwrap_or(100).saturating_add(if self.search {0} else {1}).min(9_007_199_254_740_991),"includeHidden":self.include_hidden.unwrap_or(true),
            "excludeDirectories":self.exclude_directories.clone().unwrap_or_else(|| vec![".git".into(),"node_modules".into(),".worktrees".into()]),
            "respectGitignore":self.respect_gitignore.unwrap_or(true),
            "includeRevisions":self.include_revisions.unwrap_or(false),
            "immediate":!self.recursive.unwrap_or(self.search)});
        if let Some(cursor) = &self.cursor { params["startAfterPath"] = json!(cursor); }
        if binding.source_mode != SourceMode::FixedBranch {
            params["rootId"] = json!(binding.root_id);
        } else {
            let source = binding.file_source.as_ref().expect("validated source");
            params["branchId"] = json!(source.branch_id);
            params["revision"] = json!(source.revision);
        }
        if let Some(value) = &self.query {
            params["query"] = json!(value);
        }
        if let Some(value) = &self.globs {
            params["globs"] = json!(value);
        }
        if let Some(value) = self.ignore_case {
            params["ignoreCase"] = json!(value);
        }
        // Literal search is the useful default; callers may explicitly request regex.
        params["fixedStrings"] = json!(self.fixed_strings.unwrap_or(true));
        params
    }
}

impl KernelResourceClient {
    fn observe_query(
        &self,
        binding: &ToolBinding,
        context: &ToolExecutionContext,
        cancel: &CancellationToken,
    ) -> Result<ComputeWatch, ResourceFailure> {
        let (reply, watch) = mpsc::channel();
        self.call(binding, context, ResourceOperation::ObserveCompute { reply }, false, cancel)?;
        watch.recv().map_err(|_| ResourceFailure {
            error: KernelError::Storage("compute owner disconnected before observation".into()),
            dispatched: true,
        })
    }
    fn query_control(
        &self,
        binding: &ToolBinding,
        context: &ToolExecutionContext,
        method: &'static str,
        cursor: u64,
        cancel: &CancellationToken,
    ) -> Result<Value, ResourceFailure> {
        self.call(
            binding,
            context,
            ResourceOperation::ComputeControl { method, cursor },
            false,
            cancel,
        )
    }
    // Cancellation retains ownership until the compute worker has stopped and
    // the Storage owner can release its immutable reader reference.
    fn finish_query(
        &self,
        binding: &ToolBinding,
        context: &ToolExecutionContext,
        stop: bool,
        watch: &ComputeWatch,
    ) -> Result<(), ResourceFailure> {
        let cleanup = CancellationToken::default();
        if stop {
            self.query_control(binding, context, "compute.cancel", 0, &cleanup)?;
            // Cleanup has independent cancellation ownership. A cancelled tool
            // still waits for the exact worker's terminal fact before releasing pins.
            watch.wait(0, true, &cleanup);
        }
        self.query_control(binding, context, "compute.release", 0, &cleanup)
            .map(|_| ())
    }
    pub(super) fn query(
        &self,
        binding: &ToolBinding,
        context: &ToolExecutionContext,
        args: &FileQueryArgs,
        cancel: &CancellationToken,
    ) -> Result<Value, ResourceFailure> {
        let mut page = self.call(
            binding,
            context,
            ResourceOperation::FileQuery(args.clone()),
            false,
            cancel,
        )?;
        // Acquire with independent control so cancellation racing start cannot
        // abandon a successfully admitted compute reader before cleanup owns it.
        let watch = match self.observe_query(binding, context, &CancellationToken::default()) {
            Ok(watch) => watch,
            Err(error) => {
                // Revocation cancels and sweeps the job at its existing owner.
                let _ = self.query_control(binding, context, "compute.cancel", 0, &CancellationToken::default());
                return Err(error);
            }
        };
        let mut records = Vec::new();
        let mut bytes = 2usize;
        let budget = args.max_bytes.unwrap_or(65536);
        let result = (|| loop {
            if cancel.is_cancelled() {
                return Err(ResourceFailure {
                    error: KernelError::Cancelled,
                    dispatched: true,
                });
            }
            let mut truncated = false;
            for record in page["records"].as_array().into_iter().flatten() {
                let size = serde_json::to_vec(record)
                    .map_err(|error| ResourceFailure {
                        error: error.into(),
                        dispatched: true,
                    })?
                    .len()
                    + 1;
                if bytes.saturating_add(size) > budget || (!args.search && records.len() >= args.max_results.unwrap_or(100) as usize) {
                    truncated = true;
                    break;
                }
                bytes += size;
                let mut record = record.clone();
                if !args.search {
                    if record["revision"] == "" { record.as_object_mut().unwrap().remove("revision"); }
                    if record["data"]["state"]["objectHash"] == "" {
                        record["data"]["state"].as_object_mut().unwrap().remove("objectHash");
                    }
                }
                records.push(record);
            }
            let terminal = !matches!(page["status"].as_str(), Some("queued" | "running"));
            let cursor = page["nextCursor"].as_u64().expect("compute page cursor");
            if truncated || (terminal && page["nextCursor"] == page["endCursor"]) {
                if page["status"] == "failed" {
                    return Err(ResourceFailure {
                        error: KernelError::Operation(
                            page["message"]
                                .as_str()
                                .unwrap_or("Discovery failed")
                                .into(),
                        ),
                        dispatched: true,
                    });
                }
                let next = (!args.search && truncated).then(|| records.last().and_then(|record|record["path"].as_str())).flatten();
                let output = json!({"source":if binding.source_mode == SourceMode::FixedBranch {
                        json!(binding.file_source)
                    } else { binding.physical_source() },
                        "status":if truncated {"partial"} else {page["status"].as_str().unwrap_or("failed")},
                        "records":records,"scannedFiles":page["scannedFiles"],
                        "truncated":truncated || page["status"] == "partial",
                        "nextCursor":next,
                        "message":if next.is_some() {json!("More paths are available; pass nextCursor as cursor with the same filters")}
                            else if truncated {json!("Output byte budget reached; narrow paths/globs/query or increase maxBytes")} else {page["message"].clone()}});
                self.finish_query(binding, context, !terminal, &watch)?;
                return Ok(output);
            }
            // A nonempty page must first be acknowledged by the next read to
            // free producer credit; only an already-empty page can park safely.
            if page["records"].as_array().is_none_or(Vec::is_empty) && !watch.wait(cursor, false, cancel) {
                return Err(ResourceFailure { error: KernelError::Cancelled, dispatched: true });
            }
            page = self.query_control(binding, context, "compute.read", cursor, cancel)?;
        })();
        if result.is_err() {
            // Grant revocation itself cancels and sweeps owned compute jobs.
            let _ = self.finish_query(binding, context, true, &watch);
        }
        result
    }
}

pub(super) fn schema(search: bool) -> Value {
    let mut schema = json!({"type":"object","additionalProperties":false,
        "description":if search {"Search text in the selected source. Returns file paths, source revisions, line/column and matching text. Narrow paths or globs when results are partial."} else {"List a directory in the selected source. Omit paths for the root. Pass nextCursor as cursor with the same filters to continue; recursive includes descendants. Revisions are captured only when includeRevisions is true."},
        "properties":{
            "paths":{"type":"array","items":{"type":"string"}},
            "globs":{"type":"array","items":{"type":"string"}},
            "query":{"type":"string","description":if search {"Nonempty literal text, or regex when fixedStrings is false"} else {"Optional case-insensitive path substring"}},
            "fixedStrings":{"type":"boolean","default":true},
            "ignoreCase":{"type":"boolean","default":false},
            "recursive":{"type":"boolean","default":search},
            "includeHidden":{"type":"boolean","default":true},
            "excludeDirectories":{"type":"array","items":{"type":"string"},"default":[".git","node_modules",".worktrees"],"description":"Directory names to skip; an empty array includes them."},
            "respectGitignore":{"type":"boolean","default":true},
            "includeRevisions":{"type":"boolean","default":false},
            "cursor":{"type":"string","description":"file_list continuation from nextCursor; keep the original paths and filters."},
            "maxResults":{"type":"integer","minimum":1,"maximum":9_007_199_254_740_991i64,"default":100},
            "maxBytes":{"type":"integer","minimum":1,"maximum":crate::protocol::MAX_FRAME_BYTES / 2,"default":65536}},
        "required":if search {vec!["query"]} else {vec![]}});
    if search { schema["properties"].as_object_mut().unwrap().remove("cursor"); }
    schema
}
