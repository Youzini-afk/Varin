use super::*;
use crate::test_submission::InputAdmission;
use serde_json::json;
use std::time::{Duration, Instant};

#[test]
fn completion_wake_waits_for_the_original_worker_before_releasing_launch_ownership() {
    let root = std::env::temp_dir().join(format!("varin-completion-drain-{}", uuid::Uuid::new_v4()));
    let mut catalog = Catalog::open(&root).unwrap();
    catalog.create_thread("thread", "branch").unwrap();
    let receipt = catalog.submit(&crate::SubmitInput {
        key: "input".into(), thread_id: "thread".into(), branch_id: "branch".into(),
        expected_head: None, input: json!("ready"), configuration: json!({}),
    }).unwrap();
    let epoch = catalog.epoch();
    catalog.commit_execution(&receipt.run_id, epoch, &ExecutionRecord::StateChanged {
        state: RunState::Runnable, waiting_on: None,
    }).unwrap();
    let supervisor = Arc::new(RunSupervisor::new(catalog));
    let (wake, wakes) = mpsc::channel();
    supervisor.set_wake_sender(wake.clone()).unwrap();
    let (release, held) = mpsc::channel();
    let ready = Arc::new(AtomicBool::new(false));
    let done = ready.clone();
    let worker = thread::spawn(move || {
        done.store(true, Ordering::Release);
        wake.send(()).unwrap();
        // Hold the final unwind after notifying, before JoinHandle::is_finished.
        let _ = held.recv();
    });
    supervisor.workers.lock().unwrap().insert(receipt.run_id.clone(), Worker {
        parent_run_id: None, cancel: CancellationToken::default(), join: Some(worker),
        pending: None, completion_ready: Some(ready),
    });
    wakes.recv_timeout(Duration::from_secs(3)).unwrap();
    let owner = supervisor.clone();
    let reaper = thread::spawn(move || owner.advance_pending());
    let deadline = Instant::now() + Duration::from_secs(3);
    while !supervisor.quiescence.lock().unwrap().get(&receipt.run_id)
        .is_some_and(|drain| drain.active.load(Ordering::Acquire)) {
        assert!(Instant::now() < deadline, "completion wake must join the original worker");
        thread::yield_now();
    }
    let available_while_draining = supervisor.start_available(&receipt.run_id).unwrap();
    release.send(()).unwrap();
    reaper.join().unwrap().unwrap();
    assert!(!available_while_draining, "final unwind still owns execution resources");
    assert!(supervisor.start_available(&receipt.run_id).unwrap());
    // A ready notification consumed during teardown must get a new read hint.
    wakes.recv_timeout(Duration::from_secs(3)).unwrap();
    drop(supervisor);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn stale_wait_check_does_not_hide_an_unowned_runnable_run() {
    let root = std::env::temp_dir().join(format!("varin-stale-wait-{}", uuid::Uuid::new_v4()));
    let mut catalog = Catalog::open(&root).unwrap();
    catalog.create_thread("thread", "branch").unwrap();
    let receipt = catalog.submit(&crate::SubmitInput {
        key: "input".into(), thread_id: "thread".into(), branch_id: "branch".into(),
        expected_head: None, input: json!("ready"), configuration: json!({}),
    }).unwrap();
    let epoch = catalog.epoch();
    catalog.commit_execution(&receipt.run_id, epoch, &ExecutionRecord::StateChanged {
        state: RunState::Runnable, waiting_on: None,
    }).unwrap();
    let supervisor = Arc::new(RunSupervisor::new(catalog));
    // A second reconciler already selected this Run's old Wait, but arrives after
    // the first has delivered it. Hold its fresh Catalog read at that boundary.
    let catalog = supervisor.catalog.lock().unwrap();
    let owner = supervisor.clone();
    let run = receipt.run_id.clone();
    let check = thread::spawn(move || owner.quiesce_run(&run, |run| run.state == RunState::Waiting));
    let deadline = Instant::now() + Duration::from_secs(3);
    while !supervisor.quiescence.lock().unwrap().contains_key(&receipt.run_id) {
        assert!(Instant::now() < deadline, "reconciler must reach its fresh state check");
        thread::yield_now();
    }
    let available = supervisor.start_available(&receipt.run_id).unwrap();
    drop(catalog);
    check.join().unwrap().unwrap();
    drop(supervisor);
    std::fs::remove_dir_all(root).unwrap();
    assert!(available, "a stale wait inspection is not a live execution owner");
}

#[test]
fn simultaneous_wait_teardown_drains_once_without_holding_global_controls() {
    let root = std::env::temp_dir().join(format!("varin-wait-drain-{}", uuid::Uuid::new_v4()));
    let mut catalog = Catalog::open(&root).unwrap();
    catalog.create_thread("thread", "branch").unwrap();
    let receipt = catalog
        .submit(&crate::SubmitInput {
            key: "input".into(),
            thread_id: "thread".into(),
            branch_id: "branch".into(),
            expected_head: None,
            input: json!("wait"),
            configuration: json!({}),
        })
        .unwrap();
    let epoch = catalog.epoch();
    catalog
        .commit_execution(
            &receipt.run_id,
            epoch,
            &ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None,
            },
        )
        .unwrap();
    let wait = catalog
        .register_wait(
            "question:test",
            &receipt.run_id,
            "test",
            "operation.settled",
            0,
        )
        .unwrap();
    catalog
        .commit_execution(
            &receipt.run_id,
            epoch,
            &ExecutionRecord::StateChanged {
                state: RunState::Waiting,
                waiting_on: Some(wait.id),
            },
        )
        .unwrap();
    let supervisor = Arc::new(RunSupervisor::new(catalog));
    let (release, held) = mpsc::channel();
    struct Release(Option<mpsc::Sender<()>>);
    impl Drop for Release {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }
    let release = Release(Some(release));
    let worker = thread::spawn(move || {
        held.recv().unwrap();
    });
    supervisor.workers.lock().unwrap().insert(
        receipt.run_id.clone(),
        Worker {
            parent_run_id: None,
            cancel: CancellationToken::default(),
            join: Some(worker),
            pending: None,
            completion_ready: None,
        },
    );
    let (done, completed) = mpsc::channel();
    let mut joiners = Vec::new();
    for _ in 0..2 {
        let owner = supervisor.clone();
        let run = receipt.run_id.clone();
        let done = done.clone();
        joiners.push(thread::spawn(move || {
            done.send(owner.quiesce_run(&run, |run| run.state == RunState::Waiting))
                .unwrap();
        }));
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let joined = supervisor
            .quiescence
            .lock()
            .unwrap()
            .get(&receipt.run_id)
            .is_some_and(|serial| Arc::strong_count(serial) == 3);
        if joined {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "both callers must join the actual pending teardown"
        );
        thread::yield_now();
    }
    assert!(
        matches!(completed.try_recv(), Err(mpsc::TryRecvError::Empty)),
        "neither waiter can finish before the original worker"
    );
    assert!(
        !supervisor.start_available(&receipt.run_id).unwrap(),
        "the original worker's live teardown must still fence a replacement"
    );
    let (controlled, control) = mpsc::channel();
    let owner = supervisor.clone();
    let run = receipt.run_id.clone();
    let controls = thread::spawn(move || {
        owner.cancel_control(&run);
        let cancelled = owner
            .catalog
            .lock()
            .unwrap()
            .request_cancel_run(&run)
            .unwrap();
        controlled.send(cancelled.cancel_requested).unwrap();
    });
    assert!(
        control.recv_timeout(Duration::from_secs(3)).unwrap(),
        "control remains available while teardown is held"
    );
    drop(release);
    for _ in 0..2 {
        completed
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap();
    }
    for join in joiners {
        join.join().unwrap();
    }
    controls.join().unwrap();
    assert!(supervisor.quiescence.lock().unwrap().is_empty());
    drop(supervisor);
    std::fs::remove_dir_all(root).unwrap();
}
