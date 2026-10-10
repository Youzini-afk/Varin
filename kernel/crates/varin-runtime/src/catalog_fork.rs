//! A fork fixes an immutable ancestor and its captured context, not the source's moving leaf.
use super::*;

pub struct BranchForkPreparation {
    source: String,
    target: String,
    head: Option<String>,
    thread: String,
    identity: Value,
    epoch: u64,
    contents: Option<ForkContents>,
}
struct ForkContents {
    source_head: Option<String>,
    database: std::path::PathBuf,
    checkpoint: Option<context::CheckpointRead>,
    memory: Option<Value>,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedBranchFork {
    source: String,
    target: String,
    head: Option<String>,
    thread: String,
    identity: Value,
    epoch: u64,
    admission: ForkAdmission,
}
enum ForkAdmission {
    Existing,
    Candidate {
        checkpoint: Option<(context::CheckpointMetadata, Value)>,
        memory: Option<Value>,
        _publication: crate::content::ContentPublication,
    },
}
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchForkReceipt {
    pub thread_id: String,
    pub branch_id: String,
}
impl Catalog {
    pub fn prepare_branch_fork(
        &self,
        source: &str,
        target: &str,
        head: Option<&str>,
        plan_capture: Option<plan::PlanForkCapture>,
    ) -> Result<BranchForkPreparation> {
        let source_view = self.plan_view(source, head)?;
        let mut identity = json!({"source":source,"head":head});
        if let Some(capture) = plan_capture {
            if capture.source_thread_id != source_view.thread_id
                || capture.source_branch_id != source
                || capture.target_branch_id != target
                || capture.head_id.as_deref() != head
                || capture.inherited_ref != source_view.inherited_ref
            {
                return Err(RuntimeError::Conflict(
                    "plan capture does not identify the source fork".into(),
                ));
            }
            identity["planCapture"] = serde_json::to_value(capture)?;
        }
        let existing = self.fork_creation(target, &identity)?;
        let contents = if existing {
            None
        } else {
            Some(ForkContents {
                source_head: self.head(source)?,
                database: self
                    .db
                    .path()
                    .ok_or_else(|| RuntimeError::Invalid("Catalog has no database".into()))?
                    .into(),
                checkpoint: self.capture_active_checkpoint(source)?,
                memory: self.memory_state_identity(source)?,
                content: self.content.clone(),
                publication: self.content.begin_publication(),
            })
        };
        Ok(BranchForkPreparation {
            source: source.into(),
            target: target.into(),
            head: head.map(str::to_owned),
            thread: source_view.thread_id,
            identity,
            epoch: self.epoch,
            contents,
        })
    }
    fn fork_creation(&self, target: &str, identity: &Value) -> Result<bool> {
        let creation:Option<String>=self.db.query_row("SELECT data FROM events WHERE subject=?1 AND kind='branch.created' ORDER BY cursor LIMIT 1",[target],|row|row.get(0)).optional()?;
        if let Some(creation) = creation {
            if serde_json::from_str::<Value>(&creation)? == *identity {
                return Ok(true);
            }
            return Err(RuntimeError::Conflict(
                "branch identity has different fork input".into(),
            ));
        }
        let exists: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM branches WHERE id=?1)",
            [target],
            |row| row.get(0),
        )?;
        if exists {
            return Err(RuntimeError::Conflict(
                "branch identity already exists".into(),
            ));
        }
        Ok(false)
    }
    pub fn admit_branch_fork(&mut self, prepared: PreparedBranchFork) -> Result<BranchForkReceipt> {
        let PreparedBranchFork {
            source,
            target,
            head,
            thread,
            identity,
            epoch,
            admission,
        } = prepared;
        if epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "fork preparation belongs to a previous owner".into(),
            ));
        }
        let receipt = BranchForkReceipt {
            thread_id: thread.clone(),
            branch_id: target.clone(),
        };
        if self.fork_creation(&target, &identity)? {
            return Ok(receipt);
        }
        let ForkAdmission::Candidate {
            checkpoint,
            memory,
            _publication,
        } = admission
        else {
            return Err(RuntimeError::Conflict(
                "original fork admission is unavailable".into(),
            ));
        };
        if self.branch_thread_id(&source)? != thread {
            return Err(RuntimeError::Conflict(
                "fork source identity changed".into(),
            ));
        }
        let tx = self.db.transaction()?;
        tx.execute(
            "INSERT INTO branches(id,thread_id,head) VALUES(?1,?2,?3)",
            params![target, thread, head],
        )?;
        if let Some(memory) = memory {
            tx.execute(
                "INSERT INTO memory_states(branch_id,body) VALUES(?1,?2)",
                params![target, encode(&memory)?],
            )?;
        }
        if let Some((checkpoint, reference)) = checkpoint {
            context::publish_metadata(&tx, &checkpoint, &reference)?;
        }
        event(&tx, &target, 1, "branch.created", identity)?;
        tx.commit()?;
        Ok(receipt)
    }
}
impl BranchForkPreparation {
    pub fn load(self) -> Result<PreparedBranchFork> {
        let Self {
            source,
            target,
            head,
            thread,
            identity,
            epoch,
            contents,
        } = self;
        let admission = if let Some(contents) = contents {
            if let Some(head) = head.as_deref() {
                let db = Connection::open_with_flags(
                    &contents.database,
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                        | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
                )?;
                let mut cursor = contents.source_head;
                while cursor.as_deref() != Some(head) {
                    let key = cursor.ok_or_else(|| {
                        RuntimeError::Invalid("fork head is not an ancestor".into())
                    })?;
                    cursor = db
                        .query_row("SELECT parent FROM history WHERE id=?1", [&key], |row| {
                            row.get(0)
                        })
                        .optional()?
                        .ok_or_else(|| RuntimeError::NotFound(key))?;
                }
                let mut metadata = Vec::new();
                while let Some(key) = cursor {
                    let item: HistoryItem = record(&db, "history", &key)?;
                    cursor = item.parent.clone();
                    metadata.push(item);
                }
                metadata.reverse();
                let history = context_jobs::hydrate_source(&contents.content, metadata)?;
                crate::execution::validate_history_pairs(&history)
                    .map_err(|error| RuntimeError::Invalid(error.to_string()))?;
            }
            let checkpoint = contents
                .checkpoint
                .map(|read| -> Result<_> {
                    let original = read.load()?;
                    let proposal = context::ContextProposal {
                        key: format!("fork-context:{target}"),
                        branch_id: target.clone(),
                        through_id: None,
                        expected_revision: 0,
                        summary: String::new(),
                        effective_system_prompt: original.proposal.effective_system_prompt,
                        instruction_sources: original.proposal.instruction_sources,
                        memory_checkpoint: original.proposal.memory_checkpoint,
                    };
                    let body = context::ContextCheckpoint {
                        id: proposal.key.clone(),
                        revision: 1,
                        proposal,
                        personalization: original.personalization,
                        resources: original.resources,
                    };
                    let reference = contents.content.save(&serde_json::to_value(&body)?)?;
                    Ok((context::CheckpointMetadata::from(&body), reference))
                })
                .transpose()?;
            ForkAdmission::Candidate {
                checkpoint,
                memory: contents.memory,
                _publication: contents.publication,
            }
        } else {
            ForkAdmission::Existing
        };
        Ok(PreparedBranchFork {
            source,
            target,
            head,
            thread,
            identity,
            epoch,
            admission,
        })
    }
}
