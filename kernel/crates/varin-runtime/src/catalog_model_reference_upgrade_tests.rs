use super::*;
use crate::test_submission::InputAdmission;
use std::{collections::BTreeMap, path::PathBuf};

const TABLES: [&str; 7] = [
    "model_reference_space",
    "model_references",
    "model_reference_holders",
    "model_agents",
    "model_executions",
    "model_bound_targets",
    "model_execution_aliases",
];
const DROP_INDEX: &str = "DROP TABLE model_reference_holders;
    DROP TABLE model_references; DROP TABLE model_reference_space;
    DROP TABLE model_execution_aliases; DROP TABLE model_executions;
    DROP TABLE model_agents; DROP TABLE model_bound_targets;";
const DROP_COLUMNS: &str = "ALTER TABLE external_items DROP COLUMN kind;
    ALTER TABLE external_items DROP COLUMN tool_status;";

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("varin-reference-upgrade-{}", id())))
    }
    fn open(&self) -> Catalog {
        Catalog::open(&self.0).unwrap()
    }
    fn raw(&self) -> Connection {
        Connection::open(self.0.join("conversation.sqlite")).unwrap()
    }
    fn bodies(&self) -> BTreeMap<PathBuf, Vec<u8>> {
        fn walk(root: &Path, directory: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
            for entry in std::fs::read_dir(directory).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(root, &path, files);
                } else {
                    files.insert(
                        path.strip_prefix(root).unwrap().into(),
                        std::fs::read(path).unwrap(),
                    );
                }
            }
        }
        let mut files = BTreeMap::new();
        walk(&self.0, &self.0.join("content"), &mut files);
        files
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn seed() -> (Fixture, Catalog, Receipt, String) {
    let root = Fixture::new();
    let mut db = root.open();
    db.create_thread("agent", "main").unwrap();
    let run = db.submit(&SubmitInput {
        key: "original-quoted-input".into(),
        thread_id: "agent".into(),
        branch_id: "main".into(),
        expected_head: None,
        input: json!({"text":"Keep [Reference 1] now",
            "contentReferences":[{"ref":"frozen-selection","title":"original quote","text":"original selected bytes",
                "source":{"kind":"chat","passages":[]}}],
            "contentReferenceOccurrences":[{"kind":"content","ref":"frozen-selection","start":5,"end":18}]}),
        configuration: json!({}),
    }).unwrap();
    let reference = db
        .register_model_reference(
            ReferenceKind::File,
            "original-owner",
            &json!({"path":"kept","readVersion":"original"}),
            &run.run_id,
        )
        .unwrap();
    db.freeze_model_target(
        &run.run_id,
        "wait",
        &json!({"target":"agent"}),
        &json!({"execution":"original"}),
    )
    .unwrap();
    // Retired allocations are not recoverable from the surviving rows. A no-op
    // upgrade must retain these high waters, not merely recreate equivalent rows.
    db.db
        .execute("UPDATE model_agents SET high_water=17", [])
        .unwrap();
    db.db
        .execute(
            "UPDATE sqlite_sequence SET seq=37 WHERE name='model_references'",
            [],
        )
        .unwrap();
    (root, db, run, reference)
}

