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
    pub input_id: String,
    pub key: String,
    pub thread_id: String,
    pub branch_id: String,
    pub mode: InputMode,
    pub configuration: Option<Value>,
}
pub struct PreparedQueueInput {
    pub(super) attachments: Vec<super::super::attachments::Attachment>,
    pub(super) title: Option<String>,
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
        if queue_intent(&self.command).and_then(|(value, dependencies)| {
            crate::content::ContentStore::payload_reference(
                &serde_json::to_vec(&value)?,
                dependencies,
            )
        })? != *intent
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
        let input_id = existing
            .as_ref()
            .map(|(_, receipt)| receipt.input_id.clone())
            .unwrap_or_else(id);
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
                .is_some_and(|prepared| prepared.has_skills())
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
                content.save_user_history(&input_id, &material)?,
                {
                    let (intent, dependencies) = queue_intent(&command)?;
                    content.save_with_dependencies(&intent, dependencies)?
                },
                input_preparation.as_ref().map(|_| current_id),
            )
        };
        Ok(PreparedQueueInput {
            attachments: super::super::attachments::input_attachments(&command.input)?,
            title: threads::input_title(&command.input),
            identity: QueueIdentity {
                input_id,
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
        let (content, provider) = self
            .content
            .load_stored_history_payload(&self.reference, &|| false)?;
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
    attachments: Vec<super::super::attachments::Attachment>,
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
        let revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| RuntimeError::Invalid("input revision exhausted".into()))?;
        let previous = self.previous.load()?;
        resources::validate_edited_input(&self.value, &previous.content)?;
        let (material, checkpoint) =
            if resources::same_skill_intent(&self.value, &previous.content) {
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
                    .is_some_and(|prepared| prepared.has_skills())
                {
                    self.current
                        .map(context::CheckpointRead::load)
                        .transpose()?
                } else {
                    None
                };
                (
                    resources::bind_edited_input(
                        &self.value,
                        revision,
                        self.input_preparation.as_ref(),
                        current.as_ref(),
                        &previous.content,
                    )?,
                    self.input_preparation.as_ref().map(|_| current_id),
                )
            };
        let mut stored = self.content.store_edited_user_input(&self.id, &material, &previous.content)?;
        // Editing a queued message preserves its original sending time.
        if let Some(time) = previous.content.get("sentTime") {
            if stored.is_string() {
                stored = json!({"text":stored});
            }
            stored["sentTime"] = time.clone();
        }
        // Omission preserves the exact captured revision. Only the owner can reuse these refs.
        if self.value.get("attachments").is_none() {
            if let Some(attachments) = previous.content.get("attachments") {
                if stored.is_string() {
                    stored = json!({"text":stored});
                }
                stored["attachments"] = attachments.clone();
                if let Some(references) = previous.content.get("imageReferences") {
                    stored["imageReferences"] = references.clone();
                }
            }
        }
        if self.value.get("fileAttachments").is_none() {
            if let Some(files) = previous.content.get("fileAttachments") {
                if stored.is_string() { stored=json!({"text":stored}); }
                stored["fileAttachments"] = files.clone();
            }
        }
        crate::output::validate_user_metadata(&stored)?;
        let attachments = super::super::attachments::input_attachments(&stored)?;
        let reference = self.content.save_stored_user_history(&stored)?;
        Ok(PreparedInputEdit {
            attachments,
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
        if !read.metadata.origin.is_user_ingress() {
            return Err(RuntimeError::Invalid(
                "message records use the read-only message API".into(),
            ));
        }
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
        let mut statement = self.db.prepare(
            "SELECT id FROM input_queue WHERE branch_id=?1 AND origin='user' ORDER BY cursor",
        )?;
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
        if !metadata.origin.is_user_ingress() {
            return Err(RuntimeError::Invalid("messages are immutable".into()));
        }
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
            attachments,
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
        if !input.origin.is_user_ingress() {
            return Err(RuntimeError::Invalid("messages are immutable".into()));
        }
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
        tx.execute("DELETE FROM attachment_deliveries WHERE holder_kind='input' AND holder_id=?1",[&id])?;
        super::super::attachments::publish(&tx,&super::super::attachments::AttachmentDelivery {
            source_thread_id:None, source_branch_id:None, holder_kind:"input".into(),holder_id:id.clone(),thread_id:input.thread_id.clone(),branch_id:input.branch_id.clone(),attachments,input_ref:None,
        })?;
        event(&tx, &id, input.revision, "input.edited", Value::Null)?;
        tx.commit()?;
        self.capture_queued_input(&id)
    }
}

pub struct InputDeliveryPreparation {
    run: Run,
    head: Option<String>,
    reads: Vec<QueuedInputRead>,
    initial: Vec<HistoryItem>,
    publication: crate::content::ContentPublication,
}
pub struct PreparedInputDelivery {
    pub(super) run: Run,
    pub(super) head: Option<String>,
    pub(super) selected: Vec<QueuedInputMetadata>,
    pub(super) items: crate::execution::ConversationHistory,
    pub(super) projections: std::collections::BTreeMap<String, Value>,
    pub(super) initial: Vec<HistoryItem>,
    pub(super) replacements: crate::execution::ConversationHistory,
    pub(super) _publication: crate::content::ContentPublication,
}
impl InputDeliveryPreparation {
    pub fn load(self) -> Result<PreparedInputDelivery> {
        let mut selected = Vec::new();
        let mut items = Vec::new();
        let mut projections = std::collections::BTreeMap::new();
        let mut replacements = Vec::new();
        let references = self.reads.iter().map(|read| {
            matches!(read.metadata.origin, InputOrigin::Followup { user_input: false, .. })
                .then(|| read.reference.clone())
        }).collect::<Vec<_>>();
        let projected = if let Some(read) = self.reads.first() {
            super::super::followups::event_input::project_batch(&read.content, &references)?
        } else { vec![] };
        for (index, (read, projection)) in self.reads.into_iter().zip(projected).enumerate() {
            let initial = index < self.initial.len();
            if !initial { selected.push(read.metadata.clone()); }
            let (content, provider) = if let Some(mut projection) = projection {
                projection.item.id = read.metadata.id.clone();
                let reference = read.content.save_conversation_with_dependencies(
                    &projection.item, &None, projection.dependencies,
                )?;
                projections.insert(read.metadata.id.clone(), reference);
                (serde_json::to_value(projection.item)?, None)
            } else {
                read.content.load_history_payload(&read.reference)?
            };
            if provider.is_some() {
                return Err(RuntimeError::Invalid("input has provider original".into()));
            }
            let projected_items = execution_persistence::history_input_items(
                &read.metadata.id,
                read.metadata.origin.history_source(),
                &content,
            )?;
            if initial { replacements.extend(projected_items); } else { items.extend(projected_items); }
        }
        Ok(PreparedInputDelivery {
            run: self.run,
            head: self.head,
            selected,
            items,
            projections,
            initial: self.initial,
            replacements,
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
        // User/activating ingress retains its stronger boundary semantics. Passive environment
        // facts are one finite committed page, not a barrier waiting for Host production to stop.
        let observation_cursor =
            super::super::context_observations::committed_cursor(&self.db, &run.branch_id)?;
        let mut statement = self.db.prepare("SELECT id FROM input_queue WHERE branch_id=?2 AND state='queued' AND mode!='next_run' AND origin!='context_observation' AND (run_id=?1 OR activation='passive') ORDER BY cursor")?;
        let mut ids = statement
            .query_map(params![run_id, run.branch_id], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let has_observations:bool=self.db.query_row("SELECT EXISTS(SELECT 1 FROM input_queue WHERE branch_id=?1 AND origin='context_observation' AND state='queued' AND cursor<=?2)",params![run.branch_id,sql_number(observation_cursor)?],|row|row.get(0))?;
        if has_observations {
            let sources = self.context_observation_sources(
                &super::super::context_observations::ContextObservationSources {
                    run_id: Some(run_id.into()),
                },
            )?;
            let owners: Vec<_> = sources.into_iter().map(|source| source.run_id).collect();
            let mut observations = self.db.prepare("SELECT id FROM input_queue WHERE branch_id=?1 AND origin='context_observation' AND state='queued' AND cursor<=?2 AND json_extract(body,'$.origin.owner.runId') IN (SELECT value FROM json_each(?3)) ORDER BY cursor LIMIT ?4")?;
            ids.extend(
                observations
                    .query_map(
                        params![
                            run.branch_id,
                            sql_number(observation_cursor)?,
                            encode(&owners)?,
                            super::super::context_observations::OBSERVATION_BOUNDARY_PAGE as i64
                        ],
                        |row| row.get::<_, String>(0),
                    )?
                    .collect::<std::result::Result<Vec<_>, _>>()?,
            );
        }
        if super::super::observations::next(&self.db, run_id)?.is_some() {
            ids.clear();
        }
        let mut reads = Vec::new();
        let mut holds = super::super::ingress::HoldBatch::default();
        for id in ids {
            let read = self.capture_input_row(&id)?;
            if holds.hold(&self.db, &read.metadata, &run)?.is_none() {
                reads.push(read);
            }
        }
        reads.sort_by_key(|read| read.metadata.cursor);

        // Admission records the original waking input before the worker exists. Include
        // that input at its first model boundary, alongside the other ready arrangements.
        // Once a request exists, its history prefix is immutable, including on retries.
        let mut initial = Vec::new();
        let mut first_reads = Vec::new();
        let mut query = self.db.prepare("SELECT h.body FROM history h JOIN input_queue q ON q.id=h.id WHERE h.run_id=?1 AND q.origin='followup' AND q.state='delivered' AND NOT EXISTS(SELECT 1 FROM model_steps WHERE run_id=?1) ORDER BY q.cursor")?;
        let originals = query.query_map([run_id], |row| row.get::<_, String>(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
        for raw in originals {
            let item: HistoryItem = serde_json::from_str(&raw)?;
            let read = self.capture_input_row(&item.id)?;
            if matches!(read.metadata.origin, InputOrigin::Followup { user_input: false, .. }) && item.content == read.reference {
                initial.push(item);
                first_reads.push(read);
            }
        }
        first_reads.extend(reads);

        Ok(InputDeliveryPreparation {
            run,
            head: head.map(str::to_owned),
            reads: first_reads,
            initial,
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

fn queue_intent(command: &EnqueueInput) -> Result<(Value, Vec<String>)> {
    let input = crate::content::ContentStore::normalized_user_input(&command.key, &command.input)?;
    let dependencies = crate::output::incoming_input_dependencies(&input)?;
    let mut value = serde_json::to_value(command)?;
    value["input"] = input;
    Ok((value, dependencies))
}
