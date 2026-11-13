//! Durable plugin event receipt and matching live inside the original follow-up owner.
//! Plugins own remote I/O; immutable content is prepared before the cursor transaction.
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginEventSourceHost {
    pub host_id: String,
    pub connection_id: String,
    pub endpoint_identity: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginEventSource {
    pub extension_id: String,
    pub source_id: String,
    pub connection_id: String,
    pub account_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<PluginEventSourceHost>,
}
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FollowupOwner {
    #[default]
    Work,
    Bot {
        bot_id: String,
    },
}
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EventTiming {
    #[default]
    Immediate,
    Batch {
        window_ms: u64,
    },
    Scheduled {
        calendar_id: String,
        run_empty: bool,
    },
    Passive,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventCoverage {
    pub kind: String,
    pub from_ms: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventSourceStatus {
    pub code: Option<String>,
    pub message: Option<String>,
    pub coverage: Option<EventCoverage>,
    pub last_connected_at_ms: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventSourceIdentity {
    pub principal_id: Option<String>,
    pub source: PluginEventSource,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventSourceCheckpoint {
    pub identity: EventSourceIdentity,
    pub cursor: Option<String>,
    pub status: Option<EventSourceStatus>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventSourceSubscription {
    pub followup_id: String,
    pub identity: EventSourceIdentity,
    pub filter: Value,
    pub state: FollowupState,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventEcho {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_host_id: Option<String>,
    pub followup_id: String,
    pub occurrence_id: String,
    pub operation_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventState {
    /// A complete, replaceable snapshot within this source, object and sender.
    pub key: String,
    /// Source ordering, preserved by backfill. Receipt order is not version order.
    pub sequence: u64,
    /// Human-readable state; changes remain visible when snapshot bodies are folded.
    pub value: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginEventInput {
    pub event_id: String,
    pub object_id: Option<String>,
    pub sender_id: Option<String>,
    pub revision: Option<String>,
    pub occurred_at_ms: u64,
    pub attributes: Value,
    pub content: crate::output::OutputBody<crate::output::IncomingMedia>,
    #[serde(default)]
    pub files: Vec<EventFileInput>,
    pub echo_of: Option<EventEcho>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<EventState>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventReceiveInput {
    pub identity: EventSourceIdentity,
    pub expected_cursor: Option<String>,
    pub next_cursor: Option<String>,
    pub status: Option<EventSourceStatus>,
    pub events: Vec<PluginEventInput>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventReceiveReceipt {
    pub accepted: usize,
    pub duplicates: usize,
    pub checkpoint: EventSourceCheckpoint,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FirstContactPolicy {
    CreateBotSession,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArrangementInput {
    pub key: String,
    pub expected_revision: Option<u64>,
    pub bot_id: String,
    pub thread_id: String,
    pub branch_id: String,
    pub name: String,
    pub instruction: String,
    pub source: PluginEventSource,
    pub filter: Value,
    pub timing: EventTiming,
    #[serde(default)]
    pub repeat: FollowupRepeat,
    pub first_contact: Option<FirstContactPolicy>,
    pub source_run_id: Option<String>,
    pub external_conversation_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventBacklogInput {
    pub followup_id: String,
    pub expected_revision: u64,
    pub action: EventBacklogAction,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EventBacklogAction {
    ProcessNow,
    Discard,
}

pub(super) fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE followup_event_sources(id TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE followup_events(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES followup_event_sources(id),accepted_cursor INTEGER NOT NULL UNIQUE,received_at_ms INTEGER NOT NULL,content_ref TEXT,body TEXT NOT NULL);
        CREATE INDEX followup_events_source ON followup_events(source_id,accepted_cursor);
        CREATE INDEX followup_events_identity ON followup_events(source_id,json_extract(body,'$.event_id'),json_extract(body,'$.object_id'),json_extract(body,'$.revision'));
        CREATE TABLE followup_event_matches(followup_id TEXT NOT NULL REFERENCES followups(id),event_id TEXT NOT NULL REFERENCES followup_events(id),occurrence_id TEXT REFERENCES followup_occurrences(id),discarded INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(followup_id,event_id));
        CREATE INDEX followup_event_pending ON followup_event_matches(followup_id,occurrence_id,discarded);
        CREATE TABLE followup_event_routes(id TEXT PRIMARY KEY,followup_id TEXT NOT NULL REFERENCES followups(id),object_id TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(followup_id,object_id));")?;
    super::event_transport::initialize(db)?;
    super::event_files::initialize(db)?;
    Ok(())
}
pub(crate) fn check_format(db: &Connection) -> Result<()> {
    db.prepare("SELECT id,body FROM followup_event_sources")?;
    db.prepare(
        "SELECT id,source_id,accepted_cursor,received_at_ms,content_ref,body FROM followup_events",
    )?;
    db.prepare("SELECT followup_id,event_id,occurrence_id,discarded FROM followup_event_matches")?;
    db.prepare("SELECT id,followup_id,object_id,body FROM followup_event_routes")?;
    super::event_transport::validate_store(db)?;
    super::event_files::validate_store(db)?;
    Ok(())
}
pub(crate) fn upgrade(tx: &Transaction<'_>) -> Result<()> {
    // Preserve rowids (stable list order), original identities, receipts and occurrence edges.
    tx.execute_batch("PRAGMA defer_foreign_keys=ON;
        CREATE TABLE followups_current(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id),source_run_id TEXT REFERENCES runs(id),body TEXT NOT NULL);
        INSERT INTO followups_current(rowid,id,thread_id,source_run_id,body)
          SELECT rowid,id,thread_id,source_run_id,json_set(body,'$.owner',json('{\"kind\":\"work\"}'),'$.name',NULL,'$.timing',json('{\"kind\":\"immediate\"}'),'$.event_after',0,'$.calendar_after',0,'$.principal_id',(SELECT principal_id FROM threads WHERE id=followups.thread_id)) FROM followups;
        DROP TABLE followups;
        ALTER TABLE followups_current RENAME TO followups;
        CREATE INDEX followups_thread ON followups(thread_id);
        CREATE INDEX followups_source ON followups(source_run_id);
        CREATE INDEX followups_wait_state ON followups(json_extract(body,'$.wait.state'));")?;
    // SQLite's deferred counter still remembers the replaced parent table. Verify the
    // actual graph before clearing that counter; no missing edge may cross the commit.
    let invalid: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_check)",
        [],
        |r| r.get(0),
    )?;
    if invalid {
        return Err(RuntimeError::Invalid(
            "follow-up upgrade changed a foreign key".into(),
        ));
    }
    tx.execute_batch("PRAGMA defer_foreign_keys=OFF; UPDATE followup_occurrences SET body=json_set(body,'$.passive',json('false'),'$.cancelled',json('false'),'$.target',NULL,'$.user_input',json('false')); UPDATE input_queue SET body=json_set(body,'$.origin.user_input',json('false')) WHERE origin='followup'; CREATE INDEX followups_bot ON followups(json_extract(body,'$.owner.bot_id'));")?;
    initialize(tx)
}
pub(super) fn source_key(identity: &EventSourceIdentity) -> Result<String> {
    encode(identity)
}
fn valid_text(value: &str) -> Result<()> {
    if value.trim().is_empty() {
        return Err(RuntimeError::Invalid(
            "event identity and intent must not be empty".into(),
        ));
    }
    Ok(())
}
fn validate_identity(identity: &EventSourceIdentity) -> Result<()> {
    if let Some(principal) = &identity.principal_id {
        principals::validate(principal)?;
    }
    for value in [
        &identity.source.extension_id,
        &identity.source.source_id,
        &identity.source.connection_id,
        &identity.source.account_id,
    ] {
        valid_text(value)?;
    }
    Ok(())
}
fn identity(_db: &Connection, d: &Definition) -> Result<Option<EventSourceIdentity>> {
    let FollowupTrigger::PluginEvent { source, .. } = &d.trigger else {
        return Ok(None);
    };
    Ok(Some(EventSourceIdentity {
        principal_id: d.principal_id.clone(),
        source: source.clone(),
    }))
}
pub(super) fn checkpoint(
    db: &Connection,
    identity: &EventSourceIdentity,
) -> Result<EventSourceCheckpoint> {
    validate_identity(identity)?;
    Ok(
        optional_record(db, "followup_event_sources", &source_key(identity)?)?.unwrap_or(
            EventSourceCheckpoint {
                identity: identity.clone(),
                cursor: None,
                status: None,
            },
        ),
    )
}
pub(super) fn save_checkpoint(tx: &Transaction<'_>, value: &EventSourceCheckpoint) -> Result<()> {
    tx.execute("INSERT INTO followup_event_sources(id,body) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body", params![source_key(&value.identity)?, encode(value)?])?;
    Ok(())
}
pub(super) fn definitions(db: &Connection) -> Result<Vec<Definition>> {
    let mut query = db.prepare("SELECT body FROM followups WHERE json_extract(body,'$.trigger.kind')='plugin_event' AND json_extract(body,'$.state')!='cancelled' ORDER BY rowid")?;
    let result = query
        .query_map([], |row| row.get::<_, String>(0))?
        .map(|row| Ok(serde_json::from_str(&row?)?))
        .collect();
    result
}
pub(super) fn target_hold(db: &Connection, d: &Definition) -> Result<Option<HoldReason>> {
    let available: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM threads t JOIN branches b ON b.thread_id=t.id WHERE t.id=?1 AND b.id=?2 AND t.deleted_at_ms IS NULL AND t.archived=0)", params![d.thread_id,d.branch_id], |r|r.get(0))?;
    if !available || threads::branch_deleted(db, &d.branch_id)? {
        return Ok(Some(HoldReason::TargetUnavailable));
    }
    if let FollowupOwner::Bot { bot_id } = &d.owner {
        if !bot::permitted(db, bot_id, bot::current_epoch(db)?)? {
            return Ok(Some(HoldReason::BotSuspended));
        }
    }
    if let Some(conversation) = &d.external_conversation_id {
        return super::external::target_hold(db, conversation);
    }
    Ok(None)
}
fn validate_target(db: &Connection, input: &ArrangementInput) -> Result<()> {
    valid_text(&input.key)?;
    valid_text(&input.name)?;
    valid_text(&input.instruction)?;
    valid_text(&input.bot_id)?;
    threads::require_public(db, &input.thread_id)?;
    context_jobs::require_regular_branch(db, &input.branch_id)?;
    let principal = principals::thread(db, &input.thread_id)?;
    let available: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM threads t JOIN branches b ON b.thread_id=t.id WHERE t.id=?1 AND b.id=?2 AND t.deleted_at_ms IS NULL AND t.archived=0)", params![input.thread_id,input.branch_id], |r|r.get(0))?;
    if !available || threads::branch_deleted(db, &input.branch_id)? {
        return Err(RuntimeError::Conflict(
            "arrangement target is unavailable".into(),
        ));
    }
    // A Bot may route to ordinary same-user work, but never silently to another Bot's entry.
    if let Some(target_bot) = db
        .query_row(
            "SELECT bot_id FROM bot_thread_bindings WHERE thread_id=?1",
            [&input.thread_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        if target_bot != input.bot_id {
            return Err(RuntimeError::Conflict(
                "arrangement target belongs to another Bot".into(),
            ));
        }
    }
    let sessions = bot::sessions(db, &input.bot_id)?;
    if sessions.is_empty()
        || !sessions
            .iter()
            .any(|thread| principals::thread(db, thread).ok().as_ref() == Some(&principal))
    {
        return Err(RuntimeError::Conflict(
            "arrangement Bot and target principal differ".into(),
        ));
    }
    if input.first_contact.is_some() && input.external_conversation_id.is_some() {
        return Err(RuntimeError::Invalid(
            "first contact sessions require a native Bot target".into(),
        ));
    }
    if let Some(conversation) = &input.external_conversation_id {
        super::external::validate_target(db, principal.as_deref(), conversation)?;
    }
    validate_identity(&EventSourceIdentity {
        principal_id: principal,
        source: input.source.clone(),
    })?;
    if !input.filter.is_object() {
        return Err(RuntimeError::Invalid(
            "event filter must be an object of declared attributes".into(),
        ));
    }
    if let Some(run_id) = &input.source_run_id {
        let run: Run = record(db, "runs", run_id)?;
        if principals::thread(db, &run.thread_id)? != principals::thread(db, &input.thread_id)? {
            return Err(RuntimeError::Conflict(
                "creator Run principal differs".into(),
            ));
        }
    }
    if let EventTiming::Batch { window_ms } = input.timing {
        sql_number(window_ms)?;
    }
    if let EventTiming::Scheduled { calendar_id, .. } = &input.timing {
        let calendar: Value = record(db, "calendar_definitions", calendar_id)?;
        if calendar["view"]["target"]["threadId"] != input.thread_id
            || calendar["view"]["target"]["branchId"] != input.branch_id
        {
            return Err(RuntimeError::Conflict(
                "event Calendar must target the same conversation".into(),
            ));
        }
    }
    Ok(())
}
pub struct ArrangementPreparation {
    input: ArrangementInput,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
    epoch: u64,
}
pub struct PreparedArrangement {
    capture: ArrangementPreparation,
    instruction: Value,
}
impl ArrangementPreparation {
    pub fn load(self) -> Result<PreparedArrangement> {
        let instruction = self.content.save(&json!(self.input.instruction))?;
        Ok(PreparedArrangement {
            capture: self,
            instruction,
        })
    }
}
impl Catalog {
    pub fn prepare_arrangement(&self, input: ArrangementInput) -> Result<ArrangementPreparation> {
        validate_target(&self.db, &input)?;
        Ok(ArrangementPreparation {
            input,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
            epoch: self.epoch,
        })
    }
    pub fn admit_arrangement(&mut self, prepared: PreparedArrangement) -> Result<Followup> {
        let PreparedArrangement {
            capture,
            instruction,
        } = prepared;
        let _publication = capture.publication;
        if capture.epoch != self.epoch {
            return Err(RuntimeError::Conflict("arrangement owner changed".into()));
        }
        let tx = self.db.transaction()?;
        let result = put_arrangement_tx(&tx, capture.input, instruction, FollowupActor::User)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn event_source_subscriptions(&self) -> Result<Vec<EventSourceSubscription>> {
        definitions(&self.db)?
            .into_iter()
            .filter(|d| {
                d.repeat != FollowupRepeat::Once || d.wait.state == NextRunWaitState::Waiting
            })
            .map(|d| {
                let identity = identity(&self.db, &d)?.expect("plugin event");
                let FollowupTrigger::PluginEvent { filter, .. } = d.trigger else {
                    unreachable!()
                };
                Ok(EventSourceSubscription {
                    followup_id: d.id,
                    identity,
                    filter,
                    state: d.state,
                })
            })
            .collect()
    }
    pub fn event_source_checkpoint(
        &self,
        identity: &EventSourceIdentity,
    ) -> Result<EventSourceCheckpoint> {
        checkpoint(&self.db, identity)
    }
    pub fn update_event_source_status(
        &mut self,
        identity: EventSourceIdentity,
        status: EventSourceStatus,
    ) -> Result<EventSourceCheckpoint> {
        let tx = self.db.transaction()?;
        let mut cp = checkpoint(&tx, &identity)?;
        if cp.status.as_ref() != Some(&status) {
            cp.status = Some(status);
            save_checkpoint(&tx, &cp)?;
            publish_source_change(&tx, &identity, "followup.source_status_changed")?;
        }
        tx.commit()?;
        Ok(cp)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(super) struct ReceivedEvent {
    pub(super) event_id: String,
    pub(super) object_id: Option<String>,
    pub(super) sender_id: Option<String>,
    pub(super) revision: Option<String>,
    pub(super) occurred_at_ms: u64,
    pub(super) attributes: Value,
    pub(super) echo_of: Option<EventEcho>,
    pub(super) fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) state: Option<EventState>,
    #[serde(default)]
    pub(super) files: Vec<super::event_files::StoredEventFile>,
}
pub struct EventReceivePreparation {
    input: EventReceiveInput,
    known_ids: std::collections::BTreeMap<String, String>,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
    epoch: u64,
}
pub struct PreparedEventReceive {
    capture: EventReceivePreparation,
    events: Vec<(String, ReceivedEvent, Value)>,
}
impl EventReceivePreparation {
    pub fn load(self) -> Result<PreparedEventReceive> {
        let source = source_key(&self.input.identity)?;
        let mut events = Vec::new();
        for input in &self.input.events {
            valid_text(&input.event_id)?;
            if let Some(state) = &input.state {
                valid_text(&state.key)?;
                valid_text(&state.value)?;
                // Event metadata also travels through JSON/JavaScript Hosts.
                if state.sequence > 9_007_199_254_740_991 {
                    return Err(RuntimeError::Invalid("event state sequence must be a non-negative safe integer".into()));
                }
            }
            if !input.attributes.is_object() {
                return Err(RuntimeError::Invalid(
                    "event attributes must be an object".into(),
                ));
            }
            sql_number(input.occurred_at_ms)?;
            let candidate = encode(&(
                source.clone(),
                &input.object_id,
                &input.event_id,
                &input.revision,
            ))?;
            let id = self.known_ids.get(&candidate).cloned().unwrap_or(candidate);
            let mut output = input.content.clone().map_media(|media| {
                Ok::<_, RuntimeError>(crate::output::ResolvedMedia {
                    media_type: media.media_type,
                    data_base64: media.data_base64,
                    source: crate::output::OutputSource::Conversation {
                        provenance: Provenance::EnvironmentFact {
                            event_id: id.clone(),
                        },
                    },
                })
            })?;
            // All media provenance comes from the receiving owner, never from plugin text.
            for part in &mut output.parts {
                if matches!(part, crate::output::OutputPart::Attachment { .. }) {
                    return Err(RuntimeError::Invalid(
                        "plugin event attachment references require original material admission"
                            .into(),
                    ));
                }
                if let crate::output::OutputPart::Media { media } = part {
                    media.source = crate::output::OutputSource::Conversation {
                        provenance: Provenance::EnvironmentFact {
                            event_id: id.clone(),
                        },
                    };
                }
            }
            let files = super::event_files::prepare_files(&self.content, &id, &input.files)?;
            for file in &files {
                output.parts.push(crate::output::OutputPart::Attachment {
                    attachment: file.attachment.clone(),
                });
            }
            let content = self.content.save_output_with_dependencies(
                &output,
                files
                    .iter()
                    .map(|file| file.content_ref.content_object.clone())
                    .collect(),
            )?;
            let fingerprint = {
                use sha2::{Digest, Sha256};
                hex::encode(Sha256::digest(encode(&json!({"content":content,"occurred_at_ms":input.occurred_at_ms,"attributes":input.attributes,"echo_of":input.echo_of,"sender_id":input.sender_id}))?.as_bytes()))
            };
            let event = ReceivedEvent {
                event_id: input.event_id.clone(),
                object_id: input.object_id.clone(),
                sender_id: input.sender_id.clone(),
                revision: input.revision.clone(),
                occurred_at_ms: input.occurred_at_ms,
                attributes: input.attributes.clone(),
                echo_of: input.echo_of.clone(),
                fingerprint,
                state: input.state.clone(),
                files,
            };
            events.push((id, event, content));
        }
        Ok(PreparedEventReceive {
            capture: self,
            events,
        })
    }
}
impl Catalog {
    pub fn prepare_event_receive(
        &self,
        input: EventReceiveInput,
    ) -> Result<EventReceivePreparation> {
        validate_identity(&input.identity)?;
        let mut known_ids = std::collections::BTreeMap::new();
        let source = source_key(&input.identity)?;
        for incoming in &input.events {
            let id:Option<String>=self.db.query_row("SELECT id FROM followup_events WHERE source_id=?1 AND json_extract(body,'$.event_id')=?2 AND json_extract(body,'$.object_id') IS ?3 AND json_extract(body,'$.revision') IS ?4",params![source,incoming.event_id,incoming.object_id,incoming.revision],|r|r.get(0)).optional()?;
            if let Some(id) = id {
                known_ids.insert(
                    encode(&(
                        source.clone(),
                        &incoming.object_id,
                        &incoming.event_id,
                        &incoming.revision,
                    ))?,
                    id,
                );
            }
        }
        Ok(EventReceivePreparation {
            input,
            known_ids,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
            epoch: self.epoch,
        })
    }
    pub fn admit_event_receive(
        &mut self,
        prepared: PreparedEventReceive,
    ) -> Result<EventReceiveReceipt> {
        let PreparedEventReceive { capture, events } = prepared;
        let _publication = capture.publication;
        if capture.epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "event receiver owner changed".into(),
            ));
        }
        let input = capture.input;
        let tx = self.db.transaction()?;
        let mut cp = checkpoint(&tx, &input.identity)?;
        let mut fresh = Vec::new();
        let mut duplicates = 0;
        let mut in_batch = std::collections::BTreeMap::new();
        for (id, value, content) in events {
            let known_raw:Option<String>=tx.query_row("SELECT body FROM followup_events WHERE source_id=?1 AND json_extract(body,'$.event_id')=?2 AND json_extract(body,'$.object_id') IS ?3 AND json_extract(body,'$.revision') IS ?4",params![source_key(&input.identity)?,value.event_id,value.object_id,value.revision],|r|r.get(0)).optional()?;
            let known = known_raw
                .map(|raw| serde_json::from_str::<ReceivedEvent>(&raw))
                .transpose()?
                .or_else(|| in_batch.get(&id).cloned());
            if let Some(known) = known {
                if known != value {
                    return Err(RuntimeError::Conflict(
                        "event identity was reused with different content".into(),
                    ));
                }
                duplicates += 1;
            } else {
                in_batch.insert(id.clone(), value.clone());
                fresh.push((id, value, content));
            }
        }
        if cp.cursor != input.expected_cursor {
            if fresh.is_empty() && cp.cursor == input.next_cursor {
                return Ok(EventReceiveReceipt {
                    accepted: 0,
                    duplicates,
                    checkpoint: cp,
                });
            }
            return Err(RuntimeError::Conflict("event source cursor changed".into()));
        }
        // An account synchronization cannot be silently rebound to another user's namespace.
        let active = definitions(&tx)?.iter().any(|d| {
            d.state == FollowupState::Active
                && (d.repeat != FollowupRepeat::Once || d.wait.state == NextRunWaitState::Waiting)
                && identity(&tx, d).ok().flatten().as_ref() == Some(&input.identity)
        });
        if !active && !super::event_transport::has_active_consumer(&tx, &input.identity)? {
            return Err(RuntimeError::Conflict(
                "event source has no active arrangement".into(),
            ));
        }
        cp.cursor = input.next_cursor;
        if input.status.is_some() && cp.status != input.status {
            cp.status = input.status;
            publish_source_change(&tx, &input.identity, "followup.source_status_changed")?;
        }
        save_checkpoint(&tx, &cp)?;
        let accepted = fresh.len();
        let received_at = observations::wall_time_ms()?;
        if accepted > 0 {
            publish_source_change(&tx, &input.identity, "followup.events_received")?;
        }
        for (id, value, content) in fresh {
            let cursor = event(
                &tx,
                &id,
                1,
                "followup.event_received",
                json!({"source":input.identity.source,"occurred_at_ms":value.occurred_at_ms}),
            )?;
            tx.execute("INSERT INTO followup_events(id,source_id,accepted_cursor,received_at_ms,content_ref,body) VALUES(?1,?2,?3,?4,?5,?6)",params![id,source_key(&input.identity)?,sql_number(cursor)?,sql_number(received_at)?,encode(&content)?,encode(&value)?])?;
            super::event_files::publish_files(&tx, &id, &value.files)?;
        }
        for mut d in definitions(&tx)? {
            if d.state == FollowupState::Active
                && identity(&tx, &d)?.as_ref() == Some(&input.identity)
            {
                match_events(&tx, &mut d)?;
            }
        }
        tx.commit()?;
        Ok(EventReceiveReceipt {
            accepted,
            duplicates,
            checkpoint: cp,
        })
    }
}
fn matches_filter(filter: &Value, attributes: &Value) -> bool {
    match (filter, attributes) {
        (Value::Object(expected), Value::Object(actual)) => expected.iter().all(|(key, value)| {
            actual
                .get(key)
                .is_some_and(|actual| matches_filter(value, actual))
        }),
        _ => filter == attributes,
    }
}
#[derive(PartialEq)]
enum EchoDisposition {
    New,
    Pending,
    Confirmed,
}
fn echo_disposition(
    db: &Connection,
    d: &Definition,
    received: &ReceivedEvent,
) -> Result<EchoDisposition> {
    let Some(echo) = &received.echo_of else {
        return Ok(EchoDisposition::New);
    };
    if echo.owner_host_id.is_some() || echo.followup_id != d.id {
        return Ok(EchoDisposition::New);
    }
    let Some(operation_id) = &echo.operation_id else {
        return Ok(EchoDisposition::New);
    };
    let Some(op) = optional_record::<Operation>(db, "operations", operation_id)? else {
        return Ok(EchoDisposition::New);
    };
    let Some(occurrence) =
        optional_record::<Occurrence>(db, "followup_occurrences", &echo.occurrence_id)?
    else {
        return Ok(EchoDisposition::New);
    };
    let owner: Option<String> = db
        .query_row(
            "SELECT followup_id FROM followup_occurrences WHERE id=?1",
            [&echo.occurrence_id],
            |r| r.get(0),
        )
        .optional()?;
    if owner.as_deref() != Some(d.id.as_str()) {
        return Ok(EchoDisposition::New);
    }
    let row = occurrence
        .input_id
        .as_deref()
        .map(|id| record::<QueuedInputMetadata>(db, "input_queue", id))
        .transpose()?;
    if !row.is_some_and(|row| {
        row.state == InputState::Delivered && row.run_id.as_deref() == Some(op.run_id.as_str())
    }) {
        return Ok(EchoDisposition::New);
    }
    let mut same_object = false;
    if let TriggerEvidence::PluginEvents { event_ids, .. } = &occurrence.evidence {
        let source = source_key(&identity(db, d)?.expect("event source"))?;
        for id in event_ids {
            let (source_id, raw): (String, String) = db.query_row(
                "SELECT source_id,body FROM followup_events WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let original: ReceivedEvent = serde_json::from_str(&raw)?;
            if source_id == source
                && original.object_id.is_some()
                && original.object_id == received.object_id
            {
                same_object = true;
            }
        }
    }
    if !same_object {
        return Ok(EchoDisposition::New);
    }
    if op.phase != OperationPhase::Terminal {
        return Ok(EchoDisposition::Pending);
    }
    Ok(
        if op.outcome == Some(Outcome::Succeeded) && op.effect == Effect::Confirmed {
            EchoDisposition::Confirmed
        } else {
            EchoDisposition::New
        },
    )
}
fn match_events(tx: &Transaction<'_>, d: &mut Definition) -> Result<()> {
    if d.state != FollowupState::Active
        || (d.repeat == FollowupRepeat::Once && d.wait.state != NextRunWaitState::Waiting)
    {
        return Ok(());
    }
    let Some(identity) = identity(tx, d)? else {
        return Ok(());
    };
    let FollowupTrigger::PluginEvent { filter, .. } = &d.trigger else {
        unreachable!()
    };
    let rows=tx.prepare("SELECT id,accepted_cursor,body FROM followup_events WHERE source_id=?1 AND accepted_cursor>?2 ORDER BY accepted_cursor")?.query_map(params![source_key(&identity)?,sql_number(d.event_after)?],|r|Ok((r.get::<_,String>(0)?,read_number(r,1)?,r.get::<_,String>(2)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
    for (id, cursor, raw) in rows {
        let received: ReceivedEvent = serde_json::from_str(&raw)?;
        if received.occurred_at_ms < d.discard_before_ms {
            d.event_after = cursor;
            continue;
        }
        let echo = echo_disposition(tx, d, &received)?;
        // A source notification can precede its original operation receipt. Keep the
        // subscriber cut before that fact until the effect has a definite outcome.
        if echo == EchoDisposition::Pending {
            break;
        }
        if received.occurred_at_ms >= d.discard_before_ms
            && echo != EchoDisposition::Confirmed
            && matches_filter(filter, &received.attributes)
        {
            tx.execute(
                "INSERT OR IGNORE INTO followup_event_matches(followup_id,event_id) VALUES(?1,?2)",
                params![d.id, id],
            )?;
        }
        d.event_after = cursor;
    }
    put(tx, "followups", &d.id, d)?;
    Ok(())
}
fn pending(db: &Connection, d: &Definition) -> Result<Vec<(String, u64, u64)>> {
    Ok(db.prepare("SELECT e.id,e.accepted_cursor,e.received_at_ms FROM followup_event_matches m JOIN followup_events e ON e.id=m.event_id WHERE m.followup_id=?1 AND m.occurrence_id IS NULL AND m.discarded=0 ORDER BY e.accepted_cursor")?.query_map([&d.id],|r|Ok((r.get(0)?,read_number(r,1)?,read_number(r,2)?)))?.collect::<std::result::Result<Vec<_>,_>>()?)
}
pub(super) fn observe_events(
    tx: &Transaction<'_>,
    d: &mut Definition,
    now: u64,
    force: bool,
) -> Result<bool> {
    if d.state != FollowupState::Active
        || (d.repeat == FollowupRepeat::Once && d.wait.state != NextRunWaitState::Waiting)
    {
        return Ok(false);
    }
    match_events(tx, d)?;
    if d.first_contact.is_some() {
        if let FollowupOwner::Bot { bot_id } = &d.owner {
            if !bot::permitted(tx, bot_id, bot::current_epoch(tx)?)? {
                return Ok(false);
            }
        }
    }
    let mut rows = pending(tx, d)?;
    let mut calendar = None;
    if !force {
        match &d.timing {
            EventTiming::Batch { window_ms } => {
                if rows
                    .first()
                    .is_none_or(|(_, _, at)| at.saturating_add(*window_ms) > now)
                {
                    return Ok(false);
                }
            }
            EventTiming::Scheduled {
                calendar_id,
                run_empty,
            } => {
                let slot:Option<(u64,String,u64)>=tx.query_row("SELECT e.cursor,o.id,json_extract(o.body,'$.observed_at_ms') FROM events e JOIN calendar_occurrences o ON o.id=e.subject WHERE e.kind='calendar.observed' AND o.definition_id=?1 AND e.cursor>?2 AND json_extract(o.body,'$.cancelled')=0 AND json_extract(o.body,'$.arrangement_owned')=1 ORDER BY e.cursor LIMIT 1",params![calendar_id,sql_number(d.calendar_after)?],|r|Ok((read_number(r,0)?,r.get(1)?,read_number(r,2)?))).optional()?;
                let Some((cursor, id, _at)) = slot else {
                    return Ok(false);
                };
                rows.retain(|(_, accepted, _)| *accepted < cursor);
                d.calendar_after = cursor;
                put(tx, "followups", &d.id, d)?;
                if rows.is_empty() && !*run_empty {
                    settle_calendar_slots(tx)?;
                    return Ok(false);
                }
                calendar = Some(id);
            }
            _ => (),
        }
    }
    if rows.is_empty() && calendar.is_none() {
        return Ok(false);
    }
    // A Calendar slot fixes every eligible target group in the same transaction. Its
    // watermark must not advance after only the first routed conversation.
    let mut groups: Vec<(EventDeliveryTarget, Vec<(String, u64, u64)>)> = Vec::new();
    for row in rows {
        let received = record::<ReceivedEvent>(tx, "followup_events", &row.0)?;
        ensure_first_contact(tx, d, &row.0, &received)?;
        let target = route_target(tx, d, &row.0, &received)?;
        if let Some((_, group)) = groups.iter_mut().find(|(value, _)| *value == target) {
            group.push(row);
        } else {
            groups.push((target, vec![row]));
        }
    }
    if groups.is_empty() {
        groups.push((
            EventDeliveryTarget {
                thread_id: d.thread_id.clone(),
                branch_id: d.branch_id.clone(),
                user_input: false,
                external_conversation_id: d.external_conversation_id.clone(),
            },
            vec![],
        ));
    }
    for (target, rows) in groups {
        let event_ids: Vec<String> = rows.iter().map(|(id, _, _)| id.clone()).collect();
        let cursor = event(
            tx,
            &d.id,
            d.revision,
            "followup.batch_selected",
            json!({"event_ids":event_ids,"calendar_occurrence_id":calendar}),
        )?;
        let v = Occurrence {
            id: format!("{}:{}:{cursor}", d.id, d.generation),
            accepted_cursor: cursor,
            generation: d.generation,
            trigger_cursor: rows.last().map(|(_, cursor, _)| *cursor).unwrap_or(cursor),
            evidence: TriggerEvidence::PluginEvents {
                event_ids: event_ids.clone(),
                received_at_ms: now,
                calendar_occurrence_id: calendar.clone(),
            },
            input_id: None,
            preparation_failed: false,
            target: Some(target.clone()),
            user_input: target.user_input,
            passive: !force && d.timing == EventTiming::Passive,
            cancelled: false,
            external_delivery: None,
        };
        save_batch(tx, d, &v)?;
        d.wait.trigger_cursor = Some(v.trigger_cursor);
    }
    if d.repeat == FollowupRepeat::Once {
        d.wait.state = NextRunWaitState::Observed;
    }
    put(tx, "followups", &d.id, d)?;
    Ok(true)
}
fn save_batch(tx: &Transaction<'_>, d: &Definition, v: &Occurrence) -> Result<()> {
    tx.execute("INSERT INTO followup_occurrences(id,followup_id,accepted_cursor,input_id,body) VALUES(?1,?2,?3,NULL,?4)",params![v.id,d.id,sql_number(v.accepted_cursor)?,encode(v)?])?;
    if let TriggerEvidence::PluginEvents { event_ids, .. } = &v.evidence {
        for id in event_ids {
            tx.execute("UPDATE followup_event_matches SET occurrence_id=?3 WHERE followup_id=?1 AND event_id=?2",params![d.id,id,v.id])?;
        }
    }
    Ok(())
}
/// Withdraw only a batch that has not reached its receiving execution. Both timing
/// edits and target edits use the same original input/turn cancellation boundary.
fn withdraw_unconsumed_batch(tx: &Transaction<'_>, v: &Occurrence) -> Result<bool> {
    if v.cancelled { return Ok(false); }
    if let Some(id) = &v.input_id {
        let mut row: QueuedInputMetadata = record(tx, "input_queue", id)?;
        if row.state != InputState::Queued || matches!(activation::fact(&row)?,
            IngressActivationFact::Cancelled { .. } | IngressActivationFact::Failed { .. }) {
            return Ok(false);
        }
        activation::cancel_row(tx, &mut row)?;
        calendar::unbind_arrangement_input(tx, id)?;
        tx.execute("UPDATE followup_occurrences SET input_id=NULL WHERE id=?1", [&v.id])?;
        tx.execute("DELETE FROM attachment_deliveries WHERE holder_kind='input' AND holder_id=?1", [id])?;
        tx.execute("DELETE FROM input_history_content WHERE input_id=?1", [id])?;
        tx.execute("DELETE FROM input_queue WHERE id=?1", [id])?;
    }
    if let Some(receipt) = &v.external_delivery {
        if !super::external::cancel(tx, receipt)? { return Ok(false); }
    }
    Ok(true)
}

fn reschedule_uncommitted_batches(tx: &Transaction<'_>, d: &mut Definition) -> Result<()> {
    let rows = tx.prepare("SELECT body FROM followup_occurrences WHERE followup_id=?1 ORDER BY accepted_cursor")?
        .query_map([&d.id], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut rescheduled = false;
    for raw in rows {
        let mut v: Occurrence = serde_json::from_str(&raw)?;
        if !withdraw_unconsumed_batch(tx, &v)? { continue; }
        v.cancelled = true;
        v.input_id = None;
        put(tx, "followup_occurrences", &v.id, &v)?;
        // Preserve the original receipt while returning its events to the pending
        // set. The new timing selects a fresh fixed batch from their original times.
        tx.execute("UPDATE followup_event_matches SET occurrence_id=NULL WHERE followup_id=?1 AND occurrence_id=?2 AND discarded=0",
            params![d.id, v.id])?;
        rescheduled = true;
    }
    if rescheduled && d.wait.state == NextRunWaitState::Observed {
        d.wait.state = NextRunWaitState::Waiting;
        d.wait.trigger_cursor = None;
    }
    Ok(())
}

/// Edits may revise unconsumed input, but never rewrite a delivered
/// instruction. Reprepare through the original ContentStore owner so revoked sender
/// trust is removed from both the queue origin and its immutable conversation content.
fn refresh_uncommitted_batches(tx: &Transaction<'_>, d: &Definition) -> Result<()> {
    let rows = tx
        .prepare(
            "SELECT body FROM followup_occurrences WHERE followup_id=?1 ORDER BY accepted_cursor",
        )?
        .query_map([&d.id], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for raw in rows {
        let mut v: Occurrence = serde_json::from_str(&raw)?;
        if !withdraw_unconsumed_batch(tx, &v)? { continue; }
        let mut replace = false;
        if v.external_delivery.is_some() {
            let mut old = v.clone();
            old.cancelled = true;
            put(tx, "followup_occurrences", &old.id, &old)?;
            v.external_delivery = None;
            replace = true;
        }
        v.input_id = None;
        let TriggerEvidence::PluginEvents {
            event_ids,
            received_at_ms,
            calendar_occurrence_id,
        } = &v.evidence
        else {
            continue;
        };
        let mut groups: Vec<(EventDeliveryTarget, Vec<String>)> = Vec::new();
        for id in event_ids {
            let target = route_target(
                tx,
                d,
                id,
                &record::<ReceivedEvent>(tx, "followup_events", id)?,
            )?;
            if let Some((_, ids)) = groups.iter_mut().find(|(value, _)| *value == target) {
                ids.push(id.clone());
            } else {
                groups.push((target, vec![id.clone()]));
            }
        }
        if groups.is_empty() {
            groups.push((
                EventDeliveryTarget {
                    thread_id: d.thread_id.clone(),
                    branch_id: d.branch_id.clone(),
                    user_input: false,
                    external_conversation_id: d.external_conversation_id.clone(),
                },
                vec![],
            ));
        }
        let received_at_ms = *received_at_ms;
        let calendar_occurrence_id = calendar_occurrence_id.clone();
        for (index, (target, event_ids)) in groups.into_iter().enumerate() {
            let mut revised = v.clone();
            revised.target = Some(target.clone());
            revised.user_input = target.user_input;
            revised.preparation_failed = false;
            revised.evidence = TriggerEvidence::PluginEvents {
                event_ids: event_ids.clone(),
                received_at_ms,
                calendar_occurrence_id: calendar_occurrence_id.clone(),
            };
            if index == 0 && !replace {
                put(tx, "followup_occurrences", &revised.id, &revised)?;
            } else {
                let cursor = event(
                    tx,
                    &d.id,
                    d.revision,
                    "followup.batch_rerouted",
                    json!({"original_occurrence_id":v.id,"event_ids":event_ids}),
                )?;
                revised.id = format!("{}:{}:{cursor}", d.id, d.generation);
                revised.accepted_cursor = cursor;
                save_batch(tx, d, &revised)?;
            }
        }
    }
    Ok(())
}
pub(super) fn occurrence_refs(db: &Connection, v: &Occurrence) -> Result<Vec<(Value, Value)>> {
    let TriggerEvidence::PluginEvents { event_ids, .. } = &v.evidence else {
        return Ok(vec![]);
    };
    event_ids.iter().map(|id| {
        let (source,raw,content,received):(String,String,Option<String>,u64)=db.query_row("SELECT s.body,e.body,e.content_ref,e.received_at_ms FROM followup_events e JOIN followup_event_sources s ON s.id=e.source_id WHERE e.id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,read_number(r,3)?)))?;
        let cp:EventSourceCheckpoint=serde_json::from_str(&source)?;let event:ReceivedEvent=serde_json::from_str(&raw)?;
        let reference=serde_json::from_str(&content.ok_or_else(||RuntimeError::Invalid("pending event content was released".into()))?)?;
        let mut metadata = json!({"id":id,"source":cp.identity.source,"eventId":event.event_id,"objectId":event.object_id,"senderId":event.sender_id,"revision":event.revision,"occurredAtMs":event.occurred_at_ms,"receivedAtMs":received,"attributes":event.attributes});
        if let Some(state) = event.state { metadata["state"] = serde_json::to_value(state)?; }
        Ok((metadata,reference))
    }).collect()
}
pub(super) fn projection(
    db: &Connection,
    d: &Definition,
) -> Result<(u64, Option<u64>, Option<EventSourceStatus>)> {
    let Some(identity) = identity(db, d)? else {
        return Ok((0, None, None));
    };
    let rows = pending(db, d)?;
    let next = rows.first().and_then(|(_, _, received)| match d.timing {
        EventTiming::Immediate | EventTiming::Passive => Some(*received),
        EventTiming::Batch { window_ms } => Some(received.saturating_add(window_ms)),
        _ => None,
    });
    Ok((rows.len() as u64, next, checkpoint(db, &identity)?.status))
}
pub(super) fn nearest_deadline(db: &Connection) -> Result<Option<u64>> {
    let mut nearest = None;
    for d in definitions(db)? {
        if d.state == FollowupState::Active && matches!(d.timing, EventTiming::Batch { .. }) {
            if let Some(at) = projection(db, &d)?.1 {
                nearest = Some(nearest.map_or(at, |old: u64| old.min(at)));
            }
        }
    }
    Ok(nearest)
}
impl Catalog {
    pub fn control_event_backlog(&mut self, input: EventBacklogInput) -> Result<Followup> {
        let tx = self.db.transaction()?;
        let result = backlog_tx(&tx, input)?;
        tx.commit()?;
        Ok(result)
    }
}

/// Compact identities survive collection. Payloads survive only while a subscriber or input
/// still needs them; delivered history already holds its own immutable dependency references.
pub(crate) fn collect_payloads(db: &Connection) -> Result<()> {
    db.execute("UPDATE followup_events SET content_ref=NULL WHERE content_ref IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM followup_event_matches m JOIN followups f ON f.id=m.followup_id LEFT JOIN followup_occurrences o ON o.id=m.occurrence_id LEFT JOIN input_queue q ON q.id=o.input_id
            WHERE m.event_id=followup_events.id AND m.discarded=0 AND json_extract(f.body,'$.state')!='cancelled'
            AND (m.occurrence_id IS NULL OR (o.input_id IS NULL AND (json_extract(o.body,'$.external_delivery') IS NULL OR EXISTS(SELECT 1 FROM external_turns x WHERE x.id=json_extract(o.body,'$.external_delivery.turn_id') AND json_extract(x.body,'$.status') IN ('queued','awaiting_input','preparing') AND (json_extract(x.body,'$.consumedByTurnId') IS NULL OR EXISTS(SELECT 1 FROM external_turns consumer WHERE consumer.id=json_extract(x.body,'$.consumedByTurnId') AND json_extract(consumer.body,'$.status') IN ('queued','preparing')))))) OR (q.state='queued' AND json_extract(q.body,'$.origin.activation.state') NOT IN ('cancelled','failed'))))
        AND NOT EXISTS(SELECT 1 FROM followups f
            JOIN followup_event_sources s ON s.id=followup_events.source_id
            WHERE json_extract(f.body,'$.trigger.kind')='plugin_event' AND json_extract(f.body,'$.state')!='cancelled'
            AND (json_extract(f.body,'$.repeat')='each' OR json_extract(f.body,'$.wait.state')='waiting')
            AND json_extract(f.body,'$.event_after')<followup_events.accepted_cursor
            AND json_extract(f.body,'$.trigger.source')=json_extract(s.body,'$.identity.source')
            AND json_extract(f.body,'$.principal_id') IS json_extract(s.body,'$.identity.principalId'))
        AND NOT EXISTS(SELECT 1 FROM followup_event_consumers c WHERE c.source_id=followup_events.source_id AND c.state!='released' AND c.after_cursor<followup_events.accepted_cursor)",[])?;
    Ok(())
}
impl Catalog {
    pub fn bot_arrangements(&self, bot_id: &str, principal: Option<&str>) -> Result<Vec<Followup>> {
        let mut q=self.db.prepare("SELECT body FROM followups WHERE json_extract(body,'$.principal_id') IS ?1 ORDER BY rowid")?;
        let values = q.query_map([principal], |r| r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let mut result = Vec::new();
        for raw in values {
            let d: Definition = serde_json::from_str(&raw)?;
            let owned = d.owner == (FollowupOwner::Bot { bot_id: bot_id.to_owned() })
                || super::bot::thread_owner(&self.db,&d.thread_id)?.is_some_and(|owner|owner.bot_id == bot_id)
                || super::bot_work::followers(&self.db,&d.thread_id,&d.branch_id)?.contains(&bot_id.to_owned());
            if owned { result.push(project(&self.db,d)?); }
        }
        Ok(result)
    }
}

fn put_arrangement_tx(
    tx: &Transaction<'_>,
    input: ArrangementInput,
    instruction: Value,
    actor: FollowupActor,
) -> Result<Followup> {
    validate_target(tx, &input)?;
    let old = optional_record::<Definition>(tx, "followups", &input.key)?;
    let now = observations::wall_time_ms()?;
    let last: u64 = tx.query_row("SELECT coalesce(max(cursor),0) FROM events", [], |r| {
        read_number(r, 0)
    })?;
    let mut d = if let Some(old) = old {
        if old.owner
            != (FollowupOwner::Bot {
                bot_id: input.bot_id.clone(),
            })
            || old.principal_id != principals::thread(tx, &input.thread_id)?
        {
            return Err(RuntimeError::Conflict(
                "arrangement owner cannot change".into(),
            ));
        }
        if old.state == FollowupState::Cancelled {
            return Err(RuntimeError::Conflict("arrangement was cancelled".into()));
        }
        let same = old.first_contact == input.first_contact
            && old.external_conversation_id == input.external_conversation_id
            && old.thread_id == input.thread_id
            && old.branch_id == input.branch_id
            && old.name.as_deref() == Some(&input.name)
            && old.instruction_ref.as_ref() == Some(&instruction)
            && old.trigger
                == (FollowupTrigger::PluginEvent {
                    source: input.source.clone(),
                    filter: input.filter.clone(),
                })
            && old.timing == input.timing
            && old.repeat == input.repeat;
        if same {
            return project(tx, old);
        }
        if input.expected_revision != Some(old.revision) {
            return Err(RuntimeError::Conflict(
                "arrangement revision changed".into(),
            ));
        }
        old
    } else {
        if input.expected_revision.is_some() {
            return Err(RuntimeError::NotFound(input.key));
        }
        Definition {
            id: input.key.clone(),
            repeat: input.repeat,
            revision: 0,
            generation: 1,
            thread_id: input.thread_id.clone(),
            branch_id: input.branch_id.clone(),
            source_run_id: input.source_run_id.clone(),
            principal_id: principals::thread(tx, &input.thread_id)?,
            first_contact: input.first_contact.clone(),
            external_conversation_id: input.external_conversation_id.clone(),
            owner: FollowupOwner::Bot {
                bot_id: input.bot_id.clone(),
            },
            name: None,
            timing: input.timing.clone(),
            event_after: last,
            discard_before_ms: 0,
            calendar_after: last,
            goal_id: None,
            actor: actor.clone(),
            instruction_ref: None,
            registered_at_ms: now,
            observation_operation_id: None,
            trigger: FollowupTrigger::PluginEvent {
                source: input.source.clone(),
                filter: input.filter.clone(),
            },
            sources: vec![],
            state: FollowupState::Active,
            wait: NextRunWait {
                id: format!("followup-trigger:{}", input.key),
                kind: "plugin_event".into(),
                after_cursor: last,
                trigger_cursor: None,
                state: NextRunWaitState::Waiting,
            },
            source: None,
            scope: None,
        }
    };
    if d.revision > 0
        && d.trigger
            != (FollowupTrigger::PluginEvent {
                source: input.source.clone(),
                filter: input.filter.clone(),
            })
    {
        d.event_after = last;
        if matches!(&d.trigger,FollowupTrigger::PluginEvent {source,..} if source!=&input.source) {
            tx.execute(
                "DELETE FROM followup_event_routes WHERE followup_id=?1",
                [&d.id],
            )?;
        }
    }
    let timing_changed = d.timing != input.timing;
    d.revision += 1;
    d.name = Some(input.name);
    d.instruction_ref = Some(instruction);
    d.timing = input.timing;
    d.repeat = input.repeat;
    d.first_contact = input.first_contact;
    d.external_conversation_id = input.external_conversation_id;
    d.thread_id = input.thread_id;
    d.branch_id = input.branch_id;
    d.trigger = FollowupTrigger::PluginEvent {
        source: input.source,
        filter: input.filter,
    };
    if d.revision == 1 {
        insert(tx, &d)?;
    } else {
        if timing_changed { reschedule_uncommitted_batches(tx, &mut d)?; }
        put(tx, "followups", &d.id, &d)?;
        tx.execute(
            "UPDATE followups SET thread_id=?2 WHERE id=?1",
            params![d.id, d.thread_id],
        )?;
        refresh_uncommitted_batches(tx, &d)?;
        settle_calendar_slots(tx)?;
        event(
            tx,
            &d.id,
            d.revision,
            "followup.changed",
            json!({"thread_id":d.thread_id,"branch_id":d.branch_id}),
        )?;
    }
    let source_identity = identity(tx, &d)?.expect("plugin event");
    save_checkpoint(tx, &checkpoint(tx, &source_identity)?)?;
    super::event_transport::retain_import(tx, &source_identity)?;
    project(tx, d)
}

fn backlog_tx(tx: &Transaction<'_>, input: EventBacklogInput) -> Result<Followup> {
    let mut d: Definition = record(tx, "followups", &input.followup_id)?;
    if !matches!(d.trigger, FollowupTrigger::PluginEvent { .. }) {
        return Err(RuntimeError::Invalid(
            "backlog control requires an event arrangement".into(),
        ));
    }
    if d.revision != input.expected_revision {
        return Err(RuntimeError::Conflict(
            "arrangement revision changed".into(),
        ));
    }
    if d.state == FollowupState::Cancelled {
        return Err(RuntimeError::Conflict("arrangement was cancelled".into()));
    }
    match input.action {
        EventBacklogAction::ProcessNow => {
            if d.state == FollowupState::Paused {
                return Err(RuntimeError::Conflict(
                    "resume the arrangement before processing".into(),
                ));
            }
            // Held batches have already left `pending`, even when no input can
            // yet be admitted (for example while the Bot sleeps). Retain this
            // explicit request on the original batch until admission is possible.
            let held = tx.prepare("SELECT body FROM followup_occurrences WHERE followup_id=?1 AND input_id IS NULL AND json_extract(body,'$.external_delivery') IS NULL AND json_extract(body,'$.cancelled')=0")?
                .query_map([&d.id], |r| r.get::<_, String>(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
            for raw in held {
                let mut v: Occurrence = serde_json::from_str(&raw)?;
                v.passive = false;
                v.preparation_failed = false;
                put(tx, "followup_occurrences", &v.id, &v)?;
            }
            let queued=tx.prepare("SELECT body FROM input_queue WHERE origin='followup' AND state='queued' AND activation='passive' AND json_extract(body,'$.origin.activation.state')='passive' AND json_extract(body,'$.origin.followup_id')=?1")?.query_map([&d.id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
            for raw in queued {
                let mut row: QueuedInputMetadata = serde_json::from_str(&raw)?;
                if let InputOrigin::Followup { occurrence_id, .. } = &row.origin {
                    let mut v = occurrence(tx, &d.id, occurrence_id)?;
                    v.passive = false;
                    put(tx, "followup_occurrences", &v.id, &v)?;
                }
                let fact = activation::accept_target(tx, &row.thread_id, &row.branch_id)?;
                row.run_id = fact.run_id().map(str::to_owned);
                activation::write_changed(tx, &mut row, fact)?;
                row.activation = inputs::InputActivation::Activating;
                inputs::write_input(tx, &row)?;
                tx.execute(
                    "UPDATE input_queue SET activation='activating' WHERE id=?1",
                    [&row.id],
                )?;
            }
            let rows=tx.prepare("SELECT body FROM followup_occurrences WHERE followup_id=?1 AND json_extract(body,'$.external_delivery') IS NOT NULL AND json_extract(body,'$.cancelled')=0")?.query_map([&d.id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
            for raw in rows {
                let v: Occurrence = serde_json::from_str(&raw)?;
                if let Some(receipt) = v.external_delivery {
                    super::external::retry(tx, &receipt)?;
                }
            }
            observe_events(tx, &mut d, observations::wall_time_ms()?, true)?;
        }
        EventBacklogAction::Discard => {
            d.discard_before_ms = observations::wall_time_ms()?;
            // Explicit "from now" also advances a paused subscriber's local matching cut.
            if let Some(identity) = identity(tx, &d)? {
                d.event_after=tx.query_row("SELECT coalesce(max(accepted_cursor),0) FROM followup_events WHERE source_id=?1",[source_key(&identity)?],|r|read_number(r,0))?;
            }
            let unfinished=tx.prepare("SELECT o.body FROM followup_occurrences o LEFT JOIN input_queue q ON q.id=o.input_id WHERE o.followup_id=?1 AND (o.input_id IS NULL OR q.state='queued')")?.query_map([&d.id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
            for raw in unfinished {
                let mut occurrence: Occurrence = serde_json::from_str(&raw)?;
                if let Some(receipt) = &occurrence.external_delivery {
                    if !super::external::cancel(tx, receipt)? {
                        continue;
                    }
                }
                occurrence.cancelled = true;
                put(tx, "followup_occurrences", &occurrence.id, &occurrence)?;
                if let Some(input) = &occurrence.input_id {
                    let mut row = record(tx, "input_queue", input)?;
                    activation::cancel_row(tx, &mut row)?;
                }
            }
            tx.execute("UPDATE followup_event_matches SET discarded=1 WHERE followup_id=?1 AND (occurrence_id IS NULL OR occurrence_id IN (SELECT id FROM followup_occurrences WHERE json_extract(body,'$.cancelled')=1))",[&d.id])?;
        }
    }
    d.revision += 1;
    put(tx, "followups", &d.id, &d)?;
    settle_calendar_slots(tx)?;
    event(
        tx,
        &d.id,
        d.revision,
        "followup.backlog_changed",
        json!({"action":input.action}),
    )?;
    project(tx, d)
}

pub(super) fn tool_owns(
    db: &Connection,
    d: &Definition,
    thread: &str,
    branch: &str,
) -> Result<bool> {
    if d.thread_id == thread && d.branch_id == branch {
        return Ok(principals::thread(db, thread)? == d.principal_id);
    }
    match &d.owner {
        FollowupOwner::Bot { bot_id } => Ok(bot::thread_bot(db, thread)?.as_ref() == Some(bot_id)
            && principals::thread(db, thread)? == d.principal_id),
        FollowupOwner::Work => Ok(false),
    }
}
pub struct EventToolPreparation {
    invocation: super::super::tool_content::ToolInvocationRead,
    call: crate::execution::ToolCall,
    schema: crate::execution::ToolSchema,
    operation: Operation,
    input: Option<ArrangementInput>,
    backlog: Option<EventBacklogInput>,
    route: Option<EventSourceRouteInput>,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
    epoch: u64,
}
pub struct PreparedEventTool {
    invocation: super::super::tool_content::ToolInvocationSnapshot,
    operation: Operation,
    input: Option<ArrangementInput>,
    backlog: Option<EventBacklogInput>,
    route: Option<EventSourceRouteInput>,
    instruction: Option<Value>,
    completion: crate::execution::ToolCompletion,
    metadata: result_content::ToolCompletionMetadata,
    publication: crate::content::ContentPublication,
    epoch: u64,
}
impl EventToolPreparation {
    pub fn load(self) -> Result<PreparedEventTool> {
        let invocation = registration::validate_invocation(
            self.invocation,
            self.call,
            self.schema,
            &self.operation,
            &self.content,
        )?;
        let instruction = self
            .input
            .as_ref()
            .map(|input| self.content.save(&json!(input.instruction)))
            .transpose()?;
        let id = self
            .input
            .as_ref()
            .map(|input| input.key.as_str())
            .or_else(|| {
                self.backlog
                    .as_ref()
                    .map(|input| input.followup_id.as_str())
            })
            .or_else(|| self.route.as_ref().map(|input| input.followup_id.as_str()))
            .expect("mutation");
        let completion = crate::execution::ToolCompletion::Result {
            outcome: Outcome::Succeeded,
            effect: Effect::Confirmed,
            content: json!({"accepted":true,"followupId":id}).into(),
        };
        let metadata = result_content::ToolCompletionMetadata::write(&self.content, &completion)?;
        Ok(PreparedEventTool {
            invocation,
            operation: self.operation,
            input: self.input,
            backlog: self.backlog,
            route: self.route,
            instruction,
            completion,
            metadata,
            publication: self.publication,
            epoch: self.epoch,
        })
    }
}
impl Catalog {
    pub fn prepare_event_tool(
        &self,
        c: &crate::execution::ToolExecutionContext,
        call: crate::execution::ToolCall,
        schema: crate::execution::ToolSchema,
    ) -> Result<EventToolPreparation> {
        let run = self.run(&c.run_id)?;
        let mut value: FollowupToolInput = serde_json::from_value(call.arguments.clone())?;
        self.resolve_followup_tool_input(&mut value)?;
        let mut route = None;
        let (input, backlog) = match value {
            FollowupToolInput::Arrange {
                followup_id,
                expected_revision,
                name,
                instruction,
                source,
                filter,
                timing,
                repeat,
                thread_id,
                branch_id,
                external_conversation_id,
                first_contact,
            } => {
                let key =
                    followup_id.unwrap_or_else(|| format!("followup:tool:{}", c.operation_id));
                let (bot_id, default_thread, default_branch, default_external) = if let Some(old) =
                    optional_record::<Definition>(&self.db, "followups", &key)?
                {
                    if !tool_owns(&self.db, &old, &run.thread_id, &run.branch_id)? {
                        return Err(RuntimeError::Conflict(
                            "arrangement belongs to another owner".into(),
                        ));
                    }
                    let FollowupOwner::Bot { bot_id } = old.owner else {
                        return Err(RuntimeError::Conflict(
                            "existing follow-up is not a Bot arrangement".into(),
                        ));
                    };
                    (
                        bot_id,
                        old.thread_id,
                        old.branch_id,
                        old.external_conversation_id,
                    )
                } else {
                    let bot_id = bot::thread_bot(&self.db, &run.thread_id)?.ok_or_else(|| {
                        RuntimeError::Conflict("long-term arrangement requires a Bot owner".into())
                    })?;
                    (bot_id, run.thread_id.clone(), run.branch_id.clone(), None)
                };
                let input = ArrangementInput {
                    key,
                    expected_revision,
                    bot_id,
                    thread_id: thread_id.unwrap_or(default_thread),
                    branch_id: branch_id.unwrap_or(default_branch),
                    name,
                    instruction,
                    source,
                    filter,
                    timing,
                    repeat,
                    first_contact,
                    source_run_id: Some(run.id),
                    external_conversation_id: if call
                        .arguments
                        .get("externalConversationId")
                        .is_some()
                    {
                        external_conversation_id
                    } else {
                        default_external
                    },
                };
                validate_target(&self.db, &input)?;
                (Some(input), None)
            }
            FollowupToolInput::Route {
                followup_id,
                expected_revision,
                object_id,
                thread_id,
                branch_id,
                external_conversation_id,
            } => {
                let d: Definition = record(&self.db, "followups", &followup_id)?;
                if !tool_owns(&self.db, &d, &run.thread_id, &run.branch_id)? {
                    return Err(RuntimeError::Conflict(
                        "arrangement belongs to another owner".into(),
                    ));
                }
                route = Some(EventSourceRouteInput {
                    followup_id,
                    expected_revision,
                    object_id,
                    thread_id,
                    branch_id,
                    sender_id: None,
                    user_input: false,
                    external_conversation_id,
                });
                (None, None)
            }
            FollowupToolInput::Backlog {
                followup_id,
                expected_revision,
                control,
            } => {
                let d: Definition = record(&self.db, "followups", &followup_id)?;
                if !tool_owns(&self.db, &d, &run.thread_id, &run.branch_id)? {
                    return Err(RuntimeError::Conflict(
                        "arrangement belongs to another owner".into(),
                    ));
                }
                (
                    None,
                    Some(EventBacklogInput {
                        followup_id,
                        expected_revision,
                        action: control,
                    }),
                )
            }
            _ => {
                return Err(RuntimeError::Invalid(
                    "event tool requires arrange or backlog".into(),
                ));
            }
        };
        Ok(EventToolPreparation {
            invocation: self.capture_tool_invocation(c, &call.call_id)?,
            call,
            schema,
            operation: self.operation(&c.operation_id)?,
            input,
            backlog,
            route,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
            epoch: self.epoch,
        })
    }
    pub fn authorize_event_tool(&self, p: &PreparedEventTool) -> Result<()> {
        if p.epoch != self.epoch {
            return Err(RuntimeError::Conflict("arrangement owner changed".into()));
        }
        self.validate_tool_invocation(&p.invocation, true)
    }
    pub fn admit_event_tool(
        &mut self,
        p: PreparedEventTool,
    ) -> Result<crate::execution::ToolCompletion> {
        self.authorize_event_tool(&p)?;
        let _publication = p.publication;
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", &p.operation.id)?;
        if op.call_completion.as_ref() == Some(&p.metadata) {
            return Ok(p.completion);
        }
        registration::require_invocation(&tx, self.epoch, &p.operation, &p.invocation, false)?;
        if let Some(input) = p.input {
            put_arrangement_tx(
                &tx,
                input,
                p.instruction.expect("arrangement instruction"),
                FollowupActor::Agent {
                    run_id: p.invocation.context.run_id.clone(),
                    operation_id: p.operation.id.clone(),
                    origin: p.invocation.context.origin.clone(),
                },
            )?;
        }
        if let Some(backlog) = p.backlog {
            backlog_tx(&tx, backlog)?;
        }
        if let Some(route) = p.route {
            source_route_tx(&tx, route)?;
        }
        registration::finish_tool(&tx, &mut op, &p.metadata, false)?;
        tx.commit()?;
        Ok(p.completion)
    }
}

pub(super) fn ingress_target_hold(
    db: &Connection,
    d: &Definition,
    row: &QueuedInputMetadata,
) -> Result<Option<HoldReason>> {
    let mut actual = d.clone();
    actual.thread_id = row.thread_id.clone();
    actual.branch_id = row.branch_id.clone();
    // This is the native input queue. An explicit native object route must not
    // inherit the definition's different external default at consumption time.
    actual.external_conversation_id = None;
    target_hold(db, &actual)
}

pub(crate) fn calendar_owned(db: &Connection, id: &str) -> Result<bool> {
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM followups WHERE json_extract(body,'$.trigger.kind')='plugin_event' AND json_extract(body,'$.timing.kind')='scheduled' AND json_extract(body,'$.timing.calendarId')=?1 AND json_extract(body,'$.state')!='cancelled' AND (json_extract(body,'$.repeat')='each' OR json_extract(body,'$.wait.state')='waiting'))",[id],|r|r.get(0))?)
}
/// A slot ends only when every fixed target batch ends. With no batch, an active
/// owner that has not evaluated this slot still keeps it open (including pause).
pub(in crate::catalog) fn calendar_batches_ended(db: &Connection, id: &str) -> Result<bool> {
    let rows=db.prepare("SELECT o.body,f.body FROM followup_occurrences o JOIN followups f ON f.id=o.followup_id WHERE json_extract(o.body,'$.evidence.calendar_occurrence_id')=?1")?.query_map([id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
    for (raw, definition) in rows {
        let o: Occurrence = serde_json::from_str(&raw)?;
        let d: Definition = serde_json::from_str(&definition)?;
        if o.cancelled {
            continue;
        }
        if let Some(receipt) = &o.external_delivery {
            let view = super::external::project(db, receipt)?;
            if !matches!(
                view.state.as_str(),
                "completed" | "failed" | "cancelled" | "interrupted"
            ) {
                return Ok(false);
            }
            continue;
        }
        let Some(input) = o.input_id else {
            if d.state == FollowupState::Cancelled {
                continue;
            }
            return Ok(false);
        };
        let row: QueuedInputMetadata = record(db, "input_queue", &input)?;
        if row.state == InputState::Cancelled
            || matches!(
                activation::fact(&row)?,
                IngressActivationFact::Cancelled { .. } | IngressActivationFact::Failed { .. }
            )
        {
            continue;
        }
        if row.state != InputState::Delivered {
            return Ok(false);
        }
        if let Some(run) = &row.run_id {
            if !record::<Run>(db, "runs", run)?.state.terminal() {
                return Ok(false);
            }
        }
    }
    let outstanding:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM followups f JOIN calendar_occurrences o ON json_extract(f.body,'$.timing.calendarId')=o.definition_id JOIN events e ON e.subject=o.id AND e.kind='calendar.observed' WHERE o.id=?1 AND json_extract(f.body,'$.state')!='cancelled' AND json_extract(f.body,'$.timing.kind')='scheduled' AND (json_extract(f.body,'$.repeat')='each' OR json_extract(f.body,'$.wait.state')='waiting') AND json_extract(f.body,'$.calendar_after')<e.cursor)",[id],|r|r.get(0))?;
    Ok(!outstanding)
}
pub(super) fn settle_calendar_slots(tx: &Transaction<'_>) -> Result<()> {
    let ids=tx.prepare("SELECT id FROM calendar_occurrences WHERE json_extract(body,'$.arrangement_owned')=1 AND input_id IS NULL AND json_extract(body,'$.cancelled')=0 AND NOT EXISTS(SELECT 1 FROM followup_occurrences f WHERE json_extract(f.body,'$.evidence.calendar_occurrence_id')=calendar_occurrences.id AND json_extract(f.body,'$.external_delivery') IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM events WHERE subject=calendar_occurrences.id AND kind='calendar.event_empty')")?.query_map([],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    for id in ids {
        if calendar_batches_ended(tx, &id)? {
            event(tx, &id, 1, "calendar.event_empty", Value::Null)?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventDeliveryTarget {
    pub thread_id: String,
    pub branch_id: String,
    pub user_input: bool,
    #[serde(default)]
    pub external_conversation_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventSourceRouteInput {
    pub followup_id: String,
    pub expected_revision: u64,
    pub object_id: String,
    pub thread_id: String,
    pub branch_id: String,
    pub sender_id: Option<String>,
    pub user_input: bool,
    pub external_conversation_id: Option<String>,
}
fn route_target(
    db: &Connection,
    d: &Definition,
    event_id: &str,
    event: &ReceivedEvent,
) -> Result<EventDeliveryTarget> {
    let same_source: bool = db.query_row(
        "SELECT source_id=?2 FROM followup_events WHERE id=?1",
        params![
            event_id,
            source_key(&identity(db, d)?.expect("event source"))?
        ],
        |r| r.get(0),
    )?;
    let route = event
        .object_id
        .as_ref()
        .filter(|_| same_source)
        .map(|object| {
            optional_record::<EventSourceRouteInput>(
                db,
                "followup_event_routes",
                &encode(&(&d.id, object))?,
            )
        })
        .transpose()?
        .flatten();
    Ok(if let Some(route) = route {
        EventDeliveryTarget {
            thread_id: route.thread_id,
            branch_id: route.branch_id,
            external_conversation_id: route.external_conversation_id,
            user_input: route.user_input
                && route.sender_id.is_some()
                && route.sender_id == event.sender_id,
        }
    } else {
        EventDeliveryTarget {
            thread_id: d.thread_id.clone(),
            branch_id: d.branch_id.clone(),
            user_input: false,
            external_conversation_id: d.external_conversation_id.clone(),
        }
    })
}
impl Catalog {
    pub fn put_event_source_route(&mut self, input: EventSourceRouteInput) -> Result<Followup> {
        let tx = self.db.transaction()?;
        let result = source_route_tx(&tx, input)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn event_source_routes(&self, followup: &str) -> Result<Vec<EventSourceRouteInput>> {
        let mut q = self.db.prepare(
            "SELECT body FROM followup_event_routes WHERE followup_id=?1 ORDER BY rowid",
        )?;
        let rows = q
            .query_map([followup], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str(&r?)?))
            .collect();
        rows
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventSourceRouteRemove {
    pub followup_id: String,
    pub expected_revision: u64,
    pub object_id: String,
}
impl Catalog {
    pub fn remove_event_source_route(&mut self, input: EventSourceRouteRemove) -> Result<Followup> {
        let tx = self.db.transaction()?;
        let mut d: Definition = record(&tx, "followups", &input.followup_id)?;
        if d.revision != input.expected_revision {
            let replay:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE subject=?1 AND revision=?2 AND kind='followup.source_route_removed' AND json_extract(data,'$.object_id')=?3)",params![d.id,sql_number(input.expected_revision.saturating_add(1))?,input.object_id],|r|r.get(0))?;
            if replay {
                return project(&tx, d);
            }
            return Err(RuntimeError::Conflict(
                "arrangement revision changed".into(),
            ));
        }
        tx.execute(
            "DELETE FROM followup_event_routes WHERE followup_id=?1 AND object_id=?2",
            params![d.id, input.object_id],
        )?;
        d.revision += 1;
        put(&tx, "followups", &d.id, &d)?;
        refresh_uncommitted_batches(&tx, &d)?;
        event(
            &tx,
            &d.id,
            d.revision,
            "followup.source_route_removed",
            json!({"object_id":input.object_id,"source_key":identity(&tx,&d)?.map(|value|source_key(&value)).transpose()?}),
        )?;
        let result = project(&tx, d)?;
        tx.commit()?;
        Ok(result)
    }
}

fn source_route_tx(tx: &Transaction<'_>, input: EventSourceRouteInput) -> Result<Followup> {
    let mut d: Definition = record(tx, "followups", &input.followup_id)?;
    let existing = optional_record::<EventSourceRouteInput>(
        tx,
        "followup_event_routes",
        &encode(&(&d.id, &input.object_id))?,
    )?;
    if existing.as_ref() == Some(&input) {
        return project(tx, d);
    }
    if d.revision != input.expected_revision || d.state == FollowupState::Cancelled {
        return Err(RuntimeError::Conflict(
            "arrangement revision changed or cancelled".into(),
        ));
    }
    valid_text(&input.object_id)?;
    if input.user_input {
        valid_text(input.sender_id.as_deref().unwrap_or(""))?;
        if d.principal_id.is_none() {
            return Err(RuntimeError::Conflict(
                "trusted external user routing requires an authenticated principal".into(),
            ));
        }
    }
    if d.principal_id != principals::thread(tx, &input.thread_id)? {
        return Err(RuntimeError::Conflict(
            "source route principal differs".into(),
        ));
    }
    let FollowupOwner::Bot { bot_id } = &d.owner else {
        return Err(RuntimeError::Invalid(
            "source routing requires a Bot arrangement".into(),
        ));
    };
    let FollowupTrigger::PluginEvent { source, filter } = &d.trigger else {
        return Err(RuntimeError::Invalid(
            "source routing requires a plugin event".into(),
        ));
    };
    let check = ArrangementInput {
        key: d.id.clone(),
        expected_revision: Some(d.revision),
        bot_id: bot_id.clone(),
        thread_id: input.thread_id.clone(),
        branch_id: input.branch_id.clone(),
        name: d.name.clone().unwrap_or(d.id.clone()),
        instruction: "route validation".into(),
        source: source.clone(),
        filter: filter.clone(),
        timing: EventTiming::Immediate,
        repeat: d.repeat,
        source_run_id: None,
        external_conversation_id: input.external_conversation_id.clone(),
        first_contact: None,
    };
    validate_target(tx, &check)?;
    tx.execute("INSERT INTO followup_event_routes(id,followup_id,object_id,body) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET body=excluded.body",params![encode(&(&d.id,&input.object_id))?,d.id,input.object_id,encode(&input)?])?;
    d.revision += 1;
    put(tx, "followups", &d.id, &d)?;
    refresh_uncommitted_batches(tx, &d)?;
    event(
        tx,
        &d.id,
        d.revision,
        "followup.source_route_changed",
        json!({"object_id":input.object_id,"thread_id":input.thread_id,"branch_id":input.branch_id,"user_input":input.user_input}),
    )?;
    project(tx, d)
}

fn publish_source_change(
    tx: &Transaction<'_>,
    source: &EventSourceIdentity,
    kind: &str,
) -> Result<()> {
    for d in definitions(tx)? {
        if identity(tx, &d)?.as_ref() == Some(source) {
            event(tx, &d.id, d.revision, kind, Value::Null)?;
        }
    }
    Ok(())
}
/// The original one-time legacy ownership claim moves source checkpoints and their
/// relational namespace atomically. Event ids and occurrence evidence remain immutable;
/// dedup uses the original source/event/object/revision tuple, not a newly encoded id.
pub(in crate::catalog) fn claim_legacy(tx: &Transaction<'_>, owner: &str) -> Result<()> {
    tx.execute("UPDATE followups SET body=json_set(body,'$.principal_id',?1) WHERE json_extract(body,'$.principal_id') IS NULL AND thread_id IN (SELECT id FROM threads WHERE principal_id=?1)",[owner])?;
    let rows=tx.prepare("SELECT id,body FROM followup_event_sources WHERE json_extract(body,'$.identity.principalId') IS NULL")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
    for (old, raw) in rows {
        let mut cp: EventSourceCheckpoint = serde_json::from_str(&raw)?;
        cp.identity.principal_id = Some(owner.into());
        let new = source_key(&cp.identity)?;
        if optional_record::<EventSourceCheckpoint>(tx, "followup_event_sources", &new)?.is_some() {
            return Err(RuntimeError::Conflict(
                "legacy event account already has an authenticated checkpoint".into(),
            ));
        }
        save_checkpoint(tx, &cp)?;
        tx.execute(
            "UPDATE followup_events SET source_id=?2 WHERE source_id=?1",
            params![old, new],
        )?;
        tx.execute("UPDATE followup_event_consumers SET source_id=?2,body=json_set(body,'$.identity.principalId',?3) WHERE source_id=?1",params![old,new,owner])?;
        tx.execute(
            "UPDATE followup_event_imports SET source_id=?2 WHERE source_id=?1",
            params![old, new],
        )?;
        tx.execute("UPDATE events SET data=json_set(data,'$.source_key',?2) WHERE kind IN ('followup.source_route_created','followup.source_route_removed') AND json_extract(data,'$.source_key')=?1",params![old,new])?;
        tx.execute("DELETE FROM followup_event_sources WHERE id=?1", [old])?;
    }
    Ok(())
}

pub(in crate::catalog) fn cancel_calendar_batches(
    tx: &Transaction<'_>,
    calendar: &str,
) -> Result<()> {
    let rows=tx.prepare("SELECT body FROM followup_occurrences WHERE json_extract(body,'$.evidence.calendar_occurrence_id')=?1")?.query_map([calendar],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    for raw in rows {
        let mut v: Occurrence = serde_json::from_str(&raw)?;
        if let Some(receipt) = &v.external_delivery {
            if !super::external::cancel(tx, receipt)? {
                continue;
            }
        }
        if let Some(input) = &v.input_id {
            let mut row: QueuedInputMetadata = record(tx, "input_queue", input)?;
            if row.state == InputState::Delivered {
                continue;
            }
            activation::cancel_row(tx, &mut row)?;
        }
        v.cancelled = true;
        put(tx, "followup_occurrences", &v.id, &v)?;
    }
    Ok(())
}

pub(super) fn cancel_external_batches(tx: &Transaction<'_>, id: &str) -> Result<()> {
    let rows=tx.prepare("SELECT body FROM followup_occurrences WHERE followup_id=?1 AND json_extract(body,'$.external_delivery') IS NOT NULL")?.query_map([id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    for raw in rows {
        let v: Occurrence = serde_json::from_str(&raw)?;
        if let Some(receipt) = v.external_delivery {
            super::external::cancel(tx, &receipt)?;
        }
    }
    Ok(())
}

pub(super) fn occurrence_file_dependencies(db: &Connection, v: &Occurrence) -> Result<Vec<String>> {
    let TriggerEvidence::PluginEvents { event_ids, .. } = &v.evidence else {
        return Ok(vec![]);
    };
    let mut dependencies = Vec::new();
    for id in event_ids {
        let event: ReceivedEvent = record(db, "followup_events", id)?;
        dependencies.extend(
            event
                .files
                .into_iter()
                .map(|file| file.content_ref.content_object),
        );
    }
    Ok(dependencies)
}
pub(super) fn pending_external_count(db: &Connection, id: &str) -> Result<u64> {
    let rows=db.prepare("SELECT body FROM followup_occurrences WHERE followup_id=?1 AND json_extract(body,'$.external_delivery') IS NOT NULL AND json_extract(body,'$.cancelled')=0")?.query_map([id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let mut count = 0;
    for raw in rows {
        let v: Occurrence = serde_json::from_str(&raw)?;
        if let Some(receipt) = v.external_delivery {
            let view = super::external::project(db, &receipt)?;
            if matches!(
                view.state.as_str(),
                "queued" | "awaiting_input" | "preparing"
            ) {
                count += 1;
            }
        }
    }
    Ok(count)
}

#[cfg(test)]
mod retirement_tests {
    use super::*;
    #[test]
    fn target_retirement_keeps_bot_definition_without_input_history_roots() {
        let root = std::env::temp_dir().join(format!("varin-event-retirement-{}", Uuid::new_v4()));
        let mut db = Catalog::open(&root).unwrap();
        db.publish_bot_gate(bot::BotGate {
            bot_id: "bot".into(),
            profile_revision: 1,
            activity_operation_id: None,
            permitted: true,
        })
        .unwrap();
        db.create_bot_thread("chat", "main", "bot").unwrap();
        db.create_thread("work", "work-main").unwrap();
        let source = PluginEventSource {
            host: None,
            extension_id: "mail".into(),
            source_id: "message".into(),
            connection_id: "connection".into(),
            account_id: "account".into(),
        };
        let input = ArrangementInput {
            key: "inbox".into(),
            expected_revision: None,
            bot_id: "bot".into(),
            thread_id: "work".into(),
            branch_id: "work-main".into(),
            name: "Inbox".into(),
            instruction: "Review".into(),
            source: source.clone(),
            filter: json!({}),
            timing: EventTiming::Immediate,
            repeat: FollowupRepeat::Each,
            source_run_id: None,
            external_conversation_id: None,
            first_contact: None,
        };
        let prepared = db.prepare_arrangement(input).unwrap().load().unwrap();
        db.admit_arrangement(prepared).unwrap();
        let prepared = db
            .prepare_event_receive(EventReceiveInput {
                identity: EventSourceIdentity {
                    principal_id: None,
                    source,
                },
                expected_cursor: None,
                next_cursor: Some("1".into()),
                status: None,
                events: vec![PluginEventInput {
                    event_id: "1".into(),
                    object_id: None,
                    sender_id: None,
                    revision: None,
                    occurred_at_ms: 1,
                    attributes: json!({}),
                    content: crate::output::OutputBody::text("body"),
                    files: vec![],
                    echo_of: None,
                    state: None,
                }],
            })
            .unwrap()
            .load()
            .unwrap();
        db.admit_event_receive(prepared).unwrap();
        for p in db.capture_followup_continuations().unwrap() {
            db.admit_followup_continuation(p.load().unwrap()).unwrap();
        }
        let d = db.followup("inbox").unwrap();
        db.control_event_backlog(EventBacklogInput {
            followup_id: d.id,
            expected_revision: d.revision,
            action: EventBacklogAction::Discard,
        })
        .unwrap();
        let revision = db.inspect_thread("work").unwrap()["revision"]
            .as_u64()
            .unwrap();
        db.delete_thread(&threads::ThreadDelete {
            thread_id: "work".into(),
            key: "delete".into(),
            expected_revision: revision,
        })
        .unwrap();
        db.retire_deleted_threads(&[]).unwrap();
        assert!(db.followup("inbox").is_ok());
        assert!(db
            .followup_occurrences("inbox", None)
            .unwrap()
            .occurrences
            .is_empty());
        assert_eq!(
            db.db
                .query_row(
                    "SELECT count(*) FROM input_queue WHERE origin='followup'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        drop(db);
        let _ = std::fs::remove_dir_all(root);
    }
}

fn ensure_first_contact(
    tx: &Transaction<'_>,
    d: &Definition,
    event_id: &str,
    event: &ReceivedEvent,
) -> Result<()> {
    if d.first_contact.is_none() {
        return Ok(());
    }
    let same_source: bool = tx.query_row(
        "SELECT source_id=?2 FROM followup_events WHERE id=?1",
        params![
            event_id,
            source_key(&identity(tx, d)?.expect("event source"))?
        ],
        |r| r.get(0),
    )?;
    if !same_source {
        return Ok(());
    }
    let Some(object) = event.object_id.as_deref() else {
        return Ok(());
    };
    let key = encode(&(&d.id, object))?;
    if optional_record::<EventSourceRouteInput>(tx, "followup_event_routes", &key)?.is_some() {
        return Ok(());
    }
    let source = source_key(&identity(tx, d)?.expect("event source"))?;
    let already_created:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE subject=?1 AND kind IN ('followup.source_route_created','followup.source_route_removed') AND json_extract(data,'$.source_key')=?2 AND json_extract(data,'$.object_id')=?3)",params![d.id,source,object],|r|r.get(0))?;
    if already_created {
        return Ok(());
    }
    let FollowupOwner::Bot { bot_id } = &d.owner else {
        return Err(RuntimeError::Invalid(
            "first contact sessions require a Bot owner".into(),
        ));
    };
    use sha2::{Digest, Sha256};
    let scope = encode(&(&d.id, identity(tx, d)?, object))?;
    let suffix = hex::encode(Sha256::digest(scope.as_bytes()));
    let thread = format!("thread:bot:event:{suffix}");
    let branch = format!("branch:bot:event:{suffix}");
    super::super::identity::create_public(
        tx,
        &thread,
        &branch,
        Some(bot_id),
        d.principal_id.as_deref(),
        bot::current_epoch(tx)?,
    )?;
    let route = EventSourceRouteInput {
        followup_id: d.id.clone(),
        expected_revision: d.revision,
        object_id: object.into(),
        thread_id: thread.clone(),
        branch_id: branch.clone(),
        sender_id: None,
        user_input: false,
        external_conversation_id: None,
    };
    tx.execute(
        "INSERT INTO followup_event_routes(id,followup_id,object_id,body) VALUES(?1,?2,?3,?4)",
        params![key, d.id, object, encode(&route)?],
    )?;
    super::super::event(
        tx,
        &d.id,
        d.revision,
        "followup.source_route_created",
        json!({"object_id":object,"thread_id":thread,"branch_id":branch,"source_key":source}),
    )?;
    Ok(())
}

pub(in crate::catalog) fn calendar_batch_projection(
    db: &Connection,
    id: &str,
) -> Result<Option<(calendar::OccurrenceState, Option<String>)>> {
    // Rerouting an unsent external turn preserves its cancelled receipt, but the
    // replacement batch is the slot's execution. Genuine cancellation still counts.
    let rows = db
        .prepare(
            "SELECT f.body,o.body FROM followup_occurrences o
             JOIN followups f ON f.id=o.followup_id
             WHERE json_extract(o.body,'$.evidence.calendar_occurrence_id')=?1
             AND NOT (json_extract(o.body,'$.cancelled')=1 AND EXISTS(
               SELECT 1 FROM events e WHERE e.subject=f.id
               AND e.kind='followup.batch_rerouted'
               AND json_extract(e.data,'$.original_occurrence_id')=o.id))",
        )?
        .query_map([id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.is_empty() {
        return Ok(None);
    }
    let mut result = (0, calendar::OccurrenceState::Completed, None);
    for (definition, occurrence) in rows {
        let d: Definition = serde_json::from_str(&definition)?;
        let o: Occurrence = serde_json::from_str(&occurrence)?;
        let view = project_occurrence(db, &d, o)?;
        let projected = match view.state {
            OccurrenceState::Held => (
                6,
                calendar::OccurrenceState::Held,
                view.hold_reason.map(|hold| {
                    serde_json::to_value(hold)
                        .expect("hold reason")
                        .as_str()
                        .unwrap_or("target_unavailable")
                        .to_owned()
                }),
            ),
            OccurrenceState::Observed => (5, calendar::OccurrenceState::Observed, None),
            OccurrenceState::Admitted => {
                if view
                    .delivery
                    .is_some_and(|delivery| delivery.state == InputState::Queued)
                    || view.external_delivery.as_ref().is_some_and(|delivery| {
                        matches!(
                            delivery.state.as_str(),
                            "queued" | "awaiting_input" | "preparing"
                        )
                    })
                {
                    (4, calendar::OccurrenceState::Queued, None)
                } else {
                    (3, calendar::OccurrenceState::Delivered, None)
                }
            }
            OccurrenceState::Failed => (2, calendar::OccurrenceState::Failed, None),
            OccurrenceState::Cancelled => (1, calendar::OccurrenceState::Cancelled, None),
            OccurrenceState::Completed => (0, calendar::OccurrenceState::Completed, None),
        };
        if projected.0 > result.0 {
            result = projected;
        }
    }
    Ok(Some((result.1, result.2)))
}

#[cfg(test)]
pub(in crate::catalog) fn restore_pre_arrangement_fixture(db: &Connection) -> Result<()> {
    db.execute_batch(include_str!("../tests/fixtures/catalog-pre-arrangements.sql"))?;
    Ok(())
}
