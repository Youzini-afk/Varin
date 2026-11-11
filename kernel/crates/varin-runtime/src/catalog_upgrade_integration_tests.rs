//! The two actual released layouts converge without relabelling or replaying assets.
use super::*;
use crate::catalog::context_observations::*;
use crate::execution::*;
use crate::test_submission::InputAdmission;

fn rows(db: &Connection, table: &str) -> Vec<(String, String)> {
    db.prepare(&format!("SELECT id,body FROM {table} ORDER BY id"))
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap()
}
fn zone2_objects(db: &Connection) -> Vec<(String, String)> {
    db.prepare("SELECT name,sql FROM sqlite_master WHERE name IN ('context_observation_captures','context_observation_imports','context_observation_queue_cursor','context_observation_queue_page') ORDER BY name").unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
        .collect::<std::result::Result<_, _>>().unwrap()
}
fn metadata_epoch(db: &Connection) -> i64 {
    db.query_row("SELECT epoch FROM runtime_meta", [], |r| r.get(0))
        .unwrap()
}
fn capture_batch(owner: ContextObservationSource, id: &str) -> ContextObservationCaptureBatch {
    serde_json::from_value(json!({"owner":owner,"captures":[{"captureId":id,"event":{"kind":"command","at":100,"source":"user","body":{"terminalId":"terminal","commandId":id,"command":"echo original 🦀".repeat(1000),"exitCode":0}}}]})).unwrap()
}
fn capture(
    db: &mut Catalog,
    owner: ContextObservationSource,
    id: &str,
) -> ContextObservationCaptureReceipt {
    let prepared = db
        .prepare_context_observation_captures(capture_batch(owner, id))
        .unwrap()
        .load()
        .unwrap();
    db.admit_context_observation_captures(prepared)
        .unwrap()
        .remove(0)
}
fn current_observation_owner(db: &Catalog) -> ContextObservationSource {
    db.context_observation_sources(&ContextObservationSources { run_id: None })
        .unwrap()
        .remove(0)
}

