//! Model-facing discovery composes the existing admitted compute worker. The
//! resource actor handles only admission and page reads, never waits for a scan.
use super::*;
use std::time::Duration;

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
    max_results: Option<i64>,
    max_bytes: Option<usize>,
}
impl FileQueryArgs {
    pub fn validate(&self) -> Result<(), ExecutionError> {
        for path in self.paths.as_deref().unwrap_or_default() {
            normalized_path(path, true)?;
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
    pub fn params(&self, binding: &NativeToolBinding, context: &ToolExecutionContext) -> Value {
        let mut params = json!({"workspaceId":binding.workspace_id,"jobId":context.operation_id,
            "lane":"foreground","operation":if self.search {"search"} else {"list"},
            "paths":self.paths.clone().unwrap_or_else(|| vec![String::new()]),
            "maxResults":self.max_results.unwrap_or(100),"includeHidden":self.include_hidden.unwrap_or(true),
            "immediate":!self.recursive.unwrap_or(true)});
        if binding.source_mode == NativeSourceMode::Materialized {
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

impl NativeResourceClient {
    fn query_control(
        &self,
        binding: &NativeToolBinding,
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
        binding: &NativeToolBinding,
        context: &ToolExecutionContext,
        stop: bool,
    ) -> Result<(), ResourceFailure> {
        let cleanup = CancellationToken::default();
        if stop {
            self.query_control(binding, context, "compute.cancel", 0, &cleanup)?;
            loop {
                let page = self.query_control(binding, context, "compute.read", 0, &cleanup)?;
                if !matches!(page["status"].as_str(), Some("queued" | "running")) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        self.query_control(binding, context, "compute.release", 0, &cleanup)
            .map(|_| ())
    }
    pub(super) fn query(
        &self,
        binding: &NativeToolBinding,
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
                if bytes.saturating_add(size) > budget {
                    truncated = true;
                    break;
                }
                bytes += size;
                records.push(record.clone());
            }
            let terminal = !matches!(page["status"].as_str(), Some("queued" | "running"));
            let cursor = page["nextCursor"].as_u64().expect("compute page cursor");
            if truncated || (terminal && page["nextCursor"] == page["endCursor"]) {
                if page["status"] == "failed" {
                    return Err(ResourceFailure {
                        error: KernelError::Operation(
                            page["message"]
                                .as_str()
                                .unwrap_or("Native discovery failed")
                                .into(),
                        ),
                        dispatched: true,
                    });
                }
                let output = json!({"source":if binding.source_mode == NativeSourceMode::FixedBranch {
                        json!(binding.file_source)
                    } else { json!({"mode":"materialized","rootId":binding.root_id,"base":binding.materialized_source}) },
                        "status":if truncated {"partial"} else {page["status"].as_str().unwrap_or("failed")},
                        "records":records,"scannedFiles":page["scannedFiles"],
                        "truncated":truncated || page["status"] == "partial",
                        "message":if truncated {json!("Output byte budget reached; narrow paths/globs/query or increase maxBytes")} else {page["message"].clone()}});
                self.finish_query(binding, context, !terminal)?;
                return Ok(output);
            }
            if page["records"].as_array().is_none_or(Vec::is_empty) {
                std::thread::sleep(Duration::from_millis(10));
            }
            page = self.query_control(binding, context, "compute.read", cursor, cancel)?;
        })();
        if result.is_err() {
            // Grant revocation itself cancels and sweeps owned compute jobs.
            let _ = self.finish_query(binding, context, true);
        }
        result
    }
}

pub(super) fn schema(search: bool) -> Value {
    json!({"type":"object","additionalProperties":false,
        "description":if search {"Search text in the selected source. Returns file paths, source revisions, line/column and matching text. Narrow paths or globs when results are partial."} else {"List paths in the selected source. Omit paths to select the granted root; query filters path names. Narrow paths/globs when results are partial."},
        "properties":{
            "paths":{"type":"array","items":{"type":"string"}},
            "globs":{"type":"array","items":{"type":"string"}},
            "query":{"type":"string","description":if search {"Nonempty literal text, or regex when fixedStrings is false"} else {"Optional case-insensitive path substring"}},
            "fixedStrings":{"type":"boolean","default":true},
            "ignoreCase":{"type":"boolean","default":false},
            "recursive":{"type":"boolean","default":true},
            "includeHidden":{"type":"boolean","default":true},
            "maxResults":{"type":"integer","minimum":1,"maximum":9_007_199_254_740_991i64,"default":100},
            "maxBytes":{"type":"integer","minimum":1,"maximum":crate::protocol::MAX_FRAME_BYTES / 2,"default":65536}},
        "required":if search {vec!["query"]} else {vec![]}})
}
