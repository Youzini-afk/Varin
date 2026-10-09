//! Durable process admission and writer receipts, sharing the kernel catalog.
//! Command arguments and environment are hashed, never persisted or logged.
use super::*;
use crate::process::{self, CHUNK_BYTES};
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, KernelError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| KernelError::Operation(format!("process {key} is required")))
}
fn unsigned(value: &Value, key: &str, default: u64) -> Result<u64, KernelError> {
    match value.get(key) {
        None => Ok(default),
        Some(value) => value
            .as_u64()
            .filter(|v| *v <= 9_007_199_254_740_991)
            .ok_or_else(|| {
                KernelError::Operation(format!("process {key} must be a nonnegative safe integer"))
            }),
    }
}
fn contains(parent: &Path, child: &Path) -> bool {
    #[cfg(windows)]
    {
        let parent = parent
            .to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase();
        let child = child
            .to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase();
        child == parent || child.starts_with(&(parent + "\\"))
    }
    #[cfg(not(windows))]
    {
        child.starts_with(parent)
    }
}
impl Storage {
    pub(crate) fn set_process_subscriptions(&mut self, subscriptions: process::subscriptions::ProcessSubscriptions) {
        self.processes.set_subscriptions(subscriptions);
    }

    pub(crate) fn set_process_controls(&mut self, controls: process::ProcessControlRegistry) {
        self.processes.set_controls(controls);
    }

    pub(crate) fn set_process_terminal_sender(&mut self, sender: std::sync::mpsc::Sender<process::ProcessTerminal>) {
        self.processes.set_terminal_sender(sender);
    }
    /// Replay only the native Catalog's unresolved process IDs. Completed Storage rows can
    /// precede Catalog receipt delivery, so this must not filter solely on writerActive.
    pub(crate) fn replay_process_terminals(&self, process_ids: &[String]) -> Result<(), KernelError> {
        for id in process_ids {
            let Some(record) = self.process_record(id)? else { continue; };
            let epoch = string(&record, "kernelEpoch")?;
            if let Some(receipt) = process::read_receipt(&self.root, id, epoch)? {
                self.processes.replay_terminal(id, epoch, receipt);
            }
        }
        Ok(())
    }

