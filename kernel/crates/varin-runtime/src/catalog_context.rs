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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub personalization: Option<super::personalization::PersonalizationBasis>,
}

/// Read-only guard before opening a writable connection or checkpointing committed WAL.
pub(super) fn check_format(db: &Connection) -> Result<()> {
    let version: i64 = db.query_row("SELECT version FROM runtime_domains WHERE name='context_checkpoints'", [], |row| row.get(0))?;
    if version != 3 { return Err(RuntimeError::Invalid("unsupported context checkpoint format; data preserved".into())); }
    for (table, expected, foreign_keys) in [
        ("context_checkpoints", vec![("id","TEXT",0,1),("branch_id","TEXT",1,0),("revision","INTEGER",1,0),("through_id","TEXT",0,0),("body","TEXT",1,0),("project_id","TEXT",0,0)], vec![("branches","branch_id","id"),("history","through_id","id")]),
        ("active_contexts", vec![("branch_id","TEXT",0,1),("checkpoint_id","TEXT",1,0)], vec![("branches","branch_id","id"),("context_checkpoints","checkpoint_id","id")]),
        ("runs", vec![("id","TEXT",0,1),("branch_id","TEXT",1,0),("body","TEXT",1,0),("context_checkpoint_id","TEXT",0,0)], vec![("branches","branch_id","id"),("context_checkpoints","context_checkpoint_id","id")]),
        ("memory_states", vec![("branch_id","TEXT",0,1),("body","TEXT",1,0)], vec![("branches","branch_id","id")]),
    ] {
        let table_type: Option<String> = db.query_row("SELECT type FROM sqlite_master WHERE name=?1", [table], |row| row.get(0)).optional()?;
        let mut statement = db.prepare(&format!("PRAGMA table_info({table})"))?;
        let columns = statement.query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(5)?)))?.collect::<std::result::Result<Vec<_>, _>>()?;
        let expected = expected.into_iter().map(|(name, kind, required, pk)| (name.to_string(),kind.to_string(),required,pk)).collect::<Vec<_>>();
        let mut statement = db.prepare(&format!("PRAGMA foreign_key_list({table})"))?;
        let mut actual_keys = statement.query_map([], |r| Ok((r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?, r.get::<_, String>(5)?, r.get::<_, String>(6)?, r.get::<_, String>(7)?)))?.collect::<std::result::Result<Vec<_>, _>>()?;
        actual_keys.sort();
        let mut expected_keys = foreign_keys.into_iter().map(|(target, from, to)| (target.to_string(),from.to_string(),to.to_string(),"NO ACTION".to_string(),"NO ACTION".to_string(),"NONE".to_string())).collect::<Vec<_>>();
        expected_keys.sort();
        if table_type.as_deref() != Some("table") || columns != expected || actual_keys != expected_keys {
            return Err(RuntimeError::Invalid("context checkpoint schema is malformed; data preserved".into()));
        }
    }
    for (table, columns, primary) in [
        ("context_checkpoints", vec!["id"], true),
        ("context_checkpoints", vec!["branch_id", "revision"], false),
        ("active_contexts", vec!["branch_id"], true),
        ("runs", vec!["id"], true),
        ("memory_states", vec!["branch_id"], true),
    ] {
        if !has_canonical_unique_index(db, table, &columns, primary)? {
            return Err(RuntimeError::Invalid("context key schema is unsupported; data preserved".into()));
        }
    }
    Ok(())
}

