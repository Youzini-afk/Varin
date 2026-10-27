//! Native writes enter the original affected-file checkpoint and file.apply transaction.
use super::*;
use varin_runtime::catalog::journal::JournalAnchor;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileJournalBinding {
    anchor: JournalAnchor,
    source_mode: varin_runtime::SourceMode,
    tool: String,
    before_owner_id: Option<String>,
}

impl Storage {
    /// Integration already owns durable before/after objects. Attach its original
    /// Catalog input to the same file.apply transaction, including compensation.
    pub(super) fn journal_for_file_reservation(&mut self, input: &Value, grant: &Grant) -> Result<Option<Value>,KernelError> {
        if let Some(binding) = input.get("journalBinding") {
            if input.get("reservationOperationId").is_some() {
                return Err(KernelError::Operation("File apply has two journal owners".into()));
            }
            let binding: FileJournalBinding = serde_json::from_value(binding.clone())?;
            let field = |name: &str| input[name].as_str().ok_or_else(|| KernelError::Operation(format!("File {name} is missing")));
            let workspace = field("workspaceId")?;
            let root = field("rootId")?;
            let operation = field("operationId")?;
            if binding.tool.trim().is_empty() || binding.source_mode == varin_runtime::SourceMode::FixedBranch {
                return Err(KernelError::Operation("Journalled file writes require a tool and a physical source".into()));
            }
            let expected: Value = serde_json::from_str(field("expectedJson")?)?;
            Self::validate_recovery_state(&expected, "before")?;
            // A committed intent owns its before-image. Replay checks its unchanged
            // argument hash in file.apply, after the original temporary owner was consumed.
            if self.operation_get(&json!({"operationId":operation}))?.is_null() {
                match (expected["objectHash"].as_str(), binding.before_owner_id.as_ref()) {
                    (Some(hash), Some(owner)) => self.validate_object_owners(workspace, &grant.grant_id,
                        &BTreeMap::from([(owner.clone(), hash.to_owned())]))?,
                    (None, None) => {},
                    _ => return Err(KernelError::Authorization("File before-image must belong to the original captured object owner".into())),
                }
            }
            let turn = self.prepare_journal_turn(workspace, root, &binding.anchor, binding.source_mode, grant)?;
            let mut journalled = input.clone();
            journalled["__recoveryTurn"] = turn;
            journalled["__recoveryBeforeOwner"] = json!(binding.before_owner_id);
            journalled["__recoveryTool"] = json!(binding.tool);
            return Ok(Some(journalled));
        }
        let Some(operation)=input["reservationOperationId"].as_str() else {return Ok(None);};
        let workspace=input["workspaceId"].as_str().ok_or_else(||KernelError::Operation("File workspace is missing".into()))?;
        let row=self.read_recovery_operation(workspace,operation,Some(&grant.grant_id))?;
        if row["kind"]!="integration" {return Ok(None);}
        let binding=&row["data"]["operationBinding"];
        let Some(journal)=binding.get("journal") else {return Ok(None);};
        let anchor:JournalAnchor=serde_json::from_value(journal.clone())?;
        if binding["parentRunId"]!=anchor.run_id || binding["parentThreadId"]!=anchor.thread_id || binding["parentBranchId"]!=anchor.branch_id {
            return Err(KernelError::Authorization("Integration recovery input differs from its original parent".into()));
        }
        let root=input["rootId"].as_str().ok_or_else(||KernelError::Operation("File root is missing".into()))?;
        let mode=serde_json::from_value(binding["target"]["mode"].clone())?;
        let turn=self.prepare_journal_turn(workspace,root,&anchor,mode,grant)?;
        let mut journalled=input.clone();
        journalled["__recoveryTurn"]=turn;
        journalled["__recoveryTool"]=json!("integrate_child");
        Ok(Some(journalled))
    }

