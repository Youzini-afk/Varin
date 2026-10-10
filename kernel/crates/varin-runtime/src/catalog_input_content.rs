//! Body preparation and hydration run without the Catalog mutex.
use super::*;

pub struct QueuePreparation {
    existing: Option<(Value, InputReceipt)>,
    current: Option<context::CheckpointRead>,
    input_preparation: Option<resources::InputResourcePreparation>,
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
    pub(super) checkpoint: Option<Option<String>>,
    pub(super) identity: QueueIdentity,
    pub(super) epoch: u64,
    pub(super) history: Value,
    pub(super) intent: Value,
    pub(super) _publication: crate::content::ContentPublication,
}
impl QueuePreparation {
    pub fn with_input_preparation(
        mut self,
        preparation: Option<resources::InputResourcePreparation>,
    ) -> Self {
        self.input_preparation = preparation;
        self
    }
    pub fn existing_receipt(&self) -> Result<Option<InputReceipt>> {
        let Some((intent, receipt)) = &self.existing else {
            return Ok(None);
        };
        if crate::content::ContentStore::reference(&serde_json::to_value(&self.command)?)?
            != *intent
        {
            return Err(RuntimeError::Conflict(
                "input key has different content or mode".into(),
            ));
        }
        Ok(Some(receipt.clone()))
    }
    pub fn load(self) -> Result<PreparedQueueInput> {
        let duplicate = self.existing_receipt()?.is_some();
        let Self {
            command,
            epoch,
            content,
            publication,
            current,
            input_preparation,
            existing,
        } = self;
        if command.key.trim().is_empty() {
            return Err(RuntimeError::Invalid(
                "input idempotency key cannot be empty".into(),
            ));
        }
        let (history, intent, checkpoint) = if duplicate {
            (
                Value::Null,
                existing.expect("validated queued receipt").0,
                None,
            )
        } else {
            let current_id = current.as_ref().map(|checkpoint| checkpoint.id.clone());
            if input_preparation
                .as_ref()
                .is_some_and(|prepared| prepared.expected_context_checkpoint != current_id)
            {
                return Err(RuntimeError::Conflict(
                    "prepared skill context is based on a different checkpoint".into(),
                ));
            }
            let current = if input_preparation
                .as_ref()
                .is_some_and(|prepared| prepared.skill.is_some())
            {
                current.map(context::CheckpointRead::load).transpose()?
            } else {
                None
            };
            let material = resources::bind_input(
                &command.input,
                1,
                input_preparation.as_ref(),
                current.as_ref(),
            )?;
            (
                content.save_history(&material, &None)?,
                content.save(&serde_json::to_value(&command)?)?,
                input_preparation.as_ref().map(|_| current_id),
            )
        };
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
            checkpoint,
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
        let (content, provider) = self.content.load_history_payload(&self.reference)?;
        if provider.is_some() {
            return Err(RuntimeError::Invalid(
                "queued input contains a provider original".into(),
            ));
        }
        self.metadata.with_content(content)
    }
}
pub struct InputEditPreparation {
    previous: QueuedInputRead,
    current: Option<context::CheckpointRead>,
    input_preparation: Option<resources::InputResourcePreparation>,
    id: String,
    revision: u64,
    epoch: u64,
    value: Value,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedInputEdit {
    pub(super) checkpoint: Option<Option<String>>,
    pub(super) id: String,
    pub(super) revision: u64,
    pub(super) epoch: u64,
    pub(super) reference: Value,
    pub(super) _publication: crate::content::ContentPublication,
}
impl InputEditPreparation {
    pub fn with_input_preparation(
        mut self,
        preparation: Option<resources::InputResourcePreparation>,
    ) -> Self {
        self.input_preparation = preparation;
        self
    }
    pub fn load(self) -> Result<PreparedInputEdit> {
        resources::validate_raw_input(&self.value)?;
        let revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| RuntimeError::Invalid("input revision exhausted".into()))?;
        let previous = self.previous.load()?;
        let (material, checkpoint) =
            if resources::input_text(&self.value) == resources::input_text(&previous.content) {
                (
                    resources::preserve(&self.value, &previous.content, revision)?,
                    None,
                )
            } else {
                let current_id = self
                    .current
                    .as_ref()
                    .map(|checkpoint| checkpoint.id.clone());
                if self
                    .input_preparation
                    .as_ref()
                    .is_some_and(|prepared| prepared.expected_context_checkpoint != current_id)
                {
                    return Err(RuntimeError::Conflict(
                        "prepared skill context is based on a different checkpoint".into(),
                    ));
                }
                let current = if self
                    .input_preparation
                    .as_ref()
                    .is_some_and(|prepared| prepared.skill.is_some())
                {
                    self.current
                        .map(context::CheckpointRead::load)
                        .transpose()?
                } else {
                    None
                };
                (
                    resources::bind_input(
                        &self.value,
                        revision,
                        self.input_preparation.as_ref(),
                        current.as_ref(),
                    )?,
                    self.input_preparation.as_ref().map(|_| current_id),
                )
            };
        let reference = self.content.save_history(&material, &None)?;
        Ok(PreparedInputEdit {
            id: self.id,
            revision: self.revision,
            epoch: self.epoch,
            reference,
            checkpoint,
            _publication: self.publication,
        })
    }
}

