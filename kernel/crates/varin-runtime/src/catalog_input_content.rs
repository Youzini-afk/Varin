//! Body preparation and hydration run without the Catalog mutex.
use super::*;

pub struct QueuePreparation {
    command: EnqueueInput,
    epoch: u64,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub(super) struct QueueIdentity {
    pub key: String,
    pub thread_id: String,
    pub branch_id: String,
    pub mode: InputMode,
    pub configuration: Option<Value>,
}
pub struct PreparedQueueInput {
    pub(super) identity: QueueIdentity,
    pub(super) epoch: u64,
    pub(super) history: Value,
    pub(super) intent: Value,
    pub(super) _publication: crate::content::ContentPublication,
}
impl QueuePreparation {
    pub fn load(self) -> Result<PreparedQueueInput> {
        let Self {
            command,
            epoch,
            content,
            publication,
        } = self;
        if command.key.trim().is_empty() {
            return Err(RuntimeError::Invalid(
                "input idempotency key cannot be empty".into(),
            ));
        }
        execution_persistence::user_input_items("admission", &command.input)?;
        let history = content.save_history(&command.input, &None)?;
        let intent = content.save(&serde_json::to_value(&command)?)?;
        Ok(PreparedQueueInput {
            identity: QueueIdentity {
                key: command.key,
                thread_id: command.thread_id,
                branch_id: command.branch_id,
                mode: command.mode,
                configuration: command.configuration,
            },
            epoch,
            history,
            intent,
            _publication: publication,
        })
    }
}

pub struct QueuedInputRead {
    pub metadata: QueuedInputMetadata,
    reference: Value,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl QueuedInputRead {
    pub fn load(self) -> Result<QueuedInput> {
        let payload = self.content.hydrate_history(HistoryItem {
            id: self.metadata.id.clone(),
            thread_id: self.metadata.thread_id.clone(),
            parent: None,
            source: HistorySource::User,
            content: self.reference,
            provider: None,
        })?;
        if payload.provider.is_some() {
            return Err(RuntimeError::Invalid(
                "queued input contains a provider original".into(),
            ));
        }
        Ok(self.metadata.with_content(payload.content))
    }
}
pub struct InputEditPreparation {
    id: String,
    revision: u64,
    epoch: u64,
    value: Value,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedInputEdit {
    pub(super) id: String,
    pub(super) revision: u64,
    pub(super) epoch: u64,
    pub(super) reference: Value,
    pub(super) _publication: crate::content::ContentPublication,
}
impl InputEditPreparation {
    pub fn load(self) -> Result<PreparedInputEdit> {
        execution_persistence::user_input_items(&self.id, &self.value)?;
        let reference = self.content.save_history(&self.value, &None)?;
        Ok(PreparedInputEdit {
            id: self.id,
            revision: self.revision,
            epoch: self.epoch,
            reference,
            _publication: self.publication,
        })
    }
}
impl Catalog {
    pub fn prepare_enqueue(&self, command: EnqueueInput) -> QueuePreparation {
        QueuePreparation {
            command,
            epoch: self.epoch,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        }
    }
    pub fn queued_input_metadata(&self, id: &str) -> Result<QueuedInputMetadata> {
        record(&self.db, "input_queue", id)
    }
    pub fn capture_queued_input(&self, id: &str) -> Result<QueuedInputRead> {
        let metadata = self.queued_input_metadata(id)?;
        let reference: String = self.db.query_row(
            "SELECT body FROM input_history_content WHERE input_id=?1",
            [id],
            |row| row.get(0),
        )?;
        Ok(QueuedInputRead {
            metadata,
            reference: serde_json::from_str(&reference)?,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn capture_queued_inputs(&self, branch: &str) -> Result<Vec<QueuedInputRead>> {
        let mut statement = self
            .db
            .prepare("SELECT id FROM input_queue WHERE branch_id=?1 ORDER BY cursor")?;
        let ids = statement
            .query_map([branch], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        ids.into_iter()
            .map(|id| self.capture_queued_input(&id))
            .collect()
    }
    pub fn prepare_input_edit(
        &self,
        id: &str,
        revision: u64,
        value: Value,
    ) -> Result<InputEditPreparation> {
        let metadata = self.queued_input_metadata(id)?;
        if metadata.state != InputState::Queued || metadata.revision != revision {
            return Err(RuntimeError::Conflict(
                "input has changed or was already delivered".into(),
            ));
        }
        context_jobs::require_regular_branch(&self.db, &metadata.branch_id)?;
        Ok(InputEditPreparation {
            id: id.into(),
            revision,
            epoch: self.epoch,
            value,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    pub fn admit_input_edit(&mut self, prepared: PreparedInputEdit) -> Result<QueuedInputRead> {
        let PreparedInputEdit {
            id,
            revision,
            epoch,
            reference,
            _publication,
        } = prepared;
        if epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "input edit belongs to a previous owner".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let mut input: QueuedInputMetadata = record(&tx, "input_queue", &id)?;
        if input.state != InputState::Queued || input.revision != revision {
            return Err(RuntimeError::Conflict(
                "input has changed or was already delivered".into(),
            ));
        }
        input.revision += 1;
        write_input(&tx, &input)?;
        if tx.execute(
            "UPDATE input_history_content SET body=?2 WHERE input_id=?1",
            params![id, encode(&reference)?],
        )? != 1
        {
            return Err(RuntimeError::Invalid(
                "queued history reference missing".into(),
            ));
        }
        event(&tx, &id, input.revision, "input.edited", Value::Null)?;
        tx.commit()?;
        self.capture_queued_input(&id)
    }
}

pub struct InputDeliveryPreparation {
    run: Run,
    head: Option<String>,
    reads: Vec<QueuedInputRead>,
    publication: crate::content::ContentPublication,
}
pub struct PreparedInputDelivery {
    pub(super) run: Run,
    pub(super) head: Option<String>,
    pub(super) selected: Vec<QueuedInputMetadata>,
    pub(super) items: Vec<ConversationItem>,
    pub(super) _publication: crate::content::ContentPublication,
}
impl InputDeliveryPreparation {
    pub fn load(self) -> Result<PreparedInputDelivery> {
        let mut selected = Vec::new();
        let mut items = Vec::new();
        for read in self.reads {
            selected.push(read.metadata.clone());
            let input = read.load()?;
            items.extend(execution_persistence::user_input_items(
                &input.id,
                &input.content,
            )?);
        }
        Ok(PreparedInputDelivery {
            run: self.run,
            head: self.head,
            selected,
            items,
            _publication: self.publication,
        })
    }
}
impl Catalog {
    pub fn prepare_input_delivery(
        &self,
        run_id: &str,
        epoch: u64,
        head: Option<&str>,
    ) -> Result<InputDeliveryPreparation> {
        let run = validate_delivery(&self.db, run_id, epoch, head)?;
        let mut statement=self.db.prepare("SELECT id FROM input_queue WHERE run_id=?1 AND state='queued' AND mode!='next_run' ORDER BY cursor")?;
        let ids = statement
            .query_map([run_id], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let reads = ids
            .into_iter()
            .map(|id| self.capture_queued_input(&id))
            .collect::<Result<Vec<_>>>()?;
        Ok(InputDeliveryPreparation {
            run,
            head: head.map(str::to_owned),
            reads,
            publication: self.content.begin_publication(),
        })
    }
}
pub(super) fn validate_delivery(
    db: &Connection,
    run_id: &str,
    epoch: u64,
    expected_head: Option<&str>,
) -> Result<Run> {
    let run: Run = record(db, "runs", run_id)?;
    fence(&run, epoch)?;
    if run.cancel_requested {
        return Err(RuntimeError::Conflict("input Run was cancelled".into()));
    }
    let (head, active): (Option<String>, Option<String>) = db.query_row(
        "SELECT head,active_run FROM branches WHERE id=?1",
        [&run.branch_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if active.as_deref() != Some(run_id) || head.as_deref() != expected_head {
        return Err(RuntimeError::Conflict(
            "input boundary history owner changed".into(),
        ));
    }
    let open:i64=db.query_row("SELECT (SELECT count(*) FROM model_steps WHERE run_id=?1 AND state IN ('prepared','dispatched'))+(SELECT count(*) FROM tool_calls c JOIN model_steps m ON m.id=c.request_id WHERE m.run_id=?1 AND c.committed=0)",[run_id],|row|row.get(0))?;
    if open > 0 {
        return Err(RuntimeError::Conflict(
            "input cannot enter an unfinished model/tool exchange".into(),
        ));
    }
    Ok(run)
}