    pub(super) fn prepare_journal_turn(
        &mut self,
        workspace: &str,
        root_id: &str,
        anchor: &JournalAnchor,
        mode: varin_runtime::SourceMode,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        if !grant.capabilities.contains("recovery.maintenance") && (grant.thread_id.as_deref() != Some(&anchor.thread_id)
            || grant.run_id.as_deref() != Some(&anchor.run_id))
        {
            return Err(KernelError::Authorization(
                "journal anchor is outside the original Run".into(),
            ));
        }
        let root = self.admitted_file_root(root_id, grant)?;
        let file_target = json!({"kind":"physical","workspaceId":workspace,"threadId":anchor.thread_id,"runId":anchor.run_id,"rootId":root_id,"canonicalRoot":root.canonical_root,"executionWorkspaceId":root.execution_workspace_id,"sourceMode":mode});
        let conversation =
            json!({"kind":"thread","threadId":anchor.thread_id,"branchId":anchor.branch_id});
        if let Some(turn) = self.recovery_turn_value(workspace, &anchor.execution_id)? {
            if turn["conversation"] != conversation || turn["userEntryId"] != anchor.entry_id {
                return Err(KernelError::Operation(
                    "journal input anchor changed".into(),
                ));
            }
        } else {
            self.recovery_turn_start(&json!({"operationId":format!("recovery-turn-start:{workspace}:{}",anchor.execution_id),"workspaceId":workspace,"executionId":anchor.execution_id,"conversation":conversation,"runId":anchor.run_id,"userEntryId":anchor.entry_id,"workerId":"kernel","runtimeGeneration":anchor.epoch,"activeWriterScopes":[],"provenance":"caused-by","fileTarget":file_target}),&grant.grant_id)?;
        }
        Ok(
            json!({"workspaceId":workspace,"executionId":anchor.execution_id,"checkpointId":format!("recovery.checkpoint:{workspace}:{}",anchor.execution_id),"conversation":conversation,"fileTarget":file_target,"runId":anchor.run_id}),
        )
    }
    /// Called inside begin_file_operation's original transaction, before any filesystem effect.
    pub(super) fn journal_file_intent(
        &mut self,
        operation: &str,
        intent: &Value,
    ) -> Result<(), KernelError> {
        let Some(turn) = intent.get("__recoveryTurn") else {
            return Ok(());
        };
        let workspace = turn["workspaceId"]
            .as_str()
            .ok_or_else(|| KernelError::Storage("journal workspace missing".into()))?;
        let checkpoint = turn["checkpointId"]
            .as_str()
            .ok_or_else(|| KernelError::Storage("journal checkpoint missing".into()))?;
        let execution = turn["executionId"]
            .as_str()
            .ok_or_else(|| KernelError::Storage("journal execution missing".into()))?;
        let path = intent["path"]
            .as_str()
            .ok_or_else(|| KernelError::Storage("journal path missing".into()))?;
        let before: Value = serde_json::from_str(
            intent["expectedJson"]
                .as_str()
                .ok_or_else(|| KernelError::Storage("journal before-state missing".into()))?,
        )?;
        Self::validate_recovery_state(&before, "before")?;
        let existing:Option<(String,Option<String>)>=self.conn.query_row("SELECT before_json,after_json FROM recovery_changes WHERE workspace_id=?1 AND checkpoint_id=?2 AND path=?3",params![workspace,checkpoint,path],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((_, after)) = &existing {
            if after.as_ref().is_none_or(|after| {
                serde_json::from_str::<Value>(after).ok().as_ref() != Some(&before)
            }) {
                self.conn.execute("UPDATE recovery_turns SET status='incomplete',failure_json=?3,unrecorded_resource_ids_json=json_insert(unrecorded_resource_ids_json,'$[#]',?4),revision=revision+1 WHERE workspace_id=?1 AND execution_id=?2",params![workspace,execution,json!({"code":"checkpoint-incomplete","message":"The file changed outside its controlled turn journal","retryable":false}).to_string(),path])?;
            }
        } else {
            let now = chrono_like_now();
            self.conn.execute("INSERT INTO recovery_changes(workspace_id,checkpoint_id,path,execution_id,tool_name,mutation_id,before_json,state,created_at,updated_at,revision) VALUES(?1,?2,?3,?4,?5,?6,?7,'before',?8,?8,1)",params![workspace,checkpoint,path,execution,intent["__recoveryTool"].as_str().unwrap_or("file_write"),operation,serde_json::to_string(&before)?,now])?;
            if let Some(hash) = before["objectHash"].as_str() {
                let readable: bool = self.conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM blobs WHERE hash=?1)",
                    [hash],
                    |r| r.get(0),
                )?;
                if !readable {
                    return Err(KernelError::Storage(
                        "journal before-image is unavailable".into(),
                    ));
                }
                self.conn.execute("INSERT INTO recovery_refs(workspace_id,owner_kind,owner_id,slot,object_hash) VALUES(?1,'change',?2,'before',?3)",params![workspace,format!("change:{checkpoint}:{path}"),hash])?;
            }
        }
        if let Some(owner) = intent["__recoveryBeforeOwner"].as_str() {
            self.conn.execute(
                "DELETE FROM object_owners WHERE owner_id=?1 AND workspace_id=?2",
                params![owner, workspace],
            )?;
        }
        Ok(())
    }
    /// The canonical file receipt and checkpoint after-image commit together, including reconciliation.
    pub(super) fn journal_file_receipt(
        &mut self,
        operation: &str,
        intent: &Value,
        receipt: &Value,
    ) -> Result<(), KernelError> {
        let Some(turn) = intent.get("__recoveryTurn") else {
            return Ok(());
        };
        let workspace = turn["workspaceId"]
            .as_str()
            .ok_or_else(|| KernelError::Storage("journal workspace missing".into()))?;
        let checkpoint = turn["checkpointId"]
            .as_str()
            .ok_or_else(|| KernelError::Storage("journal checkpoint missing".into()))?;
        let path = intent["path"]
            .as_str()
            .ok_or_else(|| KernelError::Storage("journal path missing".into()))?;
        let applied = receipt["status"] == "applied";
        let (before, previous): (String, Option<String>) = self.conn.query_row(
            "SELECT before_json,after_json FROM recovery_changes WHERE workspace_id=?1 AND checkpoint_id=?2 AND path=?3",
            params![workspace,checkpoint,path], |row| Ok((row.get(0)?,row.get(1)?)))?;
        let before: Value = serde_json::from_str(&before)?;
        let previous: Option<Value> = previous.map(|v|serde_json::from_str(&v)).transpose()?;
        let state: Value = serde_json::from_str(
            if applied {
                receipt["stateJson"].as_str()
            } else {
                intent["expectedJson"].as_str()
            }
            .ok_or_else(|| KernelError::Storage("journal after-state missing".into()))?,
        )?;
        Self::validate_recovery_state(&state, "after")?;
        self.conn.execute("UPDATE recovery_changes SET after_json=?4,state=?5,mutation_id=?6,updated_at=?7,revision=revision+1 WHERE workspace_id=?1 AND checkpoint_id=?2 AND path=?3",params![workspace,checkpoint,path,serde_json::to_string(&state)?,if applied {"after"} else {"unchanged"},operation,chrono_like_now()])?;
        if let Some(hash) = state["objectHash"].as_str() {
            self.conn.execute("INSERT INTO recovery_refs(workspace_id,owner_kind,owner_id,slot,object_hash) VALUES(?1,'change',?2,'after',?3) ON CONFLICT(workspace_id,owner_kind,owner_id,slot) DO UPDATE SET object_hash=excluded.object_hash",params![workspace,format!("change:{checkpoint}:{path}"),hash])?;
        } else {
            self.conn.execute("DELETE FROM recovery_refs WHERE workspace_id=?1 AND owner_kind='change' AND owner_id=?2 AND slot='after'", params![workspace,format!("change:{checkpoint}:{path}")])?;
        }
        let size = |after: Option<&Value>| -> (i64,i64) {
            match after.filter(|after| **after != before) {
                Some(after) => (1,before["byteLength"].as_i64().unwrap_or(0).max(after["byteLength"].as_i64().unwrap_or(0))),
                None => (0,0),
            }
        };
        let old=size(previous.as_ref());
        let new=size(Some(&state));
        self.conn.execute(
            "UPDATE recovery_checkpoints SET changed_path_count=changed_path_count+?3,byte_length=byte_length+?4,revision=revision+1 WHERE workspace_id=?1 AND id=?2",
            params![workspace,checkpoint,new.0-old.0,new.1-old.1])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::file_mutations::{FileWriteArgs, TextMutation, read_version};
    #[test]
    fn controlled_writes_keep_original_input_and_external_gap_after_reopen() {
        let root = std::env::temp_dir().join(format!("input-journal-{}", Uuid::new_v4()));
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("a.txt"), "A").unwrap();
        let mut storage = Storage::open(&root.join("storage"), "host").unwrap();
        let storage_identity = storage.root.to_string_lossy().to_string();
        storage.issue_grant(&json!({"grantId":"actor","hostGeneration":"generation","owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"thread","runId":"run","pathScopes":[""],"capabilities":["storage.read","storage.write","recovery"]}),"host","generation",&storage_identity,"epoch").unwrap();
        let params = json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":workspace});
        let (grant, params) = storage
            .authorize(
                Some("actor"),
                "epoch",
                "host",
                "generation",
                "file.root.register",
                &params,
            )
            .unwrap();
        let root_id = storage
            .dispatch("file.root.register", &params, Some("actor"), &grant)
            .unwrap()["rootId"]
            .as_str()
            .unwrap()
            .to_string();
        let anchor = JournalAnchor {
            execution_id: "run:input-1".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            run_id: "run".into(),
            entry_id: "input-1".into(),
            epoch: 1,
        };
        let write = |storage: &mut Storage, id: &str, content: &str, anchor: &JournalAnchor| {
            let resource = storage
                .resolve_file_resource(&root_id, "a.txt", &grant, false)
                .unwrap();
            let state = storage.capture_file_state(&resource).unwrap();
            let mutation = TextMutation::Write(FileWriteArgs {
                mode: None,
                path: "a.txt".into(),
                read_version: read_version(&root_id, "a.txt", &state).unwrap(),
                content: content.into(),
            });
            let receipt = storage
                .file_mutate(
                    "workspace",
                    &root_id,
                    id,
                    &mutation,
                    &grant,
                    Some(anchor),
                    varin_runtime::SourceMode::LiveRoot,
                    true,
                    &mut false,
                    None,
                )
                .unwrap();
            assert_eq!(receipt["status"], "applied");
            mutation
        };
        let first = write(&mut storage, "write-1", "B", &anchor);
        let again = storage
            .file_mutate(
                "workspace",
                &root_id,
                "write-1",
                &first,
                &grant,
                Some(&anchor),
                varin_runtime::SourceMode::LiveRoot,
                true,
                &mut false,
                    None,
            )
            .unwrap();
        assert_eq!(again["status"], "applied");
        fs::write(workspace.join("a.txt"), "C").unwrap();
        write(&mut storage, "write-2", "D", &anchor);
        let second = JournalAnchor {
            execution_id: "run:input-2".into(),
            entry_id: "input-2".into(),
            ..anchor.clone()
        };
        write(&mut storage, "write-3", "E", &second);
        let changes=storage.recovery_change_list(&json!({"workspaceId":"workspace","conversation":{"kind":"thread","threadId":"thread","branchId":"main"}}),"actor").unwrap();
        assert_eq!(changes["turns"].as_array().unwrap().len(), 2);
        assert_eq!(changes["turns"][0]["status"], "incomplete");
        assert_eq!(
            changes["turns"][0]["unrecordedResourceIds"],
            json!(["a.txt"])
        );
        let before = changes["changes"][0]["before"]["objectHash"].clone();
        assert_eq!(
            before,
            json!(format!("sha256-{}", hex::encode(Sha256::digest(b"A"))))
        );
        assert_eq!(
            changes["changes"][1]["before"]["objectHash"],
            json!(format!("sha256-{}", hex::encode(Sha256::digest(b"D"))))
        );
        drop(storage);
        let storage = Storage::open(&root.join("storage"), "host").unwrap();
        assert_eq!(
            storage
                .recovery_turn_value("workspace", "run:input-1")
                .unwrap()
                .unwrap()["status"],
            "incomplete"
        );
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }
}