    fn process_record(&self, id: &str) -> Result<Option<Value>, KernelError> {
        let raw: Option<String> = self
            .conn
            .query_row(
                "SELECT status_json FROM process_records WHERE process_id=?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        raw.map(|value| serde_json::from_str(&value).map_err(Into::into))
            .transpose()
    }
    fn persist_process_record(&self, id: &str, value: &Value) -> Result<(), KernelError> {
        let raw = serde_json::to_string(value)?;
        self.conn.execute(
            "UPDATE process_records SET status_json=?2 WHERE process_id=?1 AND status_json<>?2",
            params![id, raw],
        )?;
        Ok(())
    }
    fn refresh_process_record(&mut self, id: &str) -> Result<Option<Value>, KernelError> {
        let Some(mut record) = self.process_record(id)? else {
            return Ok(None);
        };
        if record["status"] == "released" {
            return Ok(Some(record));
        }
        if let Some(observed) = self.processes.observation(id)? {
            for (key, value) in observed.as_object().into_iter().flatten() {
                record[key] = value.clone();
            }
        } else {
            // Retained output has its own durability evidence. Reopening bytes never proves
            // that an old process tree stopped; reconcile writer state independently below.
            let output=match self.processes.restore_output(&self.root,id,string(&record,"kernelEpoch")?) {
                Ok(output)=>output,
                Err(error)=>json!({"outputAvailable":false,"outputComplete":false,"outputError":format!("retained output cannot be reopened: {error}")}),
            };
            for (key,value) in output.as_object().into_iter().flatten(){record[key]=value.clone();}
            if record["writerActive"].as_bool() != Some(false) {
                let epoch = string(&record, "kernelEpoch")?;
                let receipt = process::read_receipt(&self.root, id, epoch)?;
                #[cfg(windows)]
                let gone = process::platform::prior_tree_gone(&process::job_name(&self.root, id))?;
                #[cfg(unix)]
                let gone = receipt.is_some();
                if gone {
                    if let Some(receipt) = receipt {
                        self.processes.replay_terminal(id, epoch, receipt.clone());
                        for key in ["status", "pid", "exitCode", "signal", "reason"] {
                            record[key] = receipt[key].clone();
                        }
                    } else {
                        record["status"] = json!("exited");
                        record["reason"]=json!("prior native Job is gone; command is not replayed and exit code is unknown");
                    }
                    record["writerActive"] = json!(false);
                } else {
                    record["status"] = json!("unknown");
                    record["reason"]=json!("prior process tree has no confirmed exit receipt; execution directory is retained");
                }
            }
        }
        self.persist_process_record(id, &record)?;
        Ok(Some(record))
    }
    pub(crate) fn refresh_process_records(&mut self) -> Result<(), KernelError> {
        let ids = self
            .conn
            .prepare("SELECT process_id FROM process_records WHERE json_extract(status_json, '$.writerActive') = 1")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        for id in ids {
            self.refresh_process_record(&id)?;
        }
        Ok(())
    }
    pub(super) fn revoke_processes_for_grant(
        &mut self,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let ids = self.conn.prepare("SELECT process_id FROM process_records WHERE grant_id=?1 AND json_extract(status_json, '$.writerActive') = 1")?
            .query_map(params![grant_id], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        let mut pending = Vec::new();
        let mut failures = Vec::new();
        for id in ids {
            if let Some(record) = self.refresh_process_record(&id)? {
                if record["writerActive"] == false {
                    continue;
                }
            }
            if let Err(error) = self.processes.kill(&id, true) {
                failures.push(json!({"processId":id,"reason":error.to_string()}));
            }
            pending.push(id);
        }
        // Revocation removes permission immediately, never pretending a kill
        // request is an exit receipt. Maintenance can still inspect/retry.
        Ok(json!({"pendingProcesses":pending,"processStopFailures":failures}))
    }
    fn authorize_process(
        &self,
        id: &str,
        workspace: &str,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let row: Option<(String, String, String)> = self
            .conn
            .query_row(
                "SELECT workspace_id,grant_id,cwd FROM process_records WHERE process_id=?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((owner, actor, _)) = row else {
            return Err(KernelError::Operation("process not found".into()));
        };
        if owner != workspace
            || (actor != grant.grant_id && !grant.capabilities.contains("process.maintenance"))
        {
            return Err(KernelError::Authorization(
                "process belongs to another workspace or actor".into(),
            ));
        }
        self.process_record(id)?
            .ok_or_else(|| KernelError::Operation("process receipt disappeared".into()))
    }
    fn spawn_process(&mut self, params_value: &Value, grant: &Grant) -> Result<Value, KernelError> {
        self.check_cancelled()?;
        let id = string(params_value, "processId")?;
        if id.is_empty() || id.len() > 200 {
            return Err(KernelError::Operation("invalid process identity".into()));
        }
        let workspace = string(params_value, "workspaceId")?;
        let root_id = string(params_value, "rootId")?;
        let root = self.registered_file_root(root_id, grant)?.clone();
        if root.owning_workspace_id != workspace {
            return Err(KernelError::Authorization(
                "process root workspace mismatch".into(),
            ));
        }
        let cwd = self.resolve_file_resource(root_id, string(params_value, "cwd")?, grant, true)?;
        let cwd = fs::canonicalize(&cwd.absolute)?;
        if !contains(&root.canonical_root, &cwd) || !cwd.is_dir() {
            return Err(KernelError::Authorization(
                "process cwd escaped the registered directory".into(),
            ));
        }
        let canonical_relative = cwd
            .strip_prefix(&root.canonical_root)
            .map_err(|_| KernelError::Authorization("process cwd identity mismatch".into()))?
            .to_string_lossy()
            .replace('\\', "/");
        if !path_allowed(grant, &canonical_relative) {
            return Err(KernelError::Authorization(
                "process cwd is outside grant scope".into(),
            ));
        }
        let mode = string(params_value, "mode")?;
        if !matches!(mode, "pty" | "pipe") {
            return Err(KernelError::Operation(
                "process mode must be pty or pipe".into(),
            ));
        }
        if let Some(raw) = params_value
            .get("windowsRawArguments")
            .and_then(Value::as_str)
        {
            if !cfg!(windows) || mode != "pipe" {
                return Err(KernelError::Operation(
                    "windowsRawArguments requires a Windows pipe process".into(),
                ));
            }
            if raw.contains('\0') {
                return Err(KernelError::Operation(
                    "process windowsRawArguments contains NUL".into(),
                ));
            }
        }
        let command = string(params_value, "command")?;
        if command.is_empty() || command.contains('\0') {
            return Err(KernelError::Operation(
                "process command is empty or contains NUL".into(),
            ));
        }
        let cols = unsigned(params_value, "cols", 80)?;
        let rows = unsigned(params_value, "rows", 24)?;
        if !(1..=1000).contains(&cols) || !(1..=500).contains(&rows) {
            return Err(KernelError::Operation("invalid PTY dimensions".into()));
        }
        let mut identity = params_value.clone();
        identity
            .as_object_mut()
            .map(|value| value.remove("__pathScopes"));
        let hash = hash_json(&identity)?;
        if let Some(record) = self.process_record(id)? {
            self.authorize_process(id, workspace, grant)?;
            let expected: String = self.conn.query_row(
                "SELECT params_hash FROM process_records WHERE process_id=?1",
                params![id],
                |row| row.get(0),
            )?;
            if hash != expected {
                return Err(KernelError::Operation(
                    "processId was reused with different parameters".into(),
                ));
            }
            // Even after release/restart, a command identity never starts twice.
            return Ok(self.refresh_process_record(id)?.unwrap_or(record));
        }
        self.assert_file_lease(
            grant,
            root_id,
            &[FileLeaseResource {
                path: canonical_relative,
                subtree: true,
            }],
            None,
        )?;
        let record = json!({"processId":id,"kernelEpoch":grant.kernel_epoch,"workspaceId":workspace,
            "cwd":cwd,"mode":mode,"status":"starting","pid":null,"exitCode":null,"signal":null,
            "reason":null,"writerActive":true,"outputAvailable":false});
        let job_name = process::job_name(&self.root, id);
        self.conn.execute("INSERT INTO process_records(process_id,workspace_id,execution_workspace_id,grant_id,kernel_epoch,cwd,job_name,params_hash,status_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![id,workspace,root.execution_workspace_id,grant.grant_id,grant.kernel_epoch,cwd.to_string_lossy(),job_name,hash,serde_json::to_string(&record)?])?;
        let receipt_path = process::receipt_path(&self.root, id);
        fs::create_dir_all(receipt_path.parent().ok_or_else(|| {
            KernelError::Storage("process receipt directory is unavailable".into())
        })?)?;
        sync_directory(&self.root)?;
        if let Err(error) = self.check_cancelled() {
            let mut cancelled = record;
            cancelled["status"] = json!("failed");
            cancelled["writerActive"] = json!(false);
            cancelled["reason"] = json!("process launch cancelled before native spawn");
            self.persist_process_record(id, &cancelled)?;
            return Err(error);
        }
        if let Err(error)=self.processes.spawn(id,json!({"processId":id,"kernelEpoch":grant.kernel_epoch,
            "receiptPath":receipt_path,"jobName":job_name,"cwd":cwd,"command":command,"args":params_value["args"],
            "windowsRawArguments":params_value["windowsRawArguments"],
            "env":params_value["env"],"mode":mode,"cols":cols,"rows":rows,"runId":params_value["__runId"]})){
            let mut failed=record;
            failed["status"]=json!("failed");failed["writerActive"]=json!(false);failed["reason"]=json!(error.to_string());
            self.persist_process_record(id,&failed)?;
            return Err(error);
        }
        self.refresh_process_record(id)?
            .ok_or_else(|| KernelError::Storage("process intent disappeared".into()))
    }
    /// Exact read-only delegation for a Catalog-validated process of the same Run.
    /// The current grant was authorized by the Storage actor; the original grant is never
    /// revived or substituted as the caller. No persisted observer or control authority exists.
    pub(crate) fn observe_run_process(&mut self, method: &str, params_value: &Value,
        grant: &Grant, root_id: Option<&str>, authorize_only: bool) -> Result<Value, KernelError> {
        if !matches!(method,"process.inspect"|"process.read") {
            return Err(KernelError::Authorization("process delegation is observation-only".into()));
        }
        let id=string(params_value,"processId")?;
        let workspace=string(params_value,"workspaceId")?;
        let actor:String=self.conn.query_row("SELECT grant_id FROM process_records WHERE process_id=?1",[id],|row|row.get(0))?;
        let original=self.load_grant(&actor)?;
        if original.revoked || grant.revoked || original.run_id.is_none() || original.thread_id.is_none()
            || original.run_id != grant.run_id || original.thread_id != grant.thread_id
            || original.owning_workspace.as_deref() != Some(workspace)
            || original.owning_workspace != grant.owning_workspace || original.execution_workspace != grant.execution_workspace
            || original.storage_identity != grant.storage_identity || original.host_id != grant.host_id
            || original.path_scopes != grant.path_scopes || !original.capabilities.contains("process") {
            return Err(KernelError::Authorization("original process authority was revoked or does not match this Run/source".into()));
        }
        let root=self.registered_file_root(root_id.ok_or_else(||KernelError::Authorization("process observation requires its physical source root".into()))?,grant)?;
        let cwd:String=self.conn.query_row("SELECT cwd FROM process_records WHERE process_id=?1",[id],|row|row.get(0))?;
        if root.owning_workspace_id!=workspace || !contains(&root.canonical_root,Path::new(&cwd)) {
            return Err(KernelError::Authorization("process observation physical source changed".into()));
        }
        if authorize_only { return Ok(Value::Null); }
        let record=self.refresh_process_record(id)?.ok_or_else(||KernelError::Operation("process disappeared".into()))?;
        if method == "process.inspect" { return Ok(record); }
        self.read_process_output(id,params_value,record)
    }
    fn read_process_output(&mut self,id:&str,params_value:&Value,record:Value)->Result<Value,KernelError> {
        if record["outputAvailable"].as_bool()!=Some(true) {
            return Err(KernelError::Storage(record["outputError"].as_str().unwrap_or("process output is unavailable").into()));
        }
        let cursor=unsigned(params_value,"cursor",0)?;
        let limit=unsigned(params_value,"maxBytes",CHUNK_BYTES as u64)?;
        if limit==0 || limit>CHUNK_BYTES as u64 { return Err(KernelError::Operation("invalid process read chunk size".into())); }
        let mut result=self.processes.read(id,cursor,limit as usize)?;
        result["process"]=record;
        Ok(result)
    }
    pub(super) fn dispatch_process(
        &mut self,
        method: &str,
        params_value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let workspace = string(params_value, "workspaceId")?;
        if method == "process.spawn" {
            return self.spawn_process(params_value, grant);
        }
        if method == "process.list" {
            if !grant.capabilities.contains("process.maintenance") {
                return Err(KernelError::Authorization(
                    "process listing requires Host process maintenance".into(),
                ));
            }
            let root = self
                .registered_file_root(string(params_value, "rootId")?, grant)?
                .clone();
            self.refresh_process_records()?;
            let cursor = i64::try_from(unsigned(params_value, "cursor", 0)?).map_err(|_| {
                KernelError::Operation("process list cursor exceeds SQLite rowid range".into())
            })?;
            let page_size = unsigned(params_value, "pageSize", 128)?;
            if !(1..=256).contains(&page_size) {
                return Err(KernelError::Operation(
                    "invalid process list page size".into(),
                ));
            }
            let records = self.conn.prepare("SELECT rowid,status_json FROM process_records WHERE workspace_id=?1 AND rowid>?2 ORDER BY rowid LIMIT ?3")?
                .query_map(params![workspace,cursor,page_size as i64+1], |row| Ok((row.get::<_, i64>(0)?,row.get::<_, String>(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            let mut visible = Vec::new();
            let mut last = cursor;
            let mut bytes = 0;
            let mut more = records.len() > page_size as usize;
            for (row_id, raw) in records.into_iter().take(page_size as usize) {
                if bytes + raw.len() > MAX_FRAME_BYTES / 2 {
                    more = true;
                    break;
                }
                let value: Value = serde_json::from_str(&raw)?;
                let cwd = Path::new(string(&value, "cwd")?);
                if contains(&root.canonical_root, cwd) || contains(cwd, &root.canonical_root) {
                    bytes += raw.len();
                    visible.push(value);
                }
                last = row_id;
            }
            return Ok(json!({"processes":visible,"nextCursor":more.then_some(last)}));
        }
        let id = string(params_value, "processId")?;
        let authorized = self.authorize_process(id, workspace, grant)?;
        let record = self.refresh_process_record(id)?.unwrap_or(authorized);
        if method == "process.inspect" {
            return Ok(record);
        }
        if matches!(method,"process.subscribe"|"process.read") && record["outputAvailable"].as_bool()!=Some(true) {
            return Err(KernelError::Storage(record["outputError"].as_str().unwrap_or("process output is unavailable").into()));
        }
        if method == "process.subscribe" {
            return self.processes.subscribe(string(params_value,"subscriptionId")?,id,&grant.grant_id,&grant.kernel_epoch,
                unsigned(params_value,"cursor",0)?,record);
        }
        if method == "process.release" {
            if record["writerActive"].as_bool() != Some(false) {
                return Err(KernelError::Operation(
                    "process is in use or exit is unconfirmed".into(),
                ));
            }
            let output_path=process::output_path(&self.root,id);
            let marker_path=process::output_marker_path(&self.root,id);
            self.processes.release(id,||{
                for path in [output_path,marker_path.clone(),marker_path.with_extension("complete.tmp")] {
                    match fs::remove_file(path) {
                        Ok(())=>{},Err(error) if error.kind()==io::ErrorKind::NotFound=>{},Err(error)=>return Err(error.into()),
                    }
                }
                Ok(())
            })?;
            let mut record = record;
            record["status"] = json!("released");
            record["outputAvailable"] = json!(false);
            self.persist_process_record(id, &record)?;
            return Ok(record);
        }
        if record["kernelEpoch"].as_str() != Some(grant.kernel_epoch.as_str()) && method != "process.read" {
            return Err(KernelError::Authorization(
                "process handle belongs to a stale kernel epoch".into(),
            ));
        }
        match method {
            "process.read" => self.read_process_output(id,params_value,record),
            "process.write" => self.processes.write(
                id,
                unsigned(params_value, "sequence", 0)? as i64,
                string(params_value, "bytesBase64")?,
                params_value["eof"].as_bool().unwrap_or(false),
            ),
            "process.resize" => {
                if record["mode"] != "pty" {
                    return Err(KernelError::Operation(
                        "cannot resize a piped process".into(),
                    ));
                }
                let cols = unsigned(params_value, "cols", 0)?;
                let rows = unsigned(params_value, "rows", 0)?;
                if !(1..=1000).contains(&cols) || !(1..=500).contains(&rows) {
                    return Err(KernelError::Operation("invalid PTY dimensions".into()));
                }
                self.processes.resize(id, cols as u16, rows as u16)
            }
            "process.kill" => {
                if std::env::var("VARIN_KERNEL_FAIL_PROCESS_PHASE")
                    .ok()
                    .as_deref()
                    == Some("kill")
                {
                    return Err(KernelError::Operation(
                        "injected native process termination failure".into(),
                    ));
                }
                if record["writerActive"].as_bool() == Some(false) {
                    return Ok(json!({"requested":false,"exited":true}));
                }
                self.processes
                    .kill(id, params_value["force"].as_bool().unwrap_or(false))
            }
            _ => Err(KernelError::Operation("unknown process method".into())),
        }
    }
    pub(crate) fn shutdown_processes(&mut self) -> Result<(), KernelError> {
        let result = self.processes.shutdown();
        self.refresh_process_records()?;
        result
    }
    pub(super) fn assert_process_directory_idle(
        &mut self,
        target: &Path,
    ) -> Result<(), KernelError> {
        self.refresh_process_records()?;
        let records = self
            .conn
            .prepare("SELECT status_json FROM process_records")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        for raw in records {
            let record: Value = serde_json::from_str(&raw)?;
            if record["writerActive"].as_bool() != Some(false)
                && contains(target, Path::new(string(&record, "cwd")?))
            {
                return Err(KernelError::Operation(format!(
                    "process writer {} has not confirmed exit; directory is retained",
                    string(&record, "processId")?
                )));
            }
        }
        Ok(())
    }
}
