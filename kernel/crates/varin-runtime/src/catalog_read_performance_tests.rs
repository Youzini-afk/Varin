//! Real Catalog read workloads. Synthetic history/operations reuse owner-created metadata and
//! immutable content; fixture construction is outside the measured read, never production code.
use super::*;
use crate::test_submission::InputAdmission;
use std::time::Instant;

fn vm_steps(db: &mut Catalog, read: impl FnOnce(&Catalog)) -> usize {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    db.db
        .progress_handler(
            1,
            Some(move || {
                counter.fetch_add(1, Ordering::Relaxed);
                false
            }),
        )
        .unwrap();
    read(db);
    db.db.progress_handler(0, None::<fn() -> bool>).unwrap();
    calls.load(Ordering::Relaxed)
}

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("varin-catalog-reads-{}", id())))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn populate(db: &mut Catalog, threads: usize, old_operations: usize, history: usize) -> Receipt {
    db.create_thread("seed", "seed-main").unwrap();
    let receipt = db
        .submit(&SubmitInput {
            key: "seed-input".into(),
            thread_id: "seed".into(),
            branch_id: "seed-main".into(),
            expected_head: None,
            input: json!({"text":"原始消息 retained immutable content"}),
            configuration: json!({}),
        })
        .unwrap();
    let mut run = db.run(&receipt.run_id).unwrap();
    let mut operation = db
        .admit_operation(
            "seed-active",
            &run.id,
            db.epoch(),
            Lifetime::Run,
            json!({"kind":"fixture"}),
        )
        .unwrap();
    operation.phase = OperationPhase::Terminal;
    operation.outcome = Some(Outcome::Succeeded);
    let mut item: HistoryItem = record(&db.db, "history", &receipt.input_id).unwrap();
    for n in 0..threads {
        db.create_thread(&format!("thread-{n:04}"), &format!("branch-{n:04}"))
            .unwrap();
    }
    let tx = db.db.transaction().unwrap();
    for n in 0..old_operations {
        operation.id = format!("old-{n:06}");
        tx.execute(
            "INSERT INTO operations(id,run_id,body) VALUES(?1,?2,?3)",
            params![operation.id, operation.run_id, encode(&operation).unwrap()],
        )
        .unwrap();
    }
    for n in 0..threads {
        run.thread_id = format!("thread-{n:04}");
        run.branch_id = format!("branch-{n:04}");
        run.state = RunState::Completed;
        for r in 0..8 {
            run.id = format!("run-{n:04}-{r}");
            tx.execute(
                "INSERT INTO runs(id,branch_id,body) VALUES(?1,?2,?3)",
                params![run.id, run.branch_id, encode(&run).unwrap()],
            )
            .unwrap();
            operation.run_id = run.id.clone();
            for o in 0..16 {
                operation.id = format!("op-{n:04}-{r}-{o:02}");
                tx.execute(
                    "INSERT INTO operations(id,run_id,body) VALUES(?1,?2,?3)",
                    params![operation.id, operation.run_id, encode(&operation).unwrap()],
                )
                .unwrap();
            }
        }
    }
    for n in 0..history {
        item.parent = Some(item.id.clone());
        item.id = format!("history-{n:06}");
        tx.execute(
            "INSERT INTO history(id,thread_id,parent,run_id,body) VALUES(?1,?2,?3,?4,?5)",
            params![
                item.id,
                item.thread_id,
                item.parent,
                item.run_id,
                encode(&item).unwrap()
            ],
        )
        .unwrap();
    }
    tx.execute(
        "UPDATE branches SET head=?1 WHERE id='seed-main'",
        [&item.id],
    )
    .unwrap();
    tx.commit().unwrap();
    receipt
}

fn measure(name: &str, mut read: impl FnMut()) {
    let cold = Instant::now();
    read();
    let first_us = cold.elapsed().as_micros();
    let mut samples = Vec::new();
    for _ in 0..21 {
        let start = Instant::now();
        read();
        samples.push(start.elapsed().as_micros());
    }
    samples.sort_unstable();
    eprintln!(
        "{name}: first_us={first_us} warm_n=21 median_us={} p95_us={}",
        samples[10], samples[19]
    );
}

