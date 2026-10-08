use super::*;
use serde_json::json;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("varin-content-review-{}", uuid::Uuid::new_v4())))
    }
    fn store(&self) -> ContentStore {
        ContentStore::open(self.0.clone()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn db() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE model_steps(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE history(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE model_outputs(request_id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE input_queue(id TEXT PRIMARY KEY,body TEXT NOT NULL)")
        .unwrap();
    db
}
fn collection_db() -> Connection {
    let db = db();
    db.execute_batch(
        "CREATE TABLE input_history_content(input_id TEXT PRIMARY KEY,body TEXT NOT NULL)",
    )
    .unwrap();
    db
}
fn chunks(store: &ContentStore, reference: &Value) -> Vec<String> {
    let manifest: Manifest = serde_json::from_slice(
        &store
            .read_bytes(reference["content_object"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    manifest.chunks
}
fn large_request() -> Value {
    json!({"request_id":"same-request", "history":(0..12000).map(|i| json!({"id":i,"opaque":{"signature":format!("sig-{i:08x}"),"encrypted":[null,i,true]},"text":format!("entry-{i:08x}-汉字") })).collect::<Vec<_>>()})
}
#[test]
fn immutable_request_roundtrip_and_appended_history_reuse_existing_chunks() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let original = large_request();
    let first = store.save(&original).unwrap();
    assert_eq!(first, store.save(&original).unwrap());
    assert_eq!(store.load(&first).unwrap(), original);
    let mut appended = original.clone();
    appended["history"]
        .as_array_mut()
        .unwrap()
        .push(json!({"opaque":{"unknown":["keep",null,3]},"text":"next"}));
    let second = store.save(&appended).unwrap();
    let before = chunks(&store, &first);
    let after = chunks(&store, &second);
    assert!(before.len() > 1);
    assert!(
        before.iter().any(|hash| after.contains(hash)),
        "appending must reuse unchanged durable chunks"
    );
    drop(store);
    let reopened = fixture.store();
    assert_eq!(reopened.load(&first).unwrap(), original);
    assert_eq!(reopened.load(&second).unwrap(), appended);
    assert!(serde_json::to_vec(&first).unwrap().len() < 256);
}
#[test]
fn garbage_collection_keeps_all_live_chunks_and_removes_only_orphans() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let live = store.save(&large_request()).unwrap();
    let orphan = store
        .save(&json!({"orphan":"uncommitted content"}))
        .unwrap();
    let db = collection_db();
    db.execute(
        "INSERT INTO model_steps VALUES('live',?1)",
        [json!({"request":live}).to_string()],
    )
    .unwrap();
    assert!(store.collect(&db).unwrap() > 0);
    assert_eq!(store.load(&live).unwrap(), large_request());
    assert!(store.load(&orphan).is_err());
    assert_eq!(store.collect(&db).unwrap(), 0);
}
#[test]
fn corrupt_or_missing_live_object_aborts_sweep_before_deleting_other_objects() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let live = store.save(&large_request()).unwrap();
    let orphan = store
        .save(&json!({"uncommitted":"keep on failed mark"}))
        .unwrap();
    let db = collection_db();
    db.execute(
        "INSERT INTO model_steps VALUES('live',?1)",
        [json!({"request":live}).to_string()],
    )
    .unwrap();
    let path = object_path(&fixture.0, &chunks(&store, &live)[0]).unwrap();
    fs::write(&path, b"corrupt").unwrap();
    assert!(store.load(&live).is_err());
    assert!(store.collect(&db).is_err());
    assert_eq!(
        store.load(&orphan).unwrap(),
        json!({"uncommitted":"keep on failed mark"})
    );
    fs::remove_file(path).unwrap();
    assert!(store.collect(&db).is_err());
    assert!(store.load(&orphan).is_ok());
}
#[test]
fn failed_inline_conversion_preserves_every_original_row_and_format_marker() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let mut db = db();
    let original = json!({"id":"first","run_id":"run","epoch":1,"state":"prepared","request":large_request(),"original":[],"usage":null}).to_string();
    db.execute("INSERT INTO model_steps VALUES('first',?1)", [&original])
        .unwrap();
    db.execute("INSERT INTO model_steps VALUES('invalid','{}')", [])
        .unwrap();
    assert!(initialize(&mut db, &store).is_err());
    assert_eq!(
        db.query_row("SELECT body FROM model_steps WHERE id='first'", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        original
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='runtime_content_format'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    db.execute("DELETE FROM model_steps WHERE id='invalid'", [])
        .unwrap();
    initialize(&mut db, &store).unwrap();
    let converted: Value = serde_json::from_str(
        &db.query_row("SELECT body FROM model_steps WHERE id='first'", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
    )
    .unwrap();
    assert_eq!(store.load(&converted["request"]).unwrap(), large_request());
    initialize(&mut db, &store).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM runtime_content_format", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn migration_database_failure_rolls_back_earlier_reference_updates() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let mut db = db();
    for id in ["a", "b"] {
        let body = json!({"id":id,"run_id":"run","epoch":1,"state":"prepared","request":{"opaque":[id,null,{"signature":"keep"}]},"original":[],"usage":null}).to_string();
        db.execute("INSERT INTO model_steps VALUES(?1,?2)", params![id, body])
            .unwrap();
    }
    db.execute_batch("CREATE TRIGGER fail_second BEFORE UPDATE ON model_steps WHEN NEW.id='b' BEGIN SELECT RAISE(ABORT,'injected persistence failure'); END;").unwrap();
    assert!(initialize(&mut db, &store).is_err());
    for id in ["a", "b"] {
        let raw: String = db
            .query_row("SELECT body FROM model_steps WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .unwrap();
        let body: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            body["request"],
            json!({"opaque":[id,null,{"signature":"keep"}]})
        );
    }
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='runtime_content_format'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    db.execute_batch("DROP TRIGGER fail_second").unwrap();
    initialize(&mut db, &store).unwrap();
    assert_eq!(store.collect(&db).unwrap(), 0);
}

#[test]
fn content_format_marker_mismatch_never_reinterprets_existing_references() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let mut db = db();
    initialize(&mut db, &store).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    db.pragma_update(None, "user_version", 1).unwrap();
    assert!(initialize(&mut db, &store).is_err());
    db.pragma_update(None, "user_version", 3).unwrap();
    db.execute_batch("DROP TABLE runtime_content_format")
        .unwrap();
    assert!(initialize(&mut db, &store).is_err());
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='runtime_content_format'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn gc_removes_abandoned_staging_only_after_successful_mark() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let live = store.save(&json!({"opaque":"preserve"})).unwrap();
    let db = collection_db();
    db.execute(
        "INSERT INTO model_steps VALUES('live',?1)",
        [json!({"request":live}).to_string()],
    )
    .unwrap();
    let abandoned = fixture
        .0
        .join("staging")
        .join(uuid::Uuid::new_v4().to_string());
    let unknown = fixture.0.join("staging").join("user-note.txt");
    fs::write(&abandoned, b"partial immutable object").unwrap();
    fs::write(&unknown, b"not ours").unwrap();
    let manifest = object_path(&fixture.0, live["content_object"].as_str().unwrap()).unwrap();
    let intact = fs::read(&manifest).unwrap();
    fs::write(&manifest, b"corrupt").unwrap();
    assert!(store.collect(&db).is_err());
    assert!(abandoned.exists());
    fs::write(&manifest, intact).unwrap();
    store.collect(&db).unwrap();
    assert!(!abandoned.exists());
    assert!(unknown.exists());
    assert_eq!(store.load(&live).unwrap(), json!({"opaque":"preserve"}));
}

#[test]
fn version_two_upgrade_preserves_existing_request_refs_and_all_new_gc_roots() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let mut db = db();
    let request = json!({"request_id":"same","opaque":[null,{"signed":"request"}]});
    let request_ref = store.save(&request).unwrap();
    let original = json!({"signed":"provider original","unknown":[2,null]});
    let history = json!({"text":"visible","opaque":[{"unknown":[null,true]}]});
    let provider = json!({"connection_identity":"bound","adapter":"fixture","version":"1","item":{"signature":"history-signature"}});
    let output = json!({"status":"rejected","record":{"items":[{"encrypted":"output"}],"usage":{"raw":{"unknown":17}}}});
    let queued =
        json!({"text":"queued","attachments":[{"content_ref":"keep","media_type":"image/png"}]});
    db.execute_batch("PRAGMA user_version=2; CREATE TABLE runtime_content_format(id INTEGER PRIMARY KEY,version INTEGER NOT NULL); INSERT INTO runtime_content_format VALUES(1,1)").unwrap();
    db.execute("INSERT INTO model_steps VALUES('step',?1)",[json!({"request":request_ref,"original":[{"item":original,"connection_identity":"bound"}],"future_metadata":{"keep":true}}).to_string()]).unwrap();
    db.execute(
        "INSERT INTO history VALUES('entry',?1)",
        [json!({"content":history,"provider":provider,"future_metadata":[1,2]}).to_string()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO model_outputs VALUES('step',?1)",
        [output.to_string()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO input_queue VALUES('queued',?1)",
        [json!({"content":queued}).to_string()],
    )
    .unwrap();
    initialize(&mut db, &store).unwrap();
    let read = |sql: &str| -> Value {
        serde_json::from_str(&db.query_row(sql, [], |r| r.get::<_, String>(0)).unwrap()).unwrap()
    };
    let step = read("SELECT body FROM model_steps");
    assert_eq!(step["request"], request_ref);
    assert_eq!(step["future_metadata"], json!({"keep":true}));
    assert_eq!(store.load(&step["request"]).unwrap(), request);
    assert_eq!(store.load(&step["original"][0]["item"]).unwrap(), original);
    let stored_history = read("SELECT body FROM history");
    assert_eq!(stored_history["future_metadata"], json!([1, 2]));
    assert_eq!(
        store.load(&stored_history["content"]).unwrap(),
        json!({"content":history,"provider":provider})
    );
    let output_ref = read("SELECT body FROM model_outputs");
    let queued_ref = read("SELECT body FROM input_history_content");
    store.save(&json!({"orphan":"delete only this"})).unwrap();
    assert!(store.collect(&db).unwrap() > 0);
    assert_eq!(store.load(&output_ref).unwrap(), output);
    assert_eq!(
        store.load(&queued_ref).unwrap(),
        json!({"content":queued,"provider":null})
    );
    assert_eq!(store.load(&step["original"][0]["item"]).unwrap(), original);
    initialize(&mut db, &store).unwrap();
    assert_eq!(store.collect(&db).unwrap(), 0);
}
