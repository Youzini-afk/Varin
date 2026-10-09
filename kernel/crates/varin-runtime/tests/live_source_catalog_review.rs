//! Independent admission and no-write format rejection counterexamples.
#[path="fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use varin_runtime::catalog::launches::LaunchSelection;
use varin_runtime::{Catalog, RunState, SubmitInput};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "varin-live-catalog-review-{}",
            uuid::Uuid::new_v4()
        )))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn source() -> Value {
    json!({"workspace_id":"workspace","execution_workspace_id":"execution","mode":"live_root","branch_id":null,"revision":null,"live_root":{"hostId":"host","canonicalRoot":"/fixture/root","rootId":"root"}})
}
fn selection(source: Value) -> LaunchSelection {
    serde_json::from_value(json!({"connection_identity":"fixture-connection","provider_family":"fixture","model":"fake-model","configuration_generation":1,"tool_schema_generation":1,"tools":[],"policy":{"name":"agent","version":"1"},"source":source})).unwrap()
}
fn command(db: &Catalog, key: &str) -> SubmitInput {
    SubmitInput {
        key: key.into(),
        thread_id: "thread".into(),
        branch_id: "main".into(),
        expected_head: db.head("main").unwrap(),
        input: json!({"text":key}),
        configuration: json!({}),
    }
}
fn files(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for item in std::fs::read_dir(dir).unwrap() {
            let path = item.unwrap().path();
            if path.is_dir() {
                walk(base, &path, out)
            } else {
                out.insert(
                    path.strip_prefix(base).unwrap().into(),
                    std::fs::read(path).unwrap(),
                );
            }
        }
    }
    let mut result = BTreeMap::new();
    walk(root, root, &mut result);
    result
}
fn preflight_rejects_without_writes(sql: &str) {
    let root = Temp::new();
    let mut db = Catalog::open(&root.0).unwrap();
    db.create_thread("thread", "main").unwrap();
    db.submit_with_launch(&command(&db, "preserve history"), Some(selection(source())))
        .unwrap();
    drop(db);
    let raw = Connection::open(root.0.join("conversation.sqlite")).unwrap();
    raw.execute_batch("PRAGMA journal_mode=DELETE;").unwrap();
    raw.execute_batch(sql).unwrap();
    let epoch: i64 = raw
        .query_row("SELECT epoch FROM runtime_meta WHERE id=1", [], |row| {
            row.get(0)
        })
        .unwrap();
    drop(raw);
    // This orphan is evidence that content recovery/cleanup never starts on rejected formats.
    std::fs::write(root.0.join("content/preserved-orphan"), b"do not sweep").unwrap();
    let before = files(&root.0);
    let error = match Catalog::open(&root.0) {
        Ok(_) => panic!("malformed launch catalog was accepted: {sql}"),
        Err(error) => error,
    };
    assert!(
        error.to_string().contains("launch"),
        "unexpected rejection: {error}"
    );
    assert!(
        files(&root.0) == before,
        "rejected preflight wrote catalog, WAL, content, or recovery assets"
    );
    let raw = Connection::open_with_flags(
        root.0.join("conversation.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        raw.query_row("SELECT epoch FROM runtime_meta WHERE id=1", [], |row| row
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        epoch
    );
}
#[test]
fn old_launch_domain_rejected_before_any_writes() {
    preflight_rejects_without_writes(
        "UPDATE runtime_domains SET version=1 WHERE name='run_launches';",
    );
}
#[test]
fn missing_launch_domain_rejected_before_any_writes() {
    preflight_rejects_without_writes("DELETE FROM runtime_domains WHERE name='run_launches';");
}
#[test]
fn missing_launch_table_rejected_before_any_writes() {
    preflight_rejects_without_writes("DROP TABLE run_launches;");
}
#[test]
fn malformed_launch_table_rejected_before_any_writes() {
    preflight_rejects_without_writes("ALTER TABLE run_launches ADD COLUMN shadow TEXT;");
}
#[test]
fn launch_table_without_run_foreign_key_is_rejected_before_any_writes() {
    preflight_rejects_without_writes("ALTER TABLE run_launches RENAME TO saved_launches; CREATE TABLE run_launches(id TEXT PRIMARY KEY,body TEXT NOT NULL); INSERT INTO run_launches SELECT * FROM saved_launches;");
}
#[test]
fn live_source_admission_rejects_contradictions_without_creating_history() {
    let root = Temp::new();
    let mut db = Catalog::open(&root.0).unwrap();
    db.create_thread("thread", "main").unwrap();
    let base = source();
    let mut invalid = Vec::new();
    for (key, value) in [
        ("branch_id", json!("branch")),
        ("revision", json!(0)),
        ("environment_run_id", json!("origin")),
        ("live_root", Value::Null),
        ("workspace_id", json!("")),
        ("execution_workspace_id", json!("")),
    ] {
        let mut s = base.clone();
        s[key] = value;
        invalid.push(s);
    }
    for key in ["hostId", "canonicalRoot", "rootId"] {
        let mut s = base.clone();
        s["live_root"][key] = json!("");
        invalid.push(s);
    }
    for mode in ["fixed_branch", "materialized"] {
        let mut s = base.clone();
        s["mode"] = json!(mode);
        s["branch_id"] = json!("branch");
        s["revision"] = json!(1);
        invalid.push(s);
    }
    let before = serde_json::to_value(db.events_after(0, 100).unwrap()).unwrap();
    for (n, s) in invalid.into_iter().enumerate() {
        assert!(
            db.submit_with_launch(&command(&db, &format!("invalid-{n}")), Some(selection(s)))
                .is_err(),
            "invalid source {n} admitted"
        );
        assert!(db.head("main").unwrap().is_none());
        assert!(db.history("main").unwrap().is_empty());
        assert_eq!(
            serde_json::to_value(db.events_after(0, 100).unwrap()).unwrap(),
            before
        );
    }
    let accepted = db
        .submit_with_launch(&command(&db, "valid"), Some(selection(base)))
        .unwrap();
    assert!(
        db.launch_intent(&accepted.run_id)
            .unwrap()
            .unwrap()
            .requires_rebind
    );
}
#[test]
fn live_descriptor_identity_is_frozen_across_reopen_and_exact_rebind() {
    let root = Temp::new();
    let mut db = Catalog::open(&root.0).unwrap();
    db.create_thread("thread", "main").unwrap();
    let chosen = selection(source());
    let run = db
        .submit_with_launch(&command(&db, "live"), Some(chosen.clone()))
        .unwrap();
    db.bind_launch(&run.run_id, chosen.clone()).unwrap();
    drop(db);
    let mut db = Catalog::open(&root.0).unwrap();
    assert!(
        db.launch_intent(&run.run_id)
            .unwrap()
            .unwrap()
            .requires_rebind
    );
    for key in ["hostId", "canonicalRoot", "rootId"] {
        let mut s = source();
        s["live_root"][key] = json!("changed");
        assert!(
            db.bind_launch(&run.run_id, selection(s)).is_err(),
            "changed {key} rebound"
        );
        assert_eq!(
            db.launch_intent(&run.run_id).unwrap().unwrap().selection,
            chosen
        );
    }
    for key in ["workspace_id", "execution_workspace_id"] {
        let mut s = source();
        s[key] = json!("changed");
        assert!(db.bind_launch(&run.run_id, selection(s)).is_err());
    }
    assert!(!db.bind_launch(&run.run_id, chosen).unwrap().requires_rebind);
}
#[test]
fn inherited_live_source_keeps_descriptor_without_materialized_lineage() {
    let root = Temp::new();
    let mut db = Catalog::open(&root.0).unwrap();
    db.create_thread("thread", "main").unwrap();
    let chosen = selection(source());
    let receipt = db
        .submit_with_launch(&command(&db, "first"), Some(chosen.clone()))
        .unwrap();
    let run = db.run(&receipt.run_id).unwrap();
    let run = db
        .transition_run(&run.id, run.epoch, run.revision, RunState::Runnable)
        .unwrap();
    db.transition_run(&run.id, run.epoch, run.revision, RunState::Completed)
        .unwrap();
    let mut next = chosen.clone();
    next.source = None;
    let receipt = db
        .submit_with_inherited_source(&command(&db, "second"), next)
        .unwrap();
    let saved = db
        .launch_intent(&receipt.run_id)
        .unwrap()
        .unwrap()
        .selection
        .source
        .unwrap();
    assert_eq!(Some(saved.clone()), chosen.source);
    assert!(saved.environment_run_id.is_none());
}

// A separate process exits without closing SQLite to leave a genuine committed, uncheckpointed WAL.
#[test]
#[ignore]
fn leave_old_launch_domain_in_wal() {
    let root =
        std::env::var_os("VARIN_REVIEW_WAL_ROOT").expect("only invoked by WAL preservation test");
    let raw = Connection::open(PathBuf::from(root).join("conversation.sqlite")).unwrap();
    raw.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE runtime_domains SET version=1 WHERE name='run_launches';").unwrap();
    std::process::exit(0);
}
#[test]
fn old_domain_in_uncheckpointed_wal_is_rejected_without_rewriting_durable_assets() {
    let root = Temp::new();
    let mut db = Catalog::open(&root.0).unwrap();
    db.create_thread("thread", "main").unwrap();
    db.submit_with_launch(
        &command(&db, "history retained in WAL fixture"),
        Some(selection(source())),
    )
    .unwrap();
    drop(db);
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "leave_old_launch_domain_in_wal", "--ignored"])
        .env("VARIN_REVIEW_WAL_ROOT", &root.0)
        .status()
        .unwrap();
    assert!(status.success());
    assert!(
        root.0
            .join("conversation.sqlite-wal")
            .metadata()
            .unwrap()
            .len()
            > 32
    );
    let durable = |root: &Path| {
        let mut snapshot = files(root);
        snapshot.remove(Path::new("conversation.sqlite-shm"));
        snapshot
    };
    let before = durable(&root.0);
    assert!(Catalog::open(&root.0).is_err());
    let after = durable(&root.0);
    let mut changed: Vec<_> = before
        .keys()
        .chain(after.keys())
        .filter(|key| before.get(*key) != after.get(*key))
        .collect();
    changed.sort();
    changed.dedup();
    assert!(
        changed.is_empty(),
        "rejected catalog changed durable assets: {changed:?}"
    );
}

