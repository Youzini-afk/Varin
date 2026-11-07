//! Original-file ingress and reads. References are facts, not permission to read bytes.
use super::super::attachments::Attachment;
use super::*;
use crate::{content::ContentStore, output::ContentRef};
use base64::{Engine, engine::general_purpose::STANDARD};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventFileInput {
    pub file_id: String,
    pub filename: String,
    pub mime_type: String,
    pub bytes_base64: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoredEventFile {
    pub file_id: String,
    pub attachment: Attachment,
    pub content_ref: ContentRef,
    pub content_hash: String,
    pub chunk_lengths: Vec<u64>,
}
pub(super) fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE followup_event_file_refs(ref TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES followup_events(id) ON DELETE CASCADE,file_index INTEGER NOT NULL);
        CREATE INDEX followup_event_file_refs_event ON followup_event_file_refs(event_id);")?;
    Ok(())
}
pub(super) fn validate_store(db: &Connection) -> Result<()> {
    db.prepare("SELECT ref,event_id,file_index FROM followup_event_file_refs")?;
    Ok(())
}
pub(super) fn publish_files(
    db: &Connection,
    event_id: &str,
    files: &[StoredEventFile],
) -> Result<()> {
    for (index, file) in files.iter().enumerate() {
        db.execute(
            "INSERT INTO followup_event_file_refs(ref,event_id,file_index) VALUES(?1,?2,?3)",
            params![
                file.attachment.reference,
                event_id,
                sql_number(index as u64)?
            ],
        )?;
    }
    Ok(())
}
pub(super) fn prepare_files(
    content: &ContentStore,
    event_id: &str,
    files: &[EventFileInput],
) -> Result<Vec<StoredEventFile>> {
    use sha2::{Digest, Sha256};
    let mut ids = std::collections::BTreeSet::new();
    files
        .iter()
        .map(|file| {
            if file.file_id.trim().is_empty()
                || file.file_id.contains('\0')
                || !ids.insert(&file.file_id)
                || file.filename.trim().is_empty()
                || matches!(file.filename.as_str(), "." | "..")
                || file
                    .filename
                    .chars()
                    .any(|c| c == '/' || c == '\\' || c.is_control())
            {
                return Err(RuntimeError::Invalid(
                    "event file identity or filename is invalid".into(),
                ));
            }
            let mime_token = |s: &str| {
                !s.is_empty()
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&b))
            };
            if !file
                .mime_type
                .split_once('/')
                .is_some_and(|(a, b)| mime_token(a) && mime_token(b))
            {
                return Err(RuntimeError::Invalid(
                    "event file MIME type is invalid".into(),
                ));
            }
            let bytes = STANDARD
                .decode(&file.bytes_base64)
                .map_err(|_| RuntimeError::Invalid("event file bytes are not base64".into()))?;
            if STANDARD.encode(&bytes) != file.bytes_base64 {
                return Err(RuntimeError::Invalid(
                    "event file bytes are not canonical base64".into(),
                ));
            }
            let content_ref: ContentRef = serde_json::from_value(content.save_bytes(&bytes)?)?;
            let identity = encode(&(event_id, &file.file_id))?;
            let attachment = Attachment {
                reference: format!(
                    "attachment:event_{}",
                    hex::encode(Sha256::digest(identity.as_bytes()))
                ),
                filename: file.filename.clone(),
                mime_type: file.mime_type.clone(),
                byte_length: bytes.len() as u64,
            };
            attachment.validate()?;
            Ok(StoredEventFile {
                file_id: file.file_id.clone(),
                attachment,
                content_ref,
                content_hash: format!("sha256-{}", hex::encode(Sha256::digest(&bytes))),
                chunk_lengths: ContentStore::byte_chunk_lengths(&bytes),
            })
        })
        .collect()
}
pub(super) fn hydrate_files(
    content: &ContentStore,
    files: &[StoredEventFile],
) -> Result<Vec<EventFileInput>> {
    files
        .iter()
        .map(|file| {
            Ok(EventFileInput {
                file_id: file.file_id.clone(),
                filename: file.attachment.filename.clone(),
                mime_type: file.attachment.mime_type.clone(),
                bytes_base64: STANDARD.encode(
                    content.load_bytes(&serde_json::to_value(&file.content_ref)?, &|| false)?,
                ),
            })
        })
        .collect()
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventAttachmentReadInput {
    pub thread_id: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub offset: u64,
    pub length: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventAttachmentReadView {
    pub attachment: Attachment,
    pub content_hash: String,
    pub offset: u64,
    pub next_offset: u64,
    pub eof: bool,
    pub bytes_base64: String,
}
pub struct PreparedEventAttachmentRead {
    input: EventAttachmentReadInput,
    file: StoredEventFile,
    content: ContentStore,
    _publication: crate::content::ContentPublication,
}
impl PreparedEventAttachmentRead {
    /// Original ContentStore chunks are verified individually; no entire-file copy under Catalog.
    pub fn load(self) -> Result<EventAttachmentReadView> {
        let end = self
            .input
            .offset
            .saturating_add(self.input.length)
            .min(self.file.attachment.byte_length);
        let mut bytes = Vec::new();
        let mut position = 0u64;
        let reference = serde_json::to_value(&self.file.content_ref)?;
        let mut index = 0;
        if self.file.chunk_lengths.iter().sum::<u64>() != self.file.attachment.byte_length {
            return Err(RuntimeError::Invalid(
                "event file chunk index is invalid".into(),
            ));
        }
        while index < self.file.chunk_lengths.len()
            && position + self.file.chunk_lengths[index] <= self.input.offset
        {
            position += self.file.chunk_lengths[index];
            index += 1;
        }
        while position < end {
            let chunk = self.content.load_chunk(&reference, index)?;
            if chunk.total_bytes != self.file.attachment.byte_length
                || chunk.chunk_count != self.file.chunk_lengths.len()
                || chunk.bytes.len() as u64 != self.file.chunk_lengths[index]
            {
                return Err(RuntimeError::Conflict(
                    "event file byte length changed".into(),
                ));
            }
            let next = position + chunk.bytes.len() as u64;
            if next > self.input.offset {
                let first = self.input.offset.saturating_sub(position) as usize;
                let last = (end - position).min(chunk.bytes.len() as u64) as usize;
                bytes.extend_from_slice(&chunk.bytes[first..last]);
            }
            position = next;
            index += 1;
        }
        Ok(EventAttachmentReadView {
            attachment: self.file.attachment.clone(),
            content_hash: self.file.content_hash,
            offset: self.input.offset,
            next_offset: end,
            eof: end == self.file.attachment.byte_length,
            bytes_base64: STANDARD.encode(bytes),
        })
    }
}
impl Catalog {
    pub fn prepare_event_attachment_read(
        &self,
        input: EventAttachmentReadInput,
    ) -> Result<PreparedEventAttachmentRead> {
        if input.length == 0 || !input.reference.starts_with("attachment:event_") {
            return Err(RuntimeError::Invalid(
                "select an original event attachment and positive read length".into(),
            ));
        }
        let delivered: bool = self.db.query_row("SELECT EXISTS(SELECT 1 FROM attachment_deliveries d,json_each(d.body,'$.attachments') a WHERE d.thread_id=?1 AND json_extract(a.value,'$.ref')=?2)",params![input.thread_id,input.reference],|r|r.get(0))?;
        if !delivered {
            return Err(RuntimeError::Invalid(
                "event attachment has not been delivered to this Thread".into(),
            ));
        }
        let raw: Option<String> = self.db.query_row("SELECT json_extract(e.body,'$.files[' || f.file_index || ']') FROM followup_event_file_refs f JOIN followup_events e ON e.id=f.event_id WHERE f.ref=?1",[&input.reference],|r|r.get(0)).optional()?;
        let file: StoredEventFile =
            serde_json::from_str(&raw.ok_or_else(|| {
                RuntimeError::Invalid("original event file is unavailable".into())
            })?)?;
        if input.offset > file.attachment.byte_length {
            return Err(RuntimeError::Invalid(
                "event attachment read offset is out of range".into(),
            ));
        }
        Ok(PreparedEventAttachmentRead {
            input,
            file,
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
            Self(std::env::temp_dir().join(format!("varin-event-files-{}", id())))
        }
    }
    impl Drop for Store {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn file(bytes: &[u8]) -> EventFileInput {
        EventFileInput {
            file_id: "original".into(),
            filename: "invoice.pdf".into(),
            mime_type: "application/pdf".into(),
            bytes_base64: STANDARD.encode(bytes),
        }
    }
    #[test]
    fn original_event_files_validate_identity_and_allow_empty_files() {
        let store = Store::new();
        let catalog = Catalog::open(&store.0).unwrap();
        let empty = file(&[]);
        let saved = prepare_files(&catalog.content, "event", &[empty.clone()]).unwrap();
        assert_eq!(saved[0].attachment.byte_length, 0);
        assert_eq!(
            hydrate_files(&catalog.content, &saved).unwrap(),
            vec![empty.clone()]
        );
        assert!(prepare_files(&catalog.content, "event", &[empty.clone(), empty.clone()]).is_err());
        let mut invalid = empty;
        invalid.filename = "../escape.pdf".into();
        assert!(prepare_files(&catalog.content, "event", &[invalid.clone()]).is_err());
        invalid.filename = "safe.pdf".into();
        invalid.bytes_base64 = "AB==".into();
        assert!(prepare_files(&catalog.content, "event", &[invalid]).is_err());
    }
    #[test]
    fn event_file_reads_require_real_delivery_and_return_original_range_and_byte_hash() {
        use sha2::{Digest, Sha256};
        let store = Store::new();
        let mut catalog = Catalog::open(&store.0).unwrap();
        let consumer = catalog
            .bind_event_transport(EventTransportBind {
                key: EventTransportKey {
                    principal_id: "alice".into(),
                    client_id: "client".into(),
                    coordinator_host_id: "peer".into(),
                    subscription_id: "watch".into(),
                },
                source: PluginEventSource {
                    host: None,
                    extension_id: "mail".into(),
                    source_id: "messages".into(),
                    connection_id: "inbox".into(),
                    account_id: "original".into(),
                },
                state: EventTransportState::Active,
            })
            .unwrap();
        let bytes = (0..700_000).map(|i| (i % 251) as u8).collect::<Vec<_>>();
        let input = EventReceiveInput {
            identity: consumer.identity,
            expected_cursor: None,
            next_cursor: Some("one".into()),
            status: None,
            events: vec![PluginEventInput {
                event_id: "event".into(),
                object_id: None,
                sender_id: None,
                revision: None,
                occurred_at_ms: 1,
                attributes: json!({}),
                content: crate::output::OutputBody::text("original PDF"),
                files: vec![file(&bytes)],
                echo_of: None,
                state: None,
            }],
        };
        let prepared = catalog
            .prepare_event_receive(input.clone())
            .unwrap()
            .load()
            .unwrap();
        catalog.admit_event_receive(prepared).unwrap();
        let raw: String = catalog
            .db
            .query_row("SELECT body FROM followup_events", [], |r| r.get(0))
            .unwrap();
        let event: super::super::events::ReceivedEvent = serde_json::from_str(&raw).unwrap();
        let attachment = event.files[0].attachment.clone();
        catalog
            .create_thread("recipient", "recipient-main")
            .unwrap();
        catalog.create_thread("peer", "peer-main").unwrap();
        let read = EventAttachmentReadInput {
            thread_id: "recipient".into(),
            reference: attachment.reference.clone(),
            offset: 123_456,
            length: 345_678,
        };
        assert!(catalog.prepare_event_attachment_read(read.clone()).is_err());
        super::super::super::attachments::publish(
            &catalog.db,
            &super::super::super::attachments::AttachmentDelivery {
                holder_kind: "input".into(),
                holder_id: "actual-delivery".into(),
                thread_id: "recipient".into(),
                branch_id: "recipient-main".into(),
                source_thread_id: None,
                source_branch_id: None,
                attachments: vec![attachment.clone()],
                input_ref: Some(
                    catalog
                        .content
                        .save_with_dependencies(
                            &json!({"text":"typed delivery"}),
                            vec![event.files[0].content_ref.content_object.clone()],
                        )
                        .unwrap(),
                ),
            },
        )
        .unwrap();
        let prepared = catalog.prepare_event_attachment_read(read.clone()).unwrap();
        let result = prepared.load().unwrap();
        assert_eq!(
            result.content_hash,
            format!("sha256-{}", hex::encode(Sha256::digest(&bytes)))
        );
        assert_eq!(
            STANDARD.decode(result.bytes_base64).unwrap(),
            bytes[123_456..469_134]
        );
        assert_eq!(result.next_offset, 469_134);
        assert!(!result.eof);
        // The inbox may release its body after delivery; the original delivery dependency remains.
        catalog
            .db
            .execute("UPDATE followup_events SET content_ref=NULL", [])
            .unwrap();
        let collection = catalog.prepare_content_collection(Default::default()).run();
        assert_eq!(
            collection.status,
            crate::ContentCollectionStatus::Completed,
            "{collection:?}"
        );
        assert_eq!(
            catalog
                .prepare_event_attachment_read(read.clone())
                .unwrap()
                .load()
                .unwrap()
                .content_hash,
            result.content_hash
        );
        let mut other = read;
        other.thread_id = "peer".into();
        assert!(catalog.prepare_event_attachment_read(other).is_err());
        let mut changed = input;
        changed.events[0].files[0] = file(b"changed original bytes");
        let prepared = catalog
            .prepare_event_receive(changed)
            .unwrap()
            .load()
            .unwrap();
        assert!(catalog.admit_event_receive(prepared).is_err());
    }
}
