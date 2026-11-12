use super::*;
use std::{collections::BTreeMap, path::PathBuf};

const AT_MS: i64 = 1_793_491_200_000;

struct Fixture {
    root: PathBuf,
    reference: Value,
}
impl Fixture {
    fn v89() -> Self { Self::at_version(89) }
    fn v90() -> Self { Self::at_version(90) }
    fn at_version(version: i64) -> Self {
        assert!(matches!(version, 89 | 90));
        let root = std::env::temp_dir().join(format!("varin-usage-recovery-{}", Uuid::new_v4()));
        let mut catalog = Catalog::open(&root).unwrap();
        catalog.create_thread("thread", "main").unwrap();
        let reference = catalog
            .content
            .save(&json!({"original":"retained provider body"}))
            .unwrap();
        let run = json!({"id":"run","thread_id":"thread","branch_id":"main","state":"completed",
            "revision":7,"epoch":catalog.epoch(),"configuration":reference,"cancel_requested":false,"waiting_on":null});
        catalog
            .db
            .execute(
                "INSERT INTO runs(id,branch_id,body) VALUES('run','main',?1)",
                [encode(&run).unwrap()],
            )
            .unwrap();
        // Seed the unchanged v89/v90 accounting layout with its historical wire receipts, not a new
        // execution that already contains the repaired provider normalization.
        let mut effect = operation(
            "effect",
            json!({"kind":"fixture_effect","original":"already performed"}),
            Value::Null,
        );
        effect["effect"] = json!("confirmed");
        effect["outcome"] = json!("succeeded");
        catalog
            .db
            .execute(
                "INSERT INTO operations(id,run_id,body) VALUES('effect','run',?1)",
                [encode(&effect).unwrap()],
            )
            .unwrap();
        catalog.db.execute("INSERT INTO commands(id,intent,receipt) VALUES('original-command','original intent','original receipt')", []).unwrap();
        if version < 95 { crate::catalog::organization::remove_for_legacy_fixture(&catalog.db); }
        catalog.db.pragma_update(None, "user_version", version).unwrap();
        drop(catalog);
        Self { root, reference }
    }
    fn raw(&self) -> Connection {
        Connection::open(self.root.join("conversation.sqlite")).unwrap()
    }
    fn step(&self, id: &str, family: &str, write: Value) -> Value {
        json!({"id":id,"run_id":"run","epoch":1,"state":"completed","request":self.reference,"original":[],
            "usage":receipt(write),"frozen_usage":{"kind":"conversation","attribution":attribution(family)}})
    }
    fn planning(&self, id: &str, family: &str, write: Value) -> Value {
        operation(
            id,
            json!({"kind":"policy_model_job_v1","action_id":id,
            "boundary":{"id":"boundary","history_range":{"branch_id":"main","ancestor_id":null,"leaf_id":null},
                "goal":null,"resource_checkpoint_id":null,"source":null},
            "identity":{"name":"original-policy","version":"1"},"body_ref":self.reference}),
            json!({"kind":"control","value":{"goal":null,"dispatch":"completed","request_ref":self.reference,
                "original_ref":self.reference,"usage_attribution":attribution(family),
                "receipt":{"dispatch":"completed","outcome":"failed","output":null,"usage":receipt(write),
                    "finish_reason":null,"failure":null,"usable":false}}}),
        )
    }
    fn insert(&self, table: &str, id: &str, body: &Value, ledger: bool) {
        let db = self.raw();
        if table == "model_steps" {
            db.execute(
                "INSERT INTO model_steps(id,run_id,state,body) VALUES(?1,'run','completed',?2)",
                params![id, encode(body).unwrap()],
            )
            .unwrap();
        } else {
            db.execute(
                "INSERT INTO operations(id,run_id,body) VALUES(?1,'run',?2)",
                params![id, encode(body).unwrap()],
            )
            .unwrap();
        }
        if ledger {
            let (record_id, kind, attribution) = if table == "model_steps" {
                (
                    step_record_id(id),
                    "conversation",
                    &body["frozen_usage"]["attribution"],
                )
            } else {
                (
                    operation_record_id(id),
                    "planning",
                    &body["result"]["value"]["usage_attribution"],
                )
            };
            db.execute("INSERT INTO usage_records(id,at_ms,kind,purpose,owner_thread_id,thread_id,branch_id,run_id,provider_id,provider_family,model_id,body) VALUES(?1,?2,?3,NULL,'thread','thread','main','run','channel',?4,'gpt-fixture',?5)",
                params![record_id, AT_MS, kind, attribution["providerFamily"].as_str(), encode(&ledger_body()).unwrap()]).unwrap();
        }
    }
    fn content(&self) -> BTreeMap<PathBuf, Vec<u8>> {
        fn walk(root: &Path, path: &Path, entries: &mut BTreeMap<PathBuf, Vec<u8>>) {
            for entry in std::fs::read_dir(path).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(root, &path, entries);
                } else {
                    entries.insert(
                        path.strip_prefix(root).unwrap().to_owned(),
                        std::fs::read(&path).unwrap(),
                    );
                }
            }
        }
        let mut entries = BTreeMap::new();
        walk(&self.root, &self.root.join("content"), &mut entries);
        entries
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn operation(id: &str, intent: Value, result: Value) -> Value {
    json!({"id":id,"run_id":"run","epoch":1,"revision":3,"phase":"terminal","outcome":"failed",
        "effect":"none","cancel_requested":false,"lifetime":"run","handed_off":false,
        "executor":if id == "effect" {"fixture-executor"} else {"policy-model.v1"},"execution_owner":{"kind":"kernel"},
        "waiting_on":null,"intent":intent,"result":result,"external_receipt":null,"call_completion":null})
}
fn pricing() -> Value {
    json!({"currency":"USD","billing":"metered","source":"custom","version":"original-frozen-price",
        "inputPerMillion":2.0,"outputPerMillion":10.0,"cacheReadPerMillion":0.1,"cacheWritePerMillion":2.5})
}
fn attribution(family: &str) -> Value {
    json!({"providerId":"channel","providerFamily":family,"model":"gpt-fixture","connectionIdentity":"original-connection","pricing":pricing()})
}
fn receipt(write: Value) -> Value {
    json!({"measurement":"actual","input_tokens":1000,"output_tokens":20,"cached_input_tokens":400,
        "cache_write_tokens":null,"reasoning_tokens":5,"pricing_version":"original-receipt-version",
        "raw":{"input_tokens":1000,"output_tokens":20,"input_tokens_details":{"cached_tokens":400,
            "cache_write_tokens":write,"cache_write_tokens_details":{"ttl30m":100,"ttl12h":100}},
            "output_tokens_details":{"reasoning_tokens":5},"vendor_detail":{"retained":[1,"original",null]}}})
}
fn ledger_body() -> Value {
    json!({"measurement":"actual","inputTokens":1000,"outputTokens":20,"cachedInputTokens":400,
        "cacheWriteTokens":null,"reasoningTokens":5,"completeInputTokens":1000,"reasoningInOutput":true,"pricing":pricing()})
}
fn body(db: &Connection, table: &str, id: &str) -> Value {
    let value: String = db
        .query_row(
            &format!("SELECT body FROM {table} WHERE id=?1"),
            [id],
            |row| row.get(0),
        )
        .unwrap();
    serde_json::from_str(&value).unwrap()
}
fn put_body(db: &Connection, table: &str, id: &str, body: &Value) {
    db.execute(
        &format!("UPDATE {table} SET body=?1 WHERE id=?2"),
        params![encode(body).unwrap(), id],
    )
    .unwrap();
}
fn ledger_identity(db: &Connection) -> Vec<String> {
    db.prepare("SELECT json_array(id,at_ms,kind,purpose,owner_thread_id,thread_id,branch_id,run_id,provider_id,provider_family,model_id) FROM usage_records ORDER BY id").unwrap()
        .query_map([], |row| row.get(0)).unwrap().collect::<std::result::Result<_, _>>().unwrap()
}
fn count(db: &Connection, sql: &str) -> i64 {
    db.query_row(sql, [], |row| row.get(0)).unwrap()
}

