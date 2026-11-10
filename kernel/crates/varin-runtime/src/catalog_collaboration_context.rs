//! Collaboration observations enter the original closed history boundary.
//! The current family facts are read off-lock. The immutable observation is an
//! observation by the runtime, not proof of model dispatch or report delivery.
use super::*;
use crate::execution::{ConversationHistory, ConversationItem, Provenance};
use std::sync::Arc;

pub struct CollaborationObservationPreparation {
    run: Run,
    head: Option<String>,
    checkpoint_id: Option<String>,
    candidates: ConversationHistory,
    family: family::FamilyRead,
    database: std::path::PathBuf,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}

impl Catalog {
    /// Capture only an ordinary Run's closed boundary. An activating input must
    /// return through the normal Engine input/policy path, never this observation.
    pub fn prepare_collaboration_observation(
        &self,
        run_id: &str,
        epoch: u64,
        expected_head: Option<&str>,
        expected_checkpoint: Option<&str>,
        visible_history: &[Arc<ConversationItem>],
    ) -> Result<Option<CollaborationObservationPreparation>> {
        if self.is_context_job(run_id)? {
            return Ok(None);
        }
        let run = self.run(run_id)?;
        fence(&run, epoch)?;
        if run.cancel_requested {
            return Err(RuntimeError::DispatchCancelled);
        }
        if !bot::run_permitted(&self.db, &run)? {
            return Err(RuntimeError::BotSuspended);
        }
        if inputs::has_boundary_inputs(&self.db, run_id)? {
            return Err(RuntimeError::InputPending);
        }
        inputs::validate_delivery(&self.db, run_id, epoch, expected_head)?;
        let candidates = visible_history.iter().rev().filter(|item| matches!(
            &item.provenance,
            Provenance::ExternalData { source } if source == family::COLLABORATION_STATE_SOURCE
        )).cloned().collect();
        Ok(Some(CollaborationObservationPreparation {
            family: self.capture_family_read(&run.thread_id, None, None)?,
            run,
            head: expected_head.map(str::to_owned),
            checkpoint_id: expected_checkpoint.map(str::to_owned),
            candidates,
            database: self.database_path.clone(),
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        }))
    }
}

impl CollaborationObservationPreparation {
    pub fn load(self) -> Result<inputs::PreparedInputDelivery> {
        // FamilyRead supplies one coherent, finite family view. Peer changes after
        // this capture are observed at the next real model boundary; demanding that
        // every peer remain unchanged through publication would starve active teams.
        // This second reader checks the immutable baseline, not a newer family view.
        // The original delivery transaction still fences epoch/head/checkpoint/cancel.
        let snapshot = self.family.collaboration_snapshot(&self.run.branch_id)?;
        let database = Connection::open_with_flags(
            &self.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        database.execute_batch("BEGIN")?;
        let epoch = bot::current_epoch(&database)?;
        if epoch != self.run.epoch {
            return Err(RuntimeError::Conflict(
                "collaboration observation owner changed".into(),
            ));
        }
        let mut previous = None;
        for candidate in self.candidates {
            let Some(value) = family::CollaborationSnapshot::from_item(&candidate)? else {
                continue;
            };
            if value.caller_thread_id != self.run.thread_id
                || value.caller_branch_id != self.run.branch_id
            {
                continue;
            }
            // A matching label, digest or model-authored JSON is not a history fact.
            // Validate the original holder and ancestry before using it as a baseline.
            let metadata: HistoryItem = record(&database, "history", &candidate.id)?;
            if metadata.source != HistorySource::Environment
                || metadata.thread_id != self.run.thread_id
            {
                return Err(RuntimeError::Invalid(
                    "collaboration baseline has no original environment holder".into(),
                ));
            }
            let visible: bool = database.query_row(
                "WITH RECURSIVE ancestors(id,parent) AS (SELECT id,parent FROM history WHERE id=?1 UNION ALL SELECT h.id,h.parent FROM history h JOIN ancestors a ON h.id=a.parent) SELECT EXISTS(SELECT 1 FROM ancestors WHERE id=?2)",
                params![self.head, candidate.id], |row| row.get(0),
            )?;
            if !visible {
                return Err(RuntimeError::Conflict(
                    "collaboration baseline is outside the captured ancestry".into(),
                ));
            }
            let original = self.content.hydrate_history(metadata)?;
            let original = execution_persistence::history_input_items(
                &original.id,
                original.source,
                &original.content,
            )?;
            if original.len() != 1 || original[0].as_ref() != candidate.as_ref() {
                return Err(RuntimeError::Invalid(
                    "collaboration baseline differs from its original observation".into(),
                ));
            }
            previous = Some(value);
            break;
        }
        let changed = previous
            .as_ref()
            .map_or(!snapshot.members.is_empty(), |previous| {
                previous != &snapshot
            });
        let item = if changed {
            let item = Arc::new(snapshot.to_item(&format!("collaboration-observation:{}", id()))?);
            let reference = self.content.save_conversation(&item, &None)?;
            Some((item, reference))
        } else {
            None
        };
        Ok(inputs::PreparedInputDelivery::environment(
            self.run,
            self.head,
            self.checkpoint_id,
            item,
            self.publication,
        ))
    }
}

#[cfg(test)]
#[path = "catalog_collaboration_context_tests.rs"]
mod tests;
