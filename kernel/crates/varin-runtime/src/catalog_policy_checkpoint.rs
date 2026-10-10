//! Private state and the real continuation are immutable bodies. Pending decisions are explicit.
use super::*;
use crate::execution::{PolicyAction, PolicyDecision, PolicyEvent, PolicyIdentity};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PolicyCheckpointKind {
    Decision,
    Activation,
}
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PolicyCheckpointMetadata {
    pub identity: PolicyIdentity,
    pub kind: PolicyCheckpointKind,
    pub state: Value,
    pub pending_state: Option<Value>,
    pub action: Option<Value>,
    pub continuation: Option<Value>,
    pub activation_cursor: Option<u64>,
    pub decision_pending: bool,
    pub wait_id: Option<String>,
}
impl PolicyCheckpointMetadata {
    pub fn pending(&self, db: &Connection, run: &str) -> Result<bool> {
        if !self.decision_pending {
            return Ok(false);
        }
        if !self.invalidating_inputs(db, run)?.is_empty() {
            return Ok(false);
        }
        if let Some(wait_id) = &self.wait_id {
            let wait: Wait = record(db, "waits", wait_id)?;
            if wait.run_id != run {
                return Err(RuntimeError::Invalid(
                    "policy wait owner differs from its checkpoint".into(),
                ));
            }
            if wait.trigger_cursor.is_some() || wait.cancelled {
                return Ok(false);
            }
        }
        Ok(true)
    }
    /// Input is core history; it invalidates an unconsumed proposal, never committed state.
    pub fn invalidating_inputs(&self, db: &Connection, run: &str) -> Result<Vec<String>> {
        if !self.decision_pending {
            return Ok(Vec::new());
        }
        let mut statement = db.prepare(
            "SELECT json_extract(data,'$.input_id') FROM events
             WHERE subject=?1 AND kind='input.delivered' AND cursor >
                 (SELECT coalesce(max(cursor),0) FROM events WHERE subject=?1
                  AND kind='execution.committed' AND json_extract(data,'$.kind')='policy_checkpoint')
             ORDER BY cursor",
        )?;
        let rows = statement.query_map([run], |row| row.get(0))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }
}
pub(crate) fn metadata(db: &Connection, run: &str) -> Result<Option<PolicyCheckpointMetadata>> {
    let saved: Option<(String, String, String, Option<String>, Option<String>, Option<String>, Option<u64>, bool, Option<String>)> = db.query_row(
        "SELECT identity,kind,state_ref,pending_state_ref,action_ref,continuation_ref,activation_cursor,pending,wait_id
         FROM policy_checkpoints WHERE run_id=?1",
        [run],
        |row| {
            let cursor = row.get::<_, Option<i64>>(6)?.map(|value| {
                u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(6, value))
            }).transpose()?;
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?,
                row.get(5)?, cursor, row.get(7)?, row.get(8)?))
        },
    ).optional()?;
    saved
        .map(
            |(
                identity,
                kind,
                state,
                pending_state,
                action,
                continuation,
                activation_cursor,
                decision_pending,
                wait_id,
            )| {
                let kind = match kind.as_str() {
                    "decision" => PolicyCheckpointKind::Decision,
                    "activation" => PolicyCheckpointKind::Activation,
                    _ => {
                        return Err(RuntimeError::Invalid(
                            "unknown policy checkpoint kind".into(),
                        ))
                    }
                };
                if match kind {
                    PolicyCheckpointKind::Decision => {
                        action.is_none() || (decision_pending && continuation.is_none())
                    }
                    PolicyCheckpointKind::Activation => {
                        action.is_some()
                            || continuation.is_none()
                            || activation_cursor.is_none()
                            || decision_pending
                            || wait_id.is_some()
                    }
                } || decision_pending != pending_state.is_some()
                    || activation_cursor == Some(0)
                {
                    return Err(RuntimeError::Invalid(
                        "policy checkpoint tag and content references disagree".into(),
                    ));
                }
                Ok(PolicyCheckpointMetadata {
                    identity: serde_json::from_str(&identity)?,
                    kind,
                    state: serde_json::from_str(&state)?,
                    pending_state: pending_state
                        .map(|s| serde_json::from_str(&s))
                        .transpose()?,
                    action: action.map(|s| serde_json::from_str(&s)).transpose()?,
                    continuation: continuation.map(|s| serde_json::from_str(&s)).transpose()?,
                    activation_cursor,
                    decision_pending,
                    wait_id,
                })
            },
        )
        .transpose()
}
#[derive(Debug, Clone)]
pub(crate) struct PolicyCheckpointReferences {
    pub state: Value,
    pub previous_state: Option<Value>,
    pub action: Value,
    pub continuation: Option<Value>,
    pub wait_id: Option<String>,
}
impl PolicyCheckpointReferences {
    pub fn write(
        content: &crate::content::ContentStore,
        state: &Value,
        action: &PolicyAction,
    ) -> Result<Self> {
        Ok(Self {
            state: content.save(state)?,
            previous_state: None,
            action: content.save(&serde_json::to_value(action)?)?,
            continuation: None,
            wait_id: if let PolicyAction::Wait { wait_id } = action {
                Some(wait_id.clone())
            } else {
                None
            },
        })
    }
    pub fn with_previous_state(
        mut self,
        content: &crate::content::ContentStore,
        state: &Value,
    ) -> Result<Self> {
        self.previous_state = Some(content.save(state)?);
        Ok(self)
    }
    pub fn with_continuation(
        mut self,
        content: &crate::content::ContentStore,
        event: &PolicyEvent,
    ) -> Result<Self> {
        self.continuation = Some(content.save(&serde_json::to_value(event)?)?);
        Ok(self)
    }
    pub fn publish(
        &self,
        tx: &Transaction<'_>,
        run: &str,
        identity: &PolicyIdentity,
    ) -> Result<()> {
        self.publish_kind(tx, run, identity, false)
    }
    pub fn publish_pending(
        &self,
        tx: &Transaction<'_>,
        run: &str,
        identity: &PolicyIdentity,
    ) -> Result<()> {
        self.publish_kind(tx, run, identity, true)
    }
    fn publish_kind(
        &self,
        tx: &Transaction<'_>,
        run: &str,
        identity: &PolicyIdentity,
        pending: bool,
    ) -> Result<()> {
        let committed = if pending {
            self.previous_state
                .as_ref()
                .ok_or_else(|| RuntimeError::Invalid("pending decision baseline missing".into()))?
        } else {
            &self.state
        };
        let pending_state = pending.then(|| encode(&self.state)).transpose()?;
        tx.execute(
            "INSERT INTO policy_checkpoints(run_id,identity,kind,state_ref,pending_state_ref,action_ref,continuation_ref,pending,wait_id)
             VALUES(?1,?2,'decision',?3,?4,?5,?6,?7,?8)
             ON CONFLICT(run_id) DO UPDATE SET identity=excluded.identity,kind=excluded.kind,
                 state_ref=excluded.state_ref,pending_state_ref=excluded.pending_state_ref,action_ref=excluded.action_ref,
                 continuation_ref=coalesce(excluded.continuation_ref,policy_checkpoints.continuation_ref),
                 pending=excluded.pending,wait_id=excluded.wait_id",
            params![run, encode(identity)?, encode(committed)?, pending_state, encode(&self.action)?,
                self.continuation.as_ref().map(encode).transpose()?, pending, self.wait_id],
        )?;
        Ok(())
    }
}
pub(crate) fn publish_activation(
    tx: &Transaction<'_>,
    run: &str,
    identity: &PolicyIdentity,
    state: &Value,
    continuation: &Value,
    cursor: u64,
) -> Result<()> {
    tx.execute("INSERT INTO policy_checkpoints(run_id,identity,kind,state_ref,action_ref,continuation_ref,activation_cursor,pending,wait_id) VALUES(?1,?2,'activation',?3,NULL,?4,?5,0,NULL)
        ON CONFLICT(run_id) DO UPDATE SET identity=excluded.identity,kind='activation',
        state_ref=excluded.state_ref,pending_state_ref=NULL,action_ref=NULL,continuation_ref=excluded.continuation_ref,
        activation_cursor=excluded.activation_cursor,pending=0,wait_id=NULL",
        params![run,encode(identity)?,encode(state)?,encode(continuation)?,sql_number(cursor)?])?;
    Ok(())
}
/// The action's existing admission/consumption transaction advances its private state.
pub(crate) fn consume(tx: &Transaction<'_>, run: &str) -> Result<()> {
    tx.execute(
        "UPDATE policy_checkpoints SET state_ref=pending_state_ref,pending_state_ref=NULL,pending=0
         WHERE run_id=?1 AND pending=1",
        [run],
    )?;
    Ok(())
}
pub(crate) struct PolicyCheckpointRead {
    pub identity: PolicyIdentity,
    pub metadata: PolicyCheckpointMetadata,
    run_id: String,
    database: std::path::PathBuf,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl PolicyCheckpointRead {
    pub fn load_pending(self) -> Result<Option<PolicyDecision>> {
        Ok(self.load_pending_with_state()?.1)
    }
    pub fn load_pending_with_state(self) -> Result<(Value, Option<PolicyDecision>)> {
        let db = Connection::open_with_flags(
            &self.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let state = self.content.load(&self.metadata.state)?;
        let decision = if self.metadata.pending(&db, &self.run_id)? {
            Some(PolicyDecision {
                state: self
                    .content
                    .load(self.metadata.pending_state.as_ref().ok_or_else(|| {
                        RuntimeError::Invalid("pending decision state missing".into())
                    })?)?,
                action: serde_json::from_value(self.content.load(
                    self.metadata.action.as_ref().ok_or_else(|| {
                        RuntimeError::Invalid("pending decision body missing".into())
                    })?,
                )?)?,
            })
        } else {
            None
        };
        Ok((state, decision))
    }
}
impl Catalog {
    pub(crate) fn capture_policy_checkpoint(
        &self,
        run: &str,
    ) -> Result<Option<PolicyCheckpointRead>> {
        metadata(&self.db, run)?
            .map(|metadata| {
                Ok(PolicyCheckpointRead {
                    identity: metadata.identity.clone(),
                    metadata,
                    run_id: run.into(),
                    database: self
                        .db
                        .path()
                        .ok_or_else(|| {
                            RuntimeError::Invalid("Catalog has no persistent database".into())
                        })?
                        .into(),
                    content: self.content.clone(),
                    _publication: self.content.begin_publication(),
                })
            })
            .transpose()
    }
}