fn index_rows(db: &Connection) -> BTreeMap<String, Vec<Vec<rusqlite::types::Value>>> {
    let mut result = BTreeMap::new();
    for table in TABLES {
        let mut statement = db
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let columns = statement.column_count();
        let rows = statement
            .query_map([], |row| {
                (0..columns)
                    .map(|column| row.get(column))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        result.insert(table.to_owned(), rows);
    }
    let sequence: i64 = db
        .query_row(
            "SELECT seq FROM sqlite_sequence WHERE name='model_references'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    result.insert(
        "reference_allocation_high_water".into(),
        vec![vec![sequence.into()]],
    );
    result
}

fn marker(db: &Connection) -> i64 {
    db.pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap()
}
fn epoch(db: &Connection) -> i64 {
    db.query_row("SELECT epoch FROM runtime_meta", [], |row| row.get(0))
        .unwrap()
}
fn upgrade_events(db: &Connection) -> i64 {
    db.query_row(
        "SELECT count(*) FROM events WHERE kind='catalog.upgraded'",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn supported_generations_include_both_published_catalog_92_layouts() {
    for from in 78..=FORMAT {
        assert!(upgrades::supports(from), "source {from}");
    }
    for from in [0, 77, FORMAT + 1] {
        assert!(!upgrades::supports(from), "source {from}");
    }
    for (from, retained) in [(90, true), (91, false), (92, false), (92, true), (93, true)] {
        let (root, db, run, reference) = seed();
        let history = db.history("main").unwrap();
        let space = db.model_reference_space().unwrap();
        let execution = db.execution_reference(&run.run_id).unwrap();
        let rows = retained.then(|| index_rows(&db.db));
        if !retained {
            db.db.execute_batch(DROP_INDEX).unwrap();
            db.db.execute_batch(DROP_COLUMNS).unwrap();
        }
        db.db.pragma_update(None, "user_version", from).unwrap();
        drop(db);
        let bodies = root.bodies();
        let db = root.open();
        assert_eq!(marker(&db.db), FORMAT);
        assert_eq!(db.history("main").unwrap(), history);
        assert_eq!(root.bodies(), bodies);
        assert_eq!(db.execution_reference(&run.run_id).unwrap(), execution);
        assert_eq!(upgrade_events(&db.db), 1);
        if let Some(rows) = rows {
            assert_eq!(db.model_reference_space().unwrap(), space);
            assert_eq!(index_rows(&db.db), rows);
            assert_eq!(
                db.resolve_model_reference(ReferenceKind::File, &reference)
                    .unwrap()
                    .target["path"],
                "kept"
            );
            assert_eq!(
                db.register_model_reference(
                    ReferenceKind::File,
                    "original-owner",
                    &json!({"path":"next"}),
                    &run.run_id
                )
                .unwrap(),
                "file:38"
            );
        }
        let space = db.model_reference_space().unwrap();
        drop(db);
        let db = root.open();
        assert_eq!(db.model_reference_space().unwrap(), space);
        assert_eq!(
            upgrade_events(&db.db),
            1,
            "reopen must not repeat conversion"
        );
    }
}

#[test]
fn catalog_partial_or_malformed_reference_indexes_are_read_only_rejections() {
    let mut corruptions: Vec<String> = TABLES
        .iter()
        .map(|table| format!("DROP TABLE {table};"))
        .collect();
    corruptions.extend([
        "ALTER TABLE external_items DROP COLUMN kind;".into(),
        "ALTER TABLE external_items DROP COLUMN tool_status;".into(),
        DROP_INDEX.into(),
        format!("{DROP_INDEX} ALTER TABLE external_items DROP COLUMN kind;"),
        format!("{DROP_INDEX} ALTER TABLE external_items DROP COLUMN tool_status;"),
        "ALTER TABLE model_agents DROP COLUMN high_water;".into(),
        "UPDATE model_agents SET high_water=0;".into(),
        "UPDATE model_agents SET high_water='bad';".into(),
        "UPDATE model_agents SET high_water=1.5;".into(),
        "UPDATE model_executions SET kind='unknown';".into(),
        "UPDATE model_executions SET kind='external_turn';".into(),
        "UPDATE model_executions SET identity='';".into(),
        "UPDATE model_executions SET sequence=1.5; UPDATE model_execution_aliases SET sequence=1.5;".into(),
        "UPDATE model_execution_aliases SET kind='unknown';".into(),
        "UPDATE model_execution_aliases SET kind='external_turn';".into(),
        "UPDATE model_execution_aliases SET identity='';".into(),
        "UPDATE model_bound_targets SET original='not json';".into(),
        "UPDATE model_bound_targets SET target='not json';".into(),
        "UPDATE model_bound_targets SET operation_id='';".into(),
        "UPDATE model_bound_targets SET purpose='';".into(),
        "DELETE FROM sqlite_sequence WHERE name='model_references';".into(),
        "UPDATE sqlite_sequence SET seq='bad' WHERE name='model_references';".into(),
        "UPDATE sqlite_sequence SET seq=0 WHERE name='model_references';".into(),
        "UPDATE sqlite_sequence SET seq=1.5 WHERE name='model_references';".into(),
        "INSERT INTO sqlite_sequence(name,seq) VALUES('model_references',37);".into(),
        "UPDATE model_reference_space SET space_id='';".into(),
        "UPDATE model_references SET target='not json';".into(),
        "UPDATE model_execution_aliases SET sequence=999;".into(),
        format!("{DROP_INDEX}{DROP_COLUMNS} CREATE VIEW model_reference_space AS SELECT 1 AS id,'fake' AS space_id;"),
        format!("{DROP_INDEX}{DROP_COLUMNS} CREATE INDEX model_reference_holder_lookup ON events(kind);"),
        format!("{DROP_INDEX}{DROP_COLUMNS} CREATE VIEW model_reference_holder_lookup AS SELECT 1;"),
    ]);
    for version in [92, 93, FORMAT] {
        for sql in &corruptions {
            let (root, db, _, _) = seed();
            db.db.execute_batch(sql).unwrap();
            db.db.pragma_update(None, "user_version", version).unwrap();
            let original_epoch = epoch(&db.db);
            drop(db);
            let bytes = std::fs::read(root.0.join("conversation.sqlite")).unwrap();
            let bodies = root.bodies();
            assert!(
                Catalog::open(&root.0).is_err(),
                "Catalog {version} must reject {sql}"
            );
            assert_eq!(
                std::fs::read(root.0.join("conversation.sqlite")).unwrap(),
                bytes,
                "Catalog {version} must not rewrite {sql}"
            );
            assert_eq!(root.bodies(), bodies);
            let raw = root.raw();
            assert_eq!(marker(&raw), version);
            assert_eq!(epoch(&raw), original_epoch);
            assert_eq!(upgrade_events(&raw), 0);
        }
    }
}

#[test]
fn catalog_92_upgrade_failure_rolls_back_both_layouts_then_retries_once() {
    for retained in [false, true] {
        let (root, db, run, _) = seed();
        let history = db.history("main").unwrap();
        let rows = retained.then(|| index_rows(&db.db));
        if !retained {
            db.db.execute_batch(DROP_INDEX).unwrap();
            db.db.execute_batch(DROP_COLUMNS).unwrap();
        }
        db.db.pragma_update(None, "user_version", 92).unwrap();
        db.db.execute_batch("CREATE TRIGGER fail_reference_upgrade BEFORE INSERT ON events WHEN NEW.kind='catalog.upgraded' BEGIN SELECT RAISE(ABORT,'reference upgrade interrupted'); END;").unwrap();
        let original_epoch = epoch(&db.db);
        drop(db);
        let bodies = root.bodies();
        let error = Catalog::open(&root.0)
            .err()
            .expect("upgrade must roll back");
        assert!(matches!(
            error,
            RuntimeError::Upgrade {
                from: 92,
                to: FORMAT,
                ..
            }
        ));
        assert!(error.to_string().contains("reference upgrade interrupted"));
        let raw = root.raw();
        assert_eq!(marker(&raw), 92);
        assert_eq!(epoch(&raw), original_epoch);
        assert_eq!(upgrade_events(&raw), 0);
        assert_eq!(root.bodies(), bodies);
        check_optional_format(&raw).unwrap();
        if let Some(rows) = &rows {
            assert_eq!(&index_rows(&raw), rows);
        } else {
            assert!(!existing_index(&raw).unwrap());
            assert_eq!(external_index_columns(&raw).unwrap(), 0);
        }
        raw.execute_batch("DROP TRIGGER fail_reference_upgrade")
            .unwrap();
        drop(raw);
        let db = root.open();
        assert_eq!(marker(&db.db), FORMAT);
        assert_eq!(epoch(&db.db), original_epoch + 1);
        assert_eq!(upgrade_events(&db.db), 1);
        assert_eq!(db.history("main").unwrap(), history);
        assert_eq!(db.execution_reference(&run.run_id).unwrap().sequence, 1);
        assert_eq!(root.bodies(), bodies);
        if let Some(rows) = rows {
            assert_eq!(index_rows(&db.db), rows);
        }
    }
}

#[test]
fn current_or_newer_catalog_never_accepts_quote_only_reference_layout() {
    for version in [93, FORMAT, FORMAT + 1] {
        let (root, db, _, _) = seed();
        db.db.execute_batch(DROP_INDEX).unwrap();
        db.db.execute_batch(DROP_COLUMNS).unwrap();
        db.db.pragma_update(None, "user_version", version).unwrap();
        drop(db);
        let bytes = std::fs::read(root.0.join("conversation.sqlite")).unwrap();
        assert!(Catalog::open(&root.0).is_err());
        assert_eq!(
            std::fs::read(root.0.join("conversation.sqlite")).unwrap(),
            bytes
        );
        assert_eq!(marker(&root.raw()), version);
    }
}

#[test]
fn empty_reference_indexes_preserve_valid_allocator_states_and_json_targets() {
    for version in [92, 93, FORMAT] {
        for high_water in [None, Some(0), Some(37)] {
            let root = Fixture::new();
            let mut db = root.open();
            assert_eq!(
                db.db
                    .query_row(
                        "SELECT count(*) FROM sqlite_sequence WHERE name='model_references'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap(),
                0
            );
            if let Some(high_water) = high_water {
                db.db
                    .execute(
                        "INSERT INTO sqlite_sequence(name,seq) VALUES('model_references',?1)",
                        [high_water],
                    )
                    .unwrap();
            }
            // Frozen selections accept any JSON value, including projection arrays.
            // Preflight validates their encoding, not a narrower invented object schema.
            let original = json!("original selection");
            let target = json!(["fixed", 1, null]);
            db.freeze_model_target("original-operation", "projection", &original, &target)
                .unwrap();
            db.db.pragma_update(None, "user_version", version).unwrap();
            let space = db.model_reference_space().unwrap();
            drop(db);
            let db = root.open();
            assert_eq!(db.model_reference_space().unwrap(), space);
            assert_eq!(
                db.model_target("original-operation", "projection", &original)
                    .unwrap(),
                Some(target)
            );
            assert_eq!(
                db.db
                    .query_row(
                        "SELECT seq FROM sqlite_sequence WHERE name='model_references'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()
                    .unwrap(),
                high_water
            );
            let next = db
                .register_model_reference(
                    ReferenceKind::File,
                    "owner",
                    &json!({"path":"next"}),
                    "holder",
                )
                .unwrap();
            assert_eq!(next, format!("file:{}", high_water.unwrap_or(0) + 1));
        }
    }
}
