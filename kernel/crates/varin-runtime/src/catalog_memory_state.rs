//! Worker-owned memory projection preparation; Catalog publishes only immutable references.
use super::memory::{allowed, note_id, scope_key, MemoryState};
use super::personalization::PersonalizationBasis;
use super::*;

pub struct MemoryStateRead {
    reference: Value,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl MemoryStateRead {
    pub fn load(self) -> Result<MemoryState> {
        Ok(serde_json::from_value(self.content.load(&self.reference)?)?)
    }
}
enum Mutation {
    Synchronize(MemoryState),
    Receipt(Value),
}
pub struct MemoryStatePreparation {
    run: Run,
    epoch: Option<u64>,
    context: context::CheckpointRead,
    previous: Option<MemoryStateRead>,
    mutation: Mutation,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedMemoryState {
    run_id: String,
    branch_id: String,
    epoch: Option<u64>,
    context_id: String,
    expected: Option<Value>,
    reference: Value,
    _publication: crate::content::ContentPublication,
}
impl Catalog {
    pub fn memory_state_identity(&self, branch: &str) -> Result<Option<Value>> {
        let reference: Option<String> = self
            .db
            .query_row(
                "SELECT body FROM memory_states WHERE branch_id=?1",
                [branch],
                |row| row.get(0),
            )
            .optional()?;
        reference
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .transpose()
    }
    pub fn capture_memory_state(&self, branch: &str) -> Result<Option<MemoryStateRead>> {
        let reference = self.memory_state_identity(branch)?;
        reference
            .map(|value| {
                Ok(MemoryStateRead {
                    reference: value,
                    content: self.content.clone(),
                    _publication: self.content.begin_publication(),
                })
            })
            .transpose()
    }
    pub fn memory_state(&self, branch: &str) -> Result<Option<MemoryState>> {
        self.capture_memory_state(branch)?
            .map(MemoryStateRead::load)
            .transpose()
    }
    pub fn prepare_memory_sync(
        &self,
        run_id: &str,
        epoch: u64,
        state: MemoryState,
    ) -> Result<MemoryStatePreparation> {
        let run = self.run(run_id)?;
        fence(&run, epoch)?;
        let context = self
            .capture_active_checkpoint(&run.branch_id)?
            .ok_or_else(|| RuntimeError::Invalid("memory requires an admitted context".into()))?;
        self.prepare_memory_state(run, Some(epoch), context, Mutation::Synchronize(state))
    }
    pub fn prepare_memory_receipt(
        &self,
        run_id: &str,
        receipt: Value,
    ) -> Result<MemoryStatePreparation> {
        let run = self.run(run_id)?;
        let context = self
            .capture_admitted_checkpoint(run_id)?
            .ok_or_else(|| RuntimeError::Invalid("memory receipt has no admitted scope".into()))?;
        self.prepare_memory_state(run, None, context, Mutation::Receipt(receipt))
    }
    fn prepare_memory_state(
        &self,
        run: Run,
        epoch: Option<u64>,
        context: context::CheckpointRead,
        mutation: Mutation,
    ) -> Result<MemoryStatePreparation> {
        Ok(MemoryStatePreparation {
            previous: self.capture_memory_state(&run.branch_id)?,
            run,
            epoch,
            context,
            mutation,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    /// False means an actual concurrent checkpoint/state publication changed the captured basis.
    pub fn publish_memory_state(&mut self, prepared: PreparedMemoryState) -> Result<bool> {
        let run = self.run(&prepared.run_id)?;
        if run.branch_id != prepared.branch_id {
            return Err(RuntimeError::Conflict("memory branch owner changed".into()));
        }
        if let Some(epoch) = prepared.epoch {
            fence(&run, epoch)?;
            if run.cancel_requested {
                return Err(RuntimeError::Conflict(
                    "memory synchronization owner is closing".into(),
                ));
            }
            let checkpoint: Option<String> = self
                .db
                .query_row(
                    "SELECT checkpoint_id FROM active_contexts WHERE branch_id=?1",
                    [&run.branch_id],
                    |row| row.get(0),
                )
                .optional()?;
            if checkpoint.as_deref() != Some(&prepared.context_id) {
                return Ok(false);
            }
        }
        let current: Option<String> = self
            .db
            .query_row(
                "SELECT body FROM memory_states WHERE branch_id=?1",
                [&run.branch_id],
                |row| row.get(0),
            )
            .optional()?;
        let current: Option<Value> = current
            .map(|value| serde_json::from_str(&value))
            .transpose()?;
        if current != prepared.expected {
            return Ok(false);
        }
        if current.as_ref() != Some(&prepared.reference) {
            self.db.execute("INSERT INTO memory_states(branch_id,body) VALUES(?1,?2) ON CONFLICT(branch_id) DO UPDATE SET body=excluded.body",params![run.branch_id,encode(&prepared.reference)?])?;
        }
        Ok(true)
    }
}
impl MemoryStatePreparation {
    pub fn load(self) -> Result<PreparedMemoryState> {
        let context_id = self.context.id.clone();
        let expected = self.previous.as_ref().map(|read| read.reference.clone());
        let basis =
            self.context.load()?.personalization.ok_or_else(|| {
                RuntimeError::Invalid("memory requires owned personalization".into())
            })?;
        if basis.session_id != self.run.thread_id {
            return Err(RuntimeError::Conflict(
                "memory scope differs from admitted thread".into(),
            ));
        }
        let previous = self.previous.map(MemoryStateRead::load).transpose()?;
        let state = match self.mutation {
            Mutation::Synchronize(state) => synchronize(&basis, previous, state)?,
            Mutation::Receipt(receipt) => observe(&basis, previous, &receipt)?,
        };
        let reference = self.content.save(&serde_json::to_value(state)?)?;
        Ok(PreparedMemoryState {
            run_id: self.run.id,
            branch_id: self.run.branch_id,
            epoch: self.epoch,
            context_id,
            expected,
            reference,
            _publication: self.publication,
        })
    }
}
fn synchronize(
    basis: &PersonalizationBasis,
    previous: Option<MemoryState>,
    mut state: MemoryState,
) -> Result<MemoryState> {
    state.known.clear();
    if let Some(previous) = previous {
        if state.revision < previous.revision {
            return Err(RuntimeError::Conflict(
                "memory owner revision moved backwards".into(),
            ));
        }
        state.known = previous.known;
    }
    for note in basis.memory_snapshot.memories.iter().chain(&state.memories) {
        let id = note_id(note)?;
        if !allowed(basis, &note["scope"]) {
            return Err(RuntimeError::Invalid(
                "memory projection contains another scope".into(),
            ));
        }
        state.known.insert(
            format!("{}:{id}", scope_key(&note["scope"])?),
            json!({"id":id,"scope":note["scope"]}),
        );
    }
    if basis.mode == "bot" && (!state.memories.is_empty() || !state.known.is_empty()) {
        return Err(RuntimeError::Invalid(
            "ordinary memory cannot enter Bot context".into(),
        ));
    }
    if state
        .note_revisions
        .values()
        .any(|revision| *revision > state.revision)
    {
        return Err(RuntimeError::Invalid(
            "memory entry revision exceeds owner revision".into(),
        ));
    }
    let ids: std::collections::BTreeSet<String> = state
        .known
        .values()
        .filter_map(|note| note["id"].as_u64().map(|id| id.to_string()))
        .collect();
    state.note_revisions.retain(|id, _| ids.contains(id));
    Ok(state)
}
fn observe(
    basis: &PersonalizationBasis,
    previous: Option<MemoryState>,
    receipt: &Value,
) -> Result<MemoryState> {
    let revision = receipt["revision"]
        .as_u64()
        .ok_or_else(|| RuntimeError::Invalid("memory receipt revision missing".into()))?;
    let changes = receipt["changes"]
        .as_array()
        .ok_or_else(|| RuntimeError::Invalid("memory receipt changes missing".into()))?;
    let mut state = previous.unwrap_or_else(|| MemoryState {
        revision: basis.memory_snapshot.revision,
        memories: basis.memory_snapshot.memories.clone(),
        note_revisions: std::collections::BTreeMap::new(),
        known: std::collections::BTreeMap::new(),
    });
    for change in changes {
        let id = change["id"]
            .as_u64()
            .ok_or_else(|| RuntimeError::Invalid("memory receipt identity missing".into()))?;
        if !allowed(basis, &change["scope"]) {
            return Err(RuntimeError::Invalid(
                "memory receipt is outside admitted scope".into(),
            ));
        }
        let key = scope_key(&change["scope"])?;
        state.known.insert(
            format!("{key}:{id}"),
            json!({"id":id,"scope":change["scope"]}),
        );
        if state
            .note_revisions
            .get(&id.to_string())
            .is_none_or(|old| *old <= revision)
        {
            state.memories.retain(|note| {
                !(note["id"].as_u64() == Some(id)
                    && scope_key(&note["scope"]).ok().as_deref() == Some(&key))
            });
            if !change["note"].is_null() {
                if note_id(&change["note"])? != id || scope_key(&change["note"]["scope"])? != key {
                    return Err(RuntimeError::Invalid(
                        "memory receipt note differs from its change identity".into(),
                    ));
                }
                state.memories.push(change["note"].clone());
            }
            state.note_revisions.insert(id.to_string(), revision);
        }
    }
    state.revision = state.revision.max(revision);
    Ok(state)
}
