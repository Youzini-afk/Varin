//! Model-facing discovery composes the existing admitted compute worker. The
//! resource actor handles only admission and page reads, never waits for a scan.
use super::*;
use crate::compute::ComputeWatch;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListCursor {
    version: u8,
    query: String,
    job_id: String,
    cursor: u64,
    epoch: String,
}
fn decode_cursor(value: &str) -> Result<ListCursor, ExecutionError> {
    let invalid = || {
        ExecutionError::new("invalid_tool_arguments", "Invalid file query cursor. Pass nextCursor unchanged from a previous page, or omit cursor to restart.")
    };
    let cursor: ListCursor = URL_SAFE_NO_PAD
        .decode(value)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or_else(invalid)?;
    if cursor.version != 2
        || cursor.query.len() != 64
        || !cursor.query.bytes().all(|c| c.is_ascii_hexdigit())
        || cursor.job_id.is_empty()
        || cursor.epoch.is_empty()
    {
        return Err(invalid());
    }
    Ok(cursor)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FileQueryArgs {
    #[serde(skip)]
    pub search: bool,
    paths: Option<Vec<String>>,
    globs: Option<Vec<String>>,
    query: Option<String>,
    queries: Option<Vec<String>>,
    format: Option<String>,
    before: Option<u64>,
    after: Option<u64>,
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
    pub(super) fn restrict_paths(&mut self, scope: &[String]) -> Result<(), ExecutionError> {
        let within = |path: &str, root: &str| {
            root.is_empty()
                || path == root
                || path
                    .strip_prefix(root)
                    .is_some_and(|tail| tail.starts_with('/'))
        };
        let requested = self.paths.clone().unwrap_or_else(|| vec![String::new()]);
        let selected = requested
            .iter()
            .flat_map(|path| {
                scope.iter().filter_map(|root| {
                    if within(path, root) {
                        Some(path.clone())
                    } else if within(root, path) {
                        Some(root.clone())
                    } else {
                        None
                    }
                })
            })
            .collect::<std::collections::BTreeSet<_>>();
        if selected.is_empty() {
            return Err(ExecutionError::new(
                "retrieval_scope",
                "Requested search paths do not intersect this retrieval invocation's scope",
            ));
        }
        self.paths = Some(selected.into_iter().collect());
        Ok(())
    }
    pub fn validate(&mut self) -> Result<(), ExecutionError> {
        for path in self.paths.as_mut().into_iter().flatten() {
            normalize_separators(path);
            normalized_path(path, true)?;
        }
        if let Some(cursor) = &self.cursor {
            decode_cursor(cursor)?;
        }
        if self
            .format
            .as_deref()
            .is_some_and(|format| !self.search || !matches!(format, "paths" | "lines" | "windows"))
        {
            return Err(ExecutionError::new(
                "invalid_tool_arguments",
                "Search format must be paths, lines or windows",
            ));
        }
        if self.search
            && (self.query.is_some() == self.queries.is_some()
                || self.query.as_deref().is_some_and(str::is_empty)
                || self
                    .queries
                    .as_ref()
                    .is_some_and(|items| items.is_empty() || items.iter().any(String::is_empty)))
        {
            return Err(ExecutionError::new(
                "invalid_tool_arguments",
                "file_search requires either a nonempty query or a nonempty queries array",
            ));
        }
        if !self.search && (self.queries.is_some() || self.before.is_some() || self.after.is_some())
        {
            return Err(ExecutionError::new(
                "invalid_tool_arguments",
                "queries and context lines are available for file_search",
            ));
        }
        if self
            .before
            .into_iter()
            .chain(self.after)
            .any(|n| n > 9_007_199_254_740_991)
        {
            return Err(ExecutionError::new(
                "invalid_tool_arguments",
                "Context line counts must be nonnegative safe integers",
            ));
        }
        if self
            .max_results
            .is_some_and(|n| n < 1 || n > 9_007_199_254_740_991)
        {
            return Err(ExecutionError::new(
                "invalid_tool_arguments",
                "maxResults must be a positive safe integer",
            ));
        }
        if self
            .max_bytes
            .is_some_and(|n| n == 0 || n > crate::protocol::MAX_FRAME_BYTES / 2)
        {
            return Err(ExecutionError::new(
                "invalid_tool_arguments",
                "maxBytes must be positive and fit the protocol output budget",
            ));
        }
        Ok(())
    }
    fn recursive_scope(&self) -> bool { self.recursive.unwrap_or(self.search) }
    pub fn params(&self, binding: &ToolBinding, context: &ToolExecutionContext) -> Value {
        let mut params = self.query_params(binding);
        params["jobId"] = json!(context.operation_id);
        params
    }
    fn query_params(&self, binding: &ToolBinding) -> Value {
        let recursive = self.recursive.unwrap_or(self.search);
        let mut params = json!({"workspaceId":binding.workspace_id,
            "lane":"foreground","operation":if self.search {"search"} else {"list"},
            "paths":self.paths.clone().unwrap_or_else(|| vec![String::new()]),
            "maxResults":self.max_results.unwrap_or(100).saturating_add(1).min(9_007_199_254_740_991),"includeHidden":self.include_hidden.unwrap_or(true),
            "excludeDirectories":self.exclude_directories.clone().unwrap_or_else(|| if recursive {vec![".git".into(),"node_modules".into(),".worktrees".into()]} else {vec![]}),
            "respectGitignore":self.respect_gitignore.unwrap_or(recursive),
            "includeRevisions":self.include_revisions.unwrap_or(false),
            "immediate":!recursive,"paged":true});
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
        if let Some(value) = &self.queries {
            params["queries"] = json!(value);
        }
        params["pathsOnly"] = json!(self.format.as_deref() == Some("paths"));
        if let Some(value) = self.before {
            params["before"] = json!(value);
        }
        if let Some(value) = self.after {
            params["after"] = json!(value);
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
    fn query_identity(&self, binding: &ToolBinding) -> String {
        let mut query = self.query_params(binding);
        let fields = query.as_object_mut().expect("query object");
        for field in [
            "maxResults",
            "startAfterPath",
            "startAfterLine",
            "startAfterRevision",
        ] {
            fields.remove(field);
        }
        query["resourceOwner"] = json!(binding.resource_owner);
        query["format"] = json!(self.format.as_deref().unwrap_or("lines"));
        hex::encode(Sha256::digest(query.to_string().as_bytes()))
    }
    pub(super) fn validate_source(&self, binding: &ToolBinding) -> Result<(), ExecutionError> {
        if let Some(cursor) = &self.cursor {
            if decode_cursor(cursor)?.query != self.query_identity(binding) {
                return Err(ExecutionError::new("invalid_tool_arguments", "File query cursor belongs to different filters or source. Keep the original query or omit cursor to restart."));
            }
        }
        Ok(())
    }
    fn next_cursor(&self, binding: &ToolBinding, page: &Value, cursor: u64) -> String {
        URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&ListCursor {
                version: 2,
                query: self.query_identity(binding),
                job_id: page["jobId"].as_str().expect("compute identity").into(),
                cursor,
                epoch: page["kernelEpoch"].as_str().expect("compute epoch").into(),
            })
            .expect("cursor serialization"),
        )
    }
}

fn merge_windows(records: Vec<Value>) -> Vec<Value> {
    let mut windows = Vec::<Value>::new();
    for record in records {
        if record["kind"] != "hit" {
            windows.push(record);
            continue;
        }
        let data = &record["data"];
        let line = data["line"].as_u64().expect("search line");
        let before = data["before"].as_array().cloned().unwrap_or_default();
        let after = data["after"].as_array().cloned().unwrap_or_default();
        let start = line - before.len() as u64;
        let end = line + after.len() as u64;
        let lines = before
            .into_iter()
            .chain(std::iter::once(data["preview"].clone()))
            .chain(after)
            .collect::<Vec<_>>();
        let mut matched = json!({"line":line,"column":data["column"]});
        if data.get("queryIndices").is_some() {
            matched["queryIndices"] = data["queryIndices"].clone();
        }
        if let Some(previous) = windows.last_mut().filter(|previous| {
            previous["kind"] == "window"
                && previous["path"] == record["path"]
                && previous["revision"] == record["revision"]
                && previous["data"]["endLine"]
                    .as_u64()
                    .is_some_and(|last| start <= last.saturating_add(1))
        }) {
            let last = previous["data"]["endLine"].as_u64().unwrap();
            previous["data"]["lines"].as_array_mut().unwrap().extend(
                lines
                    .into_iter()
                    .skip(last.saturating_add(1).saturating_sub(start) as usize),
            );
            previous["data"]["endLine"] = json!(end.max(last));
            previous["data"]["matches"]
                .as_array_mut()
                .unwrap()
                .push(matched);
        } else {
            windows.push(
                json!({"kind":"window","path":record["path"],"revision":record["revision"],
                "data":{"startLine":start,"endLine":end,"lines":lines,"matches":[matched]}}),
            );
        }
    }
    windows
}

impl KernelResourceClient {
    fn observe_query(
        &self,
        binding: &ToolBinding,
        context: &ToolExecutionContext,
        job_id: &str,
        cancel: &CancellationToken,
    ) -> Result<ComputeWatch, ResourceFailure> {
        let (reply, watch) = mpsc::channel();
        self.call(
            binding,
            context,
            ResourceOperation::ObserveCompute {
                job_id: job_id.into(),
                reply,
            },
            false,
            cancel,
        )?;
        watch.recv().map_err(|_| ResourceFailure {
            error: KernelError::Storage("compute owner disconnected before observation".into()),
            dispatched: true,
        })
    }
    fn query_control(
        &self,
        binding: &ToolBinding,
        context: &ToolExecutionContext,
        job_id: &str,
        method: &'static str,
        cursor: u64,
        cancel: &CancellationToken,
    ) -> Result<Value, ResourceFailure> {
        self.call(
            binding,
            context,
            ResourceOperation::ComputeControl {
                job_id: job_id.into(),
                kernel_epoch: None,
                method,
                cursor,
            },
            false,
            cancel,
        )
    }
    // Cancellation retains ownership until the exact worker has stopped.
    fn finish_query(
        &self,
        binding: &ToolBinding,
        context: &ToolExecutionContext,
        job_id: &str,
        stop: bool,
        watch: &ComputeWatch,
    ) -> Result<(), ResourceFailure> {
        let cleanup = CancellationToken::default();
        if stop {
            self.query_control(binding, context, job_id, "compute.cancel", 0, &cleanup)?;
            watch.wait(0, true, &cleanup);
        }
        self.query_control(binding, context, job_id, "compute.release", 0, &cleanup)
            .map(|_| ())
    }
    pub(super) fn query(
        &self,
        binding: &ToolBinding,
        context: &ToolExecutionContext,
        args: &FileQueryArgs,
        cancel: &CancellationToken,
    ) -> Result<Value, ResourceFailure> {
        let continuation = args
            .cursor
            .as_deref()
            .map(|value| decode_cursor(value).expect("validated cursor"));
        let job_id = continuation
            .as_ref()
            .map(|value| value.job_id.as_str())
            .unwrap_or(&context.operation_id);
        let mut cursor = continuation.as_ref().map_or(0, |value| value.cursor);
        let mut page = if let Some(previous) = &continuation {
            let page = self
                .call(
                    binding,
                    context,
                    ResourceOperation::ComputeControl {
                        job_id: job_id.into(),
                        kernel_epoch: Some(previous.epoch.clone()),
                        method: "compute.read",
                        cursor,
                    },
                    false,
                    cancel,
                )
                .map_err(|error| ResourceFailure {
                    error: KernelError::Operation(format!(
                        "File query continuation is unavailable: {}. Restart without cursor.",
                        error.error
                    )),
                    dispatched: error.dispatched,
                })?;
            if page["kernelEpoch"].as_str() != Some(&previous.epoch) {
                return Err(ResourceFailure {
                    error: KernelError::Operation(
                        "File query cursor belongs to an earlier kernel. Restart without cursor."
                            .into(),
                    ),
                    dispatched: true,
                });
            }
            page
        } else {
            self.call(
                binding,
                context,
                ResourceOperation::FileQuery(args.clone()),
                false,
                cancel,
            )?
        };
        // The original job/grant remains the owner across tool calls.
        let watch =
            match self.observe_query(binding, context, job_id, &CancellationToken::default()) {
                Ok(watch) => watch,
                Err(error) => {
                    let _ = self.query_control(
                        binding,
                        context,
                        job_id,
                        "compute.cancel",
                        0,
                        &CancellationToken::default(),
                    );
                    return Err(error);
                }
            };
        let mut records = Vec::new();
        let mut query_errors = Vec::new();
        let mut bytes = 2usize;
        let budget = args.max_bytes.unwrap_or(65536);
        let result = (|| loop {
            if cancel.is_cancelled() {
                return Err(ResourceFailure {
                    error: KernelError::Cancelled,
                    dispatched: true,
                });
            }
            let mut limited = false;
            for record in page["records"].as_array().into_iter().flatten() {
                let size = serde_json::to_vec(record)
                    .map_err(|error| ResourceFailure {
                        error: error.into(),
                        dispatched: true,
                    })?
                    .len()
                    + 1;
                if (bytes.saturating_add(size) > budget
                    && (!records.is_empty() || !query_errors.is_empty()))
                    || records.len() >= args.max_results.unwrap_or(100) as usize
                {
                    limited = true;
                    break;
                }
                // Cursor counts every raw record, including per-expression failures.
                cursor += 1;
                bytes += size;
                if record["kind"] == "query-error" {
                    query_errors.push(record["data"].clone());
                    continue;
                }
                let mut record = record.clone();
                if !args.search {
                    if record["revision"] == "" {
                        record.as_object_mut().unwrap().remove("revision");
                    }
                    if record["data"]["state"]["objectHash"] == "" {
                        record["data"]["state"]
                            .as_object_mut()
                            .unwrap()
                            .remove("objectHash");
                    }
                }
                records.push(record);
            }
            let terminal = page["scanComplete"] == true;
            let drained = page["endCursor"].as_u64() == Some(cursor);
            limited |= records.len() >= args.max_results.unwrap_or(100) as usize
                || (bytes >= budget && (!records.is_empty() || !query_errors.is_empty()));
            if page["status"] == "failed" || page["status"] == "cancelled" {
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
            if limited || (terminal && drained) {
                let next =
                    (!(terminal && drained)).then(|| args.next_cursor(binding, &page, cursor));
                let output = json!({
                    "source":page["source"],
                    "status":if next.is_some() {"partial"} else {page["status"].as_str().unwrap_or("failed")},
                    "records":if args.format.as_deref()==Some("windows") {merge_windows(records)} else {records},
                    "queryErrors":query_errors,"scannedFiles":page["scannedFiles"],
                    "scope":{"paths":args.paths.clone().unwrap_or_else(||vec![String::new()]),"globs":args.globs,
                        "recursive":args.recursive_scope(),
                        "includeHidden":args.include_hidden.unwrap_or(true),"respectGitignore":args.respect_gitignore.unwrap_or(args.recursive.unwrap_or(args.search)),
                        "excludeDirectories":args.query_params(binding)["excludeDirectories"]},
                    "format":args.format.as_deref().unwrap_or("lines"),
                    "truncated":next.is_some() || page["status"]=="partial",
                    "scanComplete":terminal && drained && matches!(page["status"].as_str(),Some("ready"|"empty")),
                    "pageComplete":!limited || (terminal && drained),
                    "nextCursor":next,
                    "message":if next.is_some() {json!("Continue the original query with nextCursor and the same filters; page size may change. Counts describe observed results, not a whole-source total.")}
                        else {page["message"].clone()}
                });
                let mut output = output;
                if !args.search {
                    let paths = args.paths.clone().unwrap_or_else(|| vec![String::new()]);
                    if paths.len() > 1 {
                        let records = output["records"].as_array().expect("query records");
                        output["groups"] = json!(paths.iter().map(|path| {
                            let indices = records.iter().enumerate().filter_map(|(index, record)| {
                                let found = record["path"].as_str()?;
                                (path.is_empty() || found == path || found.strip_prefix(path).is_some_and(|tail| tail.starts_with('/'))).then_some(index)
                            }).collect::<Vec<_>>();
                            let errors = indices.iter().any(|index| records[*index]["kind"] == "error");
                            let count = indices.iter().filter(|index| records[**index]["kind"] == "entry").count();
                            json!({"path":path,"returnedEntries":count,"recordIndices":indices,
                                "status":if errors {"error"} else if count > 0 {"entries"}
                                    else if output["scanComplete"] == true && continuation.is_none() {"empty"} else {"no_entries_on_this_page"}})
                        }).collect::<Vec<_>>());
                        output["groupNote"] = json!("Groups refer to records by zero-based recordIndices. Counts describe this page. A group with no entries on this page may be outside this page or filtered; continue nextCursor or query that path alone. Only empty proves a completed initial query found no entries in that scope.");
                    }
                    output["scope"]["policy"] = json!(if args.recursive_scope() && args.respect_gitignore == Some(false) {
                        "Recursive discovery has gitignore filtering disabled. The other filters shown here still apply."
                    } else if args.recursive_scope() {
                        "Recursive discovery follows the filters shown here. Explicit paths remain reachable through parent ignore rules; rules inside the selected directory still apply."
                    } else {
                        "Immediate directory browsing includes hidden and ignored entries unless filters are requested. Recursive discovery defaults to respecting gitignore."
                    });
                }
                if next.is_none() && output["records"].as_array().is_some_and(Vec::is_empty) && output["queryErrors"].as_array().is_some_and(Vec::is_empty) {
                    output["emptyResult"] = empty_result_explanation(&args, &output["scope"]);
                    output["message"] = output["emptyResult"]["meaning"].clone();
                }
                if next.is_none() {
                    self.finish_query(binding, context, job_id, false, &watch)?;
                }
                return Ok(output);
            }
            // A read acknowledges consumed records and resumes a paused producer
            // only after its buffered page has drained.
            if page["records"].as_array().is_none_or(Vec::is_empty)
                && !watch.wait(cursor, false, cancel)
            {
                return Err(ResourceFailure {
                    error: KernelError::Cancelled,
                    dispatched: true,
                });
            }
            page = self.query_control(binding, context, job_id, "compute.read", cursor, cancel)?;
        })();
        if result.is_err() {
            let _ = self.finish_query(binding, context, job_id, true, &watch);
        }
        result
    }
}

/// Zero results are a fact about this exact scope and these filters, never about the whole
/// source. Each widening is an ordinary argument of the same tool; nothing is rescanned here.
fn empty_result_explanation(args: &FileQueryArgs, scope: &Value) -> Value {
    let mut widen = Vec::new();
    if scope["respectGitignore"] == true {
        widen.push(json!({"argument":"respectGitignore","value":false,"effect":"also search files excluded by ignore rules"}));
    }
    if scope["excludeDirectories"].as_array().is_some_and(|names| !names.is_empty()) {
        widen.push(json!({"argument":"excludeDirectories","value":[],"effect":"also enter the default excluded directories","excluded":scope["excludeDirectories"]}));
    }
    if scope["includeHidden"] == false {
        widen.push(json!({"argument":"includeHidden","value":true,"effect":"also include hidden entries"}));
    }
    if !args.recursive_scope() {
        widen.push(json!({"argument":"recursive","value":true,"effect":"also include descendants of the selected directories"}));
    }
    if args.globs.as_ref().is_some_and(|globs| !globs.is_empty()) {
        widen.push(json!({"argument":"globs","value":null,"effect":"remove the path pattern filter"}));
    }
    widen.push(json!({"argument":"paths","effect":"name a specific file or directory; explicit paths are read even when ignored"}));
    json!({"meaning":"No match in the searched scope with these filters. Paths outside the scope or removed by a filter were not searched, so this does not show they lack a match.",
        "filtersApplied":widen.len() > 1,"widen":widen})
}

pub(super) fn schema(search: bool) -> Value {
    let mut schema = json!({"type":"object","additionalProperties":false,
        "description":if search {"Search text in the selected source. Supply query or queries; a batch scans each file once and reports matching queryIndices. Returns exact paths, revisions and line positions. Use nextCursor with the same filters to continue; page size may change."} else {"List directories in the selected source. Omit paths for the root. Multiple directory roots contribute entries in turns; groups identify each path's entries on this page. Pass nextCursor as cursor with the same filters to continue; recursive includes descendants. Revisions are captured only when includeRevisions is true."},
        "properties":{
            "paths":{"type":"array","items":{"type":"string"},"description":"Explicit files or directories, including ignored paths."},
            "globs":{"type":"array","items":{"type":"string"}},
            "query":{"type":"string","description":if search {"Nonempty literal text, or regex when fixedStrings is false"} else {"Optional case-insensitive path substring"}},
            "fixedStrings":{"type":"boolean","default":true},
            "ignoreCase":{"type":"boolean","default":false},
            "recursive":{"type":"boolean","default":search},
            "includeHidden":{"type":"boolean","default":true},
            "excludeDirectories":{"type":"array","items":{"type":"string"},"description":"Directory names to skip within selected paths. Recursive queries default to .git, node_modules and .worktrees; non-recursive queries default to none."},
            "respectGitignore":{"type":"boolean","description":"Apply ignore rules within selected paths; defaults to recursive."},
            "includeRevisions":{"type":"boolean","default":false},
            "cursor":{"type":"string","description":"Opaque continuation from nextCursor; pass it unchanged with the original source, paths and filters. Page size may change. Changed search continuation files require a new query."},
            "maxResults":{"type":"integer","minimum":1,"maximum":9_007_199_254_740_991i64,"default":100},
            "maxBytes":{"type":"integer","minimum":1,"maximum":crate::protocol::MAX_FRAME_BYTES / 2,"default":65536}},
        "required":Vec::<String>::new()});
    if search {
        schema["properties"]["format"] = json!({"type":"string","enum":["paths","lines","windows"],"default":"lines","description":"Return matching files, matching lines, or merged overlapping context windows. Pagination counts original matches; scope and completeness remain explicit."});
        schema["properties"]["queries"] = json!({"type":"array","minItems":1,"items":{"type":"string","minLength":1},"description":"Expressions to search together; queryIndices refer to their zero-based positions. Mutually exclusive with query."});
        for name in ["before", "after"] {
            schema["properties"][name] = json!({"type":"integer","minimum":0,"description":"Context lines adjacent to each match."});
        }
        schema["oneOf"] = json!([{"required":["query"],"not":{"required":["queries"]}},{"required":["queries"],"not":{"required":["query"]}}]);
    }
    schema
}
