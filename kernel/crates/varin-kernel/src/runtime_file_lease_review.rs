//! Lease waiting must follow real file-worker ownership, not request cancellation.
use super::*;
use crate::storage::capture_resources::CapturePhase;

#[test]
fn file_lease_resolution_preserves_fifo_without_partial_holds_and_cancellation_unblocks_successors() {
    let mut f = Fixture::new();
    f.short("file.lease.acquire", f.lease("a", "holder"), Some("writer"));
    let first = json!({"workspaceId":"workspace","rootId":f.root_id,"leaseId":"multi",
        "resources":[{"path":"a","scope":"exact"},{"path":"b","scope":"exact"}]});
    let (original, cancelled) = f.begin("file.lease.wait", first, "writer");
    assert!(f.finish_lease().unwrap().is_none());
    f.begin("file.lease.wait", f.lease("b", "successor"), "writer");
    assert!(f.finish_lease().unwrap().is_none());
    assert_eq!(f.short("file.lease.acquire", f.lease("c", "independent"), Some("writer"))["status"], "acquired");
    cancelled.store(true, Ordering::Release);
    let completed = f.kernel.resume_file_lease_waiters(&f.tx);
    assert_eq!(completed.len(), 1);
    assert_eq!(completed[0].0, original["id"].as_str().unwrap());
    assert!(matches!(&completed[0].1, Err(KernelError::Cancelled)));
    let successor = f.finish_lease().unwrap().unwrap();
    assert_eq!(successor["leaseId"], "successor");
    assert_eq!(successor["status"], "acquired", "the multi-resource waiter never partially held b");
}

#[test]
fn file_lease_admission_is_metadata_only_and_late_revocation_never_installs_a_lease() {
    let mut f = Fixture::new();
    let moved = f.directory.0.join("away");
    fs::rename(f.work(), &moved).unwrap();
    f.begin("file.lease.acquire", f.lease("file", "missing-root"), "writer");
    f.short("storage.health", json!({}), Some("reader"));
    assert!(f.finish_lease().is_err());
    fs::rename(moved, f.work()).unwrap();
    f.begin("file.lease.acquire", f.lease("file", "late"), "writer");
    let WorkerRequest::FileLeaseResolved { request, task, result } = f.rx.recv_timeout(WAIT).unwrap() else { panic!("unexpected lease continuation"); };
    assert!(result.is_ok());
    f.short("authority.grant.revoke", json!({"grantId":"writer"}), None);
    assert!(f.kernel.complete_file_lease(&request, &task, result, &f.revoked).is_err());
    f.grant("replacement", &["storage.read","storage.write"], &[""]);
    assert_eq!(f.short("file.lease.acquire", f.lease("file", "replacement-lease"), Some("replacement"))["status"], "acquired");
}

#[test]
fn lease_wait_remains_queued_until_a_cancelled_capture_worker_has_really_drained() {
    for supplied in [false, true] {
        let mut f = Fixture::new();
        fs::write(f.work().join("body"), b"original body").unwrap();
        let mut capture = f.capture_params("body", false, "held-capture");
        if supplied {
            assert_eq!(
                f.short(
                    "file.lease.acquire",
                    f.lease("body", "worker-lease"),
                    Some("writer")
                )["status"],
                "acquired"
            );
            capture["leaseId"] = json!("worker-lease");
        }
        let mut hold = f.capture_hold(CapturePhase::Read);
        let (_, worker_cancel) = f.begin("file.capture", capture, "writer");
        hold.entered();

        let waiter = Fixture::request(
            "file.lease.wait",
            f.lease("body", "next-lease"),
            Some("writer"),
        );
        assert!(f
            .kernel
            .handle(
                &waiter,
                Arc::new(AtomicBool::new(false)),
                &f.tx
            )
            .unwrap()
            .is_none());
        assert!(f.finish_lease().unwrap().is_none());
        if supplied {
            assert_eq!(
                f.short(
                    "file.lease.release",
                    json!({"workspaceId":"workspace", "rootId":f.root_id,"leaseId":"worker-lease"}),
                    Some("writer")
                )["deferred"],
                true
            );
        }
        worker_cancel.store(true, Ordering::Release);
        assert!(f
            .kernel
            .storage
            .as_mut()
            .unwrap()
            .settle_file_lease_waiters(EPOCH, HOST, GENERATION)
            .is_empty());
        assert!(matches!(f.rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
        assert_eq!(
            f.short("storage.health", json!({}), Some("writer"))["integrity"],
            "not_checked"
        );
        assert_eq!(
            f.short(
                "file.lease.wait",
                f.lease("unrelated", "independent"),
                Some("writer")
            )["status"],
            "acquired"
        );

        hold.release();
        assert!(matches!(f.finish_capture(), Err(KernelError::Cancelled)));
        let mut completed = f
            .kernel
            .storage
            .as_mut()
            .unwrap()
            .settle_file_lease_waiters(EPOCH, HOST, GENERATION);
        assert_eq!(completed.len(), 1);
        let (id, result) = completed.pop().unwrap();
        assert_eq!(id, waiter["id"].as_str().unwrap());
        let receipt = result.unwrap();
        assert_eq!(receipt["leaseId"], "next-lease");
        assert_eq!(receipt["status"], "acquired");
        assert_eq!(
            f.short(
                "file.lease.check",
                f.lease("body", "next-lease"),
                Some("writer")
            )["checked"],
            true
        );
        assert_eq!(fs::read(f.work().join("body")).unwrap(), b"original body");
    }
}
