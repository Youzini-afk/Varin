//! Private strategy state and actions have immutable bodies; the owner commits their references.
use super::*;
use crate::execution::{PolicyAction, PolicyDecision, PolicyIdentity};

#[derive(Debug, Clone)]
pub(crate) struct PolicyCheckpointReferences {
    pub state: Value,
    pub action: Value,
}
impl PolicyCheckpointReferences {
    pub fn write(content: &crate::content::ContentStore, state: &Value, action: &PolicyAction) -> Result<Self> {
        Ok(Self { state: content.save(state)?, action: content.save(&serde_json::to_value(action)?)? })
    }
    pub fn load(&self, content: &crate::content::ContentStore) -> Result<PolicyDecision> {
        Ok(PolicyDecision { state: content.load(&self.state)?, action: serde_json::from_value(content.load(&self.action)?)? })
    }
    pub fn publish(&self, tx: &Transaction<'_>, run_id: &str, identity: &PolicyIdentity) -> Result<()> {
        tx.execute("INSERT INTO policy_checkpoints(run_id,identity,state_ref,action_ref) VALUES(?1,?2,?3,?4)
            ON CONFLICT(run_id) DO UPDATE SET identity=excluded.identity,state_ref=excluded.state_ref,action_ref=excluded.action_ref",
            params![run_id,encode(identity)?,encode(&self.state)?,encode(&self.action)?])?;
        Ok(())
    }
}
pub(crate) struct PolicyCheckpointRead {
    pub identity: PolicyIdentity,
    references: PolicyCheckpointReferences,
    run_id: String,
    database: std::path::PathBuf,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl PolicyCheckpointRead {
    pub fn load_pending(self) -> Result<Option<PolicyDecision>> {
        let decision = self.references.load(&self.content)?;
        if let PolicyAction::Wait { wait_id } = &decision.action {
            let database = Connection::open_with_flags(&self.database,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
            let wait: Wait = record(&database, "waits", wait_id)?;
            if wait.run_id != self.run_id { return Err(RuntimeError::Invalid("policy wait owner differs from its checkpoint".into())); }
            if wait.trigger_cursor.is_some() || wait.cancelled { return Ok(None); }
        }
        Ok(Some(decision))
    }
}
impl Catalog {
    pub(crate) fn capture_policy_checkpoint(&self, run_id: &str) -> Result<Option<PolicyCheckpointRead>> {
        let saved: Option<(String,String,String)> = self.db.query_row(
            "SELECT identity,state_ref,action_ref FROM policy_checkpoints WHERE run_id=?1", [run_id],
            |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
        saved.map(|(identity,state,action)|Ok(PolicyCheckpointRead {
            identity: serde_json::from_str(&identity)?,
            references: PolicyCheckpointReferences { state: serde_json::from_str(&state)?, action: serde_json::from_str(&action)? },
            run_id: run_id.into(), database: self.db.path().ok_or_else(||RuntimeError::Invalid("Catalog has no persistent database".into()))?.into(),
            content: self.content.clone(), _publication: self.content.begin_publication(),
        })).transpose()
    }
}
