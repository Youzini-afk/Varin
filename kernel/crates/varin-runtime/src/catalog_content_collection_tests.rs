//! Deterministic races on the real worker boundary, without making maintenance a Run barrier.
use super::*;
use crate::content::{ContentCollection, ContentCollectionAdmission, collection::CollectionPoint};
use crate::test_submission::InputAdmission;
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::Duration;

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("varin-content-collection-{}", id())))
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn fixture_catalog(root: &Root) -> (Catalog, Receipt) {
    let mut catalog = Catalog::open(&root.0).unwrap();
    catalog.create_thread("thread", "main").unwrap();
    let receipt = catalog
        .submit(&SubmitInput {
            key: "input".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            expected_head: None,
            input: json!({"text":"retained input"}),
            configuration: json!({}),
        })
        .unwrap();
    (catalog, receipt)
}
fn ready(catalog: &Catalog, cancel: Arc<AtomicBool>) -> ContentCollection {
    match catalog.prepare_content_collection(cancel) {
        ContentCollectionAdmission::Ready(collection) => collection,
        ContentCollectionAdmission::Deferred(report) => panic!("unexpected deferral {report:?}"),
    }
}
fn pause(
    collection: ContentCollection,
    point: CollectionPoint,
) -> (
    mpsc::Sender<()>,
    std::thread::JoinHandle<ContentCollectionReport>,
) {
    let (arrived, wait) = mpsc::channel();
    let (resume, proceed) = mpsc::channel();
    let proceed = Mutex::new(proceed);
    let once = AtomicBool::new(false);
    let collection = collection.with_hook(Arc::new(move |observed| {
        if observed == point && !once.swap(true, Ordering::AcqRel) {
            arrived.send(()).unwrap();
            proceed
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(15))
                .unwrap();
        }
    }));
    let worker = std::thread::spawn(move || collection.run());
    wait.recv_timeout(Duration::from_secs(15))
        .expect("worker reached actual collection work");
    (resume, worker)
}
fn finished(
    resume: mpsc::Sender<()>,
    worker: std::thread::JoinHandle<ContentCollectionReport>,
) -> ContentCollectionReport {
    resume.send(()).unwrap();
    worker.join().unwrap()
}

#[test]
fn roots_verification_and_actual_unlink_leave_catalog_status_and_cancel_available() {
    for point in [
        CollectionPoint::Roots,
        CollectionPoint::Verify,
        CollectionPoint::ObjectRemoved,
    ] {
        let root = Root::new();
        let (catalog, input) = fixture_catalog(&root);
        catalog
            .content
            .save(&json!({"orphan":"never committed"}))
            .unwrap();
        let owner = Arc::new(Mutex::new(catalog));
        let collection = ready(&owner.lock().unwrap(), Arc::new(AtomicBool::new(false)));
        let (resume, worker) = pause(collection, point);
        {
            let mut catalog = owner
                .try_lock()
                .expect("GC cannot own Catalog during real scan/I/O");
            assert_eq!(
                catalog.run(&input.run_id).unwrap().state,
                RunState::Accepted
            );
            assert!(
                catalog
                    .request_cancel_run(&input.run_id)
                    .unwrap()
                    .cancel_requested
            );
            // Synchronous body-bearing fixture conveniences fail immediately, never wait for gate.
            assert!(matches!(
                catalog.history("main"),
                Err(RuntimeError::Conflict(_))
            ));
        }
        let report = finished(resume, worker);
        assert_eq!(report.status, ContentCollectionStatus::Completed);
        assert!(report.removed_objects > 0);
        assert!(
            owner
                .lock()
                .unwrap()
                .run(&input.run_id)
                .unwrap()
                .cancel_requested
        );
    }
}

