//! Cross-Host consumers of the original event ledger. No transport owns a second inbox.
use super::events::{EventSourceIdentity, EventSourceStatus, PluginEventInput, PluginEventSource};
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventTransportKey {
    pub principal_id: String,
    pub client_id: String,
    pub coordinator_host_id: String,
    pub subscription_id: String,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EventTransportState {
    Active,
    Paused,
    Released,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventTransportConsumer {
    pub key: EventTransportKey,
    pub identity: EventSourceIdentity,
    pub generation: u64,
    pub coverage_from_ms: u64,
    pub after_cursor: u64,
    pub offered_through: u64,
    pub state: EventTransportState,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventTransportBind {
    pub key: EventTransportKey,
    pub source: PluginEventSource,
    pub state: EventTransportState,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventTransportRead {
    pub key: EventTransportKey,
    pub generation: u64,
    pub max_events: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventTransportAck {
    pub key: EventTransportKey,
    pub generation: u64,
    pub through_cursor: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventTransportAccess {
    pub key: EventTransportKey,
    pub generation: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventTransportPage {
    pub consumer: EventTransportConsumer,
    pub events: Vec<PluginEventInput>,
    pub through_cursor: u64,
    pub status: Option<EventSourceStatus>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventTransportImport {
    pub identity: EventSourceIdentity,
    pub state: EventTransportState,
}

pub(super) fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE followup_event_consumers(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES followup_event_sources(id),after_cursor INTEGER NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL);
        CREATE INDEX followup_event_consumers_source ON followup_event_consumers(source_id,state,after_cursor);
        CREATE TABLE followup_event_imports(source_id TEXT PRIMARY KEY REFERENCES followup_event_sources(id),released INTEGER NOT NULL DEFAULT 0);")?;
    Ok(())
}
pub(super) fn validate_store(db: &Connection) -> Result<()> {
    db.prepare("SELECT id,source_id,after_cursor,state,body FROM followup_event_consumers")?;
    db.prepare("SELECT source_id,released FROM followup_event_imports")?;
    Ok(())
}
fn key(value: &EventTransportKey) -> Result<String> {
    principals::validate(&value.principal_id)?;
    for value in [
        &value.client_id,
        &value.coordinator_host_id,
        &value.subscription_id,
    ] {
        if value.trim().is_empty() {
            return Err(RuntimeError::Invalid(
                "event transport identity must not be empty".into(),
            ));
        }
    }
    encode(value)
}
fn write(tx: &Transaction<'_>, consumer: &EventTransportConsumer) -> Result<()> {
    tx.execute("INSERT INTO followup_event_consumers(id,source_id,after_cursor,state,body) VALUES(?1,?2,?3,?4,?5)
        ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id,after_cursor=excluded.after_cursor,state=excluded.state,body=excluded.body",
        params![key(&consumer.key)?, events::source_key(&consumer.identity)?, sql_number(consumer.after_cursor)?,
            match consumer.state { EventTransportState::Active=>"active", EventTransportState::Paused=>"paused", EventTransportState::Released=>"released" }, encode(consumer)?])?;
    Ok(())
}
pub(super) fn has_active_consumer(db: &Connection, identity: &EventSourceIdentity) -> Result<bool> {
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM followup_event_consumers WHERE source_id=?1 AND state='active')",
        [events::source_key(identity)?], |row| row.get(0))?)
}
pub(super) fn retain_import(db: &Connection, identity: &EventSourceIdentity) -> Result<()> {
    if identity.source.host.is_some() {
        db.execute("INSERT INTO followup_event_imports(source_id,released) VALUES(?1,0) ON CONFLICT(source_id) DO UPDATE SET released=0", [events::source_key(identity)?])?;
    }
    Ok(())
}

impl Catalog {
    pub fn bind_event_transport(
        &mut self,
        input: EventTransportBind,
    ) -> Result<EventTransportConsumer> {
        let id = key(&input.key)?;
        if input.source.host.is_some() || input.state == EventTransportState::Released {
            return Err(RuntimeError::Invalid(
                "event consumers bind a local source in active or paused state".into(),
            ));
        }
        let identity = EventSourceIdentity {
            principal_id: Some(input.key.principal_id.clone()),
            source: input.source,
        };
        let tx = self.db.transaction()?;
        let checkpoint = events::checkpoint(&tx, &identity)?;
        events::save_checkpoint(&tx, &checkpoint)?;
        let previous =
            optional_record::<EventTransportConsumer>(&tx, "followup_event_consumers", &id)?;
        let mut consumer = if let Some(previous) = previous {
            if previous.identity != identity {
                return Err(RuntimeError::Conflict(
                    "event consumer source changed".into(),
                ));
            }
            previous
        } else {
            let after = tx.query_row(
                "SELECT coalesce(max(accepted_cursor),0) FROM followup_events WHERE source_id=?1",
                [events::source_key(&identity)?],
                |r| read_number(r, 0),
            )?;
            EventTransportConsumer {
                key: input.key,
                identity,
                generation: 1,
                coverage_from_ms: super::super::threads::now_ms()?,
                after_cursor: after,
                offered_through: after,
                state: input.state,
            }
        };
        if consumer.state == EventTransportState::Released {
            consumer.generation = consumer.generation.checked_add(1).ok_or_else(|| {
                RuntimeError::Invalid("event consumer generation exhausted".into())
            })?;
            consumer.coverage_from_ms = super::super::threads::now_ms()?;
            consumer.after_cursor = tx.query_row(
                "SELECT coalesce(max(accepted_cursor),0) FROM followup_events WHERE source_id=?1",
                [events::source_key(&consumer.identity)?],
                |r| read_number(r, 0),
            )?;
            consumer.offered_through = consumer.after_cursor;
        }
        consumer.state = input.state;
        write(&tx, &consumer)?;
        tx.commit()?;
        Ok(consumer)
    }
    pub fn event_transport_consumer(
        &self,
        input: EventTransportKey,
    ) -> Result<Option<EventTransportConsumer>> {
        optional_record(&self.db, "followup_event_consumers", &key(&input)?)
    }
    pub fn event_transport_sources(&self) -> Result<Vec<EventSourceIdentity>> {
        let rows=self.db.prepare("SELECT DISTINCT s.body FROM followup_event_consumers c JOIN followup_event_sources s ON s.id=c.source_id WHERE c.state='active'")?
            .query_map([],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        rows.into_iter()
            .map(|raw| Ok(serde_json::from_str::<events::EventSourceCheckpoint>(&raw)?.identity))
            .collect()
    }
    pub fn ack_event_transport(
        &mut self,
        input: EventTransportAck,
    ) -> Result<EventTransportConsumer> {
        let tx = self.db.transaction()?;
        let mut consumer =
            record::<EventTransportConsumer>(&tx, "followup_event_consumers", &key(&input.key)?)?;
        if consumer.generation != input.generation
            || consumer.state == EventTransportState::Released
            || input.through_cursor > consumer.offered_through
        {
            return Err(RuntimeError::Conflict(
                "event acknowledgement exceeds the offered page".into(),
            ));
        }
        if input.through_cursor > consumer.after_cursor {
            consumer.after_cursor = input.through_cursor;
            write(&tx, &consumer)?;
        }
        tx.commit()?;
        Ok(consumer)
    }
    pub fn release_event_transport(
        &mut self,
        input: EventTransportAccess,
    ) -> Result<EventTransportConsumer> {
        let tx = self.db.transaction()?;
        let mut consumer =
            record::<EventTransportConsumer>(&tx, "followup_event_consumers", &key(&input.key)?)?;
        if consumer.generation != input.generation {
            return Err(RuntimeError::Conflict(
                "event consumer generation changed".into(),
            ));
        }
        consumer.state = EventTransportState::Released;
        write(&tx, &consumer)?;
        tx.commit()?;
        Ok(consumer)
    }
    pub fn event_transport_imports(&self) -> Result<Vec<EventTransportImport>> {
        let subscriptions = self.event_source_subscriptions()?;
        let rows=self.db.prepare("SELECT s.body FROM followup_event_imports i JOIN followup_event_sources s ON s.id=i.source_id WHERE i.released=0")?
            .query_map([],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        rows.into_iter()
            .map(|raw| {
                let checkpoint: events::EventSourceCheckpoint = serde_json::from_str(&raw)?;
                let mut state = EventTransportState::Released;
                for subscription in subscriptions
                    .iter()
                    .filter(|s| s.identity == checkpoint.identity)
                {
                    if subscription.state == FollowupState::Active {
                        state = EventTransportState::Active;
                        break;
                    }
                    if subscription.state == FollowupState::Paused {
                        state = EventTransportState::Paused;
                    }
                }
                Ok(EventTransportImport {
                    identity: checkpoint.identity,
                    state,
                })
            })
            .collect()
    }
    pub fn mark_event_import_released(&mut self, identity: EventSourceIdentity) -> Result<()> {
        if identity.source.host.is_none() {
            return Err(RuntimeError::Invalid("event source is not remote".into()));
        }
        if self
            .event_source_subscriptions()?
            .iter()
            .any(|s| s.identity == identity && s.state != FollowupState::Cancelled)
        {
            return Err(RuntimeError::Conflict(
                "event source still has subscriptions".into(),
            ));
        }
        self.db.execute(
            "UPDATE followup_event_imports SET released=1 WHERE source_id=?1",
            [events::source_key(&identity)?],
        )?;
        Ok(())
    }
}
pub struct PreparedEventTransportRead {
    consumer: EventTransportConsumer,
    status: Option<EventSourceStatus>,
    rows: Vec<(events::ReceivedEvent, Value)>,
    through_cursor: u64,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl PreparedEventTransportRead {
    pub fn load(self) -> Result<EventTransportPage> {
        let mut items = Vec::new();
        for (event, reference) in self.rows {
            let mut output = self.content.load_output(&reference)?;
            for part in &output.parts {
                if let crate::output::OutputPart::Attachment { attachment } = part {
                    if !event
                        .files
                        .iter()
                        .any(|file| file.attachment == *attachment)
                    {
                        return Err(RuntimeError::Invalid(
                            "event contains an unadmitted file reference".into(),
                        ));
                    }
                }
            }
            output
                .parts
                .retain(|part| !matches!(part, crate::output::OutputPart::Attachment { .. }));
            let content = output.map_media(|media| {
                Ok::<_, RuntimeError>(crate::output::IncomingMedia {
                    media_type: media.media_type,
                    data_base64: media.data_base64,
                })
            })?;
            items.push(PluginEventInput {
                event_id: event.event_id,
                object_id: event.object_id,
                sender_id: event.sender_id,
                revision: event.revision,
                occurred_at_ms: event.occurred_at_ms,
                attributes: event.attributes,
                content,
                files: super::event_files::hydrate_files(&self.content, &event.files)?,
                echo_of: event.echo_of,
                state: event.state,
            });
        }
        Ok(EventTransportPage {
            consumer: self.consumer,
            events: items,
            through_cursor: self.through_cursor,
            status: self.status,
        })
    }
}
impl Catalog {
    /// The short transaction freezes only original ledger references; byte hydration is outside it.
    pub fn prepare_event_transport_read(
        &mut self,
        input: EventTransportRead,
    ) -> Result<PreparedEventTransportRead> {
        let count = input.max_events.unwrap_or(100);
        if count == 0 {
            return Err(RuntimeError::Invalid(
                "event page size must be positive".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let mut consumer =
            record::<EventTransportConsumer>(&tx, "followup_event_consumers", &key(&input.key)?)?;
        if consumer.generation != input.generation || consumer.state != EventTransportState::Active
        {
            return Err(RuntimeError::Conflict(
                "event consumer is not active".into(),
            ));
        }
        let mut through = consumer.after_cursor;
        let mut rows = Vec::new();
        {
            let mut query=tx.prepare("SELECT accepted_cursor,body,content_ref FROM followup_events WHERE source_id=?1 AND accepted_cursor>?2 ORDER BY accepted_cursor LIMIT ?3")?;
            let data = query.query_map(
                params![
                    events::source_key(&consumer.identity)?,
                    sql_number(consumer.after_cursor)?,
                    sql_number(count)?
                ],
                |r| {
                    Ok((
                        read_number(r, 0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                    ))
                },
            )?;
            for row in data {
                let (cursor, body, reference) = row?;
                through = cursor;
                rows.push((
                    serde_json::from_str(&body)?,
                    serde_json::from_str(&reference.ok_or_else(|| {
                        RuntimeError::Conflict("unacknowledged event payload is unavailable".into())
                    })?)?,
                ));
            }
        }
        if through > consumer.offered_through {
            consumer.offered_through = through;
            write(&tx, &consumer)?;
        }
        let mut status = events::checkpoint(&tx, &consumer.identity)?.status;
        if let Some(status) = &mut status {
            if let Some(coverage) = &status.coverage {
                // A consumer boundary narrows known provider coverage; it cannot establish
                // coverage when the provider has never supplied that observation.
                let from = match coverage.kind.as_str() {
                    "complete" => Some(consumer.coverage_from_ms),
                    "from" => coverage
                        .from_ms
                        .map(|from| from.max(consumer.coverage_from_ms)),
                    _ => None,
                };
                if let Some(from) = from {
                    status.coverage = Some(super::events::EventCoverage {
                        kind: "from".into(),
                        from_ms: Some(from),
                    });
                }
            }
        }
        tx.commit()?;
        Ok(PreparedEventTransportRead {
            consumer,
            status,
            rows,
            through_cursor: through,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Store(std::path::PathBuf);
    impl Store {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("varin-event-transport-{}", id())))
        }
    }
    impl Drop for Store {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn binding() -> EventTransportBind {
        EventTransportBind {
            key: EventTransportKey {
                principal_id: "alice".into(),
                client_id: "paired-client".into(),
                coordinator_host_id: "receiver-host".into(),
                subscription_id: "attention".into(),
            },
            source: PluginEventSource {
                extension_id: "example.mail".into(),
                source_id: "messages".into(),
                connection_id: "mailbox".into(),
                account_id: "actual-account".into(),
                host: None,
            },
            state: EventTransportState::Active,
        }
    }
    fn receive(
        catalog: &mut Catalog,
        consumer: &EventTransportConsumer,
        id: &str,
        previous: Option<&str>,
        next: &str,
    ) {
        let input = events::EventReceiveInput {
            identity: consumer.identity.clone(),
            expected_cursor: previous.map(str::to_owned),
            next_cursor: Some(next.into()),
            status: None,
            events: vec![PluginEventInput {
                event_id: id.into(),
                object_id: Some("conversation".into()),
                sender_id: Some("actual-sender".into()),
                revision: None,
                occurred_at_ms: 1,
                attributes: json!({}),
                content: crate::output::OutputBody {
                    data: Value::Null,
                    parts: vec![
                        crate::output::OutputPart::Text {
                            text: "Original source text".into(),
                        },
                        crate::output::OutputPart::Media {
                            media: crate::output::IncomingMedia {
                                media_type: "image/png".into(),
                                data_base64: "aGVsbG8=".into(),
                            },
                        },
                    ],
                },
                files: vec![EventFileInput {
                    file_id: "original-pdf".into(),
                    filename: "invoice.pdf".into(),
                    mime_type: "application/pdf".into(),
                    bytes_base64: "JVBERi0xLjQ=".into(),
                }],
                echo_of: None,
                state: Some(EventState { key: "checks".into(), sequence: 3, value: "healthy".into() }),
            }],
        };
        let prepared = catalog
            .prepare_event_receive(input)
            .unwrap()
            .load()
            .unwrap();
        catalog.admit_event_receive(prepared).unwrap();
    }
    #[test]
    fn remote_consumer_retains_original_content_until_ack_and_recovers_without_a_thread() {
        let store = Store::new();
        let mut catalog = Catalog::open(&store.0).unwrap();
        let consumer = catalog.bind_event_transport(binding()).unwrap();
        receive(&mut catalog, &consumer, "one", None, "cursor-one");
        events::collect_payloads(&catalog.db).unwrap();
        let first = catalog
            .prepare_event_transport_read(EventTransportRead {
                key: consumer.key.clone(),
                generation: consumer.generation,
                max_events: Some(1),
            })
            .unwrap()
            .load()
            .unwrap();
        assert_eq!(first.events.len(), 1);
        assert_eq!(first.events[0].sender_id.as_deref(), Some("actual-sender"));
        assert_eq!(first.events[0].state.as_ref().unwrap().sequence, 3);
        assert_eq!(first.events[0].content.parts.len(), 2);
        assert_eq!(first.events[0].files[0].bytes_base64, "JVBERi0xLjQ=");
        assert!(first.status.is_none());
        assert!(
            catalog
                .ack_event_transport(EventTransportAck {
                    key: consumer.key.clone(),
                    generation: consumer.generation,
                    through_cursor: first.through_cursor + 1
                })
                .is_err()
        );
        drop(catalog);
        let mut catalog = Catalog::open(&store.0).unwrap();
        let repeated = catalog
            .prepare_event_transport_read(EventTransportRead {
                key: consumer.key.clone(),
                generation: consumer.generation,
                max_events: Some(1),
            })
            .unwrap()
            .load()
            .unwrap();
        assert_eq!(repeated.events, first.events);
        assert_eq!(repeated.through_cursor, first.through_cursor);
        catalog
            .ack_event_transport(EventTransportAck {
                key: consumer.key.clone(),
                generation: consumer.generation,
                through_cursor: first.through_cursor,
            })
            .unwrap();
        events::collect_payloads(&catalog.db).unwrap();
        let retained: bool = catalog
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM followup_events WHERE content_ref IS NOT NULL)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!retained);
        assert!(
            catalog
                .prepare_event_transport_read(EventTransportRead {
                    key: consumer.key.clone(),
                    generation: consumer.generation,
                    max_events: None
                })
                .unwrap()
                .load()
                .unwrap()
                .events
                .is_empty()
        );
        let threads: i64 = catalog
            .db
            .query_row("SELECT count(*) FROM threads", [], |r| r.get(0))
            .unwrap();
        assert_eq!(threads, 0);
    }
    #[test]
    fn remote_consumer_only_narrows_known_source_coverage() {
        let store = Store::new();
        let mut catalog = Catalog::open(&store.0).unwrap();
        let consumer = catalog.bind_event_transport(binding()).unwrap();
        let read = |catalog: &mut Catalog| {
            catalog
                .prepare_event_transport_read(EventTransportRead {
                    key: consumer.key.clone(),
                    generation: consumer.generation,
                    max_events: None,
                })
                .unwrap()
                .load()
                .unwrap()
                .status
        };
        assert_eq!(read(&mut catalog), None);
        let unknown = EventSourceStatus {
            code: Some("connecting".into()),
            message: None,
            coverage: None,
            last_connected_at_ms: None,
        };
        catalog
            .update_event_source_status(consumer.identity.clone(), unknown.clone())
            .unwrap();
        assert_eq!(read(&mut catalog), Some(unknown));
        for (kind, from, expected) in [
            ("complete", None, consumer.coverage_from_ms),
            ("from", Some(0), consumer.coverage_from_ms),
            (
                "from",
                Some(consumer.coverage_from_ms + 100),
                consumer.coverage_from_ms + 100,
            ),
        ] {
            catalog
                .update_event_source_status(
                    consumer.identity.clone(),
                    EventSourceStatus {
                        code: None,
                        message: None,
                        coverage: Some(super::super::events::EventCoverage {
                            kind: kind.into(),
                            from_ms: from,
                        }),
                        last_connected_at_ms: Some(7),
                    },
                )
                .unwrap();
            let status = read(&mut catalog).unwrap();
            assert_eq!(
                status.coverage,
                Some(super::super::events::EventCoverage {
                    kind: "from".into(),
                    from_ms: Some(expected)
                })
            );
            assert_eq!(status.last_connected_at_ms, Some(7));
        }
    }
    #[test]
    fn remote_consumer_generation_and_principal_fence_old_ack_and_release() {
        let store = Store::new();
        let mut catalog = Catalog::open(&store.0).unwrap();
        let original = catalog.bind_event_transport(binding()).unwrap();
        let mut wrong = original.key.clone();
        wrong.principal_id = "bob".into();
        assert!(
            catalog
                .event_transport_consumer(wrong.clone())
                .unwrap()
                .is_none()
        );
        assert!(
            catalog
                .release_event_transport(EventTransportAccess {
                    key: wrong,
                    generation: original.generation
                })
                .is_err()
        );
        catalog
            .release_event_transport(EventTransportAccess {
                key: original.key.clone(),
                generation: original.generation,
            })
            .unwrap();
        let current = catalog.bind_event_transport(binding()).unwrap();
        assert!(current.generation > original.generation);
        assert!(
            catalog
                .release_event_transport(EventTransportAccess {
                    key: original.key.clone(),
                    generation: original.generation
                })
                .is_err()
        );
        assert!(
            catalog
                .ack_event_transport(EventTransportAck {
                    key: original.key,
                    generation: original.generation,
                    through_cursor: 0
                })
                .is_err()
        );
        assert_eq!(
            catalog.event_transport_sources().unwrap(),
            vec![current.identity]
        );
    }
}
