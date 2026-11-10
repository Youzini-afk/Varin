use super::*;
use crate::execution::{Content, Provenance};
use crate::test_submission::InputAdmission;
struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("varin-quotes-{}", id())))
    }
    fn open(&self) -> Catalog {
        Catalog::open(&self.0).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn input() -> Value {
    json!({"text":"前 [引用点1] 中 [图片7] 后 [引用点1]",
        "contentReferences":[{"ref":"ui-selection:frozen","number":1,"title":"引用点1","label":"Varin","text":"原始选区\n保留 JSON: {\"id\":\"user-selected-id\"}",
            "source":{"kind":"ui","snapshotRef":"ui-snapshot:original","itemId":"private-source-entry","thread":{"runtime":"agent","threadId":"source-thread","branchId":"source-branch"}}},
            {"ref":"private-image-source","title":"图片7","imageReference":7,"source":{"kind":"object","objectRef":"private-object","thread":{"runtime":"agent","threadId":"source-thread","branchId":"source-branch"},"capturedAt":"fixed"}}],
        "contentReferenceOccurrences":[{"kind":"content","ref":"ui-selection:frozen","start":2,"end":8},{"kind":"image","reference":7,"start":11,"end":16},{"kind":"content","ref":"ui-selection:frozen","start":19,"end":25}],
        "attachments":[{"media_type":"image/png","data_base64":"cGljdHVyZQ=="}],"imageReferences":[7]})
}
fn message_body(db: &Catalog, id: &str) -> Value {
    let reference: String = db
        .db
        .query_row(
            "SELECT body FROM input_history_content WHERE input_id=?1",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    db.content
        .load_stored_history_payload(&serde_json::from_str(&reference).unwrap(), &|| false)
        .unwrap()
        .0
}
fn text(items: &crate::execution::ConversationHistory) -> String {
    items
        .iter()
        .filter_map(|item| match &item.content {
            Content::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}
#[test]
fn frozen_quotes_survive_queue_delivery_reopen_and_keep_source_out_of_model() {
    let root = Fixture::new();
    let mut db = root.open();
    db.create_thread("thread", "main").unwrap();
    let initial = db
        .submit(&SubmitInput {
            key: "initial".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            expected_head: None,
            input: json!({"text":"initial"}),
            configuration: json!({}),
        })
        .unwrap();
    let command = inputs::EnqueueInput {
        key: "quote-key".into(),
        thread_id: "thread".into(),
        branch_id: "main".into(),
        mode: InputMode::Boundary,
        input: input(),
        configuration: None,
    };
    let receipt = db.enqueue_input(&command).unwrap();
    let original = db.queued_input(&receipt.input_id).unwrap().content;
    assert_eq!(
        original["contentReferences"],
        command.input["contentReferences"]
    );
    assert_eq!(
        original["contentReferenceOccurrences"],
        command.input["contentReferenceOccurrences"]
    );
    assert!(original["attachments"][0].get("content_ref").is_some());
    assert!(original["attachments"][0].get("data_base64").is_none());
    let refs = db
        .capture_material_retention(None, &[], true)
        .unwrap()
        .load()
        .unwrap()
        .ui_references
        .unwrap();
    assert!(
        refs.contains(&"ui-snapshot:original".into()),
        "structured UI source retains its original snapshot without body text"
    );
    assert!(refs.contains(&"ui-selection:frozen".into()), "accepted input retains the original UI selection owner");
    let mut changed = command.clone();
    changed.input["contentReferences"][0]["text"] = json!("changed after enqueue");
    assert!(db.enqueue_input(&changed).is_err());
    let prepared = db
        .prepare_input_delivery(&initial.run_id, db.epoch(), Some(&initial.input_id))
        .unwrap()
        .load()
        .unwrap();
    let delivery = db.admit_input_delivery(prepared).unwrap().unwrap();
    assert_eq!(
        delivery
            .items
            .iter()
            .filter(|item| matches!(item.content, Content::Media { .. }))
            .count(),
        1
    );
    let projected = text(&delivery.items);
    assert_eq!(projected.matches("原始选区").count(), 1);
    assert!(projected.contains("user-selected-id"));
    for private in [
        "ui-selection:frozen",
        "private-source-entry",
        "private-image-source",
        "source-thread",
        "source-branch",
        "ui-snapshot:original",
    ] {
        assert!(!projected.contains(private));
    }
    let quote = delivery
        .items
        .iter()
        .position(
            |item| matches!(&item.content, Content::Text { text } if text.contains("原始选区")),
        )
        .unwrap();
    let image = delivery
        .items
        .iter()
        .position(|item| matches!(item.content, Content::Media { .. }))
        .unwrap();
    assert!(quote < image);
    assert!(matches!(
        delivery.items[quote].provenance,
        Provenance::ExternalData { .. }
    ));
    assert_eq!(delivery.items.last().unwrap().id, receipt.input_id);
    drop(db);
    let mut db = root.open();
    assert_eq!(db.enqueue_input(&command).unwrap(), receipt);
    assert_eq!(
        db.queued_input(&receipt.input_id).unwrap().content,
        original
    );
    let restored = db.history("main").unwrap().last().unwrap().content.clone();
    assert_eq!(restored["contentReferences"], original["contentReferences"]);
    assert_eq!(
        restored["contentReferenceOccurrences"],
        original["contentReferenceOccurrences"]
    );
    assert_eq!(
        restored["attachments"][0]["data_base64"],
        command.input["attachments"][0]["data_base64"]
    );
}
#[test]
fn quote_ranges_use_original_utf16_and_cannot_claim_plain_text_or_other_selectors() {
    let mut value = input();
    crate::output::admit_user_input("input", &value).unwrap();
    value["contentReferenceOccurrences"][0]["start"] = json!(9);
    assert!(crate::output::admit_user_input("input", &value).is_err());
    value = input();
    value["references"] = json!([{"kind":"directory","path":"docs","start":2,"end":8}]);
    assert!(crate::output::admit_user_input("input", &value).is_err());
    value = input();
    value["contentReferenceOccurrences"][0]["ref"] = json!("not-an-object");
    assert!(crate::output::admit_user_input("input", &value).is_err());
    value = input();
    value["contentReferenceOccurrences"] = json!([]);
    let admitted = crate::output::admit_user_input("input", &value).unwrap();
    let projected = execution_persistence::user_input_items("input", &admitted).unwrap();
    assert!(
        text(&projected).starts_with(value["text"].as_str().unwrap()),
        "unbound marker spellings remain ordinary user text"
    );
    assert_eq!(
        text(&projected).matches("原始选区").count(),
        1,
        "unpositioned retained quote is appended once"
    );
}
#[test]
fn quote_projection_does_not_truncate_selection_or_shift_skill_offsets() {
    let selected = "长原文🦊\n".repeat(20_000);
    let text = "🦊 [引用点1] /skill:one @docs";
    let value = json!({"text":format!("{text}\n\nHost-selected directory"),"userText":text,"contentReferences":[{"ref":"q","number":1,"title":"quote","text":selected,"source":{"kind":"chat","passages":[]}}],
        "contentReferenceOccurrences":[{"kind":"content","ref":"q","start":3,"end":9}],
        "skills":[{"resourceId":"one","version":"v1","start":10,"end":20}],
        "references":[{"kind":"directory","path":"docs","start":21,"end":26}]});
    resources::validate_raw_input(&value).unwrap();
    let admitted = crate::output::admit_user_input("input", &value).unwrap();
    let parts = crate::input_quotes::project(&admitted).unwrap().unwrap();
    let joined = parts
        .iter()
        .filter_map(|(part, _)| match part {
            Content::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    assert_eq!(joined.matches("长原文🦊").count(), 20_000);
    assert!(joined.ends_with(" /skill:one @docs\n\nHost-selected directory"));
}

#[test]
fn raw_quote_retry_identity_matches_prepared_files_but_cannot_be_admitted() {
    let raw = json!({"text":"[引用点1] [图片7]", "contentReferences":[{"ref":"quote","title":"引用点1","number":1,"text":"caption","attachment":{"ref":"attachment:selected"},"imageReference":7,"source":{"kind":"file","path":"original.png"}}],
        "contentReferenceOccurrences":[{"kind":"content","ref":"quote","start":0,"end":6},{"kind":"image","reference":7,"start":7,"end":12}],
        "referenceIntent":{"text":"[引用点1] [图片7]","attachmentSelections":[{"ref":"attachment:selected"}],"originalImageCount":0,"attachmentImageReferences":{"attachment:fixed":7}}});
    let mut prepared = raw.clone();
    prepared["contentReferences"][0]["attachmentRef"] = json!("attachment:fixed");
    prepared["fileAttachments"] = json!([{"ref":"attachment:fixed","filename":"original.png","mimeType":"image/png","byteLength":7}]);
    prepared["attachments"] = json!([{"media_type":"image/png","data_base64":"cGljdHVyZQ=="}]);
    prepared["imageReferences"] = json!([7]);
    prepared["attachmentImageReferences"] = json!({"attachment:fixed":7});
    assert_eq!(
        crate::content::ContentStore::normalized_user_input("same", &raw).unwrap(),
        crate::content::ContentStore::normalized_user_input("same", &prepared).unwrap()
    );
    assert!(
        resources::validate_raw_input(&raw).is_err(),
        "receipt lookup cannot admit unprepared resources"
    );
    resources::validate_raw_input(&prepared).unwrap();
}

#[test]
fn quoted_image_can_remain_a_readable_file_for_a_text_only_model() {
    let value = json!({"text":"Look [图片7] here", "contentReferences":[{"ref":"image-source","title":"image","imageReference":7,"source":{"kind":"chat","passages":[]}}],
        "contentReferenceOccurrences":[{"kind":"image","reference":7,"start":5,"end":10}],
        "fileAttachments":[{"ref":"attachment:image","filename":"image.png","mimeType":"image/png","byteLength":7}],"attachmentImageReferences":{"attachment:image":7}});
    let admitted = crate::output::admit_user_input("input", &value).unwrap();
    let projection = execution_persistence::user_input_items("input", &admitted).unwrap();
    assert!(
        !projection
            .iter()
            .any(|item| matches!(item.content, Content::Media { .. }))
    );
    assert_eq!(
        projection
            .iter()
            .filter(|item| matches!(item.content, Content::Output { .. }))
            .count(),
        1
    );
    assert!(text(&projection).contains("not direct visual input"));
    assert!(text(&projection).ends_with(" here"));
}

#[test]
fn directed_message_quotes_keep_routing_and_survive_plain_text_queue_edit() {
    let root = Fixture::new();
    let mut db = root.open();
    db.create_thread("thread", "main").unwrap();
    let input: messages::MessageInput = serde_json::from_value(
        json!({"kind":"inform","targetThreadId":"thread","text":"[引用点1] response"}),
    )
    .unwrap();
    let metadata = json!({"contentReferences":[{"ref":"private-quote","title":"引用点1","number":1,"text":"immutable selected passage","source":{"kind":"chat","passages":[]}}],
        "contentReferenceOccurrences":[{"kind":"content","ref":"private-quote","start":0,"end":6}]});
    let prepared = db
        .prepare_user_message(
            "message-quote".into(),
            "thread".into(),
            "main".into(),
            input.clone(),
        )
        .unwrap()
        .with_user_content(Some(metadata.clone()))
        .load()
        .unwrap();
    let receipt = db.admit_message(prepared).unwrap().receipt;
    let view = db
        .capture_message("thread", "main", &receipt.identity.message_id)
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(view.text, input.text);
    assert_eq!(
        view.content_references,
        Some(metadata["contentReferences"].clone())
    );
    let body = message_body(&db, &receipt.identity.message_id);
    assert_eq!(body["userText"], input.text);
    assert!(body["text"].as_str().unwrap().starts_with(&input.text));
    let edit = db
        .prepare_queued_message_edit(
            "thread",
            "main",
            &receipt.identity.message_id,
            view.summary.revision,
        )
        .unwrap()
        .load("new user wording".into())
        .unwrap();
    db.admit_queued_message_edit(edit).unwrap();
    let edited = db
        .capture_message("thread", "main", &receipt.identity.message_id)
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(edited.text, "new user wording");
    assert_eq!(edited.content_reference_occurrences, Some(json!([])));
    assert_eq!(edited.content_references, view.content_references);
    let body = message_body(&db, &receipt.identity.message_id);
    assert_eq!(body["userText"], "new user wording");
    assert!(body["text"].as_str().unwrap().contains("Task message"));
}

#[test]
fn localized_quote_labels_bind_explicit_ranges_without_inferring_plain_text() {
    for label in ["[Reference 1]", "[引用点 1]", "[引用点1]", "[Référence 1]"] {
        let prefix = "🦊 ";
        let text = format!("{prefix}{label} then {label}");
        let start = prefix.encode_utf16().count();
        let end = start + label.encode_utf16().count();
        let mut input = json!({"text":text,"contentReferences":[{"ref":"source","title":"quote","text":"selected bytes","source":{"kind":"chat","passages":[]}}],
            "contentReferenceOccurrences":[{"kind":"content","ref":"source","start":start,"end":end}]});
        let admitted = crate::output::admit_user_input("localized", &input).unwrap();
        let items = execution_persistence::user_input_items("localized", &admitted).unwrap();
        let projected = super::quote_tests::text(&items);
        assert_eq!(projected.matches("selected bytes").count(), 1);
        assert!(
            projected.ends_with(&format!(" then {label}")),
            "unbound display text stays inert"
        );
        input["contentReferenceOccurrences"][0]["start"] = json!(1);
        assert!(crate::output::admit_user_input("split-emoji", &input).is_err());
    }
    let mut input = input();
    input["text"] = json!("前 [引用点1] 中 [Bild7] 后 [引用点1]");
    // Same UTF-16 width as the old image token is not required; adjust all explicit ranges.
    input["contentReferenceOccurrences"][1]["end"] = json!(18);
    input["contentReferenceOccurrences"][2]["start"] = json!(21);
    input["contentReferenceOccurrences"][2]["end"] = json!(27);
    crate::output::admit_user_input("localized-image", &input).unwrap();
}

#[test]
fn pure_image_quotes_keep_original_file_without_empty_text_quote_or_duplicate_media() {
    let file = json!({"ref":"attachment:image","filename":"source.png","mimeType":"image/png","byteLength":7});
    let value = json!({"text":"Look [Image 7] now", "contentReferences":[{"ref":"image-source","title":"image","imageReference":7,
        "attachment":{"ref":"attachment:image"},"attachmentRef":"attachment:image","source":{"kind":"chat","passages":[]}}],
        "contentReferenceOccurrences":[{"kind":"image","reference":7,"start":5,"end":14}],
        "attachments":[{"media_type":"image/png","data_base64":"cGljdHVyZQ=="}],"imageReferences":[7],
        "fileAttachments":[file],"attachmentImageReferences":{"attachment:image":7}});
    let admitted = crate::output::admit_user_input("image-file", &value).unwrap();
    let items = execution_persistence::user_input_items("image-file", &admitted).unwrap();
    assert_eq!(text(&items), "Look [图片7] now");
    assert_eq!(
        items
            .iter()
            .filter(|item| matches!(item.content, Content::Media { .. }))
            .count(),
        1
    );
    assert_eq!(
        items
            .iter()
            .filter(|item| matches!(item.content, Content::Output { .. }))
            .count(),
        1
    );
}
