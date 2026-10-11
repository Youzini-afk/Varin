//! Actual single and batch Kernel capture admission/worker/publication over the original storage.
use super::*;
use crate::storage::capture_resources::{CapturePhase, CaptureTask, CapturedBatch};
use base64::Engine;
use sha2::{Digest, Sha256};

impl Fixture {
    fn capture_params(&self, path: &str, store: bool, operation: &str) -> Value {
        let mut params = self.params(path);
        params["store"] = json!(store);
        params["operationId"] = json!(operation);
        params
    }
    fn receive_capture(&self) -> (Value, CaptureTask, Result<CapturedBatch, KernelError>) {
        match self
            .rx
            .recv_timeout(WAIT)
            .expect("capture worker did not drain")
        {
            WorkerRequest::CaptureDone {
                request,
                task,
                result,
            } => (request, task, result),
            _ => panic!("unexpected worker completion"),
        }
    }
    fn finish_capture(&mut self) -> Result<Value, KernelError> {
        let (request, task, result) = self.receive_capture();
        self.kernel
            .complete_file_capture(&request, &task, result, &self.revoked)
    }
    fn capture(&mut self, path: &str, store: bool, operation: &str) -> Value {
        self.begin(
            "file.capture",
            self.capture_params(path, store, operation),
            "writer",
        );
        self.finish_capture().unwrap()
    }
    fn capture_hold(&mut self, phase: CapturePhase) -> Hold {
        let (entered, receiver) = mpsc::channel();
        let (resume, released) = mpsc::channel();
        self.kernel.capture_hold = Some((
            phase,
            Box::new(move || {
                entered.send(()).unwrap();
                let _ = released.recv_timeout(WAIT);
            }),
        ));
        Hold {
            entered: receiver,
            resume: Some(resume),
        }
    }
    fn lease(&self, path: &str, id: &str) -> Value {
        json!({"workspaceId":"workspace","rootId":self.root_id,"leaseId":id,"resources":[{"path":path,"scope":"exact"}]})
    }
    fn release_owner(&mut self, owner: &Value) {
        self.short(
            "storage.blob.release",
            json!({"workspaceId":"workspace","ownerId":owner}),
            Some("writer"),
        );
    }
    fn gc(&mut self) {
        self.short(
            "storage.gc",
            json!({"operationId":Uuid::new_v4().to_string()}),
            Some("writer"),
        );
    }
    fn read_capture(&mut self, captured: &Value) -> Vec<u8> {
        let state: Value = serde_json::from_str(captured["stateJson"].as_str().unwrap()).unwrap();
        let read = self.blob(json!({"hash":state["objectHash"],"ownerId":captured["ownerId"],"offset":0,"length":1024}), "writer").unwrap();
        base64::engine::general_purpose::STANDARD
            .decode(read["bytesBase64"].as_str().unwrap())
            .unwrap()
    }
}
fn object_path(f: &Fixture, body: &[u8]) -> PathBuf {
    let hash = hex::encode(Sha256::digest(body));
    f.directory
        .0
        .join("store/objects")
        .join(&hash[..2])
        .join(&hash[2..])
}