#[test]
#[ignore = "manual synthetic read latency measurement; no wall-clock assertion"]
fn measure_catalog_read_hotpaths() {
    let fixture = Fixture::new();
    let mut db = Catalog::open(&fixture.0).unwrap();
    populate(&mut db, 128, 8192, 8192);
    eprintln!("Catalog fixture: 129 Threads, 1025 Runs, 24577 Operations (1 active), 8193 history items; first reads are process-warm, not disk-cold");
    measure("catalog_all", || {
        assert_eq!(
            db.list_thread_catalog(&threads::ThreadListQuery::default())
                .unwrap()
                .len(),
            129
        );
    });
    measure("catalog_search_one", || {
        let query = threads::ThreadListQuery {
            query: Some("THREAD-0064".into()),
            ..Default::default()
        };
        let rows = db.list_thread_catalog(&query).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["thread_id"], "thread-0064");
    });
    measure("active_operations", || {
        let operations = db
            .active_thread_operations("seed", Some("seed-main"))
            .unwrap();
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].id, "seed-active");
    });
    measure("history_recent_64", || {
        let page = db.history_page("seed-main", None, None, 64).unwrap();
        assert_eq!(page.items.len(), 64);
        assert_eq!(page.items.last().unwrap().id, "history-008191");
    });
    measure("history_anchored_64", || {
        let page = db
            .history_page(
                "seed-main",
                Some("history-000511"),
                Some("history-000255"),
                64,
            )
            .unwrap();
        assert_eq!(page.items.len(), 64);
        assert_eq!(page.items.last().unwrap().id, "history-000254");
    });
    eprintln!(
        "catalog_all_vm_steps={}",
        vm_steps(&mut db, |db| {
            db.list_thread_catalog(&threads::ThreadListQuery::default())
                .unwrap();
        })
    );
    eprintln!(
        "inspect_seed_vm_steps={}",
        vm_steps(&mut db, |db| {
            db.inspect_thread("seed").unwrap();
        })
    );
    eprintln!(
        "inspect_other_vm_steps={}",
        vm_steps(&mut db, |db| {
            db.inspect_thread("thread-0064").unwrap();
        })
    );
    eprintln!(
        "active_operations_vm_steps={}",
        vm_steps(&mut db, |db| {
            db.active_thread_operations("seed", None).unwrap();
        })
    );
}

#[test]
fn active_operation_read_keeps_indeterminate_and_mcp_cleanup_semantics() {
    use super::mcp_resources::{McpResourceBinding, McpResourceSubscription};
    let fixture = Fixture::new();
    let mut db = Catalog::open(&fixture.0).unwrap();
    populate(&mut db, 1, 0, 0);
    let seed = db.operation("seed-active").unwrap();
    let mut expected = vec!["seed-active".to_string()];
    // Retained terminal receipts, indeterminate outcomes and resource cleanup are independent.
    for (id, outcome, effect, subscription, cancel, released, active) in [
        (
            "settled",
            Outcome::Succeeded,
            Effect::None,
            false,
            false,
            false,
            false,
        ),
        (
            "unknown-only",
            Outcome::Succeeded,
            Effect::Unknown,
            false,
            false,
            false,
            false,
        ),
        (
            "indeterminate",
            Outcome::Indeterminate,
            Effect::None,
            false,
            false,
            false,
            true,
        ),
        (
            "subscribed",
            Outcome::Succeeded,
            Effect::None,
            true,
            false,
            true,
            true,
        ),
        (
            "cleanup-pending",
            Outcome::Succeeded,
            Effect::None,
            true,
            true,
            false,
            true,
        ),
        (
            "released",
            Outcome::Succeeded,
            Effect::None,
            true,
            true,
            true,
            false,
        ),
    ] {
        let mut op = seed.clone();
        op.id = id.into();
        op.phase = OperationPhase::Terminal;
        op.outcome = Some(outcome);
        op.effect = effect;
        op.cancel_requested = cancel;
        if subscription {
            op.mcp_resource_subscription = Some(McpResourceSubscription {
                binding: McpResourceBinding {
                    operation_id: op.id.clone(),
                    execution_owner: ExecutorOwner::External {
                        identity: "fixture-host".into(),
                        epoch: "fixture-epoch".into(),
                    },
                    endpoint: host_jobs::McpEndpoint {
                        server: "fixture".into(),
                        resource_key: "resource".into(),
                        configuration_version: "1".into(),
                        credential_version: "1".into(),
                    },
                    schema_version: "1".into(),
                    uri: "fixture://resource".into(),
                },
                source_scope: launches::McpExecutionScope::Global,
                acceptance_ref: None,
                listener_id: None,
                availability: crate::McpResourceAvailability::Closed,
                local_released: released,
                mcp_holder_released: false,
                remote_cleanup: crate::McpResourceCleanup::Unknown,
                last_event_cursor: None,
                problem: None,
            });
        }
        db.db
            .execute(
                "INSERT INTO operations(id,run_id,body) VALUES(?1,?2,?3)",
                params![op.id, op.run_id, encode(&op).unwrap()],
            )
            .unwrap();
        if active {
            expected.push(op.id);
        }
    }
    expected.sort();
    for branch in [None, Some("seed-main")] {
        let actual = db
            .active_thread_operations("seed", branch)
            .unwrap()
            .into_iter()
            .map(|op| op.id)
            .collect::<Vec<_>>();
        assert_eq!(actual, expected);
    }
    assert!(db
        .active_thread_operations("seed", Some("branch-0000"))
        .unwrap()
        .is_empty());
    let mut settled = seed;
    settled.phase = OperationPhase::Terminal;
    settled.outcome = Some(Outcome::Succeeded);
    db.db
        .execute(
            "UPDATE operations SET body=?2 WHERE id=?1",
            params![settled.id, encode(&settled).unwrap()],
        )
        .unwrap();
    assert!(!db
        .active_thread_operations("seed", None)
        .unwrap()
        .iter()
        .any(|op| op.id == "seed-active"));
}

