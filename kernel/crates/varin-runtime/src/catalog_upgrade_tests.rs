use super::*;
use std::{collections::BTreeMap, path::PathBuf};

struct Fixture(PathBuf);
impl Fixture {
    fn v78() -> Self {
        let fixture = Self(std::env::temp_dir().join(format!("varin-catalog-upgrade-{}", id())));
        std::fs::create_dir_all(&fixture.0).unwrap();
        let db = fixture.raw();
        db.execute_batch(include_str!("../tests/fixtures/catalog-v78.sql"))
            .unwrap();
        let content = crate::content::ContentStore::open(fixture.0.join("content")).unwrap();
        let configuration = content.save(&json!({"provider":"original-model"})).unwrap();
        let provider = Some(ProviderOriginal {
            connection_identity: "original-connection".into(),
            adapter: "responses".into(),
            version: "1".into(),
            item: json!({"encrypted_content":"opaque","signature":[null,42]}),
        });
        let history = content
            .save_history(&json!({"text":"历史回答"}), &provider)
            .unwrap();
        let queued = content
            .save_user_history("queued", &json!({"text":"待发送的消息"}))
            .unwrap();
        db.execute_batch("UPDATE runtime_meta SET epoch=17;
            INSERT INTO threads(id,agent_code,title,pinned) VALUES('thread','a78bc9','原来的对话',1);
            INSERT INTO branches(id,thread_id,head,active_run) VALUES('main','thread','history','run');
            INSERT INTO branches(id,thread_id,head) VALUES('fork','thread','history');
            INSERT INTO events(cursor,subject,revision,kind,data) VALUES(1,'run',1,'run.accepted','{}');").unwrap();
        // Persist the released generation's JSON, not current DTOs relabelled as an old version.
        let run = json!({"id":"run","thread_id":"thread","branch_id":"main","state":"executing","revision":6,"epoch":17,"configuration":configuration,"cancel_requested":false,"waiting_on":null});
        db.execute(
            "INSERT INTO runs(id,branch_id,body) VALUES('run','main',?1)",
            [encode(&run).unwrap()],
        )
        .unwrap();
        let item = json!({"id":"history","thread_id":"thread","run_id":"run","parent":null,"source":"assistant","content":history,"provider":null});
        db.execute(
            "INSERT INTO history(id,thread_id,run_id,body) VALUES('history','thread','run',?1)",
            [encode(&item).unwrap()],
        )
        .unwrap();
        let queue = json!({"id":"queued","thread_id":"thread","branch_id":"main","run_id":"run","mode":"boundary","state":"queued","revision":1,"cursor":1,"origin":{"kind":"user_ingress"},"activation":"activating","delivered_cursor":null});
        db.execute("INSERT INTO input_queue(id,branch_id,run_id,mode,state,cursor,origin,activation,body) VALUES('queued','main','run','boundary','queued',1,'user','activating',?1)", [encode(&queue).unwrap()]).unwrap();
        db.execute(
            "INSERT INTO input_history_content(input_id,body) VALUES('queued',?1)",
            [encode(&queued).unwrap()],
        )
        .unwrap();
        db.execute_batch("INSERT INTO commands VALUES('original-command','{\"intent\":\"kept\"}','{\"receipt\":\"original\"}');").unwrap();
        let operation = json!({"id":"effect","run_id":"run","epoch":17,"revision":2,"phase":"running","outcome":null,"effect":"dispatched","cancel_requested":false,"lifetime":"run","handed_off":false,"executor":"original-executor","execution_owner":{"kind":"external","identity":"worker","epoch":"original"},"waiting_on":null,"intent":{"click":"button"},"result":null,"external_receipt":null,"call_completion":null});
        db.execute(
            "INSERT INTO operations(id,run_id,body) VALUES('effect','run',?1)",
            [encode(&operation).unwrap()],
        )
        .unwrap();
        fixture
    }
    /// The released v79 generation: v78 plus its own committed conversion, with a settled
    /// original receipt from before the usage ledger existed.
    fn v79() -> Self {
        let fixture = Self::v78();
        let content = crate::content::ContentStore::open(fixture.0.join("content")).unwrap();
        let request = content.save(&json!({"view":"original request"})).unwrap();
        let step = json!({"id":"settled","run_id":"run","epoch":17,"state":"completed","request":request,"original":[],
            "usage":{"measurement":"actual","input_tokens":5,"output_tokens":2,"cached_input_tokens":null,"pricing_version":null}});
        let mut raw = fixture.raw();
        let tx = raw.transaction().unwrap();
        external::initialize_new(&tx).unwrap();
        tx.execute(
            "INSERT INTO model_steps(id,run_id,state,body) VALUES('settled','run','completed',?1)",
            [encode(&step).unwrap()],
        )
        .unwrap();
        tx.pragma_update(None, "user_version", 79).unwrap();
        tx.commit().unwrap();
        fixture
    }
    fn v80() -> Self {
        let fixture=Self::v79();
        let mut raw=fixture.raw();
        let tx=raw.transaction().unwrap();
        usage_ledger::initialize(&tx).unwrap();
        tx.pragma_update(None,"user_version",80).unwrap();
        tx.commit().unwrap();
        fixture
    }
    fn raw(&self) -> Connection {
        Connection::open(self.0.join("conversation.sqlite")).unwrap()
    }
    fn bodies(&self) -> BTreeMap<PathBuf, Vec<u8>> {
        fn walk(root: &Path, dir: &Path, result: &mut BTreeMap<PathBuf, Vec<u8>>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(root, &path, result);
                } else {
                    result.insert(
                        path.strip_prefix(root).unwrap().into(),
                        std::fs::read(path).unwrap(),
                    );
                }
            }
        }
        let mut result = BTreeMap::new();
        walk(&self.0, &self.0.join("content"), &mut result);
        result
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn catalog_upgrade_v78_preserves_history_queue_receipts_and_effect_fencing() {
    let fixture = Fixture::v78();
    let original_bodies = fixture.bodies();
    let raw = fixture.raw();
    let original_history: String = raw
        .query_row("SELECT body FROM history", [], |row| row.get(0))
        .unwrap();
    let original_queue: String = raw
        .query_row("SELECT body FROM input_queue", [], |row| row.get(0))
        .unwrap();
    drop(raw);

    let mut catalog = Catalog::open(&fixture.0).unwrap();
    assert_eq!(catalog.epoch(), 18);
    assert_eq!(inspect_catalog_format(&catalog.db).unwrap(), FORMAT);
    assert_eq!(catalog.head("main").unwrap().as_deref(), Some("history"));
    assert_eq!(
        catalog.history("main").unwrap(),
        catalog.history("fork").unwrap()
    );
    let history = catalog.history("main").unwrap();
    assert_eq!(history[0].content["text"], "历史回答");
    assert_eq!(
        history[0].provider.as_ref().unwrap().item["signature"],
        json!([null, 42])
    );
    let queued = catalog
        .capture_queued_input("queued")
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(queued.content["text"], "待发送的消息");
    assert_eq!(queued.state, InputState::Queued);
    assert_eq!(
        catalog
            .db
            .query_row(
                "SELECT agent_code,title,pinned FROM threads WHERE id='thread'",
                [],
                |row| Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?
                ))
            )
            .unwrap(),
        ("a78bc9".into(), "原来的对话".into(), true)
    );
    assert_eq!(
        catalog
            .db
            .query_row("SELECT body FROM history", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        original_history
    );
    assert_eq!(
        catalog
            .db
            .query_row("SELECT body FROM input_queue", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        original_queue
    );
    assert_eq!(
        catalog
            .db
            .query_row(
                "SELECT receipt FROM commands WHERE id='original-command'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "{\"receipt\":\"original\"}"
    );
    let effect = catalog.operation("effect").unwrap();
    assert_eq!(effect.epoch, 17);
    assert_eq!(effect.outcome, Some(Outcome::Indeterminate));
    assert_eq!(effect.effect, Effect::Unknown);
    assert!(
        catalog
            .dispatch_operation("effect", catalog.epoch(), "another-executor", true)
            .is_err()
    );
    let prepared = catalog
        .prepare_external(external::ExternalCommand::Settings)
        .load()
        .unwrap();
    assert_eq!(
        catalog.execute_external(prepared).unwrap().load().unwrap(),
        json!({"revision":0,"defaultAgent":null,"agents":[]})
    );
    assert_eq!(fixture.bodies(), original_bodies);
    drop(catalog);

    let reopened = Catalog::open(&fixture.0).unwrap();
    assert_eq!(
        reopened
            .db
            .query_row(
                "SELECT count(*) FROM events WHERE kind='catalog.upgraded'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(reopened.history("main").unwrap(), history);
    assert_eq!(fixture.bodies(), original_bodies);
}

#[test]
fn catalog_upgrade_sql_failure_rolls_back_and_reopen_retries() {
    let fixture = Fixture::v78();
    let bodies = fixture.bodies();
    fixture.raw().execute_batch("CREATE TRIGGER fail_upgrade BEFORE INSERT ON events WHEN NEW.kind='catalog.upgraded' BEGIN SELECT RAISE(ABORT,'fixture upgrade failure'); END;").unwrap();
    let error = Catalog::open(&fixture.0).err().expect("upgrade must fail");
    assert!(matches!(
        error,
        RuntimeError::Upgrade {
            from: 78,
            to: FORMAT,
            ..
        }
    ));
    assert!(error.to_string().contains("fixture upgrade failure"));
    let raw = fixture.raw();
    assert_eq!(inspect_catalog_format(&raw).unwrap(), 78);
    assert_eq!(
        raw.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name LIKE 'external_%' OR name LIKE 'usage_%'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        raw.query_row("SELECT epoch FROM runtime_meta", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        17
    );
    assert_eq!(fixture.bodies(), bodies);
    raw.execute_batch("DROP TRIGGER fail_upgrade").unwrap();
    drop(raw);
    assert_eq!(Catalog::open(&fixture.0).unwrap().epoch(), 18);
}

#[test]
fn catalog_upgrade_process_interruption_retries_from_committed_wal() {
    const ENV: &str = "VARIN_TEST_INTERRUPTED_CATALOG_UPGRADE";
    if let Some(root) = std::env::var_os(ENV) {
        let mut raw = Connection::open(PathBuf::from(root).join("conversation.sqlite")).unwrap();
        raw.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0; PRAGMA cache_size=1;
            INSERT INTO commands VALUES('before-crash','{}','{\"accepted\":true}');").unwrap();
        apply_before_commit(&mut raw, 78, |_| std::process::exit(42)).unwrap();
        panic!("interruption hook did not run");
    }
    let fixture = Fixture::v78();
    let bodies = fixture.bodies();
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "catalog::upgrades::tests::catalog_upgrade_process_interruption_retries_from_committed_wal", "--nocapture"])
        .env(ENV, &fixture.0)
        .output().unwrap();
    assert_eq!(
        child.status.code(),
        Some(42),
        "{}",
        String::from_utf8_lossy(&child.stderr)
    );
    assert!(
        std::fs::metadata(fixture.0.join("conversation.sqlite-wal"))
            .unwrap()
            .len()
            > 32
    );
    let catalog = Catalog::open(&fixture.0).unwrap();
    assert_eq!(catalog.epoch(), 18);
    assert_eq!(inspect_catalog_format(&catalog.db).unwrap(), FORMAT);
    assert_eq!(
        catalog
            .db
            .query_row(
                "SELECT receipt FROM commands WHERE id='before-crash'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "{\"accepted\":true}"
    );
    assert_eq!(
        catalog
            .db
            .query_row(
                "SELECT count(*) FROM events WHERE kind='catalog.upgraded'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(catalog.operation("effect").unwrap().effect, Effect::Unknown);
    assert_eq!(fixture.bodies(), bodies);
}

fn ledger_start(db: &Connection) -> u64 {
    db.query_row(
        "SELECT recording_started_at_ms FROM usage_ledger WHERE id=1",
        [],
        |row| read_number(row, 0),
    )
    .unwrap()
}

#[test]
fn catalog_upgrade_v79_starts_an_empty_usage_ledger_with_its_format_marker() {
    let fixture = Fixture::v79();
    let before = threads::now_ms().unwrap();
    let catalog = Catalog::open(&fixture.0).unwrap();
    let after = threads::now_ms().unwrap();
    assert_eq!(inspect_catalog_format(&catalog.db).unwrap(), FORMAT);
    let started = ledger_start(&catalog.db);
    assert!((before..=after).contains(&started));
    // Earlier receipts have no settle time or attribution, so the ledger is not backfilled.
    assert_eq!(
        catalog
            .db
            .query_row("SELECT count(*) FROM usage_records", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        catalog
            .db
            .query_row(
                "SELECT json_extract(body,'$.usage.input_tokens') FROM model_steps WHERE id='settled'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        5
    );
    let summary = catalog
        .capture_usage_summary(&usage_ledger::UsageSummaryParams {
            from_ms: started - 1,
            to_ms: started + 86_400_000,
            utc_offset_minutes: 0, days: vec![], current_prices: vec![] })
        .unwrap()
        .load(&|| false)
        .unwrap();
    assert_eq!(
        (summary.recording_started_at_ms, summary.rows.len()),
        (Some(started), 0)
    );
    drop(catalog);

    let preflight = Connection::open_with_flags(
        fixture.0.join("conversation.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(inspect_catalog_format(&preflight).unwrap(), FORMAT);
    drop(preflight);
    let reopened = Catalog::open(&fixture.0).unwrap();
    assert_eq!(ledger_start(&reopened.db), started);
    assert_eq!(
        reopened
            .db
            .query_row(
                "SELECT count(*) FROM events WHERE kind='catalog.upgraded' AND json_extract(data,'$.from')=79 AND json_extract(data,'$.to')=81",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[test]
fn new_catalog_installs_the_usage_ledger_and_rejects_a_store_missing_its_start() {
    let fixture = Fixture(std::env::temp_dir().join(format!("varin-catalog-new-{}", id())));
    let catalog = Catalog::open(&fixture.0).unwrap();
    assert_eq!(inspect_catalog_format(&catalog.db).unwrap(), FORMAT);
    let started = ledger_start(&catalog.db);
    drop(catalog);
    assert_eq!(ledger_start(&Catalog::open(&fixture.0).unwrap().db), started);

    fixture
        .raw()
        .execute("DELETE FROM usage_ledger", [])
        .unwrap();
    assert!(Catalog::open(&fixture.0).is_err());
    assert_eq!(
        fixture
            .raw()
            .query_row("SELECT count(*) FROM usage_ledger", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn catalog_upgrade_v80_initializes_capture_owner_without_rewriting_original_bodies() {
    let fixture=Fixture::v80();
    let bodies=fixture.bodies();
    let raw=fixture.raw();
    let original:Vec<(String,String)>=raw.prepare("SELECT id,body FROM input_queue ORDER BY id").unwrap().query_map([],|r|Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<std::result::Result<_,_>>().unwrap();
    drop(raw);
    let catalog=Catalog::open(&fixture.0).unwrap();
    assert_eq!(inspect_catalog_format(&catalog.db).unwrap(),81);
    let queue:Vec<(String,String)>=catalog.db.prepare("SELECT id,body FROM input_queue ORDER BY id").unwrap().query_map([],|r|Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<std::result::Result<_,_>>().unwrap();
    assert_eq!(queue,original);
    assert_eq!(fixture.bodies(),bodies);
    assert_eq!(catalog.db.query_row("SELECT count(*) FROM context_observation_captures",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(catalog.db.query_row("SELECT count(*) FROM context_observation_imports",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(catalog.db.query_row("SELECT count(*) FROM events WHERE kind='catalog.upgraded' AND json_extract(data,'$.from')=80 AND json_extract(data,'$.to')=81",[],|r|r.get::<_,i64>(0)).unwrap(),1);
}
