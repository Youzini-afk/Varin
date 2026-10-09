use super::*;
use crate::test_submission::InputAdmission;
use serde_json::json;
use std::time::{Duration, Instant};

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