#[test]
fn responses_cache_write_upgrade_reopens_v89_and_preserves_original_accounting() {
    assert_recovers_original_accounting(Fixture::v89());
}

#[test]
fn responses_cache_write_upgrade_reopens_v90_and_preserves_original_accounting() {
    assert_recovers_original_accounting(Fixture::v90());
}

fn assert_recovers_original_accounting(fixture: Fixture) {
    let mut expected = Vec::new();
    for (id, family, writes) in [
        ("responses", "openai-responses", 200),
        ("azure", "azure-openai-responses", 0),
        ("codex", "openai-codex-responses", 100),
    ] {
        let mut step = fixture.step(id, family, json!(writes));
        fixture.insert("model_steps", id, &step, true);
        step["usage"]["cache_write_tokens"] = json!(writes);
        expected.push((id, step, writes));
    }
    let mut planning = fixture.planning("planning", "openai-responses", json!(300));
    fixture.insert("operations", "planning", &planning, true);
    planning["result"]["value"]["receipt"]["usage"]["cache_write_tokens"] = json!(300);
    let raw = fixture.raw();
    let identities = ledger_identity(&raw);
    let started = count(&raw, "SELECT recording_started_at_ms FROM usage_ledger");
    let effect = body(&raw, "operations", "effect");
    let events = count(&raw, "SELECT count(*) FROM events");
    let content = fixture.content();
    drop(raw);

    let catalog = Catalog::open(&fixture.root).unwrap();
    assert_eq!(count(&catalog.db, "PRAGMA user_version"), FORMAT);
    for (id, step, writes) in &expected {
        assert_eq!(body(&catalog.db, "model_steps", id), *step);
        let mut ledger = ledger_body();
        ledger["cacheWriteTokens"] = json!(writes);
        assert_eq!(
            body(&catalog.db, "usage_records", &step_record_id(id)),
            ledger
        );
    }
    let recovered_planning = body(&catalog.db, "operations", "planning");
    planning["epoch"] = recovered_planning["epoch"].clone(); // Normal Catalog recovery owns its epoch.
    assert_eq!(recovered_planning, planning);
    let mut ledger = ledger_body();
    ledger["cacheWriteTokens"] = json!(300);
    assert_eq!(
        body(&catalog.db, "usage_records", "operation:planning"),
        ledger
    );
    assert_eq!(ledger_identity(&catalog.db), identities);
    assert_eq!(
        count(
            &catalog.db,
            "SELECT recording_started_at_ms FROM usage_ledger"
        ),
        started
    );
    assert_eq!(body(&catalog.db, "operations", "effect"), effect);
    assert_eq!(
        count(&catalog.db, "SELECT count(*) FROM events"),
        events + 1
    );
    assert_eq!(count(&catalog.db, "SELECT count(*) FROM commands WHERE id='original-command' AND intent='original intent' AND receipt='original receipt'"), 1);
    assert_eq!(fixture.content(), content);
    let summary = catalog
        .capture_usage_summary(&UsageSummaryParams {
            from_ms: AT_MS as u64,
            to_ms: (AT_MS + 1) as u64,
            utc_offset_minutes: 0,
            days: vec![],
            current_prices: vec![],
        })
        .unwrap()
        .load(&|| false)
        .unwrap();
    assert_eq!(summary.rows.iter().map(|row| row.requests).sum::<u64>(), 4);
    assert_eq!(
        summary
            .rows
            .iter()
            .map(|row| row.cost_unknown_requests)
            .sum::<u64>(),
        0
    );
    // Four inclusive-input receipts: 4 * (600 * $2 + 400 * $0.1 + 20 * $10),
    // with 600 explicitly reported writes replacing ordinary input at +$0.5 / million.
    assert!((summary.rows.iter().map(|row| row.cost_usd).sum::<f64>() - 0.00606).abs() < 1e-12);
    drop(catalog);

    let reopened = Catalog::open(&fixture.root).unwrap();
    assert_eq!(
        count(
            &reopened.db,
            "SELECT count(*) FROM events WHERE kind='catalog.upgraded'"
        ),
        1
    );
    assert_eq!(ledger_identity(&reopened.db), identities);
    for (id, step, _) in expected {
        assert_eq!(body(&reopened.db, "model_steps", id), step);
    }
    assert_eq!(fixture.content(), content);
}

