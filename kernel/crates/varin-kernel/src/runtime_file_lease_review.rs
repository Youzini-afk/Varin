//! Lease waiting must follow real file-worker ownership, not request cancellation.
use super::*;
use crate::storage::capture_resources::CapturePhase;

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