#[test]
fn genuine_v81_capture_and_import_assets_keep_original_receipts_digests_and_dependencies() {
    let fixture = Fixture(std::env::temp_dir().join(format!("varin-v81-assets-{}", id())));
    let mut db = Catalog::open(&fixture.0).unwrap();
    db.create_thread("thread", "main").unwrap();
    let input = db
        .submit(&SubmitInput {
            key: "input".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            expected_head: None,
            input: json!({"text":"Original user input"}),
            configuration: json!({}),
        })
        .unwrap();
    let binding: RequestBinding = serde_json::from_value(json!({"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"fixture","provider_family":"fixture","model":"fixture","credential_ref":null,"configuration_generation":1,"tool_schema_generation":1,"tools":[],"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":"main","ancestor_id":null,"leaf_id":input.input_id}})).unwrap();
    let source = serde_json::from_value(json!({"resource_owner":{"kind":"local"},"mode":"live_root","workspace_id":"root","execution_workspace_id":"root","branch_id":null,"revision":null,"live_root":{"hostId":"host","rootId":"root","canonicalRoot":"/root"}})).unwrap();
    db.bind_launch(
        &input.run_id,
        launches::LaunchSelection::from_binding(
            &binding,
            PolicyIdentity {
                name: "default".into(),
                version: "1".into(),
            },
            Some(source),
        ),
    )
    .unwrap();
    let owner = current_observation_owner(&db);
    let receipt = capture(&mut db, owner.clone(), "original");
    let prepared = db
        .prepare_context_observation_import(ContextObservationImport {
            owner: owner.clone(),
            after_id: 0,
            through_id: 3,
            events: vec![ContextObservationFact {
                id: 3,
                kind: "edit".into(),
                at: 101,
                text: "Original imported edit".into(),
                source: "user".into(),
                refs: None,
                data: None,
            }],
        })
        .unwrap()
        .load()
        .unwrap();
    db.admit_context_observation_import(prepared).unwrap();
    let head = db.head("main").unwrap();
    let delivered = db
        .prepare_input_delivery(&input.run_id, db.epoch(), head.as_deref())
        .unwrap()
        .load()
        .unwrap();
    db.admit_input_delivery(delivered).unwrap().unwrap();
    let queued_receipt = capture(&mut db, owner.clone(), "queued-original");
    drop(db);

    // Restore exactly the released81 reference representation. Capture/import owners
    // and their schema are unchanged; only82-derived sidecars are removed. No raw
    // bytes, projection body, cursor, receipt or source identity is manufactured.
    let raw = fixture.raw();
    context_observations::check_format(&raw).unwrap();
    followups::events::restore_pre_arrangement_fixture(&raw).unwrap();
        raw.execute_batch("BEGIN;DROP TABLE thread_creations;DROP TABLE calendar_invocations;DROP TABLE calendar_legacy_manual_boundaries;DROP INDEX thread_principals;ALTER TABLE threads DROP COLUMN principal_id;DROP TABLE catalog_principal_owner;UPDATE runs SET body=json_remove(body,'$.principal_id');DROP TABLE attachment_deliveries;DROP INDEX model_steps_active;ALTER TABLE model_steps DROP COLUMN driver_id;CREATE UNIQUE INDEX model_steps_active ON model_steps(run_id,coalesce(node_id,'')) WHERE state IN ('prepared','dispatched');DROP TABLE driver_calls;DROP TABLE driver_checkpoints;DROP TABLE run_drivers;DELETE FROM runtime_domains WHERE name='run_drivers';UPDATE run_launches SET body=json_remove(body,'$.selection.driver','$.selection.driver_models');UPDATE history SET body=json_remove(body,'$.content.history_text','$.content.history_call_id');UPDATE input_history_content SET body=json_remove(body,'$.history_text','$.history_call_id');DROP TABLE IF EXISTS organization_retired_containers;DROP TABLE IF EXISTS organization_positions;DROP TABLE IF EXISTS organization_containers;DROP TABLE IF EXISTS organization_commands;DROP TABLE IF EXISTS organization_spaces;PRAGMA user_version=81;COMMIT;").unwrap();
    let captures = rows(&raw, "context_observation_captures");
    let imports = rows(&raw, "context_observation_imports");
    let schema = zone2_objects(&raw);
    let history_refs: Vec<(String, String)> = raw
        .prepare("SELECT id,json_extract(body,'$.content.content_object') FROM history ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap();
    drop(raw);
    let bodies = fixture.bodies();
    let mut db = Catalog::open(&fixture.0).unwrap();
    assert_eq!(inspect_catalog_format(&db.db).unwrap(), FORMAT);
    assert_eq!(rows(&db.db, "context_observation_captures"), captures);
    assert_eq!(rows(&db.db, "context_observation_imports"), imports);
    assert_eq!(zone2_objects(&db.db), schema);
    for (id, digest) in history_refs {
        assert_eq!(
            record::<HistoryItem>(&db.db, "history", &id)
                .unwrap()
                .content["content_object"],
            digest
        );
    }
    assert_eq!(
        db.context_observation_import_position(&ContextObservationImportPosition {
            owner: owner.clone()
        })
        .unwrap(),
        3
    );
    assert_eq!(
        db.context_observation_receipts(&ContextObservationReceiptLookup {
            owner: owner.clone(),
            capture_ids: vec!["original".into(), "queued-original".into()]
        })
        .unwrap(),
        [receipt.clone(), queued_receipt]
    );
    assert_eq!(fixture.bodies(), bodies);
    assert_eq!(
        db.prepare_content_collection(Default::default())
            .run()
            .status,
        ContentCollectionStatus::Completed
    );
    let original = db
        .prepare_context_observation_original(ContextObservationRead {
            run_id: input.run_id.clone(),
            id: receipt.id.clone(),
            offset: None,
            limit: Some(usize::MAX),
        })
        .unwrap()
        .load(&|| false)
        .unwrap();
    assert_eq!(original.raw_digest, receipt.raw_digest);
    assert_eq!(original.raw_ref, receipt.raw_ref);
    let expected = serde_json::to_value(
        capture_batch(owner.clone(), "original")
            .captures
            .remove(0)
            .event,
    )
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&original.text).unwrap(),
        expected
    );
    // New83 Environment captures are intentionally not selection-history indexed.
    let current = current_observation_owner(&db);
    let new_receipt = capture(&mut db, current, "new83-passive");
    let reference: Value = serde_json::from_str(
        &db.db
            .query_row(
                "SELECT body FROM input_history_content WHERE input_id=?1",
                [&new_receipt.id],
                |r| r.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    assert!(reference.get("history_text").is_none());
    drop(db);
    let db = Catalog::open(&fixture.0).unwrap();
    assert_eq!(
        db.context_observation_receipts(&ContextObservationReceiptLookup {
            owner,
            capture_ids: vec!["original".into()]
        })
        .unwrap(),
        [receipt]
    );
    assert_eq!(db.db.query_row("SELECT count(*) FROM events WHERE kind='catalog.upgraded' AND json_extract(data,'$.from')=81 AND json_extract(data,'$.to')=?1",[FORMAT],|r|r.get::<_,i64>(0)).unwrap(),1);
}

#[test]
fn standalone_v82_adds_only_zone2_and_preserves_indexed_references_byte_for_byte() {
    let fixture = Fixture::v82();
    let raw = fixture.raw();
    assert!(zone2_objects(&raw).is_empty());
    let history = rows(&raw, "history");
    let requests = rows(&raw, "model_steps");
    let input: String = raw
        .query_row(
            "SELECT body FROM input_history_content WHERE input_id='queued'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let epoch = metadata_epoch(&raw);
    drop(raw);
    let bodies = fixture.bodies();
    let db = Catalog::open(&fixture.0).unwrap();
    assert_eq!(inspect_catalog_format(&db.db).unwrap(), FORMAT);
    assert_eq!(metadata_epoch(&db.db), epoch + 1);
    assert_eq!(zone2_objects(&db.db).len(), 4);
    assert_eq!(rows(&db.db, "history"), history);
    assert_eq!(rows(&db.db, "model_steps"), requests);
    assert_eq!(
        db.db
            .query_row(
                "SELECT body FROM input_history_content WHERE input_id='queued'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        input
    );
    assert_eq!(fixture.bodies(), bodies);
    drop(db);
    let db = Catalog::open(&fixture.0).unwrap();
    assert_eq!(rows(&db.db, "history"), history);
    assert_eq!(
        db.db
            .query_row(
                "SELECT count(*) FROM events WHERE kind='catalog.upgraded'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[test]
fn combined_conversion_rolls_back_every_released_layout_before_recovery() {
    for (from, fixture) in [
        (80, Fixture::v80()),
        (81, Fixture::v81()),
        (82, Fixture::v82()),
    ] {
        let raw = fixture.raw();
        let history = rows(&raw, "history");
        let zone2 = zone2_objects(&raw);
        let epoch = metadata_epoch(&raw);
        raw.execute_batch("CREATE TRIGGER fail_combined_upgrade BEFORE INSERT ON events WHEN NEW.kind='catalog.upgraded' BEGIN SELECT RAISE(ABORT,'combined upgrade interrupted');END;").unwrap();
        drop(raw);
        let bodies = fixture.bodies();
        assert!(
            matches!(Catalog::open(&fixture.0),Err(RuntimeError::Upgrade {from:actual,to,..}) if actual==from && to==FORMAT)
        );
        let raw = fixture.raw();
        assert_eq!(inspect_catalog_format(&raw).unwrap(), from);
        assert_eq!(metadata_epoch(&raw), epoch);
        assert_eq!(rows(&raw, "history"), history);
        assert_eq!(zone2_objects(&raw), zone2);
        assert_eq!(fixture.bodies(), bodies);
        raw.execute_batch("DROP TRIGGER fail_combined_upgrade")
            .unwrap();
        drop(raw);
        assert_eq!(
            inspect_catalog_format(&Catalog::open(&fixture.0).unwrap().db).unwrap(),
            FORMAT
        );
    }
}

#[test]
fn mismatched_layouts_and_unknown_versions_are_rejected_without_repair() {
    for (label, fixture) in [
        (80, Fixture::v81()),
        (81, Fixture::v82()),
        (82, Fixture::v81()),
        (83, Fixture::v82()),
        (84, Fixture::v82()),
    ] {
        let raw = fixture.raw();
        if label < 95 { crate::catalog::organization::remove_for_legacy_fixture(&raw); }
        raw.pragma_update(None, "user_version", label).unwrap();
        let history = rows(&raw, "history");
        let schema = zone2_objects(&raw);
        let epoch = metadata_epoch(&raw);
        drop(raw);
        let bodies = fixture.bodies();
        assert!(Catalog::open(&fixture.0).is_err());
        let raw = fixture.raw();
        assert_eq!(
            raw.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            label
        );
        assert_eq!(rows(&raw, "history"), history);
        assert_eq!(zone2_objects(&raw), schema);
        assert_eq!(metadata_epoch(&raw), epoch);
        assert_eq!(fixture.bodies(), bodies);
    }
    let fixture = Fixture::v80();
    let raw = fixture.raw();
    raw.execute_batch("CREATE INDEX context_observation_queue_page ON history(id)")
        .unwrap();
    drop(raw);
    assert!(Catalog::open(&fixture.0).is_err());
    assert_eq!(zone2_objects(&fixture.raw()).len(), 1);
}

#[test]
fn missing_null_or_scalar_current_history_indexes_fail_before_writable_open() {
    for version in [82, FORMAT] {
        for edit in [
            "json_remove(body,'$.content.history_text')",
            "json_set(body,'$.content.history_text',NULL)",
            "json_set(body,'$.content.history_text',7)",
        ] {
            let fixture = Fixture::v82();
            if version == FORMAT {
                drop(Catalog::open(&fixture.0).unwrap());
            }
            let raw = fixture.raw();
            raw.execute(&format!("UPDATE history SET body={edit}"), [])
                .unwrap();
            let before = rows(&raw, "history");
            let schema = zone2_objects(&raw);
            let epoch = metadata_epoch(&raw);
            drop(raw);
            let bodies = fixture.bodies();
            assert!(Catalog::open(&fixture.0).is_err());
            let raw = fixture.raw();
            assert_eq!(
                raw.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                    .unwrap(),
                version
            );
            assert_eq!(rows(&raw, "history"), before);
            assert_eq!(zone2_objects(&raw), schema);
            assert_eq!(metadata_epoch(&raw), epoch);
            assert_eq!(fixture.bodies(), bodies);
        }
    }
}

#[test]
fn malformed_current_index_object_fails_original_history_read_without_repair() {
    let fixture = Fixture::v82();
    drop(Catalog::open(&fixture.0).unwrap());
    let raw = fixture.raw();
    raw.execute(
        "UPDATE history SET body=json_set(body,'$.content.history_text',json('{}'))",
        [],
    )
    .unwrap();
    let before = rows(&raw, "history");
    drop(raw);
    let bodies = fixture.bodies();
    let db = Catalog::open(&fixture.0).unwrap();
    // Preflight proves presence without reading bodies. The real content reader
    // validates the typed index and must not fall back to unbounded original text.
    assert!(db.history("main").is_err());
    assert_eq!(rows(&db.db, "history"), before);
    assert_eq!(fixture.bodies(), bodies);
}

#[test]
fn both_zone2_generations_reject_missing_identity_and_foreign_key_guards() {
    for version in [81, FORMAT] {
        for foreign_key in [false, true] {
            let fixture = Fixture::v81();
            if version == FORMAT {
                drop(Catalog::open(&fixture.0).unwrap());
            }
            let raw = fixture.raw();
            let source = if foreign_key {
                "source_run_id TEXT NOT NULL REFERENCES runs(id)"
            } else {
                "source_run_id TEXT NOT NULL"
            };
            let unique = if foreign_key {
                ""
            } else {
                ",UNIQUE(source_run_id,capture_id)"
            };
            raw.execute_batch(&format!("DROP TABLE context_observation_captures;CREATE TABLE context_observation_captures(id TEXT PRIMARY KEY REFERENCES input_queue(id),{source},capture_id TEXT NOT NULL,cursor INTEGER NOT NULL REFERENCES events(cursor),body TEXT NOT NULL{unique})")).unwrap();
            let schema = zone2_objects(&raw);
            let epoch = metadata_epoch(&raw);
            let history = rows(&raw, "history");
            drop(raw);
            assert!(Catalog::open(&fixture.0).is_err());
            let raw = fixture.raw();
            assert_eq!(zone2_objects(&raw), schema);
            assert_eq!(metadata_epoch(&raw), epoch);
            assert_eq!(rows(&raw, "history"), history);
            assert_eq!(
                raw.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                    .unwrap(),
                version
            );
        }
    }
}
