use super::*;
use crate::execution::{Content, Provenance};
use crate::test_submission::InputAdmission;

struct Root(std::path::PathBuf);
impl Root {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("varin-attachment-catalog-{}", id())))
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn file(reference: &str) -> Attachment {
    Attachment {
        reference: reference.into(),
        filename: "same.csv".into(),
        mime_type: "text/csv".into(),
        byte_length: 7,
    }
}
fn open(root: &Root) -> Catalog {
    let mut db = Catalog::open(&root.0).unwrap();
    db.create_thread("thread", "main").unwrap();
    db
}
fn message(files: &[Attachment]) -> messages::MessageInput {
    serde_json::from_value(json!({"kind":"inform","targetThreadId":"thread","attachments":files.iter().map(|file|json!({"ref":file.reference})).collect::<Vec<_>>()})).unwrap()
}
fn prepare(db: &Catalog, key: &str, files: &[Attachment]) -> messages::MessagePreparation {
    db.prepare_user_message(key.into(), "thread".into(), "main".into(), message(files))
        .unwrap()
}
fn submit(db: &mut Catalog, key: &str, input: Value) -> Receipt {
    db.submit(&SubmitInput {
        key: key.into(),
        thread_id: "thread".into(),
        branch_id: "main".into(),
        expected_head: db.head("main").unwrap(),
        input,
        configuration: json!({}),
    })
    .unwrap()
}
#[test]
fn selection_is_explicit_and_exclusive() {
    for value in [
        json!({}),
        json!({"ref":"attachment:x","path":"x"}),
        json!({"path":"x","owner":"forged"}),
    ] {
        assert!(serde_json::from_value::<AttachmentSelection>(value).is_err());
    }
    for value in [json!({"ref":""}), json!({"path":"  "})] {
        assert!(
            serde_json::from_value::<AttachmentSelection>(value)
                .unwrap()
                .validate()
                .is_err()
        );
    }
    let empty: messages::MessageInput =
        serde_json::from_value(json!({"kind":"inform","targetThreadId":"thread"})).unwrap();
    assert!(empty.validate().is_err());
}
#[test]
fn complete_attachment_only_message_is_atomic_replayable_and_has_ordered_fixed_identity() {
    let root = Root::new();
    let mut db = open(&root);
    let files = vec![file("attachment:first"), file("attachment:second")];
    assert!(prepare(&db, "message", &files).load().is_err());
    assert!(db.attachment_deliveries().unwrap().is_empty());
    assert_eq!(
        db.db
            .query_row("SELECT count(*) FROM input_queue", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let prepared = prepare(&db, "message", &files)
        .with_attachments(files.clone())
        .load()
        .unwrap();
    assert!(
        db.attachment_deliveries().unwrap().is_empty(),
        "preparation cannot publish half a message"
    );
    let accepted = db.admit_message(prepared).unwrap();
    assert!(accepted.accepted);
    let view = db
        .capture_message("thread", "main", &accepted.receipt.identity.message_id)
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(view.summary.attachments, files);
    assert_eq!(view.text, "");
    let retry = prepare(&db, "message", &files)
        .with_attachments(files.clone())
        .load()
        .unwrap();
    let replay = db.admit_message(retry).unwrap();
    assert!(!replay.accepted);
    assert_eq!(replay.receipt, accepted.receipt);
    let mut changed = files.clone();
    changed[0].byte_length += 1;
    let retry = prepare(&db, "message", &files)
        .with_attachments(changed)
        .load()
        .unwrap();
    assert!(db.admit_message(retry).is_err());
    drop(db);
    let db = Catalog::open(&root.0).unwrap();
    let restored = db
        .capture_message("thread", "main", &accepted.receipt.identity.message_id)
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(restored.summary.attachments, files);
    assert_eq!(db.attachment_deliveries().unwrap().len(), 1);
}
#[test]
fn attachment_and_real_image_enter_one_original_input_boundary() {
    let root = Root::new();
    let mut db = open(&root);
    let run = submit(&mut db, "initial", json!("start"));
    let mut image = file("attachment:image");
    image.mime_type = "image/png".into();
    image.filename = "image.png".into();
    image.byte_length = 5;
    let media = crate::output::IncomingMedia {
        media_type: "image/png".into(),
        data_base64: "aW1hZ2U=".into(),
    }
    .admit(crate::output::OutputSource::Conversation {
        provenance: Provenance::UserInstruction {
            input_id: "upload".into(),
        },
    })
    .unwrap();
    let p = prepare(&db, "with-image", &[image.clone()])
        .with_attachments(vec![image.clone()])
        .with_attachment_media(vec![media])
        .load()
        .unwrap();
    let receipt = db.admit_message(p).unwrap().receipt;
    let items = db
        .consume_inputs(&run.run_id, db.epoch(), Some(&run.input_id))
        .unwrap();
    assert!(items.iter().any(|item|match &item.content {Content::Output{output}=>output.parts.iter().any(|part|matches!(part,crate::output::OutputPart::Attachment{attachment} if attachment==&image)),_=>false}));
    assert!(items.iter().any(
        |item| matches!(&item.content,Content::Media{media} if media.data_base64=="aW1hZ2U=")
    ));
    assert_eq!(
        db.capture_message("thread", "main", &receipt.identity.message_id)
            .unwrap()
            .load()
            .unwrap()
            .summary
            .state,
        InputState::Delivered
    );
    let history = db.execution_history("main").unwrap();
    assert!(history.iter().any(
        |item| matches!(&item.content,Content::Media{media} if media.data_base64=="aW1hZ2U=")
    ));
}
#[test]
fn queued_edit_preserves_or_explicitly_replaces_the_original_file_relation() {
    let root = Root::new();
    let mut db = open(&root);
    let first = file("attachment:original");
    let replacement = file("attachment:replacement");
    let run = submit(&mut db, "initial", json!("start"));
    let queued = db
        .enqueue_input(&inputs::EnqueueInput {
            key: "later".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            mode: InputMode::Boundary,
            input: json!({"text":"queued","fileAttachments":[first]}),
            configuration: None,
        })
        .unwrap();
    let edit = db
        .edit_queued_input(&queued.input_id, 1, json!({"text":"edited"}))
        .unwrap();
    assert_eq!(input_attachments(&edit.content).unwrap(), [first]);
    let edit = db
        .edit_queued_input(
            &queued.input_id,
            2,
            json!({"text":"edited","fileAttachments":[replacement]}),
        )
        .unwrap();
    assert_eq!(
        input_attachments(&edit.content).unwrap(),
        [replacement.clone()]
    );
    assert_eq!(
        db.attachment_delivery("input", &queued.input_id)
            .unwrap()
            .unwrap()
            .attachments,
        [replacement]
    );
    assert_eq!(db.run(&run.run_id).unwrap().state, RunState::Accepted);
}
#[test]
fn retention_follows_surviving_history_and_releases_only_after_the_last_holder() {
    let root = Root::new();
    let mut db = open(&root);
    let original = file("attachment:original");
    let receipt = submit(&mut db, "original", json!({"fileAttachments":[original]}));
    let run = db.run(&receipt.run_id).unwrap();
    let run = db
        .transition_run(&run.id, db.epoch(), run.revision, RunState::Runnable)
        .unwrap();
    db.transition_run(&run.id, db.epoch(), run.revision, RunState::Completed)
        .unwrap();
    db.create_thread("survivor", "survivor-main").unwrap();
    db.db
        .execute(
            "UPDATE branches SET head=?1 WHERE id='survivor-main'",
            [&receipt.input_id],
        )
        .unwrap();
    for thread in ["thread", "survivor"] {
        let revision = db.inspect_thread(thread).unwrap()["revision"]
            .as_u64()
            .unwrap();
        db.delete_thread(&threads::ThreadDelete {
            thread_id: thread.into(),
            key: format!("delete:{thread}"),
            expected_revision: revision,
        })
        .unwrap();
        let runs = db
            .deleted_thread_retirement_candidates()
            .unwrap()
            .0
            .into_iter()
            .flat_map(|(_, runs)| runs)
            .collect::<Vec<_>>();
        db.retire_deleted_threads(&runs).unwrap();
        assert_eq!(
            db.attachment_deliveries().unwrap().len(),
            usize::from(thread == "thread")
        );
    }
}
#[test]
fn v84_upgrade_keeps_receipts_and_installs_attachment_edges_atomically() {
    let root = Root::new();
    let mut db = open(&root);
    let receipt = submit(&mut db, "original", json!("legacy"));
    db.db
        .execute_batch("DROP TABLE attachment_deliveries; PRAGMA user_version=84;")
        .unwrap();
    drop(db);
    let db = Catalog::open(&root.0).unwrap();
    assert_eq!(
        db.db
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        FORMAT
    );
    assert!(db.attachment_deliveries().unwrap().is_empty());
    let stored: String = db
        .db
        .query_row(
            "SELECT receipt FROM commands WHERE id='original'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(serde_json::from_str::<Receipt>(&stored).unwrap(), receipt);
}

#[test]
fn target_deleted_during_preparation_gets_no_half_message_or_attachment_relation() {
    let root = Root::new();
    let mut db = open(&root);
    let files = vec![file("attachment:prepared")];
    let prepared = prepare(&db, "late", &files)
        .with_attachments(files)
        .load()
        .unwrap();
    let revision = db.inspect_thread("thread").unwrap()["revision"]
        .as_u64()
        .unwrap();
    db.delete_thread(&threads::ThreadDelete {
        thread_id: "thread".into(),
        key: "delete".into(),
        expected_revision: revision,
    })
    .unwrap();
    assert!(db.admit_message(prepared).is_err());
    assert!(db.attachment_deliveries().unwrap().is_empty());
    assert_eq!(
        db.db
            .query_row("SELECT count(*) FROM input_queue", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn family_pages_expose_only_original_typed_files_even_when_text_is_paged() {
    let root = Root::new();
    let mut db = open(&root);
    let file = file("attachment:history");
    let receipt = submit(&mut db, "original", json!({"fileAttachments":[file]}));
    let read = |db: &Catalog| {
        db.capture_family_read("thread", Some("thread"), Some("main"))
            .unwrap()
    };
    let page = read(&db)
        .read(
            serde_json::from_value(json!({"query":{"kind":"recent","maxItemBytes":1}})).unwrap(),
            &|| false,
        )
        .unwrap();
    assert!(page.items[0].body_truncated);
    assert_eq!(page.items[0].attachments, [file.clone()]);
    let item = read(&db)
        .item(
            serde_json::from_value(json!({"itemId":receipt.input_id,"offset":1,"maxBytes":1}))
                .unwrap(),
            &|| false,
        )
        .unwrap();
    assert_eq!(item.attachments, [file.clone()]);
    let body = json!({"id":"result","provenance":{"kind":"assistant"},"content":{"kind":"output","output":{
        "data":{"fake":{"kind":"attachment","attachment":file}},"parts":[{"kind":"text","text":"ordinary attachment:history mention"},{"kind":"attachment","attachment":file}]}},"opaque":null});
    let history = db
        .append_history(
            &receipt.run_id,
            db.epoch(),
            Some(&receipt.input_id),
            HistorySource::Assistant,
            body,
            None,
        )
        .unwrap();
    for (pointer, offset, expected) in [
        ("/data", 0, 0),
        ("/parts", 0, 0),
        ("/parts", 1, 1),
        ("/parts/1/attachment", 0, 1),
        ("", 0, 1),
    ] {
        let page = read(&db)
            .output(
                serde_json::from_value(
                    json!({"itemId":history.id,"pointer":pointer,"offset":offset,"maxBytes":1}),
                )
                .unwrap(),
                &|| false,
            )
            .unwrap();
        assert_eq!(
            page["attachments"].as_array().unwrap().len(),
            expected,
            "{pointer} at {offset}"
        );
    }
    assert!(
        history_attachments(&json!({"fileAttachments":[file]}), HistorySource::Tool)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn unsupported_image_format_stays_a_file_without_a_false_vision_requirement() {
    let mut file=file("attachment:vector");
    for mime in ["image/svg+xml","image/tiff","application/octet-stream"] {
        file.mime_type=mime.into();assert!(!file.is_direct_image());
    }
    file.mime_type="image/svg+xml".into();assert!(file.description().contains("not direct model vision input"));
    for mime in ["image/png","image/jpeg","image/webp","image/gif"] {
        file.mime_type=mime.into();assert!(file.is_direct_image());
    }
}
