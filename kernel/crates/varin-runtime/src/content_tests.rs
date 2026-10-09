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
        "CREATE TABLE input_history_content(input_id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE operations(id TEXT PRIMARY KEY,body TEXT NOT NULL)",
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
fn unsupported_catalog_versions_preserve_original_database_and_content() {
    for version in [0, 1, 2, 3, 5] {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.0.join("content/objects")).unwrap();
        let sentinel=fixture.0.join("content/objects/original-user-content");
        fs::write(&sentinel,b"original bytes, do not convert").unwrap();
        let path=fixture.0.join("conversation.sqlite");
        let db=Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE original_rows(id TEXT PRIMARY KEY,body TEXT NOT NULL); INSERT INTO original_rows VALUES('retained','opaque original')").unwrap();
        db.pragma_update(None,"user_version",version).unwrap();
        drop(db);
        let original=fs::read(&path).unwrap();
        assert!(crate::Catalog::open(&fixture.0).is_err());
        assert_eq!(fs::read(&path).unwrap(),original,"unsupported format {version} was rewritten");
        assert_eq!(fs::read(&sentinel).unwrap(),b"original bytes, do not convert");
        assert!(!fixture.0.join("content/staging").exists(),"unsupported catalog must fail before content initialization");
        assert!(!fixture.0.join("conversation.sqlite-wal").exists());
    }
}

#[test]
fn content_format_marker_mismatch_never_reinterprets_existing_references() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let mut db = collection_db();
    db.execute_batch("PRAGMA user_version=4; CREATE TABLE runtime_content_format(id INTEGER PRIMARY KEY,version INTEGER NOT NULL); INSERT INTO runtime_content_format VALUES(1,3)").unwrap();
    initialize(&mut db, &store).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        crate::catalog::FORMAT
    );
    db.pragma_update(None, "user_version", 1).unwrap();
    assert!(initialize(&mut db, &store).is_err());
    db.pragma_update(None, "user_version", crate::catalog::FORMAT).unwrap();
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
fn current_format_gc_preserves_request_original_history_output_and_input_references() {
    let fixture=Fixture::new();let store=fixture.store();let mut db=collection_db();
    db.execute_batch("PRAGMA user_version=4; CREATE TABLE runtime_content_format(id INTEGER PRIMARY KEY,version INTEGER NOT NULL); INSERT INTO runtime_content_format VALUES(1,3)").unwrap();
    let request=json!({"request_id":"same","opaque":[null,{"signed":"request"}]});
    let original=json!({"signed":"provider original","unknown":[2,null]});
    let history=json!({"content":{"text":"visible"},"provider":{"signature":"keep"}});
    let output=json!({"status":"rejected","record":{"items":[{"encrypted":"output"}]}});
    let queued=json!({"content":{"text":"queued"},"provider":null});
    let request_ref=store.save(&request).unwrap();let original_ref=store.save(&original).unwrap();
    let history_ref=store.save(&history).unwrap();let output_ref=store.save(&output).unwrap();let queued_ref=store.save(&queued).unwrap();
    db.execute("INSERT INTO model_steps VALUES('step',?1)",[json!({"request":request_ref,"original":[{"item":original_ref}]}).to_string()]).unwrap();
    db.execute("INSERT INTO history VALUES('entry',?1)",[json!({"content":history_ref}).to_string()]).unwrap();
    db.execute("INSERT INTO model_outputs VALUES('step',?1)",[output_ref.to_string()]).unwrap();
    db.execute("INSERT INTO input_history_content VALUES('input',?1)",[queued_ref.to_string()]).unwrap();
    initialize(&mut db,&store).unwrap();
    store.save(&json!({"orphan":"remove only this"})).unwrap();assert!(store.collect(&db).unwrap()>0);
    for (reference,value) in [(request_ref,request),(original_ref,original),(history_ref,history),(output_ref,output),(queued_ref,queued)] {assert_eq!(store.load(&reference).unwrap(),value);}
    initialize(&mut db,&store).unwrap();assert_eq!(store.collect(&db).unwrap(),0);
}
