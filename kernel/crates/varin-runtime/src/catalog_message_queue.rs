//! Sender controls operate only on unconsumed original ingress. Body preparation
//! happens outside the Catalog lock; the captured row fences activation and edits.
use super::*;

pub struct MessageEditPreparation {
    row: QueuedInputMetadata,
    intent: Value,
    history: Value,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct PreparedMessageEdit {
    row: QueuedInputMetadata,
    intent: Value,
    history: Value,
    _publication: crate::content::ContentPublication,
}
fn owned_queue(
    db: &Connection,
    thread: &str,
    branch: &str,
    id: &str,
    revision: u64,
) -> Result<QueuedInputMetadata> {
    branch_owner(db, thread, branch)?;
    let row: QueuedInputMetadata = record(db, "input_queue", id)?;
    let identity = message_identity(&row)?;
    if identity.sender_thread_id != thread
        || identity.sender_branch_id != branch
        || row.revision != revision
        || row.state != InputState::Queued
    {
        return Err(RuntimeError::Conflict(
            "Message has changed or is already being handled; refresh its queue state".into(),
        ));
    }
    Ok(row)
}
impl Catalog {
    pub fn control_queued_message(
        &mut self,
        thread: &str,
        branch: &str,
        id: &str,
        revision: u64,
        action: &str,
    ) -> Result<()> {
        let resolved=self.resolve_message_reference(id)?;
        let id=resolved.as_str();
        let tx = self.db.transaction()?;
        let mut row = owned_queue(&tx, thread, branch, id, revision)?;
        match action {
            "cancel" => activation::cancel_row(&tx, &mut row)?,
            "send_now" => {
                let identity = message_identity(&row)?.clone();
                if identity.source_agent.is_some() {
                    return Err(RuntimeError::Conflict(
                        "A file-basis change requires the next execution's preparation".into(),
                    ));
                }
                let next = activation::accept(&tx, &identity)?;
                row.mode = InputMode::Boundary;
                row.run_id = next.run_id().map(str::to_owned);
                activation::set_fact(&mut row, next);
                row.revision += 1;
                inputs::write_input(&tx, &row)?;
            }
            _ => {
                return Err(RuntimeError::Invalid(
                    "Unknown queued message action".into(),
                ));
            }
        }
        event(
            &tx,
            id,
            row.revision,
            "message.queue_changed",
            json!({"action":action}),
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn prepare_queued_message_edit(
        &self,
        thread: &str,
        branch: &str,
        id: &str,
        revision: u64,
    ) -> Result<MessageEditPreparation> {
        let resolved=self.resolve_message_reference(id)?;
        let id=resolved.as_str();
        let row = owned_queue(&self.db, thread, branch, id, revision)?;
        if !matches!(message_identity(&row)?.actor, MessageActor::User) {
            return Err(RuntimeError::Invalid(
                "Only an unhandled User message can be edited".into(),
            ));
        }
        let read = self.capture_message(thread, branch, id)?;
        let history: String = self.db.query_row(
            "SELECT body FROM input_history_content WHERE input_id=?1",
            [id],
            |r| r.get(0),
        )?;
        Ok(MessageEditPreparation {
            row,
            intent: read.intent,
            history: serde_json::from_str(&history)?,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn admit_queued_message_edit(&mut self, prepared: PreparedMessageEdit) -> Result<()> {
        let tx = self.db.transaction()?;
        let mut row: QueuedInputMetadata = record(&tx, "input_queue", &prepared.row.id)?;
        if row != prepared.row || row.state != InputState::Queued {
            return Err(RuntimeError::Conflict(
                "Message was handled or changed while editing; refresh its queue state".into(),
            ));
        }
        if let InputOrigin::Message { edited_intent, .. } = &mut row.origin {
            *edited_intent = Some(prepared.intent);
        }
        tx.execute(
            "UPDATE input_history_content SET body=?2 WHERE input_id=?1",
            params![row.id, encode(&prepared.history)?],
        )?;
        row.revision += 1;
        inputs::write_input(&tx, &row)?;
        event(
            &tx,
            &row.id,
            row.revision,
            "message.queue_changed",
            json!({"action":"edit"}),
        )?;
        tx.commit()?;
        Ok(())
    }
}
impl MessageEditPreparation {
    pub fn load(self, text: String) -> Result<PreparedMessageEdit> {
        let mut intent: MessageIntent = serde_json::from_value(self.content.load(&self.intent)?)?;
        let changed = intent.input.text != text;
        intent.input.text = text;
        intent.input.validate_with_content(intent.user_content.as_ref().and_then(|value|value.get("contentReferences")).and_then(Value::as_array).is_some_and(|references| !references.is_empty()))?;
        let (mut body, _) = self
            .content
            .load_stored_history_payload(&self.history, &|| false)?;
        let old = body["text"].as_str().ok_or_else(|| RuntimeError::Invalid("Queued User message text is unavailable".into()))?;
        if let Some(original) = body.get("userText").and_then(Value::as_str) {
            let suffix = old.strip_prefix(original).ok_or_else(|| RuntimeError::Invalid("Queued quoted message envelope is unavailable".into()))?.to_owned();
            body["text"] = json!(format!("{}{suffix}", intent.input.text));
            body["userText"] = json!(intent.input.text);
            if changed {
                body["contentReferenceOccurrences"] = json!([]);
                if let Some(metadata) = &mut intent.user_content { metadata["contentReferenceOccurrences"] = json!([]); }
            }
            crate::output::validate_user_metadata(&body)?;
        } else {
            let header = old.split_once("\n\n").map(|(header, _)| header).ok_or_else(|| RuntimeError::Invalid("Queued message envelope is unavailable".into()))?;
            body["text"] = json!(format!("{header}\n\n{}", intent.input.text));
        }
        Ok(PreparedMessageEdit {
            row: self.row,
            intent: self.content.save(&serde_json::to_value(intent)?)?,
            history: self.content.save_stored_user_history(&body)?,
            _publication: self._publication,
        })
    }
}
