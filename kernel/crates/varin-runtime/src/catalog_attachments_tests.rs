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
    Attachment { model_ref: None,
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
    let original = input_attachments(&db.capture_queued_input(&queued.input_id).unwrap().load().unwrap().content).unwrap();
    assert_eq!(original.len(), 1);
    assert!(original[0].same_resource(&first));
    assert!(original[0].model_ref.as_deref().is_some_and(|reference| reference.starts_with("file:")));
    let edit = db
        .edit_queued_input(&queued.input_id, 1, json!({"text":"edited"}))
        .unwrap();
    assert_eq!(input_attachments(&edit.content).unwrap(), original, "An omitted file selection preserves its original model reference too");
    let edit = db
        .edit_queued_input(
            &queued.input_id,
            2,
            json!({"text":"edited","fileAttachments":[replacement]}),
        )
        .unwrap();
    let selected = input_attachments(&edit.content).unwrap();
    assert_eq!(selected.len(), 1);
    assert!(selected[0].same_resource(&replacement));
    assert_ne!(selected[0].model_ref, original[0].model_ref, "Replacing the file selects a different immutable resource");
    let mut expected = vec![replacement];
    db.project_attachments(&mut expected, &queued.input_id).unwrap();
    assert_eq!(selected, expected, "The original attachment owner reuses the stable file reference");
    assert_eq!(
        db.attachment_delivery("input", &queued.input_id)
            .unwrap()
            .unwrap()
            .attachments,
        selected
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
    followups::events::restore_pre_arrangement_fixture(&db.db).unwrap();
    crate::catalog::upgrades::remove_read_views_for_legacy_fixture(&db.db);
    db.db
        .execute_batch("DROP TABLE thread_creations;DROP TABLE calendar_invocations;DROP TABLE calendar_legacy_manual_boundaries;DROP INDEX thread_principals;ALTER TABLE threads DROP COLUMN principal_id;DROP TABLE catalog_principal_owner;UPDATE runs SET body=json_remove(body,'$.principal_id');DROP TABLE attachment_deliveries; DROP TABLE IF EXISTS organization_retired_containers;DROP TABLE IF EXISTS organization_positions;DROP TABLE IF EXISTS organization_containers;DROP TABLE IF EXISTS organization_commands;DROP TABLE IF EXISTS organization_spaces;PRAGMA user_version=84;")
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
    let original = page.items[0].attachments.clone();
    assert_eq!(original.len(), 1);
    assert!(original[0].same_resource(&file));
    assert!(original[0].model_ref.as_deref().is_some_and(|reference| reference.starts_with("file:")));
    let mut expected = vec![file.clone()];
    db.project_attachments(&mut expected, &receipt.input_id).unwrap();
    assert_eq!(original, expected, "Paging cannot allocate another address for the same file");
    let item = read(&db)
        .item(
            serde_json::from_value(json!({"itemId":receipt.input_id,"offset":1,"maxBytes":1}))
                .unwrap(),
            &|| false,
        )
        .unwrap();
    assert_eq!(item.attachments, original, "The item and recent page retain the same original file address");
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

#[test]
fn source_citations_select_only_retained_typed_materials() {
    let source = file(&format!("attachment:material_{}", hex::encode("snap-known")));
    let other = file("attachment:unrelated");
    let text = "Known [evidence](varin-material://snap-known?startLine=2&endLine=4), unknown [fake](varin-material://snap-private), ordinary https://example.com and snap-known sha256-deadbeef".to_owned();
    assert_eq!(cited_materials(&[text.clone()], &[source.clone(), other, source.clone()]), vec![source.clone()]);
    assert!(cited_materials(&[text], &[]).is_empty());
    assert!(cited_materials(&["snap-known attachment:material_736e61702d6b6e6f776e".into()], &[source.clone()]).is_empty());
    assert!(cited_materials(&["varin-material://snap-known/foreign".into()], &[source]).is_empty());
}

#[test]
fn final_source_report_retains_only_acquired_citations_after_child_deletion() {
    use super::super::user_dispatch_tests::{Fixture, start_child};
    let mut fixture = Fixture::new_in_bot();
    let child = fixture.accept();
    let child = start_child(&mut fixture.db, child);
    let targeted = fixture.db.capture_material_retention(Some(&child.child_thread_id), &[], false).unwrap().load().unwrap();
    assert_eq!(targeted.threads.len(), 1);
    assert_eq!(targeted.threads[0].root_thread_id, child.parent_thread_id);
    let run = fixture.db.run(&child.receipt.as_ref().unwrap().run_id).unwrap();
    fixture.db.transition_run(&run.id, fixture.db.epoch(), run.revision, RunState::Runnable).unwrap();
    let source = file(&format!("attachment:material_{}", hex::encode("snap-evidence")));
    let head = fixture.db.head(&run.branch_id).unwrap();
    let observed = fixture.db.append_history(&run.id, fixture.db.epoch(), head.as_deref(), HistorySource::Tool,
        json!({"id":"search-source","provenance":{"kind":"external_data","source":"websearch"},"content":{"kind":"output","output":{
            "data":null,"parts":[{"kind":"attachment","attachment":source}]}},"opaque":null}), None).unwrap();
    let answer = fixture.db.append_history(&run.id, fixture.db.epoch(), Some(&observed.id), HistorySource::Assistant,
        json!({"id":"answer","provenance":{"kind":"assistant"},"content":{"kind":"text","text":"Verified [source](varin-material://snap-evidence?startLine=1). Unknown [source](varin-material://snap-private)."},"opaque":null}), None).unwrap();
    let run = fixture.db.run(&run.id).unwrap();
    fixture.db.transition_run(&run.id, fixture.db.epoch(), run.revision, RunState::Completed).unwrap();
    for prepared in fixture.db.capture_child_reports().unwrap().load().unwrap() { fixture.db.admit_child_report(prepared).unwrap(); }
    let report = fixture.db.read_child_report(&child.operation_id, &answer.id, 0, 4096).unwrap();
    assert_eq!(report.attachments, vec![source.clone()]);
    let history_page = fixture.db.capture_family_read(&child.parent_thread_id, Some(&child.child_thread_id), Some(&child.child_branch_id)).unwrap()
        .item(serde_json::from_value(json!({"itemId":answer.id,"maxBytes":1})).unwrap(), &|| false).unwrap();
    assert_eq!(history_page.attachments, vec![source.clone()]);

    let plan = fixture.db.capture_material_retention(None, &[], false).unwrap().load().unwrap();
    assert!(plan.attachments.iter().any(|edge| edge.holder_kind == "report" && edge.thread_id == child.parent_thread_id && edge.attachments == vec![source.clone()]));
    let revision = fixture.db.inspect_thread(&child.child_thread_id).unwrap()["revision"].as_u64().unwrap();
    fixture.db.delete_thread(&threads::ThreadDelete { thread_id: child.child_thread_id.clone(), key: "delete-source-worker".into(), expected_revision: revision }).unwrap();
    let plan = fixture.db.capture_material_retention(None, &[child.child_thread_id.clone()], false).unwrap().load().unwrap();
    assert!(plan.attachments.iter().any(|edge| edge.thread_id == child.parent_thread_id && edge.attachments == vec![source.clone()]));
}

#[test]
fn newly_prepared_message_uses_same_file_ref_and_preserves_original_delivery() {
    let root=Root::new();let mut db=open(&root);
    let mut files=vec![file("attachment:localized-owner-file")];
    let preparation=prepare(&db,"projected-message",&files).with_attachments(files.clone())
        .with_model_references(&db).unwrap();
    let accepted=db.admit_message(preparation.load().unwrap()).unwrap();
    let delivery=db.attachment_delivery("input",&accepted.receipt.identity.message_id).unwrap().unwrap();
    let reference=delivery.attachments[0].model_ref.clone().unwrap();
    assert!(delivery.attachments[0].same_resource(&files[0]));
    db.project_attachments(&mut files,&accepted.receipt.identity.message_id).unwrap();
    assert_eq!(files[0].model_ref.as_deref(),Some(reference.as_str()));
    let view=db.capture_message("thread","main",&accepted.receipt.identity.message_id).unwrap().load().unwrap();
    assert_eq!(view.summary.attachments[0].reference,"attachment:localized-owner-file");
    assert!(!view.summary.attachments[0].description().contains("attachment:localized-owner-file"));
    let target=db.resolve_model_reference(super::super::model_references::ReferenceKind::File,&reference).unwrap();
    assert_eq!(target.target,json!({"kind":"attachment","reference":"attachment:localized-owner-file"}));
}