#[test]
fn publication_that_finishes_during_mark_still_invalidates_the_old_live_set() {
    let root = Root::new();
    let (catalog, _) = fixture_catalog(&root);
    let owner = Arc::new(Mutex::new(catalog));
    let collection = ready(&owner.lock().unwrap(), Arc::new(AtomicBool::new(false)));
    let (resume, worker) = pause(collection, CollectionPoint::BeforeSweep);
    let prepared = owner.lock().unwrap().prepare_result_content();
    // Finish the complete content preparation and drop its pin before resuming the old scan.
    drop(
        prepared
            .write_result(&json!({"orphan":"new publication"}))
            .unwrap(),
    );
    let report = finished(resume, worker);
    assert_eq!(report.status, ContentCollectionStatus::Deferred);
    assert_eq!(report.reason.as_deref(), Some("publication_changed"));
    assert_eq!(report.removed_objects, 0);
    let next = ready(&owner.lock().unwrap(), Arc::new(AtomicBool::new(false))).run();
    assert_eq!(next.status, ContentCollectionStatus::Completed);
    assert!(
        next.removed_objects > 0,
        "completed publication count returned to zero"
    );
}

#[test]
fn sweep_yields_to_old_orphan_reuse_and_late_receipt_preserves_run_cancellation() {
    let root = Root::new();
    let (mut catalog, input) = fixture_catalog(&root);
    let epoch = catalog.epoch();
    let body = json!({"reused":"same previously orphaned body"});
    catalog.content.save(&body).unwrap();
    catalog
        .admit_operation(
            "receipt",
            &input.run_id,
            epoch,
            Lifetime::Run,
            json!({"kind":"read"}),
        )
        .unwrap();
    catalog
        .dispatch_operation("receipt", epoch, "read", false)
        .unwrap();
    let owner = Arc::new(Mutex::new(catalog));
    let collection = ready(&owner.lock().unwrap(), Arc::new(AtomicBool::new(false)));
    let (resume, collector) = pause(collection, CollectionPoint::ObjectRemoved);
    let preparation = owner.lock().unwrap().prepare_result_content();
    let (started, ready_to_write) = mpsc::channel();
    let value = body.clone();
    let writer = std::thread::spawn(move || {
        started.send(()).unwrap();
        preparation.write_result(&value).unwrap()
    });
    ready_to_write
        .recv_timeout(Duration::from_secs(15))
        .unwrap();
    {
        let mut catalog = owner
            .try_lock()
            .expect("foreground gate waits cannot own Catalog");
        assert!(catalog.operation("receipt").unwrap().result.is_none());
        assert!(
            catalog
                .request_cancel_run(&input.run_id)
                .unwrap()
                .cancel_requested
        );
    }
    let report = finished(resume, collector);
    assert_eq!(report.status, ContentCollectionStatus::Deferred);
    assert_eq!(report.phase, ContentCollectionPhase::Sweep);
    assert_eq!(
        report.removed_objects, 1,
        "foreground work stops sweep at the next safe point"
    );
    let prepared = writer.join().unwrap();
    owner
        .lock()
        .unwrap()
        .settle_operation_prepared("receipt", epoch, Outcome::Succeeded, Effect::None, prepared)
        .unwrap();
    {
        let mut catalog = owner.lock().unwrap();
        let run = catalog.run(&input.run_id).unwrap();
        assert!(
            run.cancel_requested,
            "receipt completion cannot revive cancelled work"
        );
        catalog
            .transition_run(&run.id, epoch, run.revision, RunState::Cancelled)
            .unwrap();
    }
    let collection = ready(&owner.lock().unwrap(), Arc::new(AtomicBool::new(false)));
    assert_eq!(collection.run().status, ContentCollectionStatus::Completed);
    drop(owner);
    let catalog = Catalog::open(&root.0).unwrap();
    assert_eq!(
        catalog.run(&input.run_id).unwrap().state,
        RunState::Cancelled
    );
    let operation = catalog.operation("receipt").unwrap();
    assert_eq!(
        catalog
            .capture_operation_read(operation)
            .load()
            .unwrap()
            .result,
        Some(body)
    );
}

