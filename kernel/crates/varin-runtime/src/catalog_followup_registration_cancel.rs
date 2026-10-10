//! Explicit User disposal of an accepted source whose definition never committed.
//! The existing command journal is the only cancellation fence.
use super::*;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Cancellation {
    actor: FollowupActor,
    source_run_id: String,
    thread_id: String,
    branch_id: String,
}
fn cancel_key(id: &str) -> String {
    format!("followup-register-cancel:{id}")
}
fn cancellation(db: &Connection, id: &str) -> Result<Option<Cancellation>> {
    let value: Option<String> = db
        .query_row(
            "SELECT intent FROM commands WHERE id=?1",
            [cancel_key(id)],
            |row| row.get(0),
        )
        .optional()?;
    value
        .map(|raw| serde_json::from_str(&raw).map_err(Into::into))
        .transpose()
}
pub(super) fn require_registration_open(
    db: &Connection,
    id: &str,
    actor: &FollowupActor,
) -> Result<()> {
    if *actor == FollowupActor::User && cancellation(db, id)?.is_some() {
        return Err(RuntimeError::Conflict(
            "original User follow-up registration was cancelled".into(),
        ));
    }
    Ok(())
}
impl Catalog {
    pub fn user_followup_registration_cancelled(&self, id: &str, run_id: &str) -> Result<bool> {
        let Some(fence) = cancellation(&self.db, id)? else {
            return Ok(false);
        };
        let run = self.run(run_id)?;
        if fence
            != (Cancellation {
                actor: FollowupActor::User,
                source_run_id: run.id,
                thread_id: run.thread_id,
                branch_id: run.branch_id,
            })
        {
            return Err(RuntimeError::Conflict(
                "registration cancellation belongs to another original User source".into(),
            ));
        }
        Ok(true)
    }
    pub fn pending_user_file_registration(
        &self,
        r: &FileObservationRequest,
        thread: &str,
        branch: &str,
    ) -> Result<bool> {
        if self.branch_thread_id(branch)? != thread {
            return Err(RuntimeError::Invalid(
                "pending registration branch belongs to another Thread".into(),
            ));
        }
        if r.actor != FollowupActor::User || r.thread_id != thread {
            return Ok(false);
        }
        let run = self.run(&r.source_run_id)?;
        if run.thread_id != r.thread_id {
            return Err(RuntimeError::Conflict(
                "file acceptance original Thread changed".into(),
            ));
        }
        if run.branch_id != branch {
            return Ok(false);
        }
        if optional_record::<Definition>(&self.db, "followups", &r.followup_id)?.is_some() {
            return Ok(false);
        }
        Ok(!self.user_followup_registration_cancelled(&r.followup_id, &r.source_run_id)?)
    }
    pub fn cancel_user_followup_registration(
        &mut self,
        id: &str,
        run_id: &str,
        accepted: &[FileObservationRequest],
    ) -> Result<Option<Followup>> {
        if id.trim().is_empty() {
            return Err(RuntimeError::Invalid("follow-up key is required".into()));
        }
        let run = self.run(run_id)?;
        let identity = Cancellation {
            actor: FollowupActor::User,
            source_run_id: run.id.clone(),
            thread_id: run.thread_id.clone(),
            branch_id: run.branch_id.clone(),
        };
        let existing = cancellation(&self.db, id)?;
        if existing.as_ref().is_some_and(|f| f != &identity) {
            return Err(RuntimeError::Conflict(
                "registration cancellation belongs to another original User source".into(),
            ));
        }
        let definition = optional_record::<Definition>(&self.db, "followups", id)?;
        if let Some(d) = &definition {
            if d.actor != FollowupActor::User
                || d.source_run_id != run_id
                || d.thread_id != run.thread_id
                || d.branch_id != run.branch_id
            {
                return Err(RuntimeError::Conflict(
                    "registration is not this original User source".into(),
                ));
            }
        }
        if accepted.iter().any(|r| {
            r.followup_id != id
                || r.actor != FollowupActor::User
                || r.source_run_id != run_id
                || r.thread_id != run.thread_id
        }) {
            return Err(RuntimeError::Conflict(
                "source acceptance belongs to another original User registration".into(),
            ));
        }
        if existing.is_none() && definition.is_none() && accepted.is_empty() {
            return Err(RuntimeError::NotFound(
                "original User registration acceptance".into(),
            ));
        }
        let tx = self.db.transaction()?;
        if existing.is_none() && definition.is_none() {
            tx.execute(
                "INSERT INTO commands(id,intent,receipt) VALUES(?1,?2,?3)",
                params![
                    cancel_key(id),
                    encode(&identity)?,
                    encode(&json!({"followup_id":id,"cancelled":true}))?
                ],
            )?;
            event(
                &tx,
                id,
                1,
                "followup.registration_cancelled",
                json!({"source_run_id":run_id,"thread_id":run.thread_id,"branch_id":run.branch_id}),
            )?;
        }
        let result = definition
            .map(|d| control_tx(&tx, id, d.revision, FollowupControlAction::Cancel))
            .transpose()?;
        tx.commit()?;
        Ok(result)
    }
}