#[test]
fn responses_cache_write_upgrade_requires_exact_evidence_and_preserves_known_counts() {
    let fixture = Fixture::v89();
    let mut unchanged = Vec::new();
    for (id, raw) in [
        ("missing", Value::Null),
        ("negative", json!(-1)),
        ("fractional", json!(1.5)),
        ("string", json!("200")),
    ] {
        let step = fixture.step(id, "openai-responses", raw);
        fixture.insert("model_steps", id, &step, true);
        unchanged.push((id, step));
    }
    for id in [
        "no-raw",
        "legacy-missing",
        "estimated",
        "different-family",
        "known-conflict",
        "payload-run-mismatch",
    ] {
        let mut step = fixture.step(id, "openai-responses", json!(200));
        match id {
            "no-raw" => step["usage"]["raw"] = Value::Null,
            "legacy-missing" => {
                step["usage"]["raw"]["input_tokens_details"]
                    .as_object_mut()
                    .unwrap()
                    .remove("cache_write_tokens");
            }
            "estimated" => step["usage"]["measurement"] = json!("estimated"),
            "different-family" => {
                step["frozen_usage"]["attribution"]["providerFamily"] = json!("anthropic-messages")
            }
            "known-conflict" => step["usage"]["cache_write_tokens"] = json!(7),
            "payload-run-mismatch" => step["run_id"] = json!("other-run"),
            _ => unreachable!(),
        }
        fixture.insert("model_steps", id, &step, true);
        unchanged.push((id, step));
    }
    let mut repaired_sources = Vec::new();
    for id in [
        "wrong-ledger-run",
        "wrong-ledger-family",
        "wrong-ledger-model",
        "wrong-ledger-kind",
        "wrong-ledger-provider",
        "wrong-ledger-count",
        "wrong-ledger-complete-input",
        "known-ledger",
    ] {
        let mut step = fixture.step(id, "openai-responses", json!(200));
        fixture.insert("model_steps", id, &step, true);
        step["usage"]["cache_write_tokens"] = json!(200);
        repaired_sources.push((id, step));
    }
    let raw = fixture.raw();
    for (id, field, value) in [
        ("wrong-ledger-run", "run_id", "other-run"),
        (
            "wrong-ledger-family",
            "provider_family",
            "openai-completions",
        ),
        ("wrong-ledger-model", "model_id", "other-model"),
        ("wrong-ledger-kind", "kind", "auxiliary"),
        ("wrong-ledger-provider", "provider_id", "other-channel"),
    ] {
        raw.execute(
            &format!("UPDATE usage_records SET {field}=?1 WHERE id=?2"),
            params![value, step_record_id(id)],
        )
        .unwrap();
    }
    for (id, field, value) in [
        ("wrong-ledger-count", "inputTokens", 1001),
        ("wrong-ledger-complete-input", "completeInputTokens", 1100),
        ("known-ledger", "cacheWriteTokens", 7),
    ] {
        let mut ledger = body(&raw, "usage_records", &step_record_id(id));
        ledger[field] = json!(value);
        put_body(&raw, "usage_records", &step_record_id(id), &ledger);
    }
    let existing_ledgers: Vec<_> = unchanged
        .iter()
        .chain(&repaired_sources)
        .map(|(id, _)| (*id, body(&raw, "usage_records", &step_record_id(id))))
        .collect();
    drop(raw);
    let mut known = fixture.step("known-same", "openai-responses", json!(200));
    known["usage"]["cache_write_tokens"] = json!(200);
    fixture.insert("model_steps", "known-same", &known, true);
    let mut no_ledger = fixture.step("no-ledger", "openai-responses", json!(200));
    fixture.insert("model_steps", "no-ledger", &no_ledger, false);
    no_ledger["usage"]["cache_write_tokens"] = json!(200);
    let mut wide = fixture.step("unsigned", "openai-responses", json!(u64::MAX));
    fixture.insert("model_steps", "unsigned", &wide, true);
    wide["usage"]["cache_write_tokens"] = json!(u64::MAX);
    let identities = ledger_identity(&fixture.raw());

    let catalog = Catalog::open(&fixture.root).unwrap();
    for (id, step) in unchanged.into_iter().chain(repaired_sources) {
        assert_eq!(body(&catalog.db, "model_steps", id), step, "{id}");
    }
    for (id, ledger) in existing_ledgers {
        assert_eq!(
            body(&catalog.db, "usage_records", &step_record_id(id)),
            ledger,
            "{id}"
        );
    }
    assert_eq!(body(&catalog.db, "model_steps", "known-same"), known);
    assert_eq!(
        body(&catalog.db, "usage_records", "model_step:known-same")["cacheWriteTokens"],
        200
    );
    assert_eq!(body(&catalog.db, "model_steps", "no-ledger"), no_ledger);
    assert_eq!(
        count(
            &catalog.db,
            "SELECT count(*) FROM usage_records WHERE id='model_step:no-ledger'"
        ),
        0
    );
    assert_eq!(body(&catalog.db, "model_steps", "unsigned"), wide);
    assert_eq!(
        body(&catalog.db, "usage_records", "model_step:unsigned")["cacheWriteTokens"],
        json!(u64::MAX)
    );
    assert_eq!(ledger_identity(&catalog.db), identities);
    let summary = catalog
        .capture_usage_summary(&UsageSummaryParams {
            from_ms: AT_MS as u64,
            to_ms: (AT_MS + 1) as u64,
            utc_offset_minutes: 0,
            days: vec![],
            current_prices: vec![],
        })
        .unwrap()
        .load(&|| false)
        .unwrap();
    assert_eq!(summary.rows.iter().map(|row| row.requests).sum::<u64>(), 20);
    // Only the preserved known ledger and the consistently known source can be priced.
    // In particular, u64::MAX stays reported evidence but cannot become a billable amount
    // when it exceeds inclusive input; pricing must return unknown without overflowing.
    assert_eq!(
        summary
            .rows
            .iter()
            .map(|row| row.cost_unknown_requests)
            .sum::<u64>(),
        18
    );
    assert!(summary
        .rows
        .iter()
        .all(|row| row.cost_usd.is_finite() && row.cost_usd >= 0.0));
}