#[test]
fn single_capture_real_body_retains_original_or_implicit_exclusion_while_control_and_cancel_run() {
    for supplied in [false, true] {
        for store in [false, true] {
            let mut f = Fixture::new();
            fs::write(f.work().join("body"), vec![7; 256 * 1024]).unwrap();
            let mut params = f.capture_params("body", store, "original-single");
            if supplied {
                f.short(
                    "file.lease.acquire",
                    f.lease("body", "original-lease"),
                    Some("writer"),
                );
                params["leaseId"] = json!("original-lease");
            }
            let mut hold = f.capture_hold(if store {
                CapturePhase::VerifySource
            } else {
                CapturePhase::Read
            });
            let (request, token) = f.begin("file.capture", params.clone(), "writer");
            hold.entered();
            assert_eq!(
                f.short("storage.health", json!({}), Some("writer"))["integrity"],
                "ok"
            );
            assert_eq!(
                f.inventory("file.measure", f.params("body"), "reader")
                    .unwrap()["logicalBytes"],
                256 * 1024
            );
            assert_eq!(
                f.short(
                    "file.lease.acquire",
                    f.lease("body", "contender"),
                    Some("writer")
                )["status"],
                "busy"
            );
            // A direct mutation without a caller lease also observes the original physical exclusion.
            let apply = Fixture::request(
                "file.apply",
                json!({"workspaceId":"workspace","rootId":f.root_id,"operationId":"must-not-write","path":"body","targetJson":"{\"kind\":\"missing\"}"}),
                Some("writer"),
            );
            assert!(
                matches!(f.kernel.handle(&apply, Arc::new(AtomicBool::new(false)), &f.tx), Err(KernelError::Operation(message)) if message.contains("busy"))
            );
            if supplied {
                let duplicate = Fixture::request("file.capture", params, Some("writer"));
                assert!(
                    matches!(f.kernel.handle(&duplicate, Arc::new(AtomicBool::new(false)), &f.tx), Err(KernelError::Operation(message)) if message.contains("active file worker"))
                );
                assert_eq!(f.short("file.lease.release", json!({"workspaceId":"workspace","rootId":f.root_id,"leaseId":"original-lease"}), Some("writer"))["deferred"], true);
            }
            active(&request, token.clone()).cancel();
            assert!(token.load(Ordering::Acquire));
            assert!(matches!(f.rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
            assert_eq!(
                f.short(
                    "file.lease.acquire",
                    f.lease("body", "contender"),
                    Some("writer")
                )["status"],
                "busy"
            );
            hold.release();
            assert!(matches!(f.finish_capture(), Err(KernelError::Cancelled)));
            assert_eq!(
                f.short(
                    "file.lease.acquire",
                    f.lease("body", "contender"),
                    Some("writer")
                )["status"],
                "acquired"
            );
            assert_eq!(
                fs::read_dir(f.directory.0.join("store/staging"))
                    .unwrap()
                    .count(),
                0
            );
            assert!(!object_path(&f, &vec![7; 256 * 1024]).exists());
        }
    }
}

#[test]
fn single_capture_preserves_exact_result_owner_bytes_gc_and_batch_indexed_identity() {
    let mut f = Fixture::new();
    fs::write(f.work().join("body"), b"actual captured bytes").unwrap();
    fs::write(f.work().join("empty"), b"").unwrap();
    fs::create_dir(f.work().join("directory")).unwrap();
    for (name, expected) in [
        ("missing", "missing"),
        ("directory", "directory"),
        ("empty", "regular-file"),
    ] {
        let captured = f.capture(name, true, name);
        assert_eq!(captured["path"], name);
        assert!(captured.get("entries").is_none());
        let state: Value = serde_json::from_str(captured["stateJson"].as_str().unwrap()).unwrap();
        assert_eq!(state["kind"], expected);
        if name == "empty" {
            assert_eq!(f.read_capture(&captured), b"");
        } else {
            assert!(captured["ownerId"].is_null());
        }
    }
    let read_only = f.capture("body", false, "read-only");
    assert!(read_only["ownerId"].is_null());
    assert!(!object_path(&f, b"actual captured bytes").exists());
    let captured = f.capture("body", true, "single-owner-operation");
    assert_eq!(
        captured["ownerId"],
        format!(
            "blob-owner-{}",
            hex::encode(Sha256::digest(b"single-owner-operation"))
        )
    );
    assert_eq!(f.read_capture(&captured), b"actual captured bytes");
    f.gc();
    assert_eq!(
        fs::read(object_path(&f, b"actual captured bytes")).unwrap(),
        b"actual captured bytes"
    );
    f.release_owner(&captured["ownerId"]);
    f.gc();
    assert!(!object_path(&f, b"actual captured bytes").exists());
    f.short(
        "file.lease.acquire",
        f.lease("body", "batch-lease"),
        Some("writer"),
    );
    f.begin("file.captureBatch", json!({"workspaceId":"workspace","rootId":f.root_id,"operationId":"batch-owner-operation","paths":["body"],"store":true,"leaseId":"batch-lease"}), "writer");
    let batch = f.finish_capture().unwrap();
    assert_eq!(
        batch["entries"][0]["ownerId"],
        format!(
            "blob-owner-{}",
            hex::encode(Sha256::digest(b"batch-owner-operation:0"))
        )
    );
    assert_eq!(
        f.read_capture(&batch["entries"][0]),
        b"actual captured bytes"
    );
    assert_eq!(
        f.short(
            "file.lease.check",
            f.lease("body", "batch-lease"),
            Some("writer")
        )["checked"],
        true
    );
}

#[test]
fn existing_object_verification_is_off_actor_and_gc_cannot_delete_later_publication() {
    for cancel in [false, true] {
        let mut f = Fixture::new();
        fs::write(f.work().join("body"), b"object verification body").unwrap();
        let seed = f.capture("body", true, "seed");
        let mut hold = f.capture_hold(CapturePhase::VerifyObject);
        let (_, token) = f.begin(
            "file.capture",
            f.capture_params("body", true, "second"),
            "writer",
        );
        hold.entered();
        f.release_owner(&seed["ownerId"]);
        f.gc();
        assert!(!object_path(&f, b"object verification body").exists());
        assert_eq!(
            f.short("storage.health", json!({}), Some("writer"))["integrity"],
            "ok"
        );
        if cancel {
            token.store(true, Ordering::Release);
        }
        hold.release();
        if cancel {
            assert!(matches!(f.finish_capture(), Err(KernelError::Cancelled)));
            assert!(!object_path(&f, b"object verification body").exists());
        } else {
            let captured = f.finish_capture().unwrap();
            f.gc();
            assert_eq!(f.read_capture(&captured), b"object verification body");
        }
    }
}

#[test]
fn completed_reader_requires_current_grant_and_uncancelled_publication_and_releases_exact_lease() {
    for action in ["cancel", "revoke", "retire"] {
        let mut f = Fixture::new();
        f.grant("source", &["storage.read", "storage.write"], &[""]);
        fs::write(f.work().join("body"), b"durable staged but not owned").unwrap();
        f.short(
            "file.lease.acquire",
            f.lease("body", "source-lease"),
            Some("source"),
        );
        let mut params = f.capture_params("body", true, "unpublished");
        params["leaseId"] = json!("source-lease");
        let (_, token) = f.begin("file.capture", params, "source");
        let (request, task, result) = f.receive_capture();
        assert!(result.is_ok());
        assert_eq!(
            f.short(
                "file.lease.acquire",
                f.lease("body", "contender"),
                Some("writer")
            )["status"],
            "busy"
        );
        if action == "cancel" {
            token.store(true, Ordering::Release);
        } else {
            f.short(
                &format!("authority.grant.{action}"),
                if action == "retire" {
                    json!({"target":{"kind":"grant","grantId":"source"}})
                } else {
                    json!({"grantId":"source"})
                },
                None,
            );
        }
        let completed = f
            .kernel
            .complete_file_capture(&request, &task, result, &f.revoked);
        if action == "cancel" {
            assert!(matches!(completed, Err(KernelError::Cancelled)));
            assert_eq!(
                f.short(
                    "file.lease.check",
                    f.lease("body", "source-lease"),
                    Some("source")
                )["checked"],
                true
            );
            f.short(
                "file.lease.release",
                json!({"workspaceId":"workspace","rootId":f.root_id,"leaseId":"source-lease"}),
                Some("source"),
            );
        } else {
            assert!(matches!(completed, Err(KernelError::Authorization(_))));
        }
        assert_eq!(
            f.short(
                "file.lease.acquire",
                f.lease("body", "contender"),
                Some("writer")
            )["status"],
            "acquired"
        );
        assert_eq!(
            fs::read_dir(f.directory.0.join("store/staging"))
                .unwrap()
                .count(),
            0
        );
        assert!(!object_path(&f, b"durable staged but not owned").exists());
    }
}

#[cfg(unix)]
#[test]
fn capture_preserves_scoped_symlinks_and_rejects_root_or_parent_retarget() {
    use std::os::unix::fs::symlink;
    let mut f = Fixture::new();
    fs::create_dir(f.work().join("allowed")).unwrap();
    fs::create_dir(f.work().join("other")).unwrap();
    fs::write(f.work().join("allowed/body"), b"before").unwrap();
    fs::write(f.work().join("other/body"), b"after").unwrap();
    symlink("../other/body", f.work().join("allowed/link")).unwrap();
    f.grant("scoped", &["storage.read", "storage.write"], &["allowed"]);
    f.begin(
        "file.capture",
        f.capture_params("allowed/link", true, "link"),
        "scoped",
    );
    let link = f.finish_capture().unwrap();
    let state: Value = serde_json::from_str(link["stateJson"].as_str().unwrap()).unwrap();
    assert_eq!(state["kind"], "symlink");
    assert_eq!(state["symlinkTarget"], "../other/body");
    assert!(link["ownerId"].is_null());
    let denied = Fixture::request(
        "file.capture",
        f.capture_params("other/body", false, "denied"),
        Some("scoped"),
    );
    assert!(matches!(
        f.kernel
            .handle(&denied, Arc::new(AtomicBool::new(false)), &f.tx),
        Err(KernelError::Authorization(_))
    ));
    symlink("allowed", f.work().join("alias")).unwrap();
    let mut hold = f.capture_hold(CapturePhase::Read);
    f.begin(
        "file.capture",
        f.capture_params("alias/body", true, "retargeted"),
        "writer",
    );
    hold.entered();
    fs::remove_file(f.work().join("alias")).unwrap();
    symlink("other", f.work().join("alias")).unwrap();
    hold.release();
    assert!(matches!(
        f.finish_capture(),
        Err(KernelError::Authorization(_))
    ));
    f.begin(
        "file.capture",
        f.capture_params("allowed/body", true, "changed-root"),
        "writer",
    );
    let (request, task, result) = f.receive_capture();
    fs::rename(f.work(), f.directory.0.join("old-work")).unwrap();
    fs::create_dir(f.directory.0.join("replacement")).unwrap();
    symlink(f.directory.0.join("replacement"), f.work()).unwrap();
    assert!(matches!(
        f.kernel
            .complete_file_capture(&request, &task, result, &f.revoked),
        Err(KernelError::Authorization(_))
    ));
    assert!(!object_path(&f, b"before").exists());
}

#[test]
fn kernel_drop_keeps_original_storage_owner_until_capture_reader_joins() {
    let mut f = Fixture::new();
    fs::write(
        f.work().join("body"),
        b"reader must stop before replacement",
    )
    .unwrap();
    let mut hold = f.capture_hold(CapturePhase::Read);
    f.begin(
        "file.capture",
        f.capture_params("body", true, "interrupted"),
        "writer",
    );
    hold.entered();
    let store = f.directory.0.join("store");
    let kernel = std::mem::replace(&mut f.kernel, Kernel::new("unused".into()));
    let (done, stopped) = mpsc::channel();
    let joining = thread::spawn(move || {
        drop(kernel);
        done.send(()).unwrap();
    });
    assert!(
        matches!(Storage::open(&store, "replacement"), Err(KernelError::Storage(message)) if message.contains("owned by another Host"))
    );
    assert!(matches!(stopped.try_recv(), Err(mpsc::TryRecvError::Empty)));
    hold.release();
    stopped.recv_timeout(WAIT).unwrap();
    joining.join().unwrap();
    let reopened = Storage::open(&store, "replacement").unwrap();
    assert_eq!(fs::read_dir(store.join("staging")).unwrap().count(), 0);
    assert!(!object_path(&f, b"reader must stop before replacement").exists());
    drop(reopened);
}

#[test]
fn staged_capture_cancellation_changed_source_and_panic_publish_no_owner_and_release_exclusion() {
    for action in ["cancel", "change", "panic"] {
        let mut f = Fixture::new();
        fs::write(f.work().join("body"), b"staged before commit").unwrap();
        let mut hold = if action == "panic" {
            f.kernel.capture_hold = Some((
                CapturePhase::Staged,
                Box::new(|| panic!("capture worker failure")),
            ));
            None
        } else {
            Some(f.capture_hold(CapturePhase::Staged))
        };
        let (_, token) = f.begin(
            "file.capture",
            f.capture_params("body", true, "failed-capture"),
            "writer",
        );
        if let Some(hold) = &mut hold {
            hold.entered();
            assert_eq!(
                fs::read_dir(f.directory.0.join("store/staging"))
                    .unwrap()
                    .count(),
                1
            );
            assert!(!object_path(&f, b"staged before commit").exists());
            assert_eq!(
                f.short(
                    "file.lease.acquire",
                    f.lease("body", "contender"),
                    Some("writer")
                )["status"],
                "busy"
            );
            if action == "cancel" {
                token.store(true, Ordering::Release);
            } else {
                fs::write(f.work().join("body"), b"externally changed").unwrap();
            }
            hold.release();
        }
        let result = f.finish_capture();
        match action {
            "cancel" => assert!(matches!(result, Err(KernelError::Cancelled))),
            "change" => assert!(
                matches!(result, Err(KernelError::Operation(message)) if message.contains("changed"))
            ),
            _ => assert!(
                matches!(result, Err(KernelError::Storage(message)) if message.contains("panicked"))
            ),
        }
        assert_eq!(
            f.short("storage.health", json!({}), Some("writer"))["temporaryObjectOwners"],
            0
        );
        assert_eq!(
            fs::read_dir(f.directory.0.join("store/staging"))
                .unwrap()
                .count(),
            0
        );
        assert_eq!(
            f.short(
                "file.lease.acquire",
                f.lease("body", "contender"),
                Some("writer")
            )["status"],
            "acquired"
        );
    }
}

#[test]
fn single_capture_rejects_corrupt_object_without_publishing_a_new_owner() {
    let mut f = Fixture::new();
    fs::write(f.work().join("body"), b"correct").unwrap();
    f.capture("body", true, "seed");
    fs::write(object_path(&f, b"correct"), b"corrupt").unwrap();
    f.begin(
        "file.capture",
        f.capture_params("body", true, "must-not-own"),
        "writer",
    );
    assert!(
        matches!(f.finish_capture(), Err(KernelError::Storage(message)) if message.contains("corrupt"))
    );
    assert_eq!(
        f.short("storage.health", json!({}), Some("writer"))["temporaryObjectOwners"],
        1
    );
    assert_eq!(
        fs::read_dir(f.directory.0.join("store/staging"))
            .unwrap()
            .count(),
        0
    );
    assert_eq!(
        f.short(
            "file.lease.acquire",
            f.lease("body", "contender"),
            Some("writer")
        )["status"],
        "acquired"
    );
}

#[test]
fn revocation_and_retirement_cannot_drop_an_implicit_capture_lease_before_real_drain() {
    for action in ["revoke", "retire"] {
        let mut f = Fixture::new();
        f.grant("source", &["storage.read", "storage.write"], &[""]);
        fs::write(f.work().join("body"), b"held implicit capture").unwrap();
        let mut hold = f.capture_hold(CapturePhase::Read);
        let (request, token) = f.begin(
            "file.capture",
            f.capture_params("body", true, "implicit"),
            "source",
        );
        hold.entered();
        f.short(
            &format!("authority.grant.{action}"),
            if action == "retire" {
                json!({"target":{"kind":"grant","grantId":"source"}})
            } else {
                json!({"grantId":"source"})
            },
            None,
        );
        let requests = Arc::new(Mutex::new(HashMap::from([(
            request["id"].as_str().unwrap().to_owned(),
            active(&request, token.clone()),
        )])));
        mark_grant_revoked(&f.revoked, &requests, "source");
        assert!(token.load(Ordering::Acquire));
        assert_eq!(
            f.short(
                "file.lease.acquire",
                f.lease("body", "contender"),
                Some("writer")
            )["status"],
            "busy"
        );
        assert!(matches!(f.rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
        hold.release();
        assert!(matches!(
            f.finish_capture(),
            Err(KernelError::Authorization(_))
        ));
        assert_eq!(
            f.short(
                "file.lease.acquire",
                f.lease("body", "contender"),
                Some("writer")
            )["status"],
            "acquired"
        );
        assert_eq!(
            f.short("storage.health", json!({}), Some("writer"))["temporaryObjectOwners"],
            0
        );
    }
}

#[path = "runtime_blob_read_tests.rs"]
mod blob_reads;
