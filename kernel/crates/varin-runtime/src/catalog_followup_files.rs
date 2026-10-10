//! File condition progress is part of the original definition. The resource owner owns
//! authorization and snapshots; the Catalog stores only its receipt and observed facts.
use super::*;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileCondition {
    Exists,
    Changed,
    Ready,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileProof {
    Exists,
    SnapshotDifference,
    TargetedInvalidation,
    ManagedReady,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum FileState {
    RegularFile {
        #[serde(rename = "objectHash")]
        object_hash: String,
        #[serde(rename = "byteLength")]
        byte_length: u64,
        mode: Option<u32>,
    },
    Directory {
        mode: Option<u32>,
    },
    Symlink {
        #[serde(rename = "symlinkTarget")]
        symlink_target: String,
        mode: Option<u32>,
    },
    Missing,
    Unsupported,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileWatchPosition {
    pub source_id: String,
    pub generation: u64,
    pub sequence: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FollowupFileSourceState {
    pub receipt_id: String,
    pub revision: u64,
    pub baseline: Option<FileState>,
    pub current: Option<FileState>,
    pub immutable: bool,
    pub watch_id: Option<String>,
    pub position: Option<FileWatchPosition>,
    pub gap: bool,
    pub failure_code: Option<String>,
    pub released: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileObservationKey {
    pub followup_id: String,
    pub generation: u64,
    pub source_index: usize,
    pub receipt_id: String,
    pub observation_revision: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FileObservationRequest {
    pub followup_id: String,
    pub source_index: usize,
    pub source_run_id: String,
    pub thread_id: String,
    pub actor: FollowupActor,
    pub source: launches::SourceSelection,
    pub path: String,
    pub condition: FileCondition,
    pub intent_ref: Value,
}
impl FileObservationRequest {
    pub fn receipt_id(&self) -> String {
        format!(
            "file-observation:{}:{}",
            self.followup_id, self.source_index
        )
    }
    /// Original intent digest binds retries without storing condition progress or bodies.
    pub fn authorization_identity(&self) -> Value {
        json!({"operationId":self.receipt_id(),"workspaceId":self.source.workspace_id,
            "followupId":self.followup_id,"sourceIndex":self.source_index,"sourceRunId":self.source_run_id,
            "threadId":self.thread_id,"actor":self.actor,"source":self.source,"path":self.path,"intentRef":self.intent_ref})
    }
}
#[derive(Debug, Clone)]
pub struct PreparedFileObservation {
    pub source_index: usize,
    pub receipt_id: String,
    pub state: Option<FileState>,
    pub immutable: bool,
    pub watch_id: Option<String>,
    pub position: Option<FileWatchPosition>,
    pub gap: bool,
    pub targeted_change: bool,
    pub ready: bool,
}
#[derive(Debug, Clone)]
pub struct FileObservationWork {
    pub key: FileObservationKey,
    pub request: FileObservationRequest,
    pub file: FollowupFileSourceState,
    pub release_required: bool,
    pub epoch: u64,
    pub definition_revision: u64,
    pub paused: bool,
}
#[derive(Debug, Clone)]
pub struct FileObservationUpdate {
    pub state: Option<FileState>,
    pub watch_id: Option<String>,
    pub position: Option<FileWatchPosition>,
    pub gap: bool,
    pub targeted_change: bool,
    pub ready: bool,
    pub failure_code: Option<String>,
}
pub(super) fn normalized_file_path(path: &str) -> Result<String> {
    use std::path::{Component, Path};
    let normalized = path.replace('\\', "/");
    let mut pieces = Vec::new();
    for component in Path::new(&normalized).components() {
        match component {
            Component::Normal(segment) => pieces.push(
                segment
                    .to_str()
                    .ok_or_else(|| RuntimeError::Invalid("file path is not UTF-8".into()))?
                    .to_owned(),
            ),
            _ => {
                return Err(RuntimeError::Invalid(
                    "file path must be a relative resource path".into(),
                ))
            }
        }
    }
    if pieces.is_empty() {
        return Err(RuntimeError::Invalid(
            "file condition requires a nonempty relative path".into(),
        ));
    }
    Ok(pieces.join("/"))
}
pub(super) fn validate_file_path(path: &str) -> Result<()> {
    normalized_file_path(path).map(|_| ())
}
pub(super) fn bind_registration(
    d: &mut Definition,
    files: &[PreparedFileObservation],
) -> Result<()> {
    let leaves = d.trigger.sources();
    let expected: Vec<_> = leaves
        .iter()
        .enumerate()
        .filter(|(_, s)| matches!(s, FollowupSource::File { .. }))
        .collect();
    if expected.len() != files.len() {
        return Err(RuntimeError::Invalid(
            "every file source requires original owner acceptance and baseline".into(),
        ));
    }
    for ((index, _), file) in expected.into_iter().zip(files) {
        if index != file.source_index
            || file.receipt_id != format!("file-observation:{}:{index}", d.id)
            || file.immutable
                != (d
                    .source
                    .as_ref()
                    .is_some_and(|s| s.mode == crate::SourceMode::FixedBranch))
            || (file.immutable && file.state.is_none())
            || (!file.immutable && (file.watch_id.is_none() || file.position.is_none()))
        {
            return Err(RuntimeError::Conflict(
                "file baseline does not match its source".into(),
            ));
        }
        d.sources[index].file = Some(FollowupFileSourceState {
            receipt_id: file.receipt_id.clone(),
            revision: 1,
            baseline: file.state.clone(),
            current: file.state.clone(),
            immutable: file.immutable,
            watch_id: file.watch_id.clone(),
            position: file.position.clone(),
            gap: file.gap,
            failure_code: file.state.is_none().then(|| "baseline_pending".into()),
            released: false,
        });
    }
    Ok(())
}
fn observe_file(
    tx: &Transaction<'_>,
    d: &mut Definition,
    index: usize,
    targeted_change: bool,
    ready: bool,
) -> Result<()> {
    if d.sources[index].observed.is_some() {
        return Ok(());
    }
    let FollowupSource::File { path, condition } = d.trigger.sources()[index].clone() else {
        return Err(RuntimeError::Invalid("file leaf changed".into()));
    };
    let file = d.sources[index]
        .file
        .as_ref()
        .ok_or_else(|| RuntimeError::Invalid("file source receipt missing".into()))?;
    if file.failure_code.is_some() || file.released {
        return Ok(());
    }
    let Some(state) = &file.current else {
        return Ok(());
    };
    let proof = match condition {
        FileCondition::Exists if !matches!(state, FileState::Missing | FileState::Unsupported) => {
            Some(FileProof::Exists)
        }
        FileCondition::Changed
            if !file.immutable
                && file.baseline.is_some()
                && file.baseline.as_ref() != Some(state) =>
        {
            Some(FileProof::SnapshotDifference)
        }
        FileCondition::Changed if !file.immutable && targeted_change => {
            Some(FileProof::TargetedInvalidation)
        }
        FileCondition::Ready if ready && matches!(state, FileState::RegularFile { .. }) => {
            Some(FileProof::ManagedReady)
        }
        _ => None,
    };
    let Some(proof) = proof else {
        return Ok(());
    };
    let evidence = FollowupLeafEvidence::File {
        receipt_id: file.receipt_id.clone(),
        condition,
        path,
        state: state.clone(),
        proof,
        position: file.position.clone(),
        gap: file.gap,
        observed_at_ms: observations::wall_time_ms()?,
    };
    let cursor = event(
        tx,
        &d.id,
        d.revision,
        "followup.file_observed",
        json!({"source_index":index,"evidence":evidence}),
    )?;
    d.sources[index].observed = Some(FollowupSourceObservation {
        trigger_cursor: cursor,
        evidence,
    });
    Ok(())
}
pub(super) fn observe_registration(
    tx: &Transaction<'_>,
    d: &mut Definition,
    files: &[PreparedFileObservation],
) -> Result<()> {
    for file in files {
        observe_file(tx, d, file.source_index, file.targeted_change, file.ready)?;
    }
    if !files.is_empty() {
        put(tx, "followups", &d.id, d)?;
    }
    Ok(())
}
fn release_required(d: &Definition, index: usize) -> bool {
    d.state == FollowupState::Cancelled
        || d.wait.state != NextRunWaitState::Waiting
        || d.sources[index].observed.is_some()
        || d.sources[index]
            .file
            .as_ref()
            .is_some_and(|f| f.failure_code.as_deref() == Some("authority_revoked"))
}
fn work(db: &Connection, d: &Definition, index: usize, epoch: u64) -> Result<FileObservationWork> {
    let source = d
        .source
        .clone()
        .ok_or_else(|| RuntimeError::Invalid("file source identity missing".into()))?;
    let leaf = d
        .trigger
        .sources()
        .get(index)
        .cloned()
        .ok_or_else(|| RuntimeError::Invalid("file source index invalid".into()))?;
    let FollowupSource::File { path, condition } = leaf else {
        return Err(RuntimeError::Invalid("source is not a file".into()));
    };
    let file = d
        .sources
        .get(index)
        .and_then(|s| s.file.clone())
        .ok_or_else(|| RuntimeError::Invalid("file acceptance missing".into()))?;
    let intent: String = db.query_row(
        "SELECT intent FROM commands WHERE id=?1",
        [format!("followup-register:{}", d.id)],
        |r| r.get(0),
    )?;
    Ok(FileObservationWork {
        key: FileObservationKey {
            followup_id: d.id.clone(),
            generation: d.generation,
            source_index: index,
            receipt_id: file.receipt_id.clone(),
            observation_revision: file.revision,
        },
        request: FileObservationRequest {
            followup_id: d.id.clone(),
            source_index: index,
            source_run_id: d.source_run_id.clone(),
            thread_id: d.thread_id.clone(),
            actor: d.actor.clone(),
            source,
            path,
            condition,
            intent_ref: serde_json::from_str(&intent)?,
        },
        file,
        release_required: release_required(d, index),
        epoch,
        definition_revision: d.revision,
        paused: d.state == FollowupState::Paused,
    })
}
impl Catalog {
    pub fn followup_file_work(&self, key: &FileObservationKey) -> Result<FileObservationWork> {
        if self.continuation_stopping.load(Ordering::Acquire) {
            return Err(RuntimeError::Conflict(
                "file observation owner stopped".into(),
            ));
        }
        let d: Definition = record(&self.db, "followups", &key.followup_id)?;
        let w = work(&self.db, &d, key.source_index, self.epoch)?;
        if &w.key != key {
            return Err(RuntimeError::Conflict(
                "file observation binding changed".into(),
            ));
        }
        Ok(w)
    }
    pub fn file_acceptance_may_release(&self, r: &FileObservationRequest) -> Result<bool> {
        if optional_record::<Definition>(&self.db, "followups", &r.followup_id)?.is_some() {
            return Ok(false);
        }
        if r.actor == FollowupActor::User {
            let run = self.run(&r.source_run_id)?;
            return Ok(run.thread_id == r.thread_id
                && self.user_followup_registration_cancelled(&r.followup_id, &r.source_run_id)?);
        }
        let FollowupActor::Agent {
            operation_id,
            run_id,
            ..
        } = &r.actor
        else {
            return Ok(false);
        };
        let op: Operation = record(&self.db, "operations", operation_id)?;
        let run: Run = record(&self.db, "runs", run_id)?;
        Ok(op.run_id == *run_id
            && run.thread_id == r.thread_id
            && (op.phase == OperationPhase::Terminal
                || op.cancel_requested
                || run.cancel_requested))
    }
    pub fn followup_file_release_work(
        &self,
        key: &FileObservationKey,
    ) -> Result<FileObservationWork> {
        let d: Definition = record(&self.db, "followups", &key.followup_id)?;
        let w = work(&self.db, &d, key.source_index, self.epoch)?;
        if w.key.generation != key.generation
            || w.key.receipt_id != key.receipt_id
            || !w.release_required
        {
            return Err(RuntimeError::Conflict(
                "file release binding changed or is still required".into(),
            ));
        }
        Ok(w)
    }
    /// Bounds output work by short metadata pages; no file bytes or instruction bodies load here.
    pub fn followup_file_works(
        &self,
        after: Option<&str>,
    ) -> Result<(Vec<FileObservationWork>, Option<String>)> {
        let mut q = self
            .db
            .prepare("SELECT body FROM followups WHERE id>=?1 ORDER BY id")?;
        let (after_id, after_index) = after
            .map(|a| serde_json::from_str::<(String, usize)>(a))
            .transpose()?
            .unwrap_or_default();
        let rows = q.query_map([&after_id], |r| r.get::<_, String>(0))?;
        let mut result = Vec::new();
        for row in rows {
            let d: Definition = serde_json::from_str(&row?)?;
            for (i, s) in d.sources.iter().enumerate() {
                if d.id == after_id && i <= after_index && after.is_some() {
                    continue;
                }
                if s.file.as_ref().is_some_and(|f| !f.released) {
                    if result.len() == 64 {
                        let last = result.last().expect("page");
                        let last: &FileObservationWork = last;
                        let cursor = serde_json::to_string(&(
                            last.key.followup_id.clone(),
                            last.key.source_index,
                        ))?;
                        return Ok((result, Some(cursor)));
                    }
                    result.push(work(&self.db, &d, i, self.epoch)?);
                }
            }
        }
        Ok((result, None))
    }
    pub fn apply_file_observation(
        &mut self,
        w: &FileObservationWork,
        update: FileObservationUpdate,
    ) -> Result<bool> {
        if w.epoch != self.epoch || self.continuation_stopping.load(Ordering::Acquire) {
            return Err(RuntimeError::Conflict(
                "file observation owner changed".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let mut d: Definition = record(&tx, "followups", &w.key.followup_id)?;
        let current = work(&tx, &d, w.key.source_index, self.epoch)?;
        if current.key != w.key
            || d.revision != w.definition_revision
            || current.release_required
            || (current.paused && update.failure_code.as_deref() != Some("authority_revoked"))
        {
            return Ok(false);
        }
        let index = w.key.source_index;
        let f = d.sources[index].file.as_mut().expect("file source");
        if f.immutable
            && (update.watch_id.is_some() || update.position.is_some() || update.targeted_change)
        {
            return Err(RuntimeError::Invalid(
                "immutable source cannot acquire a watch change".into(),
            ));
        }
        if update.failure_code.is_none() && update.state.is_none() {
            return Err(RuntimeError::Invalid(
                "file observation has neither snapshot nor failure".into(),
            ));
        }
        if f.watch_id == update.watch_id {
            if let (Some(old), Some(new)) = (&f.position, &update.position) {
                if old.source_id == new.source_id
                    && old.generation == new.generation
                    && new.sequence < old.sequence
                {
                    return Ok(false);
                }
            }
        }
        let previous = f.clone();
        if let Some(state) = update.state {
            if f.baseline.is_none() {
                f.baseline = Some(state.clone());
            }
            f.current = Some(state);
        }
        f.watch_id = update.watch_id;
        f.position = update.position;
        f.gap |= update.gap;
        f.failure_code = update.failure_code;
        if *f != previous || update.targeted_change {
            f.revision += 1;
        }
        observe_file(&tx, &mut d, index, update.targeted_change, update.ready)?;
        let changed =
            d.sources[index].file.as_ref() != Some(&previous) || d.sources[index].observed != None;
        if changed {
            put(&tx, "followups", &d.id, &d)?;
            event(
                &tx,
                &d.id,
                d.revision,
                "followup.file_checked",
                json!({"source_index":index,"file":d.sources[index].file}),
            )?;
        }
        observe(&tx, &mut d, observations::wall_time_ms()?)?;
        tx.commit()?;
        Ok(true)
    }
    pub fn confirm_file_observation_released(&mut self, key: &FileObservationKey) -> Result<()> {
        let tx = self.db.transaction()?;
        let mut d: Definition = record(&tx, "followups", &key.followup_id)?;
        if d.generation != key.generation || !release_required(&d, key.source_index) {
            return Err(RuntimeError::Conflict(
                "file observation is still required".into(),
            ));
        }
        let f = d
            .sources
            .get_mut(key.source_index)
            .and_then(|s| s.file.as_mut())
            .ok_or_else(|| RuntimeError::Invalid("file source missing".into()))?;
        if f.receipt_id != key.receipt_id {
            return Err(RuntimeError::Conflict(
                "file release identity changed".into(),
            ));
        }
        if !f.released {
            f.released = true;
            f.revision += 1;
            put(&tx, "followups", &d.id, &d)?;
            event(
                &tx,
                &d.id,
                d.revision,
                "followup.file_released",
                json!({"source_index":key.source_index}),
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}
