//! Original getBlob and fixed FileRead over real Storage admission and body workers.
use super::*;
use crate::storage::blob_reads::{BlobReadPhase, BlobReadTask, PreparedBlobRead};
use crate::tools::{self, ResourceWork};
use base64::engine::general_purpose::STANDARD as BASE64;

impl Fixture {
    fn blob_params(&self, captured: &Value, offset: u64, length: u64) -> Value {
        let state: Value = serde_json::from_str(captured["stateJson"].as_str().unwrap()).unwrap();
        json!({"hash":state["objectHash"],"ownerId":captured["ownerId"],"offset":offset,"length":length})
    }
    fn blob_hold(&mut self, phase: BlobReadPhase) -> Hold {
        let (entered, receiver) = mpsc::channel();
        let (resume, released) = mpsc::channel();
        self.kernel.blob_read_hold = Some((
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
    fn receive_blob(&self) -> (Value, BlobReadTask, Result<PreparedBlobRead, KernelError>) {
        match self
            .rx
            .recv_timeout(WAIT)
            .expect("blob reader did not drain")
        {
            WorkerRequest::BlobReadDone {
                reply: BlobReadReply::Wire(request),
                task,
                result,
            } => (request, task, result),
            _ => panic!("unexpected worker completion"),
        }
    }
    fn finish_blob(&mut self) -> Result<Value, KernelError> {
        let (request, task, result) = self.receive_blob();
        self.kernel
            .complete_blob_read(&request, &task, result, &self.revoked)
    }
    fn cold(&mut self) {
        self.kernel
            .storage
            .as_mut()
            .unwrap()
            .clear_blob_verification();
    }
    fn join_file_workers(&mut self) {
        for (_, worker) in self.kernel.file_workers.drain(..) {
            worker.join().unwrap();
        }
    }
}

#[test]
fn cold_blob_hash_is_off_actor_and_cancel_waits_for_actual_reader() {
    let mut f = Fixture::new();
    let body = vec![7; 512 * 1024];
    fs::write(f.work().join("body"), &body).unwrap();
    let captured = f.capture("body", true, "cold-reader");
    f.cold();
    let mut hold = f.blob_hold(BlobReadPhase::Verify);
    let (request, token) = f.begin("storage.getBlob", f.blob_params(&captured, 4, 3), "writer");
    hold.entered();
    assert_eq!(
        f.short("storage.health", json!({}), Some("writer"))["integrity"],
        "ok"
    );
    assert_eq!(
        f.short(
            "storage.record.get",
            json!({"workspaceId":"workspace","recordId":"absent"}),
            Some("writer")
        ),
        Value::Null
    );
    active(&request, token.clone()).cancel();
    assert!(token.load(Ordering::Acquire));
    assert!(matches!(f.rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
    hold.release();
    assert!(matches!(f.finish_blob(), Err(KernelError::Cancelled)));
    let value = f.blob(f.blob_params(&captured, 4, 3), "writer").unwrap();
    assert_eq!(
        BASE64
            .decode(value["bytesBase64"].as_str().unwrap())
            .unwrap(),
        [7, 7, 7]
    );
    assert_eq!(value["offset"], 4);
    assert_eq!(value["nextOffset"], 7);
    assert_eq!(value["eof"], false);
    let empty = f
        .blob(
            f.blob_params(&captured, body.len() as u64 + 10, 3),
            "writer",
        )
        .unwrap();
    assert_eq!(empty["offset"], body.len());
    assert_eq!(empty["nextOffset"], body.len());
    assert_eq!(empty["eof"], true);
    assert_eq!(empty["bytesBase64"], "");
}

#[test]
fn same_hash_readers_and_queued_completion_retain_bytes_without_retaining_access() {
    let mut f = Fixture::new();
    let body = b"two readers retain one immutable object";
    fs::write(f.work().join("body"), body).unwrap();
    let captured = f.capture("body", true, "reader-roots");
    f.cold();
    let mut a = f.blob_hold(BlobReadPhase::Read);
    f.begin("storage.getBlob", f.blob_params(&captured, 0, 2), "writer");
    a.entered();
    let mut b = f.blob_hold(BlobReadPhase::Read);
    f.begin("storage.getBlob", f.blob_params(&captured, 2, 2), "writer");
    b.entered();
    f.release_owner(&captured["ownerId"]);
    f.gc();
    assert!(object_path(&f, body).exists());
    a.release();
    let (request, task, result) = f.receive_blob();
    assert!(result.is_ok());
    f.gc();
    assert!(
        object_path(&f, body).exists(),
        "queued completion retains its exact hash"
    );
    assert!(matches!(
        f.kernel
            .complete_blob_read(&request, &task, result, &f.revoked),
        Err(KernelError::Authorization(_))
    ));
    drop(task);
    f.gc();
    assert!(object_path(&f, body).exists(), "second reader remains live");
    b.release();
    assert!(matches!(
        f.finish_blob(),
        Err(KernelError::Authorization(_))
    ));
    f.join_file_workers();
    f.gc();
    assert!(!object_path(&f, body).exists());
}

#[test]
fn cold_reader_verifies_outside_range_and_rejected_completion_cannot_warm_cache() {
    let mut f = Fixture::new();
    let body = vec![b'a'; 300_000];
    fs::write(f.work().join("body"), &body).unwrap();
    let captured = f.capture("body", true, "integrity");
    f.cold();
    let (_, cancel) = f.begin("storage.getBlob", f.blob_params(&captured, 0, 1), "writer");
    let (request, task, result) = f.receive_blob();
    assert!(result.is_ok());
    cancel.store(true, Ordering::Release);
    assert!(matches!(
        f.kernel
            .complete_blob_read(&request, &task, result, &f.revoked),
        Err(KernelError::Cancelled)
    ));
    drop(task);
    let mut corrupted = body.clone();
    corrupted[200_000] = b'b';
    fs::write(object_path(&f, &body), &corrupted).unwrap();
    for _ in 0..2 {
        assert!(
            matches!(f.blob(f.blob_params(&captured, 0, 1), "writer"), Err(KernelError::Storage(message)) if message.contains("corrupt"))
        );
    }
    fs::write(object_path(&f, &body), &body).unwrap();
    assert_eq!(
        f.blob(f.blob_params(&captured, 0, 1), "writer").unwrap()["bytesBase64"],
        "YQ=="
    );
}

#[test]
fn reader_rechecks_grant_and_releases_retention_after_panic_or_retirement() {
    for action in ["revoke", "retire", "panic"] {
        let mut f = Fixture::new();
        let body = b"reader lifecycle";
        fs::write(f.work().join("body"), body).unwrap();
        let captured = f.capture("body", true, "lifecycle");
        f.cold();
        if action == "panic" {
            f.kernel.blob_read_hold = Some((
                BlobReadPhase::Read,
                Box::new(|| panic!("reader fixture panic")),
            ));
        }
        f.begin("storage.getBlob", f.blob_params(&captured, 0, 3), "writer");
        let (request, task, result) = f.receive_blob();
        if action != "panic" {
            assert!(result.is_ok());
            f.short(
                &format!("authority.grant.{action}"),
                if action == "retire" {
                    json!({"target":{"kind":"grant","grantId":"writer"}})
                } else {
                    json!({"grantId":"writer"})
                },
                None,
            );
            assert!(matches!(
                f.kernel
                    .complete_blob_read(&request, &task, result, &f.revoked),
                Err(KernelError::Authorization(_))
            ));
        } else {
            assert!(
                matches!(f.kernel.complete_blob_read(&request, &task, result, &f.revoked), Err(KernelError::Storage(message)) if message.contains("panicked"))
            );
            f.release_owner(&captured["ownerId"]);
        }
        drop(task);
        f.join_file_workers();
        f.grant("cleanup", &["storage.admin"], &[""]);
        f.short(
            "storage.gc",
            json!({"operationId":"reader-cleanup"}),
            Some("cleanup"),
        );
        assert!(!object_path(&f, body).exists());
    }
}

#[test]
fn kernel_drop_joins_blob_reader_before_releasing_storage_lock() {
    let mut f = Fixture::new();
    let body = b"hold storage until actual reader stop";
    fs::write(f.work().join("body"), body).unwrap();
    let captured = f.capture("body", true, "join-reader");
    f.cold();
    let mut hold = f.blob_hold(BlobReadPhase::Read);
    f.begin("storage.getBlob", f.blob_params(&captured, 0, 3), "writer");
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
    // The abandoned old completion cannot install anything in the new Storage owner.
    drop(f.rx.recv_timeout(WAIT).unwrap());
    drop(Storage::open(&store, "replacement").unwrap());
}

#[test]
fn fixed_resource_read_uses_real_blob_worker_and_original_reply() {
    let mut f = Fixture::new();
    let body = b"fixed body";
    fs::write(f.work().join("body"), body).unwrap();
    let captured = f.capture("body", true, "fixed-read");
    let state: Value = serde_json::from_str(captured["stateJson"].as_str().unwrap()).unwrap();
    f.short("branch.create.begin", json!({"builderId":"fixed-builder","operationId":"fixed-create","branchId":"fixed","workspaceId":"workspace","draftBasePaths":[],"captureScopes":[]}), Some("writer"));
    f.short(
        "branch.create.append",
        json!({"builderId":"fixed-builder","sequence":0,"entries":[{"path":"body","state":state,"ownerId":captured["ownerId"]}]}),
        Some("writer"),
    );
    let branch = f.short(
        "branch.create.finish",
        json!({"builderId":"fixed-builder","operationId":"fixed-create"}),
        Some("writer"),
    );
    f.short("authority.grant.issue", json!({"grantId":"fixed-reader","hostGeneration":GENERATION,"capabilities":["storage.read"],"pathScopes":[""],"storageIdentity":f.directory.0.join("store"),"owningWorkspace":"workspace","executionWorkspace":"workspace","runId":"run","threadId":"thread"}), None);
    let binding: tools::ToolBinding = serde_json::from_value(json!({"grantId":"fixed-reader","runId":"run","threadId":"thread","workspaceId":"workspace","executionWorkspaceId":"workspace","rootId":null,"fileSource":{"branchId":"fixed","revision":branch["headRevision"]},"sourceMode":"fixed_branch","materializedSource":null,"liveRoot":null,"environmentRunId":null,"enabledTools":["file_read"]})).unwrap();
    let cancel = varin_runtime::execution::CancellationToken::default();
    let (call, reply) = tools::fixed_read_fixture(binding, "body", cancel);
    let task = match tools::prepare_resource(
        f.kernel.storage.as_mut().unwrap(),
        EPOCH,
        HOST,
        GENERATION,
        &call,
    )
    .unwrap_or_else(|failure| panic!("{}", failure.error))
    {
        ResourceWork::BlobRead(task) => task,
        _ => panic!("fixed read did not use shared body worker"),
    };
    let mut hold = f.blob_hold(BlobReadPhase::Read);
    f.kernel
        .spawn_blob_read(task, BlobReadReply::Resource(call), &f.tx)
        .unwrap();
    hold.entered();
    assert_eq!(
        f.short("storage.health", json!({}), Some("writer"))["integrity"],
        "ok"
    );
    assert!(matches!(reply.try_recv(), Err(mpsc::TryRecvError::Empty)));
    hold.release();
    match f.rx.recv_timeout(WAIT).unwrap() {
        WorkerRequest::BlobReadDone {
            reply: BlobReadReply::Resource(call),
            task,
            result,
        } => {
            assert!(matches!(reply.try_recv(), Err(mpsc::TryRecvError::Empty)));
            let value = tools::finish_resource_blob_read(
                f.kernel.storage.as_mut().unwrap(),
                EPOCH,
                HOST,
                GENERATION,
                &call,
                &task,
                result,
            );
            call.reply.send(value).unwrap();
        }
        _ => panic!("wrong reader reply owner"),
    }
    let value = reply
        .recv_timeout(WAIT)
        .unwrap()
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    assert_eq!(value["content"]["text"], "ixe");
    assert!(value["content"].get("bytesBase64").is_none());
    assert_eq!(value["content"]["offset"], 1);
    assert_eq!(value["content"]["nextOffset"], 4);
}
