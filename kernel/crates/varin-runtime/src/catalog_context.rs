//! Active context checkpoints retain original conversation bodies and provider items.
use super::*;
use crate::execution::{Content, ContextProjection, ConversationItem, Provenance};
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContextProposal {
    pub key: String,
    pub branch_id: String,
    pub through_id: Option<String>,
    pub expected_revision: u64,
    pub summary: String,
    pub effective_system_prompt: String,
    pub instruction_sources: Vec<String>,
    pub memory_checkpoint: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContextCheckpoint {
    pub id: String,
    pub revision: u64,
    pub proposal: ContextProposal,
}

pub(super) fn initialize(db: &mut Connection) -> Result<()> {
    let tx = db.transaction()?;
    let version: Option<i64> = tx
        .query_row(
            "SELECT version FROM runtime_domains WHERE name='context_checkpoints'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    match version {
        None => {
            tx.execute_batch("CREATE TABLE context_checkpoints(id TEXT PRIMARY KEY,branch_id TEXT NOT NULL REFERENCES branches(id),revision INTEGER NOT NULL,through_id TEXT REFERENCES history(id),body TEXT NOT NULL,UNIQUE(branch_id,revision)); CREATE TABLE active_contexts(branch_id TEXT PRIMARY KEY REFERENCES branches(id),checkpoint_id TEXT NOT NULL REFERENCES context_checkpoints(id)); INSERT INTO runtime_domains(name,version) VALUES('context_checkpoints',1);")?;
        }
        Some(1) => {
            for (table, expected) in [
                (
                    "context_checkpoints",
                    vec!["id", "branch_id", "revision", "through_id", "body"],
                ),
                ("active_contexts", vec!["branch_id", "checkpoint_id"]),
            ] {
                let mut statement = tx.prepare(&format!("PRAGMA table_info({table})"))?;
                let columns = statement
                    .query_map([], |r| r.get::<_, String>(1))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                if columns != expected {
                    return Err(RuntimeError::Invalid(
                        "context checkpoint schema is malformed; data preserved".into(),
                    ));
                }
            }
        }
        Some(_) => {
            return Err(RuntimeError::Invalid(
                "unsupported context checkpoint format; data preserved".into(),
            ))
        }
    }
    tx.commit()?;
    Ok(())
}
impl Catalog {
    pub fn active_context(&self, branch_id: &str) -> Result<Option<ContextCheckpoint>> {
        let reference:Option<String>=self.db.query_row("SELECT c.body FROM active_contexts a JOIN context_checkpoints c ON c.id=a.checkpoint_id WHERE a.branch_id=?1",[branch_id],|r|r.get(0)).optional()?;
        reference
            .map(|reference| {
                Ok::<ContextCheckpoint, RuntimeError>(serde_json::from_value(
                    self.content.load(&serde_json::from_str(&reference)?)?,
                )?)
            })
            .transpose()
    }
    /// A candidate fixes an ancestor, not a moving leaf. Appended tail input remains untouched.
    pub fn publish_context(&mut self, proposal: ContextProposal) -> Result<ContextCheckpoint> {
        let duplicate: Option<String> = self
            .db
            .query_row(
                "SELECT body FROM context_checkpoints WHERE id=?1",
                [&proposal.key],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(reference) = duplicate {
            let previous: ContextCheckpoint =
                serde_json::from_value(self.content.load(&serde_json::from_str(&reference)?)?)?;
            return if previous.proposal == proposal {
                Ok(previous)
            } else {
                Err(RuntimeError::Conflict(
                    "context candidate identity has different content".into(),
                ))
            };
        }
        if let Some(through_id) = proposal.through_id.as_deref() {
            let history = self.execution_history(&proposal.branch_id)?;
            let through = history
                .iter()
                .position(|item| item.id == through_id)
                .ok_or_else(|| {
                    RuntimeError::Conflict(
                        "context boundary is no longer on the selected branch".into(),
                    )
                })?;
            crate::execution::validate_history_pairs(&history[..=through])
                .map_err(|error| RuntimeError::Conflict(error.to_string()))?;
            if proposal.summary.trim().is_empty() {
                return Err(RuntimeError::Invalid(
                    "compaction requires a summary".into(),
                ));
            }
        } else {
            self.head(&proposal.branch_id)?;
            if !proposal.summary.is_empty() {
                return Err(RuntimeError::Invalid(
                    "a summary requires an ancestor range".into(),
                ));
            }
        }
        let revision = proposal
            .expected_revision
            .checked_add(1)
            .ok_or_else(|| RuntimeError::Invalid("context revision exhausted".into()))?;
        let checkpoint = ContextCheckpoint {
            id: proposal.key.clone(),
            revision,
            proposal,
        };
        let reference = self.content.save(&serde_json::to_value(&checkpoint)?)?;
        let tx = self.db.transaction()?;
        let current:Option<u64>=tx.query_row("SELECT c.revision FROM active_contexts a JOIN context_checkpoints c ON c.id=a.checkpoint_id WHERE a.branch_id=?1",[&checkpoint.proposal.branch_id],|r|read_number(r,0)).optional()?;
        if current.unwrap_or(0) != checkpoint.proposal.expected_revision {
            return Err(RuntimeError::Conflict(
                "active context checkpoint changed".into(),
            ));
        }
        tx.execute("INSERT INTO context_checkpoints(id,branch_id,revision,through_id,body) VALUES(?1,?2,?3,?4,?5)",params![checkpoint.id,checkpoint.proposal.branch_id,sql_number(revision)?,checkpoint.proposal.through_id,encode(&reference)?])?;
        tx.execute("INSERT INTO active_contexts(branch_id,checkpoint_id) VALUES(?1,?2) ON CONFLICT(branch_id) DO UPDATE SET checkpoint_id=excluded.checkpoint_id",params![checkpoint.proposal.branch_id,checkpoint.id])?;
        event(
            &tx,
            &checkpoint.proposal.branch_id,
            revision,
            "context.published",
            json!({"checkpoint_id":checkpoint.id,"through_id":checkpoint.proposal.through_id}),
        )?;
        tx.commit()?;
        Ok(checkpoint)
    }
    pub fn prepare_context_read(
        &self,
        run_id: &str,
        epoch: u64,
        expected_head: Option<&str>,
    ) -> Result<Option<ContextRead>> {
        let run = self.run(run_id)?;
        fence(&run, epoch)?;
        if self.head(&run.branch_id)?.as_deref() != expected_head {
            return Err(RuntimeError::Conflict(
                "context branch changed during preparation".into(),
            ));
        }
        let active:Option<(String,Option<String>,String)>=self.db.query_row("SELECT c.id,c.through_id,c.body FROM active_contexts a JOIN context_checkpoints c ON c.id=a.checkpoint_id WHERE a.branch_id=?1",[&run.branch_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let Some((checkpoint_id, through_id, reference)) = active else {
            return Ok(None);
        };
        let mut cursor = self.head(&run.branch_id)?;
        let mut suffix = Vec::new();
        while cursor.as_deref() != through_id.as_deref() {
            let key = cursor.ok_or_else(|| {
                RuntimeError::Conflict("active context boundary is not an ancestor".into())
            })?;
            let metadata: HistoryItem = record(&self.db, "history", &key)?;
            cursor = metadata.parent.clone();
            suffix.push(metadata);
        }
        suffix.reverse();
        Ok(Some(ContextRead {
            content: self.content.clone(),
            checkpoint_id,
            reference: serde_json::from_str(&reference)?,
            suffix,
        }))
    }
}
/// The immutable, already-referenced bodies are loaded after releasing the Catalog owner.
pub struct ContextRead {
    content: crate::content::ContentStore,
    checkpoint_id: String,
    reference: Value,
    suffix: Vec<HistoryItem>,
}
impl ContextRead {
    pub fn load(self) -> Result<ContextProjection> {
        let checkpoint: ContextCheckpoint =
            serde_json::from_value(self.content.load(&self.reference)?)?;
        let mut history = Vec::new();
        if !checkpoint.proposal.effective_system_prompt.is_empty() {
            history.push(ConversationItem {
                id: format!("context:{}:system", checkpoint.id),
                provenance: Provenance::SystemInstruction {
                    source: checkpoint.id.clone(),
                },
                content: Content::Text {
                    text: checkpoint.proposal.effective_system_prompt.clone(),
                },
                opaque: None,
            });
        }
        if checkpoint.proposal.through_id.is_some() {
            history.push(ConversationItem {
                id: format!("context:{}:summary", checkpoint.id),
                provenance: Provenance::ExternalData {
                    source: format!("conversation-summary:{}", checkpoint.id),
                },
                content: Content::Text {
                    text: checkpoint.proposal.summary.clone(),
                },
                opaque: None,
            });
        }
        for metadata in self.suffix {
            let item = self.content.hydrate_history(metadata)?;
            if item.source == HistorySource::User {
                history.extend(super::execution_persistence::user_input_items(
                    &item.id,
                    &item.content,
                )?);
            } else {
                history.push(serde_json::from_value(item.content)?);
            }
        }
        Ok(ContextProjection {
            checkpoint_id: self.checkpoint_id,
            history,
            instruction_sources: checkpoint.proposal.instruction_sources,
            memory_checkpoint: checkpoint.proposal.memory_checkpoint,
        })
    }
}