#[test]
fn persisted_sources_require_explicit_live_root_field_in_every_mode() {
    for mode in ["live_root", "fixed_branch", "materialized"] {
        let root = Temp::new();
        let mut db = Catalog::open(&root.0).unwrap();
        db.create_thread("thread", "main").unwrap();
        let mut source = source();
        source["mode"] = json!(mode);
        if mode != "live_root" {
            source["live_root"] = Value::Null;
            source["branch_id"] = json!("immutable-branch");
            source["revision"] = json!(1);
        }
        let selected = selection(source);
        let receipt = db
            .submit_with_launch(&command(&db, mode), Some(selected.clone()))
            .unwrap();
        assert_eq!(
            db.launch_intent(&receipt.run_id)
                .unwrap()
                .unwrap()
                .selection,
            selected
        );
        let raw = Connection::open(root.0.join("conversation.sqlite")).unwrap();
        let body: String = raw
            .query_row(
                "SELECT body FROM run_launches WHERE id=?1",
                [&receipt.run_id],
                |row| row.get(0),
            )
            .unwrap();
        let mut malformed: Value = serde_json::from_str(&body).unwrap();
        malformed["selection"]["source"]
            .as_object_mut()
            .unwrap()
            .remove("live_root");
        let malformed = serde_json::to_string(&malformed).unwrap();
        raw.execute(
            "UPDATE run_launches SET body=?2 WHERE id=?1",
            rusqlite::params![receipt.run_id, malformed],
        )
        .unwrap();
        let error = db.launch_intent(&receipt.run_id).unwrap_err();
        assert!(error.to_string().contains("live_root"), "{mode}: {error}");
        assert_eq!(
            raw.query_row(
                "SELECT body FROM run_launches WHERE id=?1",
                [&receipt.run_id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            malformed,
            "reader must not repair omitted source identity"
        );
    }
}
