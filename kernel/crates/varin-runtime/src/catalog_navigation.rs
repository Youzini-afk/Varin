//! Explicit history-head navigation. Original Runs and effects remain immutable facts.
use super::*;
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NavigationCommand {
    pub key: String,
    pub thread_id: String,
    pub branch_id: String,
    pub expected_head_id: Option<String>,
    pub target_head_id: Option<String>,
    /// Only the exact original receipt may authorize returning to a removed descendant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undo_of: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NavigationReceipt {
    pub key: String,
    pub thread_id: String,
    pub branch_id: String,
    pub previous_head_id: Option<String>,
    pub head_id: Option<String>,
    pub already_applied: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationSelection {
    pub expected_head_id: Option<String>,
    pub target_head_id: Option<String>,
    pub removed_entry_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editor_text: Option<String>,
}
pub struct NavigationRead {
    thread: String,
    head: Option<String>,
    entry: String,
    database: std::path::PathBuf,
    epoch: u64,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct NavigationPreparation {
    command: NavigationCommand,
    epoch: u64,
    database: std::path::PathBuf,
    content: crate::content::ContentStore,
    checkpoint: Option<context::CheckpointRead>,
    previous: Option<NavigationReceipt>,
    _publication: crate::content::ContentPublication,
}
pub struct PreparedNavigation {
    command: NavigationCommand,
    epoch: u64,
    checkpoint: Option<(context::CheckpointMetadata, Value)>,
    previous: Option<NavigationReceipt>,
    _publication: crate::content::ContentPublication,
}
fn command_key(branch: &str, key: &str) -> String {
    format!("navigation:{}:{branch}:{key}", branch.len())
}
fn receipt(db: &Connection, branch: &str, key: &str) -> Result<Option<(Value, NavigationReceipt)>> {
    let row: Option<(String, String)> = db
        .query_row(
            "SELECT intent,receipt FROM commands WHERE id=?1",
            [command_key(branch, key)],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    row.map(|(intent, result)| {
        Ok((
            serde_json::from_str(&intent)?,
            serde_json::from_str(&result)?,
        ))
    })
    .transpose()
}
fn existing(db: &Connection, command: &NavigationCommand) -> Result<Option<NavigationReceipt>> {
    if let Some((original, mut result)) = receipt(db, &command.branch_id, &command.key)? {
        if original != crate::content::ContentStore::reference(&serde_json::to_value(command)?)? {
            return Err(RuntimeError::Conflict(
                "navigation key has different input".into(),
            ));
        }
        // A subsequent legal head change does not erase the original successful operation.
        result.already_applied = true;
        return Ok(Some(result));
    }
    Ok(None)
}
fn idle(db: &Connection, thread: &str, branch: &str) -> Result<Option<String>> {
    context_jobs::require_regular_branch(db, branch)?;
    let (owner, head, active): (String, Option<String>, Option<String>) = db
        .query_row(
            "SELECT thread_id,head,active_run FROM branches WHERE id=?1",
            [branch],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| RuntimeError::NotFound(branch.into()))?;
    if owner != thread {
        return Err(RuntimeError::Conflict(
            "navigation branch belongs to another Thread".into(),
        ));
    }
    if active.is_some() {
        return Err(RuntimeError::Conflict(
            "stop the branch's foreground Run before navigating its history".into(),
        ));
    }
    let activating: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM input_queue WHERE branch_id=?1 AND state='queued' AND activation='activating')", [branch], |r| r.get(0))?;
    if activating {
        return Err(RuntimeError::Conflict(
            "a branch input is being committed".into(),
        ));
    }
    Ok(head)
}
fn ancestry(
    db: &Connection,
    thread: &str,
    head: Option<String>,
    stop: Option<&str>,
) -> Result<Vec<HistoryItem>> {
    let mut cursor = head;
    let mut result = Vec::new();
    while cursor.as_deref() != stop {
        let key = cursor.ok_or_else(|| {
            RuntimeError::Conflict("navigation target is not on the selected ancestry".into())
        })?;
        let item: HistoryItem = record(db, "history", &key)?;
        if item.thread_id != thread {
            return Err(RuntimeError::Conflict("history owner changed".into()));
        }
        cursor = item.parent.clone();
        result.push(item);
    }
    Ok(result)
}
impl Catalog {
    pub fn capture_navigation(
        &self,
        thread: &str,
        branch: &str,
        entry: &str,
    ) -> Result<NavigationRead> {
        let head = idle(&self.db, thread, branch)?;
        Ok(NavigationRead {
            thread: thread.into(),
            head,
            entry: entry.into(),
            database: self.database_path.clone(),
            epoch: self.epoch,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn latest_navigation_receipt(
        &self,
        thread: &str,
        branch: &str,
    ) -> Result<Option<NavigationReceipt>> {
        if self.branch_thread_id(branch)? != thread {
            return Err(RuntimeError::Conflict(
                "navigation branch belongs to another Thread".into(),
            ));
        }
        let value: Option<String> = self.db.query_row("SELECT data FROM events WHERE subject=?1 AND kind='branch.navigated' ORDER BY cursor DESC LIMIT 1", [branch], |row| row.get(0)).optional()?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .transpose()
    }
    pub fn navigation_receipt(
        &self,
        thread: &str,
        branch: &str,
        key: &str,
    ) -> Result<Option<NavigationReceipt>> {
        if self.branch_thread_id(branch)? != thread {
            return Err(RuntimeError::Conflict(
                "navigation branch belongs to another Thread".into(),
            ));
        }
        Ok(receipt(&self.db, branch, key)?.map(|(_, mut value)| {
            value.already_applied = true;
            value
        }))
    }
    pub fn prepare_navigation(&self, command: NavigationCommand) -> Result<NavigationPreparation> {
        if command.key.is_empty() {
            return Err(RuntimeError::Invalid("navigation key is required".into()));
        }
        if self.branch_thread_id(&command.branch_id)? != command.thread_id {
            return Err(RuntimeError::Conflict(
                "navigation branch belongs to another Thread".into(),
            ));
        }
        let previous = existing(&self.db, &command)?;
        if previous.is_none()
            && idle(&self.db, &command.thread_id, &command.branch_id)? != command.expected_head_id
        {
            return Err(RuntimeError::Conflict(
                "navigation expected head changed".into(),
            ));
        }
        Ok(NavigationPreparation {
            checkpoint: if previous.is_none() {
                self.capture_active_checkpoint(&command.branch_id)?
            } else {
                None
            },
            command,
            previous,
            epoch: self.epoch,
            database: self.database_path.clone(),
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn commit_navigation(&mut self, prepared: PreparedNavigation) -> Result<NavigationReceipt> {
        let PreparedNavigation {
            command,
            epoch,
            checkpoint,
            previous,
            _publication,
        } = prepared;
        if epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "navigation preparation belongs to an old owner".into(),
            ));
        }
        if let Some(result) = existing(&self.db, &command)? {
            return Ok(result);
        }
        if previous.is_some() {
            return Err(RuntimeError::Conflict(
                "navigation receipt disappeared".into(),
            ));
        }
        let tx = self.db.transaction()?;
        if idle(&tx, &command.thread_id, &command.branch_id)? != command.expected_head_id {
            return Err(RuntimeError::Conflict(
                "navigation expected head changed".into(),
            ));
        }
        if let Some((checkpoint, reference)) = checkpoint {
            context::publish_metadata(&tx, &checkpoint, &reference)?;
        } else {
            let has_context: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM active_contexts WHERE branch_id=?1)",
                [&command.branch_id],
                |r| r.get(0),
            )?;
            if has_context {
                return Err(RuntimeError::Conflict(
                    "navigation context changed during preparation".into(),
                ));
            }
        }
        let changed = tx.execute(
            "UPDATE branches SET head=?2 WHERE id=?1 AND head IS ?3 AND active_run IS NULL",
            params![
                command.branch_id,
                command.target_head_id,
                command.expected_head_id
            ],
        )?;
        if changed != 1 {
            return Err(RuntimeError::Conflict("navigation branch changed".into()));
        }
        let result = NavigationReceipt {
            key: command.key.clone(),
            thread_id: command.thread_id.clone(),
            branch_id: command.branch_id.clone(),
            previous_head_id: command.expected_head_id.clone(),
            head_id: command.target_head_id.clone(),
            already_applied: false,
        };
        event(
            &tx,
            &command.branch_id,
            1,
            "branch.navigated",
            serde_json::to_value(&result)?,
        )?;
        tx.execute(
            "INSERT INTO commands(id,intent,receipt) VALUES(?1,?2,?3)",
            params![
                command_key(&command.branch_id, &command.key),
                encode(&crate::content::ContentStore::reference(
                    &serde_json::to_value(&command)?
                )?)?,
                encode(&result)?
            ],
        )?;
        tx.commit()?;
        Ok(result)
    }
}
impl NavigationRead {
    pub fn load(self) -> Result<NavigationSelection> {
        let db = history_views::current_history_owner(&self.database, self.epoch)?;
        let mut removed = ancestry(&db, &self.thread, self.head.clone(), Some(&self.entry))?;
        let selected: HistoryItem = record(&db, "history", &self.entry)?;
        if selected.thread_id != self.thread {
            return Err(RuntimeError::Conflict(
                "selected history owner differs".into(),
            ));
        }
        let selected = self.content.hydrate_history(selected)?;
        let before = selected.source == HistorySource::User;
        let target = if before {
            selected.parent.clone()
        } else {
            Some(selected.id.clone())
        };
        if before {
            removed.push(selected.clone());
        }
        let mut remaining = ancestry(&db, &self.thread, target.clone(), None)?;
        remaining.reverse();
        crate::execution::validate_history_pairs(&context_jobs::hydrate_source(
            &self.content,
            remaining,
        )?)
        .map_err(|e| RuntimeError::Invalid(e.to_string()))?;
        history_views::current_history_owner(&self.database, self.epoch)?;
        Ok(NavigationSelection {
            expected_head_id: self.head,
            target_head_id: target,
            removed_entry_ids: removed.into_iter().map(|item| item.id).collect(),
            editor_text: if before {
                selected
                    .content
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            } else {
                None
            },
        })
    }
}
impl NavigationPreparation {
    pub fn load(self) -> Result<PreparedNavigation> {
        let Self {
            command,
            epoch,
            database,
            content,
            checkpoint,
            previous,
            _publication,
        } = self;
        if previous.is_some() {
            return Ok(PreparedNavigation {
                command,
                epoch,
                checkpoint: None,
                previous,
                _publication,
            });
        }
        let db = history_views::current_history_owner(&database, epoch)?;
        content.save(&serde_json::to_value(&command)?)?;
        if let Some(undo) = &command.undo_of {
            let (_, original) = receipt(&db, &command.branch_id, undo)?
                .ok_or_else(|| RuntimeError::NotFound("original navigation receipt".into()))?;
            if original.head_id != command.expected_head_id
                || original.previous_head_id != command.target_head_id
            {
                return Err(RuntimeError::Conflict(
                    "undo no longer matches the original navigation".into(),
                ));
            }
        } else {
            ancestry(
                &db,
                &command.thread_id,
                command.expected_head_id.clone(),
                command.target_head_id.as_deref(),
            )?;
        }
        let mut remaining = ancestry(
            &db,
            &command.thread_id,
            command.target_head_id.clone(),
            None,
        )?;
        let ids = remaining
            .iter()
            .map(|item| item.id.clone())
            .collect::<std::collections::BTreeSet<_>>();
        remaining.reverse();
        crate::execution::validate_history_pairs(&context_jobs::hydrate_source(
            &content, remaining,
        )?)
        .map_err(|e| RuntimeError::Invalid(e.to_string()))?;
        let checkpoint = checkpoint
            .map(|read| -> Result<_> {
                let mut value = read.load()?;
                value.proposal.expected_revision = value.revision;
                value.revision += 1;
                value.id = format!(
                    "navigation-context:{}",
                    command_key(&command.branch_id, &command.key)
                );
                value.proposal.key = value.id.clone();
                if value
                    .proposal
                    .through_id
                    .as_ref()
                    .is_some_and(|id| !ids.contains(id))
                {
                    value.proposal.through_id = None;
                    value.proposal.summary.clear();
                    value.resource_activations.clear();
                    if let Some(snapshot) = value.bot_memory_snapshot.take() {
                        if value.proposal.memory_checkpoint.as_deref()
                            == Some(snapshot.identity()?.as_str())
                        {
                            value.proposal.memory_checkpoint = None;
                        }
                    }
                }
                // A new context revision also fences already-prepared summarization candidates.
                let reference = value.save(&content)?;
                Ok((context::CheckpointMetadata::from(&value), reference))
            })
            .transpose()?;
        history_views::current_history_owner(&database, epoch)?;
        Ok(PreparedNavigation {
            command,
            epoch,
            checkpoint,
            previous,
            _publication,
        })
    }
}
