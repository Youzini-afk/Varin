//! File-only recovery uses the same before-images, file.apply receipts and journal as edits.
use super::*;
use crate::protocol_generated::KernelFileRecoveryParams;
use serde::{Deserialize, Serialize};
use varin_runtime::catalog::journal::JournalAnchor;

fn restored_file(file: &Value, status: &str) -> Result<Value, KernelError> {
    let mut result = json!({"path":file["path"],"status":status});
    if status == "applied" {
        let before: Value = serde_json::from_str(file["safetyJson"].as_str().ok_or_else(|| KernelError::Storage("Restore before state is missing".into()))?)?;
        let after: Value = serde_json::from_str(file["targetJson"].as_str().ok_or_else(|| KernelError::Storage("Restore target state is missing".into()))?)?;
        result["change"] = json!(if after["kind"] == "missing" { "deleted" } else if before["kind"] == "missing" { "created" } else { "updated" });
    }
    Ok(result)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecoveryPointsArgs {
    pub operation: Option<String>,
    pub point: Option<String>,
    pub paths: Option<Vec<String>>,
    pub cursor: Option<usize>,
    pub limit: Option<usize>,
    pub references: Option<bool>,
    pub operations: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileRestoreArgs {
    pub point: Option<String>,
    pub undo: Option<String>,
    pub paths: Option<Vec<String>>,
    pub overwrite_paths: Option<Vec<String>>,
    /// Host editor observations; omitted from the model's tool schema.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_paths: Option<BTreeMap<String, String>>,
}

#[derive(Clone)]
struct Change {
    checkpoint: String,
    sequence: i64,
    run: String,
    path: String,
    before: Value,
    after: Value,
    created_at: String,
    state: String,
    source_run: String,
}

fn round_ref(run: &str) -> String {
    format!("r{}", &hex::encode(Sha256::digest(run.as_bytes()))[..12])
}

impl Storage {
    pub(crate) fn recovery_statistics(
        &self,
        input: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let workspace = self.recovery_workspace(input, &grant.grant_id)?;
        let (objects,bytes):(i64,i64)=self.conn.query_row(
            "SELECT COUNT(*),COALESCE(SUM(byte_length),0) FROM blobs WHERE hash IN (SELECT DISTINCT object_hash FROM recovery_refs WHERE workspace_id=?1)",
            [&workspace],|r|Ok((r.get(0)?,r.get(1)?)))?;
        Ok(json!({"objectCount":objects,"byteLength":bytes,"scope":"workspace"}))
    }
    pub(crate) fn dispatch_file_recovery(
        &mut self,
        method: &str,
        input: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        // Authorization has already attached private scope metadata. Decode
        // only the public file parameters; path checks still use the grant.
        let params: KernelFileRecoveryParams = super::file_resources::parse_file_params(input)?;
        let args = serde_json::to_value(&params.arguments)?;
        let journal = input
            .get("journal")
            .map(|value| serde_json::from_value::<JournalAnchor>(value.clone()))
            .transpose()?;
        if journal
            .as_ref()
            .is_some_and(|anchor| anchor.thread_id != params.thread_id)
        {
            return Err(KernelError::Authorization(
                "Recovery journal belongs to a different conversation".into(),
            ));
        }
        let mode =
            serde_json::from_value(json!(params.source_mode.as_deref().unwrap_or("live_root")))?;
        match method {
            "recovery.points" => self.file_recovery_points(
                &params.workspace_id,
                &params.root_id,
                &params.thread_id,
                &serde_json::from_value(args)?,
                journal.as_ref(),
                grant,
            ),
            "recovery.files.restore" => self.restore_recorded_files(
                &params.workspace_id,
                &params.root_id,
                &params.thread_id,
                params.operation_id.as_deref().ok_or_else(|| {
                    KernelError::Operation("Restore operation is required".into())
                })?,
                &serde_json::from_value(args)?,
                journal.as_ref(),
                mode,
                grant,
                &mut false,
            ),
            "recovery.point.create" => self.create_named_file_point(&params, &args, grant),
            "recovery.point.release" => self.release_file_point(&params, &args, grant),
            _ => Err(KernelError::Protocol("Unknown file recovery method".into())),
        }
    }

    fn named_file_points(
        &self,
        workspace: &str,
        root: &str,
        thread: &str,
        grant: &Grant,
    ) -> Result<Vec<Value>, KernelError> {
        let mut query=self.conn.prepare("SELECT o.operation_id,o.data_json,c.created_at,c.sequence
            FROM recovery_operations o JOIN recovery_checkpoints c ON c.workspace_id=o.workspace_id AND c.execution_id=o.operation_id
            WHERE o.workspace_id=?1 AND o.thread_id=?2 AND o.kind='file-point' AND o.state='complete' AND json_extract(o.data_json,'$.rootId')=?3")?;
        let rows = query
            .query_map(params![workspace, thread, root], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(|(id,data,created,sequence)|{
            let data:Value=serde_json::from_str(&data)?;
            let row=self.read_recovery_operation(workspace,&id,None)?;
            let paths=row["files"].as_array().into_iter().flatten().filter_map(|file|file["path"].as_str())
                .filter(|path|path_allowed(grant,path)).collect::<Vec<_>>();
            let point=format!("p{}",&hex::encode(Sha256::digest(id.as_bytes()))[..12]);
            Ok(json!({"id":point,"before":point,"after":point,"runId":id,"sourceRunId":data["sourceRunId"],
                "label":data["name"],"createdAt":created,"sequence":sequence,"state":"ready","paths":paths,"byteLength":row["files"].as_array().into_iter().flatten().filter(|file|file["path"].as_str().is_some_and(|p|path_allowed(grant,p))).filter_map(|file|serde_json::from_str::<Value>(file["targetJson"].as_str()?).ok()).filter_map(|state|state["byteLength"].as_u64()).sum::<u64>()}))
        }).collect()
    }

    fn file_point_targets(
        &self,
        workspace: &str,
        root: &str,
        thread: &str,
        changes: &[Change],
        point: &str,
        anchor: Option<&JournalAnchor>,
        paths: Option<&[String]>,
        grant: &Grant,
    ) -> Result<BTreeMap<String, (Value, Value)>, KernelError> {
        if !point.starts_with('p') {
            return Self::point_targets(changes, point, anchor, paths);
        }
        let named = self
            .named_file_points(workspace, root, thread, grant)?
            .into_iter()
            .find(|p| p["id"] == point)
            .ok_or_else(|| KernelError::Operation("Named recovery point is unavailable".into()))?;
        let row =
            self.read_recovery_operation(workspace, named["runId"].as_str().unwrap(), None)?;
        let mut targets = BTreeMap::new();
        for file in row["files"].as_array().into_iter().flatten() {
            let path = file["path"].as_str().unwrap();
            if !path_allowed(grant, path)
                || paths.is_some_and(|paths| !paths.iter().any(|p| p == path))
            {
                continue;
            }
            let state: Value = serde_json::from_str(file["targetJson"].as_str().unwrap())?;
            targets.insert(path.to_string(), (state.clone(), state));
        }
        for change in changes
            .iter()
            .filter(|c| paths.is_none_or(|paths| paths.contains(&c.path)))
        {
            targets
                .entry(change.path.clone())
                .or_insert_with(|| (change.after.clone(), change.before.clone()))
                .0 = change.after.clone();
        }
        Ok(targets)
    }

    fn create_named_file_point(
        &mut self,
        params: &KernelFileRecoveryParams,
        args: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let workspace = &params.workspace_id;
        let root = &params.root_id;
        let thread = &params.thread_id;
        let operation = params
            .operation_id
            .as_deref()
            .ok_or_else(|| KernelError::Operation("Point operation is required".into()))?;
        let source = params
            .source_run_id
            .as_deref()
            .ok_or_else(|| KernelError::Operation("Point source is required".into()))?;
        let name = args["name"]
            .as_str()
            .filter(|name| !name.trim().is_empty())
            .ok_or_else(|| KernelError::Operation("Point name is required".into()))?;
        let changes = self.point_changes(workspace, root, thread, grant)?;
        let existing = self.recovery_operation_get(
            &json!({"workspaceId":workspace,"operationId":operation}),
            &grant.grant_id,
        )?;
        if !existing.is_null()
            && (existing["kind"] != "file-point"
                || existing["threadId"] != *thread
                || existing["data"]["rootId"] != *root
                || existing["data"]["name"] != name)
        {
            return Err(KernelError::Operation(
                "Named point operation changed".into(),
            ));
        }
        if existing.is_null() {
            let mut owners = Vec::new();
            let prepared = (|| {
                let mut files = Vec::new();
                for path in changes
                    .iter()
                    .map(|c| c.path.clone())
                    .collect::<BTreeSet<_>>()
                {
                    let lease = format!(
                        "point:{operation}:{}",
                        hex::encode(Sha256::digest(path.as_bytes()))
                    );
                    let acquired=self.file_lease_acquire(&json!({"workspaceId":workspace,"rootId":root,"leaseId":lease,"resources":[{"path":path,"scope":"exact"}]}),grant)?;
                    if acquired["status"] != "acquired" {
                        return Err(KernelError::Operation(format!(
                            "File is being changed: {path}"
                        )));
                    }
                    let captured = self.restore_capture(workspace, root, &path, &lease, grant);
                    let _ = self.file_lease_release(
                        &json!({"workspaceId":workspace,"rootId":root,"leaseId":lease}),
                        grant,
                    );
                    let captured = captured?;
                    if let Some(owner) = captured["ownerId"].as_str() {
                        owners.push(owner.to_owned());
                    }
                    let state: Value =
                        serde_json::from_str(captured["stateJson"].as_str().unwrap())?;
                    let refs=state["objectHash"].as_str().map(|hash|vec![json!({"slot":"target","objectHash":hash,"ownerId":captured["ownerId"]})]).unwrap_or_default();
                    files.push(
                        json!({"path":path,"targetJson":captured["stateJson"],"references":refs}),
                    );
                }
                self.recovery_operation_create(&json!({"operationId":operation,"workspaceId":workspace,"threadId":thread,"kind":"file-point","state":"planned",
                "dataJson":json!({"rootId":root,"sourceRunId":source,"name":name}).to_string(),"files":files}),&grant.grant_id)?;
                Ok::<_, KernelError>(())
            })();
            for owner in owners {
                let _ = self.release_object_owner(
                    &json!({"ownerId":owner}),
                    Some(workspace),
                    &grant.grant_id,
                );
            }
            prepared?;
        }
        let checkpoint=self.recovery_checkpoint_create(&json!({"workspaceId":workspace,"operationId":format!("point-label:{operation}"),"label":name}),&grant.grant_id)?;
        self.conn.execute(
            "UPDATE recovery_checkpoints SET execution_id=?3 WHERE workspace_id=?1 AND id=?2",
            params![workspace, checkpoint["id"].as_str(), operation],
        )?;
        let row = self.recovery_operation_get(
            &json!({"workspaceId":workspace,"operationId":operation}),
            &grant.grant_id,
        )?;
        if row["state"] != "complete" {
            self.recovery_operation_complete(&json!({"workspaceId":workspace,"operationId":operation,"expectedRevision":row["revision"],"state":"complete","resultJson":json!({"checkpointId":checkpoint["id"]}).to_string()}),&grant.grant_id)?;
        }
        Ok(json!({"points":self.named_file_points(workspace,root,thread,grant)?}))
    }

    fn release_file_point(
        &mut self,
        params: &KernelFileRecoveryParams,
        args: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let workspace = &params.workspace_id;
        let root = &params.root_id;
        let thread = &params.thread_id;
        let point = args["point"]
            .as_str()
            .ok_or_else(|| KernelError::Operation("Recovery point is required".into()))?;
        let changes = self.point_changes(workspace, root, thread, grant)?;
        let named = self.named_file_points(workspace, root, thread, grant)?;
        if let Some(found) = named.iter().find(|p| p["id"] == point) {
            let id = found["runId"].as_str().unwrap();
            self.conn.execute_batch("BEGIN IMMEDIATE")?;
            let result = (|| {
                self.conn.execute(
                    "DELETE FROM recovery_checkpoints WHERE workspace_id=?1 AND execution_id=?2",
                    params![workspace, id],
                )?;
                self.recovery_operation_release(
                    &json!({"workspaceId":workspace,"operationId":id}),
                    &grant.grant_id,
                )
            })();
            match result {
                Ok(_) => self.conn.execute_batch("COMMIT")?,
                Err(error) => {
                    let _ = self.conn.execute_batch("ROLLBACK");
                    return Err(error);
                }
            };
            return self.prune_released_file_points(workspace, root, thread, grant);
        }
        let reference = point.split(':').next().unwrap_or(point);
        let selected = changes
            .iter()
            .filter(|c| round_ref(&c.run) == reference)
            .collect::<Vec<_>>();
        if selected.is_empty() {
            return Ok(json!({"released":false}));
        }
        if selected.iter().any(|c| c.state == "pending") {
            return Err(KernelError::Operation(
                "This round is still using its recovery record".into(),
            ));
        }
        let run = &selected[0].run;
        // Removing a point hides it immediately. Shared journal records remain until
        // older retained points no longer need their expected states and new paths.
        self.recovery_operation_create(&json!({"workspaceId":workspace,"operationId":format!("release-point:{root}:{thread}:{run}"),
            "threadId":thread,"kind":"file-point-release","state":"complete",
            "dataJson":json!({"rootId":root,"runId":run}).to_string(),"files":[]}),&grant.grant_id)?;
        self.prune_released_file_points(workspace, root, thread, grant)
    }

    fn prune_released_file_points(
        &mut self,
        workspace: &str,
        root: &str,
        thread: &str,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let changes = self.point_changes(workspace, root, thread, grant)?;
        let named = self.named_file_points(workspace, root, thread, grant)?;
        let hidden = self.released_file_rounds(workspace, root, thread)?;
        let first_retained = changes
            .iter()
            .filter(|c| !hidden.contains(&c.run))
            .map(|c| c.sequence)
            .min();
        let first_named = named.iter().filter_map(|p| p["sequence"].as_i64()).min();
        let boundary = first_retained
            .into_iter()
            .chain(first_named)
            .min()
            .unwrap_or(i64::MAX);
        let checkpoints = {
            let mut query=self.conn.prepare("SELECT t.checkpoint_id,t.run_id,c.sequence FROM recovery_turns t
                JOIN recovery_checkpoints c ON c.workspace_id=t.workspace_id AND c.id=t.checkpoint_id
                WHERE t.workspace_id=?1 AND json_extract(t.conversation_json,'$.threadId')=?2 AND json_extract(t.file_target_json,'$.rootId')=?3")?;
            let rows = query
                .query_map(params![workspace, thread, root], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows.into_iter()
                .filter(|(_, run, sequence)| {
                    hidden.contains(run)
                        && *sequence < boundary
                        && !named.iter().any(|point| point["sourceRunId"] == *run)
                })
                .map(|(id, _, _)| id)
                .collect::<Vec<_>>()
        };
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            for id in &checkpoints {
                self.conn.execute("DELETE FROM recovery_refs WHERE workspace_id=?1 AND owner_kind='change' AND owner_id IN (SELECT 'change:'||checkpoint_id||':'||path FROM recovery_changes WHERE workspace_id=?1 AND checkpoint_id=?2)",params![workspace,id])?;
                self.conn.execute(
                    "DELETE FROM recovery_changes WHERE workspace_id=?1 AND checkpoint_id=?2",
                    params![workspace, id],
                )?;
                self.conn.execute(
                    "DELETE FROM recovery_turns WHERE workspace_id=?1 AND checkpoint_id=?2",
                    params![workspace, id],
                )?;
                self.conn.execute(
                    "DELETE FROM recovery_checkpoints WHERE workspace_id=?1 AND id=?2",
                    params![workspace, id],
                )?;
            }
            Ok::<_, KernelError>(json!({"released":true,"checkpoints":checkpoints.len()}))
        })();
        match result {
            Ok(value) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    fn released_file_rounds(
        &self,
        workspace: &str,
        root: &str,
        thread: &str,
    ) -> Result<BTreeSet<String>, KernelError> {
        let mut query=self.conn.prepare("SELECT json_extract(data_json,'$.runId') FROM recovery_operations WHERE workspace_id=?1 AND thread_id=?2 AND kind='file-point-release' AND json_extract(data_json,'$.rootId')=?3")?;
        let rows = query
            .query_map(params![workspace, thread, root], |r| r.get::<_, String>(0))?
            .collect::<Result<BTreeSet<_>, _>>()?;
        Ok(rows)
    }

    fn point_changes(
        &self,
        workspace: &str,
        root: &str,
        thread: &str,
        grant: &Grant,
    ) -> Result<Vec<Change>, KernelError> {
        self.recovery_workspace(
            &json!({"workspaceId":workspace,"threadId":thread}),
            &grant.grant_id,
        )?;
        self.registered_file_root(root, grant)?;
        let mut query = self.conn.prepare(
            "SELECT c.sequence,t.run_id,d.path,d.before_json,d.after_json,c.created_at,t.status,json_extract(t.file_target_json,'$.runId'),c.id
             FROM recovery_checkpoints c JOIN recovery_turns t ON t.workspace_id=c.workspace_id AND t.checkpoint_id=c.id
             JOIN recovery_changes d ON d.workspace_id=c.workspace_id AND d.checkpoint_id=c.id
             WHERE c.workspace_id=?1 AND json_extract(t.conversation_json,'$.threadId')=?2
               AND json_extract(t.file_target_json,'$.rootId')=?3 ORDER BY c.sequence,d.path")?;
        let rows = query
            .query_map(params![workspace, thread, root], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, String>(8)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .filter(|row| path_allowed(grant, &row.2))
            .map(|row| {
                Ok(Change {
                    checkpoint: row.8,
                    sequence: row.0,
                    run: row.1,
                    path: row.2,
                    before: serde_json::from_str(&row.3)?,
                    after: row
                        .4
                        .map(|v| serde_json::from_str(&v))
                        .transpose()?
                        .unwrap_or(Value::Null),
                    created_at: row.5,
                    state: row.6,
                    source_run: row.7,
                })
            })
            .collect()
    }

    fn point_targets(
        changes: &[Change],
        point: &str,
        anchor: Option<&JournalAnchor>,
        paths: Option<&[String]>,
    ) -> Result<BTreeMap<String, (Value, Value)>, KernelError> {
        let (reference, position) = point.rsplit_once(':').ok_or_else(|| {
            KernelError::Operation("Use a point's before/after reference or current:before".into())
        })?;
        if !matches!(position, "before" | "after") {
            return Err(KernelError::Operation(
                "Recovery point position must be before or after".into(),
            ));
        }
        let run = if reference == "current" {
            anchor
                .map(|a| a.run_id.clone())
                .ok_or_else(|| KernelError::Operation("Current round is unavailable".into()))?
        } else {
            let runs = changes
                .iter()
                .filter(|c| round_ref(&c.run) == reference)
                .map(|c| c.run.clone())
                .collect::<BTreeSet<_>>();
            if runs.len() != 1 {
                return Err(KernelError::Operation(
                    "Recovery point is unavailable".into(),
                ));
            }
            runs.into_iter().next().unwrap()
        };
        let boundary = changes.iter().filter(|c| c.run == run).map(|c| c.sequence);
        let boundary = boundary.min();
        let Some(boundary) = boundary else {
            if reference == "current" {
                return Ok(BTreeMap::new());
            }
            return Err(KernelError::Operation(
                "Recovery point has no recorded files".into(),
            ));
        };
        let mut targets = BTreeMap::new();
        for change in changes
            .iter()
            .filter(|c| c.sequence >= boundary && paths.is_none_or(|p| p.contains(&c.path)))
        {
            let target = if position == "after" && change.run == run {
                change.after.clone()
            } else {
                change.before.clone()
            };
            let entry = targets
                .entry(change.path.clone())
                .or_insert_with(|| (change.after.clone(), target));
            if position == "after" && change.run == run {
                entry.1 = change.after.clone();
            }
            // Latest recorded content is the expected current state. A gap is reported
            // per file; it does not prevent other recorded files from being restored.
            entry.0 = change.after.clone();
        }
        Ok(targets)
    }

    pub(crate) fn file_recovery_points(
        &mut self,
        workspace: &str,
        root: &str,
        thread: &str,
        args: &RecoveryPointsArgs,
        anchor: Option<&JournalAnchor>,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        if let Some(operation) = &args.operation {
            return self.reconcile_file_restore(workspace, root, thread, operation, grant);
        }
        if args.operations == Some(true) {
            self.recovery_workspace(
                &json!({"workspaceId":workspace,"threadId":thread}),
                &grant.grant_id,
            )?;
            self.registered_file_root(root, grant)?;
            let cursor = args.cursor.unwrap_or(0);
            let limit = args.limit.unwrap_or(20);
            if limit == 0 {
                return Err(KernelError::Operation("limit must be positive".into()));
            }
            let mut operations = self.file_restore_operations(
                workspace,
                root,
                thread,
                cursor,
                limit.saturating_add(1),
                grant,
            )?;
            let more = operations.len() > limit;
            operations.truncate(limit);
            return Ok(
                json!({"operations":operations,"nextCursor":if more {Some(cursor.saturating_add(limit))}else{None}}),
            );
        }
        let changes = self.point_changes(workspace, root, thread, grant)?;
        if let Some(point) = &args.point {
            let targets = self.file_point_targets(
                workspace,
                root,
                thread,
                &changes,
                point,
                anchor,
                args.paths.as_deref(),
                grant,
            )?;
            let named = if args.references == Some(true) && point.starts_with('p') {
                self.named_file_points(workspace, root, thread, grant)?
                    .into_iter()
                    .find(|value| value["id"] == *point)
            } else {
                None
            };
            let files=targets.into_iter().map(|(path,(expected,target))|{
                let mut value=json!({"path":path,"expected":expected,"target":target});
                if args.references==Some(true) {
                    if let Some(hash)=target["objectHash"].as_str() {
                        let source=changes.iter().filter(|change|change.path==path).find_map(|change|{
                            ["before","after"].into_iter().find(|slot|(if *slot=="before" {&change.before}else{&change.after})["objectHash"]==hash)
                                .map(|slot|json!({"recordId":format!("change:{}:{path}",change.checkpoint),"slot":slot}))
                        }).or_else(||named.as_ref().map(|named|json!({"recordId":format!("operation-file:{}:{path}",named["runId"].as_str().unwrap()),"slot":"target"})));
                        value["targetSource"]=source.unwrap_or(Value::Null);
                    }
                }
                value
            }).collect::<Vec<_>>();
            return Ok(json!({"point":point,"files":files,"coverage":"recorded-files"}));
        }
        let mut groups: BTreeMap<String, Value> = BTreeMap::new();
        let mut round_files: BTreeMap<(String, String), (Value, Value)> = BTreeMap::new();
        for change in &changes {
            let entry=groups.entry(change.run.clone()).or_insert_with(||json!({
                "id":round_ref(&change.run),"runId":change.run,"sourceRunId":change.source_run,"before":format!("{}:before",round_ref(&change.run)),
                "after":format!("{}:after",round_ref(&change.run)),"createdAt":change.created_at,"sequence":change.sequence,
                "state":change.state,"paths":[],"byteLength":0
            }));
            if change.state == "incomplete" {
                entry["state"] = json!("incomplete");
            }
            round_files
                .entry((change.run.clone(), change.path.clone()))
                .or_insert_with(|| (change.before.clone(), change.after.clone()))
                .1 = change.after.clone();
            let paths = entry["paths"].as_array_mut().unwrap();
            if change.before != change.after && !paths.contains(&json!(change.path)) {
                paths.push(json!(change.path));
            }
        }
        for (run, point) in &mut groups {
            let changed = round_files
                .iter()
                .filter(|((owner, _), (before, after))| owner == run && before != after);
            let files = changed
                .map(|((_, path), (before, after))| {
                    (
                        path.clone(),
                        before["byteLength"]
                            .as_u64()
                            .unwrap_or(0)
                            .max(after["byteLength"].as_u64().unwrap_or(0)),
                    )
                })
                .collect::<Vec<_>>();
            point["paths"] = json!(files.iter().map(|(path, _)| path).collect::<Vec<_>>());
            point["byteLength"] = json!(files.iter().map(|(_, bytes)| bytes).sum::<u64>());
        }
        let hidden = self.released_file_rounds(workspace, root, thread)?;
        let mut points = groups
            .into_iter()
            .filter(|(run, _)| !hidden.contains(run))
            .map(|(_, point)| point)
            .collect::<Vec<_>>();
        points.extend(self.named_file_points(workspace, root, thread, grant)?);
        points.sort_by_key(|v| std::cmp::Reverse(v["sequence"].as_i64().unwrap_or(0)));
        let cursor = args.cursor.unwrap_or(0);
        let limit = args.limit.unwrap_or(20);
        if limit == 0 {
            return Err(KernelError::Operation("limit must be positive".into()));
        }
        let next = cursor.saturating_add(limit);
        let more = next < points.len();
        let operations = self.file_restore_operations(workspace, root, thread, 0, limit, grant)?;
        Ok(
            json!({"points":points.into_iter().skip(cursor).take(limit).collect::<Vec<_>>(),"nextCursor":if more {Some(next)} else {None},"operations":operations}),
        )
    }

    fn file_restore_operations(
        &self,
        workspace: &str,
        root: &str,
        thread: &str,
        cursor: usize,
        limit: usize,
        grant: &Grant,
    ) -> Result<Vec<Value>, KernelError> {
        let operations={
            let mut query=self.conn.prepare("SELECT operation_id,state,data_json,result_json,created_at FROM recovery_operations WHERE workspace_id=?1 AND thread_id=?2 AND kind='file-restore' AND json_extract(data_json,'$.rootId')=?3 ORDER BY rowid DESC LIMIT ?4 OFFSET ?5")?;
            let rows=query.query_map(params![workspace,thread,root,limit as i64,cursor as i64],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,String>(4)?)))?.collect::<Result<Vec<_>,_>>()?;
            rows
        }.into_iter().map(|(id,state,data,result,created)| {
            let data:Value=serde_json::from_str(&data)?;
            let mut value:Value=result.map(|r|serde_json::from_str(&r)).transpose()?.unwrap_or_else(||json!({"operationId":id,"status":"pending","files":[],"appliedPaths":[],"conflictPaths":[]}));
            if state!="complete" {value["status"]=json!("pending");}
            value["sourceRunId"]=data["journal"]["fileTarget"]["runId"].as_str().or(data["runId"].as_str()).map(Value::from).unwrap_or(Value::Null);
            value["createdAt"]=json!(created);
            for field in ["appliedPaths","conflictPaths"] {
                if let Some(paths)=value[field].as_array_mut() {paths.retain(|path|path.as_str().is_some_and(|p|path_allowed(grant,p)));}
            }
            if let Some(files)=value["files"].as_array_mut() {files.retain(|file|file["path"].as_str().is_some_and(|p|path_allowed(grant,p)));}
            Ok::<_,KernelError>(value)
        }).collect::<Result<Vec<_>,_>>()?;
        Ok(operations)
    }

    fn restore_capture(
        &mut self,
        workspace: &str,
        root: &str,
        path: &str,
        lease: &str,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let cancel = self
            .cancellation
            .clone()
            .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
        let mut task=self.prepare_capture("file.capture",&json!({"workspaceId":workspace,"operationId":format!("capture:{lease}"),"rootId":root,"path":path,"leaseId":lease,"store":true}),grant,cancel)?;
        let result = (|| {
            let hashed = task.hash_sources()?;
            self.retain_capture_objects(&mut task, &hashed, grant)?;
            let captured = task.finish_sources(hashed)?;
            self.publish_capture(&task, captured, grant)
        })();
        self.finish_retained_file_lease(task.lease_id());
        result
    }

    fn restore_journal(
        &mut self,
        workspace: &str,
        root: &str,
        thread: &str,
        operation: &str,
        anchor: Option<&JournalAnchor>,
        mode: varin_runtime::SourceMode,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        if let Some(anchor) = anchor {
            return self.prepare_journal_turn(workspace, root, anchor, mode, grant);
        }
        let original:Option<(String,String)>=self.conn.query_row(
            "SELECT file_target_json,conversation_json FROM recovery_turns WHERE workspace_id=?1 AND json_extract(file_target_json,'$.rootId')=?2 AND json_extract(conversation_json,'$.threadId')=?3 ORDER BY rowid DESC LIMIT 1",
            params![workspace,root,thread],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let (target, conversation) = original.ok_or_else(|| {
            KernelError::Operation("Original file journal source is unavailable".into())
        })?;
        let target: Value = serde_json::from_str(&target)?;
        let conversation: Value = serde_json::from_str(&conversation)?;
        let execution = format!("restore:{operation}");
        let turn=self.recovery_turn_start(&json!({"operationId":format!("restore-turn:{operation}"),"workspaceId":workspace,
            "executionId":execution,"runId":execution,"conversation":conversation,"fileTarget":target,"userEntryId":operation,
            "workerId":"user","runtimeGeneration":0,"activeWriterScopes":[],"provenance":"caused-by"}),&grant.grant_id)?;
        self.conn.execute(
            "UPDATE recovery_checkpoints SET source='restore' WHERE workspace_id=?1 AND id=?2",
            params![workspace, turn["checkpointId"].as_str()],
        )?;
        Ok(
            json!({"workspaceId":workspace,"executionId":execution,"checkpointId":turn["checkpointId"],"conversation":conversation,"fileTarget":target,"runId":execution,"synthetic":true}),
        )
    }

    pub(crate) fn restore_recorded_files(
        &mut self,
        workspace: &str,
        root: &str,
        thread: &str,
        operation: &str,
        args: &FileRestoreArgs,
        anchor: Option<&JournalAnchor>,
        mode: varin_runtime::SourceMode,
        grant: &Grant,
        dispatched: &mut bool,
    ) -> Result<Value, KernelError> {
        if args.point.is_some() == args.undo.is_some() {
            return Err(KernelError::Operation("Provide point or undo".into()));
        }
        self.recovery_workspace(
            &json!({"workspaceId":workspace,"threadId":thread}),
            &grant.grant_id,
        )?;
        self.registered_file_root(root, grant)?;
        for path in args
            .paths
            .iter()
            .flatten()
            .chain(args.overwrite_paths.iter().flatten())
        {
            self.resolve_file_resource(root, path, grant, false)?;
        }
        let original = self.recovery_operation_get(
            &json!({"workspaceId":workspace,"operationId":operation}),
            &grant.grant_id,
        )?;
        if !original.is_null() {
            if original["kind"] != "file-restore"
                || original["threadId"] != thread
                || original["data"]["rootId"] != root
                || original["data"]["arguments"] != serde_json::to_value(args)?
            {
                return Err(KernelError::Operation(
                    "Restore operation identity changed".into(),
                ));
            }
            if original["state"] == "complete" {
                return Ok(original["result"].clone());
            }
            return self.reconcile_file_restore(workspace, root, thread, operation, grant);
        }
        let targets = if let Some(undo) = &args.undo {
            let old = self.read_recovery_operation(workspace, undo, None)?;
            if old["kind"] != "file-restore"
                || old["threadId"] != thread
                || old["data"]["rootId"] != root
                || old["state"] != "complete"
            {
                return Err(KernelError::Operation(
                    "Undo requires a completed restore in this conversation and worktree".into(),
                ));
            }
            let applied = old["result"]["appliedPaths"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            old["files"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|f| applied.contains(&f["path"]))
                .filter(|f| {
                    args.paths.as_ref().is_none_or(|p| {
                        f["path"].as_str().is_some_and(|f| p.iter().any(|p| p == f))
                    })
                })
                .map(|f| {
                    Ok((
                        f["path"].as_str().unwrap().to_string(),
                        (
                            serde_json::from_str(f["targetJson"].as_str().unwrap())?,
                            serde_json::from_str(f["safetyJson"].as_str().unwrap())?,
                        ),
                    ))
                })
                .collect::<Result<BTreeMap<String, (Value, Value)>, KernelError>>()?
        } else {
            let changes = self.point_changes(workspace, root, thread, grant)?;
            self.file_point_targets(
                workspace,
                root,
                thread,
                &changes,
                args.point.as_deref().unwrap(),
                anchor,
                args.paths.as_deref(),
                grant,
            )?
        };
        let mut files = Vec::new();
        let mut results = Vec::new();
        for path in args
            .paths
            .iter()
            .flatten()
            .filter(|path| !targets.contains_key(*path))
        {
            results.push(json!({"path":path,"status":"unavailable","message":"This path has no recorded state at the selected point."}));
        }
        let mut leases = Vec::new();
        let mut captured_owners = Vec::new();
        let prepared = (|| {
            for (path, (expected, target)) in targets {
                self.check_cancelled()?;
                let resource = self.resolve_file_resource(root, &path, grant, false)?;
                if let Some(message) = args
                    .blocked_paths
                    .as_ref()
                    .and_then(|paths| paths.get(&path))
                {
                    results.push(json!({"path":path,"status":"busy","message":message}));
                    continue;
                }
                let lease = format!(
                    "restore:{operation}:{}",
                    hex::encode(Sha256::digest(path.as_bytes()))
                );
                let acquired=self.file_lease_acquire(&json!({"workspaceId":workspace,"rootId":root,"leaseId":lease,"resources":[{"path":path,"scope":"exact"}]}),grant)?;
                if acquired["status"] != "acquired" {
                    results.push(json!({"path":path,"status":"busy"}));
                    continue;
                }
                leases.push(lease.clone());
                let current = serde_json::to_value(self.capture_file_state(&resource)?)?;
                if current == target {
                    results.push(json!({"path":path,"status":"unchanged"}));
                    continue;
                }
                if target.is_null() || target["kind"] == "unsupported" {
                    results.push(json!({"path":path,"status":"unavailable"}));
                    continue;
                }
                if current != expected
                    && !args
                        .overwrite_paths
                        .as_ref()
                        .is_some_and(|p| p.contains(&path))
                {
                    results.push(json!({"path":path,"status":"conflict"}));
                    continue;
                }
                let safety = self.restore_capture(workspace, root, &path, &lease, grant)?;
                if let Some(owner) = safety["ownerId"].as_str() {
                    captured_owners.push(owner.to_owned());
                }
                let safety_state: Value =
                    serde_json::from_str(safety["stateJson"].as_str().ok_or_else(|| {
                        KernelError::Storage("Recovery capture omitted state".into())
                    })?)?;
                if safety_state != expected
                    && !args
                        .overwrite_paths
                        .as_ref()
                        .is_some_and(|paths| paths.contains(&path))
                {
                    results.push(json!({"path":path,"status":"conflict"}));
                    continue;
                }
                let mut references = Vec::new();
                for (slot, state) in [
                    ("expected", &safety_state),
                    ("target", &target),
                    ("safety", &safety_state),
                ] {
                    if let Some(hash) = state["objectHash"].as_str() {
                        let mut reference = json!({"slot":slot,"objectHash":hash});
                        if slot == "safety" || slot == "expected" {
                            reference["ownerId"] = safety["ownerId"].clone();
                        }
                        references.push(reference);
                    }
                }
                files.push(json!({"path":path,"expectedJson":serde_json::to_string(&safety_state)?,"targetJson":serde_json::to_string(&target)?,"safetyJson":serde_json::to_string(&safety_state)?,"references":references}));
            }
            files.sort_by_key(|file| {
                let target: Value = serde_json::from_str(file["targetJson"].as_str().unwrap())
                    .expect("prepared state");
                let depth = file["path"].as_str().unwrap().split('/').count() as i64;
                let group = if target["kind"] == "missing" {
                    0
                } else if target["kind"] == "directory" {
                    1
                } else {
                    2
                };
                (
                    group,
                    if group == 0 { -depth } else { depth },
                    file["path"].as_str().unwrap().to_owned(),
                )
            });
            let journal = if files.is_empty() {
                None
            } else {
                Some(self.restore_journal(workspace, root, thread, operation, anchor, mode, grant)?)
            };
            self.recovery_operation_create(&json!({"operationId":operation,"workspaceId":workspace,"threadId":thread,
                "kind":"file-restore","state":"applying","dataJson":json!({"rootId":root,"runId":grant.run_id,"pointRunId":anchor.map(|anchor|&anchor.run_id),"epoch":grant.kernel_epoch,"arguments":args,"files":results,"journal":journal}).to_string(),"files":files}),&grant.grant_id)?;
            for (index, file) in files.iter().enumerate() {
                let path = file["path"].as_str().unwrap();
                let lease = format!(
                    "restore:{operation}:{}",
                    hex::encode(Sha256::digest(path.as_bytes()))
                );
                let mut params = json!({"workspaceId":workspace,"rootId":root,"path":path,"operationId":format!("{operation}:file:{index}"),
                    "leaseId":lease,"targetJson":file["targetJson"],"expectedJson":file["safetyJson"]});
                let target: Value = serde_json::from_str(file["targetJson"].as_str().unwrap())?;
                if target["kind"] == "regular-file" {
                    params["recordId"] = json!(format!("operation-file:{operation}:{path}"));
                    params["slot"] = json!("target");
                }
                if let Some(journal) = &journal {
                    params["__recoveryTurn"] = journal.clone();
                    params["__recoveryTool"] = json!("file_restore");
                }
                *dispatched = true;
                match self.file_apply(&params, grant) {
                    Ok(receipt) => results.push(restored_file(file,receipt["status"].as_str().unwrap_or("unknown"))?),
                    Err(error) => {
                        let receipt=self.file_operation_reconcile(&json!({"workspaceId":workspace,"rootId":root,"operationId":format!("{operation}:file:{index}")}),grant)?;
                        let mut result = restored_file(file,if receipt["status"]=="pending" {"pending"} else {receipt["result"]["status"].as_str().unwrap_or("failed")})?;
                        result["message"] = json!(error.to_string()); results.push(result);
                    }
                }
            }
            self.finish_file_restore(workspace, operation, results, grant)
        })();
        for lease in leases {
            let _ = self.file_lease_release(
                &json!({"workspaceId":workspace,"rootId":root,"leaseId":lease}),
                grant,
            );
        }
        for owner in captured_owners {
            let _ = self.release_object_owner(
                &json!({"ownerId":owner}),
                Some(workspace),
                &grant.grant_id,
            );
        }
        prepared
    }

    fn finish_file_restore(
        &mut self,
        workspace: &str,
        operation: &str,
        files: Vec<Value>,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let applied = files
            .iter()
            .filter(|f| f["status"] == "applied")
            .map(|f| f["path"].clone())
            .collect::<Vec<_>>();
        let conflicts = files
            .iter()
            .filter(|f| !matches!(f["status"].as_str(), Some("applied" | "unchanged")))
            .map(|f| f["path"].clone())
            .collect::<Vec<_>>();
        let pending = files.iter().any(|f| f["status"] == "pending");
        let mut result = json!({"operationId":operation,"status":if pending {"pending"} else if conflicts.is_empty() {"applied"} else if applied.is_empty() {"failed"} else {"partial"},
            "appliedPaths":applied,"conflictPaths":conflicts,"files":files});
        let row = self.recovery_operation_get(
            &json!({"workspaceId":workspace,"operationId":operation}),
            &grant.grant_id,
        )?;
        if let Some(point) = row["data"]["arguments"]["point"].as_str() {
            result["point"] = json!(match (
                point.strip_prefix("current:"),
                row["data"]["pointRunId"]
                    .as_str()
                    .or(row["data"]["runId"].as_str())
            ) {
                (Some(position), Some(run)) => format!("{}:{position}", round_ref(run)),
                _ => point.to_owned(),
            });
        }
        if let Some(undo) = row["data"]["arguments"]["undo"].as_str() {
            result["undoOf"] = json!(undo);
        }
        if !pending && row["data"]["journal"]["synthetic"] == true {
            let execution = row["data"]["journal"]["executionId"].as_str().unwrap();
            if let Some(turn) = self.recovery_turn_value(workspace, execution)? {
                self.recovery_turn_settle(&json!({"operationId":format!("restore-settle:{operation}"),"workspaceId":workspace,"executionId":execution,
                    "expectedRevision":turn["revision"],"status":"ready","observedResourceIds":[],"unrecordedResourceIds":[],"activeWriterScopes":[],"provenance":"caused-by"}),&grant.grant_id)?;
            }
        }
        self.recovery_operation_complete(&json!({"workspaceId":workspace,"operationId":operation,"expectedRevision":row["revision"],"state":if pending {"applying-files"} else {"complete"},"resultJson":result.to_string()}),&grant.grant_id)?;
        Ok(result)
    }

    pub(crate) fn reconcile_file_restore(
        &mut self,
        workspace: &str,
        root: &str,
        thread: &str,
        operation: &str,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let row = self.recovery_operation_get(
            &json!({"workspaceId":workspace,"operationId":operation}),
            &grant.grant_id,
        )?;
        if row.is_null() {
            return Ok(
                json!({"operationId":operation,"status":"failed","appliedPaths":[],"conflictPaths":[],"files":[],"message":"The original restore operation was not recorded."}),
            );
        }
        if row["kind"] != "file-restore"
            || row["threadId"] != thread
            || row["data"]["rootId"] != root
        {
            return Err(KernelError::Authorization("Restore source changed".into()));
        }
        if row["state"] == "complete" {
            return Ok(row["result"].clone());
        }
        let mut results = row["data"]["files"].as_array().cloned().unwrap_or_default();
        for (index, file) in row["files"].as_array().into_iter().flatten().enumerate() {
            let receipt=self.file_operation_reconcile(&json!({"workspaceId":workspace,"rootId":root,"operationId":format!("{operation}:file:{index}")}),grant)?;
            results.push(restored_file(file,if receipt["status"]=="pending" {"pending"} else {receipt["result"]["status"].as_str().unwrap_or("interrupted")})?);
        }
        self.finish_file_restore(workspace, operation, results, grant)
    }

    pub(crate) fn file_restore_receipt(
        &mut self,
        workspace: &str,
        root: &str,
        thread: &str,
        operation: &str,
        args: &FileRestoreArgs,
        grant: &Grant,
    ) -> Result<Option<varin_runtime::ExternalReceipt>, KernelError> {
        let row = self.recovery_operation_get(
            &json!({"workspaceId":workspace,"operationId":operation}),
            &grant.grant_id,
        )?;
        if row.is_null() {
            return Ok(None);
        }
        if row["data"]["arguments"] != serde_json::to_value(args)?
            || row["data"]["runId"] != json!(grant.run_id)
        {
            return Err(KernelError::Authorization(
                "Restore receipt differs from its original invocation".into(),
            ));
        }
        let epoch = row["data"]["epoch"]
            .as_str()
            .ok_or_else(|| KernelError::Storage("Restore epoch is missing".into()))?
            .to_owned();
        let result = self.reconcile_file_restore(workspace, root, thread, operation, grant)?;
        if result["status"] == "pending" {
            return Ok(None);
        }
        let applied = result["appliedPaths"]
            .as_array()
            .is_some_and(|p| !p.is_empty());
        Ok(Some(varin_runtime::ExternalReceipt {
            executor: "file_restore".into(),
            identity: operation.into(),
            epoch,
            outcome: if result["status"] == "applied" {
                varin_runtime::Outcome::Succeeded
            } else {
                varin_runtime::Outcome::Failed
            },
            effect: if applied {
                if result["status"] == "applied" {
                    varin_runtime::Effect::Confirmed
                } else {
                    varin_runtime::Effect::Partial
                }
            } else {
                varin_runtime::Effect::None
            },
            result: result.into(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::file_mutations::{read_version, FileWriteArgs, TextMutation};

    struct Fixture {
        storage: Storage,
        root: PathBuf,
        workspace: PathBuf,
        root_id: String,
        grant: Grant,
        anchor: JournalAnchor,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("varin-file-recovery-{}", Uuid::new_v4()));
            let workspace = root.join("workspace");
            fs::create_dir_all(&workspace).unwrap();
            let mut storage = Storage::open(&root.join("storage"), "host").unwrap();
            let identity = storage.root.to_string_lossy().to_string();
            storage.issue_grant(&json!({"grantId":"actor","hostGeneration":"generation","owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"thread","runId":"run","pathScopes":[""],"capabilities":["storage.read","storage.write","recovery"]}),"host","generation",&identity,"epoch").unwrap();
            let (grant,params)=storage.authorize(Some("actor"),"epoch","host","generation","file.root.register",&json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":workspace})).unwrap();
            let root_id = storage.file_root_register(&params, &grant).unwrap()["rootId"]
                .as_str()
                .unwrap()
                .to_string();
            Self {
                storage,
                root,
                workspace,
                root_id,
                grant,
                anchor: JournalAnchor {
                    execution_id: "run:input".into(),
                    thread_id: "thread".into(),
                    branch_id: "main".into(),
                    run_id: "run".into(),
                    entry_id: "input".into(),
                    epoch: 1,
                },
            }
        }
        fn write(&mut self, path: &str, text: &str) {
            let resource = self
                .storage
                .resolve_file_resource(&self.root_id, path, &self.grant, false)
                .unwrap();
            let state = self.storage.capture_file_state(&resource).unwrap();
            let read_version = read_version(&self.root_id, path, &state).unwrap();
            let mutation = TextMutation::Write(FileWriteArgs {
                mode: None,
                path: path.into(),
                content: text.into(),
                read_version,
            });
            let result = self
                .storage
                .file_mutate(
                    "workspace",
                    &self.root_id,
                    &Uuid::new_v4().to_string(),
                    &mutation,
                    &self.grant,
                    Some(&self.anchor),
                    varin_runtime::SourceMode::LiveRoot,
                    true,
                    &mut false,
                    None,
                )
                .unwrap();
            assert_eq!(result["status"], "applied");
        }
        fn restore(&mut self, id: &str, point: Option<&str>, undo: Option<&str>) -> Value {
            self.storage
                .restore_recorded_files(
                    "workspace",
                    &self.root_id,
                    "thread",
                    id,
                    &FileRestoreArgs {
                        point: point.map(str::to_string),
                        undo: undo.map(str::to_string),
                        paths: None,
                        overwrite_paths: None,
                        blocked_paths: None,
                    },
                    Some(&self.anchor),
                    varin_runtime::SourceMode::LiveRoot,
                    &self.grant,
                    &mut false,
                )
                .unwrap()
        }
        fn close(self) {
            let root = self.root.clone();
            drop(self);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn round_restore_spans_input_checkpoints_and_can_be_undone() {
        let mut f = Fixture::new();
        fs::write(f.workspace.join("a.txt"), "A").unwrap();
        f.write("a.txt", "B");
        f.anchor.entry_id = "input-2".into();
        f.anchor.execution_id = "run:input-2".into();
        f.write("a.txt", "C");
        let restored = f.restore("restore-1", Some("current:before"), None);
        assert_eq!(restored["status"], "applied");
        assert_eq!(restored["files"][0]["change"], "updated");
        assert_eq!(fs::read_to_string(f.workspace.join("a.txt")).unwrap(), "A");
        assert_eq!(
            f.restore("restore-1", Some("current:before"), None),
            restored
        );
        let undone = f.restore("restore-2", None, Some("restore-1"));
        assert_eq!(undone["status"], "applied");
        assert_eq!(fs::read_to_string(f.workspace.join("a.txt")).unwrap(), "C");
        let mut page = |cursor| {
            f.storage
                .file_recovery_points(
                    "workspace",
                    &f.root_id,
                    "thread",
                    &serde_json::from_value(json!({"operations":true,"limit":1,"cursor":cursor}))
                        .unwrap(),
                    None,
                    &f.grant,
                )
                .unwrap()
        };
        let first = page(0);
        let second = page(1);
        assert_eq!(first["nextCursor"], 1);
        assert!(second["nextCursor"].is_null());
        assert_ne!(
            first["operations"][0]["operationId"],
            second["operations"][0]["operationId"]
        );
        let changes=f.storage.recovery_change_list(&json!({"workspaceId":"workspace","conversation":{"kind":"thread","threadId":"thread","branchId":"main"}}),"actor").unwrap();
        assert_eq!(
            changes["changes"][1]["after"]["objectHash"],
            json!(format!("sha256-{}", hex::encode(Sha256::digest(b"C"))))
        );
        f.close();
    }

    #[test]
    fn restore_and_undo_report_deletion_and_creation() {
        let mut f = Fixture::new(); f.write("new.txt", "created");
        let removed = f.restore("remove-new", Some("current:before"), None);
        assert_eq!(removed["files"][0]["change"],"deleted"); assert!(!f.workspace.join("new.txt").exists());
        let recreated = f.restore("undo-remove", None, Some("remove-new"));
        assert_eq!(recreated["files"][0]["change"],"created");
        assert_eq!(fs::read_to_string(f.workspace.join("new.txt")).unwrap(),"created");
    }

    #[test]
    fn changed_file_does_not_block_other_files_or_undo() {
        let mut f = Fixture::new();
        for file in ["a.txt", "b.txt"] {
            fs::write(f.workspace.join(file), "before").unwrap();
            f.write(file, "after");
        }
        fs::write(f.workspace.join("a.txt"), "user change").unwrap();
        let result = f.restore("restore", Some("current:before"), None);
        assert_eq!(result["status"], "partial");
        assert_eq!(result["appliedPaths"], json!(["b.txt"]));
        assert_eq!(result["conflictPaths"], json!(["a.txt"]));
        assert_eq!(
            fs::read_to_string(f.workspace.join("a.txt")).unwrap(),
            "user change"
        );
        assert_eq!(
            fs::read_to_string(f.workspace.join("b.txt")).unwrap(),
            "before"
        );
        assert_eq!(
            f.restore("undo", None, Some("restore"))["status"],
            "applied"
        );
        assert_eq!(
            fs::read_to_string(f.workspace.join("b.txt")).unwrap(),
            "after"
        );
        f.close();
    }

    #[test]
    fn named_point_keeps_its_bytes_during_the_same_input_and_worktrees_stay_separate() {
        let mut f = Fixture::new();
        fs::write(f.workspace.join("a.txt"), "A").unwrap();
        f.write("a.txt", "B");
        let params:KernelFileRecoveryParams=serde_json::from_value(json!({"workspaceId":"workspace","rootId":f.root_id,"threadId":"thread","sourceRunId":"run","operationId":"named","arguments":{"name":"Before the next change"}})).unwrap();
        let point = f
            .storage
            .create_named_file_point(&params, &json!({"name":"Before the next change"}), &f.grant)
            .unwrap()["points"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        f.write("a.txt", "C");
        f.write("new.txt", "new file");
        let inspection = f
            .storage
            .file_recovery_points(
                "workspace",
                &f.root_id,
                "thread",
                &serde_json::from_value(json!({"point":point,"references":true,"paths":["a.txt"]}))
                    .unwrap(),
                Some(&f.anchor),
                &f.grant,
            )
            .unwrap();
        let target = &inspection["files"][0];
        let content = f
            .storage
            .read_blob_fixture(
                &json!({"hash":target["target"]["objectHash"],
            "recordId":target["targetSource"]["recordId"],"slot":target["targetSource"]["slot"]}),
                &f.grant,
            )
            .unwrap();
        assert_eq!(content["bytesBase64"], "Qg==");
        assert_eq!(
            f.restore("restore-named", Some(&point), None)["status"],
            "applied"
        );
        assert_eq!(fs::read_to_string(f.workspace.join("a.txt")).unwrap(), "B");
        assert!(!f.workspace.join("new.txt").exists());
        let other = f.root.join("other-worktree");
        fs::create_dir(&other).unwrap();
        let root=f.storage.file_root_register(&json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":other}),&f.grant).unwrap()["rootId"].as_str().unwrap().to_owned();
        let points = f
            .storage
            .file_recovery_points(
                "workspace",
                &root,
                "thread",
                &serde_json::from_value(json!({})).unwrap(),
                Some(&f.anchor),
                &f.grant,
            )
            .unwrap();
        assert!(points["points"].as_array().unwrap().is_empty());
        let turn = f
            .storage
            .recovery_turn_value("workspace", &f.anchor.execution_id)
            .unwrap()
            .unwrap();
        f.storage.recovery_turn_settle(&json!({"operationId":"settle","workspaceId":"workspace","executionId":f.anchor.execution_id,
            "expectedRevision":turn["revision"],"status":"ready","observedResourceIds":[],"unrecordedResourceIds":[],"activeWriterScopes":[],"provenance":"caused-by"}),&f.grant.grant_id).unwrap();
        assert_eq!(
            f.storage
                .release_file_point(&params, &json!({"point":round_ref("run")}), &f.grant)
                .unwrap()["released"],
            true
        );
        let remaining = f
            .storage
            .file_recovery_points(
                "workspace",
                &f.root_id,
                "thread",
                &serde_json::from_value(json!({})).unwrap(),
                Some(&f.anchor),
                &f.grant,
            )
            .unwrap();
        assert_eq!(remaining["points"].as_array().unwrap().len(), 1);
        assert_eq!(remaining["points"][0]["byteLength"], 1);
        assert!(!f
            .storage
            .point_changes("workspace", &f.root_id, "thread", &f.grant)
            .unwrap()
            .is_empty());
        assert_eq!(
            f.storage
                .release_file_point(&params, &json!({"point":point}), &f.grant)
                .unwrap()["released"],
            true
        );
        assert!(f
            .storage
            .point_changes("workspace", &f.root_id, "thread", &f.grant)
            .unwrap()
            .is_empty());
        f.close();
    }

    #[test]
    fn integration_file_receipt_enters_the_parent_input_journal() {
        let mut f = Fixture::new();
        fs::write(f.workspace.join("a.txt"), "A").unwrap();
        f.write("candidate.txt", "B");
        let lease = "integration-lease";
        f.storage.file_lease_acquire(&json!({"workspaceId":"workspace","rootId":f.root_id,"leaseId":lease,"resources":[{"path":"a.txt","scope":"exact"}]}),&f.grant).unwrap();
        let before = f
            .storage
            .restore_capture("workspace", &f.root_id, "a.txt", lease, &f.grant)
            .unwrap();
        let target = f
            .storage
            .capture_file_state(
                &f.storage
                    .resolve_file_resource(&f.root_id, "candidate.txt", &f.grant, false)
                    .unwrap(),
            )
            .unwrap();
        let target = serde_json::to_value(target).unwrap();
        let expected: Value = serde_json::from_str(before["stateJson"].as_str().unwrap()).unwrap();
        f.storage.recovery_operation_create(&json!({"workspaceId":"workspace","operationId":"integration-parent","threadId":"thread","runId":"run","kind":"integration","state":"applying",
            "dataJson":json!({"operationBinding":{"parentRunId":"run","parentThreadId":"thread","parentBranchId":"main","journal":f.anchor,"target":{"mode":"live_root"}}}).to_string(),
            "files":[{"path":"a.txt","expectedJson":expected.to_string(),"targetJson":target.to_string(),"safetyJson":expected.to_string(),
                "references":[{"slot":"before","objectHash":expected["objectHash"],"ownerId":before["ownerId"]},{"slot":"target","objectHash":target["objectHash"]}]}]}),&f.grant.grant_id).unwrap();
        let applied=f.storage.file_apply(&json!({"workspaceId":"workspace","rootId":f.root_id,"operationId":"integration-file","reservationOperationId":"integration-parent","path":"a.txt",
            "leaseId":lease,"expectedJson":expected.to_string(),"targetJson":target.to_string(),"recordId":"operation-file:integration-parent:a.txt","slot":"target"}),&f.grant).unwrap();
        assert_eq!(applied["status"], "applied");
        f.storage
            .file_lease_release(
                &json!({"workspaceId":"workspace","rootId":f.root_id,"leaseId":lease}),
                &f.grant,
            )
            .unwrap();
        let changes=f.storage.recovery_change_list(&json!({"workspaceId":"workspace","executionId":f.anchor.execution_id,"conversation":{"kind":"thread","threadId":"thread","branchId":"main"}}),&f.grant.grant_id).unwrap();
        let change = changes["changes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["path"] == "a.txt")
            .unwrap();
        assert_eq!(change["toolName"], "integrate_child");
        assert_eq!(change["before"], expected);
        assert_eq!(change["after"], target);
        f.close();
    }
}