#[test]
fn in_flight_staging_is_not_abandoned_and_cancelling_collection_does_not_cancel_publication() {
    let root = Root::new();
    let (catalog, _) = fixture_catalog(&root);
    let store = catalog.content.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    let collection = ready(&catalog, cancel.clone());
    let (resume, collector) = pause(collection, CollectionPoint::Verify);
    let (staged, arrival) = mpsc::channel();
    let (release, continuation) = mpsc::channel();
    let continuation = Mutex::new(continuation);
    let once = AtomicBool::new(false);
    store.set_write_hook(Some(Arc::new(move |path| {
        if !once.swap(true, Ordering::AcqRel) {
            staged.send(path.to_owned()).unwrap();
            continuation
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(15))
                .unwrap();
        }
    })));
    let preparation = catalog.prepare_result_content();
    let writer = std::thread::spawn(move || {
        preparation
            .write_result(&json!({"staging":"still being installed"}))
            .unwrap()
    });
    let path = arrival.recv_timeout(Duration::from_secs(15)).unwrap();
    assert!(path.is_file());
    cancel.store(true, Ordering::Release);
    let report = finished(resume, collector);
    assert_eq!(report.status, ContentCollectionStatus::Cancelled);
    assert_eq!(report.phase, ContentCollectionPhase::Verify);
    assert!(
        path.is_file(),
        "an actual writer still owns this UUID staging file"
    );
    let deferred = catalog.prepare_content_collection(Default::default()).run();
    assert_eq!(deferred.reason.as_deref(), Some("publication_active"));
    release.send(()).unwrap();
    drop(writer.join().unwrap());
    store.set_write_hook(None);
    assert!(!path.exists());
    assert_eq!(
        ready(&catalog, Default::default()).run().status,
        ContentCollectionStatus::Completed
    );
}

#[test]
fn captured_reader_keeps_replaced_memory_body_until_its_actual_read_finishes() {
    let root = Root::new();
    let (catalog, _) = fixture_catalog(&root);
    let state = |revision| memory::MemoryState {
        revision,
        memories: vec![json!({"body":revision})],
        note_revisions: Default::default(),
        known: Default::default(),
    };
    let old = catalog
        .content
        .save(&serde_json::to_value(state(1)).unwrap())
        .unwrap();
    catalog
        .db
        .execute(
            "INSERT INTO memory_states(branch_id,body) VALUES('main',?1)",
            [old.to_string()],
        )
        .unwrap();
    let old_reader = catalog.capture_memory_state("main").unwrap().unwrap();
    let replacement = catalog
        .content
        .save(&serde_json::to_value(state(2)).unwrap())
        .unwrap();
    catalog
        .db
        .execute(
            "UPDATE memory_states SET body=?1 WHERE branch_id='main'",
            [replacement.to_string()],
        )
        .unwrap();
    assert_eq!(
        catalog
            .prepare_content_collection(Default::default())
            .run()
            .reason
            .as_deref(),
        Some("publication_active")
    );
    assert_eq!(old_reader.load().unwrap(), state(1));
    let report = ready(&catalog, Default::default()).run();
    assert_eq!(report.status, ContentCollectionStatus::Completed);
    assert!(report.removed_objects > 0);
    assert!(catalog.content.load(&old).is_err());
    assert_eq!(
        catalog
            .capture_memory_state("main")
            .unwrap()
            .unwrap()
            .load()
            .unwrap(),
        state(2)
    );
}