// These domain keys are TEXT primary keys or an explicit compound UNIQUE, so each
// has a physical index. Partial uniqueness is insufficient; collation and direction
// are part of this format's canonical DDL (DESC alone does not weaken uniqueness).
fn has_canonical_unique_index(db: &Connection, table: &str, columns: &[&str], primary: bool) -> Result<bool> {
    let mut statement = db.prepare("SELECT name, [unique], origin, partial FROM pragma_index_list(?1)")?;
    let indexes = statement.query_map([table], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?)))?.collect::<std::result::Result<Vec<_>, _>>()?;
    for (name, unique, origin, partial) in indexes {
        if unique != 1 || partial != 0 || (primary && origin != "pk") { continue; }
        let mut statement = db.prepare("SELECT name, coll, [desc] FROM pragma_index_xinfo(?1) WHERE [key]=1 ORDER BY seqno")?;
        let keys = statement.query_map([name], |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)))?.collect::<std::result::Result<Vec<_>, _>>()?;
        if keys.len() == columns.len() && keys.iter().zip(columns).all(|((name, collation, descending), column)| {
            name.as_deref() == Some(*column) && collation == "BINARY" && *descending == 0
        }) { return Ok(true); }
    }
    Ok(false)
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
            tx.execute_batch("CREATE TABLE memory_states(branch_id TEXT PRIMARY KEY REFERENCES branches(id),body TEXT NOT NULL); CREATE TABLE context_checkpoints(id TEXT PRIMARY KEY,branch_id TEXT NOT NULL REFERENCES branches(id),revision INTEGER NOT NULL,through_id TEXT REFERENCES history(id),body TEXT NOT NULL,project_id TEXT,UNIQUE(branch_id,revision)); CREATE TABLE active_contexts(branch_id TEXT PRIMARY KEY REFERENCES branches(id),checkpoint_id TEXT NOT NULL REFERENCES context_checkpoints(id)); INSERT INTO runtime_domains(name,version) VALUES('context_checkpoints',3);")?;
        }
        Some(3) => {}
        Some(_) => {
            return Err(RuntimeError::Invalid(
                "unsupported context checkpoint format; data preserved".into(),
            ))
        }
    }
    for (table, expected) in [
        (
            "context_checkpoints",
            vec!["id", "branch_id", "revision", "through_id", "body", "project_id"],
        ),
        ("active_contexts", vec!["branch_id", "checkpoint_id"]),
        ("runs", vec!["id", "branch_id", "body", "context_checkpoint_id"]),
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
    tx.commit()?;
    Ok(())
}
impl Catalog {
    /// Run admission pins project scope independently of later branch context publication.
    /// Read its small immutable checkpoint metadata, never the prompt body or current UI selection.
    pub fn run_project_id(&self, run_id: &str) -> Result<Option<String>> {
        self.db.query_row(
            "SELECT c.project_id FROM runs r LEFT JOIN context_checkpoints c ON c.id=r.context_checkpoint_id WHERE r.id=?1",
            [run_id], |row| row.get(0),
        ).optional()?.ok_or_else(|| RuntimeError::NotFound(run_id.into()))
    }
    pub fn active_context(&self, branch_id: &str) -> Result<Option<ContextCheckpoint>> {
        self.capture_active_checkpoint(branch_id)?.map(CheckpointRead::load).transpose()
    }
    pub fn capture_active_checkpoint(&self, branch_id: &str) -> Result<Option<CheckpointRead>> {
        self.capture_checkpoint("SELECT c.id,c.revision,c.body FROM active_contexts a JOIN context_checkpoints c ON c.id=a.checkpoint_id WHERE a.branch_id=?1",branch_id)
    }
    pub fn capture_admitted_checkpoint(&self, run_id: &str) -> Result<Option<CheckpointRead>> {
        self.capture_checkpoint("SELECT c.id,c.revision,c.body FROM runs r JOIN context_checkpoints c ON c.id=r.context_checkpoint_id WHERE r.id=?1",run_id)
    }
    fn capture_checkpoint(&self, sql: &str, id: &str) -> Result<Option<CheckpointRead>> {
        let metadata: Option<(String,u64,String)> = self.db.query_row(sql,[id],|row| Ok((row.get(0)?,read_number(row,1)?,row.get(2)?))).optional()?;
        metadata.map(|(id, revision, reference)| Ok(CheckpointRead {id,revision,reference:serde_json::from_str(&reference)?,
            content:self.content.clone(),_publication:self.content.begin_publication()})).transpose()
    }
    /// A candidate fixes an ancestor, not a moving leaf. Appended tail input remains untouched.
    pub fn publish_context(&mut self, proposal: ContextProposal) -> Result<ContextCheckpoint> {
        let (checkpoint, reference) = self.stage_context(proposal)?;
        let tx = self.db.transaction()?;
        publish_prepared(&tx, &checkpoint, &reference)?;
        tx.commit()?;
        Ok(checkpoint)
    }
    pub(super) fn stage_context(
        &self,
        proposal: ContextProposal,
    ) -> Result<(ContextCheckpoint, Value)> {
        self.stage_context_with_personalization(proposal, None)
    }
    pub(super) fn stage_context_with_personalization(
        &self,
        proposal: ContextProposal,
        personalization: Option<super::personalization::PersonalizationBasis>,
    ) -> Result<(ContextCheckpoint, Value)> {
        if let Some(basis) = &personalization { basis.validate()?; }
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
            return if previous.proposal == proposal && personalization.as_ref().is_none_or(|basis| previous.personalization.as_ref() == Some(basis)) {
                Ok((previous, serde_json::from_str(&reference)?))
            } else {
                Err(RuntimeError::Conflict(
                    "context candidate identity has different content".into(),
                ))
            };
        }
        if let Some(through_id) = proposal.through_id.as_deref() {
            let metadata = self.context_source_metadata(&proposal.branch_id, through_id)?;
            let history = super::context_jobs::hydrate_source(&self.content, metadata)?;
            crate::execution::validate_history_pairs(&history)
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
        let personalization = match personalization {
            Some(basis) => Some(basis),
            None => self.active_context(&proposal.branch_id)?.and_then(|context| context.personalization),
        };
        let checkpoint = ContextCheckpoint {
            id: proposal.key.clone(),
            revision,
            proposal,
            personalization,
        };
        let reference = self.content.save(&serde_json::to_value(&checkpoint)?)?;
        Ok((checkpoint, reference))
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
        let capture = |kind| -> Result<ContextRead> { Ok(ContextRead { kind,
            database:self.db.path().ok_or_else(||RuntimeError::Invalid("Catalog has no database".into()))?.into(),
            _publication:self.content.begin_publication() }) };
        if let Some(request) = run.configuration.get("context_job") {
            let request: crate::context_job::ContextJobRequest =
                serde_json::from_value(request.clone())?;
            let source: crate::context_job::SummarySource = serde_json::from_value(run.configuration.get("context_job_source")
                .ok_or_else(|| RuntimeError::Invalid("context job has no frozen summary source".into()))?.clone())?;
            return Ok(Some(capture(ContextReadKind::Summary {
                content: self.content.clone(),
                request,
                source,
            })?));
        }
        let active:Option<(String,Option<String>,String)>=self.db.query_row("SELECT c.id,c.through_id,c.body FROM active_contexts a JOIN context_checkpoints c ON c.id=a.checkpoint_id WHERE a.branch_id=?1",[&run.branch_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let Some((checkpoint_id, through_id, reference)) = active else {
            return Ok(None);
        };
        Ok(Some(capture(ContextReadKind::Checkpoint {
            compositions: self.context_compositions.clone(),
            branch_id: run.branch_id.clone(),
            memory: self.memory_state(&run.branch_id)?,
            trusted_receipts: self.trusted_memory_receipts(&run.thread_id)?,
            content: self.content.clone(),
            checkpoint_id,
            reference: serde_json::from_str(&reference)?,
            head:expected_head.map(str::to_owned), through_id,
        })?))
    }
}
/// The immutable, already-referenced bodies are loaded after releasing the Catalog owner.
/// Called with the candidate body already durable and all caller-specific fences checked.
pub(super) fn publish_prepared(
    tx: &Transaction<'_>,
    checkpoint: &ContextCheckpoint,
    reference: &Value,
) -> Result<()> {
    let prior: Option<String> = tx
        .query_row(
            "SELECT body FROM context_checkpoints WHERE id=?1",
            [&checkpoint.id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(prior) = prior {
        if serde_json::from_str::<Value>(&prior)? == *reference {
            return Ok(());
        }
        return Err(RuntimeError::Conflict(
            "context candidate identity has different content".into(),
        ));
    }
    let current:Option<u64>=tx.query_row("SELECT c.revision FROM active_contexts a JOIN context_checkpoints c ON c.id=a.checkpoint_id WHERE a.branch_id=?1",[&checkpoint.proposal.branch_id],|r|read_number(r,0)).optional()?;
    if current.unwrap_or(0) != checkpoint.proposal.expected_revision {
        return Err(RuntimeError::Conflict(
            "active context checkpoint changed".into(),
        ));
    }
    // Searchable metadata is derived from this exact immutable body in the same publication.
    // It is not an independently editable project/configuration store.
    tx.execute("INSERT INTO context_checkpoints(id,branch_id,revision,through_id,body,project_id) VALUES(?1,?2,?3,?4,?5,?6)",params![checkpoint.id,checkpoint.proposal.branch_id,sql_number(checkpoint.revision)?,checkpoint.proposal.through_id,encode(reference)?,checkpoint.personalization.as_ref().and_then(|basis| basis.project_id.as_deref())])?;
    tx.execute("INSERT INTO active_contexts(branch_id,checkpoint_id) VALUES(?1,?2) ON CONFLICT(branch_id) DO UPDATE SET checkpoint_id=excluded.checkpoint_id",params![checkpoint.proposal.branch_id,checkpoint.id])?;
    event(
        tx,
        &checkpoint.proposal.branch_id,
        checkpoint.revision,
        "context.published",
        json!({"checkpoint_id":checkpoint.id,"through_id":checkpoint.proposal.through_id}),
    )?;
    Ok(())
}

pub struct CheckpointRead {
    pub id: String,
    pub revision: u64,
    reference: Value,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl CheckpointRead {
    pub fn load(self) -> Result<ContextCheckpoint> { Ok(serde_json::from_value(self.content.load(&self.reference)?)?) }
}

pub struct ContextRead {
    kind: ContextReadKind,
    database: std::path::PathBuf,
    _publication: crate::content::ContentPublication,
}

enum ContextReadKind {
    Checkpoint {
        memory: Option<super::memory::MemoryState>,
        trusted_receipts: std::collections::BTreeMap<String, Value>,
        compositions: std::sync::Arc<crate::composition::context::ContextCompositions>,
        branch_id: String,
        content: crate::content::ContentStore,
        checkpoint_id: String,
        reference: Value,
        head: Option<String>, through_id: Option<String>,
    },
    Summary {
        content: crate::content::ContentStore,
        request: crate::context_job::ContextJobRequest,
        source: crate::context_job::SummarySource,
    },
}
impl ContextRead {
    pub fn load(self) -> Result<ContextProjection> {
        let Self {kind,database,_publication} = self;
        let database = Connection::open_with_flags(database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        let (content, checkpoint_id, reference, suffix, compositions, branch_id, memory, trusted_receipts) = match kind {
            ContextReadKind::Checkpoint {
                compositions, branch_id, memory, trusted_receipts,
                content,
                checkpoint_id,
                reference,
                head, through_id,
            } => {
                let suffix = super::context_jobs::source_metadata_until(&database, head.as_deref(), through_id.as_deref())?;
                (content, checkpoint_id, reference, suffix, compositions, branch_id, memory, trusted_receipts)
            },
            ContextReadKind::Summary {
                content,
                request,
                source,
            } => {
                let metadata = super::context_jobs::source_metadata_until(&database, Some(&request.through_id), source.through_id.as_deref())?;
                let originals = super::context_jobs::hydrate_source(&content, metadata)?;
                let mut history = vec![ConversationItem {
                    id: format!("context-job:{}:system", request.key),
                    provenance: Provenance::SystemInstruction {
                        source: "context_compaction:v1".into(),
                    },
                    content: Content::Text {
                        text: crate::context_job::SUMMARIZER_SYSTEM.into(),
                    },
                    opaque: None,
                }];
                if let Some(reference) = source.checkpoint.filter(|_| source.through_id.is_some()) {
                    let checkpoint: ContextCheckpoint = serde_json::from_value(content.load(&reference)?)?;
                    history.push(ConversationItem {
                        id:format!("context-job:{}:prior-summary",request.key),
                        provenance:Provenance::ExternalData {source:format!("conversation-summary:{}",checkpoint.id)},
                        content:Content::Text {text:checkpoint.proposal.summary}, opaque:None,
                    });
                }
                for mut item in originals {
                    // Quote the semantic source with its real role and identity; never replay a
                    // historical tool call or promote earlier instructions into job authority.
                    item.opaque = None;
                    history.push(ConversationItem {
                        id: format!("context-job:{}:source:{}", request.key, item.id),
                        provenance: Provenance::ExternalData {
                            source: format!("history:{}", item.id),
                        },
                        content: Content::Text {
                            text: serde_json::to_string(&item)?,
                        },
                        opaque: None,
                    });
                }
                history.push(ConversationItem {
                    id: format!("context-job:{}:request", request.key),
                    provenance: Provenance::UserInstruction {
                        input_id: request.key.clone(),
                    },
                    content: Content::Text {
                        text: crate::context_job::SUMMARY_REQUEST.into(),
                    },
                    opaque: None,
                });
                return Ok(ContextProjection {
                    checkpoint_id: format!("context-job:{}", request.key),
                    history,
                    instruction_sources: vec!["context_compaction:v1".into()],
                    memory_checkpoint: None,
                });
            }
        };
        let checkpoint: ContextCheckpoint = serde_json::from_value(content.load(&reference)?)?;
        let mut history = Vec::new();
        // Body hydration, composition assembly and the pure typed transform execute outside
        // the Catalog mutex. The cache reuses unchanged selected handles across model requests.
        let composition = checkpoint.personalization.as_ref().and_then(|basis| basis.context_composition.as_ref());
        let fragments = compositions.bind(&branch_id, composition).map_err(RuntimeError::Invalid)?;
        let mut instruction_sources = checkpoint.proposal.instruction_sources.clone();
        if let Some(composition) = composition {
            instruction_sources.push(format!("{}:{}:{}", crate::composition::context::CAPABILITY,
                composition.provider_id, composition.content_version));
        }
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
        if let Some(fragments) = fragments {
            history.extend(fragments.apply(&checkpoint.id).map_err(RuntimeError::Invalid)?);
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
        for metadata in suffix {
            let item = content.hydrate_history(metadata)?;
            if item.source == HistorySource::User {
                history.extend(super::execution_persistence::user_input_items(
                    &item.id,
                    &item.content,
                )?);
            } else {
                history.push(serde_json::from_value(item.content)?);
            }
        }
        history.extend(super::memory::project(memory.as_ref(), checkpoint.personalization.as_ref(), &history, &trusted_receipts)?);
        Ok(ContextProjection {
            checkpoint_id,
            history,
            instruction_sources,
            memory_checkpoint: checkpoint.proposal.memory_checkpoint,
        })
    }
}