#[test]
fn active_operation_read_work_does_not_grow_with_settled_receipts() {
    let fixture = Fixture::new();
    let mut db = Catalog::open(&fixture.0).unwrap();
    populate(&mut db, 0, 4096, 0);
    let steps = vm_steps(&mut db, |db| {
        let actual = db.active_thread_operations("seed", None).unwrap();
        assert_eq!(actual.len(), 1);
        assert_eq!(actual[0].id, "seed-active");
    });
    // Counts actual owner query work, not a timing threshold or an EXPLAIN/source-text proxy.
    assert!(
        steps < 500,
        "active read scanned retained operations: {steps} VM steps"
    );
}

#[test]
fn history_paging_keeps_snapshot_boundaries_cancellation_and_owner_fences() {
    let fixture = Fixture::new();
    let mut db = Catalog::open(&fixture.0).unwrap();
    let receipt = populate(&mut db, 0, 0, 128);
    let captured = db.capture_history_page("seed-main").unwrap();
    let appended = db
        .append_history(
            &receipt.run_id,
            db.epoch(),
            Some("history-000127"),
            HistorySource::Assistant,
            json!("new suffix"),
            None,
        )
        .unwrap();
    let page = captured.load(None, None, 2, &|| false).unwrap();
    assert_eq!(page.head.as_deref(), Some("history-000127"));
    assert_eq!(page.items.last().unwrap().id, "history-000127");
    let page = db
        .capture_history_page("seed-main")
        .unwrap()
        .load_since(
            Some("history-000063"),
            Some("history-000032"),
            Some("history-000028"),
            8,
            &|| false,
        )
        .unwrap();
    assert_eq!(
        page.items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        vec!["history-000029", "history-000030", "history-000031"]
    );
    assert!(page.previous.is_none());
    assert!(!page.boundary_reset);
    assert!(matches!(
        db.history_page("seed-main", Some("absent-head"), None, 8),
        Err(RuntimeError::Conflict(_))
    ));
    assert!(matches!(
        db.history_page("seed-main", Some("history-000063"), Some(&appended.id), 8),
        Err(RuntimeError::Conflict(_))
    ));
    assert!(matches!(
        db.capture_history_page("seed-main").unwrap().load_since(
            None,
            Some("history-000032"),
            Some("history-000064"),
            8,
            &|| false
        ),
        Err(RuntimeError::Conflict(_))
    ));
    let calls = std::cell::Cell::new(0);
    assert!(matches!(
        db.capture_history_page("seed-main").unwrap().load(
            Some("history-000016"),
            None,
            8,
            &|| {
                calls.set(calls.get() + 1);
                calls.get() == 20
            }
        ),
        Err(RuntimeError::DispatchCancelled)
    ));
    let reader = db.capture_history_page("seed-main").unwrap();
    drop(db);
    let _replacement = Catalog::open(&fixture.0).unwrap();
    assert!(matches!(
        reader.load(None, None, 8, &|| false),
        Err(RuntimeError::Conflict(_))
    ));
}
