//! Public Catalog consumers: discovery, fixed history continuation and typed media.
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::json;
use varin_runtime::{
    catalog::{
        bot::BotGate,
        family::{FamilyListQuery, FamilyReadQuery, ReadRequest},
        threads::ThreadUpdate,
    },
    Catalog, HistorySource, SubmitInput,
};
fn recent(cursor: Option<String>, anchor: Option<String>) -> ReadRequest {
    ReadRequest {
        run_id: None,
        cursor,
        anchor,
        query: FamilyReadQuery::Recent {
            limit: Some(1),
            max_item_bytes: None,
        },
    }
}
#[test]
fn same_principal_direct_bots_discover_and_read_without_lending_agent_authority() {
    let root = std::env::temp_dir().join(format!("varin-bot-read-{}", uuid::Uuid::new_v4()));
    let mut db = Catalog::open(&root).unwrap();
    for bot in ["source-bot", "reader-bot", "foreign-bot"] {
        db.publish_bot_gate(BotGate {
            bot_id: bot.into(),
            profile_revision: 1,
            activity_operation_id: None,
            permitted: true,
        })
        .unwrap();
    }
    db.create_bot_thread_with_placement("source", "source-main", "source-bot", Some("alice"), None)
        .unwrap();
    db.create_bot_thread_with_placement("reader", "reader-main", "reader-bot", Some("alice"), None)
        .unwrap();
    db.create_bot_thread_with_placement(
        "another-source",
        "another-source-main",
        "source-bot",
        Some("alice"),
        None,
    )
    .unwrap();
    db.create_bot_thread_with_placement(
        "foreign",
        "foreign-main",
        "foreign-bot",
        Some("bob"),
        None,
    )
    .unwrap();
    db.create_thread_with_principal("ordinary", "ordinary-main", Some("alice"))
        .unwrap();
    let run = db
        .submit(&SubmitInput {
            key: "source-input".into(),
            thread_id: "source".into(),
            branch_id: "source-main".into(),
            expected_head: None,
            input: json!({"text":"original Bot discussion","attachments":[{"media_type":"image/png","data_base64":"AAEC"}]}),
            configuration: json!({"provider":"test"}),
        })
        .unwrap();
    let media = db.append_history(&run.run_id,db.epoch(),Some(&run.input_id),HistorySource::Assistant,
        json!({"id":"answer","provenance":{"kind":"assistant"},"content":{"kind":"text","text":"Retained assistant discussion"},"opaque":null}),None).unwrap();
    let directory = db
        .capture_family_read("reader", None, None)
        .unwrap()
        .directory_page(
            false,
            FamilyListQuery {
                scope: Some("all".into()),
                ..Default::default()
            },
            &|| false,
        )
        .unwrap();
    for id in ["source", "another-source", "ordinary"] {
        assert!(directory.members.iter().any(|m| m.thread_id == id));
    }
    assert!(!directory.members.iter().any(|m| m.thread_id == "foreign"));
    let page = db
        .capture_family_read("reader", Some("source"), None)
        .unwrap()
        .read(recent(None, None), &|| false)
        .unwrap();
    assert_eq!(page.items[0].id, media.id);
    let older = db
        .capture_family_read("reader", Some("source"), None)
        .unwrap()
        .read(
            recent(page.next_cursor.clone(), Some(page.anchor.clone())),
            &|| false,
        )
        .unwrap();
    assert_eq!(older.items[0].id, run.input_id);
    let part = &older.items[0].media[0];
    let output = db
        .capture_family_read("reader", Some("source"), None)
        .unwrap()
        .media_output(
            None,
            &page.anchor,
            &run.input_id,
            part.part_index,
            &part.content_ref,
            &|| false,
        )
        .unwrap();
    assert!(
        matches!(&output.parts[0],varin_runtime::output::OutputPart::Media{media} if media.data_base64=="AAEC")
    );

    for (caller, target) in [
        ("ordinary", "source"),
        ("foreign", "source"),
        ("reader", "foreign"),
    ] {
        assert!(db
            .capture_family_read(caller, Some(target), None)
            .unwrap()
            .authorize(&|| false)
            .is_err());
    }
    // Archives are browse filters, not revocation, and default discovery excludes them.
    let revision = db.inspect_thread("source").unwrap()["revision"]
        .as_u64()
        .unwrap();
    db.update_thread(&ThreadUpdate {
        thread_id: "source".into(),
        key: "archive".into(),
        expected_revision: revision,
        title: None,
        pinned: None,
        archived: Some(true),
        title_mode: None,
    })
    .unwrap();
    let directory = db
        .capture_family_read("reader", None, None)
        .unwrap()
        .directory_page(
            false,
            FamilyListQuery {
                scope: Some("all".into()),
                ..Default::default()
            },
            &|| false,
        )
        .unwrap();
    assert!(!directory.members.iter().any(|m| m.thread_id == "source"));
    let related = db
        .capture_family_read("reader", None, None)
        .unwrap()
        .list_page(
            false,
            FamilyListQuery {
                scope: Some("all".into()),
                ..Default::default()
            },
            &|| false,
        )
        .unwrap();
    assert!(
        related.members.iter().any(|m| m.thread_id == "source"),
        "archive must not revoke the original family/resource view"
    );
    let archives = db
        .capture_family_read("reader", None, None)
        .unwrap()
        .directory_page(
            false,
            FamilyListQuery {
                scope: Some("all".into()),
                archived: Some("only".into()),
                conversation_type: Some("bot".into()),
                ..Default::default()
            },
            &|| false,
        )
        .unwrap();
    assert_eq!(archives.members.len(), 1);
    assert_eq!(archives.members[0].thread_id, "source");
    db.capture_family_read("reader", Some("source"), None)
        .unwrap()
        .authorize(&|| false)
        .unwrap();
    drop(db);
    let db = Catalog::open(&root).unwrap();
    db.capture_family_read("reader", Some("source"), None)
        .unwrap()
        .authorize(&|| false)
        .unwrap();
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