#[test]
fn responses_cache_write_upgrade_rolls_back_with_format_and_retries_without_replaying_effects() {
    assert_atomic_recovery(Fixture::v89());
}

#[test]
fn responses_cache_write_v90_upgrade_rolls_back_without_replaying_effects() {
    assert_atomic_recovery(Fixture::v90());
}

fn assert_atomic_recovery(fixture: Fixture) {
    let step = fixture.step("request", "openai-responses", json!(200));
    let planning = fixture.planning("planning", "openai-responses", json!(300));
    fixture.insert("model_steps", "request", &step, true);
    fixture.insert("operations", "planning", &planning, true);
    let raw = fixture.raw();
    let original_format = count(&raw, "PRAGMA user_version");
    let epoch = count(&raw, "SELECT epoch FROM runtime_meta");
    let identities = ledger_identity(&raw);
    let effect = body(&raw, "operations", "effect");
    let content = fixture.content();
    raw.execute_batch("CREATE TRIGGER fail_cache_upgrade BEFORE INSERT ON events WHEN NEW.kind='catalog.upgraded' BEGIN SELECT RAISE(ABORT,'fixture cache upgrade failure'); END;").unwrap();
    drop(raw);
    let error = Catalog::open(&fixture.root)
        .err()
        .expect("upgrade must fail atomically");
    assert!(matches!(
        error,
        RuntimeError::Upgrade {
            from,
            to: FORMAT,
            ..
        } if from == original_format
    ));
    assert!(error.to_string().contains("fixture cache upgrade failure"));
    let raw = fixture.raw();
    assert_eq!(count(&raw, "PRAGMA user_version"), original_format);
    assert_eq!(count(&raw, "SELECT epoch FROM runtime_meta"), epoch);
    assert_eq!(body(&raw, "model_steps", "request"), step);
    assert_eq!(body(&raw, "operations", "planning"), planning);
    assert_eq!(
        body(&raw, "usage_records", "model_step:request"),
        ledger_body()
    );
    assert_eq!(
        body(&raw, "usage_records", "operation:planning"),
        ledger_body()
    );
    assert_eq!(ledger_identity(&raw), identities);
    assert_eq!(body(&raw, "operations", "effect"), effect);
    assert_eq!(
        count(
            &raw,
            "SELECT count(*) FROM events WHERE kind='catalog.upgraded'"
        ),
        0
    );
    assert_eq!(fixture.content(), content);
    raw.execute_batch("DROP TRIGGER fail_cache_upgrade")
        .unwrap();
    drop(raw);
    let catalog = Catalog::open(&fixture.root).unwrap();
    assert_eq!(count(&catalog.db, "PRAGMA user_version"), FORMAT);
    assert_eq!(
        body(&catalog.db, "usage_records", "model_step:request")["cacheWriteTokens"],
        200
    );
    assert_eq!(
        body(&catalog.db, "usage_records", "operation:planning")["cacheWriteTokens"],
        300
    );
    assert_eq!(body(&catalog.db, "operations", "effect"), effect);
    assert_eq!(fixture.content(), content);
}