#[test]
fn cancelled_partial_sweep_reports_real_unlinks_and_releases_collector_and_owner_on_exit() {
    let root = Root::new();
    let (catalog, _) = fixture_catalog(&root);
    catalog
        .content
        .save(&json!({"orphan":"cancel after one unlink"}))
        .unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let collection = ready(&catalog, cancel.clone());
    let (resume, worker) = pause(collection, CollectionPoint::ObjectRemoved);
    let busy = catalog.prepare_content_collection(Default::default()).run();
    assert_eq!(busy.status, ContentCollectionStatus::Deferred);
    assert_eq!(busy.reason.as_deref(), Some("collector_active"));
    // Dropping Catalog requests cancellation, but does not unlock runtime.owner or join this worker.
    drop(catalog);
    assert!(cancel.load(Ordering::Acquire));
    assert!(matches!(
        Catalog::open(&root.0),
        Err(RuntimeError::Conflict(_))
    ));
    let report = finished(resume, worker);
    assert_eq!(report.status, ContentCollectionStatus::Cancelled);
    assert_eq!(report.phase, ContentCollectionPhase::Sweep);
    assert_eq!(report.removed_objects, 1);
    assert!(report.removed_bytes > 0);
    let reopened = Catalog::open(&root.0).unwrap();
    assert_eq!(
        ready(&reopened, Default::default()).run().status,
        ContentCollectionStatus::Completed
    );
}

#[test]
fn failed_mark_and_failed_partial_staging_never_disguise_what_was_deleted() {
    let root = Root::new();
    let (catalog, _) = fixture_catalog(&root);
    let orphan = catalog
        .content
        .save(&json!({"orphan":"mark must succeed first"}))
        .unwrap();
    catalog
        .db
        .execute("UPDATE commands SET intent='not-json'", [])
        .unwrap();
    let report = ready(&catalog, Default::default()).run();
    assert_eq!(report.status, ContentCollectionStatus::Failed);
    assert_eq!(report.phase, ContentCollectionPhase::Roots);
    assert_eq!(report.removed_objects, 0);
    assert!(catalog.content.load(&orphan).is_ok());
    // A separate valid Catalog reaches actual sweep, then encounters a real staging I/O failure.
    let second = Root::new();
    let (catalog, _) = fixture_catalog(&second);
    catalog
        .content
        .save(&json!({"orphan":"deleted before staging fails"}))
        .unwrap();
    let collection = ready(&catalog, Default::default());
    let (resume, worker) = pause(collection, CollectionPoint::Staging);
    std::fs::remove_dir(second.0.join("content/staging")).unwrap();
    let report = finished(resume, worker);
    assert_eq!(report.status, ContentCollectionStatus::Failed);
    assert_eq!(report.phase, ContentCollectionPhase::Staging);
    assert!(report.removed_objects > 0);
    assert!(report.removed_bytes > 0);
    std::fs::create_dir(second.0.join("content/staging")).unwrap();
    assert_eq!(
        ready(&catalog, Default::default()).run().status,
        ContentCollectionStatus::Completed
    );
}

#[test]
fn worker_unwind_reports_partial_work_and_releases_its_gate_and_collector_lease() {
    let root = Root::new();
    let (catalog, _) = fixture_catalog(&root);
    catalog
        .content
        .save(&json!({"orphan":"panic after deletion"}))
        .unwrap();
    let collection = ready(&catalog, Default::default()).with_hook(Arc::new(|point| {
        if point == CollectionPoint::ObjectRemoved {
            panic!("injected collector unwind");
        }
    }));
    let report = std::thread::spawn(move || collection.run()).join().unwrap();
    assert_eq!(report.status, ContentCollectionStatus::Failed);
    assert_eq!(report.phase, ContentCollectionPhase::Sweep);
    assert_eq!(report.removed_objects, 1);
    assert!(report.removed_bytes > 0);
    // No reader/publication/collector admission is leaked by the unwound maintenance worker.
    assert!(!catalog.history("main").unwrap().is_empty());
    let value = catalog.content.save(&json!("subsequent writer")).unwrap();
    assert_eq!(
        catalog.content.load(&value).unwrap(),
        json!("subsequent writer")
    );
    assert_eq!(
        ready(&catalog, Default::default()).run().status,
        ContentCollectionStatus::Completed
    );
}