impl Catalog {
    pub fn prepare_enqueue(&self, command: EnqueueInput) -> Result<QueuePreparation> {
        let existing: Option<(String, String)> = self
            .db
            .query_row(
                "SELECT intent,receipt FROM commands WHERE id=?1",
                [&command.key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let existing = existing
            .map(|(intent, receipt)| -> Result<_> {
                Ok((
                    serde_json::from_str(&intent)?,
                    serde_json::from_str(&receipt)?,
                ))
            })
            .transpose()?;
        Ok(QueuePreparation {
            current: self.capture_active_checkpoint(&command.branch_id)?,
            existing,
            input_preparation: None,
            command,
            epoch: self.epoch,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    pub fn queued_input_metadata(&self, id: &str) -> Result<QueuedInputMetadata> {
        record(&self.db, "input_queue", id)
    }
    pub fn capture_queued_input(&self, id: &str) -> Result<QueuedInputRead> {
        let read = self.capture_input_row(id)?;
        if !read.metadata.origin.is_user_ingress() { return Err(RuntimeError::Invalid("message records use the read-only message API".into())); }
        Ok(read)
    }
    pub(super) fn capture_input_row(&self, id: &str) -> Result<QueuedInputRead> {
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
            .prepare("SELECT id FROM input_queue WHERE branch_id=?1 AND origin='user' ORDER BY cursor")?;
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
        if !metadata.origin.is_user_ingress() { return Err(RuntimeError::Invalid("messages are immutable".into())); }
        if metadata.state != InputState::Queued || metadata.revision != revision {
            return Err(RuntimeError::Conflict(
                "input has changed or was already delivered".into(),
            ));
        }
        context_jobs::require_regular_branch(&self.db, &metadata.branch_id)?;
        Ok(InputEditPreparation {
            previous: self.capture_queued_input(id)?,
            current: self.capture_active_checkpoint(&metadata.branch_id)?,
            input_preparation: None,
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
            checkpoint,
            _publication,
        } = prepared;
        if epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "input edit belongs to a previous owner".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let mut input: QueuedInputMetadata = record(&tx, "input_queue", &id)?;
        if !input.origin.is_user_ingress() { return Err(RuntimeError::Invalid("messages are immutable".into())); }
        if input.state != InputState::Queued || input.revision != revision {
            return Err(RuntimeError::Conflict(
                "input has changed or was already delivered".into(),
            ));
        }
        if let Some(expected) = checkpoint {
            let active: Option<String> = tx
                .query_row(
                    "SELECT checkpoint_id FROM active_contexts WHERE branch_id=?1",
                    [&input.branch_id],
                    |row| row.get(0),
                )
                .optional()?;
            if active != expected {
                return Err(RuntimeError::Conflict(
                    "input resource context changed during preparation".into(),
                ));
            }
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
            let (content, provider) = read.content.load_history_payload(&read.reference)?;
            if provider.is_some() { return Err(RuntimeError::Invalid("input has provider original".into())); }
            if read.metadata.origin.history_source() == HistorySource::User {
                items.extend(execution_persistence::user_input_items(&read.metadata.id, &content)?);
            } else { items.push(serde_json::from_value(content)?); }
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
        let mut statement=self.db.prepare("SELECT id FROM input_queue WHERE branch_id=?2 AND state='queued' AND mode!='next_run' AND (run_id=?1 OR activation='passive') ORDER BY cursor")?;
        let ids = statement
            .query_map(params![run_id, run.branch_id], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let reads = ids
            .into_iter()
            .map(|id| self.capture_input_row(&id))
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
