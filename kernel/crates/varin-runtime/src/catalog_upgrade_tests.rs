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
            to: 79,
            ..
        }
    ));
    assert!(error.to_string().contains("fixture upgrade failure"));
    let raw = fixture.raw();
    assert_eq!(inspect_catalog_format(&raw).unwrap(), 78);
    assert_eq!(
        raw.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name LIKE 'external_%'",
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
